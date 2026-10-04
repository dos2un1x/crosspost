/**
 * 「一键生成」能力提供者解析 + 调用（P2，2026-09-19）。
 *
 * ── 为什么需要这个模块 ────────────────────────────────────────────────
 * P0 把"引擎 spawn 接入方的生成脚本"改成了**进程内能力钩子**
 * （`bridge/topics.mjs` 的 `registerGenerateProvider()`）。边界是干净了，
 * 但带来一个新问题：**钩子只能由同一个进程注册**。而 CrossPost（引擎）与
 * 接入方的写作项目与引擎是**永久分离**的两个东西，正常情况下根本不同进程，
 * 于是「一键生成」在真实部署里永远是死的——Console 摆着按钮，点下去只得到
 * `generate_not_provided`。
 *
 * P2 的解法不是回到"引擎代跑脚本"（那正是 P0 要消灭的越界），而是把能力
 * 变成**声明式的跨进程契约**：项目在自己的 manifest 里写
 *
 *     "capabilities": { "generate": { "kind": "http", "url": "http://127.0.0.1:8787/generate" } }
 *
 * 引擎读声明、发一次 POST、把结果映射进既有的任务状态机。项目那边怎么实现
 * （调 LLM、跑 shell、排队到别处）完全由项目自己决定，引擎不关心也不越界。
 *
 * ── 解析优先级（三层，互不"兜底"）────────────────────────────────────
 *   ① 引擎进程内已注册的 provider（`registerGenerateProvider()`）—— 内嵌场景
 *   ② 当前项目上下文（`X-CrossPost-Project` / `--project=` / `CROSSPOST_PROJECT`）
 *      的 manifest 声明
 *   ③ 都没有项目上下文时，引擎配置 `generate.provider` 的默认声明
 *
 * **关键**：②③ 之间没有回退关系。选中了项目就去读那个项目的 manifest，
 * 它没声明就是"没有"，绝不回头用引擎默认值——否则就复现了 v2.33 修掉的那类
 * 缺陷（"界面写着项目 A，实际显示的是项目 B 的数据"）。
 *
 * ── 安全边界 ─────────────────────────────────────────────────────────
 * manifest 是**数据**，但它能让引擎主动对外发请求，所以必须设限：
 *   · 只允许 http/https
 *   · **默认只允许环回地址**（127.0.0.0/8、::1、localhost）——生成端点按设计
 *     与引擎同机；要调远程主机必须在引擎配置 `generate.allowHosts` 里逐个登记
 *   · `redirect: 'manual'` —— 不接受跳转，否则白名单可被 302 绕过
 *   · `timeoutMs` 有上限（GENERATE_MAX_TIMEOUT_MS）
 *   · 密钥只认**环境变量名**（`tokenEnv`），manifest 里不留密钥
 */
import net from 'node:net'
import { readConfig } from './config-cache.mjs'
import {
  getProject,
  GENERATE_MAX_TIMEOUT_MS,
  GENERATE_MAX_POLL_MS,
  GENERATE_MAX_OVERALL_MS,
} from './projects.mjs'

/** 默认调用超时（30s；项目可用 timeoutMs 覆盖，上限见 GENERATE_MAX_TIMEOUT_MS） */
export const DEFAULT_TIMEOUT_MS = 30000

/** 默认轮询间隔（异步模式；2s） */
export const DEFAULT_POLL_INTERVAL_MS = 2000

/** 默认整任务上限（异步模式；1h——真实生成要跑几分钟到几十分钟） */
export const DEFAULT_OVERALL_TIMEOUT_MS = 3600000

/** 健康探测的默认超时（doctor 用，必须短） */
export const DEFAULT_PROBE_TIMEOUT_MS = 1500

