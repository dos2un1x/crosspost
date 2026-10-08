/**
 * 选题库（`topic-pool.json`）的**唯一写入实现**。
 *
 * ## 为什么收拢到一处
 *
 * 这份文件有**两个写入者**：引擎自己（回填 `articleId`、Console 的删除/归档）与
 * 项目侧的候选入库脚本。此前"每行长什么样、怎么合并、要不要加锁"这套契约只写在
 * 项目侧脚本的注释与 SOP 里，引擎侧只有"读 + 整表写回"。代价：
 *
 *   · 项目侧少给一个字段（4 元组 `["<kw>", 92, "rejected", "<原因>"]`）就**整体左移**，
 *     把分数写进 `title`、把原因写进 `status`，静默写坏 4 条；引擎的统计与 Console
 *     渲染跟着错，而报错信息指向别处（渲染异常被兜底成"无法连接 Bridge"）。
 *   · 锁只在引擎侧有，项目侧根本没有 → 并发放开就会互相覆盖。
 *
 * 所以本模块持有三样东西，且**只此一份**：
 *   ① 行形状校验（`validateRows`）——不合格就拒绝整次写入，绝不写一半；
 *   ② 合并规则（`upsertRows`）——按 `(date, slot, keyword)` upsert、不许减少同日同 slot
 *      条目、`generated` 不降级、`articleId` 只增不清、`reason` 追加而非覆盖；
 *   ③ 写锁与原子写（`withPoolLock` / `writePoolFile`）——`mkdir` 原子性 + 陈旧锁回收，
 *      tmp + rename，写完回读校验。
 *
 * 项目侧的写入器应该**转发到这里**（`cli.mjs topicPoolUpsert`），而不是自己实现一遍。
 *
 * ## 锁的取舍（与引擎既有行为一致）
 *
 * 拿不到锁就重试，超时后**降级为无锁写入**并在结果里如实回报 `locked:false`：
 * 对"回填 articleId"这类写，丢一次远好过把整条生成链路卡在陈旧锁上；对候选入库，
 * 调用方拿到 `locked:false` 应当告警。陈旧锁（持有者被 kill）会被强拆。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getTopicPoolFile } from './resources.mjs'
import { withProject, currentProject } from './project-context.mjs'
import { listProjects } from './projects.mjs'
import { soleProjectId } from './resources.mjs'

/** `status` 的取值域——三值之外一律判不合格 */
export const POOL_STATUSES = ['adopted', 'generated', 'rejected']

/** 选题库顶层说明（引擎 `writeTopicPool` 一直写这个，保留同一份文案） */
export const POOL_NOTE =
  '选题库:每轮评分后 TOP 1-5 候选全量入库;status=adopted(采用,未生成文章)/generated(已生成,含articleId)/rejected(落选,含reason);落选可经 Console 人工删除(删除前自动备份);generated/adopted 不可删。'

/** 陈旧锁阈值：持有者进程被 kill 后不会有人来解锁，超过它就能强拆 */
export const LOCK_STALE_MS = 30000
const LOCK_TIMEOUT_MS = 5000
const LOCK_POLL_MS = 25

// ─────────────────────────── 行形状校验 ───────────────────────────

/** 行的**字段名**形态（对象行）；数组行按位置对应这六个 */
export const ROW_FIELDS = ['keyword', 'title', 'score', 'status', 'reason', 'articleId']

/** 允许出现但不参与写入语义的键（回灌既有行时会出现） */
const ROW_PASSTHROUGH = ['id', 'date', 'slot', 'rank', 'createdAt', 'source', 'legacy']

/**
 * 把一行候选规整成**具名字段**。数组行（按位置）与对象行（按字段名）都接受——
 * 两种形态在这里汇合，下游只看具名字段。
 *
 * 为什么两种都收：项目侧历史写入器传的是位置数组，而"少给一个字段"在位置数组里
 * 表现为**整体左移**（分数进 title、原因进 status），是最难查的一类静默错。
 * 对象行没有这个风险，所以 AI/新调用方应该用对象行；数组行作为兼容形态留着。
 *
 * @returns {{row?: object, problem?: string, unknownKeys?: string[]}}
 */
