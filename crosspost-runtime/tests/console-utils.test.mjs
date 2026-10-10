// 前端纯函数单测（2026-09-01 P1-9）：bridge/console/modules/utils.mjs 的无 DOM 纯函数。
// 运行: node --test tests/console-utils.test.mjs
// 说明：utils.mjs 仅在定义 $ 时引用 document（不调用），模块加载无 DOM 副作用，可安全 import。
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  escapeHtml,
  escapeAttr,
  statusText,
  stripSpecRefs,
  historyLabel,
  historyMeta,
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

test('stripSpecRefs：规范条款号换说法，文章小节引用不许动（2026-10-10）', () => {
  // 已知的多级条款号 → 说法（这几条是记录/留存原因里真实出现过的写法）
  assert.equal(stripSpecRefs('轮数用尽按§5.55留存'), '轮数用尽按AI 检测门禁留存')
  assert.equal(stripSpecRefs('未进入§5.6'), '未进入独立审稿')
  assert.equal(stripSpecRefs('决策见§4.0'), '决策见编辑决策')
  assert.equal(stripSpecRefs('自评未过§5.5'), '自评未过自评门槛')
  // 未知的多级号直接去掉，不留空括号与残空格
  assert.equal(stripSpecRefs('按 §9.99 处理'), '按处理')
  assert.equal(stripSpecRefs('（§9.99）'), '')
  // **单级号是指文章自己的小节**（"已删 §1 与 §5 重复的论述"）——一个字符都不许改
  const articleRefs = '已删§1与§5重复的"国产硬件优化"论述、§5改口径'
  assert.equal(stripSpecRefs(articleRefs), articleRefs)
  // 没有 § 的文本原样返回（不做无谓的改写）
  assert.equal(stripSpecRefs('普通文本，无条款号'), '普通文本，无条款号')
  assert.equal(stripSpecRefs(null), '')
})

test('historyLabel：非发布类 history 不再被写成"发布"（2026-10-09）', () => {
  // 记录里 1383 条 history 有 786 条是这些动作；此前它们全被渲染成「发布 · 微信 — · 平台 —」
  assert.equal(historyLabel('publish'), '发布')
  assert.equal(historyLabel('draft-only'), '草稿（未推送）')
  assert.equal(historyLabel('dryRun'), '渲染测试')
  assert.equal(historyLabel('retain'), '留存')
  assert.equal(historyLabel('restore'), '恢复')
  assert.equal(historyLabel('archive'), '归档')
  assert.equal(historyLabel('backfill'), '补记（日志回填）')
  assert.equal(historyLabel('mark'), '补记（人工）')
  assert.equal(historyLabel('status'), '状态变更')
  assert.equal(historyLabel('ai-detect'), 'AI 检测') // 未发布稿的判定记录（2026-10-09 起）
  assert.equal(historyLabel('writing'), '写作快照') // 编辑决策/独立审稿的落点（2026-10-10 起）
  // 未登记的 action 原样回显：宁可显示 `some-action`，也不要编一个好听的名字
  assert.equal(historyLabel('some-action'), 'some-action')
  assert.equal(historyLabel(null), '')
})

test('historyMeta：没发生过的字段不写占位（微信/平台只在推送类条目上出现）', () => {
  // 留存/恢复/归档：没有微信与平台这回事，不许补 `—`
  assert.deepEqual(historyMeta({ action: 'retain', dir: 'rejected' }), ['留存', '→ 低分库'])
  assert.deepEqual(historyMeta({ action: 'retain', dir: 'risk' }), ['留存', '→ 风险库'])
  assert.deepEqual(historyMeta({ action: 'restore', from: 'retained' }), ['恢复', '← 移回草稿目录'])
  assert.deepEqual(historyMeta({ action: 'archive' }), ['归档', '→ 归档库'])
  assert.deepEqual(historyMeta({ action: 'status', to: 'archived' }), ['状态变更', '→ archived'])
  // 推送类：有值才写，且带评分
  assert.deepEqual(
    historyMeta({ action: 'publish', wechat: 'ok', platforms: '10/10', score: 93 }),
    ['发布', '微信 ok', '平台 10/10', '评分 93'],
  )
  assert.deepEqual(
    historyMeta({ action: 'draft-only', wechat: 'skip', platforms: null, score: 90 }),
    ['草稿（未推送）', '微信 skip', '评分 90'],
  )
  // 写作快照：同样没有微信/平台，决策与审稿各自由时间线的分支渲染
  assert.deepEqual(historyMeta({ action: 'writing', decision: '决策=…', review: '审稿=90' }), [
    '写作快照',
  ])
  // AI 检测条目：没有微信/平台这回事，但会带判定（判定行由时间线的 aiDetect 分支渲染）
  assert.deepEqual(
    historyMeta({ action: 'ai-detect', aiDetect: 'AI检测=达标', note: '第2轮复检' }),
    ['AI 检测'],
  )
  // 空对象与脏输入不炸
  assert.deepEqual(historyMeta(null), [''])
  assert.deepEqual(historyMeta({}), [''])
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
