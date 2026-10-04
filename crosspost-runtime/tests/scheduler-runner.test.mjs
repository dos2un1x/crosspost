// 执行器 / 运行记录 / 单实例锁 / 调度器编排（v2.3，调度子系统）
//
// ## 这里钉住的是"真的会发生什么"
//
// 上层策略（什么时候该跑）在 scheduler-timer.test.mjs 里穷举了。这一层管的是
// **跑起来之后**：
//   · 先写 intent 再 spawn（崩在中间也留得下"有头无尾"的证据）
//   · 日志文件名与旧 launchd 任务一致（`scheduler-<槽位>.out.log`）——既有排查习惯不变
//   · 同槽位不重叠；并发上限由编排层兜
//   · 单实例锁：两个宿主只能有一个 arm（否则每天的计划各跑一遍）
//   · 编排层：到点触发一次、当天不再触发、桥不在时不 arm
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import {
  acquireLock,
  appendRun,
  heartbeatLock,
  newRunId,
  pidAlive,
  readDay,
  readLock,
  releaseLock,
  schedulerDir,
  slotDayState,
} from '../src/scheduler/store.mjs'
import { createRunner } from '../src/scheduler/runner.mjs'
import { createScheduler } from '../src/scheduler/index.mjs'
import { tzDayKey } from '../src/tz.mjs'

/** 每个用例一个沙箱：`CROSSPOST_SCHEDULER_DIR` 是唯一需要隔离的东西（其余走显式注入） */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-sched-store-'))
  const prev = process.env.CROSSPOST_SCHEDULER_DIR
  process.env.CROSSPOST_SCHEDULER_DIR = path.join(dir, 'scheduler')
  return {
    dir,
    done() {
      if (prev === undefined) delete process.env.CROSSPOST_SCHEDULER_DIR
      else process.env.CROSSPOST_SCHEDULER_DIR = prev
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 假子进程：可控地"跑完"（不真起进程，测试才快且确定） */
function fakeChild(pid = 4242) {
  const child = new EventEmitter()
  child.pid = pid
  child.kill = () => {
    child.emit('exit', null, 'SIGTERM')
    return true
  }
  child.finish = (code = 0) => child.emit('exit', code, null)
  child.fail = (msg) => child.emit('error', new Error(msg))
  return child
}

const specOf = (over = {}) => ({
  key: 'p|hotspot',
  scope: 'project',
  projectId: 'p',
  projectRoot: '/tmp/p',
  id: 'hotspot',
  name: '热点',
  time: '08:30',
  tz: 'Asia/Shanghai',
  enabled: true,
  command: ['/bin/echo', 'hi'],
  cwd: null,
  env: {},
  logDir: null,
  commandAvailable: true,
  ...over,
})

/**
 * 运行记录按**槽位时区**的日键落盘（runner 内部用 `tzDayKey(spec.tz, …)`），
 * 而 `new Date().toISOString()` 是 **UTC** 日键 —— 北京时间 00:00–08:00 之间两者不同日
 * （2026-09-25 那个时段实证：执行器①/③ 假红，改成按同一函数取键后稳定）。
 */
const DAY = (ts = Date.now()) => tzDayKey(specOf().tz, ts)

test('运行记录①：先 intent 后结果；同一天读回来能区分"跑完"与"没跑完"', () => {
  const box = sandbox()
  try {
    const day = '2026-09-24'
    const runId = newRunId()
    appendRun({ v: 1, runId, key: 'p|a', trigger: 'schedule', phase: 'started', day, startedAt: 1 })
    let st = slotDayState('p|a', day)
    assert.equal(st.unfinished, true, '只有 started → 未收尾')
    assert.equal(st.completed, false)
    appendRun({
      v: 1,
      runId,
      key: 'p|a',
      trigger: 'schedule',
      phase: 'finished',
      day,
      startedAt: 1,
      endedAt: 2,
      exit: 0,
      durationMs: 1,
    })
    st = slotDayState('p|a', day)
    assert.equal(st.unfinished, false)
    assert.equal(st.completed, true)
    assert.equal(st.lastExit, 0)
    assert.equal(readDay(day).length, 2)
  } finally {
    box.done()
  }
})

test('运行记录②：人工触发**不占**"每天一次"的名额（否则手动补跑等于取消今天）', () => {
  const box = sandbox()
  try {
    const day = '2026-09-24'
    const runId = newRunId()
    appendRun({ v: 1, runId, key: 'p|a', trigger: 'manual', phase: 'started', day, startedAt: 1 })
    appendRun({
      v: 1,
      runId,
      key: 'p|a',
      trigger: 'manual',
      phase: 'finished',
      day,
      startedAt: 1,
      endedAt: 2,
      exit: 0,
    })
    const st = slotDayState('p|a', day)
    assert.equal(st.completed, false, 'manual 不算"今天的计划已完成"')
    assert.equal(st.runs, 2, '但运行次数照记')
    assert.equal(st.lastExit, 0)
  } finally {
    box.done()
  }
})

test('运行记录③：坏行（崩溃写坏的最后一行）不会毁掉整天的记录', () => {
  const box = sandbox()
  try {
    appendRun({
      v: 1,
      runId: 'x',
      key: 'p|a',
      trigger: 'schedule',
      phase: 'started',
      day: '2026-09-24',
      startedAt: 1,
    })
    fs.appendFileSync(
      path.join(schedulerDir(), 'runs-2026-09-24.jsonl'),
      '{"v":1,"runId":"broken"\n',
    )
    assert.equal(readDay('2026-09-24').length, 1)
  } finally {
    box.done()
  }
})

test('单实例锁①：第二个宿主被拒绝并被告知持有者；陈旧锁（PID 已死）可接管', () => {
  const box = sandbox()
  try {
    const a = acquireLock({ host: 'bridge' })
    assert.equal(a.ok, true)
    assert.equal(readLock().host, 'bridge')
    assert.equal(readLock().pid, process.pid)

    // ① 陈旧锁（PID 一定不存在）→ 接管
    const lockFile = path.join(schedulerDir(), 'lock')
    const DEAD = 4194304 // 超出本机 pid 上限，必然不存在
    assert.equal(pidAlive(DEAD), false, '前提：这个 pid 不存在')
    fs.writeFileSync(lockFile, JSON.stringify({ pid: DEAD, host: 'stale' }))
    const takeover = acquireLock({ host: 'standalone' })
    assert.equal(takeover.ok, true)
    assert.equal(takeover.reclaimed, true, 'PID 已死 → 接管陈旧锁')
    assert.equal(releaseLock(), true)
    assert.equal(readLock(), null)

    // ② 另一个**活着的**进程持锁（pid=1 恒存在，EPERM 也算活着）→ 必须拒绝
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, host: 'other' }))
    const refused = acquireLock({ host: 'standalone' })
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /已由 pid=1/)
    assert.equal(readLock().pid, 1, '拒绝时不得改写别人的锁')
  } finally {
    box.done()
  }
})

