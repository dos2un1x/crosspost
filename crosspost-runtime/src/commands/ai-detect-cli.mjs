/**
 * AI 检测 CLI（`aiDetect`，2026-10-05）
 *
 * 用法：
 *   node cli.mjs aiDetect --file=<草稿绝对路径> [--segments] [--project=…]
 *   node cli.mjs aiDetect --id=<草稿文件名去.md> [--project=…]
 *   node cli.mjs aiDetect --text='<正文>'          # 裸文本（基线回测/排查）
 *   node cli.mjs aiDetect --stdin < draft.md       # 管道输入
 *   node cli.mjs aiDetect --budget                 # 只看本周期用量与预算，不调用接口
 *   node cli.mjs aiDetect --clear-exhausted        # 清掉本周期被标记失效的 key（误判限流时用）
 *
 * 多把 key（叠加额度）：`ZHUQUE_API_KEY` 之外再填 `ZHUQUE_API_KEYS`（逗号/空格分隔）即为钥匙池，
 * 总额度 = 每把 key 的 `monthlyTokenBudget` × key 数；检测时优先用余量多的，某把被鉴权拒绝/
 * 限流/额度用尽会自动换下一把并把该把标记为本周期失效。
 *
 * 口径/强度/覆盖可临时覆盖：`--mode` / `--enforce` / `--human-min` / `--human-max` /
 * `--ai-min` / `--ai-max` / `--uncertain-min` / `--uncertain-max` / `--threshold` /
 * `--sample-rate` / `--slots=a,b` / `--quota-anchor-day=1..31`。
 *
 * 失败语义分两层（有意不统一）：
 *   · **输入错误 / 文件不存在 → throw**（CLI 退出码 1）：这是调用方写错了，必须当场停住；
 *   · **凭证缺失 / 配额不足 / 接口故障 / 文本过短 → 正常返回 `{verdict:'skip', reason}`**：
 *     这类是"这次检测没做成"，属于可预期的运行态，流水线要能区分"没检测"与"检测不达标"
 *     并照常出稿（放行但显式标注，绝不静默——与 run_once.sh 的 fail-open 同一原则）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseFlags } from '../argv.mjs'
import { getDraftsDir, parseDraftFile } from '../articles.mjs'
import {
  budgetState,
  cachePath,
  clearExhaustedKeys,
  detectText,
  formatSnapshot,
  formatVerdictLine,
  judgeResult,
  pickRewriteTargets,
  readAiDetectConfig,
  resolveDetectCredentials,
  segmentPlan,
  usagePath,
} from '../ai-detect.mjs'

/** 把 `--id` 解析成草稿文件的绝对路径（在当前项目上下文的草稿目录里找） */
function resolveDraftFileById(id) {
  const dir = getDraftsDir()
  const candidates = [path.join(dir, `${id}.md`), path.join(dir, id)]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  throw new Error(`找不到草稿：${id}（草稿目录 ${dir}）`)
}

