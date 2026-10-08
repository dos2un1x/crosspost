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
  UNASSIGNED_KEY,
  addUsage,
  budgetState,
  clampAnchorDay,
  clearExhaustedKeys,
  detectText,
  formatSnapshot,
  keyId,
  markKeyExhausted,
  parseKeyList,
  poolBreakdown,
  shouldSample,
  formatVerdictLine,
  judgeResult,
  measureStyle,
  normalizeResult,
  pickRewriteTargets,
  plainRangeToSrc,
  quotaPeriod,
  readAiDetectConfig,
  readUsage,
  segmentAllowance,
  segmentPlan,
  stripMarkdown,
  usagePath,
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
const testEnvKeys = [
  'ZHUQUE_API_KEY',
  'ZHUQUE_API_KEYS',
  'EDGEONE_AI_GATEWAY_BASE',
  'CROSSPOST_CONFIG',
]
const prevEnv = Object.fromEntries(testEnvKeys.map((k) => [k, process.env[k]]))
process.on('exit', () => {
  for (const k of testEnvKeys) {
    if (prevEnv[k] === undefined) delete process.env[k]
    else process.env[k] = prevEnv[k]
  }
})
process.env.ZHUQUE_API_KEY = TEST_API_KEY
process.env.EDGEONE_AI_GATEWAY_BASE = TEST_GATEWAY
// 多 key 的用例一律**显式传参**（`apiKey: 'a,b'`），所以这里把追加列表清掉：
// 否则开发机 env 里真填了 ZHUQUE_API_KEYS 时，入口级用例会连上真实的多把 key。
delete process.env.ZHUQUE_API_KEYS

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

