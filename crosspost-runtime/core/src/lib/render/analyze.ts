/**
 * 样式采样（M10）——从一篇已有文章（URL 或 HTML）反推出一组参数
 *
 * 通道：
 *   1. **首选**：无头浏览器加载页面并读取**计算样式**（能拿到外部样式表、继承、
 *      `<style>` 块的真实结果）。浏览器不可用时自动降级，不抛错。
 *   2. **降级**：纯 DOM 解析，只读**行内 style**（读不到外部样式表）。
 *
 * 输出是一份"采样参数"（沿用参数模型的字段命名，尺寸/颜色以可读字符串给出）:
 *   - 颜色统一为大写 6 位 hex
 *   - `line_height` 归一为"行高像素 / 字号"的比值
 *   - 附带 `source_title` 与采样通道标记
 *
 * 采样失败**不抛异常**：返回空参数 + `error` 说明，由调用方决定如何提示。
 */

import { JSDOM } from 'jsdom'
import { parseHexColor, type BlockquoteStyle, type HeadingStyle } from './styles'

/* ══════════════════════════════════════════════════════════════════════
 * 类型
 * ══════════════════════════════════════════════════════════════════════ */

export interface SampledStyle {
  bg?: string
  text?: string
  accent?: string
  secondary?: string
  font?: string
  font_size?: string
  line_height?: string
  border_width?: string
  heading_style?: HeadingStyle
  heading_bg?: string
  heading_border_color?: string
  heading_color?: string
  h3_style?: HeadingStyle
  h3_border_color?: string
  blockquote_style?: BlockquoteStyle
  blockquote_bg?: string
  blockquote_border_color?: string
  source_title?: string
  [key: string]: unknown
}

/** 采样通道：浏览器计算样式 / DOM 降级 */
export type SampleMethod = 'browser' | 'fallback'

export interface StyleAnalyzeResult {
  style: SampledStyle
  method: SampleMethod
  error?: string
}

/* ══════════════════════════════════════════════════════════════════════
 * 颜色与尺寸
 * ══════════════════════════════════════════════════════════════════════ */

const NAMED_COLORS: Record<string, string> = {
  white: '#FFFFFF',
  black: '#000000',
  red: '#FF0000',
  green: '#008000',
  blue: '#0000FF',
  gray: '#808080',
  grey: '#808080',
  silver: '#C0C0C0',
  maroon: '#800000',
  navy: '#000080',
  teal: '#008080',
  olive: '#808000',
}

/** 浏览器默认链接色（采样强调色时排除） */
const DEFAULT_LINK_COLORS = new Set(['#0000EE', '#0000FF', '#551A8B', '#0000CC', '#0000AA'])

const TRANSPARENT = new Set(['transparent', 'inherit', 'initial', 'unset', 'currentcolor', 'none'])

/** 任意 CSS 颜色写法 → 大写 6 位 hex；不可解析 / 全透明 → undefined */
export function toHexColor(input: string | null | undefined): string | undefined {
  if (input === null || input === undefined) return undefined
  const value = String(input).trim().toLowerCase()
  if (!value || TRANSPARENT.has(value)) return undefined
  const short = /^#([0-9a-f]{3})$/.exec(value)
  if (short) {
    return `#${short[1]
      .split('')
      .map((c) => c + c)
      .join('')}`.toUpperCase()
  }
  const long = /^#([0-9a-f]{6})$/.exec(value)
  if (long) return `#${long[1]}`.toUpperCase()
  const rgb =
    /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*(?:[,/]\s*([0-9.]+)\s*)?\)$/.exec(
      value,
    )
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4])
    if (!Number.isFinite(alpha) || alpha === 0) return undefined
    const hex = [rgb[1], rgb[2], rgb[3]]
      .map((n) =>
        Math.max(0, Math.min(255, Math.round(Number(n))))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
    return `#${hex}`.toUpperCase()
  }
  if (value in NAMED_COLORS) return NAMED_COLORS[value]
  return undefined
}

function channelDistance(a?: string, b?: string): number {
  const ca = a ? parseHexColor(a) : null
  const cb = b ? parseHexColor(b) : null
  if (!ca || !cb) return Number.POSITIVE_INFINITY
  return Math.abs(ca.r - cb.r) + Math.abs(ca.g - cb.g) + Math.abs(ca.b - cb.b)
}