/** 只允许覆盖少数几个键——避免调用方从命令行把阈值改得面目全非后无人察觉 */
function configOverrideFrom(flags) {
  const override = {}
  const gate = (patch) => {
    override.gate = { ...(override.gate || {}), ...patch }
  }
  const ratio01 = (name, raw) => {
    const v = Number(raw)
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`${name} 必须是 0-1 之间的小数`)
    return v
  }
  if (typeof flags.metric === 'string') gate({ metric: flags.metric })
  if (typeof flags.mode === 'string') {
    if (!['bands', 'distribution', 'metric'].includes(flags.mode)) {
      throw new Error('--mode 只能是 bands / distribution / metric')
    }
    gate({ mode: flags.mode })
  }
  if (flags.threshold !== undefined) gate({ threshold: ratio01('--threshold', flags.threshold) })
  if (flags['human-min'] !== undefined)
    gate({ humanMin: ratio01('--human-min', flags['human-min']) })
  if (flags['ai-max'] !== undefined) gate({ aiMax: ratio01('--ai-max', flags['ai-max']) })
  if (flags['uncertain-max'] !== undefined) {
    gate({ uncertainMax: ratio01('--uncertain-max', flags['uncertain-max']) })
  }
  if (typeof flags.enforce === 'string') {
    if (!['observe', 'block'].includes(flags.enforce)) {
      throw new Error('--enforce 只能是 observe 或 block')
    }
    gate({ enforce: flags.enforce })
  }
  if (flags['human-max'] !== undefined)
    gate({ humanMax: ratio01('--human-max', flags['human-max']) })
  if (flags['ai-min'] !== undefined) gate({ aiMin: ratio01('--ai-min', flags['ai-min']) })
  if (flags['uncertain-min'] !== undefined) {
    gate({ uncertainMin: ratio01('--uncertain-min', flags['uncertain-min']) })
  }
  if (flags['min-chars'] !== undefined) override.minChars = Number(flags['min-chars'])
  // 抽样率（省配额）：按正文哈希确定性放行
  if (flags['sample-rate'] !== undefined) {
    override.sampleRate = ratio01('--sample-rate', flags['sample-rate'])
  }
  // 计费周期锚点日（对齐朱雀"按开通日刷新"的额度周期；缺省 1 = 自然月）
  if (flags['quota-anchor-day'] !== undefined) {
    const day = Number(flags['quota-anchor-day'])
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new Error('--quota-anchor-day 必须是 1-31 的整数')
    }
    override.quotaAnchorDay = day
  }
  // 栏目白名单可临时覆盖（`--slots=noon,evening`；空串 = 不限）
  if (typeof flags.slots === 'string') {
    override.slots = flags.slots
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return override
}

