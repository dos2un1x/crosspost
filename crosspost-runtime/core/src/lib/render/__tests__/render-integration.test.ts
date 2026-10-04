/**
 * 渲染引擎综合集成测试（2026-09-06）：混合块类型端到端渲染
 *
 * 用一段含标题/段落/加粗/行内码/列表/引用/表格/公式/代码块的 Markdown，
 * 断言各元素正确渲染（swiss 样式，wrapContainer:false，postProcess:false）。
 * 覆盖真实发布链路核心路径，防块级回归。
 */
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../index'

const MD = [
  '# 一级标题',
  '',
  '正文段落含 **加粗** 和 `code`。',
  '',
  '- 列表A',
  '- 列表B',
  '',
  '> 引用内容',
  '',
  '| 列1 | 列2 |',
  '| --- | --- |',
  '| a | b |',
  '',
  '$$x^2 + y^2 = z^2$$',
  '',
  '```',
  'const a = 1',
  '```',
].join('\n')

describe('renderMarkdown 混合块集成', () => {
  const r = renderMarkdown(MD, { style: 'swiss', wrapContainer: false, postProcess: false })
  const html = r.html

  it('标题渲染为 h1（不重复，无嵌套 section 泄漏文本）', () => {
    expect(html).toContain('<h1')
    expect(html).toContain('一级标题')
    expect((html.match(/一级标题/g) || []).length).toBe(1) // 标题只出现一次
  })

  it('段落 + 加粗 + 行内码', () => {
    expect(html).toContain('<strong')
    expect(html).toContain('<code')
    expect(html).toContain('加粗')
    expect(html).toContain('code')
  })

  it('列表渲染为 bullet 结构（• 项目符号 ×2）', () => {
    expect(html).toMatch(/<section[^>]*>.*列表A.*列表B/s)
    expect((html.match(/列表A/g) || []).length).toBe(1)
    expect((html.match(/列表B/g) || []).length).toBe(1)
  })

  it('引用渲染为 blockquote', () => {
    expect(html).toContain('<blockquote>')
    expect(html).toContain('引用内容')
  })

  it('表格渲染为 table + thead/tbody', () => {
    expect(html).toContain('<table')
    expect(html).toContain('<thead>')
    expect(html).toContain('<tbody>')
    expect(html).toContain('列1')
    expect(html).toContain('列2')
    expect(html).toContain('<td')
  })

  it('公式渲染出 SVG（MathJax 输出 SVG，不含字面 latex）', () => {
    expect(html).toContain('<svg')
    expect(html).toMatch(/<svg[^>]*viewBox/) // 公式视图经 SVG path 呈现
    expect(html).not.toContain('$$x^2') // 占位已被替换
  })

  it('代码块渲染为 section>pre + 换行', () => {
    expect(html).toMatch(/<pre[^>]*>const a = 1<br><\/pre>/)
    expect(html).toContain('const a = 1')
  })
})
