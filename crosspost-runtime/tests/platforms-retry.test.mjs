// 平台检查范围 + 失败重查策略单测（2026-09-12，模型 A：单列「勾选 = 推送 + 检查」）
// 回归目标：曾导致「哔哩哔哩/简书/豆瓣/人人都是产品经理」被每 60~90 秒无休止重查的三个缺陷——
//   ① 检查范围=全部 27 个（而用户只勾选 10 个）②重查无退避 ③无终态、永不放弃。
// 2026-09-12 二次定稿：范围 = 勾选集本身（不再有"锁定平台 ∩ 曾登录"的门控）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CHECK_ONLY_PLATFORMS,
  TARGET_PLATFORMS,
  resolveCheckSet,
  normalizeIds,
  retryDelayFor,
  applyCheckResults,
  emptyState,
  pruneState,
  selectRetryIds,
  selectFailures,
  failedDetails,
  authedIdsFrom,
  DEFAULT_FAIL_RETRY_MS,
  GIVE_UP_AFTER_MS,
} from '../../bridge/platforms-retry.mjs'

// 与线上 config.json 一致的勾选集（10 个平台 + 仅检查的微信/抖音会被一次性迁移补进来）
const DEFAULTS = [
  'zhihu',
  'csdn',
  'baijiahao',
  'toutiao',
  'xiaohongshu',
  'yidian',
  'dayu',
  'smzdm',
  'juejin',
  'cto51',
]

test('CHECK_ONLY_PLATFORMS：仅检查平台（微信/抖音）与 Console PF_LOCKED 口径一致', () => {
  assert.deepEqual([...CHECK_ONLY_PLATFORMS].sort(), ['douyin', 'weixin'])
  for (const id of CHECK_ONLY_PLATFORMS) assert.ok(TARGET_PLATFORMS.includes(id))
})

test('normalizeIds：过滤未知 id、去重、按 TARGET_PLATFORMS 顺序输出', () => {
  assert.deepEqual(normalizeIds(['juejin', 'zhihu', 'juejin', 'zip-download', '']), [
    'zhihu',
    'juejin',
  ])
  assert.deepEqual(normalizeIds(null), [])
})

test('resolveCheckSet：勾选集就是检查集；未勾选的历史失败平台（4 个）不在范围内', () => {
  const r = resolveCheckSet({ defaults: DEFAULTS })
  assert.equal(r.mode, 'scoped')
  assert.equal(r.ids.length, DEFAULTS.length)
  assert.deepEqual(r.checkOnly, [])
  for (const id of ['bilibili', 'jianshu', 'douban', 'woshipm']) {
    assert.ok(!r.ids.includes(id), `${id} 不应在检查范围内`)
    assert.ok(r.excluded.includes(id))
  }
  assert.equal(r.excluded.length, TARGET_PLATFORMS.length - DEFAULTS.length)
})

test('resolveCheckSet：微信/抖音被勾选 → 进检查范围，并标记为"仅检查"', () => {
  const r = resolveCheckSet({ defaults: [...DEFAULTS, 'weixin', 'douyin'] })
  assert.equal(r.ids.length, DEFAULTS.length + 2)
  assert.deepEqual([...r.checkOnly].sort(), ['douyin', 'weixin'])
  for (const id of CHECK_ONLY_PLATFORMS) assert.ok(r.ids.includes(id))
})

test('resolveCheckSet：未知 id 被过滤，不影响有效勾选', () => {
  const r = resolveCheckSet({ defaults: [...DEFAULTS, 'zip-download', 'nope'] })
  assert.equal(r.ids.length, DEFAULTS.length)
  assert.deepEqual(r.checkOnly, [])
})

test('resolveCheckSet：default 为空 → 回退全量（mode=fallback-all）', () => {
  const r = resolveCheckSet({ defaults: [], everAuthed: [] })
  assert.equal(r.mode, 'fallback-all')
  assert.equal(r.ids.length, TARGET_PLATFORMS.length)
  assert.deepEqual(r.excluded, [])
})

test('resolveCheckSet：default 全是未知 id 也回退全量', () => {
  const r = resolveCheckSet({ defaults: ['zip-download', 'nope'], everAuthed: [] })
  assert.equal(r.mode, 'fallback-all')
})

test('retryDelayFor：60s → 5min → 30min 阶梯', () => {
  assert.equal(retryDelayFor(1), 60_000)
  assert.equal(retryDelayFor(3), 300_000)
  assert.equal(retryDelayFor(9), 300_000)
  assert.equal(retryDelayFor(10), 1_800_000)
  assert.equal(retryDelayFor(999), 1_800_000)
})

