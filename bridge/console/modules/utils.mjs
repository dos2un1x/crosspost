// 通用工具（2026-08-24 app.js 拆分 Phase 0）
import { PAGE_SIZE, RISK_NAMES, SCORE_PASS } from './const.mjs'

export const $ = (sel) => document.querySelector(sel)

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}
export const escapeAttr = (s) => escapeHtml(s)

export function statusText(s) {
  return (
    {
      published: '已发布',
      partial: '部分成功',
      failed: '失败',
      draft: '未推送',
      archived: '已归档',
      retained: '已留存',
    }[s] || s
  )
}

export function fmtTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  if (isNaN(d)) return String(t).slice(0, 16)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 北京时间今日日期（YYYY-MM-DD）——2026-09-01 时区统一：与后端 tz.mjs/run-bridge 一致，
 *  避免机器时区 ≠ 北京时间时"今日费用/今天"标签与文章 date（北京口径）错位。 */
export function todayStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export function fmtNum(n) {
  return (n || 0).toLocaleString('zh-CN')
}

/** 风险标签（ad/investment/pr/person 彩标；unclassified 灰标；none/空 不显示） */
export function riskBadge(risk) {
  if (!risk || risk === 'none') return ''
  const cls = risk === 'unclassified' ? 'unclassified' : risk === 'person' ? 'person' : 'risk'
  return `<span class="risk-badge ${cls}">${RISK_NAMES[risk] || risk}</span>`
}

/** 评分单元格（record.score.total，≥阈值绿 / 低于红 / 无评分 —） */
export function renderScoreCell(score) {
  const total =
    score && typeof score === 'object' && score.total !== undefined
      ? score.total
      : typeof score === 'number'
        ? score
        : null
  if (total === null) return '<span style="color:var(--ink-faint)">—</span>'
  return `<span class="score-badge ${total >= SCORE_PASS ? 'pass' : 'fail'}">${total}</span>`
}

/** 分页切片 + 分页控件（列表超过 PAGE_SIZE 条才显示） */
export function pageSlice(list, page) {
  if (list.length <= PAGE_SIZE) return list
  const pages = Math.ceil(list.length / PAGE_SIZE)
  const p = Math.max(1, Math.min(page, pages))
  return list.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE)
}

export function renderPager(el, total, page, onGo, pageSize = PAGE_SIZE) {
  if (total <= pageSize) {
    el.innerHTML = ''
    return
  }
  const pages = Math.ceil(total / pageSize)
  const p = Math.max(1, Math.min(page, pages))
  const nums = []
  for (let i = 1; i <= pages; i++) {
    if (pages > 7 && i > 2 && i < pages - 1 && Math.abs(i - p) > 1) {
      if (nums[nums.length - 1] !== '…') nums.push('…')
      continue
    }
    nums.push(i)
  }
  el.innerHTML =
    `<button class="pg" data-go="${p - 1}" ${p <= 1 ? 'disabled' : ''}>‹ 上一页</button>` +
    nums
      .map((n) =>
        n === '…'
          ? '<span class="pg-dots">…</span>'
          : `<button class="pg ${n === p ? 'on' : ''}" data-go="${n}">${n}</button>`,
      )
      .join('') +
    `<button class="pg" data-go="${p + 1}" ${p >= pages ? 'disabled' : ''}>下一页 ›</button>` +
    `<span class="pg-info">共 ${total} 条 · 第 ${p}/${pages} 页</span>`
  el.querySelectorAll('button.pg').forEach((btn) => {
    if (btn.disabled) return
    btn.addEventListener('click', () => {
      onGo(Number(btn.dataset.go))
    })
  })
}

// 报表日期工具（P5）
export function toLocalDate(d) {
  if (d instanceof Date) return d
  const s = String(d)
  return new Date(s.length === 10 ? s + 'T00:00:00' : s)
}
/** 该日期所在周的周一（周一为一周起点） */
export function mondayOf(d) {
  const date = toLocalDate(d)
  const day = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - day)
  date.setHours(0, 0, 0, 0)
  return date
}
export const fmtMD = (d) =>
  `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// 栏目标签搬到 `slot-lexicon.mjs`（2026-09-25）：名字的权威源在项目声明里，
// 这里只留 `README`——请从那里 import `slotName`，不要直接索引 `const.SLOT_NAMES`。

/* ── 样式显示名 / 分组（2026-08-25：样式库与详情预览共用，单一来源） ── */

/** 样式显示名：去 custom- 前缀（custom-default → default） */
export const styleDisplayName = (name) => (name.startsWith('custom-') ? name.slice(7) : name)

const STYLE_SERIES = ['醒目', '精致', '聚焦', '简约']

/** 「其他自定义主题」细分：md-misc 里的主题按显式映射归到 3 个子组（避免单列过长） */
const MISC_GROUPS = {
  'md-ai': { title: 'AI 资讯系列', order: 0 },
  'md-brand': { title: '品牌 / 平台', order: 1 },
  'md-style': { title: '视觉风格', order: 2 },
}
/** 显式映射表：主题名（去 custom- 前缀）→ 子组 key；未列出的归 md-misc */
const MISC_MAP = {
  // AI 资讯系列（desc 多为「XX风」）
  mianpro: 'md-ai',
  longform: 'md-ai',
  tech: 'md-ai',
  product: 'md-ai',
  default: 'md-ai',
  modern: 'md-ai',
  minimal: 'md-ai',
  darktech: 'md-ai',
  // 品牌 / 平台（平台官方风）
  apple: 'md-brand',
  bytedance: 'md-brand',
  'github-readme': 'md-brand',
  classic: 'md-brand',
  'sspai-red': 'md-brand',
  chinese: 'md-brand',
  // 视觉风格（氛围 / 视觉风）
  cyber: 'md-style',
  'ink-minimal': 'md-style',
  'lavender-dream': 'md-style',
  'mint-fresh': 'md-style',
  'sunset-amber': 'md-style',
  'coffee-house': 'md-style',
  sports: 'md-style',
  'bauhaus-primary': 'md-style',
  'wechat-native': 'md-style',
}

export const STYLE_GROUP_ORDER = [
  'core',
  'extend',
  ...STYLE_SERIES.map((s) => 'md-' + s),
  ...Object.keys(MISC_GROUPS),
  'md-misc',
]

/** 样式 → 分组（与样式库分组一致） */
export function styleGroupOf(s) {
  // 内置样式按分类拆组：核心内置（swiss/editorial/ink）与扩展内置（其余 7 个）
  if (s.category === 'core') return { key: 'core', title: '核心内置' }
  if (s.category === 'extend') return { key: 'extend', title: '扩展内置' }
  const d = s.desc || ''
  for (const series of STYLE_SERIES) {
    if (d.startsWith(series)) return { key: 'md-' + series, title: `${series}系列（8 色）` }
  }
  const sub = MISC_MAP[s.name.replace(/^custom-/, '')]
  if (sub && MISC_GROUPS[sub]) return { key: sub, title: MISC_GROUPS[sub].title }
  return { key: 'md-misc', title: '其他自定义主题' }
}

/** 样式列表按分组顺序重排 → Map<key, { title, items }> */
export function groupStyles(styleList) {
  const groups = new Map()
  for (const s of styleList) {
    const g = styleGroupOf(s)
    if (!groups.has(g.key)) groups.set(g.key, { title: g.title, items: [] })
    groups.get(g.key).items.push(s)
  }
  return new Map(
    [...groups.entries()].sort(
      (a, b) => STYLE_GROUP_ORDER.indexOf(a[0]) - STYLE_GROUP_ORDER.indexOf(b[0]),
    ),
  )
}
