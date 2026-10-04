/**
 * bridge 常驻 cli worker（2026-08-24 初版单 worker；2026-08-28 升级三 worker 读写分离；
 * 2026-09-21 v2.101 拆出 costs 车道 → 四 worker）
 *
 * 单 worker + 串行队列的瓶颈：publishArticle（超时上限 10 分钟）等长任务占住队列时，
 * Console 所有请求（列表/详情/预览）全部排队等待 → 表现为"Console 卡住"。
 * 所以**"都在同一个队列里"本身就是缺陷**：每拆一条重活都是一次实测驱动的分流。
 *
 * 四 worker 分工（各自独立进程、独立串行队列）：
 *   reader  纯读方法（listArticles/getArticle/readDraft/listStyles/...）——永不阻塞，页面永远流畅
 *   costs   费用/会话解析（listCosts/articleCost/prewarmCosts）
 *           —— 实测 0.9–7.3s、~600MB，2026-09-21 从 reader 拆出（见 COSTS_METHODS 注释）
 *   writer  短写方法（archive/retain/delete/markPublished/...）——发布期间仍可归档/留存/补记
 *   heavy   长任务/网络/CPU（publishArticle/renderPreview/generateCover/verifyWechat/...）——10 分钟发布不堵任何人
 *
 * 安全性：cli.mjs --ipc 无锁/无进程内共享（多实例天然隔离）；config 只在 bridge 主进程写、
 * cli worker 只读；记录写入均为原子写（tmp+rename）。任一 worker 崩溃独立回退 execFile。
 *
 * ── 为什么常驻 worker 必须用 spawn 而不是 execFile（2026-09-21 v2.100 事故）────────
 * 2026-09-21 实测"整个 Console 变慢、不再瞬开"：reader worker 已被杀成永久冷启动态，
 * 每个 reader 请求要付 ~1.2s（进程 + jsdom 解析），而热 worker 只要 1–40ms。根因是
 * `execFile(..., { maxBuffer: 64MB })`：Node 对 execFile 的**整个进程生命周期**累计
 * stdout+stderr 字节（见 lib/child_process.js 的 onChildStdout/onChildStderr），一旦超过
 * maxBuffer 就 `kill()` 子进程并回调 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` —— **即使调用方
 * 自己挂了 data 监听也一样计数**（已实测：maxBuffer=5000 时子进程收 5514B 后被杀）。
 * 而 worker 是**故意长期存活**的进程，每轮页面加载要过 ~0.9MB JSON，64MB ≈ 65 次加载就撞死
 * 一次；撞够 maxRestarts 次后 `failed` 把它永久降级，直到重启桥。改用 spawn 后不做任何
 * 字节计数、也不缓存输出（`maxBuffer: Infinity` 反而更坏：Node 仍会把每个 chunk push 进
 * 内部 `_stdout` 数组 → 常驻进程无界内存泄漏）。
 * 同批加的可观测性：worker 的拉起/退出/冷却都写 stderr（落 bridge.err.log），
 * `/proxy/health` 暴露三 worker 状态 —— 此前这条链路**一行日志都没有**，只能靠推理定位。
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECT_FLAG, currentProject } from '../crosspost-runtime/src/project-context.mjs'
import { listProjects } from '../crosspost-runtime/src/projects.mjs'
import { configPath } from '../crosspost-runtime/src/config-path.mjs'
import {
  withProjectOverlay,
  writeProjectConfig,
  readProjectConfig,
} from '../crosspost-runtime/src/config-layers.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE_DIR = __dirname
/** config.json 路径：可用 CROSSPOST_CONFIG 覆盖（测试隔离用，避免污染真实配置）；
 *  生产不设该变量，路径与历史一致。 */
export const CONFIG_PATH = configPath()
/** 常驻 CLI 路径：`CROSSPOST_CLI_PATH` 可覆盖（测试注入假 CLI 用，见
 *  tests/cli-worker-resilience.test.mjs）；生产不设该变量 → 与历史逐字一致。 */
export const NATIVE_CLI =
  process.env.CROSSPOST_CLI_PATH ||
  path.join(BRIDGE_DIR, '..', 'crosspost-runtime', 'src', 'cli.mjs')

