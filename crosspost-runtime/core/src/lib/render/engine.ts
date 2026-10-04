/**
 * 元素级渲染：把 Markdown 元素渲染成带 inline style 的 HTML 片段。
 *
 * 三条硬约束：
 *  1. 视觉只能写在元素自身的 `style` 里 —— 不输出 `<style>`，也不让 `class` 承载任何视觉；
 *  2. 引擎内部**没有**"逐元素样式串字典" —— 每个元素的 style 都由参数推导出来；
 *  3. 输出永远是不含 `<html>/<head>/<body>` 的片段。
 *
 * 参数缺省即派生：只给核心四色也能得到一套完整样式。派生量（深色判定、细分割线、
 * 块间距、字体栈）一律在 `resolveParams` 里一次算完，元素规则只做纯字符串拼装。
 */

import MarkdownIt, { type MarkdownIt as MarkdownItInstance, type Token } from 'markdown-it'
// @ts-expect-error markdown-it-footnote 未随包提供类型声明
import footnote from 'markdown-it-footnote'
import { headingCloseHtml, headingOpenHtml, type HeadingStructure } from './headings'
import {
  BASE_STYLE_PARAMS,
  resolveStyleParams,
  type BlockquoteStyle,
  type CodeBlockStyle,
  type Density,
  type EmphasisStyle,
  type HeadingProfile,
  type ImageShadow,
} from './styles'
import { detectAsciiTable, parseAsciiTableRows, wrapCodeLines } from './code'

/* ────────────────────────────── 参数模型 ────────────────────────────── */

export type BlockquoteStructure = BlockquoteStyle
export type CodeBlockStructure = CodeBlockStyle

/** 已派生的渲染参数：元素级规则唯一的输入 */
export interface RenderParams {
  bg: string
  text: string
  accent: string
  secondary: string
  hairline: string
  isDark: boolean
  font: string
  monoFont: string
  baseFontSize: string
  lineHeight: number
  listItemLineHeight: number
  headingSizes: { h1: string; h2: string; h3: string; h4: string }
  headingUppercase: boolean
  blockGap: string
  paragraphGap: string
  containerPadding: string
  density: Density
  radius: string
  headingProfile: HeadingProfile
  headingStructure: HeadingStructure
  h3Structure: HeadingStructure
  headingBg: string
  headingBorderColor: string
  headingColor: string
  borderWidth: string
  headingBorderWidth: string
  headingRuleWidth: string
  headingRuleMaxWidth: string
  blockquoteStructure: BlockquoteStructure
  blockquoteBg: string
  blockquoteBorderColor: string
  blockquoteBorderWidth: string
  blockquoteTextColor: string
  blockquoteItalic: boolean
  blockquoteOpacity: number
  italicQuoteBg: string
  italicQuoteBorderColor: string
  codeBlockStructure: CodeBlockStructure
  codeBg: string
  codeBorderColor: string
  codeText: string
  codeFontSize: string
  codeSpanBg: string
  codeSpanText: string
  codeWrapEnabled: boolean
  codeWrapWidth: number
  listBullet: string
  listBulletSize: string
  imageRadius: string
  imageShadow: ImageShadow
  captionColor: string
  captionSuppress: string[]
  linkColor: string
  linkUnderline: boolean
  emStyle: EmphasisStyle
  strongColor: string
  emphasisColor: string
  hrVisible: boolean
  hrColor: string
  hrWidth: string
  tableBorderColor: string
  tableCellBorderColor: string
  tableHeadBg: string
  tableHeadText: string
  notesColor: string
  notesNumberColor: string
  notesLabelColor: string
  metaBoxBg: string
  metaBoxBorder: string
  headerLabel?: string
  headerTitle?: string
  footerStyle: string
  calloutPalette: Record<string, unknown>
  /** 与底色对比安全的前景色（装饰色贴近底色时换白） */
  contrastSafeText: string
}

/** 字体类 → 系统字体栈（文章内不加载 webfont，只用系统字体） */
const FONT_STACKS: Record<string, string> = {
  'sans-ui':
    "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  'sans-geo':
    "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  'serif-latin': "Georgia, 'Times New Roman', 'Songti SC', 'Noto Serif CJK SC', 'SimSun', serif",
  'serif-cjk': "'Palatino Linotype', 'Kaiti SC', 'STKaiti', 'Kaiti', Georgia, serif",
  mono: "Menlo, Monaco, Consolas, 'Courier New', 'PingFang SC', 'Microsoft YaHei', monospace",
  'display-sans':
    "Impact, 'Arial Black', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
}

/** 样式对象缺字段时的兜底色（保证空对象也能渲染） */
const FALLBACK_COLORS = { bg: '#ffffff', text: '#000000', accent: '#e62e2e', secondary: '#666666' }

/**
 * 参数缺失时的中性缺省：直接问参数模型要，而不是在本文件再写一份字面量
 * （否则同一个缺省会有两处定义，迟早分叉）。
 */
const NEUTRAL_PARAMS = resolveStyleParams(BASE_STYLE_PARAMS)

