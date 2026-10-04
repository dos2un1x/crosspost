/**
 * 内容域 `project` 维度接线契约测试（v2.22）
 *
 * 锁死两件最容易搞坏的事：
 *
 * ① **向后兼容铁律**：不指定项目时，草稿目录 / 文章库目录的返回值必须与接线前
 *    **逐字一致**。P0/P1 的整个价值就在于"引入多项目不让单项目部署失效"，
 *    这条一旦破，生产定时链路的落盘位置就会漂移。
 *
 * ② **上下文隔离**：项目上下文是**请求级**的，并发请求之间不得串味。
 *    AsyncLocalStorage 的核心保证，但必须有用例钉住——否则将来有人把它换成
 *    模块级全局变量，测试要能立刻报警。
 *
 * 另外覆盖：未注册项目回退默认（不抛错）、`--project=` 参数摘除、请求头/查询参数
 * 优先级，以及 **HTTP 层真的把 header 传到了 CLI**（用隔离端口的真实 bridge 验证，
 * 单测只验证到解析函数是自欺欺人）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  PROJECT_FLAG,
  withProject,
  currentProject,
  hasProjectContext,
  extractProjectFlag,
  projectFromRequest,
  currentProjectDataDir,
  currentProjectStoreDir,
} from '../src/project-context.mjs'
import { getDraftsDir, getArticlesDir } from '../src/articles.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const BRIDGE = path.join(REPO, 'bridge', 'run-bridge.mjs')

/* ────────────────────────── ① 隔离夹具 ────────────────────────── */

/** 造一个完全隔离的环境：独立 projects 根 + 默认 drafts + 独立文章库 */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-projctx-'))

  const projectsRoot = path.join(root, 'projects')
  const p1 = path.join(projectsRoot, 'alpha')
  fs.mkdirSync(path.join(p1, '.crosspost'), { recursive: true })
  fs.mkdirSync(path.join(p1, 'drafts'), { recursive: true })
  fs.writeFileSync(
    path.join(p1, '.crosspost', 'project.json'),
    JSON.stringify({
      id: 'alpha',
      name: '甲项目',
      manifestVersion: 1,
      capabilities: { drafts: true },
      dataDir: 'drafts',
    }),
  )
  fs.writeFileSync(path.join(p1, 'drafts', '2099-01-01-noon-alpha.md'), '---\ntitle: alpha\n---\nx')

  const defaultDrafts = path.join(root, 'drafts')
  fs.mkdirSync(defaultDrafts, { recursive: true })
  fs.writeFileSync(
    path.join(defaultDrafts, '2099-01-02-noon-default.md'),
    '---\ntitle: default\n---\ny',
  )

  // 第三个项目：manifest **有效**，但声明的 dataDir 不存在（数据源不可达）。
  // 用来钉住"宁可显示为空，不可显示为别人的内容"这条安全性质——见 v2.33。
  const broken = path.join(projectsRoot, 'broken')
  fs.mkdirSync(path.join(broken, '.crosspost'), { recursive: true })
  fs.writeFileSync(
    path.join(broken, '.crosspost', 'project.json'),
    JSON.stringify({
      id: 'broken',
      name: '数据源不可达的项目',
      manifestVersion: 1,
      capabilities: { drafts: true },
      dataDir: 'nowhere',
    }),
  )

  return {
    root,
    projectsRoot,
    projectDrafts: path.join(p1, 'drafts'),
    brokenDeclaredDrafts: path.join(broken, 'nowhere'),
    defaultDrafts,
    articles: path.join(root, 'articles'),
    localRoot: path.join(root, 'local'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

const box = makeSandbox()

// 环境变量必须在**导入后立刻**设置：paths/config 是懒解析的（每次调用读 env），
// 而 projects.mjs 也读 env，所以在用例里设置同样生效。
const saved = {}
const setEnv = (k, v) => {
  if (!(k in saved)) saved[k] = process.env[k]
  process.env[k] = v
}
setEnv('CROSSPOST_PROJECTS_DIRS', box.projectsRoot)
setEnv('CROSSPOST_DRAFTS_DIR', box.defaultDrafts)
setEnv('CROSSPOST_ARTICLES_DIR', box.articles)
setEnv('CROSSPOST_LOCAL_ROOT', box.localRoot)
// v2.40：historyDir 一并隔离（删除类操作会写 editorial-memory.json）
setEnv('CROSSPOST_HISTORY_DIR', path.join(box.root, 'history'))

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  box.cleanup()
})

