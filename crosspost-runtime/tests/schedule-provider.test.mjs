// 槽位执行器能力（2026-09-25）：`capabilities.schedule` 的解析、策略、调用与记账
//
// ## 这里钉的是什么
//
// 基座对「一键生成」做过一次边界迁移：**不在自己进程里跑接入方的业务脚本**，
// 改成"项目声明 HTTP 端点、引擎只做编排"（见 generate-provider.test.mjs）。
// 槽位执行器是同一处边界的最后一格，本文件钉住它：
//
//   ① 没声明 / 声明 `true` → 仍走**本地命令执行器**（向后兼容，行为逐字节不变）
//   ② 声明成 `{kind:'http',…}` → 解析出端点；**声明即生效**
//   ③ 声明了但不可用（非环回未登记 / 字段不合法 / kind 未知）→ 报"执行器不可用"，
//      **绝不回落**到本地 spawn（回落会让边界重新变模糊 —— 这正是 18:10 那次
//      容器故障的成因：基座在自己的命名空间里跑项目的业务脚本）
//   ④ 调用层：受理(202) → 轮询 → 归一成 `exit/durationMs`；失败也要能记账
//   ⑤ 执行器记账写进与本地 spawn **同一套** journal（`started`/`finished` + exit），
//      否则界面会退化成那句"今日已跑"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  callScheduleProvider,
  cancelScheduleProvider,
  resolveScheduleProvider,
  toSpecExecutor,
} from '../src/schedule-provider.mjs'
import { createRunner } from '../src/scheduler/runner.mjs'
import { mergeSlotSpecs } from '../src/scheduler/spec.mjs'
import { MANIFEST_VERSION } from '../src/projects.mjs'

/* ── 沙箱：所有路径落在临时目录，绝不碰生产 ───────────────────────── */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-slotsched-'))
const PROJECTS = path.join(SANDBOX, 'projects')
fs.mkdirSync(PROJECTS, { recursive: true })

process.env.CROSSPOST_LOCAL_ROOT = path.join(SANDBOX, 'local')
process.env.CROSSPOST_SCHEDULER_DIR = path.join(SANDBOX, 'scheduler')
process.env.CROSSPOST_PROJECTS_DIR = PROJECTS
process.env.CROSSPOST_PROJECTS_DIRS = PROJECTS
process.env.CROSSPOST_CONFIG = path.join(SANDBOX, 'config-none.json')
delete process.env.CROSSPOST_HOST_GATEWAY

/** 每个 config 用不同文件名：config-cache 按 mtime 缓存，同文件同毫秒会命中旧值 */
function useConfig(name, obj) {
  const p = path.join(SANDBOX, `config-${name}.json`)
  fs.writeFileSync(p, JSON.stringify(obj, null, 2))
  process.env.CROSSPOST_CONFIG = p
}
function useNoConfig() {
  process.env.CROSSPOST_CONFIG = path.join(SANDBOX, 'config-none.json')
}

function writeProject(id, { capabilities = {}, dataDir } = {}) {
  const dir = path.join(PROJECTS, id)
  fs.mkdirSync(path.join(dir, '.crosspost'), { recursive: true })
  const m = { id, name: `项目 ${id}`, manifestVersion: MANIFEST_VERSION, capabilities }
  if (dataDir) {
    fs.mkdirSync(path.join(dir, dataDir), { recursive: true })
    m.dataDir = dataDir
  }
  fs.writeFileSync(path.join(dir, '.crosspost', 'project.json'), JSON.stringify(m, null, 2))
  return dir
}

/* ── 真 HTTP 服务（契约那一侧） ─────────────────────────────────── */

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  )
}
async function withServer(handler, fn) {
  const server = http.createServer(handler)
  const port = await listen(server)
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve(null)
      }
    })
  })
}
function providerFor(url, extra = {}) {
  return {
    provided: true,
    kind: 'http',
    url,
    statusUrl: null,
    cancelUrl: null,
    requestUrl: url,
    requestStatusUrl: null,
    requestCancelUrl: null,
    gateway: null,
    timeoutMs: 2000,
    pollIntervalMs: 50,
    overallTimeoutMs: 5000,
    tokenEnv: null,
    projectId: null,
    source: '测试内联',
    ...extra,
  }
}

