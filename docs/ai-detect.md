# AI 检测（朱雀）

> 引擎侧能力：给一篇文章一个**外部 AI 判分**，并把"哪几段像 AI 写的"落到正文的具体字符区间上。
> 写作政策（什么时候检测、不达标怎么改）属于接入方项目，引擎只管能力与运行态。

## 1. 通道与凭证

| 项       | 值                                                                                 |
| -------- | ---------------------------------------------------------------------------------- |
| 模型     | 腾讯朱雀（EdgeOne Makers 内置模型 `@makers/zhuque-text`）                          |
| 端点     | `POST https://ai-gateway.edgeone.link/v1/providers/zhuque-text/classify`           |
| 鉴权     | `Authorization: Bearer <API_KEY>`，Key 在控制台 **Makers → Models → API Key** 创建 |
| 凭证位置 | `crosspost-runtime/.env` 的 `ZHUQUE_API_KEY`（env 优先；两者都 gitignored）        |
| 额度     | 内置模型 50 万 token/月，按开通日为周期起点自动刷新；不足可工单提额                |
| 官方文档 | <https://cloud.tencent.com/document/product/1552/137539>                           |

**密钥不落 `config.json`**：凭证只走 env / `.env`，与微信凭证同一规矩。

## 2. 字段语义

接口返回四个部位，能当门禁的是 `labels_ratio` 的三段：

| 字段                 | 含义                                                  | 可否作门禁                                                                                                                                         |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `softmax_confidence` | 整体 AI 生成置信度（官网顶部显示的数字）              | ❌ 对现代中文说明文**恒为 `0.9999`**；换成"极短句 + 第一人称 + 口语"的极端文体也只压到 `0.49`。`<30%` 在这个口径下不可达，作门禁会永久拦住全部稿件 |
| `ratio_confidence`   | 非人工占比（≈ `labels_ratio[1] + labels_ratio[2]`）   | ❌ 只要有一段被判 AI 就是 `1.0`，无区分度                                                                                                          |
| `labels_ratio`       | `{"0":人工特征, "1":AI特征, "2":疑似AI}` 占比         | ✅ 三段都要看，见下面的门禁口径                                                                                                                    |
| `segment_labels[]`   | 分段判定，含 `position:[起,止]`（提交文本的字符区间） | ✅ 定向改写的依据                                                                                                                                  |

### 门禁口径：三选一

三段之和恒为 1，这是所有口径设计的前提。三种模式（`aiDetect.gate.mode`）：

**`distribution`（默认）—— 一条下限 + 两条上限**

| 项          | 目标                     | 含义                                   |
| ----------- | ------------------------ | -------------------------------------- |
| `human`     | ≥ `humanMin`（0.30）     | 人工特征**不得低于**三成——唯一的硬下限 |
| `ai`        | ≤ `aiMax`（0.50）        | 上限，**没有下限、越低越好**           |
| `uncertain` | ≤ `uncertainMax`（0.50） | 上限，防止整篇躲进中间档               |

这是**容受**而非**配额**：写作过程中不可避免留下一些 AI 味与疑似味，区间表示这些**可以接受**，
不代表**必须留着**。`fails[]` 只会有 `human` / `uncertain` 这两种（整篇机器腔时才出现 `ai`）。

**`bands` —— 每段各给一个区间**（`humanMin~humanMax` / `aiMin~aiMax` / `uncertainMin~uncertainMax`）。
注意它的语义与 `distribution` 不同：三者和为 1，所以"每段都 ≥30%"实际把每段**锁进 30%-40%**，
即要求文章**保留**至少三成 AI 特征文本。越界项带方向，形如 `human:below` / `ai:above`。
需要"三种特征三分天下"时用这个模式；只要"人工别太低、其余别过半"就用默认的 `distribution`。

**`metric` —— 旧的单指标口径**：只看 `metric`/`threshold`，行为与引入分布口径前完全一致。

### 门禁强度：observe / block

| 值                | 行为                                                                                                                     | 适用                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `observe`（默认） | 只报不拦：照常返回真实 `verdict` 与 `fails`，但**不进入重写循环**，调用方记日志后继续走原流程。每篇仅 1 次调用，配额最优 | 目标刚调整、还在看真实分布 |
| `block`           | 硬门禁：按 `rewriteTargets` 定向改写 ≤`rewrite.maxRounds` 轮，仍不达标则留存                                             | 分布已稳定、要开始强制时   |

返回里的 `action` 字段直接给出本次应执行的动作（`observe` / `block`），调用方不必自己推断 config。

### 优化单元是"段落"，不是"整篇"

