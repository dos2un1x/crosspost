# 架构

> 一句话：**一个本机常驻的发布引擎**——把 Markdown 变成多个平台的**草稿**，
> 并把"发得出去吗、登录态还在吗、内容长什么样"变成可查、可诊断、可接入的能力。
> 它是引擎，不是写作系统：写作（选题、评分、写作规范、内容日历）属于接入它的项目。

**恒草稿 · 单通道（无中转服务器）· 数据不离开你的设备。**

## 1. 部件与职责

```
        ┌──────────────── 入口 ────────────────┐
        │ Console(浏览器)  CLI  MCP  DSH preset │
        └───────────┬──────────┬───────────────┘
                    │ HTTP 9540 │ stdio / 子进程
              ┌─────▼──────────▼─────┐
              │  bridge/（常驻桥）    │  token 鉴权 · 项目头 · CORS · 调度 · 静态页
              └───┬──────────────┬───┘
                  │ --ipc 常驻子进程 │ 桥→扩展消息（proxyFetch/pageOp/…）
        ┌─────────▼─────────┐  ┌──▼──────────────────────────┐
        │ crosspost-runtime │  │ chrome-proxy-extension       │
        │  src/ 引擎业务逻辑 │  └──┬──────────────────────────┘
        │  core/ 渲染核心    │     │ 在真实页面里代发请求
        └───────────────────┘  ┌──▼──────────────┐
                               │ 各平台网页/后台  │ → 存草稿（不发布）
                               └─────────────────┘
```

| 部件               | 目录                                     | 是什么                                                                                                                                                                          |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **渲染核心**       | `crosspost-runtime/core/`                | TypeScript：样式引擎（10 种内置样式）、封面模板（13 种）、平台适配器。`tsup` 构建到 `dist/`，被 runtime 以 `file:` 依赖链接；`dist/` 不入库                                     |
| **引擎业务逻辑**   | `crosspost-runtime/src/`                 | CLI 的 54 个方法、doctor、配置分层、项目注册表、草稿/记录簿记、费用统计、发布编排、AI 检测、内置定时器                                                                          |
| **MCP 服务**       | `crosspost-runtime/mcp-server/index.mjs` | MCP stdio：把 CLI 能力包装成 **22 个工具**，供 DSH 或外部 MCP 客户端（Claude Desktop / Cursor…）调用                                                                            |
| **桥**             | `bridge/run-bridge.mjs`                  | 常驻 HTTP（默认 **9540**）：鉴权、CORS、项目头、**四条常驻 worker 车道**、扩展通道、调度、Console 静态页与素材                                                                  |
| **Console**        | `bridge/console/`                        | 零构建的静态 ES Module 工作台，由桥在 `/console/` 同源托管（CSP `script-src 'self'`，故编辑器依赖同源 vendored）                                                                |
| **浏览器扩展**     | `bridge/chrome-proxy-extension/`         | 唯一的"出口"：在已登录的浏览器里代发请求。桥 ↔ 扩展走消息契约（7 个核心 method + 平台专用 handler）                                                                             |
| **DSH preset**     | `preset/crosspost/`                      | 把引擎挂到 DSH（agent 编排器）的可选 preset：bundle 声明 `cordis.patch.yml`（`@deepseek-ai/dsh-agent-preset` 行）+ `plugins/crosspost.js`                                       |
| **项目侧参考实现** | `examples/`                              | 「一键生成」与「槽位执行器」两个 HTTP provider 的参考实现（零依赖单文件，**属于项目侧，不是引擎**）；`examples/topic-pool-writer/` 性质相反——**写入实现在引擎**，项目侧只做转发 |

`@crosspost/core` 用 `file:./core` 链接进 runtime，因此 core **没有自己的 `node_modules`**：
它的依赖树由 `crosspost-runtime` 那棵树承载，core 的三条脚本（`build` / `typecheck` / `test`）
直接复用祖先树里的 `tsup` / `tsc` / `vitest`。

## 2. 数据流

### 2.1 一次"发布"

1. 入口（Console / CLI / MCP）把请求交给**桥**（HTTP）或直接交 CLI；
2. 桥把请求转给**常驻 worker 子进程**（`cli.mjs --ipc`，逐行 JSON）；
3. 引擎渲染正文（core 样式引擎）→ 逐个平台走**适配器**；
4. 适配器经桥 → **扩展** → 在平台页面里执行登录态请求；
5. 平台侧结果：**存草稿**。引擎把结果写进**内容域**（草稿文件 + 文章记录），并按配置发通知。