/** 行高归一：`24px` + `16px` → `1.5`；无单位直接取；`normal` 视为未知 */
function normalizeLineHeight(lineHeight?: string, fontSize?: string): string | undefined {
  if (!lineHeight) return undefined
  const value = lineHeight.trim().toLowerCase()
  if (!value || value === 'normal') return undefined
  const px = /^(-?[0-9.]+)px$/.exec(value)
  if (!px) return /^[0-9.]+$/.test(value) ? value : undefined
  const size = fontSize ? /^(-?[0-9.]+)px$/.exec(fontSize.trim()) : null
  const sizeValue = size ? Number(size[1]) : NaN
  const lineValue = Number(px[1])
  if (!Number.isFinite(sizeValue) || sizeValue <= 0 || !Number.isFinite(lineValue)) return undefined
  return String(Math.round((lineValue / sizeValue) * 100) / 100)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/* ══════════════════════════════════════════════════════════════════════
 * 样式名生成
 * ══════════════════════════════════════════════════════════════════════ */

/** 标题里允许保留的字符之外的分隔符：空白 + 中英文标点 */
const SEPARATOR_RE =
  /[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？、：；“”‘’【】《》〈〉（）…·～｜「」『』〔〕－—–]+/g

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITY_MAP[name.toLowerCase()] ?? m)
}

/**
 * 标题 → 短标识：去实体 → 标点/空白当分隔符 → 取前 N 个 token →
 * 连字符连接 → 小写 → 压缩连字符 → 截断 24 字符 → 空则 `style`。
 */
export function slugify(text: string, maxWords = 4): string {
  const plain = decodeEntities(String(text ?? ''))
  const tokens = plain
    .replace(SEPARATOR_RE, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, Math.max(1, Math.floor(maxWords) || 1))
  const joined = tokens
    .join('-')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  const capped = joined.slice(0, 24).replace(/-+$/g, '')
  return capped || 'style'
}

let nameCounter = 0

/** 短哈希：FNV-1a 32 位 → 6 位小写 hex（配合自增计数避免同毫秒重复） */
function shortHash(seed: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

/** 有标题 → `custom-<短标识>`；无标题 → `custom-<YYYYMMDD>-<6 位哈希>` */
export function generateCustomStyleName(sourceTitle?: string | null): string {
  const title = String(sourceTitle ?? '').trim()
  if (title) return `custom-${slugify(title, 3)}`
  const now = new Date()
  nameCounter = (nameCounter + 1) % 0xffff
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
  return `custom-${date}-${shortHash(`${now.getTime()}#${nameCounter}`)}`
}

/* ══════════════════════════════════════════════════════════════════════
 * 降级通道：纯 DOM + 行内 style
 * ══════════════════════════════════════════════════════════════════════ */

/** 解析 `style` 属性为属性表（属性名小写，简写保留原样） */
function parseStyleAttr(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const decl of String(raw ?? '').split(';')) {
    const idx = decl.indexOf(':')
    if (idx <= 0) continue
    const prop = decl.slice(0, idx).trim().toLowerCase()
    const value = decl.slice(idx + 1).trim()
    if (prop && value) out[prop] = value
  }
  return out
}

function styleOf(el: Element): Record<string, string> {
  return parseStyleAttr(el.getAttribute('style'))
}

/** 从属性表里取颜色：优先具体属性，其次简写 */
function colorFrom(props: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const hex = toHexColor(props[name])
    if (hex) return hex
  }
  return undefined
}

/** 简写 `border-left: 3px solid #bbbbbb` 也能取到颜色 */
function shorthandColor(value?: string): string | undefined {
  if (!value) return undefined
  for (const part of value.split(/\s+/)) {
    const hex = toHexColor(part)
    if (hex) return hex
  }
  return undefined
}

function borderSideColor(props: Record<string, string>, side: string): string | undefined {
  return (
    colorFrom(props, `border-${side}-color`) ??
    shorthandColor(props[`border-${side}`]) ??
    (props.border ? shorthandColor(props.border) : undefined)
  )
}

function hasBorderSide(props: Record<string, string>, side: string): boolean {
  const width = props[`border-${side}-width`]
  if (width && /^[0-9.]+(px|em|rem)$/.test(width.trim()) && parseFloat(width) > 0) return true
  const shorthand = props[`border-${side}`]
  if (shorthand && !/^(none|0)\b/.test(shorthand.trim())) return true
  const all = props.border
  if (all && /(^|\s)([0-9.]+(px|em|rem))\s/.test(` ${all} `)) return true
  return false
}

