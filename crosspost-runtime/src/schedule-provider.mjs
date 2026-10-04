/**
 * 槽位执行器能力：**声明式跨进程契约**（2026-09-25）。
 *
 * ── 它补的是哪一处越界 ─────────────────────────────────────────────────
 *
 * 基座对「一键生成」已经做过一次边界迁移（见 `generate.mjs` 头部与
 * `bridge/topics.mjs` 的 P0/P2 注释）：**"引擎执行某个具体接入方的业务脚本，
 * 是边界越界最严重的一处"** —— 改成"项目在自己的 manifest 里声明一个 HTTP 端点，
 * 引擎只做编排（受理 / 轮询 / 记账），执行方由项目自己决定"。
 *
 * 但**槽位执行器**一直是例外：调度器到点以后，在**基座自己的进程/命名空间**里
 * `spawn` 项目声明的 `command`（`scheduler/runner.mjs`）。原生形态下两者同机，
 * 这个越界看不出来；**容器化以后它会立刻变成硬故障** —— 实测（2026-09-25 18:10
 * tips 槽位）容器是 linux-x64，而项目脚本里的 `dsh` 是宿主上按 darwin 装的原生二进制，
 * 于是"定时器归容器"直接让**所有**项目槽位静默失败（exit=1、零产出、界面还写着
 * "今日已跑"）。
 *
 * 本模块就是把这最后一次越界补齐，规则与 generate 完全对称：
 *
 *     "capabilities": {
 *       "schedule": { "kind": "http", "url": "http://127.0.0.1:8788/slot/run",
 *                     "statusUrl": "http://127.0.0.1:8788/slot/status" }
 *     }
 *
 *   · `true`（v1 形态）与"没声明"都等价于**旧的本地命令执行器**（向后兼容）
 *   · 一旦声明成对象，**就是 http 执行器**：解析失败/端点被策略拒绝时
 *     `commandAvailable=false` + 原因照实上报，**绝不回落到本地 spawn**
 *     （回落会让边界重新变模糊，正是这次要治的病）
 *
 * ── 与 generate 的关系 ────────────────────────────────────────────────
 *
 * 策略校验、宿主网关重写、拨号地址与报错文案**直接复用 `generate.mjs` 的导出件**
 * （不另写一份，避免两套边界规则漂移）。本模块只做三件 generate 没有的事：
 * 读 `capabilities.schedule`、按槽位语义发 `{slot,date,runId,deadlineMs}`、
 * 把回报映射成"退出码 + 时长"（因为调度器记账用的是 exit/endedAt，不是 taskId）。
 */
import { readConfig } from './config-cache.mjs'
import {
  getProject,
  SCHEDULE_MAX_OVERALL_MS,
  SCHEDULE_MAX_POLL_MS,
  SCHEDULE_MAX_TIMEOUT_MS,
} from './projects.mjs'
import {
  applyHostGateway,
  checkEndpointPolicy,
  dialNote,
  dialStatusUrl,
  dialUrl,
} from './generate.mjs'

/** 受理（POST）的缺省超时：只等"接没接"，不等跑完 */
export const DEFAULT_ACCEPT_TIMEOUT_MS = 30000
/** 缺省轮询间隔（槽位动辄几分钟，2s 太吵） */
export const DEFAULT_POLL_INTERVAL_MS = 5000
/** 单次槽位的缺省总预算：1 小时（观测到的最长一轮 224s，留足余量） */
export const DEFAULT_OVERALL_TIMEOUT_MS = 3600000
/**
 * 上限**定义在 `projects.mjs`**（manifest 校验与这里夹取必须是同一份数字，
 * 否则会出现"声明合法但运行时被夹成别的值"这种自相矛盾）。
 */
export const SLOT_MAX_ACCEPT_TIMEOUT_MS = SCHEDULE_MAX_TIMEOUT_MS
export const SLOT_MAX_POLL_MS = SCHEDULE_MAX_POLL_MS
export const SLOT_MAX_OVERALL_MS = SCHEDULE_MAX_OVERALL_MS

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析结果里"这不是 http 执行器，走本地命令"的两种 code（其余一律视为声明了但不可用） */
export const LOCAL_EXECUTOR_CODES = ['schedule_not_declared', 'schedule_local_true']

/**
 * 读引擎配置里的槽位执行器段。
 *
 * 注意键名刻意**不叫 `schedule`**：`config.schedule` 已经是"槽位开关表"
 * （`{morning:false,…}`），撞上去会把开关读成策略。
 */
