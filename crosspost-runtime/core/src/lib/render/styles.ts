/**
 * 样式参数模型（M8）
 *
 * 三层结构，全部由「参数 + 推导规则」生成，模块内**不存在**"逐元素完整样式串"字典：
 *
 *   1. `StyleParams`        —— 可声明 / 可覆盖的**唯一事实源**（核心四色 + 可选项；
 *                              除核心三色外全部可缺省，缺省值由推导规则算出）。
 *   2. `resolveStyleParams` —— 派生层：算出 dark 判定、hairline、块间距、圆角、
 *                              正文字体栈、强调色、表格与代码配色等派生量。
 *   3. `derive*()`          —— 逐元素推导（每个元素的 inline style 由参数表达式拼出，
 *                              结构变体是 `switch`/枚举分支，不是查表）。
 *
 * 约定：
 *  - 颜色一律原样保留调用方给的大小写与写法（只做合法性判断），不做隐式归一，
 *    否则自定义样式里用户明确写的 `#f7faf7` 会被改写，观感与面板色板都会漂移。
 *  - 只用**系统字体**：不引入任何需要下载的字体家族（公众号不加载 webfont）。
 *  - `StyleDefinition` 上的若干旧拼写字段（`border_width` / `headingStyle` / `blockquote_bg` …）
 *    是给**尚未随本模块一起重写的渲染方**保留的只写镜像：本模块只写不读；
 *    样式输入侧一律以本文件的 canonical 拼写为准（旧拼写别名在 M9 里翻译）。
 */

/* ══════════════════════════════════════════════════════════════════════
 * 枚举与参数集合
 * ══════════════════════════════════════════════════════════════════════ */

export type StyleCategory = 'core' | 'extend' | 'custom'
export type FontClass =
  'sans-ui' | 'sans-geo' | 'serif-latin' | 'serif-cjk' | 'mono' | 'display-sans'
export type HeadingProfile = 'document' | 'slide' | 'structured'
export type HeadingStyle = 'plain' | 'left-border' | 'underline' | 'bg-block'
export type BlockquoteStyle = 'left-border' | 'full-box' | 'plain'
export type CodeBlockStyle = 'left-bar' | 'full-border'
export type Density = 'compact' | 'normal' | 'airy'
export type ImageShadow = 'none' | 'soft' | 'strong'
export type EmphasisStyle = 'accent-bold' | 'italic'
export type FooterStyle = 'plain' | 'rule'
export type CalloutSide = 'left' | 'top'
export type TextAlign = 'left' | 'center' | 'right'

export interface HeadingSizeScale {
  h1: string
  h2: string
  h3: string
  h4: string
}

export interface CalloutTypeStyle {
  /** 头部左侧英文标签（大写显示） */
  label: string
  /** 标题为空时的中文默认标题 */
  title: string
  /** 边线 / 分隔线颜色 */
  border: string
  /** 卡片底色 */
  bg: string
  /** 标签色（缺省跟随 border） */
  labelColor?: string
  /** 强调边的方位 */
  side: CalloutSide
}

export type CalloutPalette = Record<string, CalloutTypeStyle>

/** 可声明 / 可覆盖的参数集合 */
export interface StyleParams {
  /* ── A. 身份与元信息 ── */
  category?: StyleCategory
  desc?: string

  /* ── B. 调色板（核心） ── */
  bg: string
  accent: string
  text: string
  secondary?: string

  /* ── C. 调色板（可选覆盖） ── */
  hairline?: string
  codeBg?: string
  codeBorderColor?: string
  codeText?: string
  codeSpanBg?: string
  codeSpanText?: string
  tableBorderColor?: string
  tableCellBorderColor?: string
  tableHeadBg?: string
  tableHeadText?: string
  captionColor?: string
  notesColor?: string
  notesNumberColor?: string
  notesLabelColor?: string
  metaBoxBg?: string
  metaBoxBorder?: string

  /* ── D. 排版 ── */
  font?: string
  fontClass?: FontClass
  monoFont?: string
  baseFontSize?: string
  lineHeight?: number | string
  listItemLineHeight?: number | string
  headingSizes?: Partial<HeadingSizeScale>
  paragraphGap?: string
  headingUppercase?: boolean

  /* ── E. 结构与装饰 ── */
  headingProfile?: HeadingProfile
  headingStructure?: HeadingStyle
  headingBg?: string
  headingBorderColor?: string
  headingColor?: string
  h3Structure?: HeadingStyle
  borderWidth?: string
  headingBorderWidth?: string
  headingRuleWidth?: string
  headingRuleMaxWidth?: string
  blockquoteStructure?: BlockquoteStyle
  blockquoteBg?: string
  blockquoteBorderColor?: string
  blockquoteBorderWidth?: string
  blockquoteTextColor?: string
  blockquoteItalic?: boolean
  blockquoteOpacity?: number | string
  italicQuoteBg?: string
  italicQuoteBorderColor?: string
  codeBlockStructure?: CodeBlockStyle
  codeFontSize?: string
  codeWrapEnabled?: boolean
  codeWrapWidth?: number
  listBullet?: string
  listBulletSize?: string
  imageRadius?: string
  imageShadow?: ImageShadow
  captionSuppress?: string[]
  linkColor?: string
  linkUnderline?: boolean
  emStyle?: EmphasisStyle
  strongColor?: string
  hrVisible?: boolean
  hrColor?: string
  hrWidth?: string
  radius?: string
  density?: Density
  containerPadding?: string
  headerLabel?: string
  headerTitle?: string
  footerStyle?: FooterStyle
  notesLabel?: string
  calloutPalette?: CalloutPalette

  /* ── 渲染方兼容镜像（只写不读；输入侧不接受这些拼写，由 M9 翻译） ── */
  /** 旧"逐元素完整样式串"结构：本模型不读不写，仅为未重写的渲染方保留字段位 */
  cssTemplate?: Record<string, string>
  headingStyle?: HeadingStyle
  h3_style?: HeadingStyle
  heading_bg?: string
  heading_border_color?: string
  heading_color?: string
  h3_border_color?: string
  blockquoteStyle?: BlockquoteStyle
  blockquote_bg?: string
  blockquote_border_color?: string
  border_width?: string
}

/** 参数 + 已算好的派生量（交给渲染方的最终形态） */
export interface StyleDefinition extends StyleParams {
  category: StyleCategory
  desc: string
  secondary: string
  font: string
  monoFont: string
  baseFontSize: string
  lineHeight: string
  listItemLineHeight: string
  headingSizes: HeadingSizeScale
  paragraphGap: string
  headingUppercase: boolean
  headingProfile: HeadingProfile
  headingStructure: HeadingStyle
  h3Structure: HeadingStyle
  headingBorderColor: string
  borderWidth: string
  headingBorderWidth: string
  headingRuleWidth: string
  headingRuleMaxWidth: string
  /** h1 装饰线色：slide 族做对比安全替换，其余用强调色 */
  headingRuleColor: string
  blockquoteStructure: BlockquoteStyle
  blockquoteBg: string
  blockquoteBorderColor: string
  blockquoteBorderWidth: string
  blockquoteTextColor: string
  blockquoteItalic: boolean
  blockquoteOpacity: string
  italicQuoteBg: string
  italicQuoteBorderColor: string
  codeBlockStructure: CodeBlockStyle
  codeBg: string
  codeBorderColor: string
  codeText: string
  codeSpanBg: string
  codeSpanText: string
  codeFontSize: string
  codeWrapEnabled: boolean
  codeWrapWidth: number
  tableBorderColor: string
  tableCellBorderColor: string
  tableHeadBg: string
  tableHeadText: string
  captionColor: string
  captionSuppress: string[]
  imageRadius: string
  imageShadow: ImageShadow
  listBullet: string
  listBulletSize: string
  linkColor: string
  linkUnderline: boolean
  emStyle: EmphasisStyle
  strongColor: string
  /** `<strong>` 的实际字色（`inherit` 表示跟随上下文） */
  emphasisColor: string
  hrVisible: boolean
  hrColor: string
  hrWidth: string
  radius: string
  density: Density
  gapScale: number
  blockGap: string
  containerPadding: string
  footerStyle: FooterStyle
  notesColor: string
  notesNumberColor: string
  notesLabelColor: string
  notesLabel: string
  metaBoxBg: string
  metaBoxBorder: string
  hairline: string
  isDark: boolean
  calloutPalette: CalloutPalette
}

