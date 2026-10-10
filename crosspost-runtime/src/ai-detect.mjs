#!/usr/bin/env node
/**
 * 朱雀 AIGC 文本检测客户端（2026-10-05）
 *
 * 通道：腾讯云 EdgeOne Makers 内置模型 `@makers/zhuque-text`（免费版 50 万 token/月）。
 *   文档：https://cloud.tencent.com/document/product/1552/137539
 *   POST <gateway>/v1/providers/zhuque-text/classify
 *   Body: { text, is_merge }        Header: Authorization: Bearer <API_KEY>
 *   响应：softmax_confidence / ratio_confidence / labels_ratio / segment_labels / usage
 *
 * 为什么用这条通道而不是官网（matrix.tencent.com）：
 *   · 官网是人机校验 + 每日次数限额的前端，批量调用要逆向 TDC 协议，易碎且有条款风险；
 *   · 这条接口在 `is_merge:false` 时返回 `segment_labels[].position`（**字符区间**），
 *     是把"哪几段被判 AI"精确映射回正文、只改那几段的前提。官网只给人类看的分布图。
 *   官网仍有人工抽检价值（人工抽检流程见接入方项目的抽检清单，引擎侧不重复这份规则）。
 *
 * 字段语义（2026-10-05 用真人文本 / AI 腔文本 / 两者混合实测标定，不是猜的）：
 *   · `softmax_confidence` = **整体 AI 生成置信度**（官网顶部显示的那个数）。三组对照：
 *     真人散文 0.0006 · 人机各半 0.7045 · AI 腔 0.9999 —— 它对"人机混合"是按比例反应的。
 *   · `ratio_confidence` = **非人工占比**（≈ labels_ratio[1]+labels_ratio[2]）。只要文里有一段
 *     被判 AI 就是 1.0，**没有区分度，不能拿来做门禁**（这是最容易踩的坑）。
 *   · `labels_ratio` = 分布图口径：{"0":人工特征,"1":AI特征,"2":疑似AI}。
 *   · 因此门禁默认口径是 `confidence`（= softmax_confidence）。
 *
 * 多把 key（叠加额度）：免费额度是**账号级**的，所以 `ZHUQUE_API_KEY` 之外还可以用
 *   `ZHUQUE_API_KEYS` 追加（逗号/空格分隔可写多把）。引擎按"余量最多的先用"均衡消耗，
 *   某把被鉴权拒绝/限流/额度用尽时自动换下一把重试，并把该把标记为本周期失效。
 *   总预算 = `aiDetect.monthlyTokenBudget`（**每把 key**）× key 数；台账按 key 分桶记。
 *
 * 安全：API Key 只允许来自 env / `crosspost-runtime/.env`（均 gitignored）。
 *   与微信凭证同规矩——**绝不落 config.json**（该文件被 git 跟踪，写进去即泄露），
 *   也绝不落台账（台账只存 key 的 sha256 指纹，见 keyId）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRetry } from './fetch-util.mjs'
import { readConfig } from './config-cache.mjs'
import { localRoot } from './paths.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

export const DEFAULT_GATEWAY = 'https://ai-gateway.edgeone.link'
export const PROVIDER = 'zhuque-text'

/** 朱雀标签语义：0=真人 / 1=AI 生成 / 2=不确定（与官网「人工特征 / AI特征 / 疑似AI」一一对应） */
export const LABEL_NAMES = { 0: 'human', 1: 'ai', 2: 'uncertain' }

export const AI_DETECT_DEFAULTS = {
  enabled: true,
  provider: PROVIDER,
  gateway: DEFAULT_GATEWAY,
  /** 官网口径：文本需 > 350 字（接口文档未写下限，取官网更保守的一个） */
  minChars: 350,
  timeoutMs: 60000,
  /**
   * 门禁口径。2026-10-05 用 20 篇基线 + 12 组对照实测后定的默认值，**不是拍脑袋**：
   *   · `confidence`(=softmax) 对现代中文说明文**恒为 0.9999**，20 篇基线无一例外；
   *     连"极短句+第一人称+口语"这种极端文体也只压到 0.49 —— <30% 在这个口径下不可达，
   *     拿它做门禁会永久拦住 100% 的稿子。所以**不能**用它当门禁。
   *   · `labels_ai`（AI 特征字符占比）有区分度：原文 93% → 同题改写 0%，且与人工编辑的
   *     改动强度单调相关。官网给这一档的标签就叫"AI特征"，与业务口径同词。
   * 仍保留 `confidence` / `both` 两个取值，供需要时切换（config 改一行，无需改代码）。
   */
  gate: {
    /**
     * 门禁口径（三种，按"要不要设下界"区分）：
     *
     *   · `metric`（**默认**）：只看一个指标是否**低于** `threshold`。
     *     默认取 `metric: 'labels_ai'` + `threshold: 0.3`，即"AI 特征占比 < 30%"——
     *     单向上界，**越干净越好**，不要求任何一段必须像机器。
     *
     *   · `distribution`（可选，双侧）：`human ≥ humanMin` 且 `ai ≤ aiMax` 且 `uncertain ≤ uncertainMax`。
     *     边界**可以不设**：缺省的边界（NaN/未定义）不参与判定，例如只写 `{mode:'distribution', aiMax:0.3}`
     *     就是"只压 AI 特征上界、人工与疑似只观察"。
     *
     *   · `bands`（可选，严格区间）：三段各给一个区间（见下面六个 min/max）。三者和为 1，所以
     *     "每段都 ≥30%"实际等价于"每段都落在 30%-40%"——它要求文章**保留**一部分 AI 特征文本，
     *     与"把 AI 特征压到 0%"是相反的方向。**它会同时逼出两个方向的凑指标行为**（凑"人工体"、
     *     补"机器腔"），只有确实需要"三种特征三分天下"时才用。
     *
     * 为什么默认是 `metric`：门禁的用途是"别让机器腔过半"，而下界一旦存在，写作者就会去找
     * 最廉价的方式满足它（实测：把段落拆成一行一句的碎句去凑"人工特征"，代价是文章不可读）。
     * 上界是单调的——它只会把人往"更干净"推。
     */
    mode: 'metric',
    /**
     * `bands`/`distribution` 的六个边界（**可选模式的参数**，`metric` 模式下不参与判定）。
     * 默认值给成一组"标准区间"，切到那两种模式时作为起点。
     */
    humanMin: 0.3,
    humanMax: 0.5,
    aiMin: 0.3,
    aiMax: 0.5,
    uncertainMin: 0.2,
    uncertainMax: 0.4,
    /**
     * 哪些边界是**严格**的（开区间）。`['ai:max']` = AI 特征上界为 `<50%` 而非 `≤50%`。
     * 用数组而不是给每个边界配一个布尔键，是为了让"哪条是开区间"在 config、日志与
     * 代码里都是同一处事实。
     */
    exclusive: ['ai:max'],
    /**
     * `observe` = 只报不拦（**不进入重写循环**，每篇仅 1 次调用，配额最优）；
     * `block` = 硬门禁（结构化改写 ≤rewrite.maxRounds，仍不达标则留存）。
     * 目标刚上调时应先观察，确认真实产出能落在目标区间后再切 block。
     */
    enforce: 'observe',
    /** `metric` 模式的指标与阈值：`labels_ai` = AI 特征占比（越小越好） */
    metric: 'labels_ai',
    threshold: 0.3,
  },
  rewrite: {
    /**
     * 改写轮数上限。为什么是 3 而不是 2：实测同一篇 4000 字深度长文，
     * 一轮去模板骨架 73%→34%、二轮微观改句式反而回退到 44%、三轮改成"列举→场景"才降到 26%。
     * 轮数不足会让深度长文整类被门禁拦下。
     */
    maxRounds: 3,
    maxSegmentsPerRound: 5,
    minSegmentConf: 0.5,
    /**
     * 是否把"疑似AI"（label=2）也纳入定向改写。默认 **true**：
     * 疑似段是"机器腔的下游"——只改已判 AI 的段，疑似段下一轮常常就地转成 AI 特征。
     * 注意它只影响**改写目标清单**，不影响判定口径（`metric` 模式仍只看 AI 特征占比）。
     */
    includeSuspected: true,
  },
  /** 凭证缺失/接口故障/配额不足时的行为：skip（放行但显式标注）——不静默、不阻断出稿 */
  onError: 'skip',
  /**
   * 计费周期内的 token 硬闸，口径是**每把 key**（多把 key 叠加时总额 = 该值 × key 数）。
   * **为什么默认 40 万而不是 50 万**：免费额度是账号级 50 万/周期，而按接入方字数「5 篇/天」
   * 一个月约 40–55 万（估算口径见 `docs/ai-detect.md` §4；实测均篇看台账的 tokens/calls）——
   * 额度本来就不够跑满，必须留出余量给基线重跑与人工抽检。
   * 某把 key 超预算就换下一把；**每把都被闸住**才返回 `skip/budget-exhausted`
   * （按"未检测"放行），不会把额度烧穿。
   */
  monthlyTokenBudget: 400000,
  /**
   * 台账的计费周期锚点日（1-31，缺省 1 = 自然月）。朱雀的免费额度是**按开通日**
   * 为起点刷新的，与自然月错位时把它设成开通日即可对齐（小月自动夹到当月最后一天）。
   * 只影响台账的归零点，不影响单次检测的额度判断口径。
   */
  quotaAnchorDay: 1,
  /**
   * 抽样检测率（0-1，默认 1 = 全检）。按**正文内容哈希**确定性地抽样：
   * 同一篇稿子每次判定结果一致，可复现、可审计；被抽掉的返回 `skip/sampled-out`。
   * 这是额度紧张时最直接的省法（0.5 即省一半），代价是覆盖率下降。
   */
  sampleRate: 1,
  /**
   * 只检测哪些栏目（空数组 = 全部）。额度不够时的收口方式：
   * 例如只保留 `["noon","evening"]`（两班深度长文），或用 `["hotspot","noon"]` 之类抽样。
   * `--text`/`--stdin` 这类无栏目输入不受此限制。
   */
  slots: [],
  /**
   * 风格护栏（可选，默认关）。检测结果的 `style` 字段**总是**算出来（纯字符串运算、零成本），
   * 但只有当 `styleGuard.enabled=true` 时，越界才会把 `verdict` 判成 `fail`
   * （`fails[]` 里以 `style:` 前缀列出），并进快照/日志。
   *
   * 为什么需要它：门禁只压"AI 特征占比"这一个上界，而**把文章拆成一行一句的碎句**
   * 恰好能把这个指标压低（接入方 4 篇里，碎句版有 2 篇的 AI 特征掉到 0%/18.5%，
   * 反而"过关"）。也就是说，单靠 AI 特征这道门，**读不成句的文章比正常文章更容易达标**。
   * 这不是写作政策，是判定口径的可被绕过面，所以护栏放在引擎里、可跨项目复用。
   *
   * 阈值与接入方的零配额脚本同源（`STYLE_GUARD`），含义见各字段注释。
   */
  styleGuard: {
    enabled: false,
    /** 句数少于这个数的段落不参与判定（样本太小） */
    minSentencesToJudge: 3,
    /** ≤10 字句占比上限 */
    shortRatioMax: 0.35,
    /** 「短句」判据（比 shortRatioMax 的 ≤10 略宽）：用来抓连珠碎句 */
    shortSentLen: 12,
    /** 连续短句的最大连数 */
    consecutiveShortMax: 3,
    /** 「长句」判据：够长的段落里至少要有这么一句 */
    longSentLen: 25,
    /** 每个够长的段落至少几句长句 */
    minLongSentPerPara: 1,
    /** 触发"每段至少一句长句"的段落字数门槛 */
    minParaChars: 60,
    /** 无逗号句占比只观察：超过这个值在 `style.warn` 里提一句，不判 fail */
    noCommaRatioWarn: 0.6,
  },
}

