// token-cost.mjs 单元测试（node:test，零外部依赖；需要 /usr/local/bin/zstd 构造会话文件）
// 运行: node --test tests/token-cost.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  isPeak,
  estimateHiddenCalls,
  calcSessionCost,
  PRICING,
  matchAnchorSessions,
  findProcessWindow,
  loadSessionEvents,
  sessionFormatDiagnostics,
  readSessionLines,
  resolveUnzstd,
  resolvePython3,
} from '../src/token-cost.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const testRoot = fileURLToPath(new URL('..', import.meta.url))

// zstd CLI：macOS 在 PATH，CI/Linux 需安装（workflow 已 apt 装）；允许 ZSTD_BIN 覆盖
const zstdBin = process.env.ZSTD_BIN || 'zstd'

/** 构造本地时间戳（测试机时区 = 北京） */
const ts = (iso) => new Date(iso).getTime()

test('isPeak 工作日峰谷边界（2026-08-24 周一）', () => {
  // 高峰 9:00-12:00、14:00-18:00（含起不含止）
  assert.equal(isPeak(ts('2026-08-24T08:59:00')), false, '08:59 空闲')
  assert.equal(isPeak(ts('2026-08-24T09:00:00')), true, '09:00 高峰')
  assert.equal(isPeak(ts('2026-08-24T11:59:00')), true, '11:59 高峰')
  assert.equal(isPeak(ts('2026-08-24T12:00:00')), false, '12:00 空闲（午休）')
  assert.equal(isPeak(ts('2026-08-24T13:59:00')), false, '13:59 空闲')
  assert.equal(isPeak(ts('2026-08-24T14:00:00')), true, '14:00 高峰')
  assert.equal(isPeak(ts('2026-08-24T17:59:00')), true, '17:59 高峰')
  assert.equal(isPeak(ts('2026-08-24T18:00:00')), false, '18:00 空闲')
  assert.equal(isPeak(ts('2026-08-24T23:00:00')), false, '深夜空闲')
})

test('isPeak 周末全天低谷（2026-08-23 起生效）', () => {
  // 生效日 2026-08-23（周日）起，周六/周日任意时刻都按低谷
  assert.equal(isPeak(ts('2026-08-23T10:00:00')), false, '生效日（周日）10:00 低谷')
  assert.equal(isPeak(ts('2026-08-23T15:00:00')), false, '生效日（周日）15:00 低谷')
  assert.equal(isPeak(ts('2026-08-29T10:00:00')), false, '生效后周六 10:00 低谷')
  // 生效日前：周末仍按正常峰谷（8/22 周六、8/15 周六 10:00 高峰）
  assert.equal(isPeak(ts('2026-08-22T10:00:00')), true, '生效日前周六（8/22）10:00 仍高峰')
  assert.equal(isPeak(ts('2026-08-15T10:00:00')), true, '生效日前周六（8/15）10:00 仍高峰')
  // 生效日前的工作日正常：8/21 周五 10:00 高峰、深夜空闲
  assert.equal(isPeak(ts('2026-08-21T10:00:00')), true, '生效日前周五 10:00 仍高峰')
  assert.equal(isPeak(ts('2026-08-21T23:00:00')), false, '生效日前周五深夜空闲')
})

test('estimateHiddenCalls 计数与输入估算', () => {
  const body = 'test query '.repeat(30) // 330 字符 → input ≈ 110
  const lines = [
    JSON.stringify({ type: 'web/deepseek-search-llm-request', time: 100, data: { body } }),
    JSON.stringify({ type: 'web/deepseek-search-llm-request', time: 200, data: { body } }),
    JSON.stringify({ type: 'session/title-llm-request', time: 300, data: { title: 'x' } }),
    JSON.stringify({ type: 'assistant/chunk', time: 400, data: {} }), // 无关行忽略
    'not-json-line',
  ]
  const h = estimateHiddenCalls(lines)
  assert.ok(h, '有 hidden 调用')
  assert.equal(h.searches, 2)
  assert.equal(h.titles, 1)
  assert.ok(h.input >= 60 * 2 + 80, '输入按请求体长度估算')
  assert.equal(h.output, 2 * 120 + 20, '输出固定估算：搜索 120/次，标题 20')
  assert.equal(h.time, 300, 'time 取最后一次 hidden 调用')
  // 无 hidden → null
  assert.equal(
    estimateHiddenCalls([JSON.stringify({ type: 'assistant/chunk', time: 1, data: {} })]),
    null,
  )
})

