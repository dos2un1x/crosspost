// recordWriting / record_writing 单测（2026-10-10）
//
// 这条路径解决的是"产出了却没落点"：`decision`/`review` 的写入者本来只有发布器，
// 而 draft-only 链路（一键生成、定时生成）从不发布 —— §2.5 的决策行与 §5.6 的审稿行
// 于是只留在日志里，Console 抽屉那两张卡永远是空的。
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runRecordWriting } from '../src/commands/record-writing.mjs'
import { fileURLToPath } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-record-writing-'))
const DRAFTS = path.join(TMP, 'drafts')
const ARTICLES = path.join(TMP, 'articles')
fs.mkdirSync(DRAFTS, { recursive: true })
fs.mkdirSync(ARTICLES, { recursive: true })
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

const env = {
  ...process.env,
  CROSSPOST_DRAFTS_DIR: DRAFTS,
  CROSSPOST_ARTICLES_DIR: ARTICLES,
  CROSSPOST_PROJECT: '',
}

const ID = '2099-01-01-noon-record-writing'
const FILE = path.join(DRAFTS, `${ID}.md`)

function writeDraft() {
  fs.writeFileSync(FILE, '---\ntitle: 记账用例\nscore: 88\nrisk: none\n---\n\n正文一段。\n')
}

function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

/**
 * 进程内调用 `runRecordWriting(args)`，env 按用例那份切（与 spawn 时等价，断言不变）。
 *
 * 为什么：单次 spawn 引擎 ≈ 0.56s，**几乎全是依赖加载**；而下面 4 条断言的是**记录内容**，
 * 与 argv 解析无关。第 1 条继续走 CLI（spawn），守住"argv + JSON 信封"那条链。
 */
async function inProc(...args) {
  const saved = new Map()
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k])
    process.env[k] = v
  }
  try {
    return await runRecordWriting(args)
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const readRecord = () => JSON.parse(fs.readFileSync(path.join(ARTICLES, `${ID}.json`), 'utf8'))

test('recordWriting：把决策与审稿写进记录，并追加一条 writing 历史', () => {
  writeDraft()
  const DEC = '决策=主线A|理由=B|重复风险=low(避开角度:不写工具盘点)|写作指令=1) 只改被判 AI 的段'
  const REV = '审稿=90 自评=92 行动=publish issues=1(minor:表达-略修辞)'
  const r = cli(
    'recordWriting',
    `--id=${ID}`,
    `--decision=${DEC}`,
    `--review=${REV}`,
    '--note=定稿',
  )
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.recorded.id, ID)
  assert.equal(r.recorded.action, 'writing')
  const rec = readRecord()
  assert.equal(rec.decision, DEC, '决策原文照抄进记录')
  assert.equal(rec.review, REV)
  const hist = rec.history.filter((h) => h.action === 'writing')
  assert.equal(hist.length, 1)
  assert.equal(hist[0].decision, DEC)
  assert.equal(hist[0].review, REV)
  assert.equal(hist[0].note, '定稿')
  // 首次登记：createdAt 取草稿文件 mtime（供费用视图当锚点），不是"现在"
  assert.equal(rec.createdAt, fs.statSync(FILE).mtime.toISOString())
})

test('recordWriting：只给一个字段时另一个保持原值，不会被清空', async () => {
  const before = readRecord()
  const NEW_REV = '审稿=95 行动=publish 修订=1(补了过渡句)'
  const r = await inProc('recordWriting', `--id=${ID}`, `--review=${NEW_REV}`)
  assert.equal(r.ok, true, JSON.stringify(r))
  const rec = readRecord()
  assert.equal(rec.review, NEW_REV)
  assert.equal(rec.decision, before.decision, '没传 decision 就不该动它')
  // 每次调用各留一条历史（复盘要看完整轨迹）
  assert.equal(rec.history.filter((h) => h.action === 'writing').length, 2)
})

test('recordWriting：三项都不给 / 草稿不存在 → 明确报错', async () => {
  const empty = await inProc('recordWriting', `--id=${ID}`)
  assert.match(empty.error || '', /至少给一项/)
  const missing = await inProc('recordWriting', '--id=2099-01-01-noon-does-not-exist', '--note=x')
  assert.match(missing.error || '', /找不到草稿/)
})

test('recordWriting：留存目录里的草稿也能按 id 找到（跨目录兜底）', async () => {
  const rejected = path.join(DRAFTS, 'rejected')
  fs.mkdirSync(rejected, { recursive: true })
  const rid = '2099-01-02-noon-retained-one'
  fs.writeFileSync(
    path.join(rejected, `${rid}.md`),
    '---\ntitle: 留存稿\nscore: 70\n---\n\n正文。\n',
  )
  const r = await inProc('recordWriting', `--id=${rid}`, '--review=审稿=未审(§5.55 未达标)')
  assert.equal(r.ok, true, JSON.stringify(r))
  const rec = JSON.parse(fs.readFileSync(path.join(ARTICLES, `${rid}.json`), 'utf8'))
  assert.equal(rec.review, '审稿=未审(§5.55 未达标)')
})

test('recordWriting：--file 绝对路径可用，且不覆盖记录里的其它字段', async () => {
  const DEC = '决策=改用绝对路径写入'
  const r = await inProc('recordWriting', `--file=${FILE}`, `--decision=${DEC}`)
  assert.equal(r.ok, true, JSON.stringify(r))
  const rec = readRecord()
  assert.equal(rec.decision, DEC)
  assert.equal(rec.score.total, 88, '评分等既有字段必须留着')
})
