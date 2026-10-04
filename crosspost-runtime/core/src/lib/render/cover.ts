/**
 * 封面生成（v2 重构，2026-08-27）
 *
 * 删除旧的"文章样式专属装饰"体系（drawDecorations / buildCoverSvg），
 * 仅保留 13 款独立封面模板（COVER_TEMPLATES）：
 *   V4：nebula 星云 / orb3d 3D球 / aurora 极光 / particles 粒子 / glasscard 玻璃卡 / spectrum 频谱
 *   V5：bokeh 光斑 / cyber 霓虹 / skyline 天际线 / mountains 山峦 / bignum 大数字 / iridescent 虹彩 / minimal 极简留白
 *
 * 全部本地 SVG → sharp 栅格化 PNG，纯程序化生成：
 * 无任何外部图片素材、无 API 费用、字体用系统字体（PingFang SC / Noto Sans CJK 等）→ 免费且无版权问题。
 * 模板与文章样式（styles.ts / custom.ts 的 10+55 样式）完全解耦，不影响正文渲染。
 */
import sharp from 'sharp'

export type CoverRatio = '2_35_1' | '1_1'

/** 画布基准尺寸（2026-08-28 D1 常量层；各模板坐标/字号保持设计值） */
export const BASE_W = 900
export const BASE_H = 383

export const COVER_TEMPLATE_NAMES = [
  'nebula',
  'orb3d',
  'aurora',
  'particles',
  'glasscard',
  'spectrum',
  'bokeh',
  'cyber',
  'skyline',
  'mountains',
  'bignum',
  'iridescent',
  'minimal',
] as const
export type CoverTemplate = (typeof COVER_TEMPLATE_NAMES)[number]

export interface CoverOptions {
  title: string
  template?: CoverTemplate
  ratio?: CoverRatio
  width?: number
  outPath?: string
  fontFamily?: string
  /** 副标题（可选，空则不渲染） */
  subtitle?: string
  /** 栏目角标（可选，空则不渲染） */
  tag?: string
  /** 日期（默认当天 Asia/Shanghai） */
  date?: string
}

export interface CoverResult {
  ok: boolean
  path?: string
  error?: string
  png?: Buffer
  width?: number
  height?: number
}

interface Ctx {
  W: number
  H: number
  title: string
  subtitle: string
  tag: string
  date: string
  fontFamily: string
}

// ── 工具 ────────────────────────────────────────────────────────────────

const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 文本宽度估算：CJK/全角=1×f，ASCII=0.55×f，空格=0.3×f */
function mw(s: string, f: number): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) || 0
    if (c >= 0x2e80) w += f
    else if (ch === ' ') w += f * 0.3
    else w += f * 0.55
  }
  return w
}

/** 字符级换行（CJK 友好） */
function wrap(s: string, f: number, maxW: number): string[] {
  const lines: string[] = []
  for (const para of s.split('\n')) {
    let cur = ''
    for (const ch of para) {
      if (mw(cur + ch, f) <= maxW) cur += ch
      else {
        if (cur) lines.push(cur)
        cur = ch
      }
    }
    if (cur) lines.push(cur)
  }
  return lines.length ? lines : ['']
}

/** 字号自适应：从 start 递减至 2 行以内 */
function fit(
  title: string,
  start: number,
  maxW: number,
  maxLines = 2,
): { f: number; lines: string[] } {
  for (let f = start; f >= 26; f -= 2) {
    const lines = wrap(title, f, maxW)
    if (lines.length <= maxLines) return { f, lines }
  }
  return { f: 26, lines: wrap(title, 26, maxW) }
}

/** 可读性兜底：浅色文字自动加半透明黑描边，深色/金色文字不描边 */
function outlined(
  x: number,
  y: number,
  size: number,
  fill: string,
  text: string,
  opts = '',
): string {
  const dark = /#(111111|1a1a1a|0d1b2e|1f2937|0f172a|0b1220)/i.test(fill)
  const stroke = dark
    ? ''
    : 'paint-order="stroke" stroke="#000000" stroke-width="4" stroke-opacity="0.35"'
  return `<text x="${x}" y="${y}" font-family="PingFang SC, sans-serif" font-size="${size}" font-weight="bold" fill="${fill}" ${stroke} ${opts}>${esc(text)}</text>`
}

