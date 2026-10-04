# 安装

> 三种运行形态：**前台进程**（最简）、**守护进程**（登录自启 + 崩溃重启）、
> **[容器](docker.md)**。它们共用同一份数据，随时可以换。

## 0. 前置条件

| 项       | 要求                                                                    |
| -------- | ----------------------------------------------------------------------- |
| Node.js  | **≥ 24**（`engines` + `.nvmrc` + `.npmrc` 的 `engine-strict` 一起把关） |
| 浏览器   | Chrome / Edge / Brave 任一。扩展是平台请求**唯一**的出口，属于必需项    |
| 端口     | **9539**（扩展 ↔ 桥的 WS）与 **9540**（HTTP / Console）。HTTP = WS + 1  |
| 可选 CLI | `unzstd`（费用报表解压会话）、`lark-cli`（飞书通知）——缺了只降级不阻塞  |

端口都只监听**环回** `127.0.0.1`，不暴露到局域网。换端口改 `proxyHttpPort`，
或给安装脚本传 `WS_PORT`（HTTP 自动 = WS + 1）。

## 1. 初始化

```bash
npm install      # 只装根 devDeps（根没有 workspaces）
npm run setup    # 建数据目录、生成配置、装齐子包依赖（runtime / bridge）、构建 core
```

`setup` 是**幂等**的：已存在的配置不会被覆盖，缺什么补什么。它同时生成
`crosspost-runtime/paths.json` 与 `config.json`（两者都 gitignore）。

## 2. 起桥

### 2.1 前台（三种平台通用，最简）

```bash
node bridge/run-bridge.mjs      # 等于 npm run dev
```

进程活着，Console / HTTP / 扩展 / 定时器就都在。关掉终端即停。

### 2.2 macOS：launchd 守护

```bash
bridge/install-launchd.sh print        # ① 先看会写成什么（不落盘、不调 launchctl）
bridge/install-launchd.sh install      # ② 安装并启动（登录自启 + 崩溃自动重启）
bridge/install-launchd.sh status       # ③ 复查
```

| 子命令              | 做什么                   | 需要 macOS? |
| ------------------- | ------------------------ | ----------- |
| `print [WS_PORT]`   | 只打印将要写入的 plist   | 否          |
| `install [WS_PORT]` | 写 plist 并装载、启动    | 是          |
| `status`            | 查看守护状态             | 是          |
| `uninstall`         | 停止并卸载（含登录自启） | 是          |

label 是 `com.crosspost.bridge`，plist 落在 `~/Library/LaunchAgents/`。

### 2.3 Linux：systemd 用户单元

```bash
bridge/install-systemd.sh print 9539      # ① 任何平台都能生成并校验（CI 也用它）
bridge/install-systemd.sh install 9539    # ② 安装并启动
bridge/install-systemd.sh status          # ③ 复查
systemctl --user status crosspost-bridge
```

单元名 `crosspost-bridge.service`，日志走 journald
（`${XDG_STATE_HOME:-~/.local/state}/crosspost`）。子命令与 macOS 版一一对应。

> 无 GUI 会话时 `systemctl --user` 可能连不上总线：确认 `XDG_RUNTIME_DIR` 已设，
> 必要时 `loginctl enable-linger $USER`。

### 2.4 只跑调度（CLI-only 部署）

不要 Console / HTTP，只要到点触发：

```bash
node crosspost-runtime/src/commands/scheduler-cli.mjs run
```

用你自己的进程管理器（systemd 单元 / NSSM / pm2 / 任务计划程序）把它挂成常驻即可。
**两个宿主互斥**：桥与 `scheduler run` 同时只能有一个在跑定时器
（`<localRoot>/scheduler/lock`），后启动的会明确告诉你谁在持有。

### 2.5 共用的 node 解析

两个安装脚本与 preset 插件共用 `bridge/scripts/resolve-node.sh`：优先 `command -v node`，
并把解析出的 `node` 所在目录渲染进守护的 `PATH`（launchd 默认 PATH 很短，引擎要调
`lark-cli` / `unzstd` 这类可选 CLI）。要钉死某个 node，用：

