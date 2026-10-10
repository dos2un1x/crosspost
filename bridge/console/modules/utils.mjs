// 通用工具（2026-08-24 app.js 拆分 Phase 0）
import { PAGE_SIZE, RISK_NAMES, SCORE_PASS } from './const.mjs'

export const $ = (sel) => document.querySelector(sel)

// author: dos2un1x · repo: https://github.com/dos2un1x/crosspost
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

/**
 * 已知的**规范坐标** → 人话（2026-10-10）。
 *
 * 抽屉是给人和读者看的信息，`§5.55` / `§5.6` 这类条款号是内部规范的定位符，
 * 出现在记录、原因、通知里只会让人困惑（"§5.6 独立审稿" → 直接写"独立审稿"）。
 */
const SPEC_REF_NAMES = {
  '§2.5': '编辑决策',
  '§4.0': '编辑决策',
  '§5.5': '自评门槛',
  '§5.55': 'AI 检测门禁',
  '§5.6': '独立审稿',
  '§5.7': '定向修订',
}

/**
 * 把展示文本里的规范条款号换成说法。
 *
 * **只换多级号**（`§5.55` / `§5.6` / `§4.0`）：单级的 `§1` / `§5` 在记录里常指
 * **文章自己的小节**（例："已删 §1 与 §5 重复的论述"），删掉会让句子失去所指 ——
 * 判据是"带小数点"：规范坐标都是多级的，文章小节引用都是单级的。
 * 未知的多级号直接去掉（不编名字），并清掉留下的空格与空括号。
 */
export function stripSpecRefs(s) {
  let t = String(s == null ? '' : s)
  if (!t.includes('§')) return t
  t = t.replace(/§\s*\d+(?:\.\d+)+/g, (m) => {
    const key = '§' + m.replace(/[^\d.]/g, '')
    return Object.prototype.hasOwnProperty.call(SPEC_REF_NAMES, key) ? SPEC_REF_NAMES[key] : ''
  })
  return (
    t
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\(\s*\)|（\s*）/g, '')
      .replace(/\s+([，,。;；：:)）])/g, '$1')
      // 汉字之间的孤空格（删掉条款号后留下的）在这里并回去；"AI 检测" 这类跨中英的空格不受影响
      .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
      .replace(/^[，,、;；\s]+/, '')
      .trim()
  )
}

/**
 * `history[].action` → 人读标签（2026-10-09）。
 *
 * 为什么要有它：抽屉的发布历史此前只特判了 `dryRun`，其余 action **一律写成"发布"** ——
 * 而记录里 1383 条 history 中有 786 条是留存/恢复/归档/补记/状态，于是它们全被标成
 * 「发布 · 微信 — · 平台 —」：既不是事实，又让人以为"发过好几次却一个平台结果都没有"。
 * 未登记的 action 原样回显（宁可显示 `some-action`，也不要编一个好听的名字）。
 */
export function historyLabel(action) {
  const a = String(action == null ? '' : action)
  return (
    {
      publish: '发布',
      'draft-only': '草稿（未推送）',
      dryRun: '渲染测试',
      retain: '留存',
      restore: '恢复',
      archive: '归档',
      backfill: '补记（日志回填）',
      mark: '补记（人工）',
      status: '状态变更',
      'ai-detect': 'AI 检测',
      writing: '写作快照',
    }[a] || a
  )
}

/** 这些 action 才真的带推送结果（微信/平台）——其余条目不该渲染这两个数字 */
const PUSH_ACTIONS = new Set(['publish', 'draft-only', 'dryRun', 'backfill', 'mark'])

/**
 * 一条 history → 头行片段数组（标签 + **只有真的发生过**的字段）。
 * 调用方 `join(' · ')`；**不补 `—` 占位**：没发生的事就不写。
 */
export function historyMeta(h) {
  const e = h && typeof h === 'object' ? h : {}
  const parts = [historyLabel(e.action)]
  if (PUSH_ACTIONS.has(String(e.action))) {
    if (e.wechat) parts.push(`微信 ${e.wechat}`)
    if (e.platforms) parts.push(`平台 ${e.platforms}`)
  }
  if (e.score !== undefined && e.score !== null) parts.push(`评分 ${e.score}`)
  if (e.action === 'retain') parts.push(e.dir === 'risk' ? '→ 风险库' : '→ 低分库')
  if (e.action === 'archive') parts.push('→ 归档库')
  if (e.action === 'restore') parts.push('← 移回草稿目录')
  if (e.action === 'status' && e.to) parts.push(`→ ${e.to}`)
  return parts
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
