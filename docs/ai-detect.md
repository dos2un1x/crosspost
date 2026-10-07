# AI 检测（朱雀）

> 引擎侧能力：给一篇文章一个**外部 AI 判分**，并把"哪几段像 AI 写的"落到正文的具体字符区间上。
> 写作政策（什么时候检测、不达标怎么改）属于接入方项目，引擎只管能力与运行态。

## 1. 通道与凭证

| 项       | 值                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| 模型     | 腾讯朱雀（EdgeOne Makers 内置模型 `@makers/zhuque-text`）                                                            |
| 端点     | `POST https://ai-gateway.edgeone.link/v1/providers/zhuque-text/classify`                                             |
| 鉴权     | `Authorization: Bearer <API_KEY>`，Key 在控制台 **Makers → Models → API Key** 创建                                   |
| 凭证位置 | `crosspost-runtime/.env` 的 `ZHUQUE_API_KEY`（env 优先；两者都 gitignored。模板见 `crosspost-runtime/.env.example`） |
| 多把 key | 追加写 `ZHUQUE_API_KEYS`（逗号/空格分隔，可写多把），**额度叠加**；见下面「钥匙池」                                  |
| 额度     | 内置模型 50 万 token/月**每把 key**，按开通日为周期起点自动刷新；不足可再填一把 key 或工单提额                       |
| 官方文档 | <https://cloud.tencent.com/document/product/1552/137539>                                                             |

**密钥不落 `config.json`**：凭证只走 env / `.env`，与微信凭证同一规矩。

### 钥匙池：多把 key 叠加额度

免费额度是**账号级**的，所以"多填一把 key"就是"多一份额度"：

- `ZHUQUE_API_KEY` 是主 key（本身也可写成逗号分隔的多把），`ZHUQUE_API_KEYS` 是追加列表，两者**叠加**而非二选一。
- 总额度 = `aiDetect.monthlyTokenBudget`（**每把 key** 的值）× key 数。台账**按 key 分桶**记账（只存 key 的
  `sha256` 前 12 位指纹，**不存明文**），所以"哪把还剩多少"是可查的。
- 每次检测优先用**余量最多**的那把 → 两把是均衡消耗，而不是把第一把烧穿才轮到第二把。
- 某把返回 `401/403`（key 失效）、`429`（限流）、`402`（配额）或 200 + "额度用尽"文案时：**自动换下一把重试**，
  并把该把标记为**本周期失效**（此后直接跳过它，不再拿它撞墙）。标记只作用当前周期，跨周期自动清零。
- 全部候选都不可用时才返回 `skip/budget-exhausted`（`apiKeyId` / `keysTried` / `keyCount` 能区分
  "一把被限"与"两把都被限"）。`5xx` / 网络 / 响应格式类失败**不换 key**——那跟 key 无关，换了是白烧另一把的额度。
- 限流被误判时（例如一阵突发限流），用 `aiDetect --clear-exhausted` 把标记清掉放回池子；
  `aiDetect --budget` 的 `keys[]` 会列出每把的 `tokens` / `remaining` / `exhaustedAt`。

## 2. 字段语义

接口返回四个部位，能当门禁的是 `labels_ratio` 的三段：

| 字段                 | 含义                                                  | 可否作门禁                                                                                                                                         |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `softmax_confidence` | 整体 AI 生成置信度（官网顶部显示的数字）              | ❌ 对现代中文说明文**恒为 `0.9999`**；换成"极短句 + 第一人称 + 口语"的极端文体也只压到 `0.49`。`<30%` 在这个口径下不可达，作门禁会永久拦住全部稿件 |
| `ratio_confidence`   | 非人工占比（≈ `labels_ratio[1] + labels_ratio[2]`）   | ❌ 只要有一段被判 AI 就是 `1.0`，无区分度                                                                                                          |
| `labels_ratio`       | `{"0":人工特征, "1":AI特征, "2":疑似AI}` 占比         | ✅ 三段都要看，见下面的门禁口径                                                                                                                    |
| `segment_labels[]`   | 分段判定，含 `position:[起,止]`（提交文本的字符区间） | ✅ 定向改写的依据                                                                                                                                  |

### 门禁口径：三种，按"要不要设下界"分

