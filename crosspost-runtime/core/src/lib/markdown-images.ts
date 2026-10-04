/**
 * Markdown 正文里「行内图片」的位置解析。
 *
 * 用途：图片转存流程需要知道正文中每张图片的**原文片段**（用来按位置替换）、
 * **替代文本**（替换后要原样保留）和**地址**（真正拿去下载 / 上传的东西）。
 *
 * 识别范围仅限 `![alt](…)` 这一种行内写法：
 * · 引用式图片 `![alt][id]` 不识别；
 * · HTML 形态的 `<img>` 不识别（调用方另有一条扫描）；
 * · 不处理嵌套图片。
 *
 * 契约：
 * · 返回值按**出现顺序**排列，字段固定为 `full` / `alt` / `src`（调用方按这三个字段读取）；
 * · 任何结构不合法（缺 `]`、`]` 后不是 `(`、`<` 找不到配对 `>`、地址为空、末尾不是 `)`）
 *   都只是放弃当前候选并继续向后找，**不抛错**；
 * · 单趟线性扫描，不用回溯型正则；长正文不会退化；
 * · 无副作用、无 I/O、不依赖任何宿主 API —— Node 与浏览器 Service Worker 里都能调用。
 */

/** 一处行内图片的解析结果 */
export interface MarkdownImageRef {
  /** 匹配到的完整源码片段：从 `![` 起、到闭括号 `)` 止（含两端） */
  full: string
  /** 方括号里的替代文本**原文**（不做转义还原） */
  alt: string
  /** 圆括号里的地址；已剥掉可选标题，可能被尖括号包裹过 */
  src: string
}

/** 空白判定：`](` 之后、地址前后、标题前后、闭括号之前都允许空白 */
const BLANK = /\s/

/** 转义引导符；它后面的一个字符一律按字面量消费 */
const ESCAPE = '\\'

/** 标题的三种包裹形式：双引号、单引号、圆括号 */
const TITLE_OPENERS = ['"', "'", '(']

/**
 * 从 `from` 起找 `stop`，途中跳过被反斜杠转义的字符。
 * 找不到返回 `-1`。
 */
function seekStop(text: string, from: number, stop: string): number {
  let i = from
  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch === ESCAPE) {
      i += 2
      continue
    }
    if (ch === stop) return i
    i += 1
  }
  return -1
}

/** 跳过从 `from` 起的一段空白，返回第一个非空白位置（可能是串尾） */
function skipBlank(text: string, from: number): number {
  let i = from
  while (i < text.length && BLANK.test(text.charAt(i))) i += 1
  return i
}

/**
 * 在 `open` 位置读一个成对定界符（引号标题或圆括号标题）。
 * 返回**收尾定界符之后**的位置；没有收尾就一直读到串尾。
 */
function passDelimited(text: string, open: number, closer: string): number {
  let i = open + 1
  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch === ESCAPE) {
      i += 2
      continue
    }
    i += 1
    if (ch === closer) break
  }
  return i
}

/**
 * 读取裸地址：允许内部出现成对圆括号，遇到配平后的空白或未配对的 `)` 收尾。
 * 返回地址的结束位置。
 */
function seekBareUrlEnd(text: string, from: number): number {
  let i = from
  let depth = 0
  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch === ESCAPE) {
      i += 2
      continue
    }
    if (ch === '(') {
      depth += 1
      i += 1
      continue
    }
    if (ch === ')') {
      if (depth === 0) break
      depth -= 1
      i += 1
      continue
    }
    if (depth === 0 && BLANK.test(ch)) break
    i += 1
  }
  return i
}

/**
 * 解析 Markdown 文本里的全部行内图片。
 *
 * @param markdown 任意 Markdown 文本
 * @returns 按出现顺序排列的匹配数组；没有匹配时为空数组
 */
export function parseMarkdownImages(markdown: string): MarkdownImageRef[] {
  const refs: MarkdownImageRef[] = []
  const size = markdown.length
  let at = 0

  while (at < size) {
    const opener = markdown.indexOf('![', at)
    if (opener === -1) break

    // 替代文本从 `![` 之后开始
    const altFrom = opener + 2
    const altTo = seekStop(markdown, altFrom, ']')

    // 没有 `]`，或 `]` 后面不是 `(`：本次候选作废。
    // 游标只回到替代文本起点，让后面真正的图片还有机会被捡到。
    if (altTo === -1 || markdown.charAt(altTo + 1) !== '(') {
      at = altFrom
      continue
    }

    let scan = skipBlank(markdown, altTo + 2)
    let address: string

    if (markdown.charAt(scan) === '<') {
      const closer = markdown.indexOf('>', scan + 1)
      if (closer === -1) {
        at = altTo + 1
        continue
      }
      address = markdown.slice(scan + 1, closer)
      scan = closer + 1
    } else {
      const urlFrom = scan
      scan = seekBareUrlEnd(markdown, scan)
      address = markdown.slice(urlFrom, scan)
    }

    // 地址为空（`![]()`）同样作废
    if (address === '') {
      at = altTo + 1
      continue
    }

    // 可选标题：三种包裹形式都吃掉，内容一律丢弃
    scan = skipBlank(markdown, scan)
    const opener2 = markdown.charAt(scan)
    if (TITLE_OPENERS.indexOf(opener2) >= 0) {
      const closer = opener2 === '(' ? ')' : opener2
      scan = skipBlank(markdown, passDelimited(markdown, scan, closer))
    }

    if (markdown.charAt(scan) !== ')') {
      at = altTo + 1
      continue
    }

    refs.push({
      full: markdown.slice(opener, scan + 1),
      alt: markdown.slice(altFrom, altTo),
      src: address,
    })
    at = scan + 1
  }

  return refs
}
