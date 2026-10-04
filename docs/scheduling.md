# 调度（定时触发）

> **一句话**：到点触发由**引擎自带的定时器**负责——它住在宿主进程里（桥，或独立的
> `scheduler` 进程），跑的命令由**项目自己的声明**给出。三种平台同一套语义。

## 1. 它由什么组成

| 部件             | 在哪                                                   | 作用                                              |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------- |
| **槽位（slot）** | 项目设置 `slots` + 项目声明 `.crosspost/schedule.json` | 一个"几点跑什么"的单位：id / 名称 / 时间 / 命令   |
| **声明**         | 项目根 `.crosspost/schedule.json`                      | **命令的唯一来源**（argv 数组，不是 shell 串）    |
| **定时器**       | 桥进程内，或 `scheduler-cli.mjs run`                   | 每 60 秒判定一次"该不该跑"，到点用 argv 直接派生  |
| **运行记录**     | `<localRoot>/scheduler/runs-<日期>.jsonl`              | 触发前写 intent、结束后写结果（崩溃后据此不重跑） |
| **单实例锁**     | `<localRoot>/scheduler/lock`                           | 两个宿主只能有一个持有，避免同一计划跑两遍        |

> **引擎不自带任何任务**：槽位**全部**来自项目声明 —— 因而**默认域（未选项目）的
> 槽位列表是空的**，这不是"调度没装"。

触发链很短：

```
项目声明（命令） + 项目设置（名称/时间/开关）
        ↓
内置定时器按 config.scheduler.tz 判定"今天这一班到点了吗"
        ↓
spawn(argv)  →  <项目工作区>/logs/scheduler-<槽位>.{out,err}.log
        ↓
项目脚本跑完 →  项目自己写 logs/run-<槽位>-<日期>.log（含 [END]）
```

## 2. 项目声明：`.crosspost/schedule.json`

```jsonc
{
  "version": 1,
  "slots": {
    "hotspot": {
      "name": "热点解读①",
      "time": "08:30",
      "command": ["bash", "scripts/run_once.sh", "hotspot"],
      "cwd": "pipeline",
      "env": { "CLAUDE_BIN": "/Users/me/.local/bin/claude" },
      "logDir": "pipeline/logs",
    },
  },
}
```

规则（不满足就**报错**，不静默忽略）：

| 字段      | 要求                                                                           |
| --------- | ------------------------------------------------------------------------------ |
| `version` | 正整数，且不高于引擎支持的版本（当前 `1`）                                     |
| `slots`   | 对象：槽位 id → 定义；id 形如 `hotspot`（小写字母开头，字母/数字/横线）        |
| `command` | **非空字符串数组**（argv）。引擎不解析 shell：`&&`、`$VAR`、`*` 都只是普通字符 |
| `cwd`     | 相对项目根（缺省 = 项目根）；解析后必须落在项目根内                            |
| `env`     | 字符串 → 字符串；会叠加在宿主环境之上                                          |
| `logDir`  | 相对项目根（缺省 = 项目工作区的 `logs/`）；同样不得逃出项目根                  |

- 声明里的相对路径一律**相对项目根**解析。写 `..` 或指向项目外会被拒绝。
- 命令是否真的能跑起来由引擎**预检**：Console 会显示「缺命令声明 / 命令不可用」并给出原因，
  而不是等到点发现什么都没发生。
- 引擎**不替你编造命令**：Console 上新增槽位只是登记名称/时间/开关，
  命令必须由你在声明文件里写。也不替你删：删除按钮对声明过的槽位是禁用的，
  请从声明文件里删掉那一条。

## 3. 触发策略

| 规则                            | 取值                                                    | 说明                                                            |
| ------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| 每个槽位每天最多自动跑 **1 次** | 硬规则                                                  | 睡眠、重启、崩溃都不会重复发文                                  |
| 补跑窗口                        | `scheduler.catchUpMaxMinutes`，缺省 **120**，`0` = 不补 | 宿主恢复后仍能完成当天该跑的那次                                |
| 崩溃一致性                      | 触发**前**写 intent，结束后写结果                       | 重启见到"有头无尾"→ 当天不重跑（标 `unfinished`），宁可少发一次 |
| 重叠                            | 同槽位上次没结束 → 跳过并计数                           | 不排队（排队会让 12:30 那次拖到 14:00 才开始）                  |
| 并发上限                        | `scheduler.maxConcurrent`，缺省 2                       | 撞同一分钟的两个槽位不互相拖死                                  |
| 手动触发                        | Console「立即运行」/ `scheduler trigger`                | **不受**每天一次限制（人工优先）                                |
| 时区                            | `scheduler.tz`，缺省 `Asia/Shanghai`                    | 「08:30」按这个时区解释，与宿主机本地时区无关                   |

