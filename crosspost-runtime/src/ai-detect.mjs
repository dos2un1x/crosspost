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
     * 门禁口径。
     *   · `metric`（旧口径）：只看 `labels_ai`（AI 特征占比）是否低于 `threshold`。
     *   · `distribution`（现用）：三条同时成立 —— `human ≥ humanMin` 且 `ai ≤ aiMax`
     *     且 `uncertain ≤ uncertainMax`。三项之和为 1，所以这是"要一半文本真的像人写的"，
     *     而不是"只要没被判 AI 就算过"（旧口径下把内容全赶进"疑似"也能过，是虚假达标）。
     */
    mode: 'distribution',
    humanMin: 0.5,
    aiMax: 0.3,
    uncertainMax: 0.2,
    /**
     * `observe` = 只报不拦（**不进入重写循环**，每篇仅 1 次调用，配额最优）；
     * `block` = 硬门禁（结构化改写 ≤rewrite.maxRounds，仍不达标则留存）。
     * 目标刚上调时应先观察，确认真实产出能落在目标区间后再切 block。
     */
    enforce: 'observe',
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
     * 分布口径要求"人工 ≥50%"，而改写前的文本大多落在"疑似"档，不把疑似段纳入就等于没得改。
     */
    includeSuspected: true,
  },
  /** 凭证缺失/接口故障/配额不足时的行为：skip（放行但显式标注）——不静默、不阻断出稿 */
  onError: 'skip',
  /**
   * 当月 token 硬闸（记账口径见 §用量）。**为什么默认 40 万而不是 50 万**：
   * 免费额度是账号级 50 万/周期，实测**每天 5 篇的流水线一个月要约 80 万**（≈1.7 × 字数，
   * 均篇 ~5.5k）——额度本来就不够跑满，必须留出余量给基线重跑与人工抽检。
   * 超预算即返回 `skip/budget-exhausted`（按"未检测"放行），不会把额度烧穿。
   */
  monthlyTokenBudget: 400000,
  /**
   * 只检测哪些栏目（空数组 = 全部）。额度不够时的收口方式：
   * 例如只保留 `["noon","evening"]`（两班深度长文，约 39 万/月，落在额度内），
   * 或用 `["hotspot","noon"]` 之类抽样。`--text`/`--stdin` 这类无栏目输入不受此限制。
   */
  slots: [],
  recheckAfterRevise: true,
}

/** 深合并（只处理 gate/rewrite 两层，其余键平铺覆盖） */
function mergeConfig(base, ...layers) {
  const out = { ...base, gate: { ...base.gate }, rewrite: { ...base.rewrite } }
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined || v === null) continue
      if ((k === 'gate' || k === 'rewrite') && typeof v === 'object') Object.assign(out[k], v)
      else out[k] = v
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

/* ────────────────────────────── 用量台账（月累计，防打爆免费额度） ────────────────────────────── */

export function usagePath() {
  return path.join(localRoot(), 'ai-detect-usage.json')
}

export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function readUsage(now = new Date()) {
  const month = monthKey(now)
  try {
    const raw = JSON.parse(fs.readFileSync(usagePath(), 'utf8'))
    if (raw && raw.month === month) {
      return { month, tokens: Number(raw.tokens) || 0, calls: Number(raw.calls) || 0 }
    }
  } catch {
    /* 文件不存在/损坏 → 当月从零起算 */
  }
  return { month, tokens: 0, calls: 0 }
}

/** 记账（tmp + rename 原子写；写失败不影响检测结果） */
export function addUsage(tokens, now = new Date()) {
  const cur = readUsage(now)
  const next = {
    month: cur.month,
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
  const usage = readUsage(now)
  const budget = Number(cfg.monthlyTokenBudget) || 0
  const exhausted = budget > 0 && usage.tokens >= budget
  return {
    ...usage,
    budget,
    exhausted,
    remaining: budget > 0 ? Math.max(0, budget - usage.tokens) : null,
  }
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
  if (typeof billed === 'number') addUsage(billed)
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
    elapsedMs: Date.now() - startedAt,
  }
}

/**
 * 判定通过与否。两种口径（config.json → aiDetect.gate.mode）：
 *
 * `distribution`（现用）—— 三条同时成立才算过：
 *   `human ≥ humanMin`、`ai ≤ aiMax`、`uncertain ≤ uncertainMax`（三项之和为 1）。
 *   为什么要有这个口径：旧口径只卡 `ai`，把内容从"AI特征"赶进"疑似"就能过——指标好看、
 *   文章并没有更像人写的。加上 `human` 下限才逼出真正的目标；`uncertain` 上限则防止
 *   整篇躲进中间档。失败的项逐个列在 `fails[]` 里，日志与改写才有方向。
 *
 * `metric`（旧口径，保留兼容）—— 只比一个数：
 *   confidence（整体 AI 浓度，官网顶部那个数）/ labels_ai（AI 特征占比）/ both（取最大值）。
 */
export function judgeResult(result, cfg) {
  if (!result || result.verdict === 'skip') return result
  const gate = cfg.gate || {}
  const mode = gate.mode === 'distribution' ? 'distribution' : 'metric'

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
  const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : 'n/a')
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
  const pct1 = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : 'n/a')
  const c = segmentCounts(result)
  const segPart = ` 段=${c.human}人工/${c.ai}AI/${c.uncertain}疑似`
  if (result.metric === 'distribution' && result.ratios) {
    const r = result.ratios
    return (
      `AI检测=${result.verdict}(口径=distribution 人工=${pct1(r.human)} AI特征=${pct1(r.ai)}` +
      ` 疑似=${pct1(r.uncertain)} 失败项=${result.fails && result.fails.length ? result.fails.join('|') : '无'}` +
      `${segPart} 字符=${result.chars || 0}${extra.rounds ? ` 重写=${extra.rounds}` : ''}` +
      `${extra.rolledBack ? ' 回退=1' : ''})`
    )
  }
  return (
    `AI检测=${result.verdict}(口径=${result.metric} 值=${pct1(result.value)}` +
    ` 阈值=${pct1(result.threshold)} AI特征占比=${pct1(result.labelsRatio && result.labelsRatio.ai)}` +
    `${segPart} 字符=${result.chars || 0}${extra.rounds ? ` 重写=${extra.rounds}` : ''})`
  )
}
