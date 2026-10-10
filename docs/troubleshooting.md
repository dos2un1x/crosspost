# 排障

> **先看两处**，绝大多数问题当场有答案：
>
> ```bash
> npm run doctor     # 环境自检：0 失败即可用；有失败项时退出码 1，按它指的方向修
> ```
>
> Console（`http://127.0.0.1:9540/`）的**「接入与自检」页**会把
> 「桥 → 扩展 → 平台登录 → 接入项目」四步的当前状态与**可以照着做的修复动作**列出来。

```bash
T=$(cat bridge/token.local)
curl -s localhost:9540/proxy/health -H "X-CrossPost-Token: $T"   # 桥活着吗、四条 worker 车道状态
```

---

## 1. 装不起来 / 报 "command not found"

**症状**：`npm run setup` 报 `tsup: command not found`；`node bridge/run-bridge.mjs` 在 `require('ws')` 处崩。

**原因**：根 `package.json` 没有 workspaces，真实依赖在两个子包里，且都不入库
（见 [`dependencies.md`](dependencies.md)）。

**修法**：按 README 走 —— `npm install && npm run setup`（setup 会装齐两处并构建 core）。
之后 `npm run doctor` 的 `deps-installed` / `core-dist` 两项应通过。

**附带**：`crosspost-runtime/core` 不拥有自己的 `node_modules`（依赖由 `crosspost-runtime`
那棵树承载）。若磁盘上还留着旧树，`doctor` 会给一条 `deps-redundant-core-tree`（提醒级）——
删除它即可回收空间，不影响构建与运行。

## 2. 桥起不来

| 症状                                       | 原因                                                                                                              | 修法                                                                                                                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 端口被占                                   | 已有实例或别的进程占用 9540                                                                                       | 先 `curl -s localhost:9540/proxy/health -H "X-CrossPost-Token: $(cat bridge/token.local)"` 看是不是自己；要换端口改 `proxyHttpPort`                                                                                  |
| 端口被占（容器模式）                       | 原生守护没停，或另一个容器占着 9539/9540                                                                          | 两种形态**不能同时跑**（会双发）。停掉一个：`bridge/install-launchd.sh uninstall` / `docker compose down`。详见 [`docker.md`](docker.md) §2                                                                          |
| macOS 守护没起来                           | plist 未装载                                                                                                      | `launchctl list \| grep com.crosspost.bridge`；先 `bridge/install-launchd.sh print` 看会写成什么                                                                                                                     |
| Linux 自启失败                             | 无用户总线 / 没 linger                                                                                            | 见 [`installation.md`](installation.md) §2.3                                                                                                                                                                         |
| 容器模式：容器 `healthy` 但发布/检查全失败 | 引擎的 `@crosspost/core` 没构建出来（判据是**四个入口产物**在不在，而容器私有卷首次挂载是空目录）                 | 看 `docker compose logs crosspost` 是否报 `ERR_MODULE_NOT_FOUND ... @crosspost/core/dist/...`；entrypoint 会自动补构建，重启一次容器即可。详见 [`docker.md`](docker.md) §7                                           |
| 容器模式：`exec` 的诊断命令 exit 127       | `docker compose exec` 不走 ENTRYPOINT，容器里没有 `doctor` 这个可执行文件                                         | 加短名：`docker compose exec crosspost crosspost doctor`（详见 [`docker.md`](docker.md) §6）                                                                                                                         |
| 挪动过仓库目录后扩展连不上                 | Chrome 对"加载已解压的扩展程序"记的是**绝对路径**，目录一挪那条路径就失效（`chrome://extensions` 显示"无法加载"） | **必须移除后重新加载**（点"重新加载"按钮不够：它只会按**原来记下的那条路径**重读）。`chrome://extensions` → 移除 CrossPost Bridge → 开发者模式 → 加载已解压的扩展程序 → 选新路径下的 `bridge/chrome-proxy-extension` |

## 3. 扩展未连接 / 版本不兼容

