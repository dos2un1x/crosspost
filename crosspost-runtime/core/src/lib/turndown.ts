/**
 * HTML 片段 → Markdown 文本（正则单遍流水线，不依赖 DOM）
 *
 * 为什么不用 DOM / 第三方解析器：这条链路既要在 Service Worker 里跑，也在文章提取的
 * 热路径上；对"文章正文片段"这类输入，正则方案足够，且不引入宿主 API 依赖。
 *
 * 结构（自上而下）：
 *   1. 字符常量与掩码哨兵
 *   2. 实体解码：正文浅表路径 + 代码块完整路径（两者覆盖范围**故意不同**）
 *   3. 标签判定与白名单剔除
 *   4. 代码块：语言识别 + 代码文本提取
 *   5. 表格：表头判定 / 对齐 / 竖线转义 / `<figure>` 包裹
 *   6. 主流水线 `htmlToMarkdownSimple`
 *   7. 公开导出：`htmlToMarkdown` / `extractCodeFromHtml` / `markdownToHtml`
 */

import { marked } from 'marked'
import { normalizeBoldFlanking } from './render/markdown-flanking'

// ─────────────────────────── 1. 字符常量与掩码哨兵 ───────────────────────────

/** 公式定界符字符：`$` / `$$` 是微信、知乎等下游渲染器的共同约定 */
const DOLLAR = String.fromCharCode(36)

/**
 * 私有区哨兵：把"表示尖括号的实体"临时替换成它，删标签后再换回来。
 * 必须取正文里不可能自然出现、且不含 NUL 的字符（NUL 会让工具链把文件当二进制）。
 * 这里用 Unicode 私用区 U+E000 / U+E001。
 */
const MASK_LT = '\uE000'
const MASK_GT = '\uE001'

/** 哨兵还原用的一对字符类；写成显式转义，避免被读成区间 */
const MASKED_ANGLE = new RegExp(`[${MASK_LT}${MASK_GT}]`, 'g')
const MASK_RESTORE: Record<string, string> = { [MASK_LT]: '<', [MASK_GT]: '>' }

/** 已渲染片段的暂存槽：占位符 → 槽位号 */
const STASHED_SLOT = new RegExp(`${MASK_LT}S(\\d+)${MASK_GT}`, 'g')

/**
 * 把"已经渲染好的 Markdown 片段"先藏进占位符，等标签清理跑完再放回来。
 *
 * 为什么必须这样：代码块内容是字面文本，可能包含 `<T>`、`Map<K, V>` 这类
 * **看起来像标签**的东西。直接写回流水线的话，后面的通用标签删除会把它们
 * 当标签吃掉（`List<T>` 只剩 `List`）。
 *
 * 藏起来的片段里，尖括号换成私有区哨兵，但换行保持原样——这样它能跟上下文
 * 一起参与最后的空行压缩，与"直接内联渲染"的输出逐字一致。
 */
interface Stash {
  /** 存入一个"内容已定型"的片段，返回站位用的占位符 */
  put(text: string): string
  /** 把占位符换成片段本身（片段里的尖括号仍处于哨兵态） */
  reveal(text: string): string
  /** 换行压缩 / trim 之后调用：还原片段里的尖括号 */
  unmask(text: string): string
}

function createStash(): Stash {
  const slots: string[] = []
  return {
    put(text: string): string {
      slots.push(text)
      return `${MASK_LT}S${slots.length - 1}${MASK_GT}`
    },
    reveal(text: string): string {
      if (slots.length === 0) return text
      return text.replace(STASHED_SLOT, (whole, index: string) => slots[Number(index)] ?? whole)
    },
    unmask(text: string): string {
      return slots.length === 0 ? text : unmaskAngleEntities(text)
    },
  }
}

// ─────────────────────────── 2. 实体解码 ───────────────────────────

/**
 * 代码块用的完整解码表（命名 + 数值混合）。**必须在数值实体之后执行**：
 * `&amp;` 折叠干净、`&#…;` 解完，命名项才开始生效。
 */
