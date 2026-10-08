# 参与 CrossPost

> 这份文件给**改这个仓库的人**看。使用、安装与接入请从 [`README.md`](README.md) 与
> [`docs/`](docs/) 开始——产品文档只讲"这东西是什么、怎么用、怎么接、坏了怎么修"，
> **不写改动历史**；历史在提交信息与 tag 里。

## 1. 开发环境

```bash
npm install                      # 根 devDeps（eslint / prettier / typescript-eslint）
npm run setup                    # 装齐两个子包依赖 + 构建 crosspost-runtime/core 的 dist
npm run dev                      # 前台起桥（= node bridge/run-bridge.mjs）
```

- **Node.js ≥ 24**：6 处 `engines` + `.nvmrc` + `.npmrc` 的 `engine-strict` 一起把关。
- 根 `package.json` **没有 workspaces**：依赖在两个子包里，`npm install` 只装根 devDeps。
  背景见 [`docs/dependencies.md`](docs/dependencies.md) §1.1。
- 目录结构与数据流见 [`docs/architecture.md`](docs/architecture.md)。
- 装了 DSH 的话，`preset/crosspost/` 是 agent preset（**0.2.0 起是 bundle + 声明行**，
  不是目录式预设——见 [`preset/crosspost/README.md`](preset/crosspost/README.md)）；
  `~/.dsh/upgrade-check.sh`（软链到 `preset/upgrade-check.sh`）是升级后的一键自检，
  其中第 3b 节会逐个按模块解析预设里的 `@deepseek-ai/*` 名（包改名时那一行会静默消失）。

## 2. 门禁：一条命令

```bash
npm run check          # typecheck → lint → format:check → core 测试 → runtime 测试
```

| 子门禁         | 内容                                              |
| -------------- | ------------------------------------------------- |
| `typecheck`    | `tsc --noEmit`（严格模式），只覆盖 core           |
| `lint`         | eslint 全仓                                       |
| `format:check` | prettier（**markdown 也在内**，文档改动同样要过） |
| `test:core`    | vitest + 覆盖率门槛                               |
| `test:runtime` | `node --test` + 覆盖率门槛                        |

改完之后**按改动范围**先跑相关的那些（比全量快得多），提交前再跑一次全量：

```bash
npm run test:scoped -- <改过的文件…>    # 依据测试文件自身的 import 图推导"该跑哪些"
```

## 3. 其它验证入口

| 命令                            | 验证什么                                                                                                          | 需要                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `npm run test:contract`         | 工具面 / 平台矩阵 / 调度 / 容器的契约                                                                             | —                        |
| `npm run test:smoke`            | **空环境**：零项目接入也能装 / 起 / 自检 / 渲染                                                                   | —                        |
| `npm run test:smoke:fresh`      | **干净 clone**：照 README 两步装起来，再真起一次桥                                                                | 网络（2–6 分钟）         |
| `npm run test:docker`           | 容器形态（`--full` 更全）                                                                                         | Docker                   |
| `npm run test:extension`        | 扩展选项页的界面契约（三态读数 / 分组 / 三色 / 不横向溢出）                                                       | 真浏览器（playwright）   |
| `npm run docs:screenshots`      | 重新生成 README「界面」一节引用的截图（Console 八模块 + 扩展选项页；隔离沙箱 + 占位符替换 → `docs/images/*.png`） | 真浏览器（playwright）   |
| `npm run verify:oob`            | **开箱即用**：空环境 / 文档自足 / 发布物洁净 / 本机自检（`--full` 加干净 clone 与容器）                           | `--full` 需网络与 Docker |
| `npm run verify:acceptance`     | 本机生产状态的端到端核对（草稿、项目、桥、调度…）                                                                 | 本机生产环境             |
| `npm run verify:scheduled`      | 今日槽位日志是否收尾（只读）                                                                                      | —                        |
| `npm run verify:immutable`      | 受保护 markdown 零修改 / 零删除 / 零移动                                                                          | —                        |
| `npm run bench:views`           | 三库入口（留存 / 归档 / 报表）性能对照，宿主与容器可跑同一份                                                      | —                        |
| `npm run repair:domain-orphans` | 修"默认域里残留着属于某个项目的记录"（默认 dry-run）                                                              | —                        |

