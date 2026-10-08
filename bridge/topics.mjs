/**
 * 选题库域（从 run-bridge.mjs 拆分，2026-08-24）
 * topic-pool.json 读写、一键生成任务（draft-only）、落选删除（仅 rejected，删除前备份）
 *
 * 2026-09-18（v2.01，引擎自治）两项改造：
 *
 * 1. **路径惰性解析**：原先 `const paths = loadPaths()` 在 import 期执行，桥一启动
 *    就把单一路径固化到进程整个生命周期。这既让配置变更无法生效，也使"多项目接入"
 *    在架构上不可能成立（所有项目共用同一份路径）。现改为每次调用重新解析。
 *
 * 2. **不再代跑接入方脚本**：原先 `startTopicGenerate` 直接 spawn
 *    `generateOnceScript`（指向仓库外某个写作项目的 shell 脚本）——引擎执行某个
 *    具体接入方的业务脚本，是边界越界最严重的一处。现改为**能力钩子**：
 *    引擎只做编排（并发保护、状态机、轮询），执行方由接入项目经
 *    `registerGenerateProvider()` 提供；未提供则返回结构化错误，绝不 spawn 外部脚本。
 *
 * ── 2026-10-01（v2.111）：单例任务 → **任务注册表 + FIFO 队列** ────────────────
 *
 * 原实现是模块级单例 `topicGenTask`，同一时刻只允许一个任务，第二次点击直接
 * 「已有生成任务在运行，请等待完成」。这条限制在 Console 上表现为：连点几条选题，
 * 只有第一条真的跑，其余全部被拒；而界面只有**一条全局状态条**，被拒的那几条连
 * "为什么没动"都看不出来。
 *
 * 现在改成队列 + 调度器：
 *   · 每次入队产出一个自带 id 的任务，状态机 `queued → running → done|failed|canceled`；
 *   · 调度器按 `maxConcurrency`（**默认 1**，见 MAX_CONCURRENCY 注释）取队首开跑；
 *   · 每条任务独立跟踪 draftId / logTail / error，Console 逐行渲染，不再互相覆盖。
 *
 * **并发默认仍是 1**：引擎侧只放开了结构，真并行还需要项目侧同时放开两处
 * ——`generate_once.sh` 的 `/tmp/ai2writing-gen.lock` 全局锁，以及
 * provider 的 `GENERATE_CONCURRENCY`。在项目侧没放开之前把默认并发调大，
 * 结果只是让第 2 条起全部撞上项目侧的锁（`[SKIP] … 本轮跳过`，exit 2）。
 * 放开步骤见 `docs/writing-pipelines.md`「把并发调大之前必须先做的事」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getArticlesDir, getDraftsDir, parseDraftFile } from '../crosspost-runtime/src/articles.mjs'
import { pushHumanFeedback } from '../crosspost-runtime/src/editorial-memory.mjs'
import { getTopicPoolFile, getHistoryDir, getLogsDir } from '../crosspost-runtime/src/resources.mjs'
import { lockDirFor, withPoolLock, writePoolFile } from '../crosspost-runtime/src/topic-pool.mjs'
import { currentProject, withProject } from '../crosspost-runtime/src/project-context.mjs'
import { sendNotify } from '../crosspost-runtime/src/notify.mjs'
import {
  resolveGenerateProvider,
  callGenerateProvider,
  probeEndpoint,
} from '../crosspost-runtime/src/generate.mjs'

/** 懒解析：每次属性读取都反映当前 paths.json/env（见文件头第 1 点） */

/**
 * 栏目**显示顺序**（内建栏目按这个序；项目自定义的栏目排在其后，按名字）。
 *
 * 这里只决定"先后"，不决定"有没有"——栏目 id 由项目声明，引擎不设白名单
 * （校验形状请用 `normalizeSlotId()`）。
 */
const SLOT_ORDER = ['morning', 'hotspot', 'noon', 'hotspot2', 'tips', 'evening']

/** 同一天之内，这个栏目排在第几（未知栏目排在已知栏目之后，而不是用 -1 抢到最前） */
const slotRank = (slot) => {
  const i = SLOT_ORDER.indexOf(slot)
  return i >= 0 ? i : SLOT_ORDER.length
}
// 排序状态优先级：同一天内 未生成(adopted)/已生成(generated) 优先，落选(rejected) 沉底
// 源码：https://github.com/dos2un1x/crosspost（作者 dos2un1x）
const TOPIC_STATUS_ORDER = ['generated', 'adopted', 'rejected']

/* ── 生成任务注册表（v2.111）────────────────────────────────────────────── */

/** 并发上限的夹取范围。上限 5 是**成本护栏**：一条任务 = 一次完整 dsh 会话。 */
const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 5
/** 默认并发：1（串行）。真并行需要项目侧先放开锁，见文件头说明。 */
const DEFAULT_CONCURRENCY = 1
/** 队列容量（含 running）。超出直接拒，不无限堆积。 */
const DEFAULT_QUEUE_MAX = 50
const QUEUE_MAX_CAP = 200
/** 终态任务保留条数（供 Console 回看最近结果）；活动任务永不被回收。 */
const KEEP_FINISHED = 50

/** 任务表：id → task（活动 + 最近终态） */
const tasks = new Map()
/** FIFO 队列：仅存 task id，真正的状态在 tasks 里 */
let queue = []
let seq = 0