/** 五角星 polygon points */
function starPath(cx: number, cy: number, R: number, r: number): string {
  const pts: string[] = []
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : r
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`)
  }
  return pts.join(' ')
}

/** 可复现随机（seeded） */
function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/** 当天日期 YYYY.MM.DD（Asia/Shanghai） */
export function fmtToday(): string {
  const s = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return s.replace(/\//g, '.')
}

/** 标题块：标题（fit 换行）+ 可选副标题 */
function titleBlock(
  c: Ctx,
  x: number,
  startY: number,
  maxW: number,
  startSize: number,
  fill = '#ffffff',
) {
  const { f, lines } = fit(c.title, startSize, maxW)
  const els: string[] = []
  let y = startY
  for (const ln of lines) {
    els.push(outlined(x, y, f, fill, ln))
    y += f * 1.28
  }
  if (c.subtitle) {
    els.push(
      `<text x="${x}" y="${y + 10}" font-family="PingFang SC, sans-serif" font-size="19" fill="#c8cdd6">${esc(c.subtitle)}</text>`,
    )
  }
  return els
}

function tagEl(c: Ctx, x: number, y: number, fill: string): string {
  return c.tag
    ? `<text x="${x}" y="${y}" font-family="PingFang SC, sans-serif" font-size="15" fill="${fill}">${esc(c.tag)}</text>`
    : ''
}

function dateEl(c: Ctx, fill: string): string {
  return `<text x="${c.W - 70}" y="${c.H - 26}" font-family="PingFang SC, sans-serif" font-size="13" fill="${fill}" text-anchor="end">${esc(c.date)}</text>`
}

function svgWrap(els: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BASE_W}" height="${BASE_H}" viewBox="0 0 ${BASE_W} ${BASE_H}">${els.join('')}</svg>`
}

/** 各模板主背景色（1:1 缩略图上下留白填充） */
const TEMPLATE_BG: Record<CoverTemplate, string> = {
  nebula: '#1e1b4b',
  orb3d: '#0a0f1c',
  aurora: '#050b14',
  particles: '#060a14',
  glasscard: '#ede9fe',
  spectrum: '#0b0f19',
  bokeh: '#1e3a8a',
  cyber: '#0b0d17',
  skyline: '#7c3aed',
  mountains: '#4c1d95',
  bignum: '#0b1220',
  iridescent: '#0a0a14',
  minimal: '#faf9f7',
}

// ── 13 款模板 ───────────────────────────────────────────────────────────