/* ────────────────────── ② 向后兼容铁律（最重要） ────────────────────── */

test('无项目上下文时，默认目录解析与接线前逐字一致', () => {
  assert.equal(hasProjectContext(), false)
  assert.equal(currentProject(), '')
  assert.equal(getDraftsDir(), box.defaultDrafts)
  assert.equal(getArticlesDir(), box.articles)
})

test('withProject("") / undefined 不建立上下文（零开销、行为不变）', () => {
  for (const v of ['', null, undefined, '   ']) {
    const r = withProject(v, () => ({
      ctx: hasProjectContext(),
      drafts: getDraftsDir(),
      store: getArticlesDir(),
    }))
    assert.equal(r.ctx, false, `空值 ${JSON.stringify(v)} 不该建立上下文`)
    assert.equal(r.drafts, box.defaultDrafts)
    assert.equal(r.store, box.articles)
  }
})

/* ────────────────────── ③ 显式 projectId 解析 ────────────────────── */

test('getDraftsDir(projectId) 走注册表；未注册时回退默认且不抛错', () => {
  assert.equal(getDraftsDir('alpha'), box.projectDrafts)
  assert.equal(getDraftsDir('不存在的项目'), box.defaultDrafts)
})

test('getArticlesDir(projectId) 落到引擎簿记目录（不写进接入项目仓库）', () => {
  const dir = getArticlesDir('alpha')
  assert.equal(dir, path.join(box.localRoot, 'project-state', 'alpha', 'articles'))
  // 关键性质：簿记目录不在项目目录里（项目只需按契约提供 drafts）
  assert.equal(dir.startsWith(box.projectsRoot), false)
})

/* ────────────────────── ④ 请求级上下文 ────────────────────── */

test('withProject 内所有解析自动落到该项目（同步 + 异步链）', async () => {
  await withProject('alpha', async () => {
    assert.equal(currentProject(), 'alpha')
    assert.equal(currentProjectDataDir(), box.projectDrafts)
    assert.equal(getDraftsDir(), box.projectDrafts)
    assert.equal(getArticlesDir(), path.join(box.localRoot, 'project-state', 'alpha', 'articles'))
    // 跨 await / setTimeout：上下文必须存活
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(getDraftsDir(), box.projectDrafts)
  })
  // 出栈即失效
  assert.equal(getDraftsDir(), box.defaultDrafts)
})

test('未注册项目：上下文存在但解析失败 → 回退默认（不抛错）', async () => {
  await withProject('ghost', async () => {
    assert.equal(currentProject(), 'ghost')
    assert.equal(currentProjectDataDir(), null)
    assert.equal(currentProjectStoreDir(), null)
    assert.equal(getDraftsDir(), box.defaultDrafts)
    assert.equal(getArticlesDir(), box.articles)
  })
})

test('并发上下文互不串味（这是 AsyncLocalStorage 的核心保证）', async () => {
  const seen = []
  await Promise.all([
    withProject('alpha', async () => {
      await new Promise((r) => setTimeout(r, 10))
      seen.push(['alpha', getDraftsDir()])
    }),
    (async () => {
      await new Promise((r) => setTimeout(r, 5))
      seen.push(['none', getDraftsDir()])
    })(),
    withProject('ghost', async () => {
      await new Promise((r) => setTimeout(r, 1))
      seen.push(['ghost', getDraftsDir()])
    }),
  ])
  const m = Object.fromEntries(seen)
  assert.equal(m.alpha, box.projectDrafts)
  assert.equal(m.none, box.defaultDrafts)
  assert.equal(m.ghost, box.defaultDrafts)
})