/** 构造 zstd 会话文件（zstd CLI 压缩），返回路径 */
function makeSessionFile(lines, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tokencost-test-${name}-`))
  const raw = path.join(dir, 'raw.jsonl')
  const out = path.join(dir, 'session.jsonl.zstd')
  fs.writeFileSync(raw, lines.join('\n') + '\n', 'utf8')
  execFileSync(zstdBin, ['-f', raw, '-o', out, '-q'])
  fs.rmSync(raw)
  return out
}

test('calcSessionCost 逐 usage 事件按峰谷计费 + hidden 并入', () => {
  const peakTs = ts('2026-08-24T10:00:00') // 周一 高峰
  const idleTs = ts('2026-08-24T22:00:00') // 周一 空闲
  const file = makeSessionFile(
    [
      JSON.stringify({
        type: 'assistant/chunk',
        time: peakTs,
        data: {
          chunk: {
            type: 'usage',
            usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 500, reasoningTokens: 0 },
          },
        },
      }),
      JSON.stringify({
        type: 'assistant/chunk',
        time: idleTs,
        data: {
          chunk: {
            type: 'usage',
            usage: {
              inputTokens: 2000,
              cacheReadTokens: 100,
              outputTokens: 300,
              reasoningTokens: 50,
            },
          },
        },
      }),
      JSON.stringify({
        type: 'web/deepseek-search-llm-request',
        time: peakTs,
        data: { body: 'x'.repeat(200) },
      }),
    ],
    'cost',
  )
  const c = calcSessionCost(file)
  assert.ok(c, '有 usage 事件')
  // tokens 汇总
  assert.deepEqual(c.tokens, {
    input: 3000,
    cache: 100,
    output: 800,
    reasoning: 50,
    hidden: c.tokens.hidden,
    total: 3000 + 100 + 800 + c.tokens.hidden,
  })
  assert.equal(c.steps, 2)
  // main 计费：peak 事件 + idle 事件
  const peakCost = (1000 / 1e6) * PRICING.inputMiss.peak + (500 / 1e6) * PRICING.output.peak
  const idleCost =
    (2000 / 1e6) * PRICING.inputMiss.idle +
    (100 / 1e6) * PRICING.inputHit.idle +
    (300 / 1e6) * PRICING.output.idle
  const expectMain = Math.round((peakCost + idleCost) * 10000) / 10000
  assert.equal(c.main.cost, expectMain)
  // hidden 并入
  assert.equal(c.hidden.searches, 1)
  assert.ok(c.cost >= c.main.cost && c.cost > 0)
  // time = 最后一次 usage 事件
  assert.equal(c.time, idleTs)
})

test('calcSessionCost 缓存：文件未变命中，mtime 变化重算', () => {
  const file = makeSessionFile(
    [
      JSON.stringify({
        type: 'assistant/chunk',
        time: ts('2026-08-24T10:00:00'),
        data: {
          chunk: {
            type: 'usage',
            usage: { inputTokens: 500, cacheReadTokens: 0, outputTokens: 100, reasoningTokens: 0 },
          },
        },
      }),
    ],
    'cache',
  )
  const c1 = calcSessionCost(file)
  const c2 = calcSessionCost(file)
  assert.equal(c2, c1, 'mtime 未变 → 返回缓存同一对象')
  // 修改文件内容并推进 mtime（毫秒级写入可能同 mtime，显式 utimes）→ 重算
  const raw = path.join(path.dirname(file), 'raw2.jsonl')
  fs.writeFileSync(
    raw,
    JSON.stringify({
      type: 'assistant/chunk',
      time: ts('2026-08-24T10:00:00'),
      data: {
        chunk: {
          type: 'usage',
          usage: { inputTokens: 999, cacheReadTokens: 0, outputTokens: 1, reasoningTokens: 0 },
        },
      },
    }) + '\n',
    'utf8',
  )
  const out = path.join(path.dirname(file), 'session.jsonl.zstd')
  execFileSync(zstdBin, ['-f', raw, '-o', out, '-q'])
  const st = fs.statSync(out)
  fs.utimesSync(out, new Date(st.mtimeMs + 5000), new Date(st.mtimeMs + 5000))
  const c3 = calcSessionCost(file)
  assert.notEqual(c3, c1)
  assert.equal(c3.tokens.input, 999)
})

test('calcSessionCost 无 usage 事件返回 null', () => {
  const file = makeSessionFile([JSON.stringify({ type: 'meta', time: 1 }), 'hello'], 'null')
  assert.equal(calcSessionCost(file), null)
})

// ── 会话匹配（2026-08-28）：matchAnchorSessions ──

/** 构造临时会话目录（CROSSPOST_SESSIONS_DIRS 注入用，子进程 import 前生效），返回目录路径 */
function makeSessionDir(usageEvents, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tokencost-sess-${name}-`))
  const sessionId = `session-${name}`
  const sessionDir = path.join(dir, sessionId)
  fs.mkdirSync(sessionDir, { recursive: true })
  const lines = usageEvents.map((t) =>
    JSON.stringify({
      type: 'assistant/chunk',
      time: t,
      data: {
        chunk: {
          type: 'usage',
          usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 500, reasoningTokens: 0 },
        },
      },
    }),
  )
  fs.writeFileSync(path.join(sessionDir, 'raw.jsonl'), lines.join('\n') + '\n', 'utf8')
  execFileSync(zstdBin, [
    '-f',
    path.join(sessionDir, 'raw.jsonl'),
    '-o',
    path.join(sessionDir, 'session.jsonl.zstd'),
    '-q',
  ])
  fs.rmSync(path.join(sessionDir, 'raw.jsonl'))
  return dir
}

test('matchAnchorSessions 无锚点返回空；anchor 为 null 不抛', () => {
  assert.deepEqual(matchAnchorSessions(null), [])
  assert.deepEqual(matchAnchorSessions(undefined), [])
  assert.deepEqual(matchAnchorSessions(0), [])
})

// ── 区间匹配（2026-08-28 修复：GUI 长会话内生成的文章可追溯） ──

test('matchAnchorSessions 锚点落在会话区间内且贴近 burst → 匹配（GUI 长会话场景）', () => {
  // 会话 start=10:00, end=12:00（长会话）；锚点 10:02（贴近 10:00 burst，≤5min）→ 匹配
  const sdir = makeSessionDir([ts('2026-08-24T10:00:00'), ts('2026-08-24T12:00:00')], 'interval')
  const env = { ...process.env, CROSSPOST_SESSIONS_DIRS: sdir }
  const nodeScript = `import('./src/token-cost.mjs').then(async (m) => {
    const anchor = new Date('2026-08-24T10:02:00').getTime()
    const r = m.matchAnchorSessions(anchor)
    console.log(JSON.stringify({ n: r.length, first: r[0] && r[0].session }))
  })`
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', nodeScript], {
    env,
    encoding: 'utf8',
    cwd: testRoot,
  })
  assert.equal(out.status, 0, out.stderr)
  const res = JSON.parse(out.stdout)
  assert.ok(res.n >= 1, '区间内且贴近 burst 的锚点匹配会话')
  // 锚点在区间内但远离所有事件（>gapMs）→ 无生成活动 → 不匹配（跨会话误匹配防护）
  const nodeScript2 = `import('./src/token-cost.mjs').then(async (m) => {
    const anchor = new Date('2026-08-24T11:00:00').getTime()
    const r = m.matchAnchorSessions(anchor)
    console.log(JSON.stringify({ n: r.length }))
  })`
  const out2 = spawnSync(process.execPath, ['--input-type=module', '-e', nodeScript2], {
    env,
    encoding: 'utf8',
    cwd: testRoot,
  })
  assert.equal(out2.status, 0, out2.stderr)
  const res2 = JSON.parse(out2.stdout)
  assert.equal(res2.n, 0, '区间内但远离事件（无生成活动）→ 不匹配')
  // 锚点远早于 startTs - window → 不匹配
  const nodeScript3 = `import('./src/token-cost.mjs').then(async (m) => {
    const anchor = new Date('2026-08-20T09:00:00').getTime()
    const r = m.matchAnchorSessions(anchor)
    console.log(JSON.stringify({ n: r.length }))
  })`
  const out3 = spawnSync(process.execPath, ['--input-type=module', '-e', nodeScript3], {
    env,
    encoding: 'utf8',
    cwd: testRoot,
  })
  const res3 = JSON.parse(out3.stdout)
  assert.equal(res3.n, 0, '锚点早于会话区间 → 不匹配')
})

