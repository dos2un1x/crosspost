/**
 * 平台登录检查范围 + 失败重查策略（2026-09-12）
 *
 * 背景（当天排查结论）：此前「全量检查」= 全部 27 个平台、「失败重查」= 曾登录过 ∩ 当前失败，
 * 且重查**无退避、无上限、无终态**。结果：4 个从不勾选、且当前浏览器里根本没登录的平台
 * （bilibili / jianshu / douban / woshipm）被每 60~90 秒重查一次，9.4 小时内 420 轮、
 * 全部注定失败，且面板只显示一行「失败平台重查：…（60 秒窗口）」——既无原因也无次数。
 *
 * 本模块把「查哪些平台」「失败后多久再查」「何时放弃」抽成**纯函数**（仿 icon-detect.mjs 范式），
 * 便于 node:test 直接单测；run-bridge.mjs 只做 I/O 与调度。
 *
 * 规则（用户口径，2026-09-12 二次定稿 = 模型 A：单列「勾选 = 推送 + 检查」）：
 *   checkSet = 勾选集（config.platforms.default）
 *   - 勾上的平台自动检查；没勾的不自动查，需要时用「🔍 查一下」/「立即检查平台状态」按需查。
 *   - default 为空（或全被过滤掉）→ 回退全量（mode='fallback-all'），避免"什么都不查"。
 *   - 手动「刷新状态」走全量、单平台「查一下」走单点，都不受本模块的重查约束。
 *   - 微信/抖音可勾选，但它们的勾选只表示"纳入检查"（见 platform-ids.CHECK_ONLY_PLATFORMS），
 *     派发不受影响——那是派发侧的事，与本模块无关。
 */
import { TARGET_PLATFORMS, CHECK_ONLY_PLATFORMS } from '../crosspost-runtime/src/platform-ids.mjs'

export { CHECK_ONLY_PLATFORMS, TARGET_PLATFORMS }

/** 平台状态文件结构版本（字段不兼容时靠它迁移） */
export const STATE_VERSION = 1

/** 首批重试延迟（连续失败 0 次起）：沿用历史默认 60 秒 */
export const DEFAULT_FAIL_RETRY_MS = 60_000
/** 退避阶梯：连续失败 ≥ afterFails 次后，重试间隔改为 retryMs（取满足条件的最后一档） */
export const FAIL_BACKOFF_STEPS = [
  { afterFails: 0, retryMs: 60_000 },
  { afterFails: 3, retryMs: 300_000 },
  { afterFails: 10, retryMs: 1_800_000 },
]
/** 失败持续超过该时长仍无一次成功 → 置 needs_login 并停止自动重查（可由手动「再查一次」唤醒） */
export const GIVE_UP_AFTER_MS = 24 * 3600_000

/**
 * 规范化平台 id 列表：过滤未知 id、去重，并按 allPlatforms 的顺序输出
 * （顺序稳定 = 日志与 /proxy/status 输出可对比）
 */
export function normalizeIds(ids, allPlatforms = TARGET_PLATFORMS) {
  const allowed = new Set(allPlatforms)
  const seen = new Set()
  for (const raw of ids || []) {
    const id = String(raw || '').trim()
    if (id && allowed.has(id)) seen.add(id)
  }
  return allPlatforms.filter((id) => seen.has(id))
}

/**
 * 解析本轮检查范围（模型 A：勾选集就是检查集）。
 * @param {{defaults?: string[], allPlatforms?: string[]}} input
 * @returns {{ids: string[], mode: 'scoped'|'fallback-all', excluded: string[], checkOnly: string[]}}
 *   checkOnly = 勾选集里那类"只检查、不派发"的平台（微信/抖音），供面板提示与派发侧参考
 */
export function resolveCheckSet({ defaults, allPlatforms = TARGET_PLATFORMS } = {}) {
  const all = [...allPlatforms]
  const keep = new Set(normalizeIds(defaults, all))
  const ids = all.filter((id) => keep.has(id))
  const checkOnly = ids.filter((id) => CHECK_ONLY_PLATFORMS.includes(id))
  if (!ids.length) {
    // 兜底：一个平台都没勾（或配置里全是未知 id）→ 全量检查，卡片会标注这是回退
    return { ids: all, mode: 'fallback-all', excluded: [], checkOnly }
  }
  return {
    ids,
    mode: 'scoped',
    excluded: all.filter((id) => !keep.has(id)),
    checkOnly,
  }
}

/**
 * 跨层解析检查范围（v2.106.2）：**引擎级 ∪ 各项目覆盖层**。
 *
 * 为什么需要（一次真实的"面板说 2、Console 说 12"）：
 *   检查范围原来取 `readFullRuntimeConfig()` = 引擎 config + **当前上下文**的项目覆盖层。
 *   而后台 tick（定时器）与浏览器扩展面板的查询**都没有项目上下文**，于是只剩引擎级那份 ——
 *   实测引擎级 `platforms.default` 就是 2026-09-12 那次迁移补进去的 `['weixin','douyin']`，
 *   于是"检查范围 2/27、未勾选 25 个"；而 Console（带项目头）与派发侧看到的是项目覆盖层的 12 个。
 *
 * 为什么"并集"而不是"跟着当前项目"：**平台登录态是机器/浏览器级事实** ——
 * 同一个部署在同一台浏览器上，该确认哪些平台的登录态必须有**唯一确定**的答案，
 * 否则同一条链路会因为"谁在问"而给出不同范围（那正是这个 bug）。
 * 并集只增不减：任何一层配置过的平台都不会漏检。
 *
 * @param {{engineDefaults?: string[], projectDefaults?: string[], allPlatforms?: string[]}} input
 */
