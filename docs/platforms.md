# 平台矩阵

> **只有一个口径**：`crosspost-runtime/src/platform-matrix.mjs`。
> Console、MCP 工具描述与本文都从它派生，并由契约测试锁死
> （任何地方手写平台数量或名单都会被测试抓到）。

## 1. 分级

| 分级                 | 数量   | 含义                                                                             |
| -------------------- | ------ | -------------------------------------------------------------------------------- |
| **已支持（可勾选）** | **12** | 引擎正式支持、出现在平台勾选器里 = 默认派发 10 + 仅检查 2                        |
| 　其中「默认派发」   | 10     | `platforms.default` 的出厂默认值里包含它们，参与通用草稿派发                     |
| 　其中「仅检查」     | 2      | 只做登录态检查，**不参与通用派发**：微信公众号走官方草稿通道、抖音图文走手动推送 |
| **beta**             | 15     | 适配器存在但未纳入默认清单，需在 Console 显式勾选启用；**不承诺**发布成功        |
| **已知总数**         | 27     | 上表之外还有 0 个未分级                                                          |

## 2. 名单

**已支持 · 默认派发（10）**：`zhihu` 知乎 · `csdn` CSDN · `baijiahao` 百家号 · `toutiao` 头条 ·
`xiaohongshu` 小红书 · `yidian` 一点号 · `dayu` 大鱼号 · `smzdm` 什么值得买 ·
`juejin` 掘金 · `cto51` 51CTO

**已支持 · 仅检查（2）**：`weixin` 微信公众号 · `douyin` 抖音图文

**beta（15，需在 Console 显式启用）**：`bilibili` 哔哩哔哩 · `jianshu` 简书 · `douban` 豆瓣 ·
`xueqiu` 雪球 · `sohu` 搜狐号 · `woshipm` 人人都是产品经理 · `weibo` 微博 · `yuque` 语雀 ·
`imooc` 慕课手记 · `oschina` 开源中国 · `segmentfault` 思否 · `cnblogs` 博客园 ·
`eastmoney` 东方财富 · `netease` 网易号 · `sohufocus` 搜狐焦点

## 3. 登录态是怎么判定的

- 平台登录态是**机器级事实**，由**浏览器扩展**在真实页面里探测（cookie / 页面探针）；
- 检查**范围**是「引擎级平台设置 ∪ 各项目覆盖层」——不带项目上下文的调用方（后台 tick、扩展面板）
  与 Console 必须得到同一个答案。
- 缓存 1 小时（`platformsCacheMs`），并发 6（`platformsCheckConcurrency`），可强制刷新。
- 「未登录 0」「未检查」怎么读，见 [`troubleshooting.md`](troubleshooting.md) §4。

## 4. 加一个新平台

适配器住在 `crosspost-runtime/core/src/adapters/platforms/`，**按分级分目录**：

| 目录                 | 放什么                                   |
| -------------------- | ---------------------------------------- |
| `platforms/private/` | **默认勾选**（对外承诺支持）的平台适配器 |
| `platforms/beta/`    | 适配器存在、但未纳入默认派发的平台       |

写完在 `platforms/index.ts` 登记；平台 id / 名称 / 分级在 `platform-matrix.mjs` 一处声明，
分级决定它落在"已支持"还是"beta"，也决定 Console 与 MCP 的描述文本。
**目录必须与分级一致**——有门禁盯着这一条，开发流程见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。