/* ══════════════════════════════════════════════════════════════════════
 * 字体系（只用系统字体）
 * ══════════════════════════════════════════════════════════════════════ */

export const FONT_STACKS: Record<FontClass, string> = {
  // 系统 UI 无衬线：优先平台原生界面字体
  'sans-ui':
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  // 几何无衬线：以 system-ui 起手，字形更匀称
  'sans-geo':
    "system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  // 拉丁衬线 + 宋体中文
  'serif-latin': "Georgia, 'Times New Roman', 'Songti SC', 'Noto Serif CJK SC', SimSun, serif",
  // 中文楷体为主的手写感衬线
  'serif-cjk': "'Palatino Linotype', 'Kaiti SC', STKaiti, Kaiti, Georgia, serif",
  // 等宽：代码与终端
  mono: "Menlo, Monaco, Consolas, 'Courier New', 'PingFang SC', 'Microsoft YaHei', monospace",
  // 展示型粗黑：只用于标题气质极强的样式
  'display-sans':
    "Impact, 'Arial Black', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
}

/** 字体栈归一：双引号会截断 inline style 属性，统一成单引号 */
export function normalizeFontStack(font: string): string {
  return String(font).replace(/"/g, "'").replace(/\s+/g, ' ').trim()
}

/* ══════════════════════════════════════════════════════════════════════
 * 颜色与尺寸工具
 * ══════════════════════════════════════════════════════════════════════ */

/** `#RGB` / `#RRGGBB` → 通道值；非法返回 null */
export function parseHexColor(color: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim())
  if (!m) return null
  const hex =
    m[1].length === 3
      ? m[1]
          .split('')
          .map((c) => c + c)
          .join('')
      : m[1]
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }
}

/** 感知亮度（299/587/114 加权）；无法解析返回 null */
function perceivedLuminance(color: string): number | null {
  const rgb = parseHexColor(color)
  if (!rgb) return null
  return (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000
}

/** 是否为深色底（亮度 < 128）；无法解析按浅色处理 */
export function isDarkColor(color: string): boolean {
  const lum = perceivedLuminance(color)
  return lum === null ? false : lum < 128
}

/**
 * 对比安全色：当前景与背景亮度过于接近（例如亮蓝底配黑字）时改用白/黑，
 * 避免"装饰色融进底色"。亮度差足够则原样返回。
 */
export function contrastSafeColor(bg: string, fg: string): string {
  const lb = perceivedLuminance(bg)
  const lf = perceivedLuminance(fg)
  if (lb === null || lf === null) return fg
  if (Math.abs(lb - lf) >= 96) return fg
  return lb < 128 ? '#ffffff' : '#111111'
}

/** `12px` / `1.5` → 数值；非法返回 null */
function pxNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const m = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(value.trim())
  return m ? Number(m[1]) : null
}

/** 按比例缩放 px 值（用于从基准宽度推出次级尺寸） */
function scalePx(value: string, factor: number): string {
  const n = pxNumber(value)
  if (n === null) return value
  return `${Math.round(n * factor * 100) / 100}px`
}

/** 圆角刻度是否为直角（"网格 / 极简风"的判定依据：直角观感 → 浅灰网格线） */
function isSquare(radius: string): boolean {
  return pxNumber(radius) === 0
}

/** 拼 inline style：跳过空值，统一 `prop: value;` 形态 */
function css(decls: Record<string, string | number | undefined | null>): string {
  const parts: string[] = []
  for (const [prop, value] of Object.entries(decls)) {
    if (value === undefined || value === null || value === '') continue
    parts.push(`${prop}: ${value}`)
  }
  return parts.length ? `${parts.join('; ')};` : ''
}

/* ══════════════════════════════════════════════════════════════════════
 * 派生：由核心参数推出完整样式
 * ══════════════════════════════════════════════════════════════════════ */

/** 密度 → 块级外边距缩放 */
const DENSITY_SCALE: Record<Density, number> = { compact: 0.85, normal: 1, airy: 1.25 }

/** 块间距基准（px），所有块级元素共用 */
const BASE_BLOCK_GAP = 16

/** 默认图注抑制词（另有"Pasted image 开头"与图片文件名后缀两条规则） */
export const DEFAULT_CAPTION_SUPPRESS = ['image', 'img', '图片', 'pasted image', 'screenshot']

/** callout 类型 → 默认参数（同义类型共享同一套值） */
export const DEFAULT_CALLOUT_PALETTE: CalloutPalette = {
  TIP: { label: 'Tips', title: '知识科普', border: '#2563eb', bg: '#f3f7ff', side: 'left' },
  TIPS: { label: 'Tips', title: '知识科普', border: '#2563eb', bg: '#f3f7ff', side: 'left' },
  OVERVIEW: { label: 'Overview', title: '背景概览', border: '#6b7280', bg: '#f8f9fb', side: 'top' },
  FACTS: { label: 'Facts', title: '时空复盘', border: '#2f7a52', bg: '#f3faf5', side: 'top' },
  IMPORTANT: { label: 'Facts', title: '时空复盘', border: '#2f7a52', bg: '#f3faf5', side: 'top' },
  VALUE: { label: 'Value', title: '价值视角', border: '#6d43c8', bg: '#f8f5ff', side: 'left' },
  INVERSE: { label: 'Inverse', title: '反向思考', border: '#c2410c', bg: '#fff7f0', side: 'top' },
  WARNING: { label: 'Inverse', title: '反向思考', border: '#c2410c', bg: '#fff7f0', side: 'top' },
  TAKEAWAY: { label: 'Takeaway', title: '实操启示', border: '#0f766e', bg: '#f1faf7', side: 'top' },
  CAUTION: { label: 'Takeaway', title: '实操启示', border: '#0f766e', bg: '#f1faf7', side: 'top' },
  HIGHLIGHTS: {
    label: 'Highlights',
    title: '高光金句',
    border: '#c1912a',
    bg: '#fcf7e6',
    labelColor: '#c81e2b',
    side: 'top',
  },
  NOTE: { label: 'Note', title: '评注', border: '#26282b', bg: '#faf9f8', side: 'left' },
}

/**
 * 中性基准参数：只给四种颜色，也能推出一套完整可用的样式
 * （`styles new` 未指定模板、样式采样结果缺字段时都从这里出发）。
 */
export const BASE_STYLE_PARAMS: StyleParams = {
  category: 'custom',
  desc: '',
  bg: '#ffffff',
  accent: '#2b6cb0',
  text: '#1f2328',
  secondary: '#5c5f66',
  headingProfile: 'structured',
  headingStructure: 'left-border',
  blockquoteStructure: 'left-border',
  codeBlockStructure: 'left-bar',
  imageShadow: 'soft',
  density: 'normal',
  radius: '4px',
  lineHeight: 1.75,
  listItemLineHeight: 1.6,
  baseFontSize: '15px',
  borderWidth: '3px',
  headingRuleWidth: '3px',
  headingRuleMaxWidth: '180px',
  codeFontSize: '12px',
  codeWrapEnabled: true,
  codeWrapWidth: 45,
  listBullet: '•',
  listBulletSize: '13px',
  imageRadius: '8px',
  containerPadding: '18px 14px',
  footerStyle: 'plain',
}

/**
 * 由参数推出完整样式：先算派生量（dark / hairline / 间距 / 圆角…），
 * 再补齐兼容镜像字段供未重写的渲染方读取。
 */
