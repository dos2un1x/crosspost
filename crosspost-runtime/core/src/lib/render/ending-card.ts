/**
 * 结尾结束语图片（2026-08-27 重构）
 *
 * 与封面 13 款模板视觉呼应：选择封面 template 后，结束语图片复用同款背景语言
 * （星云/3D球/极光/粒子/玻璃卡/频谱/光斑/霓虹/天际线/山峦/大星/虹彩），首尾一致。
 *
 * 尺寸 1080×360（width 等比缩放）；单行话术（字号自适应不换行）；
 * 全部本地 SVG → sharp 栅格化，零素材、零 API、系统字体 → 免费且无版权。
 */
import sharp from 'sharp'
import type { CoverTemplate } from './cover'

export interface EndingCardOptions {
  /** 话术（默认已确认的拟人化精简版） */
  text?: string
  /** 封面模板（决定视觉语言，默认 nebula） */
  template?: CoverTemplate
  width?: number
  outPath?: string
}

export interface EndingCardResult {
  ok: boolean
  path?: string
  error?: string
  png?: Buffer
  width?: number
  height?: number
}

/** 默认话术（拟人化精简版，单行） */
const DEFAULT_TEXT = '⭐ 关注我，每天陪你聪明看世界 ➡️ 看懂热搜,玩懂AI。⭐'

const BASE_W = 1080
const BASE_H = 360

const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const EMOJI_CHARS = '⭐➡️'
const isEmoji = (ch: string): boolean => EMOJI_CHARS.includes(ch)

/** 字符宽度：emoji=1.1×f，CJK=1×f，ASCII=0.55×f，空格=0.3×f */
function glyphW(ch: string, f: number): number {
  if (isEmoji(ch)) return f * 1.1
  const c = ch.codePointAt(0) || 0
  if (c >= 0x2e80) return f
  if (ch === ' ') return f * 0.3
  return f * 0.55
}

/** 文本宽度估算（含 emoji） */
function mw(s: string, f: number): number {
  let w = 0
  for (const ch of s) w += glyphW(ch, f)
  return w
}

/** 单行字号自适应（保证一行放下） */
function fit1(text: string, start: number, maxW: number): number {
  for (let f = start; f >= 18; f -= 1) {
    if (mw(text, f) <= maxW) return f
  }
  return 18
}

interface SegStyle {
  fill: string
  anchor?: 'start' | 'middle'
  fontFamily?: string
  stroke?: string
  strokeWidth?: number
  strokeOpacity?: number
  letterSpacing?: number
}

/**
 * 分段渲染文本：普通字符 → <text>；emoji（⭐/➡️）→ 自绘 SVG 图形（librsvg 对彩色 emoji 不可靠）。
 * 按文本流定位（anchor=middle 时整体居中），返回行尾 x。
 */