test('嵌套上下文以最内层为准，出栈后外层恢复', () => {
  withProject('alpha', () => {
    assert.equal(getDraftsDir(), box.projectDrafts)
    withProject('ghost', () => {
      assert.equal(getDraftsDir(), box.defaultDrafts)
    })
    assert.equal(getDraftsDir(), box.projectDrafts)
  })
})

/* ────────────────────── ⑤ 标志与请求解析 ────────────────────── */

test('extractProjectFlag 摘除标志且不扰动其余参数顺序', () => {
  assert.deepEqual(extractProjectFlag(['listArticles', '--project=alpha', '--x']), {
    project: 'alpha',
    args: ['listArticles', '--x'],
  })
  // styles 子命令的位置参数必须原样保留
  assert.deepEqual(extractProjectFlag(['styles', 'delete', 'x', '--project=alpha']).args, [
    'styles',
    'delete',
    'x',
  ])
  assert.deepEqual(extractProjectFlag(['a', 'b']), { project: '', args: ['a', 'b'] })
  // 空值不算声明
  assert.equal(extractProjectFlag(['--project=']).project, '')
  assert.equal(extractProjectFlag(['--project=  ']).project, '')
  // 多个时最后一个生效（后者覆盖前者，符合命令行习惯）
  assert.equal(extractProjectFlag(['--project=a', '--project=b']).project, 'b')
  assert.deepEqual(extractProjectFlag(null), { project: '', args: [] })
})

test('projectFromRequest 优先级：请求头 > 查询参数 > 请求体', () => {
  const H = (v) => ({ headers: { 'x-crosspost-project': v } })
  assert.equal(projectFromRequest(H('h'), 'b'), 'h')
  assert.equal(
    projectFromRequest({ headers: {}, query: new URLSearchParams('project=q') }, 'b'),
    'q',
  )
  assert.equal(projectFromRequest({ headers: {} }, 'b'), 'b')
  assert.equal(projectFromRequest({ headers: {} }), '')
  assert.equal(projectFromRequest({ headers: {} }, '   '), '')
  // 大小写两种头名都要认（Node 规范化前/后的调用方都可能）
  assert.equal(projectFromRequest({ headers: { 'X-CrossPost-Project': 'u' } }), 'u')
})

test('PROJECT_FLAG 是唯一的 CLI 透传形态', () => {
  assert.equal(PROJECT_FLAG, '--project=')
})

/* ────────────────── ⑥ HTTP 层端到端（真实 bridge，隔离端口） ────────────────── */

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let bridge = null
let base = ''
let token = ''

before(async () => {
  for (let attempt = 0; attempt < 4 && !bridge; attempt++) {
    const ws = await freePort()
    const http = ws + 1
    const proc = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        SYNC_PROXY_WS_PORT: String(ws),
        CROSSPOST_EVER_AUTHED_PATH: path.join(box.root, 'ever-authed.json'),
        CROSSPOST_PLATFORMS_STATE_PATH: path.join(box.root, 'platforms-state.json'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let ok = false
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      await sleep(120)
      try {
        const r = await fetch(`http://127.0.0.1:${http}/proxy/bootstrap`)
        if (r.ok) {
          const d = await r.json()
          if (d && d.token) {
            token = d.token
            ok = true
            break
          }
        }
      } catch {
        /* 还没起来 */
      }
    }
    if (ok) {
      bridge = proc
      base = `http://127.0.0.1:${http}`
    } else {
      proc.kill('SIGKILL')
    }
  }
  assert.ok(bridge, '隔离 bridge 未能启动（端口争用？）')
})

after(() => {
  if (bridge) bridge.kill('SIGKILL')
})

const ids = async (extraHeaders = {}, qs = '') => {
  const r = await fetch(`${base}/proxy/articles${qs}`, {
    headers: { 'X-CrossPost-Token': token, ...extraHeaders },
  })
  assert.equal(r.status, 200)
  const d = await r.json()
  return (d.articles || []).map((a) => a.id).sort()
}

