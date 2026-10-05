// AI 检测（朱雀 @makers/zhuque-text）单测，2026-10-05
//
// 重点不在"接口通不通"，而在三个最容易静默错的地方：
//   ① markdown 剥离后**偏移映射**必须还能指回正文——错一个字符，改写就会改错段；
//   ② 一切失败都必须表达成 `verdict:'skip'` 且带 reason，**绝不能悄悄变成 pass**；
//   ③ 限流/鉴权不重试、5xx 才重试（重试 429 只会把额度与风控烧得更快）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  AI_DETECT_DEFAULTS,
  addUsage,
  budgetState,
  detectText,
  formatSnapshot,
  shouldSample,
  formatVerdictLine,
  judgeResult,
  normalizeResult,
  pickRewriteTargets,
  plainRangeToSrc,
  readUsage,
  stripMarkdown,
} from '../src/ai-detect.mjs'

/* ────────────────── 测试脚手架 ────────────────── */

/**
 * 入口级用例（`runAiDetect`）必须**完全自洽**，不许读开发机的三样东西：
 * `crosspost-runtime/.env`、`config.json`、`~/.dsh`。
 *
 * 为什么：`runAiDetect` 走真实入口，凭证由 `resolveDetectCredentials()` 解析
 * （env > `.env`，见 src/ai-detect.mjs:163），配置由 `readAiDetectConfig()` 读
 * `readConfig()`（`CROSSPOST_CONFIG` > `<runtime>/config.json`）。而 `.env` 与
 * `config.json` 都是 gitignored / 本机文件——于是本机有 key、且 `aiDetect.slots`
 * 恰好放行 `noon` 时才绿；CI / 干净 clone 上先撞 `no-api-key` 或 `slot-not-enabled`，
 * 变成 `verdict:'skip'`，用例报 `'skip' !== 'fail'`（2026-10-05 CI 实测）。
 *
 * 这与 publish.test.mjs 的做法一致（那边也叫"沙箱 config.json"，并写明
 * "读真实 config.json 会让使用者在 Console 改一次设置就变红"）。本文件里直接调
 * `detectText` 的用例本来就是自洽的（显式传 config/apiKey），这里补齐入口级的两样。
 *
 * 键值直接取自 `AI_DETECT_DEFAULTS`（而不是另抄一份字面量）：既钉住当前行为，
 * 又不会在默认值演进后与源码脱节。显式传 `apiKey:''` 的"凭证缺失"用例不受影响
 * （显式值优先，含空串）。
 */
const TEST_API_KEY = 'test-key'
const TEST_GATEWAY = 'https://gw.test'
const testEnvKeys = ['ZHUQUE_API_KEY', 'EDGEONE_AI_GATEWAY_BASE', 'CROSSPOST_CONFIG']
const prevEnv = Object.fromEntries(testEnvKeys.map((k) => [k, process.env[k]]))
process.on('exit', () => {
  for (const k of testEnvKeys) {
    if (prevEnv[k] === undefined) delete process.env[k]
    else process.env[k] = prevEnv[k]
  }
})
process.env.ZHUQUE_API_KEY = TEST_API_KEY
process.env.EDGEONE_AI_GATEWAY_BASE = TEST_GATEWAY

/** 沙箱 config.json：钉住 aiDetect（值 = 内置默认），使入口级用例与开发机配置无关 */
const SANDBOX_CONFIG = path.join(os.tmpdir(), `cp-aidetect-config-${process.pid}.json`)
fs.writeFileSync(SANDBOX_CONFIG, JSON.stringify({ aiDetect: AI_DETECT_DEFAULTS }), 'utf8')
process.env.CROSSPOST_CONFIG = SANDBOX_CONFIG
process.on('exit', () => fs.rmSync(SANDBOX_CONFIG, { force: true }))

/** 每个用例一套独立的用量台账（否则前一个用例的记账会污染后一个） */
function freshLocalRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-aidetect-'))
  process.env.CROSSPOST_LOCAL_ROOT = d
  return d
}

/** 造一份够长的正文（>350 字），避免所有用例都掉进 text-too-short */
function longText(extra = '') {
  return `## 这是小标题\n\n${'这是一段用来测检测链路的正文，包含具体数字 2026 年与结论。'.repeat(20)}\n${extra}`
}

/** 覆盖 global.fetch，记录调用次数，用完自动还原 */
function withFetch(impl, fn) {
  const orig = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return impl(url, opts, calls.length)
  }
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = orig
    })
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}

/** 文档里那份响应形状（人类文本） */
function successBody(overrides = {}) {
  return {
    status: 'success',
    softmax_confidence: 0.05,
    ratio_confidence: 0.04,
    labels_ratio: { 0: 0.9, 1: 0.05, 2: 0.05 },
    segment_labels: [{ text: '这是小标题', label: 0, conf: 0.02, order: 1, position: [0, 5] }],
    usage: { total_tokens: 1234 },
    msg: '',
    ...overrides,
  }
}

