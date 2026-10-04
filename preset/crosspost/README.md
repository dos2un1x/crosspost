# DSH agent preset（多平台发布助手）

把 CrossPost 的发布能力挂到一个 **DSH agent** 上的预设（可选件：不用 DSH 也能用 CLI / MCP / Console）。

| 文件                                         | 作用                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                               | bundle manifest：`name` + `version` + **`dsh.bundle.patch`**（缺它安装器判 `not-a-bundle`）                                                                                                                                                                                                                                      |
| `cordis.patch.yml`                           | **预设本体**：一条 `@deepseek-ai/dsh-agent-preset` 声明行，`config.plugins` 是条目列表（人格 + 工具 + 本地插件）。**本地插件必须写成包名** `preset-crosspost/plugins/crosspost.js`——相对名 `./plugins/…` 会按 profile 目录解析而找不到文件（见下方"本地插件的 specifier"）                                                       |
| `plugins/crosspost.js`                       | 自写静态插件：7 个 `xp_*` 工具（发布/重推/平台状态/渲染预览/草稿读取…），并在需要时**自拉起本机桥**（`bridge/run-bridge.mjs`）                                                                                                                                                                                                   |
| `plugins/commands.js`                        | 人用斜杠指令：`/crosspost-status`、`/crosspost-projects`、`/crosspost-platforms`、`/crosspost-styles`、`/crosspost-drafts`、`/crosspost-costs`、`/crosspost-help`（见下方「人用斜杠指令」）                                                                                                                                      |
| `runtime`                                    | 软链到 `../../crosspost-runtime`：插件**模块内部**用 `../runtime/src/*.mjs` 引用引擎源码。模块内的相对导入按插件文件自身位置解析，所以这条软链成立；而**条目列表里的相对行名不是这套规则**（见下）                                                                                                                               |
| `node_modules/@deepseek-ai/dsh-tools`        | 软链到部署：插件 `import { defineTool } from '@deepseek-ai/dsh-tools'`                                                                                                                                                                                                                                                           |
| `node_modules/@deepseek-ai/dsh-agent-preset` | 软链到部署：`cordis.patch.yml` 里 `skill-filesystem.customSkillDirs` 用 `createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')` 定位**内置 skill 目录**。`baseUrl` 是本 patch 文件所在目录，而本目录不在部署里，所以必须自己把它链上（部署换路径时这条链会断——`preset/upgrade-check.sh` 第 1 节会报出来） |

## 本地插件的 specifier：必须是包名（0.2.0 的硬规则）

`config.plugins` 里挂本地插件时，写成**包名 + 子路径**：

```yaml
- id: crosspost-tools
  name: 'preset-crosspost/plugins/crosspost.js' # ← 包名（= package.json 的 name）+ 子路径
```

**不能**写成 `./plugins/crosspost.js`。`dsh-app-boot` 的 boot 契约明写
_"Relative entry names resolve against the config directory"_——相对名解析的是
**profile 目录**（`$DSH_HOME/profiles/<profile>/`），不是本 bundle 目录。后果是：
那一行拿不到 fiber，声明挂载**看似成功**，而**新会话一绑定就失败**：

```
agent-preset/invalid: crosspost-tools (./plugins/crosspost.js): never started
```

写成包名后交给模块解析：bundle 是 profile 的依赖（`link:` 安装下指向本仓库），
从 config 目录一定解析得到。上游的同一句指导是
_"Resolve assets from installed packages rather than a preset directory"_。

两条硬约束都有护栏盯着：specifier 必须等于 `<package.json 的 name>/plugins/crosspost.js`
（`crosspost-runtime/tests/deployment-consistency.test.mjs`），且必须能按模块解析到
（`preset/upgrade-check.sh` 第 2/3b 节）。

## 人用斜杠指令（`plugins/commands.js`）

DSH 输入框的 `/` 菜单只列**人用指令**（`commands` 服务）；MCP 工具（`mcp__crosspost__*`）
属于**模型面**的工具注册表，**从来不在那个菜单里**。这个插件补上人在输入框能直接敲的入口：

| 指令                                | 作用                                          |
| ----------------------------------- | --------------------------------------------- |
| `/crosspost-status`                 | 桥 / 浏览器扩展 / 平台清单 / **自动推送开关** |
| `/crosspost-projects [project]`     | 项目注册表与数据源可达性                      |
| `/crosspost-platforms [id]`         | 平台登录态（27 个已知平台）                   |
| `/crosspost-styles`                 | 可用样式（发布时的启用清单）                  |
| `/crosspost-drafts [project]`       | 文章/草稿记录（项目域）                       |
| `/crosspost-costs [date] [project]` | Token 费用报表（项目域）                      |
| `/crosspost-help`                   | 指令清单与数据来源                            |

**作用域**：注册发生在 preset 的 standing scope 里，所以这些指令**只对选中本预设的会话可见**，
不会出现在 standard/cordis 等其它预设的会话（上游四个官方预设各自声明 `command-goal`
而不冲突，正是这条规则的实证）。

**数据域**：GUI 会话的 `web` profile **没有** `CROSSPOST_PROJECT`，不带项目时读的是
**默认域（空的）**——这正是「查不到项目里的内容」的成因。所以涉及内容的指令会显式传
`--project=`：给了参数用它，没给就用**本机唯一在册项目**（输出里会写明用了哪个）。