export function resolveScopeFromLayers({
  engineDefaults,
  projectDefaults,
  allPlatforms = TARGET_PLATFORMS,
} = {}) {
  return resolveCheckSet({
    defaults: [...(engineDefaults || []), ...(projectDefaults || [])],
    allPlatforms,
  })
}

/** 连续失败 N 次后的重试间隔（退避阶梯取"最后一档满足 afterFails<=N"） */
export function retryDelayFor(consecutiveFails, steps = FAIL_BACKOFF_STEPS) {
  let ms = steps[0]?.retryMs ?? DEFAULT_FAIL_RETRY_MS
  for (const s of steps) {
    if (consecutiveFails >= s.afterFails) ms = s.retryMs
  }
  return ms
}

/** 空状态 */
export function emptyState() {
  return { version: STATE_VERSION, platforms: {} }
}

/**
 * 用一次检查结果更新平台状态（纯函数，返回新对象）。
 * @param {object} state 上一次次状态（可为 undefined）
 * @param {Array<{id:string,isAuthenticated:boolean,error?:string|null}>} results 本次实际检查到的平台
 * @param {number} now
 * @param {{giveUpAfterMs?:number, steps?:Array<{afterFails:number,retryMs:number}>}} [opts]
 */
export function applyCheckResults(state, results, now, opts = {}) {
  const giveUpAfterMs = opts.giveUpAfterMs ?? GIVE_UP_AFTER_MS
  const steps = opts.steps ?? FAIL_BACKOFF_STEPS
  const next = {
    version: STATE_VERSION,
    platforms: { ...((state && state.platforms) || {}) },
  }
  for (const r of results || []) {
    if (!r || !r.id) continue
    const prev = next.platforms[r.id] || {}
    if (r.isAuthenticated) {
      next.platforms[r.id] = {
        status: 'ok',
        consecutiveFails: 0,
        failingSince: null,
        lastAuthAt: now,
        lastFailAt: null,
        lastCheckedAt: now,
        nextRetryAt: null,
        lastError: null,
      }
      continue
    }
    const consecutiveFails = (prev.consecutiveFails || 0) + 1
    const failingSince = prev.failingSince || now
    const giveUp = now - failingSince >= giveUpAfterMs
    next.platforms[r.id] = {
      status: giveUp ? 'needs_login' : 'retry',
      consecutiveFails,
      failingSince,
      lastAuthAt: prev.lastAuthAt ?? null,
      lastFailAt: now,
      lastCheckedAt: now,
      // 终态不再自动重查；唤醒方式是手动「再查一次」或范围重新纳入
      nextRetryAt: giveUp ? null : now + retryDelayFor(consecutiveFails, steps),
      lastError: r.error ? String(r.error).slice(0, 200) : null,
    }
  }
  return next
}

/** 丢弃不在检查范围内的平台状态（用户改了勾选后调用，避免陈旧计数影响重新纳入时的判断） */
export function pruneState(state, ids) {
  const keep = new Set(ids || [])
  const platforms = {}
  for (const [id, v] of Object.entries((state && state.platforms) || {})) {
    if (keep.has(id)) platforms[id] = v
  }
  return { version: STATE_VERSION, platforms }
}

/** 到期该重查的失败平台（受 checkSet 限制；needs_login 终态不再返回） */
export function selectRetryIds({ state, checkSet, now, ids }) {
  const scope = new Set(checkSet || ids || [])
  const out = []
  for (const [id, v] of Object.entries((state && state.platforms) || {})) {
    if (!scope.has(id)) continue
    if (v.status !== 'retry') continue
    if (v.nextRetryAt != null && now < v.nextRetryAt) continue
    out.push(id)
  }
  return out
}

/** 失败中（含未到重试时间的）与已放弃的平台，供状态卡展示 */
export function selectFailures({ state, checkSet, ids }) {
  const scope = new Set(checkSet || ids || [])
  const retry = []
  const needsLogin = []
  for (const [id, v] of Object.entries((state && state.platforms) || {})) {
    if (!scope.has(id)) continue
    if (v.status === 'retry') retry.push(id)
    else if (v.status === 'needs_login') needsLogin.push(id)
  }
  return { retry, needsLogin }
}

/** 供 Console 展示的失败明细（不含内部字段） */
export function failedDetails({ state, checkSet, ids, now }) {
  const scope = new Set(checkSet || ids || [])
  const out = []
  for (const [id, v] of Object.entries((state && state.platforms) || {})) {
    if (!scope.has(id) || (v.status !== 'retry' && v.status !== 'needs_login')) continue
    out.push({
      id,
      status: v.status,
      consecutiveFails: v.consecutiveFails || 0,
      lastAuthAt: v.lastAuthAt ?? null,
      lastFailAt: v.lastFailAt ?? null,
      nextRetryAt: v.nextRetryAt ?? null,
      lastError: v.lastError || null,
      retryInMs: v.nextRetryAt != null ? Math.max(0, v.nextRetryAt - now) : null,
    })
  }
  return out
}

/**
 * 已登录过的平台 id 集合（供锁定平台纳入判断 + 发布成功后回填）。
 * @param {Array<{id:string,status?:string,isAuthenticated?:boolean}>} results
 */
export function authedIdsFrom(results) {
  const out = []
  for (const r of results || []) {
    if (!r || !r.id) continue
    if (r.isAuthenticated || r.status === 'ok') out.push(r.id)
  }
  return out
}
