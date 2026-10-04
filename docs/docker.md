# Docker（可选运行形态）

> **一句话**：桥 + 引擎 + Console 跑在一个容器里，**浏览器扩展仍在宿主机浏览器**。
> 定时调度由引擎自带的定时器负责（住在容器内的桥进程里），不需要任何系统定时器。

## 1. 它长什么样

```
宿主机浏览器                     容器（bridge 进程）
  ├─ 扩展 ──ws://127.0.0.1:9539──▶ 桥
  └─ Console ─http://127.0.0.1:9540─▶ 桥
                                     ├─ 引擎（渲染 / 适配器 / 草稿）
                                     ├─ 定时器（内置，按 scheduler.tz 触发）
                                     └─ 项目槽位（经 HTTP 交给项目自己执行）
```

- 只有**两个端口**，且都只发布到宿主机环回（`127.0.0.1`）——与原生运行时的边界一致。
- 仓库以**同一个绝对路径**挂进容器：`paths.json` / `config.json` / 项目 manifest 里那些
  绝对路径**零改写**（这是整套方案能成立的关键）。
- 镜像里**没有代码**：只有 Node 24 + `curl` / `git` / `tzdata` / `gosu`。
  依赖在容器私有卷里（本机与容器的原生依赖不能共用）。
- compose 的**项目名是显式钉住的**（`docker-compose.yml` 顶层的 `name:`）。compose 默认取
  目录名作项目名，而容器名 / 卷名 / 网络都带这个前缀——仓库目录一改名就会换出一套空卷，
  症状是"容器还 healthy，但引擎莫名缺依赖"。钉住之后目录改名不再影响卷名。

## 2. 三步起来

**先决条件：同一台机器上只能有一个定时器。** 如果这台机器上还装着原生桥的守护
（macOS launchd / Linux systemd 用户单元），它和容器里的桥会各自 arm 一套槽位
（锁在 `<localRoot>/scheduler/lock`，而两个 PID 命名空间互不认账）→ **到点双发**。
先把它停掉并让出 9539/9540：

```bash
# macOS：卸载守护（连登录自启一起关掉；要恢复见 §8）
bridge/install-launchd.sh uninstall
# 或者只临时停一次、保留 plist：launchctl bootout gui/$(id -u)/com.crosspost.bridge

# Linux：systemctl --user disable --now crosspost-bridge

lsof -nP -iTCP:9539 -iTCP:9540 -sTCP:LISTEN     # 期望空（端口已让出）
```

```bash
cd <仓库根>
export CROSSPOST_REPO="$PWD"
export HOME="$HOME"                 # compose 用它做同路径挂载

docker compose build                # 需要额外系统包时：EXTRA_APT="python3 chromium" docker compose build
docker compose run --rm crosspost setup   # 可选：显式预装依赖（首次需要网络，几分钟）
docker compose up -d

curl -fsS http://127.0.0.1:9540/ >/dev/null && echo "Console OK"
docker compose exec crosspost crosspost doctor    # 期望 0 失败项
docker compose logs -f crosspost
```

然后照常装扩展：`chrome://extensions` → 开发者模式 → 加载 `bridge/chrome-proxy-extension`
（**宿主机**的这个目录）→ 打开 Console 自检页。

> 首次 `up` 可能要几分钟（装子包依赖 runtime / bridge + 构建渲染核心）。
> `docker compose run --rm crosspost setup` 把这一步显式化，失败时能直接看到原因；
> 跳过它也行，entrypoint 会在缺依赖时自动补。

> **`run` 与 `exec` 的区别**：`docker compose run` 会走镜像的 ENTRYPOINT
> （那一层把 `setup` / `doctor` / `cli` / `scheduler-cli` 翻成真实命令），
> 而 **`docker compose exec` 不走 ENTRYPOINT** —— 所以 exec 时要走短名
> `crosspost`（镜像里指向同一个入口脚本）：
> `docker compose exec crosspost crosspost doctor`。
> 一次性命令用 `docker compose run --rm crosspost doctor` 也行（`--rm` 用完即删）。

