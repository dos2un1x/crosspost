/**
 * AI 检测 CLI（`aiDetect`，2026-10-05）
 *
 * 用法：
 *   node cli.mjs aiDetect --file=<草稿绝对路径> [--segments] [--project=…]
 *   node cli.mjs aiDetect --id=<草稿文件名去.md> [--project=…]
 *   node cli.mjs aiDetect --text='<正文>'          # 裸文本（基线回测/排查）
 *   node cli.mjs aiDetect --stdin < draft.md       # 管道输入
 *   node cli.mjs aiDetect --budget                 # 只看当月用量与预算，不调用接口
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
  detectText,
  formatSnapshot,
  formatVerdictLine,
  judgeResult,
  pickRewriteTargets,
  readAiDetectConfig,
  resolveDetectCredentials,
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
  if (typeof flags.metric === 'string') override.gate = { metric: flags.metric }
  if (flags.threshold !== undefined) {
    const t = Number(flags.threshold)
    if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error('--threshold 必须是 0-1 之间的小数')
    override.gate = { ...(override.gate || {}), threshold: t }
  }
  if (flags['min-chars'] !== undefined) override.minChars = Number(flags['min-chars'])
  // 栏目白名单可临时覆盖（`--slots=noon,evening`；空串 = 不限）
  if (typeof flags.slots === 'string') {
    override.slots = flags.slots
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return override
}

/** 压缩报告：整体判定 + 只列被判 AI 的片段（不返回全量分段，省调用方上下文） */
function compactReport(result, cfg) {
  const base = {
    ok: result.ok,
    verdict: result.verdict,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.chars !== undefined ? { chars: result.chars } : {}),
  }
  if (result.verdict === 'skip') return base

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

  return {
    ...base,
    metric: result.metric,
    value: result.value,
    threshold: result.threshold,
    confidence: result.confidence,
    ratioConfidence: result.ratioConfidence,
    labelsRatio: result.labelsRatio,
    aiSegmentCount: aiSegments.filter((s) => s.label === 'ai').length,
    suspectedSegmentCount: aiSegments.filter((s) => s.label === 'uncertain').length,
    segments: aiSegments,
    rewriteTargets: pickRewriteTargets(result, cfg).map((s) => s.order),
    usage: result.usage,
    line: formatVerdictLine(result),
    snapshot: formatSnapshot(result),
  }
}

/** aiDetect：检测一段文本/一篇草稿 */
export async function runAiDetect(args) {
  const flags = parseFlags(args, {
    booleans: ['segments', 'json', 'stdin', 'budget', 'no-budget-check'],
  })
  const cfg = readAiDetectConfig(configOverrideFrom(flags))

  // --budget：只看台账，不调用接口（排查"为什么没检测"用）
  if (flags.budget === true) {
    const b = budgetState(cfg)
    const cred = resolveDetectCredentials()
    return {
      ok: true,
      month: b.month,
      tokens: b.tokens,
      calls: b.calls,
      budget: b.budget,
      remaining: b.remaining,
      exhausted: b.exhausted,
      hasKey: !!cred.apiKey,
      enabled: cfg.enabled,
      gate: cfg.gate,
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
    throw new Error('缺少输入：--file=<路径> | --id=<草稿id> | --text=<正文> | --stdin | --budget')
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
