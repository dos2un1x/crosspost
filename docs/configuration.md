# 配置

> 生效值 = **引擎级配置** 深合并 **项目覆盖层**。分类是**白名单**：只有
> `PROJECT_KEYS` 里的键能由项目覆盖，其余一律算引擎级
> （防御：新增的键不该悄悄落到某个项目里，更不该让项目改到引擎行为）。
> 键名与默认值以 `defaultConfig()` 为准，本文只解释它们。

## 1. 两个配置文件

| 层     | 路径                                                            | 谁写                                                           |
| ------ | --------------------------------------------------------------- | -------------------------------------------------------------- |
| 引擎级 | `crosspost-runtime/config.json`（可用 `CROSSPOST_CONFIG` 覆盖） | 桥是唯一写者；`npm run setup` 生成初始值（**已存在则不覆盖**） |
| 项目级 | `<引擎本地数据根>/project-state/<项目 id>/config.json`          | 桥；按项目隔离                                                 |

决定"有哪些项目"的键（`projectsDirs` / `projects`）**永远**取自引擎文件——
否则一个项目就能改写注册表（还会造成解析递归）。
默认域（未选项目）下写项目级键 = 写进引擎 config，语义是"所有项目共用的默认值"。

## 2. 引擎级键

`defaultConfig()` 生成的初始内容既含引擎级键，也含**项目级键的出厂默认值**
（项目没覆盖时用它们）。