test('pickRewriteTargets：长度 = "需清几段"（自动算，不再是固定上限），判 AI 优先、置信度升序', () => {
  // 5 段里 3 段判 AI → threshold 0.3 时允许 ceil(1.5)−1 = 1 段 → 只需清 2 段
  const result = {
    verdict: 'fail',
    value: 0.6,
    threshold: 0.3,
    segments: [
      { order: 1, label: 0, conf: 0.9 },
      { order: 2, label: 1, conf: 0.6 },
      { order: 3, label: 1, conf: 0.99 },
      { order: 4, label: 2, conf: 0.8 },
      { order: 5, label: 1, conf: 0.2 },
    ],
  }
  const cfg = {
    ...CFG,
    gate: { metric: 'labels_ai', threshold: 0.3, enforce: 'block' },
    rewrite: { ...CFG.rewrite, maxSegmentsPerRound: 5, minSegmentConf: 0.5 },
  }
  const picked = pickRewriteTargets(result, cfg)
  assert.deepEqual(
    picked.map((s) => s.order),
    [2, 3],
    '清单长度由需清段数决定：置信度低的判 AI 段先改（最可能被推过线的那段）',
  )

  // 单指标（labels_ai）口径只看 label=1 的比例，所以**疑似段不占名额**：
  // 清单长度由"需清几段"决定（这里是 2），不是由候选池有多大决定
  const withSuspected = pickRewriteTargets(result, {
    ...cfg,
    rewrite: { ...cfg.rewrite, includeSuspected: true, minSegmentConf: 0 },
  })
  assert.deepEqual(
    withSuspected.map((s) => s.order),
    [5, 2],
    '候选池里判 AI 的段有 3 个，但只需清 2 段 → 清单就是 2 段（不多改）',
  )
  assert.ok(!withSuspected.some((s) => s.order === 4), '疑似段（order 4）在单指标口径下不进清单')
  // 置信度门槛把判 AI 的候选也筛掉时，缺口用疑似段补 —— 宁可多给一段，也不让这一轮注定清不干净
  const topped = pickRewriteTargets(result, {
    ...cfg,
    rewrite: { ...cfg.rewrite, minSegmentConf: 0.7 },
  })
  assert.deepEqual(
    topped.map((s) => s.order),
    [3, 4],
    '判 AI 的候选只剩 1 段（需 2 段）→ 缺口由疑似段补上',
  )

  // pass：没有任何"必需项" → 空清单（要观察看 segments[]，不再是"给几个目标看看"）
  assert.deepEqual(
    pickRewriteTargets({ ...result, verdict: 'pass', value: 0.2 }, cfg).map((s) => s.order),
    [],
  )
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

/* ────────────── ⑤-b 计费周期锚点（对齐朱雀"按开通日刷新"的额度周期） ────────────── */

test('周期锚点：跨锚点即新周期（上期用量不带入），锚点=1 仍是自然月键', () => {
  freshLocalRoot()
  const before = new Date(2026, 9, 19, 12)
  const after = new Date(2026, 9, 20, 12)

  assert.equal(readUsage(before, 20).tokens, 0)
  addUsage(100, before, 20)
  assert.equal(readUsage(before, 20).tokens, 100)
  assert.equal(readUsage(before, 20).periodStart, '2026-09-20')

  // 跨过锚点：新周期从 0 起算，上一期的 100 不带入
  addUsage(200, after, 20)
  assert.equal(readUsage(after, 20).tokens, 200)
  assert.equal(readUsage(after, 20).calls, 1)
  assert.equal(readUsage(after, 20).periodStart, '2026-10-20')

  // 同一个台账文件按默认锚点（1 = 自然月）读是另一个周期 → 不会被 20 号那本账污染
  assert.equal(readUsage(after, 1).periodStart, '2026-10')
  assert.equal(readUsage(after, 1).tokens, 0)
})

test('周期锚点：锚点日大于当月天数时夹到当月最后一天', () => {
  // 锚点 31：2 月只有 28 天 → 2 月周期从 28 日起算；2 月 27 日仍属 1 月 31 日那个周期
  assert.equal(quotaPeriod(new Date(2026, 1, 28, 12), 31).key, '2026-02-28')
  assert.equal(quotaPeriod(new Date(2026, 1, 27, 12), 31).key, '2026-01-31')
  // 闰年 2 月 29 日
  assert.equal(quotaPeriod(new Date(2028, 1, 29, 12), 31).key, '2028-02-29')
})

test('周期锚点：旧台账（只有 month）在锚点=1 时直接认账，不需要迁移', () => {
  freshLocalRoot()
  fs.writeFileSync(
    usagePath(),
    JSON.stringify({ month: '2026-10', tokens: 1234, calls: 3 }),
    'utf8',
  )
  const u = readUsage(new Date(2026, 9, 5, 12), 1)
  assert.equal(u.tokens, 1234)
  assert.equal(u.calls, 3)
  assert.equal(u.periodStart, '2026-10')
  // 换成锚点 20 就是另一个周期：旧的自然月账不该被当成本周期用量
  // （周期语义不同，混用会让硬闸判断失真；换锚点等于重新起算，以控制台为准对账）
  assert.equal(readUsage(new Date(2026, 9, 25, 12), 20).tokens, 0)
})

test('周期锚点：越界/非数字一律回落到自然月', () => {
  assert.equal(clampAnchorDay(0), 1)
  assert.equal(clampAnchorDay(32), 1)
  assert.equal(clampAnchorDay('x'), 1)
  assert.equal(clampAnchorDay(15), 15)
  const b = budgetState({ monthlyTokenBudget: 1000, quotaAnchorDay: 99 }, new Date(2026, 9, 5, 12))
  assert.equal(b.periodAnchorDay, 1)
  assert.equal(b.periodStart, '2026-10')
})

/* ────────── ⑤-c 多把 key（额度叠加）：分桶台账 + 余额排序 + 失败自动切换 ────────── */

test('多 key：解析与指纹——逗号/空白/分号都能分隔、去重保序，指纹不含明文', () => {
  assert.deepEqual(parseKeyList('a,b c;;a\n d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(parseKeyList(''), [])
  assert.deepEqual(parseKeyList(undefined), [])
  assert.deepEqual(parseKeyList(['sk-1', 'sk-2']), ['sk-1', 'sk-2'], '数组写法也要认')
  const id = keyId('sk-secret-value')
  assert.equal(id.length, 12)
  assert.equal(keyId('sk-secret-value'), id, '同一把 key 的指纹必须稳定（否则分桶对不上）')
  assert.ok(!id.includes('secret'), '指纹里不能出现明文片段')
})

test('多 key：预算 = 每把 key 的额度 × key 数；顶层聚合与分桶明细都对得上', () => {
  freshLocalRoot()
  const now = new Date('2026-10-05T00:00:00Z')
  addUsage(1000, now, 1, 'key-a')
  addUsage(300, now, 1, 'key-b')

  // 单 key 口径不变
  const single = budgetState({ monthlyTokenBudget: 5000 }, now)
  assert.equal(single.budget, 5000)
  assert.equal(single.keyCount, 1)
  assert.equal(single.tokens, 1300, '顶层仍是全池聚合')
  assert.equal(single.keys, undefined, '不给 key 列表就不该有分桶')

  // 池口径：两把 key = 两份额度
  const pool = budgetState({ monthlyTokenBudget: 5000 }, now, ['key-a', 'key-b'])
  assert.equal(pool.perKeyBudget, 5000)
  assert.equal(pool.keyCount, 2)
  assert.equal(pool.budget, 10000, '总额度必须是 5000 × 2（否则多填一把 key 等于白填）')
  assert.equal(pool.tokens, 1300, '聚合用量不随 key 数放大')
  assert.equal(pool.remaining, 8700)
  assert.equal(pool.exhausted, false)
  assert.deepEqual(
    pool.keys.map((k) => [k.id, k.tokens, k.remaining, k.exhausted]),
    [
      [keyId('key-a'), 1000, 4000, false],
      [keyId('key-b'), 300, 4700, false],
    ],
  )
  // 单把读法（第三个参数给 key）
  assert.equal(readUsage(now, 1, 'key-a').tokens, 1000)
  assert.equal(readUsage(now, 1, 'key-b').tokens, 300)
})

test('多 key：台账里**只有指纹没有明文**（台账保护级别低于 .env）', () => {
  freshLocalRoot()
  const now = new Date('2026-10-05T00:00:00Z')
  addUsage(1000, now, 1, 'sk-plain-text-key-a')
  const raw = fs.readFileSync(usagePath(), 'utf8')
  assert.ok(!raw.includes('sk-plain-text-key-a'), `台账不得出现 key 明文：${raw}`)
  assert.ok(raw.includes(keyId('sk-plain-text-key-a')), '但要有指纹，否则分桶没法对账')
  assert.equal(JSON.parse(raw).tokens, 1000, '顶层聚合仍在（旧消费方读它）')
})

test('多 key：单把额度用完只该换下一把，不该整体停摆', () => {
  freshLocalRoot()
  const now = new Date('2026-10-05T00:00:00Z')
  addUsage(1000, now, 1, 'key-a') // a 已用满
  const pool = budgetState({ monthlyTokenBudget: 1000 }, now, ['key-a', 'key-b'])
  assert.equal(pool.keys[0].exhausted, true)
  assert.equal(pool.keys[1].exhausted, false)
  assert.equal(pool.exhausted, false, '还有余量就整体不算用尽')

  addUsage(1000, now, 1, 'key-b')
  const both = budgetState({ monthlyTokenBudget: 1000 }, now, ['key-a', 'key-b'])
  assert.equal(both.exhausted, true, '每把都被闸住才算池子用尽')
})

test('多 key：旧台账（无 key 归属）记到第一把头上——最保守的记法', () => {
  freshLocalRoot()
  // 单 key 时代写下的账：只有顶层，没有 keys
  fs.writeFileSync(
    usagePath(),
    JSON.stringify({ month: '2026-10', tokens: 1500, calls: 3 }),
    'utf8',
  )
  const now = new Date(2026, 9, 5, 12)
  const pool = budgetState({ monthlyTokenBudget: 1000 }, now, ['key-a', 'key-b'])
  assert.equal(pool.keys[0].tokens, 1500, '旧账记到第一把')
  assert.equal(pool.keys[0].calls, 3, 'calls 也跟着转记，否则逐把与聚合口径对不上')
  // 归属规则依赖书写顺序，所以必须显式给出"这一把里有多少是遗留归属"，
  // 否则看到"第一把凭空多了 15 万"会以为是漏账
  assert.equal(pool.keys[0].legacyTokens, 1500)
  assert.equal(pool.keys[1].legacyTokens, 0)
  assert.equal(pool.keys[0].exhausted, true, '宁可让第一把提前退出，也不让池子多算额度')
  assert.equal(pool.keys[1].tokens, 0, '第二把不该被旧账牵连')
  assert.equal(pool.exhausted, false, '第二把还有余量 → 池子还能用')
  assert.equal(pool.tokens, 1500, '聚合口径不变（旧消费方读到的还是 1500）')
  // unassigned 桶只被认一次，不会被两把 key 各扣一遍
  assert.equal(
    poolBreakdown({ monthlyTokenBudget: 1000 }, ['key-a', 'key-b'], now).keys[1].tokens,
    0,
  )
  assert.equal(UNASSIGNED_KEY, 'unassigned')
  // 归属跟着"第一把"走：换顺序就把这份遗留用量挪到另一把（池子总额不变）。
  // 钉住它是因为这行为确实是顺序相关的——不写下来，排查时会以为是漏账/串账。
  const swapped = budgetState({ monthlyTokenBudget: 1000 }, now, ['key-b', 'key-a'])
  assert.equal(swapped.keys[0].id, keyId('key-b'))
  assert.equal(swapped.keys[0].tokens, 1500, '遗留用量跟着第一把走')
  assert.equal(swapped.keys[1].tokens, 0)
  assert.equal(swapped.tokens, 1500, '池子聚合口径与顺序无关')
})

test('多 key：一把 401 → 自动换下一把成功，并把坏 key 标记为本周期失效', async () => {
  freshLocalRoot()
  await withFetch(
    (url, opts) =>
      opts.headers.Authorization === 'Bearer key-a'
        ? jsonResponse('invalid api key', 401)
        : jsonResponse(successBody()),
    async (calls) => {
      const cfg = { ...CFG, monthlyTokenBudget: 400000 }
      const r = await detectText(longText(), {
        config: cfg,
        apiKey: 'key-a,key-b',
        gateway: 'https://gw.test',
      })
      assert.notEqual(r.verdict, 'skip', `应该由第二把 key 接住：${JSON.stringify(r)}`)
      assert.equal(calls.length, 2, '401 不重试（fetchRetry 对 4xx 直接返回），只换 key')
      assert.equal(calls[0].opts.headers.Authorization, 'Bearer key-a')
      assert.equal(calls[1].opts.headers.Authorization, 'Bearer key-b')

      // 坏 key 被记下：本周期不再拿它撞墙
      const now = new Date()
      assert.ok(readUsage(now, 1, 'key-a').exhaustedAt, '被鉴权拒绝的 key 应标记本周期失效')
      assert.equal(readUsage(now, 1, 'key-b').exhaustedAt, null)

      // 下一篇（正文不同以免命中内容缓存）直接用好的那把：只有 1 次请求
      const r2 = await detectText(`${longText()}换一篇。`, {
        config: cfg,
        apiKey: 'key-a,key-b',
        gateway: 'https://gw.test',
      })
      assert.notEqual(r2.verdict, 'skip')
      assert.equal(calls.length, 3)
      assert.equal(calls[2].opts.headers.Authorization, 'Bearer key-b', '失效的 key 不该再被选中')

      // 误判时的手工出口
      const cleared = clearExhaustedKeys(now, 1)
      assert.equal(cleared, 1)
      assert.equal(readUsage(now, 1, 'key-a').exhaustedAt, null)
    },
  )
})

test('多 key：200 + "额度用尽"文案也换下一把；普通 PROVIDER 错误不换（省额度）', async () => {
  freshLocalRoot()
  // ① 配额类文案 → 换 key
  await withFetch(
    (url, opts) =>
      opts.headers.Authorization === 'Bearer key-a'
        ? jsonResponse({ status: 'error', msg: 'quota exceeded for this month' })
        : jsonResponse(successBody()),
    async (calls) => {
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: 'key-a,key-b',
        gateway: 'https://gw.test',
      })
      assert.notEqual(r.verdict, 'skip', JSON.stringify(r))
      assert.equal(calls.length, 2)
      assert.equal(calls[1].opts.headers.Authorization, 'Bearer key-b')
    },
  )

  // ② 与 key 无关的 PROVIDER 错误 → 直接返回，不白烧第二把的额度
  freshLocalRoot()
  await withFetch(
    () => jsonResponse({ status: 'error', msg: 'invalid request payload' }),
    async (calls) => {
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: 'key-a,key-b',
        gateway: 'https://gw.test',
      })
      assert.equal(r.verdict, 'skip')
      assert.equal(r.reason, 'api-error')
      assert.equal(r.errorCode, 'PROVIDER')
      assert.equal(calls.length, 1, '非 key 级错误换 key 没有意义，不许再发一次')
    },
  )
})

