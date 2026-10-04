# 接口面：HTTP / CLI / MCP / IPC

> **CLI 是内核**：桥与 MCP 都是它的包装（桥 → `cli.mjs` 常驻子进程；MCP → `cli.mjs` 一次性子进程）。
> 所以三面看到的能力、版本、项目语义是同一套。
> 「CLI 方法 ↔ MCP 工具」的对应关系由**契约测试双向锁死**：
> 新增 CLI 方法时必须明确选择"暴露为 MCP 工具"或"登记为内部面"，不允许两面悄悄漂移
> （见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)）。

## 1. HTTP（桥，默认 `http://127.0.0.1:9540`）

| 项   | 规则                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 鉴权 | 请求头 `X-CrossPost-Token: <bridge/token.local>`。**不接受查询串**（会进日志/历史，泄露凭据）                                                      |
| 项目 | 可选请求头 `X-CrossPost-Project: <id>`；不带头 = 默认域                                                                                            |
| CORS | 仅放行 `http://127.0.0.1:<端口>`、`http://localhost:<端口>`、`chrome-extension://*`；允许头 `Content-Type, X-CrossPost-Token, X-CrossPost-Project` |
| 返回 | JSON；`sendJson(status, body)`                                                                                                                     |

路由按域分组如下（`<...>` 表示前缀匹配；完整清单与逐条实现以 `bridge/run-bridge.mjs`
的 `ROUTES` 表为准）：

| 分组        | 路由                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态 / 自检 | `GET /proxy/health`（含四条 worker 车道）· `GET /proxy/status`（版本 + 扩展 + 平台缓存 + autoPush）· `GET /proxy/doctor` · `GET /proxy/platforms`                                                                                         |
| 平台口径    | `GET /proxy/platform-matrix`（平台数量与分级的**唯一来源**）                                                                                                                                                                              |
| 项目        | `GET /proxy/projects`（注册表摘要）                                                                                                                                                                                                       |
| 配置        | `GET /proxy/config` · `POST /proxy/config`（按引擎级/项目级分层写入）                                                                                                                                                                     |
| 样式        | `GET /proxy/styles` · `POST /proxy/render` · `POST /proxy/styles-delete` · `POST /proxy/styles-rename` · `POST /proxy/styles-toggle`                                                                                                      |
| 封面 / 品牌 | `POST /proxy/cover` · `POST /proxy/cover-gallery` · `GET /proxy/cover-settings` · `POST /proxy/cover-settings` · `POST /proxy/icon`                                                                                                       |
| 内容        | `GET /proxy/articles` · `GET /proxy/articles/<id>` · `GET /proxy/draft/<id>` · `POST /proxy/save-draft` · `POST /proxy/update-draft` · `POST /proxy/delete-draft` · `POST /proxy/set-status`                                              |
| 留存 / 归档 | `GET /proxy/retained` · `POST /proxy/retained/<id>` · `POST /proxy/retain` · `GET /proxy/archive` · `POST /proxy/archive` · `POST /proxy/classify` · `POST /proxy/set-risk`                                                               |
| 发布        | `POST /proxy/publish` · `POST /proxy/publish-styled` · `POST /proxy/publish-douyin` · `POST /proxy/mark-published` · `POST /proxy/notify-test` · `POST /proxy/backfill`                                                                   |
| 调度        | `GET /proxy/schedule` · `POST /proxy/schedule` · `POST /proxy/schedule/upsert` · `POST /proxy/schedule/remove` · `POST /proxy/schedule/run` · `POST /proxy/schedule-reset`                                                                |
| 选题        | `GET /proxy/topics` · `POST /proxy/topics/generate` · `POST /proxy/topics/generate/batch` · `GET /proxy/topics/generate/tasks` · `GET /proxy/topics/generate/status` · `POST /proxy/topics/generate/cancel` · `POST /proxy/topics/delete` |
| 费用        | `GET /proxy/costs` · `GET /proxy/cost/<id>`                                                                                                                                                                                               |
| 备份        | `GET /proxy/backup` · `POST /proxy/backup`                                                                                                                                                                                                |
| 扩展直发    | `POST /proxy/request`（按扩展消息契约代发一个请求）                                                                                                                                                                                       |
| 单机素材    | `GET /console/*`（Console 静态页）· `GET /brand-icon`（自定义品牌图标，免鉴权：浏览器拉 favicon 不带 token）                                                                                                                              |

```bash
T=$(cat bridge/token.local)
curl -s localhost:9540/proxy/health  -H "X-CrossPost-Token: $T"
curl -s localhost:9540/proxy/status  -H "X-CrossPost-Token: $T"
curl -s localhost:9540/proxy/schedule -H "X-CrossPost-Token: $T" -H "X-CrossPost-Project: <id>"
```

`GET /proxy/schedule` 的关键字段：

