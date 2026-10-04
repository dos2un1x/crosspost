/**
 * 记录层快照缓存的**文件读次数**回归测试（node:test，零外部依赖）
 *
 * 背景（2026-09-25，容器模式实测）：留存库 / 归档库 / 报表每次打开要重读几百个小文件
 * （`/proxy/archive` = 126 md + 126 记录 + 319 记录；`/proxy/costs` = 1400+ 次），
 * 而宿主原生读一个小文件 ~0.07ms、容器里过 Docker Desktop 的 bind mount 要 ~0.5ms
 * ——同一批 522 个记录文件，容器私有 overlay 8ms、挂载路径 255ms（31×）。
 * 于是这三个模块在容器里比原生慢 6–7×（现网实测 listArchive 41ms → 265ms）。
 *
 * 改法是 `articles.mjs` 的记录快照：**以记录目录 mtime 判活**，命中快照时零文件读。
 * 本文件把这条不变量钉住：
 *   ① 预热之后，listArchive / listRetained / allCostRecords 都**不再读任何记录文件**；
 *   ② 库规模（篇数）不影响稳态读次数 —— 旧实现（每篇一次 getRecord / 每次全量 listRecords）
 *      在本文件下必然失败；
 *   ③ 外部进程写入后立刻可见（mtime 判活不能把新鲜度做丢）；
 *   ④ 写入 / 删除在本进程内立刻自洽；
 *   ⑤ `CROSSPOST_DISABLE_RECORD_CACHE=1` 回到"逐字改动前"的行为。
 *
 * 隔离：文章库 / 草稿目录 / history 全部指向临时目录，**不碰真实部署**。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { withProject } from '../src/project-context.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-record-cache-'))
const ARTICLES = path.join(TMP, 'articles')
const DRAFTS = path.join(TMP, 'drafts')
const HISTORY = path.join(TMP, 'history')
process.env.CROSSPOST_ARTICLES_DIR = ARTICLES
process.env.CROSSPOST_DRAFTS_DIR = DRAFTS
process.env.CROSSPOST_HISTORY_DIR = HISTORY
process.env.CROSSPOST_CONFIG = path.join(TMP, 'config.json')
delete process.env.CROSSPOST_DISABLE_RECORD_CACHE

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const art = await import('../src/articles.mjs')
const { listArchive, listRetained } = await import('../src/commands/publish.mjs')
const { allCostRecords } = await import('../src/commands/costs.mjs')

/** 写一条记录文件（等价于 upsertRecord 的产物，但不经过本进程的缓存） */
function writeRecordFile(id, extra = {}) {
  fs.mkdirSync(ARTICLES, { recursive: true })
  const rec = {
    id,
    title: `标题 ${id}`,
    date: id.slice(0, 10),
    slot: 'noon',
    status: 'draft',
    risk: 'unclassified',
    wechat: { status: 'none' },
    platforms: {},
    notify: { status: 'none' },
    history: [],
    createdAt: `${id.slice(0, 10)}T12:00:00+08:00`,
    updatedAt: `${id.slice(0, 10)}T12:00:00+08:00`,
    ...extra,
  }
  fs.writeFileSync(path.join(ARTICLES, `${id}.json`), JSON.stringify(rec, null, 2))
  return rec
}