export function resolveStyleParams(params: StyleParams): StyleDefinition {
  const density: Density = params.density ?? 'normal'
  const gapScale = DENSITY_SCALE[density] ?? 1
  const bg = params.bg
  const accent = params.accent
  const text = params.text
  const secondary = params.secondary ?? '#5c5f66'
  const isDark = isDarkColor(bg)
  const hairline = params.hairline ?? (isDark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.08)')
  const radius = params.radius ?? '4px'
  const gridLike = isSquare(radius)
  const borderWidth = params.borderWidth ?? '3px'
  const fontClass: FontClass = params.fontClass ?? 'sans-ui'
  const monoFont = params.monoFont ?? FONT_STACKS.mono
  const headingProfile: HeadingProfile = params.headingProfile ?? 'structured'
  const headingStructure: HeadingStyle = params.headingStructure ?? 'left-border'
  const blockquoteStructure: BlockquoteStyle = params.blockquoteStructure ?? 'left-border'
  const strongColor = params.strongColor ?? 'inherit'
  const blockGap = `${Math.round(BASE_BLOCK_GAP * gapScale)}px`
  const neutralDeep = isDark ? text : '#2b2d31'
  const neutralPale = isDark ? 'rgba(255,255,255,0.45)' : '#97999e'
  const neutralPalest = isDark ? 'rgba(255,255,255,0.32)' : '#b0b2b6'
  const gridLine = isDark ? 'rgba(255,255,255,0.16)' : '#dcdcdc'
  const blockquoteBg = params.blockquoteBg ?? (isDark ? 'rgba(255,255,255,0.06)' : '#f7f7f5')
  const blockquoteBorderColor = params.blockquoteBorderColor ?? accent

  return {
    ...params,
    category: params.category ?? 'custom',
    desc: params.desc ?? '',
    bg,
    accent,
    text,
    secondary,
    font: normalizeFontStack(params.font ?? FONT_STACKS[fontClass]),
    fontClass,
    monoFont,
    baseFontSize: params.baseFontSize ?? '15px',
    lineHeight: String(params.lineHeight ?? 1.75),
    listItemLineHeight: String(params.listItemLineHeight ?? 1.6),
    headingSizes: {
      h1: params.headingSizes?.h1 ?? '28px',
      h2: params.headingSizes?.h2 ?? '22px',
      h3: params.headingSizes?.h3 ?? '19px',
      h4: params.headingSizes?.h4 ?? '16px',
    },
    paragraphGap: params.paragraphGap ?? `${blockGap} 0`,
    headingUppercase: params.headingUppercase ?? false,
    headingProfile,
    headingStructure,
    h3Structure: params.h3Structure ?? headingStructure,
    headingBorderColor: params.headingBorderColor ?? accent,
    borderWidth,
    headingBorderWidth: params.headingBorderWidth ?? borderWidth,
    headingRuleWidth: params.headingRuleWidth ?? '3px',
    headingRuleMaxWidth: params.headingRuleMaxWidth ?? '180px',
    headingRuleColor:
      headingProfile === 'slide'
        ? contrastSafeColor(bg, params.headingBorderColor ?? text)
        : (params.headingBorderColor ?? accent),
    blockquoteStructure,
    blockquoteBg,
    blockquoteBorderColor,
    blockquoteBorderWidth: params.blockquoteBorderWidth ?? borderWidth,
    blockquoteTextColor:
      params.blockquoteTextColor ?? (blockquoteStructure === 'full-box' ? text : secondary),
    blockquoteItalic: params.blockquoteItalic ?? true,
    blockquoteOpacity: String(params.blockquoteOpacity ?? 0.9),
    italicQuoteBg: params.italicQuoteBg ?? '#f1f2f4',
    italicQuoteBorderColor: params.italicQuoteBorderColor ?? accent,
    codeBlockStructure: params.codeBlockStructure ?? 'left-bar',
    codeBg: params.codeBg ?? (isDark ? 'rgba(255,255,255,0.07)' : '#f4f4f5'),
    codeBorderColor: params.codeBorderColor ?? secondary,
    codeText: params.codeText ?? neutralDeep,
    codeSpanBg: params.codeSpanBg ?? (isDark ? 'rgba(255,255,255,0.10)' : '#f0f1f3'),
    codeSpanText: params.codeSpanText ?? text,
    codeFontSize: params.codeFontSize ?? '12px',
    codeWrapEnabled: params.codeWrapEnabled ?? true,
    codeWrapWidth: params.codeWrapWidth ?? 45,
    tableBorderColor: params.tableBorderColor ?? (gridLike ? gridLine : text),
    tableCellBorderColor: params.tableCellBorderColor ?? (gridLike ? gridLine : secondary),
    tableHeadBg: params.tableHeadBg ?? (isDark ? text : '#eff0f1'),
    tableHeadText: params.tableHeadText ?? (isDark ? bg : text),
    captionColor: params.captionColor ?? '#8b8f96',
    captionSuppress: params.captionSuppress ?? DEFAULT_CAPTION_SUPPRESS,
    imageRadius: params.imageRadius ?? radius,
    imageShadow: params.imageShadow ?? 'soft',
    listBullet: params.listBullet ?? '•',
    listBulletSize: params.listBulletSize ?? '13px',
    linkColor: params.linkColor ?? accent,
    linkUnderline: params.linkUnderline ?? false,
    emStyle: params.emStyle ?? 'accent-bold',
    strongColor,
    emphasisColor: strongColor === 'accent' ? accent : 'inherit',
    hrVisible: params.hrVisible ?? true,
    hrColor: params.hrColor ?? hairline,
    hrWidth: params.hrWidth ?? '1px',
    radius,
    density,
    gapScale,
    blockGap,
    containerPadding: params.containerPadding ?? '18px 14px',
    footerStyle: params.footerStyle ?? 'plain',
    notesColor: params.notesColor ?? secondary,
    notesNumberColor: params.notesNumberColor ?? neutralPale,
    notesLabelColor: params.notesLabelColor ?? neutralPalest,
    notesLabel: params.notesLabel ?? 'NOTES',
    metaBoxBg: params.metaBoxBg ?? (isDark ? 'rgba(255,255,255,0.04)' : '#f8f8f6'),
    metaBoxBorder: params.metaBoxBorder ?? (isDark ? 'rgba(255,255,255,0.14)' : '#ececee'),
    hairline,
    isDark,
    calloutPalette: { ...DEFAULT_CALLOUT_PALETTE, ...(params.calloutPalette ?? {}) },

    // ── 渲染方兼容镜像（只写不读，见文件头说明） ──
    cssTemplate: undefined,
    border_width: borderWidth,
    headingStyle: headingStructure,
    h3_style: params.h3Structure ?? headingStructure,
    heading_bg: params.headingBg,
    heading_border_color: params.headingBorderColor ?? accent,
    heading_color: params.headingColor,
    h3_border_color: params.headingBorderColor ?? accent,
    blockquoteStyle: blockquoteStructure,
    blockquote_bg: blockquoteBg,
    blockquote_border_color: blockquoteBorderColor,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 逐元素推导（§3.4）
 * ══════════════════════════════════════════════════════════════════════ */

export interface DerivedHeading {
  /** 外层装饰容器的 inline style（朴素标题为空串） */
  wrapper: string
  /** 内层标题元素的 inline style */
  inner: string
  /** 内层标签：slide 族的 h2/h3 用 span 承载 */
  innerTag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'span'
}

/** 标题：容器承载装饰与间距，内层只承载字号/字重/字色（margin 只在容器上） */
export function deriveHeading(style: StyleDefinition, level: number): DerivedHeading {
  const tag = (level <= 6 ? `h${level}` : 'h6') as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  const size =
    level >= 4 ? style.headingSizes.h4 : style.headingSizes[`h${level}` as 'h1' | 'h2' | 'h3']
  const uppercase = style.headingUppercase ? 'uppercase' : undefined
  const bgBlockText =
    style.headingColor && style.headingColor.toLowerCase() !== (style.headingBg ?? '').toLowerCase()
      ? style.headingColor
      : style.text

  // h4+ 一律朴素（无外层装饰容器）
  if (level >= 4) {
    return {
      wrapper: '',
      inner: css({ margin: `${style.blockGap} 0`, 'font-weight': 'bold', color: style.text }),
      innerTag: tag,
    }
  }

  if (style.headingProfile === 'slide') {
    if (level === 1) {
      return {
        wrapper: css({
          margin: '0 0 40px',
          'border-bottom': `${style.borderWidth} solid ${style.headingRuleColor}`,
          'padding-bottom': '15px',
          'max-width': style.headingRuleMaxWidth,
        }),
        inner: css({
          'font-size': style.headingSizes.h1,
          'font-weight': '900',
          'line-height': '1.1',
          margin: 0,
          color: style.text,
          'text-transform': uppercase,
        }),
        innerTag: tag,
      }
    }
    if (level === 2) {
      return {
        wrapper: css({
          margin: '50px 0 20px',
          'border-top': `2px solid ${style.text}`,
          'padding-top': '15px',
          'max-width': scalePx(style.headingRuleMaxWidth, 5 / 6),
        }),
        inner: css({
          color: style.accent,
          'font-size': style.headingSizes.h2,
          'font-weight': '800',
          'text-transform': uppercase,
        }),
        innerTag: 'span',
      }
    }
    return {
      wrapper: css({
        margin: '25px 0 10px',
        'border-left': `${style.headingBorderWidth} solid ${style.headingBorderColor}`,
        'padding-left': '10px',
      }),
      inner: css({
        'font-size': style.headingSizes.h3,
        'font-weight': 'bold',
        color: style.text,
      }),
      innerTag: 'span',
    }
  }

  // document / structured：h1 视觉锚点统一（下划线）
  if (level === 1) {
    return {
      wrapper: css({
        margin: '30px 0 20px',
        'border-bottom': `${style.headingRuleWidth} solid ${style.accent}`,
        'padding-bottom': '10px',
      }),
      inner: css({
        'font-size': style.headingSizes.h1,
        'font-weight': 'bold',
        color: style.text,
        margin: 0,
        'line-height': '1.3',
      }),
      innerTag: tag,
    }
  }

  const structure: HeadingStyle =
    style.headingProfile === 'structured'
      ? level === 2
        ? style.headingStructure
        : style.h3Structure
      : level === 2
        ? 'plain'
        : 'left-border'

  if (structure === 'bg-block' && style.headingBg) {
    return {
      wrapper: css({
        margin: `${style.blockGap} 0`,
        'background-color': style.headingBg,
        padding: '8px 14px',
        'border-radius': style.radius,
      }),
      inner: css({ 'font-size': size, 'font-weight': 'bold', color: bgBlockText, margin: 0 }),
      innerTag: tag,
    }
  }
  if (structure === 'left-border') {
    return {
      wrapper: css({
        margin: `${style.blockGap} 0`,
        'border-left': `${style.headingBorderWidth} solid ${style.headingBorderColor}`,
        'padding-left': '12px',
      }),
      inner: css({ 'font-size': size, 'font-weight': 'bold', color: style.text, margin: 0 }),
      innerTag: tag,
    }
  }
  if (structure === 'underline') {
    return {
      wrapper: css({
        margin: `${style.blockGap} 0`,
        'border-bottom': `2px solid ${style.accent}`,
        'padding-bottom': '6px',
      }),
      inner: css({ 'font-size': size, 'font-weight': 'bold', color: style.text, margin: 0 }),
      innerTag: tag,
    }
  }
  return {
    wrapper: css({ margin: `${style.blockGap} 0` }),
    inner: css({ 'font-size': size, 'font-weight': 'bold', color: style.accent, margin: 0 }),
    innerTag: tag,
  }
}

/** 段落（列表项内的段落去掉外边距并收紧行高） */
export function deriveParagraph(style: StyleDefinition, inList = false): string {
  if (inList) {
    return css({
      margin: 0,
      'font-size': style.baseFontSize,
      'line-height': style.listItemLineHeight,
      color: style.text,
    })
  }
  return css({
    'font-size': style.baseFontSize,
    'line-height': style.lineHeight,
    margin: style.paragraphGap,
    color: style.text,
  })
}

export interface DerivedBlockquote {
  wrapper: string
  inner: string
}

/** 引用三态：左竖线 / 整框 / 朴素 */
export function deriveBlockquote(style: StyleDefinition): DerivedBlockquote {
  const italic = style.blockquoteItalic ? 'italic' : 'normal'
  const base = {
    'font-size': style.baseFontSize,
    'line-height': style.lineHeight,
    'font-style': italic,
  }
  if (style.blockquoteStructure === 'full-box') {
    return {
      wrapper: css({
        margin: '30px 0',
        padding: '25px',
        border: `1px solid ${style.hairline}`,
        'border-left': `${style.blockquoteBorderWidth} solid ${style.blockquoteBorderColor}`,
        'background-color': style.blockquoteBg,
        'border-radius': style.radius,
      }),
      inner: css({ ...base, color: style.blockquoteTextColor, opacity: style.blockquoteOpacity }),
    }
  }
  if (style.blockquoteStructure === 'plain') {
    return {
      wrapper: css({ margin: `${style.blockGap} 0`, padding: '15px 20px' }),
      inner: css({ ...base, color: style.secondary }),
    }
  }
  return {
    wrapper: css({
      margin: `${style.blockGap} 0`,
      padding: '16px 20px',
      'border-left': `${style.blockquoteBorderWidth} solid ${style.blockquoteBorderColor}`,
      'background-color': style.blockquoteBg,
    }),
    inner: css({ ...base, color: style.blockquoteTextColor }),
  }
}

/** 整段斜体段落 → 引用卡片（与引用三态是两套） */
export function deriveItalicQuote(style: StyleDefinition): DerivedBlockquote {
  return {
    wrapper: css({
      margin: '22px 0',
      padding: '16px 20px',
      'background-color': style.italicQuoteBg,
      'border-left': `3px solid ${style.italicQuoteBorderColor}`,
      'border-radius': `0 ${style.radius} ${style.radius} 0`,
    }),
    inner: css({
      color: style.blockquoteTextColor,
      'font-size': style.baseFontSize,
      'line-height': style.lineHeight,
      'font-style': 'normal',
    }),
  }
}

export interface DerivedCallout {
  type: CalloutTypeStyle
  wrapper: string
  header: string
  label: string
  title: string
  body: string
}

/** callout：结构固定，颜色/标签/强调边方位全部来自类型参数 */
export function deriveCallout(
  style: StyleDefinition,
  type: string,
  options: { title?: string } = {},
): DerivedCallout {
  const key = String(type || '').toUpperCase()
  const t = style.calloutPalette[key] ?? style.calloutPalette.NOTE ?? DEFAULT_CALLOUT_PALETTE.NOTE
  const typeStyle: CalloutTypeStyle = { ...t, title: options.title?.trim() || t.title }
  const side =
    typeStyle.side === 'left'
      ? { 'border-left': `6px solid ${typeStyle.border}` }
      : { 'border-top': `6px solid ${typeStyle.border}` }
  return {
    type: typeStyle,
    wrapper: css({
      margin: '24px 0',
      border: `1.5px solid ${typeStyle.border}`,
      ...side,
      padding: '18px',
      'background-color': typeStyle.bg,
      'box-sizing': 'border-box',
    }),
    header: css({
      display: 'flex',
      'justify-content': 'space-between',
      'align-items': 'baseline',
      'border-bottom': `1px solid ${typeStyle.border}`,
      'padding-bottom': '6px',
      'margin-bottom': '12px',
      'box-sizing': 'border-box',
    }),
    label: css({
      'font-size': '11px',
      'font-weight': 'bold',
      color: typeStyle.labelColor ?? typeStyle.border,
      'letter-spacing': '1.5px',
      'font-family': FONT_STACKS['sans-ui'],
      'text-transform': 'uppercase',
    }),
    title: css({
      'font-size': '14px',
      'font-weight': 'bold',
      color: style.text,
      'font-family': FONT_STACKS['sans-ui'],
    }),
    body: css({
      'font-size': '14px',
      'line-height': '1.7',
      color: style.text,
      'text-align': 'justify',
      margin: 0,
      padding: 0,
    }),
  }
}

/** 代码块外壳 + `<pre>` */
export function deriveCodeBlock(style: StyleDefinition): { wrapper: string; pre: string } {
  const fullBorder = style.codeBlockStructure === 'full-border'
  return {
    wrapper: css({
      margin: style.blockGap,
      padding: '15px',
      'background-color': style.codeBg,
      'overflow-x': 'auto',
      border: fullBorder ? `1px solid ${style.codeBorderColor}` : undefined,
      'border-radius': fullBorder ? style.radius : '0',
      'border-left': fullBorder ? undefined : `3px solid ${style.codeBorderColor}`,
    }),
    pre: css({
      margin: 0,
      'font-family': style.monoFont,
      'font-size': style.codeFontSize,
      'line-height': '1.5',
      'white-space': 'pre-wrap',
      'word-break': 'break-word',
      color: style.codeText,
    }),
  }
}

/** 列表：块 + 每项 flex 行 + 标记 + 内容列 */
export function deriveList(style: StyleDefinition): {
  list: string
  item: string
  bullet: string
  content: string
} {
  return {
    list: css({ margin: style.blockGap }),
    item: css({ margin: '8px 0', display: 'flex', 'align-items': 'flex-start' }),
    bullet: css({
      color: style.accent,
      'font-weight': 'bold',
      'margin-right': '8px',
      'font-size': style.listBulletSize,
      'line-height': '1.2',
    }),
    content: css({
      'font-size': style.baseFontSize,
      'line-height': style.listItemLineHeight,
      color: style.text,
    }),
  }
}

/** 分隔线：默认不输出（标题自带装饰线），参数要求时才给 `<hr>` */
export function deriveRule(style: StyleDefinition): string | null {
  if (!style.hrVisible) return null
  return css({
    border: 'none',
    'border-top': `${style.hrWidth} solid ${style.hrColor}`,
    margin: style.blockGap,
  })
}

/** 图片：居中块 + 圆角/阴影 + 图注 */
export function deriveImage(style: StyleDefinition): {
  wrapper: string
  img: string
  caption: string
} {
  const shadow =
    style.imageShadow === 'strong'
      ? '0 10px 30px rgba(0,0,0,0.24)'
      : style.imageShadow === 'soft'
        ? '0 6px 18px rgba(0,0,0,0.09)'
        : undefined
  return {
    wrapper: css({ margin: '25px 0', 'text-align': 'center' }),
    img: css({
      'max-width': '100%',
      'border-radius': style.imageRadius,
      'box-shadow': shadow,
      display: 'block',
      margin: '0 auto',
    }),
    caption: css({ color: style.captionColor, 'font-size': '13px', 'margin-top': '10px' }),
  }
}

/** 图注抑制：空 / 通用词 / Pasted image 开头 / 图片文件名后缀 */
export function shouldSuppressCaption(alt: string, style: StyleDefinition): boolean {
  const raw = String(alt ?? '').trim()
  if (!raw) return true
  const lower = raw.toLowerCase()
  if (style.captionSuppress.some((w) => w.toLowerCase() === lower)) return true
  if (lower.startsWith('pasted image')) return true
  return /\.(png|jpg|jpeg|gif|webp)$/i.test(lower)
}

/** 表格：滚动容器 + 表格 + 行线 + 表头/单元格（表头自带底色与字色，不依赖继承） */
export function deriveTable(
  style: StyleDefinition,
  align: TextAlign = 'left',
): { scroll: string; table: string; row: string; head: string; cell: string } {
  return {
    scroll: css({
      margin: '25px 0',
      'overflow-x': 'auto',
      '-webkit-overflow-scrolling': 'touch',
    }),
    table: css({
      'border-collapse': 'collapse',
      width: '100%',
      border: `1px solid ${style.tableBorderColor}`,
      'background-color': style.bg,
      'font-size': '14px',
    }),
    row: css({ 'border-bottom': `1px solid ${style.hairline}` }),
    head: css({
      border: `1px solid ${style.tableCellBorderColor}`,
      padding: '12px 10px',
      'text-align': align,
      'background-color': style.tableHeadBg,
      color: style.tableHeadText,
      'font-weight': 'bold',
    }),
    cell: css({
      border: `1px solid ${style.tableCellBorderColor}`,
      padding: '10px',
      'text-align': align,
      color: style.text,
    }),
  }
}

/** `<strong>` / `<em>` */
export function deriveEmphasis(style: StyleDefinition, kind: 'strong' | 'em'): string {
  if (kind === 'strong') return css({ 'font-weight': 'bold', color: style.emphasisColor })
  if (style.emStyle === 'italic') return css({ 'font-style': 'italic' })
  return css({ 'font-style': 'normal', color: style.accent, 'font-weight': 'bold' })
}

/** 行内代码 */
export function deriveInlineCode(style: StyleDefinition): string {
  return css({
    background: style.codeSpanBg,
    padding: '2px 4px',
    'font-family': style.monoFont,
    'font-size': '13px',
    'border-radius': style.radius,
    color: style.codeSpanText,
  })
}

/** 链接 */
export function deriveLink(style: StyleDefinition): string {
  return css({
    color: style.linkColor,
    'text-decoration': style.linkUnderline ? 'underline' : 'none',
    'word-break': 'break-word',
  })
}

/** 注区块（脚注扁平化后的形态） */
export function deriveNotes(style: StyleDefinition): {
  section: string
  label: string
  item: string
  number: string
  content: string
} {
  return {
    section: css({
      'margin-top': '40px',
      'padding-top': '16px',
      'border-top': `1px solid ${style.hairline}`,
    }),
    label: css({
      'font-size': '11px',
      'letter-spacing': '1px',
      color: style.notesLabelColor,
      'text-transform': 'uppercase',
      margin: '0 0 12px 0',
    }),
    item: css({
      'font-size': '13px',
      'line-height': '1.65',
      margin: '0 0 6px 0',
      color: style.notesColor,
      display: 'flex',
      'align-items': 'flex-start',
    }),
    number: css({
      'min-width': '22px',
      'font-weight': 'bold',
      color: style.notesNumberColor,
      'flex-shrink': '0',
    }),
    content: css({ flex: '1' }),
  }
}

/** frontmatter 元信息框 */
export function deriveMetaBox(style: StyleDefinition): { box: string; row: string; key: string } {
  return {
    box: css({
      margin: '0 0 30px',
      padding: '20px',
      border: `1px solid ${style.metaBoxBorder}`,
      'background-color': style.metaBoxBg,
      'border-radius': style.radius,
    }),
    row: css({ margin: '4px 0', 'font-size': '13px', color: style.secondary }),
    key: css({ color: style.accent, 'text-transform': 'uppercase' }),
  }
}

/** header 装饰条 */
export function deriveHeaderBar(style: StyleDefinition): {
  bar: string
  label: string
  title: string
  ruleAccent: string
  ruleHairline: string
} {
  return {
    bar: css({ 'margin-bottom': '18px' }),
    label: css({
      'font-size': '11px',
      'font-weight': '800',
      'letter-spacing': '3px',
      'text-transform': 'uppercase',
      color: style.accent,
      'margin-bottom': '6px',
    }),
    title: css({
      'font-size': '19px',
      'font-weight': '800',
      'line-height': '1.4',
      color: style.text,
      'margin-bottom': '10px',
    }),
    ruleAccent: css({ 'border-bottom': `2px solid ${style.accent}`, width: '100%' }),
    ruleHairline: css({
      'border-bottom': `1px solid ${style.hairline}`,
      width: '100%',
      'margin-top': '2px',
    }),
  }
}

/** 页脚：`plain` = 细线版；`rule` = 粗线版 */
export function deriveFooter(style: StyleDefinition): string {
  if (style.footerStyle === 'rule') {
    return css({
      'margin-top': '60px',
      'text-align': 'center',
      'border-top': `5px solid ${style.text}`,
      'padding-top': '25px',
      'font-size': '14px',
      'font-weight': '900',
      'letter-spacing': '2px',
      color: style.text,
      'text-transform': 'uppercase',
    })
  }
  return css({
    'margin-top': '50px',
    'text-align': 'center',
    'border-top': `1px solid ${style.hairline}`,
    'padding-top': '20px',
    'font-size': '12px',
    'font-weight': '600',
    'letter-spacing': '1px',
    color: style.secondary,
    'text-transform': 'uppercase',
  })
}

/** 容器（唯一携带背景色与字体栈的元素） */
export function deriveContainer(style: StyleDefinition): string {
  return css({
    'background-color': style.bg,
    color: style.text,
    'font-family': style.font,
    padding: style.containerPadding,
  })
}

/** 元素键：给下游渲染方一个统一的推导入口 */
export type StyledElement =
  | 'container'
  | 'headerBar'
  | 'headerLabel'
  | 'headerTitle'
  | 'headerRuleAccent'
  | 'headerRuleHairline'
  | 'footer'
  | 'paragraph'
  | 'paragraphInList'
  | 'quote'
  | 'quoteInner'
  | 'italicQuote'
  | 'italicQuoteInner'
  | 'codeBlock'
  | 'codePre'
  | 'list'
  | 'listItem'
  | 'listBullet'
  | 'listContent'
  | 'tableScroll'
  | 'table'
  | 'tableRow'
  | 'tableHead'
  | 'tableCell'
  | 'image'
  | 'imageCaption'
  | 'strong'
  | 'em'
  | 'inlineCode'
  | 'link'
  | 'notes'
  | 'notesLabel'
  | 'notesItem'
  | 'notesNumber'
  | 'notesContent'
  | 'metaBox'
  | 'metaBoxRow'
  | 'metaBoxKey'
  | 'hr'

/** 统一推导入口：`switch` 分派，每个分支只做属性取值，不做字符串查表 */
export function deriveElementStyle(
  element: StyledElement,
  style: StyleDefinition,
  ctx: { align?: TextAlign } = {},
): string {
  switch (element) {
    case 'container':
      return deriveContainer(style)
    case 'headerBar':
      return deriveHeaderBar(style).bar
    case 'headerLabel':
      return deriveHeaderBar(style).label
    case 'headerTitle':
      return deriveHeaderBar(style).title
    case 'headerRuleAccent':
      return deriveHeaderBar(style).ruleAccent
    case 'headerRuleHairline':
      return deriveHeaderBar(style).ruleHairline
    case 'footer':
      return deriveFooter(style)
    case 'paragraph':
      return deriveParagraph(style)
    case 'paragraphInList':
      return deriveParagraph(style, true)
    case 'quote':
      return deriveBlockquote(style).wrapper
    case 'quoteInner':
      return deriveBlockquote(style).inner
    case 'italicQuote':
      return deriveItalicQuote(style).wrapper
    case 'italicQuoteInner':
      return deriveItalicQuote(style).inner
    case 'codeBlock':
      return deriveCodeBlock(style).wrapper
    case 'codePre':
      return deriveCodeBlock(style).pre
    case 'list':
      return deriveList(style).list
    case 'listItem':
      return deriveList(style).item
    case 'listBullet':
      return deriveList(style).bullet
    case 'listContent':
      return deriveList(style).content
    case 'tableScroll':
      return deriveTable(style).scroll
    case 'table':
      return deriveTable(style).table
    case 'tableRow':
      return deriveTable(style).row
    case 'tableHead':
      return deriveTable(style, ctx.align ?? 'left').head
    case 'tableCell':
      return deriveTable(style, ctx.align ?? 'left').cell
    case 'image':
      return deriveImage(style).img
    case 'imageCaption':
      return deriveImage(style).caption
    case 'strong':
      return deriveEmphasis(style, 'strong')
    case 'em':
      return deriveEmphasis(style, 'em')
    case 'inlineCode':
      return deriveInlineCode(style)
    case 'link':
      return deriveLink(style)
    case 'notes':
      return deriveNotes(style).section
    case 'notesLabel':
      return deriveNotes(style).label
    case 'notesItem':
      return deriveNotes(style).item
    case 'notesNumber':
      return deriveNotes(style).number
    case 'notesContent':
      return deriveNotes(style).content
    case 'metaBox':
      return deriveMetaBox(style).box
    case 'metaBoxRow':
      return deriveMetaBox(style).row
    case 'metaBoxKey':
      return deriveMetaBox(style).key
    case 'hr':
      return deriveRule(style) ?? ''
    default:
      return ''
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 参数校验（§3.8）
 * ══════════════════════════════════════════════════════════════════════ */

const COLOR_FIELDS = [
  'secondary',
  'hairline',
  'codeBg',
  'codeBorderColor',
  'codeText',
  'codeSpanBg',
  'codeSpanText',
  'tableBorderColor',
  'tableCellBorderColor',
  'tableHeadBg',
  'tableHeadText',
  'captionColor',
  'notesColor',
  'notesNumberColor',
  'notesLabelColor',
  'metaBoxBg',
  'metaBoxBorder',
  'headingBg',
  'headingBorderColor',
  'headingColor',
  'blockquoteBg',
  'blockquoteBorderColor',
  'blockquoteTextColor',
  'italicQuoteBg',
  'italicQuoteBorderColor',
  'linkColor',
  'hrColor',
] as const

/**
 * 颜色类字段名（只接受 hex）。导出给"导入既有样式"的调用方用来**规整取值**：
 * 旧样式文件里这些字段夹着 `!important` 或整段渐变（`linear-gradient(…)`），
 * 直接喂给模型会被判非法。见 CLI 的 `styles install`。
 */
export const STYLE_COLOR_FIELDS: readonly string[] = COLOR_FIELDS

const TEXT_FIELDS = [
  'font',
  'monoFont',
  'paragraphGap',
  'containerPadding',
  'listBullet',
  'notesLabel',
  'headerLabel',
  'headerTitle',
  'strongColor',
  'desc',
] as const

const LENGTH_FIELDS = [
  'borderWidth',
  'headingBorderWidth',
  'headingRuleWidth',
  'headingRuleMaxWidth',
  'blockquoteBorderWidth',
  'codeFontSize',
  'imageRadius',
  'hrWidth',
  'listBulletSize',
  'radius',
  'baseFontSize',
] as const

const BOOLEAN_FIELDS = [
  'headingUppercase',
  'blockquoteItalic',
  'codeWrapEnabled',
  'linkUnderline',
  'hrVisible',
] as const

const ENUM_FIELDS: Record<string, readonly string[]> = {
  category: ['core', 'extend', 'custom'],
  fontClass: ['sans-ui', 'sans-geo', 'serif-latin', 'serif-cjk', 'mono', 'display-sans'],
  headingProfile: ['document', 'slide', 'structured'],
  headingStructure: ['plain', 'left-border', 'underline', 'bg-block'],
  h3Structure: ['plain', 'left-border', 'underline', 'bg-block'],
  blockquoteStructure: ['left-border', 'full-box', 'plain'],
  codeBlockStructure: ['left-bar', 'full-border'],
  density: ['compact', 'normal', 'airy'],
  imageShadow: ['none', 'soft', 'strong'],
  emStyle: ['accent-bold', 'italic'],
  footerStyle: ['plain', 'rule'],
}

/** 全部 canonical 参数键（含仅供内部翻译的旧拼写镜像） */
export const STYLE_PARAM_KEYS: ReadonlySet<string> = new Set<string>([
  'bg',
  'accent',
  'text',
  ...COLOR_FIELDS,
  ...TEXT_FIELDS,
  ...LENGTH_FIELDS,
  ...BOOLEAN_FIELDS,
  ...Object.keys(ENUM_FIELDS),
  'codeWrapWidth',
  'blockquoteOpacity',
  'lineHeight',
  'listItemLineHeight',
  'captionSuppress',
  'headingSizes',
  'calloutPalette',
  'cssTemplate',
  'headingStyle',
  'h3_style',
  'heading_bg',
  'heading_border_color',
  'heading_color',
  'h3_border_color',
  'blockquoteStyle',
  'blockquote_bg',
  'blockquote_border_color',
  'border_width',
])

export interface StyleParamValidation {
  /** 必填字段是否满足（不满足则该样式整条跳过） */
  ok: boolean
  /** 校验通过后的 canonical 参数（只含合法字段） */
  params: StyleParams
  /** 致命原因（缺字段 / 非法 hex），供调用方拼 warning */
  error?: string
  /** 非致命问题 */
  warnings: string[]
  /** 不属于参数集合的键 */
  unknownKeys: string[]
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const LENGTH_RE = /^-?\d+(?:\.\d+)?(?:px|em|rem|%)?$/

function asLength(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}px`
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!LENGTH_RE.test(v)) return null
  return /^-?\d+(?:\.\d+)?$/.test(v) ? `${v}px` : v
}

/**
 * 校验并归一化一组 canonical 参数。
 * 规则见 §3.8：核心三色必填且必须是 hex；次级色可选（缺省 #5c5f66）；
 * 枚举非法则忽略并告警；尺寸非法则回落缺省并告警；字体栈双引号归一为单引号。
 */
export function validateStyleParams(input: Record<string, unknown>): StyleParamValidation {
  const warnings: string[] = []
  const unknownKeys: string[] = []
  const params: Record<string, unknown> = {}

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim()
    if (!STYLE_PARAM_KEYS.has(key)) {
      unknownKeys.push(key)
      continue
    }
    if (rawValue === undefined || rawValue === null) continue

    if (key === 'bg' || key === 'accent' || key === 'text') {
      if (typeof rawValue !== 'string' || !HEX_RE.test(rawValue.trim())) {
        return {
          ok: false,
          params: {} as StyleParams,
          error: `字段 ${key} 不是合法 hex 颜色: ${String(rawValue)}`,
          warnings,
          unknownKeys,
        }
      }
      params[key] = rawValue.trim()
      continue
    }
    if ((COLOR_FIELDS as readonly string[]).includes(key)) {
      if (typeof rawValue !== 'string' || !HEX_RE.test(rawValue.trim())) {
        warnings.push(`字段 ${key} 不是合法 hex 颜色，已忽略: ${String(rawValue)}`)
        continue
      }
      params[key] = rawValue.trim()
      continue
    }
    if (key in ENUM_FIELDS) {
      const allowed = ENUM_FIELDS[key]
      if (typeof rawValue !== 'string' || !allowed.includes(rawValue)) {
        warnings.push(
          `字段 ${key} 取值非法（允许 ${allowed.join('/')}），已忽略: ${String(rawValue)}`,
        )
        continue
      }
      params[key] = rawValue
      continue
    }
    if ((BOOLEAN_FIELDS as readonly string[]).includes(key)) {
      if (typeof rawValue !== 'boolean') {
        warnings.push(`字段 ${key} 需要布尔值，已忽略: ${String(rawValue)}`)
        continue
      }
      params[key] = rawValue
      continue
    }
    if (key === 'codeWrapWidth') {
      const n = Number(rawValue)
      if (!Number.isFinite(n) || n <= 0) {
        warnings.push(`字段 ${key} 需要正数，已忽略: ${String(rawValue)}`)
        continue
      }
      params[key] = Math.round(n)
      continue
    }
    if (key === 'lineHeight' || key === 'listItemLineHeight') {
      const n = pxNumber(rawValue) ?? Number(rawValue)
      if (!Number.isFinite(n) || n <= 0) {
        warnings.push(`字段 ${key} 需要正数，已忽略: ${String(rawValue)}`)
        continue
      }
      params[key] = typeof rawValue === 'string' && rawValue.trim().endsWith('px') ? rawValue : n
      continue
    }
    if (key === 'blockquoteOpacity') {
      const n = Number(rawValue)
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        warnings.push(`字段 ${key} 需要 0–1 的数值，已忽略: ${String(rawValue)}`)
        continue
      }
      params[key] = n
      continue
    }
    if ((TEXT_FIELDS as readonly string[]).includes(key)) {
      if (typeof rawValue !== 'string') {
        warnings.push(`字段 ${key} 需要字符串，已忽略`)
        continue
      }
      if (key === 'font' || key === 'monoFont') {
        if (!rawValue.trim()) {
          warnings.push(`字段 ${key} 需要非空字符串，已忽略`)
          continue
        }
        params[key] = normalizeFontStack(rawValue)
        continue
      }
      if (key === 'strongColor') {
        const v = rawValue.trim()
        if (!(v === 'inherit' || v === 'accent' || HEX_RE.test(v))) {
          warnings.push(`字段 ${key} 只接受 inherit/accent/hex，已忽略: ${rawValue}`)
          continue
        }
        params[key] = v
        continue
      }
      params[key] = rawValue
      continue
    }
    if ((LENGTH_FIELDS as readonly string[]).includes(key)) {
      const len = asLength(rawValue)
      if (len === null) {
        warnings.push(`字段 ${key} 不是合法尺寸，已忽略: ${String(rawValue)}`)
        continue
      }
      params[key] = len
      continue
    }
    if (key === 'captionSuppress') {
      if (!Array.isArray(rawValue) || rawValue.some((v) => typeof v !== 'string')) {
        warnings.push('字段 captionSuppress 需要字符串数组，已忽略')
        continue
      }
      params[key] = rawValue.map((v) => String(v))
      continue
    }
    if (key === 'headingSizes') {
      if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
        warnings.push('字段 headingSizes 需要对象，已忽略')
        continue
      }
      const scale: Record<string, string> = {}
      for (const [k, v] of Object.entries(rawValue as Record<string, unknown>)) {
        if (!['h1', 'h2', 'h3', 'h4'].includes(k)) {
          warnings.push(`headingSizes 未知级别 ${k}，已忽略`)
          continue
        }
        const len = asLength(v)
        if (len === null) {
          warnings.push(`headingSizes.${k} 不是合法尺寸，已忽略: ${String(v)}`)
          continue
        }
        scale[k] = len
      }
      params[key] = scale
      continue
    }
    if (key === 'calloutPalette') {
      if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
        warnings.push('字段 calloutPalette 需要对象，已忽略')
        continue
      }
      const palette: CalloutPalette = {}
      for (const [k, v] of Object.entries(rawValue as Record<string, unknown>)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          warnings.push(`calloutPalette.${k} 需要对象，已忽略`)
          continue
        }
        const entry = v as Record<string, unknown>
        const border =
          typeof entry.border === 'string' && HEX_RE.test(entry.border.trim())
            ? entry.border.trim()
            : null
        const entryBg =
          typeof entry.bg === 'string' && HEX_RE.test(entry.bg.trim()) ? entry.bg.trim() : null
        if (!border || !entryBg) {
          warnings.push(`calloutPalette.${k} 缺少合法 border/bg，已忽略`)
          continue
        }
        palette[k.toUpperCase()] = {
          label: typeof entry.label === 'string' ? entry.label : k.toUpperCase(),
          title: typeof entry.title === 'string' ? entry.title : '',
          border,
          bg: entryBg,
          labelColor:
            typeof entry.labelColor === 'string' && HEX_RE.test(entry.labelColor.trim())
              ? entry.labelColor.trim()
              : undefined,
          side: entry.side === 'top' ? 'top' : 'left',
        }
      }
      params[key] = palette
      continue
    }
    // 旧拼写镜像：登记但直接丢弃（输入侧由 M9 翻译成 canonical 后再校验）
    if (key === 'cssTemplate') continue
    if (typeof rawValue === 'string') {
      params[key] = rawValue
      continue
    }
    warnings.push(`字段 ${key} 类型不受支持，已忽略`)
  }

  for (const required of ['bg', 'accent', 'text'] as const) {
    if (params[required] === undefined) {
      return {
        ok: false,
        params: {} as StyleParams,
        error: `缺少必填字段 ${required}`,
        warnings,
        unknownKeys,
      }
    }
  }
  return { ok: true, params: params as unknown as StyleParams, warnings, unknownKeys }
}

/* ══════════════════════════════════════════════════════════════════════
 * 内置样式目录（10 条）
 *
 * 每条只声明"参数向量"（颜色 / 字体类 / 边线基准 / 结构要点），
 * 其余全部由派生规则算出；`desc` 为本实现自撰文案。
 * ══════════════════════════════════════════════════════════════════════ */

interface BuiltinSeed extends StyleParams {
  category: StyleCategory
  desc: string
}

const BUILTIN_PARAMS: Record<string, BuiltinSeed> = {
  swiss: {
    category: 'core',
    desc: '白纸黑字配一抹朱红，直角网格排版，长文阅读的默认基底。',
    bg: '#fdfdfd',
    accent: '#d93025',
    text: '#111111',
    secondary: '#5f6368',
    fontClass: 'sans-geo',
    borderWidth: '4px',
    headingProfile: 'document',
    radius: '0',
    density: 'normal',
    lineHeight: 1.75,
    listBullet: '•',
    listBulletSize: '14px',
    blockquoteStructure: 'left-border',
    blockquoteBg: '#f3f2ee',
    // 引用边线沿用灰调细线（观感约定：白底样式不用强调色画引用线）
    blockquoteBorderColor: '#bcb9b4',
    blockquoteBorderWidth: '3px',
    blockquoteItalic: true,
    codeBlockStructure: 'left-bar',
    codeSpanText: '#d93025',
    codeSpanBg: '#f2f1ee',
    tableBorderColor: '#dedbd6',
    tableCellBorderColor: '#e2dfda',
    tableHeadBg: '#f1efeb',
    imageRadius: '0',
    imageShadow: 'none',
    linkUnderline: false,
  },
  editorial: {
    category: 'core',
    desc: '暖米色纸感与酒红标题，行距从容，像一本慢读的杂志内页。',
    bg: '#f3efe7',
    accent: '#8c2f39',
    text: '#211d19',
    secondary: '#6b6259',
    fontClass: 'serif-latin',
    borderWidth: '3px',
    headingProfile: 'slide',
    density: 'airy',
    lineHeight: 1.85,
    radius: '3px',
    headingRuleMaxWidth: '200px',
    listBullet: '■',
    listBulletSize: '12px',
    blockquoteStructure: 'full-box',
    blockquoteBg: '#ece5d9',
    imageShadow: 'soft',
  },
  ink: {
    category: 'core',
    desc: '宣纸底色配朱砂落款，大行距、细笔触，适合札记与长文。',
    bg: '#fbf9f4',
    accent: '#b32b26',
    text: '#191919',
    secondary: '#4a4a4a',
    fontClass: 'serif-cjk',
    borderWidth: '2px',
    headingProfile: 'slide',
    density: 'airy',
    lineHeight: 2,
    radius: '2px',
    headingRuleMaxWidth: '170px',
    listBullet: '■',
    listBulletSize: '10px',
    blockquoteStructure: 'left-border',
    blockquoteBg: '#f4f1ea',
    blockquoteBorderColor: '#b32b26',
    blockquoteItalic: true,
    imageRadius: '2px',
    imageShadow: 'none',
  },
  notebook: {
    category: 'extend',
    desc: '浅米纸底与墨绿标注，圆角卡片像一本随手翻开的笔记。',
    bg: '#f6f2e9',
    accent: '#2f7d5d',
    text: '#23201b',
    secondary: '#6a6257',
    fontClass: 'sans-ui',
    borderWidth: '3px',
    headingProfile: 'slide',
    density: 'normal',
    lineHeight: 1.8,
    radius: '8px',
    listBullet: '•',
    listBulletSize: '13px',
    blockquoteStructure: 'left-border',
    blockquoteBg: '#efe9dc',
    codeBlockStructure: 'full-border',
    tableHeadBg: '#eae3d4',
    imageRadius: '10px',
    imageShadow: 'soft',
  },
  geometry: {
    category: 'extend',
    desc: '柔和的紫罗兰强调色与圆润色块，几何但不冷硬。',
    bg: '#f7f7fb',
    accent: '#6c4bd6',
    text: '#1c1c22',
    secondary: '#5b5b6b',
    fontClass: 'sans-geo',
    borderWidth: '5px',
    headingProfile: 'slide',
    density: 'normal',
    lineHeight: 1.8,
    radius: '8px',
    headingStructure: 'bg-block',
    headingBg: '#e9e3fb',
    headingColor: '#2b2250',
    listBullet: '•',
    listBulletSize: '14px',
    blockquoteStructure: 'full-box',
    blockquoteBg: '#f0eefb',
    imageRadius: '8px',
    imageShadow: 'soft',
  },
  botanical: {
    category: 'extend',
    desc: '深林色调与暗金强调，衬线字落在暗底上像标本册的扉页。',
    bg: '#101410',
    accent: '#c9a227',
    text: '#ece7dd',
    secondary: '#9c968a',
    fontClass: 'serif-cjk',
    borderWidth: '3px',
    headingProfile: 'slide',
    density: 'airy',
    lineHeight: 1.9,
    radius: '4px',
    listBullet: '•',
    listBulletSize: '12px',
    blockquoteStructure: 'left-border',
    blockquoteBg: 'rgba(255,255,255,0.06)',
    strongColor: 'accent',
    imageShadow: 'soft',
  },
  terminal: {
    category: 'extend',
    desc: '深色终端配色与等宽字体，像直接把命令行输出贴进正文。',
    bg: '#0b1020',
    accent: '#2fd07a',
    text: '#e3ecf5',
    secondary: '#8b98a8',
    fontClass: 'mono',
    borderWidth: '2px',
    headingProfile: 'slide',
    density: 'compact',
    lineHeight: 1.7,
    radius: '0',
    codeBlockStructure: 'full-border',
    codeBorderColor: '#2fd07a',
    codeFontSize: '11px',
    codeSpanText: '#2fd07a',
    codeSpanBg: 'rgba(47,208,122,0.10)',
    strongColor: 'accent',
    listBullet: '■',
    listBulletSize: '11px',
    imageShadow: 'none',
  },
  bold: {
    category: 'extend',
    desc: '近乎全黑的高对比底与橙红粗线，标题一句就能顶满一屏。',
    bg: '#17161a',
    accent: '#ff4d1a',
    text: '#fdfdfd',
    secondary: '#a3a3a3',
    fontClass: 'display-sans',
    borderWidth: '12px',
    headingProfile: 'slide',
    headingUppercase: true,
    headingSizes: { h1: '34px', h2: '24px', h3: '19px' },
    density: 'normal',
    lineHeight: 1.6,
    radius: '0',
    listBullet: '■',
    listBulletSize: '14px',
    blockquoteStructure: 'full-box',
    blockquoteBg: 'rgba(255,255,255,0.06)',
    strongColor: 'accent',
    codeBorderColor: '#ff4d1a',
    imageShadow: 'strong',
  },
  cyber: {
    category: 'extend',
    desc: '深蓝夜空底与霓虹青色描边，标题自带赛博感的高对比。',
    bg: '#070b18',
    accent: '#12f7d6',
    text: '#f2f6ff',
    secondary: '#97a3b6',
    fontClass: 'display-sans',
    borderWidth: '5px',
    headingProfile: 'slide',
    density: 'normal',
    lineHeight: 1.7,
    radius: '2px',
    listBullet: '■',
    listBulletSize: '12px',
    blockquoteStructure: 'full-box',
    blockquoteBg: 'rgba(18,247,214,0.06)',
    strongColor: 'accent',
    codeBorderColor: '#12f7d6',
    codeBlockStructure: 'full-border',
    codeSpanText: '#12f7d6',
    imageShadow: 'strong',
  },
  voltage: {
    category: 'extend',
    desc: '电光蓝底配柠檬黄强调，像一张高饱和度的海报。',
    bg: '#0b3fd8',
    accent: '#e6ff2e',
    text: '#f4f8ff',
    secondary: '#dbe4ff',
    fontClass: 'display-sans',
    borderWidth: '7px',
    headingProfile: 'slide',
    headingUppercase: true,
    density: 'normal',
    lineHeight: 1.65,
    radius: '4px',
    listBullet: '■',
    listBulletSize: '13px',
    blockquoteStructure: 'full-box',
    blockquoteBg: 'rgba(255,255,255,0.10)',
    strongColor: 'accent',
    codeBorderColor: '#e6ff2e',
    imageShadow: 'strong',
  },
}

/** 内置样式（参数向量经派生后的完整样式定义） */
export const BUILTIN_STYLES: Record<string, StyleDefinition> = Object.fromEntries(
  Object.entries(BUILTIN_PARAMS).map(([name, params]) => [name, resolveStyleParams(params)]),
)

/** 内置样式的**声明参数**（用于克隆：`styles new` 与样式采样） */
export function builtinStyleParams(name: string): StyleParams | undefined {
  const seed = BUILTIN_PARAMS[name]
  return seed ? { ...seed } : undefined
}

/** 内置样式名（保持声明顺序） */
export function builtinStyleNames(): string[] {
  return Object.keys(BUILTIN_PARAMS)
}
