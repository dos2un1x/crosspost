import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderMarkdown, postProcessHtml, BUILTIN_STYLES } from '../index'
import { detectAsciiTable, wrapCodeLines } from '../code'

describe('P1 frontmatter', () => {
  it('parses YAML frontmatter and renders meta box', () => {
    const md = '---\ntitle: 标题\nauthor: 作者\npublished: 2026-08-19\ntags: [a, b]\n---\n正文'
    const r = renderMarkdown(md, { style: 'swiss' })
    expect(r.frontmatter.title).toBe('标题')
    expect(r.html).toContain('author:')
    expect(r.html).toContain('作者')
    expect(r.html).toContain('2026-08-19')
  })

  it('falls back to date/excerpt aliases', () => {
    const md = '---\ndate: 2026-01-01\nexcerpt: 摘要\n---\n正文'
    const r = renderMarkdown(md, { style: 'swiss' })
    expect(r.html).toContain('2026-01-01')
    expect(r.html).toContain('摘要')
  })

  it('handles no frontmatter', () => {
    const r = renderMarkdown('纯正文')
    expect(r.frontmatter).toEqual({})
    expect(r.html).toContain('纯正文')
  })
})

describe('P1 callout', () => {
  it('renders TIP callout', () => {
    const r = renderMarkdown('> [!TIP] 知识科普\n> 这是提示内容', { style: 'swiss' })
    expect(r.html).toContain('Tips')
    expect(r.html).toContain('知识科普')
    expect(r.html).toContain('这是提示内容')
    // TIP 的边线色取自样式参数里的 calloutPalette（值不写字面量）
    expect(r.html).toContain(BUILTIN_STYLES.swiss.calloutPalette.TIP.border)
  })

  it('renders OVERVIEW callout with fallback title when no content', () => {
    const r = renderMarkdown('> [!OVERVIEW]', { style: 'swiss' })
    expect(r.html).toContain('Overview')
    expect(r.html).toContain('背景概览')
  })

  it('uses first line as title when content follows', () => {
    const r = renderMarkdown('> [!TIP] 知识科普\n> 这是提示内容', { style: 'swiss' })
    expect(r.html).toContain('知识科普')
  })

  it('renders plain blockquote for non-callout', () => {
    const r = renderMarkdown('> 普通引用', { style: 'swiss' })
    expect(r.html).toContain('普通引用')
    expect(r.html).not.toContain('Tips')
  })
})

describe('P1 footnotes rebuild', () => {
  it('rebuilds footnotes as flat sections and strips ↩', () => {
    const md = '正文[^1]和[^2]\n\n[^1]: 第一条脚注\n[^2]: 第二条脚注'
    const r = renderMarkdown(md, { style: 'swiss' })
    expect(r.html).toContain('NOTES')
    expect(r.html).toContain('1.')
    expect(r.html).toContain('第一条脚注')
    expect(r.html).toContain('第二条脚注')
    expect(r.html).not.toContain('\u21a9')
    expect(r.html).not.toContain('<ol')
  })
})

