/**
 * 微信兼容后处理（渲染完成后的 DOM 修补）
 *
 * 渲染器只负责把 Markdown 变成带 inline style 的元素级 HTML；这一步负责把「结构上
 * 正确、但平台不吃」的形态换成平台能接受的形态。五步，顺序固定（前一步的产物是后一步
 * 的输入，且都必须保持「每个顶层源码块 ↔ 一个顶层元素」的一比一关系）：
 *
 *  1. 裸 `<blockquote>` → 卡片：先问 callout 渲染器认不认（认了就是 callout 卡片），
 *     不认则按引用参数的三态（左竖线 / 整框 / 无装饰）包成一张卡片。
 *  2. 整段只有斜体（或斜体加粗）的 `<p>` → 金句引用卡片（不斜体，用参数底色）。
 *  3. 脚注区 → 扁平「注」区块：平台不给 `<ol>`/`<li>` 留编号位，`<li>` 之间的空白
 *     文本会被渲染成多余的空条目，所以序号自己写、每一项是一个 flex 行。
 *  4. 锚点解包 + 回跳符清理：`<a href="#…">` 会被草稿接口判为非法链接，解包成它的
 *     子节点；解析器插入的 `↩` 在公众号里没有意义，删掉。
 *  5. 懒加载属性：每个 `<img>` 补 `data-src`（与 `src` 同值），否则图片在公众号内空白。
 *
 * 本模块只消费**样式参数**，不认识样式名：任何视觉都从参数推导，缺省值由核心四色与
 * 排版参数派生（见规格 §3.2/§3.3）。样式名参数仅为调用方签名兼容而存在。
 */
import { JSDOM } from 'jsdom'
import { renderCalloutIfMatch } from './callouts'

/** blockquote 三态 */
type QuoteStructure = 'left-border' | 'full-box' | 'plain'

/** 后处理需要的、可从样式参数派生出来的量 */
interface DerivedParams {
  accent: string
  text: string
  secondary: string
  hairline: string
  baseFontSize: string
  lineHeight: string
  radius: string
  blockGap: string
  structure: QuoteStructure
  quoteBg: string
  quoteBorderColor: string
  quoteBorderWidth: string
  quoteTextColor: string
  quoteItalic: boolean
  quoteOpacity: string
  italicQuoteBg: string
  italicQuoteBorderColor: string
  notesColor: string
  notesNumberColor: string
  notesLabelColor: string
  notesLabel: string
}

type Declarations = Record<string, string>
type RawParams = Record<string, unknown>

const QUOTE_STRUCTURES: QuoteStructure[] = ['left-border', 'full-box', 'plain']
const DENSITY_SCALE: Record<string, number> = { compact: 0.85, normal: 1, airy: 1.25 }

function asRecord(value: unknown): RawParams {
  return value !== null && typeof value === 'object' ? (value as RawParams) : {}
}

/** 依次尝试多个键（新参数名在前、旧别名在后），取第一个非空字符串 */
function pickText(source: RawParams, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return fallback
}

function pickFlag(source: RawParams, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'boolean') return value
  }
  return fallback
}

function pickNumber(source: RawParams, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return fallback
}