const FULL_ENTITY_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&amp;', '&'],
  ['&quot;', '"'],
  ['&apos;', "'"],
  ['&#039;', "'"],
  ['&nbsp;', ' '],
  ['&ndash;', '\u2013'],
  ['&mdash;', '\u2014'],
  ['&lsquo;', '\u2018'],
  ['&rsquo;', '\u2019'],
  ['&ldquo;', '\u201C'],
  ['&rdquo;', '\u201D'],
  ['&copy;', '\u00A9'],
  ['&reg;', '\u00AE'],
  ['&trade;', '\u2122'],
  ['&hellip;', '\u2026'],
]

/** 十进制 / 十六进制数值实体（代码块路径专用） */
const DECIMAL_ENTITY = /&#([0-9]+);/g
const HEX_ENTITY = /&#[xX]([0-9a-fA-F]+);/g

/** 码点 → 字符；越界码点直接丢弃，避免 `fromCharCode` 产出乱码 */
function charFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  return String.fromCodePoint(code)
}

/**
 * 代码块实体解码（完整版）：
 *   ① `&amp;` 折叠最多 3 轮（每轮无变化即提前收工；处理 `&amp;amp;lt;` 这类多层编码）
 *   ② 十六进制 → ③ 十进制 → ④ 命名表
 * 与正文路径**故意不同**：这里连 `&mdash;`、`&#8220;` 都解，代码文本要的是原字符。
 */
function decodeCodeEntities(input: string): string {
  let out = input
  for (let pass = 0; pass < 3; pass++) {
    if (out.indexOf('&amp;') < 0) break
    out = out.split('&amp;').join('&')
  }
  out = out.replace(HEX_ENTITY, (_all, hex: string) => charFromCodePoint(parseInt(hex, 16)))
  out = out.replace(DECIMAL_ENTITY, (_all, dec: string) => charFromCodePoint(parseInt(dec, 10)))
  for (const [entity, char] of FULL_ENTITY_TABLE) {
    if (out.indexOf(entity) < 0) continue
    out = out.split(entity).join(char)
  }
  return out
}

/**
 * 正文浅表解码表——**顺序即语义**：`&amp;` 必须排在最前，否则 `&amp;lt;` 这类
 * 双重编码解不出 `<`。表内只有文章正文高频的 6 项；`&mdash;`、`&#8220;` 之流
 * 属排版层，正文路径不动它们（保持与历史输出一致）。
 */
const INLINE_ENTITY_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#039;', "'"],
  ['&nbsp;', ' '],
]

/** 正文解码：逐项单遍替换，不做迭代折叠（`&amp;lt;` 只解成字面 `&lt;`） */
function decodeInlineEntities(input: string): string {
  let out = input
  for (const [entity, char] of INLINE_ENTITY_TABLE) {
    if (out.indexOf(entity) < 0) continue
    out = out.split(entity).join(char)
  }
  return out
}

// ─────────────────────────── 3. 标签判定与白名单剔除 ───────────────────────────

/**
 * 可剥离标签集合（分组书写，组内顺序不代表优先级）。
 * 判据是"标签名在此集合内"；集合外的标签交给通用标签删除处理。
 * 集合里的代码类标签用于"代码文本里保留泛型语法"这条路径。
 */
const STRIPPABLE_TAGS: ReadonlySet<string> = new Set([
  // 行内格式
  'a',
  'abbr',
  'acronym',
  'b',
  'bdi',
  'bdo',
  'big',
  'cite',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'mark',
  'meter',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
  // 代码相关
  'code',
  'kbd',
  'pre',
  'samp',
  'tt',
  // 块级元素
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'center',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'html',
  'iframe',
  'main',
  'nav',
  'noscript',
  'p',
  'section',
  'summary',
  // 列表
  'dd',
  'dir',
  'dt',
  'li',
  'menu',
  'ol',
  'ul',
  // 表格
  'caption',
  'col',
  'colgroup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  // 换行 / 分隔
  'br',
  'hr',
  // 微信正文特有标记
  'mpcps',
  'mpprofile',
  'mpvoice',
  'qqmusic',
])