describe('P1 anchor unwrap + data-src', () => {
  it('unwraps anchor links and enforces data-src on images', () => {
    const md = '[目录](#toc)\n\n![img](https://example.com/a.png)'
    const r = renderMarkdown(md, { style: 'swiss' })
    expect(r.html).not.toMatch(/<a[^>]*href="#/)
    const imgMatch = /<img[^>]*>/.exec(r.html)
    expect(imgMatch).toBeTruthy()
    expect(imgMatch![0]).toContain('data-src="https://example.com/a.png"')
  })
})

describe('P1 formulas', () => {
  it('renders block formula to inline SVG', () => {
    const r = renderMarkdown('公式：$$x^2 + y^2 = z^2$$', { style: 'swiss' })
    expect(r.html).toContain('<svg')
    expect(r.html).not.toContain('WECHAT_MATH')
  })

  it('renders inline formula', () => {
    const r = renderMarkdown('面积 $a = b \\times h$ 计算', { style: 'swiss' })
    expect(r.html).toContain('<svg')
  })

  it('does not treat currency amounts as math', () => {
    const r = renderMarkdown('从 $100 万涨到 $200 万', { style: 'swiss' })
    expect(r.html).not.toContain('<svg')
    expect(r.html).toContain('$100')
  })
})

describe('P1 ascii table in code block', () => {
  it('detects and renders pipe table', () => {
    const md = '```\n| 平台 | 状态 |\n|------|------|\n| zhihu | ✅ |\n```'
    const r = renderMarkdown(md, { style: 'swiss' })
    expect(r.html).toContain('<table')
    expect(r.html).toContain('zhihu')
  })

  it('keeps real code as pre when language given', () => {
    const md = '```js\nconst a = 1\n```'
    const r = renderMarkdown(md, { style: 'terminal' })
    expect(r.html).toContain('<pre')
  })

  it('wrapCodeLines breaks long lines at commas', () => {
    const long =
      'const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]'
    const wrapped = wrapCodeLines(long, 45)
    const lines = wrapped.split('\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(60)
  })
})

describe('P1 custom styles', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-custom-'))
  const customDir = path.join(tmpBase, 'custom-styles')
  const prevEnv = process.env.CROSSPOST_CUSTOM_STYLES_DIR

  beforeEach(() => {
    fs.mkdirSync(customDir, { recursive: true })
    process.env.CROSSPOST_CUSTOM_STYLES_DIR = customDir
  })
  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.CROSSPOST_CUSTOM_STYLES_DIR
    else process.env.CROSSPOST_CUSTOM_STYLES_DIR = prevEnv
  })

  it('loads custom style from publish-compatible path', () => {
    fs.writeFileSync(
      path.join(customDir, 'custom-test-green.json'),
      JSON.stringify({
        category: 'custom',
        desc: '测试绿',
        bg: '#f7faf7',
        accent: '#2f9e44',
        text: '#1a1a1a',
        secondary: '#555555',
        font: 'sans-serif',
        border_width: '3px',
        headingStyle: 'left-border',
        blockquoteStyle: 'full-box',
      }),
    )
    const r = renderMarkdown('# 标题\n\n> 引用', { style: 'custom-test-green' })
    expect(r.html).toContain('#f7faf7')
    expect(r.html).toContain('#2f9e44')
  })

  it('reports unknown style with available list', () => {
    expect(() => renderMarkdown('# x', { style: 'nope' })).toThrow(/未知样式/)
  })
})

describe('P1 postProcessHtml direct', () => {
  it('converts italic-only paragraph to quote box', () => {
    const html = '<p><em>整段斜体金句</em></p>'
    const out = postProcessHtml(html, BUILTIN_STYLES.swiss, 'swiss')
    expect(out).toContain('整段斜体金句')
    // 整段斜体引用卡片的底色取自样式参数（值不写字面量）
    expect(out).toContain(`background-color: ${BUILTIN_STYLES.swiss.italicQuoteBg}`)
  })

  it('video links become text links', () => {
    const r = renderMarkdown('![视频](https://www.youtube.com/watch?v=abc123)')
    expect(r.html).toContain('▶ 视频链接')
    expect(r.html).not.toContain('<img')
  })
})

describe('detectAsciiTable', () => {
  it('returns null for plain text', () => {
    expect(detectAsciiTable('const a = 1\nconst b = 2')).toBeNull()
  })

  it('detects box-drawing table', () => {
    const box = '┌────┬────┐\n│  a │  b │\n├────┼────┤\n│  1 │  2 │\n└────┴────┘'
    const segments = detectAsciiTable(box)
    expect(segments).not.toBeNull()
    expect(segments!.some(([k]) => k === 'table')).toBe(true)
  })
})
