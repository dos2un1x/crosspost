/**
 * 渲染管线编排：Markdown → 微信兼容的 inline-style HTML 片段。
 *
 * 步骤顺序有四条硬约束（顺序错了就出错）：
 *  1. 公式占位必须在 Markdown 解析**之前**（否则 `_`/`\`/`*`/`{}` 被当成 Markdown 语法），
 *     占位替换必须在解析**之后**；
 *  2. 微信兼容后处理必须在占位替换之后（否则卡片化会把含占位符的段落包进容器）；
 *  3. 块标注在后处理之后、容器包裹之前（此刻正文顶层元素与源码顶层块一一对应）；
 *  4. 图片管线在后处理之后（此时 `data-src` 已存在，替换逻辑可以覆盖它）。
 */

import { parse as parseYaml } from 'yaml'
import { BUILTIN_STYLES, type StyleDefinition } from './styles'
import { loadCustomStyles, resolveStyle } from './custom'
import { postProcessHtml } from './wechat-post'
import { processImages } from './images'
import { createRenderer, escapeHtml, resolveParams, type RenderParams } from './engine'
import { collectFormulas, renderFormulas, replaceFormulas } from './formulas'
import { annotateBlocks, markdownBlockRanges, type BlockRange } from './markdown-blockmap'
import { normalizeBoldFlanking } from './markdown-flanking'

/**
 * 渲染域的公共出口：根入口（`@crosspost/core`）经 `lib/index.ts` 再导出本文件，
 * 因此这里要把同目录的兄弟模块一并透出（样式目录、自定义样式管理、封面/结束语、
 * 样式采样、块映射、加粗修复、后处理）。
 */
export * from './styles'
export * from './custom'
export * from './wechat-post'
export * from './images'
export * from './code'
export * from './formulas'
export * from './callouts'
export * from './headings'
export * from './engine'
export * from './analyze'
export * from './cover'
export * from './ending-card'
export * from './markdown-blockmap'
export * from './markdown-flanking'

/* ────────────────────────────── 选项与结果 ────────────────────────────── */

export interface RenderOptions {
  /** 样式名（内置或 `custom-*`），缺省 `swiss` */
  style?: string
  /** 是否输出容器 / header 条 / 元信息框 / 页脚，缺省 true */
  wrapContainer?: boolean
  /** 是否输出 frontmatter 元信息框，缺省 true */
  renderFrontmatter?: boolean
  /** 是否执行微信兼容后处理（引用卡片化、脚注扁平化、锚点解包、懒加载属性），缺省 true */
  postProcess?: boolean
  /** 是否输出块标注与块行号范围，**仅预览路径**使用 */
  blocks?: boolean
  /** 每个换行渲染成 `<br>`，**仅预览路径**使用（发布路径必须关闭） */
  breaks?: boolean
  /** 页脚文字（缺省取环境变量 `WECHAT_FOOTER_TEXT`） */
  footerText?: string
  /** Markdown 文件路径，用于解析相对图片路径 */
  mdPath?: string
  /** 图片上传器；不提供则图片管线走 dry-run */
  imageUploader?: (src: string, kind: 'local' | 'remote') => Promise<string>
  /** 可注入的图片地址缓存（键为原始地址指纹）；缺省为单次渲染内的内存表 */
  imageCache?: Map<string, string>
}

export interface RenderResult {
  /** 最终 HTML 片段（保证不含 `<html>/<head>/<body>`） */
  html: string
  /** 实际生效的样式名 */
  styleName: string
  /** 生效样式的定义对象（面板取色板用） */
  style: StyleDefinition
  /** 非致命问题 */
  warnings: string[]
  /** 解析出的 frontmatter（无则空对象） */
  frontmatter: Record<string, unknown>
  /** 仅 `blocks:true` 时返回：顶层源码块的行号范围 */
  blocks?: BlockRange[]
}

/** 图片管线的产物类型直接取实现（避免与图片模块的选项类型重复声明） */
export type ProcessedImages = Awaited<ReturnType<typeof processImages>>

export interface RenderAsyncResult extends RenderResult {
  /** 图片管线统计 */
  images?: ProcessedImages
}

/* ────────────────────────────── frontmatter ────────────────────────────── */

type Bag = Record<string, unknown>

/** 逐行 `key: value` 降级解析（YAML 不可用或解析失败时） */
function looseFrontmatter(raw: string): Record<string, unknown> {
  const fm: Record<string, unknown> = {}
  for (const line of raw.split('\n')) {
    const matched = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!matched) continue
    const value = matched[2].trim().replace(/^["']|["']$/g, '')
    fm[matched[1]] = value
  }
  return fm
}

/**
 * 拆出文件头的 YAML frontmatter 与正文。
 * frontmatter 行**不计入正文行号**（块映射依赖这一点）。
 */
export function parseFrontmatter(markdown: string): {
  fm: Record<string, unknown>
  body: string
} {
  if (!markdown) return { fm: {}, body: markdown || '' }
  const matched = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown)
  if (!matched) return { fm: {}, body: markdown }

  const raw = matched[1]
  let fm: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>
    } else {
      fm = looseFrontmatter(raw)
    }
  } catch {
    fm = looseFrontmatter(raw)
  }
  return { fm, body: matched[2] }
}