const CFG = {
  ...AI_DETECT_DEFAULTS,
  gate: { metric: 'confidence', threshold: 0.3 },
  rewrite: { ...AI_DETECT_DEFAULTS.rewrite },
}

/* ────────────────── ① markdown 剥离 + 偏移映射 ────────────────── */

test('stripMarkdown：剥掉 frontmatter / 标记 / URL，保留正文文字', () => {
  const src =
    '---\ntitle: 测试标题\nscore: 88\n---\n\n' +
    '## 小标题\n\n' +
    '这是**加粗**的文字，还有[链接文字](https://example.com/x)与裸链接 https://foo.bar/baz。\n\n' +
    '- 列表项一\n' +
    '1. 列表项二\n' +
    '> 引用行\n\n' +
    '| 表头 | 值 |\n| --- | --- |\n| 甲 | 乙 |\n\n' +
    '---\n\n尾段。\n'

  const { plain, srcIndex, frontmatter } = stripMarkdown(src)

  assert.match(frontmatter, /title: 测试标题/)
  assert.doesNotMatch(plain, /---/)
  assert.doesNotMatch(plain, /title:/)
  assert.doesNotMatch(plain, /##/)
  assert.doesNotMatch(plain, /\*\*/)
  assert.doesNotMatch(plain, /https?:\/\//)
  assert.doesNotMatch(plain, /^\s*[-*+]\s/m, '列表符号应被剥掉')
  assert.doesNotMatch(plain, /^\s*>\s?/m, '引用符号应被剥掉')
  assert.doesNotMatch(plain, /\|/, '表格竖线应被剥掉')

  for (const keep of [
    '小标题',
    '加粗',
    '链接文字',
    '列表项一',
    '列表项二',
    '引用行',
    '甲',
    '尾段',
  ]) {
    assert.ok(plain.includes(keep), `正文应保留「${keep}」`)
  }

  // 偏移映射：纯文本里的每一段文字都必须指回原文里的同一段文字
  for (const probe of ['加粗', '链接文字', '引用行', '尾段']) {
    const p = plain.indexOf(probe)
    assert.ok(p >= 0, `plain 应含 ${probe}`)
    const s = srcIndex[p]
    assert.equal(
      src.slice(s, s + probe.length),
      probe,
      `「${probe}」的偏移映射错位：plain[${p}] → src[${s}]`,
    )
  }

  // srcIndex 严格递增（二分/夹取都依赖它）
  for (let i = 1; i < srcIndex.length; i += 1) {
    assert.ok(srcIndex[i] > srcIndex[i - 1], `srcIndex 必须严格递增（i=${i}）`)
  }
})

test('plainRangeToSrc：纯文本区间 → 源码区间（含越界夹取）', () => {
  const src = '## 标题\n\n正文一二三四五\n'
  const { plain, srcIndex } = stripMarkdown(src)
  const start = plain.indexOf('正文')
  const { charStart, charEnd } = plainRangeToSrc(
    { plain, srcIndex },
    start,
    start + '正文一二'.length,
  )
  assert.equal(src.slice(charStart, charEnd), '正文一二')

  // 越界：不应抛错，夹在合法区间内
  const clamped = plainRangeToSrc({ plain, srcIndex }, -5, 99999)
  assert.equal(clamped.charStart, srcIndex[0])
  assert.equal(clamped.charEnd, srcIndex[srcIndex.length - 1] + 1)
})

test('normalizeResult：segment_labels.position 回映射到正文偏移 + 计算占比', () => {
  const src = '## 标题\n\n第一段正文内容。\n\n第二段正文内容。\n'
  const strip = stripMarkdown(src)
  const p1 = strip.plain.indexOf('第一段正文内容。')
  const p2 = strip.plain.indexOf('第二段正文内容。')

  const r = normalizeResult(
    {
      softmax_confidence: 0.91,
      ratio_confidence: 0.5,
      labels_ratio: { 0: 0.5, 1: 0.5, 2: 0 },
      segment_labels: [
        { text: '第一段正文内容。', label: 0, conf: 0.1, order: 1, position: [p1, p1 + 8] },
        { text: '第二段正文内容。', label: 1, conf: 0.97, order: 2, position: [p2, p2 + 8] },
      ],
      usage: { total_tokens: 500 },
    },
    strip,
    CFG,
  )

  const seg2 = r.segments.find((s) => s.order === 2)
  assert.equal(src.slice(seg2.charStart, seg2.charEnd), '第二段正文内容。')
  assert.equal(seg2.labelName, 'ai')
  assert.ok(seg2.charRatio > 0 && seg2.charRatio < 1)
  assert.equal(r.usage.totalTokens, 500)
  assert.equal(r.labelsRatio.ai, 0.5)
})

test('normalizeResult：字段缺失/异名不炸（防御式读取）', () => {
  const strip = stripMarkdown(longText())
  // 只有 confidence（没有 softmax_confidence）、没有 segment_labels、没有 labels_ratio
  const r = normalizeResult({ confidence: 0.4 }, strip, CFG)
  assert.equal(r.confidence, 0.4)
  assert.deepEqual(r.segments, [])
  assert.equal(r.labelsRatio.ai, null)
  assert.equal(r.usage.totalTokens, null)
})

/* ────────────────── ② 三态判定：一切失败都必须 skip ────────────────── */

test('detectText：未启用 / 无 key / 文本过短 / 预算耗尽 一律 skip，且不发起请求', async () => {
  freshLocalRoot()
  await withFetch(
    () => {
      throw new Error('不该发起请求')
    },
    async (calls) => {
      const disabled = await detectText(longText(), {
        config: { ...CFG, enabled: false },
        apiKey: 'k',
      })
      assert.equal(disabled.verdict, 'skip')
      assert.equal(disabled.reason, 'disabled')

      const tooShort = await detectText('太短了', { config: CFG, apiKey: 'k' })
      assert.equal(tooShort.verdict, 'skip')
      assert.equal(tooShort.reason, 'text-too-short')
      assert.equal(tooShort.minChars, 350)

      // 不给 apiKey 时走"凭证缺失"，必须 skip 而不是抛错（fail-open，但显式标注）
      const noKey = await detectText(longText(), { config: CFG, apiKey: '' })
      assert.equal(noKey.verdict, 'skip')
      assert.equal(noKey.reason, 'no-api-key')

      // 先把台账烧到超预算，再检测：应直接 skip，一次请求都不发
      addUsage(999999)
      const exhausted = await detectText(longText(), {
        config: { ...CFG, monthlyTokenBudget: 1 },
        apiKey: 'k',
      })
      assert.equal(exhausted.verdict, 'skip')
      assert.equal(exhausted.reason, 'budget-exhausted')

      assert.equal(calls.length, 0, '以上情况都不应发起网络请求')
    },
  )
})

test('detectText：成功响应 → 归一化 + 判定（低于阈值 pass）', async () => {
  freshLocalRoot()
  await withFetch(
    () => jsonResponse(successBody()),
    async (calls) => {
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: 'k',
        gateway: 'https://gw.test',
      })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://gw.test/v1/providers/zhuque-text/classify')
      assert.equal(calls[0].opts.headers.Authorization, 'Bearer k')
      assert.equal(JSON.parse(calls[0].opts.body).is_merge, false, '必须要求分段结果')
      assert.equal(judgeResult(r, CFG).verdict, 'pass')
    },
  )
})