test('HTTP：不带项目 → 默认草稿目录', async () => {
  assert.deepEqual(await ids(), ['2099-01-02-noon-default'])
})

test('HTTP：X-CrossPost-Project 请求头生效（Console 走的就是这条）', async () => {
  assert.deepEqual(await ids({ 'X-CrossPost-Project': 'alpha' }), ['2099-01-01-noon-alpha'])
})

test('HTTP：?project= 查询参数生效（第三方/curl 友好）', async () => {
  assert.deepEqual(await ids({}, '?project=alpha'), ['2099-01-01-noon-alpha'])
})

test('HTTP：无效项目回退默认且不报错（引入多项目不打断既有调用）', async () => {
  assert.deepEqual(await ids({ 'X-CrossPost-Project': 'ghost' }), ['2099-01-02-noon-default'])
})

test('HTTP：请求头优先于查询参数', async () => {
  assert.deepEqual(await ids({ 'X-CrossPost-Project': 'alpha' }, '?project=ghost'), [
    '2099-01-01-noon-alpha',
  ])
})

test('HTTP：项目隔离后的文章库记录写在引擎簿记目录，不污染默认文章库', async () => {
  await ids({ 'X-CrossPost-Project': 'alpha' }) // 触发一次 scanAndList（会登记记录）
  const projStore = path.join(box.localRoot, 'project-state', 'alpha', 'articles')
  assert.ok(
    fs.existsSync(path.join(projStore, '2099-01-01-noon-alpha.json')),
    '项目记录应落在引擎簿记目录',
  )
  assert.equal(
    fs.existsSync(path.join(box.articles, '2099-01-01-noon-alpha.json')),
    false,
    '默认文章库不该出现项目 alpha 的记录',
  )
})

/* ──────────── ⑦ 写路径隔离（读对了不代表写也对） ──────────── */

/**
 * 这一段是本次接线里**最该测**的部分：读错了只是显示错，写错了会动错文件。
 * `runArchiveArticle` 会把草稿 `renameSync` 到 `drafts/archive/`——如果 project
 * 没传到 CLI 子进程，归档就会落到**默认草稿目录**里去，属于真实的跨项目破坏。
 */
const post = async (pathname, body, extraHeaders = {}) => {
  const r = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      'X-CrossPost-Token': token,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
  assert.equal(r.status, 200)
  return r.json()
}

test('HTTP 写路径：带项目归档 → 文件只在该项目目录内移动，默认目录不受影响', async () => {
  const projDraft = path.join(box.projectDrafts, '2099-01-01-noon-alpha.md')
  const defaultDraft = path.join(box.defaultDrafts, '2099-01-02-noon-default.md')
  const projArchive = path.join(box.projectDrafts, 'archive', '2099-01-01-noon-alpha.md')
  assert.ok(fs.existsSync(projDraft), '前置：项目草稿存在')
  assert.ok(!fs.existsSync(projArchive), '前置：项目归档目录下还没有它')

  const r = await post(
    '/proxy/archive',
    { id: '2099-01-01-noon-alpha', action: 'archive' },
    { 'X-CrossPost-Project': 'alpha' },
  )
  assert.ok(!r.error, `归档不该报错：${JSON.stringify(r)}`)

  assert.ok(fs.existsSync(projArchive), '项目草稿应被移入项目的 drafts/archive/')
  assert.equal(fs.existsSync(projDraft), false, '原位置应已不存在')
  assert.ok(fs.existsSync(defaultDraft), '默认草稿目录必须一字未动（跨项目破坏检测）')

  // 恢复现场，避免影响后续用例与"项目列表"断言
  const back = await post(
    '/proxy/archive',
    { id: '2099-01-01-noon-alpha', action: 'restore' },
    { 'X-CrossPost-Project': 'alpha' },
  )
  assert.ok(!back.error, `撤销归档不该报错：${JSON.stringify(back)}`)
  assert.ok(fs.existsSync(projDraft), '撤销归档后应回到项目草稿顶层')
})