/** 压缩报告：整体判定 + 只列被判 AI/疑似的片段（不返回全量分段，省调用方上下文） */
function compactReport(result, cfg) {
  const base = {
    ok: result.ok,
    verdict: result.verdict,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.chars !== undefined ? { chars: result.chars } : {}),
  }
  // skip 也要给 `line`/`snapshot`：调用方要靠它把"未检测 + 原因"写进日志/通知/文章库记录。
  // 只回 reason 的话，三态里的第三态在快照面上是空的，事后无法区分"跳过"与"没跑过"。
  if (result.verdict === 'skip') {
    return { ...base, line: formatVerdictLine(result), snapshot: formatSnapshot(result) }
  }

  const aiSegments = (result.segments || [])
    .filter((s) => s.label === 1 || s.label === 2)
    .map((s) => ({
      order: s.order,
      label: s.labelName,
      conf: s.conf,
      charRatio: s.charRatio === null ? null : Number(s.charRatio.toFixed(4)),
      charStart: s.charStart,
      charEnd: s.charEnd,
      preview: s.preview,
    }))

  const counts = {
    human: (result.segments || []).filter((s) => s.label === 0).length,
    ai: (result.segments || []).filter((s) => s.label === 1).length,
    uncertain: (result.segments || []).filter((s) => s.label === 2).length,
    total: (result.segments || []).length,
  }
  // 本轮改写计划：由检测结果算（需清几段 / 建议动作），不再依赖配置里的固定段数
  const plan = segmentPlan(result, cfg)

  return {
    ...base,
    metric: result.metric,
    value: result.value,
    threshold: result.threshold,
    ...(result.ratios ? { ratios: result.ratios } : {}),
    ...(result.targets ? { targets: result.targets } : {}),
    ...(result.fails ? { fails: result.fails } : {}),
    ...(result.bands ? { bands: result.bands } : {}),
    ...(result.cached ? { cached: true, cachedAt: result.cachedAt } : {}),
    // enforce=observe 时只报不拦：调用方据此跳过重写循环（省配额）
    action: (cfg.gate && cfg.gate.enforce) === 'block' ? 'block' : 'observe',
    enforce: (cfg.gate && cfg.gate.enforce) || 'observe',
    /**
     * 本次**要不要改写**（2026-10-07 新增）。
     *
     * 为什么不能只看 `action`：它只反映**配置的强度**，与本次判定无关 —— 一篇 `pass` 的稿子
     * 在 `block` 下同样返回 `action:"block"`（实测）。调用方若把 `action` 读成"现在就改"，
     * 就会去改一篇本来达标的稿子：白花额度，还可能把好稿子改坏。
     * 所以另给一个**由判定与强度共同决定**的字段：只有 `fail` + `block` 才为真。
     */
    rewriteRequired: (cfg.gate && cfg.gate.enforce) === 'block' && result.verdict === 'fail',
    // 每轮改几段 = **由检测结果算**（2026-10-07 起），不再是配置里的固定数：
    // 门禁指标按段数计（实测接口占比 ≈ 判 AI 段数 / 总段数），所以"至少要让几段脱掉 AI 标记"
    // 是确定的；`maxSegmentsPerRound` 退化为保险上限。`advise` 直接给出建议动作，
    // 其中 `retain` = 需清段数 > 每轮上限 × 轮数（一轮救不回来）→ 别白花一次改写与检测。
    ...(plan
      ? {
          rewriteNeed: {
            totalSegments: plan.total,
            aiSegments: plan.ai,
            suspectedSegments: plan.uncertain,
            allowedAiSegments: plan.allow.ai,
            allowedUncertainSegments: plan.allow.uncertain,
            allowedAiPlusUncertainSegments: plan.allow.aiPlusUncertain,
            mustRewrite: plan.mustRewrite,
            perRoundTargets: plan.perRoundTargets,
            perRoundCap: plan.perRoundCap,
            capacity: plan.capacity,
            reachable: plan.reachable,
            styleOnly: plan.styleOnly,
            basis: plan.allow.basis,
          },
          advise: plan.advise,
        }
      : {}),
    // 改写预算（2026-10-07）：`block` 下的重写循环由**调用方**执行，而循环的**成本上限**
    // 由 `rewrite.maxRounds` 决定（每篇最多 1 + maxRounds 次检测）。此前调用方只能从
    // 文档里按**名字**猜到这两个键，数值没有随结果下发 —— 它若自己猜一个轮数，
    // 成本上限就形同虚设（额度是按这个上限规划的）。所以把预算显式发给调用方。
    rewriteBudget: {
      maxRounds: Number(cfg.rewrite && cfg.rewrite.maxRounds) || 0,
      maxSegmentsPerRound: Number(cfg.rewrite && cfg.rewrite.maxSegmentsPerRound) || 0,
    },
    confidence: result.confidence,
    ratioConfidence: result.ratioConfidence,
    labelsRatio: result.labelsRatio,
    segmentCounts: counts,
    aiSegmentCount: counts.ai,
    suspectedSegmentCount: counts.uncertain,
    segments: aiSegments,
    rewriteTargets: pickRewriteTargets(result, cfg).map((s) => s.order),
    usage: result.usage,
    // 结构指标（风格护栏）：压缩成几个数——调用方要据此判断"这篇是不是被写成了碎句"，
    // 并定位到段（越界项带段号）。`styleGuard.enabled=false` 时它也只是观察值。
    ...(result.style
      ? {
          style: {
            shortRatio: result.style.shortRatio,
            maxConsecShort: result.style.maxConsecShort,
            longSentCount: result.style.longSentCount,
            noCommaRatio: result.style.noCommaRatio,
            judgedParagraphs: result.style.judgedParagraphs,
            fails: result.style.fails,
            guarded: (cfg.styleGuard && cfg.styleGuard.enabled) === true,
          },
        }
      : {}),
    line: formatVerdictLine(result),
    snapshot: formatSnapshot(result),
  }
}