## 2.1 可选：让容器里的飞书通知能用

只有 `notify.channel = "lark"` 才需要这一步（webhook 通道是纯 HTTP，容器里开箱即用）。

引擎发通知走的是 **bot 身份**（`im +messages-send --as bot`）→ 需要**应用凭据**，
不是用户登录。容器**读不到**宿主的密钥（它在 macOS 钥匙串里），所以要在容器里配一次：

```bash
# App Secret 走 stdin（不进进程列表）；app-id 见宿主 lark-cli config 或开放平台后台
docker compose exec -T crosspost lark-cli config init \
  --app-id cli_xxxxxxxxxxxx --app-secret-stdin
# 然后自证（doctor 也会查这一条）：
docker compose exec crosspost lark-cli auth status     # 期望 identities.bot.status = ready
curl -s -X POST -H "X-CrossPost-Token: $(cat bridge/token.local)" \
  http://127.0.0.1:9540/proxy/notify-test              # Console「发送测试通知」等价
```

两点注意：

- 容器与宿主共享 `~/.lark-cli`（同路径挂载），这一操作会写那份配置；
  写完**复核宿主**一次（`lark-cli auth status`），异常就从备份恢复。
- 不想配凭据就把 `notify.channel` 改成 `webhook`（需要一个群机器人 URL）——
  那条路径与容器完全解耦，也不需要在镜像里装 CLI（`--build-arg LARK_CLI_VERSION=` 可跳过）。

## 3. 定时调度在容器里

- 触发者是**容器内的桥进程**：`docker compose up -d` 起的就是它。
  `restart: unless-stopped` 保证崩溃后自愈。
- 槽位时间按 `config.scheduler.tz`（缺省 `Asia/Shanghai`，可用 `CROSSPOST_SCHEDULER_TZ` 覆盖）解释——
  compose 里的 `TZ` **不参与**这个判定，所以换台机器/换个容器都不会漂。
- **执行不在容器里（必读）**：槽位有"谁持有钟"和"谁执行脚本"两件事，容器只负责前者。
  项目在 manifest 里声明 `capabilities.schedule = {kind:'http',url,statusUrl}` 后，
  到点由容器里的桥**发一次 HTTP** 给项目自己的执行器，脚本在**项目那侧的环境**里跑
  （该有的解释器/CLI/内网访问都在那边）。
  参考实现：[`../examples/slot-runner-http/server.mjs`](../examples/slot-runner-http/server.mjs)；
  契约与规则见 [`scheduling.md`](scheduling.md) §4b。
  - 为什么必须这样：容器的命名空间里没有项目那套运行时。项目脚本常依赖宿主原生二进制
    （某个 CLI、某个原生模块），在 linux 容器里加载会失败 → `exit=1`、当日零产出。
  - 只声明 `command`（本地执行器）的项目在容器模式下会**明确失败**：Console 调度区显示
    「跑失败(exit=N)」，项目日志里能看到容器内缺哪个运行时。
- 想只要定时器、不要桥？`docker compose run --rm --service-ports crosspost scheduler`。
- 从旧系统任务迁过来：`docker compose run --rm crosspost scheduler-cli migrate --dry-run`
  （容器里做的事与原生一致，见 [`scheduling.md`](scheduling.md) §6）。

## 4. 必须知道的边界