> **恒草稿**是设计而非开关：底层发布工具对"定时链路"（`WECHAT_AUTO_SCHEDULED=1`）
> 与"一键生成"（`WECHAT_AUTO_DRAFT_ONLY=1`）来源**一律拒绝**，防止绕过。

### 2.2 四条常驻 worker 车道

| 车道     | 角色                   | 为什么单独一条                                 |
| -------- | ---------------------- | ---------------------------------------------- |
| `reader` | 读列表/记录            | 最常被 Console 调用，必须永远短                |
| `writer` | 写草稿/记录/状态       | 写与读互不阻塞                                 |
| `heavy`  | 渲染、发布编排等长任务 | 长任务不该占住读队列                           |
| `costs`  | 费用/会话类统计        | 会话索引是秒级 I/O，混在读车道上会拖慢整个界面 |

**它们只在 spawn 时加载一次模块** —— 所以"代码已提交"≠"桥已生效"。
改了引擎代码（尤其 `articles.mjs` / `paths.mjs` / `doctor.mjs`）**必须重启桥**，
见 [`troubleshooting.md`](troubleshooting.md) §9。

### 2.3 内容域：默认域 ≠ 项目域

- **项目**由 manifest 显式声明（[`integration.md`](integration.md)），引擎**只读 manifest、不猜目录**；
- 草稿与文章记录按项目分域存放；**默认域是独立的、可以为空**——它不等于"第一个项目"；
- 周边资源（`history` / `logs` / 选题库 / 编辑记忆）**跟着内容工作区走**，即 manifest `dataDir` 的父目录；
- HTTP 侧用 `X-CrossPost-Project` 选项目，CLI 用 `--project=`，MCP 用 `CROSSPOST_PROJECT`（会话级）——三面同一套语义。

### 2.4 配置分层

**引擎级**（与哪个项目无关：端口、超时、并发、注册表扫描目录）× **项目级**（槽位开关、推哪些平台、通知、评分阈值、品牌、封面、样式清单）。
生效值 = 引擎 config 深合并项目覆盖层；分类是**白名单**，未知键一律算引擎级。
详见 [`configuration.md`](configuration.md)。

## 3. 本机数据落点

| 路径                            | 是什么                                                                               | 入库?                      |
| ------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| `.local/`                       | 本地数据根：`drafts/`、`articles` 记录、`logs/`、`history/`、`project-state/<项目>/` | 否（gitignore）            |
| `crosspost-runtime/config.json` | 引擎级配置（含接入项目的扫描目录）                                                   | 否（含机器路径、通知对象） |
| `crosspost-runtime/paths.json`  | 路径统一配置（本机）；支持环境变量覆盖                                               | 否                         |
| `bridge/token.local`            | 本地 API token（桥与调用方共用）                                                     | 否                         |

这些位置都可以用 `CROSSPOST_*` 环境变量覆盖，清单见 [`configuration.md`](configuration.md) §4。

## 4. 调度（定时发文）

- **触发由引擎自己负责**：一个跨平台的进程内定时器（`crosspost-runtime/src/scheduler/`），
  按 `scheduler.tz` 判定"几点该跑"，到点用 **argv** 直接派生项目的命令。
  不存在 launchd plist / systemd timer 这一层——三平台同一套语义，见 [`scheduling.md`](scheduling.md)。
- **宿主**：定时器住在进程里。缺省是**桥**（Console / HTTP / 扩展都在它里面）；
  也可以只跑 `crosspost-runtime/src/commands/scheduler-cli.mjs run`（CLI-only / 容器 / Windows）。
  两个宿主互斥（`<localRoot>/scheduler/lock`），后启动的会说明谁在持有。
- **命令来自项目声明**：`.crosspost/schedule.json`（argv 数组，不是 shell 串）。
  引擎**只读**它（删条目要改项目里那个文件），也不替项目编造命令。
- **"谁持有钟"与"谁执行脚本"是两件事**：执行可以是基座里的本地命令，也可以是项目自己的
  HTTP 执行器（容器化部署必须用后者），见 [`scheduling.md`](scheduling.md) §4b。
- **每槽位每天最多自动跑一次**：语义是"补跑窗口 + 崩溃不重跑"，见 [`scheduling.md`](scheduling.md) §3。
- **引擎不自带任何任务**：槽位**全部**来自项目声明，因此默认域（未选项目）的槽位列表是空的。
- 桥自身的守护（`install-launchd.sh` / `install-systemd.sh`）**保留**——它们守护的是
  "谁在跑那个定时器"，与槽位调度是两件事。