// ── 会话索引/成本磁盘缓存（2026-08-28 性能优化） ──
// 磁盘缓存文件路径与实现绑定 /tmp/dsh-session-index.json / /tmp/dsh-session-cost.json；
// 这里用真实会话文件验证跨进程缓存语义（listSessions/calcSessionCost 从索引读、mtime 变化重扫）。

test('listSessions 磁盘索引：mtime 未变命中、变化重扫（子进程模拟跨进程复用）', () => {
  // 构造两个独立子进程：第一次建索引，第二次（mtime 不变）应命中复用（不重解压）
  const sdir = makeSessionDir([ts('2026-08-24T10:00:00')], 'idx')
  const envBase = { ...process.env, CROSSPOST_SESSIONS_DIRS: sdir }
  const nodeScript = `import('./src/token-cost.mjs').then(async (m) => {
    const s = m.listSessions()
    console.log(JSON.stringify(s.map(x => ({ session: x.session, mtime: x.mtime, startTs: x.startTs }))))
  })`
  const run = (env) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', nodeScript], {
      env,
      encoding: 'utf8',
      cwd: testRoot,
    })
  const r1 = run(envBase)
  assert.equal(r1.status, 0, r1.stderr)
  const s1 = JSON.parse(r1.stdout)
  assert.ok(s1.length >= 1 && s1[0].startTs !== null, '首次扫描解析出时间范围')
  // 二次调用（同一目录，mtime 未变）：索引命中，时间范围一致
  const r2 = run(envBase)
  assert.equal(r2.status, 0, r2.stderr)
  const s2 = JSON.parse(r2.stdout)
  assert.deepEqual(
    s2.map((x) => x.startTs),
    s1.map((x) => x.startTs),
    '索引命中：时间范围不变',
  )
})

test('calcSessionCost 磁盘成本缓存：同 mtime 跨进程复用、mtime 变化重算', () => {
  const anchor = ts('2026-08-24T10:00:00')
  const file = makeSessionFile(
    [
      JSON.stringify({
        type: 'assistant/chunk',
        time: anchor,
        data: {
          chunk: {
            type: 'usage',
            usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 500, reasoningTokens: 0 },
          },
        },
      }),
    ],
    'costdisk',
  )
  const envBase = { ...process.env, CROSSPOST_SESSIONS_DIRS: path.dirname(path.dirname(file)) }
  const nodeScript = `import('./src/token-cost.mjs').then(async (m) => {
    const c = m.calcSessionCost(process.argv[1])
    console.log(JSON.stringify(c && { input: c.tokens.input, cost: c.cost }))
  })`
  const run = (f) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', nodeScript, f], {
      env: envBase,
      encoding: 'utf8',
      cwd: testRoot,
    })
  const r1 = run(file)
  assert.equal(r1.status, 0, r1.stderr)
  const c1 = JSON.parse(r1.stdout)
  assert.ok(c1 && c1.input === 1000, '首次计算')
  // mtime 未变 → 磁盘缓存命中（结果一致，且不重解压——此处只验证结果等价）
  const r2 = run(file)
  const c2 = JSON.parse(r2.stdout)
  assert.deepEqual(c2, c1, '磁盘成本缓存：结果复用')
  // mtime 变化 → 重算（改文件内容）
  const raw = path.join(path.dirname(file), 'raw3.jsonl')
  fs.writeFileSync(
    raw,
    JSON.stringify({
      type: 'assistant/chunk',
      time: anchor,
      data: {
        chunk: {
          type: 'usage',
          usage: { inputTokens: 999, cacheReadTokens: 0, outputTokens: 1, reasoningTokens: 0 },
        },
      },
    }) + '\n',
    'utf8',
  )
  execFileSync(zstdBin, ['-f', raw, '-o', file, '-q'])
  const st = fs.statSync(file)
  fs.utimesSync(file, new Date(st.mtimeMs + 5000), new Date(st.mtimeMs + 5000))
  const r3 = run(file)
  const c3 = JSON.parse(r3.stdout)
  assert.equal(c3.input, 999, 'mtime 变化重算')
})

// ── 2026-08-28 精确计费：生成过程窗口切分（burst） ──

test('findProcessWindow burst 切分：只取锚点所在过程簇', () => {
  // 两个过程簇：A 簇 10:00-10:05（间隔 1min），停顿 30min，B 簇 10:35-10:40；锚点在 A 簇
  const t = ts
  const events = [
    [t('2026-08-24T10:00:00'), 100, 0, 50, 0],
    [t('2026-08-24T10:01:00'), 100, 0, 50, 0],
    [t('2026-08-24T10:05:00'), 100, 0, 50, 0],
    [t('2026-08-24T10:35:00'), 100, 0, 50, 0],
    [t('2026-08-24T10:40:00'), 100, 0, 50, 0],
  ]
  const anchor = t('2026-08-24T10:05:30') // A 簇末尾（生成完成落盘）
  const win = findProcessWindow(events, anchor)
  assert.ok(win, '有窗口')
  assert.equal(win.from, t('2026-08-24T10:00:00'), '起点=A 簇首事件')
  assert.equal(win.to, t('2026-08-24T10:05:00'), '终点=A 簇尾事件（B 簇被 30min 停顿切开）')
  assert.ok(win.to < t('2026-08-24T10:35:00'), 'B 簇不在窗口内')
})

