// engine.ts 渲染引擎单测（2026-08-28 阶段 C1：注入防护用安全语义断言）
// 安全判定原则：
//  - 属性逃逸（" onerror=）取决于双引号是否转义——断言无 `" onerror=` 裸模式
//  - caption 文本 XSS（<script>）取决于 < > 是否转义——断言 caption <p> 内无裸 <script>
import { describe, it, expect } from 'vitest'
import { renderMarkdown, BUILTIN_STYLES } from '../index'

describe('engine 注入防护（2026-08-28 安全加固回归）', () => {
  it('图片 src/alt 属性无法逃逸（onerror 不成为属性）', () => {
    const evil = '![x" onerror="alert(1)](https://example.com/a.png)'
    const r = renderMarkdown(evil, { style: 'swiss' })
    // 无裸引号逃逸后的 onerror 属性（" 已转义为 &quot;；onerror 只能出现在转义文本内）
    expect(r.html).not.toMatch(/"\s+onerror=/)
    expect(r.html).not.toContain(' onerror="')
    // src 仍指向原图
    expect(r.html).toContain('https://example.com/a.png')
  })

  it('javascript: 链接不渲染为可点击 href', () => {
    const evil = '[点我](javascript:alert(1))'
    const r = renderMarkdown(evil, { style: 'swiss' })
    expect(r.html).not.toMatch(/href="javascript:/)
    expect(r.html).not.toContain('<a ')
  })

  it('caption 文本内 <script> 被转义（不成为可执行节点）', () => {
    const evil = '![<script>alert(1)</script>](https://example.com/a.png)'
    const r = renderMarkdown(evil, { style: 'swiss' })
    // caption <p> 内不允许出现裸 <script（双重转义 &amp;lt;script&amp;gt; 是安全的）
    expect(r.html).not.toMatch(/<p[^>]*><script/)
    // 且 <p> 内容里没有可执行脚本（允许 &lt; / &amp;lt; 形式的转义文本）
    // 图注段落用样式参数里的 captionColor 定位（值不写字面量）
    const captionRe = new RegExp(
      `<p style="color: ${BUILTIN_STYLES.swiss.captionColor}[^>]*>([\\s\\S]*?)</p>`,
    )
    const m = r.html.match(captionRe)
    if (m) {
      expect(m[1]).not.toMatch(/<script/i)
      expect(m[1]).not.toMatch(/<img/i)
    }
  })

  it('视频链接替换后无属性逃逸', () => {
    const evil = '![v" onerror="x](https://www.youtube.com/watch?v=abc)'
    const r = renderMarkdown(evil, { style: 'swiss' })
    expect(r.html).not.toMatch(/"\s+onerror=/)
    expect(r.html).toContain('视频链接')
  })
})

describe('engine 基础渲染', () => {
  it('标题/加粗正常渲染', () => {
    const r = renderMarkdown('# 标题\n\n正文 **加粗**', { style: 'swiss' })
    expect(r.html).toContain('标题')
    expect(r.html).toContain('<strong') // 带 style 属性
  })
})
