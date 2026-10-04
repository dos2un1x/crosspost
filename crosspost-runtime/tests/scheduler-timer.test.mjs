// 触发策略（v2.3，调度子系统）：时区换算 + "什么时候该跑"的纯函数
//
// ## 为什么这些断言值得写
//
// v2.3 把"到点会不会跑"从操作系统手里接了过来，于是**以前由系统兜住的语义
// 现在必须由我们证明**：
//   · 跨天 / 跨时区 / DST 的墙钟换算（用机器本地时区写 `setHours` 就错在这里）
//   · 每天最多自动跑一次（睡眠、重启、崩溃都不重复发文）
//   · 补跑窗口（错过多久之内还补，超过就放弃）
//   · 有头无尾（崩在中间）当天不重跑
// 这些在真机上"跑一次看看"是看不出来的（要等到某天刚好睡眠/刚好崩溃），只能靠纯函数穷举。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TZ,
  bjDate,
  bjHHMM,
  bjWeekday,
  isValidTz,
  normalizeTz,
  tzDayKey,
  tzHHMM,
  tzInstantForWallClock,
  tzNextOccurrence,
  tzOffsetMinutes,
  tzParts,
} from '../src/tz.mjs'
import {
  ACTIONS,
  REASONS,
  decideFire,
  nextOccurrence,
  scheduledToday,
  sliceSleepMs,
} from '../src/scheduler/timer.mjs'

const HOUR = 3600 * 1000

test('时区①：既有北京时间 API 行为不变（成本/报表依赖它）', () => {
  const t = Date.parse('2026-09-24T00:30:00+08:00')
  assert.equal(bjDate(t), '2026-09-24')
  assert.equal(bjHHMM(t), '00:30', '午夜 24:00 的写法必须归一为 00:00/00:30')
  assert.equal(bjWeekday(t), 4)
  assert.equal(DEFAULT_TZ, 'Asia/Shanghai')
})

test('时区②：任意 IANA 时区的偏移与墙钟（含 DST 两侧）', () => {
  assert.equal(tzOffsetMinutes('Asia/Shanghai', Date.parse('2026-09-24T00:00:00Z')), 480)
  assert.equal(tzOffsetMinutes('America/New_York', Date.parse('2026-01-15T12:00:00Z')), -300)
  assert.equal(tzOffsetMinutes('America/New_York', Date.parse('2026-07-15T12:00:00Z')), -240)
  const p = tzParts('Asia/Shanghai', Date.parse('2026-09-24T00:30:00Z'))
  assert.deepEqual(
    { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute },
    { y: 2026, m: 9, d: 24, h: 8, mi: 30 },
  )
  assert.equal(tzDayKey('Asia/Shanghai', Date.parse('2026-09-24T15:59:00Z')), '2026-09-24')
  assert.equal(tzDayKey('Asia/Shanghai', Date.parse('2026-09-24T16:01:00Z')), '2026-09-25')
  assert.equal(tzHHMM('America/New_York', Date.parse('2026-03-08T12:30:00Z')), '08:30')
})

test('时区③：下一次触发按**墙钟**逐日推进（加 86400000 会在 DST 日错一小时）', () => {
  const now = Date.parse('2026-09-24T07:00:00+08:00')
  const next = tzNextOccurrence('08:30', 'Asia/Shanghai', now)
  assert.equal(new Date(next).toISOString(), '2026-09-24T00:30:00.000Z')
  const after = tzNextOccurrence('08:30', 'Asia/Shanghai', Date.parse('2026-09-24T09:00:00+08:00'))
  assert.equal(new Date(after).toISOString(), '2026-09-25T00:30:00.000Z', '过了点就推到明天')
  // DST 切换日（2026-03-08 美东 02:00 起夏令时）：08:30 仍必须落在本地 08:30
  const dst = tzNextOccurrence('08:30', 'America/New_York', Date.parse('2026-03-07T20:00:00-05:00'))
  assert.equal(tzHHMM('America/New_York', dst), '08:30')
  // 不存在的墙钟（02:30 那天不存在）：收敛到邻近合法瞬间，且不返回过去时刻
  const ghost = tzNextOccurrence(
    '02:30',
    'America/New_York',
    Date.parse('2026-03-08T00:00:00-05:00'),
  )
  assert.ok(ghost.getTime() > Date.parse('2026-03-08T00:00:00-05:00'))
})

test('时区④：非法时区回退默认而不是让调度整体失败', () => {
  assert.equal(isValidTz('Asia/Shanghai'), true)
  assert.equal(isValidTz('Not/AZone'), false)
  assert.equal(normalizeTz('Not/AZone'), DEFAULT_TZ)
  assert.equal(normalizeTz(''), DEFAULT_TZ)
  assert.equal(normalizeTz('America/New_York'), 'America/New_York')
  assert.equal(
    tzInstantForWallClock('Not/AZone', 2026, 9, 24, 8, 30).toISOString(),
    '2026-09-24T00:30:00.000Z',
  )
})