const COVER_TEMPLATES: Record<CoverTemplate, (c: Ctx) => string> = {
  // 15 星云
  nebula(c) {
    const els: string[] = []
    els.push(`<defs>
      <filter id="n15"><feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves="5"/>
        <feColorMatrix values="0 0 0 0 0.45 0 0 0 0 0.20 0 0 0 0 0.65 0 0 0 0.85 0"/></filter>
      <filter id="g15"><feGaussianBlur stdDeviation="18"/></filter>
      <radialGradient id="b15" cx="25%" cy="20%" r="110%">
        <stop offset="0%" stop-color="#4c1d95"/><stop offset="55%" stop-color="#1e1b4b"/><stop offset="100%" stop-color="#020617"/></radialGradient></defs>`)
    els.push(`<rect width="${c.W}" height="${c.H}" fill="url(#b15)"/>`)
    els.push(`<rect width="${c.W}" height="${c.H}" filter="url(#n15)" opacity="0.55"/>`)
    els.push(`<circle cx="690" cy="150" r="90" fill="#7c3aed" opacity="0.35" filter="url(#g15)"/>`)
    els.push(`<circle cx="200" cy="70" r="60" fill="#22d3ee" opacity="0.22" filter="url(#g15)"/>`)
    const r = rng(42)
    for (let i = 0; i < 46; i++) {
      const sx = Math.round(r() * c.W),
        sy = Math.round(r() * c.H * 0.75),
        rr = r() * 1.6 + 0.4
      els.push(
        `<circle cx="${sx}" cy="${sy}" r="${rr.toFixed(1)}" fill="#ffffff" opacity="${(0.35 + r() * 0.55).toFixed(2)}"/>`,
      )
    }
    els.push(tagEl(c, 70, 72, '#a78bfa'))
    els.push(...titleBlock(c, 70, 220, c.W - 140, 46))
    els.push(dateEl(c, '#6366f1'))
    return svgWrap(els)
  },

  // 16 3D 渐变球
  orb3d(c) {
    const els: string[] = []
    els.push(`<rect width="${c.W}" height="${c.H}" fill="#0a0f1c"/>`)
    els.push(`<defs>
      <radialGradient id="a16" cx="32%" cy="26%" r="85%"><stop offset="0%" stop-color="#fde68a"/><stop offset="45%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#b45309"/></radialGradient>
      <radialGradient id="b16" cx="32%" cy="26%" r="85%"><stop offset="0%" stop-color="#67e8f9"/><stop offset="50%" stop-color="#0891b2"/><stop offset="100%" stop-color="#164e63"/></radialGradient>
      <radialGradient id="c16" cx="32%" cy="26%" r="85%"><stop offset="0%" stop-color="#e9d5ff"/><stop offset="50%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#4c1d95"/></radialGradient></defs>`)
    els.push(`<circle cx="700" cy="150" r="130" fill="url(#a16)"/>`)
    els.push(
      `<ellipse cx="652" cy="100" rx="42" ry="24" fill="#ffffff" opacity="0.35" transform="rotate(-28 652 100)"/>`,
    )
    els.push(`<circle cx="560" cy="310" r="80" fill="url(#b16)"/>`)
    els.push(
      `<ellipse cx="528" cy="278" rx="26" ry="15" fill="#ffffff" opacity="0.35" transform="rotate(-28 528 278)"/>`,
    )
    els.push(`<circle cx="812" cy="300" r="55" fill="url(#c16)"/>`)
    els.push(
      `<ellipse cx="792" cy="280" rx="17" ry="10" fill="#ffffff" opacity="0.35" transform="rotate(-28 792 280)"/>`,
    )
    els.push(`<circle cx="470" cy="120" r="7" fill="#67e8f9"/>`)
    els.push(`<circle cx="856" cy="120" r="4" fill="#fde68a"/>`)
    els.push(tagEl(c, 70, 72, '#9ca3af'))
    els.push(...titleBlock(c, 70, 205, 380, 44))
    els.push(dateEl(c, '#4b5563'))
    return svgWrap(els)
  },

  // 17 极光
  aurora(c) {
    const els: string[] = []
    els.push(`<rect width="${c.W}" height="${c.H}" fill="#050b14"/>`)
    els.push(`<defs>
      <filter id="g17" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="26"/></filter>
      <linearGradient id="a17" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#22d3ee" stop-opacity="0"/><stop offset="35%" stop-color="#22d3ee" stop-opacity="0.85"/><stop offset="70%" stop-color="#8b5cf6" stop-opacity="0.6"/><stop offset="100%" stop-color="#8b5cf6" stop-opacity="0"/></linearGradient></defs>`)
    els.push(
      `<path d="M-40,150 C 180,90 340,190 520,140 S 820,90 940,140" fill="none" stroke="url(#a17)" stroke-width="34" filter="url(#g17)" opacity="0.75"/>`,
    )
    els.push(
      `<path d="M-40,200 C 200,150 380,240 560,190 S 840,150 940,195" fill="none" stroke="url(#a17)" stroke-width="22" filter="url(#g17)" opacity="0.5"/>`,
    )
    els.push(tagEl(c, 70, 72, '#64748b'))
    els.push(...titleBlock(c, 70, 250, c.W - 140, 46))
    els.push(dateEl(c, '#334155'))
    return svgWrap(els)
  },

  // 18 上升粒子
  particles(c) {
    const els: string[] = []
    els.push(`<rect width="${c.W}" height="${c.H}" fill="#060a14"/>`)
    els.push(`<defs><filter id="g18"><feGaussianBlur stdDeviation="10"/></filter>
      <radialGradient id="b18" cx="50%" cy="110%" r="90%"><stop offset="0%" stop-color="#0ea5e9" stop-opacity="0.35"/><stop offset="100%" stop-color="#060a14" stop-opacity="0"/></radialGradient></defs>`)
    els.push(`<rect width="${c.W}" height="${c.H}" fill="url(#b18)"/>`)
    const r = rng(7)
    for (let i = 0; i < 120; i++) {
      const sx = Math.round(r() * c.W),
        sy = Math.round(r() * c.H),
        rr = r() * 2.4 + 0.5
      const glow = r() > 0.88
      if (glow)
        els.push(
          `<circle cx="${sx}" cy="${sy}" r="${(rr + 6).toFixed(1)}" fill="#38bdf8" opacity="0.12" filter="url(#g18)"/>`,
        )
      els.push(
        `<circle cx="${sx}" cy="${sy}" r="${rr.toFixed(1)}" fill="${glow ? '#7dd3fc' : '#e0f2fe'}" opacity="${(0.3 + r() * 0.6).toFixed(2)}"/>`,
      )
    }
    els.push(tagEl(c, 70, 72, '#7c8ba1'))
    els.push(...titleBlock(c, 70, 230, c.W - 140, 46))
    els.push(dateEl(c, '#334155'))
    return svgWrap(els)
  },

  // 19 玻璃卡
  glasscard(c) {
    const els: string[] = []
    els.push(`<defs>
      <linearGradient id="b19" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#dbeafe"/><stop offset="50%" stop-color="#ede9fe"/><stop offset="100%" stop-color="#fce7f3"/></linearGradient>
      <filter id="g19"><feGaussianBlur stdDeviation="14"/></filter></defs>`)
    els.push(`<rect width="${c.W}" height="${c.H}" fill="url(#b19)"/>`)
    els.push(`<circle cx="140" cy="80" r="70" fill="#60a5fa" opacity="0.4" filter="url(#g19)"/>`)
    els.push(`<circle cx="820" cy="330" r="90" fill="#c084fc" opacity="0.4" filter="url(#g19)"/>`)
    els.push(`<circle cx="760" cy="60" r="40" fill="#f472b6" opacity="0.35" filter="url(#g19)"/>`)
    els.push(
      `<rect x="80" y="92" width="${c.W - 160}" height="232" rx="22" fill="#ffffff" opacity="0.55"/>`,
    )
    els.push(
      `<rect x="80" y="92" width="${c.W - 160}" height="232" rx="22" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.9"/>`,
    )
    if (c.tag)
      els.push(
        `<text x="${c.W / 2}" y="132" font-family="PingFang SC, sans-serif" font-size="15" fill="#6b7280" text-anchor="middle">${esc(c.tag)}</text>`,
      )
    const { f, lines } = fit(c.title, 44, c.W - 220, 2)
    let y = 200
    for (const ln of lines) {
      els.push(outlined(c.W / 2, y, f, '#1f2937', ln, 'text-anchor="middle"'))
      y += f * 1.26
    }
    if (c.subtitle)
      els.push(
        `<text x="${c.W / 2}" y="${y + 8}" font-family="PingFang SC, sans-serif" font-size="18" fill="#4b5563" text-anchor="middle">${esc(c.subtitle)}</text>`,
      )
    els.push(dateEl(c, '#9ca3af'))
    return svgWrap(els)
  },

  // 20 霓虹频谱
  spectrum(c) {
    const els: string[] = []
    els.push(`<rect width="${c.W}" height="${c.H}" fill="#0b0f19"/>`)
    const bars = [46, 96, 60, 128, 74, 150, 88, 118, 56, 104, 70, 92]
    const cols = ['#22d3ee', '#818cf8', '#a78bfa', '#f472b6', '#fbbf24', '#34d399']
    bars.forEach((h, i) => {
      const x = 110 + i * 58,
        col = cols[i % cols.length]
      els.push(
        `<rect x="${x}" y="${c.H - 34 - h}" width="34" height="${h}" rx="6" fill="${col}" opacity="0.85"/>`,
      )
      els.push(
        `<rect x="${x}" y="${c.H - 34 - h}" width="34" height="5" rx="3" fill="#ffffff" opacity="0.8"/>`,
      )
    })
    els.push(
      `<rect x="90" y="${c.H - 34}" width="${c.W - 180}" height="3" rx="1.5" fill="#ffffff" opacity="0.18"/>`,
    )
    els.push(tagEl(c, 70, 72, '#64748b'))
    els.push(...titleBlock(c, 70, 190, c.W - 140, 46))
    els.push(dateEl(c, '#334155'))
    return svgWrap(els)
  },

  // 21 Bokeh 光斑
  bokeh(c) {
    const els: string[] = []
    els.push(`<defs><filter id="b21" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10"/></filter>
      <radialGradient id="bg21" cx="30%" cy="25%" r="110%"><stop offset="0%" stop-color="#1e3a8a"/><stop offset="100%" stop-color="#020617"/></radialGradient></defs>`)
    els.push(`<rect width="${c.W}" height="${c.H}" fill="url(#bg21)"/>`)
    const r = rng(21)
    const colors = ['#60a5fa', '#c084fc', '#f472b6', '#22d3ee', '#fbbf24', '#ffffff']
    for (let i = 0; i < 30; i++) {
      const sx = Math.round(r() * c.W),
        sy = Math.round(r() * c.H * 0.8 + 20)
      const rr = 8 + r() * 34
      const col = colors[Math.floor(r() * colors.length)]
      const op = (0.08 + r() * 0.2).toFixed(2)
      if (i % 4 === 0)
        els.push(
          `<circle cx="${sx}" cy="${sy}" r="${rr}" fill="${col}" opacity="${op}" filter="url(#b21)"/>`,
        )
      else els.push(`<circle cx="${sx}" cy="${sy}" r="${rr}" fill="${col}" opacity="${op}"/>`)
    }
    for (let i = 0; i < 10; i++)
      els.push(
        `<circle cx="${Math.round(r() * c.W)}" cy="${Math.round(r() * c.H * 0.7)}" r="${(1 + r() * 2).toFixed(1)}" fill="#ffffff" opacity="0.5"/>`,
      )
    els.push(tagEl(c, 70, 72, '#93c5fd'))
    els.push(...titleBlock(c, 70, 230, c.W - 140, 46))
    els.push(dateEl(c, '#3b5b92'))
    return svgWrap(els)
  },

  // 22 赛博霓虹
  cyber(c) {
    const els: string[] = []
    els.push(`<rect width="${c.W}" height="${c.H}" fill="#0b0d17"/>`)
    els.push(
      `<defs><linearGradient id="g22" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#22d3ee"/><stop offset="100%" stop-color="#e879f9"/></linearGradient></defs>`,
    )
    for (let i = 0; i <= 9; i++)
      els.push(
        `<line x1="0" y1="${c.H - 40 - i * 34}" x2="${c.W}" y2="${c.H - 40 - i * 34}" stroke="#22d3ee" stroke-width="1" opacity="${(0.1 + i * 0.03).toFixed(2)}"/>`,
      )
    for (let i = 0; i <= 12; i++)
      els.push(
        `<line x1="${i * 75}" y1="${c.H - 40}" x2="${i * 75 + 70}" y2="${c.H - 346}" stroke="#e879f9" stroke-width="1" opacity="0.15"/>`,
      )
    els.push(
      `<line x1="0" y1="${c.H - 40}" x2="${c.W}" y2="${c.H - 40}" stroke="#22d3ee" stroke-width="2" opacity="0.8"/>`,
    )
    const { f, lines } = fit(c.title, 44, c.W - 140, 2)
    let y = 150
    for (const ln of lines) {
      els.push(
        `<text x="70" y="${y}" font-family="PingFang SC, sans-serif" font-size="${f}" font-weight="bold" fill="url(#g22)" stroke="url(#g22)" stroke-width="2" paint-order="stroke">${esc(ln)}</text>`,
      )
      els.push(
        `<text x="70" y="${y}" font-family="PingFang SC, sans-serif" font-size="${f}" font-weight="bold" fill="none" stroke="#22d3ee" stroke-width="10" stroke-opacity="0.22" opacity="0.8">${esc(ln)}</text>`,
      )
      y += f * 1.28
    }
    if (c.subtitle)
      els.push(
        `<text x="70" y="${y + 8}" font-family="PingFang SC, sans-serif" font-size="19" fill="#a5f3fc">${esc(c.subtitle)}</text>`,
      )
    els.push(tagEl(c, 70, 78, '#67e8f9'))
    els.push(dateEl(c, '#155e75'))
    return svgWrap(els)
  },

  // 23 城市天际线
  skyline(c) {
    const els: string[] = []
    els.push(`<defs><linearGradient id="sky23" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#312e81"/><stop offset="55%" stop-color="#7c3aed"/><stop offset="85%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#fb923c"/></linearGradient></defs>`)
    els.push(`<rect width="${c.W}" height="${c.H}" fill="url(#sky23)"/>`)
    els.push(`<circle cx="700" cy="230" r="42" fill="#fde68a"/>`)
    els.push(`<circle cx="700" cy="230" r="70" fill="#fde68a" opacity="0.3"/>`)
    const r = rng(23)
    const skylineY = 250
    const blds: Array<[number, number, number, number]> = []
    let bx = -10
    while (bx < c.W) {
      const bw = 40 + Math.round(r() * 60)
      const bh = 40 + Math.round(r() * 130)
      blds.push([bx, skylineY - bh, bw, bh])
      bx += bw + (4 + Math.round(r() * 10))
    }
    els.push(
      `<path d="${blds.map(([x, y, w, _h]) => `M${x},${skylineY} L${x},${y} L${x + w},${y} L${x + w},${skylineY}`).join(' ')} Z" fill="#0f172a"/>`,
    )
    for (const [x, y, w, h] of blds) {
      for (let wy = y + 10; wy < y + h - 8; wy += 16) {
        for (let wx = x + 6; wx < x + w - 10; wx += 12) {
          if (r() > 0.68)
            els.push(
              `<rect x="${wx}" y="${wy}" width="4" height="6" fill="#fde68a" opacity="${(0.5 + r() * 0.5).toFixed(2)}"/>`,
            )
        }
      }
    }
    els.push(
      `<rect x="0" y="${skylineY}" width="${c.W}" height="${c.H - skylineY}" fill="#0b1220"/>`,
    )
    els.push(
      `<line x1="0" y1="${skylineY}" x2="${c.W}" y2="${skylineY}" stroke="#fbbf24" stroke-width="2" opacity="0.7"/>`,
    )
    els.push(tagEl(c, 70, 72, '#ddd6fe'))
    els.push(...titleBlock(c, 70, 70, 460, 46, '#ffffff'))
    els.push(dateEl(c, '#8b7bbd'))
    return svgWrap(els)
  },

  // 24 山峦日出
  mountains(c) {
    const els: string[] = []
    els.push(`<defs><linearGradient id="sky24" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e1b4b"/><stop offset="50%" stop-color="#4c1d95"/><stop offset="80%" stop-color="#be185d"/><stop offset="100%" stop-color="#f97316"/></linearGradient></defs>`)
    els.push(`<rect width="${c.W}" height="${c.H}" fill="url(#sky24)"/>`)
    els.push(`<circle cx="240" cy="250" r="46" fill="#fed7aa"/>`)
    els.push(`<circle cx="240" cy="250" r="80" fill="#fb923c" opacity="0.35"/>`)
    els.push(`<circle cx="240" cy="250" r="130" fill="#f97316" opacity="0.18"/>`)
    els.push(
      `<path d="M0,300 L120,210 L260,285 L420,190 L580,280 L740,205 L900,290 L900,383 L0,383 Z" fill="#312e81" opacity="0.85"/>`,
    )
    els.push(
      `<path d="M0,330 L160,260 L330,320 L520,240 L700,315 L900,262 L900,383 L0,383 Z" fill="#1e1b4b"/>`,
    )
    els.push(
      `<path d="M0,365 L200,305 L420,352 L640,296 L900,352 L900,383 L0,383 Z" fill="#0f0a1e"/>`,
    )
    els.push(tagEl(c, 70, 72, '#fbcfe8'))
    els.push(...titleBlock(c, 70, 90, 460, 46, '#ffffff'))
    els.push(dateEl(c, '#9d6b9d'))
    return svgWrap(els)
  },

  // 25 大数字海报
  bignum(c) {
    const els: string[] = []
    els.push(`<rect width="${c.W}" height="${c.H}" fill="#0b1220"/>`)
    els.push(
      `<defs><linearGradient id="n25" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#67e8f9"/><stop offset="100%" stop-color="#2563eb"/></linearGradient></defs>`,
    )
    // 从标题提取第一个数字（如"5 个必知参数"→ 5）；无数字则用 ★
    const numMatch = /\d+/.exec(c.title)
    const num = numMatch ? numMatch[0] : '★'
    els.push(
      `<text x="150" y="330" font-family="PingFang SC, sans-serif" font-size="330" font-weight="bold" fill="url(#n25)" opacity="0.95" text-anchor="middle">${esc(num)}</text>`,
    )
    els.push(
      `<text x="150" y="330" font-family="PingFang SC, sans-serif" font-size="330" font-weight="bold" fill="none" stroke="#22d3ee" stroke-width="3" stroke-opacity="0.5" text-anchor="middle">${esc(num)}</text>`,
    )
    els.push(`<circle cx="150" cy="120" r="4" fill="#67e8f9"/>`)
    els.push(`<circle cx="60" cy="260" r="3" fill="#818cf8"/>`)
    els.push(`<circle cx="280" cy="90" r="2.5" fill="#ffffff" opacity="0.7"/>`)
    const { f, lines } = fit(c.title, 40, 400, 2)
    let y = 150
    for (const ln of lines) {
      els.push(outlined(330, y, f, '#ffffff', ln))
      y += f * 1.26
    }
    if (c.subtitle)
      els.push(
        `<text x="330" y="${y + 6}" font-family="PingFang SC, sans-serif" font-size="17" fill="#8b9bb4">${esc(c.subtitle)}</text>`,
      )
    if (c.tag)
      els.push(
        `<text x="330" y="66" font-family="PingFang SC, sans-serif" font-size="14" fill="#64748b">${esc(c.tag)}</text>`,
      )
    els.push(dateEl(c, '#334155'))
    return svgWrap(els)
  },

  // 极简留白（点线 + 红星，2026-08-27）
  minimal(c) {
    const els: string[] = []
    els.push(`<rect width="${c.W}" height="${c.H}" fill="#faf9f7"/>`)
    const dot = (y: number, op: number): string => {
      let s = ''
      for (let x = 70; x < c.W - 40; x += 26)
        s += `<circle cx="${x}" cy="${y}" r="3" fill="#c41e3a" opacity="${op}"/>`
      return s
    }
    els.push(dot(44, 0.85))
    els.push(dot(c.H - 44, 0.45))
    if (c.tag)
      els.push(
        `<text x="70" y="80" font-family="PingFang SC, sans-serif" font-size="15" fill="#999999">${esc(c.tag)}</text>`,
      )
    els.push(`<polygon points="${starPath(c.W / 2, 130, 15, 6.2)}" fill="#c41e3a"/>`)
    const { f, lines } = fit(c.title, 46, c.W - 160, 2)
    let y = 196
    for (const ln of lines) {
      els.push(
        `<text x="${c.W / 2}" y="${y}" font-family="PingFang SC, sans-serif" font-size="${f}" font-weight="bold" fill="#1a1a1a" text-anchor="middle">${esc(ln)}</text>`,
      )
      y += f * 1.3
    }
    if (c.subtitle)
      els.push(
        `<text x="${c.W / 2}" y="${y + 12}" font-family="PingFang SC, sans-serif" font-size="19" fill="#666666" text-anchor="middle">${esc(c.subtitle)}</text>`,
      )
    els.push(dateEl(c, '#aaaaaa'))
    return svgWrap(els)
  },

  // 26 虹彩液体
  iridescent(c) {
    const els: string[] = []
    els.push(`<rect width="${c.W}" height="${c.H}" fill="#0a0a14"/>`)
    els.push(`<defs>
      <linearGradient id="r26" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#f472b6"/><stop offset="30%" stop-color="#a78bfa"/><stop offset="60%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#34d399"/></linearGradient>
      <radialGradient id="o26" cx="35%" cy="28%" r="85%"><stop offset="0%" stop-color="#ffffff"/><stop offset="25%" stop-color="#f0abfc"/><stop offset="70%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#312e81"/></radialGradient>
      <filter id="b26" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="16"/></filter></defs>`)
    els.push(`<circle cx="690" cy="150" r="120" fill="url(#o26)"/>`)
    els.push(
      `<ellipse cx="642" cy="102" rx="36" ry="20" fill="#ffffff" opacity="0.4" transform="rotate(-28 642 102)"/>`,
    )
    els.push(
      `<path d="M-40,320 C 160,270 300,350 480,300 S 760,270 940,310" fill="none" stroke="url(#r26)" stroke-width="22" filter="url(#b26)" opacity="0.8"/>`,
    )
    els.push(
      `<path d="M-40,348 C 180,306 340,372 520,330 S 800,300 940,340" fill="none" stroke="url(#r26)" stroke-width="12" opacity="0.5"/>`,
    )
    els.push(tagEl(c, 70, 72, '#9ca3af'))
    els.push(...titleBlock(c, 70, 200, 400, 44))
    els.push(dateEl(c, '#4b5563'))
    return svgWrap(els)
  },
}