| 键                                     | 默认                 | 说明                                                                                                                                                |
| -------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxyMode`                            | `true`               | 走浏览器代理通道（**唯一的出口**；无中转服务器）                                                                                                    |
| `proxyHost` / `proxyHttpPort`          | `127.0.0.1` / `9540` | 桥的监听地址与端口（Console 也在同一个端口）                                                                                                        |
| `timeoutMs`                            | `150000`             | 单次引擎调用超时                                                                                                                                    |
| `platformsCacheMs`                     | `3600000`            | 平台登录态缓存时长（1 小时）                                                                                                                        |
| `platformsCheckConcurrency`            | `6`                  | 平台登录态并发探测数                                                                                                                                |
| `concurrency`                          | `3`                  | 发布并发数                                                                                                                                          |
| `projectsDirs`                         | `[]`                 | 项目注册表**扫描根**（本机部署才会写具体值）                                                                                                        |
| `scheduler.tz`                         | `Asia/Shanghai`      | 槽位时间按哪个时区解释（与宿主机本地时区无关，见 [`scheduling.md`](scheduling.md)）                                                                 |
| `scheduler.catchUpMaxMinutes`          | `120`                | 补跑窗口（分钟）；`0` = 不补跑                                                                                                                      |
| `scheduler.maxConcurrent`              | `2`                  | 同时最多跑几个槽位                                                                                                                                  |
| `slotExecutor.allowHosts`              | `[]`                 | 槽位 HTTP 执行器允许的**非环回**主机（缺省只允许环回）                                                                                              |
| `slotExecutor.allowRemote`             | `false`              | 放开环回限制（与 `allowHosts` 二选一，见 [`scheduling.md`](scheduling.md) §4b）                                                                     |
| `topicsGenerateMaxConcurrency`         | `1`                  | 「一键生成」队列的同时执行数（**夹取到 1–5**）；默认 1 = 串行，调大前必须先放开项目侧的两处锁，见 [`writing-pipelines.md`](writing-pipelines.md) §9 |
| `topicsGenerateQueueMax`               | `50`                 | 队列容量（含正在跑的；夹取到 1–200），超出直接拒绝而不是无限堆积                                                                                    |
| `adapters.backfillFromRunLogs.enabled` | `false`              | 从运行日志回填；Console 没有入口暴露它                                                                                                              |

**「一键生成」的两个键都是引擎级**（不属于项目白名单）：队列与并发是引擎在编排，
换项目不该让队列形状跟着变。临时调参可以用环境变量
`CROSSPOST_TOPIC_GEN_MAX_CONCURRENCY=<1–5>` 覆盖并发（优先于配置）。

## 3. 项目级键（白名单，9 个）

| 键                  | 形状                                                                                           | 说明                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `schedule`          | `{ <槽位>: bool }`                                                                             | 槽位门禁（`false` 即不跑）                                                        |
| `slots`             | `[{id,name,time,enabled}]`                                                                     | **槽位定义**：id/名称/时间/开关（**命令**在项目的 `.crosspost/schedule.json` 里） |
| `platforms.default` | `string[]`                                                                                     | 这个项目推哪些平台                                                                |
| `notify`            | `{enabled,channel,webhookUrl,webhookType,larkChatId,larkBin,template}`                         | 通知发到哪                                                                        |
| `scoring`           | `{threshold,investment:{strong[],weak[]}}`                                                     | 评分阈值与投资类信号词                                                            |
| `branding`          | `{name,icon}`                                                                                  | 品牌素材                                                                          |
| `coverSettings`     | `{defaultTemplate,endingTemplate,disabledTemplates,coverEnabled,endingCardEnabled,endingText}` | 封面/结束语                                                                       |
| `styles`            | `{disabled[], perSlot}`                                                                        | 样式启用清单 + **每栏默认样式**（`perSlot = { "<栏目 id>": "<样式名>" }`）        |
| `autoPush`          | `{enabled}`                                                                                    | 生成后自动推送；**关着时链路只存草稿**（是开关，不是绕过总开关的捷径）            |

**槽位的默认时间**：`morning 08:10` · `hotspot 08:30` · `noon 12:30` · `hotspot2 13:10` · `tips 18:10` · `evening 20:30`。

**样式解析顺序**（发布一篇草稿时）：请求传入 > 草稿 frontmatter 的 `style` > `styles.perSlot[该栏目]` >
引擎内建的栏目映射 > `swiss`。命中的样式被禁用或不存在时回退 `swiss` 并记一条 warning。
`perSlot` 是**项目级**键，所以每条写作流水线都能给自己的栏目配自己的默认样式
（`{"perSlot": {"newsletter": "editorial"}}`）。

**自定义样式住在** `~/.config/crosspost/styles/`（一个样式一个 JSON 文件，文件名即样式名）。
它是"同一套样式参数的覆盖集"：只写你要覆盖的字段即可，其余用缺省值；引擎在渲染时由这些参数推导出
每个元素的 inline style。可用 `CROSSPOST_CUSTOM_STYLES_DIR` 换目录（测试/容器用）。

**起手样式包**：仓库自带 55 个成稿样式（`crosspost-runtime/styles/`）。装进你的样式目录：

```bash
node crosspost-runtime/src/cli.mjs styles install        # 装仓库自带那一包（逐个校验，已存在的跳过）
node crosspost-runtime/src/cli.mjs styles install <目录>  # 装任意一包；也可指向旧样式目录做一次性迁移
```

- 装完**不必重启**：样式是运行时读盘的，目录变了就重扫；刷新 Console 即出现在样式下拉里
  （是否出现在下拉里还受 `styles.disabled` 影响）。
- `--dry` 只报告不写盘（校验规则与真装一致）；`--force` 覆盖同名样式。
- 旧格式（`border_width` / `headingStyle` / `blockquote_bg` 这类旧拼写、已废弃的 `cssTemplate`、
  颜色字段里的 `!important` 与渐变）会被自动翻译/规整，命令逐条报告改了什么、哪条过不了校验。
- MCP 侧同一个能力叫 `install_styles`（`{dir?, force?, dryRun?}`）。

## 4. 环境变量（`CROSSPOST_*`）

优先级**一律是：项目 > 环境变量 > `paths.json` > 内置默认**。
在项目上下文里，环境变量**不再能**把项目资源指到别处——那正是"项目之间必须独立"的含义；
要隔离测试，请把项目的 `dataDir` 放进临时目录。

| 变量                                                                                                                                                        | 作用                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `CROSSPOST_CONFIG`                                                                                                                                          | 覆盖 config.json 路径（沙箱/测试用；**桥与引擎共用同一条规则**）                                       |
| `CROSSPOST_PATHS`                                                                                                                                           | 覆盖 `paths.json` 路径                                                                                 |
| `CROSSPOST_LOCAL_ROOT`                                                                                                                                      | 引擎本地数据根（隔离测试**必须**连它一起隔离）                                                         |
| `CROSSPOST_PROJECT`                                                                                                                                         | 项目上下文（MCP 是"一进程一项目"，会话级声明一次）                                                     |
| `CROSSPOST_PROJECTS_DIR` / `CROSSPOST_PROJECTS_DIRS`                                                                                                        | 项目注册表扫描根（单个 / 多个）                                                                        |
| `CROSSPOST_DRAFTS_DIR` · `CROSSPOST_ARTICLES_DIR` · `CROSSPOST_HISTORY_DIR` · `CROSSPOST_LOGS_DIR` · `CROSSPOST_TOPIC_POOL` · `CROSSPOST_ARTICLE_COST_FILE` | **默认域**的资源位置覆盖                                                                               |
| `CROSSPOST_SESSIONS_DIRS`                                                                                                                                   | Claude/DSH 会话目录（费用报表用）                                                                      |
| `CROSSPOST_SCHEDULER_DIR`                                                                                                                                   | 调度数据目录（运行记录 + 锁；缺省 `<localRoot>/scheduler`）                                            |
| `CROSSPOST_SCHEDULER_TZ`                                                                                                                                    | 覆盖 `config.scheduler.tz`                                                                             |
| `CROSSPOST_SCHEDULER_DISABLE`                                                                                                                               | 设 `1` 时宿主不启动定时器（诊断用）                                                                    |
| `CROSSPOST_LEGACY_TASKS_DIR` / `CROSSPOST_LEGACY_SYSTEMD_DIR`                                                                                               | 旧系统任务的**只读检测**目录（测试/迁移用；缺省 `~/Library/LaunchAgents` 与 `~/.config/systemd/user`） |
| `CROSSPOST_NODE` / `CROSSPOST_CLI_PATH`                                                                                                                     | 守护脚本与 MCP 子进程用的 node 与 CLI 路径                                                             |
| `CROSSPOST_PLATFORMS_STATE_PATH` / `CROSSPOST_EVER_AUTHED_PATH`                                                                                             | 平台登录态的落盘位置                                                                                   |
| `CROSSPOST_HOST_GATEWAY`                                                                                                                                    | 容器模式：把项目声明的**回环**主机名重写成它（缺省 `host.docker.internal`）                            |
| `CROSSPOST_DISABLE_RECORD_CACHE`                                                                                                                            | 关掉记录快照缓存（排障开关：功能仍正确，只是每次全量读）                                               |
| `CROSSPOST_START_TS`                                                                                                                                        | 进程启动时间戳（内部用）                                                                               |

链路来源标记（**不是配置**，由 shell 注入、AI 无法自我豁免）：
`WECHAT_AUTO_SCHEDULED=1`（定时链路）、`WECHAT_AUTO_DRAFT_ONLY=1`（一键生成）——
两者一律被底层发布工具拒绝。

## 5. 路径配置（`paths.json`，机器级）

| 键                                         | 含义                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| `localRoot`                                | 引擎本地数据根（`.local/`）                            |
| `draftsDir` / `articlesDir`                | 默认域的草稿与记录目录                                 |
| `logsDir` / `historyDir` / `topicPoolFile` | 默认域的日志、历史、选题池                             |
| `sessionsDirs`                             | 会话目录（机器级：`setup` 默认生成 `~/.dsh/sessions`） |
| `bridgeScript` / `workspace` / `tokenFile` | 桥的入口脚本、工作目录与本地 API token 位置            |

> 项目域**不读**这里的资源键：项目资源由 manifest 的 `dataDir` 推导（见 [`integration.md`](integration.md)）。
> `@crosspost/core` **没有独立依赖树**（见 [`dependencies.md`](dependencies.md) §1.1）。