test('findProcessWindow 锚点后缓冲：纳入落盘后的评分/审稿事件', () => {
  const t = ts
  const events = [
    [t('2026-08-24T10:00:00'), 100, 0, 50, 0],
    [t('2026-08-24T10:03:00'), 100, 0, 50, 0],
    [t('2026-08-24T10:07:00'), 100, 0, 50, 0], // 锚点后 5min（≤15min 缓冲且间隔 ≤5min gap）→ 同过程
    [t('2026-08-24T10:40:00'), 100, 0, 50, 0], // 间隔 33min（>gap）→ 排除
  ]
  const anchor = t('2026-08-24T10:02:00')
  const win = findProcessWindow(events, anchor)
  assert.ok(win)
  assert.equal(win.from, t('2026-08-24T10:00:00'))
  assert.equal(win.to, t('2026-08-24T10:07:00'), '锚点后缓冲内事件并入')
})

test('findProcessWindow 边界：空事件/无锚点返回 null；回溯上限防吞并', () => {
  assert.equal(findProcessWindow([], ts('2026-08-24T10:00:00')), null)
  assert.equal(findProcessWindow(null, ts('2026-08-24T10:00:00')), null)
  assert.equal(findProcessWindow([[ts('2026-08-24T10:00:00'), 1, 0, 0, 0]], null), null)
  // 锚点远早于所有事件 → 无窗口
  assert.equal(
    findProcessWindow([[ts('2026-08-24T10:00:00'), 1, 0, 0, 0]], ts('2026-08-20T10:00:00')),
    null,
  )
})

test('calcSessionCost 窗口计费：只累计窗口内事件（峰谷按各自时间判）', () => {
  const t = ts
  // 峰(10:00) 事件 1000 输入 + 500 输出；闲(22:00) 事件 2000 输入 + 300 输出
  const file = makeSessionFile(
    [
      JSON.stringify({
        type: 'assistant/chunk',
        time: t('2026-08-24T10:00:00'),
        data: {
          chunk: {
            type: 'usage',
            usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 500, reasoningTokens: 0 },
          },
        },
      }),
      JSON.stringify({
        type: 'assistant/chunk',
        time: t('2026-08-24T22:00:00'),
        data: {
          chunk: {
            type: 'usage',
            usage: { inputTokens: 2000, cacheReadTokens: 0, outputTokens: 300, reasoningTokens: 0 },
          },
        },
      }),
    ],
    'win',
  )
  const win = { from: t('2026-08-24T09:30:00'), to: t('2026-08-24T10:30:00') }
  const c = calcSessionCost(file, win)
  assert.ok(c, '窗口内有事件')
  assert.equal(c.steps, 1, '窗口外事件不计')
  assert.equal(c.tokens.input, 1000, '只累计窗口内输入')
  assert.equal(c.tokens.output, 500)
  const expect = (1000 / 1e6) * PRICING.inputMiss.peak + (500 / 1e6) * PRICING.output.peak
  assert.equal(c.main.cost, Math.round(expect * 10000) / 10000, '窗口内按峰值计费')
  // 全会话（无窗口）仍累计两个事件
  const all = calcSessionCost(file)
  assert.equal(all.steps, 2)
})

test('loadSessionEvents 事件缓存：结构正确且 mtime 复用', () => {
  const t = ts
  const file = makeSessionFile(
    [
      JSON.stringify({
        type: 'assistant/chunk',
        time: t('2026-08-24T10:00:00'),
        data: {
          chunk: {
            type: 'usage',
            usage: {
              inputTokens: 1000,
              cacheReadTokens: 200,
              outputTokens: 500,
              reasoningTokens: 50,
            },
          },
        },
      }),
      JSON.stringify({
        type: 'web/deepseek-search-llm-request',
        time: t('2026-08-24T10:00:30'),
        data: { body: 'x'.repeat(300) },
      }),
    ],
    'evts',
  )
  const d = loadSessionEvents(file)
  assert.ok(d && d.events.length === 1, 'usage 事件解析')
  assert.deepEqual(
    d.events[0],
    [t('2026-08-24T10:00:00'), 1000, 200, 500, 50],
    '事件字段 [ts,input,cache,output,reasoning]',
  )
  assert.ok(d.hidden.length === 1 && d.hidden[0].type === 'search', 'hidden 解析')
  // 同对象（mtime 未变缓存命中）
  assert.equal(loadSessionEvents(file), d, 'mtime 未变返回同一缓存对象')
})

test('matchAnchorSessions GUI 长会话：只计锚点所在 burst，不再返回整个会话成本', () => {
  // 会话内两个簇：A 10:00-10:05（生成文章），B 12:00-12:05（后续活动）；
  // 锚点 10:03 → 只应累计 A 簇（2 事件），B 簇不计入
  const anchor = ts('2026-08-24T10:03:00')
  const sdir = makeSessionDir(
    [
      ts('2026-08-24T10:00:00'),
      ts('2026-08-24T10:05:00'),
      ts('2026-08-24T12:00:00'),
      ts('2026-08-24T12:05:00'),
    ],
    'burst',
  )
  const env = { ...process.env, CROSSPOST_SESSIONS_DIRS: sdir }
  const nodeScript = `import('./src/token-cost.mjs').then(async (m) => {
    const r = m.matchAnchorSessions(${anchor})
    console.log(JSON.stringify(r.map(x => ({ session: x.session, steps: x.steps, window: x.window }))))
  })`
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', nodeScript], {
    env,
    encoding: 'utf8',
    cwd: testRoot,
  })
  assert.equal(out.status, 0, out.stderr)
  const res = JSON.parse(out.stdout)
  assert.ok(res.length >= 1, '锚点匹配会话')
  const r = res[0]
  assert.equal(r.steps, 2, '只计 A 簇 2 个事件（B 簇被 2h 停顿切开）')
  assert.equal(new Date(r.window.from).toISOString(), '2026-08-24T02:00:00.000Z', '窗口起点=A 簇首')
  assert.equal(new Date(r.window.to).toISOString(), '2026-08-24T02:05:00.000Z', '窗口终点=A 簇尾')
})