test('多 key：每把都没余量 → skip/budget-exhausted 且零请求；被标记失效的也一样', async () => {
  freshLocalRoot()
  const now = new Date()
  addUsage(1000, now, 1, 'key-a')
  addUsage(1000, now, 1, 'key-b')
  await withFetch(
    () => {
      throw new Error('两把 key 都没余量时不该发起请求')
    },
    async (calls) => {
      const r = await detectText(longText(), {
        config: { ...CFG, monthlyTokenBudget: 1000 },
        apiKey: 'key-a,key-b',
        gateway: 'https://gw.test',
      })
      assert.equal(r.verdict, 'skip')
      assert.equal(r.reason, 'budget-exhausted')
      assert.equal(calls.length, 0)

      // 第二把被标记失效 + 第一把没余量 → 同样零请求
      freshLocalRoot()
      addUsage(1000, new Date(), 1, 'key-a')
      markKeyExhausted('key-b', new Date(), 1)
      const r2 = await detectText(longText(), {
        config: { ...CFG, monthlyTokenBudget: 1000 },
        apiKey: 'key-a,key-b',
        gateway: 'https://gw.test',
      })
      assert.equal(r2.reason, 'budget-exhausted')
      assert.equal(calls.length, 0)
    },
  )
})

test('多 key：--no-budget-check 要放过被标记失效的 key（否则这个开关比不加还受限）', async () => {
  freshLocalRoot()
  const now = new Date()
  markKeyExhausted('key-a', now, 1)
  markKeyExhausted('key-b', now, 1)
  await withFetch(
    () => jsonResponse(successBody()),
    async (calls) => {
      // 不传开关：两把都被标记 → 零请求
      const blocked = await detectText(longText(), {
        config: CFG,
        apiKey: 'key-a,key-b',
        gateway: 'https://gw.test',
      })
      assert.equal(blocked.reason, 'budget-exhausted')
      assert.equal(calls.length, 0)

      // 传开关：放回候选，真的发一次（手工验证被误判的 key 靠它）
      const forced = await detectText(longText(), {
        config: CFG,
        apiKey: 'key-a,key-b',
        gateway: 'https://gw.test',
        skipBudgetCheck: true,
      })
      assert.notEqual(forced.verdict, 'skip', JSON.stringify(forced))
      assert.equal(calls.length, 1)
    },
  )
})

