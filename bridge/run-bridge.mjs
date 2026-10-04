#!/usr/bin/env node
/**
 * CrossPost 本地桥运行器（单通道：迷你代理扩展，N2）
 *
 *   WS  = SYNC_PROXY_WS_PORT 默认 9539（迷你扩展连这里）
 *   HTTP= WS+1               默认 9540
 *   端点: GET  /proxy/status
 *         GET  /proxy/platforms[?refresh=1]
 *         POST /proxy/request    {method:'proxyFetch'|'getCookie'|'pageOp'|'tabs*'|'ping', params}
 *
 * 通道1（早期外部扩展的 MCP 桥接，9537/9538）已于 2026-08 移除——原生代理通道
 * 已覆盖全部平台，桥接模式（外部工具前缀 / mcp-server / token）随之删除。
 */
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lazyPaths } from '../crosspost-runtime/src/paths.mjs'
import { buildPlatformMatrix } from '../crosspost-runtime/src/platform-matrix.mjs'
import { registrySummary } from '../crosspost-runtime/src/projects.mjs'
import {
  withProject,
  projectFromRequest,
  currentProject,
} from '../crosspost-runtime/src/project-context.mjs'
import { versionInfo } from '../crosspost-runtime/src/version.mjs'
import { checkExtensionCompatibility } from '../crosspost-runtime/src/extension-compat.mjs'
import {
  runCli,
  CONFIG_PATH,
  NATIVE_CLI,
  workersHealth,
  prewarmWorkers,
  stopWorkers,
  writeConfigFile,
  writeConfigScoped,
  writeProjectConfigFile,
  readEngineConfigFile,
  readFullRuntimeConfig,
  projectPlatformDefaults,
} from './cli-worker.mjs'
import {
  classifyKey,
  projectOverriddenKeys,
  readProjectConfig,
} from '../crosspost-runtime/src/config-layers.mjs'
import {
  listTopics,
  deleteTopic,
  startTopicGenerate,
  getTopicGenStatus,
  getTopicGenTasks,
  cancelTopicGenerate,
  preflightGenerate,
  setConfigReader as setTopicsConfigReader,
} from './topics.mjs'
import { normalizeSlotId } from '../crosspost-runtime/src/scheduler/spec.mjs'
import { detectIconExt } from './icon-detect.mjs'
import {
  getScheduleStatus,
  setScheduleSlot,
  upsertScheduleSlot,
  removeScheduleSlot,
  startScheduler,
  stopScheduler,
  triggerScheduleSlot,
} from './schedule.mjs'
import { backupArticles, maybeBackupArticles, getBackupStatus } from './backup.mjs'
import {
  TARGET_PLATFORMS,
  CHECK_ONLY_PLATFORMS,
  resolveScopeFromLayers,
  emptyState,
  applyCheckResults,
  pruneState,
  selectRetryIds,
  selectFailures,
  failedDetails,
  authedIdsFrom,
  GIVE_UP_AFTER_MS,
  FAIL_BACKOFF_STEPS,
} from './platforms-retry.mjs'

/* ── 日志时间戳（2026-09-12）─────────────────────────────────────────────
 * 此前 bridge 日志**完全没有时间戳**：复盘「某平台什么时候开始失败 / 什么时候换了浏览器」
 * 只能靠备份文件名插值，而备份名是 UTC（`articles-2026-09-12-04-28-44` 实为本地 12:28:44），
 * 二次误读风险很高。这里给所有 console 输出统一加本地 ISO 时间戳（带时区偏移），
 * 不改任何既有调用点。 */
function isoLocal(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  )
}
for (const level of ['log', 'error', 'warn']) {
  const orig = console[level].bind(console)
  console[level] = (...args) => orig(isoLocal(), ...args)
}

const require = createRequire(import.meta.url)
const { WebSocketServer } = require('ws')

const proxyWsPort = parseInt(process.env.SYNC_PROXY_WS_PORT || '9539', 10)
/** HTTP API 端口恒为 WS+1（与扩展、Console、沙箱约定一致） */
const proxyHttpPort = proxyWsPort + 1

/**
 * 删除授权校验（2026-08-24 实现，对齐 OPERATION-RULES 删除铁律）：
 * 所有删除类端点要求请求体携带 authorized: true（Console 删除操作均带，
 * 前端确认后提交），否则 403 拒绝。防 API 误删/未确认触发。
 */
function requireDeleteAuth(reqData) {
  if (reqData && reqData.authorized === true) return null
  return {
    code: 403,
    error: '删除需授权：请携带 authorized: true（删除铁律：删除类操作须确认授权）',
  }
}

/**
 * 校验一条「一键生成」批量入参（v2.111）。
 *
 * 批量入口一次收 N 条，其中一条不合法不该让整批失败——返回 `null` 表示这条可用，
 * 否则返回带原因的对象，由调用方放进 `failures` 里逐条回报。
 * 规则与单条入口**逐字一致**（栏目 id 形状 + keyword 非空），否则批量会成为绕过校验的后门。
 */
function validateTopicItem(it) {
  const slot = it && it.slot
  if (!normalizeSlotId(slot)) {
    return {
      slot: slot ?? null,
      keyword: (it && it.keyword) || null,
      message: 'slot 必须是合法的栏目 id（小写字母开头，字母/数字/横线，≤32 字）',
    }
  }
  if (!it.keyword || !String(it.keyword).trim()) {
    return { slot, keyword: null, message: 'keyword 必填' }
  }
  return null
}

/* 2026-09-18（v2.01，引擎自治）：路径改为懒解析。
 * 原先 `const paths = loadPaths()` 在桥启动时固化全部路径，使配置变更、
 * 隔离沙箱与多项目接入都无法生效。token 文件路径同样改为按需解析。 */
const paths = lazyPaths()
const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const CONSOLE_DIR = path.join(BRIDGE_DIR, 'console')
const BRAND_DIR = path.join(BRIDGE_DIR, 'brand')

/* 选题库生成队列读配置的来源（v2.111）：注入桥自己的读法，而不是让 topics.mjs
 * 直接 import —— 桥认 `CROSSPOST_CONFIG` 与项目覆盖层，两处必须同源，
 * 否则会出现"Console 读的是沙箱配置、队列读的是生产配置"那类脑裂（v2.47 教训）。 */
setTopicsConfigReader(() => readFullRuntimeConfig())

/* ── 本地 API 最小鉴权（2026-08-24 P0-3）──────────────────────────────
 * token.local：bridge 启动生成随机 token（600 权限），
 *  - 浏览器端（Console / 扩展 popup）：先 GET /proxy/bootstrap 同源/受信源取 token，之后带 X-CrossPost-Token
 *  - Node 内部（cli runtime proxyCall）：读 token.local 文件带 header
 *  - /proxy/bootstrap 与静态页面免鉴权；其余 /proxy/* 一律校验
 * CORS 仅放行 Console 自身源 + 本扩展源；响应带 CSP。 */
const tokenFile = () => paths.tokenFile
let apiToken = ''
function ensureApiToken() {
  const TOKEN_FILE = tokenFile()
  try {
    if (!fs.existsSync(TOKEN_FILE)) {
      apiToken = crypto.randomBytes(24).toString('base64url')
      fs.writeFileSync(TOKEN_FILE, apiToken, { mode: 0o600 })
    } else {
      apiToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    }
    if (!apiToken) throw new Error('empty token')
  } catch {
    // 极少发生（文件被删/权限异常）：降级为一次性随机 token（不落盘），后续请求仍可用
    apiToken = crypto.randomBytes(24).toString('base64url')
    try {
      fs.writeFileSync(TOKEN_FILE, apiToken, { mode: 0o600 })
    } catch {
      /* 写失败不阻塞 */
    }
  }
  return apiToken
}
/* CORS 白名单：从实际 HTTP 端口派生（2026-09-18 v2.01）。
 * 原先把 9540 写死，导致 SYNC_PROXY_WS_PORT 被改（沙箱/多实例/端口冲突迁移）后
 * Console 自身源不在白名单、全部请求被 CORS 拦掉。 */
const ALLOWED_ORIGINS = [`http://127.0.0.1:${proxyHttpPort}`, `http://localhost:${proxyHttpPort}`]
function setCors(res, origin) {
  let allowed = null
  if (origin && (ALLOWED_ORIGINS.includes(origin) || origin.startsWith('chrome-extension://')))
    allowed = origin
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed)
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    // 2026-09-19（v2.35）：必须列出**自定义**请求头，否则跨源调用方的预检会失败、
    // 请求被浏览器直接拦掉。此前只有 Content-Type / X-CrossPost-Token，
    // 而 v2.22 起内容域多了 X-CrossPost-Project —— 不列进来的话，
    // 文档里承诺的"用请求头指定项目"对浏览器侧调用方根本不成立（curl 不受影响，
    // 所以只在真浏览器跨源时暴露）。同源的 Console 不走预检，故也不受影响。
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-CrossPost-Token, X-CrossPost-Project',
    )
    res.setHeader('Access-Control-Max-Age', '3600')
  }
}
function hasApiToken(req) {
  // 2026-08-28 A3：token 仅走 header X-CrossPost-Token，不再接受 ?token= 查询串
  // （查询串会出现在日志/历史记录中泄露 token，且违背"凭据只放 header"契约）
  const h = req.headers['x-crosspost-token']
  return !!(h && h === apiToken)
}
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https: blob:; connect-src 'self'; frame-src 'self' about:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'"

// ===== 平台掉线告警（P6）：曾登录 → 本次未登录 → 通知 =====
const authSnapshot = new Map() // platformId -> { wasOk, notified }
let lastDropNotified = '' // 防刷屏：同一轮全量检查只通知一次（合并平台）

/** 每次平台状态更新后调用：检测"曾登录→掉线"的平台 */
function notePlatformAuth(platforms) {
  const drops = []
  for (const p of platforms || []) {
    const prev = authSnapshot.get(p.id)
    if (!prev) {
      authSnapshot.set(p.id, { wasOk: !!p.isAuthenticated, notified: false })
      continue
    }
    if (p.isAuthenticated) {
      if (!prev.wasOk) {
        prev.wasOk = true
        prev.notified = false
      } else prev.wasOk = true
    } else {
      if (prev.wasOk && !prev.notified) {
        prev.notified = true
        drops.push(p)
      }
    }
  }
  if (drops.length && lastDropNotified !== new Date().toISOString().slice(0, 10)) {
    lastDropNotified = new Date().toISOString().slice(0, 10)
    notifyPlatformDrops(drops)
  }
}

function notifyPlatformDrops(drops) {
  const lines = drops.map((p) => {
    const st = platformsCache.state.platforms[p.id] || {}
    const lastAuth = st.lastAuthAt ? new Date(st.lastAuthAt).toLocaleString('sv-SE') : '无记录'
    return `- ${p.name || p.id}：${(p.error || '未检测到登录态').slice(0, 60)}（最后成功 ${lastAuth}）`
  })
  const src = proxyClient
    ? `当前代理来源：client=${proxyClient.clientId || '?'}（${proxyClient.ua || 'UA 未知'}）`
    : '当前代理来源：扩展未连接'
  const tmp = path.join(os.tmpdir(), `crosspost-drop-${Date.now()}.json`)
  fs.writeFileSync(
    tmp,
    JSON.stringify({
      idempotencyKey:
        `crosspost-authdrop-${new Date().toISOString().slice(0, 10)}-${drops.map((d) => d.id).join('-')}`.slice(
          0,
          50,
        ),
      title: '平台掉线告警',
      // 2026-09-12：此前文案只让人"检查登录态"，而真实高频原因是**代理扩展换了浏览器**
      // （你在 A 浏览器登录、扩展在 B 浏览器）——把两个方向都写清楚，并附代理来源。
      summary:
        `检测到 ${drops.length} 个平台登录状态异常（曾登录→现未登录）：\n${lines.join('\n')}\n` +
        `常见原因：① 代理扩展所在的浏览器换了（登录态在另一个浏览器里）② 该平台登录过期。\n` +
        `${src}`,
      footer: 'CrossPost Console 自动检测（不影响草稿箱已有内容）',
    }),
    'utf8',
  )
  runCli(['notify', tmp], 30000)
    .then((r) => {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      console.error(
        `[bridge] 平台掉线告警已发送: ${r && r.status === 'ok' ? 'ok' : JSON.stringify(r).slice(0, 120)}`,
      )
    })
    .catch(() => {})
}