function borderWidths(props: Record<string, string>): string | undefined {
  for (const side of ['left', 'top', 'bottom', 'right']) {
    const width = props[`border-${side}-width`]
    if (width && /^[0-9.]+px$/.test(width.trim())) return width.trim()
    const shorthand = props[`border-${side}`]
    const m = shorthand ? /(^|\s)([0-9.]+px)(\s|$)/.exec(shorthand) : null
    if (m) return m[2]
  }
  return undefined
}

/** 标题结构判定：底色 → bg-block；仅左边线 → left-border；下边线 → underline；否则 plain */
function detectHeadingStyle(
  props: Record<string, string>,
  pageBg?: string,
): { style: HeadingStyle; bg?: string; borderColor?: string; color?: string } {
  const bg = colorFrom(props, 'background-color', 'background')
  const color = colorFrom(props, 'color')
  if (bg && bg !== pageBg) {
    return { style: 'bg-block', bg, color }
  }
  const left = hasBorderSide(props, 'left')
  const right = hasBorderSide(props, 'right')
  if (left && !right) {
    return { style: 'left-border', borderColor: borderSideColor(props, 'left'), color }
  }
  if (hasBorderSide(props, 'bottom')) {
    return { style: 'underline', borderColor: borderSideColor(props, 'bottom'), color }
  }
  return { style: 'plain', color }
}

/** 引用结构判定：仅左边线 → left-border；有左边线或底色 → full-box；否则 plain */
function detectBlockquoteStyle(
  props: Record<string, string>,
  pageBg?: string,
): {
  style: BlockquoteStyle
  bg?: string
  borderColor?: string
} {
  const bg = colorFrom(props, 'background-color', 'background')
  const left = hasBorderSide(props, 'left')
  const right = hasBorderSide(props, 'right')
  const top = hasBorderSide(props, 'top')
  const borderColor = borderSideColor(props, 'left') ?? borderSideColor(props, 'top')
  if (left && !right && !top) return { style: 'left-border', bg, borderColor }
  if ((left && (right || top)) || (bg && bg !== pageBg))
    return { style: 'full-box', bg, borderColor }
  return { style: 'plain', bg, borderColor }
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function extractTitle(doc: Document): string | undefined {
  const h1 = textOf(doc.querySelector('h1'))
  if (h1) return h1
  const title = textOf(doc.querySelector('title'))
  return title || undefined
}

function pickMostFrequent(candidates: string[]): string | undefined {
  const counts = new Map<string, number>()
  for (const c of candidates) counts.set(c, (counts.get(c) ?? 0) + 1)
  let best: string | undefined
  let bestCount = 0
  for (const [color, count] of counts) {
    if (count > bestCount) {
      best = color
      bestCount = count
    }
  }
  return best
}

/**
 * 降级采样：只读行内 style（读不到外部样式表 / `<style>` 块）。
 * 取不到任何可用信息时返回空对象。
 */
export function analyzeStyleFromHtmlFallback(html: string): SampledStyle {
  let doc: Document
  try {
    doc = new JSDOM(String(html ?? '')).window.document
  } catch {
    return {}
  }
  const out: SampledStyle = {}
  const elements = Array.from(doc.querySelectorAll('*'))
  if (!elements.length) return out

  const propsOf = new Map<Element, Record<string, string>>()
  for (const el of elements) propsOf.set(el, styleOf(el))
  const props = (el: Element): Record<string, string> => propsOf.get(el) ?? {}

  // 背景色：文档顺序里第一个显式给了背景的元素（通常是内容容器）
  let bg: string | undefined
  for (const el of elements) {
    bg = colorFrom(props(el), 'background-color', 'background')
    if (bg) break
  }
  out.bg = bg ?? '#FFFFFF'

  // 正文：第一个带行内字色的非链接元素
  const textEl = elements.find(
    (el) => el.tagName.toLowerCase() !== 'a' && !!colorFrom(props(el), 'color'),
  )
  if (textEl) {
    const p = props(textEl)
    out.text = colorFrom(p, 'color')
    if (p['font-family']) out.font = p['font-family'].replace(/"/g, "'")
    if (p['font-size']) out.font_size = p['font-size']
    const lh = normalizeLineHeight(p['line-height'], p['font-size'])
    if (lh) out.line_height = lh
  }

  // 边线宽度：第一个显式给了边线宽度的元素
  for (const el of elements) {
    const width = borderWidths(props(el))
    if (width) {
      out.border_width = width
      break
    }
  }

  // 标题结构
  const heading = doc.querySelector('h1, h2')
  if (heading) {
    const detected = detectHeadingStyle(props(heading), out.bg)
    out.heading_style = detected.style
    if (detected.bg) out.heading_bg = detected.bg
    if (detected.borderColor) out.heading_border_color = detected.borderColor
    if (detected.color) out.heading_color = detected.color
  }
  const h3 = doc.querySelector('h3')
  if (h3) {
    const detected = detectHeadingStyle(props(h3), out.bg)
    out.h3_style = detected.style
    if (detected.borderColor) out.h3_border_color = detected.borderColor
  }

  // 引用结构
  const quote = doc.querySelector('blockquote')
  if (quote) {
    const detected = detectBlockquoteStyle(props(quote), out.bg)
    out.blockquote_style = detected.style
    if (detected.bg) out.blockquote_bg = detected.bg
    if (detected.borderColor) out.blockquote_border_color = detected.borderColor
  }

  // 强调色：标题/引用装饰边线 + 链接颜色里，排除默认链接色与贴近正文/背景的颜色后取众数
  const accentCandidates: string[] = []
  for (const el of elements) {
    const p = props(el)
    const tag = el.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag) || tag === 'blockquote') {
      for (const side of ['left', 'top', 'bottom']) {
        if (hasBorderSide(p, side)) {
          const color = borderSideColor(p, side)
          if (color) accentCandidates.push(color)
        }
      }
    }
    if (tag === 'a') {
      const color = colorFrom(p, 'color')
      if (color) accentCandidates.push(color)
    }
  }
  const usable = accentCandidates.filter(
    (c) =>
      !DEFAULT_LINK_COLORS.has(c) &&
      c !== out.text &&
      c !== out.bg &&
      channelDistance(c, out.text) >= 60 &&
      channelDistance(c, out.bg) >= 60,
  )
  out.accent = pickMostFrequent(usable) ?? out.text ?? out.accent

  // 次级色：span / small / em / figcaption 上非正文、非强调的颜色取众数
  const secondaryCandidates: string[] = []
  for (const el of elements) {
    const tag = el.tagName.toLowerCase()
    if (!['span', 'small', 'em', 'figcaption', 'cite'].includes(tag)) continue
    const color = colorFrom(props(el), 'color')
    if (color && color !== out.text && color !== out.accent) secondaryCandidates.push(color)
  }
  out.secondary = pickMostFrequent(secondaryCandidates) ?? '#8b8f96'

  const title = extractTitle(doc)
  if (title) out.source_title = title
  return out
}