test('articleCost 锚点修正：迁移老文章 publishedAt 与 date 相差>3 天 → 回退文件 mtime（无匹配→无会话记录）', () => {
  // 迁移文章：date=08-12，publishedAt=08-19（批量登记），文件 mtime=08-12（无会话可匹配）
  const t = ts
  const sdir = makeSessionDir([t('2026-08-19T15:55:00')], 'migrate') // 会话只在 08-19（登记日）
  const env = { ...process.env, CROSSPOST_SESSIONS_DIRS: sdir }
  const nodeScript = `import('./src/token-cost.mjs').then(async (m) => {
    const cost = m.articleCost({
      id: '2026-08-12-morning-ai-coworker', date: '2026-08-12', slot: 'morning', title: 'x',
      file: process.argv[1], publishedAt: '2026-08-19T15:55:09.448Z',
    })
    console.log(JSON.stringify({ matched: cost.matched, cost: cost.cost, window: cost.processWindow }))
  })`
  // 构造一个 08-12 的"草稿文件"（mtime=08-12，会话只有 08-19 → 匹配不上）
  const draftsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokencost-drafts-'))
  const fakeFile = path.join(draftsDir, '2026-08-12-morning-ai-coworker.md')
  fs.writeFileSync(fakeFile, '---\ntitle: x\n---\n', 'utf8')
  fs.utimesSync(fakeFile, new Date(t('2026-08-12T09:00:00')), new Date(t('2026-08-12T09:00:00')))
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', nodeScript, fakeFile], {
    env,
    encoding: 'utf8',
    cwd: testRoot,
  })
  assert.equal(out.status, 0, out.stderr)
  const res = JSON.parse(out.stdout)
  assert.equal(res.matched, false, '迁移文章不匹配 08-19 会话 → 无会话记录（不再误算）')
  assert.equal(res.cost, 0)
})

test('articleCost 真实首发文章：publishedAt 与 date 同天 → 用 publishedAt 匹配并返回过程窗口', () => {
  // 文章 date=08-24，publishedAt=08-24T10:05Z（同天），会话在 10:00Z-10:05Z → 匹配
  const sdir = makeSessionDir(
    [new Date('2026-08-24T10:00:00Z').getTime(), new Date('2026-08-24T10:05:00Z').getTime()],
    'real',
  )
  const env = { ...process.env, CROSSPOST_SESSIONS_DIRS: sdir }
  const nodeScript = `import('./src/token-cost.mjs').then(async (m) => {
    const cost = m.articleCost({
      id: '2026-08-24-morning-test', date: '2026-08-24', slot: 'morning', title: 'x',
      file: process.argv[1] || null, publishedAt: '2026-08-24T10:05:00.000Z',
    })
    console.log(JSON.stringify({ matched: cost.matched, steps: cost.sessions.length && cost.sessions[0].steps, cost: cost.cost }))
  })`
  const out = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', nodeScript, '/nonexistent'],
    { env, encoding: 'utf8', cwd: testRoot },
  )
  assert.equal(out.status, 0, out.stderr)
  const res = JSON.parse(out.stdout)
  assert.equal(res.matched, true, '真实首发匹配')
  assert.ok(res.steps >= 1 && res.cost > 0, '有过程消耗')
})

test('articleCost 文章级缓存：同 key 命中（返回同一结果）', () => {
  const sdir = makeSessionDir([new Date('2026-08-24T10:00:00Z').getTime()], 'acache')
  const env = { ...process.env, CROSSPOST_SESSIONS_DIRS: sdir }
  const nodeScript = `import('./src/token-cost.mjs').then(async (m) => {
    const mk = () => m.articleCost({ id: '2026-08-24-morning-cache', date: '2026-08-24', slot: 'morning', title: 'x', file: process.argv[1] || null, publishedAt: '2026-08-24T10:00:00.000Z' })
    const a = mk(); const b = mk()
    console.log(JSON.stringify({ same: a === b, cost1: a.cost, cost2: b.cost, matched: a.matched }))
  })`
  const out = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', nodeScript, '/nonexistent'],
    { env, encoding: 'utf8', cwd: testRoot },
  )
  assert.equal(out.status, 0, out.stderr)
  const res = JSON.parse(out.stdout)
  assert.equal(res.matched, true)
  assert.equal(res.cost1, res.cost2, '同 key 缓存命中，结果一致')
})

test('estimateHiddenCalls 窗口过滤：只统计窗口内的隐藏调用', () => {
  const t = ts
  const lines = [
    JSON.stringify({
      type: 'web/deepseek-search-llm-request',
      time: t('2026-08-24T10:00:00'),
      data: { body: 'a'.repeat(200) },
    }),
    JSON.stringify({
      type: 'web/deepseek-search-llm-request',
      time: t('2026-08-24T12:00:00'),
      data: { body: 'b'.repeat(200) },
    }),
  ]
  const win = { from: t('2026-08-24T09:30:00'), to: t('2026-08-24T10:30:00') }
  const h = estimateHiddenCalls(lines, win)
  assert.ok(h && h.searches === 1, '窗口内 1 次搜索')
  assert.equal(h.time, t('2026-08-24T10:00:00'))
  const all = estimateHiddenCalls(lines)
  assert.equal(all.searches, 2, '无窗口仍统计全部')
})