// ===== 代理通道（迷你扩展） =====
let proxyWs = null
const proxyPending = new Map()
let proxyMsgId = 0
let lastProxyAt = 0
let proxyHttpServer = null

/* ── 扩展心跳 / 连接状态（2026-09-11）──────────────────────────────────
 * 扩展每 30s（保活 alarm）推一条无 id 的 {type:'proxy-status', connected, at}。
 * 桥侧据此判定"扩展是否真的在线"：距最近一次心跳超过 extStaleMs 视为失联
 * （覆盖 close 推送送不达的情况，如 SW 被回收）。statusRev 在连接状态翻转或
 * 平台检查完成时自增，供 Console 轮询时判断"是否需要重渲染"。
 * 注意：lastProxyAt 语义不变（仍只由真实代理请求更新），心跳用独立时间戳。 */
let extLastPushAt = 0
let extConnected = false
let statusRev = 0

function extIsConnected() {
  if (!proxyWs || !extConnected) return false
  const stale = readRuntimeConfig().extStaleMs
  return extLastPushAt > 0 && Date.now() - extLastPushAt <= stale
}

/** 近期是否见过扩展（2026-09-11）：与 extIsConnected 的区别——
 *  extIsConnected 是"此刻是否在线"的展示判定（90s 心跳阈值）；
 *  extSeenWithin 是"是否值得尝试一次检查"的调度判定，宽容掉线抖动：
 *  扩展在 MV3 下会周期性掉线 3 秒后重连，tick 若恰好落在那一瞬，
 *  旧逻辑会整轮跳过（连失败平台的 60 秒重查也一起跳）。 */
const RECENT_EXT_MS = 5 * 60 * 1000
function extSeenWithin(ms) {
  return extLastPushAt > 0 && Date.now() - extLastPushAt <= ms
}

function noteExtHeartbeat(connected) {
  const next = !!connected
  const flipped = next !== extConnected
  extConnected = next
  extLastPushAt = Date.now()
  if (flipped) statusRev += 1
}

/** 缓存是否已到"该全量重查"的条件（无数据 / 超龄 / 上次失败后已过重试窗口） */
function needsFullCheck(now) {
  if (!platformsCache.data) return true
  if (now - platformsCache.at >= readRuntimeConfig().platformsCacheMs) return true
  // 上次检查失败：不等 TTL，过 RETRY_AFTER_ERROR_MS 就重试一次（single-flight 保证不叠加）
  const RETRY_AFTER_ERROR_MS = 60 * 1000
  return !!platformsCache.lastErrorAt && now - platformsCache.lastErrorAt >= RETRY_AFTER_ERROR_MS
}

/* ── 扩展身份（2026-09-12）─────────────────────────────────────────────
 * 今天的真实故障：面板在 Google Chrome、代理扩展却在 360Chrome，于是「你在 A 浏览器登录、
 * 桥用 B 浏览器的 Cookie 去查」，4 个平台永远失败而界面上看不出任何线索。
 * 从此扩展在每次心跳里带 clientId（首次运行生成、存 chrome.storage.local，每个浏览器
 * 用户目录各自一份）+ UA + 扩展版本；桥记录并在**来源切换时告警**，Console 状态卡展示。 */
let proxyClient = null
function noteExtIdentity(info) {
  if (!info || (!info.clientId && !info.ua)) return
  const next = {
    clientId: info.clientId ? String(info.clientId).slice(0, 12) : null,
    ua: info.ua ? String(info.ua).slice(0, 240) : null,
    version: info.version ? String(info.version) : null,
    connectedAt: Date.now(),
  }
  const prev = proxyClient
  proxyClient = next
  if (prev && next.clientId && prev.clientId && prev.clientId !== next.clientId) {
    console.error(
      `[proxy] ⚠ 代理来源切换：${prev.clientId} → ${next.clientId}` +
        `（同一时刻只服务最后一个连接；两个浏览器都装了扩展时结果会来回翻面）` +
        `\n[proxy]   旧: ${prev.ua || '(未知)'}\n[proxy]   新: ${next.ua || '(未知)'}`,
    )
    statusRev += 1
  } else if (!prev) {
    console.error(
      `[proxy] 代理来源: client=${next.clientId || '(无 id)'} ext=${next.version || '?'} ua=${next.ua || '(未知)'}`,
    )
  }
}

function handleExtPush(msg) {
  if (!msg || msg.type !== 'proxy-status') return
  noteExtHeartbeat(msg.connected !== false)
  noteExtIdentity(msg)
  // 扩展恢复在线：立即补跑被跳过的检查（此前只在"全量超龄"时补跑，
  // 掉线期间错过的失败重查 / 失败重试不会被补上）
  if (msg.connected !== false) {
    const now = Date.now()
    if (needsFullCheck(now)) {
      refreshPlatforms(null, 'reconnect-full', 'scope')
      return
    }
    const stale = staleFailPlatforms(now)
    if (stale.length) refreshPlatforms(stale.join(','), 'reconnect-subset', 'retry')
  }
}

function startProxyChannel() {
  return new Promise((resolve) => {
    // 2026-08-28 安全加固：仅接受 Chrome 扩展来源（浏览器强制 Origin 头，网页无法伪造 chrome-extension://）
    // 恶意网页 / 无 Origin 的本地进程一律拒绝，堵住"任意网页抢占代理通道"（SSRF/cookie 窃取/连接劫持）
    const wss = new WebSocketServer({
      port: proxyWsPort,
      verifyClient: (info) => {
        const origin = String(info.origin || '')
        if (origin.startsWith('chrome-extension://')) return true
        console.error(`[proxy] 拒绝非扩展来源连接: ${origin || '(无 Origin)'}`)
        return false
      },
    })
    wss.on('listening', () => {
      console.error(`[proxy] WS listening on ${proxyWsPort}`)
      startProxyHttp(proxyWsPort + 1)
        .then(resolve)
        .catch((e) => {
          console.error(`[proxy] HTTP 启动失败: ${(e && e.stack) || e}`)
          resolve()
        })
    })
    wss.on('connection', (client) => {
      console.error('[proxy] mini extension connected')
      proxyWs = client
      noteExtHeartbeat(true) // 2026-09-11：连接即视为在线，心跳随后续推送刷新
      client.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          // 扩展主动推送（无 id）：心跳/连接状态，不占用 proxyPending 匹配
          if (typeof msg.id !== 'number') {
            handleExtPush(msg)
            return
          }
          const pending = proxyPending.get(msg.id)
          if (!pending) return
          proxyPending.delete(msg.id)
          clearTimeout(pending.timer)
          if (msg.error) pending.reject(new Error(msg.error.message || 'proxy error'))
          else pending.resolve(msg.result)
        } catch {
          /* ignore malformed */
        }
      })
      client.on('close', () => {
        console.error('[proxy] mini extension disconnected')
        if (proxyWs === client) {
          proxyWs = null
          noteExtHeartbeat(false)
        }
      })
      client.on('error', () => {})
    })
    wss.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') {
        console.error(`[proxy] port ${proxyWsPort} in use — 已有 Bridge 在运行，本进程退出`)
        process.exit(0)
      } else {
        console.error('[proxy] WS error:', e.message)
        resolve()
      }
    })
  })
}

// proxyCall：断连/超时自动重试（MV3 扩展 SW 会被 Chrome 30s 空闲回收导致 WS 短暂断开，
// 重试覆盖 3s 重连窗口，避免"撞上断连瞬间"的请求误判为失败）
const PROXY_RETRY_ATTEMPTS = 3
const PROXY_RETRY_DELAY_MS = 2000
function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function proxyCall(method, params, timeoutMs = 120000, attempt = 0) {
  if (!proxyWs) {
    if (attempt < PROXY_RETRY_ATTEMPTS) {
      await waitMs(PROXY_RETRY_DELAY_MS)
      return proxyCall(method, params, timeoutMs, attempt + 1)
    }
    throw new Error('proxy extension not connected')
  }
  proxyMsgId += 1
  const id = proxyMsgId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proxyPending.delete(id)
      if (attempt < PROXY_RETRY_ATTEMPTS) {
        waitMs(PROXY_RETRY_DELAY_MS).then(() =>
          proxyCall(method, params, timeoutMs, attempt + 1).then(resolve, reject),
        )
      } else {
        reject(new Error('proxy request timeout: ' + method))
      }
    }, timeoutMs)
    proxyPending.set(id, { resolve, reject, timer })
    // 2026-08-28：消息带 token（纵深防御；扩展已配置 token 时 sw.js 侧强校验，未配置时向后兼容）
    proxyWs.send(JSON.stringify({ id, method, params: params || {}, token: apiToken }))
  })
}

// 平台登录状态缓存（默认 1h；登录态即 cookie 有效期，通常以周计，故缓存可长；弹窗"刷新状态"走 ?refresh=1 强制绕过）
// 可用环境变量 SYNC_PLATFORMS_CACHE_MS 覆盖（config.json 优先）
const platformsCacheMs = parseInt(process.env.SYNC_PLATFORMS_CACHE_MS || '3600000', 10)
// 失败平台重查「首档」间隔（2026-09-12 起只是退避阶梯的第一档，见 platforms-retry.mjs）：
// 连续失败 3 次 → 5 分钟，10 次 → 30 分钟，持续 24h 无一次成功 → 置「需重新登录」并停止自动重查。
const FAIL_RETRY_MS = parseInt(process.env.SYNC_PLATFORMS_FAIL_RETRY_MS || '60000', 10)
// 退避阶梯：第一档取 FAIL_RETRY_MS（保留 SYNC_PLATFORMS_FAIL_RETRY_MS 覆盖能力），其余沿用模块默认
const BACKOFF_STEPS = [{ afterFails: 0, retryMs: FAIL_RETRY_MS }, ...FAIL_BACKOFF_STEPS.slice(1)]

// "曾登录成功过"的平台集合（持久化，last written 2026-08-16）：
// 唯一用途（2026-09-12 起）= 判断**锁定平台**（weixin/douyin）要不要纳入检查范围。
// 历史教训：它曾被当作"失败重查白名单"，于是换浏览器/清 Cookie 后留下的旧登录记忆
// （bilibili/jianshu/douban/woshipm）被每 60~90 秒无休止重查 —— 现在检查范围由
// 「设置页默认推送平台 ∪ 锁定∩曾登录」决定，范围外的历史记忆彻底不再参与调度。
const EVER_AUTHED_PATH = process.env.CROSSPOST_EVER_AUTHED_PATH
  ? path.resolve(process.env.CROSSPOST_EVER_AUTHED_PATH)
  : fileURLToPath(new URL('../crosspost-runtime/ever-authed.json', import.meta.url))
let everAuthed = new Set()
function loadEverAuthed() {
  try {
    everAuthed = new Set(JSON.parse(fs.readFileSync(EVER_AUTHED_PATH, 'utf8')))
  } catch {
    everAuthed = new Set()
  }
}
function saveEverAuthed() {
  try {
    fs.writeFileSync(EVER_AUTHED_PATH, JSON.stringify([...everAuthed].sort(), null, 2))
  } catch {
    /* ignore */
  }
}
/** 记入"曾登录过"（检查成功、或成功推送到该平台时调用）；锁定平台的检查范围靠它生效 */
function markEverAuthed(ids) {
  let changed = false
  for (const id of ids || []) {
    if (id && !everAuthed.has(id)) {
      everAuthed.add(id)
      changed = true
    }
  }
  if (changed) saveEverAuthed()
  return changed
}