- 桥的 `/proxy/status` 会报扩展的 `clientId`、版本、是否 stale；
- 版本不匹配的策略是**告警不拒绝**：不匹配会明确报出来，而不是"显示已连接但发布静默失败"；
- **改了扩展代码必须重新加载**：`chrome://extensions` → CrossPost Bridge → 「重新加载」。
  扩展脚本只在**加载那一刻**读一次磁盘，而且扩展自带保活闹钟、它的 Service Worker 不会被
  浏览器回收 —— 所以不点重新加载就等于没改，浏览器里跑的仍是旧脚本；
- `doctor` 的「扩展版本」一项把**已连接版本**与 `bridge/chrome-proxy-extension/manifest.json`
  的版本摆在一起：两者不同就是这个原因，跟着它的 hint 重新加载即可；
- 排查"发布失败"先对齐**代码版本**：报错文案、`doctor` 的扩展版本、`/proxy/status` 的
  `version.engine` 三处必须与仓库当前代码对得上。对不上时先解决版本落后，再查平台侧
  （否则会把"跑着旧代码"误判成平台改版 / WAF / 登录态）；
- 装法：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `bridge/chrome-proxy-extension`。

## 4. 平台登录态是空的（或几个界面数字不一样）

平台登录态由扩展在**真实浏览器页面**里探测。检查范围是「引擎级平台设置 ∪ 各项目覆盖层」——
不带项目上下文的调用方（后台 tick、扩展面板）与 Console 必须得到**同一个答案**。

```bash
curl -s localhost:9540/proxy/status -H "X-CrossPost-Token: $(cat bridge/token.local)"
#   看 platforms.count / platforms.scope.ids / platforms.excluded
```

若某个界面确实少了平台，先确认那个平台在浏览器里是登录状态；若两个界面数字不一致，那是
**范围不一致**，不是你没登录。

**三种状态必须分开读**：未勾选的平台**不会被自动检查**，所以它们既不是"已登录"也不是
"未登录"，而是**未检查**。

| 数字            | 含义                                                       |
| --------------- | ---------------------------------------------------------- |
| 已登录 / 未登录 | 只统计**本轮真的查过**的平台（勾选范围内的那些）           |
| 未检查          | 勾选范围外的平台：登录态未知，发布时本就跳过               |
| 检查范围 `N/M`  | N = 本轮实际查到的平台数（点「刷新状态」走全量后就是 M/M） |

所以单独一个「未登录 0」只说明**勾选范围内**没有掉线的平台，不代表 27 个平台都在线。
扩展选项页会在有未检查平台时显示「未登录 0 · 未检查 15」并把那 15 个列在第二栏，
点「刷新状态」触发一次全量检查并在页面上等到结果出来。
要看某**单个**未勾选平台的登录态：Console 平台网格里点行内 🔍。

三态在界面上有**三种颜色**：已登录 = 绿、未登录 = 红、**未检查 = 琥珀**
（虚框图标 + 琥珀标签）；顶部状态卡下方那条细比例条把三者按「检查范围」画成三段。
选项页的深浅色跟随系统，也可用报头那枚 `☀/☾/◐` 键手动切换（存 `localStorage`，不写仓库）。

**tab 区自己说明"这批数字算不算数"**：每个 tab 两行 —— 上一行是计数
（数字带三态颜色），下一行是**可信度**。于是同一对数字在不同处境下不会被读错：

| tab 副标签       | 意思是                                            | 你该做什么                       |
| ---------------- | ------------------------------------------------- | -------------------------------- |
| 本轮已核验       | 刚查完，数字就是现状                              | 无                               |
| 复核中…          | 正在重算，上面是**上一轮**的数字                  | 等约 10s（全量）                 |
| 首次核对中…      | 桥刚起来、还没查过任何平台                        | 等；或点「刷新状态」             |
| `N 小时前的核验` | 缓存超过一个检查周期（默认 1h），桥下个整点会重查 | 想立刻看现状就点「刷新状态」     |
| 上次核对失败     | 上一轮检查没成功，数字仍是上一次的有效结果        | 看报头连接状态 / 点「刷新状态」  |
| 扩展未连接       | 浏览器扩展没连，检查根本发不出去                  | `chrome://extensions` 里重新加载 |
| 尚未核验         | 没有任何核验结果（不是"0 个已登录"）              | 点「刷新状态」                   |
| 数据不可用       | 连本地桥都取不到数，计数一律显示 `–`              | 看 `doctor`，桥没跑就起桥        |