/**
 * 端点返回 409 busy 时的重试上限（v2.111）。
 *
 * 只在引擎侧并发 > 1 时才可能触发：一条任务 = 一次 POST，409 意味着**项目侧没接单**
 * （provider 的 `GENERATE_CONCURRENCY` 满了），因此"稍后再 POST 一次"是安全的
 * ——不会开出两条真实生成。退避后仍忙就如实上报"项目侧忙"，不装作失败。
 */
export const BUSY_RETRY_MAX = 3
const BUSY_RETRY_BASE_MS = 2000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 环回主机名（含 IPv6 字面量的方括号形态） */
function isLoopbackHost(hostname) {
  const h = String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  if (!h) return false
  if (h === 'localhost' || h === '::1') return true
  if (h === '0.0.0.0' || h === '::') return true // 通配地址在本机语义上等同于环回
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  return false
}

/**
 * 端点策略校验：给定 url 与引擎策略，判断能否调用。
 * @returns {{ok:true,url:string,host:string,port:string}|{ok:false,reason:string}}
 */
export function checkEndpointPolicy(rawUrl, policy = {}) {
  const allowHosts = Array.isArray(policy.allowHosts) ? policy.allowHosts : []
  const allowRemote = policy.allowRemote === true

  let u
  try {
    u = new URL(String(rawUrl))
  } catch {
    return { ok: false, reason: `不是合法 URL: ${rawUrl}` }
  }
  if (!['http:', 'https:'].includes(u.protocol))
    return { ok: false, reason: `协议必须是 http/https（当前 ${u.protocol}）` }

  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  if (isLoopbackHost(host)) return { ok: true, url: u.toString(), host, port }

  // 非环回：必须显式登记（host 或 host:port 两种写法都认）
  const hit = allowHosts.some((h) => {
    const s = String(h || '')
      .trim()
      .toLowerCase()
    return s && (s === host || s === `${host}:${port}`)
  })
  if (hit || allowRemote) return { ok: true, url: u.toString(), host, port }

  return {
    ok: false,
    reason:
      `端点主机 ${host} 不是环回地址，且未在引擎配置 generate.allowHosts 中登记。` +
      `（引擎默认只调用本机生成端点；确需远程请显式登记，或设 generate.allowRemote=true）`,
  }
}

/**
 * 宿主网关重写（2026-09-25，Docker 形态实测加的这一层）
 *
 * ## 它解决什么
 *
 * 项目 manifest 里声明的宿主服务地址（今天只有 `capabilities.generate.url/statusUrl`）
 * 通常是 `http://127.0.0.1:<port>/…`。原生形态下没问题；**容器形态下 `127.0.0.1` 指向
 * 容器自己** —— 实测：宿主上 8787 明明有服务在听，容器里拨 `127.0.0.1:8787` 得到
 * ECONNREFUSED，而拨 `host.docker.internal:8787` 才通。于是"一键生成"在容器里直接不可用，
 * 而 manifest 是**接入方的文件**（不该为了跑容器去改它，改了原生形态又坏）。
 *
 * ## 语义（刻意收得很窄）
 *
 *   · 只有 `CROSSPOST_HOST_GATEWAY` 非空才生效（不设 ≡ 与今天逐字节同行为）
 *   · 只重写**回环主机名**（127.0.0.0/8、localhost、::1、0.0.0.0/::）—— 远程端点原样放过
 *   · 端口/路径/查询原样保留；gateway 里若带 `:端口`，则连端口一起替换
 *   · **不参与端点策略判断**：`checkEndpointPolicy()` 判的始终是**声明值**
 *     （环回直接放行；重写出来的 `host.docker.internal` 不会被当成"未登记的非环回端点"）
 *     —— 安全边界与重写解耦，重写发生在策略之后
 *
 * @returns {{url:string, rewrote:boolean, from:string|null, to:string|null}}
 */
