// publish-origin.mjs 单元测试（node:test，纯函数无 IO）
// 背景：2026-09-12 回归——MCP 层硬编码 manual:true 使「生成后自动推送」开关在定时链路上被绕过。
// 本测试锁定来源判定与派发真值表。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  resolvePublishOrigin,
  resolveDispatch,
  originIsManual,
  lowLevelPublishBlocked,
  lowLevelBlockReason,
  LOW_LEVEL_PUBLISH_TOOLS,
} = await import(new URL('../src/publish-origin.mjs', import.meta.url).href)

// ── 来源判定：只认 shell 注入的 '1'，AI 无法用其他值伪装 ──
test('resolvePublishOrigin：无标记 = manual（交互式会话/CLI/Console）', () => {
  assert.equal(resolvePublishOrigin({}), 'manual')
  // 默认参数走真实 process.env：只要求返回合法枚举，不断言具体值（测试进程 env 不可控）
  assert.ok(['manual', 'scheduled', 'draft-only'].includes(resolvePublishOrigin(undefined)))
})

test('resolvePublishOrigin：WECHAT_AUTO_SCHEDULED=1 = scheduled（定时链路）', () => {
  assert.equal(resolvePublishOrigin({ WECHAT_AUTO_SCHEDULED: '1' }), 'scheduled')
})

test('resolvePublishOrigin：WECHAT_AUTO_DRAFT_ONLY=1 = draft-only，且优先于 scheduled', () => {
  assert.equal(resolvePublishOrigin({ WECHAT_AUTO_DRAFT_ONLY: '1' }), 'draft-only')
  assert.equal(
    resolvePublishOrigin({ WECHAT_AUTO_DRAFT_ONLY: '1', WECHAT_AUTO_SCHEDULED: '1' }),
    'draft-only',
  )
})

test('resolvePublishOrigin：非 "1" 值不触发（true/yes/0 均为 manual）', () => {
  for (const v of ['0', 'true', 'yes', '', ' 1']) {
    assert.equal(resolvePublishOrigin({ WECHAT_AUTO_SCHEDULED: v }), 'manual', `值=${v}`)
    assert.equal(resolvePublishOrigin({ WECHAT_AUTO_DRAFT_ONLY: v }), 'manual', `值=${v}`)
  }
})

test('originIsManual：仅 manual 为人工来源', () => {
  assert.equal(originIsManual('manual'), true)
  assert.equal(originIsManual('scheduled'), false)
  assert.equal(originIsManual('draft-only'), false)
})

// ── 派发真值表 ──
const base = { autoPushEnabled: false, autoPushIncludeWechat: false }

test('派发：定时链路 + 开关关闭 ⇒ 恒不派发（即使带 manual/allowDouyin/force）', () => {
  for (const extra of [
    {},
    { manual: true },
    { allowDouyin: true },
    { force: true },
    { manual: true, allowDouyin: true, force: true },
  ]) {
    const d = resolveDispatch({ ...base, origin: 'scheduled', ...extra })
    assert.equal(d.manualPush, false, JSON.stringify(extra))
    assert.equal(d.dispatchEnabled, false, JSON.stringify(extra))
    assert.equal(d.wantWechat, false, JSON.stringify(extra))
    assert.match(d.skipReason || '', /生成后自动推送已关闭/)
    assert.match(d.skipReason || '', /定时链路/)
  }
})

test('派发：定时链路 + 开关开启（含微信）⇒ 正常派发', () => {
  const d = resolveDispatch({
    autoPushEnabled: true,
    autoPushIncludeWechat: true,
    origin: 'scheduled',
  })
  assert.equal(d.dispatchEnabled, true)
  assert.equal(d.manualPush, false)
  assert.equal(d.wantWechat, true)
  assert.equal(d.skipReason, null)
})

test('派发：开关开启但未勾含微信 ⇒ 平台派发、微信不派发', () => {
  const d = resolveDispatch({
    autoPushEnabled: true,
    autoPushIncludeWechat: false,
    origin: 'scheduled',
  })
  assert.equal(d.dispatchEnabled, true)
  assert.equal(d.wantWechat, false)
})

test('派发：人工来源 + 开关关闭 ⇒ manual/allowDouyin/force 均可派发（Console 手动通道语义）', () => {
  for (const extra of [{ manual: true }, { allowDouyin: true }, { force: true }]) {
    const d = resolveDispatch({ ...base, origin: 'manual', ...extra })
    assert.equal(d.manualPush, true, JSON.stringify(extra))
    assert.equal(d.dispatchEnabled, true, JSON.stringify(extra))
    assert.equal(d.wantWechat, true, JSON.stringify(extra))
    assert.equal(d.skipReason, null)
  }
})

test('派发：人工来源但无任何手动标记 + 开关关闭 ⇒ 仅落草稿（09-11 之前的老行为）', () => {
  const d = resolveDispatch({ ...base, origin: 'manual' })
  assert.equal(d.manualPush, false)
  assert.equal(d.dispatchEnabled, false)
  assert.equal(d.wantWechat, false)
  assert.equal(d.skipReason, '生成后自动推送已关闭')
})

test('派发：wechat:false 时不派发微信（人工豁免也不覆盖显式 false）', () => {
  const d = resolveDispatch({ ...base, origin: 'manual', manual: true, wechat: false })
  assert.equal(d.dispatchEnabled, true)
  assert.equal(d.wantWechat, false)
})

test('派发：origin 缺省视为 manual', () => {
  const d = resolveDispatch({ autoPushEnabled: false, manual: true })
  assert.equal(d.origin, 'manual')
  assert.equal(d.dispatchEnabled, true)
})

// ── 底层发布工具守卫 ──
test('底层发布工具守卫：定时/一键生成链路禁用，人工来源放行', () => {
  assert.equal(lowLevelPublishBlocked('scheduled'), true)
  assert.equal(lowLevelPublishBlocked('draft-only'), true)
  assert.equal(lowLevelPublishBlocked('manual'), false)
  assert.match(lowLevelBlockReason('scheduled'), /定时链路/)
  assert.match(lowLevelBlockReason('draft-only'), /一键生成/)
  assert.equal(lowLevelBlockReason('manual'), null)
})

test('底层发布工具清单：覆盖 MCP 面 3 个旁路工具', () => {
  assert.deepEqual(LOW_LEVEL_PUBLISH_TOOLS, ['sync_article', 'publish_styled', 'wechat_draft'])
})
