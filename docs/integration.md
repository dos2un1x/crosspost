# 项目接入契约

> 引擎**只读 manifest，不猜测任何项目布局**；没有 manifest 就是"未接入"。
> manifest 是**声明**，不允许注入可执行代码——`generate` 与 `schedule` 的跨进程提供者
> 都是**纯数据**（一个 URL + 若干参数），引擎只会按它发 HTTP 请求。

## 1. 接入：放一个文件

在**扫描根**（`config.projectsDirs` 里的目录）的任一子目录放 `.crosspost/project.json`：

```jsonc
{
  "manifestVersion": 2,
  "id": "my-project", // 稳定标识，进所有项目级路径
  "name": "我的写作项目", // 显示名
  "dataDir": "drafts", // 内容工作区（草稿 + 记录）——相对项目根或绝对路径
  "capabilities": {
    "drafts": true, // 引擎直接读写这个目录
    "topics": true, // 选题库
    "retention": true, // 留存/归档
    "reports": true, // 费用报表
    "generate": {
      // 「一键生成」：跨进程，纯数据描述
      "kind": "http",
      "url": "http://127.0.0.1:8787/generate",
      "statusUrl": "http://127.0.0.1:8787/status",
      "tokenEnv": "CROSSPOST_GENERATE_TOKEN",
    },
  },
}
```

然后 `npm run doctor` 的 `projects` 检查会列出它；Console 的项目切换器会看到它。

## 2. 六项能力（引擎已知的全部）

| 能力        | 值形态            | 含义                                    | 缺了会怎样                                   |
| ----------- | ----------------- | --------------------------------------- | -------------------------------------------- |
| `drafts`    | `true`            | 引擎读写 `<dataDir>` 下的草稿与文章记录 | 内容域不可用（**声明它必须给 `dataDir`**）   |
| `topics`    | `true`            | 选题库（池文件）                        | Console 选题页无数据                         |
| `retention` | `true`            | 留存库与归档                            | 留存/归档视图无数据                          |
| `reports`   | `true`            | 费用/会话报表                           | 报表视图无数据                               |
| `generate`  | **对象**          | 「一键生成」跨进程提供者                | Console 的一键生成按钮不可用                 |
| `schedule`  | **对象** / `true` | 槽位执行器；`true` 表示用本地命令执行器 | Console 定时区显示「缺命令声明」（到点不跑） |

**校验规则**（不满足即**报错**，不静默忽略）：

- `manifestVersion` 必须是正整数，且不得高于引擎支持版本（当前 **2**）；低于当前版本只给一条**升级建议**，不是错误。
- 能力名**不认识即报错**——所以不要写引擎不认识的键。
- 除 `generate` / `schedule` 外，能力值必须是布尔。
- 对象形态**不得**出现 `command` / `script` / `argv` 之类字段：能力只描述"怎么调用"，不描述"执行什么代码"。

### 2.1 调度声明（能力 `schedule: true`）

声明布尔形态表示项目在**项目根**放了 `.crosspost/schedule.json`，
写清"哪个槽位、几点、跑什么命令"：

```jsonc
{
  "version": 1,
  "slots": {
    "hotspot": {
      "name": "热点解读①",
      "time": "08:30",
      "command": ["bash", "scripts/run_once.sh", "hotspot"], // argv，不是 shell 串
      "cwd": "pipeline", // 相对项目根（缺省=项目根），不得逃出项目根
      "env": { "CLAUDE_BIN": "/Users/me/.local/bin/claude" },
      "logDir": "pipeline/logs",
    },
  },
}
```

完整规则与触发策略见 [`scheduling.md`](scheduling.md) §2、§3。
**注意**：这份声明是**项目侧文件**，引擎只读它（删条目要改这个文件）。
它与 manifest 是两件事——manifest 是**契约**；声明是**项目自己的调度配置**
（argv 直传、禁 shell 展开、路径不得逃出项目根）。

## 3. 三个入口，同一套项目语义

| 入口       | 怎么指定项目                                                          |
| ---------- | --------------------------------------------------------------------- |
| CLI        | `node crosspost-runtime/src/cli.mjs <method> --project=<id>`          |
| HTTP（桥） | 请求头 `X-CrossPost-Project: <id>`（桥的 CORS 已放行这个头）          |
| MCP        | 环境变量 `CROSSPOST_PROJECT=<id>`（**一进程一项目**，会话级声明一次） |