test('detectText：高浓度 → judge fail（口径 confidence）', async () => {
  freshLocalRoot()
  await withFetch(
    () =>
      jsonResponse(
        successBody({ softmax_confidence: 0.88, labels_ratio: { 0: 0.1, 1: 0.9, 2: 0 } }),
      ),
    async () => {
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: 'k',
        gateway: 'https://gw.test',
      })
      const judged = judgeResult(r, CFG)
      assert.equal(judged.verdict, 'fail')
      assert.equal(judged.metric, 'confidence')
      assert.equal(judged.threshold, 0.3)
    },
  )
})

test('judgeResult：三种口径各按其字段判定（both = 两者都要低于阈值）', async () => {
  freshLocalRoot()
  await withFetch(
    () =>
      jsonResponse(
        successBody({ softmax_confidence: 0.1, labels_ratio: { 0: 0.5, 1: 0.6, 2: 0 } }),
      ),
    async () => {
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: 'k',
        gateway: 'https://gw.test',
      })

      const byConfidence = judgeResult(r, {
        ...CFG,
        gate: { metric: 'confidence', threshold: 0.3 },
      })
      assert.equal(byConfidence.verdict, 'pass')

      const byLabels = judgeResult(r, { ...CFG, gate: { metric: 'labels_ai', threshold: 0.3 } })
      assert.equal(byLabels.verdict, 'fail')
      assert.equal(byLabels.value, 0.6)

      // both 取两者最大值比阈值：0.6 > 0.3 → fail
      const byBoth = judgeResult(r, { ...CFG, gate: { metric: 'both', threshold: 0.3 } })
      assert.equal(byBoth.verdict, 'fail')
      assert.equal(byBoth.value, 0.6)
    },
  )
})