export function normalizeRow(raw, i) {
  if (Array.isArray(raw)) {
    if (raw.length < 5 || raw.length > 6)
      return {
        problem:
          `第 ${i} 条有 ${raw.length} 个字段，应为 5 或 6 个 ` +
          `[keyword, title, score, status, reason, articleId?]——少给 title 会让后面所有字段左移`,
      }
    const [keyword, title, score, status, reason] = raw
    return {
      row: { keyword, title, score, status, reason, articleId: raw.length === 6 ? raw[5] : null },
    }
  }
  if (raw && typeof raw === 'object') {
    const unknownKeys = Object.keys(raw).filter(
      (k) => !ROW_FIELDS.includes(k) && k !== 'topicScore' && !ROW_PASSTHROUGH.includes(k),
    )
    const problems = []
    if (unknownKeys.length)
      problems.push(
        `第 ${i} 条有未知字段 ${unknownKeys.map((k) => JSON.stringify(k)).join(', ')}` +
          `（字段名写错会被静默忽略，所以这里判死；可用：${ROW_FIELDS.join(' / ')}）`,
      )
    if (!('title' in raw))
      problems.push(`第 ${i} 条缺 title（对象行同样不能省：没有标题就给空串 ""）`)
    const row = {
      keyword: raw.keyword,
      title: raw.title === undefined ? undefined : raw.title,
      score:
        raw.score !== undefined ? raw.score : raw.topicScore !== undefined ? raw.topicScore : null,
      status: raw.status,
      reason: raw.reason === undefined ? '' : raw.reason,
      articleId: raw.articleId === undefined ? null : raw.articleId,
    }
    return { row, problems }
  }
  return { problem: `第 ${i} 条既不是数组也不是对象：${describe(raw)}` }
}

/**
 * 逐行校验候选数组，返回问题清单（空数组 = 全部合格）。
 *
 * 行形状是**调用方的契约**，在这里当场判死：让"写坏数据"变成一次响亮失败，
 * 而不是让下游（Console / 引擎统计）去猜某个字段为什么不是它以为的类型。
 *
 * 两种行形态都接受（见 `normalizeRow`）：数组 `[keyword,title,score,status,reason,articleId?]`
 * 或对象 `{keyword,title,score,status,reason,articleId?}`（对象可用 `topicScore` 作 `score` 的别名，
 * 方便把既有行原样传回来）。
 *
 * @param {unknown} rows
 * @returns {string[]} 人类可读的问题清单（含行号与实参）
 */
export function validateRows(rows) {
  const problems = []
  if (!Array.isArray(rows)) return [`候选必须是数组（拿到 ${describe(rows)}）`]
  if (!rows.length) return ['候选数组不能为空']
  rows.forEach((raw, idx) => {
    const i = idx + 1
    const norm = normalizeRow(raw, i)
    if (norm.problems) problems.push(...norm.problems)
    if (!norm.row) {
      if (norm.problem) problems.push(norm.problem)
      return
    }
    const { keyword, title, score, status, reason, articleId } = norm.row
    const missingTitle = (norm.problems || []).some((x) => x.includes('缺 title'))
    if (typeof keyword !== 'string' || !keyword.trim())
      problems.push(`第 ${i} 条 keyword 必须是非空字符串：${describe(keyword)}`)
    if (!missingTitle && title !== null && typeof title !== 'string')
      problems.push(
        `第 ${i} 条 title 必须是字符串（没有标题就给空串 ""，不能省略也不能给数字）：${describe(title)}`,
      )
    if (score !== null && score !== undefined) {
      const okScore =
        typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100
      if (!okScore) problems.push(`第 ${i} 条 score 必须是 0-100 的数字或 null：${describe(score)}`)
    }
    if (!POOL_STATUSES.includes(status))
      problems.push(`第 ${i} 条 status 必须是 ${POOL_STATUSES.join('/')} 之一：${describe(status)}`)
    if (typeof reason !== 'string')
      problems.push(`第 ${i} 条 reason 必须是字符串（可空串）：${describe(reason)}`)
    if (articleId !== null && articleId !== undefined && typeof articleId !== 'string')
      problems.push(`第 ${i} 条 articleId 必须是字符串或省略：${describe(articleId)}`)
  })
  return problems
}

