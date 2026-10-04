# 依赖

> 根 `package.json` **没有 workspaces**，所以 `npm install` 只装根 devDeps；
> 真实依赖在**两个子包**（`crosspost-runtime` / `bridge`）里，它们的 `node_modules`
> 与 `core/dist` 都**不入库**。`npm run setup` 会按顺序替你装齐它们并构建 `core/dist`
> ——照 README 的两步走就够。

## 1. 必需

| 依赖                      | 要求     | 为什么                                                  | 探针                                                 |
| ------------------------- | -------- | ------------------------------------------------------- | ---------------------------------------------------- |
| **Node.js**               | **≥ 24** | 6 处 `engines` + `.nvmrc` + `.npmrc` 的 `engine-strict` | `doctor` 的 Node 项（含"node 可执行文件一致且存在"） |
| **Chrome / Edge / Brave** | 任一     | 扩展是**唯一的出口**：所有平台请求都在真浏览器里代发    | `doctor` 的"浏览器扩展目录/已连接"项                 |

**两个子包与关键依赖探针**（`crosspost-runtime/src/deps.mjs` 是唯一事实来源）：

| 子包                | 目录                | 关键探针                                           | 缺了会怎样                                  |
| ------------------- | ------------------- | -------------------------------------------------- | ------------------------------------------- |
| `crosspost-runtime` | `crosspost-runtime` | `jsdom`、`ws`、`@crosspost/core`、`tsup`、`js-md5` | 渲染/发布链挂；core 构建不出来（`tsup` 缺） |
| `bridge`            | `bridge`            | `ws`                                               | 桥起不来（`require('ws')` 直接崩）          |

安装顺序：**runtime → bridge**。`core/dist` 也必须存在（`npm run setup` 会构建它）。

### 1.1 依赖树住在哪里

`crosspost-runtime/package.json` 用 `"@crosspost/core": "file:./core"`，npm 把这种**目录链接
按工作区处理**，于是 core 的整棵依赖图（含它自己的 devDeps `tsup` / `vitest`）被 hoist 进
`crosspost-runtime/node_modules`。因此：

- **core 没有自己的 `node_modules`**，也没有自己的 lock 文件；
- core 的三条脚本照旧可用：npm 把**所有祖先** `node_modules/.bin` 注入脚本 PATH，
  `npm -C crosspost-runtime/core run build|typecheck|test` 用的就是 runtime 那棵树里的
  `tsup` / `tsc` / `vitest`；
- 若磁盘上出现 `crosspost-runtime/core/node_modules`，`doctor` 会给一条
  `deps-redundant-core-tree`（提醒级，不判失败）；它可安全删除，不影响构建与运行；
- 要把 `@crosspost/core` 单独拿去用（或发布）时，在它目录里 `npm install` 现场生成 lock 即可；
  它是一个按"可发布包"维护的包（`license: GPL-3.0-only`、`files` 含 `src`、发布时由 `prepack`
  带入根 `LICENSE`），分发与许可规则见 [`CONTRIBUTING.md`](../CONTRIBUTING.md) §10。

```bash
npm install && npm run setup    # 幂等：已存在则保留配置，缺依赖则自动装
```

## 2. 可选（缺了功能降级，不阻塞启动）

| 可选件             | 用途                                      | 缺失表现                                                                                                     |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `unzstd`（zstd）   | 解压会话压缩文件以统计 token 费用         | 费用报表拿不到部分会话数据；`doctor` 会提醒（**容器镜像自带**）                                              |
| `lark-cli`         | 飞书通知通道                              | 通知发不出去；`doctor` 会提醒（**容器镜像自带 linux 版**，但凭据要各自配——见 [`docker.md`](docker.md) §2.1） |
| `systemd`（Linux） | 桥的用户级守护                            | 只能前台 `node bridge/run-bridge.mjs`                                                                        |
| DSH ≥ 0.2.0-rc.2   | agent preset 接入（7 个 `xp_*` 原生工具） | 只能在 CLI / MCP / Console 里用；`doctor` 的 `preset-bundle` / `preset-installed` 两条会提醒                 |

**DSH preset 作为可选件的判据**：

- 预设**不是**一个目录，而是 bundle patch 里的一条 `@deepseek-ai/dsh-agent-preset` 声明行，
  由目标 profile 的 `dsh.profile.bundles` 装载（`$DSH_HOME/.agent-presets/<id>/` 没有读取方）。
- 因此"`preset/crosspost/plugins/crosspost.js` 文件在不在"**不是**可用性判据——文件一直在仓库里，
  而会话里可能一个 `xp_*` 工具都没有。判据是"bundle 齐备 + 已装进某个 profile"，
  由 `doctor` 的 `preset-bundle` / `preset-installed` 两条与 `preset/upgrade-check.sh`
  的第 2/3/3b 节给出。
- 装法用 `link:`（profile 里 `"preset-crosspost": "link:~/crosspost/preset/crosspost"`）：
  仓库即源，改代码免重装。`file:` 安装会被包管理器物化成副本树，改仓库要重装。
  安装三条命令与工具面缺失的排查见 [`troubleshooting.md`](troubleshooting.md) §11。

`doctor` 的可选项只给**提醒**不给失败；必需项缺失才判红。

两条判据值得记住（它们解释了 doctor 的措辞）：

- **"文件在不在"≠"能不能用"**：可选件除了查路径，还要能自证可用。例如飞书通道会额外查
  `lark-cli auth status`（bot 是否 ready）——二进制在、身份不可用也算不可用。
- **体检与代码必须同一判据**：doctor 与引擎都经 `resolveOnPath` 按 PATH 解析
  （而不是写死 `/usr/local/bin/...`），否则 Debian 这类把工具装在 `/usr/bin` 的系统上，
  体检与运行会得出两个答案。
