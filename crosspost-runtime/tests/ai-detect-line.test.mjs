// Console 文章抽屉的 AI 检测展示层单测（2026-10-08）
//
// 为什么值得测：面板上那一块**同时要读新老两种文本**（记录是历史数据，旧行不会被重写）：
//   新：`AI检测=达标 · AI特征 10.4% < 30.0% · 片段 8人工/1疑似/1AI · 2620字 · 风格 正常`
//   旧：`AI检测=pass(口径=labels_ai 值=10.4% 阈值=30.0% AI特征占比=10.4% 段=1人工/1AI/8疑似 字符=2620 风格=ok)`
// 判据三件事：① 关键数字没丢；② `skip` 不许被显示成"通过"；③ 解析不了的文本**原样显示**而不是消失。
// 纯函数、无 DOM，可直接跑（`node --test tests/ai-detect-line.test.mjs`）。
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aiDetectDetailHtml,
  aiDetectInlineHtml,
  parseAiDetectLine,
} from '../../bridge/console/modules/ai-detect-line.mjs'

const NEW_PASS = 'AI检测=达标 · AI特征 10.4% < 30.0% · 片段 8人工/1疑似/1AI · 2620字 · 风格 正常'
const NEW_FAIL =
  'AI检测=超标 · 人工 45.0%（≥50.0%） · AI特征 35.0%（≤30.0%） · 疑似 20.0%（≤20.0%） · 越界 人工不足、AI特征超限 · 1520字'
const OLD_PASS =
  'AI检测=pass(口径=labels_ai 值=10.4% 阈值=30.0% AI特征占比=10.4% 段=1人工/1AI/8疑似 字符=2620 风格=ok)'
const OLD_FAIL =
  'AI检测=fail(口径=labels_ai 值=47.2% 阈值=30.0% AI特征占比=47.2% 段=0人工/3AI/3疑似 字符=1520)'

test('新格式：判定/主判据/片段/字数/风格都解析出来', () => {
  const p = parseAiDetectLine(NEW_PASS)
  assert.equal(p.ok, true)
  assert.equal(p.verdict, 'pass')
  assert.equal(p.skipped, false)
  assert.deepEqual(p.metric, { label: 'AI特征', value: '10.4%', op: '<', threshold: '30.0%' })
  assert.deepEqual(p.segments, { human: 8, uncertain: 1, ai: 1 })
  assert.equal(p.chars, 2620)
  assert.deepEqual(p.style, { ok: true, text: '正常' })
})

test('新格式（分布口径）：三项各自带目标，越界项列出来', () => {
  const p = parseAiDetectLine(NEW_FAIL)
  assert.equal(p.verdict, 'fail')
  assert.equal(p.metric, null, '分布口径不该再显示单指标那行')
  assert.deepEqual(
    p.ratios.map((r) => [r.label, r.value, r.bound, r.fail]),
    [
      ['人工', '45.0%', '≥50.0%', true],
      ['AI特征', '35.0%', '≤30.0%', true],
      ['疑似', '20.0%', '≤20.0%', false],
    ],
  )
  assert.deepEqual(p.fails, ['人工不足', 'AI特征超限'])
  assert.equal(p.chars, 1520)
})

test('老格式：同一个数的两个字段（值 / AI特征占比）不去重也不误判成三项占比', () => {
  const p = parseAiDetectLine(OLD_PASS)
  assert.equal(p.ok, true)
  assert.equal(p.verdict, 'pass')
  assert.equal(p.metric.label, 'AI特征')
  assert.equal(p.metric.value, '10.4%')
  assert.equal(p.metric.threshold, '30.0%')
  assert.equal(p.metric.op, '<')
  assert.deepEqual(p.ratios, [], '`AI特征占比=` 不是分布口径的一项')
  assert.deepEqual(p.segments, { human: 1, ai: 1, uncertain: 8 })
  assert.equal(p.chars, 2620)
  assert.equal(p.style.ok, true)
})

