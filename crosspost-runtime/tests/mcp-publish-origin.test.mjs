/**
 * MCP 层来源守卫端到端测试（2026-09-12）
 *
 * 以 stdio JSON-RPC 直驱真实 `mcp-server/index.mjs`，验证「shell 注入的 env 来源标记」如何决定
 * publish_article 的派发行为，以及底层发布工具（sync_article/publish_styled/wechat_draft）的守卫。
 *
 * 零外部副作用：隔离 drafts/articles 目录 + `platforms:[]` + `wechat:false` + `notify:false`
 * （即便守卫失效也不会真的推送任何平台/微信，也不会发飞书通知；claude/LLM 不参与）。
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-mcp-origin-'))
const DRAFTS = path.join(TMP, 'drafts')
const ARTICLES = path.join(TMP, 'articles')
// v2.40：historyDir 也要隔离 —— 删除类操作会经 pushHumanFeedback() 写
// history/editorial-memory.json，漏了就会污染真实部署的编辑记忆。
const HISTORY = path.join(TMP, 'history')
fs.mkdirSync(DRAFTS, { recursive: true })
fs.mkdirSync(HISTORY, { recursive: true })

/** 剔除本进程可能存在的来源标记，保证用例可控；CROSSPOST_NODE 指到当前 node */
function baseEnv(extra = {}) {
  const e = {
    ...process.env,
    CROSSPOST_NODE: process.execPath,
    CROSSPOST_DRAFTS_DIR: DRAFTS,
    CROSSPOST_ARTICLES_DIR: ARTICLES,
    CROSSPOST_HISTORY_DIR: HISTORY,
  }
  delete e.WECHAT_AUTO_SCHEDULED
  delete e.WECHAT_AUTO_DRAFT_ONLY
  return { ...e, ...extra }
}

function writeDraft(name, { title = 'MCP 来源守卫测试', score = 86 } = {}) {
  const file = path.join(DRAFTS, name)
  fs.writeFileSync(file, `---\ntitle: ${title}\nscore: ${score}\n---\n\n正文内容\n\n第二段。\n`)
  return file
}

/** 启动 MCP server（stdio JSON-RPC 客户端最小实现） */
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
  function send(method, params) {
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
    child,
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
    clientInfo: { name: 'crosspost-origin-test', version: '0' },
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

test('MCP 来源：定时链路（WECHAT_AUTO_SCHEDULED=1）⇒ publish_article 只落草稿、不派发', async () => {
  const s = await initServer(baseEnv({ WECHAT_AUTO_SCHEDULED: '1' }))
  try {
    const file = writeDraft('2026-09-12-morning-mcp-scheduled.md')
    const r = toolResult(
      await s.send('tools/call', {
        name: 'publish_article',
        arguments: { file, platforms: [], wechat: false, notify: false },
      }),
    )
    assert.equal(r.isError, false, r.text)
    assert.equal(r.json.origin, 'scheduled', r.text)
    assert.equal(r.json.dispatch, 'skipped', r.text)
    assert.equal(r.json.autoPushEnabled, false, r.text)
    assert.equal(r.json.status, 'draft', r.text)
    assert.match(r.json.skipReason || '', /定时链路/, r.text)
    const last = r.json.record.history[r.json.record.history.length - 1]
    assert.equal(last.action, 'draft-only')
    assert.equal(last.origin, 'scheduled')
    // 留痕：stderr 里能看到本次判定的来源（将来 env 穿透失效时立刻可查）
    assert.match(s.stderr(), /\[mcp\] publish_article origin=scheduled/)
  } finally {
    s.close()
  }
})

test('MCP 来源：无标记（交互式会话）⇒ 视为人工触发，豁免语义保持', async () => {
  const s = await initServer(baseEnv())
  try {
    const file = writeDraft('2026-09-12-morning-mcp-manual.md')
    const r = toolResult(
      await s.send('tools/call', {
        name: 'publish_article',
        arguments: { file, platforms: [], wechat: false, notify: false },
      }),
    )
    assert.equal(r.isError, false, r.text)
    assert.equal(r.json.origin, 'manual', r.text)
    assert.equal(r.json.dispatch, 'dispatched', r.text)
    const last = r.json.record.history[r.json.record.history.length - 1]
    assert.equal(last.action, 'publish')
    assert.match(s.stderr(), /origin=manual/)
  } finally {
    s.close()
  }
})

test('MCP 来源：一键生成（WECHAT_AUTO_DRAFT_ONLY=1）⇒ 直接拒绝发布', async () => {
  const s = await initServer(baseEnv({ WECHAT_AUTO_DRAFT_ONLY: '1' }))
  try {
    const file = writeDraft('2026-09-12-morning-mcp-draftonly.md')
    const r = toolResult(
      await s.send('tools/call', {
        name: 'publish_article',
        arguments: { file, platforms: [], wechat: false, notify: false },
      }),
    )
    assert.equal(r.isError, true, r.text)
    assert.match(r.text, /一键生成/)
    assert.match(r.text, /禁止任何发布调用/)
  } finally {
    s.close()
  }
})

test('MCP 来源：定时链路禁止底层发布工具（sync_article/publish_styled/wechat_draft）', async () => {
  const s = await initServer(baseEnv({ WECHAT_AUTO_SCHEDULED: '1' }))
  try {
    for (const name of ['sync_article', 'publish_styled', 'wechat_draft']) {
      const args =
        name === 'wechat_draft'
          ? { title: 't', markdown: 'm' }
          : { platforms: ['zhihu'], title: 't', markdown: 'm' }
      const r = toolResult(await s.send('tools/call', { name, arguments: args }))
      assert.equal(r.isError, true, `${name} 应被拒绝: ${r.text}`)
      assert.match(r.text, /来源守卫/)
    }
  } finally {
    s.close()
  }
})

test('MCP 工具描述：不再声称「平台派发不受开关限制」', async () => {
  const s = await initServer(baseEnv())
  try {
    const res = await s.send('tools/list', {})
    const tools = res.result.tools || []
    const pa = tools.find((t) => t.name === 'publish_article')
    assert.ok(pa, '未找到 publish_article')
    assert.match(pa.description, /永不豁免/)
    assert.doesNotMatch(pa.description, /平台派发不受/)
  } finally {
    s.close()
  }
})