export function applyHostGateway(rawUrl, gateway = process.env.CROSSPOST_HOST_GATEWAY) {
  const gw = String(gateway || '').trim()
  const plain = { url: rawUrl, rewrote: false, from: null, to: null }
  if (!gw) return plain
  let u
  try {
    u = new URL(String(rawUrl))
  } catch {
    return plain // 非法 URL 交给后面的策略/请求去报错，这里不越权
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!isLoopbackHost(host)) return plain
  const from = host
  if (gw.includes(':')) u.host = gw
  else u.hostname = gw
  return { url: u.toString(), rewrote: true, from, to: gw }
}

/** 这个 URL 的主机名是不是回环（doctor 用它解释"容器里回环指向自己"） */
export function isLoopbackUrl(rawUrl) {
  try {
    return isLoopbackHost(new URL(String(rawUrl)).hostname.replace(/^\[|\]$/g, ''))
  } catch {
    return false
  }
}

/** 实际拨号地址（宿主网关重写后）；展示与报错仍用 provider.url（声明值） */
export function dialUrl(provider) {
  return (provider && (provider.requestUrl || provider.url)) || provider.url
}

/** 状态端点的实际拨号地址 */
export function dialStatusUrl(provider) {
  return (provider && (provider.requestStatusUrl || provider.statusUrl)) || provider.statusUrl
}

/** 重写过时，报错文案要带上"声明 → 实拨"，否则会出现"报的地址不是拨的地址" */
export function dialNote(provider) {
  if (!provider || !provider.gateway) return ''
  const u = dialUrl(provider)
  return u !== provider.url ? `（声明 ${provider.url} → 实际拨号 ${u}）` : ''
}

/** 读引擎配置里的 generate 段（读不到就给空对象，绝不因此报错） */
function generateConfig() {
  try {
    const cfg = readConfig()
    const g = cfg && typeof cfg.generate === 'object' && cfg.generate ? cfg.generate : {}
    return {
      policy: {
        allowHosts: Array.isArray(g.allowHosts) ? g.allowHosts : [],
        allowRemote: g.allowRemote === true,
      },
      defaultTimeoutMs:
        Number.isInteger(g.timeoutMs) && g.timeoutMs > 0 ? g.timeoutMs : DEFAULT_TIMEOUT_MS,
      provider: g.provider && typeof g.provider === 'object' ? g.provider : null,
    }
  } catch {
    return { policy: {}, defaultTimeoutMs: DEFAULT_TIMEOUT_MS, provider: null }
  }
}

/** 把 `{kind,url,timeoutMs,…}` 声明规范化成内部 provider 对象 */
function buildHttpProvider(decl, { projectId, source, defaultTimeoutMs }) {
  const clamp = (v, dflt, max, min = 1) =>
    Math.min(Math.max(Number.isInteger(v) && v > 0 ? v : dflt, min), max)
  // 声明值 → 实际拨号值（宿主网关重写）。两者分开存，见 applyHostGateway 的注释：
  // 展示/策略用 url（声明），fetch/probe 用 requestUrl（实拨）。
  const eff = applyHostGateway(decl.url)
  const effStatus =
    typeof decl.statusUrl === 'string'
      ? applyHostGateway(decl.statusUrl)
      : { url: null, rewrote: false }
  return {
    provided: true,
    kind: 'http',
    url: decl.url,
    statusUrl: typeof decl.statusUrl === 'string' ? decl.statusUrl : null,
    requestUrl: eff.url,
    requestStatusUrl: effStatus.url,
    gateway: eff.rewrote ? { from: eff.from, to: eff.to } : null,
    timeoutMs: clamp(decl.timeoutMs, defaultTimeoutMs, GENERATE_MAX_TIMEOUT_MS),
    pollIntervalMs: clamp(decl.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, GENERATE_MAX_POLL_MS, 250),
    overallTimeoutMs: clamp(
      decl.overallTimeoutMs,
      DEFAULT_OVERALL_TIMEOUT_MS,
      GENERATE_MAX_OVERALL_MS,
      1000,
    ),
    tokenEnv: typeof decl.tokenEnv === 'string' ? decl.tokenEnv : null,
    description: typeof decl.description === 'string' ? decl.description : null,
    projectId: projectId || null,
    source,
  }
}