`labels_ratio` 近似**按分段计权**（15 段中 4 段判 AI ⇒ 4/15 ≈ 26.7%，与返回的 25.94% 吻合），
段落规模约 280 字/段。因此"整篇一半文本达到人工特征"可分解为"约一半的段落各自达到人工特征"——
这既是写作侧的目标，也是分段数会影响判定的原因（短文本分段少、粒度粗）。

同一话题、不同文体的标定值：

| 样本                              | 字数      | softmax | labels {人工, AI特征, 疑似} |
| --------------------------------- | --------- | ------- | --------------------------- |
| 1925 年白话散文                   | 176       | 0.0003  | {1, 0, 0}                   |
| 极短句 + 口语 + 第一人称具体动作  | 307       | 0.4932  | {1, 0, 0}                   |
| 第一人称轶事 + 对话               | 219       | 0.808   | {0, 0, 1}                   |
| 抽象机制论述（套路化措辞密集）    | 237       | 0.993   | {0, **1**, 0}               |
| 结构化论述（"先说结论 / 本质是"） | 272       | 0.9996  | {0, **1**, 0}               |
| 本引擎接入方的真实成稿            | 1387–4733 | 0.9999  | {0, **0.93**, 0.07}         |

三个需要留意的性质：

- **`labels_ratio` 按分段计权，不按字符计权。** 分段少的短文本粒度很粗——3 段里 1 段被判 AI 就是 33%，
  因此阈值要与"正文长度下限"一起看，别把短文的百分比直接与长文比。
- **两个数会背离。** 同一篇改写稿可以 `softmax=0.9999` 而 `AI特征=0%`，报告两个数，别只看一个。
- **同一篇重复检测结果一致**，无需为抖动预留安全边际。

## 3. 省配额的三道闸

按代价从低到高排列：

| 闸             | 机制                                                                                                   | 省什么                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **内容缓存**   | 按 `sha256(通道+网关+剥离后正文)` 缓存**归一化结果**（判定每次用当前 gate 重算，改阈值不会拿到旧结论） | 重复检测：Console 复推、同一篇既走手动又走定时、block 模式下未改动正文的复检 |
| **确定性抽样** | `aiDetect.sampleRate`（0-1，默认 1 全检）。按正文哈希决定检不检——同一篇每次判定一致，可复现、可审计    | 覆盖率换额度（0.5 即省一半）。被抽掉返回 `skip/sampled-out`                  |
| **额度硬闸**   | `monthlyTokenBudget`，累计超过即不再调用                                                               | 兜底，防止把额度烧穿                                                         |

抽样用哈希而不是随机数，是为了让"这篇为什么没检测"可复现——否则排查会变成玄学。

## 4. 用量

- 计费口径看 `makers_models_usage.total_tokens`（网关侧记账），≈ **1.7 × 正文字数**；
  `usage.total_tokens` ≈ 1.0 × 字数，用它估额度会低估约 40%。**控制台「模型用量」页是权威口径**。
- 台账在 `<repo>/.local/ai-detect-usage.json`，按月累计、跨月归零；额度是**账号级**，全引擎共用一份台账。
  注意：台账只统计**经引擎发起的**调用，直接用 curl/脚本打接口的部分不在里面——对账以控制台为准。
- `config.json → aiDetect.monthlyTokenBudget`（默认 40 万）是硬闸：累计超过即不再调用，
  返回 `skip/budget-exhausted`（按"未检测"放行，不阻断出稿）。留出的余量用于基线重跑与人工抽检。
- **量级与覆盖率的关系**（均篇 ≈ 5.5k token）：

  | 覆盖                                       | 月度消耗（30 天） | 是否落在 50 万免费额度内 |
  | ------------------------------------------ | ----------------- | ------------------------ |
  | 5 篇/天（全栏目）                          | ≈ 80 万           | ❌ 超出                  |
  | 只检深度长文（noon/evening，2 篇/天）      | ≈ 39 万           | ✅                       |
  | 只检快讯（hotspot/hotspot2/tips，3 篇/天） | ≈ 22 万           | ✅                       |

  因此建议**每篇只在定稿后检测一次**，并按 `aiDetect.slots` 选择覆盖栏目：

  ```json
  "aiDetect": { "slots": ["noon", "evening"] }
  ```

  `slots` 为空数组 = 不限栏目。`--text` / `--stdin`（基线回测、人工排查）不受该白名单限制。
  被白名单挡下时返回 `skip/slot-not-enabled`，零请求零消耗。

- 额度不够跑满全部栏目时，除收窄 `slots` 外还可以提交工单提额。
- `node crosspost-runtime/src/cli.mjs aiDetect --budget` 看当月用量、预算与 key 是否就位。

