// 记录快照竞态回归测试（2026-11-01 事故）
//
// ## 事故
//
// Console 里「选题库 → 一键生成」出来的三篇稿子，抽屉的「记录概览」全都只有
// 「⚠ 无生成/发布记录」：`history: []`、没有 `aiDetect`、没有 `decision`/`review`。
// 而写作侧的日志与 MCP 回执都写着 `record_writing` **成功**（返回 `recorded.id`）。
//
// ## 根因（两个缺陷叠加）
//
// ① `rescan()` 的判活 mtime 是在**读完目录之后**取的。另一个进程（MCP 记账）恰好在
//    「读完列表、还没取 mtime」之间落盘时，快照就变成"列表是旧的、mtime 是新的"——
//    它**自称新鲜**，于是这份旧列表被一直复用下去。
// ② `scanAndList()` 只凭快照判断"这篇有没有记录"。快照里没有 → 它直接按 frontmatter
//    造一条空骨架并 `upsertRecord()` 落盘，把别的进程刚写好的过程记录整个覆盖掉。
//
// 后果是"看着像没生成过"，而实际上决策 / 审稿 / AI 检测都产出过。
//
// ## 本文件钉住的三件事
//
//   ① 重扫跨过外部写入后，快照必须自我作废（下一次读取要重新扫盘）；
//   ② `scanAndList()` 要写回（登记骨架 / 回填评分）时**以磁盘为准**，不得拿过期副本写回；
//   ③ `upsertRecord()` 层再加一道：history **只增不减**——任何持有过期副本的写入方都
//      抹不掉别人追加的过程。
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-record-race-'))
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }))

const DRAFTS = path.join(TMP, 'drafts')
const ARTICLES = path.join(TMP, 'articles')
// 三个目录全部隔离：articles/ 记录、drafts/ 草稿、history/ 编辑记忆（别碰真实部署）
process.env.CROSSPOST_ARTICLES_DIR = ARTICLES
process.env.CROSSPOST_DRAFTS_DIR = DRAFTS
process.env.CROSSPOST_HISTORY_DIR = path.join(TMP, 'history')

const art = await import(new URL('../src/articles.mjs', import.meta.url).href)

const recFile = (id) => path.join(ARTICLES, `${id}.json`)
const readRec = (id) => JSON.parse(fs.readFileSync(recFile(id), 'utf8'))

/** 写一篇草稿（可选带 frontmatter 评分） */
function writeDraft(id, score = null) {
  fs.mkdirSync(DRAFTS, { recursive: true })
  const fm = ['---', `title: 竞态测试 ${id}`]
  if (score !== null) fm.push(`score: ${score}`)
  fm.push('---', '', '正文', '')
  const file = path.join(DRAFTS, `${id}.md`)
  fs.writeFileSync(file, fm.join('\n'))
  return file
}

/** 绕过快照，直接往磁盘落一条记录（模拟**另一个进程**的写入） */
function writeRecordDirect(id, rec) {
  fs.mkdirSync(ARTICLES, { recursive: true })
  fs.writeFileSync(recFile(id), JSON.stringify(rec, null, 2))
}

/** 外部写入方（MCP 记账）在这个时刻写下的记录：有 AI 检测、有决策，但还没有评分 */
function externalRecord(id, file) {
  return {
    id,
    title: `竞态测试 ${id}`,
    file,
    dir: null,
    slot: 'hotspot',
    date: '2026-11-01',
    style: null,
    status: 'draft',
    risk: 'none',
    wechat: { status: 'none' },
    platforms: {},
    notify: { status: 'none' },
    aiDetect: 'AI检测=达标 · AI特征 16.7% < 50.0% · 片段 5人工/1疑似/0AI · 1410字 · 风格 正常',
    decision: '决策=主线：不是新开池子，而是把日常聊天塞进早已共用的池子',
    review: '审稿=89 自评=91 行动=publish issues=2(minor:表达-首段；minor:标题)',
    history: [
      { action: 'ai-detect', verdict: 'pass', at: '2026-11-01T12:22:16.000Z' },
      { action: 'writing', decision: '决策=主线：不是新开池子', at: '2026-11-01T12:22:54.000Z' },
      { action: 'writing', review: '审稿=89 行动=publish', at: '2026-11-01T12:22:54.500Z' },
    ],
    createdAt: '2026-11-01T12:20:00.000Z',
    updatedAt: '2026-11-01T12:22:54.500Z',
  }
}