/* ══════════════ 一、解析：三种形态 ══════════════ */

test('解析①：未声明 / 声明 true → 本地命令执行器（向后兼容，executor=null）', () => {
  writeProject('p-none', { capabilities: { drafts: true }, dataDir: 'drafts' })
  writeProject('p-true', { capabilities: { schedule: true }, dataDir: 'drafts' })

  const none = resolveScheduleProvider('p-none')
  assert.equal(none.provided, false)
  assert.equal(none.code, 'schedule_not_declared')
  assert.equal(toSpecExecutor(none), null)

  const t = resolveScheduleProvider('p-true')
  assert.equal(t.provided, false)
  assert.equal(t.code, 'schedule_local_true')
  assert.equal(toSpecExecutor(t), null, 'true ≡ 旧的本地命令执行器')
})

test('解析②：声明 http → 解析出端点与默认参数（声明即生效）', () => {
  writeProject('p-http', {
    capabilities: {
      schedule: {
        kind: 'http',
        url: 'http://127.0.0.1:8788/slot/run',
        statusUrl: 'http://127.0.0.1:8788/slot/status',
      },
    },
    dataDir: 'drafts',
  })
  const r = resolveScheduleProvider('p-http')
  assert.equal(r.provided, true)
  assert.equal(r.kind, 'http')
  assert.equal(r.url, 'http://127.0.0.1:8788/slot/run')
  assert.equal(r.statusUrl, 'http://127.0.0.1:8788/slot/status')
  assert.ok(r.pollIntervalMs >= 250)
  const spec = toSpecExecutor(r)
  assert.equal(spec.kind, 'http')
  assert.equal(spec.unavailable, undefined)
})

test('策略①：默认**拒绝**非环回端点，且不回落到本地命令', () => {
  writeProject('p-remote', {
    capabilities: { schedule: { kind: 'http', url: 'http://10.0.0.9:8788/slot/run' } },
    dataDir: 'drafts',
  })
  const r = resolveScheduleProvider('p-remote')
  assert.equal(r.provided, false)
  assert.equal(r.code, 'schedule_endpoint_blocked')
  const spec = toSpecExecutor(r)
  assert.equal(spec.kind, 'http')
  assert.equal(spec.unavailable, true, '声明了但不可用 → 不允许回落本地 spawn')
  assert.match(spec.reason, /策略拒绝/)
})

test('策略②：引擎配置 slotExecutor.allowHosts 可放行指定主机', () => {
  useConfig('allow-host', { slotExecutor: { allowHosts: ['10.0.0.9:8788'] } })
  writeProject('p-remote2', {
    capabilities: { schedule: { kind: 'http', url: 'http://10.0.0.9:8788/slot/run' } },
    dataDir: 'drafts',
  })
  const r = resolveScheduleProvider('p-remote2')
  assert.equal(r.provided, true)
  useNoConfig()
})

test('解析③：字段不合法 / kind 未知 → 明确报错（不是静默当本地命令）', () => {
  // `{kind:'http'}` 缺 url 会在 **manifest 校验**就被拦下（项目整体判无效）——
  // 比"运行到一半才发现"更早，两种落法都必须让执行器不可用、且不得回落本地命令。
  writeProject('p-nourl', { capabilities: { schedule: { kind: 'http' } }, dataDir: 'drafts' })
  writeProject('p-kind', {
    capabilities: { schedule: { kind: 'stdio', url: 'http://127.0.0.1:1/x' } },
    dataDir: 'drafts',
  })
  const a = resolveScheduleProvider('p-nourl')
  assert.equal(a.provided, false)
  assert.ok(
    ['schedule_invalid', 'project_invalid'].includes(a.code),
    `缺 url 应被拦下，实际 code=${a.code}`,
  )
  assert.equal(toSpecExecutor(a).unavailable, true)
  const b = resolveScheduleProvider('p-kind')
  assert.equal(b.provided, false)
  assert.ok(
    ['schedule_kind_unknown', 'project_invalid'].includes(b.code),
    `kind 未知应被拦下，实际 code=${b.code}`,
  )
  assert.equal(toSpecExecutor(b).unavailable, true)
})

