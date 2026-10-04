#!/usr/bin/env node
/**
 * 文章生成 Token 消耗与费用计算（2026-08-22）
 *
 * 数据源: ~/.dsh/sessions/--<cwd>--/session-<id>/session[.vN].jsonl[.zstd]
 *   - 每个会话 = 一个文章生成轮次（定时轮/手动生成/一键生成）
 *   - 会话文件按 **generation** 命名（DSH 会随版本推进，见 dsh-session-format 的
 *     CANONICAL_LOG_FILENAME）：v0 = session.jsonl[.zstd]，vN(n>=1) = session.vN.jsonl[.zstd]。
 *     同一目录可能同时存在多代（迁移保留源文件），一律取"数值最高的规范 generation"。
 *   - usage 承载位置随代际变化（2026-09-11 修复：DSH 0.1.5-rc.1 起写 v3；
 *     2026-10-03 实测 v4 未变——DSH 0.2.0-rc.2 写 session.v4.jsonl[.zstd]，
 *     usage 仍在 assistant/message 的 data.usage，且不产生 assistant/chunk）：
 *       v0/v1/v2 : assistant/chunk  { data.chunk.usage: { inputTokens, cacheReadTokens, outputTokens, reasoningTokens } }
 *       v3/v4+   : assistant/message { data.usage:       同字段名 }（v3 起不再产生 assistant/chunk）
 *     注意：v0 文件里两种事件各带一份**同值** usage，故只能二选一（按代际优先 + 空则回退），
 *     绝不能累加，否则历史费用翻倍。
 *     ⚠ 代际再往上走时必须**复验**这条：位置一变，报表会静默归零而不是报错。
 *       preset/upgrade-check.sh 第 8 节会在代际 > 4 时提醒。
 *   - 计费方式: 每个 usage 事件独立计费（逐 step 累加），按事件时间戳判峰谷
 *
 * 价格: DeepSeek deepseek-v4-flash（每百万 tokens，人民币）
 *   官方定价页: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *   峰值时段: 北京时间 9:00-12:00、14:00-18:00；其余空闲
 *   2026-08-23（周日）00:00 起: 周末（周六/周日）全天按低谷价，不再区分峰谷
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadPaths } from './paths.mjs'
import { resolveOnPath } from './preflight.mjs'
import { bjTime } from './tz.mjs'

/** deepseek-v4-flash 价格（每百万 tokens，元）——2026-08-22 官方价 */
export const PRICING = {
  version: '2026-08-22',
  model: 'deepseek-v4-flash',
  inputMiss: { idle: 1.5, peak: 3.0 }, // 缓存未命中输入
  inputHit: { idle: 0.05, peak: 0.1 }, // 缓存命中输入
  output: { idle: 4.5, peak: 9.0 }, // 输出（含推理）
  weekendIdleFrom: '2026-08-23', // 周末全天低谷生效日
  peakHours: [
    [9, 12],
    [14, 18],
  ], // 高峰时段（北京时间）
}

const SESSIONS_DIRS = loadPaths().sessionsDirs

// ── 会话文件代际（2026-09-11 修复：DSH 升级后由 session.jsonl.zstd 改为 session.v3.jsonl.zstd）──
// 规则与 DSH 官方一致（@deepseek-ai/dsh-session-format 的 CANONICAL_LOG_FILENAME）：
// v0 不带 tag；vN 为不带前导零的小写 vN；.v0/大写/临时名/其它后缀都不是规范文件名。
// 本正则按 vN 泛化，**不需要**跟着代际改（v3 → v4 就无需改动）；要改的是上面那段
// usage 承载位置的分支，见 2026-10-03 对 v4 的实测说明。
const GENERATION_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/

/** 会话目录里挑"数值最高的规范 generation"（同代际压缩优先——一个根只属于一种编码）。
 *  返回 { file, gen, compressed }；目录里没有规范会话文件返回 null。 */
function sessionLogPath(dir) {
  let best = null
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    const m = GENERATION_RE.exec(name)
    if (!m) continue
    const gen = m[1] ? Number(m[1]) : 0
    const compressed = !!m[2]
    if (!best || gen > best.gen || (gen === best.gen && compressed && !best.compressed)) {
      best = { file: path.join(dir, name), gen, compressed }
    }
  }
  return best
}

/** 从会话文件路径解析代际（0 = session.jsonl[.zstd]）。非规范名按 0 处理（当旧格式读）。 */
function sessionGeneration(sessionPath) {
  const m = GENERATION_RE.exec(path.basename(sessionPath))
  return m && m[1] ? Number(m[1]) : 0
}

// ── 缓存（2026-08-22 性能优化）：会话文件静态不变，解析结果可安全缓存 ──
const sessionCostCache = new Map() // sessionPath[#window] -> { mtime, cost }  calcSessionCost 结果
const sessionRangeCache = new Map() // sessionPath -> { mtime, start, end }  sessionTimeRange 结果
const sessionEventsCache = new Map() // sessionPath -> { mtime, data }  loadSessionEvents 结果
let sessionsListCache = null // { at, sessions }  listSessions 结果
let sessionsListAt = 0

// ── 生成过程窗口参数（2026-08-28 精确计费：会话内按 burst 切分，只算单篇生成过程）──
// 实测（GUI 长会话 6777 事件）：单篇文章生成过程（标题候选→正文→评分→落盘）内事件
// 间隔 ≤3min（实测某篇 14:43→15:03 的簇内部 ≤132s）；跨任务/跨文章停顿 ≥6min
// （08-28 下午多任务间 398s~1072s）→ GAP=5min 稳定切分单篇过程，不吞并相邻任务。
export const PROCESS_WINDOW = {
  gapMs: 5 * 60 * 1000, // 过程内最大事件间隔：超过视为不同过程
  maxBeforeMs: 3 * 60 * 60 * 1000, // 锚点前回溯上限（3h），防吞并大簇前的无关历史
  afterMs: 15 * 60 * 1000, // 锚点后缓冲（覆盖落盘后的评分/审稿/补记）
}
const MATCH_WINDOW_MS = 10 * 60 * 1000 // 会话匹配缓冲（锚点 ± 窗口）
const ANCHOR_DATE_TOLERANCE_MS = 3 * 24 * 3600 * 1000 // publishedAt 与 article.date 容差（3 天）