// ── 主入口 ──────────────────────────────────────────────────────────────

/** 生成封面 PNG（2.35:1 或 1:1），返回 buffer，可选写盘。
 *  模板以 900×383 为基准设计；1:1 时横版内容垂直居中、上下以模板主背景色填充。 */
export async function generateCover(options: CoverOptions): Promise<CoverResult> {
  try {
    const template: CoverTemplate = options.template || 'nebula'
    const fn = COVER_TEMPLATES[template]
    if (!fn)
      return {
        ok: false,
        error: `未知封面模板: ${template}（可选：${COVER_TEMPLATE_NAMES.join('/')}）`,
      }
    const ratio: CoverRatio = options.ratio || '2_35_1'
    const W = options.width || BASE_W
    const H = ratio === '1_1' ? W : Math.round((W * BASE_H) / BASE_W)

    const ctx: Ctx = {
      W: BASE_W,
      H: BASE_H,
      title: options.title || '',
      subtitle: options.subtitle || '',
      tag: options.tag || '',
      date: options.date || fmtToday(),
      fontFamily:
        options.fontFamily ||
        'PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, sans-serif',
    }
    const content = fn(ctx)
    let svg: string
    if (ratio === '1_1') {
      const inner = content.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')
      svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${BASE_W}" height="${BASE_W}" viewBox="0 0 ${BASE_W} ${BASE_W}">` +
        `<rect width="${BASE_W}" height="${BASE_W}" fill="${TEMPLATE_BG[template]}"/>` +
        `<g transform="translate(0,258.5)">${inner}</g></svg>`
    } else {
      svg = content
    }

    let img = sharp(Buffer.from(svg)).png()
    if (W !== BASE_W) img = img.resize({ width: W })
    const png = await img.toBuffer()

    const result: CoverResult = { ok: true, png, width: W, height: H }
    if (options.outPath) {
      const fs = await import('node:fs')
      const path = await import('node:path')
      fs.mkdirSync(path.dirname(options.outPath), { recursive: true })
      fs.writeFileSync(options.outPath, png)
      result.path = options.outPath
    }
    return result
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) }
  }
}

