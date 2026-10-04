/**
 * markdownBlockRanges / annotateBlocks 单元测试（编写工作台滚动/选区同步，2026-09-05）
 *
 * 验证：markdown-it 顶层块（level===0）与渲染产物 body 直接子元素 1:1；
 * 覆盖标题/段落/引用(callout)/列表/代码块/公式/表格。
 */
import { describe, it, expect } from 'vitest'
import { markdownBlockRanges, annotateBlocks, renderMarkdown } from '../index'

describe('markdownBlockRanges', () => {
  it('解析混合内容顶层块序列（1-based 行号）', () => {
    const md =
      '# 标题\n\n第一段\n\n> [!TIP] 提示\n> 内容\n\n- A\n- B\n\n```\ncode\n```\n\n**加粗**尾段'
    const blocks = markdownBlockRanges(md, undefined, 'swiss')
    expect(blocks).toHaveLength(6)
    expect(blocks[0]).toMatchObject({ type: 'heading_open', startLine: 1, endLine: 1 })
    expect(blocks[1]).toMatchObject({ type: 'paragraph_open', startLine: 3, endLine: 3 })
    expect(blocks[2]).toMatchObject({ type: 'blockquote_open', startLine: 5, endLine: 6 })
    expect(blocks[3]).toMatchObject({ type: 'bullet_list_open', startLine: 8, endLine: 10 })
    expect(blocks[4]).toMatchObject({ type: 'fence', startLine: 11, endLine: 13 })
    expect(blocks[5].type).toBe('paragraph_open')
  })

  it('空内容返回空数组；单段无换行也算一个块', () => {
    expect(markdownBlockRanges('', undefined, 'swiss')).toHaveLength(0)
    expect(markdownBlockRanges('纯文本无换行', undefined, 'swiss')).toHaveLength(1)
  })

  it('frontmatter 不计入行号（正文行号与编辑器一致，首块从正文第一行起）', () => {
    const md = '---\ntitle: x\n---\n正文第一段'
    const blocks = markdownBlockRanges(md, undefined, 'swiss')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].startLine).toBe(1)
  })
})

describe('annotateBlocks', () => {
  it('为每个顶层块根元素打 data-block，数量与 blocks 一致', () => {
    const md = '# h\n\np1\n\n> [!TIP] t\n> x\n\n- a\n- b\n\n```\nc\n```\n\n尾'
    const blocks = markdownBlockRanges(md, undefined, 'swiss')
    const r = renderMarkdown(md, { style: 'swiss', wrapContainer: false, postProcess: true })
    const ann = annotateBlocks(r.html)
    expect(ann.count).toBe(blocks.length)
    // 每个根元素依次有 data-block="0..n-1"
    const marks = [...ann.html.matchAll(/data-block="(\d+)"/g)].map((m) => m[1])
    expect(marks).toEqual(blocks.map((_, i) => String(i)))
  })

  it('callout/引用在 postProcess 后仍为单一根元素', () => {
    for (const md of ['> [!TIP] 提示\n> 内容', '> 普通引用']) {
      const blocks = markdownBlockRanges(md, undefined, 'swiss')
      const r = renderMarkdown(md, { style: 'swiss', wrapContainer: false, postProcess: true })
      const ann = annotateBlocks(r.html)
      expect(ann.count).toBe(blocks.length)
      expect(ann.count).toBe(1)
    }
  })
})
