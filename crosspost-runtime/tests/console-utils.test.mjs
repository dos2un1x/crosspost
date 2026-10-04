// 前端纯函数单测（2026-09-01 P1-9）：bridge/console/modules/utils.mjs 的无 DOM 纯函数。
// 运行: node --test tests/console-utils.test.mjs
// 说明：utils.mjs 仅在定义 $ 时引用 document（不调用），模块加载无 DOM 副作用，可安全 import。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  escapeHtml,
  escapeAttr,
  statusText,
  fmtTime,
  todayStr,
  riskBadge,
  renderScoreCell,
  pageSlice,
  styleDisplayName,
  styleGroupOf,
  groupStyles,
  fmtMD,
  mondayOf,
} from '../../bridge/console/modules/utils.mjs'
// 栏目名的唯一入口搬到了 slot-lexicon（名字的权威源是项目声明，不是前端常量）
import { slotName } from '../../bridge/console/modules/slot-lexicon.mjs'

test('escapeHtml 转义 & < > " \' ', () => {
  assert.equal(escapeHtml('<a b="c">&'), '&lt;a b=&quot;c&quot;&gt;&amp;')
  assert.equal(escapeHtml("'"), '&#39;')
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
})

test('escapeAttr 与 escapeHtml 同源（属性转义）', () => {
  assert.equal(escapeAttr('"'), '&quot;')
})

test('statusText 状态映射 + 未知透传', () => {
  assert.equal(statusText('published'), '已发布')
  assert.equal(statusText('partial'), '部分成功')
  assert.equal(statusText('archived'), '已归档')
  assert.equal(statusText('retained'), '已留存')
  assert.equal(statusText('weird-status'), 'weird-status')
})

test('fmtTime 空值/非法/合法输入', () => {
  assert.equal(fmtTime(null), '—')
  assert.equal(fmtTime('not-a-date'), 'not-a-date'.slice(0, 16))
  assert.match(fmtTime('2026-08-31T12:34:56Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('todayStr 返回 YYYY-MM-DD（北京时间口径）', () => {
  assert.match(todayStr(), /^\d{4}-\d{2}-\d{2}$/)
})

test('riskBadge：命中彩标 / none 与空不显示', () => {
  assert.match(riskBadge('ad'), /广告/)
  assert.match(riskBadge('investment'), /risk-badge/)
  assert.equal(riskBadge('none'), '')
  assert.equal(riskBadge(null), '')
})

test('renderScoreCell：≥ SCORE_PASS 为 pass，低于为 fail，空为 —', () => {
  assert.match(renderScoreCell({ total: 90 }), /score-badge pass/)
  assert.match(renderScoreCell({ total: 50 }), /score-badge fail/)
  assert.match(renderScoreCell(68), /pass/) // 68 恰好及线（SCORE_PASS）
  assert.match(renderScoreCell(67), /fail/)
  assert.match(renderScoreCell(null), /—/)
  assert.match(renderScoreCell({ total: undefined }), /—/)
})

test('pageSlice：按 PAGE_SIZE 切片 + 分页', () => {
  const list = Array.from({ length: 75 }, (_, i) => i)
  assert.equal(pageSlice(list, 1).length, 30)
  assert.equal(pageSlice(list, 1)[0], 0)
  assert.equal(pageSlice(list, 3)[0], 60)
  assert.equal(
    pageSlice(
      Array.from({ length: 5 }, (_, i) => i),
      1,
    ).length,
    5,
  ) // 少于一页原样返回
})

test('slotName 栏目标签映射（词典未加载时的兜底路径）', () => {
  // 2026-09-25：栏目名的权威源变成了项目声明（`/proxy/schedule` 的 `label`），
  // 前端只保留"词典拿不到时"的兜底常量。这里钉的就是那条兜底：
  // 没有词典时行为与改前逐字一致，历史槽位（如 morning）仍显示得出名字。
  assert.equal(slotName('morning'), '早报')
  assert.equal(slotName('manual'), '手动')
  assert.equal(slotName('unknown'), 'unknown')
})

test('styleDisplayName 去 custom- 前缀', () => {
  assert.equal(styleDisplayName('custom-product'), 'product')
  assert.equal(styleDisplayName('swiss'), 'swiss')
})

test('styleGroupOf 分组归类', () => {
  assert.equal(styleGroupOf({ name: 'swiss', category: 'core' }).key, 'core')
  assert.equal(styleGroupOf({ name: 'terminal', category: 'extend' }).key, 'extend')
  assert.equal(styleGroupOf({ name: 'custom-x', category: 'custom', desc: '其他' }).key, 'md-misc')
  assert.equal(styleGroupOf({ name: 'x', category: 'custom', desc: '醒目系列' }).key, 'md-醒目')
  assert.equal(styleGroupOf({ name: 'y', category: 'custom', desc: '其他' }).key, 'md-misc')
  // 「其他自定义主题」细分（显式映射）
  assert.equal(
    styleGroupOf({ name: 'custom-mianpro', category: 'custom', desc: 'AI 日报风' }).key,
    'md-ai',
  )
  assert.equal(
    styleGroupOf({ name: 'custom-tech', category: 'custom', desc: '工程技术' }).key,
    'md-ai',
  )
  assert.equal(
    styleGroupOf({ name: 'custom-apple', category: 'custom', desc: '苹果范' }).key,
    'md-brand',
  )
  assert.equal(
    styleGroupOf({ name: 'custom-cyber', category: 'custom', desc: '赛博朋克' }).key,
    'md-style',
  )
})

test('groupStyles 按组重排返回 Map', () => {
  const groups = groupStyles([
    { name: 'custom-a', category: 'custom', desc: 'x' },
    { name: 'swiss', category: 'core', desc: 'core' },
  ])
  assert.ok(groups instanceof Map)
  assert.ok(groups.has('core'))
  assert.ok(groups.has('md-misc'))
  assert.ok(Array.isArray(groups.get('core').items))
})

test('fmtMD 输出 MM-DD', () => {
  assert.equal(fmtMD(new Date(2026, 0, 5)), '01-05')
})

test('mondayOf 返回所在周周一（周一为一周起点）', () => {
  // 2026-09-01 是周二 → 周一为 2026-08-31
  const m = mondayOf(new Date(2026, 8, 1))
  assert.equal(m.getFullYear(), 2026)
  assert.equal(m.getMonth(), 7) // 8 月
  assert.equal(m.getDate(), 31)
  assert.equal(m.getHours(), 0)
})