const isActive = (t) => !!t && (t.state === 'queued' || t.state === 'running')

/** 任务 id：时间序 + 序号，便于日志文件名排序与人工排查 */
function nextTaskId() {
  seq += 1
  return `${Date.now().toString(36)}-${seq.toString(36)}`
}

/** 安全读一个整数配置项（读不到/非法 → dflt；夹取到 [min,max]） */
function clampInt(getter, dflt, min, max) {
  try {
    const v = getter()
    if (!Number.isFinite(v)) return dflt
    return Math.min(Math.max(Math.trunc(v), min), max)
  } catch {
    return dflt
  }
}

/** config.json 读取（注入式；未注入时按"没有配置"处理） */
let _readConfig = null
function readConfigSafe() {
  if (!_readConfig) return null
  try {
    return _readConfig()
  } catch {
    return null
  }
}

/**
 * 生效的并发上限。优先级：
 *   ① 环境变量 `CROSSPOST_TOPIC_GEN_MAX_CONCURRENCY`（逃生阀，测试与临时调参用）
 *   ② 引擎 config.json 的 `topicsGenerateMaxConcurrency`
 *   ③ 默认 1
 * 非法值回落到默认值而不是报错（改配置不该把功能改坏）。
 */
export function getMaxConcurrency() {
  const raw = process.env.CROSSPOST_TOPIC_GEN_MAX_CONCURRENCY
  if (raw !== undefined && raw !== '') {
    return clampInt(() => Number(raw), DEFAULT_CONCURRENCY, MIN_CONCURRENCY, MAX_CONCURRENCY)
  }
  return clampInt(
    () => (readConfigSafe() || {}).topicsGenerateMaxConcurrency,
    DEFAULT_CONCURRENCY,
    MIN_CONCURRENCY,
    MAX_CONCURRENCY,
  )
}

/** 队列容量：config 可调，夹取到 [1, 200] */
function getQueueMax() {
  return clampInt(
    () => (readConfigSafe() || {}).topicsGenerateQueueMax,
    DEFAULT_QUEUE_MAX,
    1,
    QUEUE_MAX_CAP,
  )
}

/**
 * 注入 config 读取器（bridge 启动时调一次）。
 *
 * 为什么要注入而不是直接 import：`config-cache.mjs` 会读路径与项目上下文，
 * 而本模块被 bridge 与测试双双 import；注入让测试可以完全控制配置来源，
 * 且避免"import 期就固化了某个路径"这类历史缺陷（见文件头第 1 点）。
 */
export function setConfigReader(fn) {
  _readConfig = typeof fn === 'function' ? fn : null
}

/** 当前活动任务数（queued + running） */
function activeCount() {
  let n = 0
  for (const t of tasks.values()) if (isActive(t)) n += 1
  return n
}

function runningCount() {
  let n = 0
  for (const t of tasks.values()) if (t.state === 'running') n += 1
  return n
}

/** 队列中的位次（1-based）；不在队列返回 0 */
function queuePositionOf(id) {
  const i = queue.indexOf(id)
  return i >= 0 ? i + 1 : 0
}

/** 终态任务回收：只保留最近 KEEP_FINISHED 条，活动任务永不回收 */
function pruneFinished() {
  const finished = [...tasks.values()].filter((t) => !isActive(t))
  if (finished.length <= KEEP_FINISHED) return
  finished
    .sort((a, b) => Date.parse(a.finishedAt || 0) - Date.parse(b.finishedAt || 0))
    .slice(0, finished.length - KEEP_FINISHED)
    .forEach((t) => tasks.delete(t.id))
}

/** 把任务收敛为终态（幂等：已有终态不改写，避免 canceled 被后到的 done 覆盖） */
function settle(task, state, { error = null, errorCode = null } = {}) {
  if (!task || !isActive(task)) return false
  task.state = state
  task.finishedAt = new Date().toISOString()
  if (state === 'done') {
    task.exitCode = 0
  } else {
    task.exitCode = task.exitCode ?? 1
    if (error) task.error = String(error)
    if (errorCode) task.errorCode = String(errorCode)
  }
  queue = queue.filter((id) => id !== task.id)
  pruneFinished()
  // 终态通知（成功/失败）放在**这里**而不是各调用方：settle 是唯一的终态收敛点，
  // 放外面就得在 done/failed 两处（未来还会更多）各写一遍，早晚漏一处。
  // 取消不发：那是用户自己刚点的，他此刻就盯着 Console（见 notifyTaskSettled 注释）。
  if (state !== 'canceled') notifyTaskSettled(task)
  return true
}