/** 把任意值渲染成人类可读的短描述（用于报错，不用于写盘） */
function describe(v) {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// ─────────────────────────── 读 / 写 ───────────────────────────

/**
 * 读选题库。文件缺失/损坏一律返回"空库 + 原因"，**不抛**——调用方据此决定要不要继续写。
 * @param {string} file
 * @returns {{topics: object[], raw: object, existed: boolean, error: string|null}}
 */
export function readPoolFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return {
      topics: [],
      raw: {},
      existed: false,
      error: e && e.code === 'ENOENT' ? null : String(e.message || e),
    }
  }
  try {
    const raw = JSON.parse(text)
    return {
      topics: Array.isArray(raw && raw.topics) ? raw.topics : [],
      raw: raw && typeof raw === 'object' ? raw : {},
      existed: true,
      error: null,
    }
  } catch (e) {
    return {
      topics: [],
      raw: {},
      existed: true,
      error: `选题库文件已损坏，先修它再写：${e.message || e}`,
    }
  }
}

/**
 * 原子写选题库：保留文件原有的其它顶层键（`_note` 等），缺 `_note` 时补上引擎那份文案。
 * 写完**回读校验**，解析不通过就不 rename（宁可这次不写，也不留下半个坏文件）。
 * @param {string} file
 * @param {object[]} topics
 * @param {{raw?: object}} [opts]
 */
export function writePoolFile(file, topics, opts = {}) {
  const data = { ...(opts.raw && typeof opts.raw === 'object' ? opts.raw : {}) }
  if (!data._note) data._note = POOL_NOTE
  data.topics = topics
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  try {
    const back = JSON.parse(fs.readFileSync(tmp, 'utf8'))
    if (!Array.isArray(back.topics)) throw new Error('回读校验失败：topics 不是数组')
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw e
  }
  fs.renameSync(tmp, file)
  return data
}

// ─────────────────────────── 写锁 ───────────────────────────

/** 锁目录与选题库同目录（与引擎既有约定一致：`<history>/.topic-pool.lock`） */
export function lockDirFor(poolFile) {
  return path.join(path.dirname(poolFile), '.topic-pool.lock')
}

/**
 * 取锁（`mkdir` 的原子性）。返回是否真的拿到；拿不到按 `allowUnlocked` 决定是否降级。
 * @param {string} dir
 * @param {{timeoutMs?: number, staleMs?: number, allowUnlocked?: boolean}} [opts]
 */
export function acquirePoolLock(dir, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS
  const staleMs = opts.staleMs ?? LOCK_STALE_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.mkdirSync(dir)
      return { locked: true }
    } catch (e) {
      if (e && e.code !== 'EEXIST') return { locked: false, reason: `取锁失败：${e.message || e}` }
      // 陈旧锁回收：持有者大概率已被 kill（没有别的进程会留下这个目录）
      try {
        const st = fs.statSync(dir)
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.rmdirSync(dir)
          continue
        }
      } catch {
        continue // 锁刚被释放，下一轮直接抢
      }
      if (Date.now() >= deadline) {
        return opts.allowUnlocked === false
          ? { locked: false, reason: `等待选题库写锁超时（${timeoutMs}ms）` }
          : {
              locked: false,
              degraded: true,
              reason: `等待选题库写锁超时（${timeoutMs}ms），已降级为无锁写入`,
            }
      }
      const wait = Date.now() + LOCK_POLL_MS
      while (Date.now() < wait) {
        /* 忙等极短时间：Node 没有同步 sleep，而读—改—写必须在同步块里完成 */
      }
    }
  }
}

// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
export function releasePoolLock(dir) {
  try {
    fs.rmdirSync(dir)
  } catch {
    /* 已经没了就算了 */
  }
}

/**
 * 在锁里执行一次读—改—写。
 * @template T
 * @param {string} dir
 * @param {(info: {locked: boolean, degraded?: boolean, reason?: string}) => T} fn
 * @param {{timeoutMs?: number, staleMs?: number}} [opts]
 * @returns {T}
 */