/** 感知亮度（299/587/114 加权），背景明暗决定一整套派生量 */
function isDarkBackground(color: string): boolean {
  const hex = color.trim().replace(/^#/, '')
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : hex
  if (!/^[0-9a-f]{6}$/i.test(full)) return false
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return (299 * r + 587 * g + 114 * b) / 1000 < 128
}

function toAttributes(declarations: Declarations): string {
  return Object.keys(declarations)
    .filter((property) => declarations[property] !== '')
    .map((property) => `${property}: ${declarations[property]}`)
    .join('; ')
}

function writeStyle(element: Element, declarations: Declarations): void {
  const style = toAttributes(declarations)
  if (style) element.setAttribute('style', style)
}

/** 把参数字典收敛成一张推导表；缺省值全部来自核心参数，不做任何按样式名的特判 */
function deriveParams(style: unknown): DerivedParams {
  const source = asRecord(style)
  const accent = pickText(source, ['accent'], '#e62e2e')
  const text = pickText(source, ['text'], '#000000')
  const secondary = pickText(source, ['secondary'], '#666666')
  const dark = isDarkBackground(pickText(source, ['bg'], '#ffffff'))
  const requested = pickText(source, ['blockquoteStructure', 'blockquoteStyle'], 'left-border')
  const structure = QUOTE_STRUCTURES.includes(requested as QuoteStructure)
    ? (requested as QuoteStructure)
    : 'left-border'
  const density = pickText(source, ['density'], 'normal')
  const scale = DENSITY_SCALE[density] ?? 1

  return {
    accent,
    text,
    secondary,
    hairline: pickText(source, ['hairline'], dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.10)'),
    baseFontSize: pickText(source, ['baseFontSize'], '15px'),
    lineHeight: pickText(source, ['lineHeight'], '1.75'),
    radius: pickText(source, ['radius'], '0px'),
    blockGap: pickText(source, ['blockGap'], `${Math.round(16 * scale)}px`),
    structure,
    quoteBg: pickText(source, ['blockquoteBg'], dark ? 'rgba(255,255,255,0.05)' : '#f9f9f9'),
    quoteBorderColor: pickText(source, ['blockquoteBorderColor'], accent),
    quoteBorderWidth: pickText(
      source,
      ['blockquoteBorderWidth', 'borderWidth', 'border_width'],
      '3px',
    ),
    quoteTextColor: pickText(
      source,
      ['blockquoteTextColor'],
      structure === 'full-box' ? text : secondary,
    ),
    quoteItalic: pickFlag(source, ['blockquoteItalic'], true),
    quoteOpacity: String(pickNumber(source, ['blockquoteOpacity'], 0.9)),
    italicQuoteBg: pickText(source, ['italicQuoteBg'], '#f5f5f5'),
    italicQuoteBorderColor: pickText(source, ['italicQuoteBorderColor'], accent),
    notesColor: pickText(source, ['notesColor'], secondary),
    notesNumberColor: pickText(source, ['notesNumberColor'], '#999999'),
    notesLabelColor: pickText(source, ['notesLabelColor'], '#bbbbbb'),
    notesLabel: pickText(source, ['notesLabel'], 'NOTES'),
  }
}

function createSection(document: Document, declarations: Declarations): HTMLElement {
  const section = document.createElement('section')
  writeStyle(section, declarations)
  return section
}

/** 引用卡片：参数只管颜色与形态，结构固定为「卡片 + 正文容器」 */
function buildQuoteCard(document: Document, inner: string, params: DerivedParams): HTMLElement {
  const container: Declarations = {
    margin: `${params.blockGap} 0`,
    padding: params.structure === 'full-box' ? '25px' : '16px 20px',
  }
  if (params.structure !== 'plain') {
    container['background-color'] = params.quoteBg
    container['border-left'] = `${params.quoteBorderWidth} solid ${params.quoteBorderColor}`
  }
  if (params.structure === 'full-box') {
    container.border = `1px solid ${params.hairline}`
    container['border-radius'] = params.radius
  }

  const body: Declarations = {
    color: params.quoteTextColor,
    'font-size': params.baseFontSize,
    'line-height': params.lineHeight,
    'font-style': params.quoteItalic ? 'italic' : 'normal',
  }
  if (params.structure === 'full-box') body.opacity = params.quoteOpacity

  const bodySection = createSection(document, body)
  bodySection.innerHTML = inner

  const card = createSection(document, container)
  card.appendChild(bodySection)
  return card
}

/** 金句卡片（整段斜体）：与引用卡片是两套形态，底色/边线各有参数 */
function buildItalicQuoteCard(
  document: Document,
  inner: string,
  params: DerivedParams,
): HTMLElement {
  const card = createSection(document, {
    margin: '22px 0',
    padding: '16px 20px',
    'background-color': params.italicQuoteBg,
    'border-left': `3px solid ${params.italicQuoteBorderColor}`,
    'border-radius': `0 ${params.radius} ${params.radius} 0`,
  })
  const body = createSection(document, {
    color: params.quoteTextColor,
    'font-size': params.baseFontSize,
    'line-height': params.lineHeight,
    'font-style': 'normal',
  })
  body.innerHTML = inner
  card.appendChild(body)
  return card
}

/** 取「整段只有一个强调节点」时该强调节点的内容；不是整段强调则返回 null */
function soleEmphasisContent(paragraph: Element): string | null {
  const children = Array.from(paragraph.children)
  if (children.length !== 1) return null
  const only = children[0]
  if (only.tagName === 'EM') return only.innerHTML
  if (
    only.tagName === 'STRONG' &&
    only.children.length === 1 &&
    only.children[0].tagName === 'EM'
  ) {
    return only.children[0].innerHTML
  }
  return null
}

/** 脚注项内容：去掉回跳链接、脱掉单层段落壳，其余行内标记照旧 */
function footnoteBody(item: Element): string {
  const clone = item.cloneNode(true) as Element
  for (const anchor of Array.from(clone.querySelectorAll('a[href^="#"]'))) {
    anchor.replaceWith(...Array.from(anchor.childNodes))
  }
  const children = Array.from(clone.children)
  if (children.length === 1 && children[0].tagName === 'P') return children[0].innerHTML
  return clone.innerHTML
}

/** 把解析器产出的脚注区（<section class="footnotes"><ol>…）压成扁平「注」区块 */
function flattenFootnotes(document: Document, params: DerivedParams): void {
  const list = document.querySelector('ol.footnotes-list, ul.footnotes-list')
  const items = list
    ? Array.from(list.children)
    : Array.from(document.querySelectorAll('li.footnote-item'))
  if (items.length === 0) return

  const outer = list?.closest('.footnotes') ?? list ?? items[0].parentElement
  const block = createSection(document, {
    'margin-top': '40px',
    'padding-top': '16px',
    'border-top': `1px solid ${params.hairline}`,
  })

  const label = document.createElement('p')
  writeStyle(label, {
    'font-size': '11px',
    'letter-spacing': '1px',
    color: params.notesLabelColor,
    'text-transform': 'uppercase',
    margin: '0 0 12px 0',
  })
  label.textContent = params.notesLabel
  block.appendChild(label)

  items.forEach((item, index) => {
    const row = createSection(document, {
      'font-size': '13px',
      'line-height': '1.65',
      'margin-bottom': '6px',
      color: params.notesColor,
      display: 'flex',
    })
    const order = document.createElement('span')
    writeStyle(order, {
      'min-width': '22px',
      'font-weight': 'bold',
      color: params.notesNumberColor,
      'flex-shrink': '0',
    })
    order.textContent = `${index + 1}.`
    const content = document.createElement('span')
    writeStyle(content, { flex: '1' })
    content.innerHTML = footnoteBody(item)
    row.append(order, content)
    block.appendChild(row)
  })

  for (const separator of Array.from(document.querySelectorAll('.footnotes-sep')))
    separator.remove()
  if (outer) outer.replaceWith(block)
}

/** 收集全部文本节点：TreeWalker 边走边改会漏，先取快照再改 */
function textNodesOf(root: HTMLElement): Text[] {
  const walker = root.ownerDocument.createTreeWalker(root, 4)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return nodes
}

function replaceQuoteBlocks(
  document: Document,
  params: DerivedParams,
  style: unknown,
  styleName: string,
): void {
  const quotes = Array.from(document.querySelectorAll('blockquote'))
  // 由内向外：先处理嵌套引用，外层读取 innerHTML 时拿到的就是已经卡片化的内容
  quotes.sort((a, b) => depthOf(b) - depthOf(a))
  for (const quote of quotes) {
    const inner = quote.innerHTML
    let card = ''
    try {
      card = renderCalloutIfMatch(inner, style, styleName) ?? ''
    } catch {
      // callout 渲染不可用（参数缺失等）时按普通引用卡片降级
      card = ''
    }
    if (!card) {
      quote.replaceWith(buildQuoteCard(document, inner, params))
      continue
    }
    const holder = document.createElement('section')
    holder.innerHTML = card
    quote.replaceWith(...Array.from(holder.childNodes))
  }
}

function depthOf(element: Element): number {
  let depth = 0
  let cursor: Element | null = element.parentElement
  while (cursor) {
    if (cursor.tagName === 'BLOCKQUOTE') depth += 1
    cursor = cursor.parentElement
  }
  return depth
}

function upgradeItalicParagraphs(document: Document, params: DerivedParams): void {
  for (const paragraph of Array.from(document.querySelectorAll('p'))) {
    if (paragraph.closest('blockquote, table, pre')) continue
    const content = soleEmphasisContent(paragraph)
    if (content === null) continue
    paragraph.replaceWith(buildItalicQuoteCard(document, content, params))
  }
}

function unwrapAnchors(document: Document): void {
  for (const anchor of Array.from(document.querySelectorAll('a[href^="#"]'))) {
    anchor.replaceWith(...Array.from(anchor.childNodes))
  }
  // 回跳符 + 可能的变体选择符：分开写，避免组合字符落进字符类
  const backref = /\u21a9|\ufe0e/g
  for (const node of textNodesOf(document.body)) {
    if (backref.test(node.data)) node.data = node.data.replace(backref, '')
    backref.lastIndex = 0
  }
}

/**
 * 把正文文本里的双引号重新写成实体。
 *
 * DOM 往返会把文本里的 `&quot;` 解码成裸 `"`（HTML 规范里文本节点不需要转义引号），
 * 但平台侧与安全断言都按「输出里不得出现 `" onerror=`」这种裸模式检查，所以序列化完成后
 * 按标签边界扫一遍：标签内（含属性引号）原样保留，标签外只转义 `"`。
 */
function escapeTextQuotes(html: string): string {
  let out = ''
  let cursor = 0
  while (cursor < html.length) {
    if (html[cursor] !== '<') {
      out += html[cursor] === '"' ? '&quot;' : html[cursor]
      cursor += 1
      continue
    }
    let scan = cursor + 1
    let quote = ''
    while (scan < html.length) {
      const char = html[scan]
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        scan += 1
        break
      }
      scan += 1
    }
    out += html.slice(cursor, scan)
    cursor = scan
  }
  return out
}

function ensureLazySource(document: Document): void {
  for (const image of Array.from(document.querySelectorAll('img'))) {
    const source = image.getAttribute('src')
    if (!source || image.hasAttribute('data-src')) continue
    image.setAttribute('data-src', source)
  }
}

/**
 * 后处理入口。任何一步失败都退回原 HTML——宁可不美化，也不能把可用内容弄丢。
 * `styleName` 只透传给 callout 渲染器（它可能用于兜底标签），本模块自身不做按样式名的特判。
 */
export function postProcessHtml(html: string, style?: unknown, styleName = 'swiss'): string {
  if (!html || !html.trim()) return html

  try {
    const params = deriveParams(style)
    const dom = new JSDOM(html)
    const document = dom.window.document

    replaceQuoteBlocks(document, params, style, styleName)
    upgradeItalicParagraphs(document, params)
    flattenFootnotes(document, params)
    unwrapAnchors(document)
    ensureLazySource(document)

    return escapeTextQuotes(document.body.innerHTML)
  } catch {
    return html
  }
}