test('单实例锁②（2026-09-25，Docker 实测）跨 PID 命名空间：心跳新鲜 → 拒绝接管；心跳陈旧 → 接管', () => {
  // 为什么必须有这一条（2026-09-25 在真容器里实测出来的）：
  // 容器与宿主是两个 PID 命名空间，而 pidAlive() 是 kill(pid,0) —— 跨命名空间无意义。
  // 实测过的两个后果：
  //   ① 宿主 scheduler 在容器桥持有锁时**接管**了它，而容器桥在自己的内存里仍持有
  //      → 同一台机器两个实例同时 armed = 到点双发；
  //   ② 反方向（容器写下的 pid 在宿主上恰好被别的进程占用，Linux 宿主持有几乎必然）
  //      → 宿主桥永远拿不到锁 → armedReason='no-lock' → 定时器静默失效。
  // 修法：hostname 不同就**不看 PID，改看心跳**（持有者每 tick 续一次）。
  const box = sandbox()
  const stale0 = process.env.CROSSPOST_SCHEDULER_LOCK_STALE_MS
  try {
    process.env.CROSSPOST_SCHEDULER_LOCK_STALE_MS = String(60_000) // 60s
    const lockFile = path.join(schedulerDir(), 'lock')
    fs.mkdirSync(schedulerDir(), { recursive: true })
    const t0 = Date.now()

    // 外来实例（另一个 hostname = 容器/另一台机），pid 故意用本机**活着**的 1
    const foreign = (heartbeatAt) =>
      fs.writeFileSync(
        lockFile,
        JSON.stringify({
          pid: 1,
          host: 'bridge',
          hostname: 'container-abc123',
          startedAt: t0 - 10 * 60_000,
          heartbeatAt,
          instanceId: 'foreign-instance',
        }),
      )

    // ① 心跳新鲜（10s 前）→ 必须拒绝，且不得改写别人的锁
    foreign(t0 - 10_000)
    const fresh = acquireLock({ host: 'standalone', now: t0 })
    assert.equal(fresh.ok, false, '另一个命名空间的实例心跳新鲜 → 不能接管（否则双发）')
    assert.match(fresh.reason, /另一个 PID 命名空间/)
    assert.equal(readLock().instanceId, 'foreign-instance', '拒绝时不得改写别人的锁')

    // ② 心跳陈旧（5 分钟前）→ 那个实例已经死了（老容器被删掉）→ 接管
    foreign(t0 - 5 * 60_000)
    const stale = acquireLock({ host: 'standalone', now: t0 })
    assert.equal(stale.ok, true, '心跳陈旧 → 接管（容器被删掉后宿主应能继续调度）')
    assert.equal(stale.reclaimed, true)
    assert.equal(readLock().hostname, os.hostname())

    // ③ 同命名空间仍然按 PID 判活：本机 pid=1 活着 → 拒绝（老行为不变）
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, host: 'other', hostname: os.hostname() }))
    assert.equal(acquireLock({ host: 'standalone', now: t0 }).ok, false)

    // ④ 老锁记录（没有 heartbeatAt，也没有 hostname）→ 退回旧的 PID 语义
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, host: 'legacy' }))
    assert.equal(
      acquireLock({ host: 'standalone', now: t0 }).ok,
      false,
      '无 hostname 的旧锁按老判据处理',
    )
  } finally {
    if (stale0 === undefined) delete process.env.CROSSPOST_SCHEDULER_LOCK_STALE_MS
    else process.env.CROSSPOST_SCHEDULER_LOCK_STALE_MS = stale0
    box.done()
  }
})