/** frontmatter 白名单字段（含别名） */
const META_FIELDS: Array<{ label: string; keys: string[] }> = [
  { label: 'source', keys: ['source'] },
  { label: 'author', keys: ['author'] },
  { label: 'published', keys: ['published', 'date'] },
  { label: 'tags', keys: ['tags'] },
  { label: 'description', keys: ['description', 'excerpt'] },
]

/** 元信息值 → 单行纯文本（数组逗号连接，`[[wiki]]` 语法剥成纯文本） */
function metaValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value))
    return value
      .map((entry) => metaValue(entry))
      .filter(Boolean)
      .join(', ')
  if (typeof value === 'object') return ''
  const text = String(value)
  return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_w, target: string, alias?: string) =>
    (alias || target).trim(),
  )
}

/** 元信息框：逐字段一行，字段名用强调色，值用次级色 */
function metaBoxHtml(fm: Record<string, unknown>, p: RenderParams): string {
  if (!fm || Object.keys(fm).length === 0) return ''
  const rows: string[] = []
  for (const field of META_FIELDS) {
    const key = field.keys.find(
      (candidate) => fm[candidate] !== undefined && fm[candidate] !== null,
    )
    if (!key) continue
    const value = metaValue(fm[key])
    if (!value) continue
    rows.push(
      `<div style="margin: 4px 0; font-size: 13px; color: ${p.secondary};">` +
        `<strong style="color: ${p.accent}; text-transform: uppercase;">${field.label}:</strong> ` +
        `${escapeHtml(value)}</div>`,
    )
  }
  if (rows.length === 0) return ''
  return (
    `<section style="margin-bottom: 30px; padding: 20px; border: 1px solid ${p.metaBoxBorder};` +
    ` background-color: ${p.metaBoxBg}; border-radius: ${p.radius};">${rows.join('')}</section>`
  )
}

/* ────────────────────────── 容器 / header / 页脚 ────────────────────────── */

const containerStyle = (p: RenderParams): string =>
  `background-color: ${p.bg}; color: ${p.text}; font-family: ${p.font};` +
  ` padding: ${p.containerPadding};`

/** header 装饰条：标签行 + 主标题 + 双细线（强调色 2px + 细线 1px） */
function headerHtml(p: RenderParams): string {
  const label = p.headerLabel
  const title = p.headerTitle
  if (!label && !title) return ''
  const labelHtml = label
    ? `<p style="margin: 0; font-size: 11px; font-weight: 800; letter-spacing: 3px;` +
      ` text-transform: uppercase; color: ${p.accent};">${escapeHtml(label)}</p>`
    : ''
  const titleHtml = title
    ? `<p style="margin: 4px 0 0; font-size: 19px; font-weight: 800; line-height: 1.4;` +
      ` color: ${p.text};">${escapeHtml(title)}</p>`
    : ''
  return (
    `<section style="margin-bottom: 18px;">${labelHtml}${titleHtml}` +
    `<div style="border-bottom: 2px solid ${p.accent}; margin-top: 10px;"></div>` +
    `<div style="border-top: 1px solid ${p.hairline}; margin-top: 2px;"></div></section>`
  )
}

/** 页脚：`rule` = 粗线版，其余（`plain`）= 细线版 */
function footerHtml(p: RenderParams, text: string): string {
  if (!text) return ''
  const common = 'text-align: center; text-transform: uppercase;'
  if (p.footerStyle === 'rule') {
    return (
      `<section style="margin-top: 60px; ${common} border-top: 5px solid ${p.text};` +
      ` padding-top: 25px; font-size: 14px; font-weight: 900; letter-spacing: 2px;` +
      ` color: ${p.secondary};">${escapeHtml(text)}</section>`
    )
  }
  return (
    `<section style="margin-top: 50px; ${common} border-top: 1px solid ${p.hairline};` +
    ` padding-top: 20px; font-size: 12px; font-weight: 600; letter-spacing: 1px;` +
    ` color: ${p.secondary};">${escapeHtml(text)}</section>`
  )
}

/* ────────────────────────────── 样式解析 ────────────────────────────── */

/** 自定义样式快照：兼容实现返回的 `{styles, warnings}` 形态 */
function customSnapshot(): { styles: Record<string, StyleDefinition>; warnings: string[] } {
  const raw = loadCustomStyles() as unknown
  const bag = raw && typeof raw === 'object' ? (raw as Bag) : {}
  const styles =
    bag.styles && typeof bag.styles === 'object'
      ? (bag.styles as Record<string, StyleDefinition>)
      : {}
  const warnings = Array.isArray(bag.warnings)
    ? bag.warnings.filter((entry): entry is string => typeof entry === 'string')
    : []
  return { styles, warnings }
}

function warningsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/** 内置优先 → 再 custom；读不到就返回空（由调用方抛"未知样式"） */
function findStyle(name: string): { style?: StyleDefinition; warnings: string[] } {
  const builtin = (BUILTIN_STYLES as Record<string, StyleDefinition | undefined>)[name]
  if (builtin) return { style: builtin, warnings: [] }

  const snapshot = customSnapshot()
  const custom = snapshot.styles[name]
  if (custom) return { style: custom, warnings: snapshot.warnings }

  try {
    const resolved = resolveStyle(name) as unknown
    const bag = resolved && typeof resolved === 'object' ? (resolved as Bag) : {}
    const style = bag.style as StyleDefinition | undefined
    if (style) {
      return { style, warnings: snapshot.warnings.concat(warningsOf(bag.warnings)) }
    }
  } catch {
    /* 未知样式的判定统一在下面抛，避免把解析实现的差异暴露给调用方 */
  }
  return { warnings: snapshot.warnings }
}

/** 内置 + 自定义样式名（custom 按文件名排序，保证确定性） */
export function listStyleNames(): string[] {
  const builtin = Object.keys(BUILTIN_STYLES)
  const custom = Object.keys(customSnapshot().styles)
    .filter((name) => !builtin.includes(name))
    .sort()
  return builtin.concat(custom)
}

/* ────────────────────────────── 管线 ────────────────────────────── */

/** Obsidian `![[图.png|别名]]` → 标准图片语法（路径两侧加 `<>` 以容忍空格） */
function expandWikiImages(markdown: string): string {
  return markdown.replace(
    /!\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g,
    (_whole, target: string, alias?: string) => {
      const path = target.trim()
      const label = (alias || '').trim() || path
      return `![${label}](<${path}>)`
    },
  )
}

/** 去掉可能出现的文档级标签，只留正文片段 */
function fragmentOf(html: string): string {
  if (!/<html|<head|<body/i.test(html)) return html
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)
  if (body) return body[1]
  return html.replace(/<\/?(?:html|head|body)[^>]*>/gi, '')
}

function footerTextOf(options: RenderOptions): string {
  if (typeof options.footerText === 'string') return options.footerText.trim()
  const fromEnv = process.env.WECHAT_FOOTER_TEXT
  return typeof fromEnv === 'string' ? fromEnv.trim() : ''
}

function unknownStyleError(name: string): Error {
  const available = listStyleNames().join('、')
  return new Error(`未知样式："${name}"；可用样式：${available}`)
}

/**
 * 同步渲染（不含图片管线）。
 */
export function renderMarkdown(markdown: string, options: RenderOptions = {}): RenderResult {
  const styleName = options.style || 'swiss'
  const { style, warnings } = findStyle(styleName)
  if (!style) throw unknownStyleError(styleName)

  const params = resolveParams(style, styleName)
  const source = typeof markdown === 'string' ? markdown : ''
  const { fm, body } = parseFrontmatter(source)

  // 4–6：公式收集 → 渲染 → 加粗 flanking 修复
  const collection = collectFormulas(expandWikiImages(body))
  const formulaResults = renderFormulas(collection.items)
  const prepared = normalizeBoldFlanking(collection.text)

  // 8：Markdown 解析 + 元素渲染（blocks 只影响"关闭分隔线时是否留占位元素"）
  const renderer = createRenderer(style, styleName, {
    breaks: !!options.breaks,
    blocks: !!options.blocks,
  })
  let html = renderer.render(prepared, {})

  // 9：占位替换
  html = replaceFormulas(html, collection.items, formulaResults, {
    isDark: params.isDark,
    textColor: params.text,
    blockGap: params.blockGap,
  })

  // 10：微信兼容后处理
  if (options.postProcess !== false) {
    html = postProcessHtml(html, style, styleName)
  }
  html = fragmentOf(html)

  // 11：块标注（仅预览路径）
  let blocks: BlockRange[] | undefined
  if (options.blocks) {
    html = annotateBlocks(html).html
    blocks = markdownBlockRanges(source, style, styleName)
  }

  // 12：容器包裹（+ header 条 + 元信息框 + 页脚）
  if (options.wrapContainer !== false) {
    const metaBox = options.renderFrontmatter !== false ? metaBoxHtml(fm, params) : ''
    html =
      `<section style="${containerStyle(params)}">` +
      headerHtml(params) +
      metaBox +
      html +
      footerHtml(params, footerTextOf(options)) +
      '</section>'
  }

  const result: RenderResult = {
    html,
    styleName,
    style,
    warnings,
    frontmatter: fm,
  }
  if (blocks) result.blocks = blocks
  return result
}

/**
 * 异步渲染：先跑同步管线，再把图片 `src`/`data-src` 换成图床地址。
 * 未提供上传器时图片管线是 dry-run（HTML 原样返回，计数全 0）。
 */
export async function renderMarkdownAsync(
  markdown: string,
  options: RenderOptions = {},
): Promise<RenderAsyncResult> {
  const base = renderMarkdown(markdown, options)
  const processed = await processImages(base.html, {
    uploader: options.imageUploader,
    mdPath: options.mdPath,
    cache: options.imageCache,
  })
  return { ...base, html: fragmentOf(processed.html), images: processed }
}
