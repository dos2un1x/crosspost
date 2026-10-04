/**
 * 代码块的两种「文本结构」处理：
 *  1. 长行软折行 —— 移动端 `pre` 不换行会横向溢出，平台又不提供滚动容器；
 *  2. 无语言代码块里的 ASCII 表格识别 —— 作者常把表格画在代码块里，直接渲染更易读。
 *
 * 两者都只处理**文本**，不产出 HTML：渲染形态由引擎决定（元素级规则在 engine.ts）。
 */

/** 一段被识别出来的内容：表格段或普通代码段 */
export type CodeSegment = ['table' | 'code', string]

/** Unicode 框线字符（Box Drawing / Block Elements 区段） */
const BOX_RUN = /[\u2500-\u257F\u2580-\u259F]/
/** 框线表格的竖向分隔符：带它的行是数据行，不是边框行 */
const BOX_VERTICAL = '\u2502'
/** 分隔行/边框行允许出现的 ASCII 字符 */
const RULE_CHARS = /^[\s|+\-=:]*$/
/** 框线边框行：在上面那组之外还允许 Unicode 框线字符 */
const BORDER_CHARS = /^[\s|+\-=:\u2500-\u257F\u2580-\u259F]*$/

/** 行内 `|` 数量 —— 管道数据行的判据 */
function pipeCount(line: string): number {
  let n = 0
  for (const ch of line) if (ch === '|') n += 1
  return n
}

/** 去掉空白后只剩 `+ - = : |` 且含 `--` 或 `==` 的行 = 分隔行 */
function isSeparatorRow(line: string): boolean {
  const stripped = line.replace(/\s+/g, '')
  if (stripped === '' || !RULE_CHARS.test(stripped)) return false
  return stripped.includes('--') || stripped.includes('==')
}

/** 管道表的数据行：至少两个 `|` */
function isPipeRow(line: string): boolean {
  return pipeCount(line) >= 2
}

/** 框线表的数据行：含 `│` */
function isBoxDataRow(line: string): boolean {
  return line.includes(BOX_VERTICAL)
}

/**
 * 框线表的边框行：去掉空白后只由空白/框线字符/`+ - = :`/`|` 组成，
 * 至少含一个框线字符，且不含 `│`（含 `│` 的是数据行）。
 */
function isBoxBorderRow(line: string): boolean {
  if (isBoxDataRow(line)) return false
  const stripped = line.replace(/\s+/g, '')
  if (!stripped || !BORDER_CHARS.test(stripped)) return false
  return BOX_RUN.test(stripped)
}

/** 表格块的行分类 */
type RowKind = 'pipe' | 'separator' | 'box-border' | 'box-data' | 'text'

function classify(line: string): RowKind {
  if (isSeparatorRow(line)) return 'separator'
  if (isBoxDataRow(line)) return 'box-data'
  if (isBoxBorderRow(line)) return 'box-border'
  if (isPipeRow(line)) return 'pipe'
  return 'text'
}

const isTableRow = (kind: RowKind): boolean =>
  kind === 'pipe' || kind === 'separator' || kind === 'box-border' || kind === 'box-data'

/**
 * 从 `start` 起吃一个「框线风格表」：连续吃边框行/数据行，
 * 要求至少见过一条边框行、且数据行 ≥ 2；否则返回 0（不算表）。
 */
function takeBoxTable(kinds: RowKind[], start: number): number {
  let i = start
  let border = 0
  let data = 0
  while (i < kinds.length && (kinds[i] === 'box-border' || kinds[i] === 'box-data')) {
    if (kinds[i] === 'box-border') border += 1
    else data += 1
    i += 1
  }
  return border >= 1 && data >= 2 ? i - start : 0
}

/**
 * 从 `start` 起吃一个「管道表」：连续吃分隔行/管道行，允许夹**一个**空行
 * （仅当空行之后的下一个非空行仍是表格行时才并入，用于分割相邻子表）。
 * 要求至少一条分隔行、且数据行 ≥ 2。
 */
function takePipeTable(lines: string[], kinds: RowKind[], start: number): number {
  let i = start
  let separator = 0
  let data = 0
  let lastRow = start
  while (i < lines.length) {
    const kind = kinds[i]
    if (kind === 'separator') {
      separator += 1
      lastRow = i
      i += 1
      continue
    }
    if (kind === 'pipe') {
      data += 1
      lastRow = i
      i += 1
      continue
    }
    if (lines[i].trim() === '' && i + 1 < lines.length && isTableRow(kinds[i + 1])) {
      i += 1
      continue
    }
    break
  }
  if (separator < 1 || data < 2) return 0
  return lastRow - start + 1
}