/** 任务 → 对外结构（只吐叶子字段，绝不放 provider 内部对象） */
function publicTask(t) {
  return {
    id: t.id,
    slot: t.slot,
    keyword: t.keyword,
    topicId: t.topicId || null,
    date: t.date || null,
    state: t.state,
    queuePosition: t.state === 'queued' ? queuePositionOf(t.id) : 0,
    startedAt: t.startedAt || null,
    enqueuedAt: t.enqueuedAt || null,
    finishedAt: t.finishedAt || null,
    exitCode: t.exitCode ?? null,
    draftId: t.draftId || null,
    providerTaskId: t.providerTaskId || null,
    logFile: t.logFile || null,
    logTail: t.logTail || '',
    error: t.error || null,
    errorCode: t.errorCode || null,
    // 通知投递结果（终态后异步落定；null = 还没落定或没发）——见 notifyTaskSettled
    notify: t.notify || null,
    // 回填告警（如"命中多条无法确定写哪条"）：逐条任务视图也要带上，
    // 否则"宁可少写也不写错"这件事在界面上完全不可见——用户只会看到没回填。
    warning: t.warning || null,
    via: t.via || null,
    // providerKind 与 via 同义，保留旧名字：既有消费方（generate-provider.test.mjs
    // 的桥接用例）读的是 `task.providerKind`，改结构不该把它们打断。
    providerKind: t.via || null,
    provider: t.provider || null,
  }
}

/* ── 终态通知（2026-10-07）────────────────────────────────────────────────
 * 为什么需要：一键生成是**无人值守**的入口——点完「一键生成（全部未生成）」人就离开
 * Console 了，而生成结果此前只落在页面上（关掉标签就没了）；失败更只是行内一行小字，
 * 没人会一直盯着。所以终态必须能主动推到飞书（渠道/开关复用项目级 `notify` 配置）。
 *
 * 三个刻意的决定：
 *
 * 1. **必须 `withProject(task.projectId)`**：任务队列是**全局**的（跨项目一份），而
 *    `notify` 是**项目级**配置（每条流水线发到自己的群）。任务真正跑完时，当初那个请求的
 *    上下文早已结束；不显式切回项目，通知就会发到"当时恰好是谁的上下文"，无上下文时
 *    退化成引擎默认那份——正是 v2.77 分层要消除的串项目缺陷。项目 id 在**入队时**记下
 *    （那一刻的上下文一定是发起项目），而不是发通知时现取。
 *
 * 2. **不 await**：`settle()` 是同步的，通知是 fire-and-forget。让队列等一次外部渠道
 *    往返（lark-cli 最长 30s、webhook 走 fetchRetry）意味着"飞书挂了就拖慢出稿"，
 *    而并发默认是 1，一条卡住会顶住后面所有任务。**别"顺手"改成 await**：代价不是
 *    通知变慢，是出稿变慢。
 *
 * 3. **取消不发**：那是用户自己刚点的按钮，他此刻就在 Console 前面。真正需要通知的是
 *    "我走开了之后它自己跑完了/挂了"。
 */
const NOTIFY_TAIL_MAX = 400

/** 任务耗时（毫秒）；时间戳缺失返回 null */
function taskElapsedMs(task) {
  const from = Date.parse(task.startedAt || task.enqueuedAt || '')
  const to = Date.parse(task.finishedAt || '') || Date.now()
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return Math.max(0, to - from)
}

/** 耗时文案：`2 分 13 秒` / `45 秒` */
function elapsedText(task) {
  const ms = taskElapsedMs(task)
  if (ms === null) return '未知'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分`
}

/**
 * 读生成出来的草稿（best-effort）。
 * 提供者只保证回报 draftId，标题要去草稿文件里读；**读不到就只报 id**——
 * 通知的内容完整性不该成为"通知发不发得出去"的前提。
 */
function lookupDraftInfo(task) {
  if (!task || !task.draftId) return null
  try {
    const file = path.join(getDraftsDir(task.projectId || undefined), `${task.draftId}.md`)
    if (!fs.existsSync(file)) return null
    return { title: parseDraftFile(file).title || '' }
  } catch {
    return null
  }
}

/** 终态通知的文案（成功/失败各一份；纯函数，便于单测直接断言） */
export function buildTopicNotifyPayload(task, draft = null) {
  const kw = task.keyword || '(无关键词)'
  const head = `📌 栏目=${task.slot || '?'} · 选题=「${kw}」`
  const keyBase = `crosspost-topicgen-${task.id}`

  if (task.state === 'done') {
    const title = draft && draft.title ? `（《${draft.title}》）` : ''
    return {
      idempotencyKeyBase: keyBase,
      title: `选题已生成草稿：${kw}`,
      summary: [
        head,
        `${task.draftId ? `草稿=${task.draftId}` : '草稿=（提供者未回报 draftId）'}${title}`,
        `用时=${elapsedText(task)} · 任务=${task.id}`,
      ].join('\n'),
      links: [],
      footer: 'CrossPost Console「一键生成」· **恒草稿、不自动发布**：审稿后在 Console 手动发布。',
    }
  }

  const why = String(task.error || task.errorCode || '生成失败').slice(0, 300)
  const tail = task.logTail ? String(task.logTail).slice(0, NOTIFY_TAIL_MAX) : ''
  return {
    idempotencyKeyBase: keyBase,
    title: `选题生成失败：${kw}`,
    summary: [
      head,
      `失败原因=${why}`,
      `状态=${task.state}${task.errorCode ? `（${task.errorCode}）` : ''} · 任务=${task.id}`,
      task.logFile ? `日志=${task.logFile}` : null,
      tail ? `日志尾部：\n${tail}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    links: [],
    footer: 'CrossPost Console「一键生成」· 修好后可在选题库那一行点「重试」。',
  }
}

/**
 * 发终态通知（不抛、不 await；结果写回 `task.notify` 供状态接口与 Console 读）。
 * 发送失败绝不影响任务状态——通知是旁路，不是任务的一部分。
 */
