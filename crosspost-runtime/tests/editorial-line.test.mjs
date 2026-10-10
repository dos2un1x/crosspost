// 编辑决策 / 独立审稿展示层的单测（2026-10-10）
//
// 为什么用真实语料当用例：这两个字段是写作侧按 SKILL §2.5 / §5.6 手写的一行文本，写法在演进 ——
// 抽查过全库 158+158 条，decision 有 5 种字段组合（含"只有决策="和纯散文老格式），
// review 的 issues 有 4 种写法（`minor:事实-…` / `minor/表达 …` / `minor+事实+"…"` / 整段散文）。
// 解析器必须**照着现实**写：解析不出来就原样显示（历史数据不能因为格式变了就看不见）。
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDecision,
  parseReview,
  decisionDetailHtml,
  reviewDetailHtml,
  decisionInlineHtml,
  reviewInlineHtml,
} from '../../bridge/console/modules/editorial-line.mjs'

// 全字段（库里最常见的一种，2026-08 起）
const DEC_FULL =
  '决策=微信 WeWorm 零点击蠕虫把"AI 攻击力"从抽象风险变成每条好友链上的具体漏洞:漏洞本身是旧的 VoIP 协议栈内存损坏,变的是 AI 把发现到武器化的周期压到约 9 天 | 理由=微信用户量级人人相关,9/8 研究公开后仍处上升期 | 重复风险=medium(避开角度:不写成 AI 末日论/减速叙事,09-11、09-13 已写) | 写作指令=1)速览 5 条各 1-2 句带数据不展开 2)今日必知只拆三点:零点击、9 天、好友链 3)结尾落到可执行动作 | 标题避免=末日/灭世/慌了/炸裂'

test('决策：全字段解析成 主线/理由/重复风险/避开角度/写作指令/标题避免', () => {
  const d = parseDecision(DEC_FULL)
  assert.equal(d.ok, true)
  assert.match(d.main, /^微信 WeWorm 零点击蠕虫/)
  assert.match(d.reason, /^微信用户量级人人相关/)
  assert.equal(d.risk, 'medium', '括号里的"避开角度"必须从风险值里剥掉')
  assert.match(d.avoid, /^不写成 AI 末日论/)
  assert.deepEqual(d.instructions, [
    '速览 5 条各 1-2 句带数据不展开',
    '今日必知只拆三点:零点击、9 天、好友链',
    '结尾落到可执行动作',
  ])
  assert.deepEqual(d.notes, [{ k: '标题避免', v: '末日/灭世/慌了/炸裂' }])
})

test('决策：`medium，避开角度=…` 的逗号写法同样能拆（且不留悬挂括号）', () => {
  const d = parseDecision(
    '决策=主线A|理由=B|重复风险=medium，避开角度=不写模型发布节奏/基准跑分对比',
  )
  assert.equal(d.risk, 'medium')
  assert.match(d.avoid, /^不写模型发布节奏/)
  assert.ok(!d.risk.includes('(') && !d.risk.includes('（'), d.risk)
})

test('决策：①②③ 与 `主线:` 混写、只有 决策= 的短格式都能读', () => {
  const circled = parseDecision('决策=主线:某题|理由=R|写作指令=①讲清机制 ②纠偏误解 ③只写官方数字')
  assert.equal(circled.main, '某题')
  assert.deepEqual(circled.instructions, ['讲清机制', '纠偏误解', '只写官方数字'])
  const only = parseDecision('决策=只有主线的一句话')
  assert.equal(only.ok, true)
  assert.equal(only.main, '只有主线的一句话')
})

test('决策：老格式（纯散文，没有键）按 | 分段兜底，信息不丢', () => {
  const d = parseDecision(
    'AI生图抹掉食欲瑕疵 | 全球餐厅被AI菜单图攻占 | low，近3天无同类题材 | 用具体失真例开篇造反差',
  )
  assert.equal(d.ok, true)
  assert.match(d.main, /^AI生图抹掉食欲瑕疵/)
  assert.match(d.reason, /^全球餐厅/)
  assert.equal(d.risk, 'low')
  assert.ok(d.instructions.length >= 1)
})

const REV_FULL =
  '审稿=90 自评=92 行动=publish issues=3(minor:事实-速览第 2 条"多家媒体报道"口径偏软,建议保留但不下结论;minor:表达-"这就是蠕虫的分量"略修辞,全篇仅 1 处可留;minor:配图-无图,当前流水线不扣分)'

test('审稿：行动/分数/自评 + 逐条 issue（严重度与分类各自拆出）', () => {
  const r = parseReview(REV_FULL)
  assert.equal(r.ok, true)
  assert.equal(r.score, 90)
  assert.equal(r.selfScore, 92)
  assert.equal(r.action, 'publish')
  assert.equal(r.actionLabel, '发布')
  assert.equal(r.issueCount, 3)
  assert.equal(r.issues.length, 3)
  assert.deepEqual(r.issues[0], {
    severity: 'minor',
    category: '事实',
    text: '速览第 2 条"多家媒体报道"口径偏软,建议保留但不下结论',
  })
  assert.equal(r.issues[1].category, '表达')
  assert.equal(r.issues[2].category, '配图')
})