/** bridge 侧运维日志：一律走 stderr —— stdout 是 launchd 的 bridge.out.log（历史为空），
 *  stderr 落 bridge.err.log，与其它 bridge 日志同处，便于"变慢了先看这个"。
 *
 *  2026-09-22（v2.103.1）：改走 `console.error` —— run-bridge.mjs 给 console.* 统一加了
 *  ISO 本地时间戳（带时区偏移），而此前这里直接 `process.stderr.write` **绕过了那层包装**，
 *  于是 worker 生命周期行是全日志里唯一没有时间戳的，复盘"哪个车道什么时候起来的"只能靠插值。
 *  （测试进程里 console.error 没有被包装，输出保持干净。） */
function bridgeLog(line) {
  try {
    console.error(line)
  } catch {
    /* stderr 关闭时忽略 */
  }
}

/** 原子写 config.json（tmp+rename，2026-09-01 单写者）：bridge 主进程唯一配置写入入口，
 *  与 articles/editorial-memory 的原子写一致，防写坏导致 bridge 读空。 */
export function writeConfigFile(cfg) {
  const target = configPath() // 每次调用重读 env：测试里会切 CROSSPOST_CONFIG
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  fs.renameSync(tmp, target)
  return cfg
}

/**
 * 读**生效**配置：引擎 `config.json` 深合并当前项目的覆盖层（v2.77）。
 *
 * `schedule.mjs`（槽位开关与栏目时间）与 `run-bridge.mjs`（设置页、autoPush、品牌…）
 * 共用它，于是这些**项目级**设置自动跟着当前项目走；
 * 引擎级键（proxy / timeout / 并发 / `projectsDirs`）永远来自引擎文件（见 `config-layers.mjs`）。
 * 无项目上下文 → 与分层前逐字一致。
 */
export function readFullRuntimeConfig() {
  return withProjectOverlay(readEngineConfigFile())
}

/** 只读引擎 `config.json` 原文（不含项目覆盖层）：给"只要引擎级事实"的调用方 */
export function readEngineConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 全部已注册项目覆盖层里声明的 `platforms.default`（并集用，v2.106.2）。
 *
 * 为什么需要它：平台登录**检查范围**必须有唯一确定的答案，不能随"谁在问"变化 ——
 * 详见 `platforms-retry.mjs` 的 `resolveScopeFromLayers`。
 * 这里只做 I/O：注册表里每个合法项目的覆盖层 → `platforms.default`，原样拼起来
 * （去重/排序/过滤未知 id 交给 `normalizeIds`）。
 * 读不到 / manifest 无效 → 跳过该项目，绝不抛错（与既有"回退默认"语义一致）。
 */
export function projectPlatformDefaults() {
  const out = []
  let projects = []
  try {
    projects = listProjects() || []
  } catch {
    return out
  }
  for (const p of projects) {
    if (!p || !p.valid || !p.id) continue
    try {
      const list = readProjectConfig(p.id)?.platforms?.default
      if (Array.isArray(list)) out.push(...list)
    } catch {
      /* 单个项目读失败不影响其它项目 */
    }
  }
  return out
}

/** 写**项目覆盖层**（`<localRoot>/project-state/<id>/config.json`） */
export function writeProjectConfigFile(projectId, patch) {
  return writeProjectConfig(projectId, patch)
}

/**
 * 分层感知的配置写入（v2.77）：`mutate(cfg)` 在**将被写的那一层**上就地修改。
 *
 * 为什么需要它：`readFullRuntimeConfig()` 现在返回**生效配置**（引擎 + 项目覆盖层），
 * 若调用方再把这个合并结果整体写回引擎文件，就会把项目设置泄漏成全局默认值——
 * 而且项目覆盖层里的旧值仍会盖住引擎文件，表现为"改了没反应"。所以凡是"读改写"项目级键
 * 的地方都必须走本函数，按当前上下文落到正确的那一层。
 *
 * @returns {{scope:'project'|'engine', project?:string, file?:string}}
 */