/** 深合并（只处理 gate/rewrite/styleGuard 三层，其余键平铺覆盖） */
function mergeConfig(base, ...layers) {
  const out = {
    ...base,
    gate: { ...base.gate },
    rewrite: { ...base.rewrite },
    styleGuard: { ...base.styleGuard },
  }
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined || v === null) continue
      if ((k === 'gate' || k === 'rewrite' || k === 'styleGuard') && typeof v === 'object') {
        Object.assign(out[k], v)
      } else out[k] = v
    }
  }
  return out
}

/** 读取检测配置（config.json → aiDetect），可与调用方覆盖项合并；读不到就用内置默认 */
export function readAiDetectConfig(override) {
  let raw = null
  try {
    raw = (readConfig() || {}).aiDetect || null
  } catch {
    raw = null
  }
  return mergeConfig(AI_DETECT_DEFAULTS, raw, override)
}

/**
 * 把 `a,b c` 这类多 key 写法拆成列表（逗号/分号/空白都能分隔，保持书写顺序并去重）。
 * 为什么要支持一把以上的 key：免费额度是**账号级**的，多填一把就多一份额度。
 */
export function parseKeyList(raw) {
  const out = []
  for (const part of String(raw ?? '').split(/[\s,;]+/)) {
    const k = part.trim()
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

/**
 * key 指纹（sha256 前 12 位）。台账里**只存指纹、绝不存明文**：台账落在 localRoot，
 * 保护级别低于 `.env`，明文写进去等于把密钥复制到一个没人记得要 gitignore 的地方。
 */
export function keyId(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 12)
}

/**
 * 解析凭证：env > crosspost-runtime/.env（与 wechat.mjs 同一规矩）。
 *
 * 多 key 两种写法，效果是**叠加**（不是二选一）：
 *   · `ZHUQUE_API_KEY`  —— 主 key，单 key 时代就有，向后兼容；本身也接受逗号分隔的多把；
 *   · `ZHUQUE_API_KEYS` —— 追加的 key 列表（模板里默认注释掉）。
 * `apiKey` 仍返回第一把（老调用方只管一把 key），新增 `apiKeys` 返回完整列表。
 */
export function resolveDetectCredentials() {
  // 三个变量各自独立地"env 优先、缺了才看 .env"。注意读文件的条件保持老样子
  // （主 key 或网关缺了才读）：env 里两样都给全了就不读文件，否则开发机上真实 `.env`
  // 里的第二把 key 会渗进测试与 CI（tests/ai-detect.test.mjs 顶部专门钉了这件事）。
  let apiKeyRaw = process.env.ZHUQUE_API_KEY || ''
  // 新变量用"是否出现过"判断而不是真假判断：这样 `ZHUQUE_API_KEYS=`（空串）能表达
  // "显式不要文件里的追加 key"，而不会又被 .env 填回来。
  let extraRaw = process.env.ZHUQUE_API_KEYS !== undefined ? process.env.ZHUQUE_API_KEYS : null
  let gateway = process.env.EDGEONE_AI_GATEWAY_BASE || ''
  const envFile = path.join(ROOT, '.env')
  if ((!apiKeyRaw || !gateway) && fs.existsSync(envFile)) {
    let text = ''
    try {
      text = fs.readFileSync(envFile, 'utf8')
    } catch {
      text = ''
    }
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line)
      if (!m) continue
      if (m[1] === 'ZHUQUE_API_KEY' && !apiKeyRaw) apiKeyRaw = m[2]
      if (m[1] === 'ZHUQUE_API_KEYS' && extraRaw === null) extraRaw = m[2]
      if (m[1] === 'EDGEONE_AI_GATEWAY_BASE' && !gateway) gateway = m[2]
    }
  }
  const apiKeys = parseKeyList(apiKeyRaw)
  for (const k of parseKeyList(extraRaw)) if (!apiKeys.includes(k)) apiKeys.push(k)
  return { apiKey: apiKeys[0] || '', apiKeys, gateway }
}

/* ────────────────────────────── markdown → 纯文本（带偏移映射） ──────────────────────────────
 * 检测器吃的是纯文本：`##` / `**` / 图片链接 URL 这些标记会污染分词，也让"占全文比例"失真。
 * 但 `segment_labels[].position` 是**相对提交文本**的下标，所以剥离时必须同步记录
 * "第 i 个纯文本字符来自原文第几个字符"——否则拿到了被判 AI 的片段也回不到正文里。
 *
 * 取舍：`*` `_` `` ` `` `|` 这类标记字符在正文里一律丢弃（`2*3`、`snake_case` 会掉一个符号）。
 * 对检测分数没有实质影响，换来的是实现可预测、偏移映射不会错位。
 */

// 源码：https://github.com/dos2un1x/crosspost（作者 dos2un1x）
const RE_HR = /[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*(?=\r?\n|$)/y
const RE_TABLE_SEP =
  /[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*(?=\r?\n|$)/y
const RE_HEADING = /[ \t]*#{1,6}[ \t]+/y
const RE_QUOTE = /[ \t]*>[ \t]?/y
const RE_BULLET = /[ \t]*(?:[-*+][ \t]+|\d{1,3}\.[ \t]+)/y

/** 收集"整段丢弃"的源码区间：markdown 链接/图片的 URL、裸 URL */
function collectDropRanges(s, from) {
  const ranges = []
  for (const m of s.matchAll(/!?\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g)) {
    if (m.index < from) continue
    const br = m[0].search(/\]\(/)
    if (br < 0) continue
    ranges.push([m.index + br, m.index + m[0].length])
  }
  for (const m of s.matchAll(/https?:\/\/[^\s)\]<>"'，。；：、）】]+/g)) {
    if (m.index < from) continue
    ranges.push([m.index, m.index + m[0].length])
  }
  ranges.sort((a, b) => a[0] - b[0])
  return ranges
}

/**
 * 剥离 markdown 得到纯文本 + 偏移映射。
 * @returns {{plain: string, srcIndex: number[], frontmatter: string|null, bodyStart: number}}
 *   `srcIndex[i]` = plain 第 i 个字符在原文里的下标（严格递增）
 */
export function stripMarkdown(text) {
  const s = String(text ?? '')
  let bodyStart = 0
  let frontmatter = null
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(s)
  if (fm) {
    frontmatter = fm[1]
    bodyStart = fm[0].length
  }

  const dropRanges = collectDropRanges(s, bodyStart)
  const out = []
  const srcIndex = []
  const n = s.length
  let i = bodyStart
  let dropped = 0
  let atLineStart = true

  const push = (ch, idx) => {
    out.push(ch)
    srcIndex.push(idx)
  }

  while (i < n) {
    while (dropped < dropRanges.length && dropRanges[dropped][1] <= i) dropped += 1
    if (dropped < dropRanges.length && i >= dropRanges[dropped][0] && i < dropRanges[dropped][1]) {
      i = dropRanges[dropped][1]
      continue
    }

    const c = s[i]
    if (c === '\n') {
      push('\n', i)
      i += 1
      atLineStart = true
      continue
    }
    if (c === '\r') {
      i += 1
      continue
    }

    if (atLineStart) {
      let m
      RE_HR.lastIndex = i
      if ((m = RE_HR.exec(s))) {
        i += m[0].length
        continue
      }
      RE_TABLE_SEP.lastIndex = i
      if ((m = RE_TABLE_SEP.exec(s))) {
        i += m[0].length
        continue
      }
      RE_HEADING.lastIndex = i
      if ((m = RE_HEADING.exec(s))) {
        i += m[0].length
        continue // 仍在行首：允许 `> ## 标题` 这种叠加
      }
      RE_QUOTE.lastIndex = i
      if ((m = RE_QUOTE.exec(s))) {
        i += m[0].length
        continue
      }
      RE_BULLET.lastIndex = i
      if ((m = RE_BULLET.exec(s))) {
        i += m[0].length
        atLineStart = false
        continue
      }
      if (c === '|') {
        i += 1
        continue
      }
      atLineStart = false
    }

    if (c === '*' || c === '_' || c === '`' || c === '|') {
      i += 1 // 强调/代码/表格标记：丢弃字符，保留内容
      continue
    }

    push(c, i)
    i += 1
  }

  return { plain: out.join(''), srcIndex, frontmatter, bodyStart }
}

/** 纯文本区间 → 源码区间（end 为开区间；越界自动夹取） */
export function plainRangeToSrc(strip, start, end) {
  const map = strip.srcIndex
  if (!map.length) return { charStart: null, charEnd: null }
  const s = Math.max(0, Math.min(Number(start) || 0, map.length - 1))
  const e = Math.max(s + 1, Math.min(Number(end) || s + 1, map.length))
  return { charStart: map[s], charEnd: map[e - 1] + 1 }
}

/* ─────────────────── 用量台账（计费周期累计，防打爆免费额度） ───────────────────
 * 朱雀的免费额度是**按开通日**为起点刷新的（见 docs/ai-detect.md §1），而台账最初按自然月
 * 归零——两者错位时会出现"账面还有余量、实际已被停"或反之。所以周期起点可配：
 * `aiDetect.quotaAnchorDay`（1-31，缺省 1 = 自然月）。锚点为 1 时周期键就是 `YYYY-MM`，
 * 与旧台账（只存 `month`）天然兼容，不需要迁移。
 *
 * 2026-10-07 起台账**按 key 分桶**（多把 key 叠加额度）：
 *   { month, periodStart, tokens, calls, keys: { <keyId>: {tokens, calls, exhaustedAt?} } }
 * 顶层 `tokens`/`calls` 仍是**全池聚合**，老消费方（控制台/自检/文章库）不用改也读得到；
 * 分桶只多一件事：判断"哪把 key 还有余量"。旧台账（只有顶层、没有 `keys`）照读不误——
 * 那些量没有 key 归属，池化后记到第一把 key 头上（见 poolBreakdown）。
 */

/** 旧台账（单 key 时代的写入）没有 key 归属，单独一桶；它只是"不知道算谁的"，不是没有 */
export const UNASSIGNED_KEY = 'unassigned'

export function usagePath() {
  return path.join(localRoot(), 'ai-detect-usage.json')
}

export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 某年某月的天数（用"下月第 0 天"求，闰年自动正确） */
function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate()
}

/** 锚点日夹到 1-31；非数字/越界一律回落到 1（自然月） */
export function clampAnchorDay(raw) {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1 || n > 31) return 1
  return n
}

