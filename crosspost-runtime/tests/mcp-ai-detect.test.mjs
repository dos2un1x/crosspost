/**
 * MCP 层 AI 检测（朱雀）端到端测试（2026-10-05）
 *
 * 为什么要单独一条 MCP 级用例：`ai_detect` 是接入方**定时链路**（`WECHAT_AUTO_SCHEDULED=1`）
 * 里唯一一个"必须照常工作"的外部判分工具 —— 同一条链路上的发布工具会被来源守卫拦下
 * （只落草稿、不派发，见 `mcp-publish-origin.test.mjs`），而检测本身是**只读**的：
 * 它既不该被守卫误伤，也不该在额度/凭证出问题时抛错（那是 `skip`，不是异常）。
 *
 * 零外部副作用：网关是本地起的假服务（`EDGEONE_AI_GATEWAY_BASE` 指过去），
 * 用量台账/缓存都在沙箱 `CROSSPOST_LOCAL_ROOT` 下，不碰真实额度、不碰生产 config。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { AI_DETECT_DEFAULTS } from '../src/ai-detect.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(__dirname, '../mcp-server/index.mjs')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-mcp-aidetect-'))
const LOCAL = path.join(TMP, 'local')
// author: dos2un1x · repo: https://github.com/dos2un1x/crosspost
const DRAFTS = path.join(LOCAL, 'drafts')
const ARTICLES = path.join(LOCAL, 'articles')
const HISTORY = path.join(LOCAL, 'history')
const CFG = path.join(TMP, 'config.json')
for (const d of [DRAFTS, ARTICLES, HISTORY]) fs.mkdirSync(d, { recursive: true })

const monthKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

/** 假网关：记录请求数，返回一个形状完整的朱雀响应（两段：人工 + AI 特征） */
function startFakeGateway() {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: body.slice(0, 80) })
      const payload = JSON.stringify({
        softmax_confidence: 0.9999,
        ratio_confidence: 0.4,
        // 人工 60% / AI 特征 20% / 疑似 20%：默认口径（AI 特征 < 30%）下达标
        labels_ratio: { 0: 0.6, 1: 0.2, 2: 0.2 },
        segment_labels: [
          { order: 1, label: 0, position: [0, 300], conf: 0.9 },
          { order: 2, label: 0, position: [300, 600], conf: 0.8 },
        ],
        usage: { total_tokens: 1000 },
        makers_models_usage: { total_tokens: 1700 },
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(payload)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ base: `http://127.0.0.1:${port}`, calls, close: () => server.close() })
    })
  })
}

/** 正文必须 > minChars（默认 350），否则判 text-too-short 拿不到判定 */
const LONG_TEXT = `## 小标题\n\n${'这是一段用来测定时链路检测的正文，包含具体数字与结论。'.repeat(18)}\n`

function baseEnv(extra = {}) {
  const e = {
    ...process.env,
    CROSSPOST_NODE: process.execPath,
    CROSSPOST_LOCAL_ROOT: LOCAL,
    CROSSPOST_CONFIG: CFG,
    CROSSPOST_DRAFTS_DIR: DRAFTS,
    CROSSPOST_ARTICLES_DIR: ARTICLES,
    CROSSPOST_HISTORY_DIR: HISTORY,
  }
  delete e.WECHAT_AUTO_SCHEDULED
  delete e.WECHAT_AUTO_DRAFT_ONLY
  return { ...e, ...extra }
}

/** 启动 MCP server（stdio JSON-RPC 客户端最小实现，与 mcp-publish-origin.test.mjs 同构） */
function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  let stderr = ''
  const waiters = new Map()
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const w = waiters.get(msg.id)
      if (w) {
        waiters.delete(msg.id)
        w(msg)
      }
    }
  })
  child.stderr.on('data', (d) => {
    stderr += d
  })
  let seq = 0
  const send = (method, params) => {
    seq += 1
    const rid = seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP 响应超时: ${method}`)), 120000)
      waiters.set(rid, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method, params })}\n`)
    })
  }
  return {
    send,
    notify: (method, params) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    stderr: () => stderr,
    close: () => child.kill('SIGKILL'),
  }
}

async function initServer(env) {
  const s = startServer(env)
  const init = await s.send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'crosspost-aidetect-test', version: '0' },
  })
  assert.ok(init.result, `initialize 失败: ${JSON.stringify(init).slice(0, 400)}`)
  s.notify('notifications/initialized', {})
  return s
}

/** tools/call 结果 → { isError, text, json }（CLI 返回体是 JSON 字符串） */
function toolResult(res) {
  assert.ok(res.result, `tools/call 失败: ${JSON.stringify(res).slice(0, 400)}`)
  const item = (res.result.content || []).find((c) => c.type === 'text')
  const text = item ? item.text : ''
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON（错误文案） */
  }
  return { isError: !!res.result.isError, text, json }
}

/** 沙箱 config：把网关指到假服务，其余与出厂默认一致 */
function writeSandboxConfig(gateway, aiOverrides = {}) {
  const aiDetect = {
    ...AI_DETECT_DEFAULTS,
    gateway,
    ...aiOverrides,
    gate: { ...AI_DETECT_DEFAULTS.gate, ...(aiOverrides.gate || {}) },
  }
  fs.writeFileSync(CFG, JSON.stringify({ aiDetect }, null, 2), 'utf8')
  return aiDetect
}