test('detectText：鉴权失败(401) 不重试 → skip api-error/AUTH', async () => {
  freshLocalRoot()
  await withFetch(
    () => jsonResponse({ error: 'invalid key' }, 401),
    async (calls) => {
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: 'k',
        gateway: 'https://gw.test',
      })
      assert.equal(r.verdict, 'skip')
      assert.equal(r.reason, 'api-error')
      assert.equal(r.errorCode, 'AUTH')
      assert.equal(calls.length, 1, '401 重试没有意义，只应请求一次')
    },
  )
})

test('detectText：限流(429) 不重试（重试只会把风控烧得更狠）', async () => {
  freshLocalRoot()
  await withFetch(
    () => jsonResponse({ msg: 'rate limited' }, 429),
    async (calls) => {
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: 'k',
        gateway: 'https://gw.test',
      })
      assert.equal(r.reason, 'api-error')
      assert.equal(r.errorCode, 'RATE')
      assert.equal(calls.length, 1)
    },
  )
})

test('detectText：服务端 5xx 重试一次后仍未好 → skip api-error/SERVER', async () => {
  freshLocalRoot()
  await withFetch(
    () => jsonResponse({ msg: 'boom' }, 503),
    async (calls) => {
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: 'k',
        gateway: 'https://gw.test',
      })
      assert.equal(r.reason, 'api-error')
      assert.equal(r.errorCode, 'SERVER')
      assert.equal(calls.length, 2, '5xx 应重试一次（attempts=2）')
    },
  )
})

test('detectText：网络超时 → skip timeout（不抛）', async () => {
  freshLocalRoot()
  await withFetch(
    () => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    },
    async () => {
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: 'k',
        gateway: 'https://gw.test',
      })
      assert.equal(r.verdict, 'skip')
      assert.equal(r.reason, 'timeout')
    },
  )
})

test('detectText：HTTP 200 但 body 说失败 → skip api-error/PROVIDER', async () => {
  freshLocalRoot()
  await withFetch(
    () => jsonResponse({ status: 'failed', msg: 'text too long' }),
    async () => {
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: 'k',
        gateway: 'https://gw.test',
      })
      assert.equal(r.verdict, 'skip')
      assert.equal(r.errorCode, 'PROVIDER')
    },
  )
})

test('detectText：响应不是合法 JSON → skip bad-json', async () => {
  freshLocalRoot()
  await withFetch(
    () => ({
      ok: true,
      status: 200,
      async json() {
        throw new Error('Unexpected token')
      },
      async text() {
        return '<html>'
      },
    }),
    async () => {
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: 'k',
        gateway: 'https://gw.test',
      })
      assert.equal(r.verdict, 'skip')
      assert.equal(r.reason, 'bad-json')
    },
  )
})

/* ────────────────── ③ 改写目标挑选 ────────────────── */

test('pickRewriteTargets：只挑明确判 AI 的段、按置信度降序、受上限约束', () => {
  const result = {
    segments: [
      { order: 1, label: 0, conf: 0.9 },
      { order: 2, label: 1, conf: 0.6 },
      { order: 3, label: 1, conf: 0.99 },
      { order: 4, label: 2, conf: 0.8 },
      { order: 5, label: 1, conf: 0.2 },
    ],
  }
  const cfg = { ...CFG, rewrite: { ...CFG.rewrite, maxSegmentsPerRound: 2, minSegmentConf: 0.5 } }
  const picked = pickRewriteTargets(result, cfg)
  assert.deepEqual(
    picked.map((s) => s.order),
    [3, 2],
  )

  // includeSuspected=true 时才把"疑似"算进来
  const withSuspected = pickRewriteTargets(result, {
    ...cfg,
    rewrite: { ...cfg.rewrite, includeSuspected: true, maxSegmentsPerRound: 5 },
  })
  assert.ok(withSuspected.some((s) => s.order === 4))
})

/* ────────────────── ④ 栏目白名单（额度收口） ────────────────── */

test('runAiDetect：--slots 白名单之外的栏目直接 skip，且不调接口', async () => {
  freshLocalRoot()
  // 造一个"像草稿"的文件名（引擎按文件名解析栏目）——放临时目录，不碰真草稿
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-drafts-'))
  const file = path.join(dir, '2026-01-01-tips-some-topic.md')
  fs.writeFileSync(file, longText(), 'utf8')

  await withFetch(
    () => {
      throw new Error('栏目被白名单挡下时不该发起请求')
    },
    async (calls) => {
      const { runAiDetect } = await import('../src/commands/ai-detect-cli.mjs')
      const r = await runAiDetect([`--file=${file}`, '--slots=noon,evening', '--min-chars=1'])
      assert.equal(r.verdict, 'skip')
      assert.equal(r.reason, 'slot-not-enabled')
      assert.equal(r.slot, 'tips')
      assert.equal(calls.length, 0, '被白名单挡下必须是零请求零消耗')
    },
  )
})