三段之和恒为 1，这是所有口径设计的前提。三种模式（`aiDetect.gate.mode`）：

**`metric`（默认）—— 单指标阈值，只有上界**

只看一个指标是否**低于** `threshold`。默认 `metric: "labels_ai"` + `threshold: 0.30`，
即 **AI 特征占比 < 30% 达标**；`confidence` / `both` 是另外两个可选项（见 §2 首表）。

它是**单向上界**：越干净越好，不要求任何一段必须像机器。人工特征与疑似占比仍会算出来、
仍会随结果返回（`labelsRatio`），但**只作观察，不参与判定**。

> **为什么默认选它**：下界一旦存在，写作者就会去找最廉价的方式满足它。两种下界各有代价——
> 要求"人工特征 ≥ N%"时，最省力的写法是把句子拆成一行一句的碎句（无逗号、超短句）；
> 要求"AI 特征 ≥ N%"时，等于**要求文章保留机器腔**，与"去 AI 味"是相反方向。
> 两者同时存在时，文章会变成"一半碎句、一半套话"的拼贴。上界不会产生这类激励。

**`distribution` —— 一条下限 + 两条上限（可选，双侧）**

| 项          | 目标                      | 含义                             |
| ----------- | ------------------------- | -------------------------------- |
| `human`     | ≥ `humanMin`（默认 0.30） | 人工特征**不得低于**三成——硬下限 |
| `ai`        | ≤ `aiMax`（默认 0.50）    | 上限，**没有下限、越低越好**     |
| `uncertain` | ≤ `uncertainMax`（0.50）  | 上限，防止整篇躲在中间档         |

这是**容受**而非**配额**：区间表示"可以接受"，不代表"必须留着"。`fails[]` 只会有
`human` / `uncertain` 这两种（整篇机器腔时才出现 `ai`）。
三个边界**可以不设**：缺省的边界（未定义）不参与判定，所以
`"gate": {"mode": "distribution", "aiMax": 0.3}` 就是"只压 AI 特征上界，人工与疑似只观察"。

**`bands`（可选，严格区间）—— 每段各给一个区间**

`humanMin~humanMax` / `aiMin~aiMax` / `uncertainMin~uncertainMax`。三者和为 1，所以
"每段都 ≥30%"实际把每段**锁进 30%-40%**，即要求文章**保留**至少三成 AI 特征文本。
越界项带方向，形如 `human:below` / `ai:above`。

边界默认是**闭区间**；`gate.exclusive`（默认 `["ai:max"]`）里的名字按**开区间**判——
默认参数下 AI 特征要求落在 `[30%, 50%)`，恰好 50% 判不达标。用数组而不是给每个边界配一个布尔键，
是为了让"哪条是开区间"在 config、日志与代码里都是同一处事实（日志里印 `开区间=…`）。

**只有在确实需要"三种特征三分天下"时才用它**：它同时逼两个方向（凑人工体、补机器腔）。
一组典型的生产数据足以说明这个口径有多难满足——同一条流水线的 4 篇成稿：

| 稿子     | 人工% | AI 特征% | 疑似% | `bands` 判定                  |
| -------- | ----- | -------- | ----- | ----------------------------- |
| 深度长文 | 23.6  | 0.0      | 76.4  | fail（人工低、AI 低、疑似高） |
| 热点解读 | 17.5  | 42.7     | 39.8  | fail（人工低）                |
| 热点解读 | 0.0   | 46.6     | 53.4  | fail（人工低、疑似高）        |
| 晚间长文 | 0.0   | 18.5     | 81.5  | fail（三项全越界）            |

注意"AI 特征 0.0% 也算不达标"这一行：`ai:below` 与 `human:below` 同时出现，意味着
**写得越干净越不合格**。把口径换回 `metric`（只压上界）后，这 4 篇里有 2 篇直接达标。

### 风格护栏：别让"碎句"成为达标捷径（可选，默认关）

**动机**：门禁只压"AI 特征占比"这一个上界，而把段落拆成一行一句、砍掉逗号与长句，恰好能把这个
占比压低。同一批 4 篇成稿的对照说明了问题——碎句版里有两篇的 AI 特征掉到 **0.0% / 18.5%**，
反而改成正常散文的那两篇更高（33%-46%）。**单靠 AI 特征这道门，读不成句的文章比正常文章更容易达标。**