`verify:acceptance` **不进 CI**：它有一半检查依赖本机生产状态，
在 runner 上会把"环境缺"报成"代码红"。CI（`.github/workflows/ci.yml`）跑的是
`check` 那套 + 一个独立的 `fresh-clone` job。

## 4. 常驻进程的规矩（最容易踩的一条）

桥给四条 worker 车道路各养一个常驻 `cli.mjs --ipc` 子进程，**模块只在 spawn 时加载一次**。
所以改了引擎代码（尤其 `articles.mjs` / `paths.mjs` / `doctor.mjs`）**必须重启桥**，
否则你在跑的仍是旧代码：

```bash
launchctl kickstart -k gui/$(id -u)/com.crosspost.bridge    # macOS
systemctl --user restart crosspost-bridge                   # Linux
docker compose restart crosspost                            # 容器
```

## 5. 加一个平台适配器

1. 适配器写在 `crosspost-runtime/core/src/adapters/platforms/`，**按分级分目录**：`private/`（默认勾选）与 `beta/`（未纳入默认派发）；目录必须与分级一致（有门禁）；
2. 在 `platforms/index.ts` 登记；
3. 平台 id、名称与**分级**在 `crosspost-runtime/src/platform-matrix.mjs` 一处声明——
   分级（默认派发 / 仅检查 / beta）决定 Console 与 MCP 的描述文本；
4. `npm run test:contract` 会检查"平台数量与名单只有一处口径"，Console 与 MCP 不许手写数字。

## 6. 版本与发布

**tag 就是版本真值**：`versionInfo().engine = git describe --tags`（去掉前导 `v`）。
没有 git 的部署回退读 `crosspost-runtime/package.json` 的 `version`。

| 守卫                | 断言                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `version-contract`  | 有 git 时，回退值必须与最近 tag **同主次版本**                        |
| `version-contract`  | 根 README 的「当前版本」行必须等于最近 tag                            |
| `version-contract`  | 各包 `repository` 指向同一个仓库；可发布包必须有 `license` 与 `files` |
| `fresh-clone-smoke` | 无 `.git` 沙箱里读到的版本 = 回退值，且与 tag 同主次版本              |

发布顺序（不可换）：

```bash
# ① 改 README 的「当前版本」行与 crosspost-runtime/package.json 的 version
git add -A && git commit -m "…"
git tag -a v2.5 -m "…"          # ② 先打 tag（版本一致性以它为准）
npm run verify:acceptance       # ③ 再验收
```

版本号怎么取：新功能 / 行为变化 / 文档树结构调整 → 递增次版本；纯文档或测试修正 → 可以不升。

## 7. 产品文档的纪律

`README.md` 与 `docs/**` 是**产品文档**，面向使用者与接入方：

- ✖ 不写日期戳、不写"vX.Y 起…"这类版本考古、不写"以前怎样 / 我们放弃了什么"这类决策叙事； <!-- hygiene-allow: 规则陈述本身必须把被禁的说法引出来 -->
- ✖ 不写内部测试文件名、不写只有维护者才需要的流程；
- ✔ 只写"系统现在是什么 + 我该怎么做"，以及**会改变用户行为的**"为什么"。

一条门禁盯着它：`crosspost-runtime/tests/docs-hygiene.test.mjs`。

## 8. 受保护的 markdown（改之前先备份）

`md-backup/**` 是**冻结的归档**（里面有文档基线、备份与维护者笔记），
`verify:immutable` 盯着它。**删除或大改任何 markdown 之前**先留痕：

```bash
D=md-backup/backups/$(date +%F)-pre-<步骤>
mkdir -p "$D/files" "$D/evidence"
cp -p <原文件> "$D/files/<绝对路径去前导/>"      # 保留原仓库相对结构
shasum -a 256 <原文件> >> "$D/evidence/manifest.sha256"
```

`md-backup/` 整体在 `.gitignore` 里（**不入库、不发布**），所以它是本机的归档区，
不是产品文档的一部分。

