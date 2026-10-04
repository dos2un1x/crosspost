# 「槽位执行器」HTTP 提供者 · 参考实现

> **这是项目侧的代码，不属于引擎。** 引擎只声明并调用一组 HTTP 端点；
> 这个零依赖单文件说明了"端点那一侧"长什么样。任何语言/框架实现同样的端点都等价。
>
> 契约定义：[`../../docs/scheduling.md`](../../docs/scheduling.md) 的「谁来执行」一节；
> 它在整条流水线里的位置见 [`../../docs/writing-pipelines.md`](../../docs/writing-pipelines.md)。

## 四个端点

| 端点                       | 请求                                                                 | 响应                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /slot/run`           | `{"slot","date","runId","deadlineMs","projectId","contractVersion"}` | `202 {"taskId","state":"running","logFile"}`（受理）／`200 {…,"state":"done","exit"}`／`409`（同槽位在跑）／`4xx·5xx {"error","message"}` |
| `GET /slot/status?taskId=` | —                                                                    | `200 {"taskId","state":"running"｜"done"｜"failed","exit","durationMs","logFile","logTail","message"}`                                    |
| `POST /slot/cancel`        | `{"taskId"}`                                                         | `200 {"ok":true,"state"}`（尽力而为；引擎退出时会调，未实现也只是"停止跟踪"）                                                             |
| `GET /health`              | —                                                                    | `200 {"ok":true,"bin":…,"running":n}`（探活，给人/doctor 用；引擎不做自动探活）                                                           |

**为什么受理是异步的**：一个槽位动辄跑几分钟到几十分钟。同步模式一旦在任一中间层
（代理、容器、项目侧重启）被掐断，引擎就不知道任务还在不在跑；异步模式下**状态在项目侧**，
引擎重启也能重新问。

## 三条纪律

1. **argv 传参，不经 shell**：`slot` 来自请求体，拼进 shell 等于给自己开洞。
2. **同槽位不重叠**：上一次没跑完就拒绝这一次（`409`），而不是排队——排队会让"到点"变成"迟到"。
   引擎侧也有同样的保护，两层都要有：引擎重启后它自己的内存态会丢，项目侧的互斥必须独立成立。
3. **退出码如实上报**：`exit` 是引擎记账的唯一判据（今日是否跑过、上次退出码、连续多少天没产出），
   不能把"跑失败"报成 `state=done`。

## 启动

```bash
SLOT_BIN=/path/to/run_once.sh \
SLOT_WORKDIR=/path/to/my-writing-project \
SLOT_LOGS_DIR=/path/to/my-writing-project/logs \
node server.mjs
```

| 环境变量          | 缺省                     | 作用                                                   |
| ----------------- | ------------------------ | ------------------------------------------------------ |
| `SLOT_BIN`        | 必填                     | 到点要跑的脚本（以 argv 方式调用，不经 shell）         |
| `SLOT_WORKDIR`    | 当前目录                 | 脚本的工作目录                                         |
| `SLOT_LOGS_DIR`   | `<cwd>/logs/slot-runner` | 每次运行日志的落点（`logTail` 从这里回给引擎）         |
| `SLOT_IDS`        | 不限                     | 逗号分隔的白名单；不在名单里的槽位返回 `404`           |
| `SLOT_TOKEN`      | 无                       | 配了就要求 `Authorization: Bearer <token>`，否则 `401` |
| `HOST` / `PORT`   | `127.0.0.1` / `8788`     | 监听地址（**只监听环回**，不要暴露到局域网）           |
| `SLOT_TIMEOUT_MS` | 引擎给的预算             | 单次槽位的硬上限；超时按失败上报                       |

脚本的 stdout/stderr 会被收进 `logFile`，`logTail` 取尾部若干字符回给引擎，便于失败时一眼看到原因。
脚本产出草稿时把草稿 id 用 `[draft-id]` 括起来打印，引擎会把它捡出来记到这一轮的运行记录里。

## 在 manifest 里声明

```jsonc
"capabilities": {
  "schedule": {
    "kind": "http",
    "url": "http://127.0.0.1:8788/slot/run",
    "statusUrl": "http://127.0.0.1:8788/slot/status",
    "cancelUrl": "http://127.0.0.1:8788/slot/cancel",
  }
}
```

**为什么执行器是"能力"而不是配置**：引擎不执行接入方的业务脚本。"到点"只是引擎发一次请求，
**执行方与执行环境都由项目决定**，引擎只做编排与记账。这样容器化部署才是对的——
linux 容器里跑不了宿主原生安装的 CLI。
