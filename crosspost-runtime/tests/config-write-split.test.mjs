// `POST /proxy/config` 的**分层写入**端到端测试（v2.77）
//
// 为什么必须端到端：分层规则在 `config-layers.mjs` 有单测（分类/覆盖/hijack 守卫），
// 但"桥收到 patch 后到底写进了哪个文件"是另一回事——写错文件不会报错，只会让某个项目的
// 设置悄悄改到全局（或反之）。这条路径直接决定生产配置，值得起一次真桥来钉。
//
// 断言：
//   ① 带项目头的 POST：项目级键 → `<localRoot>/project-state/<id>/config.json`
//   ② 同一次 POST 里的引擎级键 → 引擎 `config.json`（不落项目覆盖层）
//   ③ 不带项目头的 POST：项目级键写进引擎 `config.json`（作为所有项目的默认值）
//   ④ GET 返回的是**生效配置**并带 `_scope` 标记
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const BRIDGE = path.join(REPO, 'bridge', 'run-bridge.mjs')
const PID = 'cfg-split'

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cfg-split-'))
const LOCAL = path.join(SANDBOX, 'local')
const PROJECTS = path.join(SANDBOX, 'projects')
const CONFIG = path.join(SANDBOX, 'config.json')
const PROJECT_CONFIG = path.join(LOCAL, 'project-state', PID, 'config.json')

fs.mkdirSync(path.join(PROJECTS, PID, '.crosspost'), { recursive: true })
fs.mkdirSync(path.join(PROJECTS, PID, 'drafts'), { recursive: true })
fs.writeFileSync(
  path.join(PROJECTS, PID, '.crosspost', 'project.json'),
  JSON.stringify({
    id: PID,
    name: '配置分层拆分测试项目',
    manifestVersion: 2,
    capabilities: { drafts: true, generate: false, schedule: true },
    dataDir: 'drafts',
  }),
)
// 槽位声明（v2.3）：**命令只能来自项目声明**，所以沙箱项目要自带一个
// `.crosspost/schedule.json`，动态槽位才有东西可改。
const DECLARATION = path.join(PROJECTS, PID, '.crosspost', 'schedule.json')
fs.writeFileSync(
  DECLARATION,
  JSON.stringify(
    {
      version: 1,
      slots: {
        'probe-route': { name: '路由探针', time: '06:07', command: ['/bin/echo', 'ok'] },
      },
    },
    null,
    2,
  ),
)

fs.writeFileSync(
  CONFIG,
  JSON.stringify({
    proxyMode: true,
    proxyHttpPort: 0,
    concurrency: 2,
    projectsDirs: [PROJECTS],
    // 六个槽位全部显式写死：v2.3 起开关缺省是 fail-open（未设 = 跑），
    // 不写全就无法断言"默认域 vs 项目域"的差异
    schedule: {
      morning: false,
      hotspot: false,
      noon: false,
      hotspot2: false,
      tips: false,
      evening: false,
    },
    notify: { enabled: true, channel: 'lark' },
    platforms: { default: ['zhihu'] },
  }),
)

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

async function startBridge() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wsPort = await freePort()
    const httpPort = wsPort + 1
    const proc = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        CROSSPOST_CONFIG: CONFIG,
        CROSSPOST_LOCAL_ROOT: LOCAL,
        CROSSPOST_PROJECTS_DIRS: PROJECTS,
        CROSSPOST_PROJECTS_DIR: PROJECTS,
        CROSSPOST_DRAFTS_DIR: path.join(SANDBOX, 'drafts'),
        CROSSPOST_ARTICLES_DIR: path.join(SANDBOX, 'articles'),
        CROSSPOST_HISTORY_DIR: path.join(SANDBOX, 'history'),
        CROSSPOST_LOGS_DIR: path.join(SANDBOX, 'logs'),
        SYNC_PROXY_WS_PORT: String(wsPort),
        // v2.3：调度器与旧任务检测都要关进沙箱——桥现在会启动内置定时器，
        // 不隔离就会去抢本机真实的调度锁、并扫真实的 ~/Library/LaunchAgents。
        CROSSPOST_SCHEDULER_DIR: path.join(SANDBOX, 'scheduler'),
        CROSSPOST_LEGACY_TASKS_DIR: path.join(SANDBOX, 'no-legacy-tasks'),
        CROSSPOST_EVER_AUTHED_PATH: path.join(SANDBOX, `ever-authed-${wsPort}.json`),
        CROSSPOST_PLATFORMS_STATE_PATH: path.join(SANDBOX, `state-${wsPort}.json`),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    proc.stderr.on('data', () => {})
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break
      try {
        const r = await fetch(`http://127.0.0.1:${httpPort}/proxy/bootstrap`)
        if (r.ok) return { proc, httpPort, boot: await r.json() }
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    proc.kill()
  }
  return null
}

