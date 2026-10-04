/**
 * Markdown → ProseMirror JSON 转换（小红书草稿用）
 *
 * 小红书发布需要把文章写入页面 IndexedDB 的 article-draft store，其
 * richJson 字段是 ProseMirror 文档 JSON。原版用 bundle 内联的整套
 * markdown→prosemirror 工具链（混淆压缩、依赖页面行为），这里用 marked
 * AST 直接构建等价结构。
 *
 * ⚠️ 兼容性（2026-08-15 实测锁定）：小红书长文编辑器 schema 只接受
 * `doc > paragraph > text` 且 text 不带 marks——任何额外块节点
 * （heading/bulletList/blockquote/codeBlock/horizontalRule）或 marks
 * （bold/italic/...）都会导致整篇正文校验失败被丢弃（草稿只有标题）。
 * 因此所有格式一律降级为纯段落纯文本；图片保留 image 节点（长文核心能力）。
 *
 * 图片节点需先经 uploadImage 回调上传，因此转换是异步的。
 */
import { marked, type Token, type Tokens } from 'marked'

export interface PMImageUploadResult {
  url: string
  width?: number
  height?: number
  fileId?: string
}

export interface MarkdownToProseMirrorOptions {
  uploadImage?: (src: string) => Promise<PMImageUploadResult>
  onImageProgress?: (current: number, total: number) => void
}

type PMNode = Record<string, unknown>

// 所有行内格式（粗/斜/删/行内码/链接）一律降级为纯文本——小红书 schema 不接受 marks
function inlineToPM(
  tokens: Tokens.Generic[] | undefined,
  opts: MarkdownToProseMirrorOptions,
): PMNode[] {
  const out: PMNode[] = []
  for (const tok of tokens || []) {
    switch (tok.type) {
      case 'text': {
        const text = (tok as Tokens.Text).text
        if (text && text !== '') out.push({ type: 'text', text })
        break
      }
      case 'strong':
        out.push({ type: 'text', text: inlineText(tok as Tokens.Strong) })
        break
      case 'em':
        out.push({ type: 'text', text: inlineText(tok as Tokens.Em) })
        break
      case 'del':
        out.push({ type: 'text', text: inlineText(tok as Tokens.Del) })
        break
      case 'codespan':
        out.push({ type: 'text', text: (tok as Tokens.Codespan).text })
        break
      case 'link': {
        const t = tok as Tokens.Link
        const content = inlineToPM(t.tokens, opts)
        if (content.length === 0) break
        out.push(...content)
        break
      }
      case 'image': {
        const t = tok as Tokens.Image
        const img = imageToPM(t.href, t.text || t.title || '', opts) as unknown as PMNode | null
        if (img) out.push(img)
        break
      }
      default:
        break
    }
  }
  return out
}

function inlineText(tok: Tokens.Strong | Tokens.Em | Tokens.Del): string {
  if (!tok.tokens) return ''
  let s = ''
  for (const c of tok.tokens) {
    if (c.type === 'text') s += (c as Tokens.Text).text
    else if (c.type === 'codespan') s += (c as Tokens.Codespan).text
    else if ('tokens' in c && c.tokens) s += inlineText(c as Tokens.Strong)
  }
  return s
}

async function imageToPM(
  src: string,
  alt: string,
  opts: MarkdownToProseMirrorOptions,
): Promise<PMNode | null> {
  let url = src
  let width = 800
  let height = 600
  if (opts.uploadImage) {
    try {
      const r = await opts.uploadImage(src)
      url = r.url
      width = r.width || 800
      height = r.height || 600
    } catch {
      return { type: 'paragraph', content: [{ type: 'text', text: `[图片: ${alt || src}]` }] }
    }
  }
  // 小红书 image 节点格式（原版 bundle 实测）：attrs.imgs 数组，元素 {src, desc, percent, width, height}
  const attrs: Record<string, unknown> = {
    imgs: [{ src: url, desc: alt || '', percent: 30, width, height }],
  }
  return { type: 'image', attrs }
}