| 边界                        | 说明                                                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 扩展在宿主机                | 容器不提供浏览器；扩展是唯一的出网口，登录态在**你的**浏览器里                                                                                                                                                                                                                       |
| 项目里的 `127.0.0.1:<端口>` | 在容器内指向**容器自己**。**不用改 manifest**：compose 默认带 `CROSSPOST_HOST_GATEWAY=host.docker.internal`，引擎会把项目声明的**回环**主机名重写成它（远程端点不动、原生形态不受影响）。生成服务就跑在同一容器里时把它**留空关掉**（`CROSSPOST_HOST_GATEWAY=docker compose up -d`） |
| 样式采样                    | 容器里没有 Chrome → 自动降级为 `fetch`；要保真就 `EXTRA_APT="chromium"` 重建（此时该请求从容器出网）                                                                                                                                                                                 |
| `${HOME}` 同路径挂载        | 暴露面与原生运行**相同**（原生进程本来就能读 `$HOME`）。要更窄就按 §5 换成窄挂载                                                                                                                                                                                                     |
| Linux 宿主属主              | 建议 `CROSSPOST_UID=$(id -u) CROSSPOST_GID=$(id -g) docker compose up -d`，否则挂载目录里会出现 root 属主文件                                                                                                                                                                        |
| 依赖卷                      | 别在容器里把依赖装到宿主路径：`node_modules` / `core/dist` 是**容器私有卷**                                                                                                                                                                                                          |
| 宿主的根 `node_modules`     | 同路径挂载让容器**看得见**它（里面只有 eslint/prettier/typescript）。引擎进程优先命中 runtime 卷里那份 Linux 依赖；容器构建 core 时用的 `typescript` 也来自 runtime 卷                                                                                                               |
| 同机两个定时器              | 宿主守护与容器桥**不能同时跑**：锁记录带心跳，能识别"另一个命名空间持有"，但**并行运行仍然是不支持的**。先停一个（见 §2 先决条件）                                                                                                                                                   |
| `exec` 不走 ENTRYPOINT      | `docker compose exec crosspost doctor` 会 exit 127（容器里没有 `doctor` 这个可执行文件）。用短名：`docker compose exec crosspost crosspost doctor`                                                                                                                                   |
| 容器内写文件的属主          | macOS 宿主：容器里是 root，落到宿主是**当前用户**（Docker Desktop 的映射）。Linux 宿主仍需按上一行设 `CROSSPOST_UID/GID`                                                                                                                                                             |
| 挂载路径的小文件 I/O        | Docker Desktop 的 file sharing 让每次小文件读明显慢于原生，而三库入口（留存 / 归档 / 报表）要读记录簿记。引擎用"记录快照 + 目录 mtime 判活"把稳态读次数压到 0；仍想量化就用 `npm run bench:views`（见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)）                                      |
| 镜像里的可选 CLI            | 镜像自带 `unzstd`（费用报表解压会话）与 linux 版 `lark-cli`。lark-cli **始终装最新**（`--build-arg LARK_CLI_VERSION=1.0.79` 可钉住、留空则不装、镜像小约 50MB）；升级要走 `LARK_CLI_REFRESH=$(date +%s) docker compose build`，否则 Docker 层缓存会把 `latest` 钉在旧版本            |
| 凭据不跟着挂载走            | `$HOME` 同路径挂载让容器读得到宿主的 `~/.lark-cli/config.json`，但**密钥/令牌存在 macOS 钥匙串里**，容器取不到 → 容器必须自己配一次（见 §2.1）。别指望"挂进来就能用"                                                                                                                 |

## 5. 换成窄挂载（更严格的边界）

把 compose 里的 `${HOME}:${HOME}` 去掉，改成逐目录同路径挂载（路径必须**逐字相同**）：

```yaml
volumes:
  - '${CROSSPOST_REPO}:${CROSSPOST_REPO}' # 仓库（含 config.json / paths.json）
  - '/Users/me/my-writing-project:/Users/me/my-writing-project' # 每个接入项目
  - '/Users/me/.dsh/sessions:/Users/me/.dsh/sessions:ro' # 费用报表用的会话目录（只读）
  - runtime-node-modules:${CROSSPOST_REPO}/crosspost-runtime/node_modules
  - bridge-node-modules:${CROSSPOST_REPO}/bridge/node_modules
  - core-dist:${CROSSPOST_REPO}/crosspost-runtime/core/dist
  - npm-cache:/deps/npm-cache
```

