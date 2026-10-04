// 共享状态 store（2026-08-24 app.js 拆分 Phase 0）
// 普通对象（非响应式）：视图读写 store.x，写后手动重渲染，与拆分前行为一致
import { DEFAULT_PLATFORMS } from './const.mjs'
import { getJSON } from './api.mjs'

export const store = {
  // 平台默认配置
  configuredDefaults: null,
  defaultsPromise: null,
  platformAuth: {}, // id -> isAuthenticated（登录状态缓存，设置页/详情 chips 用）
  platformErrors: {}, // id -> 未登录原因（2026-09-12：此前 applyAuthPayload 把 error 整包丢掉，界面只能说"未登录"）
  // 平台状态元信息（2026-09-11：/proxy/platforms 变纯缓存读后，用这些字段区分"未知/检查中"与"未登录"）
  platformsCheckedAt: null,
  platformsFullAt: null, // 范围检查完成时间（与 checkedAt 区分：失败重查只推进 checkedAt）
  platformsRefreshing: false,
  platformsInit: true,
  platformsFailedRetryIds: [], // 失败中的平台（在检查范围内、当前未登录）
  platformsNeedsLoginIds: [], // 已放弃自动重查的失败平台（24h 无成功 → 需重新登录）
  platformsFailedDetail: [], // 失败明细：{id,status,consecutiveFails,lastAuthAt,lastFailAt,nextRetryAt,lastError,retryInMs}
  // 检查范围（2026-09-12）：只查「设置页默认推送平台 ∪ 锁定(曾登录)」
  platformsScope: null, // {ids,mode,excluded,lockedInScope,locked,all,count}
  extClient: null, // 代理来源身份 {clientId,ua,version,connectedAt}
  autoPushEnabled: false, // 「生成后自动推送」开关状态（来自 /proxy/status.autoPush；手动推送不受其影响）
  // 平台状态订阅者（检查完成后通知详情 chips / 平台网格重渲染）
  platformAuthSubs: new Set(),
  authPromise: null,
  // 文章列表
  articles: [],
  articlePage: 1,
  selected: new Set(), // P6 批量操作选中
  // 详情抽屉
  detail: { id: null, record: null, draft: null },
  selectedPlatforms: new Set(),
  previewTimer: null,
  // 选题库
  topics: [],
  topicsPage: 1,
  topicsFilter: { slot: '', status: '', date: '', q: '' },
  // 一键生成任务（v2.111 队列）：taskId → 任务；`topicTaskOf` 是 (slot|keyword) → taskId 反查
  topicTasks: {},
  topicTaskOf: {},
  topicGenPoll: null, // 逐条任务轮询定时器（无活动任务时即清）
  topicGenDone: true, // 本轮生成是否已收尾（true=可以停表；入队时清零以重新守望）
  topicGenPending: false, // 刚入队、任务还没落表的那 4 秒空窗（此时不能停表）
  topicGenPolling: false, // 这一拍轮询是否还在进行（收尾含全量刷新，可能超过 4s）
  topicBannerTick: null, // 汇总条"已运行 mm:ss"的秒级刷新
  topicGenProvided: true,
  topicGenProvider: null,
  topicGenUnavailable: null,
  topicGenMaxConcurrency: 1,
  // 留存库
  retained: [],
  retainedPage: 1,
  // 归档库
  archived: [],
  archivePage: 1,
  // 设置
  scheduleData: null,
  settingsLoaded: false,
  settingsPoll: null, // 设置页状态轮询定时器（离开视图即清）
  platformsPollMs: 60000, // 状态轮询间隔（来自 /proxy/status.platforms.pollMs，设置页可配）
  // 补记面板
  markSelected: new Set(),
  // 编写工作台（2026-09-05）
  editor: {
    id: null, // 编辑中的草稿 id（新建为 null）
    draft: null, // 回填的草稿数据（title/slot/date/markdown）
    style: 'swiss',
    editor: null, // CM6 createEditor 返回的句柄
    timer: null, // 预览 debounce
    dirty: false, // 有未保存改动
    fromView: 'articles',
    blocks: [], // 预览块映射 [{startLine,endLine,type}]，来自 /proxy/render
    syncOn: true, // 滚动/选区同步开关
  },
}

export function getDefaultPlatforms() {
  return store.configuredDefaults && store.configuredDefaults.length
    ? store.configuredDefaults
    : DEFAULT_PLATFORMS
}