## 5. 用法

```bash
# 查台账与 key 状态（不调接口）
node crosspost-runtime/src/cli.mjs aiDetect --budget

# 检测一篇草稿（自动剥离 frontmatter 与 markdown 标记）
node crosspost-runtime/src/cli.mjs aiDetect --file=/abs/path/to/draft.md

# 按 id 在当前项目草稿目录里找
node crosspost-runtime/src/cli.mjs aiDetect --id=<草稿文件名去.md>

# 裸文本 / 管道（基线回测、排查用）
node crosspost-runtime/src/cli.mjs aiDetect --text='……'
cat draft.md | node crosspost-runtime/src/cli.mjs aiDetect --stdin

# 临时换口径（默认取 config.json → aiDetect.gate）
node crosspost-runtime/src/cli.mjs aiDetect --file=… --metric=confidence
```

MCP 面是同名工具 `ai_detect`（AI 会话侧入口，同一个实现）：入参 `file` / `id` / `text` 三选一，
另有 `metric` / `threshold` / `budget`。

## 6. 三态语义

| verdict | 含义               | 调用方该做什么                                                  |
| ------- | ------------------ | --------------------------------------------------------------- |
| `pass`  | 低于阈值           | 继续走审稿/发布                                                 |
| `fail`  | 超阈值             | 按返回的 `rewriteTargets`（被判 AI 的片段序号）定向改写，再复检 |
| `skip`  | **本次未检测成功** | 如实记"未检测" + 原因，不得当成 pass                            |

`skip` 的 `reason`：`disabled` / `slot-not-enabled`（被 `aiDetect.slots` 白名单挡下）/
`text-too-short`（正文不足 `minChars`，默认 350 字，取官网下限）/
`no-api-key` / `budget-exhausted` / `timeout` / `network-error` / `api-error`（附 `errorCode`：
`AUTH` / `RATE` / `QUOTA` / `SERVER` / `PROVIDER` / `HTTP_<n>`）/ `bad-json` / `bad-response` / `metric-unavailable`。

取向：**凭证缺失、额度不足、接口故障一律放行但显式标注**，不静默、也不阻断出稿——与槽位门禁
"绝不因配置故障静默停发"一致。但"未检测"必须在日志、通知、文章库记录三处都可见，
否则事后无法区分"通过"与"没检测"。

## 7. 实现要点

- `src/ai-detect.mjs` —— 客户端：剥离、调用、归一化、判定、台账。
- `src/commands/ai-detect-cli.mjs` —— CLI handler（输入解析 + 报告压缩）。
- `mcp-server/index.mjs` —— `ai_detect` 工具，只回传**被判 AI 的片段**，不回传全量分段。
- **markdown 剥离必须带偏移映射**：`segment_labels[].position` 是相对**提交文本**的下标，
  剥离时同步记录"第 i 个纯文本字符来自原文第几个字符"（`stripMarkdown` 的 `srcIndex`），
  否则拿到被判 AI 的片段也回不到正文，改写无从下手。
- **失败分类要分清"接口错误"与"网络不通"**：`fetchRetry` 重试用尽后抛的是 `HTTP <n> for <url>`，
  必须还原成 `api-error` + `errorCode`，不能一律归成 `network-error`。
- **限流(429) 与鉴权(401/403) 不重试**，只有 5xx 与网络错误才重试一次。

## 8. 排障

| 现象                        | 查什么                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| `skip/no-api-key`           | `crosspost-runtime/.env` 是否有 `ZHUQUE_API_KEY`；文件权限是否可读  |
| `skip/budget-exhausted`     | `aiDetect --budget` 看当月累计；核对 `monthlyTokenBudget`           |
| `skip/api-error` + `AUTH`   | Key 失效或额度被停；到 EdgeOne 控制台确认                           |
| `skip/api-error` + `RATE`   | 触发限流；降频或错峰                                                |
| `skip/text-too-short`       | 正文不足 `minChars`（默认 350 字）；短文按"未检测"处理              |
| `segments` 为空但整体分正常 | 接口未返回分段；此时只能按整体判定，无法定向改写                    |
| 改完稿分数不降              | 先确认看的是哪个字段：`confidence` 恒饱和，要看 `labels_ratio["1"]` |

## 9. 相关

- 接口面契约（新增 CLI 方法必须显式选面）：[`api-surfaces.md`](api-surfaces.md)
- 配置项说明：[`configuration.md`](configuration.md)
- 接入方写作流水线怎么用这个能力：[`writing-pipelines.md`](writing-pipelines.md)