test('单实例锁③（2026-09-25，Docker 实测）心跳只刷自己的锁；锁被接管 → 心跳报 lock-lost', () => {
  const box = sandbox()
  try {
    const mine = acquireLock({ host: 'bridge' })
    assert.equal(mine.ok, true)
    assert.ok(mine.lock.instanceId, '锁记录必须带 instanceId（单靠 PID 跨命名空间不成立）')
    const before = readLock().heartbeatAt

    // 刷自己的锁 → heartbeatAt 前进
    const beat = heartbeatLock(mine.lock, { now: before + 5000 })
    assert.equal(beat.ok, true)
    assert.equal(readLock().heartbeatAt, before + 5000)

    // 别人接管（模拟另一命名空间抢占）→ 我们必须知道，而不是继续点火
    fs.writeFileSync(
      path.join(schedulerDir(), 'lock'),
      JSON.stringify({
        pid: 1,
        host: 'other',
        hostname: 'container-xyz',
        instanceId: 'someone-else',
      }),
    )
    const lost = heartbeatLock(mine.lock, { now: before + 10_000 })
    assert.equal(lost.ok, false)
    assert.equal(lost.reason, 'lock-lost')
    assert.equal(readLock().instanceId, 'someone-else', '不得把别人的锁改写成自己的')

    // 释放也只删自己的：手里握的是旧 instanceId → 不删别人的
    assert.equal(releaseLock(mine.lock), false, '不是自己的锁不能删')
    assert.ok(readLock(), '别人那把锁必须还在')
  } finally {
    box.done()
  }
})

test('执行器①：先落 intent、日志名与旧 launchd 一致、退出后写结果', async () => {
  const box = sandbox()
  try {
    const child = fakeChild(777)
    const spawns = []
    let journalAtSpawn = null
    const runner = createRunner({
      spawnImpl: (cmd, args, opts) => {
        // 2026-09-28 测试审计：原断言在 `runner.start()` **返回之后**才读账本 ——
        // 那时"先写 intent 还是先 spawn"两种实现都能通过，顺序其实没被证明。
        // 在 spawn 回调里读一次才是真正的顺序判据。
        journalAtSpawn = readDay(DAY())
        spawns.push({ cmd, args, opts })
        return child
      },
    })
    const logDir = path.join(box.dir, 'logs')
    const res = runner.start(specOf({ logDir }), { trigger: 'schedule' })
    assert.equal(res.ok, true)
    assert.equal(res.pid, 777)
    // 顺序：**先落 intent，再起进程**（spawn 那一刻账本里就必须有 started）
    assert.ok(journalAtSpawn, 'spawnImpl 未被调用')
    assert.ok(
      journalAtSpawn.some((r) => r.phase === 'started'),
      'spawn 发生时 started 记录必须已经在账本里（否则容器重启会丢这次触发）',
    )
    const day = readDay(DAY())
    const started = day.filter((r) => r.phase === 'started')
    assert.equal(started.length, 1)
    assert.equal(spawns[0].cmd, '/bin/echo')
    assert.deepEqual(spawns[0].args, ['hi'])
    assert.equal(spawns[0].opts.cwd, undefined)
    assert.equal(spawns[0].opts.env.CROSSPOST_SCHEDULED_BY, 'crosspost-scheduler')
    assert.ok(fs.existsSync(path.join(logDir, 'scheduler-hotspot.out.log')))
    assert.ok(fs.existsSync(path.join(logDir, 'scheduler-hotspot.err.log')))
    assert.equal(runner.isRunning('p|hotspot'), true)

    child.finish(0)
    assert.equal(runner.isRunning('p|hotspot'), false)
    const dayKey = DAY()
    const finished = readDay(dayKey).filter((r) => r.phase === 'finished')
    assert.equal(finished.length, 1)
    assert.equal(finished[0].exit, 0)
    assert.equal(finished[0].trigger, 'schedule')
  } finally {
    box.done()
  }
})