function slotExecutorConfig() {
  try {
    const cfg = readConfig()
    const s =
      cfg && typeof cfg.slotExecutor === 'object' && cfg.slotExecutor ? cfg.slotExecutor : {}
    return {
      policy: {
        allowHosts: Array.isArray(s.allowHosts) ? s.allowHosts : [],
        allowRemote: s.allowRemote === true,
      },
      defaultTimeoutMs:
        Number.isInteger(s.timeoutMs) && s.timeoutMs > 0 ? s.timeoutMs : DEFAULT_ACCEPT_TIMEOUT_MS,
      provider: s.provider && typeof s.provider === 'object' ? s.provider : null,
    }
  } catch {
    return { policy: {}, defaultTimeoutMs: DEFAULT_ACCEPT_TIMEOUT_MS, provider: null }
  }
}

function buildHttpProvider(decl, { projectId, source, defaultTimeoutMs }) {
  const clamp = (v, dflt, max, min = 1) =>
    Math.min(Math.max(Number.isInteger(v) && v > 0 ? v : dflt, min), max)
  const eff = applyHostGateway(decl.url)
  const effStatus =
    typeof decl.statusUrl === 'string' ? applyHostGateway(decl.statusUrl) : { url: null }
  const effCancel =
    typeof decl.cancelUrl === 'string' ? applyHostGateway(decl.cancelUrl) : { url: null }
  return {
    provided: true,
    kind: 'http',
    url: decl.url,
    statusUrl: typeof decl.statusUrl === 'string' ? decl.statusUrl : null,
    cancelUrl: typeof decl.cancelUrl === 'string' ? decl.cancelUrl : null,
    requestUrl: eff.url,
    requestStatusUrl: effStatus.url,
    requestCancelUrl: effCancel.url,
    gateway: eff.rewrote ? { from: eff.from, to: eff.to } : null,
    timeoutMs: clamp(decl.timeoutMs, defaultTimeoutMs, SLOT_MAX_ACCEPT_TIMEOUT_MS),
    pollIntervalMs: clamp(decl.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, SLOT_MAX_POLL_MS, 250),
    overallTimeoutMs: clamp(
      decl.overallTimeoutMs,
      DEFAULT_OVERALL_TIMEOUT_MS,
      SLOT_MAX_OVERALL_MS,
      1000,
    ),
    tokenEnv: typeof decl.tokenEnv === 'string' ? decl.tokenEnv : null,
    description: typeof decl.description === 'string' ? decl.description : null,
    projectId: projectId || null,
    source,
  }
}

/**
 * 解析某个项目当前生效的槽位执行器。
 *
 * @param {string|undefined|null} projectId 项目上下文（引擎内置槽位不走这里）
 * @returns {{provided:true,kind:'http',url:string,statusUrl:string|null,projectId:string|null,source:string}
 *          |{provided:false,code:string,reason:string,projectId:string|null}}
 */
export function resolveScheduleProvider(projectId) {
  const cfg = slotExecutorConfig()
  const pid = projectId || null

  if (!pid)
    return {
      provided: false,
      code: 'schedule_no_project',
      reason: '引擎内置槽位不走项目执行器（引擎自己跑自己的脚本）',
      projectId: null,
    }

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

  const decl = (p.capabilities || {}).schedule
  // `true` = v1 形态（"这个项目有槽位"）→ 与没声明一样都走本地命令执行器
  if (decl === undefined || decl === false || decl === true)
    return {
      provided: false,
      code: decl === true ? 'schedule_local_true' : 'schedule_not_declared',
      reason:
        decl === true
          ? `项目 ${pid} 的 capabilities.schedule=true：使用本地命令执行器（槽位 command 在基座进程里跑）`
          : `项目 ${pid} 未声明 schedule 执行器：使用本地命令执行器`,
      projectId: pid,
    }

  if (!decl || typeof decl !== 'object' || Array.isArray(decl))
    return {
      provided: false,
      code: 'schedule_invalid',
      reason: `项目 ${pid} 的 capabilities.schedule 必须是 true 或 {kind:'http',url,…} 对象`,
      projectId: pid,
    }
  if (decl.kind !== 'http')
    return {
      provided: false,
      code: 'schedule_kind_unknown',
      reason: `项目 ${pid} 的 schedule 执行器 kind=${JSON.stringify(decl.kind)} 未知（目前只支持 http）`,
      projectId: pid,
    }
  if (typeof decl.url !== 'string' || !decl.url.trim())
    return {
      provided: false,
      code: 'schedule_invalid',
      reason: `项目 ${pid} 的 schedule 执行器缺少 url`,
      projectId: pid,
    }

  const pol = checkEndpointPolicy(decl.url, cfg.policy)
  if (!pol.ok)
    return {
      provided: false,
      code: 'schedule_endpoint_blocked',
      reason:
        `项目 ${pid} 声明的槽位执行端点被策略拒绝: ${pol.reason}` +
        `（槽位执行器的白名单在引擎配置 slotExecutor.allowHosts / slotExecutor.allowRemote）`,
      projectId: pid,
    }

  return buildHttpProvider(decl, {
    projectId: pid,
    source: `项目 ${pid} 的 manifest`,
    defaultTimeoutMs: cfg.defaultTimeoutMs,
  })
}

