/**
 * 重推不得吃掉记录里的快照（2026-10-08）
 *
 * **症状（实测）**：在 Console 里对一篇已发布的稿子点「▶ 重推到所选平台」——它只传
 * `id/style/platforms/wechat/concurrency/manual`——之后，抽屉「记录概览」里的
 * **编辑决策 / 独立审稿 / AI 检测** 三行一起消失，记录里 `decision`/`review`/`aiDetect` 三个键
 * 直接没了（不是空值，是键不存在）。
 *
 * **根因**：发布路径是**重建**一个 record 对象再落盘（不是 patch 原记录），而这三处原本写成
 * `...(req.decision !== undefined ? { decision: req.decision } : {})` —— 注释写着"未传保持原记录"，
 * 代码干的是"未传就把键丢掉"。于是"重推"这个纯派发动作顺手删掉了写作侧留下的快照。
 *
 * **回归锁**：显式传了就用新的；没传就沿用原值。dryRun 与正式发布两条分支都要锁。
 *
 * 零副作用：沙箱草稿/记录目录 + 沙箱 config（autoPush 关闭）、不触网、不写生产簿记。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-publish-keep-snap-'))
const DRAFTS = path.join(TMP, 'drafts')
const ARTICLES = path.join(TMP, 'articles')
const CFG = path.join(TMP, 'config.json')
fs.mkdirSync(DRAFTS, { recursive: true })

// env 必须在动态 import 引擎模块之前设置（引擎按 env 解析配置/数据根）
process.env.CROSSPOST_DRAFTS_DIR = DRAFTS
process.env.CROSSPOST_ARTICLES_DIR = ARTICLES
process.env.CROSSPOST_HISTORY_DIR = path.join(TMP, 'history')
process.env.CROSSPOST_LOCAL_ROOT = path.join(TMP, 'local')
process.env.CROSSPOST_CONFIG = CFG
delete process.env.WECHAT_AUTO_SCHEDULED
delete process.env.WECHAT_AUTO_DRAFT_ONLY

// autoPush 关闭：正式发布这条路也只会落草稿（不派发、不触网），正好覆盖非 dryRun 分支
fs.writeFileSync(
  CFG,
  JSON.stringify({
    autoPush: { enabled: false, includeWechat: false },
    platforms: { default: [] },
    notify: { enabled: false, channel: 'off' },
  }),
)

const { runPublishArticle } = await import(
  new URL('../src/commands/publish.mjs', import.meta.url).href
)
const { upsertRecord, getRecord } = await import(
  new URL('../src/articles.mjs', import.meta.url).href
)

const DECISION = '决策=主线是内存构成而不是参数|理由=今日热点|重复风险=low'
const REVIEW = '审稿=90 行动=publish 修订=0 issues=0'
const AI = 'AI检测=pass(口径=labels_ai 值=0.0% 阈值=30.0% 段=0人工/0AI/5疑似 字符=1278 风格=ok)'

/** 造一篇"写作侧已经留下快照"的稿子 + 记录 */
function seed(id) {
  const file = path.join(DRAFTS, `${id}.md`)
  fs.writeFileSync(
    file,
    `---\ntitle: 快照保留测试\nscore: 90\nrisk: none\n---\n\n正文内容。\n\n第二段。\n`,
  )
  upsertRecord({
    id,
    title: '快照保留测试',
    file,
    slot: 'hotspot',
    date: '2026-10-08',
    status: 'draft',
    risk: 'none',
    score: { total: 90, at: '2026-10-08T00:00:00.000Z' },
    decision: DECISION,
    review: REVIEW,
    aiDetect: AI,
    wechat: { status: 'none' },
    platforms: {},
    notify: { status: 'none' },
    history: [{ action: 'draft-only', at: '2026-10-08T00:00:00.000Z' }],
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
  })
  return file
}

test('正式发布（非 dryRun）：没传快照 ⇒ 沿用记录里的原值，不许抹掉', async () => {
  const id = '2026-10-08-hotspot-keep-snap-live'
  const file = seed(id)
  const r = await runPublishArticle({ file, manual: false, wechat: false, platforms: [] })
  assert.equal(r.error, undefined, JSON.stringify(r.error))
  const rec = getRecord(id)
  assert.equal(rec.decision, DECISION, '重推不带 decision 时必须沿用原值')
  assert.equal(rec.review, REVIEW, '重推不带 review 时必须沿用原值')
  assert.equal(rec.aiDetect, AI, '重推不带 aiDetect 时必须沿用原值')
})

test('dryRun：同样沿用原值（渲染测试不是"清空快照"的理由）', async () => {
  const id = '2026-10-08-hotspot-keep-snap-dry'
  const file = seed(id)
  const r = await runPublishArticle({
    file,
    dryRun: true,
    manual: false,
    wechat: false,
    platforms: [],
  })
  assert.equal(r.error, undefined, JSON.stringify(r.error))
  const rec = getRecord(id)
  assert.equal(rec.decision, DECISION)
  assert.equal(rec.review, REVIEW)
  assert.equal(rec.aiDetect, AI)
})

test('显式传入时仍以新值为准（沿用 ≠ 不许覆盖）', async () => {
  const id = '2026-10-08-hotspot-keep-snap-new'
  const file = seed(id)
  const next =
    'AI检测=pass(口径=labels_ai 值=12.0% 阈值=30.0% 段=0人工/0AI/5疑似 字符=1300 风格=ok)'
  const r = await runPublishArticle({
    file,
    dryRun: true,
    manual: false,
    wechat: false,
    platforms: [],
    aiDetect: next,
  })
  assert.equal(r.error, undefined, JSON.stringify(r.error))
  const rec = getRecord(id)
  assert.equal(rec.aiDetect, next, '显式传入的新快照必须生效')
  assert.equal(rec.decision, DECISION, '未传的那两项照旧沿用')
  assert.equal(rec.review, REVIEW)
})
