// 会话级项目环境变量 `CROSSPOST_PROJECT` 这一条路，端到端钉住（v2.65 / Phase 2a）
//
// ## 为什么需要它
//
// 内容域（草稿目录 + 引擎簿记目录）有三条入口，语义必须一致：
//   ① CLI 显式 `--project=<id>`（`extractProjectFlag`）
//   ② HTTP 请求头 `X-CrossPost-Project`（Console 走这条）
//   ③ **会话级环境变量 `CROSSPOST_PROJECT`**（headless / MCP 走这条）
//
// ①② 都有测试（project-context.test.mjs、projects-contract.test.mjs），
// ③ 此前**一条都没有** —— 而定时链路恰恰只用 ③。链路是：
//
//   dsh --profile <接入方 profile>
//     → profile 的 `mcp-crosspost` 行 `config.env: {CROSSPOST_PROJECT: ...}`
//     → 子进程环境（dsh-subprocess 的 scrubbedParentEnv 合并）
//     → mcp-server/index.mjs 的 defaultProject()
//     → 每次 callCli 追加 `--project=<id>`
//     → cli.mjs 的 withProject() → getDraftsDir()/getArticlesDir() 切域
//
// 也就是说，**这是生产在跑、却没人守的一条路**。光"配置里写了 env"不算数：
// `dsh --dump-config` 只能证明配置被解析，证明不了它换了目录。
//
// ## 怎么做到零副作用
//
// ① 引擎层用 `--project=` 直接在临时目录里对照（不碰生产簿记与真实 drafts）。
// ② MCP 层用**已有的** `CROSSPOST_NODE` 接缝（index.mjs:38，2026-09-18 起）
//    把子进程换成探针：`spawn(NODE, [CLI, ...argv])` 于是变成
//    `spawn(探针, [CLI, ...argv])`，探针把**真正的 argv** 原样吐回来。
//    真实 CLI 一次都不会执行 —— 所以连 `publish_article` 这种工具也能安全调用，
//    正好用来验证"工具自带 project 时优先、且不重复追加"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
const CLI = path.join(RUNTIME, 'src', 'cli.mjs')
const SERVER = path.join(RUNTIME, 'mcp-server', 'index.mjs')
const PID = 'env-project'

/** 一次性实验台：项目根 / 引擎 localRoot / 兜底 drafts+articles 全在临时目录里 */
function makeBox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-project-env-'))
  const b = {
    root,
    dataDir: path.join(root, 'project-drafts'),
    local: path.join(root, 'local'),
    projects: path.join(root, 'projects'),
    fallbackDrafts: path.join(root, 'fallback-drafts'),
    fallbackArticles: path.join(root, 'fallback-articles'),
  }
  fs.mkdirSync(path.join(b.projects, PID, '.crosspost'), { recursive: true })
  fs.mkdirSync(b.dataDir, { recursive: true })
  fs.mkdirSync(b.fallbackDrafts, { recursive: true })
  fs.mkdirSync(b.fallbackArticles, { recursive: true })
  fs.writeFileSync(
    path.join(b.projects, PID, '.crosspost', 'project.json'),
    JSON.stringify({
      id: PID,
      name: '会话级项目环境变量测试',
      manifestVersion: 2,
      capabilities: { drafts: true, generate: false },
      dataDir: b.dataDir,
    }),
  )
  // 隔离机器配置：否则本机 config.json 里的 projectsDirs 会漏进来，
  // 让"未注册项目 → 回退默认"这类断言取决于运行机器（v2.55 踩过）
  b.config = path.join(root, 'config.json')
  fs.writeFileSync(b.config, JSON.stringify({ schedule: {} }))
  return b
}

/** 引擎侧共用的环境：全指向临时目录 */
const baseEnv = (b) => ({
  ...process.env,
  CROSSPOST_CONFIG: b.config,
  CROSSPOST_LOCAL_ROOT: b.local,
  CROSSPOST_PROJECTS_DIRS: b.projects,
  CROSSPOST_DRAFTS_DIR: b.fallbackDrafts,
  CROSSPOST_ARTICLES_DIR: b.fallbackArticles,
})