/* ══════════════════════════════════════════════════════════════════════
 * 首选通道：无头浏览器计算样式
 * ══════════════════════════════════════════════════════════════════════ */

/** 页面侧采样脚本：返回原始计算样式（颜色/尺寸字符串，归一化在 Node 侧做） */
const BROWSER_SAMPLER = `(() => {
  const cs = (el) => (el ? getComputedStyle(el) : null)
  const txt = (el) => ((el && el.textContent) || '').replace(/\\s+/g, ' ').trim()
  const all = Array.from(document.querySelectorAll('body *'))
  // 内容容器：文本最多的"有底色"元素，否则 body
  let container = document.body
  let best = 0
  for (const el of all) {
    const bg = getComputedStyle(el).backgroundColor
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue
    const len = txt(el).length
    if (len > best) { best = len; container = el }
  }
  const pageBg = (cs(container) || cs(document.body) || cs(document.documentElement) || {}).backgroundColor
  const p = document.querySelector('p') || container
  const ps = cs(p) || {}
  const heading = document.querySelector('h1, h2')
  const h3 = document.querySelector('h3')
  const quote = document.querySelector('blockquote')
  const sides = ['left', 'top', 'right', 'bottom']
  const read = (el) => {
    const s = cs(el)
    if (!s) return null
    const borders = {}
    for (const side of sides) {
      borders[side] = {
        width: s['border' + side[0].toUpperCase() + side.slice(1) + 'Width'],
        color: s['border' + side[0].toUpperCase() + side.slice(1) + 'Color'],
        style: s['border' + side[0].toUpperCase() + side.slice(1) + 'Style'],
      }
    }
    return { bg: s.backgroundColor, color: s.color, borders }
  }
  const accentCandidates = []
  for (const el of Array.from(document.querySelectorAll('h1, h2, h3, h4, blockquote, a'))) {
    const s = cs(el)
    if (!s) continue
    if (el.tagName === 'A') { accentCandidates.push(s.color); continue }
    for (const side of sides) {
      const cap = side[0].toUpperCase() + side.slice(1)
      const width = parseFloat(s['border' + cap + 'Width']) || 0
      if (width > 0 && s['border' + cap + 'Style'] !== 'none') accentCandidates.push(s['border' + cap + 'Color'])
    }
  }
  const secondaryCandidates = []
  for (const el of Array.from(document.querySelectorAll('span, small, em, figcaption'))) {
    const s = cs(el)
    if (s) secondaryCandidates.push(s.color)
  }
  return {
    title: txt(document.querySelector('h1')) || document.title || '',
    bg: pageBg,
    text: ps.color,
    font: ps.fontFamily,
    fontSize: ps.fontSize,
    lineHeight: ps.lineHeight,
    containerPadding: cs(container) ? cs(container).padding : null,
    heading: read(heading),
    h3: read(h3),
    quote: read(quote),
    accentCandidates,
    secondaryCandidates,
  }
})()`