/**
 * 会话索引磁盘缓存（2026-08-28 性能优化）：listSessions 全量解压每个 zstd 会话文件取
 * 首尾 usage 时间戳（冷调用 3-4s）。把 { mtime, startTs, endTs } 持久化到 /tmp，
 * 跨进程/重启复用；仅对 mtime 变化的会话增量重扫，全量扫描降至毫秒级。
 * 文件丢失/损坏视为空索引 → 全量重建（安全兜底）。
 */
const SESSION_INDEX_FILE = '/tmp/dsh-session-index.json'

function readSessionIndex() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_INDEX_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeSessionIndex(idx) {
  try {
    const tmp = SESSION_INDEX_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(idx))
    fs.renameSync(tmp, SESSION_INDEX_FILE)
  } catch {
    /* 写失败静默：下次重建 */
  }
}

/** 会话成本磁盘缓存（2026-08-28）：{ [sessionPath[#window]]: { mtime, cost } }
 *  2026-08-28 精确计费：key 含窗口（#all=全会话；#from:to=生成过程窗口），
 *  窗口计费与整会话计费互不复用（数值不同，必须分开缓存）。 */
const SESSION_COST_FILE = '/tmp/dsh-session-cost.json'

/** ── 批内索引上下文（2026-09-22 v2.102.1）────────────────────────────
 *  和 v2.102 修的文章级索引同一个病，只是更贵：这两个**会话**索引文件分别 2.66MB / 2.28MB，
 *  而 `calcSessionCost` / `loadSessionEvents` 对**每个会话**都要 `readFileSync + JSON.parse` 一次。
 *  实测：预热 278 个会话 = **5587ms**（≈20ms/会话，基本全是这两个文件的重复解析，
 *  而不是真的解析会话 —— 磁盘缓存本来就命中）。
 *
 *  所以给"一批"运算内挂一个上下文：索引**只在批开始时读一次**、改动在内存里累积、
 *  批结束最多各写一次。关键在于这两个批入口（prewarmSessions / listCosts）都是**同步**的，
 *  批内不会发生 await 交错，因此用模块级上下文是安全的（嵌套时复用外层，不重复起批）。
 */
let indexCtx = null

function withIndexCtx(fn) {
  if (indexCtx) return fn() // 嵌套：复用外层批次
  indexCtx = { cost: null, events: null, dirtyCost: false, dirtyEvents: false }
  try {
    return fn()
  } finally {
    const c = indexCtx
    indexCtx = null
    if (c.dirtyCost) writeSessionCostIndexFile(c.cost)
    if (c.dirtyEvents) writeSessionEventsIndexFile(c.events)
  }
}

/** 批内读/写诊断（回归测试用：批处理的索引读次数必须与批大小无关） */
const sessionIdxCounters = { reads: 0, writes: 0 }
export function sessionIndexStats() {
  return { ...sessionIdxCounters }
}

function readJsonFileSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeJsonFileAtomic(file, data) {
  try {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, file)
  } catch {
    /* 写失败静默 */
  }
}

function readSessionCostIndex() {
  if (indexCtx) {
    if (!indexCtx.cost) {
      sessionIdxCounters.reads += 1 // 只有真的落盘读才计数（批内复用不算）
      indexCtx.cost = readJsonFileSafe(SESSION_COST_FILE)
    }
    return indexCtx.cost
  }
  sessionIdxCounters.reads += 1
  return readJsonFileSafe(SESSION_COST_FILE)
}

function writeSessionCostIndex(idx) {
  if (indexCtx) {
    indexCtx.cost = idx
    indexCtx.dirtyCost = true
    return
  }
  sessionIdxCounters.writes += 1
  writeJsonFileAtomic(SESSION_COST_FILE, idx)
}

function writeSessionCostIndexFile(idx) {
  sessionIdxCounters.writes += 1
  writeJsonFileAtomic(SESSION_COST_FILE, idx)
}

/** 会话 usage 事件磁盘缓存（2026-08-28 精确计费）：{ [sessionPath]: { mtime, events, hidden } }
 *  events = [[ts, input, cache, output, reasoning]...]（按 ts 升序，仅 usage 事件）
 *  hidden = [{ type:'search'|'title', ts, input, output }...]（web 搜索/标题调用，估算后缓存）
 *  一次解压 → 任意窗口计费复用，不再对 51.8MB GUI 会话重复解压。
 */
const SESSION_EVENTS_FILE = '/tmp/dsh-session-events.json'

function readSessionEventsIndex() {
  if (indexCtx) {
    if (!indexCtx.events) {
      sessionIdxCounters.reads += 1 // 同上：只统计真的落盘读
      indexCtx.events = readJsonFileSafe(SESSION_EVENTS_FILE)
    }
    return indexCtx.events
  }
  sessionIdxCounters.reads += 1
  return readJsonFileSafe(SESSION_EVENTS_FILE)
}

function writeSessionEventsIndex(idx) {
  if (indexCtx) {
    indexCtx.events = idx
    indexCtx.dirtyEvents = true
    return
  }
  sessionIdxCounters.writes += 1
  writeJsonFileAtomic(SESSION_EVENTS_FILE, idx)
}

function writeSessionEventsIndexFile(idx) {
  sessionIdxCounters.writes += 1
  writeJsonFileAtomic(SESSION_EVENTS_FILE, idx)
}

