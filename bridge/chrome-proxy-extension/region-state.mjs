/**
 * 选项页「tab 区」的状态机（纯函数）——页面渲染与单测共用。
 *
 * ## 这个区域要回答的问题
 *
 * tab 区展示两个计数（已登录 / 未登录·未检查）。**数字本身不足以读**：
 * 同一对数字可能是"刚核验完的真实结果"，也可能是"三小时前的旧账"、
 * "上次核对失败了但缓存还在"、"浏览器扩展没连、根本没法核"。
 * 用户报"细化这个区域的多种状态"指的就是这件事。
 *
 * ## 三态 vs 四格：为什么「已登录未检查」不存在
 *
 * 用户列了四格：已登录已检查 / 已登录未检查 / 未登录已检查 / 未登录未检测。
 * 前三格之外的那两格（未检查 × 已登录/未登录）在本系统里**取不到数据**，不是没实现：
 *   · `/proxy/platforms` 只返回**本轮检查范围内**的平台（模型 A：勾选集 = 检查集）；
 *   · 桥侧的持久状态 `crosspost-runtime/platforms-state.json` 也**只保留当前范围**——
 *     `pruneState()` 的注释写着"丢弃不在检查范围内的平台状态（避免陈旧计数影响
 *     重新纳入时的判断）"。实测该文件此刻只有 12 条（= 勾选的 12 个），
 *     15 个未勾选平台**一条记录都没有**。
 * 所以未检查平台的登录态是**未知**，把它画成"已登录/未登录"就是把猜测当状态——
 * 正是 v2.3.2 修掉的那一族假象。未检查因此是**第三种状态**，不是第四格。
 *
 * 本模块补的是另一个轴：**这批数字的可信度**（核验时间 / 正在复核 / 核对失败 /
 * 扩展未连接 / 尚未核验 / 数据不可用）。
 *
 * 纯函数：不碰 DOM、不碰网络、不认识时间格式（年龄文案由页面 `fmtAgo` 传进来），
 * 因此能在 node 里把七种状态逐条钉住。
 */
import {
  emptyLoggedPaneText,
  loggedTabParts,
  loggedTabText,
  notLoggedTabParts,
  notLoggedTabText,
} from './platform-groups.mjs'

/** 可信度状态（`text` 之外还给 `key` 与 `tone`，让页面能上色/加图标而不必再解析文案） */
export const TRUST_KEYS = [
  'unavailable',
  'failed',
  'offline',
  'first',
  'checking',
  'unknown',
  'stale',
  'fresh',
]

/** 副标签的通用文案（未检查那一侧固定用它：计数在左，这里只说明"状态未知"） */
export const UNCHECKED_SUB = '未核验 · 状态未知'

/**
 * 计算 tab 区数字的可信度。
 *
 * @param {{reachable?:boolean, connected?:boolean, checkedAt?:number|null,
 *          refreshing?:boolean, init?:boolean, checkError?:string|null,
 *          cacheMs?:number, checked?:number, now?:number, ageText?:string}} s
 *   - `reachable`：本地桥本来能不能取数（false = API 都没通）
 *   - `connected`：桥在跑但**浏览器扩展**没连（检查要靠它代发请求）
 *   - `checked`：本轮真的核验过的平台数（0 = 一个都没核过）
 *   - `ageText`：`checkedAt` 的人话年龄（"3 小时前"），由页面传
 * @returns {{key:string, tone:'quiet'|'run'|'warn'|'err', text:string}}
 */
export function trustState(s = {}) {
  const {
    reachable = true,
    connected = true,
    checkedAt = null,
    refreshing = false,
    init = false,
    checkError = null,
    cacheMs = 3600000,
    checked = 0,
    now = Date.now(),
    ageText = '',
  } = s

  // ① 桥都取不到数：下面的数字没有任何依据
  if (!reachable) return { key: 'unavailable', tone: 'err', text: '数据不可用' }
  // ② 上次核对失败且**没有任何缓存**：不能说"本轮已核验"
  if (checkError && !checked) return { key: 'failed', tone: 'err', text: '上次核对失败' }
  // ③ 桥在跑但扩展没连：检查发不出去（数字只能是上一轮的）
  if (!connected) return { key: 'offline', tone: 'warn', text: '扩展未连接' }
  // ④ 第一次核验还没落地（冷启动）与后续复核，都是"正在查"
  if (!checked && (init || refreshing)) return { key: 'first', tone: 'run', text: '首次核对中…' }
  if (refreshing) return { key: 'checking', tone: 'run', text: '复核中…' }
  // ⑤ 没在查、也没核过：尚未核验（不是"0"）
  if (!checked) return { key: 'unknown', tone: 'quiet', text: '尚未核验' }
  // ⑥ 有缓存但上一轮核对失败：数字还算数，只是不是最新的
  if (checkError) return { key: 'failed', tone: 'err', text: '上次核对失败' }
  // ⑦ 缓存超过一个周期：桥会在下一个 tick 重查（数字仍是上一轮的真结果）
  if (checkedAt && now - checkedAt >= cacheMs) {
    return { key: 'stale', tone: 'warn', text: `${ageText || '较早'}的核验` }
  }
  return { key: 'fresh', tone: 'quiet', text: '本轮已核验' }
}

/**
 * tab 区四个文案一次算齐：主标签（+ 分段）+ 副标签（可信度）。
 *
 * @param {{groups:object, trust:ReturnType<typeof trustState>}} input
 * @returns {{tabOk:{text:string,parts:Array<{tone:string,text:string}>,sub:string},
 *            tabNo:{text:string,parts:Array<{tone:string,text:string}>,sub:string},
 *            emptyOk:string}}
 */
export function regionLabels({ groups, trust }) {
  const unchecked = groups.uncheckedIds.length
  // 副标签只说明一件事：这组数字算不算数。
  // · 已登录那一栏：没核过就说"尚未核验"，核过就报可信度；
  // · 未登录/未检查那一栏：只要还有未检查的平台，就先说明那部分**状态未知**
  //   （否则「未检查 15」会被读成"15 个未登录"）。
  return {
    tabOk: {
      text: loggedTabText(groups),
      parts: loggedTabParts(groups),
      // 副标签恒为可信度本身：没核过时 trustState 自己会说「尚未核验」/「首次核对中…」
      // （不必在这里再分一次支 —— 两处判据会漂）
      sub: trust.text,
      subTone: trust.tone,
    },
    tabNo: {
      text: notLoggedTabText(groups),
      parts: notLoggedTabParts(groups),
      // 只要还有未检查的平台，就先把"那部分状态未知"写在计数下面；
      // 未检查那一段的琥珀色已经挂在数字上，所以这里保持静音（不必两个地方同时喊）
      sub: unchecked ? UNCHECKED_SUB : trust.text,
      subTone: unchecked ? 'quiet' : trust.tone,
    },
    emptyOk: emptyLoggedPaneText(groups),
  }
}