未指定项目时走**默认域**：它是独立的、可以为空——**不等于"第一个项目"**。

## 4. 数据边界（铁律）

- **草稿归项目，引擎簿记归引擎**：草稿与文章记录按项目分域；引擎自己的运行数据（桥日志、费用缓存、修复留痕）在引擎本地数据根。
- **周边资源跟着内容工作区走**：`history` / `logs` / 选题库 / 编辑记忆 = `dataDir` 的父目录下的同名目录。
- **写入侧按草稿归属纠正域**：在默认域上下文里发布一个属于某项目的草稿时，记录写进**该项目**的簿记（读路径不换域）。响应会带 `projectDerived` 标记。
- 向前兼容：能力全为布尔（不含对象形态）的 manifest 继续可读。

## 5. 四种接入层次

| 层                   | 你要做什么                                                                                | 你得到什么                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **L1 发布接入**      | 只放 manifest + 草稿目录                                                                  | Console/CLI/MCP 能读你的草稿、按你的平台配置发布、状态写入你的内容域                              |
| **L2 工作台接入**    | 额外提供 `topics`/`retention`/`reports` 所需的数据文件                                    | Console 的完整工作台（选题/留存/报表）按项目隔离                                                  |
| **P2「一键生成」**   | 实现 `generate` 的 HTTP 端点（`POST /generate`、`GET /status`、`GET /health`）            | Console 上点一下就能让你的流水线跑起来；状态在**你**这一侧，引擎重启也能重新问                    |
| **P3「槽位执行器」** | 实现 `schedule` 的 HTTP 端点（`POST /slot/run`、`GET /slot/status`、`POST /slot/cancel`） | 定时到点时脚本**在你自己的环境里**跑（该有的解释器/CLI/内网访问都在这一侧）；容器化部署的正确形态 |

参考实现（项目侧，不属于引擎，零依赖单文件）：
[`../examples/generate-provider-http/server.mjs`](../examples/generate-provider-http/server.mjs)、
[`../examples/slot-runner-http/server.mjs`](../examples/slot-runner-http/server.mjs)。

要接的是一条（或多条）**写作流水线**（每条写自己的题材与风格），
接法与并存语义见 [`writing-pipelines.md`](writing-pipelines.md)。

**为什么 provider 走异步**：真实生成/真实槽位要跑几分钟到几十分钟；同步模式在任一中间层被掐断后，
引擎就不知道任务还在不在跑。异步模式下状态在项目侧，引擎重启能重新问。

### 5.1 「一键生成」是**队列**，一次 POST = 一条任务

Console 上连点几条选题（或点「一键生成全部未生成」），引擎把它排成 FIFO 队列，
按 `topicsGenerateMaxConcurrency`（**默认 1**）取队首执行。对项目侧的含义只有两条：

- **一个任务一次 POST**。引擎不会在一次调用里捎带多条；`slot`/`keyword` 之外还会带一个
  可选的 `topicId`（引擎侧的选题 id，用于生成后精确回填选题库——不认这个字段可以忽略）。
- **你的端点说"忙"就是"忙"**。并发上限满时按契约返回
  `409 {"error":"busy","message":"…"}`；引擎把它映射成结构化的 `generate_provider_busy`
  （**不是失败**），并发 > 1 时退避重试有限次，否则如实告诉使用者"项目侧正忙"。
  参考实现（`examples/generate-provider-http/server.mjs`）的 `GENERATE_CONCURRENCY` 就是这里。

**注意别把并发调成"引擎想并行、项目侧却串行"**：项目侧的全局锁会让第 2 条起直接失败或空转。
要真并行，两边的并发必须**同批**放开——步骤见 [`writing-pipelines.md`](writing-pipelines.md) §9。

**为什么 provider 走异步**（续）/ 端点细节：`POST /generate` 的请求与响应形态见
[`../examples/generate-provider-http/README.md`](../examples/generate-provider-http/README.md)。

**为什么执行器是能力而不是配置**：引擎不执行接入方的业务脚本。
"到点"只是引擎发一次请求，**执行方与执行环境都由项目决定**，引擎只做编排与记账。
这样容器化部署才是对的：linux 容器里跑不了宿主原生二进制。