/** 从发布结果里取「确实成功推送到」的平台 id（含微信官方通道草稿）——
 *  锁定平台（weixin/douyin）"从未登录过 → 不检查"的自动发现路径：一旦成功推送过就纳入检查范围。 */
function okPlatformsFromPublish(r) {
  const out = []
  for (const [id, p] of Object.entries((r && r.platforms) || {})) {
    if (p && p.status === 'ok') out.push(id)
  }
  if (r && r.wechat && r.wechat.status === 'ok') out.push('weixin')
  return out
}

// 平台状态持久化（2026-09-12 新增）：失败累计次数 / 最后成功时间 / 退避到期 / 终态。
// 此前这些只在内存（lastFailAt），bridge 一重启就清零、面板也无从展示"第几次失败、上次成功是何时"。
const PLATFORMS_STATE_PATH = process.env.CROSSPOST_PLATFORMS_STATE_PATH
  ? path.resolve(process.env.CROSSPOST_PLATFORMS_STATE_PATH)
  : fileURLToPath(new URL('../crosspost-runtime/platforms-state.json', import.meta.url))
function loadPlatformsState() {
  try {
    const d = JSON.parse(fs.readFileSync(PLATFORMS_STATE_PATH, 'utf8'))
    return d && typeof d === 'object' && d.platforms ? d : emptyState()
  } catch {
    return emptyState()
  }
}
function savePlatformsState(st) {
  try {
    fs.writeFileSync(PLATFORMS_STATE_PATH, JSON.stringify(st, null, 2))
  } catch {
    /* ignore */
  }
}

// ===== 配置读写（config.json，面板经 /proxy/config 读写；CONFIG_PATH 来自 cli-worker） =====
// 默认值（2026-09-11）：状态轮询间隔 / 平台检查并发 / 扩展心跳陈旧阈值
const DEFAULT_PLATFORMS_POLL_MS = 60000
const DEFAULT_PLATFORMS_CHECK_CONCURRENCY = 6
const extStaleMsDefault = parseInt(process.env.SYNC_PROXY_EXT_STALE_MS || '90000', 10)

/** 钳制检查并发度（1-10，非法回默认 6；与 runtime clampConcurrency 同规则） */
function clampCheckConcurrency(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 1) return DEFAULT_PLATFORMS_CHECK_CONCURRENCY
  return Math.min(10, Math.floor(v))
}

function readRuntimeConfig() {
  try {
    const text = fs.readFileSync(CONFIG_PATH, 'utf8')
    const cfg = JSON.parse(text)
    return {
      proxyMode: cfg.proxyMode !== false,
      proxyHost: cfg.proxyHost || '127.0.0.1',
      proxyHttpPort: Number(cfg.proxyHttpPort) || 9540,
      timeoutMs: Number(cfg.timeoutMs) || 150000,
      platformsCacheMs: Number(cfg.platformsCacheMs) || platformsCacheMs,
      concurrency: Number(cfg.concurrency) || 3,
      platformsPollMs: Number(cfg.platformsPollMs) || DEFAULT_PLATFORMS_POLL_MS,
      platformsCheckConcurrency: clampCheckConcurrency(cfg.platformsCheckConcurrency),
      extStaleMs: Number(cfg.extStaleMs) || extStaleMsDefault,
    }
  } catch {
    return {
      proxyMode: true,
      proxyHost: '127.0.0.1',
      proxyHttpPort: 9540,
      timeoutMs: 150000,
      platformsCacheMs,
      concurrency: 3,
      platformsPollMs: DEFAULT_PLATFORMS_POLL_MS,
      platformsCheckConcurrency: DEFAULT_PLATFORMS_CHECK_CONCURRENCY,
      extStaleMs: extStaleMsDefault,
    }
  }
}
/**
 * 写配置：**按层拆分**（v2.77）。
 *
 * · 引擎级键 → 引擎 `config.json`（永远）
 * · 项目级键 → 有项目上下文时写 `<localRoot>/project-state/<id>/config.json`；
 *   默认域（未选项目）时写进引擎 `config.json`，语义是"所有项目共用的默认值"
 * · 返回**生效配置**，前端拿到的就是合并后的值
 *
 * 合并规则沿用历史：`scoring`/`autoPush` 键内浅合并（只改一个子字段不清掉另一个），
 * 其余整键覆盖；越界值仍在落盘前 clamp。
 */
function writeRuntimeConfig(patch) {
  const projectId = currentProject() || ''
  const engineCfg = { ...readEngineConfigFile() }
  // 项目覆盖层（只取项目级键；写之前先按项目自己的文件算基线）
  const projectCfg = projectId ? { ...readProjectConfig(projectId) } : {}
  for (const k of [
    'proxyMode',
    'proxyHost',
    'proxyHttpPort',
    'timeoutMs',
    'platformsCacheMs',
    'platformsPollMs',
    'platformsCheckConcurrency',
    'extStaleMs',
    'concurrency',
    'notify',
    'schedule',
    'draftsDir',
    'scoring',
    'platforms',
    'styles',
    'coverSettings',
    'branding',
    'autoPush',
  ]) {
    if (patch[k] !== undefined) {
      // 落到哪一层：项目级键 + 有项目 → 项目覆盖层；否则引擎文件
      const target = classifyKey(k) === 'project' && projectId ? projectCfg : engineCfg
      // scoring 深浅合并（2026-09-02）：threshold 与 investment 独立更新，避免存阈值时清空 investment 词表
      if (k === 'scoring' && patch.scoring && typeof patch.scoring === 'object') {
        target.scoring = { ...target.scoring, ...patch.scoring }
      } else if (k === 'autoPush' && patch.autoPush && typeof patch.autoPush === 'object') {
        // autoPush 深浅合并（2026-09-09）：enabled/includeWechat 独立更新，避免只切一个清掉另一个
        target.autoPush = { ...target.autoPush, ...patch.autoPush }
      } else {
        target[k] = patch[k]
      }
    }
  }
  // 2026-09-11：新配置项落盘前规范化，避免前端/手工写入越界值污染 config.json
  if (engineCfg.platformsCheckConcurrency !== undefined) {
    engineCfg.platformsCheckConcurrency = clampCheckConcurrency(engineCfg.platformsCheckConcurrency)
  }
  if (engineCfg.platformsPollMs !== undefined) {
    const v = Number(engineCfg.platformsPollMs)
    engineCfg.platformsPollMs =
      Number.isFinite(v) && v >= 15000 ? Math.min(600000, Math.round(v)) : DEFAULT_PLATFORMS_POLL_MS
  }
  if (engineCfg.extStaleMs !== undefined) {
    const v = Number(engineCfg.extStaleMs)
    engineCfg.extStaleMs =
      Number.isFinite(v) && v >= 15000 ? Math.min(600000, Math.round(v)) : extStaleMsDefault
  }
  // 引擎文件总是写（引擎级键 + 默认域下的项目级键都在这）；项目覆盖层只在有项目时写
  writeConfigFile(engineCfg) // 2026-09-01：原子写（tmp+rename），防止配置写坏
  if (projectId) writeProjectConfigFile(projectId, projectCfg)
  return readFullRuntimeConfig() // 返回生效配置（合并后的视图）
}

// 缓存结构：{ at: 本轮检查时间, data: 本轮结果（范围快照）, state: 平台状态（持久化镜像）,
//            scope: { ids, mode, excluded, checkOnly },
//            checking: 是否有检查在飞, lastError: 最近一次失败原因, lastMode: 'scope' | 'all' | 'retry' }
/* 2026-09-11 重构：平台检查不再挂在 HTTP 请求的同步路径上。
 * 交互请求（详情抽屉/列表）只读缓存；检查由 refreshPlatforms() 在后台跑，
 * single-flight 保证同一时刻只有一份 cli listPlatforms（并发度由
 * config.platformsCheckConcurrency 控制，见 runCliListPlatforms）。
 * 2026-09-12：检查范围由 platforms-retry.resolveCheckSet 决定（= 设置页勾选的平台；模型 A 单列），
 * 失败重查走退避阶梯 + needs_login 终态；范围外的历史失败（bilibili/jianshu/douban/woshipm）
 * 不再进入任何调度。 */
let platformsCache = {
  at: 0,
  data: null,
  state: loadPlatformsState(),
  scope: null,
  checking: false,
  lastError: null,
  lastErrorAt: 0,
  lastMode: null,
}
let platformsRefreshPromise = null

// 执行 cli listPlatforms（idsArg 为逗号分隔平台 id；null/缺省 = 全量 27 个）
// 并发度按位置参数第 2 位传给 CLI（config.platformsCheckConcurrency，1-10，缺省 6）
// 注意：不能用 `--concurrency=N` 这种 flag 形式——`--xxx` 会被 cli.mjs 的 argTail
// 当成尾部 flag 过滤掉（2026-09-11 实测踩过），位置参数才是可靠通道。
function runCliListPlatforms(idsArg) {
  return new Promise((resolve) => {
    const args = [NATIVE_CLI, 'listPlatforms']
    const c = readRuntimeConfig().platformsCheckConcurrency
    if (idsArg) {
      args.push(idsArg, String(c))
    } else {
      // 全量：第 1 位需占位（'true' = 全量，CLI 侧同样按全量处理），第 2 位才是并发度
      args.push('true', String(c))
    }
    execFile(process.execPath, args, { timeout: 90000 }, (err, stdout) => {
      try {
        const data = JSON.parse(stdout)
        data.checkedAt = Date.now()
        resolve(data)
      } catch (e) {
        resolve({
          error: 'native cli 解析失败: ' + ((err && err.message) || e.message),
          raw: String(stdout).slice(0, 300),
        })
      }
    })
  })
}

/**
 * 本轮检查范围（2026-09-12）：默认推送平台（config.platforms.default）∪ 锁定平台∩曾登录。
 * mode='fallback-all' 表示 default 为空/非法而回退全量（状态卡会标注）。
 *
 * 2026-09-22（v2.106.2）：取**引擎级 ∪ 各项目覆盖层**，而不是"当前上下文生效的那份"。
 * 事故：后台 tick 与扩展面板的查询都没有项目上下文 → 只剩引擎级那份（= 微信/抖音两个，
 * 2026-09-12 迁移补进去的），于是"检查范围 2/27、未勾选 25 个"，而 Console（带项目头）
 * 与派发侧看到的是项目覆盖层的 12 个。判据与取舍见 `platforms-retry.mjs` 的
 * `resolveScopeFromLayers`。
 */
function currentScope() {
  return resolveScopeFromLayers({
    engineDefaults: (readEngineConfigFile().platforms || {}).default,
    projectDefaults: projectPlatformDefaults(),
    allPlatforms: TARGET_PLATFORMS,
  })
}

/** 用一次检查结果更新平台状态（持久化）并刷新"曾登录过"集合 */
function applyResults(platforms, now) {
  platformsCache.state = applyCheckResults(platformsCache.state, platforms, now, {
    giveUpAfterMs: GIVE_UP_AFTER_MS,
    steps: BACKOFF_STEPS,
  })
  savePlatformsState(platformsCache.state)
  markEverAuthed(authedIdsFrom(platforms))
}