/** aiDetect：检测一段文本/一篇草稿 */
export async function runAiDetect(args) {
  const flags = parseFlags(args, {
    booleans: ['segments', 'json', 'stdin', 'budget', 'no-budget-check', 'clear-exhausted'],
  })
  const cfg = readAiDetectConfig(configOverrideFrom(flags))
  const cred = resolveDetectCredentials()

  // --clear-exhausted：把本周期被标记失效的 key 放回池子（限流误判时的手工出口，不调接口）
  if (flags['clear-exhausted'] === true) {
    const cleared = clearExhaustedKeys(new Date(), cfg.quotaAnchorDay)
    const b = budgetState(cfg, new Date(), cred.apiKeys)
    return {
      ok: true,
      cleared,
      keyCount: b.keyCount,
      exhausted: b.exhausted,
      keys: b.keys || [],
      hint:
        cleared > 0
          ? `已清掉 ${cleared} 把 key 的本周期失效标记；下一次检测会重新用上它们`
          : '本周期没有被标记失效的 key，池子本来就是全的',
    }
  }

  // --budget：只看台账，不调用接口（排查"为什么没检测"用）
  if (flags.budget === true) {
    // 预算按**池**算（每把 key 的额度 × key 数），所以这里必须把 key 列表传进去，
    // 否则两把 key 只显示一份额度，人工核对时会以为额度没叠加。
    const b = budgetState(cfg, new Date(), cred.apiKeys)
    return {
      ok: true,
      month: b.month,
      periodStart: b.periodStart,
      periodAnchorDay: b.periodAnchorDay,
      tokens: b.tokens,
      calls: b.calls,
      avgTokensPerCall: b.calls > 0 ? Math.round(b.tokens / b.calls) : null,
      budget: b.budget,
      perKeyBudget: b.perKeyBudget,
      remaining: b.remaining,
      exhausted: b.exhausted,
      hasKey: cred.apiKeys.length > 0,
      keyCount: b.keyCount,
      // 分桶明细：哪把 key 用了多少、还剩多少、有没有被标记失效（**只给指纹，不给明文**）
      keys: b.keys || [],
      enabled: cfg.enabled,
      gate: cfg.gate,
      sampleRate: cfg.sampleRate,
      styleGuard: { enabled: !!(cfg.styleGuard && cfg.styleGuard.enabled) },
      cacheFile: cachePath(),
      usageFile: usagePath(),
    }
  }

  let text = null
  let source = null
  if (flags.stdin === true) {
    text = fs.readFileSync(0, 'utf8')
    source = { kind: 'stdin' }
  } else if (typeof flags.text === 'string') {
    text = flags.text
    source = { kind: 'text' }
  } else if (typeof flags.file === 'string') {
    const f = path.resolve(flags.file)
    if (!fs.existsSync(f)) throw new Error(`找不到文件：${f}`)
    text = fs.readFileSync(f, 'utf8')
    source = { kind: 'file', file: f }
  } else if (typeof flags.id === 'string') {
    const f = resolveDraftFileById(flags.id)
    text = fs.readFileSync(f, 'utf8')
    source = { kind: 'file', file: f, id: flags.id }
  } else {
    throw new Error(
      '缺少输入：--file=<路径> | --id=<草稿id> | --text=<正文> | --stdin | --budget | --clear-exhausted',
    )
  }

  // 栏目白名单：额度不够时用 aiDetect.slots 收口（空 = 全部栏目）。
  // 无栏目的输入（--text / --stdin，通常是基线回测与人工排查）不受限制——那些是有意为之的单次调用。
  const wanted = Array.isArray(cfg.slots) ? cfg.slots : []
  const slot = source && source.file ? parseDraftFile(source.file).slot : null
  if (wanted.length && slot && !wanted.includes(slot)) {
    return {
      ok: false,
      verdict: 'skip',
      reason: 'slot-not-enabled',
      slot,
      slots: wanted,
      line: `AI检测=跳过(slot-not-enabled:${slot})`,
      snapshot: `AI检测=跳过(slot-not-enabled:${slot})`,
      source,
    }
  }

  const raw = await detectText(text, {
    config: cfg,
    skipBudgetCheck: flags['no-budget-check'] === true,
  })
  const result = judgeResult(raw, cfg)
  const report = compactReport(result, cfg)
  return { ...report, source }
}