/* ────────────────── ⑤ 用量台账 ────────────────── */

test('用量台账：按月累计、跨月归零、超预算即 exhausted', () => {
  freshLocalRoot()
  const now = new Date('2026-10-05T00:00:00Z')
  assert.equal(readUsage(now).tokens, 0)

  addUsage(1000, now)
  addUsage(500, now)
  const u = readUsage(now)
  assert.equal(u.tokens, 1500)
  assert.equal(u.calls, 2)

  const ok = budgetState({ monthlyTokenBudget: 2000 }, now)
  assert.equal(ok.exhausted, false)
  assert.equal(ok.remaining, 500)

  const over = budgetState({ monthlyTokenBudget: 1000 }, now)
  assert.equal(over.exhausted, true)
  assert.equal(over.remaining, 0)

  // 下个月：账目重新从零起算（不把上个月的用量算进新周期）
  const nextMonth = new Date('2026-11-01T00:00:00Z')
  assert.equal(readUsage(nextMonth).tokens, 0)
})

/* ────────────────── ⑥ 三分布口径（人工 50% / AI 30% / 疑似 20%） ────────────────── */

/** 分布口径配置（与 config.json 默认一致，测试里显式写死以免被默认值变更带偏） */
const DIST_CFG = {
  ...AI_DETECT_DEFAULTS,
  gate: { mode: 'distribution', humanMin: 0.5, aiMax: 0.3, uncertainMax: 0.2, enforce: 'observe' },
  rewrite: { ...AI_DETECT_DEFAULTS.rewrite },
}

/** 造一个已归一化的结果（只带判定需要的字段） */
function distResult(human, ai, uncertain) {
  return {
    ok: true,
    verdict: 'unknown',
    metric: 'distribution',
    labelsRatio: { human, ai, uncertain },
    segments: [],
    chars: 1000,
  }
}

test('分布口径：三项全达标 → pass（50/30/20 正好是边界）', () => {
  const r = judgeResult(distResult(0.5, 0.3, 0.2), DIST_CFG)
  assert.equal(r.verdict, 'pass')
  assert.deepEqual(r.fails, [])
  assert.equal(r.metric, 'distribution')
})

test('分布口径：人工不足 → fail（且必然连带 AI 或疑似超限）', () => {
  // 三项之和恒为 1：人工 <50% ⇒ AI+疑似 >50%；又因疑似 ≤20%，故 AI 必然 >30%。
  // 也就是说「只有人工不达标」在算术上不存在——这条不变量本身就是门禁设计的一部分。
  const r = judgeResult(distResult(0.45, 0.35, 0.2), DIST_CFG)
  assert.equal(r.verdict, 'fail')
  assert.deepEqual(r.fails, ['human', 'ai'])
})

test('分布口径不变量：人工不达标时，ai 与 uncertain 至少有一项也不达标', () => {
  for (let h = 0; h <= 0.5; h += 0.05) {
    for (let u = 0; u <= 0.2; u += 0.05) {
      const a = Number((1 - h - u).toFixed(4))
      if (a < 0) continue
      const r = judgeResult(distResult(Number(h.toFixed(2)), a, Number(u.toFixed(2))), DIST_CFG)
      if (r.fails.includes('human')) {
        assert.ok(
          r.fails.includes('ai') || r.fails.includes('uncertain'),
          `h=${h} a=${a} u=${u} 时不该出现"只有人工不达标"`,
        )
      }
    }
  }
})

test('分布口径：AI 特征超限 → fail（即使人工达标）', () => {
  const r = judgeResult(distResult(0.6, 0.35, 0.05), DIST_CFG)
  assert.equal(r.verdict, 'fail')
  assert.deepEqual(r.fails, ['ai'])
})

test('分布口径：疑似超限 → fail（即便只把内容赶进疑似也过不了）', () => {
  const r = judgeResult(distResult(0.55, 0.25, 0.2 + 0.001), DIST_CFG)
  assert.equal(r.verdict, 'fail')
  assert.deepEqual(r.fails, ['uncertain'])
})

test('分布口径：多项失败时 fails 全部列出（改写方向才明确）', () => {
  const r = judgeResult(distResult(0.1, 0.35, 0.55), DIST_CFG)
  assert.equal(r.verdict, 'fail')
  assert.deepEqual(r.fails, ['human', 'ai', 'uncertain'])
})

test('分布口径：任一项缺失 → skip（不当成通过）', () => {
  const r = judgeResult(distResult(0.6, null, 0.2), DIST_CFG)
  assert.equal(r.verdict, 'skip')
  assert.equal(r.reason, 'metric-unavailable')
})

