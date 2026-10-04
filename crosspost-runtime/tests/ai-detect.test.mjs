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
  judgeResult,
  normalizeResult,
  pickRewriteTargets,
  plainRangeToSrc,
  readUsage,
  stripMarkdown,
} from '../src/ai-detect.mjs'

/* ────────────────── 测试脚手架 ────────────────── */

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