## 6. 日常操作

```bash
docker compose logs -f crosspost                          # 日志
docker compose exec crosspost crosspost doctor            # 自检（注意：exec 要走 crosspost 短名）
docker compose exec crosspost crosspost scheduler-cli status   # 调度状态（槽位 / 下次触发 / 是否 arm）
docker compose exec crosspost crosspost scheduler-cli tasks    # 还留着的旧系统任务
docker compose exec crosspost crosspost cli listArticles       # 引擎 CLI（方法名见 docs/api-surfaces.md）
docker compose restart crosspost                          # 改了桥 / 运行时的 js 后重启（常驻进程只在 spawn 时加载一次）
docker compose exec crosspost sh -c 'cd "$CROSSPOST_REPO" && npm -C crosspost-runtime/core run build'
                                                          # 改了 core/ 源码：产物在**容器私有卷**里，restart 不会重建它
docker compose build                                      # 重建镜像（改 Dockerfile / 要升级镜像内的 lark-cli 时）
LARK_CLI_REFRESH=$(date +%s) docker compose build         # 升级镜像内的 lark-cli（latest 会被层缓存钉住，必须刷）
LARK_CLI_VERSION= docker compose build                    # 不装 lark-cli（镜像小约 50MB，配合 webhook 通道）
docker compose down                                       # 停止（数据都在挂载卷里）
docker compose down -v                                    # 连依赖卷一起删（下次启动会重新装依赖）
```

### 拉取了新代码之后，怎么让容器跑上新版

先分清"哪一半是活的挂载、哪一半是需要重建的产物"，再决定动哪一步：

| 变的是什么                              | 容器要做什么                                     | 为什么                                                                                          |
| --------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `bridge/**`、`crosspost-runtime/src/**` | `docker compose restart crosspost`               | 同路径挂载：文件**立刻**就是新的；但桥是常驻进程，只在启动时 import 一次 → 必须重启进程才会加载 |
| `crosspost-runtime/core/src/**`         | 重启 **+** `crosspost setup`（重建 `core/dist`） | `core/dist` 是**容器私有卷**：`build` 只作用镜像层，`restart` 更不会重建它                      |
| `docker-compose.yml` / `Dockerfile`     | `docker compose up -d`                           | 变的是容器定义。注意 **`up -d` 只在定义真的变了时才重建容器**——纯代码更新跑它可能什么都不发生   |
| `package.json` / lock（新增依赖）       | `docker compose exec crosspost crosspost setup`  | entrypoint 的"缺依赖才装"按**关键包存在性**判断，已存在就不会重装                               |

> **别只看"容器还 healthy"。** 桥不 import `@crosspost/core`，所以 `core/dist` 空/旧
> 时容器照样 healthy、Console 照样打得开——只有真正发布那条路才炸。
>
> 判断"进程是否已加载新代码"要**用行为自证**，而不是看版本号：代码是挂载的，
> 容器里的源码版本永远等于宿主机当前检出的版本。挑一个**新版本才有**的端点问一下，
> 用状态码区分新旧（下例的问法要求带上项目头、且那个项目真有选题库，按自己的接口与项目改）：
>
> ```bash
> T=$(cat bridge/token.local)
> curl -s -o /dev/null -w '%{http_code}\n' -H "X-CrossPost-Token: $T" \
>   -H 'X-CrossPost-Project: <项目 id>' \
>   http://127.0.0.1:9540/proxy/topics/generate/tasks    # 200=已加载新代码；404=还是旧进程
> ```

> 依赖卷都是**可再生的**：删掉之后下一次 `up` 会自动重装依赖、重建 core，只是多花几分钟。
> 真出现孤儿卷（例如手工改过项目名）按下式回收——**用通配，别抄具体名字**：
>
> ```bash
> docker volume ls | awk '/^local[[:space:]]+<旧项目名>_/ {print $2}' | xargs -r docker volume rm
> ```