function notifyTaskSettled(task) {
  if (!task || typeof sendNotify !== 'function') return
  Promise.resolve()
    .then(() =>
      withProject(task.projectId || '', async () => {
        const draft = lookupDraftInfo(task)
        return await sendNotify(buildTopicNotifyPayload(task, draft))
      }),
    )
    .then((r) => {
      task.notify = r || null
      console.error(`[topics] 终态通知 ${task.state} ${task.id}: ${(r && r.status) || 'unknown'}`)
    })
    .catch((e) => {
      task.notify = { status: 'fail', error: String((e && e.message) || e).slice(0, 300) }
      console.error(`[topics] 终态通知失败 ${task.id}: ${task.notify.error}`)
    })
}

/* ── 生成能力解析（v2.01 钩子；v2.51 增加跨进程 http 提供者）──────────────
 * 引擎不内建生成能力，三层来源按优先级解析（详见 src/generate.mjs 文件头）：
 *   ① 进程内钩子 `registerGenerateProvider()`（内嵌场景，同进程）
 *   ② 当前项目 manifest 的 `capabilities.generate = {kind:"http",url:"…"}`（跨进程）
 *   ③ 无项目上下文时，引擎配置 `generate.provider`
 * ②③ 之间**没有回退**：选中了项目就以那个项目的 manifest 为准，它没声明就是
 * "没有"——否则会复现 v2.33 修掉的那类"界面写 A、实际是 B"的缺陷。 */
let generateProvider = null

/** 注册生成能力提供者（内嵌场景调用）。传 null 可注销。返回注销函数。 */
export function registerGenerateProvider(fn) {
  generateProvider = typeof fn === 'function' ? fn : null
  return () => {
    generateProvider = null
  }
}

/**
 * 解析**当前请求上下文**的生成能力（含进程内钩子层）。
 * @returns {{provided:boolean, kind?:string, source?:string, url?:string, reason?:string, code?:string}}
 */
export function resolveGenerate() {
  if (typeof generateProvider === 'function')
    return { provided: true, kind: 'inprocess', source: '引擎进程内已注册的 provider' }
  return resolveGenerateProvider(currentProject())
}

/** 当前是否具备生成能力（Console/doctor 据此决定是否渲染入口） */
export function hasGenerateProvider() {
  return resolveGenerate().provided
}

/** 读选题库（topic-pool.json），文件缺失/损坏返回空列表 */
export function readTopicPool() {
  try {
    // v2.76：选题库按项目解析（项目上下文 → <内容工作区>/history/topic-pool.json）
    const d = JSON.parse(fs.readFileSync(getTopicPoolFile(), 'utf8'))
    return Array.isArray(d.topics) ? d.topics : []
  } catch {
    return []
  }
}

/** 选题库写锁目录（与选题库同目录；实现见 topic-pool.mjs 的 lockDirFor） */
function poolLockDir() {
  return lockDirFor(getTopicPoolFile())
}

/**
 * 原子写选题库（tmp+rename，写完回读校验）。
 *
 * 实现已收拢到 `crosspost-runtime/src/topic-pool.mjs`——**选题库只有一个写实现**：
 * 行形状校验、合并规则、写锁、原子写都在那里，项目侧写入器（`cli.mjs topicPoolUpsert`）
 * 转发到同一个模块。此前这里与项目侧脚本各写一份，契约靠人记。
 */
export function writeTopicPool(topics) {
  return writePoolFile(getTopicPoolFile(), topics)
}

/**
 * 读文章库，构建 id -> {title,status} 映射供关联展示。
 * 仅解析被选题池引用的 articleId 子集，避免每次 /proxy/topics 全库 readdir+read+parse。
 */
export function loadArticleMeta() {
  // 2026-09-18（v2.01）：改从 articles.mjs 取文章库位置，与 CROSSPOST_ARTICLES_DIR
  // 一致。此前用 paths.workspace 反推，会忽略该环境变量（沙箱隔离下读到真实文章库）。
  const ARTICLES_DIR = getArticlesDir()
  const out = new Map()
  if (!fs.existsSync(ARTICLES_DIR)) return out
  const pool = readTopicPool()
  const wanted = new Set(pool.map((t) => t.articleId).filter(Boolean))
  if (!wanted.size) return out
  for (const id of wanted) {
    const p = path.join(ARTICLES_DIR, `${id}.json`)
    if (!fs.existsSync(p)) continue
    try {
      const a = JSON.parse(fs.readFileSync(p, 'utf8'))
      out.set(a.id, { title: a.title, status: a.status })
    } catch {
      /* skip */
    }
  }
  return out
}

/** 合并选题库 + 文章元信息 → 面板列表（日期新→旧 → 状态优先级 → 栏目 → rank） */
export function listTopics() {
  const pool = readTopicPool()
  const arts = loadArticleMeta()
  const out = pool.map((t) => ({
    ...t,
    articleTitle: t.articleId ? arts.get(t.articleId)?.title || '' : '',
    articleStatus: t.articleId ? arts.get(t.articleId)?.status || '' : '',
  }))
  out.sort(
    (a, b) =>
      (b.date || '').localeCompare(a.date || '') ||
      TOPIC_STATUS_ORDER.indexOf(a.status) - TOPIC_STATUS_ORDER.indexOf(b.status) ||
      slotRank(a.slot) - slotRank(b.slot) ||
      (a.rank ?? 99) - (b.rank ?? 99),
  )
  return out
}