> **宿主必须活着**。定时器住在进程里：桥停了、`scheduler run` 没跑，到点就不会触发
> （当天错过的会在补跑窗口内，于下次启动时补跑）。`doctor` 与 Console 都会明确说出来。

## 4. 谁来跑定时器（两个宿主，互斥）

```bash
# ① 桥（缺省，最常用：Console / HTTP / 扩展都在它里面）
node bridge/run-bridge.mjs
bridge/install-launchd.sh install      # macOS 守护
bridge/install-systemd.sh install 9539 # Linux 守护

# ② 只跑调度（CLI-only 部署 / 容器 / Windows 服务 / 任意进程管理器）
node crosspost-runtime/src/commands/scheduler-cli.mjs run
```

两者共用 `<localRoot>/scheduler/lock`：后启动的会**明确拒绝**并告诉你谁在持有
（而不是两个定时器把每天的计划各跑一遍）。

## 4b. 谁来**执行**（两种执行器；容器化必须用第二种）

"谁持有钟"与"谁执行脚本"是**两件事**，后者常常被忽略：

| 执行器               | 声明                                                                | 脚本跑在哪                       | 什么时候用                                                        |
| -------------------- | ------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| **本地命令**（缺省） | `.crosspost/schedule.json` 的 `command`（argv，不经 shell）         | **基座自己的进程/容器里**        | 同机原生部署；脚本依赖与基座环境一致                              |
| **远程 http**        | manifest 的 `capabilities.schedule = {kind:'http',url,statusUrl,…}` | **项目自己的环境里**（项目决定） | 容器化部署（必用）；脚本需要宿主原生解释器/CLI/内网访问时（必用） |

```jsonc
// 项目 manifest（.crosspost/project.json）—— 声明"到点发给我，我自己跑"
"capabilities": {
  "schedule": {
    "kind": "http",
    "url": "http://127.0.0.1:8788/slot/run",
    "statusUrl": "http://127.0.0.1:8788/slot/status",
    "cancelUrl": "http://127.0.0.1:8788/slot/cancel", // 可选：引擎退出时尽力取消
    "pollIntervalMs": 5000,                            // 250..60000
    "overallTimeoutMs": 3600000,                       // 单次槽位总预算，上限 24h
    "tokenEnv": "CROSSPOST_SLOT_TOKEN"                 // 只写变量名，密钥不进 manifest
  }
}
```

契约（参考实现：[`../examples/slot-runner-http/server.mjs`](../examples/slot-runner-http/server.mjs)）：

```
POST <url>   {slot,date,runId,deadlineMs,projectId,contractVersion}
   → 202 {taskId,state:"running",logFile}        受理（推荐：槽位要跑几分钟）
   → 200 {taskId,state:"done",exit,durationMs,logFile,logTail}   同步完成
   → 409 {error:"slot_busy"}                     同槽位已有实例在跑（拒绝，不排队）
GET  <statusUrl>?taskId=…   → {state:"running"|"done"|"failed",exit,durationMs,logFile,logTail,message}
POST <cancelUrl> {taskId}   → 200              尽力而为；没实现也只是"停止跟踪"
```

规则（与 `generate` 能力同构，见 [`integration.md`](integration.md) §5）：

- **声明即生效**：项目声明成对象就**不再**在基座里 spawn 脚本；解析失败/端点被策略拒绝时
  Console 显示「执行器不可用」并给出原因，**绝不回落到本地 spawn**（回落会让边界重新变模糊）。
- `schedule: true` 与"不声明"都等价于**本地命令执行器**。
- 端点策略：默认**只允许环回**；要调远程主机得在引擎配置 `slotExecutor.allowHosts` 里登记
  （或 `slotExecutor.allowRemote=true`）。`redirect: 'manual'`，`tokenEnv` 只认变量名。
- **容器模式**：引擎会把声明里的回环主机名重写成 `CROSSPOST_HOST_GATEWAY`（缺省
  `host.docker.internal`），所以 manifest 不用为容器改写（与「一键生成」同一套机制）。
- 记账不受影响：远程槽位同样写 `started`/`finished` + `exit`/时长，Console 的
  「今日已跑 / 跑失败 / 未收尾」与 `daysSince` 判据完全复用。

