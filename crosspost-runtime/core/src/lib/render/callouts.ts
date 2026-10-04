/**
 * Obsidian 风格 callout：`> [!TIP] 标题` + 正文 → 一张带类型配色的卡片。
 *
 * 识别在**渲染后的 HTML** 上做（输入是 `<blockquote>` 的内部片段），因为 Markdown
 * 解析器会把标记行与正文放在同一个段落里，用换行 / `<br>` / 段末连接。
 *
 * 卡片结构固定（外框 + 头部行 + 正文块），只有颜色与强调边方位随类型变化；
 * 颜色来自样式参数 `calloutPalette`，缺省值取自参数模型（见下）。
 */

import { escapeHtml, resolveParams, type RenderParams } from './engine'
import { DEFAULT_CALLOUT_PALETTE, type CalloutTypeStyle } from './styles'

/**
 * 类型配色一律来自参数模型：`styles.ts` 的 `DEFAULT_CALLOUT_PALETTE` 是唯一定义处，
 * 本模块只做「标记名 → 键」的归一与「样式覆盖 → 缺省」的合并，不复制任何颜色字面量。
 */
type CalloutTypeSpec = CalloutTypeStyle

/** 取某个标记名的类型参数：样式里的 `calloutPalette` 优先，缺省回落到参数模型的缺省表 */
function specFor(marker: string, palette: Record<string, unknown>): CalloutTypeSpec {
  const key = marker.toUpperCase()
  const defaults = DEFAULT_CALLOUT_PALETTE as Record<string, CalloutTypeSpec | undefined>
  const builtin = defaults[key] ?? DEFAULT_CALLOUT_PALETTE.NOTE
  const override = palette[key]
  if (!override || typeof override !== 'object') return builtin

  const bag = override as Record<string, unknown>
  const pick = (...keys: string[]): string | undefined => {
    for (const name of keys) {
      const value = bag[name]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    return undefined
  }
  const side = pick('side')
  return {
    label: pick('label', 'labelEn', 'en') ?? builtin.label,
    title: pick('title', 'labelZh', 'zh') ?? builtin.title,
    border: pick('border', 'borderColor', 'color') ?? builtin.border,
    bg: pick('bg', 'background', 'background_color') ?? builtin.bg,
    labelColor: pick('labelColor', 'label_color') ?? builtin.labelColor,
    side: side === 'top' || side === 'left' ? side : builtin.side,
  }
}

/** 去掉标签后的纯文本（标题里可能带行内标记） */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .trim()
}

/** 标题写成 `（…）` / `(…)` 时取括号里的内容 */
function unwrapTitle(title: string): string {
  const matched = /^[（(]\s*([\s\S]*?)\s*[）)]$/.exec(title)
  return matched ? matched[1] : title
}

interface DetectedCallout {
  marker: string
  title: string
  body: string
}

/**
 * 从 `<blockquote>` 的内容片段里识别 callout 标记。
 * 未命中标记时返回 null（调用方按普通引用处理）。
 */
function detectCallout(source: string): DetectedCallout | null {
  let inner = source.trim()
  const wrapped = /^<blockquote\b[^>]*>([\s\S]*)<\/blockquote>\s*$/i.exec(inner)
  if (wrapped) inner = wrapped[1]

  inner = inner.replace(/^\s*<p\b[^>]*>/i, '')
  const marker = /^\s*\[!\s*([A-Za-z][A-Za-z0-9_-]*)\s*\]\s*[-+]?[ \t]*/.exec(inner)
  if (!marker) return null

  const rest = inner.slice(marker[0].length)
  const boundary = /<br\s*\/?>|<\/p>|\n/i.exec(rest)
  const head = boundary ? rest.slice(0, boundary.index) : rest
  let body = boundary ? rest.slice(boundary.index + boundary[0].length) : ''
  // 分隔符是 <br> / 软换行时，正文仍在同一个段落里，尾部会留下最初的 </p>
  if (boundary && !/^<\/p>/i.test(boundary[0])) body = body.replace(/<\/p>\s*$/i, '')

  return {
    marker: marker[1].toUpperCase(),
    title: unwrapTitle(plainText(head)),
    body: body.trim(),
  }
}

/** 卡片 HTML：外框（含一侧加粗强调边）→ 头部行 → 正文块 */
function cardHtml(
  spec: CalloutTypeSpec,
  title: string,
  body: string,
  params: RenderParams,
): string {
  const sideBorder = spec.side === 'top' ? 'border-top' : 'border-left'
  const labelColor = spec.labelColor || spec.border
  const head =
    `<section style="display: flex; justify-content: space-between; align-items: baseline;` +
    ` border-bottom: 1px solid ${spec.border}; padding-bottom: 6px; margin-bottom: 12px;">` +
    `<span style="font-size: 11px; font-weight: bold; color: ${labelColor}; letter-spacing: 1.5px;` +
    ` text-transform: uppercase; font-family: ${params.font};">${escapeHtml(spec.label)}</span>` +
    `<span style="font-size: 14px; font-weight: bold; color: ${params.text};">${escapeHtml(title)}</span>` +
    `</section>`

  const content = body
    ? `<section style="font-size: 14px; line-height: 1.7; color: ${params.text};` +
      ` text-align: justify; margin: 0; padding: 0;">${body}</section>`
    : ''

  return (
    `<section style="margin: 24px 0; border: 1.5px solid ${spec.border};` +
    ` ${sideBorder}: 6px solid ${spec.border}; padding: 18px; background-color: ${spec.bg};` +
    ` box-sizing: border-box;">${head}${content}</section>`
  )
}

/**
 * 内容片段是 callout 时返回卡片 HTML，否则返回 null（调用方回落普通引用）。
 *
 * 第二个/第三个参数是样式对象与样式名（可选）：只用于取 `calloutPalette` 与字体栈。
 */
export function renderCalloutIfMatch(
  innerHtml: string,
  style?: unknown,
  styleName?: string,
): string | null {
  if (!innerHtml || !innerHtml.includes('[!')) return null
  const detected = detectCallout(innerHtml)
  if (!detected) return null

  const params = resolveParams(style, styleName || 'swiss')
  const spec = specFor(detected.marker, params.calloutPalette)
  const title = detected.title || spec.title
  return cardHtml(spec, title, detected.body, params)
}