// 用子集结果合并回缓存（仅覆盖查询到的平台）
// addNew=true（2026-09-12 单平台「查一下」）：缓存里没有的平台也追加进去，
// 否则点「🔍」查一个没勾选的平台时结果无处可放、面板徽标不会变。
function mergePlatforms(subsetPlatforms, now, { addNew = false } = {}) {
  const byId = new Map((subsetPlatforms || []).map((p) => [p.id, p]))
  const merged = (platformsCache.data.platforms || []).map((p) => byId.get(p.id) || p)
  if (addNew) {
    const known = new Set(merged.map((p) => p.id))
    for (const p of subsetPlatforms || []) if (p && p.id && !known.has(p.id)) merged.push(p)
  }
  platformsCache.data.platforms = merged
  platformsCache.data.checkedAt = now
  applyResults(subsetPlatforms, now)
}

/**
 * 到期该重查的失败平台。**范围约束取"当前配置的检查范围"，而不是"上一轮检查快照"** ——
 * 手动全量刷新（mode='all'）会把 27 个平台的结果写进状态，若按快照取材，
 * 范围外平台（如 bilibili）又会重新进入重查循环（这正是 2026-09-12 要根除的问题）。
 */
function staleFailPlatforms(now, scope) {
  return selectRetryIds({
    state: platformsCache.state,
    checkSet: scope || currentScope().ids,
    now,
  })
}

/** 失败中的平台（含未到退避时间的 + 已放弃的），供状态卡展示（同样按当前检查范围约束） */
function currentFailures(scope) {
  return selectFailures({
    state: platformsCache.state,
    checkSet: scope || currentScope().ids,
  })
}

/**
 * 后台刷新（single-flight，火忘式调用）。四种 mode（2026-09-12 模型 A）：
 *   - 'scope'：按勾选集查（config.platforms.default）——tick / 心跳重连 / 冷启动
 *   - 'retry'：只查到期该重查的失败平台（idsArg 为逗号分隔 id）
 *   - 'check'：单平台「🔍 查一下」——只查指定平台，**允许并入缓存外平台**，不订阅重查
 *   - 'all'  ：全量 27 个——仅手动「立即检查平台状态」用（逃生舱：看得到未勾选平台的登录态）
 * scope/all 用结果**替换**缓存快照（缓存 = 本轮范围快照）；retry/check 合并进快照。
 * 同一时刻只有一份检查在飞；失败只记 lastError/lastErrorAt 并保留旧缓存（tick 会按退避重试）。
 * reason 仅用于日志（tick|reconnect|manual|request|manual-one），便于事后复盘"这次检查是谁触发的"。
 */
function refreshPlatforms(idsArg, reason, mode = idsArg ? 'retry' : 'scope') {
  if (platformsRefreshPromise) return platformsRefreshPromise
  const subsetMode = mode === 'retry' || mode === 'check'
  const scope = subsetMode ? null : currentScope()
  const ids = subsetMode ? String(idsArg) : mode === 'all' ? null : scope.ids.join(',')
  const kind =
    mode === 'all'
      ? 'all(27)'
      : mode === 'scope'
        ? `scope(${scope.ids.length}/${TARGET_PLATFORMS.length}${scope.mode === 'fallback-all' ? ',回退全量' : ''})`
        : `${mode}(ids=${ids})`
  const why = reason || 'unknown'
  platformsCache.checking = true
  console.error(`[platforms] 检查开始 ${kind} reason=${why}`)
  platformsRefreshPromise = (async () => {
    const nowStart = Date.now()
    try {
      const data = await runCliListPlatforms(ids)
      if (data && !data.error && Array.isArray(data.platforms)) {
        if (subsetMode && platformsCache.data) {
          mergePlatforms(data.platforms, Date.now(), { addNew: mode === 'check' })
          notePlatformAuth(data.platforms) // P6 掉线检测（子集重查）
          platformsCache.lastMode = mode
        } else {
          const now = Date.now()
          platformsCache = {
            at: now,
            data,
            // 范围快照 = 本轮范围内平台的状态；范围外状态剪除（勾选变化后不残留旧计数）
            state: pruneState(
              platformsCache.state,
              data.platforms.map((p) => p.id),
            ),
            scope: mode === 'all' ? null : scope,
            checking: true,
            lastError: null,
            lastErrorAt: 0,
            lastMode: mode,
          }
          applyResults(data.platforms, now)
          notePlatformAuth(data.platforms) // P6 掉线检测
        }
        platformsCache.lastError = null
        platformsCache.lastErrorAt = 0
        console.error(
          `[platforms] 检查完成 ${kind} ${data.platforms.length} 个平台 用时 ${Math.round((Date.now() - nowStart) / 1000)}s`,
        )
      } else {
        platformsCache.lastError = (data && data.error) || '平台检查失败'
        platformsCache.lastErrorAt = Date.now()
        console.error(`[platforms] 检查失败 ${kind}: ${platformsCache.lastError}`)
      }
    } catch (e) {
      platformsCache.lastError = String((e && e.message) || e)
      platformsCache.lastErrorAt = Date.now()
      console.error(`[platforms] 检查异常 ${kind}: ${platformsCache.lastError}`)
    } finally {
      platformsCache.checking = false
      platformsRefreshPromise = null
      statusRev += 1
    }
    return platformsCache.data
  })()
  return platformsRefreshPromise
}

/** 定期自检 tick：仅在做检查有意义时触发；每个分支都留痕，避免"看起来没跑"无法复盘 */
function platformCheckTick() {
  // 是否值得尝试：socket 在线，或近期（5 分钟，宽容 MV3 掉线抖动）见过扩展心跳
  // 注意这里**不用** extIsConnected()（那是 90s 的展示判定）——否则 tick 撞上扩展
  // 掉线的那几秒会整轮跳过，连失败重查也一起被跳掉。
  if (!proxyWs && !extSeenWithin(RECENT_EXT_MS)) {
    console.error(
      `[platforms] tick 跳过（扩展离线 sock=${proxyWs ? 1 : 0} conn=${extConnected ? 1 : 0} lastPush=${extLastPushAt ? Math.round((Date.now() - extLastPushAt) / 1000) + 's前' : '无'}）`,
    )
    return
  }
  if (platformsCache.checking) {
    console.error('[platforms] tick 跳过（已有检查在飞 checking=true）')
    return
  }
  const now = Date.now()
  if (needsFullCheck(now)) {
    const why = !platformsCache.data
      ? 'cache 缺失'
      : platformsCache.lastErrorAt
        ? `上次失败后重试（失败于 ${Math.round((now - platformsCache.lastErrorAt) / 1000)}s 前）`
        : `超龄 ${Math.round((now - platformsCache.at) / 1000)}s`
    refreshPlatforms(null, 'tick', 'scope')
    console.error(`[platforms] tick 发起范围检查（${why}）`)
    return
  }
  const stale = staleFailPlatforms(now)
  if (stale.length) {
    refreshPlatforms(stale.join(','), 'tick', 'retry')
    console.error(`[platforms] tick 发起失败重查 ids=${stale.join(',')}`)
    return
  }
  const remain = Math.round((platformsCache.at + readRuntimeConfig().platformsCacheMs - now) / 1000)
  console.error(`[platforms] tick 无需检查（范围检查剩 ${remain}s 到期，失败集空）`)
}

/**
 * 平台状态读取（纯只读，绝不阻塞）：返回缓存 + 后台刷新/单飞状态。
 * - init=true：桥刚启动、缓存还没建立，调用方应视为"检查中"而不是"未登录"
 * - refreshing=true：有一份后台检查在飞（下一次读取会拿到更新结果）
 * - opts.forceAll：全量 27 个（「立即检查平台状态」按钮）
 * - opts.check：单平台「🔍 查一下」的 id 列表；opts.wait=true 时等这次检查结束再返回（上限 20s），
 *   让按钮点完就能看到真实徽标；该平台**不订阅自动重查**（范围约束照旧）。
 */
async function getPlatformsStatus(opts = {}) {
  const {
    forceAll = false,
    check = [],
    wait = false,
  } = typeof opts === 'boolean' ? { forceAll: opts } : opts
  const cfg = readRuntimeConfig()
  if (check.length) {
    const p = refreshPlatforms(check.join(','), 'manual-one', 'check')
    if (wait) await Promise.race([p, waitMs(20_000)])
    else if (!platformsCache.data) await Promise.race([p, waitMs(20_000)])
    // 单点检查不改变"范围"语义，但仍要把最新缓存（含范围信息）返回给面板
  }
  if (!platformsCache.data) {
    // 冷启动：立即返回空集合，范围检查转后台（不再让交互请求等 90s）
    if (!check.length) refreshPlatforms(null, 'request', 'scope')
    if (forceAll) refreshPlatforms(null, 'manual', 'all')
    return {
      platforms: [],
      checkedAt: null,
      refreshing: true,
      init: true,
      error: platformsCache.lastError,
      scope: scopeMeta(),
    }
  }
  const stale = Date.now() - platformsCache.at >= cfg.platformsCacheMs
  if (forceAll) refreshPlatforms(null, 'manual', 'all')
  else if (stale) refreshPlatforms(null, 'request', 'scope')
  return {
    platforms: platformsCache.data.platforms || [],
    checkedAt: platformsCache.checkedAt || platformsCache.at || null,
    refreshing: !!platformsRefreshPromise,
    init: false,
    lastMode: platformsCache.lastMode,
    error: platformsCache.lastError,
    scope: scopeMeta(),
  }
}

/** 检查范围元信息（供 /proxy/status 与 Console 展示"查了哪几个、哪些没查"） */
function scopeMeta() {
  const s = platformsCache.scope || currentScope()
  return {
    ids: s.ids,
    mode: s.mode,
    excluded: s.excluded || [],
    checkOnly: s.checkOnly || [],
    checkOnlyAll: CHECK_ONLY_PLATFORMS,
    all: TARGET_PLATFORMS.length,
    count: s.ids.length,
  }
}

// ── HTTP 路由表（2026-09-01 P1-6：run-bridge 路由收敛）──────────────────────
// 每个路由 { method, match, handler }：match 为精确字符串或 pathname 谓词；
// handler 接收 ctx { req, res, pathname, query, sendJson, readBody }，自行发送响应。
const sendJsonTo = (res, code, obj) => {
  if (res.headersSent) return
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}
// POST 请求体统一读取（5MB 上限，超限 413）
async function readJsonBody(req, sendJson) {
  const MAX_BODY = 5 * 1024 * 1024
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY) {
      sendJson(413, { error: '请求体超限(>5MB)' })
      throw new Error('body too large')
    }
  }
  return body
}