test('执行器②：同槽位不重叠（计 overlapSkipped），不是排队', () => {
  const box = sandbox()
  try {
    const child = fakeChild()
    const runner = createRunner({ spawnImpl: () => child })
    const spec = specOf({ logDir: path.join(box.dir, 'logs') })
    assert.equal(runner.start(spec).ok, true)
    const second = runner.start(spec)
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'overlap')
    assert.equal(runner.overlapSkipped(), 1)
    child.finish(0)
    assert.equal(runner.start(spec).ok, true, '上一次结束后可以再跑（人工触发场景）')
    child.finish(0)
  } finally {
    box.done()
  }
})

test('执行器③：spawn 失败也要写"结果"（否则当天会被判成"未收尾"而永远不重跑）', () => {
  const box = sandbox()
  try {
    const child = fakeChild()
    const runner = createRunner({ spawnImpl: () => child })
    const spec = specOf({ logDir: path.join(box.dir, 'logs') })
    runner.start(spec)
    child.fail('boom')
    const dayKey = DAY()
    const fin = readDay(dayKey).filter((r) => r.phase === 'finished')
    assert.equal(fin.length, 1)
    assert.match(fin[0].error, /boom/)
    assert.equal(runner.isRunning('p|hotspot'), false)
  } finally {
    box.done()
  }
})

/* ── 编排层：注入 runner 与时钟，验证"到点触发恰好一次" ── */

// 2026-09-28 测试审计：原签名带 `engineSlots = false` 且函数体里 `void engineSlots`，
// 但**没有任何调用方传它**（引擎自带任务 2026-09-25 已退役）——纯死参数，删掉。
function orchestration({ nowRef, slots }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-sched-orch-'))
  const projectRoot = path.join(dir, 'project')
  fs.mkdirSync(path.join(projectRoot, '.crosspost'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'drafts'), { recursive: true })
  fs.writeFileSync(
    path.join(projectRoot, '.crosspost', 'project.json'),
    JSON.stringify({
      id: 'p',
      name: 'P',
      manifestVersion: 2,
      capabilities: { drafts: true, schedule: true },
      dataDir: 'drafts',
    }),
  )
  const declSlots = {}
  for (const s of slots) declSlots[s.id] = { time: s.time, command: ['/bin/echo', s.id] }
  fs.writeFileSync(
    path.join(projectRoot, '.crosspost', 'schedule.json'),
    JSON.stringify({ version: 1, slots: declSlots }, null, 2),
  )
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ projectsDirs: [dir], scheduler: { catchUpMaxMinutes: 120 } }),
  )
  const envKeys = [
    'CROSSPOST_CONFIG',
    'CROSSPOST_LOCAL_ROOT',
    'CROSSPOST_PROJECTS_DIRS',
    'CROSSPOST_PROJECTS_DIR',
    'CROSSPOST_SCHEDULER_DIR',
    'CROSSPOST_LEGACY_TASKS_DIR',
  ]
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]))
  process.env.CROSSPOST_CONFIG = path.join(dir, 'config.json')
  process.env.CROSSPOST_LOCAL_ROOT = path.join(dir, 'local')
  process.env.CROSSPOST_PROJECTS_DIRS = dir
  process.env.CROSSPOST_PROJECTS_DIR = path.join(dir, 'no-default')
  process.env.CROSSPOST_SCHEDULER_DIR = path.join(dir, 'scheduler')
  process.env.CROSSPOST_LEGACY_TASKS_DIR = path.join(dir, 'no-legacy')
  return {
    dir,
    projectRoot,
    done() {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      fs.rmSync(dir, { recursive: true, force: true })
    },
    nowRef,
  }
}

