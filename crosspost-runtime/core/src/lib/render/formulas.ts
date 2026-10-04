/**
 * 公式：LaTeX → 内联 SVG（MathJax，纯 Node，无浏览器），失败时降级为外链 PNG。
 *
 * 微信公众号不执行 JS、不加载样式表，所以公式必须在**渲染期**就变成矢量图形：
 *  - 首选 `inline <svg>`：`fontCache: 'none'` 让路径用 `currentColor` 着色，
 *    于是公式自动跟随正文字色，深色主题不需要任何特判；
 *  - 兜底 `<img>`：指向外部渲染服务，之后由图片管线换成平台图床地址。
 *
 * MathJax 对非法 LaTeX **不抛错**，而是画出红色错误框，所以"输出里出现错误标记"
 * 也必须算失败，否则错误框会被发到公众号。
 */

import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'

/** 一条待渲染的公式 */
export interface FormulaItem {
  /** 占位符标识（同一次渲染内唯一） */
  id: string
  latex: string
  /** true = 块级（独占一行），false = 行内 */
  display: boolean
}

/** 单条公式的渲染结果：`ok:false` 时调用方改走图片兜底 */
export interface FormulaResult {
  id: string
  ok: boolean
  svg?: string
  image?: string
  error?: string
}

export type FormulaResults = Record<string, FormulaResult>

/** 收集阶段的产物：占位后的正文 + 待渲染清单 */
export interface FormulaCollection {
  text: string
  items: FormulaItem[]
}

/** 替换阶段需要的渲染上下文（由调用方从样式参数里取） */
export interface FormulaRenderContext {
  isDark: boolean
  textColor: string
  blockGap: string
}

const PLACEHOLDER_PREFIX = '[[WECHAT_MATH_'
const PLACEHOLDER_SUFFIX = ']]'
const PLACEHOLDER_PATTERN = /\[\[WECHAT_MATH_(\d+)\]\]/g

/** 公式占位符（Markdown 解析器不会改写这一形态） */
export function formulaPlaceholder(id: string): string {
  return `${PLACEHOLDER_PREFIX}${id}${PLACEHOLDER_SUFFIX}`
}

/** 反查占位符对应的下标；不是占位符时返回 -1 */
function placeholderIndex(text: string): number {
  if (!text.startsWith(PLACEHOLDER_PREFIX) || !text.endsWith(PLACEHOLDER_SUFFIX)) return -1
  const middle = text.slice(PLACEHOLDER_PREFIX.length, -PLACEHOLDER_SUFFIX.length)
  return /^\d+$/.test(middle) ? Number(middle) : -1
}

const CJK_RANGE =
  /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/**
 * 「像公式」判定：去空白后非空、长度不超过 200、且不含 CJK。
 * 这条判据把 `$100 万涨到 $200 万` 这类货币金额挡在公式之外。
 */
export function looksLikeMath(text: string): boolean {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (trimmed.length > 200) return false
  return !CJK_RANGE.test(trimmed)
}

/**
 * 收集公式并替换成占位符。
 *
 * 顺序有讲究：先扫块级 `$$…$$`（允许跨行），再扫行内 `$…$`（不跨行、前后不能是 `$`）。
 * 占位必须发生在 Markdown 解析之前，否则 `_`/`\`/`*`/`{}` 会被当成 Markdown 语法吃掉。
 */
export function collectFormulas(markdown: string): FormulaCollection {
  const items: FormulaItem[] = []
  let text = markdown

  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (whole, body: string) => {
    if (body.trim() === '') return whole
    const id = String(items.length)
    items.push({ id, latex: body.trim(), display: true })
    return formulaPlaceholder(id)
  })

  text = text.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, (whole, body: string) => {
    if (!looksLikeMath(body)) return whole
    const id = String(items.length)
    items.push({ id, latex: body.trim(), display: false })
    return formulaPlaceholder(id)
  })

  return { text, items }
}

/* ────────────────────────── MathJax 句柄（进程内复用） ────────────────────────── */

interface MathJaxRuntime {
  convert: (latex: string, display: boolean) => unknown
  inner: (node: unknown) => string
}

let runtime: MathJaxRuntime | null = null
let runtimeUnavailable = false

function ensureRuntime(): MathJaxRuntime | null {
  if (runtime) return runtime
  if (runtimeUnavailable) return null
  try {
    const adaptor = liteAdaptor()
    RegisterHTMLHandler(adaptor)
    const tex = new TeX({ packages: AllPackages })
    const svg = new SVG({ fontCache: 'none' })
    const doc = mathjax.document('', { InputJax: tex, OutputJax: svg })
    runtime = {
      convert: (latex: string, display: boolean) =>
        doc.convert(latex, {
          display,
          em: 16,
          ex: 8,
          containerWidth: 80 * 16,
        }),
      inner: (node: unknown) => adaptor.innerHTML(node as never),
    }
    return runtime
  } catch {
    runtimeUnavailable = true
    return null
  }
}

/** 从 MathJax 的容器里取出 `<svg>…</svg>` 片段 */
function extractSvg(markup: string): string {
  const start = markup.indexOf('<svg')
  if (start < 0) return markup
  const end = markup.lastIndexOf('</svg>')
  return end > start ? markup.slice(start, end + 6) : markup.slice(start)
}

/** 错误标记：MathJax 把非法 LaTeX 画成 `<merror>`，必须当失败处理 */
const ERROR_MARK = /data-mml-node="merror"|data-mjx-error|class="mjx-error"/

/**
 * 批量渲染公式。单条失败不影响整批；MathJax 整体不可用时全部标记失败（走图片兜底）。
 */