// ─────────────────────────── MCP 层：env → --project= ───────────────────────────

/** 把 CROSSPOST_NODE 换成探针：它会收到 [CLI, ...真实参数]，把参数原样回吐 */
function installProbe(b) {
  b.probe = path.join(b.root, 'probe.mjs')
  fs.writeFileSync(
    b.probe,
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(3) }) + "\\n")\n',
  )
  const sh = path.join(b.root, 'fake-node.sh')
  fs.writeFileSync(
    sh,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(b.probe)} "$@"\n`,
  )
  fs.chmodSync(sh, 0o755)
  return sh
}

/**
 * 起一个真 MCP server（stdio JSON-RPC），调一个工具，返回**它交给子进程的 argv**。
 * 子进程已被探针替换，所以没有任何真实副作用。
 */
async function mcpArgvFor(b, toolName, toolArgs) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...baseEnv(b), CROSSPOST_NODE: installProbe(b) },
  })
  let buf = ''
  const pending = new Map()
  let nextId = 1
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      // 同 cli-ipc/drafts：兜底超时必须清掉，否则每个用例留一个 30s 定时器
      // （实测本文件 32.9s → 6.9s，见 2026-09-28 测试审计）。
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error('timeout: ' + method))
        }
      }, 30000)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n')
    })

  try {
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'session-project-env-test', version: '0.0.1' },
    })
    await send('notifications/initialized', {})
    const r = await send('tools/call', { name: toolName, arguments: toolArgs || {} })
    const content = (r.result && r.result.content) || []
    const text = content.map((c) => c.text || '').join('')
    assert.ok(!r.error, `tools/call 返回错误：${JSON.stringify(r.error)}`)
    const parsed = JSON.parse(text)
    assert.ok(Array.isArray(parsed.argv), `探针未返回 argv（工具输出：${text.slice(0, 200)}）`)
    return parsed.argv
  } finally {
    child.kill('SIGKILL')
  }
}

test('MCP：设了 CROSSPOST_PROJECT，每次 CLI 调用都自动带上 --project=（2a 依赖的正是这条）', async () => {
  const b = makeBox()
  const argv = await (async () => {
    // 单独起一次，只为把 env 传进去
    const saved = process.env.CROSSPOST_PROJECT
    process.env.CROSSPOST_PROJECT = PID
    try {
      return await mcpArgvFor(b, 'projects')
    } finally {
      if (saved === undefined) delete process.env.CROSSPOST_PROJECT
      else process.env.CROSSPOST_PROJECT = saved
    }
  })()
  assert.deepEqual(
    argv,
    ['projects', `--project=${PID}`],
    '会话级项目必须被翻译成 --project= 追加给 CLI（否则定时链路的记录会落到默认簿记）',
  )
})

test('MCP：没设 CROSSPOST_PROJECT 时一个标志都不加（对照组，证明上一条不是恒真）', async () => {
  const b = makeBox()
  const saved = process.env.CROSSPOST_PROJECT
  delete process.env.CROSSPOST_PROJECT
  try {
    const argv = await mcpArgvFor(b, 'projects')
    assert.deepEqual(argv, ['projects'], '未声明项目时必须与接线前逐字一致')
  } finally {
    if (saved !== undefined) process.env.CROSSPOST_PROJECT = saved
  }
})

test('MCP：工具自带 project 参数时优先，且不重复追加两个 --project=', async () => {
  const b = makeBox()
  const saved = process.env.CROSSPOST_PROJECT
  process.env.CROSSPOST_PROJECT = PID
  try {
    // 用 publish_article 是因为它是**唯一**把 project 作为独立参数传给 callCli 的工具；
    // 子进程已被探针替换，所以这里不会真的发布任何东西。
    const reqFile = path.join(b.root, 'pub.json')
    fs.writeFileSync(reqFile, JSON.stringify({ file: '/tmp/does-not-matter.md' }))
    const argv = await mcpArgvFor(b, 'publish_article', {
      file: '/tmp/does-not-matter.md',
      project: 'explicit-project',
    })
    const flags = argv.filter((a) => String(a).startsWith('--project='))
    assert.deepEqual(
      flags,
      ['--project=explicit-project'],
      `工具显式指定的项目应优先于会话级，且只能有一个标志（实际：${JSON.stringify(argv)}）`,
    )
  } finally {
    if (saved === undefined) delete process.env.CROSSPOST_PROJECT
    else process.env.CROSSPOST_PROJECT = saved
  }
})

// ─────────────────────── 引擎层：--project= → 内容域真的切 ───────────────────────

/** 跑一次 createDraft（写草稿文件 + 登记记录），返回两个落点 */
function createDraft(b, { topic, projectFlag }) {
  const req = path.join(b.root, `req-${topic}.json`)
  fs.writeFileSync(
    req,
    JSON.stringify({
      title: '会话级项目探针',
      slot: 'tips',
      date: '2099-01-01',
      topic,
      markdown: '正文',
    }),
  )
  const args = projectFlag ? [`--project=${projectFlag}`, 'createDraft', req] : ['createDraft', req]
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: RUNTIME,
    encoding: 'utf8',
    env: baseEnv(b),
  })
  assert.equal(r.status, 0, `CLI 退出码非 0：${r.stderr || r.stdout}`)
  const out = (() => {
    try {
      return JSON.parse(r.stdout)
    } catch {
      return {}
    }
  })()
  assert.ok(out.id, `未返回 id：${r.stdout}`)
  return {
    id: out.id,
    projectDraft: path.join(b.dataDir, `${out.id}.md`),
    fallbackDraft: path.join(b.fallbackDrafts, `${out.id}.md`),
    projectRecord: path.join(b.local, 'project-state', PID, 'articles', `${out.id}.json`),
    fallbackRecord: path.join(b.fallbackArticles, `${out.id}.json`),
  }
}

test('引擎：--project= 把草稿与簿记**同时**切到项目域', () => {
  const b = makeBox()
  const p = createDraft(b, { topic: 'withproject', projectFlag: PID })

  assert.ok(fs.existsSync(p.projectDraft), `草稿应在项目声明的 dataDir：${p.projectDraft}`)
  assert.ok(fs.existsSync(p.projectRecord), `记录应在项目簿记目录：${p.projectRecord}`)
  // 负向才是"真的切了"的证据：兜底路径一个都不该被写
  assert.equal(fs.existsSync(p.fallbackDraft), false, `草稿不该落在兜底 drafts：${p.fallbackDraft}`)
  assert.equal(
    fs.existsSync(p.fallbackRecord),
    false,
    `记录不该落在兜底 articles：${p.fallbackRecord}`,
  )
})

test('引擎：不带项目时走兜底路径（对照组）', () => {
  const b = makeBox()
  const p = createDraft(b, { topic: 'noproject' })

  assert.ok(fs.existsSync(p.fallbackDraft), `草稿应落在 CROSSPOST_DRAFTS_DIR：${p.fallbackDraft}`)
  assert.ok(
    fs.existsSync(p.fallbackRecord),
    `记录应落在 CROSSPOST_ARTICLES_DIR：${p.fallbackRecord}`,
  )
  assert.equal(fs.existsSync(p.projectDraft), false, '未指定项目时不该写项目 dataDir')
  assert.equal(fs.existsSync(p.projectRecord), false, '未指定项目时不该写项目簿记')
})

test('引擎：项目未注册 → 回退兜底且不报错（把项目 id 写错不该让链路停机）', () => {
  // 契约（articles.mjs getDraftsDir 注释 ②）：未注册/无效 manifest → 回退默认路径，
  // 不打断既有用法。定时链路一旦把项目 id 写错，要的是"照旧能跑"。
  const b = makeBox()
  const p = createDraft(b, { topic: 'ghost', projectFlag: 'no-such-project' })

  assert.ok(fs.existsSync(p.fallbackDraft), '未注册项目应回退到 CROSSPOST_DRAFTS_DIR')
  assert.ok(fs.existsSync(p.fallbackRecord), '未注册项目应回退到 CROSSPOST_ARTICLES_DIR')
  assert.equal(fs.existsSync(p.projectRecord), false, '未注册项目不该写进项目簿记')
})