引擎因此自己也算一组结构指标（纯字符串运算，**不额外调用接口、不花额度**），随每次检测结果返回：

| 字段（`result.style`） | 含义                             | 判定                                           |
| ---------------------- | -------------------------------- | ---------------------------------------------- |
| `shortRatio`           | ≤10 字句占比                     | 上限 0.35                                      |
| `maxConsecShort`       | 连续短句（≤12 字）的最大连数     | 上限 3                                         |
| `longSentCount`        | 够长的段落（≥60 字）里的长句条数 | 每段至少 1 句 ≥25 字                           |
| `noCommaRatio`         | 无逗号句占比                     | **只观察**（正常中文的短陈述句本来就不带逗号） |
| `fails[]`              | 逐段越界项，形如 `short-run:段2` | —                                              |

`aiDetect.styleGuard.enabled = true` 时，`fails[]` 非空即把判定降为 `fail`，越界项以
**`style:` 前缀**并进 `fails[]`（如 `style:short-run:段2`）；快照/日志里写
`风格=碎句(短句比=100% 连短=7 越界=3处)`，正常散文写 `风格=ok`。

**默认关**：判定口径的收紧应由接入方显式打开。开与不开的差别只有"碎句是否判 fail"这一条，
`style` 指标在任何情况下都会返回——所以**先观察一段时间再决定**也是可行的用法。

> 阈值可用 `aiDetect.styleGuard` 里的同名字段覆盖（`shortRatioMax` / `consecutiveShortMax` /
> `longSentLen` / `minLongSentPerPara` / `minParaChars` / `minSentencesToJudge`）。

### 门禁强度：observe / block

| 值                | 行为                                                                                                                                     | 适用                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `observe`（默认） | 只报不拦：照常返回真实 `verdict` 与 `fails`，但**不进入重写循环**，调用方记日志后继续走原流程。每篇仅 1 次调用，配额最优                 | 目标刚调整、还在看真实分布 |
| `block`           | 硬门禁：按 `rewriteTargets`（长度 = 引擎算出的需清段数）定向改写 ≤`rewrite.maxRounds` 轮，仍不达标则留存；`advise=retain` 时连改写都不做 | 分布已稳定、要开始强制时   |

返回里的 `action` 字段直接给出本次应执行的动作（`observe` / `block`），调用方不必自己推断 config。

> **`action` 是引擎的建议，不是对调用方的约束。** `observe` 下引擎不代做改写，也不阻止任何后续动作；
> 接入方完全可以自行把 `fail` 当硬门禁（自己组织定向改写、自己决定留存）。两种选择都合法，
> 但**别把 `observe` 读成"这篇不用管"**——判定与 `fails[]` 在任何强度下都是真实值。

### 优化单元是"段落"，不是"整篇"

`labels_ratio` 近似**按分段计权**（15 段中 4 段判 AI ⇒ 4/15 ≈ 26.7%，与返回的 25.94% 吻合），
段落规模约 280 字/段。所以占比是**段落级**的量：改一段只动一格，改不到就白改；
短文本分段少、粒度粗（3 段里 1 段被判 AI 就是 33%），阈值要与正文长度一起看。

默认口径（`metric`）下要压的是 `labels_ratio["1"]`；`human` / `uncertain` 两段只作观察——
它们能说明"这一段为什么被判 AI"（疑似档往上一格就是 AI 特征），但不是达标条件。

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
| **额度硬闸**   | `monthlyTokenBudget`（**每把 key** 的值），单把累计超过即不再用它；每把都被闸住才算池子用尽            | 兜底，防止把额度烧穿                                                         |

抽样用哈希而不是随机数，是为了让"这篇为什么没检测"可复现——否则排查会变成玄学。

## 4. 用量

- 计费口径看 `makers_models_usage.total_tokens`（网关侧记账），≈ **1.7 × 正文字数**；
  `usage.total_tokens` ≈ 1.0 × 字数，用它估额度会低估约 40%。**控制台「模型用量」页是权威口径**。
