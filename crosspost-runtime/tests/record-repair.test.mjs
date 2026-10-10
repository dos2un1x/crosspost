/**
 * 留存记录对账 `repairRecords`（2026-10-09）
 *
 * 背景（真实事故）：写作 agent 在 workspace-write 沙箱里执行 `retainArticle`，文件能移进
 * `drafts/rejected/`，但引擎簿记在沙箱之外 —— 写盘 EPERM，「文件走了、记录没写」。后果：
 * Console 那行没有留存原因/时间、抽屉显示「⚠ 无记录」，`verify:immutable` 把这次移动判成删除
 * （它要"内容 + 记录双证"）。
 *
 * 对账的取向必须钉死在三件事上，本文件逐条断言：
 *   ① 只信**文件系统事实**，不猜内容（原因取不到就写诚实占位，绝不编 AI 数值）；
 *   ② **默认 dry-run**，`--apply` 才写，写前备份记录原件；
 *   ③ 有过程、但描述的是**另一份产物**（同一 id 的归档/风险那一份）时**只报告不改写** ——
 *      自动写一次就会覆盖掉更晚的归档/风险处置决定。
 *
 * 沙箱：草稿/记录/localRoot/config 全在临时目录，不碰生产。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-record-repair-'))
const LOCAL = path.join(TMP, 'local')
const DRAFTS = path.join(TMP, 'drafts')
const ARTICLES = path.join(LOCAL, 'articles')
const HISTORY = path.join(TMP, 'history')
const CFG = path.join(TMP, 'config.json')
for (const d of [
  DRAFTS,
  path.join(DRAFTS, 'rejected'),
  path.join(DRAFTS, 'risk'),
  ARTICLES,
  HISTORY,
])
  fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(CFG, JSON.stringify({}, null, 2), 'utf8')

// env 必须在 import 之前设好（引擎按 env 解析数据根）
process.env.CROSSPOST_LOCAL_ROOT = LOCAL
process.env.CROSSPOST_CONFIG = CFG
process.env.CROSSPOST_DRAFTS_DIR = DRAFTS
process.env.CROSSPOST_ARTICLES_DIR = ARTICLES
process.env.CROSSPOST_HISTORY_DIR = HISTORY
delete process.env.CROSSPOST_PROJECT
delete process.env.CROSSPOST_TOPIC_POOL

const { planRecordRepair, applyRecordRepair, reconcileRecords } = await import(
  new URL('../src/record-repair.mjs', import.meta.url).href
)
const { ensureDraftRecord, getRecord, parseDraftFile, upsertRecord } = await import(
  new URL('../src/articles.mjs', import.meta.url).href
)

/** 造一篇"已在留存库、记录缺失/残缺"的稿子 */
function writeRetained(id, { dir = 'rejected', score = 90, at = null } = {}) {
  const file = path.join(DRAFTS, dir, `${id}.md`)
  fs.writeFileSync(file, `---\ntitle: 测试稿 ${id}\nscore: ${score}\nrisk: none\n---\n\n正文。\n`)
  if (at) fs.utimesSync(file, at, at)
  return file
}

const recordOf = (id) => JSON.parse(fs.readFileSync(path.join(ARTICLES, `${id}.json`), 'utf8'))
// 选题库读的是 `<localRoot>/history/topic-pool.json`（paths.mjs 的默认；不是 CROSSPOST_HISTORY_DIR）
const POOL = path.join(LOCAL, 'history', 'topic-pool.json')
fs.mkdirSync(path.dirname(POOL), { recursive: true })
const writePool = (rows) => fs.writeFileSync(POOL, JSON.stringify({ topics: rows }, null, 2))
const cleanPool = () => fs.rmSync(POOL, { force: true })

test('无记录 + 文件在留存库 ⇒ create；apply 后 status/dir/原因/时间齐全', () => {
  cleanPool()
  const id = '2026-10-09-hotspot-repair-create'
  const file = writeRetained(id)
  const mtime = new Date('2026-10-09T13:57:00.000Z')
  fs.utimesSync(file, mtime, mtime)

  const plan = planRecordRepair()
  const item = plan.items.find((i) => i.id === id)
  assert.ok(item, JSON.stringify(plan.items))
  assert.equal(item.action, 'create')
  assert.equal(item.reasonSource, 'placeholder')
  assert.match(item.reason, /对账补写：留存原因见 wechat-auto\/logs\/run-hotspot-2026-10-09/)

  const res = applyRecordRepair(plan)
  assert.equal(res.ok, true)
  assert.ok(fs.existsSync(res.backupRoot), '备份目录应已建')
  const rec = recordOf(id)
  assert.equal(rec.status, 'retained')
  assert.equal(rec.retainedDir, 'rejected')
  assert.equal(rec.dir, 'rejected')
  assert.equal(rec.file, file)
  assert.match(rec.retainedReason, /对账补写/)
  const entry = (rec.history || []).find((h) => h.action === 'retain')
  assert.equal(entry.source, 'reconciled')
  // 时间取**文件 mtime**（留存是过去发生的，写"现在"会把时间线说成假的）
  assert.equal(entry.at, mtime.toISOString())
})

