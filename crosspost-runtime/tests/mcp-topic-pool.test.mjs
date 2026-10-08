// MCP 面：`topic_pool_upsert` 工具的端到端契约（真起一次 stdio server）
//
// 为什么值得单独测：这个工具的**全部价值**就在"形状在调用边界被挡住"——
// 工具清单里要能看到字段（模型据此填），漏字段要在**写盘之前**被拒。
// 只测引擎函数测不到这两点（那是 CLI 面的事）。
//
// 做法与 doctor 的握手探针同源：raw JSON-RPC over stdio，不引 SDK 客户端；
// 沙箱用一个临时项目（CROSSPOST_PROJECTS_DIRS + CROSSPOST_PROJECT），
// 于是选题库落在沙箱的 `<项目>/history/topic-pool.json`，不碰真项目。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
// 作者：dos2un1x · 项目：https://github.com/dos2un1x/crosspost
const SERVER = path.join(RUNTIME, 'mcp-server', 'index.mjs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-mcp-topic-pool-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

/** 造一个沙箱项目（工作区 = <box>/projects/pa），返回 env 与选题库路径 */
function makeBox() {
  const root = fs.mkdtempSync(path.join(tmp, 'box-'))
  const local = path.join(root, 'local')
  const projects = path.join(root, 'projects')
  const config = path.join(root, 'config.json')
  const pathsFile = path.join(root, 'paths.json')
  const projDir = path.join(projects, 'pa')
  fs.mkdirSync(path.join(projDir, '.crosspost'), { recursive: true })
  fs.mkdirSync(path.join(projDir, 'drafts'), { recursive: true })
  fs.mkdirSync(path.join(projDir, 'history'), { recursive: true })
  fs.writeFileSync(
    path.join(projDir, '.crosspost', 'project.json'),
    JSON.stringify({
      id: 'pa',
      name: 'MCP 选题库测试项目',
      manifestVersion: 2,
      capabilities: { drafts: true, generate: false },
      dataDir: 'drafts',
    }),
  )
  fs.writeFileSync(config, JSON.stringify({ schedule: {} }))
  fs.writeFileSync(
    pathsFile,
    JSON.stringify({
      localRoot: local,
      logsDir: path.join(root, 'logs'),
      historyDir: path.join(root, 'history'),
      topicPoolFile: path.join(root, 'topic-pool.json'),
    }),
  )
  return {
    root,
    projDir,
    poolFile: path.join(projDir, 'history', 'topic-pool.json'),
    env: {
      ...process.env,
      CROSSPOST_CONFIG: config,
      CROSSPOST_PATHS: pathsFile,
      CROSSPOST_LOCAL_ROOT: local,
      CROSSPOST_PROJECTS_DIRS: projects,
      CROSSPOST_PROJECTS_DIR: projects,
      CROSSPOST_PROJECT: 'pa',
      CROSSPOST_TOPIC_POOL: path.join(root, 'topic-pool.json'),
    },
  }
}

/** 起一个真 MCP server，提供 rpc(id, method, params) 与关闭 */
async function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env })
  let buf = ''
  const pending = new Map()
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        p(msg)
      }
    }
  })
  const rpc = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`rpc 超时: ${method} ${stderr.slice(0, 200)}`)),
        60000,
      )
      pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  await rpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'crosspost-test', version: '1' },
  })
  return {
    rpc,
    close: () =>
      new Promise((r) => {
        child.on('close', r)
        child.kill('SIGKILL')
      }),
  }
}

test('MCP：topic_pool_upsert 在工具清单里，且 rows 的字段形状写进了 schema', async () => {
  const box = makeBox()
  const srv = await startServer(box.env)
  try {
    const list = await srv.rpc(2, 'tools/list', {})
    const tools = list.result.tools
    const tool = tools.find((t) => t.name === 'topic_pool_upsert')
    assert.ok(tool, `工具清单里应有 topic_pool_upsert，实际有 ${tools.length} 个工具`)
    const schema = tool.inputSchema
    assert.deepEqual(schema.required.sort(), ['date', 'rows', 'slot'])
    const row = schema.properties.rows.items
    assert.deepEqual(
      row.required.sort(),
      ['keyword', 'reason', 'score', 'status', 'title'],
      'title 必须是**必填**字段：漏了它就是当初写坏数据的那类错',
    )
    assert.deepEqual(row.properties.status.enum, ['adopted', 'generated', 'rejected'])
    assert.match(row.properties.title.description, /必须给|空串/)
  } finally {
    await srv.close()
  }
})

test('MCP：合法候选写入沙箱项目的选题库（对象行 → 落盘字段正确）', async () => {
  const box = makeBox()
  const srv = await startServer(box.env)
  try {
    const call = await srv.rpc(3, 'tools/call', {
      name: 'topic_pool_upsert',
      arguments: {
        date: '2026-10-04',
        slot: 'hotspot',
        rows: [
          { keyword: '采用候选', title: '标题一', score: 95, status: 'adopted', reason: '' },
          { keyword: '落选候选', title: '', score: 82, status: 'rejected', reason: '时效陈旧' },
        ],
      },
    })
    assert.ok(!call.result.isError, `不该报错：${JSON.stringify(call.result).slice(0, 300)}`)
    const out = JSON.parse(call.result.content[0].text)
    assert.equal(out.ok, true)
    assert.deepEqual(out.added, ['采用候选', '落选候选'])
    assert.equal(out.project, 'pa', '项目来自连接配置的 CROSSPOST_PROJECT')

    const pool = JSON.parse(fs.readFileSync(box.poolFile, 'utf8'))
    assert.equal(pool.topics.length, 2)
    const rejected = pool.topics.find((t) => t.keyword === '落选候选')
    assert.deepEqual(
      {
        title: rejected.title,
        topicScore: rejected.topicScore,
        status: rejected.status,
        reason: rejected.reason,
      },
      { title: '', topicScore: 82, status: 'rejected', reason: '时效陈旧' },
      '字段必须各就各位（错位正是要防的那类事故）',
    )
    assert.equal(rejected.id, '2026-10-04-hotspot-02')
  } finally {
    await srv.close()
  }
})

test('MCP：漏 title 在写盘之前被挡（工具调用即失败，池子零变化）', async () => {
  const box = makeBox()
  const srv = await startServer(box.env)
  try {
    const bad = await srv.rpc(4, 'tools/call', {
      name: 'topic_pool_upsert',
      arguments: {
        date: '2026-10-04',
        slot: 'hotspot',
        rows: [{ keyword: 'k', score: 88, status: 'rejected', reason: 'r' }],
      },
    })
    const failed = bad.error || bad.result?.isError
    assert.ok(failed, `漏 title 必须失败，实际：${JSON.stringify(bad).slice(0, 300)}`)
    assert.equal(fs.existsSync(box.poolFile), false, '被拒的调用不许落盘')
  } finally {
    await srv.close()
  }
})