- 台账在 `<repo>/.local/ai-detect-usage.json`，按**计费周期**累计、跨周期归零；额度是**账号级**，全引擎共用一份台账。
  注意：台账只统计**经引擎发起的**调用，直接用 curl/脚本打接口的部分不在里面——对账以控制台为准。
- 台账形状 `{month, periodStart, tokens, calls, keys: {<指纹>: {tokens, calls, exhaustedAt?}}}`：
  顶层 `tokens`/`calls` 是**全池聚合**（控制台/自检/文章库读这两个），`keys` 是按 key 分桶的明细。
  旧台账（单 key 时代只有顶层）照读不误——那些量没有 key 归属，池化后记到**第一把** key 头上
  （最保守的记法：宁可让第一把提前退出，也不让池子多算出一份额度）。这条规则**依赖书写顺序**：
  换顺序会把这份遗留用量挪到另一把 key（池子总额不变，只影响"哪把看起来用得多"），所以逐把明细里
  显式给出 `legacyTokens` / `legacyCalls`——看到"第一把凭空多了十几万"先看这个字段，那不是漏账。
  单个 key 的用量也可直接读：`readUsage(now, anchorDay, apiKey)`。
- 周期默认是**自然月**，而朱雀的免费额度是**按开通日**为起点刷新的：两者错位时把
  `aiDetect.quotaAnchorDay` 设为开通日（1-31，小月自动夹到当月最后一天）即可对齐。
- `config.json → aiDetect.monthlyTokenBudget`（代码默认 **40 万**，部署可改；当前生效值以 `aiDetect --budget` 为准）
  是硬闸，口径是**每把 key**：总额度 = 该值 × 已配置 key 数（`--budget` 的 `budget` 即总额、
  `perKeyBudget` 是单把、`keys[]` 是逐把明细）。每把都被闸住（或标记失效）才返回
  `skip/budget-exhausted`（按"未检测"放行，不阻断出稿）。留出的余量用于基线重跑与人工抽检。
- **量级与覆盖率的关系**（按接入方的字数为准重算；均篇 ≈ 1.7 × 字数）：

  | 覆盖                                   | 月度消耗（30 天） | 是否落在 50 万免费额度内 |
  | -------------------------------------- | ----------------- | ------------------------ |
  | 5 篇/天（全栏目：2 篇长文 + 3 篇快讯） | ≈ 47 万           | ✅ 贴线                  |
  | 只检长文（2 篇/天）                    | ≈ 28 万           | ✅ 宽裕                  |
  | 只检快讯（3 篇/天）                    | ≈ 19 万           | ✅ 宽裕                  |

  这张表只是**估算**，实际有两道闸要同时满足：既不能超免费额度，也不能超 `monthlyTokenBudget`
  （代码默认 40 万，比表里的估算**先**到线）。要按自己的真实消耗核对，看 `aiDetect --budget`
  返回的 `tokens` / `calls`（两者相除即均篇 token）。
  上面的"50 万"是**单把 key** 的免费额度；填了 N 把 key 就是 50 万 × N，`monthlyTokenBudget`
  也按同一倍数放大（`--budget` 里的 `budget` 已是放大后的总额）。
  全栏目覆盖几乎没有余量，因此**每篇只在定稿后检测一次**（`observe` 不做复检正是为此）。
  `aiDetect.slots` 是一个**可选**的栏目白名单：

  ```json
  "aiDetect": { "slots": [] }                  // 空数组 = 不限栏目（全检）
  "aiDetect": { "slots": ["noon", "evening"] } // 或只检指定栏目
  ```

  `--text` / `--stdin`（基线回测、人工排查）不受该白名单限制。
  被白名单挡下时返回 `skip/slot-not-enabled`，零请求零消耗。

- 额度不够跑满全部栏目时，除收窄 `slots` 外还可以提交工单提额。
- `node crosspost-runtime/src/cli.mjs aiDetect --budget` 看当月用量、预算与 key 是否就位。

## 5. 用法

