# 写作流水线接入

> 引擎只有一份，**写作流水线可以有多条**——每条写自己的题材与风格，各自接入。
> 一条流水线 = **一个 skill（写什么、怎么写）+ 一份项目注册（怎么被引擎调用）**。
>
> 引擎契约本身（六项能力、校验规则、三种入口、数据边界）见 [`integration.md`](integration.md)；
> 本文只讲"流水线"这一层的接法与并存语义。

## 1. 一条流水线由什么组成

| 这一层                                             | 落在哪                                                     | 谁负责                           |
| -------------------------------------------------- | ---------------------------------------------------------- | -------------------------------- |
| 写什么风格（体裁 / 语气 / 读者 / 字数 / 评分锚点） | `SKILL.md` + `references/`（提示词、评分细则）             | **流水线自己**；引擎不参与内容   |
| 「写作」这一步怎么跑                               | `scripts/generate.sh`（或任意语言的等价物）                | 流水线自己                       |
| Console 上点一下就能生成                           | 一个实现了 P2 三端点的 HTTP 提供者                         | 流水线的 `capabilities.generate` |
| 到点自动跑                                         | 一个实现了 P3 四端点的 HTTP 执行器（或本地命令）           | `capabilities.schedule`          |
| 栏目（几点、叫什么、跑什么）                       | `.crosspost/schedule.json`                                 | 项目侧文件，引擎只读             |
| 草稿与记录放哪                                     | manifest 的 `dataDir`                                      | 引擎按项目分域读写               |
| 主题样式 / 平台清单 / 评分阈值 / 封面 / 通知       | 项目级配置（见 [`configuration.md`](configuration.md) §3） | 每条流水线一套，互不影响         |
| headless 会话的人格                                | `dsh-profile/cordis.patch.yml`                             | 流水线自己（见 §6）              |

**"不同流水线写不同风格"就是这张表的后三行 + `SKILL.md`**：同一个引擎下，把 `SKILL.md`
的风格表与项目级配置换成另一套，就得到另一条流水线。

## 2. 注册一条流水线

在**扫描根**（`config.projectsDirs` 里的目录）的任一直接子目录放 `.crosspost/project.json`。
一份能过校验的最小 manifest：

```jsonc
{
  "manifestVersion": 2,
  "id": "my-pipeline", // 稳定标识：进所有项目级路径
  "name": "我的写作流水线", // 显示名（Console 项目切换器里看到的就是它）
  "dataDir": "drafts", // 草稿与记录的落点
  "capabilities": {
    "drafts": true, // 内容域（声明它必须给 dataDir）
    "generate": {
      "kind": "http",
      "url": "http://127.0.0.1:8787/generate",
      "statusUrl": "…/status",
    },
    "schedule": {
      "kind": "http",
      "url": "http://127.0.0.1:8788/slot/run",
      "statusUrl": "…/status",
    },
  },
}
```

`topics` / `retention` / `reports` 三个能力按需打开：它们要求你的项目里有对应的数据文件
（选题池、留存/归档目录、会话目录），没准备好就别声明——声明了 Console 会照实显示空视图。

注册后 `npm run doctor` 会列出它，Console 的项目切换器里能选到它。

## 3. 加一条新流水线：五步

1. **复制骨架**：[`../examples/writing-pipeline-template/`](../examples/writing-pipeline-template/)
   → 你的写作项目里。它是"抄的"，两个 provider 参考实现是"读的"。
2. **改三处**：manifest 的 `id` / `name` / `dataDir`；两个 provider 的端口；
   `SKILL.md` §0「本流水线写什么风格」。
3. **写你自己的栏目**：在 `.crosspost/schedule.json` 里声明（见 §4）。
4. **起 provider**：直接复用 [`../examples/generate-provider-http/server.mjs`](../examples/generate-provider-http/server.mjs)
   与 [`../examples/slot-runner-http/server.mjs`](../examples/slot-runner-http/server.mjs)，
   把"跑哪个脚本"指向你的 `scripts/`。
5. **（可选）headless**：按 §6 建一个 DSH profile。

## 4. 栏目：名字随你起，形状有约束

栏目（slot）**由项目声明**，引擎没有内置白名单——`articles` / 选题 / 发布 / Console 全程按声明走。