test('多 key：全部候选都失败 → 返回最后一次失败，并带 keysTried/keyCount 供事后判断', async () => {
  freshLocalRoot()
  await withFetch(
    () => jsonResponse('rate limited', 429),
    async (calls) => {
      const r = await detectText(longText(), {
        config: CFG,
        apiKey: 'key-a,key-b',
        gateway: 'https://gw.test',
      })
      assert.equal(r.verdict, 'skip')
      assert.equal(r.errorCode, 'RATE')
      assert.equal(calls.length, 2, '两把都试过')
      assert.equal(r.keysTried, 2)
      assert.equal(r.keyCount, 2)
      assert.equal(r.apiKeyId, keyId('key-b'), 'apiKeyId 是最后失败那把的指纹')
      // 两把都被标记失效 → 下一次连请求都不发
      const both = budgetState(CFG, new Date(), ['key-a', 'key-b'])
      assert.equal(both.exhausted, true)
    },
  )
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

test('容受口径：distribution 只设 AI 上界时，人工/疑似多低都不算失败', () => {
  // 只压上界是"越干净越好"的口径：人工 0%、疑似 70% 也不该产生失败项，
  // 否则写作者又会去找最廉价的方式把"人工特征"凑出来（实测代价是文章被拆成碎句）。
  const cfg = { ...AI_DETECT_DEFAULTS, gate: { mode: 'distribution', aiMax: 0.3 } }
  const ok = judgeResult(distResult(0, 0.2, 0.8), cfg)
  assert.equal(ok.verdict, 'pass', JSON.stringify(ok.fails))
  assert.deepEqual(ok.fails, [])
  const bad = judgeResult(distResult(0, 0.45, 0.55), cfg)
  assert.equal(bad.verdict, 'fail')
  assert.deepEqual(bad.fails, ['ai'])
})

test('容受口径：缺省边界在日志里打 n/a，不许印成 NaN%', () => {
  const cfg = { ...AI_DETECT_DEFAULTS, gate: { mode: 'distribution', aiMax: 0.3 } }
  const r = judgeResult(distResult(0.1, 0.2, 0.7), cfg)
  const line = formatVerdictLine(r)
  assert.match(line, /人工=10\.0%/)
  assert.match(line, /目标≥n\/a/)
  assert.ok(!/NaN/.test(line), line)
  const snap = formatSnapshot(r)
  assert.ok(!/NaN/.test(snap), snap)
})

test('默认口径是 metric + labels_ai<30%：只压上界，没有下界陷阱', () => {
  const cfg = AI_DETECT_DEFAULTS
  assert.equal(cfg.gate.mode, 'metric')
  assert.equal(cfg.gate.metric, 'labels_ai')
  assert.equal(cfg.gate.threshold, 0.3)
  // AI 特征 29% 达标、30% 不达标（边界是严格小于）；人工/疑似多少都不影响判定
  const pass = judgeResult(distResult(0.0, 0.29, 0.71), cfg)
  assert.equal(pass.verdict, 'pass', JSON.stringify(pass))
  const fail = judgeResult(distResult(0.0, 0.3, 0.7), cfg)
  assert.equal(fail.verdict, 'fail')
  assert.match(formatVerdictLine(fail), /口径=labels_ai 值=30\.0% 阈值=30\.0%/)
})

/* ────────────── ⑥ 风格护栏（碎了句子的文章不该比正常文章更容易过门禁） ────────────── */

const TELEGRAPH_TEXT = [
  '去年 329 美元。',
  '今年 3399。',
  '同一根条子。',
  '128GB 的那种。',
  '维修师傅接了个活。',
  '两条内存。',
  '一条 128GB。',
].join('\n')

const PROSE_TEXT = [
  '去年这根内存条卖 329 美元，今年同一规格的报价已经涨到 3399 美元，同一根条子涨了十倍。',
  '维修师傅接到的活儿也更难做了：两条从服务器上拆下来的 ECC 内存，一条 128GB、一条 256GB，报价合计一万六千美元。',
].join('\n')

/** 造一个只带判定所需字段的网侧响应（AI 特征 10% → 网侧口径本身是 pass） */
const netJson = () => ({
  softmax_confidence: 0.99,
  ratio_confidence: 0.1,
  labels_ratio: { 0: 0.5, 1: 0.1, 2: 0.4 },
  segment_labels: [],
  usage: {},
  makers_models_usage: {},
})

test('风格护栏：结构指标能区分电报体与正常散文', () => {
  const t = measureStyle(TELEGRAPH_TEXT)
  assert.equal(t.shortRatio, 1, JSON.stringify(t))
  assert.ok(t.maxConsecShort >= 7, JSON.stringify(t))
  assert.ok(
    t.fails.some((f) => f.startsWith('short-sent')) &&
      t.fails.some((f) => f.startsWith('short-run')),
    JSON.stringify(t.fails),
  )
  const p = measureStyle(PROSE_TEXT)
  assert.deepEqual(p.fails, [], JSON.stringify(p))
})

test('风格护栏：默认关（判定只看网侧口径），开了才把碎句判成 fail', () => {
  const strip = stripMarkdown(TELEGRAPH_TEXT)
  const off = judgeResult(normalizeResult(netJson(), strip, AI_DETECT_DEFAULTS), AI_DETECT_DEFAULTS)
  assert.equal(off.verdict, 'pass', '默认关时不得改变既有判定')
  assert.ok(off.style.fails.length > 0, '但结构越界必须作为观测量返回')

  const cfg = {
    ...AI_DETECT_DEFAULTS,
    styleGuard: { ...AI_DETECT_DEFAULTS.styleGuard, enabled: true },
  }
  const on = judgeResult(normalizeResult(netJson(), strip, cfg), cfg)
  assert.equal(on.verdict, 'fail')
  assert.ok(
    on.fails.some((f) => f.startsWith('style:short-sent')),
    JSON.stringify(on.fails),
  )
  assert.match(formatSnapshot(on), /风格=碎句/)

  // 正常散文：开了也不误伤，且快照写"风格=ok"
  const ok = judgeResult(normalizeResult(netJson(), stripMarkdown(PROSE_TEXT), cfg), cfg)
  assert.equal(ok.verdict, 'pass')
  assert.match(formatSnapshot(ok), /风格=ok/)
})

test('风格护栏：配置深合并（只给 enabled 也不会把阈值清成 undefined）', () => {
  const merged = readAiDetectConfig({ styleGuard: { enabled: true } })
  assert.equal(merged.styleGuard.enabled, true)
  assert.equal(merged.styleGuard.shortRatioMax, AI_DETECT_DEFAULTS.styleGuard.shortRatioMax)
  assert.equal(
    merged.styleGuard.consecutiveShortMax,
    AI_DETECT_DEFAULTS.styleGuard.consecutiveShortMax,
  )
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

test('segmentPlan：门禁按段数计 → "需清几段"由检测结果算（真实数据表驱动）', () => {
  // 这批 (总段数 N, 判 AI 段数 A) 全部来自 2026-10-07 线上真实检测结果（24 条里的代表样本）。
  // 为什么能这么算：接口给的 `labels_ratio.ai` 贴着 A/N（实测），口径又是**严格小于**阈值，
  // 所以允许的 A = ceil(t·N) − 1，需清 = A − 允许值。
  const LAB = { metric: 'labels_ai', threshold: 0.3, enforce: 'block' }
  const cfg = {
    ...CFG,
    gate: LAB,
    rewrite: { ...CFG.rewrite, maxRounds: 1, maxSegmentsPerRound: 5 },
  }
  const segs = (n, label) =>
    Array.from({ length: n }, (_, i) => ({ order: i + 1, label, conf: 0.9 }))
  const mk = (N, A) => ({
    verdict: 'fail',
    value: A / N,
    threshold: 0.3,
    segments: [...segs(A, 1), ...segs(N - A, 0)],
  })
  const table = [
    // [N, A, 允许的 A, 需清几段]  —— 允许值 = ceil(0.3N) − 1
    [5, 5, 1, 4],
    [5, 2, 1, 1],
    [6, 3, 1, 2],
    [6, 5, 1, 4],
    [9, 2, 2, 0],
    [10, 4, 2, 2],
    [11, 5, 3, 2],
    [12, 7, 3, 4],
    [12, 4, 3, 1],
    [2, 2, 0, 2],
  ]
  for (const [N, A, allow, need] of table) {
    const plan = segmentPlan(mk(N, A), cfg)
    assert.equal(plan.allow.ai, allow, `N=${N} A=${A} 允许值`)
    assert.equal(plan.mustRewrite, need, `N=${N} A=${A} 需清段数`)
  }
  // 边界：允许值随 N 变化，所以同样的"判 5 段"在长文里能过、在短文里过不了
  assert.equal(segmentPlan(mk(12, 3), cfg).mustRewrite, 0, '12 段里 3 段判 AI = 25% → 达标')
  assert.equal(segmentPlan(mk(5, 2), cfg).mustRewrite, 1, '5 段里 2 段判 AI = 40% → 需清 1 段')
  // 阈值恰好落在整数上时必须再减 1（口径是严格小于）：N=10 → 3/10 = 30% 不算达标
  assert.equal(segmentAllowance({ gate: LAB }, 10).ai, 2, '严格小于 30% → 10 段最多允许 2 段')
  assert.equal(
    segmentAllowance({ gate: { ...LAB, threshold: 0.5 } }, 10).ai,
    4,
    '50% 时 10 段最多 4 段',
  )
})

test('segmentPlan.advise：一轮救不回来就建议留存（别白花一次改写与检测）', () => {
  const segs = (n, label) =>
    Array.from({ length: n }, (_, i) => ({ order: i + 1, label, conf: 0.9 }))
  const base = {
    ...CFG,
    gate: { metric: 'labels_ai', threshold: 0.3, enforce: 'block' },
  }
  // 12 段里 9 段判 AI → 允许 3 段 → 需清 6 段；每轮上限 5 × 轮数 1 = 5 → 清不完
  const hard = {
    verdict: 'fail',
    value: 0.75,
    threshold: 0.3,
    segments: [...segs(9, 1), ...segs(3, 0)],
  }
  const one = segmentPlan(hard, {
    ...base,
    rewrite: { ...base.rewrite, maxRounds: 1, maxSegmentsPerRound: 5 },
  })
  assert.equal(one.mustRewrite, 6)
  assert.equal(one.reachable, false)
  assert.equal(one.advise, 'retain', '一轮清不完 → 直接建议留存')
  assert.equal(one.perRoundTargets, 5, '清单仍给满上限，便于人工/多轮时参考')
  // 同一篇给 2 轮（容量 10 ≥ 6）→ 可达，改成建议改写
  const two = segmentPlan(hard, {
    ...base,
    rewrite: { ...base.rewrite, maxRounds: 2, maxSegmentsPerRound: 5 },
  })
  assert.equal(two.reachable, true)
  assert.equal(two.advise, 'rewrite')
  // 轮数 0 = 不做改写 → 容量 0，任何需清都不可达
  const zero = segmentPlan(hard, { ...base, rewrite: { ...base.rewrite, maxRounds: 0 } })
  assert.equal(zero.capacity, 0)
  assert.equal(zero.advise, 'retain')

  // 只有护栏（碎句）不达标：指标那条线是过的 → 不是"改片段"，而是按 style.fails 并回句子
  const styleOnly = {
    verdict: 'fail',
    value: 0.2,
    threshold: 0.3,
    fails: ['style:short-run:段2'],
    styleFails: ['short-run:段2'],
    segments: [...segs(1, 1), ...segs(4, 0)],
  }
  const s = segmentPlan(styleOnly, { ...base, rewrite: { ...base.rewrite, maxRounds: 1 } })
  assert.equal(s.mustRewrite, 0)
  assert.equal(s.styleOnly, true)
  assert.equal(s.advise, 'fix-style')

  // pass → none；observe → none（只报不拦，不进改写循环）
  assert.equal(segmentPlan({ ...hard, verdict: 'pass', value: 0.2 }, base).advise, 'none')
  assert.equal(
    segmentPlan(hard, {
      ...base,
      gate: { metric: 'labels_ai', threshold: 0.3, enforce: 'observe' },
      rewrite: { ...base.rewrite, maxRounds: 1 },
    }).advise,
    'none',
  )
  // confidence 口径与段无关 → 算不出"需清几段"，但要如实说 computable=false（调用方自行处置）
  const conf = segmentPlan(hard, {
    ...CFG,
    gate: { metric: 'confidence', threshold: 0.5, enforce: 'block' },
  })
  assert.equal(conf.computable, false)
  assert.equal(conf.advise, 'rewrite')
})

test('includeSuspected 默认 true：分布口径下必须能改"疑似"段', () => {
  assert.equal(AI_DETECT_DEFAULTS.rewrite.includeSuspected, true)
  const picked = pickRewriteTargets(
    {
      verdict: 'fail',
      fails: ['uncertain'],
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

test('改写目标排序：判 AI 的段排在疑似之前，同类里置信度低的先改', () => {
  const picked = pickRewriteTargets(
    {
      verdict: 'fail',
      fails: ['human', 'uncertain'],
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
    [2, 3, 1],
    '判 AI 的段（2）在前；疑似段里置信度低的（3）先于高的（1）',
  )
})

test('segmentPlan.charGuard：段数清够了、字符占比仍过不了线 → 别再花这一轮', () => {
  // 实测形状（2026-10-08 真实结果）：N=5、A=2，段数比 40%，接口给的字符加权占比 44.47%。
  // 允许 1 段 → 需清 1 段 → 段数上"可达"。但剩下那一段按均值占 22.2% < 30% → 真能过。
  const segs = (n, label, conf = 0.9) =>
    Array.from({ length: n }, (_, i) => ({ order: i + 1, label, conf }))
  const cfg = {
    ...CFG,
    gate: { metric: 'labels_ai', threshold: 0.3, enforce: 'block' },
    rewrite: { ...CFG.rewrite, maxRounds: 1, maxSegmentsPerRound: 5 },
  }
  const ok = {
    verdict: 'fail',
    value: 0.4447,
    threshold: 0.3,
    chars: 1581,
    labelsRatio: { human: 0, ai: 0.4447, uncertain: 0.5553 },
    segments: [...segs(2, 1), ...segs(3, 2)],
  }
  const a = segmentPlan(ok, cfg)
  assert.equal(a.mustRewrite, 1)
  assert.equal(a.charGuard, true, '清掉 1 段后剩 1 段 ≈22% → 能过线')
  assert.ok(Math.abs(a.projectedAiShare - 0.4447 / 2) < 1e-9)
  assert.equal(a.advise, 'rewrite')

  // 反例：5 段里 2 段判 AI，但这两段吃掉了 63% 的字（长段落）→ 清 1 段后剩 ≈31.5% > 30%
  // 段数上仍然"可达"（需清 1 ≤ 容量 5），只有字符加权这一层看得出来。
  const fat = {
    ...ok,
    value: 0.63,
    labelsRatio: { human: 0, ai: 0.63, uncertain: 0.37 },
  }
  const b = segmentPlan(fat, cfg)
  assert.equal(b.mustRewrite, 1, '段数上仍需清 1 段')
  assert.equal(b.charGuard, false, '但按段长均值投影仍过不了线')
  assert.equal(b.reachable, false)
  assert.equal(b.advise, 'retain', '段数够了也过不了 → 别白花一轮改写与检测')

  // 缺 labelsRatio / chars 时不许猜：一律当"不拦"，照常建议改写
  const blind = segmentPlan({ ...ok, labelsRatio: undefined }, cfg)
  assert.equal(blind.projectedAiShare, null)
  assert.equal(blind.charGuard, true)
  assert.equal(blind.advise, 'rewrite')
  // 全线达标（A ≤ 允许值、占比也低）→ 照旧 none
  assert.equal(
    segmentPlan(
      {
        ...ok,
        verdict: 'pass',
        value: 0.2,
        labelsRatio: { human: 0, ai: 0.2, uncertain: 0.8 },
        segments: [...segs(1, 1), ...segs(4, 2)],
      },
      cfg,
    ).advise,
    'none',
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
      assert.equal(observed.rewriteRequired, false, 'observe 下任何判定都不该要求改写')
      assert.deepEqual(observed.fails, ['human', 'uncertain'])
      // 2026-10-07 起清单按"需清几段"自动算：这份样例里 AI 比例 26% 其实**达标**
      // （分布口径的 aiMax=50%），真正不达标的是"人工不足 + 疑似超 40% 上界"——
      // 所以只递疑似段（order 2），不去让人白改那段本来合格的判 AI 文字。
      assert.deepEqual(observed.rewriteTargets, [2], '只给真正需要清的那一类段')
      assert.equal(observed.advise, 'none', 'observe 只报不拦 → 不进入改写循环')
      assert.equal(observed.rewriteNeed.mustRewrite, 1, '需清 1 段（疑似超上界）')
      assert.equal(observed.rewriteNeed.allowedAiSegments, 1, 'AI 上界 50% → 2 段里允许 1 段判 AI')
      // 2026-10-07：重写循环由调用方执行，轮数必须随结果下发——
      // 调用方自己猜轮数，额度规划用的"每篇最多 1+maxRounds 次检测"这个上限就失效了。
      assert.deepEqual(
        observed.rewriteBudget,
        {
          maxRounds: AI_DETECT_DEFAULTS.rewrite.maxRounds,
          maxSegmentsPerRound: AI_DETECT_DEFAULTS.rewrite.maxSegmentsPerRound,
        },
        '必须把改写预算（轮数/每轮段数）交给调用方',
      )

      const blocked = await runAiDetect([
        `--file=${file}`,
        '--min-chars=1',
        '--enforce=block',
        '--mode=distribution',
      ])
      assert.equal(blocked.action, 'block')
      assert.equal(blocked.rewriteRequired, true, 'block + fail 才要求改写')
      assert.equal(blocked.advise, 'rewrite', 'block + 需清 1 段 ≤ 容量 → 按清单定向改写')
      assert.equal(blocked.rewriteNeed.mustRewrite, 1)
      assert.ok(
        blocked.rewriteBudget && blocked.rewriteBudget.maxRounds > 0,
        'block 下预算更要明确',
      )
    },
  )
})

test('runAiDetect：block 下 `pass` 不许要求改写（action 只表强度，不能当"现在就改"读）', async () => {
  freshLocalRoot()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-drafts-'))
  const file = path.join(dir, '2026-01-01-noon-passing.md')
  fs.writeFileSync(file, longText(), 'utf8')
  const { runAiDetect } = await import('../src/commands/ai-detect-cli.mjs')

  // human 90% / ai 5% / 疑似 5% → distribution 口径下三条线全过
  await withFetch(
    () =>
      jsonResponse(
        successBody({
          labels_ratio: { 0: 0.9, 1: 0.05, 2: 0.05 },
          // 故意留一段被判 AI：`rewriteTargets` 非空 ≠ 必须改写，这正是要靠
          // `rewriteRequired` 区分开的地方（只给 targets 会让调用方误改达标稿）
          segment_labels: [{ text: '判AI段', label: 1, conf: 0.9, order: 1, position: [0, 10] }],
        }),
      ),
    async () => {
      const r = await runAiDetect([
        `--file=${file}`,
        '--min-chars=1',
        '--enforce=block',
        '--mode=distribution',
      ])
      assert.equal(r.verdict, 'pass')
      assert.equal(r.action, 'block', 'action 仍反映配置强度（block）')
      assert.equal(r.rewriteRequired, false, 'pass + block 绝不能被理解为"要改写"')
      assert.deepEqual(r.rewriteTargets, [], 'pass 没有必需项 → 空清单（要观察请看 segments[]）')
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
