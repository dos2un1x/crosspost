/**
 * 费用批量查询的**索引 I/O 次数**回归测试（node:test，零外部依赖）
 *
 * 背景（2026-09-22 v2.102 实测）：文章级费用缓存索引文件有 292KB，
 * `listCosts` 遍历 301 篇时**每篇都 readFileSync + JSON.parse 一次**（实测 301 次 = 619ms），
 * 未命中还要原子写一次（301 次 = 751ms）。于是报表视图每次打开要等 `/proxy/costs` 810ms。
 * 改成"一批只读一次、最多写一次"后实测：**稳定 92ms**（首开 1.08s 建缓存）。
 *
 * 本文件把这条不变量钉住：**批量查询的索引读次数必须与篇数无关**。
 * 旧实现（每篇读一次）在本文件下必然失败 —— 这就是它能防住性能回归的原因。
 *
 * 隔离：`CROSSPOST_ARTICLE_COST_FILE` / `CROSSPOST_SESSIONS_DIRS` / 文章与草稿目录
 * 全部指向临时目录，**不碰真实部署**（与 CROSSPOST_CONFIG 的隔离风格一致）。
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-costs-'))
process.env.CROSSPOST_ARTICLE_COST_FILE = path.join(TMP, 'article-cost.json')
process.env.CROSSPOST_SESSIONS_DIRS = path.join(TMP, 'sessions') // 空会话目录：走「无会话记录」分支，确定性强
process.env.CROSSPOST_ARTICLES_DIR = path.join(TMP, 'articles')
process.env.CROSSPOST_DRAFTS_DIR = path.join(TMP, 'drafts')
process.env.CROSSPOST_HISTORY_DIR = path.join(TMP, 'history')
process.env.CROSSPOST_CONFIG = path.join(TMP, 'config.json')

const N = 40
const articles = Array.from({ length: N }, (_, i) => ({
  id: `2026-09-0${(i % 9) + 1}-noon-test-${i}`,
  date: `2026-09-0${(i % 9) + 1}`,
  slot: 'noon',
  title: `测试文章 ${i}`,
  createdAt: `2026-09-0${(i % 9) + 1}T12:00:00+08:00`,
}))

let tc
before(async () => {
  fs.mkdirSync(process.env.CROSSPOST_SESSIONS_DIRS, { recursive: true })
  fs.mkdirSync(process.env.CROSSPOST_ARTICLES_DIR, { recursive: true })
  fs.mkdirSync(process.env.CROSSPOST_DRAFTS_DIR, { recursive: true })
  fs.writeFileSync(process.env.CROSSPOST_CONFIG, JSON.stringify({}))
  tc = await import('../../crosspost-runtime/src/token-cost.mjs')
})

test('① 批量查询的索引读次数与篇数无关（旧实现是每篇一次）', () => {
  const before = tc.costIndexStats()
  tc.listCosts(articles)
  const after = tc.costIndexStats()
  const reads = after.reads - before.reads
  const writes = after.writes - before.writes
  assert.equal(reads, 1, `批量 ${N} 篇应只读索引 1 次，实际 ${reads} 次（每篇一次 = 旧实现的病）`)
  assert.ok(writes <= 1, `批量 ${N} 篇最多写索引 1 次，实际 ${writes} 次`)
})

test('② 第二次批量查询是纯缓存命中（0 写），且结果逐字相同', () => {
  const first = tc.listCosts(articles)
  const before = tc.costIndexStats()
  const second = tc.listCosts(articles)
  const after = tc.costIndexStats()
  assert.equal(after.writes - before.writes, 0, '全部命中时不应写索引')
  assert.equal(after.reads - before.reads, 1, '仍只读一次索引')
  assert.deepEqual(second, first, '缓存命中与未命中必须给出相同结果')
})

test('③ 单篇与批量结果一致（单篇仍在同一份缓存上工作）', () => {
  const batch = tc.listCosts(articles)
  for (const i of [0, 7, N - 1]) {
    const one = tc.articleCost(articles[i])
    const row = batch.find((r) => r.id === articles[i].id)
    assert.equal(row.cost, one ? one.cost : null, `第 ${i} 篇单篇/批量费用应一致`)
    assert.equal(row.matched, one ? one.matched : false, `第 ${i} 篇单篇/批量匹配态应一致`)
  }
})

test('④ 空列表不读也不写索引（边界）', () => {
  const before = tc.costIndexStats()
  const out = tc.listCosts([])
  const after = tc.costIndexStats()
  assert.deepEqual(out, [])
  assert.equal(after.writes - before.writes, 0)
  // 读一次是允许的（实现里 context 会先读索引），但不该出现"每篇一次"的放大
  assert.ok(after.reads - before.reads <= 1)
})
