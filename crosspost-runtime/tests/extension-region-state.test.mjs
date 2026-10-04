/**
 * tab 区状态机（v2.3.4）——「这批数字算不算数」的回归
 *
 * ## 为什么需要它（用户报："细化这个区域的多种状态"）
 *
 * tab 区是用户判断"现在到底什么情况"的第一屏。此前它只显示两个计数，
 * 于是**同一对数字**可能是完全不同的现实：
 *   · 刚核验完的真实结果；
 *   · 三小时前的旧账（桥下一次 tick 才会重查）；
 *   · 上次核对失败了、但缓存还在（数字还算数，只是不是最新）；
 *   · 浏览器扩展没连、检查根本发不出去；
 *   · 一个平台都还没核过（冷启动）；
 *   · 连桥都取不到数（数据不可用）。
 * 本文件把这条轴逐条钉住。
 *
 * ## 同时钉住「未检查」为什么不是第四格
 *
 * 用户列了四格：已登录已检查 / 已登录未检查 / 未登录已检查 / 未登录未检查。
 * 后两格在本系统**取不到数据**（`/proxy/platforms` 只回范围内平台；
 * 桥侧 `platforms-state.json` 只保留当前范围，实测只有勾选的 12 条），
 * 所以未检查平台的登录态是**未知**——它只能是一格，不能被画成两格。
 * 这条以 ⑦ 断言的形式写下来，免得日后有人"补全四格"补出一个猜测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  trustState,
  regionLabels,
  UNCHECKED_SUB,
} from '../../bridge/chrome-proxy-extension/region-state.mjs'
import { groupPlatforms } from '../../bridge/chrome-proxy-extension/platform-groups.mjs'

const HOUR = 3600e3

/** 线上真值形状：3 个已登录（范围内）+ 5 个未勾选未检查，缓存 8 个中的 3 个 */
const SCOPED = groupPlatforms({
  platforms: [
    { id: 'zhihu', isAuthenticated: true },
    { id: 'csdn', isAuthenticated: true },
    { id: 'weixin', isAuthenticated: true },
  ],
  scope: {
    ids: ['zhihu', 'csdn', 'weixin'],
    excluded: ['bilibili', 'jianshu', 'douban', 'xueqiu', 'weibo'],
    all: 8,
    count: 3,
    mode: 'scoped',
  },
  lastMode: 'scope',
})

/** 冷启动：桥刚起来，还什么都没查 */
const COLD = groupPlatforms({
  platforms: [],
  scope: {
    ids: ['zhihu', 'csdn', 'weixin'],
    excluded: ['bilibili'],
    all: 4,
    count: 3,
    mode: 'scoped',
  },
  lastMode: null,
})

const base = { checked: SCOPED.coverage.checked, cacheMs: 1 * HOUR }

test('① 正常落定：本轮已核验（数字就是刚查的）', () => {
  const t = trustState({ ...base, checkedAt: Date.now() - 120e3, ageText: '2 分钟前' })
  assert.equal(t.key, 'fresh')
  assert.equal(t.tone, 'quiet')
  assert.equal(t.text, '本轮已核验')
})

test('② 复核中：旧数字还在，但必须写明正在重算', () => {
  const t = trustState({ ...base, checkedAt: Date.now() - 120e3, refreshing: true })
  assert.equal(t.key, 'checking')
  assert.equal(t.tone, 'run')
  assert.equal(t.text, '复核中…')
})

test('③ 首次核对（冷启动）：一个平台都没核过时不许说"本轮已核验"', () => {
  const t = trustState({ checked: 0, init: true, refreshing: true })
  assert.equal(t.key, 'first')
  assert.equal(t.tone, 'run')
  assert.equal(t.text, '首次核对中…')
  const t2 = trustState({ checked: 0, init: false, refreshing: false })
  assert.equal(t2.key, 'unknown')
  assert.equal(t2.text, '尚未核验')
})

test('④ 旧账：缓存超过一个周期 → 报出年龄（桥会在下个 tick 重查）', () => {
  const t = trustState({ ...base, checkedAt: Date.now() - 3 * HOUR, ageText: '3 小时前' })
  assert.equal(t.key, 'stale')
  assert.equal(t.tone, 'warn')
  assert.equal(t.text, '3 小时前的核验')
  // 年龄文案缺失时也不能崩：退回"较早"
  assert.equal(trustState({ ...base, checkedAt: Date.now() - 3 * HOUR }).text, '较早的核验')
})

