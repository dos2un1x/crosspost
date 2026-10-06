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
 * 安全：API Key 只允许来自 env / `crosspost-runtime/.env`（均 gitignored）。
 *   与微信凭证同规矩——**绝不落 config.json**（该文件被 git 跟踪，写进去即泄露）。
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
   * 计费周期内的 token 硬闸（记账口径见 §用量）。**为什么默认 40 万而不是 50 万**：
   * 免费额度是账号级 50 万/周期，而按接入方字数「5 篇/天」一个月约 40–55 万
   * （估算口径见 `docs/ai-detect.md` §4；实测均篇看台账的 tokens/calls）——
   * 额度本来就不够跑满，必须留出余量给基线重跑与人工抽检。
   * 超预算即返回 `skip/budget-exhausted`（按"未检测"放行），不会把额度烧穿。
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

/** 解析凭证：env > crosspost-runtime/.env（与 wechat.mjs 同一规矩） */
export function resolveDetectCredentials() {
  let apiKey = process.env.ZHUQUE_API_KEY || ''
  let gateway = process.env.EDGEONE_AI_GATEWAY_BASE || ''
  const envFile = path.join(ROOT, '.env')
  if ((!apiKey || !gateway) && fs.existsSync(envFile)) {
    let text = ''
    try {
      text = fs.readFileSync(envFile, 'utf8')
    } catch {
      text = ''
    }
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line)
      if (!m) continue
      if (m[1] === 'ZHUQUE_API_KEY' && !apiKey) apiKey = m[2]
      if (m[1] === 'EDGEONE_AI_GATEWAY_BASE' && !gateway) gateway = m[2]
    }
  }
  return { apiKey, gateway }
}

/* ────────────────────────────── markdown → 纯文本（带偏移映射） ──────────────────────────────
 * 检测器吃的是纯文本：`##` / `**` / 图片链接 URL 这些标记会污染分词，也让"占全文比例"失真。
 * 但 `segment_labels[].position` 是**相对提交文本**的下标，所以剥离时必须同步记录
 * "第 i 个纯文本字符来自原文第几个字符"——否则拿到了被判 AI 的片段也回不到正文里。
 *
 * 取舍：`*` `_` `` ` `` `|` 这类标记字符在正文里一律丢弃（`2*3`、`snake_case` 会掉一个符号）。
 * 对检测分数没有实质影响，换来的是实现可预测、偏移映射不会错位。
 */

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
 */

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

export function readUsage(now = new Date(), anchorDay = 1) {
  const period = quotaPeriod(now, anchorDay)
  try {
    const raw = JSON.parse(fs.readFileSync(usagePath(), 'utf8'))
    // 新台账存 periodStart；旧台账只有 month —— 锚点为 1 时两者同形，直接认
    const key = raw && (raw.periodStart ?? (period.anchorDay === 1 ? raw.month : undefined))
    if (raw && key === period.key) {
      return {
        month: period.key,
        periodStart: period.key,
        tokens: Number(raw.tokens) || 0,
        calls: Number(raw.calls) || 0,
      }
    }
  } catch {
    /* 文件不存在/损坏 → 本周期从零起算 */
  }
  return { month: period.key, periodStart: period.key, tokens: 0, calls: 0 }
}

