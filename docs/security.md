# 安全与数据边界

> 三条主张：**凭据只走请求头**、**数据不离开你的设备**、**写入尽头永远是草稿**。

## 1. 凭据

| 凭据           | 位置                                  | 规则                                                                                       |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| 本地 API token | `bridge/token.local`（**gitignore**） | 只接受请求头 `X-CrossPost-Token`；**明确拒绝** `?token=` 查询串（会进日志/历史记录而泄露） |
| 平台登录态     | 浏览器自身（cookie）                  | 引擎**从不复制、不落盘**平台凭据；每次都由扩展在真实页面里带 cookie 发请求                 |
| 生成端点 token | 项目侧（`tokenEnv` 指向的环境变量）   | 引擎只传 `tokenEnv` 名字，值不写进 manifest                                                |
| 通知凭据       | `lark-cli` 自己的配置                 | 引擎只说"走 lark 通道"                                                                     |

## 2. 网络边界

- **单通道、无中转服务器**：唯一出口是**浏览器扩展**（在你自己已登录的浏览器里代发请求）。
- **CORS 白名单**：只放行 `http://127.0.0.1:<端口>`、`http://localhost:<端口>`、`chrome-extension://*`；
  必须列出自定义头 `X-CrossPost-Token`、`X-CrossPost-Project`，否则浏览器侧调用方的预检会被拦死
  （curl 不受影响，所以这类问题只在真浏览器里暴露）。
- **扩展消息契约**：桥只发 7 个核心 method（`proxyFetch`/`getCookie`/`pageOp`/`tabsQuery`/`tabsCreate`/`tabsWaitForLoad`/`tabsClose`），
  其余是平台专用 handler；扩展版本与桥做兼容握手（不匹配会明确报出，而不是"显示已连接但静默失败"）。
- **端口只监听环回**：9539 / 9540 都不暴露到局域网。

## 3. 写入边界（防误发）

- **恒草稿**：底层发布工具对定时链路（`WECHAT_AUTO_SCHEDULED=1`）与一键生成（`WECHAT_AUTO_DRAFT_ONLY=1`）
  来源**一律拒绝**——这两个标记由 shell 注入，AI/页面无法自我豁免。
- **自动推送是开关不是总闸**：`autoPush.enabled=false` 时链路只存草稿。
- **验证脚本的只读性**：测试/冒烟脚本若要写盘，必须隔离到临时目录
  （连 `CROSSPOST_LOCAL_ROOT` 一起隔离——只隔离 `CROSSPOST_ARTICLES_DIR` 拦不住按归属纠正域后的写入）。

## 4. 数据落点

| 路径                                      | 是什么                                  | 入库?                |
| ----------------------------------------- | --------------------------------------- | -------------------- |
| `.local/`                                 | 本地数据根（草稿 / 记录 / 日志 / 历史） | 否（gitignore）      |
| `crosspost-runtime/config.json`           | 引擎级配置（含机器路径、通知对象）      | 否                   |
| `crosspost-runtime/paths.json`            | 路径统一配置（本机）                    | 否                   |
| `crosspost-runtime/token.*.json`、`*.env` | 平台/渠道凭据                           | 否                   |
| `bridge/token.local`                      | 本地 API token                          | 否                   |
| `<项目>/<dataDir>/`                       | 该项目自己的草稿与记录                  | 由项目自己的仓库决定 |

这些位置都可以用 `CROSSPOST_*` 环境变量覆盖，清单见 [`configuration.md`](configuration.md) §4。

**提交前必看**：以上"入库? = 否"的文件都在 `.gitignore` 里。往公开仓库提交前，
先跑一次 `git status --short` 确认没有任何一条被误加（尤其 `.env`、`token.*.json`、
`bridge/brand/` 这些本地运行态文件）。