/** 删除落选选题（仅 status=rejected；删除前自动备份；generated/adopted 拒绝）。authorized 校验在路由层 */
export function deleteTopic(id) {
  const topics = readTopicPool()
  const target = topics.find((t) => t.id === id)
  if (!target) return { error: `选题不存在: ${id}` }
  if (target.status !== 'rejected') {
    return {
      error: `仅允许删除落选(rejected)选题，当前状态=${target.status}（generated/adopted 不可删）`,
    }
  }
  // 删除前自动备份整个选题库（防误删，与文章库每日备份同思路；本地时区时间戳）
  try {
    const bakDir = path.join(getHistoryDir(), 'backups') // v2.76：项目级
    fs.mkdirSync(bakDir, { recursive: true })
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    fs.copyFileSync(getTopicPoolFile(), path.join(bakDir, `topic-pool-${stamp}.json`))
  } catch {
    /* 备份失败不阻塞删除（记录在返回里） */
  }
  const remaining = topics.filter((t) => t.id !== id)
  writeTopicPool(remaining)
  // 编辑记忆：人工删除落选选题 = 负反馈（2026-08-25 B-1；失败不阻塞删除）
  try {
    pushHumanFeedback('topic-delete', { id, keyword: target.keyword, reason: target.reason })
  } catch {
    /* 记忆写入失败不阻塞 */
  }
  return { ok: true, deleted: target, remaining: remaining.length }
}

/**
 * 启动一键生成任务（v2.01 能力钩子；v2.111 改为**入队**）
 *
 * 语义变化：本函数现在**只入队**并立刻返回任务 id，真正的执行由调度器
 * `pumpQueue()` 在有空位时驱动。这样"点了没反应"不再依赖一次阻塞的 POST：
 * Console 拿到 id 就能显示「排队中（第 N 位）」，随后由状态接口把进度喂回来。
 *
 * 返回值：
 *   · `{ ok:true, task:{id,state:'queued'|'running',...}, position }` 入队成功
 *   · `{ error:'already_queued', ... }` 同一 (slot,keyword) 已在队列/运行中
 *   · `{ error:'queue_full', ... }` 队列已满
 *   · `{ error:'generate_not_provided', ... }` 能力缺项（Console 据此隐藏入口）
 *
 * @param {string} slot 栏目 id
 * @param {string} keyword 选题关键词
 * @param {{topicId?:string, date?:string}} [meta] 选题标识（用于精确回填，可缺省）
 */
export function startTopicGenerate(slot, keyword, meta = {}) {
  const gen = resolveGenerate()
  if (!gen.provided) {
    // 能力缺项：明确告知，而非静默失败或越界代跑（Console 据此隐藏入口）
    return {
      error: 'generate_not_provided',
      message:
        '当前接入项目未提供「一键生成」能力（引擎不再代跑外部脚本）。' +
        `原因：${gen.reason || '未声明'}。` +
        '项目侧可在 manifest 里声明 HTTP 端点：' +
        '"capabilities": { "generate": { "kind": "http", "url": "http://127.0.0.1:<port>/generate" } }，' +
        '详见 docs/integration.md。',
      capability: 'generate',
      provided: false,
      code: gen.code || null,
      reason: gen.reason || null,
    }
  }

  const kw = String(keyword ?? '').trim()
  const sl = String(slot ?? '').trim()

  // 去重：同一 (slot,keyword) 已在队列或运行中时不再入队（重复点按钮是个常见误操作，
  // 而"开两条一模一样的任务"既烧 token 又会让选题库回填出现两条同 keyword 的记录）
  const dup = [...tasks.values()].find((t) => isActive(t) && t.slot === sl && t.keyword === kw)
  if (dup) {
    return {
      error: 'already_queued',
      message: `该选题已在队列中（${dup.state === 'running' ? '生成中' : `排队第 ${queuePositionOf(dup.id)} 位`}）`,
      task: publicTask(dup),
    }
  }

  // 队列容量：超出直接拒，不无限堆积（每一条都是一次完整 dsh 会话，费用是真的）
  const queueMax = getQueueMax()
  if (activeCount() >= queueMax) {
    return {
      error: 'queue_full',
      message: `生成队列已满（${activeCount()}/${queueMax}），请等待现有任务结束`,
      queueMax,
    }
  }

  // 本地时区日期（沿用历史日志命名 date +%Y-%m-%d）
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const localDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

  const id = nextTaskId()
  // 日志文件名带任务短码：同一 (slot,date) 并发跑两次时不再互相覆盖
  const logFile = path.join(getLogsDir(), `run-${sl}-${localDate}-manual-${id}.log`)

  const task = {
    id,
    pid: null,
    slot: sl,
    keyword: kw,
    topicId: meta.topicId ? String(meta.topicId) : null,
    date: meta.date ? String(meta.date) : localDate,
    // 发起项目：此刻的上下文**一定**是发起方，而任务跑完可能已经不在那个上下文里了
    // （队列全局共享、并发调度会由别的请求触发）。终态通知必须按它切回项目，
    // 否则 `notify` 这个项目级配置会解析成别家/引擎默认（见 notifyTaskSettled）。
    projectId: currentProject() || null,
    state: 'queued',
    enqueuedAt: now.toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    logFile,
    draftId: null,
    logTail: '',
    hook: true,
    via: gen.kind,
    provider: {
      kind: gen.kind,
      source: gen.source || null,
      url: gen.url || null,
      projectId: gen.projectId ?? null,
    },
    error: null,
    errorCode: null,
  }
  tasks.set(id, task)
  queue.push(id)

  // 立刻尝试开跑：并发默认 1 时，第一条会直接进入 running（与旧行为逐字一致）
  pumpQueue()

  return {
    ok: true,
    task: publicTask(tasks.get(id)),
    position: queuePositionOf(id),
    maxConcurrency: getMaxConcurrency(),
  }
}

