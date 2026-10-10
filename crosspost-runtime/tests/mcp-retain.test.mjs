/**
 * MCP 层留存 `retain_article`（2026-10-09）
 *
 * 为什么单测这条：写作 agent 此前用 `node cli.mjs retainArticle …` 走 shell，而它在
 * workspace-write 沙箱里跑 —— 文件能移进 `drafts/rejected/`，**引擎簿记写不进去**（EPERM），
 * 于是 Console 那一行没有留存原因、抽屉显示「⚠ 无记录」、`verify:immutable` 把这次移动判成删除。
 * MCP 面由**引擎进程**写记录，这条路必须真的落盘，所以这里断言到"记录里有 status/dir/reason"，
 * 而不是只看工具返回 ok。
 *
 * 零外部副作用：草稿/记录/配置都在临时沙箱里，不触网、不碰生产簿记。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(__dirname, '../mcp-server/index.mjs')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-mcp-retain-'))
const LOCAL = path.join(TMP, 'local')
const DRAFTS = path.join(TMP, 'drafts')
const ARTICLES = path.join(LOCAL, 'articles')
const HISTORY = path.join(TMP, 'history')
const CFG = path.join(TMP, 'config.json')
for (const d of [DRAFTS, ARTICLES, HISTORY]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(CFG, JSON.stringify({}, null, 2), 'utf8')

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
  delete e.CROSSPOST_PROJECT
  return { ...e, ...extra }
}

/** 启动 MCP server（stdio JSON-RPC 最小客户端，与 mcp-ai-detect.test.mjs 同构） */
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
      const timer = setTimeout(() => reject(new Error(`MCP 响应超时: ${method}`)), 60000)
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
    clientInfo: { name: 'crosspost-retain-test', version: '0' },
  })
  assert.ok(init.result, `initialize 失败: ${JSON.stringify(init).slice(0, 400)}`)
  s.notify('notifications/initialized', {})
  return s
}

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

function writeDraft(id, { score = 90, risk = 'none' } = {}) {
  const file = path.join(DRAFTS, `${id}.md`)
  fs.writeFileSync(
    file,
    `---\ntitle: 测试稿 ${id}\nscore: ${score}\nrisk: ${risk}\n---\n\n正文。\n`,
  )
  return file
}

const recordOf = (id) => JSON.parse(fs.readFileSync(path.join(ARTICLES, `${id}.json`), 'utf8'))

test('retain_article：移入低分库并把记录写进**引擎进程**（沙箱里的 shell 做不到这件事）', async () => {
  const id = '2026-10-09-hotspot-mcp-retain-ok'
  const file = writeDraft(id)
  const s = await initServer(baseEnv())
  try {
    const r = toolResult(
      await s.send('tools/call', {
        name: 'retain_article',
        arguments: { id, reason: 'AI检测=超标 · AI特征 47.2% ≥ 30.0% · 轮数用尽' },
      }),
    )
    assert.equal(r.isError, false, r.text)
    assert.equal(r.json.ok, true, r.text)
    assert.equal(r.json.dir, 'rejected')
    // 文件真的移走了，且记录真的落盘了（这两件事以前会脱节）
    assert.equal(fs.existsSync(file), false, '草稿应已离开 drafts/ 顶层')
    const moved = path.join(DRAFTS, 'rejected', `${id}.md`)
    assert.equal(fs.existsSync(moved), true, '草稿应在 drafts/rejected/')

    const rec = recordOf(id)
    assert.equal(rec.status, 'retained')
    assert.equal(rec.retainedDir, 'rejected')
    assert.equal(rec.dir, 'rejected')
    assert.match(rec.retainedReason, /AI特征 47\.2% ≥ 30\.0%/)
    assert.equal(rec.file, moved)
    assert.ok(
      (rec.history || []).some((h) => h.action === 'retain' && h.dir === 'rejected'),
      JSON.stringify(rec.history),
    )
  } finally {
    s.close()
  }
})

test('retain_article：dir=risk 进风险库；缺 id 时工具报错而不是静默', async () => {
  const id = '2026-10-09-hotspot-mcp-retain-risk'
  writeDraft(id, { risk: 'ad' })
  const s = await initServer(baseEnv())
  try {
    const r = toolResult(
      await s.send('tools/call', {
        name: 'retain_article',
        arguments: { id, dir: 'risk', reason: '风险命中: ad' },
      }),
    )
    assert.equal(r.isError, false, r.text)
    assert.equal(r.json.dir, 'risk')
    assert.equal(fs.existsSync(path.join(DRAFTS, 'risk', `${id}.md`)), true)
    assert.equal(recordOf(id).retainedDir, 'risk')

    // 缺 id 由 schema 层挡下（zod 必填）——比进 handler 再报错更早
    const bad = toolResult(await s.send('tools/call', { name: 'retain_article', arguments: {} }))
    assert.equal(bad.isError, true, bad.text)
    assert.match(bad.text, /Invalid arguments|Required at id/)
  } finally {
    s.close()
  }
})

// author: dos2un1x · repo: https://github.com/dos2un1x/crosspost