/** 生成双尺寸封面（主图 + 缩略） */
export async function generateCoverSet(options: CoverOptions & { outDir: string }): Promise<{
  cover2_35_1: CoverResult
  cover1_1: CoverResult
}> {
  const main = await generateCover({
    ...options,
    ratio: '2_35_1',
    outPath: `${options.outDir}/cover_2_35_1.png`,
  })
  let square: CoverResult = { ok: true, path: undefined }
  if (options.template !== 'minimal') {
    // minimal 无 1:1 变体（2026-08-27 用户确认无用）
    square = await generateCover({
      ...options,
      ratio: '1_1',
      outPath: `${options.outDir}/cover_1_1.png`,
    })
  }
  return { cover2_35_1: main, cover1_1: square }
}

/** 生成 13 款模板画廊拼图（3 列），供选款预览 */
export async function generateCoverGallery(options: CoverOptions & { outDir: string }): Promise<{
  ok: boolean
  path?: string
  error?: string
}> {
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')
    fs.mkdirSync(options.outDir, { recursive: true })
    const W = 900
    const H = Math.round((W * 383) / 900)
    const cols = 3
    const rows = Math.ceil(COVER_TEMPLATE_NAMES.length / cols)
    const cellW = W,
      cellH = H

    const layers: Array<{ input: Buffer; top: number; left: number }> = []
    for (let i = 0; i < COVER_TEMPLATE_NAMES.length; i++) {
      const r = await generateCover({
        ...options,
        template: COVER_TEMPLATE_NAMES[i],
        ratio: '2_35_1',
        width: W,
      })
      if (r.ok && r.png) {
        layers.push({ input: r.png, top: Math.floor(i / cols) * cellH, left: (i % cols) * cellW })
      }
    }
    const grid = await sharp({
      create: { width: cellW * cols, height: cellH * rows, channels: 3, background: '#101014' },
    })
      .composite(layers)
      .png()
      .toBuffer()
    const out = path.join(options.outDir, 'cover-gallery.png')
    fs.writeFileSync(out, grid)
    return { ok: true, path: out }
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) }
  }
}