interface BrowserRawSample {
  title?: string
  bg?: string
  text?: string
  font?: string
  fontSize?: string
  lineHeight?: string
  heading?: {
    bg?: string
    color?: string
    borders?: Record<string, { width?: string; color?: string; style?: string }>
  } | null
  h3?: {
    bg?: string
    color?: string
    borders?: Record<string, { width?: string; color?: string; style?: string }>
  } | null
  quote?: {
    bg?: string
    color?: string
    borders?: Record<string, { width?: string; color?: string; style?: string }>
  } | null
  accentCandidates?: string[]
  secondaryCandidates?: string[]
}

function borderHas(sample: BrowserRawSample['heading'], side: string): boolean {
  const border = sample?.borders?.[side]
  if (!border) return false
  const width = parseFloat(String(border.width ?? '0')) || 0
  return width > 0 && border.style !== 'none'
}

function borderColorOf(sample: BrowserRawSample['heading'], side: string): string | undefined {
  return toHexColor(sample?.borders?.[side]?.color)
}

function borderWidthOf(sample: BrowserRawSample['heading']): string | undefined {
  for (const side of ['left', 'top', 'bottom', 'right']) {
    const border = sample?.borders?.[side]
    const width = parseFloat(String(border?.width ?? '0')) || 0
    if (width > 0 && border?.style !== 'none') return `${width}px`
  }
  return undefined
}