/**
 * 复刻事故时序：在**重扫读完记录目录、还没取 mtime** 的那一刻，让另一个进程落盘。
 *
 * 用打桩的 `fs.readdirSync` 注入，而不是靠真实竞态——否则这个用例要么跑不到窗口里
 * （永远绿），要么偶发红。注入点必须命中，调用方用返回的 `injected` 断言守着这一点。
 *
 * `run` 是"这次要在竞态里做的那一件事"（建快照 / `scanAndList`）；每次注入前都先
 * 作废快照，保证真的走到了扫盘（否则会复用上一个用例留下的快照，注入点碰不到）。
 */
function withConcurrentWrite(id, file, run) {
  fs.mkdirSync(ARTICLES, { recursive: true })
  art.invalidateRecordCache()
  const realReaddir = fs.readdirSync
  let injected = false
  fs.readdirSync = function patchedReaddir(p, ...rest) {
    const out = realReaddir.call(fs, p, ...rest)
    if (!injected && path.resolve(String(p)) === path.resolve(ARTICLES)) {
      injected = true
      writeRecordDirect(id, externalRecord(id, file))
    }
    return out
  }
  try {
    return { result: run(), injected }
  } finally {
    fs.readdirSync = realReaddir
  }
}

test('重扫跨过外部写入：scanAndList 不得把已有过程记录扫成空骨架', () => {
  const id = '2026-11-01-hotspot-race-a'
  const file = writeDraft(id, 91) // 草稿有评分、记录还没回填 —— 正是回填写回的那一步
  assert.equal(fs.existsSync(recFile(id)), false, '前置：此刻磁盘上还没有这条记录')

  const { result: list, injected } = withConcurrentWrite(id, file, () => art.scanAndList())
  assert.equal(injected, true, '注入点没命中 → 这个用例什么都没测到')

  const row = list.find((r) => r.id === id)
  assert.ok(row, '草稿必须出现在文章列表里')
  assert.equal(
    row.decision,
    externalRecord(id, file).decision,
    '列表行必须是磁盘上那条记录；拿过期快照重建骨架就等于丢掉决策',
  )
  assert.equal(row.recordHealth, 'ok', '有过程记录就不能再报「无生成/发布记录」')

  const saved = readRec(id)
  assert.equal(
    saved.history.length,
    3,
    `history 被抹掉了：${JSON.stringify(saved.history?.map((h) => h.action))}`,
  )
  assert.ok(saved.aiDetect, 'AI 检测快照不能被覆盖掉')
  assert.equal(saved.score?.total, 91, '评分照常从 frontmatter 回填（这次写入是合法的）')
})

test('重扫跨过外部写入后，快照必须自我作废（下一次读取重新扫盘）', () => {
  const id = '2026-11-01-hotspot-race-b'
  const file = writeDraft(id)

  // 只建快照、不登记草稿：这样"下一次读取"不会被别的写入掩盖
  const { injected } = withConcurrentWrite(id, file, () => art.listRecords())
  assert.equal(injected, true, '注入点没命中 → 这个用例什么都没测到')

  // 竞态窗口里生成的快照"自称新鲜"是这次的根因：它必须在下一次读取时判定为过期
  const before = art.recordIoStats().scans
  const list = art.listRecords()
  assert.equal(
    art.recordIoStats().scans,
    before + 1,
    '快照来自竞态窗口 → 下一次快照调用必须重扫（否则旧列表会被当成新事实一直用下去）',
  )
  assert.ok(
    list.some((r) => r.id === id),
    '重扫之后必须看得见外部写入的记录',
  )
})

test('upsertRecord：history 只增不减（过期副本不得抹掉别人追加的过程）', () => {
  const id = '2026-11-01-hotspot-race-c'
  const file = writeDraft(id)
  const ext = externalRecord(id, file)
  writeRecordDirect(id, ext)
  art.invalidateRecordCache()
  assert.equal(art.getRecord(id).history.length, 3, '前置：磁盘上有 3 条过程')

  // 模拟一个持有"过期骨架"的写入方（例如另一个 worker 先扫到了空记录）
  art.upsertRecord({
    id,
    title: ext.title,
    file,
    slot: 'hotspot',
    date: '2026-11-01',
    status: 'draft',
    risk: 'none',
    wechat: { status: 'none' },
    platforms: {},
    notify: { status: 'none' },
    history: [],
    createdAt: ext.createdAt,
    updatedAt: ext.updatedAt,
  })

  const saved = readRec(id)
  assert.equal(
    saved.history.length,
    3,
    `history 只该变长：实际 ${JSON.stringify(saved.history?.map((h) => h.action))}`,
  )
  // 这一层只守 history（唯一确定"只增不减"的字段）；整条记录以磁盘为准的那道闸在
  // `scanAndList()` 的写回路径上（上一个用例断言 aiDetect/decision 不被清掉）。
})