两条容易误读的规则：**没核验过时不显示 0**（`已登录 –` / `未检查 15` 而不是 `未登录 0`）——
"0"是查过之后的结果，没查过就没有这个结果；**未检查平台的登录态是未知**，
所以它只有一格（桥侧 `platforms-state.json` 只保留当前范围的平台）。

复跑这条界面契约见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)（需要真浏览器）。

## 5. Console 上「一键生成」点了没反应

`doctor` 的「一键生成」项会告诉你端点是否有人听：

```
✔「一键生成」可用（N 个项目提供，端点均已监听）
```

接口里没有声明**首字延迟**，所以 doctor 只能答"有没有人听"，答不了"它快不快"。
项目侧的端点契约见 [`integration.md`](integration.md) §5。

### 点下去之后应该看到什么

| 界面上的字                           | 含义                                      | 该做什么                                                 |
| ------------------------------------ | ----------------------------------------- | -------------------------------------------------------- |
| 行内「排队中（第 N 位）」            | 已入队，前面还有 N-1 条在等（默认并发 1） | 等；汇总条会显示整体进度                                 |
| 行内「生成中 · 已运行 mm:ss」        | 正在跑                                    | 等；这一条是**真在跑**，秒数每秒刷新                     |
| 行内「查看《…》」                    | 完成，草稿已进文章库                      | 点进去人工检查后推送                                     |
| 行内「重试」+ 一行红字               | 失败，红字就是原因（不是错误码）          | 看原因；改完点「重试」，或到汇总条点「重试最后一条失败」 |
| 汇总条一片空白、行内还是「一键生成」 | **没有任何任务被受理**                    | 看行内有没有报错；报"端点连不上"就跑 `npm run doctor`    |

### 常见误判

- **"我点了 5 条，只有第 1 条在跑"** —— 这是默认行为：`topicsGenerateMaxConcurrency` 默认 1，
  其余 4 条排队。要同时跑得先放开项目侧的锁与并发，步骤见
  [`writing-pipelines.md`](writing-pipelines.md) §9（**只调引擎那一侧是没用的**）。
- **"任务跑完了，列表里还写未生成"** —— 引擎是先回填选题库、再置终态，
  理论上不会出现；如果真出现，说明项目侧的 `topic_pool_upsert.py` 与引擎同时写池子
  且项目侧没加锁，两边互相覆盖了。
- **"取消之后它还在跑"** —— 取消的语义是**引擎不再跟踪**。排队中的任务会立刻出队；
  已经在跑的那条，项目侧那次生成仍会跑完并把草稿落盘（跨进程，引擎杀不掉它）。
- **"`409` / 项目侧正忙"** —— 项目侧 provider 的并发上限满了。引擎并发 1 时不该出现，
  出现了就说明有别的来源（另一个客户端/定时链路）在占着。

## 6. 调度：看不到槽位 / 到点没跑

调度是**引擎自带的定时器**。诊断就三步：

```bash
# ① 定时器在哪、槽位什么状态（--json 机器可读）
node crosspost-runtime/src/commands/scheduler-cli.mjs status

# ② 还留着旧的系统任务吗（留着就会双发）
node crosspost-runtime/src/commands/scheduler-cli.mjs tasks

# ③ 今天该跑的槽位真的跑完没有（只读项目日志）
npm run verify:scheduled
```

判据：`backend` / `armed` + `armedReason` / `commandMissing` / `completedToday` / `unfinished`。