test('老格式（fail + 无风格字段）：判定与片段结构照常', () => {
  const p = parseAiDetectLine(OLD_FAIL)
  assert.equal(p.verdict, 'fail')
  assert.equal(p.metric.op, '≥')
  assert.deepEqual(p.segments, { human: 0, ai: 3, uncertain: 3 })
  assert.equal(p.style, null)
})

test('skip：原因翻成人话，代码留着；绝不显示成"通过"', () => {
  for (const raw of ['AI检测=未检测 · 抽查未命中（sampled-out）', 'AI检测=跳过(sampled-out)']) {
    const p = parseAiDetectLine(raw)
    assert.equal(p.verdict, 'skip')
    assert.equal(p.reason, '抽查未命中', raw)
    assert.equal(p.reasonCode, 'sampled-out', raw)
    const html = aiDetectDetailHtml(raw)
    assert.match(html, /未检测/)
    assert.match(html, /不等于通过/, '面板必须写明"未检测 ≠ 通过"')
    assert.doesNotMatch(html, /达标/)
  }
})

test('skip（栏目白名单）：带上被挡下的栏目，AI 追加的说明也不丢', () => {
  const p = parseAiDetectLine('AI检测=跳过(slot-not-enabled:hotspot2) 口径=bands 未检测(白名单外)')
  assert.equal(p.reason, '栏目不在白名单')
  assert.equal(p.reasonCode, 'slot-not-enabled:hotspot2')
  assert.match(aiDetectDetailHtml(p.raw), /slot-not-enabled:hotspot2/)
})

test('旧区间口径（方括号写法）也能读', () => {
  const p = parseAiDetectLine(
    'AI检测=达标 口径=bands 人工=34.0%[30.0%~50.0%] AI特征=33.0%[30.0%~50.0%] 疑似=33.0%[30.0%~50.0%] 失败项=无',
  )
  assert.equal(p.verdict, 'pass')
  assert.equal(p.ratios.length, 3)
  assert.equal(p.ratios[0].label, '人工')
  assert.equal(p.ratios[0].bound, '30.0%~50.0%')
  assert.equal(p.ratios[0].fail, false)
})

test('渲染：超标项标红、开区间用 ~<、明细带上片段与风格', () => {
  const html = aiDetectDetailHtml(NEW_FAIL)
  assert.match(html, /ai-verdict fail">超标/)
  assert.match(html, /ai-ratio fail">人工/)
  assert.match(html, /ai-ratio fail">AI特征/)
  assert.doesNotMatch(html, /ai-ratio fail">疑似/)
  const band = aiDetectDetailHtml(
    'AI检测=超标 · 人工 36.0%（30.0%~50.0%） · AI特征 35.0%（30.0%~<50.0%） · 疑似 29.0%（20.0%~40.0%） · 越界 AI特征偏低 · 900字',
  )
  assert.match(band, /30\.0%~&lt;50\.0%/, '开区间必须写成 ~<')
})

test('渲染：解析不了的文本原样显示（格式再变也不丢内容）', () => {
  const weird = 'AI检测=搞不出来的格式）'
  const p = parseAiDetectLine(weird)
  assert.equal(p.ok, false)
  assert.equal(aiDetectDetailHtml(weird).includes('搞不出来的格式'), true)
  assert.equal(aiDetectInlineHtml(weird).includes('搞不出来的格式'), true)
})

test('渲染：时间线一行只留判定 + 主判据', () => {
  const html = aiDetectInlineHtml(NEW_PASS)
  assert.match(html, /ai-verdict sm pass">达标/)
  assert.match(html, /AI特征 10\.4% &lt; 30\.0%/)
  assert.match(html, /2620 字/)
  assert.doesNotMatch(html, /风格/, '明细不挤进时间线')
})

test('渲染：空文本与未知原因不炸', () => {
  assert.equal(aiDetectDetailHtml('').includes('未执行'), true)
  assert.equal(aiDetectInlineHtml(''), '')
  const p = parseAiDetectLine('AI检测=未检测 · 某新原因（brand-new-reason）')
  assert.equal(p.ok, true)
  assert.equal(p.reasonCode, 'brand-new-reason')
  assert.match(aiDetectDetailHtml(p.raw), /brand-new-reason/)
})
