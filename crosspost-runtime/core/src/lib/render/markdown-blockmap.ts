/**
 * Markdown 块映射（2026-09-05 编写工作台：左编辑 ↔ 右预览同步）
 *
 * 目标：把「源码行号 ↔ 渲染块」精确对齐，供前端做：
 *  - 左编辑滚动 → 右预览对应块滚动
 *  - 左编辑选区所在的 Markdown 块 → 右预览高亮对应渲染块
 *
 * 原理（已验证）：
 *  markdown-it 顶层块 token（level===0）有 map=[startLine,endLine]；渲染产物在
 *  postProcessHtml 之后仍是「每个顶层源码块 ↔ 一个 body 直接子元素」（callout/
 *  引用/代码块/公式/列表均成立，1:1）。
 *
 * 本模块只在「预览」路径（renderPreview）调用，不污染发布/微信产物。
 */
import { JSDOM } from 'jsdom'
import { createRenderer } from './engine'
import type { StyleDefinition } from './styles'

export interface BlockRange {
  /** 源码块起始行（1-based，与编辑器行号一致） */
  startLine: number
  /** 源码块结束行（1-based） */
  endLine: number
  /** 块类型（heading_open / paragraph_open / bullet_list_open / blockquote_open / fence / ...） */
  type: string
}

/** 去掉 YAML frontmatter，返回正文（与 renderMarkdown 内部 parseFrontmatter 同口径，行号相对正文） */
function stripFrontmatter(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md)
  return m ? m[2] : md
}

/** markdown-it 顶层块起始 token 类型 */
const BLOCK_START = new Set([
  'heading_open',
  'paragraph_open',
  'bullet_list_open',
  'ordered_list_open',
  'blockquote_open',
  'table_open',
  'fence',
  'code_block',
  'hr',
  'thematic_break',
])

/**
 * 解析 markdown 的顶层块范围序列（1-based 行号）。
 * 与 markdownBlockRanges 用同一 createRenderer 解析，保证与渲染侧块序一致。
 */
export function markdownBlockRanges(
  md: string,
  style?: StyleDefinition,
  styleName = 'swiss',
): BlockRange[] {
  if (!md) return []
  const body = stripFrontmatter(md)
  const mdIt = createRenderer(style || ({} as StyleDefinition), styleName)
  const tokens = mdIt.parse(body, {})
  const blocks: BlockRange[] = []
  for (const t of tokens) {
    if (!t.map || t.level !== 0) continue
    if (!BLOCK_START.has(t.type)) continue
    blocks.push({ startLine: t.map[0] + 1, endLine: t.map[1], type: t.type })
  }
  return blocks
}

export interface AnnotateBlocksResult {
  html: string
  /** 顶层块根元素数（应对应 markdownBlockRanges 的 blocks.length） */
  count: number
}

/**
 * 给渲染后 HTML 的每个「顶层块根元素」注入 data-block="N"。
 * 必须在 postProcessHtml 之后调用（此时 body 直接子元素与顶层源码块 1:1）。
 * N 与 markdownBlockRanges 返回的数组下标对应。
 */
export function annotateBlocks(html: string): AnnotateBlocksResult {
  if (!html) return { html, count: 0 }
  const dom = new JSDOM(html)
  const doc = dom.window.document
  const roots = Array.from(doc.body.children) as Element[]
  roots.forEach((el, i) => el.setAttribute('data-block', String(i)))
  return { html: doc.body.innerHTML, count: roots.length }
}