test('applyCheckResults：失败累计 + 退避到期时间；成功清零', () => {
  const t0 = 1_700_000_000_000
  let st = emptyState()
  const fail = [{ id: 'weixin', isAuthenticated: false, error: '未登录' }]
  st = applyCheckResults(st, fail, t0)
  assert.equal(st.platforms.weixin.status, 'retry')
  assert.equal(st.platforms.weixin.consecutiveFails, 1)
  assert.equal(st.platforms.weixin.nextRetryAt, t0 + 60_000)
  assert.equal(st.platforms.weixin.lastError, '未登录')
  assert.equal(st.platforms.weixin.lastAuthAt, null)

  // 连续失败 3 次 → 退避到 5 分钟
  st = applyCheckResults(st, fail, t0 + 60_000)
  st = applyCheckResults(st, fail, t0 + 120_000)
  assert.equal(st.platforms.weixin.consecutiveFails, 3)
  assert.equal(st.platforms.weixin.nextRetryAt, t0 + 120_000 + 300_000)

  // 成功 → 清零、记 lastAuthAt
  st = applyCheckResults(st, [{ id: 'weixin', isAuthenticated: true }], t0 + 200_000)
  assert.equal(st.platforms.weixin.status, 'ok')
  assert.equal(st.platforms.weixin.consecutiveFails, 0)
  assert.equal(st.platforms.weixin.lastAuthAt, t0 + 200_000)
  assert.equal(st.platforms.weixin.nextRetryAt, null)

  // 再次失败 → 从 1 开始（不是 4）
  st = applyCheckResults(st, fail, t0 + 260_000)
  assert.equal(st.platforms.weixin.consecutiveFails, 1)
})

test('applyCheckResults：连续失败超过 24h → needs_login 终态，不再进重查集', () => {
  const t0 = 1_700_000_000_000
  let st = applyCheckResults(emptyState(), [{ id: 'douyin', isAuthenticated: false }], t0)
  st = applyCheckResults(st, [{ id: 'douyin', isAuthenticated: false }], t0 + GIVE_UP_AFTER_MS + 1)
  assert.equal(st.platforms.douyin.status, 'needs_login')
  assert.equal(st.platforms.douyin.nextRetryAt, null)
  assert.equal(st.platforms.douyin.lastAuthAt, null)
  assert.deepEqual(
    selectRetryIds({ state: st, checkSet: ['douyin'], now: t0 + GIVE_UP_AFTER_MS + 1 }),
    [],
  )
  assert.deepEqual(selectFailures({ state: st, checkSet: ['douyin'] }).needsLogin, ['douyin'])
})

test('selectRetryIds：只返回「在检查范围内 + retry + 已到退避时间」的平台', () => {
  const t0 = 1_700_000_000_000
  const st = applyCheckResults(
    emptyState(),
    [
      { id: 'weixin', isAuthenticated: false },
      { id: 'douyin', isAuthenticated: false },
      { id: 'bilibili', isAuthenticated: false },
      { id: 'jianshu', isAuthenticated: false },
    ],
    t0,
  )
  // 范围内：已到退避时间 → 返回；未到期 → 不返回
  assert.deepEqual(
    selectRetryIds({ state: st, checkSet: ['weixin', 'douyin'], now: t0 + 61_000 }).sort(),
    ['douyin', 'weixin'],
  )
  assert.deepEqual(selectRetryIds({ state: st, checkSet: ['weixin', 'douyin'], now: t0 + 1 }), [])
  // 范围外（今天的 4 个历史失败平台）→ 永远不返回
  assert.deepEqual(selectRetryIds({ state: st, checkSet: DEFAULTS, now: t0 + 10 * 60_000 }), [])
  assert.deepEqual(
    selectRetryIds({ state: st, checkSet: DEFAULTS, now: t0 + 10 * 60_000 }).filter((id) =>
      ['bilibili', 'jianshu'].includes(id),
    ),
    [],
  )
})

test('selectFailures / failedDetails：只覆盖检查范围内的失败平台', () => {
  const t0 = 1_700_000_000_000
  const st = applyCheckResults(
    emptyState(),
    [
      { id: 'weixin', isAuthenticated: false, error: 'no cookie' },
      { id: 'douban', isAuthenticated: false },
      { id: 'zhihu', isAuthenticated: true },
    ],
    t0,
  )
  const { retry, needsLogin } = selectFailures({ state: st, checkSet: ['weixin', 'zhihu'] })
  assert.deepEqual(retry, ['weixin'])
  assert.deepEqual(needsLogin, [])
  const d = failedDetails({ state: st, checkSet: ['weixin'], now: t0 })
  assert.equal(d.length, 1)
  assert.equal(d[0].id, 'weixin')
  assert.equal(d[0].consecutiveFails, 1)
  assert.equal(d[0].retryInMs, DEFAULT_FAIL_RETRY_MS)
})

test('pruneState：勾选变化后丢弃范围外状态，保留范围内计数', () => {
  const t0 = 1_700_000_000_000
  const st = applyCheckResults(
    emptyState(),
    [
      { id: 'weixin', isAuthenticated: false },
      { id: 'douban', isAuthenticated: false },
    ],
    t0,
  )
  const p = pruneState(st, ['weixin'])
  assert.deepEqual(Object.keys(p.platforms), ['weixin'])
  assert.equal(p.platforms.weixin.consecutiveFails, 1)
})

test('authedIdsFrom：从检查结果 / 发布结果里取已登录平台', () => {
  assert.deepEqual(
    authedIdsFrom([
      { id: 'zhihu', isAuthenticated: true },
      { id: 'weixin', isAuthenticated: false },
      { id: 'douyin', status: 'ok' },
      { id: 'csdn', status: 'skip' },
    ]),
    ['zhihu', 'douyin'],
  )
  assert.deepEqual(authedIdsFrom(null), [])
})
