/**
 * 选题库 CLI（`topicPoolUpsert` / `topicPoolValidate` / `topicPoolShow`）。
 *
 * 这三个方法是**接入方写入器的唯一入口**：项目侧的 `topic_pool_upsert.py` 之类只做参数转发，
 * 形状校验、合并规则、写锁与原子写全在 `../topic-pool.mjs` 里，且只此一份（见那里的长注释）。
 *
 * 用法：
 *   node cli.mjs topicPoolUpsert   --date=2026-10-04 --slot=hotspot \
 *     --json='[["<kw>","",87,"rejected","<原因>"]]' [--manual] [--article-id=…] [--project=…] [--pool=…] [--dry-run]
 *   node cli.mjs topicPoolValidate --json='[[…]]'          # 只校验形状，不碰磁盘
 *   node cli.mjs topicPoolShow     [--project=…] [--pool=…] # 只读：路径 + 各状态计数
 *
 * 失败语义：**throw**（CLI 退出码 1），不是 `{error}` 对象——写坏数据必须让流水线当场停住。
 */
import {
  parseFlags,
  planUpsert,
  readPoolFile,
  resolvePoolTarget,
  upsertRows,
  validateRows,
} from '../topic-pool.mjs'

const ROW_HINT =
  '每行应为 [keyword, title, score, status, reason, articleId(可选)]；' +
  '落选也要给空 title，例如：["<kw>","",87,"rejected","<原因>"]'

/** 取候选 JSON（`--json=<数组>`），解析失败即拒绝 */
function jsonRows(flags) {
  const raw = flags.json
  if (raw === undefined || raw === true) throw new Error('缺少 --json=<候选数组 JSON>')
  try {
    return JSON.parse(String(raw))
  } catch (e) {
    throw new Error(`--json 不是合法 JSON：${e.message}`)
  }
}

/** 解析目标选题库（`--pool` 优先，否则按项目上下文 / cwd / 唯一项目） */
function targetOf(flags) {
  const t = resolvePoolTarget({ pool: typeof flags.pool === 'string' ? flags.pool : null })
  if (t.error) throw new Error(t.error)
  return t
}

/** 把校验问题拼成"人能照着改"的一句话 */
function rejectMessage(problems, extra) {
  const lines = [...(problems || []), ...(extra ? [extra] : [])]
  return `拒绝写入（本次一个字节都没落盘）：\n  · ${lines.join('\n  · ')}\n${ROW_HINT}`
}

/** upsert：写入候选（dry-run 只算不写） */
export function runTopicPoolUpsert(args) {
  const flags = parseFlags(args, { booleans: ['manual', 'dry-run'] })
  const rows = jsonRows(flags)
  const t = targetOf(flags)
  const r = upsertRows({
    poolFile: t.poolFile,
    date: typeof flags.date === 'string' ? flags.date : '',
    slot: typeof flags.slot === 'string' ? flags.slot : '',
    rows,
    manual: flags.manual === true,
    articleId: typeof flags['article-id'] === 'string' ? flags['article-id'] : null,
    dryRun: flags['dry-run'] === true,
  })
  if (!r.ok) throw new Error(rejectMessage(r.problems, r.error))
  return {
    ok: true,
    poolFile: r.poolFile,
    project: t.project,
    targetSource: t.source,
    dryRun: !!r.dryRun,
    added: r.added,
    updated: r.updated,
    before: r.before,
    after: r.after,
    locked: r.locked,
    degraded: r.degraded || false,
    ...(r.lockReason ? { lockReason: r.lockReason } : {}),
  }
}

/** validate：只校验形状（项目侧可以在写之前先问一句） */
export function runTopicPoolValidate(args) {
  const flags = parseFlags(args, { booleans: ['manual', 'dry-run'] })
  const rows = jsonRows(flags)
  const problems = validateRows(rows)
  if (problems.length) throw new Error(rejectMessage(problems))
  return { ok: true, count: rows.length, statuses: [...new Set(rows.map((r) => r[3]))].sort() }
}

/** show：只读观测（路径 + 各状态计数 + 最近一天各 slot 的条数） */
export function runTopicPoolShow(args) {
  const flags = parseFlags(args, { booleans: ['manual', 'dry-run'] })
  const t = targetOf(flags)
  const read = readPoolFile(t.poolFile)
  const counts = { adopted: 0, generated: 0, rejected: 0, other: 0 }
  for (const row of read.topics) {
    const s = row && row.status
    if (s === 'adopted' || s === 'generated' || s === 'rejected') counts[s] += 1
    else counts.other += 1
  }
  const dates = read.topics
    .map((r) => r && r.date)
    .filter(Boolean)
    .sort()
  const latest = dates.length ? dates[dates.length - 1] : null
  const bySlot = latest
    ? read.topics
        .filter((r) => r && r.date === latest)
        .reduce((acc, r) => {
          acc[r.slot] = (acc[r.slot] || 0) + 1
          return acc
        }, {})
    : {}
  return {
    ok: true,
    poolFile: t.poolFile,
    project: t.project,
    targetSource: t.source,
    existed: read.existed,
    error: read.error,
    total: read.topics.length,
    counts,
    latestDate: latest,
    bySlot,
  }
}

/** dry-run 计划（给测试与"先看看会写什么"用；不写盘） */
export function planForTest({ poolFile, date, slot, rows, manual, articleId }) {
  const read = readPoolFile(poolFile)
  return planUpsert({ date, slot, rows, manual, articleId, topics: read.topics })
}