```bash
CROSSPOST_NODE=/path/to/node bridge/install-launchd.sh install
```

## 3. 装浏览器扩展 + 自检

```
chrome://extensions → 打开「开发者模式」→「加载已解压的扩展程序」
                    → 选 <仓库>/bridge/chrome-proxy-extension
```

```bash
npm run doctor      # 期望 0 失败项；有失败项时退出码 1
```

再打开 **http://127.0.0.1:9540/** —— Console 的「接入与自检」页把「桥 → 扩展 → 平台登录 →
接入项目」四步的当前状态与可照做的修复动作列出来。

## 4. 卸载

```bash
bridge/install-launchd.sh uninstall          # macOS（Linux 换成 install-systemd.sh）
```

数据不会因此删除：草稿与记录在 `.local/` 与项目自己的 `dataDir` 里，
配置在 `crosspost-runtime/config.json` / `paths.json`。要彻底清空，见
[`security.md`](security.md) §「数据落点」。

## 5. 平台差异速查

| 平台    | 前台 | 守护                         | 定时触发   | 定时执行                           | 状态                                 |
| ------- | ---- | ---------------------------- | ---------- | ---------------------------------- | ------------------------------------ |
| macOS   | ✔    | `install-launchd.sh`         | 内置定时器 | 本地命令（缺省）或项目 HTTP 执行器 | 已验证                               |
| Linux   | ✔    | `install-systemd.sh`         | 内置定时器 | 同上                               | 脚本与契约测试齐备，**未在真机验证** |
| Docker  | —    | `restart: unless-stopped`    | 内置定时器 | 项目 HTTP 执行器（容器内必用）     | 见 [`docker.md`](docker.md)          |
| Windows | ✔    | 用任务计划程序 / NSSM 挂常驻 | 内置定时器 | 同上                               | **未验证**                           |

### 5.1 Linux 上的调度

调度由引擎自带的定时器负责，不依赖 systemd timer，因此与 macOS 语义完全一致：
让宿主常驻（§2.2 / §2.3 / §2.4），再让[项目声明槽位](scheduling.md)。
时区按 `config.scheduler.tz`（缺省 `Asia/Shanghai`）解释，**不看机器本地时区**；
容器里请显式传 `TZ`。

### 5.2 Windows：未验证

已有的部分：前台运行与 `scheduler-cli.mjs run` 走同一套代码，调度语义与其它平台一致。
未验证的部分：**守护方式**（怎么把常驻进程挂成服务）。

必须注意的一点：项目声明的 `command` **不要依赖 `bash`** ——
用 `["node", "scripts/run_once.mjs", "<槽位>"]` 这类 argv 形式。
引擎会把解析不了的命令直接报出来（`commandMissing`），不会静默不跑。

## 6. 排查

| 症状                                         | 原因 / 修法                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run setup` 报 `tsup: command not found` | 只跑了 `npm install`。根没有 workspaces，真实依赖在两个子包里，必须跟 `npm run setup`（见 [dependencies.md](dependencies.md)） |
| `require('ws')` 崩 / 桥起不来                | 同上：`bridge` 子包的依赖没装                                                                                                  |
| `Failed to connect to bus`（Linux）          | 无用户总线：确认 `systemctl --user` 可用，必要时 `loginctl enable-linger $USER`                                                |
| 单元/守护装好但立即退出                      | `journalctl --user -u crosspost-bridge -n 50`（macOS 看 `bridge/install-launchd.sh status`）；先手动前台跑一次看真实报错       |
| 找不到 node                                  | `which node`；或 `CROSSPOST_NODE=/path/to/node` 再装一次                                                                       |
| 端口被占                                     | 已有实例或别的进程占着 9539/9540；`lsof -nP -iTCP:9539 -iTCP:9540 -sTCP:LISTEN`                                                |

更多症状见 [`troubleshooting.md`](troubleshooting.md)。