/**
 * 解析"当前上下文"可用的生成提供者（**不含**进程内钩子——那一层在
 * `bridge/topics.mjs`，本模块刻意不 import 它，避免循环依赖）。
 *
 * @param {string|undefined|null} projectId 当前项目上下文（无则走引擎默认）
 * @returns {{provided:true,kind:'http',url:string,timeoutMs:number,projectId:string|null,source:string}
 *          |{provided:false,code:string,reason:string,projectId:string|null}}
 */
export function resolveGenerateProvider(projectId) {
  const cfg = generateConfig()
  const pid = projectId || null

  if (pid) {
    const p = getProject(pid)
    if (!p)
      return {
        provided: false,
        code: 'project_not_registered',
        reason: `未注册的项目: ${pid}`,
        projectId: pid,
      }
    if (!p.valid)
      return {
        provided: false,
        code: 'project_invalid',
        reason: `项目 ${pid} 的 manifest 无效: ${(p.errors || []).join('; ')}`,
        projectId: pid,
      }

    const decl = (p.capabilities || {}).generate
    if (decl === undefined || decl === false)
      return {
        provided: false,
        code: 'generate_not_declared',
        reason: `项目 ${pid} 未声明 generate 能力（manifest capabilities.generate）`,
        projectId: pid,
      }
    if (decl === true)
      return {
        provided: false,
        code: 'generate_inprocess_required',
        reason:
          `项目 ${pid} 只声明了 generate=true（v1 形态），而引擎进程内没有注册 provider。` +
          `跨进程请改用 v2 形态声明 HTTP 端点`,
        projectId: pid,
      }

    const pol = checkEndpointPolicy(decl.url, cfg.policy)
    if (!pol.ok)
      return {
        provided: false,
        code: 'generate_endpoint_blocked',
        reason: `项目 ${pid} 声明的生成端点被策略拒绝: ${pol.reason}`,
        projectId: pid,
      }
    return buildHttpProvider(decl, {
      projectId: pid,
      source: `项目 ${pid} 的 manifest`,
      defaultTimeoutMs: cfg.defaultTimeoutMs,
    })
  }

  // ③ 无项目上下文 → 引擎级默认（同样不走"回退"，只是另一条独立来源）
  if (!cfg.provider)
    return {
      provided: false,
      code: 'generate_not_provided',
      reason: '当前没有项目上下文，且引擎配置未声明 generate.provider',
      projectId: null,
    }
  const pol = checkEndpointPolicy(cfg.provider.url, cfg.policy)
  if (!pol.ok)
    return {
      provided: false,
      code: 'generate_endpoint_blocked',
      reason: `引擎配置 generate.provider 的端点被策略拒绝: ${pol.reason}`,
      projectId: null,
    }
  return buildHttpProvider(cfg.provider, {
    projectId: null,
    source: '引擎配置 generate.provider',
    defaultTimeoutMs: cfg.defaultTimeoutMs,
  })
}

/** 认证头（tokenEnv 指向的环境变量非空时才带） */
function authHeaders(provider) {
  const headers = { accept: 'application/json' }
  if (provider.tokenEnv) {
    const t = process.env[provider.tokenEnv]
    if (t) headers.authorization = `Bearer ${t}`
  }
  return headers
}

