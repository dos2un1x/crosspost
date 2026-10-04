/**
 * 平台三态分组（纯函数）——扩展选项页渲染与单测共用。
 *
 * ## 为什么需要它（2026-09-25 实测的「未登录 0」陷阱）
 *
 * `/proxy/platforms` 返回的是**本轮检查范围内的**平台：模型 A（勾选集 = 检查集）下，
 * 未勾选的平台根本不在返回列表里。于是选项页把"范围内 12 个都已登录"渲染成「未登录 0」，
 * 而那份平台上一次全量检查的结果是：27 个里有 **14 个未登录**
 * （简书/豆瓣/雪球/搜狐/什么值得买/微博/语雀/慕课/开源中国/SegmentFault/博客园/
 * 东方财富/网易/搜狐焦点）。用户看到的是"一切正常"的假象 —— 这正是被报上来的那条。
 *
 * 判据：**「没查过」必须与「查过且未登录」分开算**。
 * - 已登录 / 未登录：只统计**返回列表里**的平台（它们才真的被查过）
 * - 未检查：`scope.excluded` 里那些**不在返回列表中**的 id
 *   （手动全量查之后返回列表含全部 27 个，未检查自然归零 —— 这是"点刷新全量查"的意义）
 *
 * 本模块不碰 DOM、不碰网络，所以既能被选项页直接 import，也能被 node 单测直接调。
 */

/** 检查在飞时的轮询间隔与上限（选项页用；单测可容忍 1.5s 的真实等待） */
export const CHECK_POLL_MS = 1500
export const CHECK_POLL_MAX_MS = 120000

/**
 * @param {{platforms?: Array<{id:string,isAuthenticated?:boolean}>,
 *          scope?: {ids?:string[],excluded?:string[],all?:number,count?:number|null,mode?:string}|null,
 *          lastMode?: string|null}} input
 */
export function groupPlatforms({ platforms = [], scope = null, lastMode = null } = {}) {
  const checked = (Array.isArray(platforms) ? platforms : []).filter((p) => p && p.id)
  const ids = new Set(checked.map((p) => p.id))
  const excluded = ((scope && scope.excluded) || []).filter((id) => id && !ids.has(id))
  const all = Number(scope && scope.all) || checked.length
  return {
    ok: checked.filter((p) => p.isAuthenticated),
    no: checked.filter((p) => !p.isAuthenticated),
    uncheckedIds: excluded,
    coverage: {
      checked: ids.size,
      all,
      scopeCount: (scope && scope.count) != null ? scope.count : null,
      mode: lastMode || (scope && scope.mode) || null,
    },
  }
}

/**
 * 第一个 tab（已登录）的文案。
 *
 * **一个平台都没核验过时不报 0**：`已登录 0` 会被读成"没有平台登录了"，而真相是
 * "还没核过"——这与下面 `notLoggedTabText` 里「未登录 0」的假象（v2.3.2 修的那条）
 * 是同一族错误：**把"没有数据"画成"数据是 0"**。未知一律画成 `–`（与状态卡的占位一致）。
 */
export function loggedTabText(g) {
  return g.coverage.checked ? `已登录 ${g.ok.length}` : '已登录 –'
}

/**
 * 第二个 tab 的文案。三条诚实规则：
 *   ① 一个都没核验过（checked = 0）→ **不出现「未登录 0」**，只报未检查数
 *      （"未登录"只在真的查过之后才是状态，否则是猜测）；
 *   ② 只要还有未检查的平台，两个数必须一起出现（v2.3.2 的硬要求，
 *      单独一个「未登录 0」在没查全时会读成"全部平台都登录了"）；
 *   ③ 全量核验过 → 只报未登录数。
 */
export function notLoggedTabText(g) {
  const checked = g.coverage.checked
  const no = g.no.length
  const unchecked = g.uncheckedIds.length
  if (!checked) return unchecked ? `未检查 ${unchecked}` : '未登录 –'
  return unchecked ? `未登录 ${no} · 未检查 ${unchecked}` : `未登录 ${no}`
}

/**
 * 与 {@link notLoggedTabText} 同源的**分段**（给数字上三态颜色用）。
 *
 * 页面把每段渲染成 `<b class="seg 状态">数字</b>`，数字带色、文字保持中性 ——
 * 于是这一个 tab 里"未登录 0"和"未检查 15"在**颜色**上也是两种状态
 * （红 / 琥珀），不必读完整句话。
 *
 * ⚠️ 不变量：`parts.map(p => p.text).join(' · ') === notLoggedTabText(g)`
 * （单测钉住）。分段与文案是同一条判据的两种呈现，绝不允许各自漂移。
 */
export function notLoggedTabParts(g) {
  const checked = g.coverage.checked
  const no = g.no.length
  const unchecked = g.uncheckedIds.length
  if (!checked) {
    return unchecked
      ? [{ tone: 'unk', text: `未检查 ${unchecked}` }]
      : [{ tone: 'none', text: '未登录 –' }]
  }
  const parts = [{ tone: 'no', text: `未登录 ${no}` }]
  if (unchecked) parts.push({ tone: 'unk', text: `未检查 ${unchecked}` })
  return parts
}

/** 第二个 tab 的分段（供页面上色；`loggedTabParts` 对称提供第一个） */
export function loggedTabParts(g) {
  return [{ tone: g.coverage.checked ? 'ok' : 'none', text: loggedTabText(g) }]
}

/** 顶部状态卡的检查范围说明（把"没查全"说成人话，并给出可执行动作） */
export function scopeNoteText(g) {
  const unchecked = g.uncheckedIds.length
  if (unchecked) return `未检查 ${unchecked} 个（未勾选；点「刷新状态」全量查）`
  if (g.coverage.mode === 'all') return `全部 ${g.coverage.all} 个平台都已检查`
  return '全部平台都在检查范围内'
}

/** 未检查分组的标题（只有真的要渲染这一组时才用它） */
export function uncheckedGroupTitle(g) {
  return `未检查平台（未勾选，${g.uncheckedIds.length} 个）`
}

/**
 * 第一个面板为空时的说明。
 *
 * `暂无平台` 会让"本轮还没核验"看起来像"范围内一个平台都没有"；
 * 而这两件事的动作完全不同（前者点「刷新状态」，后者去 Console 勾选平台）。
 */
export function emptyLoggedPaneText(g) {
  return g.coverage.checked ? '暂无平台' : '本轮尚未核验（点「刷新状态」立即查）'
}
