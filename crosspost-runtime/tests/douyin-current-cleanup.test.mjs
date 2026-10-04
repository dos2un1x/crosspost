/**
 * 抖音"当前草稿箱"是单槽，推新的要清掉旧的 —— **包括归档/留存记录**（v2.68）
 *
 * ## 修的什么
 *
 * `runPublishDouyin()` 成功后会把其它记录上的 `douyinCurrent`/`douyinPushedAt` 清掉
 * （抖音草稿箱只有一个槽，推新内容覆盖旧的）。原实现遍历 `scanAndList()`，
 * 而它**顶层模式刻意排除** `archived`/`retained` 状态与 archive/rejected/risk
 * 子目录 —— 于是那些记录上的指针**永远清不掉**。
 *
 * 实测（2026-09-19 本机）：全库 26 条带 `douyinCurrent`，其中 **25 条是归档/留存记录**。
 * 危害不是"数据脏"，而是 Console 用 `store.articles.find(a => a.douyinCurrent)`
 * 找"当前抖音草稿"，在归档/详情视图里就可能把 📱 角标指到一篇老文章上。
 *
 * ## 这个测试怎么保证自己不是空壳
 *
 * 第一例先断言**根因仍然成立**：`scanAndList()` 顶层模式**看不到**归档记录，
 * 而 `listRecords()` 看得到。若哪天有人在 scanAndList 里放开排除，
 * 这一例会先失败，提醒"这条修复的前提变了"。
 * 后面几例逐个覆盖四种"旧实现清不到"的形态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-douyin-current-'))
const ARTICLES = path.join(tmp, 'articles')
const DRAFTS = path.join(tmp, 'drafts')
fs.mkdirSync(ARTICLES, { recursive: true })
fs.mkdirSync(DRAFTS, { recursive: true })
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({}))

// 必须在**动态 import 之前**设好：这些模块会读它们解析目录
process.env.CROSSPOST_ARTICLES_DIR = ARTICLES
process.env.CROSSPOST_DRAFTS_DIR = DRAFTS
process.env.CROSSPOST_CONFIG = path.join(tmp, 'config.json')

const { listRecords, scanAndList } = await import('../src/articles.mjs')
const { clearOtherDouyinCurrent } = await import('../src/commands/publish.mjs')

/** 造一条记录；只有传入 douyinCurrent 时才带那对字段 */
function put(id, extra = {}) {
  const rec = {
    id,
    title: `标题-${id}`,
    slot: 'hotspot',
    date: '2099-01-01',
    status: 'draft',
    dir: null,
    history: [],
    createdAt: '2099-01-01T00:00:00.000Z',
    ...extra,
  }
  fs.writeFileSync(path.join(ARTICLES, `${id}.json`), JSON.stringify(rec, null, 2))
  return rec
}

const PUSHED = '2099-01-01-hotspot-pushed' // 刚推成功的那条，指针要保留

// 四条"旧实现清不到"的形态 + 一条顶层的（旧实现本来就能清）
put(PUSHED)
put('2099-01-01-hotspot-top', { douyinCurrent: true, douyinPushedAt: '2099-01-01T01:00:00.000Z' })
put('2099-01-01-hotspot-archived', {
  status: 'archived',
  douyinCurrent: true,
  douyinPushedAt: '2099-01-01T02:00:00.000Z',
})
put('2099-01-01-hotspot-archived-dir', {
  status: 'archived',
  dir: 'archive',
  douyinCurrent: true,
  douyinPushedAt: '2099-01-01T03:00:00.000Z',
})
put('2099-01-01-hotspot-retained', {
  status: 'retained',
  douyinCurrent: true,
  douyinPushedAt: '2099-01-01T04:00:00.000Z',
})
put('2099-01-01-hotspot-rejected-dir', {
  status: 'retained',
  dir: 'rejected',
  douyinCurrent: true,
  douyinPushedAt: '2099-01-01T05:00:00.000Z',
})

const claimants = () =>
  listRecords()
    .filter((r) => r.douyinCurrent)
    .map((r) => r.id)
    .sort()

test('前提：顶层模式看不到归档/留存记录，全量模式看得到（这条修复的根因）', () => {
  const visible = new Set(scanAndList().map((r) => r.id))
  assert.ok(visible.has('2099-01-01-hotspot-top'), '顶层记录应在 scanAndList 里')
  assert.equal(
    visible.has('2099-01-01-hotspot-archived'),
    false,
    'archived 记录**不该**出现在 scanAndList（旧实现因此清不掉它的指针）',
  )
  assert.equal(visible.has('2099-01-01-hotspot-archived-dir'), false, 'archive 子目录同理')
  assert.equal(visible.has('2099-01-01-hotspot-retained'), false, 'retained 同理')
  assert.equal(visible.has('2099-01-01-hotspot-rejected-dir'), false, 'rejected 子目录同理')

  const all = new Set(listRecords().map((r) => r.id))
  for (const id of [
    '2099-01-01-hotspot-archived',
    '2099-01-01-hotspot-archived-dir',
    '2099-01-01-hotspot-retained',
    '2099-01-01-hotspot-rejected-dir',
  ])
    assert.ok(all.has(id), `listRecords 必须看得到 ${id}`)
})

test('清理后全库只剩一个 claimant：新旧形态的过期指针全被清掉', () => {
  const cleared = clearOtherDouyinCurrent(PUSHED).sort()

  assert.deepEqual(
    cleared,
    [
      '2099-01-01-hotspot-archived',
      '2099-01-01-hotspot-archived-dir',
      '2099-01-01-hotspot-rejected-dir',
      '2099-01-01-hotspot-retained',
      '2099-01-01-hotspot-top',
    ],
    '五种形态的过期指针都要被清（含旧实现清不到的归档/留存四种）',
  )
  assert.deepEqual(claimants(), [], '此时还没有人被打上新指针 → 全库 0 个 claimant')
})

test('被清掉的记录不再带 douyinPushedAt；被推送的那条不受影响', () => {
  const archived = JSON.parse(
    fs.readFileSync(path.join(ARTICLES, '2099-01-01-hotspot-archived.json'), 'utf8'),
  )
  assert.equal(archived.douyinCurrent, undefined, '归档记录上的 douyinCurrent 必须被删掉')
  assert.equal(archived.douyinPushedAt, undefined, 'douyinPushedAt 一并删掉')
  assert.equal(archived.status, 'archived', '其它字段不动（只删这两个）')

  const pushed = JSON.parse(fs.readFileSync(path.join(ARTICLES, `${PUSHED}.json`), 'utf8'))
  assert.equal(pushed.douyinCurrent, undefined, '本次例外的那条在打标前也不该被清（它还没标）')
})

test('写回的记录不再夹带 hasFile 这个展示用字段（旧写法会落盘）', () => {
  const archived = JSON.parse(
    fs.readFileSync(path.join(ARTICLES, '2099-01-01-hotspot-archived.json'), 'utf8'),
  )
  assert.equal(
    archived.hasFile,
    undefined,
    'hasFile 是 scanAndList 输出里的展示字段，不该被写进记录（历史上有 104 条被它污染）',
  )
})

test('没有过期指针时是幂等的：再清一次不报错、也不误伤', () => {
  assert.deepEqual(clearOtherDouyinCurrent(PUSHED), [], '第二次清理应为空操作')
})
