// Console 常量（2026-08-24 app.js 拆分 Phase 0）
export const API = '' // 同源（bridge 托管 9540）

// 硬编码默认平台（2026-08-22：仅作为 config 未加载时的回退；真实默认以 config.json platforms.default 为准）
// 2026-09-01：与 crosspost-runtime/src/commands/publish.mjs 的 DEFAULT_PLATFORMS 保持一致（增删平台同步改）
export const DEFAULT_PLATFORMS = [
  'toutiao',
  'baijiahao',
  'xiaohongshu',
  'zhihu',
  'yidian',
  'dayu',
  'csdn',
  'jianshu',
  'smzdm',
  'juejin',
  'cto51',
]

// 全部 27 平台（顺序同 crosspost TARGET_PLATFORMS）
export const PANEL_PLATFORMS = [
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

// 「仅检查」平台说明（2026-09-12 模型 A）：它们**可勾选**，但勾选只表示纳入登录状态检查，
// 不参与通用多平台派发（微信走官方草稿通道、抖音走专用推送按钮）。
// 键与 crosspost-runtime/src/platform-ids.mjs 的 CHECK_ONLY_PLATFORMS 由契约测试锁死。
export const PF_LOCKED = { weixin: '仅检查·微信走官方通道', douyin: '仅检查·抖音仅手动推送' }

// 默认推送平台分组：覆盖全部已知平台，调整分组只需改这里。
// **别在这里手写平台数量** —— 数量口径归引擎的 `src/platform-matrix.mjs`
// （这里曾经写死过 28，而真值是 27）。
export const PLATFORM_GROUPS = [
  {
    key: 'main',
    title: '主流内容平台',
    ids: [
      'toutiao',
      'baijiahao',
      'zhihu',
      'sohu',
      'netease',
      'weibo',
      'xiaohongshu',
      'yidian',
      'dayu',
    ],
  },
  {
    key: 'tech',
    title: '技术社区',
    ids: [
      'csdn',
      'juejin',
      'cto51',
      'imooc',
      'oschina',
      'segmentfault',
      'cnblogs',
      'yuque',
      'jianshu',
    ],
  },
  { key: 'finance', title: '财经 / 消费', ids: ['eastmoney', 'xueqiu', 'smzdm', 'douban'] },
  { key: 'vertical', title: '垂直 / 其他', ids: ['woshipm', 'bilibili', 'sohufocus'] },
  { key: 'locked', title: '锁定（不可选）', ids: ['weixin', 'douyin'] },
]

// 平台显示名（2026-09-01：与 crosspost-runtime/src/notify.mjs 的 PLATFORM_NAMES 保持一致）
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

export const SLOT_NAMES = {
  morning: '早报',
  hotspot: '热点①',
  noon: '深度①',
  hotspot2: '热点②',
  tips: '热点③',
  evening: '深度②',
  manual: '手动',
}

export const RISK_NAMES = {
  ad: '广告',
  investment: '投资',
  pr: '公司宣传',
  person: '人名',
  none: '正常',
  unclassified: '未分类',
}

// 分页（2026-08-20）：列表超过 PAGE_SIZE 条启用分页控件
export const PAGE_SIZE = 30
export const TOPICS_PAGE_SIZE = 40

// 评分及格线（2026-09-01 抽常量：消除 utils/settings/retained/archive 5 处魔数 68）
export const SCORE_PASS = 68