test('HTTP 写路径：不带项目归档 → 只动默认目录（单项目部署行为不变）', async () => {
  const defaultDraft = path.join(box.defaultDrafts, '2099-01-02-noon-default.md')
  const defaultArchive = path.join(box.defaultDrafts, 'archive', '2099-01-02-noon-default.md')

  const r = await post('/proxy/archive', { id: '2099-01-02-noon-default', action: 'archive' })
  assert.ok(!r.error, `归档不该报错：${JSON.stringify(r)}`)
  assert.ok(fs.existsSync(defaultArchive), '默认草稿应被移入默认 drafts/archive/')

  const back = await post('/proxy/archive', { id: '2099-01-02-noon-default', action: 'restore' })
  assert.ok(!back.error)
  assert.ok(fs.existsSync(defaultDraft))
})

/* ──── ⑧ 数据源不可达的项目：宁可空视图，不可显示别人的内容（v2.33） ──── */

/**
 * 这一段的由来：此前 `getDraftsDir(projectId)` 走 `resolveProjectDataDir()`，
 * 它对"manifest 有效但 dataDir 不存在"也返回 error → **回退默认目录**。
 * 后果是用户选中一个数据源不可达的项目，看到的却是**默认目录的文章**，
 * 而界面写着该项目名；写操作（归档/留存/发布）更会落到那个目录里。
 *
 * 现在：注册且有效的项目**永远用它声明的路径**（不存在就是空视图）；
 * 只有"未注册 / manifest 无效"才回退默认（向后兼容）。
 */
test('注册但数据源不可达的项目：用声明路径（空视图），不回退到默认目录', () => {
  assert.equal(getDraftsDir('broken'), box.brokenDeclaredDrafts)
  assert.notEqual(getDraftsDir('broken'), box.defaultDrafts, '绝不能回退到别人的草稿目录')
})

test('显式传参与请求级上下文对同一项目给出**一致**的目录', () => {
  for (const id of ['alpha', 'broken', 'not-registered']) {
    const explicit = getDraftsDir(id)
    const contextual = withProject(id, () => getDraftsDir())
    assert.equal(explicit, contextual, `项目 ${id}：显式与上下文必须一致`)
  }
})

test('HTTP：选中数据源不可达的项目 → 空列表（而不是默认目录的文章）', async () => {
  const r = await fetch(`${base}/proxy/articles`, {
    headers: { 'X-CrossPost-Token': token, 'X-CrossPost-Project': 'broken' },
  })
  assert.equal(r.status, 200, '不可达不该变成 500——视图空着，桥仍然健康')
  const d = await r.json()
  assert.deepEqual(
    (d.articles || []).map((a) => a.id),
    [],
    '不能把默认项目的文章当成该项目的文章显示出来',
  )
})

/* ──── ⑨ 跨源预检必须放行 X-CrossPost-Project（v2.35） ──── */

/**
 * 背景：`Access-Control-Allow-Headers` 此前只列了 `Content-Type, X-CrossPost-Token`。
 * v2.22 起内容域多了 `X-CrossPost-Project`——**自定义头必须被显式放行**，
 * 否则浏览器预检失败、请求根本发不出去。curl 不受影响，同源的 Console 也不走预检，
 * 所以这个洞只在"真浏览器 + 跨源"时暴露——正是最容易漏测的那种组合。
 */
test('CORS 预检放行 X-CrossPost-Project（否则跨源浏览器调用方发不出请求）', async () => {
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
  const r = await fetch(`${base}/proxy/articles`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'x-crosspost-token,x-crosspost-project',
    },
  })
  assert.equal(r.status, 204, '预检应返回 204')
  assert.equal(r.headers.get('access-control-allow-origin'), origin)
  const allowed = (r.headers.get('access-control-allow-headers') || '').toLowerCase()
  assert.ok(allowed.includes('x-crosspost-token'), `应放行 token：${allowed}`)
  assert.ok(
    allowed.includes('x-crosspost-project'),
    `必须放行 X-CrossPost-Project，否则文档承诺的请求头用法对浏览器侧不成立：${allowed}`,
  )
})