/**
 * 含 `now` 的计费周期。锚点为 1 时返回自然月键（`YYYY-MM`）；否则返回周期**起始日**
 * （`YYYY-MM-DD`）。锚点日大于当月天数时夹到当月最后一天（例如锚点 31 → 2 月从 28/29 起算）。
 */
export function quotaPeriod(now = new Date(), anchorDay = 1) {
  const day = clampAnchorDay(anchorDay)
  const y = now.getFullYear()
  const m = now.getMonth()
  if (day === 1) return { key: monthKey(now), anchorDay: 1 }
  const thisAnchor = Math.min(day, daysInMonth(y, m))
  let sy = y
  let sm = m
  let sd = thisAnchor
  if (now.getDate() < thisAnchor) {
    sm = m === 0 ? 11 : m - 1
    sy = m === 0 ? y - 1 : y
    sd = Math.min(day, daysInMonth(sy, sm))
  }
  const key = `${sy}-${String(sm + 1).padStart(2, '0')}-${String(sd).padStart(2, '0')}`
  return { key, anchorDay: day }
}

function readUsageFile() {
  try {
    return JSON.parse(fs.readFileSync(usagePath(), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 把任意历史形状的台账读成当前周期的分桶表；读不出/跨周期 → 空表（本周期从零起算）。
 * 三种形状都要认：新版（有 `keys`）、旧版（只有 `month`+`tokens`+`calls`）、空/损坏。
 */
function ledgerBuckets(raw, period) {
  const buckets = {}
  if (!raw || typeof raw !== 'object') return buckets
  const key = raw.periodStart ?? (period.anchorDay === 1 ? raw.month : undefined)
  if (key !== period.key) return buckets
  if (raw.keys && typeof raw.keys === 'object') {
    for (const [id, v] of Object.entries(raw.keys)) {
      if (!v || typeof v !== 'object') continue
      buckets[id] = {
        tokens: Number(v.tokens) || 0,
        calls: Number(v.calls) || 0,
        exhaustedAt: v.exhaustedAt || null,
      }
    }
    return buckets
  }
  // 旧台账（单 key 时代）：归到 unassigned 桶，池化时由 poolBreakdown 记到第一把 key 上。
  if (Number(raw.tokens) || Number(raw.calls)) {
    buckets[UNASSIGNED_KEY] = {
      tokens: Number(raw.tokens) || 0,
      calls: Number(raw.calls) || 0,
      exhaustedAt: null,
    }
  }
  return buckets
}

/** 原子写台账（tmp + rename）；写失败不影响检测结果，所以吞掉异常 */
/**
 * 台账文件的跨进程互斥（2026-10-10）。
 *
 * 为什么需要：`addUsage` 是"读台账 → 加一笔 → 原子写回"，**这段整体必须互斥** ——
 * 单看 `writeLedger` 的 tmp+rename 是原子的（不会写出半个文件），但两个进程同时
 * "读到旧值 → 各加一笔 → 各自写回"时，后写的会覆盖先写的，**计数凭空少一笔**。
 * 台账是预算的唯一依据，少计数意味着可能超支；批量补检（并发 4）会天天踩到。
 *
 * 实现：`openSync(..., 'wx')` 抢锁文件 + 同步小睡重试（`Atomics.wait`，不阻塞事件循环之外的东西）。
 * 抢不到就**降级为无锁写入**并留一行 stderr：宁可计数可能少一笔，也不能因为锁文件残留
 * 让检测永远跑不动（陈旧锁最多多等 `LEDGER_LOCK_TIMEOUT_MS`）。
 */
const LEDGER_LOCK_TIMEOUT_MS = 3000
const LEDGER_LOCK_STALE_MS = 10000

function ledgerLockPath() {
  return `${usagePath()}.lock`
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 退化为忙等一次 */
  }
}

/** 拿锁执行 fn；拿不到就无锁执行（并如实提示） */
function withLedgerLock(fn) {
  const lock = ledgerLockPath()
  const started = Date.now()
  let fd = null
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true })
  } catch {
    /* ignore */
  }
  while (Date.now() - started < LEDGER_LOCK_TIMEOUT_MS) {
    try {
      fd = fs.openSync(lock, 'wx')
      break
    } catch (e) {
      if (e && e.code !== 'EEXIST') break
      // 陈旧锁（进程被杀）：超过阈值直接接管，别让一次崩溃永久堵住记账
      try {
        const st = fs.statSync(lock)
        if (Date.now() - st.mtimeMs > LEDGER_LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true })
          continue
        }
      } catch {
        /* 锁刚好被释放 */
      }
      sleepSync(5)
    }
  }
  try {
    return fn()
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(lock, { force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

function writeLedger(period, buckets, now = new Date()) {
  let tokens = 0
  let calls = 0
  for (const b of Object.values(buckets)) {
    tokens += b.tokens
    calls += b.calls
  }
  const next = {
    month: period.key, // 兼容只认 `month` 的旧读法
    periodStart: period.key,
    tokens, // 顶层 = 全池聚合（控制台/自检/文章库直接读这两个）
    calls,
    keys: buckets,
    updatedAt: now.toISOString(),
  }
  try {
    const file = usagePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    /* 台账只是护栏，写不进去不该让检测失败 */
  }
  return next
}

/**
 * 读用量。不给 `apiKey` 时返回**全池聚合**（顶层口径）；给了就读那一把 key 的分桶。
 * 单 key 用法与测试里 `readUsage(now)` 的语义完全不变。
 */
export function readUsage(now = new Date(), anchorDay = 1, apiKey) {
  const period = quotaPeriod(now, anchorDay)
  const buckets = ledgerBuckets(readUsageFile(), period)
  if (apiKey !== undefined) {
    const id = apiKey ? keyId(apiKey) : UNASSIGNED_KEY
    const b = buckets[id] || { tokens: 0, calls: 0, exhaustedAt: null }
    return {
      month: period.key,
      periodStart: period.key,
      keyId: id,
      tokens: b.tokens,
      calls: b.calls,
      exhaustedAt: b.exhaustedAt || null,
    }
  }
  let tokens = 0
  let calls = 0
  for (const b of Object.values(buckets)) {
    tokens += b.tokens
    calls += b.calls
  }
  return { month: period.key, periodStart: period.key, tokens, calls }
}

/** 记账（按 key 分桶；不给 apiKey 时记到 unassigned 桶，语义与旧版一致） */
export function addUsage(tokens, now = new Date(), anchorDay = 1, apiKey) {
  // 读-改-写必须整体互斥：并发补检时两次"读到旧值再各自写回"会丢计数（见 withLedgerLock 说明）
  return withLedgerLock(() => {
    const period = quotaPeriod(now, anchorDay)
    const buckets = ledgerBuckets(readUsageFile(), period)
    const id = apiKey ? keyId(apiKey) : UNASSIGNED_KEY
    const cur = buckets[id] || { tokens: 0, calls: 0, exhaustedAt: null }
    buckets[id] = {
      tokens: cur.tokens + (Number(tokens) || 0),
      calls: cur.calls + 1,
      ...(cur.exhaustedAt ? { exhaustedAt: cur.exhaustedAt } : {}),
    }
    return writeLedger(period, buckets, now)
  })
}

/**
 * 把某把 key 标记为**本周期已失效**：鉴权失败（key 被撤/写错）或撞上配额/限流时，
 * 与其每次检测都拿它去撞一次墙，不如记下来、这一周期不再用它。
 * 标记只看当前周期（跨周期自动失效，不需要手工清理）；误判时手工删掉 `exhaustedAt` 即可。
 */
export function markKeyExhausted(apiKey, now = new Date(), anchorDay = 1) {
  const period = quotaPeriod(now, anchorDay)
  const buckets = ledgerBuckets(readUsageFile(), period)
  const id = keyId(apiKey)
  const cur = buckets[id] || { tokens: 0, calls: 0 }
  buckets[id] = { ...cur, exhaustedAt: now.toISOString() }
  return writeLedger(period, buckets, now)
}

/** 清掉本周期所有 key 的失效标记（`aiDetect --clear-exhausted`；误判限流时的手工出口） */
export function clearExhaustedKeys(now = new Date(), anchorDay = 1) {
  const period = quotaPeriod(now, anchorDay)
  const buckets = ledgerBuckets(readUsageFile(), period)
  let cleared = 0
  for (const [id, b] of Object.entries(buckets)) {
    if (b.exhaustedAt) {
      buckets[id] = { tokens: b.tokens, calls: b.calls }
      cleared += 1
    }
  }
  if (cleared) writeLedger(period, buckets, now)
  return cleared
}

/**
 * 按 key 拆开算余量（多把 key 叠加额度的核心）。
 * @param {string[]} apiKeys 参与池化的 key（顺序 = 优先级）
 * @returns {{period: object, periodStart: string, anchorDay: number, perKeyBudget: number,
 *            keys: Array<{id,tokens,calls,exhaustedAt,budget,remaining,exhausted}>}}
 */
export function poolBreakdown(cfg, apiKeys, now = new Date()) {
  const anchorDay = clampAnchorDay(cfg.quotaAnchorDay)
  const period = quotaPeriod(now, anchorDay)
  const buckets = ledgerBuckets(readUsageFile(), period)
  const perKeyBudget = Number(cfg.monthlyTokenBudget) || 0
  // 旧台账的量没有 key 归属：记到**第一把** key 上。单 key 时代写台账的就是它，这也是最
  // 保守的记法——宁可让第一把提前退出，也不能让池子整体多算出一份额度。
  // tokens 与 calls 一起转记（只转 tokens 会让"逐把调用次数"与聚合口径对不上）。
  // 注意这条规则**依赖书写顺序**：换顺序会把这份遗留用量挪到另一把 key 上（池子总额不变，
  // 只影响"哪把看起来用得多"）。所以逐把明细里显式给出 legacyTokens/legacyCalls，
  // 免得看到"第一把凭空多了 15 万"时以为是漏账。
  let carry = { tokens: 0, calls: 0, ...(buckets[UNASSIGNED_KEY] || {}) }
  const keys = []
  for (const apiKey of apiKeys) {
    const id = keyId(apiKey)
    const b = buckets[id] || { tokens: 0, calls: 0, exhaustedAt: null }
    const legacyTokens = carry.tokens
    const legacyCalls = carry.calls
    carry = { tokens: 0, calls: 0 }
    const tokens = b.tokens + legacyTokens
    keys.push({
      id,
      tokens,
      calls: b.calls + legacyCalls,
      legacyTokens,
      legacyCalls,
      exhaustedAt: b.exhaustedAt,
      budget: perKeyBudget,
      remaining: perKeyBudget > 0 ? Math.max(0, perKeyBudget - tokens) : null,
      exhausted: !!b.exhaustedAt || (perKeyBudget > 0 && tokens >= perKeyBudget),
    })
  }
  return { period, periodStart: period.key, anchorDay, perKeyBudget, keys }
}

/**
 * 预算状态。`apiKeys` 给了就按**池**算（总额度 = 每把 key 的额度 × key 数），
 * 不给就是老的单份预算口径（测试与外部调用方仍在用）。
 * 池模式下 `exhausted` = **所有** key 都没余量；单把 key 用完只该换下一把，不该整体停摆。
 */
export function budgetState(cfg, now = new Date(), apiKeys = null) {
  const anchorDay = clampAnchorDay(cfg.quotaAnchorDay)
  const usage = readUsage(now, anchorDay)
  const perKeyBudget = Number(cfg.monthlyTokenBudget) || 0
  const list = Array.isArray(apiKeys) && apiKeys.length ? apiKeys : null
  const keyCount = list ? list.length : 1
  const budget = perKeyBudget * keyCount
  const pool = list ? poolBreakdown(cfg, list, now) : null
  const exhausted = pool
    ? pool.keys.length > 0 && pool.keys.every((k) => k.exhausted)
    : perKeyBudget > 0 && usage.tokens >= budget
  return {
    ...usage,
    periodAnchorDay: anchorDay,
    budget,
    perKeyBudget,
    keyCount,
    exhausted,
    remaining: budget > 0 ? Math.max(0, budget - usage.tokens) : null,
    ...(pool ? { keys: pool.keys } : {}),
  }
}

/* ────────────────────────── 省配额：内容缓存 + 抽样 ──────────────────────────
 * 一次检测 ≈1.7 × 字数 token，所以"同一篇稿子被检测两次"是纯浪费：
 *   · 人工在 Console 复推、或同一篇既走手动又走定时，正文一个字没变 → 结果必然一样；
 *   · block 模式下的复检，若某轮没改动正文，也没必要重问一遍。
 * 因此按**剥离后正文 + 通道**做哈希缓存（缓存的是归一化结果，不是判定——
 * 判定必须每次用当前 gate 重新算，否则改了阈值会拿到旧结论）。
 */

export function cachePath() {
  return path.join(localRoot(), 'ai-detect-cache.json')
}

/** 缓存键：通道 + 网关 + 剥离后的正文（正文变了就不命中） */
export function contentKey(plain, cfg) {
  return crypto
    .createHash('sha256')
    .update(`${cfg.provider}|${cfg.gateway || DEFAULT_GATEWAY}|${plain}`)
    .digest('hex')
}

function readCacheFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf8'))
    return raw && typeof raw === 'object' && raw.entries ? raw : { entries: {} }
  } catch {
    return { entries: {} }
  }
}

/** 命中则返回归一化结果（含 cached 标记），未命中返回 null */
export function readCachedResult(key) {
  const f = readCacheFile()
  const hit = f.entries[key]
  if (!hit || !hit.result) return null
  return { ...hit.result, cached: true, cachedAt: hit.at }
}

/** 写入缓存（按插入顺序保留最近 CACHE_MAX 条） */
const CACHE_MAX = 300
export function writeCachedResult(key, result, now = new Date()) {
  const f = readCacheFile()
  f.entries[key] = { at: now.toISOString(), result }
  const keys = Object.keys(f.entries)
  if (keys.length > CACHE_MAX) {
    for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete f.entries[k]
  }
  try {
    const file = cachePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(f), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    /* 缓存写不进去不该让检测失败 */
  }
}

/**
 * 确定性抽样：按正文哈希决定检不检。
 * 用哈希而不是随机数，是为了**同一篇稿子每次判定一致**（可复现、可审计），
 * 否则排查"这篇为什么没检测"会变成玄学。
 */
export function shouldSample(plain, cfg) {
  const rate = Number(cfg.sampleRate)
  if (!Number.isFinite(rate) || rate >= 1) return true
  if (rate <= 0) return false
  const h = crypto.createHash('sha1').update(plain).digest()
  const bucket = ((h[0] << 8) | h[1]) / 65536
  return bucket < rate
}

/* ────────────────────────────── 检测 ────────────────────────────── */

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function skipResult(reason, cfg, startedAt, extra = {}) {
  return {
    ok: false,
    verdict: 'skip',
    reason,
    provider: cfg.provider,
    metric: cfg.gate.metric,
    threshold: cfg.gate.threshold,
    ...extra,
    elapsedMs: Date.now() - startedAt,
  }
}

/** HTTP 状态 → 可读错误码（AUTH/RATE/SERVER/HTTP） */
function errorCodeForStatus(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE'
  if (status === 402) return 'QUOTA'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * 这个错误码是不是"**这把 key**的问题"（换一把有意义），而不是"这条链路的问题"（换一把一样）。
 * 鉴权失败 / 配额用尽 / 限流都只跟 key 绑定；5xx、网络、响应格式跟网关绑定，换 key 是白烧额度。
 */
function isKeyLevelError(code) {
  return code === 'AUTH' || code === 'RATE' || code === 'QUOTA'
}

/** 网关把配额问题放在 200 响应的 `msg` 里时的兜底识别（各家措辞不一致，只能宽匹配） */
const QUOTA_MSG_RE =
  /(quota|rate.?limit|too many|exceed|exhaust|insufficient|余额|额度|配额|限流|频率)/i

/**
 * 用**一把** key 发一次检测请求。
 * @returns {Promise<{result?: object, skip?: object, failover?: boolean, markExhausted?: boolean}>}
 *   成功给 `result`（已归一化）；失败给 `skip` + 两个策略位：
 *   `failover` = 换一把 key 有意义；`markExhausted` = 该把这周期别再用了。
 */
async function callClassify({ url, apiKey, plain, strip, cfg, startedAt, chars }) {
  let resp
  try {
    resp = await fetchRetry(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: plain, is_merge: false }),
      },
      {
        attempts: 2,
        baseDelayMs: 800,
        timeoutMs: cfg.timeoutMs,
        // 只重试 5xx 与网络错误；鉴权(401/403)/限流(429)/配额类重试只会更糟
        retryOn: (v) => (v && typeof v.status === 'number' ? v.status >= 500 : true),
      },
    )
  } catch (e) {
    const msg = String((e && e.message) || e)
    // fetchRetry 重试用尽后抛的是 `HTTP <status> for <url>`——这是接口的错误，
    // 不是网络不通；两者混为一谈会让排查方向完全跑偏（"网络问题"vs"服务端 5xx"）。
    const httpMatch = /^HTTP (\d{3}) for /.exec(msg)
    if (httpMatch) {
      const status = Number(httpMatch[1])
      const code = errorCodeForStatus(status)
      return {
        skip: skipResult('api-error', cfg, startedAt, {
          chars,
          errorCode: code,
          status,
          error: msg,
        }),
        failover: isKeyLevelError(code),
        markExhausted: isKeyLevelError(code),
      }
    }
    return {
      skip: skipResult(/timeout/i.test(msg) ? 'timeout' : 'network-error', cfg, startedAt, {
        chars,
        error: msg,
      }),
      failover: false,
      markExhausted: false,
    }
  }

  if (!resp || typeof resp.ok !== 'boolean') {
    return { skip: skipResult('bad-response', cfg, startedAt, { chars }), failover: false }
  }
  if (!resp.ok) {
    const code = errorCodeForStatus(resp.status)
    let body = ''
    try {
      body = (await resp.text()).slice(0, 300)
    } catch {
      body = ''
    }
    return {
      skip: skipResult('api-error', cfg, startedAt, {
        chars,
        errorCode: code,
        status: resp.status,
        error: body,
      }),
      failover: isKeyLevelError(code),
      markExhausted: isKeyLevelError(code),
    }
  }

  let json
  try {
    json = await resp.json()
  } catch (e) {
    return {
      skip: skipResult('bad-json', cfg, startedAt, { chars, error: String((e && e.message) || e) }),
      failover: false,
    }
  }

  if (json && json.status && json.status !== 'success') {
    const msg = String(json.msg || json.status).slice(0, 300)
    // 有些配额问题不体现在 HTTP 状态里，而是 200 + `status!=='success'` + 一句"额度已用尽"。
    const quotaish = QUOTA_MSG_RE.test(msg)
    return {
      skip: skipResult('api-error', cfg, startedAt, { chars, errorCode: 'PROVIDER', error: msg }),
      failover: quotaish,
      markExhausted: quotaish,
    }
  }

  return { result: normalizeResult(json, strip, cfg, startedAt) }
}