const ROUTES = [
  // 健康自检（2026-08-24 P2）：轻量、零副作用，供 launchd/监控/运维探测
  {
    method: 'GET',
    match: '/proxy/health',
    handler: (c) =>
      c.sendJson(200, {
        ok: true,
        uptimeMs:
          Date.now() -
          (process.env.CROSSPOST_START_TS ? Number(process.env.CROSSPOST_START_TS) : 0),
        startedAt: process.env.CROSSPOST_START_TS || null,
        proxyWs: !!proxyWs,
        lastProxyAt,
        tokenConfigured: !!apiToken,
        lastBackup: getBackupStatus().lastBackup,
        // 2026-09-12：代理来源（哪个浏览器在替你发请求）——排查"登录态对不上"的第一现场
        client: proxyClient,
        // 2026-09-21（v2.100）：三 worker 的存活/重启/累计输出 —— 排查"Console 变慢"的第一现场。
        // reader/writer/heavy 任一 alive=false 或 coolingDown=true ⇒ 该 role 正在付 ~1.2s 冷启动。
        workers: workersHealth(),
      }),
  },
  {
    method: 'GET',
    match: '/proxy/status',
    handler: (c) => {
      const cfg = readRuntimeConfig()
      const connected = extIsConnected()
      const checkedAt = platformsCache.checkedAt || platformsCache.at || null
      // 一次请求内只解析一次范围（配置读盘），并让失败集与展示范围同源
      const scope = scopeMeta()
      const failures = currentFailures(scope.ids)
      c.sendJson(200, {
        connected,
        rev: statusRev,
        lastProxyAt,
        // P1：引擎与接入契约版本。HTTP 消费者（Console、第三方）据此做兼容判断。
        version: versionInfo(),
        // 2026-09-11：前端据此提示「自动推送」模式（手动重推/抖音推送不受该开关影响）
        autoPush: { enabled: !!(readFullRuntimeConfig().autoPush || {}).enabled },
        ext: {
          lastPushAt: extLastPushAt || null,
          staleMs: cfg.extStaleMs,
          // 曾在 90s 内收到心跳但当前判定失联 → 前端区分"扩展未启动"与"刚断开"
          seen: extLastPushAt > 0,
          // 2026-09-12：代理来源身份（哪个浏览器在替你发请求）——今天的故障就是"你在 A 浏览器登录、
          // 扩展在 B 浏览器"，没有这个字段就只能靠 lsof 手工比对 cookie 库
          client: proxyClient,
          // P1：扩展↔桥 协议兼容性判定（告警不拒绝）。
          // 此前扩展版本只在 UI 里显示，没有任何判定——版本不匹配表现为
          // "已连接但发布静默失败"，是最难排查的一类故障。
          compat: checkExtensionCompatibility(proxyClient && proxyClient.version),
        },
        platforms: {
          checkedAt,
          // at = 范围检查完成时间（与 checkedAt 区分：失败重查会推进 checkedAt，但不推进 at）
          at: platformsCache.at || null,
          count: (platformsCache.data && platformsCache.data.platforms.length) || 0,
          refreshing: !!platformsRefreshPromise,
          init: !platformsCache.data,
          nextCheckAt: platformsCache.data ? platformsCache.at + cfg.platformsCacheMs : null,
          checkIntervalMs: cfg.platformsCacheMs,
          cacheMs: cfg.platformsCacheMs,
          pollMs: cfg.platformsPollMs,
          checkConcurrency: cfg.platformsCheckConcurrency,
          lastMode: platformsCache.lastMode,
          lastError: platformsCache.lastError,
          lastErrorAt: platformsCache.lastErrorAt || null,
          // 检查范围（2026-09-12）：只查「默认推送平台 ∪ 锁定∩曾登录」，其余 15 个不再参与任何调度
          scope,
          // 失败中（含未到退避时间的）：供状态卡展示"失败平台重查：a / b / c"；
          // 与 scope.ids 同源 → 范围外平台永远不会出现在这里（手动全量刷新也不会）
          failedRetryIds: failures.retry,
          needsLoginIds: failures.needsLogin,
          failedDetail: failedDetails({
            state: platformsCache.state,
            checkSet: scope.ids,
            now: Date.now(),
          }),
          failRetryMs: FAIL_RETRY_MS,
          backoffSteps: BACKOFF_STEPS,
          giveUpAfterMs: GIVE_UP_AFTER_MS,
        },
      })
    },
  },
  {
    method: 'GET',
    match: '/proxy/platforms',
    // 2026-09-11：纯缓存直读（冷启动也不再阻塞交互请求）；检查转后台 refreshPlatforms。
    // 2026-09-12：?refresh=1 全量 27 个（「立即检查平台状态」）；
    //             ?check=id[,id] 单平台「🔍 查一下」（可 &wait=1 等结果，不订阅自动重查）。
    handler: async (c) => {
      const check = String(c.query.get('check') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const st = await getPlatformsStatus({
        forceAll: c.query.get('refresh') === '1',
        check,
        wait: c.query.get('wait') === '1',
      })
      c.sendJson(200, st)
    },
  },
  {
    // 项目注册表（P1）：Console 项目切换器与接入页的数据源。
    // 只读枚举 manifest；不推测项目布局，无 manifest 即"未接入"。
    method: 'GET',
    match: '/proxy/projects',
    handler: (c) => c.sendJson(200, registrySummary()),
  },
  {
    // 平台能力矩阵（v2.03）：平台口径的唯一来源。
    // Console 与 MCP 工具描述均从此派生，禁止各处手写数量/名单。
    method: 'GET',
    match: '/proxy/platform-matrix',
    handler: (c) => c.sendJson(200, buildPlatformMatrix()),
  },
  {
    method: 'GET',
    match: '/proxy/config',
    // v2.77：返回**生效**配置（引擎 config + 当前项目覆盖层），并带上作用域标记，
    // 让设置页能显示"正在编辑哪个域、哪些项被项目覆盖"。
    handler: (c) =>
      c.sendJson(200, {
        ...readFullRuntimeConfig(),
        _scope: {
          project: currentProject() || null,
          overridden: projectOverriddenKeys(),
        },
      }),
  },
  {
    method: 'POST',
    match: '/proxy/config',
    handler: async (c) => {
      const patch = JSON.parse((await c.readBody()) || '{}')
      const cfg = writeRuntimeConfig(patch)
      // 配置变化（含「默认推送平台」勾选）后清空缓存：检查范围随 tick（≤60s）或下一次心跳重新解析；
      // 状态里只保留当前范围内的平台，避免取消勾选后旧失败计数在重新勾选时"复活"
      platformsCache = {
        at: 0,
        data: null,
        state: pruneState(platformsCache.state, currentScope().ids),
        scope: null,
        checking: platformsCache.checking,
        lastError: null,
        lastErrorAt: 0,
        lastMode: null,
      }
      statusRev += 1
      c.sendJson(200, { ok: true, config: cfg })
    },
  },
  // 自定义品牌图标上传（2026-09-02）：魔数嗅探判定类型（不信任上报 MIME，修复 .ico 误报）+ base64 有效 + ≤512KB
  {
    method: 'POST',
    match: '/proxy/icon',
    handler: async (c) => {
      const { data } = JSON.parse((await c.readBody()) || '{}')
      const m = /^data:([^;]+);base64,(.+)$/.exec(String(data || ''))
      if (!m) {
        c.sendJson(400, { error: '无效的图片数据' })
        return
      }
      let buf
      try {
        buf = Buffer.from(m[2], 'base64')
        if (!buf.length) throw new Error('empty')
      } catch {
        c.sendJson(400, { error: '无效的 base64 图片' })
        return
      }
      if (buf.length > 512 * 1024) {
        c.sendJson(413, { error: '图标过大(>512KB)' })
        return
      }
      const ext = detectIconExt(buf, m[1])
      if (!ext) {
        c.sendJson(400, { error: '仅支持 png/jpg/webp/gif/svg/ico' })
        return
      }
      fs.mkdirSync(BRAND_DIR, { recursive: true })
      for (const f of fs.readdirSync(BRAND_DIR))
        if (f.startsWith('icon.') || f.startsWith('raw.')) {
          try {
            fs.unlinkSync(path.join(BRAND_DIR, f))
          } catch {
            /* ignore */
          }
        }
      const raw = path.join(BRAND_DIR, 'raw.' + ext)
      fs.writeFileSync(raw, buf)
      // 栅格图（png/jpg/webp）用 sips 缩到 256×256 PNG，消除大图加载慢/短暂图裂；失败回退原图
      let saved = 'icon.' + ext
      if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        const outPng = path.join(BRAND_DIR, 'icon.png')
        if (await resizeBrandRaster(raw, outPng)) saved = 'icon.png'
      }
      if (saved === 'icon.' + ext) fs.renameSync(raw, path.join(BRAND_DIR, saved))
      try {
        fs.unlinkSync(raw)
      } catch {
        /* ignore */
      }
      c.sendJson(200, { ok: true, icon: '/brand-icon?v=' + Date.now() })
    },
  },
  {
    method: 'POST',
    match: '/proxy/request',
    handler: async (c) => {
      const { method, params } = JSON.parse(await c.readBody())
      lastProxyAt = Date.now()
      const result = await proxyCall(method, params)
      c.sendJson(200, { result })
    },
  },

  // ── P5 渲染引擎路由（面板用） ──
  {
    method: 'GET',
    match: '/proxy/styles',
    handler: async (c) => c.sendJson(200, await runCli(['listStyles'])),
  },
  {
    method: 'POST',
    match: '/proxy/render',
    handler: async (c) => {
      const { markdown, style } = JSON.parse(await c.readBody())
      const tmp = path.join(os.tmpdir(), `crosspost-panel-render-${Date.now()}.md`)
      fs.writeFileSync(tmp, markdown || '', 'utf8')
      const r = await runCli(['renderPreview', tmp, style || 'swiss'])
      try {
        fs.unlinkSync(tmp)
      } catch {}
      c.sendJson(200, r)
    },
  },
  {
    method: 'POST',
    match: '/proxy/cover',
    handler: async (c) => {
      const { title, template } = JSON.parse(await c.readBody())
      c.sendJson(
        200,
        await runCli([
          'generateCover',
          title || '',
          template || 'nebula',
          '--out-dir=' + path.join(os.tmpdir(), 'crosspost-cover'),
        ]),
      )
    },
  },
  {
    method: 'POST',
    match: '/proxy/cover-gallery',
    handler: async (c) => {
      const { title } = JSON.parse(await c.readBody())
      c.sendJson(
        200,
        await runCli([
          'generateCoverGallery',
          title || '',
          '--out-dir=' + path.join(os.tmpdir(), 'crosspost-cover-gallery'),
        ]),
      )
    },
  },
  {
    method: 'POST',
    match: '/proxy/publish-styled',
    handler: async (c) => {
      const reqData = JSON.parse(await c.readBody())
      const tmp = path.join(os.tmpdir(), `crosspost-panel-publish-${Date.now()}.json`)
      fs.writeFileSync(tmp, JSON.stringify(reqData), 'utf8')
      const r = await runCli(['syncStyledArticle', tmp], 300000)
      try {
        fs.unlinkSync(tmp)
      } catch {}
      c.sendJson(200, r)
    },
  },
  {
    method: 'POST',
    match: '/proxy/styles-delete',
    handler: async (c) => {
      const { name } = JSON.parse(await c.readBody())
      c.sendJson(200, await runCli(['styles', 'delete', name || '']))
    },
  },
  {
    method: 'POST',
    match: '/proxy/styles-rename',
    handler: async (c) => {
      const { oldName, newName } = JSON.parse(await c.readBody())
      c.sendJson(200, await runCli(['styles', 'rename', oldName || '', newName || '']))
    },
  },
  {
    method: 'POST',
    match: '/proxy/styles-toggle',
    handler: async (c) => {
      // 启用/禁用样式（2026-08-27）：更新 config.styles.disabled
      const { name, enabled } = JSON.parse(await c.readBody())
      if (!name) {
        c.sendJson(400, { error: '缺少样式名' })
        return
      }
      const cfg = readFullRuntimeConfig()
      const disabled = new Set((cfg.styles && cfg.styles.disabled) || [])
      if (enabled === false) disabled.add(name)
      else disabled.delete(name)
      writeRuntimeConfig({ styles: { disabled: [...disabled].sort() } })
      c.sendJson(200, { ok: true, name, enabled: enabled !== false })
    },
  },
  {
    method: 'GET',
    match: '/proxy/cover-settings',
    handler: async (c) => {
      // 封面/结束语模板设置（2026-08-27）：返回 coverSettings + 13 款启用状态
      const cfg = readFullRuntimeConfig()
      const cs = cfg.coverSettings || {}
      const disabled = new Set(cs.disabledTemplates || [])
      c.sendJson(200, {
        ok: true,
        coverSettings: {
          defaultTemplate: cs.defaultTemplate || 'nebula',
          endingTemplate: cs.endingTemplate || '',
          disabledTemplates: cs.disabledTemplates || [],
          endingCardEnabled: cs.endingCardEnabled !== false,
          endingText: cs.endingText || '',
          coverEnabled: cs.coverEnabled !== false,
        },
        templates: (await runCli(['listCoverTemplates'])).templates.map((name) => ({
          name,
          enabled: !disabled.has(name),
          isDefault: name === (cs.defaultTemplate || 'nebula'),
          isEnding: name === (cs.endingTemplate || cs.defaultTemplate || 'nebula'),
        })),
      })
    },
  },
  {
    method: 'POST',
    match: '/proxy/cover-settings',
    handler: async (c) => {
      const patch = JSON.parse((await c.readBody()) || '{}')
      const cfg = readFullRuntimeConfig()
      const cs = cfg.coverSettings || {}
      const next = {
        // 未传字段保留现有值（2026-08-27：单独提交开关不重置其他设置）
        defaultTemplate: patch.defaultTemplate || cs.defaultTemplate || 'nebula',
        endingTemplate: patch.endingTemplate || cs.endingTemplate || '',
        disabledTemplates: Array.isArray(patch.disabledTemplates)
          ? patch.disabledTemplates
          : cs.disabledTemplates || [],
        // 结束语图片（2026-08-27）：开关 + 自定义内容
        endingCardEnabled:
          typeof patch.endingCardEnabled === 'boolean'
            ? patch.endingCardEnabled
            : cs.endingCardEnabled !== false,
        endingText: typeof patch.endingText === 'string' ? patch.endingText : cs.endingText || '',
        // 封面图片（2026-08-31）：开关
        coverEnabled:
          typeof patch.coverEnabled === 'boolean' ? patch.coverEnabled : cs.coverEnabled !== false,
      }
      writeRuntimeConfig({ coverSettings: next })
      c.sendJson(200, { ok: true, coverSettings: next })
    },
  },

  // ── 引擎自检（v2.50）：把 doctor 的 26 项检查暴露给 Console ──
  //
  // 为什么需要：Console 的「接入与自检」页此前只从 /proxy/status、平台矩阵、项目注册表
  // 推导 4 步，**完全看不到 doctor** —— 而 doctor 才是"哪些能力可用、哪些配置矛盾"
  // 的权威（例如「一键生成」能力未提供、通知配置自相矛盾）。
  // 这些以前只能在终端 `npm run doctor` 看。
  // 只读：doctor 不写任何数据（它会探一次桥、拉一次 MCP 握手、读文件）。
  {
    method: 'GET',
    match: '/proxy/doctor',
    handler: async (c) => c.sendJson(200, await runCli(['doctor'], 60000)),
  },

  // ── 文章管理平台路由（CrossPost Console） ──
  {
    method: 'GET',
    match: '/proxy/articles',
    handler: async (c) => c.sendJson(200, await runCli(['listArticles'], 60000)),
  },
  {
    method: 'GET',
    match: (p) => p.startsWith('/proxy/articles/'),
    handler: async (c) => {
      // 2026-08-28 A2 错误契约：非法 id（含路径穿越尝试）→ 400，与 articles.mjs assertSafeId 规则一致
      let id
      try {
        id = decodeURIComponent(c.pathname.slice('/proxy/articles/'.length))
      } catch {
        c.sendJson(400, { error: '非法 articleId: URL 编码错误' })
        return
      }
      if (!/^[\w.-]+$/.test(id)) {
        c.sendJson(400, { error: `非法 articleId: ${String(id).slice(0, 40)}` })
        return
      }
      c.sendJson(200, await runCli(['getArticle', id], 60000))
    },
  },
  {
    method: 'GET',
    match: (p) => p.startsWith('/proxy/draft/'),
    handler: async (c) => {
      const id = decodeURIComponent(c.pathname.slice('/proxy/draft/'.length))
      c.sendJson(200, await runCli(['readDraft', id], 60000))
    },
  },
  {
    method: 'POST',
    match: '/proxy/publish',
    handler: async (c) => {
      const reqData = JSON.parse(await c.readBody())
      const tmp = path.join(os.tmpdir(), `crosspost-publish-${Date.now()}.json`)
      fs.writeFileSync(tmp, JSON.stringify(reqData), 'utf8')
      const r = await runCli(['publishArticle', tmp], 600000)
      try {
        fs.unlinkSync(tmp)
      } catch {}
      // 2026-09-11：手动重推留痕——此前"未推送任何平台"在桥侧零日志，只能靠猜。
      // 记录请求意图（manual/平台数）与响应骨架，便于区分"早退错误 / 静默跳过 / 平台全失败"。
      const wantN = Array.isArray(reqData.platforms) ? reqData.platforms.length : null
      const gotN = r && r.platforms ? Object.keys(r.platforms).length : 0
      const okN =
        r && r.platforms
          ? Object.values(r.platforms).filter((p) => p && p.status === 'ok').length
          : 0
      console.error(
        '[publish] ' +
          JSON.stringify({
            id: reqData.id || null,
            manual: reqData.manual === true,
            wechat: reqData.wechat !== false,
            wantPlatforms: wantN,
            reqPlatforms: Array.isArray(reqData.platforms) ? reqData.platforms : null,
            gotPlatforms: gotN,
            okPlatforms: okN,
            skipped: (r && r.skip) || [],
            wechatStatus: (r && r.wechat && r.wechat.status) || null,
            // 2026-09-11：通知留痕带上幂等键与去重标记（飞书按 key 去重时 messageId 会复用，
            // 此前只能看到"ok"，无法定位"为什么没收到"）
            notifyStatus: (r && r.notify && r.notify.status) || null,
            notifyKey: (r && r.notify && r.notify.key) || null,
            notifyDeduped: !!(r && r.notify && r.notify.deduped),
            notifyMessageId: (r && r.notify && r.notify.messageId) || null,
            status: (r && r.status) || null,
            error: (r && r.error) || null,
          }),
      )
      // 2026-09-12：成功推送到某平台 = 该平台确实登录过 → 记入 ever-authed（锁定平台
      // weixin/douyin 的「检查范围」靠它生效：从未登录过的不查，登录过之后才自动纳入）。
      const authedNow = okPlatformsFromPublish(r)
      if (markEverAuthed(authedNow)) {
        console.error(
          `[platforms] 发布成功 → 记入"曾登录过"：${authedNow.join(',')}（下次检查纳入）`,
        )
      }
      c.sendJson(200, r)
    },
  },

  // 调度（自动推送开关）
  {
    method: 'GET',
    match: '/proxy/schedule',
    handler: async (c) => c.sendJson(200, await getScheduleStatus()),
  },
  // 通知通道自检（2026-09-11）：Console「发送测试通知」按钮用；用当前配置真实发一条
  {
    method: 'POST',
    match: '/proxy/notify-test',
    handler: async (c) => {
      const r = await runCli(['notifyTest'], 60000)
      // 留痕：便于事后核对"何时发过自检、返回了什么 messageId"
      console.error('[notify-test] ' + JSON.stringify(r).slice(0, 300))
      c.sendJson(200, r)
    },
  },
  {
    method: 'POST',
    match: '/proxy/schedule',
    handler: async (c) => {
      const { slot, enabled } = JSON.parse(await c.readBody())
      const r = await setScheduleSlot(slot, !!enabled)
      if (r.error) {
        c.sendJson(400, r)
        return
      }
      c.sendJson(200, { ...r, ...(await getScheduleStatus()) })
    },
  },
  // 手动触发一次（v2.3）：不受"每天最多自动跑一次"限制，Console 的「立即运行」用它。
  // 沿用删除类操作同一条授权约定（`authorized: true`），因为它会真的跑项目脚本。
  {
    method: 'POST',
    match: '/proxy/schedule/run',
    handler: async (c) => {
      const body = JSON.parse((await c.readBody()) || '{}')
      const denied = requireDeleteAuth(body)
      if (denied) {
        c.sendJson(denied.code, denied)
        return
      }
      const r = triggerScheduleSlot({ slot: body.slot, projectId: body.project })
      c.sendJson(r.ok ? 200 : 400, r)
    },
  },
  // 动态槽位（v2.3）：改名称/时间/开关。**命令**由项目声明
  // （`.crosspost/schedule.json`）提供，引擎不替项目编造命令，也不写项目的仓库。
  {
    method: 'POST',
    match: '/proxy/schedule/upsert',
    handler: async (c) => {
      const body = JSON.parse((await c.readBody()) || '{}')
      const r = await upsertScheduleSlot(body || {})
      c.sendJson(r.error ? 400 : 200, r)
    },
  },
  {
    method: 'POST',
    match: '/proxy/schedule/remove',
    handler: async (c) => {
      const body = JSON.parse((await c.readBody()) || '{}')
      const r = await removeScheduleSlot(body && body.slot)
      c.sendJson(r.error ? 400 : 200, r)
    },
  },
  {
    method: 'POST',
    match: '/proxy/schedule-reset',
    handler: async (c) => {
      // v2.3 语义变更：以前是"从 launchctl 实际状态恢复"，现在是
      // **清空槽位开关覆盖**（回到 fail-open：未设 = 跑）。
      // v2.77：分层写（见 cli-worker.writeConfigScoped）——项目上下文里只清该项目覆盖层的 schedule
      writeConfigScoped((cfg) => {
        cfg.schedule = {}
      })
      c.sendJson(200, { ok: true, ...(await getScheduleStatus()) })
    },
  },

  // P5 数据维护：历史回填 / 手动补记
  {
    method: 'POST',
    match: '/proxy/backfill',
    handler: async (c) => {
      const { force } = JSON.parse((await c.readBody()) || '{}')
      c.sendJson(200, await runCli(['backfill', force ? '--force' : ''], 120000))
    },
  },
  {
    method: 'POST',
    match: '/proxy/mark-published',
    handler: async (c) => {
      const tmp = path.join(os.tmpdir(), `crosspost-mark-${Date.now()}.json`)
      fs.writeFileSync(tmp, JSON.stringify(JSON.parse(await c.readBody())), 'utf8')
      const r = await runCli(['markPublished', tmp], 30000)
      try {
        fs.unlinkSync(tmp)
      } catch {}
      c.sendJson(200, r)
    },
  },
  { method: 'GET', match: '/proxy/backup', handler: (c) => c.sendJson(200, getBackupStatus()) },
  {
    method: 'POST',
    match: '/proxy/backup',
    handler: async (c) => c.sendJson(200, await backupArticles()),
  },

  // 抖音手动推送（单槽草稿箱，仅手动；2026-08-19 用户决策）
  {
    method: 'POST',
    match: '/proxy/publish-douyin',
    handler: async (c) => {
      const reqBody = JSON.parse(await c.readBody())
      const tmp = path.join(os.tmpdir(), `crosspost-douyin-${Date.now()}.json`)
      fs.writeFileSync(tmp, JSON.stringify(reqBody), 'utf8')
      const r = await runCli(['publishDouyin', tmp], 600000)
      try {
        fs.unlinkSync(tmp)
      } catch {}
      // 2026-09-11：失败留痕（此前失败只回前端一句"未知原因"，桥侧零日志，事后无法复盘）
      const dy = r && r.platforms && r.platforms.douyin
      if ((r && r.error) || !dy || dy.status !== 'ok') {
        console.error(
          '[douyin] 推送失败 ' +
            JSON.stringify({
              id: reqBody.id,
              req: reqBody,
              error: (r && r.error) || null,
              douyin: dy || null,
              errors: (r && r.errors) || [],
              // 响应骨架：区分「CLI 未返回 platforms」与其他形态（此前只看到 platforms 缺失，需原样留痕）
              keys: r && typeof r === 'object' ? Object.keys(r) : typeof r,
              status: r && r.status,
              skip: (r && r.skip) || null,
              targetPlatforms: (r && r.targetPlatforms) || null,
            }),
        )
      } else {
        console.error('[douyin] 推送成功 id=' + reqBody.id + ' postUrl=' + (dy.postUrl || '-'))
      }
      // 2026-09-12：抖音推送成功 = 确实登录过 → 记入 ever-authed（锁定平台纳入检查范围的判别依据）
      if (markEverAuthed(okPlatformsFromPublish(r))) {
        console.error('[platforms] 抖音推送成功 → 记入"曾登录过"：douyin（下次检查纳入）')
      }
      c.sendJson(200, r)
    },
  },

  // 文章管理（P3：编辑/删除/归档）
  {
    method: 'POST',
    match: '/proxy/update-draft',
    handler: async (c) => {
      const tmp = path.join(os.tmpdir(), `crosspost-update-${Date.now()}.json`)
      fs.writeFileSync(tmp, JSON.stringify(JSON.parse(await c.readBody())), 'utf8')
      const r = await runCli(['updateDraft', tmp], 30000)
      try {
        fs.unlinkSync(tmp)
      } catch {}
      c.sendJson(200, r)
    },
  },
  {
    method: 'POST',
    match: '/proxy/save-draft',
    handler: async (c) => {
      // 2026-09-05 编写工作台：新建草稿（无 id）走 createDraft；已有 id 走 updateDraft
      const reqData = JSON.parse(await c.readBody())
      const tmp = path.join(os.tmpdir(), `crosspost-save-${Date.now()}.json`)
      fs.writeFileSync(tmp, JSON.stringify(reqData), 'utf8')
      const r = reqData.id
        ? await runCli(['updateDraft', tmp], 30000)
        : await runCli(['createDraft', tmp], 30000)
      try {
        fs.unlinkSync(tmp)
      } catch {}
      c.sendJson(200, r)
    },
  },
  {
    method: 'POST',
    match: '/proxy/delete-draft',
    handler: async (c) => {
      const reqData = JSON.parse(await c.readBody())
      const authErr = requireDeleteAuth(reqData)
      if (authErr) {
        c.sendJson(authErr.code, authErr)
        return
      }
      c.sendJson(200, await runCli(['deleteDraft', reqData.id || ''], 30000))
    },
  },
  {
    method: 'POST',
    match: '/proxy/set-status',
    handler: async (c) => {
      const reqData = JSON.parse(await c.readBody())
      const tmp = path.join(os.tmpdir(), `crosspost-status-${Date.now()}.json`)
      fs.writeFileSync(tmp, JSON.stringify(reqData), 'utf8')
      const r = await runCli(['setArticleStatus', tmp], 30000)
      try {
        fs.unlinkSync(tmp)
      } catch {}
      c.sendJson(200, r)
    },
  },

  // ── 留存库（2026-08-20：低分/风险文章人工控制） ──
  {
    method: 'GET',
    match: '/proxy/retained',
    handler: async (c) => c.sendJson(200, await runCli(['listRetained'], 30000)),
  },
  {
    method: 'POST',
    match: (p) => p.startsWith('/proxy/retained/'),
    handler: async (c) => {
      const reqData = JSON.parse((await c.readBody()) || '{}')
      const action = c.pathname.slice('/proxy/retained/'.length)
      // 2026-08-21 起移除 publish：留存库仅支持 restore/delete
      if (!['restore', 'delete'].includes(action)) {
        c.sendJson(400, { error: 'unknown retained action' })
        return
      }
      if (action === 'delete') {
        const authErr = requireDeleteAuth(reqData)
        if (authErr) {
          c.sendJson(authErr.code, authErr)
          return
        }
      }
      const tmp = path.join(os.tmpdir(), `crosspost-retained-${Date.now()}.json`)
      fs.writeFileSync(tmp, JSON.stringify({ ...reqData, action }), 'utf8')
      const r = await runCli(['retainedAction', tmp], 600000)
      try {
        fs.unlinkSync(tmp)
      } catch {}
      c.sendJson(200, r)
    },
  },
  {
    method: 'POST',
    match: '/proxy/classify',
    handler: async (c) => c.sendJson(200, await runCli(['classifyArticles'], 60000)),
  },

  // ── 归档库（2026-08-21：草稿文件移入 drafts/archive/，人工恢复/删除） ──
  {
    method: 'GET',
    match: '/proxy/archive',
    handler: async (c) => c.sendJson(200, await runCli(['listArchive'], 30000)),
  },
  {
    method: 'POST',
    match: '/proxy/archive',
    handler: async (c) => {
      const reqData = JSON.parse((await c.readBody()) || '{}')
      const action = reqData.action
      if (!['archive', 'restore', 'delete'].includes(action)) {
        c.sendJson(400, { error: 'unknown archive action' })
        return
      }
      if (action === 'delete') {
        const authErr = requireDeleteAuth(reqData)
        if (authErr) {
          c.sendJson(authErr.code, authErr)
          return
        }
        c.sendJson(200, await runCli(['deleteDraft', reqData.id || ''], 30000))
        return
      }
      const tmp = path.join(os.tmpdir(), `crosspost-archive-${Date.now()}.json`)
      fs.writeFileSync(
        tmp,
        JSON.stringify({ id: reqData.id, restore: action === 'restore' }),
        'utf8',
      )
      const r = await runCli(['archiveArticle', tmp], 30000)
      try {
        fs.unlinkSync(tmp)
      } catch {}
      c.sendJson(200, r)
    },
  },

  // ── 手动留存（2026-08-21：人工移入留存库 rejected/risk） ──
  {
    method: 'POST',
    match: '/proxy/retain',
    handler: async (c) => {
      const reqData = JSON.parse((await c.readBody()) || '{}')
      if (!reqData.id) {
        c.sendJson(400, { error: 'missing id' })
        return
      }
      if (!['rejected', 'risk'].includes(reqData.dir)) {
        c.sendJson(400, { error: 'dir 必须是 rejected 或 risk' })
        return
      }
      const tmp = path.join(os.tmpdir(), `crosspost-retain-${Date.now()}.json`)
      fs.writeFileSync(
        tmp,
        JSON.stringify({ id: reqData.id, dir: reqData.dir, reason: reqData.reason || null }),
        'utf8',
      )
      const r = await runCli(['retainArticle', tmp], 30000)
      try {
        fs.unlinkSync(tmp)
      } catch {}
      c.sendJson(200, r)
    },
  },
  {
    method: 'POST',
    match: '/proxy/set-risk',
    handler: async (c) => {
      const { id, risk } = JSON.parse((await c.readBody()) || '{}')
      c.sendJson(200, await runCli(['setArticleRisk', id || '', risk || ''], 30000))
    },
  },

  // ── 选题中心（2026-08-22：选题库 + 一键生成 draft-only） ──
  {
    method: 'GET',
    match: '/proxy/topics',
    handler: (c) =>
      c.sendJson(200, {
        topics: listTopics(),
        task: getTopicGenStatus(),
        // v2.111：逐条任务视图（Console 逐行渲染排队位次/进度用）
        tasks: getTopicGenTasks().tasks,
      }),
  },
  {
    method: 'POST',
    match: '/proxy/topics/generate',
    handler: async (c) => {
      let body = {}
      try {
        body = JSON.parse((await c.readBody()) || '{}')
      } catch {
        c.sendJson(400, { error: '请求体不是合法 JSON' })
        return
      }
      const { slot, keyword, topicId, date } = body
      // 栏目由项目声明，引擎不设白名单：只校验 id 形状（小写字母开头，字母/数字/横线，≤32 字）
      if (!normalizeSlotId(slot)) {
        c.sendJson(400, {
          error: 'slot 必须是合法的栏目 id（小写字母开头，字母/数字/横线，≤32 字）',
        })
        return
      }
      if (!keyword || !String(keyword).trim()) {
        c.sendJson(400, { error: 'keyword 必填' })
        return
      }
      // v2.111：入队前先探一次端点（TCP，不触发真实生成）。`probe:false` 可跳过
      // （批量入口会用一次探测代表整批，避免 N 次重复拨号）。
      if (body.probe !== false) {
        const pre = await preflightGenerate()
        if (!pre.ok) {
          c.sendJson(pre.code === 'generate_not_provided' ? 501 : 503, {
            error: pre.code,
            message: pre.message,
            provided: pre.code !== 'generate_not_provided',
          })
          return
        }
      }
      // 入队是同步的：拿到 task id 就能立刻回「排队中（第 N 位）」，执行由队列驱动
      const r = startTopicGenerate(slot, String(keyword).trim(), { topicId, date })
      // 2026-09-18（v2.01）：能力未提供（引擎不再代跑外部脚本）→ 501 + 可读说明，
      // 而不是笼统 409；Console 依 `provided:false` 隐藏入口。
      if (r && r.error === 'generate_not_provided') {
        c.sendJson(501, r)
        return
      }
      c.sendJson(r.error ? 409 : 202, r)
    },
  },
  {
    method: 'POST',
    match: '/proxy/topics/generate/batch',
    handler: async (c) => {
      let body = {}
      try {
        body = JSON.parse((await c.readBody()) || '{}')
      } catch {
        c.sendJson(400, { error: '请求体不是合法 JSON' })
        return
      }
      const items = Array.isArray(body.items) ? body.items : []
      if (!items.length) {
        c.sendJson(400, { error: 'items 必填（[{slot, keyword, topicId?, date?}]）' })
        return
      }
      if (items.length > 50) {
        c.sendJson(400, { error: `一次最多入队 50 条（收到 ${items.length}）` })
        return
      }
      // 整批只探一次端点：N 条选题指向同一个端点，逐条探测只是重复拨号
      const pre = await preflightGenerate()
      if (!pre.ok) {
        c.sendJson(pre.code === 'generate_not_provided' ? 501 : 503, {
          error: pre.code,
          message: pre.message,
          provided: pre.code !== 'generate_not_provided',
        })
        return
      }
      const queued = []
      const rejected = []
      for (const it of items) {
        const bad = validateTopicItem(it)
        if (bad) {
          rejected.push({ ...bad, error: 'bad_request' })
          continue
        }
        const r = startTopicGenerate(it.slot, String(it.keyword).trim(), {
          topicId: it.topicId,
          date: it.date,
        })
        if (r.error)
          rejected.push({ slot: it.slot, keyword: it.keyword, error: r.error, message: r.message })
        else queued.push(r.task)
      }
      c.sendJson(200, {
        ok: true,
        queued: queued.length,
        rejected: rejected.length,
        tasks: queued,
        failures: rejected,
        ...getTopicGenTasks(),
      })
    },
  },
  {
    method: 'POST',
    match: '/proxy/topics/generate/cancel',
    handler: async (c) => {
      let body = {}
      try {
        body = JSON.parse((await c.readBody()) || '{}')
      } catch {
        c.sendJson(400, { error: '请求体不是合法 JSON' })
        return
      }
      if (!body.id) {
        c.sendJson(400, { error: 'id 必填（任务 id，见 /proxy/topics/generate/tasks）' })
        return
      }
      const r = cancelTopicGenerate(body.id)
      c.sendJson(r.error ? 409 : 200, r)
    },
  },
  {
    method: 'GET',
    match: '/proxy/topics/generate/tasks',
    handler: (c) => c.sendJson(200, getTopicGenTasks()),
  },
  {
    method: 'GET',
    match: '/proxy/topics/generate/status',
    handler: (c) => c.sendJson(200, getTopicGenStatus()),
  },

  // ── 生成消耗（token + 费用，2026-08-22） ──
  {
    method: 'GET',
    match: (p) => p.startsWith('/proxy/cost/'),
    handler: async (c) => {
      const id = decodeURIComponent(c.pathname.slice('/proxy/cost/'.length))
      c.sendJson(200, await runCli(['articleCost', id], 60000))
    },
  },
  {
    method: 'GET',
    match: '/proxy/costs',
    handler: async (c) => {
      const date = c.query.get('date') || ''
      c.sendJson(200, await runCli(['listCosts', date], 60000))
    },
  },

  // 落选选题删除（2026-08-22 二期：仅 rejected 可删，删除前自动备份；generated/adopted 拒绝）
  {
    method: 'POST',
    match: '/proxy/topics/delete',
    handler: async (c) => {
      const reqData = JSON.parse((await c.readBody()) || '{}')
      const authErr = requireDeleteAuth(reqData)
      if (authErr) {
        c.sendJson(authErr.code, authErr)
        return
      }
      const id = reqData.id
      if (!id) {
        c.sendJson(400, { error: 'id 必填' })
        return
      }
      const r = deleteTopic(String(id))
      if (r.error) {
        c.sendJson(r.error.includes('不存在') ? 404 : 403, r)
        return
      }
      c.sendJson(200, r)
    },
  },
]