/** 扫标签用的单遍扫描：开标签、闭标签、注释/声明都算一次命中 */
const TAG_SCAN = /<[^>]*>/g
/** 从标签字面里取标签名；`<!-- -->`、`<!doctype>` 之类取不到，视作可丢弃 */
const TAG_NAME = /^<\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/

/**
 * 按白名单删除标签（只删集合内的，集合外的原样留着）。
 *
 * 用单遍扫描而不是"每个标签名一个正则"：白名单有几十项，逐名 `replace` 是
 * 每项一次全串扫描；单遍扫描只过一遍字符串，长文输入下差别明显。
 */
function stripWhitelistedTags(input: string): string {
  if (input.indexOf('<') < 0) return input
  let out = ''
  let last = 0
  TAG_SCAN.lastIndex = 0
  let hit: RegExpExecArray | null
  while ((hit = TAG_SCAN.exec(input)) !== null) {
    const name = TAG_NAME.exec(hit[0])?.[1]?.toLowerCase()
    if (name === undefined || !STRIPPABLE_TAGS.has(name)) continue
    out += input.slice(last, hit.index)
    last = hit.index + hit[0].length
  }
  return last === 0 ? input : out + input.slice(last)
}

/**
 * 整段标签：`<…>`（含未闭合、但尾巴里还有 `>` 的"标签"）。
 * 用于"内容里不该出现标签"的场景（表格单元格、figcaption）。
 */
const ANY_TAG = /<[^>]+>/g

/**
 * 主流水线最后一道通用删除。两个分支：
 *   ① `<…>`            —— 标签整段吃掉
 *   ② `<` 后面还有 `>` —— 裸尖括号，只吃掉它本身
 * 唯一放过的残渣是"`<` 之后整条尾巴再无 `>`"：那说明源 HTML 在这里被截断，
 * 后面是正文而非标签，只把它当普通字符（历史行为会把尾巴整段吞掉）。
 */
const GENERIC_TAG_OR_LT = /<[^>]*>|<(?=[^<]*>)/g

// ─────────────────────────── 4. 代码块 ───────────────────────────

/** 语言短名白名单：`class` 里只写了短名时靠它兜底（也覆盖 `hljs <词>` 的第二段） */
const LANGUAGE_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'go',
  'html',
  'java',
  'javascript',
  'json',
  'kotlin',
  'markdown',
  'php',
  'powershell',
  'python',
  'ruby',
  'rust',
  'scala',
  'shell',
  'sql',
  'swift',
  'typescript',
  'xml',
  'yaml',
])

/** 语言判定顺序：`language-x` → `lang-x` → `hljs x` → 白名单裸词 */
const LANGUAGE_HINTS: readonly RegExp[] = [/language-(\w+)/i, /lang-(\w+)/i, /\bhljs\s+(\w+)/i]