/**
 * 调度器：有空位就取队首开跑。
 *
 * 刻意做成"每次入队/每次结束都调一次"的同步函数，而不是常驻定时器——
 * 常驻定时器会在桥退出时留下句柄，也让"为什么它没跑"更难排查。
 */
function pumpQueue() {
  const max = getMaxConcurrency()
  while (runningCount() < max && queue.length) {
    const id = queue[0]
    const task = tasks.get(id)
    if (!task || task.state !== 'queued') {
      queue.shift()
      continue
    }
    queue.shift()
    task.state = 'running'
    task.startedAt = new Date().toISOString()
    runTask(task).catch(() => {
      /* runTask 内部已收敛状态；这里只防止未处理的 rejection */
    })
  }
}

/** 执行一条任务（http 提供者走轮询；进程内钩子直接调用） */
async function runTask(task) {
  const gen = resolveGenerate()
  if (!gen.provided) {
    settle(task, 'failed', {
      error: gen.reason || '生成能力在当前项目上下文里不可用',
      errorCode: 'generate_not_provided',
    })
    pumpQueue()
    return
  }

  const onProgress = (p) => applyProviderProgress(task, p)
  const runProvider =
    gen.kind === 'http'
      ? () =>
          callGenerateProvider(gen, {
            slot: task.slot,
            keyword: task.keyword,
            projectId: gen.projectId,
            onProgress,
            // 并发 > 1 时端点可能回 409 busy（项目侧的并发上限更小）；
            // 并发 1 时不该出现——真出现了说明项目侧有别的来源在跑，如实上报更有用。
            allowBusyRetry: getMaxConcurrency() > 1,
          })
      : () => generateProvider(task.slot, task.keyword)

  let out
  try {
    out = await runProvider()
  } catch (e) {
    settle(task, 'failed', { error: (e && e.message) || String(e), errorCode: 'provider_threw' })
    pumpQueue()
    return
  }

  const r = out && typeof out === 'object' ? out : {}
  if (r.error) {
    // v2.51：把**人话**留给 Console。此前只存 `r.error`（一个错误码），
    // 用户看到的就是 `generate_provider_timeout` 这种裸码——正是 v2.42 修过
    // 的那类"只显示错误码"的毛病。
    settle(task, 'failed', {
      error: String(r.message || r.error),
      errorCode: String(r.error),
    })
  } else {
    // draftId 与 taskId 是两件事（v2.54 修）：
    //   · http 提供者：taskId 是**它自己的任务号**，draftId 才是生成的草稿 id；
    //     它没报 draftId 时**绝不**用 taskId 顶替——否则选题库会写入一个
    //     不存在的 articleId，Console 的「查看《…》」链接必然 404。
    //   · 进程内旧钩子：契约里 taskId 本来就是草稿 id，保持原语义。
    if (r.draftId) task.draftId = String(r.draftId)
    else if (r.taskId && gen.kind !== 'http') task.draftId = String(r.taskId)
    if (r.taskId) task.providerTaskId = String(r.taskId)
    if (r.logFile) task.logFile = String(r.logFile)
    if (r.logTail) task.logTail = String(r.logTail).split('\n').slice(-6).join('\n')
    // 顺序要紧（v2.111）：**先回填、后置终态**。
    // 反过来会出现一个很短但真实的窗口——任务已经是 done、而选题库那一条还是
    // 「未生成」。Console 正是在这个窗口里读池子的（轮询看到 done 就刷新列表），
    // 于是用户会看到"生成完了，但列表里还写着未生成"，直到下次手动刷新。
    // 先回填再 settle 之后，`done` 才是"连选题库都写完了"的可信信号。
    backfillGeneratedTopic(task)
    settle(task, 'done')
  }
  pumpQueue()
}

/**
 * 把提供者上报的进度同步进任务（供 Console 轮询显示）。
 *
 * v2.51：异步 http 任务可能跑几十分钟，期间 Console 只能靠状态接口看到进度。
 * 没有这个回填，界面上就是一串"运行中"直到某刻突然结束——用户无法判断它是慢还是卡死。
 */
function applyProviderProgress(task, p) {
  if (!task || task.state !== 'running') return
  if (p.draftId) task.draftId = String(p.draftId)
  if (p.taskId) task.providerTaskId = String(p.taskId)
  if (p.logFile) task.logFile = String(p.logFile)
  if (typeof p.logTail === 'string' && p.logTail)
    task.logTail = p.logTail.split('\n').slice(-6).join('\n')
}