/**
 * 把解析结果归一成**槽位规格**用的执行器描述（JSON 安全；不塞 provider 对象）。
 *
 * `spec.mjs` 因此完全不需要懂能力语义：它只看到 `null`（本地命令执行器）、
 * `{kind:'http',…}`（可执行）或 `{kind:'http',unavailable:true,reason}`（声明了但不可用）。
 * 后者**绝不回落**本地 spawn —— 回落会让边界重新变模糊（见模块头）。
 */
export function toSpecExecutor(resolved) {
  if (!resolved) return null
  if (resolved.provided)
    return {
      kind: 'http',
      url: resolved.url,
      statusUrl: resolved.statusUrl || null,
      cancelUrl: resolved.cancelUrl || null,
      gateway: resolved.gateway || null,
      source: resolved.source,
    }
  if (LOCAL_EXECUTOR_CODES.includes(resolved.code)) return null
  return { kind: 'http', unavailable: true, code: resolved.code, reason: resolved.reason }
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

/**
 * 发一次受理请求（POST url）并归一化响应。
 * @returns {{taskId:string|null,state:'running'|'done'|'failed',exit:number|null,durationMs:number|null,logFile:string|null,logTail:string}
 *          |{error:string,message:string}}
 */
async function postRun(provider, { slot, date, runId, deadlineMs, projectId }) {
  const headers = { ...authHeaders(provider), 'content-type': 'application/json' }
  const body = JSON.stringify({
    slot: slot ?? null,
    date: date ?? null,
    runId: runId ?? null,
    deadlineMs: Number.isFinite(deadlineMs) ? deadlineMs : null,
    projectId: projectId || provider.projectId || null,
    contractVersion: 1,
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
        error: 'slot_provider_timeout',
        message: `槽位执行端点超时（${provider.timeoutMs}ms 未响应）: ${provider.url}${dialNote(provider)}`,
      }
    return {
      error: 'slot_provider_unreachable',
      message: `槽位执行端点不可达: ${provider.url}${dialNote(provider)}（${(e && e.message) || e}）`,
    }
  }

  if (res.status >= 300 && res.status < 400)
    return {
      error: 'slot_provider_redirect',
      message: `槽位执行端点返回重定向 ${res.status}；契约要求直接响应，不接受跳转（${provider.url}${dialNote(provider)}）`,
    }

  const text = await res.text().catch(() => '')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }

  if (!res.ok) {
    const inner = data && (data.message || data.error)
    return {
      error: 'slot_provider_failed',
      message: `槽位执行端点返回 ${res.status}${inner ? `: ${inner}` : text ? `: ${text.slice(0, 200)}` : ''}`,
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return {
      error: 'slot_provider_bad_response',
      message: `槽位执行端点响应不是 JSON 对象（收到 ${text ? text.slice(0, 120) : '空响应'}）`,
    }
  if (data.error)
    return { error: 'slot_provider_rejected', message: String(data.message || data.error) }

  const state = typeof data.state === 'string' ? data.state : 'done'
  if (!['running', 'done', 'failed'].includes(state))
    return {
      error: 'slot_provider_bad_response',
      message: `槽位执行端点返回了未知 state=${JSON.stringify(data.state)}（允许 running/done/failed）`,
    }
  const out = {
    taskId: data.taskId ? String(data.taskId) : null,
    state,
    exit: Number.isInteger(data.exit) ? data.exit : null,
    durationMs: Number.isFinite(data.durationMs) ? Number(data.durationMs) : null,
    logFile: data.logFile ? String(data.logFile) : null,
    logTail: typeof data.logTail === 'string' ? data.logTail : '',
    message: typeof data.message === 'string' ? data.message : null,
  }
  if (state === 'failed')
    return {
      error: 'slot_provider_failed',
      message: String(data.message || '槽位执行端点报告 state=failed'),
      ...out,
    }
  return out
}

/** 轮询状态端点，直到 done/failed 或整任务超时 */
async function pollRun(provider, taskId, { onProgress } = {}) {
  const deadline = Date.now() + provider.overallTimeoutMs
  let consecutive = 0
  let last = { exit: null, durationMs: null, logFile: null, logTail: '', state: 'running' }

  for (;;) {
    if (Date.now() >= deadline)
      return {
        error: 'slot_provider_timeout',
        message:
          `槽位任务 ${taskId || '(无 taskId)'} 在 ${provider.overallTimeoutMs}ms 内未结束` +
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
          error: 'slot_provider_unreachable',
          message: `连续 ${consecutive} 次轮询状态端点失败: ${provider.statusUrl}${dialNote({ ...provider, url: provider.statusUrl, requestUrl: provider.requestStatusUrl })}（${(e && e.message) || e}）`,
        }
      continue
    }

    if (data.error && !data.state)
      return { error: 'slot_provider_rejected', message: String(data.message || data.error) }

    const state = typeof data.state === 'string' ? data.state : 'running'
    last = {
      exit: Number.isInteger(data.exit) ? data.exit : last.exit,
      durationMs: Number.isFinite(data.durationMs) ? Number(data.durationMs) : last.durationMs,
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
        error: 'slot_provider_failed',
        message: String(data.message || '槽位执行端点报告 state=failed'),
        taskId: taskId || null,
        ...last,
      }
  }
}

/**
 * 跑一次槽位：受理 → 轮询 → 归一成 `{ok,exit,durationMs,…}`。
 *
 * 与 generate 的差别：槽位记账要的是 **exit + 时长**（调度器用它们算
 * `completedToday/lastExit/daysSince`），所以这里把远程状态映射成进程语义：
 * `done → exit 0`、`failed → exit (回报里的 exit ?? 1)`。
 *
 * 返回值恒带 `ok`：失败路径一律 `{ok:false, error, message, exit?}` ——
 * 调用方（执行器）要用 `exit` 记账，不能只拿到一个 `error` 字符串。
 */
export async function callScheduleProvider(
  provider,
  { slot, date, runId, deadlineMs, projectId, onProgress } = {},
) {
  const accepted = await postRun(provider, { slot, date, runId, deadlineMs, projectId })
  if (accepted.error)
    return {
      ok: false,
      ...accepted,
      exit: Number.isInteger(accepted.exit) ? accepted.exit : 1,
    }

  if (accepted.state === 'done') return { ok: true, ...accepted, exit: accepted.exit ?? 0 }
  if (accepted.state === 'failed')
    return {
      ok: false,
      error: accepted.error || 'slot_provider_failed',
      message: accepted.message || `槽位 ${slot} 在项目侧失败`,
      exit: Number.isInteger(accepted.exit) ? accepted.exit : 1,
      durationMs: accepted.durationMs,
      logFile: accepted.logFile,
      logTail: accepted.logTail,
      taskId: accepted.taskId,
    }

  if (!provider.statusUrl)
    return {
      ok: false,
      error: 'slot_provider_no_status',
      message:
        `项目声明了异步执行器（返回 state=running），但 manifest 未声明 statusUrl，` +
        `引擎无法跟踪进度（${provider.url}）。要么让端点同步返回结果，要么补上 "statusUrl"。`,
    }

  const polled = await pollRun(provider, accepted.taskId, { onProgress })
  if (polled.error) return { ok: false, ...polled, exit: polled.exit ?? 1, taskId: accepted.taskId }
  return { ok: true, ...polled, exit: polled.exit ?? 0, taskId: accepted.taskId }
}

/** 尽力而为地取消一个远程槽位任务（项目没实现 cancelUrl 时返回 not-supported） */
export async function cancelScheduleProvider(provider, taskId) {
  if (!provider || !provider.requestCancelUrl || !taskId)
    return { ok: false, reason: 'not-supported' }
  try {
    const res = await fetch(provider.requestCancelUrl, {
      method: 'POST',
      headers: { ...authHeaders(provider), 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: String(taskId) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(provider.timeoutMs),
    })
    return { ok: res.ok, status: res.status }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}