| 约束                     | 规则                                           | 为什么                                                                                    |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 声明里的栏目 id          | 小写字母开头，允许字母/数字/**横线**，≤32 字符 | 要能安全地进 URL、文件名、日志                                                            |
| 草稿**文件名**里的栏目段 | 小写字母开头，只含小写字母与数字，**不含横线** | 文件名形态是 `<日期>-<栏目>-<主题>`，而主题里几乎一定有横线；栏目段再带横线就无法唯一解析 |

**因此：栏目 id 建议不带横线。** 带横线的 id（如 `deep-dive`）在声明与 Console 里都能正常显示与勾选，
但它的草稿文件名还原不出这个栏目（`YYYY-MM-DD-deep-dive-ai` 会被读成栏目 `deep`）——
要避开这个问题，用 `deepdive` 这类不带横线的 id。

草稿文件名请统一写成 `<日期>-<栏目 id>-<主题>.md`（各段 ASCII），frontmatter 至少给 `title`；
可选 `score`（质量分）、`risk`（风险标记）、`style`（这篇的主题样式）。

## 5. 风格落到哪些旋钮上

一篇草稿最终长什么样，由三层叠加决定：

1. **内容层**（`SKILL.md` 的 SOP）：体裁、语气、结构、字数、事实边界——**引擎不参与**。
2. **栏目默认样式**：`styles.perSlot = { "<栏目 id>": "<样式名>" }`（项目级）。
   解析顺序是：请求传入 > 草稿 frontmatter 的 `style` > `perSlot[栏目]` > 引擎内建栏目映射 > `swiss`；
   命中的样式被禁用或不存在时回退 `swiss` 并记一条 warning。
3. **项目级设置**：`platforms.default`（推哪些平台）、`scoring.threshold`（评分阈值）、
   `coverSettings`（封面与结束语）、`branding`、`notify`。

三层都是**按项目**生效的——这正是"两条流水线两种风格"能同时存在的原因。

## 6. headless：让流水线在无人值守下跑

定时轮与「一键生成」在 DSH 里以 **profile** 启动：一条流水线一个 profile，profile 通过
`cordis.patch.yml` 叠加在 `dsh-base` + `dsh-headless` 之上，并挂上发布器 MCP 客户端
（`crosspost-runtime/mcp-server/index.mjs`）。

```
~/.dsh/profiles/<你的 profile 名>/
  cordis.yml          # 空数组：树由 bundles + patch 组合而成
  package.json        # dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]
  cordis.patch.yml    # 软链到你流水线仓库里那一份（写作规范只有一份）
```

`cordis.patch.yml` 里放两样东西：`system-prompt`（人格：写明"按本流水线的 `SKILL.md` 执行"）
与 `insert:` 的 MCP 客户端（发布器；你自己的数据源按需加）。
模板见 [`../examples/writing-pipeline-template/dsh-profile/cordis.patch.yml`](../examples/writing-pipeline-template/dsh-profile/cordis.patch.yml)。

**为什么软链而不是拷一份**：写作规范与人格会持续迭代，拷一份就会出现"两份各自演化、
改了不生效且无从察觉"。软链让流水线仓库成为唯一权威副本。

## 7. 多条流水线并存

| 维度                                                        | 是否按项目隔离 | 说明                                               |
| ----------------------------------------------------------- | -------------- | -------------------------------------------------- |
| 草稿与文章记录                                              | 是             | 各写各的 `dataDir`；写入时还会按草稿归属纠正域     |
| 选题库 / 留存 / 归档 / 费用报表                             | 是             | 跟着内容工作区走，声明对应能力即可                 |
| 编辑记忆（近期题材与人工反馈）                              | 是             | 每个项目一份，选题去重不会跨流水线互相干扰         |
| 栏目、时间、开关                                            | 是             | 项目自己的 `.crosspost/schedule.json` + `schedule` |
| 平台清单 / 样式清单 / 每栏默认样式 / 评分阈值 / 封面 / 通知 | 是             | 都是项目级键                                       |
| 引擎运行数据（桥日志、费用缓存、调度状态）                  | 否             | 那是引擎自己的，不属于任何流水线                   |

未选项目时走**默认域**：它是独立的、可以为空，不等于"第一个项目"。

## 8. 候选池（`topic-pool.json`）的行契约

引擎读这份文件渲染 Console 选题库、算统计（采用/落选/未生成）、决定「积压重推」，
所以**行形状是双方契约**，不是某个脚本的内部格式：

| 字段                                      | 类型                                 | 说明                                            |
| ----------------------------------------- | ------------------------------------ | ----------------------------------------------- |
| `keyword`                                 | 非空字符串                           | 与 `date` + `slot` 一起构成唯一键               |
| `title`                                   | 字符串（可空串）                     | 采用项的文章标题。**可为空串，但不能省略**      |
| `topicScore`                              | 0-100 的数字或 `null`                | 五维评分                                        |
| `status`                                  | `adopted` / `generated` / `rejected` | 三值之一                                        |
| `reason`                                  | 字符串（可空串）                     | 落选原因，与低分维度对应                        |
| `articleId`                               | 字符串或 `null`                      | 文章落盘后回填                                  |
| `rank`、`id`、`date`、`slot`、`createdAt` |                                      | 写入侧按约定生成（`id` = `<date>-<slot>-<NN>`） |

**AI 会话里写入用 MCP 工具**（同一实现的另一个入口，字段形状由 schema 约束，
漏字段在调用边界就被挡）：

```
mcp__crosspost__topic_pool_upsert
  { date, slot, rows: [{ keyword, title, score, status, reason, articleId? }], manual?, articleId? }
```

**脚本 / 定时链路用下面的 CLI**（同一个 handler、同一份规则；两条路不会分叉）：

**写入用引擎的命令，不要自己实现**（唯一写入口）：

```bash
node <引擎>/crosspost-runtime/src/cli.mjs topicPoolUpsert \
  --date=<YYYY-MM-DD> --slot=<slot> --json='[["<kw>","",87,"rejected","<原因>"]]'
# 另有 topicPoolValidate（只校验形状）与 topicPoolShow（只读观测）
```

形状不对（少给 `title` 这种**整体左移**）、条目数会减少、选不出项目 → 命令**拒绝整次写入**
并以 `1` 退出，一个字节都不落盘。转发器写法与完整契约：
[`../examples/topic-pool-writer/README.md`](../examples/topic-pool-writer/README.md)。

两条纪律：

- **写入方逐行校验形状再写**。按位置取字段（`[kw, title, score, status, reason]`）时少给一个
  字段，后面所有字段会**整体左移**，一行候选就被静默写坏——而引擎不会去"猜"字段类型，
  表现在 Console 上就是歪的数据（渲染不会因此整页报错，但统计与门槛判断都按字段语义走）。
- **读—改—写要串行**：引擎侧的写入（回填 `articleId`）带锁 `<history>/.topic-pool.lock`，
  项目侧的写入器必须用同一把锁，否则两边的读—改—写互相覆盖，最新的一次会盖掉前一次。

## 9. 参考实现与模板

| 想做什么                          | 看哪份                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| 抄一条流水线的骨架                | [`../examples/writing-pipeline-template/`](../examples/writing-pipeline-template/) |
| 实现「一键生成」的端点            | [`../examples/generate-provider-http/`](../examples/generate-provider-http/)       |
| 实现槽位执行器的端点              | [`../examples/slot-runner-http/`](../examples/slot-runner-http/)                   |
| 调度声明与触发策略                | [`scheduling.md`](scheduling.md)                                                   |
| 把引擎挂到 agent 上（DSH preset） | [`preset/crosspost/README.md`](../preset/crosspost/README.md)                      |

## 10. 「一键生成」是队列；把并发调大之前必须先做的事

**引擎侧现在就是一个队列**：Console 上连点几条选题（或点「一键生成全部未生成」）会
排成 FIFO，按 `topicsGenerateMaxConcurrency`（默认 **1**）逐条执行，每行显示
「排队中（第 N 位）」/「生成中 · 已运行 mm:ss」/「查看《…》」/「失败 + 重试」。
默认 1 意味着**今天的实际节奏没变**——变的是"点了就有反馈、失败不会连累后一条、
不用盯着屏幕手点重试"。

### 想真正并行，要同时放开三处

| #   | 在哪                          | 改什么                                                                                                     | 不改会怎样                                                                        |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | 项目侧 `generate_once.sh`     | 把全局锁 `/tmp/ai2writing-gen.lock` 改成**按 slot/keyword 分锁**                                           | 第 2 条起拿到锁就 `[SKIP] … 本轮跳过`（exit 2），引擎侧看到的是"成功但其实没生成" |
| 2   | 项目侧 `generate_provider.sh` | `GENERATE_CONCURRENCY=1` → 目标值（改完要重启 provider）                                                   | provider 回 `409 busy`；引擎会如实报"项目侧正忙"，并发 > 1 时退避重试到超时为止   |
| 3   | 引擎                          | `config.json` 的 `topicsGenerateMaxConcurrency` 调到 2–3（或临时用 `CROSSPOST_TOPIC_GEN_MAX_CONCURRENCY`） | 引擎仍按并发 1 排队，前面两处白放开                                               |

**先说代价**：一条任务 = 一次完整 dsh 会话，通常要跑几分钟。
并发 3 意味着同时烧三份 token，也意味着三条流水线同时往同一个 `topic-pool.json` 写
——引擎侧的回填已经加了锁（`<history>/.topic-pool.lock`），但**项目侧的
`topic_pool_upsert.py` 也要加锁**，否则两边的读—改—写仍会互相覆盖。

**建议顺序**：先按默认 1 用一阵（确认排队、重试、逐行状态符合预期），再改 1+2，
最后把 3 调到 2，观察一周再决定要不要到 3。上限硬夹在 5——那是成本护栏，
不是技术上限。