/**
 * 检测一段文本。
 * @param {string} input 原文（markdown 或纯文本都行，内部会剥离）
 * @param {{config?: object, skipBudgetCheck?: boolean, apiKey?: string|string[], gateway?: string,
 *          noCache?: boolean, skipSample?: boolean}} [opts]
 *   `apiKey` 可给数组或用逗号分隔的多把（多 key 时按余量轮用 + 失败自动切换）。
 * @returns {Promise<object>} 归一化结果（永不抛：一切失败都表达为 verdict:'skip' + reason）
 */
export async function detectText(input, opts = {}) {
  const cfg = opts.config || readAiDetectConfig()
  const startedAt = Date.now()

  if (!cfg.enabled) return skipResult('disabled', cfg, startedAt)

  const strip = stripMarkdown(input)
  const plain = strip.plain
  const chars = plain.replace(/\s+/g, '').length
  if (chars < cfg.minChars) {
    return skipResult('text-too-short', cfg, startedAt, { chars, minChars: cfg.minChars })
  }

  // 抽样（省配额）：按正文哈希确定性放行，被抽掉的记为 skip，绝不当成通过
  if (!opts.skipSample && !shouldSample(plain, cfg)) {
    return skipResult('sampled-out', cfg, startedAt, { chars, sampleRate: cfg.sampleRate })
  }

  // 内容缓存：同一篇正文不重复花钱（判定仍用当前 gate 重算）
  const ckey = contentKey(plain, cfg)
  if (!opts.noCache) {
    const hit = readCachedResult(ckey)
    // 结构指标**每次现算**：它不花钱，而且必须用"当前"的 styleGuard 阈值与当前正文来算——
    // 缓存里那份可能是旧版本引擎（甚至还没有 style 字段）写下的，直接复用会让护栏静默失效。
    if (hit) return { ...hit, style: measureStyle(strip.plain, cfg.styleGuard) }
  }

  const cred = resolveDetectCredentials()
  // 显式给了 apiKey 就以它为准（**包括空串**）：否则调用方无法表达"这次故意不带凭证"，
  // 测试与排查都会被打回真实 .env 里的 key，静默走成一次真调用。
  const apiKeys = opts.apiKey !== undefined ? parseKeyList(opts.apiKey) : cred.apiKeys
  if (!apiKeys.length) return skipResult('no-api-key', cfg, startedAt, { chars })

  // 预算按池算：每把 key 的额度 × key 数，所以多填一把 key 额度就真的多一份
  const budget = budgetState(cfg, new Date(), apiKeys)
  if (!opts.skipBudgetCheck && budget.exhausted) {
    return skipResult('budget-exhausted', cfg, startedAt, { chars, usage: budget })
  }

  // 候选顺序：**余量多的先用**。两把 key 因此是均衡消耗，而不是把第一把烧穿才轮到第二把
  // （后者在"第一把已在别处用掉大半额度"时会退化成单 key）。已标记失效/没余量的直接剔除，
  // 省下"拿一把已知不行的 key 去撞墙"的那次调用。
  //
  // `skipBudgetCheck`（CLI `--no-budget-check`）的语义是"别拿台账拦我"，所以它也要放过被标记
  // 失效的 key：否则在所有 key 都被标记时，加了这个开关反而比不加更受限——想手工验证一把
  // 被误判的 key 都做不到。此时按余量排序仍生效，健康的那把自然排在前面。
  const pool = budget.keys || []
  const candidates = []
  for (let i = 0; i < apiKeys.length; i += 1) {
    const st = pool[i]
    if (st && st.exhausted && !opts.skipBudgetCheck) continue
    candidates.push({
      apiKey: apiKeys[i],
      id: st ? st.id : keyId(apiKeys[i]),
      remaining: st ? st.remaining : null,
    })
  }
  candidates.sort(
    (a, b) => (b.remaining ?? Number.POSITIVE_INFINITY) - (a.remaining ?? Number.POSITIVE_INFINITY),
  )
  if (!candidates.length) {
    return skipResult('budget-exhausted', cfg, startedAt, { chars, usage: budget })
  }

  const gateway = String(opts.gateway || cred.gateway || cfg.gateway || DEFAULT_GATEWAY).replace(
    /\/+$/,
    '',
  )
  const url = `${gateway}/v1/providers/${encodeURIComponent(cfg.provider)}/classify`

  let last = null
  for (let i = 0; i < candidates.length; i += 1) {
    const cand = candidates[i]
    const attempt = await callClassify({
      url,
      apiKey: cand.apiKey,
      plain,
      strip,
      cfg,
      startedAt,
      chars,
    })
    if (attempt.result) {
      // 记账用 Makers 口径（网关自己的计费口径，实测 ≈ 1.67 × 字数），没有才退回 usage 口径。
      // 与免费额度（50 万 token/月）对比时必须用同一把尺子，否则会低估 ~40%。
      const billed = attempt.result.usage.makerTokens ?? attempt.result.usage.totalTokens
      // 账记到**实际用的那把 key**头上：分桶记账是"哪把还有余量"的唯一依据
      if (typeof billed === 'number') addUsage(billed, new Date(), cfg.quotaAnchorDay, cand.apiKey)
      if (!opts.noCache) writeCachedResult(ckey, attempt.result)
      return attempt.result
    }
    // 失败：带上 key 指纹与已试次数（**只有失败才带**——成功结果会被内容缓存复用，
    // 把"哪把 key 跑的"写进去，命中缓存时会变成一条对不上的旧信息）
    last = { ...attempt.skip, apiKeyId: cand.id, keysTried: i + 1, keyCount: candidates.length }
    // 不是"这把 key 的问题"（5xx/网络/响应格式）：换一把也一样，直接返回，别白烧另一把的额度
    if (!attempt.failover) return last
    // 这把 key 本周期作废：记下来，别再拿它撞墙。误判（例如一阵限流）用
    // `aiDetect --clear-exhausted` 清掉即可，标记只作用当前周期。
    if (attempt.markExhausted) markKeyExhausted(cand.apiKey, new Date(), cfg.quotaAnchorDay)
  }
  // 所有候选都不行：返回最后一次失败（keysTried/keyCount 能区分"一把被限"与"两把都被限"）
  return last
}