> **容器模式下项目槽位必须走远程执行器**：容器的命名空间里没有宿主那套解释器/CLI
> （项目脚本常依赖宿主原生二进制，在 linux 容器里加载会失败 → `exit=1`、当日零产出）。
> 详见 [`docker.md`](docker.md) §3。

## 5. 平台落地

| 平台    | 触发       | 守护                                                     | 时区                | 补跑             |
| ------- | ---------- | -------------------------------------------------------- | ------------------- | ---------------- |
| macOS   | 内置定时器 | `install-launchd.sh`（守护桥）                           | 精确                | 窗口内，每天一次 |
| Linux   | 内置定时器 | `install-systemd.sh`（守护桥）                           | 精确                | 同上             |
| Docker  | 内置定时器 | `restart: unless-stopped`                                | 精确（按容器 `TZ`） | 同上             |
| Windows | 内置定时器 | 用「任务计划程序 / NSSM / pm2」把 `scheduler run` 挂常驻 | 精确                | 同上             |

> 容器/Docker 行的"触发"在容器里、**"执行"在项目那边**（§4b 的 http 执行器）。
> Windows 的守护方式**未验证**，见 [`installation.md`](installation.md) §5.2。
> 宿主与容器同时只能有一个定时器（见 [`docker.md`](docker.md) §2）。

## 6. 从旧的系统任务迁过来

槽位不再由 launchd / systemd 触发，而**旧任务不会自己消失**，不清掉就会双发。

```bash
# ① 看看还剩哪些旧任务
node crosspost-runtime/src/commands/scheduler-cli.mjs tasks

# ② 看迁移计划（不写盘、不注销；把 cwd 的变化也列出来）
node crosspost-runtime/src/commands/scheduler-cli.mjs migrate --dry-run

# ③ 执行：生成项目声明 + 备份并移走旧 plist + 注销任务
node crosspost-runtime/src/commands/scheduler-cli.mjs migrate
```

- 迁移会从旧 plist 学出 `command` / `time` / `env` / `logDir`，写进项目声明并**保留**已有条目。
- 旧 plist 没有 `WorkingDirectory`，所以旧行为是 `cwd=/`（launchd 的缺省）。
  迁移把 `cwd` 写成项目根——dry-run 会单独列出来让你确认。
- 旧任务被**移动**到 `<localRoot>/scheduler/legacy-backup/<时间戳>/`（不是复制后删除：
  一步到位、可回滚）。
- 迁移**幂等**：再跑一次不会覆盖你改过的声明。
- 一个 plist 若有多个时间点，迁移会**拒绝**它并说明原因（不猜拆分，避免"少跑一次"没人知道）。

## 7. 排查

| 症状                            | 先看哪里                                             | 结论 / 修法                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console 显示「已启用·未生效」   | `armedReason`                                        | `no-lock`：没有宿主在跑 → 启动桥或 `scheduler run`                                                                                                    |
| 槽位徽标是「缺命令声明」        | 项目根的 `.crosspost/schedule.json`                  | 写声明（或 `scheduler migrate` 从旧任务生成）                                                                                                         |
| 到点了但没跑                    | `logs/scheduler-<槽位>.err.log`、`runs-<日期>.jsonl` | 项目脚本自身报错看前者；"引擎有没有触发"看后者                                                                                                        |
| 一天跑了两次                    | 槽位列表 → 是否有旧任务                              | `scheduler tasks` 的**「旧任务」**栏有东西就先迁移（双发）；同一输出里单列的**「常驻服务」**（无到点触发的执行器/生成提供者那类）不是旧任务，不用迁移 |
| 今天是"上次未收尾"              | 运行记录里 `phase:"started"` 无对应 `finished`       | 上次跑到一半崩了；按策略当天不自动重跑，可「立即运行」                                                                                                |
| 时间对不上（差一小时/差几小时） | `scheduler.tz` 与容器 `TZ`                           | 时间按 `scheduler.tz` 解释；容器里要显式传 `TZ`                                                                                                       |
| 换台机器后没有槽位              | 项目声明是否在该项目的仓库里                         | 声明是项目侧文件，跟着项目仓库走                                                                                                                      |

## 8. 与发布链路的关系

- 恒草稿：底层发布工具对定时链路来源（`WECHAT_AUTO_SCHEDULED=1`）与一键生成来源
  （`WECHAT_AUTO_DRAFT_ONLY=1`）一律只存草稿。
- 门禁：`config.schedule[槽位] === false` 是唯一"停"的写法；项目脚本仍可用
  `cli.mjs slotEnabled <槽位>` 问同一个开关（未设 = 跑，fail-open）。
  调度器在派生之前也会再问一次，两道判断同源。