/** 文章级费用结果缓存（2026-08-28 精确计费）：{ [articleId|doc:name]: { key, cost, at } }
 *  key = 锚点 + 匹配会话(path@mtime) 指纹；命中直接返回，打开详情零扫描零解压（毫秒级）。
 *  会话 mtime 变化（新生成/新写入）→ key 变化 → 自动失效重算。
 *
 *  2026-09-22（v2.102）：**按篇读写的代价被实测抓出来了** —— 这个索引文件 292KB，
 *  `listCosts` 遍历 301 篇时每篇都 `readFileSync + JSON.parse` 一次（实测 301 次 = 619ms），
 *  未命中还要原子写一次（301 次 = 751ms）。于是 `/proxy/costs` 稳定 810ms，
 *  而报表视图**每次打开**都要调它。改为**一次批处理只读一次、最多写一次**（见 costContext）。
 *  路径可用 `CROSSPOST_ARTICLE_COST_FILE` 覆盖（测试隔离用，与 CROSSPOST_CONFIG 同风格）。 */
const ARTICLE_COST_FILE = process.env.CROSSPOST_ARTICLE_COST_FILE || '/tmp/dsh-article-cost.json'

/** 索引读/写计数（只读诊断 + 回归测试用：批处理必须"读 1 次、写 ≤1 次"） */
const indexStats = { reads: 0, writes: 0 }
export function costIndexStats() {
  return { ...indexStats }
}