/**
 * 识别代码块里的 ASCII 表格。
 *
 * 返回按出现顺序排列的段落序列（`table` = 需要渲染成表格，`code` = 保持代码），
 * 整块里一条表都没有时返回 `null`（调用方按纯代码渲染）。
 */
export function detectAsciiTable(code: string): CodeSegment[] | null {
  if (!code) return null
  const lines = code.replace(/\r\n?/g, '\n').split('\n')
  const kinds = lines.map(classify)

  let found = false
  const segments: CodeSegment[] = []
  let buffer: string[] = []
  let cursor = 0

  const flushText = (): void => {
    if (buffer.length === 0) return
    const text = buffer.join('\n')
    if (text.trim() !== '') segments.push(['code', text])
    buffer = []
  }

  while (cursor < lines.length) {
    const kind = kinds[cursor]
    const boxSpan = kind === 'box-border' ? takeBoxTable(kinds, cursor) : 0
    const pipeSpan = isTableRow(kind) ? takePipeTable(lines, kinds, cursor) : 0
    const span = Math.max(boxSpan, pipeSpan)
    if (span > 0) {
      flushText()
      segments.push(['table', lines.slice(cursor, cursor + span).join('\n')])
      cursor += span
      found = true
      continue
    }
    buffer.push(lines[cursor])
    cursor += 1
  }
  flushText()

  return found ? segments : null
}

/** 管道/框线数据行 → 单元格数组（去首尾分隔符、逐格 trim） */
function splitRow(line: string, delimiter: string): string[] {
  let text = line.trim()
  if (text.startsWith(delimiter)) text = text.slice(delimiter.length)
  if (text.endsWith(delimiter)) text = text.slice(0, -delimiter.length)
  return text.split(delimiter).map((cell) => cell.trim())
}

/**
 * 表格段 → 行 × 列 的纯文本矩阵（首行是表头）。
 * 分隔行与边框行只是版式，不产出数据；列数不齐时补空串到最大列数。
 */
export function parseAsciiTableRows(table: string): string[][] {
  const rows: string[][] = []
  for (const raw of table.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.trim() === '') continue
    const kind = classify(raw)
    if (kind === 'separator' || kind === 'box-border') continue
    if (kind === 'box-data') rows.push(splitRow(raw, BOX_VERTICAL))
    else rows.push(splitRow(raw, '|'))
  }
  const widths = rows.map((row) => row.length)
  const columns = widths.length ? Math.max(...widths) : 0
  return rows.map((row) => {
    const padded = row.slice()
    while (padded.length < columns) padded.push('')
    return padded
  })
}

/** 行首缩进（空格/制表符） */
function leadingIndent(line: string): string {
  const matched = /^[ \t]*/.exec(line)
  return matched ? matched[0] : ''
}

/**
 * 找 `limit` 之前最后一个**不在字符串字面量里**的逗号下标；没有则返回 -1。
 * 单双引号成对跟踪，反斜杠转义的引号不算边界 —— 避免把 `"a,b"` 拆断。
 */
function lastCommaOutsideString(line: string, limit: number): number {
  let quote: string | null = null
  let found = -1
  const end = Math.min(limit, line.length)
  for (let i = 0; i < end; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ',') found = i
  }
  return found
}

/** 单行折行：超过宽度阈值时在阈值前的最后一个逗号处断开，续行缩进 +4 空格 */
function wrapOneLine(line: string, maxWidth: number): string {
  if (line.length <= maxWidth) return line
  const indent = leadingIndent(line)
  const parts: string[] = []
  let current = line
  let guard = 0

  while (current.length > maxWidth && guard < 256) {
    guard += 1
    const at = lastCommaOutsideString(current, maxWidth)
    if (at < 0) break
    parts.push(current.slice(0, at + 1))
    current = `${indent}    ${current.slice(at + 1).replace(/^[ \t]+/, '')}`
  }
  parts.push(current)
  return parts.join('\n')
}

/**
 * 代码块长行软换行：按逗号边界断开，续行缩进 = 原缩进 + 4 空格，递归处理剩余部分。
 * 阈值内不动、找不到逗号不折行；空行与短行原样保留（因此可重复调用）。
 */
export function wrapCodeLines(code: string, maxWidth = 45): string {
  if (!code) return code
  const width = Number.isFinite(maxWidth) && maxWidth > 0 ? Math.floor(maxWidth) : 45
  return code
    .split('\n')
    .map((line) => wrapOneLine(line, width))
    .join('\n')
}