| 字段                                                            | 含义                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `backend` / `tz` / `catchUpMaxMinutes` / `maxConcurrent`        | 定时器自身：后端（恒 `internal`）、时区、补跑窗口、并发上限                          |
| `lockHeldByUs` / `lock`                                         | 内置定时器有没有在跑（两个宿主互斥，`lock` 是持有者）                                |
| `legacyTasks`                                                   | 还留着的旧 launchd/systemd 调度任务（**双发风险**，给迁移命令）                      |
| `slots[].label`                                                 | 槽位显示名（项目配置 `name` > 声明 `name` > 模板名）：Console 各视图的栏目名唯一来源 |
| `slots[].scope` / `source`                                      | `engine`（引擎任务）或 `project`；来源 `declaration`/`config`/`template`/`engine`    |
| `slots[].commandMissing` / `commandReason`                      | 命令声明能不能解析（命令来自项目 `.crosspost/schedule.json`）                        |
| `slots[].armed` / `armedReason`                                 | 这个槽位当前会不会被触发（`no-lock` = 没宿主）                                       |
| `slots[].enabled` / `completedToday` / `unfinished` / `running` | 开关、今日是否已跑、上次是否未收尾、是否正在跑                                       |
| `slots[].next` / `nextAt` / `lastRunAt` / `daysSince`           | 下一次触发（按 `tz`）与最近一次完成（取项目日志）                                    |

`POST /proxy/schedule/run` 手动触发一次（不受"每天最多一次"限制），
沿用删除类操作的授权约定：请求体需带 `{ "slot": "<id>", "authorized": true }`。
`/proxy/schedule-reset` 的语义是**清空槽位开关覆盖**（回到 fail-open：未设 = 跑）。

## 2. CLI（`node crosspost-runtime/src/cli.mjs <method> [args…]`）

输出恒为 **stdout 单行 JSON**；出错走统一包装（`{"error":…}`）。
**50 个方法**，按域分组：

| 域          | 方法                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自检 / 环境 | `doctor` `doctorText` `setup` `proxyStatus` `proxyTest` `checkAuth` `slotEnabled`                                                                                                           |
| 项目        | `projects` `resolveProject`                                                                                                                                                                 |
| 文章 / 草稿 | `listArticles` `getArticle` `readDraft` `createDraft` `updateDraft` `deleteDraft` `setArticleStatus`                                                                                        |
| 分诊 / 留存 | `classifyArticles` `setArticleRisk` `archiveArticle` `retainArticle` `listRetained` `listArchive` `retainedAction`                                                                          |
| 发布        | `publishArticle` `syncArticle` `syncStyledArticle` `publishDouyin` `markPublished` `markAllPublished` `wechatDraft` `wechatDrafts` `wechatDraftDelete`                                      |
| 渲染 / 素材 | `listStyles` `styles` `renderPreview` `analyzeStyle` `listCoverTemplates` `generateCover` `generateCoverGallery` `generateEndingCard` `uploadImageFile` `extractArticle` `extractActiveTab` |
| 平台        | `listPlatforms` `checkAuth`                                                                                                                                                                 |
| 通知        | `notify` `notifyTest`                                                                                                                                                                       |
| 费用        | `listCosts` `articleCost` `prewarmCosts`                                                                                                                                                    |
| 其它        | `backfill`                                                                                                                                                                                  |

## 3. MCP（stdio，`crosspost-runtime/mcp-server/index.mjs`）

**22 个工具**（DSH 里名字是 `mcp__crosspost__*`）：

| 类别        | 工具                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态        | `status` `projects` `list_platforms` `check_auth` `proxy_test`                                                                                                        |
| 内容 / 发布 | `publish_article` `publish_styled` `sync_article` `wechat_draft` `wechat_draft_delete`                                                                                |
| 渲染 / 素材 | `render_preview` `list_styles` `create_style` `install_styles` `styles_rename` `styles_delete` `analyze_style` `generate_cover` `extract_article` `upload_image_file` |
| 选题库      | `topic_pool_upsert`（候选入库；行形状由 schema 约束，是 AI 会话侧的写入口。脚本/定时链路走同名的 CLI 方法，同一个实现）                                               |
| 内容质量    | `ai_detect`（朱雀 AIGC 检测；返回整体判定 + **被判 AI 的片段**及其在正文里的字符区间。见 [`ai-detect.md`](ai-detect.md)）                                             |

项目语义：`CROSSPOST_PROJECT` 在**会话级**声明一次（一进程一项目）。
**两个来源标记由 shell 注入、AI 无法自我豁免**：`WECHAT_AUTO_SCHEDULED=1`（定时链路）、
`WECHAT_AUTO_DRAFT_ONLY=1`（一键生成）——两者调用底层发布工具一律被拒。

## 4. IPC（常驻 worker）

`node crosspost-runtime/src/cli.mjs --ipc`，stdin/stdout **逐行 JSON** 请求/响应；
桥为 `reader` / `writer` / `heavy` / `costs` 四条车道路各养一个常驻子进程。
模块**只在 spawn 时加载一次** → 改了引擎代码必须重启桥（见 [`troubleshooting.md`](troubleshooting.md) §9）。