/** 确保配置默认平台已加载（未进设置页时兜底拉取 /proxy/config） */
export async function ensureDefaults() {
  if (store.configuredDefaults) return
  if (!store.defaultsPromise) {
    store.defaultsPromise = getJSON('/proxy/config')
      .then((cfg) => {
        const list = cfg && cfg.platforms && cfg.platforms.default
        if (list && list.length) store.configuredDefaults = [...list]
        return store.configuredDefaults
      })
      .catch(() => null)
      .finally(() => {
        store.defaultsPromise = null
      })
  }
  await store.defaultsPromise
}

/** 登录状态懒加载（详情页 chips 角标用；设置页加载后即有）
 *  2026-09-11：改为**永不阻塞**——bridge 侧 /proxy/platforms 已是纯缓存直读，
 *  冷启动返回 init=true（空集合 + 后台检查中），这里立即落库并触发后台补拉。 */
export async function ensurePlatformAuth() {
  if (store.authPromise) return store.authPromise
  store.authPromise = refreshPlatformAuth().finally(() => {
    store.authPromise = null
  })
  return store.authPromise
}

/** 拉取平台登录状态（返回即用；完成后通知订阅者重渲染徽标） */
export async function refreshPlatformAuth() {
  try {
    const plats = await getJSON('/proxy/platforms')
    applyAuthPayload(plats)
  } catch {
    /* 失败保持旧值，角标显示未知 */
  }
}

/** 写入 /proxy/platforms 结果（数组 + 检查元信息）并广播 */
export function applyAuthPayload(plats) {
  if (!plats || !Array.isArray(plats.platforms)) return
  if (!plats.init) {
    const next = {}
    const errs = {}
    for (const p of plats.platforms) {
      next[p.id] = !!p.isAuthenticated
      errs[p.id] = p.error || null
    }
    store.platformAuth = next
    store.platformErrors = errs
  }
  store.platformsCheckedAt = plats.checkedAt || store.platformsCheckedAt
  store.platformsRefreshing = !!plats.refreshing
  store.platformsInit = !!plats.init
  notifyPlatformAuth()
}

/** 写入 /proxy/status.platforms 检查元信息（不发列表，只更新"检查中/上次检查"状态）
 *  有实质变化才广播，避免状态轮询造成无意义重渲染 */
export function applyStatusMeta(meta) {
  if (!meta || typeof meta !== 'object') return
  let changed = false
  if (typeof meta.checkedAt === 'number' && meta.checkedAt !== store.platformsCheckedAt) {
    store.platformsCheckedAt = meta.checkedAt
    changed = true
  }
  for (const [key, field] of [
    ['refreshing', 'platformsRefreshing'],
    ['init', 'platformsInit'],
  ]) {
    if (typeof meta[key] === 'boolean' && meta[key] !== store[field]) {
      store[field] = meta[key]
      changed = true
    }
  }
  if (typeof meta.pollMs === 'number' && meta.pollMs > 0) store.platformsPollMs = meta.pollMs
  // 2026-09-11：失败平台重查窗口也参与"有实质变化才重渲染"（状态卡会展示这组 id）
  if (Array.isArray(meta.failedRetryIds)) {
    const next = meta.failedRetryIds.join(',')
    if (next !== (store.platformsFailedRetryIds || []).join(',')) {
      store.platformsFailedRetryIds = [...meta.failedRetryIds]
      changed = true
    }
  }
  // 2026-09-12：检查范围 / 失败明细 / 终态 / 代理来源身份
  if (Array.isArray(meta.needsLoginIds)) store.platformsNeedsLoginIds = [...meta.needsLoginIds]
  if (Array.isArray(meta.failedDetail)) store.platformsFailedDetail = meta.failedDetail
  if (meta.scope && typeof meta.scope === 'object') {
    const next = (meta.scope.ids || []).join(',')
    if (next !== ((store.platformsScope && store.platformsScope.ids) || []).join(',')) {
      store.platformsScope = meta.scope
      changed = true
    } else {
      store.platformsScope = meta.scope
    }
  }
  if (typeof meta.at === 'number' && meta.at !== store.platformsFullAt) {
    store.platformsFullAt = meta.at
    changed = true
  }
  if (changed) notifyPlatformAuth()
}

/** 写入 /proxy/status.ext 元信息（2026-09-12：代理来源身份 = 哪个浏览器在替你发请求） */
export function applyExtMeta(ext) {
  if (!ext || typeof ext !== 'object') return
  if (ext.client && typeof ext.client === 'object') store.extClient = ext.client
}

function notifyPlatformAuth() {
  for (const cb of store.platformAuthSubs) {
    try {
      cb()
    } catch {
      /* 单个订阅者异常不影响其它 */
    }
  }
}

/** 订阅平台状态变化（返回取消订阅函数） */
export function onPlatformAuthChange(cb) {
  store.platformAuthSubs.add(cb)
  return () => store.platformAuthSubs.delete(cb)
}
