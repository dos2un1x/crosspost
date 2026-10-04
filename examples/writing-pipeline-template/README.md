# 写作流水线骨架 · 可复制模板

> **这是"抄的"，不是"读的"。** [`../generate-provider-http/server.mjs`](../generate-provider-http/server.mjs) 与
> [`../slot-runner-http/server.mjs`](../slot-runner-http/server.mjs) 是**契约参考实现**（读一遍知道端点长什么样）；
> 本目录是**起手骨架**：复制走、改三处、就是一条属于你自己的写作流水线。

一条流水线 = **一个 skill（写什么、怎么写）+ 一份项目注册（怎么被引擎调用）**。
引擎不管内容，只管把写好的东西按草稿发出去。完整映射见
[`../../docs/writing-pipelines.md`](../../docs/writing-pipelines.md)。

## 用起来：三步

```bash
# 1) 复制到你的写作项目里（不要就放在本仓库里改）
cp -R examples/writing-pipeline-template /path/to/my-writing-project/pipeline

# 2) 改三处
#    · .crosspost/project.json 的 id / name / dataDir
#    · .crosspost/project.json 里两个 provider 的端口（缺省 8787 / 8788）
#    · SKILL.md §0「本流水线写什么风格」——这一张表决定这条流水线写什么样的文章

# 3) 起 provider（复用参考实现，不用自己写）
GENERATE_BIN=/path/to/my-writing-project/pipeline/scripts/generate.sh \
GENERATE_LOGS_DIR=/path/to/my-writing-project/pipeline/logs \
node examples/generate-provider-http/server.mjs

SLOT_BIN=/path/to/my-writing-project/pipeline/scripts/run_once.sh \
SLOT_WORKDIR=/path/to/my-writing-project/pipeline \
node examples/slot-runner-http/server.mjs
```

然后把**扫描根**指向你的写作项目（`config.projectsDirs`，见
[`../../docs/configuration.md`](../../docs/configuration.md)），`npm run doctor` 就会列出它，
Console 的项目切换器里也能选到它。

**只想先看回路通不通**：不用起 provider，直接跑

```bash
PIPELINE_DATA_DIR=/tmp/my-pipeline-drafts \
  bash examples/writing-pipeline-template/scripts/generate.sh weekly "我的第一篇"
```

它会离线产出一篇带 frontmatter 的草稿（不调模型、不联网），把路径打在 stdout。
**回路先通，再换掉生成器里的那一步。**

## 目录里每个文件

| 文件                           | 作用                                                   | 你要改吗                     |
| ------------------------------ | ------------------------------------------------------ | ---------------------------- |
| `.crosspost/project.json`      | 项目注册（manifest v2）：声明 `drafts` 与两个 provider | **改** id / name / 端口      |
| `.crosspost/schedule.json`     | 栏目声明：每个栏目的 id / 名称 / 时间 / 命令           | **改**成你自己的栏目         |
| `SKILL.md`                     | 这条流水线写什么、怎么写、怎么自评                     | **改**（这才是"风格"的落点） |
| `references/`                  | 放你的提示词模板、评分锚点、样式映射                   | 往里加                       |
| `scripts/generate.sh`          | 「写作」这一步；模板版离线产出占位正文                 | **改**成你的写作流程         |
| `scripts/run_once.sh`          | 槽位入口：到点跑什么                                   | **改**成你的流程             |
| `dsh-profile/cordis.patch.yml` | headless 会话的人格叠加层（可选）                      | 按需改                       |

## 它怎么和引擎对上

| 你要的                                    | 谁负责                           | 落在哪                                            |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------- |
| 内容写得好不好                            | **你**（SKILL.md 的 SOP 与评分） | 引擎不参与                                        |
| Console 上点一下就能生成                  | 引擎发 HTTP 给你的生成提供者     | `capabilities.generate`                           |
| 到点自动跑                                | 引擎发 HTTP 给你的槽位执行器     | `capabilities.schedule`                           |
| 草稿与记录放哪                            | 引擎按项目分域读写               | `dataDir`                                         |
| **风格**（主题样式 / 平台 / 阈值 / 封面） | **项目级配置**，每条流水线一套   | `<localRoot>/project-state/<你的 id>/config.json` |

栏目（slot）的 `id` 由你声明，引擎只校验形状（小写字母开头、字母数字与横线）。
文件名请用 `<日期>-<栏目 id>-<主题>.md` 形态：引擎按它解析 id / 日期 / 栏目。

## headless（可选）

要让这条流水线在**无人值守**下跑（定时轮、一键生成），需要给 DSH 建一个 profile：

```bash
mkdir -p ~/.dsh/profiles/<你的 profile 名>
ln -s /path/to/my-writing-project/pipeline/dsh-profile/cordis.patch.yml \
      ~/.dsh/profiles/<你的 profile 名>/cordis.patch.yml
```

`cordis.yml` 留空数组、`package.json` 声明 bundles（照 `~/.dsh/profiles/` 下任一既有 profile 抄）。
**软链指向流水线仓库里那一份**，这样写作规范只有一份、改一处即生效。

## 一句提醒

**不要把本目录自己注册进 `projectsDirs`。** 它是模板：注册它只会让 Console 里多出一个
叫「我的写作流水线」的空项目。复制走之后再注册你的那一份。