test('⑤ 上次核对失败：有缓存就保留数字（只说失败），没缓存才只说失败', () => {
  const withCache = trustState({ ...base, checkedAt: Date.now() - 120e3, checkError: '扩展未连接' })
  assert.equal(withCache.key, 'failed')
  assert.equal(withCache.tone, 'err')
  assert.equal(withCache.text, '上次核对失败')
  const noCache = trustState({ checked: 0, checkError: '扩展未连接' })
  assert.equal(noCache.key, 'failed')
})

test('⑥ 扩展未连接 / 桥取不到数：两种不同的坏，文案不能混', () => {
  const offline = trustState({ ...base, connected: false, checkedAt: Date.now() - 120e3 })
  assert.equal(offline.key, 'offline')
  assert.equal(offline.tone, 'warn')
  assert.equal(offline.text, '扩展未连接')
  const dead = trustState({ reachable: false, checked: 0 })
  assert.equal(dead.key, 'unavailable')
  assert.equal(dead.tone, 'err')
  assert.equal(dead.text, '数据不可用')
  // 桥取不到数是更根本的坏：即使扩展"连着"也报数据不可用
  assert.equal(trustState({ reachable: false, connected: true, checked: 3 }).key, 'unavailable')
})

test('⑦ 区域四文案：未检查档位**只有一格**（不存在"已登录未检查/未登录未检查"）', () => {
  const trust = trustState({ ...base, checkedAt: Date.now() - 120e3 })
  const l = regionLabels({ groups: SCOPED, trust })
  assert.equal(l.tabOk.text, '已登录 3')
  assert.equal(l.tabOk.sub, '本轮已核验')
  assert.equal(l.tabNo.text, '未登录 0 · 未检查 5')
  assert.equal(l.tabNo.sub, UNCHECKED_SUB, '未检查那部分必须自报"状态未知"')
  // 分段与文案同源（页面把每段渲染成带色数字）
  const join = (parts) => parts.map((p) => p.text).join(' · ')
  assert.equal(join(l.tabOk.parts), l.tabOk.text)
  assert.equal(join(l.tabNo.parts), l.tabNo.text)
  assert.deepEqual(
    l.tabNo.parts.map((p) => p.tone),
    ['no', 'unk'],
    '两个数各自带状态色：未登录=红、未检查=琥珀',
  )
})

test('⑧ 冷启动 / 不可用：未知画成 –（不报 0），副标签写明原因', () => {
  const cold = regionLabels({ groups: COLD, trust: trustState({ checked: 0, init: true }) })
  assert.equal(cold.tabOk.text, '已登录 –', '没核过就不是"0 个已登录"')
  assert.equal(cold.tabNo.text, '未检查 1', '也不该出现"未登录 0"')
  assert.equal(cold.tabOk.sub, '首次核对中…')
  assert.match(cold.emptyOk, /尚未核验/)

  const dead = regionLabels({ groups: groupPlatforms({}), trust: trustState({ reachable: false }) })
  assert.equal(dead.tabOk.text, '已登录 –')
  assert.equal(dead.tabNo.text, '未登录 –')
  assert.equal(dead.tabOk.sub, '数据不可用')
  assert.equal(dead.tabNo.sub, '数据不可用')
})

test('⑨ 全量已核验（无未检查）：副标签回到可信度本身', () => {
  const FULL = groupPlatforms({
    platforms: [
      { id: 'zhihu', isAuthenticated: true },
      { id: 'csdn', isAuthenticated: false },
    ],
    scope: { ids: ['zhihu', 'csdn'], excluded: ['zhihu'], all: 2, count: 2, mode: 'scoped' },
    lastMode: 'all',
  })
  const l = regionLabels({
    groups: FULL,
    trust: trustState({ checked: 2, checkedAt: Date.now() - 60e3 }),
  })
  assert.equal(l.tabNo.text, '未登录 1')
  assert.equal(l.tabNo.sub, '本轮已核验', '没有未检查平台时，副标签说明的是数字的可信度')
})