function normalizeBrowserSample(raw: BrowserRawSample): SampledStyle {
  const out: SampledStyle = {}
  const title = String(raw.title ?? '').trim()
  if (title) out.source_title = title
  out.bg = toHexColor(raw.bg) ?? '#FFFFFF'
  out.text = toHexColor(raw.text)
  if (raw.font) out.font = String(raw.font).replace(/"/g, "'")
  if (raw.fontSize) out.font_size = String(raw.fontSize)
  const lh = normalizeLineHeight(raw.lineHeight, raw.fontSize)
  if (lh) out.line_height = lh

  // 标题结构
  const headingSample = raw.heading ?? null
  if (headingSample) {
    const bg = toHexColor(headingSample.bg)
    const color = toHexColor(headingSample.color)
    if (bg && bg !== out.bg) {
      out.heading_style = 'bg-block'
      out.heading_bg = bg
    } else if (borderHas(headingSample, 'left') && !borderHas(headingSample, 'right')) {
      out.heading_style = 'left-border'
      out.heading_border_color = borderColorOf(headingSample, 'left')
    } else if (borderHas(headingSample, 'bottom')) {
      out.heading_style = 'underline'
      out.heading_border_color = borderColorOf(headingSample, 'bottom')
    } else {
      out.heading_style = 'plain'
    }
    if (color && color !== out.text) out.heading_color = color
  }
  if (raw.h3) {
    const bg = toHexColor(raw.h3.bg)
    if (bg && bg !== out.bg) out.h3_style = 'bg-block'
    else if (borderHas(raw.h3, 'left') && !borderHas(raw.h3, 'right')) {
      out.h3_style = 'left-border'
      out.h3_border_color = borderColorOf(raw.h3, 'left')
    } else if (borderHas(raw.h3, 'bottom')) {
      out.h3_style = 'underline'
      out.h3_border_color = borderColorOf(raw.h3, 'bottom')
    } else out.h3_style = 'plain'
  }

  // 引用结构
  if (raw.quote) {
    const bg = toHexColor(raw.quote.bg)
    const left = borderHas(raw.quote, 'left')
    const right = borderHas(raw.quote, 'right')
    const top = borderHas(raw.quote, 'top')
    out.blockquote_border_color =
      borderColorOf(raw.quote, 'left') ?? borderColorOf(raw.quote, 'top')
    if (left && !right && !top) out.blockquote_style = 'left-border'
    else if ((left && (right || top)) || (bg && bg !== out.bg)) out.blockquote_style = 'full-box'
    else out.blockquote_style = 'plain'
    if (bg && bg !== out.bg) out.blockquote_bg = bg
  }

  // 边线宽度
  const width = borderWidthOf(raw.heading) ?? borderWidthOf(raw.quote)
  if (width) out.border_width = width

  // 强调色
  const accentCandidates = (raw.accentCandidates ?? [])
    .map((c) => toHexColor(c))
    .filter((c): c is string => !!c)
    .filter(
      (c) =>
        !DEFAULT_LINK_COLORS.has(c) &&
        c !== out.text &&
        c !== out.bg &&
        channelDistance(c, out.text) >= 60 &&
        channelDistance(c, out.bg) >= 60,
    )
  out.accent = pickMostFrequent(accentCandidates) ?? out.text

  const secondaryCandidates = (raw.secondaryCandidates ?? [])
    .map((c) => toHexColor(c))
    .filter((c): c is string => !!c)
    .filter((c) => c !== out.text && c !== out.accent)
  out.secondary = pickMostFrequent(secondaryCandidates) ?? '#8b8f96'
  return out
}

async function sampleWithBrowser(target: {
  url?: string
  html?: string
}): Promise<SampledStyle | null> {
  let chromium: typeof import('playwright').chromium | undefined
  try {
    const playwright = await import('playwright')
    chromium = playwright.chromium
  } catch {
    return null // 未安装 playwright：静默降级
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    try {
      browser = await chromium.launch({ channel: 'chrome' })
    } catch {
      browser = await chromium.launch()
    }
    const page = await browser.newPage()
    if (target.url) {
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    } else {
      await page.setContent(target.html ?? '', { waitUntil: 'domcontentloaded' })
    }
    const raw = (await page.evaluate(BROWSER_SAMPLER)) as BrowserRawSample
    if (!raw || typeof raw !== 'object') return null
    return normalizeBrowserSample(raw)
  } catch {
    return null
  } finally {
    if (browser) await browser.close().catch(() => undefined)
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 对外入口
 * ══════════════════════════════════════════════════════════════════════ */

/** 采样一段 HTML：首选浏览器计算样式，失败降级为行内 style 解析 */
export async function analyzeStyleFromHtml(html: string): Promise<StyleAnalyzeResult> {
  const sampled = await sampleWithBrowser({ html })
  if (sampled) return { style: sampled, method: 'browser' }
  const style = analyzeStyleFromHtmlFallback(html)
  if (!Object.keys(style).length) {
    return { style: {}, method: 'fallback', error: 'HTML 无法解析或未取到任何样式信息' }
  }
  return { style, method: 'fallback' }
}

/** 采样一个 URL：首选浏览器加载，失败改为抓取 HTML 后再走降级解析 */
export async function analyzeStyleFromUrl(url: string): Promise<StyleAnalyzeResult> {
  const target = String(url ?? '').trim()
  if (!/^https?:\/\//i.test(target)) {
    return { style: {}, method: 'fallback', error: `只支持 http(s) URL: ${target}` }
  }
  const sampled = await sampleWithBrowser({ url: target })
  if (sampled) return { style: sampled, method: 'browser' }
  try {
    const response = await fetch(target, {
      redirect: 'follow',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!response.ok) {
      return { style: {}, method: 'fallback', error: `页面抓取失败: HTTP ${response.status}` }
    }
    const html = await response.text()
    const style = analyzeStyleFromHtmlFallback(html)
    if (!Object.keys(style).length) {
      return { style: {}, method: 'fallback', error: '页面内容为空或未取到任何样式信息' }
    }
    return { style, method: 'fallback' }
  } catch (err) {
    return {
      style: {},
      method: 'fallback',
      error: `页面抓取失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
