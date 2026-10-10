// report-series.mjs 单测（2026-10-10）——报表折线图与周对比的算术
//
// 这段算术的特点：**边界全在"没有数据的那一天/那一周"**（记 0 还是当缺失、环比能不能算）。
// 靠看图看不出来，所以逐条钉住。
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dailySeries,
  weeklyCompare,
  linePath,
  sortSlots,
} from '../../bridge/console/modules/report-series.mjs'

const TODAY = '2026-10-10'

test('dailySeries：补齐没有产出的天（记 0，不是缺失），旧 → 新', () => {
  const s = dailySeries(
    [
      { date: '2026-10-10', cost: 1.59 },
      { date: '2026-10-10', cost: 0.41 },
      { date: '2026-10-08', cost: 3.26 },
    ],
    { days: 4, today: TODAY },
  )
  assert.equal(s.length, 4)
  assert.deepEqual(
    s.map((d) => d.date),
    ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'],
  )
  assert.equal(s[3].cost, 2, '同一天多篇要相加')
  assert.equal(s[3].n, 2)
  assert.equal(s[2].cost, 0, '没有产出的那天记 0')
  assert.equal(s[2].n, 0)
  assert.equal(s[0].label, '10-07')
})

test('dailySeries：跨月照常往回数；cost 为 null/缺 date 的行不进序列', () => {
  const s = dailySeries(
    [
      { date: '2026-10-01', cost: 2 },
      { date: '', cost: 9 },
      { date: '2026-10-01', cost: null },
    ],
    { days: 3, today: '2026-10-02' },
  )
  assert.deepEqual(
    s.map((d) => d.date),
    ['2026-09-30', '2026-10-01', '2026-10-02'],
  )
  assert.equal(s[1].cost, 2)
  assert.equal(s[1].n, 1)
  assert.equal(s[2].cost, 0)
})

test('weeklyCompare：周一为周起点，给每篇均价与环比（上一周无数据 → 不给环比）', () => {
  // 2026-10-10 是周六 → 本周起点 10-05；上周 09-28；上上周 09-21
  const rows = [
    { date: '2026-10-05', cost: 2.0 }, // 本周 2 篇 → 均价 1.5
    { date: '2026-10-06', cost: 1.0 },
    { date: '2026-10-01', cost: 3.0 }, // 上周 1 篇 → 均价 3.0
    { date: '2026-09-29', cost: 3.0 }, // 同属上周
  ]
  const w = weeklyCompare(rows, { weeks: 3, today: TODAY })
  assert.equal(w.length, 3)
  assert.deepEqual(
    w.map((x) => x.start),
    ['2026-09-21', '2026-09-28', '2026-10-05'],
  )
  assert.equal(w[0].n, 0, '上上周没有产出')
  assert.equal(w[0].avg, null)
  assert.equal(w[1].n, 2)
  assert.equal(w[1].cost, 6)
  assert.equal(w[1].avg, 3)
  assert.equal(w[1].delta, null, '上一周没有均价就不给环比（别编比值）')
  assert.equal(w[2].n, 2)
  assert.equal(w[2].avg, 1.5)
  assert.equal(w[2].delta, -1.5, '1.5 - 3.0')
  assert.equal(w[2].end, '2026-10-11')
})

test('weeklyCompare：周日归到当周（周一为起点）', () => {
  const w = weeklyCompare([{ date: '2026-10-11', cost: 1 }], { weeks: 2, today: TODAY })
  assert.equal(w[1].start, '2026-10-05', '10-11 是周日，属于 10-05 那一周')
  assert.equal(w[1].n, 1)
})

test('linePath：等宽取点、纵向归一化；全 0 不除零', () => {
  assert.equal(linePath([0, 5, 10], { w: 100, h: 100 }), 'M0,100 L50,50 L100,0')
  assert.equal(linePath([0, 0], { w: 100, h: 100 }), 'M0,100 L100,100')
  assert.equal(linePath([], {}), '')
  assert.equal(linePath([7], { w: 100, h: 100 }), 'M0,0', '单点不产生 NaN')
  // 指定 max 时按 max 归一（用于多图共用纵轴）
  assert.equal(linePath([5], { w: 10, h: 10, max: 10 }), 'M0,5')
})

test('sortSlots：按指标排序，且"没有数"永远排最后（升序降序都一样）', () => {
  const rows = [
    { key: 'a', total: 89, gRate: 0.75, avgValue: 0.21, avgCost: 0.44 },
    { key: 'b', total: 38, gRate: null, avgValue: null, avgCost: 0.27 },
    { key: 'c', total: 82, gRate: 0, avgValue: 0.593, avgCost: null },
  ]
  // 默认按产量降序
  assert.deepEqual(
    sortSlots(rows).map((r) => r.key),
    ['a', 'c', 'b'],
  )
  // 按达标率升序：0 在最前（那是要找的栏目），null 在最后
  assert.deepEqual(
    sortSlots(rows, { key: 'gRate', dir: 'asc' }).map((r) => r.key),
    ['c', 'a', 'b'],
  )
  // 按特征占比降序：最像 AI 的排最前
  assert.deepEqual(
    sortSlots(rows, { key: 'avgValue', dir: 'desc' }).map((r) => r.key),
    ['c', 'a', 'b'],
  )
  // 按每篇费用升序：null 依旧最后
  assert.deepEqual(
    sortSlots(rows, { key: 'avgCost', dir: 'asc' }).map((r) => r.key),
    ['b', 'a', 'c'],
  )
  // 不改原数组（渲染会反复调用）
  assert.equal(rows[0].key, 'a')
  assert.deepEqual(sortSlots([]), [])
  assert.deepEqual(sortSlots(null), [])
})