function appendTextSegments(
  els: string[],
  x0: number,
  y: number,
  f: number,
  text: string,
  st: SegStyle,
): number {
  const total = mw(text, f)
  let x = st.anchor === 'middle' ? x0 - total / 2 : x0
  let buf = ''
  const flush = () => {
    if (!buf) return
    const attrs = [
      `x="${x.toFixed(1)}"`,
      `y="${y}"`,
      `font-family="${st.fontFamily || 'PingFang SC, sans-serif'}"`,
      `font-size="${f}"`,
      `font-weight="bold"`,
      `fill="${st.fill}"`,
      `text-anchor="start"`,
    ]
    if (st.letterSpacing) attrs.push(`letter-spacing="${st.letterSpacing}"`)
    if (st.stroke)
      attrs.push(
        `paint-order="stroke" stroke="${st.stroke}" stroke-width="${st.strokeWidth || 4}" stroke-opacity="${st.strokeOpacity ?? 0.3}"`,
      )
    els.push(`<text ${attrs.join(' ')}>${esc(buf)}</text>`)
    x += mw(buf, f)
    buf = ''
  }
  for (const ch of text) {
    if (isEmoji(ch)) {
      flush()
      const gy = y - f * 0.35
      if (ch === '⭐') {
        const R = f * 0.55
        els.push(
          `<polygon points="${starPath(x + R, gy, R, R * 0.42)}" fill="#fbbf24" stroke="#ffffff" stroke-width="1.5"/>`,
        )
      } else if (ch === '➡️') {
        const w2 = f * 0.8,
          h2 = f * 0.5
        els.push(
          `<polygon points="${x},${(gy - h2 / 2).toFixed(1)} ${(x + w2).toFixed(1)},${(gy - h2 / 2).toFixed(1)} ${(x + w2).toFixed(1)},${(gy - h2).toFixed(1)} ${(x + w2 + h2).toFixed(1)},${gy} ${(x + w2).toFixed(1)},${(gy + h2).toFixed(1)} ${(x + w2).toFixed(1)},${(gy + h2 / 2).toFixed(1)} ${x},${(gy + h2 / 2).toFixed(1)}" fill="${st.fill}"/>`,
        )
      }
      x += glyphW(ch, f)
    } else buf += ch
  }
  flush()
  return x
}

/** 白字分段（默认描边兜底） */
function whiteSegments(
  els: string[],
  x: number,
  y: number,
  f: number,
  text: string,
  anchor: 'start' | 'middle' = 'middle',
): void {
  appendTextSegments(els, x, y, f, text, {
    fill: '#ffffff',
    anchor,
    stroke: '#000000',
    letterSpacing: 0.5,
  })
}