async function dispatchRoute(ctx) {
  for (const r of ROUTES) {
    if (r.method !== ctx.req.method) continue
    const ok = typeof r.match === 'string' ? ctx.pathname === r.match : r.match(ctx.pathname)
    if (!ok) continue
    await r.handler(ctx)
    return true
  }
  return false
}

function startProxyHttp(httpPort) {
  return new Promise((resolve, reject) => {
    ensureApiToken()
    proxyHttpServer = http.createServer(async (req, res) => {
      const origin = req.headers.origin || ''
      setCors(res, origin)
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      // sendJson / readBody 收敛到模块级（2026-09-01 P1-6）
      const sendJson = (code, obj) => sendJsonTo(res, code, obj)
      const readBody = () => readJsonBody(req, sendJson)
      // 路由匹配忽略查询字符串（弹窗刷新会带 ?refresh=1）
      const pathname = (req.url || '').split('?')[0]
      const query = new URL(req.url || '', 'http://localhost').searchParams
      // 免鉴权白名单：静态页面 + token 引导端点 + 浏览器自动请求的图标
      const isStatic =
        req.method === 'GET' &&
        (pathname === '/' ||
          pathname === '/index.html' ||
          pathname.startsWith('/console/') ||
          pathname === '/favicon.ico' ||
          pathname === '/apple-touch-icon.png' ||
          pathname === '/brand-icon')
      const isBootstrap = req.method === 'GET' && pathname === '/proxy/bootstrap'
      if (!isStatic && !isBootstrap && !hasApiToken(req)) {
        sendJson(401, { error: '缺少或错误的 API token（X-CrossPost-Token）' })
        return
      }
      try {
        if (isBootstrap) {
          sendJson(200, { token: apiToken })
          return
        }
        const ctx = { req, res, pathname, query, sendJson, readBody }
        // 2026-09-19（v2.22）内容域 project 维度：在**唯一分发口**建立项目上下文。
        //   · 来源：`X-CrossPost-Project` 请求头 或 `?project=` 查询参数（都能在不读请求体
        //     的前提下拿到，因此对既有路由零侵入；请求体里的 project 不支持，用头即可）
        //   · 未声明项目 → withProject('') 不建立上下文 → 全链路沿用默认路径（生产不变）
        //   · 声明但无效（未注册/manifest 无效/不可达）→ 解析失败回退默认路径，不报错，
        //     避免"引入多项目"把既有调用打断；Console 侧由切换器标记为不可选
        const reqProject = projectFromRequest({ headers: req.headers, query })
        if (await withProject(reqProject, () => dispatchRoute(ctx))) return
        // 静态页面（CrossPost Console：http://127.0.0.1:9540/）
        if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
          serveStatic(res, 'index.html')
          return
        }
        if (req.method === 'GET' && pathname.startsWith('/console/')) {
          serveStatic(res, pathname.slice('/console/'.length))
          return
        }
        if (req.method === 'GET' && pathname === '/brand-icon') {
          serveBrandIcon(res)
          return
        }
        sendJson(404, { error: 'not found' })
      } catch (e) {
        sendJson(500, { error: String((e && e.message) || e) })
      }
    })
    proxyHttpServer.listen(httpPort, () => {
      console.error(`[proxy] HTTP API listening on ${httpPort}`)
      resolve()
    })
    proxyHttpServer.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') {
        console.error(`[proxy] HTTP port ${httpPort} in use — 已有 Bridge 在运行，本进程退出`)
        process.exit(0)
      } else reject(e)
    })
  })
}