test('编排①：到点触发一次；同一天不再触发（每天最多一次）', () => {
  const nowRef = { t: Date.parse('2026-09-24T08:31:00+08:00') }
  const box = orchestration({ nowRef, slots: [{ id: 'job', time: '08:30' }] })
  try {
    const started = []
    const runner = {
      start: (spec, o) => {
        started.push({ key: spec.key, trigger: o.trigger })
        return { ok: true }
      },
      stop: () => [],
      isRunning: () => false,
      runningCount: () => 0,
      runningKeys: () => [],
      overlapSkipped: () => 0,
      runningInfo: () => null,
    }
    const sched = createScheduler({ host: 'test', now: () => nowRef.t, runner, tickMs: 1e9 })
    sched.start()
    const mine = started.filter((s) => s.key === 'p|job')
    assert.equal(mine.length, 1, `到点应触发一次，实际 ${JSON.stringify(started)}`)
    assert.equal(mine[0].trigger, 'schedule')
    // 第二次 tick（模拟下一分钟）：记录里没有"跑完"，但策略是"每天一次"，
    // 只有**跑完**才算占名额 —— 因此这里仍会触发，直到写回结果。
    // 这正是"先 intent 后结果"的代价：结果没写回来就不算完成，靠 unfinished 兜底。
    sched.tick()
    const after = started.filter((s) => s.key === 'p|job')
    assert.equal(after.length, 2, '未写回结果时仍会重试（容器重启后能自愈）')

    // 写回"跑完"后再 tick：不再触发
    // 2026-09-28 测试审计：`require_store()` 只是个返回顶层已导入绑定的间接层
    // （注释说"避免顶层 import 与 env 顺序耦合"，但它返回的就是同一份绑定），删掉。
    const day = '2026-09-24'
    const rid = newRunId()
    appendRun({
      v: 1,
      runId: rid,
      key: 'p|job',
      trigger: 'schedule',
      phase: 'started',
      day,
      startedAt: 1,
    })
    appendRun({
      v: 1,
      runId: rid,
      key: 'p|job',
      trigger: 'schedule',
      phase: 'finished',
      day,
      startedAt: 1,
      endedAt: 2,
      exit: 0,
    })
    sched.tick()
    assert.equal(started.filter((s) => s.key === 'p|job').length, 2, '当天已完成 → 不再触发')
    sched.stop()
  } finally {
    box.done()
  }
})

test('编排②：补跑窗口内补跑、超过窗口放弃；关闭的槽位不触发', () => {
  const nowRef = { t: Date.parse('2026-09-24T11:00:00+08:00') }
  const box = orchestration({ nowRef, slots: [{ id: 'stale', time: '08:30' }] })
  try {
    const started = []
    const runner = {
      start: (spec) => {
        started.push(spec.key)
        return { ok: true }
      },
      stop: () => [],
      isRunning: () => false,
      runningCount: () => 0,
      runningKeys: () => [],
      overlapSkipped: () => 0,
      runningInfo: () => null,
    }
    // 11:00 距 08:30 已 150 分钟 > 120 → 放弃
    const s1 = createScheduler({ host: 't', now: () => nowRef.t, runner, tickMs: 1e9 })
    s1.start()
    assert.equal(started.length, 0, '超过补跑窗口不触发')
    const row = s1.status({ projectId: 'p' }).slots.find((x) => x.slot === 'stale')
    assert.equal(row.decidedReason, 'missed-window')
    assert.ok(row.next.startsWith('2026-09-25'), '下一次指向明天')
    s1.stop()

    // 窗口放宽到 300 分钟 → 补跑
    nowRef.t = Date.parse('2026-09-24T11:00:00+08:00')
    fs.writeFileSync(
      process.env.CROSSPOST_CONFIG,
      JSON.stringify({ projectsDirs: [box.dir], scheduler: { catchUpMaxMinutes: 300 } }),
    )
    const started2 = []
    const runner2 = {
      ...runner,
      start: (spec) => {
        started2.push(spec.key)
        return { ok: true }
      },
    }
    const s2 = createScheduler({ host: 't', now: () => nowRef.t, runner: runner2, tickMs: 1e9 })
    s2.start()
    assert.deepEqual(
      started2.filter((k) => k.startsWith('p|')),
      ['p|stale'],
      '窗口内应补跑（引擎内置任务同日也在窗口内，按各自时区判定，故只断言项目槽位）',
    )
    s2.stop()
  } finally {
    box.done()
  }
})