| 看到                                    | 含义                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 默认域只有「引擎任务」                  | 正常：项目槽位要**选中项目**才显示                                                                                                                           |
| `armed:false` + `armedReason:"no-lock"` | 定时器没有宿主进程 → 启动桥或 `scheduler-cli.mjs run`                                                                                                        |
| `commandMissing:true`                   | 项目还没写 `.crosspost/schedule.json`（或其 `command` 不可解析）→ 见 [`scheduling.md`](scheduling.md) §2                                                     |
| `unfinished:true`                       | 上次触发没写回结果（崩在中途）→ 按策略当天不自动重跑，可 Console「立即运行」                                                                                 |
| `legacyTasks` 非空                      | 旧的 launchd/systemd 任务仍在 → `scheduler-cli.mjs migrate`（**否则会双发**）                                                                                |
| LaunchAgents 里有个没见过的 plist       | `npm run doctor` 或 `scheduler-cli.mjs tasks`：被列进**「常驻服务」**的那一栏就是无到点触发的常驻进程（槽位执行器/生成提供者那类），**不用迁移**，也不会双发 |

时间对不上（差一小时/几小时）先看 `scheduler.tz`：槽位时间按它解释，与宿主机本地时区无关
（容器里记得传 `TZ`）。

**宿主必须活着**：定时器住在进程里。桥停了、`scheduler run` 没跑，到点就不会触发；
当天错过的会在**补跑窗口**（缺省 120 分钟）内于下次启动时补跑一次。
`npm run doctor` 的「定时调度」一项会把这三件事一起报出来。

`verify:scheduled` 只读日志，判定依据是"今日槽位日志存在 + 尾部有 `[END]` 收尾行 + 自报的发布摘要"。
**它不能证明草稿真的进了平台后台**——那需要你在 Console 或平台后台抽看一篇。

## 7. Console 整体变慢

先看 `/proxy/health` 里的**四条常驻 worker 车道**：

```bash
curl -s localhost:9540/proxy/health -H "X-CrossPost-Token: $(cat bridge/token.local)" | python3 -m json.tool
```

| 现象                                     | 含义                                   | 处置                                                                                                                                |
| ---------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 全部未运行                               | worker 起不来                          | 看桥日志；`npm run doctor`                                                                                                          |
| 某条冷却中                               | 该车道刚被杀，60 秒后自愈              | 等一个冷却周期；连续出现就查那条方法的内存/响应大小                                                                                 |
| `restarts` 持续增长                      | 车道反复崩                             | 看桥日志里该方法的 stderr（已带时间戳）                                                                                             |
| 首屏慢但车道正常                         | 前端在等多余请求                       | 首屏只等 `/proxy/articles`，其余三库在后台补齐统计条                                                                                |
| 只有三库慢（留存/归档/报表），其余视图快 | 记录簿记是"一篇一个 JSON 文件"的全量读 | 先量化再动手（`npm run bench:views`，见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)）；容器里这是**挂载路径的小文件 I/O**，不是队列堵塞 |

**看起来"整体慢"时先看车道，不要先怀疑网络。**

三库入口的性能判据是：**首项之后落到几十毫秒内，且"稳态记录读 = 0"**。
引擎用"记录快照 + 记录目录 mtime 判活"做到这一点——外部进程写记录会更新目录 mtime，
下一个请求自动重扫。若稳态读又变成几百次，按顺序查：

1. 代码没进常驻 worker（模块只在 spawn 时加载一次）：重启桥；
2. `CROSSPOST_DISABLE_RECORD_CACHE=1` 被设过（排障开关，会退回"每次全量读"）；
3. 记录目录被绕过 mtime 判活的方式改写（例如写在挂载之外、或用了别的写路径）。

关掉缓存后的代价是"每次全量读"，功能正确只是慢——它是回滚开关，不是优化开关。

## 8. 费用报表第一次打开很慢

会话索引是秒级 I/O。首次打开会触发预热分块，稳态应回到百毫秒级。
若持续慢，看 `costs` 车道状态与 `unzstd` 是否可用（见 [`dependencies.md`](dependencies.md)）。

## 9. 改了代码不生效 / 版本落后