test('宿主网关：容器形态把回环改写成 host.docker.internal（策略仍判声明值）', () => {
  writeProject('p-gw', {
    capabilities: { schedule: { kind: 'http', url: 'http://127.0.0.1:8788/slot/run' } },
    dataDir: 'drafts',
  })
  const before = resolveScheduleProvider('p-gw')
  assert.equal(before.provided, true)
  assert.equal(before.requestUrl, 'http://127.0.0.1:8788/slot/run')
  assert.equal(before.gateway, null)

  process.env.CROSSPOST_HOST_GATEWAY = 'host.docker.internal'
  try {
    const after = resolveScheduleProvider('p-gw')
    assert.equal(after.provided, true, '重写发生在策略之后，不影响放行')
    assert.equal(after.requestUrl, 'http://host.docker.internal:8788/slot/run')
    assert.deepEqual(after.gateway, { from: '127.0.0.1', to: 'host.docker.internal' })
  } finally {
    delete process.env.CROSSPOST_HOST_GATEWAY
  }
})

/* ══════════════ 二、调用层：受理 → 轮询 → 归一 ══════════════ */

test('调用①：异步契约（202 running → status done）→ ok + exit 0', async () => {
  await withServer(
    async (req, res) => {
      if (req.method === 'POST' && req.url === '/slot/run') {
        const body = await readBody(req)
        assert.equal(body.slot, 'tips')
        assert.ok(body.runId, '契约要求带上 runId（项目侧据此认出是哪一班）')
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ taskId: 't1', state: 'running' }))
        return
      }
      if (req.method === 'GET' && req.url.startsWith('/slot/status')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            taskId: 't1',
            state: 'done',
            exit: 0,
            durationMs: 12345,
            logFile: '/tmp/run.log',
            logTail: 'hello',
          }),
        )
        return
      }
      res.writeHead(404).end()
    },
    async (base) => {
      const p = providerFor(`${base}/slot/run`, { statusUrl: `${base}/slot/status` })
      const r = await callScheduleProvider(p, { slot: 'tips', date: '2026-09-25', runId: 'r1' })
      assert.equal(r.ok, true)
      assert.equal(r.exit, 0)
      assert.equal(r.durationMs, 12345)
      assert.equal(r.logTail, 'hello')
    },
  )
})

test('调用②：项目侧 state=failed → ok:false 且带 exit（失败必须能记账）', async () => {
  await withServer(
    async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          taskId: 't2',
          state: 'failed',
          exit: 7,
          message: 'dsh 起不来',
          durationMs: 34000,
        }),
      )
    },
    async (base) => {
      const p = providerFor(`${base}/slot/run`)
      const r = await callScheduleProvider(p, { slot: 'tips', runId: 'r2' })
      assert.equal(r.ok, false)
      assert.equal(r.exit, 7)
      assert.match(r.message, /dsh 起不来/)
    },
  )
})

test('调用③：端点不可达 → slot_provider_unreachable（绝不静默成功）', async () => {
  const p = providerFor('http://127.0.0.1:1/slot/run', { timeoutMs: 800 })
  const r = await callScheduleProvider(p, { slot: 'tips' })
  assert.equal(r.ok, false, '失败必须显式 ok:false，调用方要用它记账')
  assert.equal(r.error, 'slot_provider_unreachable')
})

test('调用④：返回 running 但未声明 statusUrl → 明确报错（不允许"接了就不知道下文"）', async () => {
  await withServer(
    async (req, res) => {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ taskId: 't3', state: 'running' }))
    },
    async (base) => {
      const p = providerFor(`${base}/slot/run`)
      const r = await callScheduleProvider(p, { slot: 'tips' })
      assert.equal(r.error, 'slot_provider_no_status')
      assert.match(r.message, /statusUrl/)
    },
  )
})