/** 从 `class="…"` 里提取语言短名；命中即转小写，认不出返回空串 */
function languageFromClass(className: string): string {
  if (!className) return ''
  for (const hint of LANGUAGE_HINTS) {
    const hit = hint.exec(className)
    if (hit?.[1]) return hit[1].toLowerCase()
  }
  for (const word of className.toLowerCase().split(/[^\w+#]+/)) {
    if (LANGUAGE_NAMES.has(word)) return word
  }
  return ''
}

/** 取标签上的双引号属性值（与图片/链接规则一致：只认双引号） */
function attributeValue(literal: string, attribute: string): string {
  const pattern = new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i')
  return pattern.exec(literal)?.[1] ?? ''
}

/** `data-lang` / `data-language`（值为裸词时才认） */
function dataLanguageOf(literal: string): string {
  const raw = attributeValue(literal, 'data-lang') || attributeValue(literal, 'data-language')
  return raw && /^\w+$/.test(raw) ? raw.toLowerCase() : ''
}

/** `<pre>` 自带的语言线索：`data-*` 优先，其次 `class` */
function languageOnPre(preLiteral: string): string {
  const fromData = dataLanguageOf(preLiteral)
  if (fromData) return fromData
  const className = attributeValue(preLiteral, 'class')
  return className ? languageFromClass(className) : ''
}

/**
 * 综合判定代码块语言。优先级（先命中者胜）：
 *   `pre[data-lang|data-language]` → `pre[class]` → 内层 `code[data-lang|data-language]` → `code[class]`
 */
function detectCodeLanguage(preLiteral: string, inner: string): string {
  const fromPre = languageOnPre(preLiteral)
  if (fromPre) return fromPre
  const codeOpen = /<code\b[^>]*>/i.exec(inner)?.[0]
  if (!codeOpen) return ''
  const fromData = dataLanguageOf(codeOpen)
  if (fromData) return fromData
  const className = attributeValue(codeOpen, 'class')
  return className ? languageFromClass(className) : ''
}

/** 代码文本的换行还原：块级边界与 `<br>` 都折算成换行 */
const CODE_LINE_BREAK = /<br\b[^>]*\/?>|<\/(?:div|p|li)\s*>/gi
/** `<code …>` / `</code>` 本身不留痕 */
const CODE_TAG = /<\/?code\b[^>]*>/gi
/** `<pre …>` 的标签体 */
const PRE_BODY = /<pre\b[^>]*>([\s\S]*?)<\/pre>/i

/** 哨兵保护：把"表示尖括号的实体"换成私有区字符（删标签之前调用） */
function maskAngleEntities(input: string): string {
  return input
    .replace(/&lt;/gi, MASK_LT)
    .replace(/&gt;/gi, MASK_GT)
    .replace(/&#0*60;/gi, MASK_LT)
    .replace(/&#0*62;/gi, MASK_GT)
    .replace(/&#x0*3[cC];/gi, MASK_LT)
    .replace(/&#x0*3[eE];/gi, MASK_GT)
}

/** 哨兵还原（删标签之后、完整解码之前调用） */
function unmaskAngleEntities(input: string): string {
  if (input.indexOf(MASK_LT) < 0 && input.indexOf(MASK_GT) < 0) return input
  return input.replace(MASKED_ANGLE, (char) => MASK_RESTORE[char] ?? char)
}

/**
 * 代码文本清洗（`extractCodeFromHtml` 与代码块规则共用）：
 *   换行还原 → 去 code 标签 → 保护尖括号实体 → 剔白名单标签 → 完整实体解码 → trim
 *
 * 哨兵**一直留到解码之后**才交给调用方还原：`&lt;T&gt;` 解出来的 `<T>` 是代码内容，
 * 不能再被当标签删一次（这正是"代码里的泛型语法被吃掉"的根因）。
 */
function cleanCodeText(inner: string): string {
  const lined = inner.replace(CODE_LINE_BREAK, '\n').replace(CODE_TAG, '')
  const shielded = maskAngleEntities(lined)
  const stripped = stripWhitelistedTags(shielded)
  return maskAngleEntities(decodeCodeEntities(stripped)).trim()
}

/** 围栏代码块：语言紧贴围栏（无空格），前后各留一个换行 */
function renderCodeFence(language: string, code: string): string {
  return `\n\`\`\`${language}\n${code}\n\`\`\`\n`
}

// ─────────────────────────── 5. 表格 ───────────────────────────

/** 表格行：标签体，不跨行 */
const TABLE_ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
/** 单元格：`<th …>` / `<td …>`，分组 1 = `h`/`d`、2 = 属性、3 = 内容 */
const TABLE_CELL = /<t([hd])\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi
/** 整张表（成对闭合才算；未闭合的留给通用删除） */
const TABLE_BODY = /<table\b[^>]*>([\s\S]*?)<\/table>/gi
/** `<figure>` 包裹体 */
const FIGURE_BODY = /<figure\b[^>]*>([\s\S]*?)<\/figure>/gi
const FIGCAPTION_BODY = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i
/** 单元格里的 `<br>` 折算成一个空格 */
const CELL_LINE_BREAK = /<br\b[^>]*\/?>/gi
/** 单元格对齐：`align="…"`（引号可有可无）或 `style="…text-align: …"` */
const ALIGN_ATTR = /\balign\s*=\s*"?\s*(left|center|right)/i
const ALIGN_STYLE = /text-align\s*:\s*(left|center|right)/i

interface TableCell {
  /** 已清洗并转义竖线的文本 */
  text: string
  /** `left` / `center` / `right` / 空串 */
  align: string
}

interface TableRow {
  cells: TableCell[]
  /** 该行是否"有单元格且全是 `<th>`" */
  allHead: boolean
  /** 该行在**原始**行列表里的序号：表头判定要跟它比，不能跟过滤后的序号比 */
  rawIndex: number
}

/** 对齐取值：属性优先，其次样式；命中即转小写 */
function readAlign(attrs: string): string {
  const attr = ALIGN_ATTR.exec(attrs)
  if (attr?.[1]) return attr[1].toLowerCase()
  const style = ALIGN_STYLE.exec(attrs)
  return style?.[1] ? style[1].toLowerCase() : ''
}

/**
 * 单元格文本：换行折空格 → 解实体 → 去标签 → 空白折叠 → 竖线转义。
 *
 * 实体解码（`&amp;` 在最前，`&amp;lt;` 才能连锁解成 `<`）与去标签之间插一层哨兵：
 * 解出来的 `<` / `>` 是**内容**，不能被当成标签吃掉（`&lt;&gt;` 要留成 `<>`）。
 */
function readCellText(inner: string): string {
  const ampersands = inner
    .replace(CELL_LINE_BREAK, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
  const shielded = maskAngleEntities(ampersands)
  const stripped = shielded.replace(ANY_TAG, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  return unmaskAngleEntities(stripped).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
}

/** 一行文本 → 单元格数组，并记录"整行都是 `<th>`" */
function readTableRow(rowLiteral: string, rawIndex: number): TableRow {
  const cells: TableCell[] = []
  let sawTd = false
  let sawTh = false
  TABLE_CELL.lastIndex = 0
  let hit: RegExpExecArray | null
  while ((hit = TABLE_CELL.exec(rowLiteral)) !== null) {
    if ((hit[1] ?? '').toLowerCase() === 'h') sawTh = true
    else sawTd = true
    cells.push({ text: readCellText(hit[3] ?? ''), align: readAlign(hit[2] ?? '') })
  }
  return { cells, allHead: cells.length > 0 && sawTh && !sawTd, rawIndex }
}

/** 对齐标记：无对齐 `---`、左 `:---`、中 `:---:`、右 `---:` */
function alignMarker(align: string): string {
  if (align === 'left') return ':---'
  if (align === 'center') return ':---:'
  if (align === 'right') return '---:'
  return '---'
}

/** 一行渲染成 `| a | b |`，短行按最大列数补空单元格 */
function renderTableRow(cells: TableCell[], width: number): string {
  const texts = cells.slice(0, width).map((cell) => cell.text)
  while (texts.length < width) texts.push('')
  return `| ${texts.join(' | ')} |`
}

/** 分隔行：按表头行的对齐逐列生成，列数不足处补 `---` */
function renderSeparator(headerCells: TableCell[], width: number): string {
  const markers = headerCells.slice(0, width).map((cell) => alignMarker(cell.align))
  while (markers.length < width) markers.push('---')
  return `| ${markers.join(' | ')} |`
}

/**
 * `<table>` 标签体 → GFM 表格。
 *
 * 表头判定：有 `<thead>` 时取"最后一个含 `<th>` 的行"；否则仅当首行**全是 `<th>`**
 * 才算表头；两者都没命中就把首行降级成表头（GFM 必须有分隔行）。
 * 分隔行插在表头行之后——表头不在首位时，它前面的数据行会原样留在分隔行之上
 * （不修正这种本来就畸形的输入）。
 */
function tableToMarkdown(tableInner: string): string {
  const rows: TableRow[] = []
  TABLE_ROW.lastIndex = 0
  let line: RegExpExecArray | null
  while ((line = TABLE_ROW.exec(tableInner)) !== null) {
    const row = readTableRow(line[0], rows.length)
    // 没有任何单元格的行不产出内容；但表头位置仍按原始行号判定
    if (row.cells.length > 0) rows.push(row)
  }
  if (rows.length === 0) return ''

  const hasThead = /<thead\b/i.test(tableInner)
  let headerIndex = -1
  if (hasThead) {
    rows.forEach((row, index) => {
      if (row.allHead) headerIndex = index
    })
  } else if (rows[0].allHead) {
    headerIndex = 0
  }
  if (headerIndex < 0) headerIndex = 0

  const width = rows.reduce((max, row) => Math.max(max, row.cells.length), 0)
  const headerRow = rows.find((row) => row.rawIndex === headerIndex) ?? rows[0]
  const out: string[] = []
  for (const row of rows) {
    out.push(renderTableRow(row.cells, width))
    if (row === headerRow) out.push(renderSeparator(headerRow.cells, width))
  }
  return out.join('\n')
}

/**
 * `<figure>` 里的表：只取 table，`<figcaption>` 的纯文本折成一行斜体说明。
 * 表外的其它内容一律丢弃；不含 table 的 figure 保持原样（后续走通用删除）。
 */
function inlineFigureTables(html: string): string {
  if (!/<figure\b/i.test(html)) return html
  return html.replace(FIGURE_BODY, (whole, figureInner: string) => {
    const tableMatch = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(figureInner)
    if (!tableMatch) return whole
    const captionText = (FIGCAPTION_BODY.exec(figureInner)?.[1] ?? '').replace(ANY_TAG, '').trim()
    return captionText ? `${tableMatch[0]}\n*${captionText}*\n` : tableMatch[0]
  })
}

/** `<table>` 主体替换：表格块前后各留一个空行，避免与相邻段落粘连 */
function inlineTables(html: string, stash: Stash): string {
  if (!/<table\b/i.test(html)) return html
  return html.replace(TABLE_BODY, (whole, tableInner: string) => {
    const table = tableToMarkdown(tableInner)
    return table ? `\n\n${stash.put(table)}\n\n` : whole
  })
}

// ─────────────────────────── 6. 主流水线 ───────────────────────────

/** 微信代码块的行号栏：必须早于列表规则，否则行号会变成列表项 */
const WECHAT_LINE_INDEX =
  /<ul\b[^>]*class\s*=\s*["'][^"']*code-snippet__line-index[^"']*["'][^>]*>[\s\S]*?<\/ul>/gi

/** 块级公式：`math/tex` 且含 `display`——**必须先于行内公式**，否则 display 语义丢失 */
const BLOCK_FORMULA =
  /<script\b[^>]*type\s*=\s*["'][^"']*math\/tex[^"']*display[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi
/** 行内公式：`type` 恰好是 `math/tex`（引号内没有别的修饰） */
const INLINE_FORMULA = /<script\b[^>]*type\s*=\s*["']math\/tex["'][^>]*>([\s\S]*?)<\/script>/gi
/** `<pre …>` 整块 */
const PRE_BLOCK = /<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi
/** `<blockquote …>` 整块 */
const BLOCKQUOTE_BLOCK = /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi

/** 标题与行内格式的标签对：`[标签名, 前缀, 后缀, 收尾换行]` */
const FORMAT_TAGS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['h1', '# ', '', '\n\n'],
  ['h2', '## ', '', '\n\n'],
  ['h3', '### ', '', '\n\n'],
  ['h4', '#### ', '', '\n\n'],
  ['h5', '##### ', '', '\n\n'],
  ['h6', '###### ', '', '\n\n'],
  ['strong', '**', '**', ''],
  ['b', '**', '**', ''],
  ['em', '*', '*', ''],
  ['i', '*', '*', ''],
]

/** 链接：`href` 必须双引号；链接文本原样 */
const LINK_TAG = /<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
/** 图片带 alt：`src` 必须出现在 `alt` 之前，且两者都是双引号 */
const IMAGE_WITH_ALT = /<img\b[^>]*\bsrc\s*=\s*"([^"]*)"[^>]*\balt\s*=\s*"([^"]*)"[^>]*\/?>/gi
/** 图片仅 src（或 alt 在 src 之前）：输出空 alt */
const IMAGE_PLAIN = /<img\b[^>]*\bsrc\s*=\s*"([^"]*)"[^>]*\/?>/gi
/** 行内代码：反引号包裹（块级 `<pre>` 已经在前面被替换掉了，这里只会命中行内） */
const INLINE_CODE = /<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi
/** 列表项 */
const LIST_ITEM = /<li\b[^>]*>([\s\S]*?)<\/li>/gi
/** 换行与分隔线 */
const LINE_BREAK = /<br\b[^>]*\/?>/gi
const HORIZONTAL_RULE = /<hr\b[^>]*\/?>/gi
/** 段落：前后各补一个换行 */
const PARAGRAPH_TAG = /<\/?p\b[^>]*>/gi
/**
 * 无序 / 有序列表容器（编号一律丢弃，有序列表退化成无序）。
 * 开标签整体消失；闭标签留一个换行——两个相邻列表之间因此保持空行分隔。
 */
const LIST_OPEN = /<(?:ul|ol)\b[^>]*>/gi
const LIST_CLOSE = /<\/(?:ul|ol)\s*>/gi

/**
 * 标题与粗斜体：`<h1>` → `# `；`<strong>`/`<b>` → `**`；`<em>`/`<i>` → `*`。
 * 开闭标签必须同名（`</h1>` 只配 `<h1>`），不做交叉配对。
 */
function inlineFormatTags(html: string): string {
  let out = html
  for (const [name, before, after, suffix] of FORMAT_TAGS) {
    if (!out.includes(`<${name}`)) continue
    const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'gi')
    out = out.replace(pattern, (_whole, inner: string) => {
      // 只折叠"本规则搬进来的"空白（标签在源里常带缩进），收尾换行原样保留
      const body = (inner ?? '').trim().replace(/\s+/g, ' ')
      return `${before}${body}${after}${suffix}`
    })
  }
  return out
}

/** 块引用：内容 trim 后逐行加 `> ` 前缀（空行也带前缀） */
function quoteLines(inner: string): string {
  const body = (inner ?? '')
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `\n${body}\n`
}

/**
 * HTML 片段 → Markdown（主流水线）。
 *
 * 步骤（顺序敏感，改动顺序即改动输出）：
 *   ① 微信行号栏 → ② figure/table → ③ 块级公式 → ④ 行内公式 → ⑤ 代码块
 *   → ⑥ 标题/粗斜体 → ⑦ 链接 → ⑧ 图片 → ⑨ 行内代码 → ⑩ 列表项
 *   → ⑪ 段落与列表容器 → ⑫ 换行/分隔线 → ⑬ 块引用 → ⑭ 通用标签删除
 *   → ⑮ 占位符放回 → ⑯ 正文实体解码 → ⑰ 压缩空行 → trim
 *
 * 三条硬约束：
 *   · 公式与代码块必须早于 ⑭——它们的内容是字面文本，不能被当标签吃掉；
 *   · 代码块与表格的产物走占位符（⑮ 才放回），否则 ⑭ 会二次啃掉里面的 `<`；
 *   · 块引用必须晚于 ⑫——`<p>` / `<br>` 先折成换行，逐行加 `> ` 才对得上行数。
 */
function htmlToMarkdownSimple(html: string): string {
  const stash = createStash()
  let out = html.replace(WECHAT_LINE_INDEX, '')

  // 表格结果先藏进占位符：单元格里解出来的 `<` / `>` 不能被后面的通用删除当标签吃掉
  out = inlineTables(inlineFigureTables(out), stash)

  // 公式体原样保留（不 trim）：公式里的空格与换行有语义，交给下游渲染器。
  // 用回调而不是替换串：`$` 本身就是定界符，替换串里无法安全地写字面 `$$`。
  out = out.replace(
    BLOCK_FORMULA,
    (_whole, body: string) => `\n${DOLLAR}${DOLLAR}\n${body ?? ''}\n${DOLLAR}${DOLLAR}\n`,
  )
  out = out.replace(
    INLINE_FORMULA,
    (_whole, body: string) => ` ${DOLLAR}${DOLLAR}${body ?? ''}${DOLLAR}${DOLLAR} `,
  )

  out = out.replace(PRE_BLOCK, (_whole, attrs: string, inner: string) =>
    stash.put(
      renderCodeFence(
        detectCodeLanguage(`<pre${attrs ?? ''}>`, inner ?? ''),
        cleanCodeText(inner ?? ''),
      ),
    ),
  )

  out = inlineFormatTags(out)

  out = out.replace(LINK_TAG, (_whole, href: string, text: string) => `[${text ?? ''}](${href})`)
  out = out.replace(IMAGE_WITH_ALT, (_whole, src: string, alt: string) => `![${alt}](${src})`)
  out = out.replace(IMAGE_PLAIN, (_whole, src: string) => `![](${src})`)

  out = out.replace(INLINE_CODE, (_whole, inner: string) => `\`${inner ?? ''}\``)

  out = out.replace(LIST_ITEM, (_whole, inner: string) => `- ${(inner ?? '').trim()}\n`)

  // 段落自带一换行；列表项自己带收尾换行，闭容器只补一个块间隔
  out = out.replace(PARAGRAPH_TAG, '\n')
  out = out.replace(LIST_OPEN, '')
  out = out.replace(LIST_CLOSE, '\n')
  out = out.replace(/<\/li\b[^>]*>/gi, '')

  out = out.replace(LINE_BREAK, '\n')
  out = out.replace(HORIZONTAL_RULE, '\n---\n')

  // 引用放在靠后的位置：`<p>` / `<br>` 已经折成换行，逐行加 `> ` 才拿到正确行数
  out = out.replace(BLOCKQUOTE_BLOCK, (_whole, inner: string) => quoteLines(inner ?? ''))

  out = out.replace(GENERIC_TAG_OR_LT, '')

  out = stash.reveal(out)

  out = decodeInlineEntities(out)

  return stash.unmask(out.replace(/\n{3,}/g, '\n\n').trim())
}

// ─────────────────────────── 7. 公开导出 ───────────────────────────

/**
 * 从一个 HTML 片段里取出代码纯文本。
 * 输入通常是 `<pre>` 的内层标签体（也可以是整段 `<pre>…</pre>`）。
 */
export function extractCodeFromHtml(html: string): string {
  const inner = PRE_BODY.exec(html)?.[1] ?? html
  return unmaskAngleEntities(cleanCodeText(inner))
}

/**
 * 转换选项。**每一项的默认值都等于历史输出**；不传选项时行为与历史逐字一致。
 */
export interface TurndownOptions {
  /** 标题样式：setext（下划线）或 atx（`#` 前缀，默认） */
  headingStyle?: 'setext' | 'atx'
  /** 分隔线字面，默认 `---` */
  hr?: string
  /** 无序列表标记，默认 `-` */
  bulletListMarker?: '-' | '+' | '*'
  /** 代码块样式：indented 或 fenced（默认，围栏代码块） */
  codeBlockStyle?: 'indented' | 'fenced'
  /** 围栏字符，默认 ``` */
  fence?: '```' | '~~~'
  /** 强调分隔符，默认 `*` */
  emDelimiter?: '_' | '*'
  /** 加粗分隔符，默认 `**` */
  strongDelimiter?: '__' | '**'
  /** 链接样式，默认 inlined（行内链接） */
  linkStyle?: 'inlined' | 'referenced'
  /** 引用链接样式，默认 full */
  linkReferenceStyle?: 'full' | 'collapsed' | 'shortcut'
}

/**
 * HTML 片段 → Markdown。
 *
 * 第二个参数目前**不参与分支**：所有选项的默认值都等于历史输出，
 * 只有显式传入非默认值时才可能改变结果（当前实现只走默认路径）。
 */
export function htmlToMarkdown(html: string, _options: TurndownOptions = {}): string {
  void _options
  return htmlToMarkdownSimple(html)
}

/** Markdown → HTML：先做加粗 flanking 归一化，再交给 `marked` 同步解析 */
export function markdownToHtml(markdown: string): string {
  return marked.parse(normalizeBoldFlanking(markdown), { async: false }) as string
}