`/proxy/status` 报的 `version.engine` 是**桥启动那一刻**的版本。桥给四条车道路各养一个常驻
`cli.mjs --ipc` 子进程，**模块只在 spawn 时加载一次**——所以"代码已提交"≠"桥已生效"。

```bash
launchctl kickstart -k gui/$(id -u)/com.crosspost.bridge     # macOS
systemctl --user restart crosspost-bridge                    # Linux

curl -s localhost:9540/proxy/status -H "X-CrossPost-Token: $(cat bridge/token.local)" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])"
```

容器部署还有一条关于**产物**的：`crosspost-runtime/core/dist` 在容器里是**私有卷**，
不随 `docker compose restart crosspost` 更新。所以入口脚本在启动时自己比一次"产物 vs 源码"
（判据与 `doctor` 的 `coreDistFreshness` 同一份）：**过期就地重建，再启桥** —— 容器下
`docker compose restart crosspost` 就够了，不用手动 build。

想跳过启动时那十几秒构建，也可以先把产物建好再重启：

```bash
docker compose exec crosspost sh -c 'cd "$CROSSPOST_REPO" && npm -C crosspost-runtime/core run build'
docker compose restart crosspost
```

`doctor` 的「core 产物比源码旧」一项在原生部署下仍会直接报出这种不同步（原生不会自动重建）；
容器下若重建失败，入口脚本**不拦启动**（继续用现有产物，`doctor` 报提醒），
等价的彻底重建口径是 `docker compose down -v && docker compose up -d` —— 它把依赖卷一起再生，只是慢几分钟。

## 10. 默认域里出现了属于某个项目的记录

记录应当写到**草稿所属项目**的簿记里；在默认域上下文发布项目草稿时，写入侧会按草稿归属纠正域。
若发现残留：

```bash
npm run repair:domain-orphans        # 默认 dry-run：先看清要动什么，再决定是否执行
```

`doctor` 有一条提醒级检查 `default-domain-orphans` 会先告诉你有没有。

## 11. DSH 会话里少了 7 个 `xp_*` 工具（preset 载体在 0.2.0 变了）

**症状**：DSH 照常启动、MCP 面（`mcp__crosspost__*`）也正常，但新会话的工具目录里
没有 `xp_platform_status` / `xp_render_preview` 这一组**原生**工具。DSH 不报任何错。

**原因**：DSH 0.2.0-rc.2 起，预设不再从目录读——`$DSH_HOME/.agent-presets/<id>/`
（`preset.yml` + `agent.cordis.yml`）**已无任何读取方**（`@deepseek-ai/dsh-agent-preset`
的 `editing-cordis-compositions` skill：_"Nothing reads that directory any more"_）。
预设现在是一条 **bundle patch 里的 `@deepseek-ai/dsh-agent-preset` 声明行**，
bundle 由 profile 的 `dsh.profile.bundles` 装载。所以"文件还在"不等于"能力还在"。

**诊断**（从快到慢）：

```bash
npm run doctor            # preset-bundle / preset-installed 两条直接给结论
bash preset/upgrade-check.sh   # 逐条：声明行、安装链接、行名可达性（第 2/3/3b 节）
```

**安装**（仓库即源，改代码免重装）：

```bash
# 1) 目标 profile（本机是 ~/.dsh/profiles/web）的 package.json：
#      dependencies: { "preset-crosspost": "link:/Users/me/crosspost/preset/crosspost" }
#      dsh.profile.bundles: [..., "preset-crosspost"]
# 2) 在该 profile 目录执行（pnpm 不在 PATH 时用 corepack）：
cd ~/.dsh/profiles/web && corepack pnpm install
# 3) 确认是软链（realpath 必须指回仓库；副本安装 = 改代码要重装）
node -e "console.log(require('fs').realpathSync('node_modules/preset-crosspost'))"
```

`link:` 与 `file:` 的区别值得记住：**`link:` 是直接软链（仓库即源）**，
`file:` 会被 pnpm 物化成 `.pnpm/...` 下的副本树——那时改仓库必须重装，
而 `upgrade-check.sh` 第 2 节与 `doctor` 的 `preset-installed` 都会把这件事说出来。