const spec = (over = {}) => ({
  id: 's',
  key: 'p|s',
  time: '08:30',
  tz: 'Asia/Shanghai',
  enabled: true,
  commandAvailable: true,
  ...over,
})

test('策略①：开关与命令 —— 关闭、命令不可用都不触发（原因可读）', () => {
  const now = Date.parse('2026-09-24T09:00:00+08:00')
  const off = decideFire({ spec: spec({ enabled: false }), now })
  assert.equal(off.action, ACTIONS.SKIP)
  assert.equal(off.reason, REASONS.DISABLED)
  const noCmd = decideFire({ spec: spec({ commandAvailable: false }), now })
  assert.equal(noCmd.action, ACTIONS.SKIP)
  assert.equal(noCmd.reason, REASONS.COMMAND_MISSING)
})

test('策略②：到点前等、到点后准点跑、超过补跑窗口放弃', () => {
  const at = Date.parse('2026-09-24T08:30:00+08:00')
  const before = decideFire({ spec: spec(), now: at - 60 * 1000 })
  assert.equal(before.action, ACTIONS.WAIT)
  assert.equal(before.reason, REASONS.NOT_DUE)
  assert.equal(before.at, at)

  const onTime = decideFire({ spec: spec(), now: at + 30 * 1000 })
  assert.equal(onTime.action, ACTIONS.FIRE)
  assert.equal(onTime.reason, REASONS.DUE)
  assert.equal(onTime.trigger, 'schedule')

  const late = decideFire({ spec: spec(), now: at + 90 * 60 * 1000, catchUpMaxMinutes: 120 })
  assert.equal(late.action, ACTIONS.FIRE)
  assert.equal(late.reason, REASONS.CATCHUP)
  assert.equal(late.trigger, 'catchup', '补跑要能与准点区分开（运行记录里可复盘）')

  const tooLate = decideFire({ spec: spec(), now: at + 3 * 3600 * 1000, catchUpMaxMinutes: 120 })
  assert.equal(tooLate.action, ACTIONS.SKIP)
  assert.equal(tooLate.reason, REASONS.MISSED)
  assert.ok(tooLate.next > tooLate.at, '放弃当天也要给出明天的下一次')

  const noCatchUp = decideFire({ spec: spec(), now: at + 60 * 1000, catchUpMaxMinutes: 0 })
  assert.equal(noCatchUp.action, ACTIONS.SKIP, '窗口=0 表示不补跑')
  assert.equal(noCatchUp.reason, REASONS.MISSED)
})

test('策略③：每天最多自动跑一次；人工触发不占名额', () => {
  const now = Date.parse('2026-09-24T09:00:00+08:00')
  const done = decideFire({ spec: spec(), now, record: { completedDay: '2026-09-24' } })
  assert.equal(done.action, ACTIONS.SKIP)
  assert.equal(done.reason, REASONS.ALREADY_TODAY)
  const yesterday = decideFire({ spec: spec(), now, record: { completedDay: '2026-09-23' } })
  assert.equal(yesterday.action, ACTIONS.FIRE, '昨天跑过不影响今天')
  const manual = decideFire({
    spec: spec(),
    now,
    record: { completedDay: '2026-09-24' },
    force: true,
  })
  assert.equal(manual.action, ACTIONS.FIRE, '人工触发不受每天一次限制')
  assert.equal(manual.trigger, 'manual')
})

test('策略④：有头无尾（崩在中间）当天不重跑', () => {
  const now = Date.parse('2026-09-24T09:00:00+08:00')
  const r = decideFire({ spec: spec(), now, record: { unfinishedDay: '2026-09-24' } })
  assert.equal(r.action, ACTIONS.SKIP)
  assert.equal(r.reason, REASONS.UNFINISHED)
})

test('策略⑤：scheduledToday / nextOccurrence 与 spec 时区一致', () => {
  const s = spec({ time: '08:30', tz: 'America/New_York' })
  const now = Date.parse('2026-09-24T00:00:00-04:00')
  assert.equal(tzHHMM('America/New_York', scheduledToday(s, now).getTime()), '08:30')
  assert.equal(tzHHMM('America/New_York', nextOccurrence(s, now).getTime()), '08:30')
  assert.ok(nextOccurrence(s, now).getTime() > now)
})

test('策略⑥：分段睡眠有上限（不信任长睡眠；醒来重新判定）', () => {
  const now = Date.now()
  assert.equal(sliceSleepMs(now + 5 * HOUR, now, 60000), 60000)
  assert.equal(sliceSleepMs(now + 10 * 1000, now, 60000), 10000)
  assert.equal(sliceSleepMs(now - 1000, now, 60000), 0, '过去的时刻立刻醒（不能返回负数）')
})