export function writeConfigScoped(mutate) {
  const projectId = currentProject()
  if (projectId) {
    const overlay = { ...readProjectConfig(projectId) }
    mutate(overlay)
    const r = writeProjectConfig(projectId, overlay)
    return { scope: 'project', project: projectId, file: r.file }
  }
  const cfg = readEngineConfigFile()
  mutate(cfg)
  writeConfigFile(cfg)
  return { scope: 'engine', file: configPath() }
}

/* ── 方法 → worker 分类表 ─────────────────────────────────────── */
/**
 * 费用/会话类：要解析 token 会话记录（实测 278 个 .jsonl / 301 条成本），
 * **不是"毫秒级纯读"** —— 实测 `listCosts` 0.9s（冷缓存 2.9s）、`prewarmCosts` **7.3s**，
 * 工作集 ~600MB。2026-09-21（v2.101）之前它们挂在 reader 上，代价是：
 *   · 启动预热 7.3s 期间，reader 串行队列被占 → 重启后**首次打 read 实测 8.6s**（对照：空闲 22ms）；
 *   · 打开报表时，并发的读请求 23ms → **2.34s**（同一条队列）。
 * 也不能放 heavy：10 分钟发布会把"报表/详情费用"排到 CLI 超时。故单开一条 `costs` 车道，
 * 顺带让三个成本方法的会话缓存**共享一份**（此前 reader/heavy 各建一份）。
 */
const COSTS_METHODS = new Set(['listCosts', 'articleCost', 'prewarmCosts'])
/** 纯读：不写文件、无网络、毫秒级（scanAndList 内含 ensureDraftRecord 原子写盘副作用，可接受） */
const READ_METHODS = new Set([
  'listArticles',
  'getArticle',
  'readDraft',
  'listStyles',
  'listCoverTemplates',
  'listPlatforms',
  'listArchive',
  'listRetained',
  'proxyStatus',
  'proxyTest',
  'checkAuth',
  // v2.50：doctor 只读（探桥 + 拉一次 MCP 握手 + 读文件），但耗时约 1s，
  // 且 Console 的「接入与自检」页每次打开都会调它 —— 放 reader 才不会被
  // 队列里正在跑的 10 分钟发布挡住。
  'doctor',
])
/** 短写：写文件/记录但秒级完成（低频操作，不与发布互斥） */
const WRITE_METHODS = new Set([
  'archiveArticle',
  'retainArticle',
  'retainedAction',
  'deleteDraft',
  'markPublished',
  'markAllPublished',
  'setArticleRisk',
  'setArticleStatus',
  'updateDraft',
  'styles',
])
/** 其余全部 → heavy：长任务/网络/CPU 密集 */
function routeMethod(method) {
  if (COSTS_METHODS.has(method)) return 'costs'
  if (READ_METHODS.has(method)) return 'reader'
  if (WRITE_METHODS.has(method)) return 'writer'
  return 'heavy'
}

/** 单个 worker 的状态容器 */
function createWorkerState() {
  return {
    proc: null, // child_process.ChildProcess
    seq: 0,
    pending: new Map(), // seq -> resolve
    buf: '',
    starting: null, // 进行中的 spawn Promise（防并发重复拉起）
    restarts: 0, // 连续异常退出次数（达上限 → 进入冷却，冷却结束自动重试）
    failedUntil: 0, // 冷却截止时间戳；> now 期间走冷启动 execFile 回退
    startedAt: 0, // 本代进程拉起时间（健康上报用）
    outputBytes: 0, // 本代累计 stdout+stderr 字节（健康上报用；spawn 不对它设限）
    stderr: { winStart: 0, winCount: 0, suppressed: 0 }, // stderr 转发限流窗口
  }
}
/** 连续退出上限：达到则进入**冷却**（不是永久降级）——保留"防重启风暴"的初衷，
 *  去掉"踩一次坑就永久残废到重启桥"的副作用（2026-09-21 v2.100）。 */