/** 归一化接口响应（字段名做防御式读取，名字变了也不会炸） */
export function normalizeResult(json, strip, cfg, startedAt = Date.now()) {
  const src = json || {}
  const confidence = num(src.softmax_confidence ?? src.confidence)
  const ratioConfidence = num(src.ratio_confidence)
  const lr = src.labels_ratio || {}
  const labelsRatio = {
    human: num(lr['0'] ?? lr.human),
    ai: num(lr['1'] ?? lr.ai),
    uncertain: num(lr['2'] ?? lr.uncertain),
  }
  const usageRaw = src.usage || {}
  const makerRaw = src.makers_models_usage || {}
  const usage = {
    totalTokens: num(usageRaw.total_tokens ?? usageRaw.totalTokens),
    // Makers 网关自己的计费口径（实测 ≈ 1.67 × usage），免费额度按它算
    makerTokens: num(makerRaw.total_tokens ?? makerRaw.totalTokens),
  }

  const plainLen = Math.max(1, strip.plain.length)
  const rawSegs = Array.isArray(src.segment_labels) ? src.segment_labels : []
  const segments = rawSegs.map((sg, idx) => {
    const label = num(sg.label)
    const pos =
      Array.isArray(sg.position) && sg.position.length >= 2
        ? [Number(sg.position[0]), Number(sg.position[1])]
        : null
    const mapped =
      pos && Number.isFinite(pos[0]) && Number.isFinite(pos[1]) && pos[1] > pos[0]
        ? plainRangeToSrc(strip, pos[0], pos[1])
        : { charStart: null, charEnd: null }
    return {
      order: num(sg.order) ?? idx + 1,
      label: label === null ? null : label,
      labelName: label === null ? 'unknown' : LABEL_NAMES[label] || 'unknown',
      conf: num(sg.conf),
      charRatio:
        pos && Number.isFinite(pos[0]) && Number.isFinite(pos[1]) && pos[1] > pos[0]
          ? (pos[1] - pos[0]) / plainLen
          : null,
      charStart: mapped.charStart,
      charEnd: mapped.charEnd,
      preview: String(sg.text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60),
    }
  })

  return {
    ok: true,
    verdict: 'unknown', // 由 judgeResult 填
    provider: cfg.provider,
    confidence,
    ratioConfidence,
    labelsRatio,
    segments,
    usage,
    chars: strip.plain.replace(/\s+/g, '').length,
    // 结构指标（零成本、纯字符串运算）：随结果一起返回，`styleGuard.enabled` 决定它是否参与判定
    style: measureStyle(strip.plain, cfg.styleGuard),
    elapsedMs: Date.now() - startedAt,
  }
}

/* ───────────────────────── 风格护栏（结构指标，零成本） ─────────────────────────
 * 一句话：**别让"碎句"成为通过门禁的捷径**。
 *
 * 门禁只有"AI 特征占比"这一个上界，而把段落拆成一行一句、砍掉逗号与长句，恰好能把这个
 * 占比压低——接入方的 4 篇成稿里，碎句版有 2 篇的 AI 特征掉到 0%/18.5%，反而是正常散文
 * 那两篇更高。也就是说单靠这道门，**读不成句的文章比正常文章更容易达标**。
 *
 * 所以引擎自己也算一组风格指标（纯字符串运算，不花钱、不调接口），随结果返回：
 *   · `shortRatio`     ≤10 字句占比（上限）、`maxConsecShort` 连续短句数（上限）
 *   · `longSentCount`  够长的段落里的长句条数（下限）
 *   · `noCommaRatio`   无逗号句占比（**只观察**：正常中文短陈述句本来就不带逗号）
 * `styleGuard.enabled=true` 时越界会把它判成 `fail`（`fails[]` 前缀 `style:`）；
 * 默认关——判定口径的收紧应该由接入方显式打开，而不是悄悄改变既有判定的含义。
 */