```bash
# 查台账与 key 状态（不调接口；keys[] 是逐把明细）
node crosspost-runtime/src/cli.mjs aiDetect --budget

# 限流被误判成"本周期失效"时，把 key 放回池子（不调接口）
node crosspost-runtime/src/cli.mjs aiDetect --clear-exhausted

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
`project` 指定项目；口径与强度可临时覆盖 `mode` / `humanMin` / `humanMax` / `aiMin` / `aiMax` /
`uncertainMin` / `uncertainMax` / `sampleRate` / `enforce`，旧口径另有 `metric` / `threshold`；
`budget: true` 只看台账不调接口。

`gate.enforce=block` 时，返回里除 `rewriteTargets`（本轮要定向改写的片段序号）之外，还给三个字段：

- **`rewriteRequired`** —— **本次要不要改**的判据（= `fail` 且 `block`）。**别用 `action` 判断**：`action` 只反映配置强度，一篇 `pass` 的稿子在 `block` 下同样返回 `action:"block"`；把它读成"现在就改"会去改本来达标的稿子。
- **`rewriteNeed`** —— **需清几段是算出来的，不是配置里的固定数**。门禁指标按**段数**计（接口给的 AI 占比 ≈ 判 AI 段数 / 总段数），所以"至少要让几段脱掉 AI 标记"是确定的：
  `allowedAiSegments = ceil(阈值 × 总段数) − 1`（口径是**严格小于**阈值）、`mustRewrite = 判 AI 段数 − allowedAiSegments`。
  `perRoundTargets` 就是 `rewriteTargets` 的长度（受 `rewrite.maxSegmentsPerRound` 这个**保险上限**约束，它不再决定清单长度）；`capacity = 每轮上限 × maxRounds`；`reachable=false` 表示一轮救不回来。
  短文的容错更小是同一算式的结果：一篇 5 段的稿子最多只能有 1 段判 AI（`ceil(1.5)−1`），而 12 段的长文允许 3 段。
- **`advise`** —— 引擎的建议动作：`none`（不用改）/ `rewrite`（按 `rewriteTargets` 定向改写）/
  `fix-style`（指标达标、只有风格护栏不达标 → 按 `style.fails` 的段号**并回句子**，不是改片段）/
  `retain`（`mustRewrite > capacity`：**一轮救不回来 → 直接留存**，别白花一轮改写与一次检测）。
- **`rewriteBudget`** —— `{maxRounds, maxSegmentsPerRound}`。重写循环由**调用方**执行（引擎没有 LLM，不代改稿），所以轮数必须照它走：一篇稿子的检测次数上限 = `1 + maxRounds`，额度就是按这个上限规划的；调用方自己猜轮数会让上限失效。

> 清单里只放**必需**的段：单指标口径（`metric` + `labels_ai`）只看 `label=1` 的比例，所以改"疑似"段对本次达标没有贡献，它们不进清单；只有 `distribution` / `bands` 这类给疑似（或"AI + 疑似"）也设了上界的口径，疑似段才算必需。`maxSegmentsPerRound` 与 `minSegmentConf` 仍是配置项，但**只作保险**：前者限单轮批量上限，后者是纳入清单的最低置信度。

CLI（`aiDetect`）是同一实现的命令行面，除上面的 `--budget` / `--clear-exhausted` / `--metric` /
`--file` / `--id` / `--text` / `--stdin` 外，还接受 `--mode` / `--enforce` / `--human-min` /
`--human-max` / `--ai-min` / `--ai-max` / `--uncertain-min` / `--uncertain-max` / `--sample-rate` /
`--slots=a,b` / `--threshold` / `--segments` / `--project=…`。

`--no-budget-check` 是"别拿台账拦我"的手工出口：越过额度硬闸，并放过被标记为失效的 key
（否则所有 key 都被标记时，加了这个开关反而比不加更受限——想手工验证一把被误判的 key 都做不到）。
注意它只解除**引擎侧**的护栏，朱雀账号侧的真实额度照样生效。

## 6. 三态语义

| verdict | 含义               | 调用方该做什么                                                  |
| ------- | ------------------ | --------------------------------------------------------------- |
| `pass`  | 低于阈值           | 继续走审稿/发布                                                 |
| `fail`  | 超阈值             | 按返回的 `rewriteTargets`（被判 AI 的片段序号）定向改写，再复检 |
| `skip`  | **本次未检测成功** | 如实记"未检测" + 原因，不得当成 pass                            |

`skip` 的 `reason`：`disabled` / `slot-not-enabled`（被 `aiDetect.slots` 白名单挡下）/
`text-too-short`（正文不足 `minChars`，默认 350 字，取官网下限）/ `sampled-out`（被
`sampleRate` 的确定性抽样抽掉）/
`no-api-key` / `budget-exhausted` / `timeout` / `network-error` / `api-error`（附 `errorCode`：
`AUTH` / `RATE` / `QUOTA` / `SERVER` / `PROVIDER` / `HTTP_<n>`）/ `bad-json` / `bad-response` / `metric-unavailable`。

多把 key 时，`api-error` 只有在**所有**候选 key 都失败后才会返回，并带 `apiKeyId`（失败的那把的指纹）、
`keysTried` / `keyCount`（试了几把、一共有几把）——`keysTried === keyCount` 说明两把都被限了。

取向：**凭证缺失、额度不足、接口故障一律放行但显式标注**，不静默、也不阻断出稿——与槽位门禁
"绝不因配置故障静默停发"一致。但"未检测"必须在日志、通知、文章库记录三处都可见，
否则事后无法区分"通过"与"没检测"。

### 发布侧：把快照变成硬要求（可选）

判定归判定，**"有没有把判定结果带进发布回执"是另一件事**：`publish_article` 的 `aiDetect` 是可选入参，
不传就写"未执行"。想让"缺快照"变成可拦的条件，把 `aiDetect.requireSnapshotOnPublish` 设为 `true`：

| 值              | 缺快照时的行为                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `false`（默认） | 照常派发，记录与通知里写"未执行"                                                                                 |
| `true`          | **不派发**（平台与微信都不发），仍落草稿 + 历史，回执给 `dispatch:"skipped"` 与 `skipReason`，通知文案写真实原因 |

不做成"抛错"是有意的：定时链路无人值守，一次异常会丢掉整轮结果；停在草稿态是可恢复的，
补上快照重跑即可。`--text`/`--stdin` 的裸检测与这条开关无关。

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
- **多把 key 的失败切换只认"key 级"错误**：`AUTH`/`RATE`/`QUOTA`（含 200 响应里"额度用尽"文案）才换下一把，
  并把这把标记为本周期失效；`5xx`/网络/响应格式不换——那跟 key 无关，换了是白烧另一把的额度。
- **key 明文绝不落台账**：分桶键是 `sha256(key)` 前 12 位（`keyId`），台账在 `localRoot`，
  保护级别低于 `.env`。

## 8. 排障

| 现象                        | 查什么                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `skip/no-api-key`           | `crosspost-runtime/.env` 是否有 `ZHUQUE_API_KEY`（模板 `.env.example`）；`npm run doctor` 也会提醒 |
| `skip/budget-exhausted`     | `aiDetect --budget` 看当月累计与 `keys[]`；核对 `monthlyTokenBudget`（口径是每把 key）             |
| 检测突然只用一把 key        | `aiDetect --budget` 看另一把的 `exhaustedAt`（被 401/429 标记失效）；误判就 `--clear-exhausted`    |
| `skip/sampled-out`          | 正常（被 `sampleRate` 抽掉）；要全检就把 `sampleRate` 调回 1                                       |
| `skip/api-error` + `AUTH`   | Key 失效或额度被停；到 EdgeOne 控制台确认（多把 key 时会自动换下一把，`keysTried` 表明换了几把）   |
| `skip/api-error` + `RATE`   | 触发限流；降频或错峰（多把 key 时先换手，全被限才返回）                                            |
| `skip/text-too-short`       | 正文不足 `minChars`（默认 350 字）；短文按"未检测"处理                                             |
| `segments` 为空但整体分正常 | 接口未返回分段；此时只能按整体判定，无法定向改写                                                   |
| 改完稿分数不降              | 先确认看的是哪个字段：`confidence` 恒饱和，要看 `labels_ratio["1"]`                                |

## 9. 相关

- 接口面契约（新增 CLI 方法必须显式选面）：[`api-surfaces.md`](api-surfaces.md)
- 配置项说明：[`configuration.md`](configuration.md)
- 接入方写作流水线怎么用这个能力：[`writing-pipelines.md`](writing-pipelines.md)