export function withPoolLock(dir, fn, opts = {}) {
  const info = acquirePoolLock(dir, opts)
  try {
    return fn(info)
  } finally {
    if (info.locked) releasePoolLock(dir)
  }
}

// ─────────────────────────── 合并规则（upsert）───────────────────────────

/**
 * **纯函数**：算出这次 upsert 之后选题库该长什么样（不碰磁盘）。
 *
 * 规则（与原项目侧脚本的历史行为逐条对齐，收敛到这一份）：
 *   · 按 `(date, slot, keyword)` 命中就地更新，未命中才追加；`rank` 按传入顺序
 *   · **绝不移除**同日同 slot 的其它条目；条目数只许增不许减（纯函数只算，不变量由调用方复核）
 *   · 已 `generated` 的条目不降级；`articleId` 只增不清
 *   · `reason` 追加（同一条则覆盖），不丢历史原因
 *   · `manual`（一键生成分支）只写自己那一条：`id=<date>-<slot>-manual-NN`、`status=generated`
 *
 * @param {{date: string, slot: string, rows: unknown, topics?: object[],
 *          manual?: boolean, articleId?: string|null}} spec
 * @returns {{ok: boolean, problems?: string[], error?: string, added: string[],
 *            updated: string[], before: number, after: number, topics: object[]}}
 */
export function planUpsert(spec) {
  const { date, slot, rows, manual = false, articleId = null } = spec
  const base = { added: [], updated: [], before: 0, after: 0, topics: [] }
  if (!date || !slot) return { ...base, ok: false, problems: ['缺少 date 或 slot'] }
  const problems = validateRows(rows)
  if (problems.length) return { ...base, ok: false, problems }

  const topics = Array.isArray(spec.topics) ? spec.topics : []
  const same = (t) => t && t.date === date && t.slot === slot
  const before = topics.filter(same).length
  const idx = new Map()
  for (const t of topics)
    if (t && t.keyword !== undefined) idx.set(`${t.date}\u0000${t.slot}\u0000${t.keyword}`, t)
  let manualSeq = topics.filter((t) => same(t) && String(t.id || '').includes('-manual-')).length

  const added = []
  const updated = []
  rows.forEach((raw, i0) => {
    const i = i0 + 1
    const norm = normalizeRow(raw, i)
    if (!norm.row) throw new Error(norm.problem || `第 ${i} 条行形状不合法`)
    const { keyword: kw, title, score, status, reason, articleId: rowArticle } = norm.row
    const key = `${date}\u0000${slot}\u0000${kw}`
    const hit = idx.get(key)
    if (!hit) {
      let id
      if (manual) {
        manualSeq += 1
        id = `${date}-${slot}-manual-${String(manualSeq).padStart(2, '0')}`
      } else {
        id = `${date}-${slot}-${String(i).padStart(2, '0')}`
      }
      const row = {
        id,
        date,
        slot,
        keyword: kw,
        title: title || '',
        topicScore: score,
        rank: i,
        status: manual ? 'generated' : status,
        reason: reason || '',
        articleId: manual ? articleId : rowArticle,
        createdAt: `${date}T00:00:00.000Z`,
      }
      topics.push(row)
      idx.set(key, row)
      added.push(kw)
      return
    }
    const oldReason = hit.reason || ''
    if (score !== null && score !== undefined) hit.topicScore = score
    hit.rank = i
    hit.status = manual ? 'generated' : hit.status === 'generated' ? hit.status : status
    if (reason) hit.reason = !oldReason || oldReason === reason ? reason : `${reason}；${oldReason}`
    if (articleId || rowArticle) hit.articleId = articleId || rowArticle
    updated.push(kw)
  })

  const after = topics.filter(same).length
  if (after < before) {
    return {
      ...base,
      topics,
      before,
      after,
      ok: false,
      error: `拒绝写入：会把 ${date}/${slot} 的条目从 ${before} 减到 ${after}（upsert 不允许删除）`,
    }
  }
  return { ok: true, added, updated, before, after, topics }
}