const HEADING_STRUCTURES = ['plain', 'left-border', 'underline', 'bg-block'] as const
const BLOCKQUOTE_STRUCTURES = ['left-border', 'full-box', 'plain'] as const
const CODE_STRUCTURES = ['left-bar', 'full-border'] as const
const SHADOWS = ['none', 'soft', 'strong'] as const
const DENSITIES = ['compact', 'normal', 'airy'] as const
const HEADING_PROFILES = ['document', 'slide', 'structured'] as const

type Bag = Record<string, unknown>

function bagOf(value: unknown): Bag {
  return value && typeof value === 'object' ? (value as Bag) : {}
}

function readString(bag: Bag, key: string, fallback: string): string {
  const value = bag[key]
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

function readOptionalString(bag: Bag, key: string): string | undefined {
  const value = bag[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function readNumber(bag: Bag, key: string, fallback: number): number {
  const value = bag[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return fallback
}

function readBoolean(bag: Bag, key: string, fallback: boolean): boolean {
  const value = bag[key]
  return typeof value === 'boolean' ? value : fallback
}

/** 结构枚举只接受白名单取值，非法值静默回落（校验告警由样式加载侧负责） */
function readEnum<T extends string>(bag: Bag, key: string, allowed: readonly T[], fallback: T): T {
  const value = bag[key]
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function readStringList(bag: Bag, key: string, fallback: string[]): string[] {
  const value = bag[key]
  if (!Array.isArray(value)) return fallback
  const items = value.filter((entry): entry is string => typeof entry === 'string')
  return items.length ? items : fallback
}

/** 字体值：认得字体类就换成系统栈，否则原样用（双引号归一为单引号，避免截断 style 属性） */
function resolveFont(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return fallback
  const known = FONT_STACKS[raw]
  if (known) return known
  return raw.replace(/"/g, "'")
}

/** 解析 `#RGB` / `#RRGGBB` 的感知亮度，判断底色是否属于深色主题 */
function isDarkHex(color: string): boolean {
  const matched = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!matched) return false
  let hex = matched[1]
  if (hex.length === 3)
    hex = hex
      .split('')
      .map((ch) => ch + ch)
      .join('')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return (299 * r + 587 * g + 114 * b) / 1000 < 128
}

/** 前景/底色的感知距离过小 → 用白色，避免"极亮蓝底 + 深色装饰线"这类隐形组合 */
function contrastSafe(background: string, foreground: string): string {
  const luminance = (color: string): number | null => {
    const matched = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
    if (!matched) return null
    let hex = matched[1]
    if (hex.length === 3)
      hex = hex
        .split('')
        .map((ch) => ch + ch)
        .join('')
    return (
      (299 * parseInt(hex.slice(0, 2), 16) +
        587 * parseInt(hex.slice(2, 4), 16) +
        114 * parseInt(hex.slice(4, 6), 16)) /
      1000
    )
  }
  const a = luminance(background)
  const b = luminance(foreground)
  if (a === null || b === null) return foreground
  return Math.abs(a - b) < 40 ? '#ffffff' : foreground
}

/**
 * 把样式对象派生成完整的渲染参数。
 * 传入已派生过的参数对象时结果不变（幂等），因此调用方可以放心重复调用。
 */
export function resolveParams(style: unknown, _styleName = 'swiss'): RenderParams {
  const bag = bagOf(style)

  const bg = readString(bag, 'bg', FALLBACK_COLORS.bg)
  const text = readString(bag, 'text', FALLBACK_COLORS.text)
  const accent = readString(bag, 'accent', FALLBACK_COLORS.accent)
  const secondary = readString(bag, 'secondary', FALLBACK_COLORS.secondary)
  const isDark = isDarkHex(bg)

  const density = readEnum<Density>(bag, 'density', DENSITIES, 'normal')
  const gapScale = density === 'compact' ? 0.85 : density === 'airy' ? 1.25 : 1
  const gapPx = Math.round(16 * gapScale)
  const blockGap = readString(bag, 'blockGap', `${gapPx}px`)
  const paragraphGap = readString(bag, 'paragraphGap', `${gapPx}px 0`)

  const radius = readString(bag, 'radius', '0')
  const borderWidth = readString(bag, 'borderWidth', '3px')
  const blockquoteStructure = readEnum<BlockquoteStructure>(
    bag,
    'blockquoteStructure',
    BLOCKQUOTE_STRUCTURES,
    'left-border',
  )
  const codeBlockStructure = readEnum<CodeBlockStructure>(
    bag,
    'codeBlockStructure',
    CODE_STRUCTURES,
    'left-bar',
  )
  const strongColor = readString(bag, 'strongColor', 'inherit')
  const headingBg = readString(bag, 'headingBg', '#f5f5f5')
  const headingColorRaw = readString(bag, 'headingColor', text)

  const headingSizesBag = bagOf(bag.headingSizes)
  const headingSizes = {
    h1: readString(headingSizesBag, 'h1', '28px'),
    h2: readString(headingSizesBag, 'h2', '22px'),
    h3: readString(headingSizesBag, 'h3', '19px'),
    h4: readString(headingSizesBag, 'h4', '16px'),
  }

  const headingStructure = readEnum<HeadingStructure>(
    bag,
    'headingStructure',
    HEADING_STRUCTURES,
    'plain',
  )

  return {
    bg,
    text,
    accent,
    secondary,
    hairline: readString(bag, 'hairline', isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.10)'),
    isDark,
    font: resolveFont(bag.font, FONT_STACKS['sans-ui']),
    monoFont: resolveFont(bag.monoFont, FONT_STACKS.mono),
    baseFontSize: readString(bag, 'baseFontSize', '15px'),
    lineHeight: readNumber(bag, 'lineHeight', 1.75),
    listItemLineHeight: readNumber(bag, 'listItemLineHeight', 1.6),
    headingSizes,
    headingUppercase: readBoolean(bag, 'headingUppercase', false),
    blockGap,
    paragraphGap,
    containerPadding: readString(bag, 'containerPadding', '15px 12px'),
    density,
    radius,
    headingProfile: readEnum<HeadingProfile>(bag, 'headingProfile', HEADING_PROFILES, 'document'),
    headingStructure,
    h3Structure: readEnum<HeadingStructure>(
      bag,
      'h3Structure',
      HEADING_STRUCTURES,
      headingStructure,
    ),
    headingBg,
    headingBorderColor: readString(bag, 'headingBorderColor', accent),
    // 字色与底色一致会让文字隐形，此时回落到正文色
    headingColor: headingColorRaw === headingBg ? text : headingColorRaw,
    borderWidth,
    headingBorderWidth: readString(bag, 'headingBorderWidth', borderWidth),
    headingRuleWidth: readString(bag, 'headingRuleWidth', '3px'),
    headingRuleMaxWidth: readString(bag, 'headingRuleMaxWidth', '180px'),
    blockquoteStructure,
    blockquoteBg: readString(bag, 'blockquoteBg', isDark ? 'rgba(255,255,255,0.05)' : '#f9f9f9'),
    blockquoteBorderColor: readString(bag, 'blockquoteBorderColor', accent),
    blockquoteBorderWidth: readString(bag, 'blockquoteBorderWidth', borderWidth),
    blockquoteTextColor: readString(
      bag,
      'blockquoteTextColor',
      blockquoteStructure === 'full-box' ? text : secondary,
    ),
    blockquoteItalic: readBoolean(bag, 'blockquoteItalic', true),
    blockquoteOpacity: readNumber(bag, 'blockquoteOpacity', 0.9),
    italicQuoteBg: readString(bag, 'italicQuoteBg', '#f5f5f5'),
    italicQuoteBorderColor: readString(bag, 'italicQuoteBorderColor', accent),
    codeBlockStructure,
    codeBg: readString(bag, 'codeBg', isDark ? 'rgba(255,255,255,0.05)' : '#f6f6f6'),
    // 单色/极客风的代码块边线取强调色，其余取次级色
    codeBorderColor: readString(
      bag,
      'codeBorderColor',
      strongColor === 'accent' ? accent : secondary,
    ),
    codeText: readString(bag, 'codeText', isDark ? text : '#333333'),
    codeFontSize: readString(bag, 'codeFontSize', '12px'),
    codeSpanBg: readString(bag, 'codeSpanBg', isDark ? 'rgba(255,255,255,0.10)' : '#f0f0f0'),
    codeSpanText: readString(bag, 'codeSpanText', strongColor === 'accent' ? accent : text),
    codeWrapEnabled: readBoolean(bag, 'codeWrapEnabled', true),
    codeWrapWidth: readNumber(bag, 'codeWrapWidth', 45),
    listBullet: readString(bag, 'listBullet', '•'),
    listBulletSize: readString(bag, 'listBulletSize', '12px'),
    imageRadius: readString(bag, 'imageRadius', radius),
    imageShadow: readEnum<ImageShadow>(bag, 'imageShadow', SHADOWS, 'soft'),
    captionColor: readString(bag, 'captionColor', NEUTRAL_PARAMS.captionColor),
    captionSuppress: readStringList(bag, 'captionSuppress', [
      'image',
      'img',
      '图片',
      'pasted image',
      'screenshot',
    ]),
    linkColor: readString(bag, 'linkColor', accent),
    linkUnderline: readBoolean(bag, 'linkUnderline', false),
    emStyle: readEnum<EmphasisStyle>(
      bag,
      'emStyle',
      ['accent-bold', 'italic'] as const,
      'accent-bold',
    ),
    strongColor,
    emphasisColor: strongColor === 'accent' ? accent : 'inherit',
    // 分隔线默认可见（产品决定）：显式 false 才关闭
    hrVisible: readBoolean(bag, 'hrVisible', true),
    hrColor: readString(bag, 'hrColor', isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.10)'),
    hrWidth: readString(bag, 'hrWidth', '1px'),
    tableBorderColor: readString(bag, 'tableBorderColor', text),
    tableCellBorderColor: readString(bag, 'tableCellBorderColor', secondary),
    tableHeadBg: readString(bag, 'tableHeadBg', isDark ? text : '#f2f2f2'),
    tableHeadText: readString(bag, 'tableHeadText', isDark ? bg : text),
    notesColor: readString(bag, 'notesColor', secondary),
    notesNumberColor: readString(bag, 'notesNumberColor', '#999999'),
    notesLabelColor: readString(bag, 'notesLabelColor', '#aaaaaa'),
    metaBoxBg: readString(bag, 'metaBoxBg', isDark ? 'rgba(255,255,255,0.04)' : '#fafafa'),
    metaBoxBorder: readString(bag, 'metaBoxBorder', '#e5e5e5'),
    headerLabel: readOptionalString(bag, 'headerLabel'),
    headerTitle: readOptionalString(bag, 'headerTitle'),
    footerStyle: readString(bag, 'footerStyle', 'plain'),
    calloutPalette: bagOf(bag.calloutPalette),
    contrastSafeText: contrastSafe(bg, text),
  }
}

/* ────────────────────────────── 工具 ────────────────────────────── */

/** HTML 转义：先 `&` 再其余，属性值与文本共用（属性值里的 `"` 必须转义） */
export function escapeHtml(input: unknown): string {
  const text =
    typeof input === 'string' ? input : input === null || input === undefined ? '' : String(input)
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 深色底上的柔和/强阴影差异只在透明度与扩散上 */
function shadowFor(kind: ImageShadow): string {
  if (kind === 'strong') return ' box-shadow: 0 8px 28px rgba(0,0,0,0.22);'
  if (kind === 'soft') return ' box-shadow: 0 4px 15px rgba(0,0,0,0.10);'
  return ''
}

/* ────────────────────────── 元素级样式推导 ────────────────────────── */

const containerStyle = (p: RenderParams): string =>
  `background-color: ${p.bg}; color: ${p.text}; font-family: ${p.font};` +
  ` padding: ${p.containerPadding};`

const paragraphStyle = (p: RenderParams, inList: boolean): string =>
  inList
    ? `font-size: ${p.baseFontSize}; line-height: ${p.listItemLineHeight}; margin: 0; color: ${p.text};`
    : `font-size: ${p.baseFontSize}; line-height: ${p.lineHeight}; margin: ${p.paragraphGap}; color: ${p.text};`

const strongStyle = (p: RenderParams): string => `font-weight: bold; color: ${p.emphasisColor};`

const emphasisStyle = (p: RenderParams): string =>
  p.emStyle === 'italic'
    ? 'font-style: italic;'
    : `font-style: normal; color: ${p.accent}; font-weight: bold;`

const inlineCodeStyle = (p: RenderParams): string =>
  `background: ${p.codeSpanBg}; padding: 2px 4px; font-size: 13px; border-radius: ${p.radius};` +
  ` color: ${p.codeSpanText}; font-family: ${p.monoFont};`

const linkStyle = (p: RenderParams): string =>
  `color: ${p.linkColor}; text-decoration: ${p.linkUnderline ? 'underline' : 'none'};` +
  ' word-break: break-word;'

const listBlockStyle = (p: RenderParams): string => `margin: ${p.blockGap} 0;`

const listItemStyle = (): string => 'margin: 8px 0; display: flex; align-items: flex-start;'

const listMarkerStyle = (p: RenderParams): string =>
  `color: ${p.accent}; font-weight: bold; margin-right: 8px; font-size: ${p.listBulletSize};` +
  ' line-height: 1.2; flex: none;'

const listContentStyle = (p: RenderParams): string =>
  `font-size: ${p.baseFontSize}; line-height: ${p.listItemLineHeight}; color: ${p.text};` +
  ` font-family: ${p.font}; flex: 1; min-width: 0;`

const imageOuterStyle = (): string => 'margin: 25px 0; text-align: center;'

const imageStyle = (p: RenderParams): string =>
  `max-width: 100%; border-radius: ${p.imageRadius}; display: block; margin: 0 auto;` +
  `${shadowFor(p.imageShadow)}`

const captionStyle = (p: RenderParams): string =>
  `color: ${p.captionColor}; font-size: 13px; margin-top: 10px;`

const codeOuterStyle = (p: RenderParams): string => {
  const shape =
    p.codeBlockStructure === 'full-border'
      ? `border: 1px solid ${p.codeBorderColor}; border-radius: ${p.radius};`
      : `border-radius: 0; border-left: 3px solid ${p.codeBorderColor};`
  return `margin: ${p.blockGap} 0; padding: 15px; background-color: ${p.codeBg}; overflow-x: auto; ${shape}`
}

const preStyle = (p: RenderParams): string =>
  `margin: 0; font-family: ${p.monoFont}; font-size: ${p.codeFontSize}; line-height: 1.5;` +
  ` white-space: pre-wrap; word-break: break-word; color: ${p.codeText};`

const tableScrollStyle = (): string =>
  'margin: 25px 0; overflow-x: auto; -webkit-overflow-scrolling: touch;'

const tableStyle = (p: RenderParams): string =>
  `border-collapse: collapse; width: 100%; border: 1px solid ${p.tableBorderColor};` +
  ` background-color: ${p.bg}; font-size: 14px;`

const tableRowStyle = (p: RenderParams): string => `border-bottom: 1px solid ${p.hairline};`

const tableCellStyle = (p: RenderParams, align: string, header: boolean): string =>
  header
    ? `border: 1px solid ${p.tableCellBorderColor}; padding: 12px 10px; text-align: ${align};` +
      ` background-color: ${p.tableHeadBg}; color: ${p.tableHeadText}; font-weight: bold;`
    : `border: 1px solid ${p.tableCellBorderColor}; padding: 10px; text-align: ${align};` +
      ` color: ${p.text};`

const hrStyle = (p: RenderParams): string =>
  `border: none; border-top: ${p.hrWidth} solid ${p.hrColor}; margin: ${p.blockGap} 0;`

/* ────────────────────── 代码块 / 表格 / 图片 ────────────────────── */

/** 代码块内容：转义 `& < >`，换行写成 `<br>`（`pre` 用 pre-wrap，不依赖滚动容器） */
function codeBlockHtml(content: string, p: RenderParams): string {
  const wrapped = p.codeWrapEnabled ? wrapCodeLines(content, p.codeWrapWidth) : content
  const body = escapeHtml(wrapped).replace(/\n/g, '<br>')
  return (
    `<section style="${codeOuterStyle(p)}">` + `<pre style="${preStyle(p)}">${body}</pre></section>`
  )
}

/** 表格：首行表头 + 其余表体，单元格文本转义；列对齐缺省左对齐 */
function tableRowsHtml(rows: string[][], p: RenderParams): string {
  if (rows.length === 0) return ''
  const [head, ...body] = rows
  const headCells = head
    .map((cell) => `<th style="${tableCellStyle(p, 'left', true)}">${escapeHtml(cell)}</th>`)
    .join('')
  const bodyRows = body
    .map(
      (row) =>
        `<tr style="${tableRowStyle(p)}">` +
        row
          .map((cell) => `<td style="${tableCellStyle(p, 'left', false)}">${escapeHtml(cell)}</td>`)
          .join('') +
        '</tr>',
    )
    .join('')
  return (
    `<section style="${tableScrollStyle()}">` +
    `<table style="${tableStyle(p)}"><thead><tr style="${tableRowStyle(p)}">${headCells}</tr></thead>` +
    `<tbody>${bodyRows}</tbody></table></section>`
  )
}

/** mermaid 围栏 → 外部图表服务的居中图片（内容走 URL 安全的 base64） */
function mermaidHtml(content: string): string {
  const encoded = Buffer.from(content, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const url = `https://mermaid.ink/img/${encoded}`
  const safe = escapeHtml(url)
  return (
    `<section style="margin: 25px 0; text-align: center;">` +
    `<img src="${safe}" data-src="${safe}" alt="Diagram" style="max-width: 100%; height: auto;"></section>`
  )
}

/**
 * 无语言（或 `text`/`txt`/`plain`）代码块：先试 ASCII 表格识别。
 * 识别到表格时把内容切成「表格 + 代码」混排；整块没有任何表格就按纯代码渲染。
 */
function codeOrTableHtml(content: string, allowTable: boolean, p: RenderParams): string {
  if (allowTable) {
    const segments = detectAsciiTable(content)
    if (segments) {
      const parts: string[] = []
      for (const [kind, text] of segments) {
        if (kind === 'table') parts.push(tableRowsHtml(parseAsciiTableRows(text), p))
        else if (text.trim() !== '') parts.push(codeBlockHtml(text, p))
      }
      if (parts.length === 1) return parts[0]
      // 混排仍然只产出一个顶层元素（编辑器块映射依赖这个不变式）
      if (parts.length > 1) return `<section>${parts.join('')}</section>`
    }
  }
  return codeBlockHtml(content, p)
}

const VIDEO_HOST = /(youtube\.com|youtu\.be|vimeo\.com|bilibili\.com|b23\.tv|v\.qq\.com)/i

/** 图注抑制：空 alt、占位名、纯文件名都不作为图注展示 */
function captionText(alt: string, p: RenderParams): string {
  const text = (alt || '').trim()
  if (!text) return ''
  const lower = text.toLowerCase()
  if (p.captionSuppress.some((entry) => entry.toLowerCase() === lower)) return ''
  if (lower.startsWith('pasted image')) return ''
  if (/\.(png|jpe?g|gif|webp)$/i.test(text)) return ''
  return text
}

/** 图片块：居中容器 + 图 + 可选图注；`src`/`data-src` 同值 */
function imageHtml(src: string, alt: string, p: RenderParams): string {
  const safeSrc = escapeHtml(src)
  const img =
    `<img src="${safeSrc}" data-src="${safeSrc}" alt="${escapeHtml(alt)}"` +
    ` style="${imageStyle(p)}">`
  const caption = captionText(alt, p)
  // 图注是纯文本节点，而后处理阶段会把它透过 DOM 解析器往返一次（实体被归一化）。
  // 这里做两层转义：往返后回到"一层转义"的形态，渲染结果不变，
  // 同时 `"` / `<` 不会以裸形态留在产物里（属性逃逸与脚本注入的判据都依赖这一点）。
  const captionHtml = caption
    ? `<p style="${captionStyle(p)}">${escapeHtml(escapeHtml(caption))}</p>`
    : ''
  return `<section style="${imageOuterStyle()}">${img}${captionHtml}</section>`
}

/** 视频站链接 → 文本链接，不输出 `<img>` */
function videoLinkHtml(src: string, p: RenderParams): string {
  return `<a href="${escapeHtml(src)}" style="${linkStyle(p)}">▶ 视频链接</a>`
}

/** 图片 alt 文本（markdown-it 把它放在 children 里，需要自己取） */
function imageAlt(children: Token[] | null): string {
  if (!children) return ''
  let out = ''
  for (const child of children) {
    if (child.type === 'text' || child.type === 'code_inline') out += child.content
    else if (child.children) out += imageAlt(child.children)
  }
  return out
}

/** 读 token 属性并归一成字符串（属性值在类型上是 `string | number`） */
function attrOf(token: Token, name: string): string {
  const value = token.attrGet(name)
  return value === null || value === undefined ? '' : String(value)
}

/** 列对齐：解析器把 `:--:` 语法写进 `style` 属性，必须保留（不能被覆盖丢失） */
function alignmentOf(token: Token): string {
  const decl = attrOf(token, 'style')
  const matched = /text-align\s*:\s*(left|center|right)/i.exec(decl)
  return matched ? matched[1].toLowerCase() : 'left'
}

/** 危险属性/协议清洗：原始 HTML 直通时仍要去掉可执行内容 */
function sanitizeRawHtml(raw: string): string {
  return raw
    .replace(
      /<\s*(script|style|iframe|object|embed|link|meta|form|input|video|audio|canvas)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi,
      '',
    )
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /(href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
      (whole, attr: string, value: string) => {
        const bare = value.replace(/^["']|["']$/g, '').toLowerCase()
        return /^(javascript|vbscript|data:text\/html)/.test(bare) ? `${attr}="#"` : whole
      },
    )
}

/* ────────────────────────────── 渲染器 ────────────────────────────── */

export interface RendererOptions {
  /** 每个换行渲染成 `<br>`（仅预览路径；发布路径必须关闭） */
  breaks?: boolean
  /** 是否直通作者写的原始 HTML（默认直通，但仍做清洗） */
  html?: boolean
  /**
   * 预览路径的块标注开关。关闭分隔线的样式在这里仍要占一个顶层元素，
   * 否则「源码块 ↔ 渲染根元素」的 1:1 会少一个（发布路径不传它）。
   */
  blocks?: boolean
}

/** 列表渲染期的临时状态（挂在 markdown-it 的 env 上，随一次渲染结束而释放） */
interface ListRuntime {
  depth: number
  kinds: string[]
  counters: number[]
}

function listRuntime(env: unknown): ListRuntime {
  const bag = (env || {}) as Bag
  const existing = bag.__cpListRuntime as ListRuntime | undefined
  if (existing) return existing
  const created: ListRuntime = { depth: 0, kinds: [], counters: [] }
  bag.__cpListRuntime = created
  return created
}

function listDepthOf(env: unknown): number {
  const bag = (env || {}) as Bag
  const runtime = bag.__cpListRuntime as ListRuntime | undefined
  return runtime ? runtime.depth : 0
}

/** 一个段落是否只由图片构成（此时不输出 `<p>`，让图片块成为唯一顶层元素） */
function paragraphIsImageOnly(tokens: Token[], idx: number, open: boolean): boolean {
  const inline = open ? tokens[idx + 1] : tokens[idx - 1]
  if (!inline || inline.type !== 'inline' || !inline.children) return false
  let images = 0
  for (const child of inline.children) {
    if (child.type === 'image') {
      images += 1
      continue
    }
    if (child.type === 'text' && child.content.trim() === '') continue
    return false
  }
  return images > 0
}

function headingLevel(tag: string): number {
  const digits = (tag || '').replace(/[^0-9]/g, '')
  const level = Number(digits)
  return level >= 1 && level <= 6 ? level : 1
}

/**
 * 建一个配好元素规则的 markdown-it 实例。
 * 调用方（块映射/预览）只需要 token 流，因此不传样式也能安全调用。
 */
export function createRenderer(
  style: unknown,
  styleName = 'swiss',
  options: RendererOptions = {},
): MarkdownItInstance {
  const p = resolveParams(style, styleName)
  const md = new MarkdownIt({
    html: options.html !== false,
    breaks: !!options.breaks,
    linkify: false,
    typographer: false,
  })
  md.use(footnote)

  const rules = md.renderer.rules

  /* 标题：开标签带装饰容器，内联内容由 Markdown 行内规则渲染一次 */
  rules.heading_open = (tokens, idx) => headingOpenHtml(headingLevel(tokens[idx].tag), p, styleName)
  rules.heading_close = (tokens, idx) => headingCloseHtml(headingLevel(tokens[idx].tag))

  /* 段落：紧凑列表里的段落被解析器标为 hidden（不产出 `<p>`） */
  rules.paragraph_open = (tokens, idx, _options, env) => {
    const token = tokens[idx]
    if (token.hidden) return ''
    if (paragraphIsImageOnly(tokens, idx, true)) return ''
    return `<p style="${paragraphStyle(p, listDepthOf(env) > 0)}">`
  }
  rules.paragraph_close = (tokens, idx) => {
    if (tokens[idx].hidden) return ''
    if (paragraphIsImageOnly(tokens, idx, false)) return ''
    return '</p>'
  }

  /* 引用：引擎只输出裸 blockquote，卡片化交给后处理（预览路径可保持原样） */
  rules.blockquote_open = () => '<blockquote>'
  rules.blockquote_close = () => '</blockquote>'

  /* 列表：每项一个 flex 行（标记 + 内容列），嵌套列表落在内容列里 */
  rules.bullet_list_open = (_tokens, _idx, _options, env) => {
    const runtime = listRuntime(env)
    runtime.kinds.push('ul')
    runtime.counters.push(0)
    return `<section style="${listBlockStyle(p)}">`
  }
  rules.bullet_list_close = (_tokens, _idx, _options, env) => {
    const runtime = listRuntime(env)
    runtime.kinds.pop()
    runtime.counters.pop()
    return '</section>'
  }
  rules.ordered_list_open = (tokens, idx, _options, env) => {
    const runtime = listRuntime(env)
    runtime.kinds.push('ol')
    const start = Number(attrOf(tokens[idx], 'start'))
    runtime.counters.push(Number.isFinite(start) && start > 0 ? start - 1 : 0)
    return `<section style="${listBlockStyle(p)}">`
  }
  rules.ordered_list_close = (_tokens, _idx, _options, env) => {
    const runtime = listRuntime(env)
    runtime.kinds.pop()
    runtime.counters.pop()
    return '</section>'
  }
  rules.list_item_open = (tokens, idx, _options, env) => {
    const runtime = listRuntime(env)
    runtime.depth += 1
    const kind = runtime.kinds[runtime.kinds.length - 1] || 'ul'
    let marker = p.listBullet
    if (kind === 'ol') {
      const top = runtime.counters.length - 1
      runtime.counters[top] = (runtime.counters[top] || 0) + 1
      const info = tokens[idx].info
      marker = `${/^\d+$/.test(info) ? info : String(runtime.counters[top])}.`
    }
    return (
      `<section style="${listItemStyle()}">` +
      `<span style="${listMarkerStyle(p)}">${escapeHtml(marker)}</span>` +
      `<section style="${listContentStyle(p)}">`
    )
  }
  rules.list_item_close = (_tokens, _idx, _options, env) => {
    const runtime = listRuntime(env)
    runtime.depth = Math.max(0, runtime.depth - 1)
    return '</section></section>'
  }

  /* 分隔线：默认输出细线；样式关闭它时，预览打点路径仍占一个不可见的顶层元素 */
  rules.hr = () => {
    if (p.hrVisible) return `<hr style="${hrStyle(p)}">`
    return options.blocks ? '<hr style="display: none;">' : ''
  }

  /* 代码块 */
  rules.fence = (tokens, idx) => {
    const token = tokens[idx]
    const info = (token.info || '').trim()
    const language = info.split(/\s+/)[0].toLowerCase()
    if (language === 'mermaid') return mermaidHtml(token.content)
    const allowTable = language === '' || ['text', 'txt', 'plain'].includes(language)
    return codeOrTableHtml(token.content, allowTable, p)
  }
  rules.code_block = (tokens, idx) => codeOrTableHtml(tokens[idx].content, true, p)

  /* 表格：保留解析器给出的列对齐 */
  rules.table_open = () => `<section style="${tableScrollStyle()}"><table style="${tableStyle(p)}">`
  rules.table_close = () => '</table></section>'
  rules.thead_open = () => '<thead>'
  rules.thead_close = () => '</thead>'
  rules.tbody_open = () => '<tbody>'
  rules.tbody_close = () => '</tbody>'
  rules.tr_open = () => `<tr style="${tableRowStyle(p)}">`
  rules.tr_close = () => '</tr>'
  rules.th_open = (tokens, idx) =>
    `<th style="${tableCellStyle(p, alignmentOf(tokens[idx]), true)}">`
  rules.th_close = () => '</th>'
  rules.td_open = (tokens, idx) =>
    `<td style="${tableCellStyle(p, alignmentOf(tokens[idx]), false)}">`
  rules.td_close = () => '</td>'

  /* 行内元素 */
  rules.strong_open = () => `<strong style="${strongStyle(p)}">`
  rules.strong_close = () => '</strong>'
  rules.em_open = () => `<em style="${emphasisStyle(p)}">`
  rules.em_close = () => '</em>'
  rules.s_open = () => '<del style="text-decoration: line-through;">'
  rules.s_close = () => '</del>'
  rules.code_inline = (tokens, idx) =>
    `<code style="${inlineCodeStyle(p)}">${escapeHtml(tokens[idx].content)}</code>`

  rules.link_open = (tokens, idx, _options, env) => {
    const href = attrOf(tokens[idx], 'href')
    const safe = !/^\s*(javascript|vbscript|data:text\/html)/i.test(href)
    const stack = linkStack(env)
    stack.push(safe)
    return safe
      ? `<a href="${escapeHtml(href)}" style="${linkStyle(p)}">`
      : `<span style="${linkStyle(p)}">`
  }
  rules.link_close = (_tokens, _idx, _options, env) => {
    const stack = linkStack(env)
    return stack.pop() === false ? '</span>' : '</a>'
  }

  rules.image = (tokens, idx) => {
    const token = tokens[idx]
    const src = attrOf(token, 'src')
    if (VIDEO_HOST.test(src)) return videoLinkHtml(src, p)
    return imageHtml(src, imageAlt(token.children), p)
  }

  /* 原始 HTML 直通但清洗 */
  rules.html_block = (tokens, idx) => sanitizeRawHtml(tokens[idx].content)
  rules.html_inline = (tokens, idx) => sanitizeRawHtml(tokens[idx].content)

  return md
}

/** 链接的开/闭配对状态（不安全协议的链接降级为纯文本外壳） */
function linkStack(env: unknown): boolean[] {
  const bag = (env || {}) as Bag
  const existing = bag.__cpLinkStack as boolean[] | undefined
  if (existing) return existing
  const created: boolean[] = []
  bag.__cpLinkStack = created
  return created
}

/* ────────────────────────────── 兼容入口 ────────────────────────────── */

/**
 * 取某个标签的 inline style 内容（参数推导入口）。
 *
 * 第二个参数是样式对象或已派生的参数对象；命中不了的标签返回空串。
 * 历史上这里返回的是"整元素模板串"，新模型下不存在模板字典，一律由参数算出来。
 */
export function elStyle(style: unknown, tag: string, _fallback = ''): string {
  const p = resolveParams(style)
  switch (tag) {
    case 'section':
      return containerStyle(p)
    case 'h1':
      return headingsPreview(p, 1)
    case 'h2':
      return headingsPreview(p, 2)
    case 'h3':
      return headingsPreview(p, 3)
    case 'h4':
    case 'h5':
    case 'h6':
      return headingsPreview(p, 4)
    case 'p':
      return paragraphStyle(p, false)
    case 'strong':
      return strongStyle(p)
    case 'em':
      return emphasisStyle(p)
    case 'code':
      return inlineCodeStyle(p)
    case 'pre':
      return preStyle(p)
    case 'a':
      return linkStyle(p)
    case 'img':
      return imageStyle(p)
    case 'ul':
    case 'ol':
      return listBlockStyle(p)
    case 'li':
      return listItemStyle()
    case 'hr':
      return p.hrVisible ? hrStyle(p) : ''
    case 'table':
      return tableStyle(p)
    case 'th':
      return tableCellStyle(p, 'left', true)
    case 'td':
      return tableCellStyle(p, 'left', false)
    case 'blockquote':
      return blockquotePreview(p)
    default:
      return ''
  }
}

/** 标题的内层样式（`elStyle` 用：只回内层元素的样式，不含装饰容器） */
function headingsPreview(p: RenderParams, level: number): string {
  return (
    `font-size: ${level <= 1 ? p.headingSizes.h1 : level === 2 ? p.headingSizes.h2 : level === 3 ? p.headingSizes.h3 : p.headingSizes.h4};` +
    ` font-weight: bold; color: ${p.text}; margin: 0; line-height: 1.3;`
  )
}

/** 引用的容器样式（裸 blockquote 由后处理卡片化，这里只描述卡片形态） */
function blockquotePreview(p: RenderParams): string {
  if (p.blockquoteStructure === 'plain') {
    return `padding: 8px 0; color: ${p.blockquoteTextColor};`
  }
  if (p.blockquoteStructure === 'full-box') {
    return (
      `margin: 30px 0; padding: 25px; border: 1px solid ${p.hairline};` +
      ` border-left: ${p.blockquoteBorderWidth} solid ${p.blockquoteBorderColor};` +
      ` background-color: ${p.blockquoteBg}; border-radius: ${p.radius};`
    )
  }
  return (
    `margin: ${p.blockGap} 0; padding: 16px 20px;` +
    ` border-left: ${p.blockquoteBorderWidth} solid ${p.blockquoteBorderColor};` +
    ` background-color: ${p.blockquoteBg};`
  )
}