test('编排③：拿不到锁时不 arm（并计入 skippedNoLock），状态里说明原因', () => {
  const nowRef = { t: Date.parse('2026-09-24T08:31:00+08:00') }
  const box = orchestration({ nowRef, slots: [{ id: 'job', time: '08:30' }] })
  try {
    // 冒充"另一个活着的进程"持锁：pid=1 在任何系统上都在（EPERM 也算活着），
    // 于是本次 acquireLock 必须被拒绝——这正是"桥与独立 scheduler 只能有一个"的现场。
    fs.mkdirSync(process.env.CROSSPOST_SCHEDULER_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(process.env.CROSSPOST_SCHEDULER_DIR, 'lock'),
      JSON.stringify({ pid: 1, host: 'other-host' }),
    )
    let startedCount = 0
    const sched = createScheduler({
      host: 't',
      now: () => nowRef.t,
      runner: {
        start: () => {
          startedCount += 1
          return { ok: true }
        },
        stop: () => [],
        isRunning: () => false,
        runningCount: () => 0,
        runningKeys: () => [],
        overlapSkipped: () => 0,
        runningInfo: () => null,
      },
      tickMs: 1e9,
    })
    const r = sched.start()
    assert.equal(r.ok, false, '锁被别的活进程持有 → 不 arm')
    assert.match(r.lock.reason, /已由 pid=1/)
    assert.equal(sched.isArmed('p|job'), false)
    const st = sched.status({ projectId: 'p' })
    const row = st.slots.find((x) => x.slot === 'job')
    assert.equal(row.armedReason, 'no-lock', '状态里必须说明"没拿到锁"，而不是假装没这个槽位')
    assert.equal(row.decidedReason, 'no-lock')
    assert.equal(startedCount, 0, '没锁时一个槽位都不该启动')
    assert.ok(st.skippedNoLock >= 1, '要计数，方便诊断"定时为什么没跑"')
    // 2026-09-25（docker 实测踩到）：`scheduler-cli status` 是**另一个进程**，它手里永远没有锁，
    // 于是"今天还没跑过"的槽位一律显示 `未生效(no-lock)` —— 照文档跑体检的人会以为定时器坏了，
    // 其实桥正拿着锁。所以"锁在别人手里、且它还活着"必须单独暴露出来。
    assert.equal(
      st.armedByOther,
      true,
      '锁被另一个活着的实例持有 → status 必须报 armedByOther（与"根本没人持有"区分开）',
    )
    sched.stop()
  } finally {
    box.done()
  }
})

test('编排④（2026-09-25）没有"活着的别人"持锁时，armedByOther 必须为 false', () => {
  const nowRef = { t: Date.parse('2026-09-24T08:31:00+08:00') }
  const box = orchestration({ nowRef, slots: [{ id: 'job', time: '08:30' }] })
  try {
    const mkSched = () =>
      createScheduler({
        host: 't',
        now: () => nowRef.t,
        runner: {
          start: () => ({ ok: true }),
          stop: () => [],
          isRunning: () => false,
          runningCount: () => 0,
          runningKeys: () => [],
          overlapSkipped: () => 0,
          runningInfo: () => null,
        },
        tickMs: 1e9,
      })

    // ① 从没起过（没有锁文件）→ 不是"别人持有"
    const idle = mkSched()
    assert.equal(idle.status().armedByOther, false, '空闲 ≠ 别人持有')
    idle.stop()

    // ② 陈旧锁（pid 必然不存在）被自己接管 → 更不该说"别人持有"
    fs.mkdirSync(process.env.CROSSPOST_SCHEDULER_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(process.env.CROSSPOST_SCHEDULER_DIR, 'lock'),
      JSON.stringify({ pid: 4194304, host: 'stale', hostname: os.hostname() }),
    )
    const sched = mkSched()
    assert.equal(sched.start().ok, true, '陈旧锁应当被接管')
    const st = sched.status()
    assert.equal(st.lockHeldByUs, true)
    assert.equal(st.armedByOther, false, '自己持有时不该说"由另一个实例持有"')
    sched.stop()
  } finally {
    box.done()
  }
})