test('分布口径：日志与快照都带三占比与失败项', () => {
  const r = judgeResult(distResult(0, 0.2594, 0.7406), DIST_CFG)
  const line = formatVerdictLine(r)
  assert.match(line, /人工=0\.0%/)
  assert.match(line, /AI特征=25\.9%/)
  assert.match(line, /疑似=74\.1%/)
  assert.match(line, /失败项=human\|uncertain/)

  const snap = formatSnapshot(r)
  assert.match(snap, /口径=distribution/)
  assert.match(snap, /失败项=human\|uncertain/)
})

test('旧口径（metric 模式）行为不变，避免老配置静默改语义', () => {
  const legacy = {
    ...AI_DETECT_DEFAULTS,
    gate: { metric: 'labels_ai', threshold: 0.3 },
    rewrite: { ...AI_DETECT_DEFAULTS.rewrite },
  }
  const r = judgeResult(distResult(0.2, 0.31, 0.49), legacy)
  assert.equal(r.verdict, 'fail') // 只看 ai
  assert.equal(r.metric, 'labels_ai')
  assert.equal(r.fails, undefined, '旧口径不应产生 fails 字段')
})

test('includeSuspected 默认 true：分布口径下必须能改"疑似"段', () => {
  assert.equal(AI_DETECT_DEFAULTS.rewrite.includeSuspected, true)
  const picked = pickRewriteTargets(
    {
      segments: [
        { order: 1, label: 2, conf: 0.9 },
        { order: 2, label: 2, conf: 0.4 },
        { order: 3, label: 0, conf: 0.99 },
      ],
    },
    { ...DIST_CFG, rewrite: { ...DIST_CFG.rewrite, minSegmentConf: 0.5 } },
  )
  assert.deepEqual(
    picked.map((s) => s.order),
    [1],
    '疑似段默认纳入；人工段不纳入',
  )
})

test('改写目标排序：判 AI 的段排在疑似之前（危害大的先改）', () => {
  const picked = pickRewriteTargets(
    {
      segments: [
        { order: 1, label: 2, conf: 0.99 },
        { order: 2, label: 1, conf: 0.2 },
        { order: 3, label: 2, conf: 0.3 },
      ],
    },
    { ...DIST_CFG, rewrite: { ...DIST_CFG.rewrite, minSegmentConf: 0, maxSegmentsPerRound: 5 } },
  )
  assert.deepEqual(
    picked.map((s) => s.order),
    [2, 1, 3],
  )
})

/* ────────────────── ⑦ enforce=observe/block 的动作分派 ────────────────── */

test('runAiDetect：enforce 决定 action（observe 不重写，block 才进改写循环）', async () => {
  freshLocalRoot()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-drafts-'))
  const file = path.join(dir, '2026-01-01-noon-some-topic.md')
  fs.writeFileSync(file, longText(), 'utf8')
  const { runAiDetect } = await import('../src/commands/ai-detect-cli.mjs')

  // 人工 0% / AI 26% / 疑似 74% → 分布口径下 fail（人工、疑似两项不达标）
  // 分段里同时给"判 AI"与"疑似"，验证改写目标把判 AI 的排在前面
  await withFetch(
    () =>
      jsonResponse(
        successBody({
          softmax_confidence: 0.99,
          labels_ratio: { 0: 0, 1: 0.2594, 2: 0.7406 },
          segment_labels: [
            { text: '疑似段', label: 2, conf: 0.8, order: 2, position: [0, 10] },
            { text: '判AI段', label: 1, conf: 0.9, order: 1, position: [10, 20] },
          ],
        }),
      ),
    async () => {
      // 显式钉住口径：本用例验证的是 distribution 模式的动作分派，
      // 不该被 config.json 的默认口径改动带偏
      const observed = await runAiDetect([
        `--file=${file}`,
        '--min-chars=1',
        '--enforce=observe',
        '--mode=distribution',
      ])
      assert.equal(observed.verdict, 'fail')
      assert.equal(observed.action, 'observe', 'observe 模式必须明确告知调用方不要重写')
      assert.deepEqual(observed.fails, ['human', 'uncertain'])
      assert.deepEqual(observed.rewriteTargets, [1, 2], '仍要给改写方向，且判 AI 的段排在疑似之前')

      const blocked = await runAiDetect([
        `--file=${file}`,
        '--min-chars=1',
        '--enforce=block',
        '--mode=distribution',
      ])
      assert.equal(blocked.action, 'block')
    },
  )
})

/* ────────────────── ⑧ 区间口径（bands）────────────────── */

const BANDS_CFG = {
  ...AI_DETECT_DEFAULTS,
  gate: {
    mode: 'bands',
    humanMin: 0.3,
    humanMax: 0.5,
    aiMin: 0.3,
    aiMax: 0.5,
    uncertainMin: 0.3,
    uncertainMax: 0.5,
    enforce: 'observe',
  },
  rewrite: { ...AI_DETECT_DEFAULTS.rewrite },
}