**新会话才生效**：已存在的会话在启动时就固定了插件 revision，换预设/装 bundle 后要**新开**一个。

**升级后**（这是本节的真正用途）：跑 `bash preset/upgrade-check.sh`。它的第 3b 节会逐个按
模块解析预设里的 `@deepseek-ai/*` 名——**包改名/被删时那一行会静默消失**，这是唯一能自动发现的地方
被改名或删除的包（例如 `dsh-workflow-worker-thread` 已被 `dsh-workflow-ptc` 取代）只能靠它发现。

## 12. 敲了斜杠指令却看不到结果（全新空会话）

**症状**：在一个**还没有任何对话内容**的新会话里敲 `/crosspost-status` 这类指令，
界面没有任何变化。而指令其实执行了——会话日志里有 `command/run` 与 `command/done`，
内容也对。

**原因**：DSH 的指令结果渲染成**流程节点**，而聊天流程视图只在「存在非指令节点」时才算活跃；
客户端在「空会话且无活跃目标」时渲染的是**欢迎页**，指令卡片被它盖住。
空会话里跑 `/compact`、`/goal` 同样如此。

**三种处理**：

1. **先发一条消息**（哪怕一个「hi」）再用指令——会话不再是空会话，结果就会显示。
2. **给 DSH 打一个本地维护补丁**（让「只有指令节点」也算活跃），刷新页面后生效：

   ```bash
   bash preset/patches/dsh-blank-session-command-nodes.sh            # 幂等
   bash preset/patches/dsh-blank-session-command-nodes.sh --status   # 只看状态
   bash preset/patches/dsh-blank-session-command-nodes.sh --revert   # 还原
   ```

   补丁改的是 DSH 安装目录里的构建产物，**npx 重新安装或升级 DSH 会覆盖**；
   升级后重放一次即可，`preset/upgrade-check.sh` 第 0 节会在补丁被冲掉时提醒。
   约定见 [`../preset/patches/README.md`](../preset/patches/README.md)。

3. **不依赖界面**：同样的数据可以直接问引擎，例如
   `node crosspost-runtime/src/cli.mjs listCosts --project=wechat-auto`
   （接口面见 [`api-surfaces.md`](api-surfaces.md)）。

## 13. 宿主与容器各跑着一个桥（定时器归属 / 双发风险）

同一个引擎只能有一个实例跑定时器。锁在 `<localRoot>/scheduler/lock`，**跨宿主 / 容器用心跳判活**：
另一个命名空间的实例心跳还新鲜就拒绝接管，并按设计打印

```
[scheduler] 未取得调度锁：定时器已由另一个 PID 命名空间/主机的实例持有：pid=… （bridge @ …）
宿主与容器不能同时跑定时器（会双发）——要切换请先停掉另一个。
```

要看现在归谁：

```bash
cat .local/scheduler/lock            # hostname = 容器 id 就是容器持有
docker compose ps                    # 容器在不在
```

**要注意的一点**：桥只在**启动时**抢一次锁，之后不重试。所以"另一个实例"退出后，
留在场上的那个不会自动接手——必须重启它（`docker compose restart crosspost`）才会重新 arm。
排查顺序：先确认谁是持有者，再停掉不要的那个，最后重启要留下的那个。

DSH 预设里的 CrossPost 插件启动前会先探测本机是否已有桥（探测到就不自拉起），
避免自己变成那个"另一个实例"；判定与起桥逻辑见
[`../preset/crosspost/README.md`](../preset/crosspost/README.md)。

## 14. 文章详情里「记录概览」是空的（只剩打分与风险）

**症状**：打开某篇的抽屉 →「发布记录」→「记录概览」只有「风险分类 / 质量评分 / 平台推送
0 成功 · 0 失败 · 0 共推 / 通知 none」，发布历史写着「暂无发布历史」；文章列表里那一行的状态徽标
旁会多一个 **⚠ 无记录**。

