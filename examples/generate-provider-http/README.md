# 「一键生成」HTTP 提供者 · 参考实现

> **这是项目侧的代码，不属于引擎。** 引擎只声明并调用一个 HTTP 端点；
> 这个零依赖单文件说明了"端点那一侧"长什么样。任何语言/框架实现同样的三个端点都等价。
>
> 契约定义：[`../../docs/integration.md`](../../docs/integration.md) §5。

## 三个端点

| 端点                   | 请求                                               | 响应                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /generate`       | `{"slot","keyword","projectId","contractVersion"}` | `202 {"taskId","state":"running","logFile"}`（受理）／`200 {…,"state":"done","logTail"}`（同步完成）／`409 {"error":"busy"}`（并发满）／`4xx·5xx {"error","message"}` |
| `GET /status?taskId=…` | —                                                  | `200 {"taskId","state":"running"｜"done"｜"failed","logFile","logTail","message"}`                                                                                    |
| `GET /health`          | —                                                  | `200 {"ok":true,…}`（探活，给人用；引擎不做探活）                                                                                                                     |

**`409 busy` 是"稍后再来"，不是"失败"**：引擎把它映射成结构化的
`generate_provider_busy`。引擎侧并发 > 1 时会在退避后重发这次 POST（安全——409 意味着
你**没有接单**，不会开出两条真实生成），并发 1 时直接如实告诉使用者"项目侧正忙"。
`GENERATE_CONCURRENCY` 就是这条 409 的触发阈值。

**为什么走异步**：真实生成要跑几分钟到几十分钟。同步模式一旦在任一中间层
（代理、容器、项目侧重启）被掐断，引擎就不知道任务还在不在跑；
异步模式下**状态在项目侧**，引擎重启也能重新问。

## 启动

```bash
GENERATE_BIN=/path/to/generate.sh \
GENERATE_LOGS_DIR=/path/to/logs \
GENERATE_TOKEN=$(openssl rand -hex 16) \
node server.mjs
```

然后在项目 manifest 里声明（见 [`../../docs/integration.md`](../../docs/integration.md) §1）：

```jsonc
"capabilities": {
  "generate": {
    "kind": "http",
    "url": "http://127.0.0.1:8787/generate",
    "statusUrl": "http://127.0.0.1:8787/status",
    "tokenEnv": "CROSSPOST_GENERATE_TOKEN"
  }
}
```

## 安全设计（这个文件里最要紧的一行）

`GENERATE_BIN` 以 **argv** 方式启动（**不经 shell**），`slot` / `keyword` 只作为参数传递——
选题文案里出现 `;`、`$()`、反引号也不会变成命令执行。生成端点的入参最终来自网页表单，
所以这条防线必须在这里，而不是在调用方。

`tokenEnv` 只写**环境变量名**，token 值不进 manifest。