/** 写一个草稿 md（frontmatter 带 title/score） */
function writeDraftFile(sub, id) {
  const dir = path.join(DRAFTS, sub)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${id}.md`), `---\ntitle: 草稿 ${id}\nscore: 88\n---\n\n正文\n`)
}

const IDS = (n) =>
  Array.from(
    { length: n },
    (_, i) => `2026-09-${String((i % 28) + 1).padStart(2, '0')}-noon-t-${i}`,
  )

before(() => {
  fs.mkdirSync(ARTICLES, { recursive: true })
  fs.mkdirSync(DRAFTS, { recursive: true })
  fs.mkdirSync(HISTORY, { recursive: true })
  fs.writeFileSync(process.env.CROSSPOST_CONFIG, JSON.stringify({}))
})

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

/** 在项目上下文里同步执行（无项目上下文时项目目录解析不到临时目录） */
function inTmp(fn) {
  return withProject('', fn)
}

/** 预热一次（建立快照）后测量下一次调用的记录读次数 */
function steadyReads(fn) {
  inTmp(fn) // 预热：全量重扫建立快照
  art.resetRecordIoStats()
  const value = inTmp(fn)
  const { reads } = art.recordIoStats()
  return { reads, value }
}

test('① 预热后：listArchive / listRetained / allCostRecords 稳态零记录读', () => {
  for (const id of IDS(12)) writeRecordFile(id, { status: 'archived' })
  for (const id of IDS(5)) writeDraftFile('archive', id)
  for (const id of ['2026-09-01-noon-low-a', '2026-09-02-risk-b']) writeDraftFile('rejected', id)
  writeDraftFile('risk', '2026-09-03-risk-c')

  const cases = [
    ['listArchive', () => listArchive().length],
    ['listRetained', () => listRetained().retained.length],
    ['allCostRecords', () => allCostRecords().length],
  ]
  for (const [name, fn] of cases) {
    const { reads, value } = steadyReads(fn)
    assert.equal(reads, 0, `${name} 稳态应 0 次记录读，实际 ${reads} 次（每篇一次 = 旧实现的病）`)
    assert.ok(value > 0, `${name} 应返回非空结果`)
  }
})

test('② 稳态读次数与库规模无关（旧实现是每篇一次）', () => {
  // 在当前 12 条记录 + 若干草稿的基础上，再加 40 条
  for (const id of IDS(40).map((x) => `${x}-big`)) writeRecordFile(id, { status: 'archived' })
  const { reads } = steadyReads(() => listArchive().length)
  assert.equal(reads, 0, `规模翻倍后稳态仍应 0 次记录读，实际 ${reads} 次`)
})

test('③ 外部进程写入后立刻可见（mtime 判活没把新鲜度做丢）', () => {
  inTmp(() => listArchive()) // 先建立快照
  const id = '2026-09-28-noon-external-writer'
  // 刻意用**另一个进程**写：这正是宿主侧项目脚本写记录的真实形态
  const r = spawnSync(
    process.execPath,
    [
      '-e',
      `require('fs').mkdirSync(process.env.CROSSPOST_ARTICLES_DIR,{recursive:true});` +
        `require('fs').writeFileSync(process.env.CROSSPOST_ARTICLES_DIR+'/${id}.json',` +
        `JSON.stringify({id:'${id}',title:'外部写入',date:'2026-09-28',slot:'noon',status:'archived',history:[],createdAt:'2026-09-28T12:00:00+08:00',updatedAt:'2026-09-28T12:00:00+08:00'}))`,
    ],
    { env: { ...process.env } },
  )
  assert.equal(r.status, 0, `外部写进程失败: ${r.stderr}`)
  const list = inTmp(() => listArchive())
  assert.ok(
    list.some((e) => e.id === id),
    '外部进程写入的归档记录必须立刻出现在 listArchive（mtime 判活失效了）',
  )
})

test('④ 本进程写入 / 删除立刻自洽', () => {
  const id = '2026-09-29-noon-cache-self'
  inTmp(() => art.upsertRecord({ id, title: '自己写的', status: 'archived', history: [] }))
  assert.equal(inTmp(() => art.getRecord(id)).title, '自己写的')
  assert.ok(inTmp(() => listArchive()).some((e) => e.id === id))

  assert.equal(
    inTmp(() => art.removeRecord(id)),
    true,
  )
  assert.equal(
    inTmp(() => art.getRecord(id)),
    null,
  )
  assert.ok(!inTmp(() => listArchive()).some((e) => e.id === id))

  // 快照返回的是浅拷贝：调用方就地改不得污染缓存
  const first = inTmp(() => art.getRecord(id))
  assert.equal(first, null)
  const anyId = inTmp(() => art.listRecords())[0].id
  inTmp(() => art.getRecord(anyId)).title = '被外部改坏'
  assert.notEqual(inTmp(() => art.getRecord(anyId)).title, '被外部改坏')
})

test('⑤ CROSSPOST_DISABLE_RECORD_CACHE=1 回到逐字改动前的读法（每篇一次）', () => {
  process.env.CROSSPOST_DISABLE_RECORD_CACHE = '1'
  try {
    art.invalidateRecordCache()
    inTmp(() => listArchive())
    art.resetRecordIoStats()
    inTmp(() => listArchive())
    const { reads } = art.recordIoStats()
    assert.ok(reads > 0, `关掉缓存后应回到"每次全量读"，实际 ${reads} 次`)
  } finally {
    delete process.env.CROSSPOST_DISABLE_RECORD_CACHE
    art.invalidateRecordCache()
  }
})

test('⑥ 非法 id（历史遗留中文文件名）仍然返回 null，不抛错', () => {
  inTmp(() => listArchive())
  // 真实部署里存在这种文件（drafts/risk/2026-08-21-noon-柯洁装弱智赢AI.md）：
  // getRecord 的 assertSafeId 在 try 内抛出并被吞，改动前后都必须返回 null
  // ——否则 /proxy/costs 会因为一条脏数据整个 500。
  assert.equal(
    inTmp(() => art.getRecord('2026-08-21-noon-柯洁装弱智赢AI')),
    null,
  )
})

test('⑦ CLI listRetained 与名单口径一致（搬迁后语义不变）', () => {
  const r = spawnSync(process.execPath, [CLI, 'listRetained'], {
    env: { ...process.env },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.ok(Array.isArray(out.retained) && out.retained.length > 0)
  assert.ok(out.retained.every((e) => e.id && e.dir && typeof e.title === 'string'))
})