async function blockToPM(tok: Token, opts: MarkdownToProseMirrorOptions): Promise<PMNode | null> {
  switch (tok.type) {
    // 所有块级格式一律降级为 paragraph（小红书 schema 不接受 heading/list/quote/code/hr）
    case 'heading': {
      const t = tok as Tokens.Heading
      const content = inlineToPM(t.tokens, opts)
      return content.length > 0 ? { type: 'paragraph', content } : null
    }
    case 'paragraph': {
      const t = tok as Tokens.Paragraph
      // 段落内图片单独成段
      const hasImage = (t.tokens || []).some((x) => x.type === 'image')
      if (hasImage) {
        const out: PMNode[] = []
        let buf: PMNode[] = []
        for (const c of t.tokens || []) {
          if (c.type === 'image') {
            if (buf.length > 0) {
              out.push({ type: 'paragraph', content: buf })
              buf = []
            }
            const img = await imageToPM(
              (c as Tokens.Image).href,
              (c as Tokens.Image).text || '',
              opts,
            )
            if (img) out.push(img)
          } else {
            buf.push(...inlineToPM([c], opts))
          }
        }
        if (buf.length > 0) out.push({ type: 'paragraph', content: buf })
        return out.length > 0 ? (out as unknown as PMNode) : null
      }
      const content = inlineToPM(t.tokens, opts)
      return content.length > 0 ? { type: 'paragraph', content } : null
    }
    case 'blockquote': {
      const t = tok as Tokens.Blockquote
      const content: PMNode[] = []
      for (const b of t.tokens) {
        const node = await blockToPM(b, opts)
        if (node && Array.isArray(node)) content.push(...node)
        else if (node) content.push(node)
      }
      // 扁平化为单层 paragraph（防嵌套 paragraph 不被 schema 接受）
      const texts: PMNode[] = []
      const collect = (nodes: PMNode[]) => {
        for (const n of nodes) {
          if (n.type === 'text') texts.push(n)
          else if (Array.isArray(n.content)) collect(n.content as PMNode[])
        }
      }
      collect(content)
      return texts.length > 0 ? { type: 'paragraph', content: texts } : null
    }
    case 'list': {
      const t = tok as Tokens.List
      const out: PMNode[] = []
      for (const item of t.items) {
        const texts: PMNode[] = []
        const collect = (nodes: PMNode[]) => {
          for (const n of nodes) {
            if (n.type === 'text') texts.push(n)
            else if (Array.isArray(n.content)) collect(n.content as PMNode[])
          }
        }
        for (const b of item.tokens) {
          if (b.type === 'text' || b.type === 'paragraph') {
            collect(
              inlineToPM(
                (b as Tokens.Paragraph).tokens || (b as Tokens.Text).tokens,
                opts,
              ) as PMNode[],
            )
          } else if (b.type === 'list') {
            const nested = await blockToPM(b, opts)
            if (nested && Array.isArray(nested)) collect(nested as PMNode[])
          }
        }
        if (texts.length > 0) out.push({ type: 'paragraph', content: texts })
      }
      return out.length > 0 ? (out as unknown as PMNode) : null
    }
    case 'code': {
      const t = tok as Tokens.Code
      return { type: 'paragraph', content: [{ type: 'text', text: t.text }] }
    }
    case 'hr':
      return null
    case 'table': {
      const t = tok as Tokens.Table
      const lines: string[] = []
      const headerRow = t.header.map((c) => c.text || '').join(' | ')
      if (headerRow.trim()) lines.push(headerRow)
      for (const row of t.rows) lines.push(row.map((c) => c.text || '').join(' | '))
      if (lines.length === 0) return null
      return { type: 'paragraph', content: [{ type: 'text', text: lines.join('\n') }] }
    }
    case 'space':
      return null
    default:
      return null
  }
}

export async function markdownToProseMirror(
  markdown: string,
  opts: MarkdownToProseMirrorOptions = {},
): Promise<PMNode> {
  const tokens = marked.lexer(markdown || '', { gfm: true })
  const images = collectImageCount(tokens)
  let done = 0
  const onProgress = opts.onImageProgress
  const uploadImage = opts.uploadImage
    ? async (src: string) => {
        const r = await (opts.uploadImage as (s: string) => Promise<PMImageUploadResult>)(src)
        done += 1
        if (onProgress) onProgress(done, images)
        return r
      }
    : undefined
  const content: PMNode[] = []
  for (const tok of tokens) {
    const node = await blockToPM(tok, { ...opts, uploadImage })
    if (node && Array.isArray(node)) content.push(...(node as PMNode[]))
    else if (node) content.push(node)
  }
  if (content.length === 0) content.push({ type: 'paragraph', content: [] })
  return { type: 'doc', content }
}

function collectImageCount(tokens: Token[]): number {
  let n = 0
  const walk = (list: Token[]) => {
    for (const t of list) {
      if (t.type === 'image') n += 1
      if ('tokens' in t && Array.isArray((t as { tokens?: Token[] }).tokens))
        walk((t as { tokens: Token[] }).tokens)
    }
  }
  walk(tokens)
  return n
}