**含义**：这条**记录是空骨架**——引擎的记录写盘失败了（常见：`project-state/<项目>/articles/`
不可写，例如桥跑在没有该目录写权限的沙箱里），而文件本身已经就位。于是下一次扫描只按草稿
frontmatter 登记一条骨架，决策、审稿、AI 检测、产物归档、平台结果全都缺。**注意这与"这篇没发过"
是两回事**：稿子可能确实生成过、甚至已经发布过。

**补录**（文件不需要再动，重跑对应的处置命令即可；重跑是幂等的）：

```bash
# ① 一篇一篇补（原因取原文；AI 门禁行直接传 ai_detect 返回的 snapshot）
node crosspost-runtime/src/cli.mjs retainArticle --id=<草稿id> --dir=rejected --reason="<原原因>"

# ② 不知道缺了哪几篇：先看计划（dry-run），再一键补齐（写前把记录原件备份到 <localRoot>/repairs/）
node crosspost-runtime/src/cli.mjs repairRecords --project=<项目>
node crosspost-runtime/src/cli.mjs repairRecords --apply --project=<项目>
```

`repairRecords` 以**文件系统事实**为准：扫 `drafts/rejected` + `drafts/risk`，凡"文件在留存库、
记录却缺（或只有一条没有 `history` 的空骨架）"的都补成 `status=retained` + `dir` + `retainedReason`
（原因优先取记录里已有的，其次取选题库同一 `articleId` 的 reason，都取不到就写"对账补写：见 run 日志"，
**不编造 AI 数值**）。同一 id 在多个目录各有一份（记录描述的是归档/风险那一份）时不自动改写，
只报出来等你人工确认。Console 留存库的「补录缺失记录」按钮与 `doctor` 的 `records` 检查走同一个实现。

**决策 / 审稿 / AI 检测为什么也常常是空的**：这三样只有**发布器**会写（`publish_article` 的
`decision` / `review` / `aiDetect` 入参），而 draft-only 链路（一键生成、定时生成）从不调发布器 ——
判定与结论都产出了，却没有落点。补写用非发布入口：

```bash
node crosspost-runtime/src/cli.mjs aiDetect --id=<草稿id> --record --note="第2轮复检"   # AI 检测门禁行
node crosspost-runtime/src/cli.mjs recordWriting --id=<草稿id> --decision="<决策行原文>" --review="<审稿行原文>"
```

（MCP 面分别是 `ai_detect` 的 `record: true` 与 `record_writing`。两个入口都只打这次要改的键，
不会清掉另一个字段；写盘失败只回 `recordError`，判定结果照常返回。）

**归档库与留存库也能查这些字段**：这两库里的行可以直接点开抽屉（**只读**：不显示编辑 / 留存 /
重推那些动作，默认停在「发布记录」），决策、审稿、AI 检测、留存原因与推送结果都在里面 ——
文章发布后记录随它一起进归档库，那里是复盘唯一能看到全貌的地方。

失败时命令会把状态说清楚：`{"error":"…记录写入失败（文件已移入 rejected/，需重跑本命令补录）…",
"fileMoved":true,"recordError":"…"}` —— `fileMoved=true` 表示**文件已经移好了**，只有账没记，
照上面重跑一次即可（`findDraftFile` 会到 `rejected/` 里找到它）。

> **写入方为什么会失败**：写作 agent 跑在文件沙箱里（只能写自己的工作区），而引擎簿记在
> `<引擎仓库>/.local/` 下 —— 越界即 `EPERM`，于是出现"文件已留存、记录没写"。所以写作侧用
> MCP 工具 `mcp__crosspost__retain_article`（记录由引擎进程写，不受调用方沙箱限制）；
> `repairRecords` 是对账兜底：任何写入方（裸 `mv`、回退链路、中途中断）丢的记录都能补回来。

判据由引擎派生下发：`listArticles` / `getArticle` 的每条记录带 `recordHealth`（`ok` | `empty`，
`empty` = 该记录一条 `history` 都没有）。Console 用它显示列表角标与抽屉里的警告行。