function readArticleCostIndex() {
  indexStats.reads += 1
  try {
    return JSON.parse(fs.readFileSync(ARTICLE_COST_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeArticleCostIndex(idx) {
  indexStats.writes += 1
  try {
    const tmp = ARTICLE_COST_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(idx))
    fs.renameSync(tmp, ARTICLE_COST_FILE)
  } catch {
    /* 写失败静默 */
  }
}

/** 失效缓存（mtime 变化检测辅助） */
function fileMtime(p) {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0
  }
}

/** 判定是否高峰时段（含周末全天低谷规则；统一北京时间，2026-08-24 时区修正） */
export function isPeak(ts) {
  const { date, hhmm, weekday } = bjTime(ts)
  // 周末全天低谷（2026-08-23 起生效）
  if (date >= PRICING.weekendIdleFrom && (weekday === 0 || weekday === 6)) return false
  const h = parseInt(hhmm.split(':')[0], 10)
  return PRICING.peakHours.some(([s, e]) => h >= s && h < e)
}

/**
 * `unzstd` 的解析（2026-09-25，Docker 形态实测后改）
 *
 * 这里原来**写死** `/usr/local/bin/unzstd`（Homebrew/macOS 的落点）。容器里
 * Debian 的 `zstd` 包装在 `/usr/bin/unzstd`，于是"宿主能跑、容器必然失败" ——
 * 更糟的是 `doctor` 是**按 PATH** 判可用的：体检说"可用"、费用报表照样解不开。
 *
 * 现在两边同一判据：先 PATH（use resolveOnPath，它也会补 /usr/local/bin 等兜底目录），
 * 再退回历史绝对路径，最后才交给 python 分支。
 */
export function resolveUnzstd() {
  return (
    resolveOnPath('unzstd') ||
    firstExecutable(['/usr/local/bin/unzstd', '/usr/bin/unzstd']) ||
    'unzstd'
  )
}

/** `python3` 的解析（同样的理由：别写死一个路径） */
export function resolvePython3() {
  return (
    resolveOnPath('python3') ||
    firstExecutable(['/usr/bin/python3', '/usr/local/bin/python3']) ||
    'python3'
  )
}

/** 按顺序返回第一个可执行的绝对路径（都不可执行 → null） */
function firstExecutable(paths) {
  for (const p of paths) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {
      /* 继续找 */
    }
  }
  return null
}

/** 解压（或直读）会话文件 → 行数组（失败返回 null；临时文件按会话名唯一，防并发覆盖）。
 *  2026-09-11：DSH 支持 compression='none'（文件名 session[.vN].jsonl），未压缩时直接读文本。 */
export function readSessionLines(sessionPath) {
  if (!fs.existsSync(sessionPath)) return null
  // 未压缩代际：直接按文本读行（与 zstd 分支产出同一形态）
  if (!sessionPath.endsWith('.zstd')) {
    try {
      return fs
        .readFileSync(sessionPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
    } catch {
      return null
    }
  }
  const tmp = `/tmp/tokencost-${path.basename(path.dirname(sessionPath))}.jsonl`
  try {
    execFileSync(resolveUnzstd(), ['-f', sessionPath, '-o', tmp, '-q'], {
      timeout: 30000,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const text = fs.readFileSync(tmp, 'utf8')
    return text.split('\n').filter((l) => l.trim())
  } catch {
    // 备用：无 unzstd 时尝试 python zstandard
    try {
      const py = execFileSync(
        resolvePython3(),
        [
          '-c',
          `
import zstandard, sys
with open('${sessionPath}','rb') as f:
    data = zstandard.ZstdDecompressor().decompress(f.read())
sys.stdout.write(data.decode('utf-8'))
`,
        ],
        { timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      return py
        .toString()
        .split('\n')
        .filter((l) => l.trim())
    } catch {
      return null
    }
  }
}

/**
 * 估算隐藏 LLM 调用的 token（web 搜索 / 会话标题生成）。
 * 这些调用在会话里只有请求体、无 usage 事件（DeepSeek 无按请求查 usage 的公开接口），
 * 只能基于请求体长度估算输入 token（≈ 字符数/3），输出按用途固定估算。
 * 结果与主对话实测值分开标注（main=实测 / hidden=估算）。
 * 2026-08-28 精确计费：可选 window {from,to} —— 只统计落在生成过程窗口内的隐藏调用，
 * 防止把其他文章的 web 搜索误算进本篇。
 */
export function estimateHiddenCalls(lines, window = null) {
  let search = 0 // web/deepseek-search-llm-request 次数
  let searchIn = 0
  let title = 0 // session/title-llm-request 次数
  let titleIn = 0
  let firstTs = null
  let lastTs = null
  for (const line of lines) {
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const type = d.type
    if (type !== 'web/deepseek-search-llm-request' && type !== 'session/title-llm-request') continue
    const ts = d.time
    if (window && (ts < window.from || ts > window.to)) continue
    if (firstTs === null) firstTs = ts
    lastTs = ts
    if (type === 'web/deepseek-search-llm-request') {
      search++
      const body = d.data && d.data.body
      searchIn += body ? Math.max(60, Math.round(JSON.stringify(body).length / 3)) : 90
    } else {
      title++
      const body = d.data || {}
      titleIn += Math.max(80, Math.round(JSON.stringify(body).length / 3))
    }
  }
  if (!search && !title) return null
  // 输出估算：web 搜索每次 ~120 tokens（搜索调用以小输出为主），标题 ~20
  const searchOut = search * 120
  const titleOut = title * 20
  return {
    searches: search,
    titles: title,
    input: searchIn + titleIn,
    output: searchOut + titleOut,
    total: searchIn + titleIn + searchOut + titleOut,
    time: lastTs || firstTs,
  }
}

/**
 * 加载会话全部 usage 事件 + hidden 调用（2026-08-28 精确计费核心）。
 * 返回 { events: [[ts, input, cache, output, reasoning]...]（ts 升序）, hidden: [...] }。
 * 磁盘缓存（mtime 键控）：一次解压任意复用，跨进程共享。
 * 失败（文件缺失/损坏）返回 null。
 *
 * 2026-09-11（DSH 会话格式 v3 兼容）：usage 的承载事件随代际变化——
 *   v0/v1/v2 → assistant/chunk.data.chunk.usage；v3+ → assistant/message.data.usage。
 * 2026-10-03（v4 实测）：0.2.0-rc.2 写 session.v4.jsonl.zstd，承载**仍是**
 *   assistant/message.data.usage（本机 v4 会话实测 94 条 assistant/message 各带一份 usage，
 *   且无 assistant/chunk），所以下面两条分支不用改。代际再往上走时须复验这一点。
 * 按文件名代际优先选一种，**该形态为空时才回退另一种**（v0 两种各有一份同值 usage，
 * 累加会翻倍；回退只为兜住"某代际实际用了另一种承载"）。两条路径互斥，绝不双计。
 */
export function loadSessionEvents(sessionPath) {
  const mtime = fileMtime(sessionPath)
  const hit = sessionEventsCache.get(sessionPath)
  if (hit && hit.mtime === mtime) return hit.data
  const diskHit = readSessionEventsIndex()[sessionPath]
  if (diskHit && diskHit.mtime === mtime) {
    sessionEventsCache.set(sessionPath, { mtime, data: diskHit })
    recordSessionShape(sessionPath, diskHit.events ? diskHit.events.length : 0)
    return diskHit
  }
  const lines = readSessionLines(sessionPath)
  if (!lines) return null
  const gen = sessionGeneration(sessionPath)
  const fromChunk = [] // 旧承载：assistant/chunk（v0/v1/v2）
  const fromMessage = [] // 新承载：assistant/message（v3+）
  const hidden = []
  for (const line of lines) {
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const ts = d.time
    if (d.type === 'assistant/chunk') {
      const u = d.data && d.data.chunk && d.data.chunk.usage
      if (!u) continue
      fromChunk.push([
        ts || Date.now(),
        u.inputTokens || 0,
        u.cacheReadTokens || 0,
        u.outputTokens || 0,
        u.reasoningTokens || 0,
      ])
    } else if (d.type === 'assistant/message') {
      const u = d.data && d.data.usage
      if (!u) continue
      fromMessage.push([
        ts || Date.now(),
        u.inputTokens || 0,
        u.cacheReadTokens || 0,
        u.outputTokens || 0,
        u.reasoningTokens || 0,
      ])
    } else if (
      d.type === 'web/deepseek-search-llm-request' ||
      d.type === 'session/title-llm-request'
    ) {
      let input = 0
      if (d.type === 'web/deepseek-search-llm-request') {
        const body = d.data && d.data.body
        input = body ? Math.max(60, Math.round(JSON.stringify(body).length / 3)) : 90
      } else {
        const body = d.data || {}
        input = Math.max(80, Math.round(JSON.stringify(body).length / 3))
      }
      hidden.push({ type: d.type.startsWith('web/') ? 'search' : 'title', ts, input })
    }
  }
  const primary = gen >= 3 ? fromMessage : fromChunk
  const fallback = gen >= 3 ? fromChunk : fromMessage
  const events = primary.length ? primary : fallback
  events.sort((a, b) => a[0] - b[0])
  const data = { mtime, events, hidden }
  recordSessionShape(sessionPath, events.length)
  sessionEventsCache.set(sessionPath, { mtime, data })
  try {
    const idx = readSessionEventsIndex()
    idx[sessionPath] = data
    writeSessionEventsIndex(idx)
  } catch {
    /* 静默 */
  }
  return data
}

// ── 会话格式自检（2026-09-11）：记录每个会话的"代际 + 解析出的 usage 条数" ──
// 目的：DSH 再次改动会话格式时，报表不会只静默变成 0——sessionFormatDiagnostics()
// 会直接点名"哪些代际/哪些文件一条 usage 都没解析出来"。
const sessionShapeStats = new Map() // sessionPath -> { gen, usageEvents }（仅本进程实际解析过的会话）
let sessionsScanStats = { at: 0, sessions: 0, byGen: {} } // listSessions 每次扫描的完整可见分布

function recordSessionShape(sessionPath, usageEvents) {
  sessionShapeStats.set(sessionPath, { gen: sessionGeneration(sessionPath), usageEvents })
}

/** 会话格式诊断。
 *  sessions/byGen 来自 listSessions 的**完整扫描**（按最高代际选定的可见会话，无需解析）；
 *  usageParsed/zeroUsage 只覆盖本进程实际解析过 usage 的会话（磁盘索引命中的不算，属正常）。
 *  出现没见过的代际、或 zeroUsage 点名文件 → 会话格式又变了。 */
export function sessionFormatDiagnostics() {
  const zeroUsage = []
  let usageParsed = 0
  for (const [p, s] of sessionShapeStats) {
    usageParsed++
    if (!s.usageEvents) zeroUsage.push(p)
  }
  return {
    sessions: sessionsScanStats.sessions,
    byGen: { ...sessionsScanStats.byGen },
    usageParsed,
    zeroUsageCount: zeroUsage.length,
    zeroUsage: zeroUsage.slice(0, 10), // 一条 usage 都没解析出来的会话（最多列 10 条）
  }
}

/**
 * 锚点所在「生成过程窗口」（2026-08-28 精确计费核心）：
 * 以锚点前最近事件为基准（生成完成/落盘 ≈ 过程末尾），向前回溯 burst ——
 * 事件间隔 ≤ gapMs 视为同一生成过程，遇间隔 > gapMs 停；回溯上限 maxBeforeMs
 * 防吞并大簇前无关历史；向后扩展 ≤ afterMs 缓冲（覆盖落盘后的评分/审稿/补记）。
 * 保护：锚点前最近事件距锚点 > gapMs（该会话在锚点时刻无生成活动）→ 返回 null，
 * 防止长会话区间覆盖锚点但实际生成在另一会话时，误取数小时前的孤立事件。
 * 返回 { from, to }（毫秒时间戳）；events 为空或锚点早于所有事件返回 null。
 */
export function findProcessWindow(events, anchor, opts = {}) {
  if (!events || !events.length || !anchor) return null
  const gapMs = opts.gapMs || PROCESS_WINDOW.gapMs
  const maxBeforeMs = opts.maxBeforeMs || PROCESS_WINDOW.maxBeforeMs
  const afterMs = opts.afterMs || PROCESS_WINDOW.afterMs
  const times = events.map((e) => e[0])
  // 锚点前最近事件索引（生成过程末尾 ≈ 落盘/登记时刻）
  let base = -1
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= anchor) base = i
    else break
  }
  if (base < 0) return null
  // 保护：锚点与最近事件距离超过 gapMs → 该会话此刻无生成活动（跨会话误匹配防护）
  if (anchor - times[base] > gapMs) return null
  // 向前回溯 burst 起点：间隔 ≤ gapMs 且未超 maxBeforeMs
  let startIdx = base
  while (
    startIdx > 0 &&
    times[startIdx] - times[startIdx - 1] <= gapMs &&
    anchor - times[startIdx - 1] <= maxBeforeMs
  ) {
    startIdx--
  }
  // 向后扩展：锚点后连续事件且 ≤ anchor + afterMs（评分/审稿/补记）
  let endIdx = base
  while (
    endIdx + 1 < times.length &&
    times[endIdx + 1] - times[endIdx] <= gapMs &&
    times[endIdx + 1] <= anchor + afterMs
  ) {
    endIdx++
  }
  return { from: times[startIdx], to: times[endIdx] }
}

/**
 * 计算单个会话的 token 与费用（逐 usage 事件累加，按事件时间判峰谷）。
 * 2026-08-28 精确计费：可选 window {from,to} —— 只累计生成过程窗口内的事件；
 * 无窗口 = 全会话（保持旧语义，headless 单轮会话窗口≈全会话）。
 * 缓存键含窗口（#all / #from:to），窗口内计费与整会话计费互不复用。
 * 返回 { main, hidden, tokens, cost, steps, time }；无 usage 事件返回 null。
 */
export function calcSessionCost(sessionPath, window = null) {
  const mtime = fileMtime(sessionPath)
  const cacheKey = window ? `${sessionPath}#${window.from}:${window.to}` : `${sessionPath}#all`
  const hit = sessionCostCache.get(cacheKey)
  if (hit && hit.mtime === mtime) return hit.cost
  // 磁盘缓存兜底（跨进程）：mtime 一致直接复用
  const diskHit = readSessionCostIndex()[cacheKey]
  if (diskHit && diskHit.mtime === mtime) {
    sessionCostCache.set(cacheKey, { mtime, cost: diskHit.cost })
    return diskHit.cost
  }
  const cost = computeSessionCost(sessionPath, window)
  sessionCostCache.set(cacheKey, { mtime, cost })
  if (cost !== null) {
    const idx = readSessionCostIndex()
    idx[cacheKey] = { mtime, cost }
    writeSessionCostIndex(idx)
  }
  return cost
}

function computeSessionCost(sessionPath, window = null) {
  const data = loadSessionEvents(sessionPath)
  if (!data || !data.events.length) return null
  const t = { input: 0, cache: 0, output: 0, reasoning: 0 }
  let cost = 0
  let steps = 0
  let firstTs = null
  let lastTs = null
  for (const [ts, i, c, o, r] of data.events) {
    if (window && (ts < window.from || ts > window.to)) continue
    t.input += i
    t.cache += c
    t.output += o
    t.reasoning += r
    if (firstTs === null) firstTs = ts
    lastTs = ts
    const zone = isPeak(ts) ? 'peak' : 'idle'
    cost +=
      (i / 1e6) * PRICING.inputMiss[zone] +
      (c / 1e6) * PRICING.inputHit[zone] +
      (o / 1e6) * PRICING.output[zone]
    steps++
  }
  if (!steps) return null
  // 隐藏调用（web 搜索 / 标题生成）：估算（窗口内）
  const hidden = estimateHiddenCallsFromEvents(data.hidden, window)
  let hiddenCost = 0
  if (hidden) {
    const zone = isPeak(hidden.time || Date.now()) ? 'peak' : 'idle'
    hiddenCost =
      Math.round(
        ((hidden.input / 1e6) * PRICING.inputMiss[zone] +
          (hidden.output / 1e6) * PRICING.output[zone]) *
          10000,
      ) / 10000
  }
  return {
    main: {
      tokens: { ...t, total: t.input + t.cache + t.output },
      cost: Math.round(cost * 10000) / 10000,
    },
    hidden: hidden
      ? {
          searches: hidden.searches,
          titles: hidden.titles,
          tokens: { input: hidden.input, output: hidden.output, total: hidden.total },
          cost: hiddenCost,
        }
      : null,
    tokens: {
      input: t.input,
      cache: t.cache,
      output: t.output,
      reasoning: t.reasoning,
      hidden: hidden ? hidden.total : 0,
      total: t.input + t.cache + t.output + (hidden ? hidden.total : 0),
    },
    cost: Math.round((cost + hiddenCost) * 10000) / 10000,
    mainCost: Math.round(cost * 10000) / 10000,
    steps,
    time: lastTs || firstTs,
    session: path.basename(path.dirname(sessionPath)),
    window,
  }
}

/** 从已解析的 hidden 事件列表估算（窗口过滤；与 estimateHiddenCalls 同口径，复用事件缓存免二次解压） */
function estimateHiddenCallsFromEvents(hidden, window = null) {
  if (!hidden || !hidden.length) return null
  let search = 0,
    title = 0,
    searchIn = 0,
    titleIn = 0,
    firstTs = null,
    lastTs = null
  for (const h of hidden) {
    if (window && (h.ts < window.from || h.ts > window.to)) continue
    if (firstTs === null) firstTs = h.ts
    lastTs = h.ts
    if (h.type === 'search') {
      search++
      searchIn += h.input
    } else {
      title++
      titleIn += h.input
    }
  }
  if (!search && !title) return null
  const searchOut = search * 120
  const titleOut = title * 20
  return {
    searches: search,
    titles: title,
    input: searchIn + titleIn,
    output: searchOut + titleOut,
    total: searchIn + titleIn + searchOut + titleOut,
    time: lastTs || firstTs,
  }
}

/** 列出所有文章生成会话 → [{ session, path, mtime, startTs, endTs }]
 *  startTs/endTs 取自 usage 事件真实时间。
 *  2026-08-28 性能优化：磁盘索引增量复用——只对 mtime 变化的会话重解压取时间范围，
 *  其余从 /tmp/dsh-session-index.json 复用；同时保留 60s 内存缓存。
 *  2026-09-11 修复：会话文件按代际命名（v0 = session.jsonl.zstd，v3+ = session.v3.jsonl.zstd），
 *  改为按"最高规范 generation"选文件——旧代码硬编码 session.jsonl.zstd，DSH 升级后
 *  新增的 v3 会话全部不可见，导致报表费用静默归零。
 *  2026-10-03 复核：该修法对 v4 同样成立（GENERATION_RE 本就泛化到 vN，无需再改）；
 *  0.2.0-rc.2 的会话已实测被 listSessions/loadSessionEvents 正常读出 usage。
 */
export function listSessions() {
  const now = Date.now()
  if (sessionsListCache && now - sessionsListAt < 60000) return sessionsListCache
  const index = readSessionIndex()
  let changed = false
  const out = []
  const scanByGen = {}
  for (const root of SESSIONS_DIRS) {
    if (!fs.existsSync(root)) continue
    for (const sid of fs.readdirSync(root)) {
      const dir = path.join(root, sid)
      if (!fs.statSync(dir).isDirectory()) continue
      const log = sessionLogPath(dir)
      if (!log) continue
      const f = log.file
      scanByGen[log.gen] = (scanByGen[log.gen] || 0) + 1 // 格式自检：可见会话的代际分布
      try {
        const st = fs.statSync(f)
        const mtime = st.mtimeMs
        const hit = index[f]
        let startTs = null,
          endTs = null
        if (hit && hit.mtime === mtime) {
          // 磁盘索引命中：mtime 未变，复用已解析时间范围
          startTs = hit.startTs
          endTs = hit.endTs
        } else {
          // mtime 变化或新会话：增量重扫该会话
          const info = sessionTimeRange(f)
          startTs = info ? info.start : null
          endTs = info ? info.end : null
          index[f] = { mtime, startTs, endTs }
          changed = true
        }
        out.push({ session: sid, path: f, mtime, startTs, endTs })
      } catch {
        /* skip */
      }
    }
  }
  if (changed) writeSessionIndex(index)
  sessionsListCache = out.sort((a, b) => (a.startTs || a.mtime) - (b.startTs || b.mtime))
  sessionsListAt = now
  sessionsScanStats = { at: now, sessions: out.length, byGen: scanByGen }
  return sessionsListCache
}

/** 读取会话内首尾 usage 事件时间戳（真实运行时间，mtime 不可靠——文件会被 dsh 后续 touch；结果缓存）
 *  2026-08-28 精确计费：复用 loadSessionEvents 事件缓存，避免与窗口计费重复解压。 */
function sessionTimeRange(sessionPath) {
  const mtime = fileMtime(sessionPath)
  const hit = sessionRangeCache.get(sessionPath)
  if (hit && hit.mtime === mtime) return { start: hit.start, end: hit.end }
  const data = loadSessionEvents(sessionPath)
  let res = null
  if (data && data.events.length) {
    res = { start: data.events[0][0], end: data.events[data.events.length - 1][0] }
  }
  sessionRangeCache.set(sessionPath, {
    mtime,
    start: res ? res.start : null,
    end: res ? res.end : null,
  })
  return res
}

/**
 * 按时间窗匹配会话（±windowMs 内），返回候选列表
 */
export function matchSessions(ts, windowMs = 5 * 60 * 1000) {
  return listSessions().filter((s) => Math.abs(s.mtime - ts) <= windowMs)
}

/**
 * 按锚点时间匹配会话并汇总消耗（articleCost 用，2026-08-28 抽取）。
 * 2026-08-28 匹配策略修复：headless 单轮会话 endTs 定格（锚点 ≈ endTs），
 * 但 GUI 长会话持续活跃（endTs 不断推进），旧条件 |endTs-anchor|≤window 永远匹配不上
 * 会话内生成的文章 → 成本"无会话记录"。改为**锚点落在会话 usage 时间区间 [startTs, endTs] 内**
 * （含 ±windowMs 缓冲）即视为同轮生成，兼容两种会话形态。
 * 2026-08-28 精确计费：不再返回整个会话成本，而是每会话只计**锚点所在生成过程窗口**
 * （findProcessWindow burst 切分）内的 token/费用——GUI 长会话中每篇文章只算自己的过程。
 */
export function matchAnchorSessions(anchor, windowMs = MATCH_WINDOW_MS) {
  if (!anchor) return []
  const sessions = listSessions()
  return sessions
    .filter((s) => s.startTs && anchor >= s.startTs - windowMs && anchor <= s.endTs + windowMs)
    .map((s) => {
      const data = loadSessionEvents(s.path)
      if (!data || !data.events.length) return null
      const win = findProcessWindow(data.events, anchor)
      if (!win) return null
      const c = calcSessionCost(s.path, win)
      return c ? { ...c, session: s.session, window: win } : null
    })
    .filter(Boolean)
}

/** 汇总匹配会话的 token/费用（matchAnchorSessions 结果 → articleCost 同构返回体）
 *  2026-08-28 精确计费：新增 processWindow（生成过程时间窗，跨会话取并集） */
export function aggregateSessionCosts(results, id, date, slot, title) {
  const tokens = results.reduce(
    (acc, r) => {
      acc.input += r.tokens.input
      acc.cache += r.tokens.cache
      acc.output += r.tokens.output
      acc.reasoning += r.tokens.reasoning
      acc.hidden += r.tokens.hidden || 0
      return acc
    },
    { input: 0, cache: 0, output: 0, reasoning: 0, hidden: 0 },
  )
  tokens.total = tokens.input + tokens.cache + tokens.output + tokens.hidden
  const mainCost =
    Math.round(results.reduce((a, r) => a + (r.mainCost || r.cost), 0) * 10000) / 10000
  const hiddenCost =
    Math.round(results.reduce((a, r) => a + ((r.hidden && r.hidden.cost) || 0), 0) * 10000) / 10000
  const cost = Math.round((mainCost + hiddenCost) * 10000) / 10000
  const hiddenMeta = results.reduce(
    (a, r) => {
      if (r.hidden) {
        a.searches += r.hidden.searches || 0
        a.titles += r.hidden.titles || 0
      }
      return a
    },
    { searches: 0, titles: 0 },
  )
  const windows = results.map((r) => r.window).filter(Boolean)
  const processWindow = windows.length
    ? { from: Math.min(...windows.map((w) => w.from)), to: Math.max(...windows.map((w) => w.to)) }
    : null

  return {
    id,
    date,
    slot,
    title,
    tokens,
    cost,
    mainCost,
    hiddenCost,
    hiddenMeta,
    processWindow,
    sessions: results.map((r) => ({
      session: r.session,
      steps: r.steps,
      cost: r.cost,
      mainCost: r.mainCost,
      hiddenCost: (r.hidden && r.hidden.cost) || 0,
      time: r.time,
      window: r.window,
    })),
    matched: results.length > 0,
  }
}

/** 无会话匹配时的空返回体 */
export function noMatchCost(id, date, slot, title) {
  return {
    id,
    date,
    slot,
    title,
    tokens: { input: 0, cache: 0, output: 0, reasoning: 0, hidden: 0, total: 0 },
    cost: 0,
    mainCost: 0,
    hiddenCost: 0,
    hiddenMeta: { searches: 0, titles: 0 },
    processWindow: null,
    sessions: [],
    matched: false,
  }
}

/**
 * 计算单篇文章生成消耗：按可靠时间锚点匹配会话（会话用内部 usage 时间，文件 mtime 不可靠）。
 * 2026-08-28 精确计费：
 *  - 锚点优先级：createdAt（首次登记=生成时刻）> publishedAt（真实首发）> 文件 mtime > 日期近似；
 *    迁移老文章（date 与 createdAt/publishedAt 相差 >3 天）自动回退文件 mtime，
 *    匹配不到现有会话 → 「无会话记录」，不再误算批量登记日的 burst。
 *  - 过程窗口：只计锚点所在 burst 内的 token/费用（matchAnchorSessions 内部切分）。
 *  - 文章级结果缓存：key=锚点+匹配会话指纹，命中直接返回（打开详情零重算）。
 *
 *  2026-09-22（v2.102）：把"每篇都读一次索引文件"改掉 —— 见下方 costContext 的说明。
 */
export function articleCost(article) {
  const ctx = costContext()
  const cost = articleCostWith(ctx, article)
  ctx.commit()
  return cost
}

/**
 * 批处理上下文（2026-09-22 v2.102，实测驱动的性能修复）
 *
 * 改前：`articleCost` 每次调用都 `readArticleCostIndex()`（292KB 的 JSON 全读全解析），
 * 未命中还要原子写一次。`listCosts` 遍历 301 篇 ⇒ 301 次读（实测 619ms）+ 若干次写（751ms），
 * 于是报表视图每次打开的 `/proxy/costs` 稳定 810ms。
 *
 * 改后：一次批处理**只读一次索引**，命中判定与写回都在内存里完成，收尾最多写一次。
 * 语义不变（key 仍是"锚点 + 匹配会话 path@mtime 指纹"，会话变化照样自动失效）。
 * 并把"匹配会话指纹"预计算成一张表，省掉每篇重建 path@mtime 字符串的开销。
 *
 * 并发说明：批处理期间持有的是**读时的快照**；另一个进程（cron/CLI）若同时写入，
 * 那一侧的新增条目可能被本次的收尾写覆盖 —— 这只是缓存条目丢失（下次重算），
 * 不影响结果正确性。
 */
function costContext() {
  const idx = readArticleCostIndex()
  const prints = listSessions().map((s) => ({
    startTs: s.startTs,
    endTs: s.endTs,
    print: `${s.path}@${Math.round(s.mtime)}`,
  }))
  let dirty = false
  return {
    idx,
    prints,
    markDirty() {
      dirty = true
    },
    commit() {
      if (dirty) writeArticleCostIndex(idx)
    },
  }
}

function articleCostWith(ctx, article) {
  if (!article) return null
  const id = article.id
  const date = article.date
  const slot = article.slot
  const title = article.title
  // 锚点解析（2026-08-28 修正：createdAt 优先——登记即生成时刻；publishedAt 可能是补登记）
  let anchor = null
  const validTs = (iso) => {
    const t = new Date(iso).getTime()
    return Number.isFinite(t) ? t : null
  }
  const sameDayAsDate = (ts) => {
    if (!date) return true
    const d = new Date(date + 'T12:00:00').getTime()
    return Number.isFinite(d) && Math.abs(ts - d) <= ANCHOR_DATE_TOLERANCE_MS
  }
  const createdAt = validTs(article.createdAt)
  const publishedAt = validTs(article.publishedAt)
  if (createdAt && sameDayAsDate(createdAt)) anchor = createdAt
  if (anchor === null && publishedAt && sameDayAsDate(publishedAt)) anchor = publishedAt
  if (anchor === null && article.file && fs.existsSync(article.file))
    anchor = fs.statSync(article.file).mtimeMs
  if (anchor === null && date) anchor = new Date(date + 'T12:00:00').getTime()

  // 文章级结果缓存：key = 锚点 + 匹配会话(path@mtime) 指纹；命中直接返回
  const key =
    anchor !== null
      ? `${anchor}|${ctx.prints
          .filter(
            (s) =>
              s.startTs &&
              anchor >= s.startTs - MATCH_WINDOW_MS &&
              anchor <= s.endTs + MATCH_WINDOW_MS,
          )
          .map((s) => s.print)
          .sort()
          .join(',')}`
      : 'no-anchor'
  const idx = ctx.idx
  const hit = idx[id]
  if (hit && hit.key === key) return hit.cost

  let cost
  if (anchor === null) {
    cost = noMatchCost(id, date, slot, title)
  } else {
    const results = matchAnchorSessions(anchor)
    cost = results.length
      ? aggregateSessionCosts(results, id, date, slot, title)
      : noMatchCost(id, date, slot, title)
  }
  // 写文章级缓存（内存里更新，由 ctx.commit() 在批处理收尾时原子落盘一次）
  try {
    ctx.idx[id] = { key, cost, at: Date.now() }
    ctx.markDirty()
  } catch {
    /* 静默 */
  }
  return cost
}

/**
 * 预热全部会话解析（批量查询前调用一次，避免逐篇重复解压；2026-08-22 性能优化）
 *  2026-08-28：listCosts 不再隐式调用（articleCost 已按锚点只算匹配会话 + 磁盘索引兜底），
 *  本函数保留供显式预热场景（prewarmCosts CLI）使用。
 *
 *  2026-09-22（v2.102.1）**分块化**：实测 278 个会话要 6.5s，而 costs 车道是**串行队列** ——
 *  桥启动整块预热时，用户开机后立刻打开报表要等 **7.46s**（实测）。
 *  现在支持 `{ offset, limit }` 只预热一块，桥侧循环调用，于是插进来的 `/proxy/costs`
 *  最多等**一块**（默认 20 个会话 ≈ 0.5s）。返回值带 `total/offset/done` 供调用方续块。
 *  不传参 = 仍预热全部（向后兼容）。 */
export function prewarmSessions(opts = {}) {
  const sessions = listSessions()
  const total = sessions.length
  const offset = Math.max(0, Number(opts.offset) || 0)
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : total
  const slice = sessions.slice(offset, offset + limit)
  // 批内索引上下文：本块里 2.66MB/2.28MB 两个会话索引各只读一次（改前每会话各读一次）
  withIndexCtx(() => {
    for (const s of slice) calcSessionCost(s.path)
  })
  const next = offset + slice.length
  return { warmed: slice.length, total, offset, done: next >= total || slice.length === 0 }
}

/** 批量计算文章列表的消耗（列表页用，轻量：不展开会话明细；articleCost 惰性匹配，磁盘索引避免全量解压） */
export function listCosts(articles) {
  // 2026-09-22（v2.102）：整批共享一个 costContext ⇒ 索引文件**只读一次、最多写一次**。
  // 改前每篇都读一次那个 292KB 文件（301 篇 = 619ms），这是 /proxy/costs 810ms 的主因。
  // v2.102.1：外面再套一层 withIndexCtx —— 匹配过程要用两个 2.66MB/2.28MB 的**会话**索引，
  // 它们此前同样是"每次查找读一遍"，是开机后第一次看报表的主要成本。
  const ctx = costContext()
  const out = withIndexCtx(() =>
    articles.map((a) => {
      // 2026-08-28 精确计费：透传 createdAt（首次登记=生成时刻，优先于 publishedAt 补登记）
      const publishedAt = a.history && a.history[0] ? a.history[0].at : null
      const c = articleCostWith(ctx, { ...a, createdAt: a.createdAt, publishedAt })
      return {
        id: a.id,
        date: a.date,
        slot: a.slot,
        title: a.title,
        tokens: c ? c.tokens : null,
        cost: c ? c.cost : null,
        mainCost: c ? c.mainCost : null,
        hiddenCost: c ? c.hiddenCost : null,
        hiddenMeta: c ? c.hiddenMeta : null,
        processWindow: c ? c.processWindow : null,
        matched: c ? c.matched : false,
      }
    }),
  )
  ctx.commit()
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI 调试：node src/token-cost.mjs <article-id|all>
  const arg = process.argv[2] || 'all'
  const { scanAndList } = await import('./articles.mjs')
  const list = scanAndList()
  if (arg === 'all') {
    const res = listCosts(list)
    const total = res.reduce((a, r) => a + (r.cost || 0), 0)
    for (const r of res) {
      console.log(
        `${r.date} ${(r.slot || '').padEnd(9)} ${String(r.cost !== null ? '¥' + r.cost.toFixed(4) : '—').padEnd(10)} ${(r.tokens ? String(r.tokens.total).padStart(8) : '—').padEnd(9)} ${r.title.slice(0, 30)}`,
      )
    }
    console.log(
      `\n合计: ¥${total.toFixed(4)} (${list.length} 篇, ${res.filter((r) => r.cost !== null).length} 篇有会话匹配)`,
    )
  } else {
    const a = list.find((x) => x.id === arg)
    if (!a) {
      console.log('not found:', arg)
      process.exit(1)
    }
    console.log(JSON.stringify(articleCost(a), null, 2))
  }
}