/**
 * 候选入库（锁 + 读 + 合并 + 原子写）。`dryRun` 时只算不写。
 *
 * @param {{poolFile: string, date: string, slot: string, rows: unknown,
 *          manual?: boolean, articleId?: string|null, dryRun?: boolean,
 *          lockOpts?: {timeoutMs?: number, staleMs?: number}}} spec
 * @returns {{ok: boolean, problems?: string[], error?: string, added?: string[], updated?: string[],
 *            before?: number, after?: number, locked?: boolean, degraded?: boolean, lockReason?: string,
 *            dryRun?: boolean, poolFile: string}}
 */
export function upsertRows(spec) {
  const { poolFile, dryRun = false } = spec
  const out = { poolFile, dryRun }
  if (!poolFile) return { ...out, ok: false, problems: ['缺少选题库文件路径'] }
  if (!spec.date || !spec.slot) return { ...out, ok: false, problems: ['缺少 date 或 slot'] }
  const problems = validateRows(spec.rows)
  if (problems.length) return { ...out, ok: false, problems }

  const apply = (info) => {
    const read = readPoolFile(poolFile)
    if (read.error) return { ...out, ok: false, error: read.error, locked: info.locked }
    const plan = planUpsert({ ...spec, topics: read.topics })
    if (!plan.ok)
      return { ...out, ok: false, problems: plan.problems, error: plan.error, locked: info.locked }
    if (!dryRun) writePoolFile(poolFile, plan.topics, { raw: read.raw })
    return {
      ...out,
      ok: true,
      added: plan.added,
      updated: plan.updated,
      before: plan.before,
      after: plan.after,
      locked: info.locked,
      degraded: !!info.degraded,
      lockReason: info.reason,
    }
  }
  // dry-run 不写盘，没必要抢锁（也就不会因为别人在写而排队）
  if (dryRun) return apply({ locked: false })
  return withPoolLock(lockDirFor(poolFile), apply, spec.lockOpts || {})
}

// ─────────────────────────── 参数解析 ───────────────────────────

/**
 * 参数解析见 `./argv.mjs`——CLI 的 flag 语义只有一份（留存/归档等命令也要用），
 * 这里 re-export 供既有调用方（`commands/topic-pool-cli.mjs` 等）沿用。
 */
export { parseFlags } from './argv.mjs'

/**
 * 解析"这次写哪个选题库"。
 *
 * 顺序（**任何一步都不许猜**，猜错就是往别的项目的数据里写）：
 *   ① `--pool=<file>` 显式文件（维护/测试用）；
 *   ② 当前项目上下文（`--project=<id>` 由 cli.mjs 统一注入）；
 *   ③ `cwd` 落在某个已登记项目根里 → 那个项目（接入方的脚本就在项目根下跑）；
 *   ④ 本机只有一个合法项目 → 就是它（launchd 侧没有上下文）；
 *   ⑤ 否则报错，让调用方显式给 `--project`。
 *
 * @param {{pool?: string|null, cwd?: string}} [opts]
 * @returns {{poolFile: string, project: string|null, source: string} | {error: string}}
 */
export function resolvePoolTarget(opts = {}) {
  const pool = opts.pool
  if (pool) {
    const abs = path.resolve(String(pool).replace(/^~(?=$|\/)/, process.env.HOME || ''))
    return { poolFile: abs, project: null, source: 'explicit' }
  }
  const already = currentProject()
  if (already) return { poolFile: getTopicPoolFile(), project: already, source: 'context' }

  const cwd = path.resolve(opts.cwd || process.cwd())
  for (const p of listProjects()) {
    if (!p || !p.valid || !p.sourcePath) continue
    const root = path.dirname(path.dirname(path.resolve(p.sourcePath)))
    if (cwd === root || cwd.startsWith(root + path.sep)) {
      return { poolFile: withProject(p.id, () => getTopicPoolFile()), project: p.id, source: 'cwd' }
    }
  }
  const sole = soleProjectId()
  if (sole)
    return { poolFile: withProject(sole, () => getTopicPoolFile()), project: sole, source: 'sole' }
  return {
    error:
      '无法确定要写哪个项目的选题库：请用 --project=<id> 指定项目，或 --pool=<file> 指定文件' +
      `（cwd=${cwd}；本机登记的项目：${
        listProjects()
          .filter((p) => p && p.id)
          .map((p) => p.id)
          .join(', ') || '无'
      }）`,
  }
}
