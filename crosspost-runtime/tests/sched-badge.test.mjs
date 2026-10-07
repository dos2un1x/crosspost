// 槽位徽标 / 今日小标的纯函数单测（2026-10-07）
//
// 为什么单独测这两个函数：它们是"这张时刻表今天到底跑没跑"的唯一表达面，而
// 「今日已跑」这个词**同时**被两件事用着：
//   · `completedToday` —— 今天的**自动**班次已完成（`decideFire` 拿它跳过当天）
//   · `manualToday`    —— 今天**手动**跑过（人工触发**不占**「每天一次」名额）
// 把两者混成一个（让手动也置 completedToday）会直接导致"手动补跑一次 = 取消今天的自动班次"，
// 而那正是 `scheduler-runner.test.mjs` 运行记录② 明确钉住的语义。所以这里钉的是另一面：
// **不混，但都要看得见**。
//
// 起因是一个真实误读：18:10 那班被错过（超出补跑窗口）后点「立即运行」补跑成功，
// 界面上那一行与"根本没跑过"长得一模一样。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { schedBadge, schedDriftChip } from '../../bridge/console/modules/views-settings.mjs'

/** 一个"命令可用 + 定时器在跑 + 已启用"的槽位基线 */
const armed = (over = {}) => ({
  slot: 'tips',
  enabled: true,
  armed: true,
  commandMissing: false,
  unfinished: false,
  running: false,
  completedToday: false,
  manualToday: false,
  lastExit: 0,
  daysSince: null,
  ...over,
})

const PROJECT = 'wechat-auto'

test('徽标：都没跑过 → 「已启用」', () => {
  const b = schedBadge(armed(), PROJECT)
  assert.equal(b.cls, 'on')
  assert.equal(b.text, '已启用')
})

test('徽标：自动班次跑完 → 「已启用·今日已跑」', () => {
  const b = schedBadge(armed({ completedToday: true }), PROJECT)
  assert.equal(b.cls, 'on')
  assert.equal(b.text, '已启用·今日已跑')
})

test('徽标：只手动跑过 → 「已启用·今日已手动跑」，且 tooltip 讲清"没取消今天"', () => {
  const b = schedBadge(armed({ manualToday: true }), PROJECT)
  assert.equal(b.cls, 'on', '手动跑过仍是"在跑"态，不是告警')
  assert.equal(b.text, '已启用·今日已手动跑')
  assert.match(b.title, /不占/)
  assert.match(b.title, /没有取消今天的自动班次/)
})

test('徽标：自动 + 手动都跑过 → 只说「今日已跑」（自动完成是更强的结论，不并列）', () => {
  const b = schedBadge(armed({ completedToday: true, manualToday: true }), PROJECT)
  assert.equal(b.text, '已启用·今日已跑')
  assert.doesNotMatch(b.text, /手动/)
})

test('徽标：手动跑失败 → 走"跑失败"分支，不被手动标记盖住', () => {
  const b = schedBadge(armed({ manualToday: true, lastExit: 1, lastRunAt: '' }), PROJECT)
  assert.equal(b.cls, 'warn')
  assert.equal(b.text, '跑失败(exit=1)')
})

test('今日小标：三种状态各自成形，且互斥（自动优先）', () => {
  assert.equal(schedDriftChip(armed()), '', '都没跑过 → 不占位')
  assert.match(schedDriftChip(armed({ completedToday: true })), /is-ok[^>]*>今日已跑</)
  const manualChip = schedDriftChip(armed({ manualToday: true }))
  assert.match(manualChip, /is-manual/, '手动用小标必须与"今日已跑"视觉可区分')
  assert.match(manualChip, />今日已手动跑</)
  assert.doesNotMatch(manualChip, /is-ok/, '手动跑过不能借绿色（绿色的意思是"这一班收工了"）')
  assert.match(manualChip, /不占「每天一次」名额/)
  // 未收尾优先于两者（有头无尾是更该先看到的异常）
  const unfinishedChip = schedDriftChip(
    armed({ unfinished: true, manualToday: true, completedToday: true }),
  )
  assert.match(unfinishedChip, />未收尾</)
  assert.doesNotMatch(unfinishedChip, /今日已/)
})

test('今日小标：字段缺失时不炸（后端旧版本 / 默认域）', () => {
  assert.equal(schedDriftChip(null), '')
  assert.equal(schedDriftChip(undefined), '')
  assert.equal(schedDriftChip({}), '')
})
