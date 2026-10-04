/**
 * normalizeBoldFlanking 回归测试（CommonMark flanking 规则）
 *
 * 根因：`**` 后紧跟 Unicode 标点（半角引号、全角引号、冒号、逗号、括号等），
 * 且前一字符非空白/非标点（如汉字），则该 `**` 不满足 left-flanking，
 * 不会被当作强调开篇 → `**"..."**` 加粗失效、`**` 原样输出。
 *
 * 本测试覆盖：
 *  - 用户真实报错片段（`**"..."**`，2026-09-05：小红书/CSDN/掘金/51CTO/抖音 5 平台仍加粗失败）
 *  - 归一化后 marked 应产出 <strong> 且无字面 **
 *  - 幂等性（重复归一化不叠加 U+200B）
 *  - 不误伤：正常加粗、行内公式、***粗斜体***、代码块内的 ** 不受影响
 */
import { describe, it, expect } from 'vitest'
import { marked } from 'marked'
import { normalizeBoldFlanking } from '../markdown-flanking'

describe('normalizeBoldFlanking', () => {
  it('对 `**"..."**` 片段插入零宽空格（open 位置满足 left-flanking）', () => {
    const md = '是**"人和机器各干各的活"这件事本身**。'
    const out = normalizeBoldFlanking(md)
    // 开篇 `**` 后应插入 U+200B，首段「标题钩子」前的裸 `**"` 不应再存在
    expect(out).toContain('**\u200b"')
    expect(out).not.toContain('**"')
  })

  it('markdown 型平台渲染归一化后的串应产出 <strong> 且无字面 **', () => {
    const segments = [
      // 用户报错两个片段
      '是**"人和机器各干各的活"这件事本身**。',
      '而是**"AI 怎么跟聪明人配合"**。',
    ]
    for (const seg of segments) {
      const html = marked.parse(normalizeBoldFlanking(seg), { async: false }) as string
      expect(html).toContain('<strong>')
      expect(html).not.toMatch(/\*\*/)
    }
  })

  it('原始（未归一化）串在 marked 下会还原成字面 **（对照症状）', () => {
    const seg = '是**"人和机器各干各的活"这件事本身**。'
    const html = marked.parse(seg, { async: false }) as string
    expect(html).not.toContain('<strong>')
    expect(html).toMatch(/\*\*/)
  })

  it('幂等：重复归一化不叠加 U+200B', () => {
    const seg = '是**"人和机器各干各的活"这件事本身**。'
    const once = normalizeBoldFlanking(seg)
    const twice = normalizeBoldFlanking(once)
    expect(twice).toBe(once)
  })

  it('不误伤普通加粗（`**加粗**` 前后为空白/汉字非标点）', () => {
    const md = '正文 **加粗** 结尾'
    expect(normalizeBoldFlanking(md)).toBe(md)
  })

  it('不误伤行内公式（`**x^n + y^n = z^n**` 仍保持加粗）', () => {
    const md = '能满足 **x^n + y^n = z^n**。'
    // 开篇 `**` 后跟的是非标点 `x`，不应在此插 ZWSP；仅结尾 `**`（紧跟 `。`）会被补 U+200B（无害）。
    const n = normalizeBoldFlanking(md)
    expect(n).toContain('**x^n + y^n = z^n**')
    const html = marked.parse(n, { async: false }) as string
    expect(html).toContain('<strong>')
    expect(html).not.toMatch(/\*\*/)
  })

  it('不误伤 ***粗斜体***（(?!\\*) 保护多星号）', () => {
    const md = '这是 ***粗斜体*** 文本'
    const out = normalizeBoldFlanking(md)
    expect(out).not.toContain('***\u200b')
    expect(out).toContain('***粗斜体***')
  })

  it('空字符串与无加粗输入原样返回', () => {
    expect(normalizeBoldFlanking('')).toBe('')
    expect(normalizeBoldFlanking('纯正文，无加粗。')).toBe('纯正文，无加粗。')
  })
})