/**
 * 取消任务：排队中的直接出队；运行中的标记为 canceled 并停止跟踪。
 *
 * **不 kill 项目侧进程**：引擎与项目侧是两个进程，引擎能做的只是"不再跟踪"。
 * 如实说明这一点，比假装取消成功要好——项目侧那次生成仍会把草稿落盘。
 */
export function cancelTopicGenerate(id) {
  const task = tasks.get(String(id || ''))
  if (!task) return { error: `任务不存在: ${id}` }
  if (!isActive(task)) {
    return { error: `任务已结束（${task.state}），无法取消`, task: publicTask(task) }
  }
  const wasRunning = task.state === 'running'
  settle(task, 'canceled', {
    error: wasRunning
      ? '已取消跟踪（项目侧的那次生成可能仍在跑完并落盘草稿）'
      : '已从队列移除（未开始执行）',
    errorCode: 'canceled',
  })
  pumpQueue()
  return { ok: true, wasRunning, task: publicTask(tasks.get(task.id)) }
}

/**
 * 生成成功后回填选题库 articleId + status（失败不阻塞）。
 *
 * v2.111：整个读—改—写包在选题库锁里（见 withPoolLock 注释），并按**更精确的键**匹配：
 *   ① 有 topicId 就按 id 匹配（最准，且是唯一能区分同 keyword 多条的键）；
 *   ② 否则退回 (slot, keyword) 且只认"尚未 generated"的那条；
 *   ③ 命中多条 → **不写**，把歧义记进任务告警字段（宁可少写一次，也不要写错一条）。
 */
function backfillGeneratedTopic(task) {
  if (!task || !task.draftId) return
  try {
    const out = withPoolLock(poolLockDir(), ({ locked }) => {
      const topics = readTopicPool()
      let target = null
      let ambiguous = false

      if (task.topicId) {
        target = topics.find((t) => t.id === task.topicId) || null
      }
      if (!target) {
        const hits = topics.filter(
          (t) => t.slot === task.slot && t.keyword === task.keyword && t.status !== 'generated',
        )
        if (hits.length > 1) ambiguous = true
        else if (hits.length === 1) target = hits[0]
      }

      if (ambiguous) return { written: false, ambiguous: true, locked }
      if (!target) return { written: false, ambiguous: false, locked }

      target.status = 'generated'
      target.articleId = task.draftId
      target.reason = 'Console 一键生成'
      writeTopicPool(topics)
      return { written: true, ambiguous: false, locked }
    })
    if (out && out.ambiguous) {
      task.warning = `选题库回填跳过：(${task.slot}/${task.keyword}) 命中多条未生成记录，无法确定该写哪条`
    }
    if (out && out.written === false && !(out && out.ambiguous)) {
      // 没命中任何记录不是错误：项目侧的生成脚本通常自己已经 upsert 过选题库
      task.backfill = 'skipped'
    } else if (out && out.written) {
      task.backfill = 'written'
    }
    if (out && !out.locked) task.backfillLocked = false
  } catch {
    /* 回填失败不阻塞 */
  }
}

/**
 * 当前"代表任务"：优先正在跑的，其次刚排上队的，其次最近一条。
 *
 * 为什么要单独算：v2.111 之前"当前任务"就是一个模块级单例 `topicGenTask`，
 * 任务结束后仍指着它、而队首可能已经换了人。status 的旧字段（slot/keyword/draftId/error…）
 * 都从这里填充，所以必须给出与 `state` 一致的那一条——否则会出现
 * "state=queued 但 slot 还是上一条"这种自相矛盾的应答。
 */
function representativeTask(running, queued) {
  if (running > 0) {
    const r = [...tasks.values()]
      .filter((t) => t.state === 'running')
      .sort((a, b) => Date.parse(a.startedAt || 0) - Date.parse(b.startedAt || 0))
    if (r.length) return r[0]
  }
  if (queued > 0) {
    const q = queue.map((id) => tasks.get(id)).filter(Boolean)
    if (q.length) return q[0]
  }
  const finished = [...tasks.values()]
    .filter((t) => !isActive(t))
    .sort((a, b) => Date.parse(b.finishedAt || 0) - Date.parse(a.finishedAt || 0))
  return finished[0] || null
}

/**
 * 聚合状态（兼容旧字段）：Console/doctor 仍在读 `state` 回答"现在有没有在跑"。
 * 新增 `queued`/`tasks`，但**不删除**任何旧字段——外部消费方（doctor 的能力探测、
 * 既有冒烟脚本）依赖它们。
 */