**看不到结果？** 在**还没有任何对话内容**的新会话里，DSH 会用欢迎页盖住指令结果
（指令照常执行；空会话里跑 `/compact` 也一样）。先发一条消息再用，或打本机维护补丁——
处理办法与命令见 [`../../docs/troubleshooting.md`](../../docs/troubleshooting.md) §12 与
[`../patches/README.md`](../patches/README.md)。

**它不重复起桥**：插件启动前会先探测 `http://127.0.0.1:<proxyHttpPort>/proxy/bootstrap`
（免鉴权端点，与 `doctor` 同源）。本机已有桥在应答就**不再自拉起**——两个桥会抢同一个调度锁
（`<localRoot>/scheduler/lock`），而定时器一旦被自拉起的那个桥持有，它的寿命就绑在 DSH 会话上：
GUI 一关，定时器静默停摆（容器只在启动时抢一次锁、不重试）。判定认"拿得到 token"，
所以别的服务恰好占用该端口也不会被误判成桥。

**安全边界**：一条指令 = 一次 `crosspost-runtime/src/cli.mjs` 调用，走 `subprocess.spawn({ argv })`
**不经过 shell**，人给的 token 还逐条按白名单校验；且全部**只读**——不写文件、不发草稿、不动平台。
发布/重推仍由模型侧的工具承担（那边有来源守卫与「生成后自动推送」开关门控）。
CLI 与 MCP 服务端共用同一套判定源与数据，所以两边答案一致。

## 载体：0.2.0 起是 bundle + 声明行（**不再是目录**）

DSH **0.2.0-rc.2** 起不再有任何代码读 `$DSH_HOME/.agent-presets/<id>/`
（`@deepseek-ai/dsh-agent-preset` 的 `editing-cordis-compositions` skill：
_"Nothing reads that directory any more"_）。旧的 `preset.yml` + `agent.cordis.yml`
已在本仓库删除；`preset.yml` 的 name/description 合并进了声明行（单一真源）。

于是本目录的角色从"被 DSH 拷走的预设目录"变成"**一个 bundle**"：
`dsh.profile.bundles` 里列上包名，bundle 的 `dsh.bundle.patch` 被当作一层 patch 应用。

## 它怎么被装上

**本机用的是 `link:` 安装**——pnpm 给出一条直接指向本目录的软链，**仓库即源，改代码免重装**：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "preset-crosspost": "link:/Users/me/crosspost/preset/crosspost" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "preset-crosspost"],
    },
  },
}
```

```bash
cd ~/.dsh/profiles/<profile> && corepack pnpm install     # pnpm 不在 PATH 时用 corepack
node -e "console.log(require('fs').realpathSync('node_modules/preset-crosspost'))"   # 必须指回仓库
```

**`link:` 与 `file:` 的差别是这份 README 最该记住的一条**：`link:` 出的是软链（上一步会打印仓库路径）；
`file:` 会被 pnpm **物化成 `.pnpm/...` 下的副本树**——那时改仓库必须重装，而"改了没反应"极难查。
安装后是副本还是软链，`preset/upgrade-check.sh` 第 2 节与 `npm run doctor` 的 `preset-installed`
都会直说。

**换了 preset 要新开会话**：已存在的会话在启动时就固定了插件 revision。

护栏（都在仓库里，红了就按提示修）：

- `crosspost-runtime/tests/deployment-consistency.test.mjs` —— 断言安装条目**是软链且指回本仓库**
  （副本安装时退化为逐字哈希比对），外加"载体形状"契约（不许再出现旧载体文件、bundle 三件套齐备）。
- `preset/upgrade-check.sh` —— 升级后的一键自检；**第 3b 节**逐个按模块解析声明行里的 `@deepseek-ai/*` 名
  （`dsh-workflow-worker-thread` → `dsh-workflow-ptc` 那次改名就是它抓到的）。
- `npm run doctor` —— `preset-bundle` / `preset-installed` 两条给"文件在 ≠ 能用"的结论。

## 一条写作流水线怎么用它

预设给的是**工具**（发得出去），写作规范与人格由**流水线自己**提供：流水线在自己的仓库里放一份
`dsh-profile/cordis.patch.yml`（`system-prompt` 人格 + 挂发布器 MCP），再把它软链成 DSH profile 的
`cordis.patch.yml`。这样每个流水线一个 profile，各自的人格与写作 SOP 互不干扰，
引擎侧只有这一份预设。完整接法见 [`../../docs/writing-pipelines.md`](../../docs/writing-pipelines.md) §6。

## 边界

- 插件**只消费** host 服务（`tools` / `fs` / `shell` / `subprocess` / `timer`），**不发布服务**，
  所以不需要 `isolate` realm。
- 它不是调度器：定时到点由引擎的内置定时器负责（见 [`../../docs/scheduling.md`](../../docs/scheduling.md)）。
- 它与 MCP 面共用同一套判定源（发布来源守卫、平台白名单都来自 `crosspost-runtime/src/`）。
- 它**不是发布链路的一部分**：定时链路走 `mcp-crosspost`（MCP 面），不依赖本预设。
  本预设只为"在 DSH 会话里直接调 `xp_*` 原生工具"服务。工具面整体消失时的排查见
  [`../../docs/troubleshooting.md`](../../docs/troubleshooting.md) §11。