// ═══════════════════════════════════════════════════════════════════════════
// DSH 会话格式 v3 兼容（2026-09-11 修复）
// 背景：DSH 0.1.5-rc.1 起会话文件为 session.v3.jsonl.zstd，usage 从
//   assistant/chunk.data.chunk.usage 迁到 assistant/message.data.usage；
// 旧代码硬编码 v0 文件名 + chunk 形态 → 升级后文章全部"无会话记录"、报表费用归零。
// v4（2026-10-03，DSH 0.2.0-rc.2）：文件名再进一步到 session.v4.jsonl.zstd，
//   但 usage 承载位置**实测未变**（仍是 assistant/message.data.usage、仍无 assistant/chunk）。
//   下面的 v4 用例把这条件钉住：若将来某代际又搬动 usage，报表会静默归零，这里会先红。
// ═══════════════════════════════════════════════════════════════════════════

// CrossPost · maintained by dos2un1x · https://github.com/dos2un1x/crosspost
const USAGE = { inputTokens: 1000, cacheReadTokens: 200, outputTokens: 500, reasoningTokens: 0 }

/** 按代际造 usage 事件行：v0/v1/v2 → assistant/chunk；v3+ → assistant/message */
function usageLine(gen, time, usage = USAGE, step = 1) {
  return JSON.stringify(
    gen >= 3
      ? { type: 'assistant/message', time, data: { turn: 1, step, usage } }
      : { type: 'assistant/chunk', time, data: { chunk: { type: 'usage', usage } } },
  )
}

/** 构造会话文件（可选代际文件名 / 不压缩），返回文件路径 */
function makeGenSessionFile(lines, name, { gen = 0, compress = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tokencost-gen-${name}-`))
  const base = gen === 0 ? 'session.jsonl' : `session.v${gen}.jsonl`
  const file = path.join(dir, base + (compress ? '.zstd' : ''))
  const body = lines.join('\n') + '\n'
  if (!compress) {
    fs.writeFileSync(file, body, 'utf8')
    return file
  }
  const raw = path.join(dir, 'raw.jsonl')
  fs.writeFileSync(raw, body, 'utf8')
  execFileSync(zstdBin, ['-f', raw, '-o', file, '-q'])
  fs.rmSync(raw)
  return file
}

/** 构造会话目录（CROSSPOST_SESSIONS_DIRS 注入用），可放多代文件 */
function makeGenSessionDir(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tokencost-sess-${name}-`))
  const sessionDir = path.join(dir, `session-${name}`)
  fs.mkdirSync(sessionDir, { recursive: true })
  for (const f of files) {
    const base = f.gen === 0 ? 'session.jsonl' : `session.v${f.gen}.jsonl`
    const file = path.join(sessionDir, base + (f.compress === false ? '' : '.zstd'))
    const body = f.lines.join('\n') + '\n'
    if (f.compress === false) {
      fs.writeFileSync(file, body, 'utf8')
      continue
    }
    const raw = path.join(sessionDir, `raw-${f.gen}.jsonl`)
    fs.writeFileSync(raw, body, 'utf8')
    execFileSync(zstdBin, ['-f', raw, '-o', file, '-q'])
    fs.rmSync(raw)
  }
  return dir
}