function maxRestarts() {
  return 5
}
/** 冷却时长：期间走冷启动回退（功能可用、代价是慢），到期自动再试一次 */
function failedCooldownMs() {
  return 60 * 1000
}
/** stderr 转发限流：每个 worker 每 10s 最多逐行转发 20 行，其余折叠成一行统计 */
const STDERR_WINDOW_MS = 10 * 1000
const STDERR_MAX_LINES_PER_WINDOW = 20
const workers = {
  reader: createWorkerState(),
  costs: createWorkerState(),
  writer: createWorkerState(),
  heavy: createWorkerState(),
}

/** 常驻 worker 的拉起参数（2026-09-21 v2.100：改用 spawn，**不设 maxBuffer**）。
 *  抽成函数是为了让回归测试注入同样的语义（tests/cli-worker-resilience.test.mjs），
 *  并让"这里为什么不是 execFile"有一个可被引用的落点（见文件头 §maxBuffer）。 */
export function workerSpawnOptions() {
  return { stdio: ['pipe', 'pipe', 'pipe'] }
}

/** 三个 worker 的健康快照（`/proxy/health` 暴露；Console 自检页展示）。
 *  `degraded` = 当前不在冷却期但也没有活进程，或正在冷却期 → 该 role 的请求都在付冷启动成本。 */
export function workersHealth() {
  const now = Date.now()
  const out = {}
  for (const role of Object.keys(workers)) {
    const w = workers[role]
    const alive = !!(w.proc && w.proc.exitCode === null)
    out[role] = {
      alive,
      pid: alive ? w.proc.pid : null,
      uptimeMs: alive && w.startedAt ? now - w.startedAt : 0,
      pending: w.pending.size,
      restarts: w.restarts,
      coolingDown: w.failedUntil > now,
      failedUntil: w.failedUntil > now ? w.failedUntil : null,
      outputBytes: w.outputBytes,
    }
  }
  return out
}

/** 启动指定 role 的常驻 cli.mjs --ipc 子进程（就绪 ping = listArchive）。
 *  2026-08-30：worker 崩溃后允许自动重启（带次数上限），而非永久回退冷启动 execFile。
 *  2026-09-21（v2.100）：① 拉起方式 execFile → spawn（execFile 的 maxBuffer 会按
 *  进程生命周期累计输出并 kill 子进程，把"常驻"变成了"限时生存"，见文件头）；
 *  ② "达上限即永久降级"改为"达上限进 60s 冷却，到期自动重试"；
 *  ③ 拉起/就绪/退出/冷却全部落 stderr；④ 转发子进程 stderr（限流），
 *     并只在**当前代际**上拒绝 pending（旧代际回调不再误伤新 worker 的在飞请求）。 */