test('审稿：issues 的另三种写法（`/`、`+`、散文式 `none major/blocker）：`）都能读', () => {
  const slash = parseReview(
    '审稿=90 行动=publish issues=2(minor/表达 边拍边审用词略堆砌;minor/事实 上线不足一月与停运一致) 修订=0',
  )
  assert.equal(slash.issues.length, 2)
  assert.deepEqual(
    slash.issues.map((i) => i.category),
    ['表达', '事实'],
  )
  assert.equal(slash.revisions, 0)

  const plus = parseReview(
    '审稿=90 行动=publish 修订=0 issues=2条:minor+事实+"新闻集团与模型公司达成内容授权"为概括性表述；minor+表达+"一个公开案件库"未标机构名',
  )
  assert.equal(plus.issues.length, 2)
  assert.deepEqual(
    plus.issues.map((i) => i.severity),
    ['minor', 'minor'],
  )

  const prose = parseReview(
    '审稿=91 自评=93 行动=publish issues=4(none major/blocker)：minor 事实"同期已有万亿参数开源模型"未给具体数字；minor 结构 误区二涉"世界第一"已平衡',
  )
  assert.equal(prose.issues.length, 2)
  assert.equal(prose.issues[0].category, '事实')
  assert.equal(prose.issues[1].category, '结构')
})

test('审稿：没有行动（未审/未跑）时给"说明"，不编造分数', () => {
  for (const raw of [
    '审稿=未审(三门槛未过,自评不审稿)',
    '审稿=未跑(§5.55 AI检测 advise=retain 已留存,未进入 §5.6 独立审稿)',
    '审稿=n/a(不进入:AI检测未达标)',
  ]) {
    const r = parseReview(raw)
    assert.equal(r.ok, true, raw)
    assert.equal(r.score, null, `${raw} 不该编出分数`)
    assert.equal(r.action, '')
    assert.match(r.tail, /未过|AI检测|未进入|不进入/, raw)
    const html = reviewDetailHtml(raw)
    assert.match(html, /未审/)
    assert.match(html, /说明/)
    // 时间线那一行不能只剩"审稿："后面空着——未审的原因就是这一行的全部信息
    const inline = reviewInlineHtml(raw)
    assert.match(inline, /未审/)
    assert.ok(
      inline.replace(/<[^>]+>/g, '').trim().length > 2,
      `${raw} → 时间线渲染为空: ${inline}`,
    )
  }
})

test('审稿：revise 行动与修订次数；blocker/major 的严重度标签', () => {
  const r = parseReview(
    '审稿=86 行动=revise 修订=1(软化"第一次"强断言→转述论文口径) issues=2(blocker:事实-断言无来源;major:表达-口号化)',
  )
  assert.equal(r.action, 'revise')
  assert.equal(r.actionLabel, '修订')
  assert.equal(r.revisions, 1)
  assert.deepEqual(
    r.issues.map((i) => i.severity),
    ['blocker', 'major'],
  )
  const html = reviewDetailHtml(r.raw)
  assert.match(html, /ed-sev blocker/)
  assert.match(html, /ed-sev major/)
})

test('渲染：解析不出来就原样显示（格式变了也不许把内容藏起来）', () => {
  const weird = '这是一段到处都不是的审稿说明@@@@'
  // 老格式兜底会把散文当主线 → 必须仍然可见
  assert.equal(parseDecision(weird).ok, true)
  assert.equal(decisionDetailHtml(weird).includes('@@@@'), true)
  const r = parseReview(weird)
  assert.equal(r.ok, false)
  assert.equal(reviewDetailHtml(weird).includes('@@@@'), true)
  assert.equal(reviewInlineHtml(weird).includes('@@@@'), true)
  assert.equal(decisionInlineHtml(weird).includes('@@@@'), true)
})

test('渲染：空值与时间线一行形态', () => {
  assert.equal(decisionDetailHtml('').includes('未记录'), true)
  assert.equal(reviewDetailHtml('').includes('未记录'), true)
  assert.equal(decisionInlineHtml(''), '')
  assert.equal(reviewInlineHtml(''), '')
  const inline = reviewInlineHtml(REV_FULL)
  assert.match(inline, /ai-verdict sm pass">发布/)
  assert.match(inline, /审稿 90/)
  assert.match(inline, /issues 3/)
  // 时间线只放主线（理由与指令放不进一行）
  const dInline = decisionInlineHtml(DEC_FULL)
  assert.match(dInline, /微信 WeWorm 零点击蠕虫/)
  assert.ok(!dInline.includes('标题避免'), '时间线不该塞进完整决策')
})