const bandResult = (human, ai, uncertain) => ({
  ok: true,
  verdict: 'unknown',
  labelsRatio: { human, ai, uncertain },
  segments: [],
  chars: 1000,
})

test('区间口径：三段都落在 30%-50% → pass', () => {
  const r = judgeResult(bandResult(0.34, 0.33, 0.33), BANDS_CFG)
  assert.equal(r.verdict, 'pass')
  assert.deepEqual(r.fails, [])
  assert.equal(r.metric, 'bands')
})

test('区间口径：失败项带方向（below / above）', () => {
  // 本次验证稿：人工 36.3%（在带内）、AI 0%（低于下界）、疑似 63.7%（高于上界）
  const r = judgeResult(bandResult(0.363, 0, 0.637), BANDS_CFG)
  assert.equal(r.verdict, 'fail')
  assert.deepEqual(r.fails, ['ai:below', 'uncertain:above'])
})

test('区间口径：过干净也会失败（AI 特征低于 30% 同样不达标）', () => {
  // 这是区间口径与上一轮"越干净越好"最反直觉的差别：把 AI 特征压到 0% 反而不在带内
  const r = judgeResult(bandResult(0.6, 0, 0.4), BANDS_CFG)
  assert.equal(r.verdict, 'fail')
  assert.ok(r.fails.includes('ai:below'))
})

test('区间口径：三者和为 1，故"每段都 ≥30%"实际把每段锁进 30%-40%', () => {
  // 边界：给出一个三项都恰好 1/3 的分布必然通过；任一段 >50% 必然有另一段 <30%
  const r = judgeResult(bandResult(1 / 3, 1 / 3, 1 / 3), BANDS_CFG)
  assert.equal(r.verdict, 'pass')
  const skewed = judgeResult(bandResult(0.5, 0.5, 0), BANDS_CFG)
  assert.equal(skewed.verdict, 'fail')
  assert.ok(skewed.fails.includes('uncertain:below'))
})

test('区间口径：日志与快照带上界下界', () => {
  const r = judgeResult(bandResult(0.34, 0.33, 0.33), BANDS_CFG)
  const line = formatVerdictLine(r)
  assert.match(line, /口径=bands/)
  assert.match(line, /人工=34\.0%\[30\.0%~50\.0%\]/)
  assert.match(formatSnapshot(r), /口径=bands/)
})

/* ────────────────── ⑨ 省配额：确定性抽样 + 内容缓存 ────────────────── */

test('抽样：按正文哈希确定性决定，且同一正文每次判定一致', () => {
  const cfg = { ...AI_DETECT_DEFAULTS, sampleRate: 0.5 }
  const a = shouldSample('同一段正文', cfg)
  assert.equal(shouldSample('同一段正文', cfg), a, '同正文必须每次一致（否则排查变玄学）')
  assert.equal(shouldSample('任意正文', { ...cfg, sampleRate: 1 }), true, 'rate=1 全检')
  assert.equal(shouldSample('任意正文', { ...cfg, sampleRate: 0 }), false, 'rate=0 全不检')
  // 抽样样本量足够时，命中率应接近设定值（允许较宽的容差）
  let hit = 0
  for (let i = 0; i < 2000; i += 1) if (shouldSample(`正文-${i}`, cfg)) hit += 1
  assert.ok(hit > 800 && hit < 1200, `2000 条里应约 1000 条命中，实际 ${hit}`)
})

test('抽样：被抽掉的返回 skip/sampled-out，不发起请求且不计配额', async () => {
  freshLocalRoot()
  await withFetch(
    () => {
      throw new Error('被抽样挡下时不该发起请求')
    },
    async (calls) => {
      const r = await detectText(longText(), {
        config: { ...CFG, sampleRate: 0 },
        apiKey: 'k',
        gateway: 'https://gw.test',
      })
      assert.equal(r.verdict, 'skip')
      assert.equal(r.reason, 'sampled-out')
      assert.equal(calls.length, 0)
    },
  )
})

test('内容缓存：同一篇正文第二次检测不发请求、不重复计费', async () => {
  freshLocalRoot()
  await withFetch(
    () => jsonResponse(successBody()),
    async (calls) => {
      const opts = { config: CFG, apiKey: 'k', gateway: 'https://gw.test' }
      const first = await detectText(longText(), opts)
      assert.equal(first.cached, undefined, '首次不应带 cached 标记')
      assert.equal(calls.length, 1)

      const second = await detectText(longText(), opts)
      assert.equal(second.cached, true, '第二次应命中缓存')
      assert.equal(calls.length, 1, '命中缓存不得再发请求')
      assert.equal(second.labelsRatio.ai, first.labelsRatio.ai, '缓存结果应与首次一致')

      // 正文改一个字 → 必须重新检测（缓存键含正文哈希）
      const third = await detectText(`${longText()}多一个字。`, opts)
      assert.equal(third.cached, undefined)
      assert.equal(calls.length, 2)
    },
  )
})