test('桥：带项目头 → 项目级键进覆盖层、引擎级键进引擎配置；不带项目头 → 进默认层', async () => {
  const started = await startBridge()
  // 2026-09-28 测试审计：原先是 `t.skip('桥未能在 3 次尝试内就绪')` —— 本文件只有这一个 test，
  // 端口一抖就变成"显示通过、实际什么都没验"。星号：桥起不来是**基础设施故障**，
  // 不是"本机缺生产数据"，所以应当判红。同时把重试从 3 次提到 5 次降低抖动概率。
  assert.ok(started, '桥未能在 5 次尝试内就绪（本测试会失去全部判据，故判红而不是跳过）')
  const { proc, httpPort, boot } = started
  const token = boot.token
  const H = { 'Content-Type': 'application/json', 'X-CrossPost-Token': token }
  const post = (body, project) =>
    fetch(`http://127.0.0.1:${httpPort}/proxy/config`, {
      method: 'POST',
      headers: project ? { ...H, 'X-CrossPost-Project': project } : H,
      body: JSON.stringify(body),
    }).then((r) => r.json())

  try {
    // ① + ② 带项目头：一次 POST 里两类键各归各的文件
    const r1 = await post({ schedule: { tips: true }, proxyHttpPort: 9711 }, PID)
    assert.equal(r1.ok, true, JSON.stringify(r1))
    const engineCfg = readJson(CONFIG)
    const projCfg = readJson(PROJECT_CONFIG)
    assert.equal(engineCfg.proxyHttpPort, 9711, '引擎级键应写进引擎 config')
    assert.equal(
      engineCfg.schedule.tips,
      false,
      '带项目头时，项目级键**不该**落到引擎 config（那会改到所有项目）',
    )
    assert.equal(projCfg.schedule.tips, true, '项目级键应写进项目覆盖层')
    assert.equal(projCfg.proxyHttpPort, undefined, '引擎级键不该出现在项目覆盖层')

    // ④ GET 返回生效配置 + 作用域标记
    const got = await fetch(`http://127.0.0.1:${httpPort}/proxy/config`, {
      headers: { ...H, 'X-CrossPost-Project': PID },
    }).then((r) => r.json())
    assert.equal(got.schedule.tips, true, 'GET 应返回叠加后的生效值')
    assert.equal(got.proxyHttpPort, 9711)
    assert.equal(got._scope.project, PID)
    assert.deepEqual(got._scope.overridden, ['schedule'])

    // ④+ 排程跟随项目：它读的是**生效**配置（项目覆盖层 > 引擎层）。
    //
    // 2026-09-25：原来这里读 `/proxy/workflow` 的 schedule 节点来钉这件事（"工作流页跟随项目"）；
    // 该页与端点已删除，改为直接钉 `/proxy/schedule` 的两个作用域读数（下方 stScoped/stDefault），
    // 断言强度不变：同一份引擎配置 + 不同项目覆盖层 → 两个作用域读到的配置必须不同。
    await post(
      {
        schedule: {
          morning: false,
          hotspot: true,
          noon: true,
          hotspot2: false,
          tips: true,
          evening: false,
        },
      },
      PID,
    )
    const stScoped = await fetch(`http://127.0.0.1:${httpPort}/proxy/schedule`, {
      headers: { ...H, 'X-CrossPost-Project': PID },
    }).then((r) => r.json())
    const stDefault = await fetch(`http://127.0.0.1:${httpPort}/proxy/schedule`, {
      headers: H,
    }).then((r) => r.json())
    assert.deepEqual(
      stScoped.config,
      { morning: false, hotspot: true, noon: true, hotspot2: false, tips: true, evening: false },
      '项目域应读到项目覆盖层的 schedule',
    )
    assert.deepEqual(
      stDefault.config,
      { morning: false, hotspot: false, noon: false, hotspot2: false, tips: false, evening: false },
      '默认域应读到引擎 config 的 schedule（两者必须不同）',
    )

    // ④ 动态槽位走路由（v2.3）：命令来自项目声明，路由只改名称/时间/开关
    const up = await fetch(`http://127.0.0.1:${httpPort}/proxy/schedule/upsert`, {
      method: 'POST',
      headers: { ...H, 'X-CrossPost-Project': PID },
      body: JSON.stringify({ id: 'probe-route', name: '路由探针', time: '6:7', enabled: false }),
    }).then((r) => r.json())
    assert.equal(up.ok, true, JSON.stringify(up))
    assert.equal(up.time, '06:07')
    assert.equal(up.backend, 'internal', 'v2.3 的后端只有一个：引擎自带定时器')
    const overlayAfterUpsert = readJson(PROJECT_CONFIG)
    assert.ok(
      (overlayAfterUpsert.slots || []).some((x) => x.id === 'probe-route'),
      '槽位定义应写进**项目覆盖层**',
    )
    assert.equal(overlayAfterUpsert.schedule['probe-route'], false)
    assert.equal(
      readJson(CONFIG).slots,
      undefined,
      '槽位定义不该写进引擎 config（那是默认层，会串到别的项目）',
    )

    // 声明过的槽位**不允许**从引擎侧删除（命令在项目仓库里，引擎不越界改写）
    const rm = await fetch(`http://127.0.0.1:${httpPort}/proxy/schedule/remove`, {
      method: 'POST',
      headers: { ...H, 'X-CrossPost-Project': PID },
      body: JSON.stringify({ slot: 'probe-route' }),
    }).then((r) => r.json())
    assert.equal(rm.error, 'declared_slot_not_removable', JSON.stringify(rm))
    assert.match(rm.message, /schedule\.json/, '错误里要给出该改哪个文件')
    assert.ok(
      (readJson(PROJECT_CONFIG).slots || []).some((x) => x.id === 'probe-route'),
      '拒绝删除后覆盖层里的槽位定义必须原样保留',
    )
    assert.ok(fs.existsSync(DECLARATION), '项目声明文件不得被引擎改动')

    // 未声明的槽位：upsert 结构化拒绝（引擎不替项目编造命令）
    const up2 = await fetch(`http://127.0.0.1:${httpPort}/proxy/schedule/upsert`, {
      method: 'POST',
      headers: { ...H, 'X-CrossPost-Project': PID },
      body: JSON.stringify({ id: 'ghost', name: '幽灵', time: '07:00' }),
    }).then((r) => r.json())
    assert.equal(up2.error, 'no_slot_spec', JSON.stringify(up2))
    assert.match(up2.message, /schedule\.json/)

    // ③ 不带项目头：项目级键写进引擎 config（默认层）
    const r2 = await post({ notify: { channel: 'off' } })
    assert.equal(r2.ok, true, JSON.stringify(r2))
    assert.equal(readJson(CONFIG).notify.channel, 'off', '默认域的项目级键写引擎 config')
    assert.equal(readJson(PROJECT_CONFIG).notify, undefined, '不带项目头时不该新建/改动项目覆盖层')
  } finally {
    proc.kill()
    fs.rmSync(SANDBOX, { recursive: true, force: true })
  }
})