test('调用⑤：3xx 不接受跳转（白名单不可被重定向绕过）', async () => {
  await withServer(
    async (req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:9/evil' })
      res.end()
    },
    async (base) => {
      const r = await callScheduleProvider(providerFor(`${base}/slot/run`), { slot: 'tips' })
      assert.equal(r.error, 'slot_provider_redirect')
    },
  )
})

test('取消：未声明 cancelUrl → not-supported（尽力而为，不假装成功）', async () => {
  const r = await cancelScheduleProvider(providerFor('http://127.0.0.1:1/x'), 'task')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-supported')
})

/* ══════════════ 三、记账：与本地 spawn 同一套 journal ══════════════ */

test('记账①：远程槽位写 started/finished（含 exit/时长），界面无需改动', async () => {
  await withServer(
    async (req, res) => {
      const body = req.method === 'POST' ? await readBody(req) : null
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          body
            ? { taskId: 't9', state: 'running' }
            : { taskId: 't9', state: 'done', exit: 0, durationMs: 4321 },
        ),
      )
    },
    async (base) => {
      // 关键：执行器是**运行时重新解析**的（拿当下策略与网关），所以 manifest 必须
      // 指向这个测试服务 —— 这也顺带钉住了"spec 里带的 executor 只是展示/分派用"。
      // 轮询间隔取校验下限 250ms（manifest 校验要求 ≥250）。
      writeProject('p-live', {
        capabilities: {
          schedule: {
            kind: 'http',
            url: `${base}/slot/run`,
            statusUrl: `${base}/slot/status`,
            pollIntervalMs: 250,
          },
        },
        dataDir: 'drafts',
      })
      const dir = path.join(SANDBOX, 'proj-runner')
      fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
      const runner = createRunner({})
      const spec = {
        key: 'p-live|tips',
        id: 'tips',
        scope: 'project',
        projectId: 'p-live',
        projectRoot: dir,
        tz: 'Asia/Shanghai',
        logDir: path.join(dir, 'logs'),
        command: null,
        executor: { kind: 'http', url: `${base}/slot/run`, statusUrl: `${base}/slot/status` },
      }
      const res = runner.start(spec, { trigger: 'schedule' })
      assert.equal(res.ok, true, '远程执行器对调用方是同步受理语义（与 spawn 一致）')
      assert.equal(res.remote, true)
      assert.equal(runner.isRunning(spec.key), true)

      for (let i = 0; i < 200 && runner.isRunning(spec.key); i++)
        await new Promise((r) => setTimeout(r, 25))
      assert.equal(runner.isRunning(spec.key), false, '轮询结束后必须摘掉 running')

      // 直接扫 scheduler 目录找这个 runId（不依赖时区/日期键）
      const dirSched = process.env.CROSSPOST_SCHEDULER_DIR
      const entries = []
      for (const f of fs.readdirSync(dirSched)) {
        if (!f.startsWith('runs-')) continue
        for (const line of fs.readFileSync(path.join(dirSched, f), 'utf8').split('\n')) {
          if (!line.trim()) continue
          const j = JSON.parse(line)
          if (j.runId === res.runId) entries.push(j)
        }
      }
      const started = entries.find((e) => e.phase === 'started')
      const finished = entries.find((e) => e.phase === 'finished')
      assert.ok(started, '必须先写 started（有头无尾是重启后不重跑的判据）')
      assert.equal(started.executor, 'http')
      assert.equal(started.command, null)
      assert.ok(started.url.startsWith(base), 'journal 里要留下端点，否则运维无从查起')
      assert.ok(finished, '远程跑完必须写 finished')
      assert.equal(finished.exit, 0)
      assert.equal(finished.durationMs, 4321)
      // 面包屑：项目回报的 logTail 落到本地 scheduler-<槽位>.out.log，老习惯仍成立
      const breadcrumb = fs.readFileSync(path.join(dir, 'logs', 'scheduler-tips.out.log'), 'utf8')
      assert.match(breadcrumb, /远程执行器/)
    },
  )
})