/** 记账（tmp + rename 原子写；写失败不影响检测结果） */
export function addUsage(tokens, now = new Date(), anchorDay = 1) {
  const cur = readUsage(now, anchorDay)
  const next = {
    month: cur.month,
    periodStart: cur.periodStart,
    tokens: cur.tokens + (Number(tokens) || 0),
    calls: cur.calls + 1,
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

/** 预算状态：超了就不再调用（避免把额度烧穿后连"为什么没检测"都查不到） */
export function budgetState(cfg, now = new Date()) {
  const anchorDay = clampAnchorDay(cfg.quotaAnchorDay)
  const usage = readUsage(now, anchorDay)
  const budget = Number(cfg.monthlyTokenBudget) || 0
  const exhausted = budget > 0 && usage.tokens >= budget
  return {
    ...usage,
    periodAnchorDay: anchorDay,
    budget,
    exhausted,
    remaining: budget > 0 ? Math.max(0, budget - usage.tokens) : null,
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
 * 检测一段文本。
 * @param {string} input 原文（markdown 或纯文本都行，内部会剥离）
 * @param {{config?: object, skipBudgetCheck?: boolean}} [opts]
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
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : cred.apiKey
  if (!apiKey) return skipResult('no-api-key', cfg, startedAt, { chars })

  const budget = budgetState(cfg)
  if (!opts.skipBudgetCheck && budget.exhausted) {
    return skipResult('budget-exhausted', cfg, startedAt, { chars, usage: budget })
  }

  const gateway = String(opts.gateway || cred.gateway || cfg.gateway || DEFAULT_GATEWAY).replace(
    /\/+$/,
    '',
  )
  const url = `${gateway}/v1/providers/${encodeURIComponent(cfg.provider)}/classify`

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
      return skipResult('api-error', cfg, startedAt, {
        chars,
        errorCode: errorCodeForStatus(status),
        status,
        error: msg,
      })
    }
    return skipResult(/timeout/i.test(msg) ? 'timeout' : 'network-error', cfg, startedAt, {
      chars,
      error: msg,
    })
  }

  if (!resp || typeof resp.ok !== 'boolean') {
    return skipResult('bad-response', cfg, startedAt, { chars })
  }
  if (!resp.ok) {
    const code = errorCodeForStatus(resp.status)
    let body = ''
    try {
      body = (await resp.text()).slice(0, 300)
    } catch {
      body = ''
    }
    return skipResult('api-error', cfg, startedAt, {
      chars,
      errorCode: code,
      status: resp.status,
      error: body,
    })
  }

  let json
  try {
    json = await resp.json()
  } catch (e) {
    return skipResult('bad-json', cfg, startedAt, { chars, error: String((e && e.message) || e) })
  }

  if (json && json.status && json.status !== 'success') {
    return skipResult('api-error', cfg, startedAt, {
      chars,
      errorCode: 'PROVIDER',
      error: String(json.msg || json.status).slice(0, 300),
    })
  }

  const result = normalizeResult(json, strip, cfg, startedAt)
  // 记账用 Makers 口径（网关自己的计费口径，实测 ≈ 1.67 × 字数），没有才退回 usage 口径。
  // 与免费额度（50 万 token/月）对比时必须用同一把尺子，否则会低估 ~40%。
  const billed = result.usage.makerTokens ?? result.usage.totalTokens
  if (typeof billed === 'number') addUsage(billed, new Date(), cfg.quotaAnchorDay)
  if (!opts.noCache) writeCachedResult(ckey, result)
  return result
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

/** 挑出本轮要定向改写的片段（判 AI 优先，其次"疑似"，按置信度降序，上限 maxSegmentsPerRound） */
export function pickRewriteTargets(result, cfg) {
  if (!result || !Array.isArray(result.segments)) return []
  const min = Number(cfg.rewrite.minSegmentConf)
  const includeSuspected = !!cfg.rewrite.includeSuspected
  return (
    result.segments
      .filter((s) => {
        if (s.label === 1) return true
        return includeSuspected && s.label === 2
      })
      .filter((s) => typeof s.conf !== 'number' || !Number.isFinite(min) || s.conf >= min)
      // 判 AI 的段先改（危害最大），同为判 AI 再按置信度降序
      .sort((a, b) => {
        const la = a.label === 1 ? 0 : 1
        const lb = b.label === 1 ? 0 : 1
        if (la !== lb) return la - lb
        return (Number(b.conf) || 0) - (Number(a.conf) || 0)
      })
      .slice(0, Math.max(1, Number(cfg.rewrite.maxSegmentsPerRound) || 5))
  )
}

/** 一行式人读摘要（日志/通知用） */
export function formatVerdictLine(result) {
  if (!result) return 'AI检测=未执行'
  if (result.verdict === 'skip') return `AI检测=跳过(${result.reason})`
  // 非有限值一律打 `n/a`：容受口径下"没设这个边界"是合法状态（边界为 NaN/undefined），
  // 直接 toFixed 会印出 `NaN%`，读日志的人会以为检测坏了
  const pct = (v) =>
    typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'n/a'
  if (result.metric === 'bands' && result.ratios) {
    const r = result.ratios
    const b = result.bands || {}
    return (
      `AI检测=${result.verdict === 'pass' ? '达标' : '超标'}` +
      ` 口径=bands 人工=${pct(r.human)}[${pct((b.human || [])[0])}~${pct((b.human || [])[1])}]` +
      ` AI特征=${pct(r.ai)}[${pct((b.ai || [])[0])}~${pct((b.ai || [])[1])}]` +
      ` 疑似=${pct(r.uncertain)}[${pct((b.uncertain || [])[0])}~${pct((b.uncertain || [])[1])}]` +
      `${result.exclusive && result.exclusive.length ? ` 开区间=${result.exclusive.join('|')}` : ''}` +
      ` 失败项=${result.fails && result.fails.length ? result.fails.join('|') : '无'}`
    )
  }
  if (result.metric === 'bands' && result.ratios) {
    const r = result.ratios
    return (
      `AI检测=${result.verdict}(口径=bands 人工=${pct1(r.human)} AI特征=${pct1(r.ai)}` +
      ` 疑似=${pct1(r.uncertain)} 失败项=${result.fails && result.fails.length ? result.fails.join('|') : '无'}` +
      `${segPart} 字符=${result.chars || 0}${extra.rounds ? ` 重写=${extra.rounds}` : ''}` +
      `${extra.rolledBack ? ' 回退=1' : ''})`
    )
  }
  if (result.metric === 'distribution' && result.ratios) {
    const r = result.ratios
    const t = result.targets || {}
    return (
      `AI检测=${result.verdict === 'pass' ? '达标' : '超标'}` +
      ` 口径=distribution` +
      ` 人工=${pct(r.human)}(目标≥${pct(t.human)} 缺口=${pct(r.human - t.human)})` +
      ` AI特征=${pct(r.ai)}(目标≤${pct(t.ai)} 超出=${pct(r.ai - t.ai)})` +
      ` 疑似=${pct(r.uncertain)}(目标≤${pct(t.uncertain)} 超出=${pct(r.uncertain - t.uncertain)})` +
      ` 失败项=${result.fails && result.fails.length ? result.fails.join('|') : '无'}`
    )
  }
  return (
    `AI检测=${result.verdict === 'pass' ? '达标' : '超标'}` +
    ` 口径=${result.metric} 值=${pct(result.value)} 阈值=${pct(result.threshold)}` +
    ` AI特征占比=${pct(result.labelsRatio && result.labelsRatio.ai)}`
  )
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

/** 检测报告快照（写进文章库记录/历史，供事后复盘；纯文本，不含密钥） */
export function formatSnapshot(result, extra = {}) {
  if (!result) return ''
  if (result.verdict === 'skip')
    return `AI检测=跳过(${result.reason})${extra.rounds ? ` 重写=${extra.rounds}` : ''}`
  const pct1 = (v) =>
    typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'n/a'
  const c = segmentCounts(result)
  const segPart = ` 段=${c.human}人工/${c.ai}AI/${c.uncertain}疑似`
  // 风格护栏：开了才写进快照（没开时不加噪音，但 `style` 仍随返回值给调用方）
  const stylePart = styleSnapshotPart(result)
  if (result.metric === 'distribution' && result.ratios) {
    const r = result.ratios
    return (
      `AI检测=${result.verdict}(口径=distribution 人工=${pct1(r.human)} AI特征=${pct1(r.ai)}` +
      ` 疑似=${pct1(r.uncertain)} 失败项=${result.fails && result.fails.length ? result.fails.join('|') : '无'}` +
      `${segPart} 字符=${result.chars || 0}${stylePart}${extra.rounds ? ` 重写=${extra.rounds}` : ''}` +
      `${extra.rolledBack ? ' 回退=1' : ''})`
    )
  }
  return (
    `AI检测=${result.verdict}(口径=${result.metric} 值=${pct1(result.value)}` +
    ` 阈值=${pct1(result.threshold)} AI特征占比=${pct1(result.labelsRatio && result.labelsRatio.ai)}` +
    `${segPart} 字符=${result.chars || 0}${stylePart}${extra.rounds ? ` 重写=${extra.rounds}` : ''})`
  )
}

/**
 * 快照里的风格片段：只在"有 `style` 且确实越界过"时出现。
 * 形如 ` 风格=碎句(短句比=100% 连短=7)`；正常散文写 ` 风格=ok`。
 */
function styleSnapshotPart(result) {
  const s = result && result.style
  if (!s || !s.spec) return ''
  const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`
  if (!s.fails || !s.fails.length) return ' 风格=ok'
  return ` 风格=碎句(短句比=${pct(s.shortRatio)} 连短=${s.maxConsecShort} 越界=${s.fails.length}处)`
}
