/**
 * AI 检测快照门禁（`aiDetect.requireSnapshotOnPublish`）单测（2026-10-05）
 *
 * 这条开关的语义：打开后，`publish_article` 没带 §5.55 检测快照就**不派发**（平台与微信都不发），
 * 但仍落草稿 + 历史 + 明确原因。取向与槽位门禁一致——不静默、不抛错：宁可停在草稿态并说清原因，
 * 也不让一篇"跳过检测"的稿子带着"未执行"出门。
 *
 * 零副作用：dryRun + 沙箱草稿/记录目录 + 沙箱 config（autoPush 关闭），不触网、不写生产簿记。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-publish-ai-snapshot-'))
const DRAFTS = path.join(TMP, 'drafts')
const CFG = path.join(TMP, 'config.json')
fs.mkdirSync(DRAFTS, { recursive: true })

// env 必须在动态 import 引擎模块之前设置（引擎按 env 解析配置/数据根）
process.env.CROSSPOST_DRAFTS_DIR = DRAFTS
process.env.CROSSPOST_ARTICLES_DIR = path.join(TMP, 'articles')
process.env.CROSSPOST_HISTORY_DIR = path.join(TMP, 'history')
process.env.CROSSPOST_LOCAL_ROOT = path.join(TMP, 'local')
process.env.CROSSPOST_CONFIG = CFG
delete process.env.WECHAT_AUTO_SCHEDULED
delete process.env.WECHAT_AUTO_DRAFT_ONLY

// 沙箱 config：出厂默认 + 本用例要打开的那一个开关
const { AI_DETECT_DEFAULTS } = await import(new URL('../src/ai-detect.mjs', import.meta.url).href)
fs.writeFileSync(
  CFG,
  JSON.stringify({
    autoPush: { enabled: false, includeWechat: false },
    platforms: { default: ['zhihu'] },
    notify: { enabled: false, channel: 'off' },
    aiDetect: { ...AI_DETECT_DEFAULTS, requireSnapshotOnPublish: true },
  }),
)

const { runPublishArticle, buildPublishNotifyCopy } = await import(
  new URL('../src/commands/publish.mjs', import.meta.url).href
)

// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
function writeDraft(name, { title = '快照门禁测试' } = {}) {
  const file = path.join(DRAFTS, name)
  fs.writeFileSync(file, `---\ntitle: ${title}\nscore: 90\n---\n\n正文内容\n\n第二段。\n`)
  return file
}

test('快照门禁：开关打开 + 没带快照 ⇒ 不派发（仍落草稿并给出原因）', async () => {
  const file = writeDraft('2026-10-05-hotspot-ai-snapshot-missing.md')
  const r = await runPublishArticle({
    file,
    dryRun: true,
    manual: true, // 人工来源勾选即执行——派发本来会打开，只有快照门禁能拦住
    wechat: true,
    platforms: ['zhihu'],
    allowDouyin: false,
  })
  assert.equal(r.error, undefined, JSON.stringify(r.error))
  assert.equal(r.dispatch, 'skipped', JSON.stringify(r))
  assert.match(r.skipReason || '', /缺少 AI 检测快照/)
  // 被拦住的是"派发"，不是"稿子"：草稿必须留在原地（可补上快照后重试）
  assert.ok(fs.existsSync(file), '门禁只拦派发，不得移动/删除草稿')
})

test('快照门禁：带了快照 ⇒ 照常派发（门禁不误伤）', async () => {
  const file = writeDraft('2026-10-05-hotspot-ai-snapshot-ok.md')
  const r = await runPublishArticle({
    file,
    dryRun: true,
    manual: true,
    wechat: true,
    platforms: ['zhihu'],
    allowDouyin: false,
    aiDetect: 'AI检测=达标(口径=bands 人工=40.0% AI特征=40.0% 疑似=20.0% 失败项=无)',
  })
  assert.equal(r.error, undefined, JSON.stringify(r.error))
  assert.equal(r.dispatch, 'dispatched', JSON.stringify(r))
  assert.ok(!r.skipReason, `已派发就不该有 skipReason：${r.skipReason}`)
})

test('通知文案：没派发时要写真实原因，不能一律说"未开启自动推送"', () => {
  const c = buildPublishNotifyCopy({
    title: 'T',
    slot: 'hotspot',
    style: 'swiss',
    score: 90,
    wechatStatus: 'skip',
    okCount: 0,
    total: 0,
    dispatchEnabled: false,
    origin: 'manual',
    wechatSkippedByReq: false,
    file: '/tmp/x.md',
    skipReason: '缺少 AI 检测快照（aiDetect.requireSnapshotOnPublish=true）',
    template: {},
  })
  assert.match(c.summaryLine, /缺少 AI 检测快照/)
  assert.match(c.footer, /缺少 AI 检测快照/)
  assert.equal(c.vars.failReason, '缺少 AI 检测快照（aiDetect.requireSnapshotOnPublish=true）')
})