/** 五角星 path */
function starPath(cx: number, cy: number, R: number, r: number): string {
  const pts: string[] = []
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : r
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`)
  }
  return pts.join(' ')
}

const star = (cx: number, cy: number, R: number, r: number, fill: string, op = 1): string =>
  `<polygon points="${starPath(cx, cy, R, r)}" fill="${fill}" opacity="${op}"/>`

/** 可复现随机 */
function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

type BgFn = (W: number, H: number, text: string, f: number) => string[]

// ── 13 款背景（与封面同款视觉语言，压缩到 1080×360） ─────────────────────

const ENDING_BG: Record<CoverTemplate, BgFn> = {
  // 星云
  nebula(W, H, text, f) {
    const els: string[] = []
    els.push(`<defs><filter id="n1"><feTurbulence type="fractalNoise" baseFrequency="0.01" numOctaves="5"/>
      <feColorMatrix values="0 0 0 0 0.45 0 0 0 0 0.20 0 0 0 0 0.65 0 0 0 0.85 0"/></filter>
      <filter id="g1"><feGaussianBlur stdDeviation="16"/></filter>
      <radialGradient id="b1" cx="25%" cy="20%" r="110%"><stop offset="0%" stop-color="#4c1d95"/><stop offset="100%" stop-color="#020617"/></radialGradient></defs>`)
    els.push(`<rect width="${W}" height="${H}" fill="url(#b1)"/>`)
    els.push(`<rect width="${W}" height="${H}" filter="url(#n1)" opacity="0.55"/>`)
    els.push(
      `<circle cx="${W - 220}" cy="110" r="80" fill="#7c3aed" opacity="0.35" filter="url(#g1)"/>`,
    )
    els.push(
      `<circle cx="220" cy="${H - 60}" r="55" fill="#22d3ee" opacity="0.2" filter="url(#g1)"/>`,
    )
    const r = rng(42)
    for (let i = 0; i < 40; i++)
      els.push(
        `<circle cx="${Math.round(r() * W)}" cy="${Math.round(r() * H * 0.8)}" r="${(r() * 1.5 + 0.4).toFixed(1)}" fill="#ffffff" opacity="${(0.35 + r() * 0.5).toFixed(2)}"/>`,
      )
    whiteSegments(els, W / 2, H / 2 + f * 0.36, f, text)
    els.push(
      `<line x1="${W / 2 - 70}" y1="${H - 52}" x2="${W / 2 + 70}" y2="${H - 52}" stroke="#a78bfa" stroke-width="1.5" opacity="0.6"/>`,
    )
    els.push(star(W / 2, H - 28, 12, 5, '#a78bfa'))
    return els
  },
  // 3D 渐变球
  orb3d(W, H, text, f) {
    const els: string[] = []
    els.push(`<rect width="${W}" height="${H}" fill="#0a0f1c"/>`)
    els.push(`<defs>
      <radialGradient id="oa" cx="32%" cy="26%" r="85%"><stop offset="0%" stop-color="#fde68a"/><stop offset="45%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#b45309"/></radialGradient>
      <radialGradient id="ob" cx="32%" cy="26%" r="85%"><stop offset="0%" stop-color="#67e8f9"/><stop offset="50%" stop-color="#0891b2"/><stop offset="100%" stop-color="#164e63"/></radialGradient>
      <radialGradient id="oc" cx="32%" cy="26%" r="85%"><stop offset="0%" stop-color="#e9d5ff"/><stop offset="50%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#4c1d95"/></radialGradient></defs>`)
    els.push(`<circle cx="${W - 150}" cy="140" r="100" fill="url(#oa)"/>`)
    els.push(
      `<ellipse cx="${W - 184}" cy="98" rx="30" ry="17" fill="#ffffff" opacity="0.35" transform="rotate(-28 ${W - 184} 98)"/>`,
    )
    els.push(`<circle cx="${W - 260}" cy="${H - 60}" r="62" fill="url(#ob)"/>`)
    els.push(
      `<ellipse cx="${W - 280}" cy="${H - 82}" rx="19" ry="11" fill="#ffffff" opacity="0.35" transform="rotate(-28 ${W - 280} ${H - 82})"/>`,
    )
    els.push(`<circle cx="${W - 70}" cy="${H - 80}" r="42" fill="url(#oc)"/>`)
    els.push(
      `<ellipse cx="${W - 84}" cy="${H - 92}" rx="13" ry="7" fill="#ffffff" opacity="0.35" transform="rotate(-28 ${W - 84} ${H - 92})"/>`,
    )
    whiteSegments(els, W / 2 - 100, H / 2 + f * 0.36, f, text)
    els.push(star(760, 70, 12, 5, '#f59e0b'))
    return els
  },
  // 极光
  aurora(W, H, text, f) {
    const els: string[] = []
    els.push(`<rect width="${W}" height="${H}" fill="#050b14"/>`)
    els.push(`<defs><filter id="g2" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter>
      <linearGradient id="a2" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#22d3ee" stop-opacity="0"/><stop offset="40%" stop-color="#22d3ee" stop-opacity="0.8"/><stop offset="75%" stop-color="#8b5cf6" stop-opacity="0.55"/><stop offset="100%" stop-color="#8b5cf6" stop-opacity="0"/></linearGradient></defs>`)
    els.push(
      `<path d="M-40,130 C 200,80 400,170 600,120 S 860,90 1120,125" fill="none" stroke="url(#a2)" stroke-width="30" filter="url(#g2)" opacity="0.75"/>`,
    )
    els.push(
      `<path d="M-40,180 C 220,140 420,210 620,170 S 880,140 1120,175" fill="none" stroke="url(#a2)" stroke-width="18" filter="url(#g2)" opacity="0.5"/>`,
    )
    whiteSegments(els, W / 2, H / 2 + f * 0.36, f, text)
    els.push(star(W / 2, H - 34, 12, 5, '#22d3ee'))
    return els
  },
  // 上升粒子
  particles(W, H, text, f) {
    const els: string[] = []
    els.push(`<rect width="${W}" height="${H}" fill="#060a14"/>`)
    els.push(`<defs><filter id="gp"><feGaussianBlur stdDeviation="9"/></filter>
      <radialGradient id="bp" cx="50%" cy="110%" r="90%"><stop offset="0%" stop-color="#0ea5e9" stop-opacity="0.35"/><stop offset="100%" stop-color="#060a14" stop-opacity="0"/></radialGradient></defs>`)
    els.push(`<rect width="${W}" height="${H}" fill="url(#bp)"/>`)
    const r = rng(7)
    for (let i = 0; i < 110; i++) {
      const sx = Math.round(r() * W),
        sy = Math.round(r() * H),
        rr = r() * 2.2 + 0.5
      const glow = r() > 0.88
      if (glow)
        els.push(
          `<circle cx="${sx}" cy="${sy}" r="${(rr + 5).toFixed(1)}" fill="#38bdf8" opacity="0.12" filter="url(#gp)"/>`,
        )
      els.push(
        `<circle cx="${sx}" cy="${sy}" r="${rr.toFixed(1)}" fill="${glow ? '#7dd3fc' : '#e0f2fe'}" opacity="${(0.3 + r() * 0.6).toFixed(2)}"/>`,
      )
    }
    whiteSegments(els, W / 2, H / 2 + f * 0.36, f, text)
    els.push(star(W / 2, H - 30, 11, 4.5, '#38bdf8'))
    return els
  },
  // 玻璃卡（浅色背景，深色字）
  glasscard(W, H, text, f) {
    const els: string[] = []
    els.push(`<defs><linearGradient id="g3" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#dbeafe"/><stop offset="50%" stop-color="#ede9fe"/><stop offset="100%" stop-color="#fce7f3"/></linearGradient>
      <filter id="gf3"><feGaussianBlur stdDeviation="14"/></filter>
      <radialGradient id="badge3" cx="35%" cy="30%" r="90%"><stop offset="0%" stop-color="#a78bfa"/><stop offset="100%" stop-color="#6d28d9"/></radialGradient></defs>`)
    els.push(`<rect width="${W}" height="${H}" fill="url(#g3)"/>`)
    els.push(`<circle cx="150" cy="80" r="70" fill="#60a5fa" opacity="0.35" filter="url(#gf3)"/>`)
    els.push(
      `<circle cx="${W - 110}" cy="${H - 60}" r="85" fill="#c084fc" opacity="0.35" filter="url(#gf3)"/>`,
    )
    els.push(
      `<rect x="80" y="60" width="${W - 160}" height="240" rx="30" fill="#ffffff" opacity="0.62"/>`,
    )
    els.push(
      `<rect x="80" y="60" width="${W - 160}" height="240" rx="30" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.95"/>`,
    )
    appendTextSegments(els, W / 2 - 50, H / 2 + f * 0.36, f, text, {
      fill: '#1f2937',
      anchor: 'middle',
      letterSpacing: 0.5,
    })
    els.push(`<circle cx="${W - 160}" cy="${H / 2}" r="40" fill="url(#badge3)"/>`)
    els.push(star(W - 160, H / 2, 20, 8, '#ffffff'))
    return els
  },
  // 频谱
  spectrum(W, H, text, f) {
    const els: string[] = []
    els.push(`<rect width="${W}" height="${H}" fill="#0b0f19"/>`)
    const bars = [40, 84, 52, 110, 66, 130, 76, 102, 50, 92, 60, 80]
    const cols = ['#22d3ee', '#818cf8', '#a78bfa', '#f472b6', '#fbbf24', '#34d399']
    bars.forEach((h, i) => {
      const x = 90 + i * 78,
        col = cols[i % cols.length]
      els.push(
        `<rect x="${x}" y="${H - 28 - h}" width="56" height="${h}" rx="8" fill="${col}" opacity="0.85"/>`,
      )
      els.push(
        `<rect x="${x}" y="${H - 28 - h}" width="56" height="6" rx="3" fill="#ffffff" opacity="0.8"/>`,
      )
    })
    els.push(
      `<rect x="60" y="${H - 28}" width="${W - 120}" height="3" rx="1.5" fill="#ffffff" opacity="0.18"/>`,
    )
    whiteSegments(els, W / 2, H / 2 + f * 0.36, f, text)
    return els
  },
  // 光斑
  bokeh(W, H, text, f) {
    const els: string[] = []
    els.push(`<defs><filter id="bk" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
      <radialGradient id="bg" cx="30%" cy="25%" r="110%"><stop offset="0%" stop-color="#1e3a8a"/><stop offset="100%" stop-color="#020617"/></radialGradient></defs>`)
    els.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`)
    const r = rng(21)
    const colors = ['#60a5fa', '#c084fc', '#f472b6', '#22d3ee', '#fbbf24', '#ffffff']
    for (let i = 0; i < 26; i++) {
      const sx = Math.round(r() * W),
        sy = Math.round(r() * H * 0.85 + 10)
      const rr = 7 + r() * 30
      const col = colors[Math.floor(r() * colors.length)]
      const op = (0.08 + r() * 0.2).toFixed(2)
      if (i % 4 === 0)
        els.push(
          `<circle cx="${sx}" cy="${sy}" r="${rr}" fill="${col}" opacity="${op}" filter="url(#bk)"/>`,
        )
      else els.push(`<circle cx="${sx}" cy="${sy}" r="${rr}" fill="${col}" opacity="${op}"/>`)
    }
    for (let i = 0; i < 8; i++)
      els.push(
        `<circle cx="${Math.round(r() * W)}" cy="${Math.round(r() * H * 0.7)}" r="${(1 + r() * 1.8).toFixed(1)}" fill="#ffffff" opacity="0.5"/>`,
      )
    whiteSegments(els, W / 2, H / 2 + f * 0.36, f, text)
    return els
  },
  // 赛博霓虹（渐变发光话术）
  cyber(W, H, text, f) {
    const els: string[] = []
    els.push(`<rect width="${W}" height="${H}" fill="#0b0d17"/>`)
    els.push(
      `<defs><linearGradient id="c4" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#22d3ee"/><stop offset="100%" stop-color="#e879f9"/></linearGradient></defs>`,
    )
    for (let i = 0; i <= 8; i++)
      els.push(
        `<line x1="0" y1="${H - 24 - i * 36}" x2="${W}" y2="${H - 24 - i * 36}" stroke="#22d3ee" stroke-width="1" opacity="${(0.08 + i * 0.025).toFixed(2)}"/>`,
      )
    for (let i = 0; i <= 14; i++)
      els.push(
        `<line x1="${i * 75}" y1="${H - 24}" x2="${i * 75 + 64}" y2="60" stroke="#e879f9" stroke-width="1" opacity="0.12"/>`,
      )
    els.push(
      `<line x1="0" y1="${H - 24}" x2="${W}" y2="${H - 24}" stroke="#22d3ee" stroke-width="2" opacity="0.7"/>`,
    )
    const y = H / 2 - 30
    // 发光层
    appendTextSegments(els, W / 2, y, f, text, {
      fill: 'none',
      anchor: 'middle',
      stroke: '#22d3ee',
      strokeWidth: 9,
      strokeOpacity: 0.2,
      letterSpacing: 0.5,
    })
    // 主层（渐变）
    appendTextSegments(els, W / 2, y, f, text, {
      fill: 'url(#c4)',
      anchor: 'middle',
      stroke: 'url(#c4)',
      strokeWidth: 1.5,
      strokeOpacity: 1,
      letterSpacing: 0.5,
    })
    els.push(star(W / 2, H - 40, 11, 4.5, '#22d3ee'))
    return els
  },
  // 天际线
  skyline(W, H, text, f) {
    const els: string[] = []
    els.push(
      `<defs><linearGradient id="s5" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#312e81"/><stop offset="55%" stop-color="#7c3aed"/><stop offset="85%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#fb923c"/></linearGradient></defs>`,
    )
    els.push(`<rect width="${W}" height="${H}" fill="url(#s5)"/>`)
    els.push(`<circle cx="${W - 200}" cy="200" r="34" fill="#fde68a"/>`)
    els.push(`<circle cx="${W - 200}" cy="200" r="56" fill="#fde68a" opacity="0.3"/>`)
    const r = rng(23)
    const skyY = 262
    const blds: Array<[number, number, number, number]> = []
    let bx = -8
    while (bx < W) {
      const bw = 40 + Math.round(r() * 56),
        bh = 34 + Math.round(r() * 80)
      blds.push([bx, skyY - bh, bw, bh])
      bx += bw + (4 + Math.round(r() * 9))
    }
    els.push(
      `<path d="${blds.map(([x, y, w, _h]) => `M${x},${skyY} L${x},${y} L${x + w},${y} L${x + w},${skyY}`).join(' ')} Z" fill="#0f172a"/>`,
    )
    for (const [x, y, w, h] of blds) {
      for (let wy = y + 8; wy < y + h - 6; wy += 14) {
        for (let wx = x + 5; wx < x + w - 9; wx += 11) {
          if (r() > 0.7)
            els.push(
              `<rect x="${wx}" y="${wy}" width="3.5" height="5" fill="#fde68a" opacity="${(0.4 + r() * 0.5).toFixed(2)}"/>`,
            )
        }
      }
    }
    els.push(`<rect x="0" y="${skyY}" width="${W}" height="${H - skyY}" fill="#0b1220"/>`)
    els.push(
      `<line x1="0" y1="${skyY}" x2="${W}" y2="${skyY}" stroke="#fbbf24" stroke-width="1.5" opacity="0.7"/>`,
    )
    whiteSegments(els, W / 2, 120, f, text)
    els.push(star(W / 2, H - 30, 11, 4.5, '#fbbf24'))
    return els
  },
  // 山峦
  mountains(W, H, text, f) {
    const els: string[] = []
    els.push(
      `<defs><linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1e1b4b"/><stop offset="50%" stop-color="#4c1d95"/><stop offset="80%" stop-color="#be185d"/><stop offset="100%" stop-color="#f97316"/></linearGradient></defs>`,
    )
    els.push(`<rect width="${W}" height="${H}" fill="url(#sk)"/>`)
    els.push(`<circle cx="240" cy="230" r="38" fill="#fed7aa"/>`)
    els.push(`<circle cx="240" cy="230" r="66" fill="#fb923c" opacity="0.35"/>`)
    els.push(`<circle cx="240" cy="230" r="104" fill="#f97316" opacity="0.18"/>`)
    els.push(
      `<path d="M0,280 L110,200 L240,268 L390,182 L540,262 L690,196 L900,270 L1080,232 L1080,360 L0,360 Z" fill="#312e81" opacity="0.85"/>`,
    )
    els.push(
      `<path d="M0,310 L150,248 L310,302 L490,230 L660,298 L840,250 L1080,300 L1080,360 L0,360 Z" fill="#1e1b4b"/>`,
    )
    els.push(
      `<path d="M0,342 L190,290 L400,330 L610,282 L820,328 L1080,296 L1080,360 L0,360 Z" fill="#0f0a1e"/>`,
    )
    whiteSegments(els, W / 2 + 120, 110, f, text)
    els.push(star(W - 100, 66, 12, 5, '#fbcfe8'))
    return els
  },
  // 大星（无数字场景用 ★ 主视觉）
  bignum(W, H, text, f) {
    const els: string[] = []
    els.push(`<rect width="${W}" height="${H}" fill="#0b1220"/>`)
    els.push(
      `<defs><linearGradient id="bn" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#67e8f9"/><stop offset="100%" stop-color="#2563eb"/></linearGradient></defs>`,
    )
    els.push(
      `<text x="250" y="330" font-family="PingFang SC, sans-serif" font-size="290" font-weight="bold" fill="url(#bn)" opacity="0.95" text-anchor="middle">★</text>`,
    )
    els.push(
      `<text x="250" y="330" font-family="PingFang SC, sans-serif" font-size="290" font-weight="bold" fill="none" stroke="#22d3ee" stroke-width="3" stroke-opacity="0.5" text-anchor="middle">★</text>`,
    )
    whiteSegments(els, 430, H / 2 + f * 0.36, f, text)
    els.push(`<circle cx="470" cy="80" r="4" fill="#67e8f9"/>`)
    els.push(`<circle cx="380" cy="300" r="3" fill="#818cf8"/>`)
    return els
  },
  // 极简留白（点线 + 红星，2026-08-27）
  minimal(W, H, text, f) {
    const els: string[] = []
    els.push(`<rect width="${W}" height="${H}" fill="#faf9f7"/>`)
    const dot = (y: number, op: number): string => {
      let s = ''
      for (let x = 70; x < W - 40; x += 26)
        s += `<circle cx="${x}" cy="${y}" r="3" fill="#c41e3a" opacity="${op}"/>`
      return s
    }
    els.push(dot(48, 0.85))
    els.push(dot(H - 48, 0.45))
    els.push(star(W / 2, 128, 16, 6.5, '#c41e3a'))
    appendTextSegments(els, W / 2, H / 2 + 22, f, text, {
      fill: '#1a1a1a',
      anchor: 'middle',
      letterSpacing: 0.5,
    })
    return els
  },

  // 虹彩
  iridescent(W, H, text, f) {
    const els: string[] = []
    els.push(`<rect width="${W}" height="${H}" fill="#0a0a14"/>`)
    els.push(`<defs>
      <linearGradient id="r6" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#f472b6"/><stop offset="35%" stop-color="#a78bfa"/><stop offset="65%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#34d399"/></linearGradient>
      <radialGradient id="o6" cx="35%" cy="28%" r="85%"><stop offset="0%" stop-color="#ffffff"/><stop offset="30%" stop-color="#f0abfc"/><stop offset="75%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#312e81"/></radialGradient>
      <filter id="b6" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter></defs>`)
    els.push(`<circle cx="${W - 150}" cy="110" r="95" fill="url(#o6)"/>`)
    els.push(
      `<ellipse cx="${W - 180}" cy="80" rx="28" ry="16" fill="#ffffff" opacity="0.4" transform="rotate(-28 ${W - 180} 80)"/>`,
    )
    els.push(
      `<path d="M-40,300 C 160,260 320,330 520,290 S 800,260 1120,295" fill="none" stroke="url(#r6)" stroke-width="18" filter="url(#b6)" opacity="0.8"/>`,
    )
    els.push(
      `<path d="M-40,326 C 200,290 380,345 580,315 S 860,288 1120,322" fill="none" stroke="url(#r6)" stroke-width="10" opacity="0.5"/>`,
    )
    whiteSegments(els, W / 2 - 60, H / 2 + f * 0.36, f, text)
    els.push(star(W - 200, H / 2, 13, 5.5, '#a78bfa'))
    return els
  },
}

// ── 主入口 ──────────────────────────────────────────────────────────────

/** 生成结尾结束语图片 PNG（1080×360，width 等比缩放），可选写盘 */
export async function generateEndingCard(
  options: EndingCardOptions = {},
): Promise<EndingCardResult> {
  try {
    const template: CoverTemplate = options.template || 'nebula'
    const bg = ENDING_BG[template]
    if (!bg) return { ok: false, error: `未知封面模板: ${template}` }
    const W = options.width || BASE_W
    const H = Math.round((BASE_H * W) / BASE_W)
    const text = options.text || DEFAULT_TEXT
    const f = fit1(text, 34, W - 160)
    const els = bg(W, H, text, f)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${els.join('')}</svg>`
    const png = await sharp(Buffer.from(svg)).png().toBuffer()

    const result: EndingCardResult = { ok: true, png, width: W, height: H }
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

export { DEFAULT_TEXT }