/** 托管 CrossPost Console 静态文件（防路径穿越：resolve 后校验仍在 CONSOLE_DIR 内；2026-08-24 支持 modules/ 子目录） */
function serveStatic(res, name) {
  let decoded
  try {
    decoded = decodeURIComponent(name)
  } catch {
    decoded = name
  }
  const file = path.resolve(CONSOLE_DIR, decoded)
  if (
    !file.startsWith(CONSOLE_DIR + path.sep) ||
    !fs.existsSync(file) ||
    !fs.statSync(file).isFile()
  ) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const ext = path.extname(file).toLowerCase()
  const mime =
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    }[ext] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': CSP,
  })
  fs.createReadStream(file).pipe(res)
}

/** 用 macOS sips 把大图缩到 256×256 输出 PNG（best-effort；失败返回 false，由调用方回退原图）。2026-09-03 */
function resizeBrandRaster(rawPath, outPath) {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/sips',
      ['-s', 'format', 'png', '-Z', '256', rawPath, '--out', outPath],
      { timeout: 15000 },
      (err) => resolve(!err && fs.existsSync(outPath)),
    )
  })
}

/** 托管自定义品牌图标（bridge/brand/icon.<ext>，免鉴权 GET /brand-icon，浏览器拉 favicon 无 token）。2026-09-02 新增 */
function serveBrandIcon(res) {
  let icon = null
  try {
    for (const f of fs.readdirSync(BRAND_DIR))
      if (f.startsWith('icon.')) {
        icon = path.join(BRAND_DIR, f)
        break
      }
  } catch {
    icon = null
  }
  if (!icon || !fs.existsSync(icon) || !fs.statSync(icon).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('no brand icon')
    return
  }
  const st = fs.statSync(icon)
  const mime =
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    }[path.extname(icon).toLowerCase()] || 'application/octet-stream'
  // 2026-09-03：URL 带版本 ?v=<ts>，可安全长期缓存——消除每次刷新重新下载/解码整张大图导致的"短暂图裂→慢慢加载"
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': st.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
  })
  fs.createReadStream(icon).pipe(res)
}