## 7. 常见故障

| 症状                                                                      | 原因 / 修法                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CROSSPOST_REPO 不是目录`                                                 | 忘了 `export CROSSPOST_REPO="$PWD"`，或仓库没在 compose 的挂载列表里                                                                                                                                                                                                                                                                                                                                     |
| 端口 `address already in use`                                             | 原生桥还在跑（macOS launchd / Linux systemd），或另一个容器占着 9539/9540；先停掉，见 §2 先决条件                                                                                                                                                                                                                                                                                                        |
| 容器起来了但读不到项目/草稿                                               | 挂载路径与宿主**不一致**（绝对路径解析会失效）；核对 `docker compose config` 里的挂载                                                                                                                                                                                                                                                                                                                    |
| 扩展连不上                                                                | 端口被别的进程占了，或扩展选项页的端口不是 9539；`docker compose ps` 看端口映射                                                                                                                                                                                                                                                                                                                          |
| `doctor` 说「命令不可用」                                                 | 项目脚本依赖不在镜像里（`EXTRA_APT` 重建）或声明的 `command[0]` 在容器内不存在                                                                                                                                                                                                                                                                                                                           |
| 到点没触发                                                                | 容器在跑吗（`docker compose ps`）？`scheduler-cli status` 里 `armed` 与 `armedReason` 是判据                                                                                                                                                                                                                                                                                                             |
| `armedReason=no-lock` 或有两个定时器                                      | 同机还跑着另一个桥（另一个命名空间）。`crosspost scheduler-cli status` 会打出**谁持有**（含 hostname 与心跳年龄）；停掉多余实例后重启本进程即可恢复                                                                                                                                                                                                                                                      |
| 当天补跑没发生                                                            | 补跑窗口缺省 120 分钟；超窗口按策略放弃（`scheduler.catchUpMaxMinutes` 可调）                                                                                                                                                                                                                                                                                                                            |
| 槽位时间差几小时                                                          | `TZ` 与 `scheduler.tz` 不一致；两者都设成你要的时区                                                                                                                                                                                                                                                                                                                                                      |
| 镜像太大                                                                  | 默认没装浏览器；确认没在 `EXTRA_APT` 里加了大件                                                                                                                                                                                                                                                                                                                                                          |
| `docker compose build` 卡在拉基础镜像 / `failed to fetch anonymous token` | 代理或 DNS 问题：Docker Desktop → Settings → Resources → Proxies 指到你**活着**的本地代理端口；直连被墙时 Docker Hub 走不通。应急可 `DOCKER_BUILDKIT=0 docker compose build`（经典构建器走 daemon 的 pull 通道，与 buildkit 自己的 registry 客户端不是一条路）                                                                                                                                           |
| 容器 `healthy` 但引擎不干活（Console 打得开、发布/检查全失败）            | 引擎的 `@crosspost/core` 没构建出来：看 `docker compose logs crosspost` 有没有 `ERR_MODULE_NOT_FOUND ... @crosspost/core/dist/...`。判据是**四个入口产物**在不在（不是 `core/dist` 目录在不在——容器私有卷首次挂载就是个空目录）。entrypoint 会在缺产物时自动补构建；确认一次：`docker compose exec crosspost sh -c 'cd $CROSSPOST_REPO && find crosspost-runtime/core/dist -type f \| wc -l'`（期望 28） |
| 诊断命令本身 exit 127                                                     | `exec` 不走 ENTRYPOINT：加 `crosspost` 短名（§6）                                                                                                                                                                                                                                                                                                                                                        |
| 「一键生成」在容器里连不上（宿主那个端口明明在听）                        | 容器里的 `127.0.0.1` 指容器自己。compose 默认带 `CROSSPOST_HOST_GATEWAY=host.docker.internal`，引擎会把项目声明的回环主机名重写成它；**没生效**就查两处：容器 env 有没有这个变量（`docker compose exec crosspost sh -c 'echo $CROSSPOST_HOST_GATEWAY'`）、`extra_hosts` 是否还在。诊断信息里会打出「声明 … → 实际拨号 …」                                                                                |
| 费用报表在容器里读不到会话（`unzstd` 缺失）                               | 镜像自带 `zstd`（`/usr/bin/unzstd`）。自建子镜像里没有的话：`EXTRA_APT="zstd"` 重建；代码按 PATH 解析，不写死路径                                                                                                                                                                                                                                                                                        |
| 留存库 / 归档库 / 报表在容器里比原生慢                                    | 先量化再动手：宿主与容器跑同一个对照脚本（`npm run bench:views`，见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)）。期望两个形态的"首项之后"都落到几十毫秒、且**稳态记录读 = 0**。若容器里稳态读又变成几百次：①引擎代码没进常驻 worker（`docker compose restart crosspost`）；②`CROSSPOST_DISABLE_RECORD_CACHE=1` 被设过；③记录目录的 mtime 判活被绕过（记录被写在挂载之外/被别的手段改写）                   |
| 「整站变慢」但车道健康                                                    | `curl -s localhost:9540/proxy/health -H "X-CrossPost-Token: $(cat bridge/token.local)"` 看四条车道：`alive=true`、`restarts` 不增长、`coolingDown=false` 时，瓶颈多半在**挂载路径的小文件 I/O**（上一行），不在网络也不在 worker                                                                                                                                                                         |
| 飞书通知发不出：`doctor` 说「飞书 CLI 可用」但消息没到                    | 二进制在 ≠ 身份可用。看 doctor 的**「飞书通道：身份可用（bot ready）」**那条：容器拿不到宿主钥匙串里的密钥 → 按 §2.1 在容器里 `lark-cli config init --app-id … --app-secret-stdin`，或改走 webhook 通道                                                                                                                                                                                                  |
| 镜像里 `lark-cli` 命令在、一跑就报找不到二进制                            | npm 11.19 起默认**不跑**依赖的 install 脚本，而 `@larksuite/cli` 靠 postinstall 下平台二进制。Dockerfile 里必须有 `--allow-scripts=@larksuite/cli`（已有）；自建镜像别漏                                                                                                                                                                                                                                 |

## 8. 在「原生守护」与「容器」之间切换

两种形态**共用同一份数据**（`.local/`、`config.json`、`paths.json`、项目的草稿与簿记都在
同路径挂载里），所以切换只是"停一个、起一个"，不需要迁移任何数据。

**原生 → 容器**

```bash
# ① 停原生守护（macOS 示例；Linux 用 systemctl --user disable --now crosspost-bridge）
bridge/install-launchd.sh uninstall

# ② 确认端口让出来了、且没有第二个定时器
lsof -nP -iTCP:9539 -iTCP:9540 -sTCP:LISTEN          # 期望空
node crosspost-runtime/src/commands/scheduler-cli.mjs status   # 锁应显示"空闲"或容器持有

# ③ 起容器
export CROSSPOST_REPO="$PWD" HOME="$HOME"
docker compose up -d && docker compose exec crosspost crosspost doctor
```

**容器 → 原生**

```bash
docker compose down
bridge/install-launchd.sh install 9539    # Linux：bridge/install-systemd.sh install 9539
```

两条纪律：

- **别让两边同时跑**（双发，见 §4 与 §7）。
- 宿主重启后想让容器自动起来，得让 Docker Desktop 随登录启动
  （Settings → General → _Start Docker Desktop when you sign in_）；
  否则重启后没人 arm 定时器，当天的槽位要等下次启动才补跑（窗口 120 分钟，见 [`scheduling.md`](scheduling.md)）。
