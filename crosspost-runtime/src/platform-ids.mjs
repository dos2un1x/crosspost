/**
 * 平台 ID 单一来源（2026-08-24 统一工具面）：
 * cli/adapters（platforms.mjs）、preset 插件（crosspost.js NATIVE_WHITELIST）共用，
 * 避免两处列表漂移。
 */
export const TARGET_PLATFORMS = [
  'zhihu',
  'csdn',
  'weixin',
  'bilibili',
  'baijiahao',
  'toutiao',
  'xiaohongshu',
  'jianshu',
  'yidian',
  'dayu',
  'smzdm',
  'douban',
  'xueqiu',
  'sohu',
  'woshipm',
  'juejin',
  'weibo',
  'yuque',
  'cto51',
  'imooc',
  'oschina',
  'segmentfault',
  'cnblogs',
  'eastmoney',
  'douyin',
  'netease',
  'sohufocus',
]

/**
 * 「仅检查」平台（2026-09-12 二次定稿）：勾选它们 = **只纳入登录状态检查**，不进通用多平台派发。
 *
 *   - 微信：草稿走官方通道（抽屉里的「微信草稿」复选框 / autoPush.includeWechat），
 *     通用派发再走一遍 mp.weixin 浏览器通道会产生第二份草稿，因此排除。
 *   - 抖音：publish.mjs 的抖音铁律本就把它从自动派发里剔除（仅手动 publishDouyin 入口放行）。
 *
 * 生效点（三处必须一致，由 platform-ids-contract.test.mjs 锁死）：
 *   1) publish.mjs resolvePublishConfig 的 **config 默认分支**（显式传参不受影响）
 *   2) Console 抽屉平台芯片（微信/抖音不在「重推到所选平台」里）
 *   3) Console 设置页徽标文案「勾选仅纳入检查」
 */
export const CHECK_ONLY_PLATFORMS = ['weixin', 'douyin']

/** @deprecated 旧名（2026-09-12 上一版的"锁定平台"含义已作废）；保留一个版本避免外部引用断裂 */
export const LOCKED_PLATFORMS = CHECK_ONLY_PLATFORMS