/**
 * 一次性迁移（2026-09-12 模型 A）：把「仅检查」平台（微信/抖音）补进勾选集 platforms.default。
 * 背景：上一版把它们做成"不可勾选"，本次解锁后它们能否被检查取决于是否被勾选；用户已明确
 * "微信和抖音也需要勾选"。这里幂等补齐（不动已有顺序、不删任何 id），写一次、日志留痕。
 * 派发行为零变化——publish.mjs 的 config 默认分支会过滤掉它们（CHECK_ONLY_PLATFORMS）。
 */
function migrateCheckOnlyPlatforms() {
  try {
    const cfg = readFullRuntimeConfig()
    const cur = Array.isArray(cfg.platforms && cfg.platforms.default) ? cfg.platforms.default : []
    const missing = CHECK_ONLY_PLATFORMS.filter((id) => !cur.includes(id))
    if (!missing.length) return
    const next = [...cur, ...missing]
    writeRuntimeConfig({ platforms: { ...(cfg.platforms || {}), default: next } })
    console.error(
      `[platforms] 迁移：勾选集补齐"仅检查"平台 ${missing.join(',')} → ${next.length} 个（派发不受影响）`,
    )
  } catch (e) {
    console.error(`[platforms] 迁移失败（不影响启动）：${(e && e.message) || e}`)
  }
}

async function main() {
  process.env.CROSSPOST_START_TS = String(Date.now())
  loadEverAuthed()
  migrateCheckOnlyPlatforms()
  await startProxyChannel()
  console.error(`[proxy] 通道就绪 ws=localhost:${proxyWsPort} http=localhost:${proxyWsPort + 1}`)
  /** `startScheduler()` 的结果（诊断用；Console 从 /proxy/schedule 读锁的持有者） */
  let startSchedulerResult = { ok: false, lock: null, specs: 0 }
  // 文章库每日备份：启动时 + 每 6 小时检查一次（同天不重复）
  maybeBackupArticles()
  setInterval(() => maybeBackupArticles(), 6 * 3600 * 1000)
  // 平台登录状态定期自检（2026-09-11）：检查不再由请求触发——每 60s tick 一次，
  // 仅在缓存超龄（platformsCacheMs，设置页可配）或失败平台超 FAIL_RETRY_MS 时后台刷新；
  // 扩展未在线时跳过（避免无谓失败），交互请求始终只读缓存。
  setInterval(platformCheckTick, 60 * 1000)
  // 常驻 worker 预热（2026-09-21 v2.100）：三个 cli worker 各需 ~1.2s 冷启动，若由用户
  // 第一次请求承担，首屏实测 1690ms（热态 353–397ms）。启动后后台错峰拉起，用户首开即热。
  prewarmWorkers()
  // 调度器启动（v2.3）：引擎自带定时器，桥是缺省宿主。
  // 抢不到单实例锁（另一个独立 scheduler 进程在跑）时不 arm 并如实说明——
  // 两个定时器同时跑会把每天的计划各触发一次。
  startSchedulerResult = startScheduler()
  if (!startSchedulerResult.ok) {
    console.error(
      `[scheduler] 未取得调度锁：${startSchedulerResult.lock && startSchedulerResult.lock.reason}`,
    )
  } else {
    const s = startSchedulerResult
    console.error(
      `[scheduler] 内置定时器就绪（${s.specs} 个槽位${s.lock.reclaimed ? '，接管了陈旧锁' : ''}）`,
    )
  }
  // 生成费用会话预热（2026-08-22 性能优化）：后台预热，报表秒开；失败不影响启动。
  // 2026-09-22（v2.102.1）**分块**：278 个会话整块要 6.5s，而 costs 车道是串行队列 ——
  // 实测"重启桥后 1.2s 内调 /proxy/costs"要等 **7.46s**（用户开机后第一次看报表就是这个体感）。
  // 改成每块 20 个会话循环调用，插进来的 /proxy/costs 最多等一块（≈0.5s）。
  prewarmCostsInChunks()
  // 保持进程存活
  setInterval(() => {}, 1 << 30)
}

/** 分块预热会话费用缓存（每块 20 个会话；插进来的报表请求最多等一块） */
const PREWARM_COST_CHUNK = 20
function prewarmCostsInChunks() {
  let warmed = 0
  let total = 0
  const step = async (offset) => {
    const r = await runCli(['prewarmCosts', String(offset), String(PREWARM_COST_CHUNK)], 120000)
    if (!r || r.error) {
      console.error(`[proxy] 费用会话预热中断: ${(r && r.error) || '无响应'}`)
      return
    }
    warmed += r.warmed || 0
    total = r.total || total
    if (r.done) {
      console.error(
        `[proxy] 费用会话预热完成: ${warmed}/${total} 个会话（分块 ${PREWARM_COST_CHUNK}/块）`,
      )
      return
    }
    await step(offset + (r.warmed || PREWARM_COST_CHUNK))
  }
  step(0).catch((e) =>
    console.error(`[proxy] 费用会话预热失败（不影响启动）: ${(e && e.message) || e}`),
  )
}

main().catch((err) => {
  console.error('[bridge] failed to start:', err)
  process.exit(1)
})

function stopAll() {
  if (proxyHttpServer) {
    try {
      proxyHttpServer.close()
    } catch {}
  }
  // 2026-09-21（v2.100）：显式收掉三个常驻 cli worker（否则重启时留下孤儿进程占 CPU）
  try {
    stopWorkers()
  } catch {}
  // v2.3：收掉调度器（停掉在跑的子进程 + 释放单实例锁）。
  // 顺序在 stopWorkers 之后：槽位子进程是**项目的**脚本，它可能还在等引擎的 CLI。
  try {
    stopScheduler()
  } catch {}
  process.exit(0)
}
process.on('SIGINT', stopAll)
process.on('SIGTERM', stopAll)