test('空骨架记录（有记录、无 history、status=draft）⇒ fix（正是 2026-10-09 的形状）', () => {
  cleanPool()
  const id = '2026-10-09-hotspot2-repair-skeleton'
  const file = writeRetained(id)
  // 先按 frontmatter 登记一条骨架 —— 与"文件已留存、记录写盘失败"后的现场一致
  ensureDraftRecord(parseDraftFile(file))
  assert.equal(recordOf(id).status, 'draft')
  assert.deepEqual(recordOf(id).history, [])

  const plan = planRecordRepair()
  const item = plan.items.find((i) => i.id === id)
  assert.equal(item.action, 'fix')
  applyRecordRepair(plan)
  const rec = recordOf(id)
  assert.equal(rec.status, 'retained')
  assert.equal(rec.retainedDir, 'rejected')
  assert.equal((rec.history || []).length, 1)
})

test('原因优先取选题库（articleId 精确命中）；标记串「Console 一键生成」当空处理', () => {
  const id = '2026-10-09-noon-repair-pool'
  writeRetained(id)
  writePool([
    {
      id: 'x',
      date: '2026-10-09',
      slot: 'noon',
      keyword: 'kw',
      articleId: id,
      status: 'generated',
      reason: 'AI检测未达标(AI特征100.0%>30%),已留存drafts/rejected/未推送',
    },
    {
      id: 'y',
      date: '2026-10-09',
      slot: 'noon',
      keyword: 'kw2',
      articleId: '2026-10-09-noon-repair-marker',
      status: 'generated',
      reason: 'Console 一键生成',
    },
  ])
  writeRetained('2026-10-09-noon-repair-marker')

  const plan = planRecordRepair()
  const a = plan.items.find((i) => i.id === id)
  assert.equal(a.reasonSource, 'pool')
  assert.match(a.reason, /AI特征100\.0%>30%/)

  const b = plan.items.find((i) => i.id === '2026-10-09-noon-repair-marker')
  assert.equal(b.reasonSource, 'placeholder', '回填标记串不是留存原因')
  cleanPool()
})

test('有过程但描述的是另一份产物 ⇒ 只报 conflict，绝不自动改写', () => {
  cleanPool()
  const id = '2026-10-09-hotspot-repair-conflict'
  const file = writeRetained(id)
  const rec = ensureDraftRecord(parseDraftFile(file))
  rec.status = 'archived'
  rec.dir = 'archive'
  rec.file = path.join(DRAFTS, 'archive', `${id}.md`)
  rec.history = [{ action: 'archive', at: '2026-10-09T10:00:00.000Z' }]
  upsertRecord(rec)
  const before = JSON.stringify(recordOf(id))

  const plan = planRecordRepair()
  assert.equal(
    plan.items.some((i) => i.id === id),
    false,
    '不该进待补清单',
  )
  const c = plan.conflicts.find((x) => x.id === id)
  assert.ok(c, JSON.stringify(plan.conflicts))
  assert.equal(c.recordStatus, 'archived')
  applyRecordRepair(plan)
  assert.equal(JSON.stringify(recordOf(id)), before, '冲突项一个字节都不许改')
})

test('幂等：补完再跑计划为空；dry-run 一个字节都不写', () => {
  cleanPool()
  const id = '2026-10-09-tips-repair-idempotent'
  writeRetained(id)

  const dry = reconcileRecords({ apply: false })
  assert.ok(dry.items.some((i) => i.id === id))
  assert.equal(fs.existsSync(path.join(ARTICLES, `${id}.json`)), false, 'dry-run 不得写盘')

  const applied = reconcileRecords({ apply: true })
  assert.equal(applied.applied.length >= 1, true)
  const again = reconcileRecords({ apply: true })
  assert.equal(
    again.items.some((i) => i.id === id),
    false,
    '第二次应为空计划',
  )
  assert.equal(again.applied.length, 0)
  assert.equal(recordOf(id).status, 'retained')
  assert.equal((recordOf(id).history || []).length, 1, '幂等：不许重复追加 history')
})

test('draftIds 限定：流水线收尾只查刚跑的那一篇', () => {
  cleanPool()
  writeRetained('2026-10-09-evening-repair-scoped-a')
  writeRetained('2026-10-09-evening-repair-scoped-b')
  const plan = planRecordRepair({ draftIds: ['2026-10-09-evening-repair-scoped-a'] })
  assert.deepEqual(
    plan.items.map((i) => i.id),
    ['2026-10-09-evening-repair-scoped-a'],
  )
  assert.equal(getRecord('2026-10-09-evening-repair-scoped-b'), null)
})

// author: dos2un1x · repo: https://github.com/dos2un1x/crosspost
