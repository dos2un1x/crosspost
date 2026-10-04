// 栏目词典（2026-09-25）—— Console 里"栏目叫什么、有哪些"的**唯一**入口。
//
// ## 为什么要有这个模块
//
// 栏目名曾经在前端有一份硬编码副本（`const.mjs` 的 `SLOT_NAMES`），而权威源早就搬到
// 项目侧了：槽位的 `name` 写在项目配置与 `.crosspost/schedule.json` 里，设置→调度
// 显示的就是那里的名字。于是同一个槽位在 Console 里出现了**两个名字**，实测本机：
//
//     项目声明（设置→调度看见的）        前端常量（文章/报表/归档/选题/详情/编写看见的）
//     热点解读①                          热点①
//     深度分析                            深度
//     热点解读②                          热点②
//     AI技巧·工具                         技巧
//     教学/娱乐                           晚间
//
// 连"有哪些栏目"都不一致：编写页的栏目下拉还列着一个本项目根本没声明的「早报」。
// 契约测试只锁了 `SLOT_NAMES` 的**键**（= 引擎 `SLOTS ∪ {manual}`），没锁**名**，
// 所以名字漂了没有任何门禁会红。
//
// ## 数据源与形态
//
// 名字取自 `GET /proxy/schedule`（项目域请求，行里带 `slot` / `label` / `time`；
// `label` 的合并顺序是"项目配置 name > 声明 name > 模板名"，与设置页**同源**）。
// 不使用 `/proxy/bootstrap`：它是 `api.mjs` 里一次性的裸 fetch（不带项目头、按文档加载
// 缓存），项目切换后会是错的。
//
// ## 两类语义必须分开（曾经混在一起才出事）
//
//   · **显示**（`slotName`）：词典 → 常量兜底 → 原样 id。历史文章 `slot=morning` 即使
//     本项目不再声明它，也照样显示「早报」，不会露出裸 id。
//   · **可选项**（`slotChoices`）：只用**项目声明的槽位** + `manual`。于是"本项目不跑的
//     栏目"不再出现在下拉里，而项目新声明的栏目立刻可选。词典拿不到（旧桥/未接入项目）
//     时**回退到常量键序**，单项目部署的编写页行为逐字不变。
//
// 词典是异步的、按项目缓存；`app.js` 在两处 `await loadSlotLexicon()` 之后再渲染
// （首屏、切换项目），所以视图拿到的名字不会先错后对。请求带 5s 超时：桥忙时宁可
// 用兜底常量渲染，也不让首屏挂 90 秒（api.mjs 的默认超时）。
import { getJSON } from './api.mjs'
import { activeProject } from './active-project.mjs'
import { SLOT_NAMES } from './const.mjs'

/** 词典请求超时：拿不到就用常量兜底，不值得让首屏等 */
const LEXICON_TIMEOUT_MS = 5000

/** 当前词典（按项目缓存；`project` 为取词典时选中的项目） */
let state = { project: null, items: [], ready: false }
/** 在飞的那次请求（同一项目并发调用共享它，不叠加请求） */
let inflight = null

/** 状态行 → 词典条目（只取本模块需要的叶子字段，不搬运后端对象） */
function toItems(status) {
  const rows = Array.isArray(status && status.slots) ? status.slots : []
  return rows
    .filter((r) => r && r.slot)
    .map((r) => ({
      id: r.slot,
      label: r.label || r.slot,
      time: r.time || '',
    }))
}

/**
 * 取当前项目的栏目词典（幂等、按项目缓存）。
 *
 * 失败/拿不到 → 记为空词典（`ready:false`）并返回空数组：调用方一律走常量兜底，
 * 页面不该因为"词典没拿到"而空白或报错。
 */
export async function loadSlotLexicon() {
  const project = activeProject()
  if (state.ready && state.project === project) return state.items
  if (inflight && inflight.project === project) return inflight.promise
  const promise = getJSON('/proxy/schedule', { timeoutMs: LEXICON_TIMEOUT_MS })
    .then((status) => {
      state = { project, items: toItems(status), ready: true }
      return state.items
    })
    .catch(() => {
      state = { project, items: [], ready: false }
      return state.items
    })
    .finally(() => {
      if (inflight && inflight.promise === promise) inflight = null
    })
  inflight = { project, promise }
  return promise
}

/** 仅测试/调试用：重置缓存 */
export function resetSlotLexicon() {
  state = { project: null, items: [], ready: false }
  inflight = null
}

/** 词典里的条目（给排序/下拉用）——槽位全部来自项目（引擎不再自带任务） */
export function projectSlotItems() {
  return state.items
}

/**
 * 槽位 id → 显示名。**所有**栏目名都必须走这里（不要直接索引 `SLOT_NAMES`）。
 *
 * 顺序：词典 → 常量（历史槽位如 `morning` 仍有名字）→ 原样 id。
 */
export function slotName(id) {
  if (!id) return ''
  const hit = state.items.find((x) => x.id === id)
  return (hit && hit.label) || SLOT_NAMES[id] || id
}

/** 这个 id 是不是"系统认得的栏目"（词典或常量里有） */
export function isKnownSlot(id) {
  return !!(id && (state.items.some((x) => x.id === id) || SLOT_NAMES[id]))
}

/**
 * 编写页的栏目**可选项**：项目声明的槽位（按时间序）+ `manual`。
 *
 * 词典为空（未接入项目 / 旧桥 / 请求失败）→ 回退常量键序，与今天逐字一致。
 * `keep` 用于回填历史草稿：它的栏目若不在项目声明里（例如旧 `morning`），
 * 也**必须**出现在选项里 —— 否则下拉会落到第一项，等于替用户静默改了栏目。
 */
export function slotChoices(keep) {
  const rows = projectSlotItems()
  if (!rows.length) {
    const ids = Object.keys(SLOT_NAMES)
    if (keep && !ids.includes(keep)) ids.unshift(keep)
    return ids.map((id) => ({ id, label: slotName(id) }))
  }
  const sorted = [...rows].sort((a, b) => String(a.time).localeCompare(String(b.time)))
  const out = sorted.map((r) => ({ id: r.id, label: slotName(r.id) }))
  if (!out.some((o) => o.id === 'manual')) out.push({ id: 'manual', label: slotName('manual') })
  if (keep && !out.some((o) => o.id === keep)) out.push({ id: keep, label: slotName(keep) })
  return out
}

/**
 * 报表里栏目的**定义顺序**：声明（按时间）→ 常量里剩下的（保持历史顺序）→ 其它。
 * 只决定先后，不决定"有没有"（数据里出现的栏目一律照列，绝不丢数）。
 */
export function slotOrderKeys(extraKeys = []) {
  const declared = projectSlotItems()
    .sort((a, b) => String(a.time).localeCompare(String(b.time)))
    .map((r) => r.id)
  const seen = new Set()
  const out = []
  for (const id of [...declared, ...Object.keys(SLOT_NAMES), ...extraKeys]) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