test('记账②：执行器不可用（声明被策略拒绝）→ 记 finished + error，且不 spawn', async () => {
  const dir = path.join(SANDBOX, 'proj-blocked')
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
  writeProject('p-blocked2', {
    capabilities: { schedule: { kind: 'http', url: 'http://10.0.0.9:8788/slot/run' } },
    dataDir: 'drafts',
  })
  const runner = createRunner({})
  const res = runner.start({
    key: 'p-blocked2|tips',
    id: 'tips',
    scope: 'project',
    projectId: 'p-blocked2',
    projectRoot: dir,
    tz: 'Asia/Shanghai',
    logDir: path.join(dir, 'logs'),
    command: null,
    executor: { kind: 'http', unavailable: true, reason: '端点被策略拒绝' },
  })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'executor-unavailable')
})

/* ══════════════ 四、规格层：命令与执行器的取舍 ══════════════ */

test('规格①：http 执行器下"命令可用"换成"端点可用"，且不要求声明 command', () => {
  writeProject('p-spec-h', {
    capabilities: { schedule: { kind: 'http', url: 'http://127.0.0.1:8788/slot/run' } },
    dataDir: 'drafts',
  })
  const executor = toSpecExecutor(resolveScheduleProvider('p-spec-h'))
  const { specs, warnings } = mergeSlotSpecs({
    projectId: 'p-spec-h',
    projectRoot: path.join(PROJECTS, 'p-spec-h'),
    declaration: { slots: { tips: { time: '18:10', name: '热点解读③' } } },
    configSlots: [],
    scheduleMap: {},
    tz: 'Asia/Shanghai',
    executor,
    logsDir: path.join(PROJECTS, 'p-spec-h', 'logs'),
  })
  const tips = specs.find((s) => s.id === 'tips')
  assert.ok(tips)
  assert.equal(tips.command, null, '远程执行器不需要本地命令')
  assert.equal(tips.commandAvailable, true)
  assert.equal(tips.commandReason, null)
  assert.equal(tips.executor.kind, 'http')
  assert.ok(
    !warnings.some((w) => w.includes('没有命令声明')),
    '既然执行在项目那边，就不该再抱怨"没有命令声明"',
  )
})

test('规格②：执行器不可用 → commandAvailable=false + 说清原因（供 Console/doctor）', () => {
  writeProject('p-spec-b', {
    capabilities: { schedule: { kind: 'http', url: 'http://10.0.0.9:8788/x' } },
    dataDir: 'drafts',
  })
  const executor = toSpecExecutor(resolveScheduleProvider('p-spec-b'))
  const { specs } = mergeSlotSpecs({
    projectId: 'p-spec-b',
    projectRoot: path.join(PROJECTS, 'p-spec-b'),
    declaration: { slots: { tips: { time: '18:10' } } },
    configSlots: [],
    scheduleMap: {},
    tz: 'Asia/Shanghai',
    executor,
  })
  const tips = specs.find((s) => s.id === 'tips')
  assert.equal(tips.commandAvailable, false)
  assert.match(tips.commandReason, /执行器不可用/)
})

test('规格③：不传 executor（旧调用点）→ 行为与今天逐字节一致', () => {
  // 声明文件的**校验后形态**：`argv` 由 `validateDeclaration()` 展开（这里直接给）
  const { specs } = mergeSlotSpecs({
    projectId: 'p-legacy',
    projectRoot: path.join(PROJECTS, 'p-legacy'),
    declaration: {
      slots: {
        tips: { time: '18:10', command: ['node', '-e', '0'], argv: [process.execPath, '-e', '0'] },
      },
    },
    configSlots: [],
    scheduleMap: {},
    tz: 'Asia/Shanghai',
  })
  const tips = specs.find((s) => s.id === 'tips')
  assert.equal(tips.executor, null, '不声明执行器的项目仍是本地命令执行器')
  assert.ok(Array.isArray(tips.command))
})