/** 发一次请求并归一化：返回 { error, message } 或 { taskId, state, logFile, logTail } */
async function postGenerate(provider, { slot, keyword, projectId }) {
  const headers = { ...authHeaders(provider), 'content-type': 'application/json' }
  const body = JSON.stringify({
    slot: slot ?? null,
    keyword: keyword ?? null,
    projectId: projectId || provider.projectId || null,
    contractVersion: 2,
  })

  let res
  try {
    res = await fetch(dialUrl(provider), {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(provider.timeoutMs),
    })
  } catch (e) {
    const name = (e && e.name) || ''
    if (name === 'TimeoutError' || name === 'AbortError')
      return {
        error: 'generate_provider_timeout',
        message: `生成端点超时（${provider.timeoutMs}ms 未响应）: ${provider.url}${dialNote(provider)}`,
      }
    return {
      error: 'generate_provider_unreachable',
      message: `生成端点不可达: ${provider.url}${dialNote(provider)}（${(e && e.message) || e}）`,
    }
  }

  // 3xx：不接受跳转（白名单可被重定向绕过）
  if (res.status >= 300 && res.status < 400) {
    return {
      error: 'generate_provider_redirect',
      message: `生成端点返回重定向 ${res.status}；契约要求直接响应，不接受跳转（${provider.url}${dialNote(provider)}）`,
    }
  }

  const text = await res.text().catch(() => '')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }

  // 409：项目侧在忙（provider 的并发上限已满），**不是失败**。
  // v2.111 前这里落到下面的 generate_provider_failed，于是"项目侧还有任务在跑"
  // 在 Console 上表现为"生成失败"——用户会去排错，而其实只需要等一会。
  // 单独给一个错误码，让调用方可以（并发>1 时）退避重试、否则给人话。
  if (res.status === 409) {
    const inner = data && (data.message || data.error)
    return {
      error: 'generate_provider_busy',
      busy: true,
      message:
        (inner ? `${inner} · ` : '') +
        `项目侧生成端点正忙（${provider.url}${dialNote(provider)}）· 稍后重试`,
    }
  }

  if (!res.ok) {
    const inner = data && (data.message || data.error)
    return {
      error: 'generate_provider_failed',
      message: `生成端点返回 ${res.status}${inner ? `: ${inner}` : text ? `: ${text.slice(0, 200)}` : ''}`,
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return {
      error: 'generate_provider_bad_response',
      message: `生成端点响应不是 JSON 对象（收到 ${text ? text.slice(0, 120) : '空响应'}）`,
    }
  if (data.error)
    return { error: 'generate_provider_rejected', message: String(data.message || data.error) }

  const state = typeof data.state === 'string' ? data.state : 'done'
  if (!['running', 'done', 'failed'].includes(state))
    return {
      error: 'generate_provider_bad_response',
      message: `生成端点返回了未知 state=${JSON.stringify(data.state)}（允许 running/done/failed）`,
    }
  const out = {
    taskId: data.taskId ? String(data.taskId) : null,
    // 生成出来的**文章草稿 id**（与 taskId 不是一回事）。项目侧可让生成脚本在
    // stdout 打印 `[draft-id] <id>`（参考实现会捡取并回报），引擎据此回填选题库的
    // articleId、并给 Console 一个可达的"查看《…》"链接。
    // 缺了它时**不要**拿 taskId 顶替 —— 那会把一个不存在的 id 写进选题库。
    draftId: data.draftId ? String(data.draftId) : null,
    state,
    logFile: data.logFile ? String(data.logFile) : null,
    logTail: typeof data.logTail === 'string' ? data.logTail : '',
  }
  if (state === 'failed')
    return {
      error: 'generate_provider_failed',
      message: String(data.message || '生成端点报告 state=failed'),
      taskId: out.taskId,
    }
  return out
}

/** 轮询状态端点，直到 done/failed 或整任务超时 */
async function pollGenerate(provider, taskId, { onProgress } = {}) {
  const deadline = Date.now() + provider.overallTimeoutMs
  let consecutive = 0
  let last = { draftId: null, logFile: null, logTail: '', state: 'running' }

  for (;;) {
    if (Date.now() >= deadline)
      return {
        error: 'generate_provider_timeout',
        message:
          `生成任务 ${taskId || '(无 taskId)'} 在 ${provider.overallTimeoutMs}ms 内未结束` +
          `（最后状态 ${last.state}）· 状态端点 ${provider.statusUrl}`,
      }
    await sleep(provider.pollIntervalMs)

    let data = null
    try {
      const u = new URL(dialStatusUrl(provider))
      if (taskId) u.searchParams.set('taskId', taskId)
      const res = await fetch(u.toString(), {
        method: 'GET',
        headers: authHeaders(provider),
        redirect: 'manual',
        signal: AbortSignal.timeout(provider.timeoutMs),
      })
      if (res.status >= 300 && res.status < 400) throw new Error(`重定向 ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data = await res.json()
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('响应不是 JSON 对象')
      consecutive = 0
    } catch (e) {
      // 单次轮询失败（网络抖动 / 项目侧重启）不立刻判死；连续多次才认输
      consecutive++
      if (consecutive >= 5)
        return {
          error: 'generate_provider_unreachable',
          message: `连续 ${consecutive} 次轮询状态端点失败: ${provider.statusUrl}${dialNote({ ...provider, url: provider.statusUrl, requestUrl: provider.requestStatusUrl })}（${(e && e.message) || e}）`,
        }
      continue
    }

    if (data.error && !data.state)
      return { error: 'generate_provider_rejected', message: String(data.message || data.error) }

    const state = typeof data.state === 'string' ? data.state : 'running'
    last = {
      draftId: data.draftId ? String(data.draftId) : last.draftId,
      logFile: data.logFile ? String(data.logFile) : last.logFile,
      logTail: typeof data.logTail === 'string' ? data.logTail : last.logTail,
      state,
    }
    if (typeof onProgress === 'function') {
      try {
        onProgress({ taskId, ...last })
      } catch {
        /* 进度回调出错不影响任务本身 */
      }
    }
    if (state === 'done') return { taskId: taskId || null, ...last }
    if (state === 'failed')
      return {
        error: 'generate_provider_failed',
        message: String(data.message || '生成端点报告 state=failed'),
        taskId: taskId || null,
      }
  }
}

/**
 * 调用 HTTP 生成端点。
 *
 * 请求：`POST <url>`，JSON `{slot, keyword, projectId, contractVersion}`；
 * 若声明了 `tokenEnv` 且该环境变量非空，带 `Authorization: Bearer <值>`。
 *
 * 响应约定（2xx + JSON 对象）：
 *   · `{ "taskId": "…", "logFile": "…", "logTail": "…" }`（无 state）= 同步完成
 *   · `{ "state": "running", "taskId": "…" }` = 已受理；**必须**同时声明
 *     `statusUrl`，引擎按 `pollIntervalMs` 轮询 `GET <statusUrl>?taskId=…`
 *     直到 `done`/`failed`，整任务上限 `overallTimeoutMs`
 *   · `{ "error": "…", "message": "…" }` = 项目侧明确拒绝
 *
 * 为什么必须有异步模式：真实生成要跑几分钟到几十分钟，靠"一个 HTTP 请求一直挂着"
 * 表达进度，任何一个中间层（代理、容器、项目侧重启）都可能把它掐断，而掐断之后
 * 引擎**不知道任务到底还在不在跑**——这比"慢"糟得多。异步模式下状态在项目侧，
 * 引擎重启也能重新问。
 *
 * 其余情况（超时 / 连不上 / 重定向 / 非 JSON）一律返回结构化错误，**绝不抛出**
 * ——调用方是一个 HTTP 路由，抛出去只会变成 500 加一句栈。
 *
 * 注意：本函数只负责"发起并跟踪一次任务"，**并发保护与状态机在
 * `bridge/topics.mjs`**（引擎不假设项目侧的幂等性：队列在引擎侧，这条调用
 * 只在拿到运行位之后才发生）。
 *
 * v2.111：`allowBusyRetry` 打开时，端点返回 409 会**退避后重发**（最多 BUSY_RETRY_MAX 次）。
 * 这只在引擎侧并发 > 1 时被打开——那种情况下 409 是"项目侧并发更小，等一下就能接单"，
 * 重发安全（409 意味着项目侧根本没接单，不会开出两条真实生成）。
 *
 * @param {object} provider resolveGenerateProvider() 的返回值
 * @param {{slot?:string,keyword?:string,projectId?:string|null,onProgress?:(p:object)=>void,
 *          allowBusyRetry?:boolean}} [opts]
 */
export async function callGenerateProvider(
  provider,
  { slot, keyword, projectId, onProgress, allowBusyRetry = false } = {},
) {
  let post = await postGenerate(provider, { slot, keyword, projectId })
  for (let attempt = 0; post.error === 'generate_provider_busy'; attempt++) {
    if (!allowBusyRetry || attempt >= BUSY_RETRY_MAX) break
    // 退避带抖动：避免多条任务在同一刻齐步重试、把刚空出的并发位再次挤满
    const wait = BUSY_RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 500)
    if (typeof onProgress === 'function') {
      try {
        onProgress({
          state: 'running',
          logTail: `项目侧生成端点正忙，${Math.round(wait / 1000)}s 后重试（第 ${attempt + 1}/${BUSY_RETRY_MAX} 次）`,
        })
      } catch {
        /* ignore */
      }
    }
    await sleep(wait)
    post = await postGenerate(provider, { slot, keyword, projectId })
  }
  if (post.error) return post
  if (post.state !== 'running')
    return {
      taskId: post.taskId,
      draftId: post.draftId,
      logFile: post.logFile,
      logTail: post.logTail,
    }
  if (!provider.statusUrl)
    return {
      error: 'generate_provider_async_unsupported',
      message:
        `生成端点返回 state=running，但 manifest 未声明 statusUrl，引擎无法跟踪进度` +
        `（${provider.url}）。要么让端点同步返回结果，要么补上 "statusUrl"。`,
    }
  if (typeof onProgress === 'function') {
    try {
      onProgress({
        taskId: post.taskId,
        draftId: post.draftId,
        state: 'running',
        logFile: post.logFile,
        logTail: post.logTail,
      })
    } catch {
      /* ignore */
    }
  }
  return pollGenerate(provider, post.taskId, { onProgress })
}

/**
 * 端点可达性探测（doctor 用）。
 *
 * 刻意只做 **TCP 连接**，不发 HTTP 请求：生成端点按契约是 `POST` 触发真实
 * 生成任务，用 GET/HEAD"探活"有把用户的检查变成一次真实生成的风险
 * （自测脚本写生产数据，本项目已经栽过两次）。TCP 连上就说明"有东西在听"，
 * 正是"声明了但没人监听"这个最常见的坏法。
 */
export function probeEndpoint(provider, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    // 探的必须是**实际拨号**的地址（宿主网关重写后）——否则容器形态下会出现
    // "体检说连不上、其实生成能跑"（探 127.0.0.1 而真正拨 host.docker.internal）。
    const target = dialUrl(provider)
    let u
    try {
      u = new URL(target)
    } catch {
      resolve({ reachable: false, reason: `不是合法 URL: ${target}` })
      return
    }
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    const host = u.hostname.replace(/^\[|\]$/g, '')
    // 重写过时把两段地址都带上，方便排障时一眼看出"声明 vs 实拨"
    const via = provider.gateway && target !== provider.url ? { declaredUrl: provider.url } : {}
    const sock = net.connect({ host, port })
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done({ reachable: true, host, port, ...via }))
    sock.once('timeout', () =>
      done({ reachable: false, host, port, reason: `${timeoutMs}ms 内未建立 TCP 连接`, ...via }),
    )
    sock.once('error', (e) =>
      done({ reachable: false, host, port, reason: (e && e.message) || String(e), ...via }),
    )
  })
}