## 9. 隐私红线（提交前必看）

以下文件含机器路径、通知对象、真实凭据或草稿，**一律不得提交**：

```
.local/                          crosspost-runtime/config.json
crosspost-runtime/paths.json     crosspost-runtime/token.*.json
crosspost-runtime/ever-authed.json  crosspost-runtime/platforms-state.json
crosspost-runtime/.env           bridge/token.local
bridge/brand/                    md-backup/
```

它们都在 `.gitignore` 里。提交前跑一次 `git status --short` 确认没有一条被误加。

**文档截图同样算在内**：README「界面」一节里的截图（Console 八个模块 + 浏览器扩展选项页）
由 `npm run docs:screenshots` 生成 —— 它在隔离沙箱里取页面，把真实路径 / 用户名 / pid /
客户端标识 / token 换成占位符，并在落盘前断言"页面上已经没有本机痕迹"
（扩展选项页那张还会用示例载荷喂页面，绝不去取真实桥的登录态）。
不要手工截图后直接提交：PNG 是二进制，`release-artifact` 的家目录检查对图片扩展名整类跳过，
手工图里的 `/Users/<用户名>/…` 与草稿标题没人拦得住。

## 10. 许可

**全仓唯一许可是 `GPL-3.0-only`**，正文只在仓库根维护一份：[`LICENSE`](LICENSE)
（版权 `Copyright (C) 2026 CrossPost`）。向本项目提交贡献即表示同意以同一许可分发你的贡献
（inbound = outbound，无需额外签署文件）。

**为什么是「only」而不是「or later」**：`LICENSE` 正文里没有 "or later" 声明，`GPL-3.0-only`
是与之一致的、无歧义的 SPDX 写法。换写法要同时改 `LICENSE` 与全部 `package.json`。

**许可证怎么随分发物走**（根目录那一份只在"整个仓库作为分发单位"时覆盖全部文件）：

| 分发物                       | 怎么拿到许可证                                                               | 谁来保证                                                |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| 整个仓库（clone / 打包分享） | 根 `LICENSE` 即在其中                                                        | 无需额外动作                                            |
| npm 包 `@crosspost/core`     | 包内 `prepack` 从根复制 `LICENSE`，`postpack` 清掉（仓库仍只有一份正文）     | `license-compliance.test.mjs` 的「许可③」直接查打包产物 |
| 容器镜像                     | `Dockerfile` 的 `COPY LICENSE` → `/usr/local/share/doc/crosspost/LICENSE`    | 同上，且 `.dockerignore` 必须放行 `!LICENSE`            |
| 单独分享 agent preset        | 一并给出本仓库（preset 的插件按源码引用引擎，且 `runtime` 是指向仓库的软链） | 见 `preset/crosspost/README.md`                         |

**依赖许可政策**：只接受与 GPL-3.0 相容的许可（宽松类，以及 `LGPL-3.0-or-later`）。
新依赖的许可必须先进 `crosspost-runtime/tests/license-compliance.test.mjs` 的 `ALLOWED` 白名单，
并说明理由；白名单之外一律判红。当前依赖树的许可分布就登记在 `ALLOWED` 里，每条为什么允许写在它的注释里。

> 这些是**机器检查**（白名单 + 文件齐备性），不是法律意见；对外发布前建议让法务过一眼。

## 11. 署名注释（自研代码文件）

自研代码文件都带一行署名注释：**作者名 `dos2un1x` + 仓库地址
`https://github.com/dos2un1x/crosspost`**。位置不限、措辞不限，两者都在即可；
`package.json` 这类放不下注释的文件走 `author` 字段。

护栏是 `crosspost-runtime/tests/attribution.test.mjs`：它扫同一份清单（JS 家族 / CSS / HTML /
shell / Python / YAML / TOML / Dockerfile / `.env.example`，排除 `node_modules`、`vendor`、
`dist`、`.local`、`md-backup`），任何一个文件缺仓库地址或作者名就红。
**所以新增自研代码文件时，记得把这一行带上**；`.md` 文档与 JSON 不在范围内。

不想要这条约束时：**删掉那一个测试文件即可**，没有别的联动。
