/**
 * 平台能力矩阵 —— **平台口径的唯一来源**（v2.03）。
 *
 * 背景：改造前「平台数量/能力」有 5 个互相矛盾的口径：
 *   README 27 · MCP 工具描述硬编码"28 平台" · src/platform-ids.mjs 27 ·
 *   config.json.platforms.default 12 · preset 文案"11 平台"
 * 且平台名在 console/modules/const.mjs 与 notify.mjs 各有一份重复定义。
 *
 * 本模块是唯一权威。所有出口（Console 平台芯片、MCP 工具描述、doctor、文档表格）
 * 必须从这里派生，不得再手写数量或名单。
 *
 * 平台分级：
 *   enabled      —— 已支持：进入默认派发清单，对外承诺可用
 *   check-only   —— 可勾选但仅纳入登录检查，不参与通用派发（微信走官方草稿通道；
 *                   抖音仅走手动推送按钮）
 *   beta         —— 适配器存在但未纳入默认派发；需在 Console 显式勾选启用
 */
import { TARGET_PLATFORMS, CHECK_ONLY_PLATFORMS } from './platform-ids.mjs'

/** 已支持（进入默认派发清单；对外承诺） */
export const ENABLED_PLATFORMS = [
  'zhihu',
  'csdn',
  'weixin',
  'baijiahao',
  'toutiao',
  'xiaohongshu',
  'yidian',
  'dayu',
  'smzdm',
  'juejin',
  'cto51',
  'douyin',
]

/** 平台中文名（唯一来源；Console 与通知均从此派生） */
export const PLATFORM_NAMES = {
  zhihu: '知乎',
  csdn: 'CSDN',
  weixin: '微信公众号',
  bilibili: '哔哩哔哩',
  baijiahao: '百家号',
  toutiao: '头条',
  xiaohongshu: '小红书',
  jianshu: '简书',
  yidian: '一点号',
  dayu: '大鱼号',
  smzdm: '什么值得买',
  douban: '豆瓣',
  xueqiu: '雪球',
  sohu: '搜狐号',
  woshipm: '人人都是产品经理',
  juejin: '掘金',
  weibo: '微博',
  yuque: '语雀',
  cto51: '51CTO',
  imooc: '慕课手记',
  oschina: '开源中国',
  segmentfault: '思否',
  cnblogs: '博客园',
  eastmoney: '东方财富',
  douyin: '抖音图文',
  netease: '网易号',
  sohufocus: '搜狐焦点',
}

/** check-only 平台的原因（供 UI 直接展示，避免只显示"未登录"） */
export const CHECK_ONLY_REASONS = {
  weixin: '仅检查 · 草稿走微信官方通道',
  douyin: '仅检查 · 仅手动推送',
}

export function platformName(id) {
  return PLATFORM_NAMES[id] || id
}

/**
 * 平台分级：enabled | check-only | beta
 * 注意 check-only 优先于 enabled —— 微信/抖音在默认清单里，但派发语义特殊。
 */
export function platformTier(id) {
  if (CHECK_ONLY_PLATFORMS.includes(id)) return 'check-only'
  if (ENABLED_PLATFORMS.includes(id)) return 'enabled'
  return 'beta'
}

/** 单个平台的完整条目 */
export function platformEntry(id) {
  const tier = platformTier(id)
  return {
    id,
    name: platformName(id),
    tier,
    /** 是否进入默认派发清单 */
    defaultDispatch: tier === 'enabled',
    /** 是否可勾选（全部可勾选；仅语义不同） */
    selectable: true,
    ...(tier === 'check-only' ? { note: CHECK_ONLY_REASONS[id] || '仅检查' } : {}),
    ...(tier === 'beta' ? { note: '需在 Console 显式勾选启用' } : {}),
  }
}

/**
 * 完整矩阵（顺序同 TARGET_PLATFORMS，保持历史稳定）。
 * `counts` 使调用方无需再手写任何数量。
 */
export function buildPlatformMatrix() {
  const platforms = TARGET_PLATFORMS.map(platformEntry)
  const byTier = { enabled: 0, 'check-only': 0, beta: 0 }
  for (const p of platforms) byTier[p.tier]++
  return {
    version: 1,
    platforms,
    /** 默认派发清单（= config.json.platforms.default 应等于的值） */
    defaultDispatch: ENABLED_PLATFORMS.filter((id) => !CHECK_ONLY_PLATFORMS.includes(id)),
    /** 默认勾选（含仅检查平台） */
    defaultSelected: ENABLED_PLATFORMS,
    counts: {
      /** 全部已知适配器 */
      all: platforms.length,
      /** 已支持（对外承诺；= 默认派发 + 仅检查） */
      enabled: byTier.enabled,
      'check-only': byTier['check-only'],
      beta: byTier.beta,
      /** 默认派发 */
      defaultDispatch: ENABLED_PLATFORMS.filter((id) => !CHECK_ONLY_PLATFORMS.includes(id)).length,
    },
    /** 供 UI 文案直接使用的一句话口径（禁止各处手写） */
    summary: `${ENABLED_PLATFORMS.length} 个已支持平台（另有 ${byTier.beta} 个 beta，需手动启用）`,
  }
}

/** 供 MCP 工具描述等使用的一句话（替代原先硬编码的"28 平台"） */
export function platformCountPhrase() {
  const m = buildPlatformMatrix()
  // 措辞刻意避开"已支持"：那个词在矩阵里专指 12 个**可勾选**平台，而这里是全部 27 个已知平台。
  return `${m.counts.all} 个已知平台（默认派发 ${m.counts.defaultDispatch} 个）`
}