/** 切句：中文句末标点与换行（逗号不算断句——碎句稿的特征正是"用换行代替逗号"） */
function splitSentences(text) {
  return String(text ?? '')
    .split(/[。！？!?；;\n]+/)
    .map((s) =>
      s
        .replace(/^[#>*\-\s|]+/, '')
        .replace(/[*`]/g, '')
        .trim(),
    )
    .filter((s) => s.length > 0)
}

/**
 * 量一篇文章的结构指标（入参是**剥离 markdown 后的纯文本**）。
 * 段落按空行切；标题行会自然落成"1 句的段落"而被句数门槛排除，不需要额外识别。
 */
export function measureStyle(plain, spec = AI_DETECT_DEFAULTS.styleGuard) {
  const g = { ...AI_DETECT_DEFAULTS.styleGuard, ...(spec || {}) }
  const paragraphs = String(plain ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text) => {
      const sents = splitSentences(text)
      const lens = sents.map((s) => s.length)
      const chars = text.replace(/\s/g, '').length
      let run = 0
      let maxConsecShort = 0
      for (const l of lens) {
        if (l <= g.shortSentLen) {
          run += 1
          if (run > maxConsecShort) maxConsecShort = run
        } else run = 0
      }
      return {
        chars,
        sentences: lens.length,
        shortRatio: lens.length ? lens.filter((l) => l <= 10).length / lens.length : 0,
        noCommaRatio: lens.length
          ? sents.filter((s) => !s.includes('，') && !s.includes(',')).length / lens.length
          : 0,
        maxConsecShort,
        longSentCount: lens.filter((l) => l >= g.longSentLen).length,
        avgSentLen: lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0,
      }
    })
  const judged = paragraphs.filter((p) => p.sentences >= g.minSentencesToJudge)
  const totalSents = paragraphs.reduce((a, p) => a + p.sentences, 0)
  const weighted = (pick) =>
    totalSents ? paragraphs.reduce((a, p) => a + pick(p) * p.sentences, 0) / totalSents : 0
  const round = (v) => Number(v.toFixed(3))
  return {
    paragraphs: paragraphs.length,
    judgedParagraphs: judged.length,
    sentences: totalSents,
    chars: paragraphs.reduce((a, p) => a + p.chars, 0),
    // 句级加权：短文本与长段落一起统计时，按句数加权比按段平均更贴近"整篇读起来什么节奏"
    avgSentLen: round(weighted((p) => p.avgSentLen)),
    shortRatio: round(weighted((p) => p.shortRatio)),
    noCommaRatio: round(weighted((p) => p.noCommaRatio)),
    maxConsecShort: paragraphs.reduce((a, p) => Math.max(a, p.maxConsecShort), 0),
    longSentCount: paragraphs.reduce((a, p) => a + p.longSentCount, 0),
    /** 逐段越界项（`styleGuard.enabled=false` 时只作为观测量返回） */
    fails: styleFails(paragraphs, g),
    spec: {
      shortRatioMax: g.shortRatioMax,
      shortSentLen: g.shortSentLen,
      consecutiveShortMax: g.consecutiveShortMax,
      longSentLen: g.longSentLen,
      minLongSentPerPara: g.minLongSentPerPara,
      minParaChars: g.minParaChars,
    },
  }
}

/** 逐段判越界：返回 `['short-sent:段2', 'short-run:段2', …]`（带段号，便于定位） */
function styleFails(paragraphs, g) {
  const out = []
  paragraphs.forEach((p, i) => {
    if (p.sentences < g.minSentencesToJudge) return
    if (p.shortRatio > g.shortRatioMax) out.push(`short-sent:段${i + 1}`)
    if (p.maxConsecShort > g.consecutiveShortMax) out.push(`short-run:段${i + 1}`)
    if (p.chars >= g.minParaChars && p.longSentCount < g.minLongSentPerPara) {
      out.push(`no-long-sent:段${i + 1}`)
    }
  })
  return out
}

/**
 * 判定通过与否。两种口径（config.json → aiDetect.gate.mode）：
 *
 * `metric`（默认）—— 只比一个数：`labels_ai`（AI 特征占比）低于 `threshold` 即达标。
 *   只有上界、越干净越好；人工与疑似只作观察（它们仍随结果返回）。
 *
 * `distribution` / `bands`（可选，双侧）—— 见 docs/ai-detect.md §2；
 *   未设的边界不参与判定。
 */
export function judgeResult(result, cfg) {
  return applyStyleGuard(judgeNetResult(result, cfg), cfg)
}

/**
 * 风格护栏的落地点：`styleGuard.enabled=true` 且存在逐段越界项时，把判定降为 `fail`，
 * 并把越界项以 `style:` 前缀并进 `fails[]`（日志/面板沿用它，新增字段 `styleFails` 给机器读）。
 * 关闭时原样返回——判定口径的收紧必须由接入方显式打开。
 */
function applyStyleGuard(result, cfg) {
  const g = (cfg && cfg.styleGuard) || {}
  if (g.enabled !== true) return result
  if (!result || result.verdict === 'skip') return result
  const styleFails = (result.style && result.style.fails) || []
  if (!styleFails.length) return result
  return {
    ...result,
    verdict: 'fail',
    fails: [...(result.fails || []), ...styleFails.map((f) => `style:${f}`)],
    styleFails,
  }
}

/** 网侧判定（不含风格护栏）——口径与边界语义见 docs/ai-detect.md §2 */
function judgeNetResult(result, cfg) {
  if (!result || result.verdict === 'skip') return result
  const gate = cfg.gate || {}
  const mode =
    gate.mode === 'bands' ? 'bands' : gate.mode === 'distribution' ? 'distribution' : 'metric'

  if (mode === 'bands') {
    const lr = result.labelsRatio || {}
    const got = { human: lr.human, ai: lr.ai, uncertain: lr.uncertain }
    // 三段缺任一都无法判定——按"未检测"处理，绝不当成通过
    if (Object.values(got).some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      return { ...result, verdict: 'skip', reason: 'metric-unavailable', metric: 'bands' }
    }
    const bands = {
      human: [Number(gate.humanMin), Number(gate.humanMax)],
      ai: [Number(gate.aiMin), Number(gate.aiMax)],
      uncertain: [Number(gate.uncertainMin), Number(gate.uncertainMax)],
    }
    // 失败项带方向：`human:below` = 低于下界 / `ai:above` = 高于上界
    // `exclusive` 名单里的上界按开区间判（默认只有 AI 特征上界是 <50%）
    const excl = new Set(Array.isArray(gate.exclusive) ? gate.exclusive : [])
    const fails = []
    for (const [name, [lo, hi]] of Object.entries(bands)) {
      if (Number.isFinite(lo) && got[name] < lo) fails.push(`${name}:below`)
      if (Number.isFinite(hi)) {
        const isOpen = excl.has(`${name}:max`)
        if (isOpen ? got[name] >= hi : got[name] > hi) fails.push(`${name}:above`)
      }
    }
    return {
      ...result,
      verdict: fails.length ? 'fail' : 'pass',
      metric: 'bands',
      bands,
      exclusive: Array.isArray(gate.exclusive) ? gate.exclusive : [],
      ratios: got,
      fails,
      value: got.ai,
      threshold: bands.ai[1],
    }
  }

  if (mode === 'distribution') {
    const lr = result.labelsRatio || {}
    const need = {
      human: Number(gate.humanMin),
      ai: Number(gate.aiMax),
      uncertain: Number(gate.uncertainMax),
    }
    const got = { human: lr.human, ai: lr.ai, uncertain: lr.uncertain }
    // 三项里缺任何一个都无法判定——按"未检测"处理，绝不当成通过
    if (Object.values(got).some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      return { ...result, verdict: 'skip', reason: 'metric-unavailable', metric: 'distribution' }
    }
    const fails = []
    if (got.human < need.human) fails.push('human')
    if (got.ai > need.ai) fails.push('ai')
    if (got.uncertain > need.uncertain) fails.push('uncertain')
    return {
      ...result,
      verdict: fails.length ? 'fail' : 'pass',
      metric: 'distribution',
      // 报告口径：目标与实测三项，便于日志/面板直接展示
      targets: need,
      ratios: got,
      fails,
      // 兼容既有消费方：value/threshold 取 binding 项（人工缺口或超限最多的那项）
      value: got.ai,
      threshold: need.ai,
    }
  }

  const metric = gate.metric || 'confidence'
  const threshold = Number(gate.threshold)

  const cands = []
  if (metric === 'confidence' || metric === 'both') {
    cands.push(['confidence', result.confidence])
  }
  if (metric === 'labels_ai' || metric === 'both') {
    cands.push(['labels_ai', result.labelsRatio ? result.labelsRatio.ai : null])
  }
  const usable = cands.filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
  if (!usable.length) {
    return { ...result, verdict: 'skip', reason: 'metric-unavailable', metric }
  }
  const [name, value] = usable.reduce((a, b) => (b[1] > a[1] ? b : a))
  return {
    ...result,
    verdict: value < threshold ? 'pass' : 'fail',
    metric: name,
    threshold,
    value,
  }
}

/* ────────── 每轮改写预算：由**检测结果**算出来，而不是让人拍一个固定数（2026-10-07）──────────
 * 为什么能算：门禁指标是**按段数**算的。实测 24 条真实结果：接口给的 `labels_ratio.ai` 贴着
 * "判 AI 段数 / 总段数"（例：A=3,N=6 → 0.4664；A=4,N=6 → 0.6393；A=5,N=6 → 0.8023），
 * 而"按字数加权"算出来与它差一个数量级（0 / 0.18 / 0.19）。所以"这一轮至少要清几段"是确定的：
 *
 *     allowedAi   = 满足 A/N < threshold 的最大 A = ceil(threshold × N) − 1
 *     mustRewrite = fail 时 A − allowedAi；pass 时 0
 *
 * 为什么不再拿 `maxSegmentsPerRound` 当清单长度：实测它几乎从不"不够"（最大需清 4 段），而是
 * **给多了** —— 12 段里只有 4 段判 AI 时其实只需清 1 段，却递过去 5 个目标，徒增改动面与回退
 * 风险（项目基线实测：同一篇改多了会 34% → 44%）。它现在退化为**保险上限**（防病态批量）。
 *
 * 疑似段：单指标口径（metric + labels_ai）只看 `label=1` 的比例，所以单轮里改疑似段对**本次**
 * 达标没有贡献，不进必需清单；只有 `distribution` / `bands` 这类**给疑似或"AI+疑似"也设了
 * 上界**的口径，疑似段才算必需。这是口径决定的，不是偏好。
 *
 * 一个诚实的余量：接口内部切段比它返回的略细（实测一条 `N=10, A=3, 占比 27.47%` 被接口判
 * **pass**，而按返回的 10 段算会得出"该清 1 段"）。所以算式在"刚好卡线"时可能偏保守一格 ——
 * 宁可多改一段，也不要因为少算一段而白花一整轮（`maxRounds=1` 时等于整篇作废）。
 *
 * 第二条余量（2026-10-08 补）：**段数达标 ≠ 指标达标**。`allow` 是从段数推的，而门禁实际比的
 * 是接口给的**字符加权**占比（实测同一篇 `N=5, A=2` 的段数比是 40%，接口占比是 44.47%）。
 * 于是"清到只剩 1 段"也可能过不了线 —— 如果剩下那一段特别长。用 `占比 × 字数 ÷ 段数` 估出
 * 判 AI 段的平均字数，就能在改写**之前**预判这件事（`projectedAiShare` / `charGuard`）：
 * 预判过不了线时 `advise` 直接给 `retain`，省掉一轮注定失败的改写兼检测。
 */

/**
 * 门禁口径允许的"最多几段判 AI / 疑似"（`null` = 该口径不能用段数表达）。
 *
 * 三种口径的边界语义不同，必须分开算：
 *   · `metric`（严格小于阈值）        → `x/N < t` → `ceil(t·N) − 1`
 *   · `distribution`（上界是闭区间）  → `x/N ≤ t` → `floor(t·N)`
 *   · `bands`（上界开/闭由 `exclusive` 决定，默认 AI 上界是开区间）
 * 另外带**人工下界**的口径还有一条等价约束：`human ≥ h ⇔ (ai + uncertain)/N ≤ 1 − h`。
 */
export function segmentAllowance(cfg, total) {
  const gate = (cfg && cfg.gate) || {}
  const N = Math.max(0, Math.floor(Number(total)))
  if (!N) return { ai: null, uncertain: null, aiPlusUncertain: null, basis: 'no-segments' }
  /** 满足 x/N < t 的最大整数 x（严格小于：t·N 恰为整数时还要再减 1） */
  const maxBelow = (t) => {
    const v = Number(t)
    if (!Number.isFinite(v) || v <= 0) return 0
    if (v >= 1) return N
    return Math.max(0, Math.ceil(v * N) - 1)
  }
  /** 满足 x/N ≤ t 的最大整数 x */
  const maxAtMost = (t) => {
    const v = Number(t)
    if (!Number.isFinite(v) || v < 0) return N
    if (v >= 1) return N
    return Math.max(0, Math.floor(v * N))
  }
  const mode =
    gate.mode === 'bands' ? 'bands' : gate.mode === 'distribution' ? 'distribution' : 'metric'
  if (mode === 'metric') {
    const metric = gate.metric || 'labels_ai'
    // `confidence` 与段无关；`both` 里那条 AI 特征线仍可按段算
    if (metric !== 'labels_ai' && metric !== 'both') {
      return { ai: null, uncertain: null, aiPlusUncertain: null, basis: 'metric-not-segment-based' }
    }
    return {
      ai: maxBelow(gate.threshold),
      uncertain: null,
      aiPlusUncertain: null,
      basis: 'labels_ai < threshold',
    }
  }
  const excl = new Set(Array.isArray(gate.exclusive) ? gate.exclusive : [])
  const aiMax = Number(gate.aiMax)
  const uncMax = Number(gate.uncertainMax)
  const humanMin = Number(gate.humanMin)
  const allowAi =
    mode === 'distribution'
      ? Number.isFinite(aiMax)
        ? maxAtMost(aiMax)
        : null
      : Number.isFinite(aiMax)
        ? excl.has('ai:max')
          ? maxBelow(aiMax)
          : maxAtMost(aiMax)
        : null
  const allowUnc =
    mode === 'distribution'
      ? Number.isFinite(uncMax)
        ? maxAtMost(uncMax)
        : null
      : Number.isFinite(uncMax)
        ? excl.has('uncertain:max')
          ? maxBelow(uncMax)
          : maxAtMost(uncMax)
        : null
  return {
    ai: allowAi,
    uncertain: allowUnc,
    // 人工下界 → (ai + uncertain) 的上界（三项之和恒为 1）
    aiPlusUncertain: Number.isFinite(humanMin) ? maxAtMost(1 - humanMin) : null,
    basis: mode,
  }
}

/**
 * 本轮改写计划（纯函数，便于用真实数据做表驱动测试）。
 *
 * `mustRewrite` = 至少要让几段**脱掉 AI/疑似标记**才可能达标：
 *   · 每条上界各自算缺口（`label=1` / `label=2` 两类段**不能互相顶替**）；
 *   · "人工下界"转化成 `ai + uncertain` 的上界，可以由两类段里任意一段补上；
 *   · 三者取"各缺口之和"与"总和缺口"的较大者 —— 这是满足全部约束的最小翻转数。
 *
 * `advise`（只表达**引擎的建议**，动作仍由调用方决定）：
 *   · `none`       —— 不用改（pass，或口径是 observe）
 *   · `fix-style`  —— 指标达标、只有护栏（碎句）不达标：按 `style.fails` 的段号**并回句子**，不是改片段
 *   · `rewrite`    —— 按 `rewriteTargets` 定向改写
 *   · `retain`     —— 需清段数 > 每轮上限 × 轮数：**一轮救不回来**，建议直接留存，
 *                     省掉一轮注定失败的改写与一次检测（每次 ≈3.8k token）
 */
export function segmentPlan(result, cfg) {
  if (!result || result.verdict === 'skip') return null
  const segs = Array.isArray(result.segments)
    ? result.segments.filter((s) => s && s.label !== null && s.label !== undefined)
    : []
  const total = segs.length
  if (!total) return null
  const ai = segs.filter((s) => s.label === 1).length
  const uncertain = segs.filter((s) => s.label === 2).length
  const allow = segmentAllowance(cfg, total)
  const gate = (cfg && cfg.gate) || {}
  const rewriteCfg = (cfg && cfg.rewrite) || {}
  const styleFails = Array.isArray(result.styleFails) ? result.styleFails : []
  const mode =
    gate.mode === 'bands' ? 'bands' : gate.mode === 'distribution' ? 'distribution' : 'metric'
  // 注意：`metric` 口径**不写 `fails[]`**（只有分布/区间口径写），所以它那条线要看 value/threshold
  const metricFail =
    mode === 'metric'
      ? typeof result.value === 'number' && typeof result.threshold === 'number'
        ? !(result.value < result.threshold)
        : result.verdict === 'fail' && styleFails.length === 0
      : (Array.isArray(result.fails) ? result.fails : []).some(
          (f) => !String(f).startsWith('style:'),
        )
  const gap = (n, allowed) => (allowed === null ? 0 : Math.max(0, n - allowed))
  const needAi = metricFail ? gap(ai, allow.ai) : 0
  const needUncertain = metricFail ? gap(uncertain, allow.uncertain) : 0
  const needSum = metricFail ? gap(ai + uncertain, allow.aiPlusUncertain) : 0
  const mustRewrite = Math.max(needAi + needUncertain, needSum)
  const perRoundCap = Math.max(1, Math.floor(Number(rewriteCfg.maxSegmentsPerRound)) || 5)
  const rounds = Math.max(0, Math.floor(Number(rewriteCfg.maxRounds)) || 0)
  const capacity = perRoundCap * rounds
  const computable = allow.ai !== null || allow.uncertain !== null || allow.aiPlusUncertain !== null
  const blocking = (gate.enforce || 'observe') === 'block'
  const styleOnly = !metricFail && styleFails.length > 0
  // 段数达标 ≠ 指标达标：接口给的占比是**字符加权**的，而 `allow` 是从段数推的。
  // 改完这一批（= 把判 AI 段数压到 `allow.ai`）之后，剩下 `allow.ai` 段仍判 AI，它们吃掉多少字？
  // 按"判 AI 段的平均字数"线性折算就是 `占比 × allow.ai ÷ 判 AI 段数`。这一条只有段数与
  // 占比都拿得到时才判；拿不到就给 true（不拦）—— 别凭猜把还能救的稿子劝退。
  const aiShare = result.labelsRatio ? Number(result.labelsRatio.ai) : NaN
  const bound = mode === 'metric' ? Number(gate.threshold) : Number(gate.aiMax)
  const projectedAiShare =
    allow.ai !== null && ai > 0 && Number.isFinite(aiShare) ? (aiShare * allow.ai) / ai : null
  const charGuard =
    projectedAiShare === null || !Number.isFinite(bound) ? true : projectedAiShare < bound
  let advise = 'none'
  if (blocking && result.verdict === 'fail') {
    if (styleOnly) advise = 'fix-style'
    else if (!computable)
      advise = 'rewrite' // 口径不能按段算 → 交给调用方按结果自行处置
    else if (mustRewrite > capacity || !charGuard) advise = 'retain'
    else advise = 'rewrite'
  }
  return {
    total,
    ai,
    uncertain,
    allow,
    mustRewrite,
    mustRewriteAi: needAi,
    mustRewriteUncertain: needUncertain,
    mustRewriteSum: needSum,
    perRoundCap,
    rounds,
    capacity,
    /** 本轮清单的目标长度（= 需清段数，受保险上限约束） */
    perRoundTargets: Math.min(mustRewrite, perRoundCap),
    reachable: mustRewrite <= capacity && charGuard,
    /** 按"清光本轮容量"投影的 AI 字符占比（null = 缺字数/占比，无法投影） */
    projectedAiShare,
    /** 段数清够了、字符占比仍过不了线（含"无法投影"时的 true） */
    charGuard,
    computable,
    styleOnly,
    styleFails,
    advise,
  }
}

/**
 * 挑出本轮要定向改写的片段：**长度 = 需清段数**（`segmentPlan` 自动算，不再是固定上限）。
 *
 * 构造顺序（重要）：先满足**各条上界各自点名的那一类**段 —— `label=1` 的缺口只能由判 AI 的段补，
 * `label=2` 的缺口只能由疑似段补（两类段不能互相顶替）；只有在"人工下界"这条**总和约束**
 * （`ai + uncertain` 过多）上，两类段才可以互换，此时先用判 AI 的段补（顺带改善头条指标）。
 *
 * 为什么不是"判 AI 的一律排最前"：口径只要约束疑似（`distribution` / `bands`），就可能出现
 * "AI 比例达标、疑似超上界"的情形 —— 先递判 AI 的段等于让调用方去改一段本来合格的文字，
 * 白花改写量还抬高回退风险（实测过：这一改动让 `N=2/A=1/U=1` 的分布口径样例从"给 2 段"
 * 变成"只给真正需要改的那 1 段"）。
 *
 * 同一类里**按置信度升序**（2026-10-08 改，此前是降序）：置信度是"这一段有多像 AI"的直接读数，
 * 0.99 的段改完仍然是 0.99（实测：10-08 三篇改写后判 AI 段的置信度 0.9934→0.9937、
 * 0.9962→0.9995，一个都没翻），而 0.5~0.7 的段本来就是边界态，改写最容易把它推过线。
 * 降序等于"专挑最铁的段改、把最容易翻的那段留在清单外"，对"这一轮能不能过门禁"是反着的。
 * 段长拿不到（接口只给首段 position），所以"翻哪段最省字"无法排序，只能按可翻概率排。
 */
export function pickRewriteTargets(result, cfg) {
  if (!result || !Array.isArray(result.segments)) return []
  const plan = segmentPlan(result, cfg)
  if (!plan || plan.perRoundTargets <= 0) return []
  const rewriteCfg = (cfg && cfg.rewrite) || {}
  const min = Number(rewriteCfg.minSegmentConf)
  const includeSuspected = !!rewriteCfg.includeSuspected
  // 疑似段只有在"口径确实约束它（有上界或有人工下界）"或调用方显式开启时才进候选；
  // 单指标 labels_ai 口径下改它对本次达标无贡献（实测口径只数 label=1 的段）。
  const suspectedEligible =
    includeSuspected || plan.allow.uncertain !== null || plan.allow.aiPlusUncertain !== null
  const passConf = (s) => typeof s.conf !== 'number' || !Number.isFinite(min) || s.conf >= min
  /** 置信度升序：最可能被改写推过线的段排最前 */
  const byConfAsc = (a, b) => (Number(a.conf) || 0) - (Number(b.conf) || 0)
  const aiPool = result.segments.filter((s) => s.label === 1 && passConf(s)).sort(byConfAsc)
  const uncPool = suspectedEligible
    ? result.segments.filter((s) => s.label === 2 && passConf(s)).sort(byConfAsc)
    : []
  const picked = []
  // ① 各上界点名的类别按缺口取（不足则有多少取多少）
  picked.push(...aiPool.slice(0, plan.mustRewriteAi))
  picked.push(...uncPool.slice(0, plan.mustRewriteUncertain))
  // ② 总和约束（人工下界）的剩余缺口：两类段可互换 → 先用判 AI 的，再用疑似
  const short = Math.min(plan.mustRewrite, plan.perRoundTargets) - picked.length
  if (short > 0) {
    picked.push(...aiPool.slice(plan.mustRewriteAi, plan.mustRewriteAi + short))
    const stillShort = Math.min(plan.mustRewrite, plan.perRoundTargets) - picked.length
    if (stillShort > 0) {
      picked.push(
        ...uncPool.slice(plan.mustRewriteUncertain, plan.mustRewriteUncertain + stillShort),
      )
    }
  }
  return picked.slice(0, plan.perRoundTargets)
}

/* ───────────────────── 人读行（快照 / 日志 / 通知 / 面板同源，2026-10-08 重写） ─────────────────────
 * 旧行长这样：
 *   AI检测=pass(口径=labels_ai 值=10.4% 阈值=30.0% AI特征占比=10.4% 段=1人工/1AI/8疑似 字符=2620 风格=ok)
 * 四个问题：同一个数印两遍（`值` 与 `AI特征占比` 恒等）、口径写成配置里的标识符（`labels_ai`）、
 * 判定写英文（`pass`）、字段名比内容还长；而且发布通知还会在它前面再套一层 `AI检测=`，
 * 于是飞书里收到的是 `AI检测=AI检测=pass(...)`。人读的一行不该留这些机器字段的残渣。
 *
 * 现在的形状（` · ` 分段，信息缺哪块就少哪段）：
 *   AI检测=达标 · AI特征 10.4% < 30.0% · 片段 8人工/1疑似/1AI · 2620字 · 风格 正常
 *   AI检测=超标 · 人工 45.0%（≥50.0%）· AI特征 35.0%（≤30.0%）· 疑似 20.0%（≤20.0%）· 越界 人工不足、AI特征超限
 *   AI检测=未检测 · 抽查未命中（sampled-out）
 *
 * 机器字段（`metric` / `value` / `threshold` / `fails` / `reason`）仍在 `ai_detect` 的 JSON 返回里，
 * 面板与通知只渲染这一行。**改这里要同步** `bridge/console/modules/ai-detect-line.mjs`：
 * 面板要把它拆回字段再排版（徽标 + 主判据 + 明细），不能只把整行贴出来。
 */

/** 判定词：`pass/fail/skip` 是机器值，人读的一律用中文 */
const VERDICT_WORDS = { pass: '达标', fail: '超标', skip: '未检测' }

/** 口径标识 → 人话（`labels_ai` 只该出现在 JSON 字段里） */
const METRIC_WORDS = { labels_ai: 'AI特征', confidence: 'AI浓度', both: 'AI浓度+特征' }

/** 三段的短名（分布/区间口径共用） */
const RATIO_WORDS = { human: '人工', ai: 'AI特征', uncertain: '疑似' }

/**
 * skip 原因 → 人话。括号里仍保留原始代码：面板上"为什么没检测"要能一眼看懂，
 * 而按代码排查（文档 §6 有全表）时又不能丢掉代码本身。
 */
const SKIP_REASON_WORDS = {
  disabled: '检测未启用',
  'slot-not-enabled': '栏目不在白名单',
  'text-too-short': '正文过短',
  'sampled-out': '抽查未命中',
  'no-api-key': '未配置凭证',
  'budget-exhausted': '额度已用尽',
  timeout: '接口超时',
  'network-error': '网络异常',
  'api-error': '接口报错',
  'bad-json': '响应无法解析',
  'bad-response': '响应异常',
  'metric-unavailable': '指标缺失',
}

/** 失败项 `fails[]` → 人话（`ai:above` 这类带方向的代码直接印出来没人看得懂） */
const FAIL_WORDS = {
  human: '人工不足',
  ai: 'AI特征超限',
  uncertain: '疑似超限',
  'human:below': '人工偏低',
  'human:above': '人工偏高',
  'ai:below': 'AI特征偏低',
  'ai:above': 'AI特征超限',
  'uncertain:below': '疑似偏低',
  'uncertain:above': '疑似超限',
}

/** 百分比：非有限值打 `n/a`（容受口径下"没设这个边界"是合法状态，直接 toFixed 会印 `NaN%`） */
const pctText = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'n/a'
/** 同上，但"没有"返回 null —— 用于决定整段是否出现（不印 `n/a` 的边界） */
const pctOrNull = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : null

/** 分布口径的一项：值 + 括号里的目标（没设的边界不印） */
function ratioText(key, value, kind, target) {
  const label = `${RATIO_WORDS[key] || key} ${pctText(value)}`
  const t = pctOrNull(target)
  if (!t) return label
  return `${label}（${kind === 'min' ? '≥' : '≤'}${t}）`
}

/**
 * 区间口径的一项：值 + 括号里的区间（只设一边就只印那一边）。
 * 上界在 `exclusive` 名单里时印成 `lo~<hi`（开区间：恰好取到端点**不**达标）——
 * 这个差别正是"AI 特征刚好 50% 为什么判失败"的唯一解释，不能省。
 */
function bandText(key, value, range, exclusive) {
  const label = `${RATIO_WORDS[key] || key} ${pctText(value)}`
  const lo = pctOrNull((range || [])[0])
  const hi = pctOrNull((range || [])[1])
  const open = Array.isArray(exclusive) && exclusive.includes(`${key}:max`)
  const rng = lo && hi ? `${lo}~${open ? '<' : ''}${hi}` : lo ? `≥${lo}` : hi ? `≤${hi}` : ''
  return rng ? `${label}（${rng}）` : label
}

/** 判定依据那段：三种口径各一句（单指标 = 一个数 vs 阈值；另两种 = 三项各自的目标） */
function metricPart(result) {
  if (result.metric === 'bands' && result.ratios) {
    const b = result.bands || {}
    return ['human', 'ai', 'uncertain']
      .map((k) => bandText(k, result.ratios[k], b[k], result.exclusive))
      .join(' · ')
  }
  if (result.metric === 'distribution' && result.ratios) {
    const t = result.targets || {}
    return [
      ratioText('human', result.ratios.human, 'min', t.human),
      ratioText('ai', result.ratios.ai, 'max', t.ai),
      ratioText('uncertain', result.ratios.uncertain, 'max', t.uncertain),
    ].join(' · ')
  }
  // 单指标口径：阈值是"严格小于才达标"，所以对比符用 `<` / `≥` 直接把判定理由写出来
  const name = METRIC_WORDS[result.metric] || 'AI特征'
  const t = Number(result.threshold)
  if (!Number.isFinite(t)) return `${name} ${pctText(result.value)}`
  const v = Number(result.value)
  const op = Number.isFinite(v) ? (v < t ? '<' : '≥') : result.verdict === 'pass' ? '<' : '≥'
  return `${name} ${pctText(result.value)} ${op} ${pctText(t)}`
}

/** 片段数统计：判 AI / 疑似 / 人工 各几段（分布口径下日志与面板都要看段落结构） */
function segmentCounts(result) {
  const segs = result.segments || []
  return {
    ai: segs.filter((s) => s.label === 1).length,
    uncertain: segs.filter((s) => s.label === 2).length,
    human: segs.filter((s) => s.label === 0).length,
    total: segs.length,
  }
}

/** 片段结构：总段数拿不到就整段不印（比印 `片段 0人工/0疑似/0AI` 诚实） */
function segmentPart(result) {
  const c = segmentCounts(result)
  if (!c.total) return ''
  return `片段 ${c.human}人工/${c.uncertain}疑似/${c.ai}AI`
}

/**
 * 风格护栏：只有真跑过结构指标（`style.spec` 存在）才有话说。
 * 越界细节仍保留（这是"这篇被判碎句"的唯一现场证据），但用中文与括号收拢成一小段。
 */
function stylePart(result) {
  const s = result && result.style
  if (!s || !s.spec) return ''
  const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`
  if (!s.fails || !s.fails.length) return '风格 正常'
  return `风格 碎句（越界${s.fails.length}处 短句比${pct(s.shortRatio)} 连短${s.maxConsecShort}）`
}

/**
 * 失败项。单指标口径**不写** `fails[]`（只有分布/区间口径写），它由 `值 ≥ 阈值` 自证，
 * 所以这里为空不是"没失败"，而是"失败已经写在对比符里"。风格类失败由 `stylePart` 表达。
 */
function failsPart(result) {
  const fails = (result.fails || []).filter((f) => !String(f).startsWith('style:'))
  if (!fails.length) return ''
  return `越界 ${fails.map((f) => FAIL_WORDS[f] || String(f)).join('、')}`
}

/** 未检测的原因：人话 + 原始代码（栏目白名单还要带上被挡下的栏目） */
function skipPart(result) {
  const code = String(result.reason || '').trim() || 'unknown'
  const why = SKIP_REASON_WORDS[code]
  const detail = code === 'slot-not-enabled' && result.slot ? `${code}: ${result.slot}` : code
  return why ? `${why}（${detail}）` : detail
}

/** 一行式人读摘要（日志/通知/面板共用；格式与理由见本段顶部注释） */
function gateLine(result, extra = {}) {
  if (!result) return 'AI检测=未执行'
  const verdict = VERDICT_WORDS[result.verdict] || result.verdict
  if (result.verdict === 'skip') {
    const rounds = extra.rounds ? ` · 重写 ${extra.rounds}` : ''
    return `AI检测=${verdict} · ${skipPart(result)}${rounds}`
  }
  const parts = [metricPart(result), failsPart(result)]
  const seg = segmentPart(result)
  if (seg) parts.push(seg)
  const chars = Number(result.chars)
  if (Number.isFinite(chars) && chars > 0) parts.push(`${chars}字`)
  const style = stylePart(result)
  if (style) parts.push(style)
  if (extra.rounds) parts.push(`重写 ${extra.rounds}`)
  if (extra.rolledBack) parts.push('已回退')
  return `AI检测=${verdict} · ${parts.filter(Boolean).join(' · ')}`
}

/** 一行式人读摘要（日志/通知用） */
export function formatVerdictLine(result, extra = {}) {
  return gateLine(result, extra)
}

/**
 * 反解一行门禁快照（`formatSnapshot` 的输出）→ `{verdict, value, chars}`。
 *
 * 为什么要有反向解析：快照是**事后**复盘唯一的载体（记录里存的是这一行文本），
 * 而报表要按它汇总"这周达标几篇、平均特征占比多少"。会话/记录里没有原始 JSON，
 * 所以格式的读写必须由同一个模块负责——这里把两种历史写法都认下来：
 *   · 现行：`AI检测=达标 · AI特征 27.4% < 30.0% · 片段 … · 1496字 · 风格 正常`
 *   · 旧版：`AI检测=pass(口径=labels_ai 值=10.4% 阈值=30.0% … 字符=2620 风格=ok)`
 *   · 未检测：`AI检测=未检测 · 额度已用尽（budget-exhausted）`
 * 认不出来返回 `verdict: 'unknown'`（**不猜**）——报表把 unknown 单独计数，别混进达标率。
 */
export function parseGateSnapshot(text) {
  const raw = String(text == null ? '' : text)
  const out = { verdict: 'unknown', value: null, chars: null }
  if (!raw.trim()) return out
  const head = /AI检测\s*=\s*([^\s(·]+)/.exec(raw)
  const word = head ? head[1] : ''
  // `跳过` 是早期快照的第三种写法（`AI检测=跳过(sampled-out)` / `(slot-not-enabled:tips)`），
  // 语义与 `未检测` 相同：**没检测**，不是通过。
  const byWord = { 达标: 'pass', 超标: 'fail', 未检测: 'skip', 跳过: 'skip' }
  const byCode = { pass: 'pass', fail: 'fail', skip: 'skip', blocked: 'fail', rolledback: 'pass' }
  out.verdict = byWord[word] || byCode[word.toLowerCase()] || 'unknown'
  // 特征占比：现行写 `AI特征 27.4%`，旧版写 `值=10.4%`
  // 注意 `值=` 前面不能用 `\b`：JS 的 \w 只含 ASCII，空格与中文「值」之间不存在词边界
  const v = /AI特征\s*([\d.]+)\s*%/.exec(raw) || /(?:^|[\s(（])值\s*=\s*([\d.]+)\s*%/.exec(raw)
  // 保留四位小数：0.274 直接算会得到 0.27399999999999997，累加进均值后报表会出现 23.999999999%
  if (v) out.value = Math.round(Number(v[1]) * 100) / 10000
  const c = /(\d+)\s*字/.exec(raw) || /字符\s*=\s*(\d+)/.exec(raw)
  if (c) out.chars = Number(c[1])
  return out
}

/** 检测报告快照（写进文章库记录/历史，供事后复盘；纯文本，不含密钥） */
export function formatSnapshot(result, extra = {}) {
  if (!result) return ''
  return gateLine(result, extra)
}