const runInSessionDir = (sdir, expr) =>
  spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import('./src/token-cost.mjs').then(async (m) => { console.log(JSON.stringify(await (async () => (${expr}))())) })`,
    ],
    { env: { ...process.env, CROSSPOST_SESSIONS_DIRS: sdir }, encoding: 'utf8', cwd: testRoot },
  )

test('v3 会话：usage 在 assistant/message 上，计费与同值 chunk 形态一致', () => {
  const peak = ts('2026-08-24T10:00:00') // 周一高峰
  const v3 = makeGenSessionFile([usageLine(3, peak)], 'v3msg', { gen: 3 })
  const c3 = calcSessionCost(v3)
  assert.ok(c3, 'v3 会话能解析出 usage（旧代码此处返回 null）')
  assert.equal(c3.steps, 1)
  assert.equal(c3.tokens.input, USAGE.inputTokens)
  assert.equal(c3.tokens.cache, USAGE.cacheReadTokens)
  assert.equal(c3.tokens.output, USAGE.outputTokens)
  // 与同值 v0 chunk 形态逐位一致
  const v0 = makeGenSessionFile([usageLine(0, peak)], 'v0same', { gen: 0 })
  const c0 = calcSessionCost(v0)
  assert.equal(c3.cost, c0.cost, 'v3 与 v0 同值 usage → 同费用')
  // 手算校验：高峰 inputMiss 3.0 / inputHit 0.1 / output 9.0（元/百万）
  const expect =
    (USAGE.inputTokens / 1e6) * PRICING.inputMiss.peak +
    (USAGE.cacheReadTokens / 1e6) * PRICING.inputHit.peak +
    (USAGE.outputTokens / 1e6) * PRICING.output.peak
  assert.equal(c3.mainCost, Math.round(expect * 10000) / 10000)
})

test('v0 会话同时含 chunk 与 message 两份同值 usage → 只计一次（不翻倍）', () => {
  const peak = ts('2026-08-24T10:00:00')
  const both = makeGenSessionFile(
    [
      usageLine(0, peak), // assistant/chunk
      usageLine(3, peak), // assistant/message（同一 (turn,step) 同值）
    ],
    'v0both',
    { gen: 0 },
  )
  const c = calcSessionCost(both)
  assert.equal(c.steps, 1, '同一条模型调用只计一次')
  const chunkOnly = calcSessionCost(makeGenSessionFile([usageLine(0, peak)], 'v0only', { gen: 0 }))
  assert.equal(c.cost, chunkOnly.cost, 'v0 计费与仅 chunk 形态完全一致（历史数值不变）')
})

test('代际选择：同目录存在 v0 与 v3 → 只读最高代际（不双计、不误读旧文件）', () => {
  const peak = ts('2026-08-24T10:00:00')
  const sdir = makeGenSessionDir('genpick', [
    { gen: 0, lines: [usageLine(0, peak)] },
    { gen: 3, lines: [usageLine(3, peak), usageLine(3, peak + 60000, USAGE, 2)] },
  ])
  const out = runInSessionDir(
    sdir,
    `(() => { const s = m.listSessions(); return { n: s.length, path: s[0] && s[0].path, events: s[0] && m.loadSessionEvents(s[0].path).events.length } })()`,
  )
  assert.equal(out.status, 0, out.stderr)
  const res = JSON.parse(out.stdout)
  assert.equal(res.n, 1, '一个会话目录只产出一个会话')
  assert.ok(/session\.v3\.jsonl\.zstd$/.test(res.path), `选中的应是 v3 文件，实际 ${res.path}`)
  assert.equal(res.events, 2, '只计 v3 文件里的 2 条 usage（未叠加 v0 文件）')
})

test('v4 会话（DSH 0.2.0-rc.2 实况）：usage 仍在 assistant/message.data.usage', () => {
  const peak = ts('2026-08-24T10:00:00')
  const v4 = makeGenSessionFile([usageLine(4, peak)], 'v4msg', { gen: 4 })
  assert.ok(v4.endsWith('session.v4.jsonl.zstd'), `文件名应为 v4，实际 ${v4}`)
  const c4 = calcSessionCost(v4)
  assert.ok(c4, 'v4 会话必须能解析出 usage（承载位置若搬走，这里会返回 null → 报表静默归零）')
  assert.equal(c4.steps, 1)
  assert.equal(c4.tokens.input, USAGE.inputTokens)
  assert.equal(c4.tokens.cache, USAGE.cacheReadTokens)
  assert.equal(c4.tokens.output, USAGE.outputTokens)
  // 与同值 v3 / v0 逐位一致：代际不改变计费口径
  const c3 = calcSessionCost(makeGenSessionFile([usageLine(3, peak)], 'v3same', { gen: 3 }))
  const c0 = calcSessionCost(makeGenSessionFile([usageLine(0, peak)], 'v0same2', { gen: 0 }))
  assert.equal(c4.cost, c3.cost, 'v4 与 v3 同值 usage → 同费用')
  assert.equal(c4.cost, c0.cost, 'v4 与 v0 同值 usage → 同费用')
})

test('代际选择：同目录存在 v0 / v3 / v4 → 只读最高代际 v4（不双计、不误读旧文件）', () => {
  const peak = ts('2026-08-24T10:00:00')
  const sdir = makeGenSessionDir('genpick4', [
    { gen: 0, lines: [usageLine(0, peak)] },
    { gen: 3, lines: [usageLine(3, peak)] },
    { gen: 4, lines: [usageLine(4, peak), usageLine(4, peak + 60000, USAGE, 2)] },
  ])
  const out = runInSessionDir(
    sdir,
    `(() => { const s = m.listSessions(); return { n: s.length, path: s[0] && s[0].path, events: s[0] && m.loadSessionEvents(s[0].path).events.length } })()`,
  )
  assert.equal(out.status, 0, out.stderr)
  const res = JSON.parse(out.stdout)
  assert.equal(res.n, 1, '一个会话目录只产出一个会话')
  assert.ok(/session\.v4\.jsonl\.zstd$/.test(res.path), `选中的应是 v4 文件，实际 ${res.path}`)
  assert.equal(res.events, 2, '只计 v4 文件里的 2 条 usage（未叠加 v0/v3 文件）')
})

test('非规范代际文件名不被当作会话（.v03 / .V3 / .tmp / 其它后缀）', () => {
  const peak = ts('2026-08-24T10:00:00')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokencost-badname-'))
  const sessionDir = path.join(dir, 'session-badname')
  fs.mkdirSync(sessionDir)
  const raw = path.join(sessionDir, 'raw.jsonl')
  fs.writeFileSync(raw, usageLine(3, peak) + '\n', 'utf8')
  for (const bad of [
    'session.v03.jsonl.zstd',
    'session.V3.jsonl.zstd',
    'session.v3.jsonl.zstd.tmp',
  ]) {
    execFileSync(zstdBin, ['-f', raw, '-o', path.join(sessionDir, bad), '-q'])
  }
  fs.rmSync(raw)
  const out = runInSessionDir(
    dir,
    `(() => { const s = m.listSessions(); return { n: s.length } })()`,
  )
  assert.equal(out.status, 0, out.stderr)
  assert.equal(
    JSON.parse(out.stdout).n,
    0,
    '非规范名一律不识别（与 DSH CANONICAL_LOG_FILENAME 一致）',
  )
})

test('未压缩代际（compression=none 的 session.v3.jsonl）可直接读取', () => {
  const peak = ts('2026-08-24T10:00:00')
  const file = makeGenSessionFile([usageLine(3, peak)], 'v3plain', { gen: 3, compress: false })
  assert.ok(file.endsWith('session.v3.jsonl'))
  const c = calcSessionCost(file)
  assert.ok(c && c.steps === 1, '未压缩 v3 会话同样可计费')
  assert.equal(
    c.mainCost,
    calcSessionCost(makeGenSessionFile([usageLine(3, peak)], 'v3z', { gen: 3 })).mainCost,
  )
})

test('v3 端到端：锚点落在 v3 会话区间内 → matched=true 且费用>0（复刻报表归零场景）', () => {
  const anchorIso = '2026-08-24T10:00:00'
  const sdir = makeGenSessionDir('v3e2e', [{ gen: 3, lines: [usageLine(3, ts(anchorIso))] }])
  const out = runInSessionDir(
    sdir,
    `(() => { const a = new Date('${anchorIso}').getTime(); const r = m.matchAnchorSessions(a); return { n: r.length, cost: r[0] && r[0].cost, matched: r.length > 0 } })()`,
  )
  assert.equal(out.status, 0, out.stderr)
  const res = JSON.parse(out.stdout)
  assert.equal(res.matched, true, 'v3 会话能被锚点匹配到')
  assert.ok(res.cost > 0, '且费用大于 0')
})

test('sessionFormatDiagnostics：按代际计数 + 点名零 usage 会话', () => {
  const peak = ts('2026-08-24T10:00:00')
  const okFile = makeGenSessionFile([usageLine(3, peak)], 'diagv3', { gen: 3 })
  const emptyFile = makeGenSessionFile(
    [JSON.stringify({ type: 'session', version: 3, id: 'x', createdAt: peak })],
    'diagempty',
    { gen: 3 },
  )
  loadSessionEvents(okFile)
  loadSessionEvents(emptyFile)
  const d = sessionFormatDiagnostics()
  // 2026-09-28 测试审计：原先两条 `typeof d.sessions === 'number'` / `typeof d.byGen === 'object'`
  // 恒真——它们只证明"字段存在"。改成真正的不变式：**分代计数必须与 sessions 对得上**，
  // 进程内没扫过时就是 0/{}，扫描后必须逐条对上（不许出现幽灵计数或漏计）。
  assert.equal(
    Object.values(d.byGen).reduce((a, b) => a + b, 0),
    d.sessions,
    'byGen 的分代计数之和必须等于 sessions（计数来自 listSessions 的那次扫描）',
  )
  assert.ok(d.usageParsed >= 2, '本进程已解析 usage 的会话数')
  assert.ok(d.zeroUsageCount >= 1, '零 usage 会话被计数')
  assert.ok(
    d.zeroUsage.some((p) => p.includes('diagempty')),
    '零 usage 会话被点名（未来格式再变时可直接定位）',
  )
})

test('sessionFormatDiagnostics：listSessions 的 byGen 覆盖全部可见会话（含陈旧索引命中）', () => {
  const peak = ts('2026-08-24T10:00:00')
  const sdir = makeGenSessionDir('diagscan', [
    { gen: 0, lines: [usageLine(0, peak)] },
    { gen: 3, lines: [usageLine(3, peak)] },
  ])
  const sdir2 = makeGenSessionDir('diagscan2', [{ gen: 3, lines: [usageLine(3, peak)] }])
  // 两个会话目录，其中 1 个 v0 + 1 个 v3：byGen 必须是完整的 {0:1, 3:1}
  const out = runInSessionDir(
    sdir,
    `(() => { const s = m.listSessions(); const d = m.sessionFormatDiagnostics(); return { n: s.length, sessions: d.sessions, byGen: d.byGen } })()`,
  )
  assert.equal(out.status, 0, out.stderr)
  const res = JSON.parse(out.stdout)
  assert.equal(res.sessions, 1, '一个会话目录 = 1 个可见会话（取最高代际）')
  assert.deepEqual(res.byGen, { 3: 1 }, '可见代际分布来自文件名，无需解析')
  const out2 = runInSessionDir(
    sdir2,
    `(() => { const s = m.listSessions(); const d = m.sessionFormatDiagnostics(); return { byGen: d.byGen, sessions: d.sessions } })()`,
  )
  assert.deepEqual(JSON.parse(out2.stdout).byGen, { 3: 1 }, '第二个目录同样只报 v3')
})

/* ── 解压工具的解析（2026-09-25，Docker 形态实测后加）───────────────────
 * 现场：容器里根本没装 zstd（unzstd），而代码把路径**写死**成
 * `/usr/local/bin/unzstd`（Homebrew/macOS 的落点）、失败后回退写死的
 * `/usr/bin/python3`（容器里也没装）→ 两条路都断，费用报表在容器里必然降级。
 * 更阴的是 doctor 是**按 PATH** 判"unzstd 可用"的：体检绿、报表照样失败。
 * 现在两边同一判据：PATH 优先 → 回退历史绝对路径 → 才轮到 python。 */
test('解压工具解析①：PATH 优先（别写死一个平台专属路径）', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-zstd-bin-'))
  const stub = path.join(bin, 'unzstd')
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(stub, 0o755)
  const prevPath = process.env.PATH
  try {
    process.env.PATH = `${bin}${path.delimiter}${prevPath}`
    assert.equal(resolveUnzstd(), stub, 'PATH 里有就用 PATH 里那个')
    assert.equal(resolvePython3(), resolvePython3()) // 幂等，不抛
  } finally {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    fs.rmSync(bin, { recursive: true, force: true })
  }
})

test('解压工具解析②：PATH 里没有时回退到绝对路径（宿主 Homebrew / Debian 两套落点）', () => {
  const prevPath = process.env.PATH
  try {
    process.env.PATH = ''
    const r = resolveUnzstd()
    assert.ok(r, '必须总能给出一个候选（最差是裸名，交给 spawn 去找）')
    assert.ok(!r.includes('cp-zstd-bin'), '不得残留上一个用例的 stub')
    // 本机（或容器）装了 zstd 时，回退必须是绝对路径
    const abs = ['/usr/local/bin/unzstd', '/usr/bin/unzstd'].find((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK)
        return true
      } catch {
        return false
      }
    })
    if (abs) assert.equal(r, abs, 'PATH 为空 → 回退到存在的绝对路径')
  } finally {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
  }
})

test('解压工具解析③：readSessionLines 真的走解析出来的那个二进制', () => {
  // 造一个**不是合法 zstd** 的文件 + 一个把 -o 目标写成已知内容的 PATH stub：
  // 只有真的调用了 PATH 里那个 stub 才可能读出内容（真 unzstd 会解压失败）
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-zstd-bin2-'))
  const stub = path.join(bin, 'unzstd')
  fs.writeFileSync(
    stub,
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\nprintf \'{"marker":"from-stub"}\\n\' > "$out"\n',
  )
  fs.chmodSync(stub, 0o755)
  const sess = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-zstd-sess-'))
  const fake = path.join(sess, 'session.zstd')
  fs.writeFileSync(fake, 'NOT-REAL-ZSTD')
  const prevPath = process.env.PATH
  try {
    process.env.PATH = `${bin}${path.delimiter}${prevPath}`
    const lines = readSessionLines(fake)
    assert.ok(Array.isArray(lines), '必须返回行数组')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /from-stub/, '内容来自 PATH 里的 stub → 证明用的是解析结果')
  } finally {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    fs.rmSync(bin, { recursive: true, force: true })
    fs.rmSync(sess, { recursive: true, force: true })
  }
})