test('MCP / 定时链路：ai_detect 不被来源守卫误伤，照常出判定且只报不拦', async () => {
  const gw = await startFakeGateway()
  writeSandboxConfig(gw.base)
  const s = await initServer(
    baseEnv({
      WECHAT_AUTO_SCHEDULED: '1',
      ZHUQUE_API_KEY: 'test-key',
      EDGEONE_AI_GATEWAY_BASE: gw.base,
    }),
  )
  try {
    const r = toolResult(
      await s.send('tools/call', { name: 'ai_detect', arguments: { text: LONG_TEXT } }),
    )
    assert.equal(r.isError, false, r.text)
    assert.equal(r.json.verdict, 'pass', r.text)
    // 默认口径：单指标上界（AI 特征 20% < 阈值 30%）
    assert.equal(r.json.metric, 'labels_ai', r.text)
    assert.equal(r.json.value, 0.2, r.text)
    assert.equal(r.json.threshold, 0.3, r.text)
    // 三段占比仍随结果返回（观察用）——门禁不压它，但日志/复盘要看得到
    assert.equal(r.json.labelsRatio.ai, 0.2, r.text)
    // observe：调用方自己决定要不要改，引擎不代做，也不阻止后续动作
    assert.equal(r.json.action, 'observe', r.text)
    assert.equal(gw.calls.length, 1, '定时链路下必须真的发出一次检测请求')
    // 台账已记账（记账口径取 makers_models_usage.total_tokens = 1700）
    const usage = JSON.parse(fs.readFileSync(path.join(LOCAL, 'ai-detect-usage.json'), 'utf8'))
    assert.equal(usage.tokens, 1700)
    assert.equal(usage.calls, 1)
  } finally {
    s.close()
    gw.close()
  }
})

test('MCP / 定时链路：额度用尽 ⇒ skip/budget-exhausted，且零请求', async () => {
  const gw = await startFakeGateway()
  writeSandboxConfig(gw.base, { monthlyTokenBudget: 100 })
  // 台账里已累计超过预算 —— 定时链路无人值守，这里必须"跳过"而不是抛错（照常出稿并显式标注）
  fs.writeFileSync(
    path.join(LOCAL, 'ai-detect-usage.json'),
    JSON.stringify({ month: monthKey(), tokens: 999, calls: 3 }),
    'utf8',
  )
  const s = await initServer(
    baseEnv({
      WECHAT_AUTO_SCHEDULED: '1',
      ZHUQUE_API_KEY: 'test-key',
      EDGEONE_AI_GATEWAY_BASE: gw.base,
    }),
  )
  try {
    const r = toolResult(
      await s.send('tools/call', { name: 'ai_detect', arguments: { text: LONG_TEXT } }),
    )
    assert.equal(r.isError, false, r.text)
    assert.equal(r.json.verdict, 'skip', r.text)
    assert.equal(r.json.reason, 'budget-exhausted', r.text)
    assert.equal(gw.calls.length, 0, '超预算不得发起请求')
    assert.match(r.json.snapshot || '', /AI检测=未检测 · 额度已用尽（budget-exhausted）/, r.text)
  } finally {
    s.close()
    gw.close()
  }
})

test('MCP：ai_detect record=true 把判定写进文章记录（未发布稿也有 AI 检测）', async () => {
  // 背景：`aiDetect` 的唯一写入者本来是发布器，而 draft-only 链路从不调它 ——
  // 于是"这篇的朱雀判定是多少"在文章库里没有落点（Console 那张卡永远空白）。
  const gw = await startFakeGateway()
  writeSandboxConfig(gw.base)
  const id = '2099-01-01-noon-mcp-record'
  fs.writeFileSync(
    path.join(DRAFTS, `${id}.md`),
    `---\ntitle: 记账用例\nscore: 90\nrisk: none\n---\n\n${LONG_TEXT}`,
  )
  const s = await initServer(
    baseEnv({ ZHUQUE_API_KEY: 'test-key', EDGEONE_AI_GATEWAY_BASE: gw.base }),
  )
  try {
    const r = toolResult(
      await s.send('tools/call', {
        name: 'ai_detect',
        arguments: { id, record: true, note: '第2轮复检' },
      }),
    )
    assert.equal(r.isError, false, r.text)
    assert.equal(r.json.verdict, 'pass', r.text)
    assert.equal(r.json.recorded && r.json.recorded.id, id, r.text)
    assert.equal(r.json.recorded.action, 'ai-detect')
    // 记录里写的必须与返回的 snapshot 逐字一致（判据同源，面板与日志对得上）
    const rec = JSON.parse(fs.readFileSync(path.join(ARTICLES, `${id}.json`), 'utf8'))
    assert.equal(rec.aiDetect, r.json.snapshot)
    const hist = (rec.history || []).filter((h) => h.action === 'ai-detect')
    assert.equal(hist.length, 1, JSON.stringify(rec.history))
    assert.equal(hist[0].aiDetect, r.json.snapshot)
    assert.equal(hist[0].verdict, 'pass')
    assert.equal(hist[0].note, '第2轮复检')

    // 不带 record 时一个字节都不写（避免"顺手改簿记"）
    const before = JSON.stringify(rec)
    const r2 = toolResult(await s.send('tools/call', { name: 'ai_detect', arguments: { id } }))
    assert.equal(r2.isError, false, r2.text)
    assert.equal(r2.json.recorded, undefined, '没要记账就不该回 recorded')
    assert.equal(
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(ARTICLES, `${id}.json`), 'utf8'))),
      before,
    )

    // 裸文本没有文章记录 → 明确报错，别静默不记
    const bad = toolResult(
      await s.send('tools/call', {
        name: 'ai_detect',
        arguments: { text: LONG_TEXT, record: true },
      }),
    )
    assert.equal(bad.isError, true, bad.text)
    assert.match(bad.text, /--record 只能用于 --file \/ --id/)
  } finally {
    s.close()
    gw.close()
  }
})