export function getTopicGenStatus() {
  const gen = resolveGenerate()
  const provider = gen.provided
    ? {
        kind: gen.kind,
        source: gen.source || null,
        url: gen.url || null,
        projectId: gen.projectId ?? null,
      }
    : null
  const unavailable = gen.provided ? null : { code: gen.code || null, reason: gen.reason || null }

  const max = getMaxConcurrency()
  const running = runningCount()
  const queued = queue.length
  const queuedTasks = queue.map((id) => tasks.get(id)).filter(Boolean)

  if (!tasks.size) {
    return {
      state: 'idle',
      provided: gen.provided,
      provider,
      unavailable,
      running: 0,
      queued: 0,
      maxConcurrency: max,
      // queueMax 在"有任务"与"没任务"两条分支里都要在：否则首屏（还没跑过任何任务）
      // 读不到它，消费方得在两个形状之间分支——接口形状不该随"今天有没有跑过"变化。
      queueMax: getQueueMax(),
      tasks: [],
    }
  }

  const current = representativeTask(running, queued)
  // state 语义保持不变：有跑着的就是 running，否则有排队的算 queued，
  // 都没有时回**当前这条**的终态（旧实现回单例的 state，即 done 或 failed）——
  // 把 failed 说成 done 会让"最后一条失败了"在界面上消失。
  const state = current ? current.state : 'idle'

  const base = {
    state,
    provided: gen.provided,
    provider: (current && current.provider) || provider || null,
    providerKind: (current && current.via) || null,
    unavailable,
    via: current && current.hook ? 'provider' : null,
    slot: current ? current.slot : null,
    keyword: current ? current.keyword : null,
    startedAt: current ? current.startedAt : null,
    finishedAt: (current && current.finishedAt) || null,
    exitCode: current ? (current.exitCode ?? null) : null,
    draftId: (current && current.draftId) || null,
    providerTaskId: (current && current.providerTaskId) || null,
    logFile: (current && current.logFile) || null,
    logTail: (current && current.logTail) || '',
    error: (current && current.error) || null,
    errorCode: (current && current.errorCode) || null,
    warning: (current && current.warning) || null,
    queueMax: getQueueMax(),
    maxConcurrency: max,
    running,
    queued,
    // 队首排队任务的位次信息，供汇总条显示「下一条：xxx」
    next: queuedTasks.length ? publicTask(queuedTasks[0]) : null,
    // 活动任务在前（按开始/入队时间），终态任务在后（新的在前）
    tasks: orderedTasks(),
  }
  return base
}

/** 活动任务（running → queued 顺序）+ 终态任务（新→旧） */
function orderedTasks() {
  const list = [...tasks.values()]
  const active = list.filter(isActive)
  const finished = list.filter((t) => !isActive(t))
  active.sort((a, b) => {
    const rank = (t) => (t.state === 'running' ? 0 : 1)
    return (
      rank(a) - rank(b) ||
      Date.parse(a.startedAt || a.enqueuedAt || 0) - Date.parse(b.startedAt || b.enqueuedAt || 0)
    )
  })
  finished.sort((a, b) => Date.parse(b.finishedAt || 0) - Date.parse(a.finishedAt || 0))
  return [...active, ...finished].map(publicTask)
}

/**
 * 清空任务注册表与队列（**只给测试用**）。
 *
 * 为什么需要它：本模块的状态是**进程内单例**（与桥的实际生命周期一致），
 * 而 `node --test` 在同一个进程里跑完整个文件——上一个用例残留的终态任务会
 * 让下一个用例的"完成条数"断言凭空多出几条（实测踩到：断言 3 条、实际 7 条）。
 *
 * 生产代码不该调用它：桥没有"清空队列"这个业务动作，队列是进程生命周期的一部分。
 */
export function resetTopicGenState() {
  tasks.clear()
  queue = []
  seq = 0
}

/** 逐条任务视图（Console 轮询用；含队列位次与汇总计数） */
export function getTopicGenTasks() {
  const gen = resolveGenerate()
  return {
    tasks: orderedTasks(),
    maxConcurrency: getMaxConcurrency(),
    queueMax: getQueueMax(),
    running: runningCount(),
    queued: queue.length,
    provided: gen.provided,
    provider: gen.provided
      ? {
          kind: gen.kind,
          source: gen.source || null,
          url: gen.url || null,
          projectId: gen.projectId ?? null,
        }
      : null,
    unavailable: gen.provided ? null : { code: gen.code || null, reason: gen.reason || null },
  }
}

/**
 * 端点预检（入队前的"点了就知道"）。
 *
 * 为什么值得多做一次 TCP 连接：生成端点"声明了但没人监听"是最常见的坏法，
 * 而旧流程下用户要等 30s 超时才看到"不可达"。一次 1.5s 的 TCP 探测把这个
 * 反馈提前到点击的瞬间，且**不会**触发任何真实生成（`probeEndpoint` 刻意只连 TCP）。
 *
 * 只对 http 提供者做；进程内钩子无需探测。探测结果不做缓存——端点可能刚起来。
 */
export async function preflightGenerate() {
  const gen = resolveGenerate()
  if (!gen.provided) {
    return {
      ok: false,
      code: gen.code || 'generate_not_provided',
      message: gen.reason || '生成能力未提供',
    }
  }
  if (gen.kind !== 'http') return { ok: true, kind: gen.kind }
  const probe = await probeEndpoint(gen)
  if (probe.reachable)
    return { ok: true, kind: 'http', url: gen.url, host: probe.host, port: probe.port }
  return {
    ok: false,
    code: 'generate_endpoint_unreachable',
    message:
      `生成端点连不上：${gen.url}` +
      (probe.declaredUrl
        ? `（声明 ${probe.declaredUrl}，实际拨号 ${gen.requestUrl || gen.url}）`
        : '') +
      ` · ${probe.reason || 'TCP 连接失败'} · 可运行 npm run doctor 查看详情`,
    url: gen.url,
  }
}