test('内容缓存：命中缓存时不需要凭证（省的不只是 token）', async () => {
  freshLocalRoot()
  await withFetch(
    () => jsonResponse(successBody({ labels_ratio: { 0: 0.34, 1: 0.33, 2: 0.33 } })),
    async () => {
      await detectText(longText(), { config: CFG, apiKey: 'k', gateway: 'https://gw.test' })
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: '',
        gateway: 'https://gw.test',
      })
      assert.equal(r.cached, true, '缓存命中应优先于"无凭证"判定')
      assert.equal(r.verdict, 'unknown')
    },
  )
})

/* ────────────────── ⑩ 精确区间口径（人工30-50 / AI30-<50 / 疑似20-40）────────────────── */

const EXACT_CFG = {
  ...AI_DETECT_DEFAULTS,
  gate: {
    mode: 'bands',
    humanMin: 0.3,
    humanMax: 0.5,
    aiMin: 0.3,
    aiMax: 0.5,
    uncertainMin: 0.2,
    uncertainMax: 0.4,
    exclusive: ['ai:max'],
    enforce: 'observe',
  },
  rewrite: { ...AI_DETECT_DEFAULTS.rewrite },
}

test('精确区间：三项各在区间内且和为 100% → pass', () => {
  for (const [h, a, u] of [
    [0.36, 0.35, 0.29],
    [0.3, 0.3, 0.4],
    [0.5, 0.3, 0.2],
    [0.4, 0.35, 0.25],
  ]) {
    const r = judgeResult(bandResult(h, a, u), EXACT_CFG)
    assert.equal(r.verdict, 'pass', `${h}/${a}/${u} 应达标，实际 ${JSON.stringify(r.fails)}`)
  }
})

test('精确区间：AI 特征上界是**开区间**——恰好 50% 判不达标', () => {
  const r = judgeResult(bandResult(0.3, 0.5, 0.2), EXACT_CFG)
  assert.equal(r.verdict, 'fail')
  assert.deepEqual(r.fails, ['ai:above'])

  // 49.9% 仍在区间内
  const ok = judgeResult(bandResult(0.301, 0.499, 0.2), EXACT_CFG)
  assert.equal(ok.verdict, 'pass')
})

test('精确区间：其他两条边界是闭区间（恰好取到端点仍然达标）', () => {
  assert.equal(judgeResult(bandResult(0.3, 0.3, 0.4), EXACT_CFG).verdict, 'pass', '人工 30% 闭')
  assert.equal(judgeResult(bandResult(0.5, 0.3, 0.2), EXACT_CFG).verdict, 'pass', '人工 50% 闭')
  assert.equal(judgeResult(bandResult(0.5, 0.3, 0.2), EXACT_CFG).verdict, 'pass', '疑似 20% 闭')
})

test('精确区间：等价约束 人工+疑似 ∈ (50%,70%]（推导自 AI 必须落在 [30,50)）', () => {
  // 人工+疑似 = 50 ⇒ AI = 50 ⇒ 被开区间拒
  assert.equal(judgeResult(bandResult(0.3, 0.5, 0.2), EXACT_CFG).verdict, 'fail')
  // 人工+疑似 = 70 ⇒ AI = 30 ⇒ 达标
  assert.equal(judgeResult(bandResult(0.4, 0.3, 0.3), EXACT_CFG).verdict, 'pass')
  // 人工+疑似 < 50 ⇒ AI > 50 ⇒ 超上界
  const over = judgeResult(bandResult(0.3, 0.6, 0.1), EXACT_CFG)
  assert.ok(over.fails.includes('ai:above'))
})

test('精确区间：验证稿 36.3/0/63.7 的两项失败方向正确', () => {
  const r = judgeResult(bandResult(0.363, 0, 0.637), EXACT_CFG)
  assert.deepEqual(r.fails, ['ai:below', 'uncertain:above'])
})

test('精确区间：日志标出开区间，便于事后复核判定依据', () => {
  const line = formatVerdictLine(judgeResult(bandResult(0.36, 0.35, 0.29), EXACT_CFG))
  assert.match(line, /口径=bands/)
  assert.match(line, /人工=36\.0%\[30\.0%~50\.0%\]/)
  assert.match(line, /AI特征=35\.0%\[30\.0%~50\.0%\]/)
  assert.match(line, /疑似=29\.0%\[20\.0%~40\.0%\]/)
  assert.match(line, /开区间=ai:max/)
})
