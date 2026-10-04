import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  renderMarkdown,
  listStyleNames,
  BUILTIN_STYLES,
  annotateBlocks,
  markdownBlockRanges,
} from '../index'
import { invalidateCustomStyleCache } from '../custom'
import { isDarkColor } from '../styles'

const SAMPLE_MD = `# 标题一

一段正文，包含 **加粗** 和 \`行内代码\`。

> 引用块内容

- 列表项 A
- 列表项 B

1. 有序一
2. 有序二

\`\`\`js
const x = 1
console.log(x)
\`\`\`

| 列1 | 列2 |
|-----|-----|
| a | b |

[链接](https://example.com)

![图片](https://example.com/a.png)

---

*斜体文字*
`

describe('renderMarkdown', () => {
  it('renders swiss style with container and accent colors', () => {
    const r = renderMarkdown('# Hi\n\n> 引用\n\nbody', { style: 'swiss' })
    expect(r.html).toContain(`background-color: ${BUILTIN_STYLES.swiss.bg}`)
    expect(r.html).toContain(`color: ${BUILTIN_STYLES.swiss.text}`)
    // swiss 引用块：灰底 + 一条实线左边线（宽度与颜色都从样式参数取，不写字面量）
    expect(r.html).toContain(
      `border-left: ${BUILTIN_STYLES.swiss.blockquoteBorderWidth} solid ${BUILTIN_STYLES.swiss.blockquoteBorderColor}`,
    )
    expect(r.styleName).toBe('swiss')
  })

  it('renders ink style', () => {
    const r = renderMarkdown('# 标题\n\n> 引用', { style: 'ink' })
    expect(r.html).toContain(`background-color: ${BUILTIN_STYLES.ink.bg}`)
    // ink 引用块左线用 accent（值从样式参数取，不写字面量）
    expect(r.html).toContain(BUILTIN_STYLES.ink.accent)
  })

  it('renders all 10 builtin styles without throwing', () => {
    for (const name of Object.keys(BUILTIN_STYLES)) {
      const r = renderMarkdown(SAMPLE_MD, { style: name })
      expect(r.html.length).toBeGreaterThan(100)
      expect(r.warnings).toEqual([])
    }
  })

  it('throws on unknown style', () => {
    expect(() => renderMarkdown('# x', { style: 'nope' })).toThrow(/未知样式/)
  })

  it('defaults to swiss', () => {
    const r = renderMarkdown('# x')
    expect(r.styleName).toBe('swiss')
  })

  it('can skip container wrapping', () => {
    const r = renderMarkdown('# x', { wrapContainer: false })
    expect(r.html).not.toContain('background-color:')
    expect(r.html).toContain('<h1')
  })

  it('does not leak html/head/body document tags (2026-08-25 修复)', () => {
    const r = renderMarkdown('# 标题\n\n正文段落\n\n> 引用', { style: 'swiss' })
    expect(r.html).not.toMatch(/<html|<head|<body/)
    expect(r.html).toContain('<section')
    expect(r.html).toContain('正文段落')
  })

  it('renders heading text exactly once (标题重复修复回归)', () => {
    const r = renderMarkdown('# 一级标题\n\n## 二级标题\n\n正文', { style: 'swiss' })
    const h1Count = (r.html.match(/一级标题/g) || []).length
    const h2Count = (r.html.match(/二级标题/g) || []).length
    expect(h1Count).toBe(1)
    expect(h2Count).toBe(1)
  })

  it('escapes code content', () => {
    const r = renderMarkdown('```\n<script>alert(1)</script>\n```', { style: 'terminal' })
    expect(r.html).toContain('&lt;script&gt;')
    expect(r.html).not.toContain('<script>alert')
  })

  it('renders footnote references', () => {
    const r = renderMarkdown('正文[^1]\n\n[^1]: 脚注内容', { style: 'swiss' })
    expect(r.html).toContain('footnote-ref')
    expect(r.html).toContain('脚注内容')
  })
})

describe('listStyleNames', () => {
  it('contains core and extend styles', () => {
    const names = listStyleNames()
    expect(names).toContain('swiss')
    expect(names).toContain('editorial')
    expect(names).toContain('ink')
    expect(names).toContain('terminal')
    expect(names.length).toBeGreaterThanOrEqual(10)
  })
})

describe('isDarkColor', () => {
  it('detects dark and light colors', () => {
    expect(isDarkColor('#0d1117')).toBe(true)
    expect(isDarkColor('#ffffff')).toBe(false)
    expect(isDarkColor('#ffcccc')).toBe(false)
  })
})

/** 分隔线行为（产品决定）：默认输出细线，只有样式显式 hrVisible:false 才关闭 */
describe('hrVisible（分隔线默认可见 + 可显式关闭）', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-hr-'))
  const customDir = path.join(tmpBase, 'custom-styles')
  const prevEnv = process.env.CROSSPOST_CUSTOM_STYLES_DIR
  const MD = '上面一段\n\n---\n\n下面一段'

  beforeAll(() => {
    fs.mkdirSync(customDir, { recursive: true })
    fs.writeFileSync(
      path.join(customDir, 'custom-no-hr.json'),
      JSON.stringify({ bg: '#ffffff', text: '#111111', accent: '#e62e2e', hrVisible: false }),
    )
    process.env.CROSSPOST_CUSTOM_STYLES_DIR = customDir
    invalidateCustomStyleCache()
  })

  afterAll(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.CROSSPOST_CUSTOM_STYLES_DIR
    else process.env.CROSSPOST_CUSTOM_STYLES_DIR = prevEnv
    invalidateCustomStyleCache()
  })

  it('内置样式未声明 hrVisible → 输出 <hr>', () => {
    const r = renderMarkdown(MD, { style: 'swiss', wrapContainer: false })
    expect(r.html).toContain('<hr')
  })

  it('样式显式 hrVisible:false → 不输出 <hr>', () => {
    const r = renderMarkdown(MD, { style: 'custom-no-hr', wrapContainer: false })
    expect(r.html).not.toContain('<hr')
    expect(r.html).toContain('上面一段')
    expect(r.html).toContain('下面一段')
  })

  it('hrVisible:false + blocks:true → 仍占一个不可见元素，块标注与源码块 1:1', () => {
    const blocks = markdownBlockRanges(MD, undefined, 'custom-no-hr')
    const r = renderMarkdown(MD, { style: 'custom-no-hr', wrapContainer: false, blocks: true })
    expect(r.html).toContain('display: none')
    expect(annotateBlocks(r.html).count).toBe(blocks.length)
    expect(blocks.length).toBe(3)
  })

  it('发布路径（不传 blocks）在 hrVisible:false 时不留任何占位元素', () => {
    const r = renderMarkdown(MD, { style: 'custom-no-hr', wrapContainer: false, breaks: false })
    expect(r.html).not.toContain('display:none')
    expect(r.html).not.toContain('display: none')
    expect(r.html).not.toContain('data-block')
  })
})