function ensureWorker(role) {
  const w = workers[role]
  if (w.proc && w.proc.exitCode === null) return true
  if (w.starting) return w.starting // 并发请求共用同一次 spawn
  if (w.failedUntil) {
    if (Date.now() < w.failedUntil) return false // 冷却中 → 本请求走冷启动 execFile
    bridgeLog(`[cli worker:${role}] 冷却结束（此前连续退出 ${w.restarts} 次），重新拉起常驻 worker`)
    w.restarts = 0
    w.failedUntil = 0
  }
  w.starting = new Promise((resolve) => {
    const t0 = Date.now()
    const spec = workerSpawnOptions()
    const proc = spawn(process.execPath, [NATIVE_CLI, '--ipc'], spec)
    w.proc = proc
    w.startedAt = t0
    w.outputBytes = 0
    w.stderr = { winStart: Date.now(), winCount: 0, suppressed: 0 }
    let dead = false // 同一进程的 exit/error 只结算一次（spawn 下两者都可能触发）
    const exited = (detail) => {
      if (dead) return
      dead = true
      w.restarts += 1
      // 代际隔离：旧进程的退出回调不得拒绝/清空新 worker 的 pending
      if (w.proc === proc) {
        for (const [, p] of w.pending) p({ error: `cli worker[${role}] 退出: ${detail}` })
        w.pending.clear()
        w.proc = null
        w.starting = null
      }
      const cooled = w.restarts >= maxRestarts()
      if (cooled) w.failedUntil = Date.now() + failedCooldownMs()
      bridgeLog(
        `[cli worker:${role}] 退出 ${detail}（本代存活 ${Math.round((Date.now() - t0) / 1000)}s、` +
          `输出 ${(w.outputBytes / 1048576).toFixed(1)}MB、第 ${w.restarts} 次）` +
          (cooled
            ? ` → 进入 ${failedCooldownMs() / 1000}s 冷却，期间该 role 走冷启动回退（功能可用但慢）`
            : ' → 下次请求自动重新拉起'),
      )
    }
    proc.on('exit', (code, signal) => exited(`code=${code} signal=${signal || 'none'}`))
    proc.on('error', (e) => exited(`错误 ${String((e && e.message) || e)}`))
    // 子进程 stderr（cli.mjs 的 `[cli]` 前缀 + 崩溃栈）：限流转发到 bridge.err.log。
    // 此前**完全没有 stderr 监听**，worker 死了既无日志也无告警（本次事故只能靠推理定位）。
    proc.stderr.setEncoding('utf8')
    let errBuf = ''
    proc.stderr.on('data', (d) => {
      w.outputBytes += Buffer.byteLength(d)
      errBuf += d
      let nl
      while ((nl = errBuf.indexOf('\n')) !== -1) {
        const line = errBuf.slice(0, nl).trim()
        errBuf = errBuf.slice(nl + 1)
        if (!line) continue
        const now = Date.now()
        if (now - w.stderr.winStart >= STDERR_WINDOW_MS) {
          if (w.stderr.suppressed)
            bridgeLog(
              `[cli worker:${role}] （上一窗口另有 ${w.stderr.suppressed} 行 stderr 未逐行记录）`,
            )
          w.stderr = { winStart: now, winCount: 0, suppressed: 0 }
        }
        if (w.stderr.winCount < STDERR_MAX_LINES_PER_WINDOW) {
          w.stderr.winCount += 1
          bridgeLog(`[cli worker:${role}] ${line.slice(0, 300)}`)
        } else {
          w.stderr.suppressed += 1
        }
      }
    })
    proc.stdout.on('data', (d) => {
      w.outputBytes += d.length
      w.buf += d.toString()
      let nl
      while ((nl = w.buf.indexOf('\n')) !== -1) {
        const line = w.buf.slice(0, nl).trim()
        w.buf = w.buf.slice(nl + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        const p = w.pending.get(msg.seq)
        if (p) {
          w.pending.delete(msg.seq)
          p(msg)
        }
      }
    })
    const readySeq = w.seq++
    const ready = new Promise((r) => w.pending.set(readySeq, r))
    proc.stdin.write(JSON.stringify({ seq: readySeq, method: 'listArchive' }) + '\n')
    ready
      .then(() => {
        if (w.proc === proc) w.starting = null
        // 就绪前进程就死了（pending 被 exited 以 error 值 resolve）：本次回退冷启动，
        // **必须 settle**，否则 await ensureWorker 永不返回 → 该 role 所有请求挂死。
        if (dead) {
          resolve(false)
          return
        }
        // 注：ready 在 worker 返回任何响应（含 error 响应）时都算就绪——与改造前一致
        bridgeLog(`[cli worker:${role}] 就绪 pid=${proc.pid} 启动耗时 ${Date.now() - t0}ms`)
        resolve(true)
      })
      .catch(() => {
        if (w.proc === proc) {
          w.proc = null
          w.starting = null
        }
        if (w.restarts + 1 >= maxRestarts()) w.failedUntil = Date.now() + failedCooldownMs()
        resolve(false)
      })
  })
  return w.starting
}

/** 停掉全部常驻 worker（桥优雅退出 / 测试收尾）：让子进程立即结束，避免留孤儿。
 *  正常路径其实靠 cli.mjs 的 `stdin end → process.exit(0)` 自结束，但显式收更干净、也可测。 */
export function stopWorkers() {
  for (const role of Object.keys(workers)) {
    const w = workers[role]
    const proc = w.proc
    w.proc = null
    w.starting = null
    w.pending.clear()
    try {
      if (proc && proc.exitCode === null) proc.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

/** 桥启动时预热常驻 worker（2026-09-21 v2.100）。
 *  冷启动 1.2s 若由"用户第一次请求"承担，实测表现为**首屏 1690ms**（改前 1676ms 同量级）；
 *  提前在后台拉起后，用户第一次打开就已经是热的（实测首屏 353–397ms）。
 *  错峰 1.5s 拉起第二个，避免启动瞬间 3 个 node 一起抢 CPU。失败不影响功能（会走冷启动回退）。 */
export function prewarmWorkers() {
  const roles = Object.keys(workers)
  roles.forEach((role, i) => {
    const kick = () => {
      try {
        // ensureWorker 可能返回 true/false（布尔）或 Promise —— 统一兜住，不让预热异常影响桥
        Promise.resolve(ensureWorker(role)).catch((e) =>
          bridgeLog(
            `[cli worker:${role}] 预热失败（不影响功能，将按需冷启动）: ${String(e && e.message)}`,
          ),
        )
      } catch (e) {
        bridgeLog(`[cli worker:${role}] 预热异常: ${String(e && e.message)}`)
      }
    }
    if (i === 0) kick()
    // 2026-09-22（v2.103.1）：错峰 1500ms → 400ms。实测四个车道"全部就绪"时刻被错峰主导：
    // 1.5s 错峰下最后一个（heavy）要到 **+4637ms** 才就绪；400ms 后降到 ~+1.6s。
    // 每个车道自己 ~1.05s 的冷启动成本不变，只是不再串成"排队启动"。
    else setTimeout(kick, i * 400).unref?.()
  })
}

/** 通用 cli 调用（按方法路由到对应 worker；worker 不可用时回退 execFile 冷启动）
 *
 *  2026-09-19（v2.22）：若当前异步上下文带项目（HTTP 请求边界由 run-bridge 建立），
 *  自动补 `--project=<id>` 透传给 cli.mjs。**已在 args 里显式给出 project 时不覆盖**，
 *  允许单点调用方覆盖当前上下文（例如"给别的项目发文"）。
 *  无上下文时不追加任何参数 → 生产单项目路径逐字不变。
 */
export function runCli(args, timeoutMs = 300000) {
  const project = currentProject()
  const effectiveArgs =
    project && !args.some((a) => typeof a === 'string' && a.startsWith(PROJECT_FLAG))
      ? [...args, PROJECT_FLAG + project]
      : args
  const method = effectiveArgs[0] || ''
  const arg1 = effectiveArgs[1]
  const arg2 = effectiveArgs[2]
  const role = routeMethod(method)
  const w = workers[role]
  return new Promise((resolve, reject) => {
    // 同步 executor 内跑 async IIFE：async executor 会吞掉内部异常导致 Promise 永不 settle
    ;(async () => {
      if (await ensureWorker(role)) {
        const seq = w.seq++
        const timer =
          timeoutMs && timeoutMs > 0
            ? setTimeout(() => {
                if (w.pending.has(seq)) {
                  w.pending.delete(seq)
                  resolve({ error: `cli 超时(${timeoutMs}ms): ${method}` })
                }
              }, timeoutMs)
            : null
        w.pending.set(seq, (msg) => {
          if (timer) clearTimeout(timer)
          // 剥掉 IPC 内部 seq 字段，只返回业务结果
          const { seq: _s, ...out } = msg || {}
          resolve(out)
        })
        try {
          // args 全量传递（2026-08-28）：styles 子命令 / generateCover --out-dir 等 flag 依赖 argTail
          w.proc.stdin.write(
            JSON.stringify({ seq, method, arg1, arg2, args: effectiveArgs }) + '\n',
          )
        } catch (e) {
          if (timer) clearTimeout(timer)
          w.pending.delete(seq)
          resolve({ error: `cli worker[${role}] 写入失败: ` + String(e.message || e) })
        }
      } else {
        // 回退：冷启动单次执行
        execFile(
          process.execPath,
          [NATIVE_CLI, ...effectiveArgs],
          { timeout: timeoutMs },
          (err, stdout) => {
            try {
              resolve(JSON.parse(stdout))
            } catch (e) {
              resolve({
                error: 'cli 解析失败: ' + ((err && err.message) || e.message),
                raw: String(stdout).slice(0, 300),
              })
            }
          },
        )
      }
    })().catch(reject)
  })
}