export function renderFormulas(items: FormulaItem[]): FormulaResults {
  const results: FormulaResults = {}
  const engine = ensureRuntime()
  for (const item of items) {
    if (!engine) {
      results[item.id] = { id: item.id, ok: false, error: 'MathJax 不可用' }
      continue
    }
    try {
      const node = engine.convert(item.latex, item.display)
      const markup = engine.inner(node)
      if (ERROR_MARK.test(markup)) {
        results[item.id] = { id: item.id, ok: false, error: 'LaTeX 语法错误' }
        continue
      }
      const svg = extractSvg(markup)
      if (!svg.includes('<svg')) {
        results[item.id] = { id: item.id, ok: false, error: '未产出 SVG' }
        continue
      }
      results[item.id] = { id: item.id, ok: true, svg }
    } catch (error) {
      results[item.id] = {
        id: item.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  return results
}

/* ────────────────────────────── 输出形态 ────────────────────────────── */

/** 块级公式容器：居中、可横向滚动、字色跟随正文 */
function blockSvgHtml(svg: string, context: FormulaRenderContext): string {
  return (
    `<section style="margin: ${context.blockGap} 0; text-align: center; overflow-x: auto;` +
    ` -webkit-overflow-scrolling: touch; color: ${context.textColor};">${svg}</section>`
  )
}

/** 行内公式：直接内联 SVG，不额外包块 */
function inlineSvgHtml(svg: string): string {
  return svg
}

/** 兜底图 URL：DPI 前缀 + 深色主题下的白字指令 */
function fallbackImageUrl(latex: string, display: boolean, isDark: boolean): string {
  const dpi = display ? 160 : 110
  const color = isDark ? '\\color{White}' : ''
  const body = `${color}\\dpi{${dpi}}${latex}`
  return `https://latex.codecogs.com/png.image?${encodeURIComponent(body)}`
}

function blockImageHtml(url: string): string {
  const escaped = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return (
    `<section style="margin: 16px 0; text-align: center; overflow-x: auto;">` +
    `<img src="${escaped}" data-src="${escaped}" alt="公式"` +
    ` style="max-width: 90%; height: auto; display: inline-block;"></section>`
  )
}

function inlineImageHtml(url: string): string {
  const escaped = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return (
    `<img src="${escaped}" data-src="${escaped}" alt="公式"` +
    ` style="max-height: 1.1em; vertical-align: -0.2em; margin: 0 1px;">`
  )
}

/** 一条公式最终落到 HTML 的形态 */
function formulaHtml(
  item: FormulaItem,
  result: FormulaResult | undefined,
  ctx: FormulaRenderContext,
): string {
  if (result && result.ok && result.svg) {
    return item.display ? blockSvgHtml(result.svg, ctx) : inlineSvgHtml(result.svg)
  }
  const url = result?.image || fallbackImageUrl(item.latex, item.display, ctx.isDark)
  return item.display ? blockImageHtml(url) : inlineImageHtml(url)
}

/**
 * 把占位符换成公式 HTML。
 *
 * 三步走，且**只扫一遍**（避免"每条公式扫全文一次"）：
 *  1. 独占一个段落的块级公式：连包裹段一起换成块容器（块级公式必须独立成块）；
 *  2. 段落里夹着块级公式的：把段落拆成「前段 + 公式块 + 后段」；
 *  3. 其余残留占位符：就地替换（行内公式、或已在段落外的块级公式）。
 */
export function replaceFormulas(
  html: string,
  items: FormulaItem[],
  results: FormulaResults,
  context: FormulaRenderContext,
): string {
  if (items.length === 0 || !html.includes(PLACEHOLDER_PREFIX)) return html
  const byId = new Map(items.map((item) => [item.id, item]))
  const rendered = (item: FormulaItem): string => formulaHtml(item, results[item.id], context)

  // 步骤 1：占位符独占一段
  let output = html.replace(
    /<p\b[^>]*>\s*(\[\[WECHAT_MATH_\d+\]\])\s*<\/p>/g,
    (whole, placeholder: string) => {
      const index = placeholderIndex(placeholder)
      const item = index >= 0 ? byId.get(String(index)) : undefined
      if (!item || !item.display) return whole
      return rendered(item)
    },
  )

  // 步骤 2：段落内含块级公式 → 拆段
  output = output.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/g, (whole, attrs: string, body: string) => {
    if (!body.includes(PLACEHOLDER_PREFIX)) return whole
    const pieces: string[] = []
    let cursor = 0
    let hit = false
    const re = new RegExp(PLACEHOLDER_PATTERN.source, 'g')
    let matched: RegExpExecArray | null
    while ((matched = re.exec(body)) !== null) {
      const index = placeholderIndex(matched[0])
      const item = index >= 0 ? byId.get(String(index)) : undefined
      if (!item || !item.display) continue
      hit = true
      const before = body.slice(cursor, matched.index)
      if (before.trim() !== '') pieces.push(`<p${attrs}>${before}</p>`)
      pieces.push(rendered(item))
      cursor = matched.index + matched[0].length
    }
    if (!hit) return whole
    const after = body.slice(cursor)
    if (after.trim() !== '') pieces.push(`<p${attrs}>${after}</p>`)
    return pieces.join('')
  })

  // 步骤 3：就地替换剩余占位符（行内公式与段落外的块级公式）
  output = output.replace(PLACEHOLDER_PATTERN, (placeholder: string) => {
    const index = placeholderIndex(placeholder)
    const item = index >= 0 ? byId.get(String(index)) : undefined
    return item ? rendered(item) : placeholder
  })

  return output
}

/** 输出里是否还残留占位符（自检用） */
export function hasPlaceholder(text: string): boolean {
  return text.includes(PLACEHOLDER_PREFIX)
}
