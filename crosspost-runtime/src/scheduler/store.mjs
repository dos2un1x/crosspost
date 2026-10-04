/**
 * 调度运行记录与单实例锁（v2.3，调度子系统）
 *
 * ## 为什么要自己记
 *
 * 以前"今天跑没跑"只能从**项目写的日志**里猜（`logs/run-<slot>-<日期>.log` 的 `[END]` 行），
 * 而"跑到一半崩了""正在跑"这两件事完全不可见——因为它们没有落点。引擎自己接手触发之后，
 * 必须先有一份**引擎自己的账**：谁在什么时候被触发、结束没有、退出码多少。
 *
 * 落点：`<localRoot>/scheduler/runs-<YYYY-MM-DD>.jsonl`（按槽位时区切日，追加写）
 *   · 按天分文件：查"今天跑没跑"只读一个文件；轮转也是天然的
 *   · jsonl：追加写不会破坏既有内容（崩溃最多丢最后一行，读的时候跳过坏行）
 *   · 先写 `phase:"started"`（**意图**）再 spawn：崩在中间也留得下"有头无尾"的证据，
 *     重启后据此**不重跑**（宁可少发一次，不可重复发文）
 *
 * ## 单实例锁
 *
 * 定时器只能有一个持有者（桥进程内，或独立 `scheduler` 进程）。两个同时跑 = 双触发。
 * 锁用 `<localRoot>/scheduler/lock`（JSON：pid/host/startedAt）：PID 还在 → 拒绝；
 * PID 已死（含重启后 PID 复用不到的旧锁）→ 视为陈旧，接管。这不是分布式锁，
 * 只是防"自己把自己跑两遍"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadPaths } from '../paths.mjs'

/** 调度数据目录（`CROSSPOST_SCHEDULER_DIR` 供测试隔离） */
export function schedulerDir() {
  const override = process.env.CROSSPOST_SCHEDULER_DIR
  if (override) return path.resolve(override)
  return path.join(loadPaths().localRoot, 'scheduler')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 某天的运行记录文件 */
export function runsFile(dayKey, dir = schedulerDir()) {
  return path.join(dir, `runs-${dayKey}.jsonl`)
}

let runSeq = 0
/** 生成一次运行的 id（同进程内单调；跨进程靠 pid 区分） */
export function newRunId() {
  runSeq += 1
  return `${process.pid}-${Date.now().toString(36)}-${runSeq}-${crypto.randomBytes(2).toString('hex')}`
}

/** 追加一条运行记录（失败不抛：记账不能把调度本身搞死） */
export function appendRun(rec) {
  try {
    const dir = ensureDir(schedulerDir())
    fs.appendFileSync(runsFile(rec.day, dir), JSON.stringify(rec) + '\n')
    return true
  } catch {
    return false
  }
}

/** 读某天的运行记录（跳过坏行；文件不存在 → `[]`） */
export function readDay(dayKey, dir = schedulerDir()) {
  let text
  try {
    text = fs.readFileSync(runsFile(dayKey, dir), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const o = JSON.parse(s)
      if (o && typeof o === 'object') out.push(o)
    } catch {
      /* 崩溃写坏的半行：跳过，不让它把整天的记录废掉 */
    }
  }
  return out
}

/** 已存在的运行记录日期（升序） */
export function listRunDays(dir = schedulerDir()) {
  try {
    return fs
      .readdirSync(dir)
      .map((f) => /^runs-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1])
      .filter(Boolean)
      .sort()
  } catch {
    return []
  }
}

/**
 * 某槽位在**某一天**的状态摘要（`decideFire` 的输入）。
 *
 * 关键区分：`trigger === 'manual'` 的运行**不**占用"每天一次"的名额——
 * 人工触发永远不该让当天的自动计划消失（否则"手动补跑一次"就等于取消了今天）。
 * 但它的结果仍用于展示（lastExit / lastDurationMs）。
 */
export function slotDayState(key, dayKey, dir = schedulerDir()) {
  const entries = readDay(dayKey, dir).filter((e) => e && e.key === key)
  const auto = entries.filter((e) => e.trigger !== 'manual')
  const finished = new Set(entries.filter((e) => e.phase === 'finished').map((e) => e.runId))
  const startedAuto = auto.filter((e) => e.phase === 'started')
  const completed = startedAuto.some((e) => finished.has(e.runId))
  const unfinished = startedAuto.some((e) => !finished.has(e.runId))
  const lastFinished = [...entries].reverse().find((e) => e.phase === 'finished') || null
  const lastStarted = [...entries].reverse().find((e) => e.phase === 'started') || null
  return {
    day: dayKey,
    completedDay: completed ? dayKey : null,
    unfinishedDay: unfinished ? dayKey : null,
    completed,
    unfinished,
    lastExit: lastFinished ? (lastFinished.exit ?? null) : null,
    lastStartedAt: lastStarted ? lastStarted.startedAt : null,
    lastDurationMs: lastFinished ? (lastFinished.durationMs ?? null) : null,
    runs: entries.length,
    entries,
  }
}

/** 清理过旧的运行记录（缺省保留 180 天） */
export function pruneRuns({ keepDays = 180, todayKey } = {}) {
  if (!todayKey || !Number.isFinite(keepDays) || keepDays <= 0) return []
  const cutoff = new Date(todayKey + 'T00:00:00Z').getTime() - keepDays * 86400000
  const removed = []
  for (const day of listRunDays()) {
    const t = new Date(day + 'T00:00:00Z').getTime()
    if (Number.isFinite(t) && t < cutoff) {
      try {
        fs.unlinkSync(runsFile(day))
        removed.push(day)
      } catch {
        /* 删不掉就算了：记账文件不是关键路径 */
      }
    }
  }
  return removed
}

/* ── 单实例锁 ─────────────────────────────────────────────── */

function lockFile(dir = schedulerDir()) {
  return path.join(dir, 'lock')
}

/** PID 是否还活着（`EPERM` 也算活着：进程存在但不是我们的） */
export function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    return !!(e && e.code === 'EPERM')
  }
}

/** 读锁内容（无锁/坏锁 → `null`） */
export function readLock() {
  try {
    const o = JSON.parse(fs.readFileSync(lockFile(), 'utf8'))
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

/**
 * 锁记录对应的实例**是不是还活着**（判活的唯一实现，acquireLock 与 status 共用）。
 *
 *   · 同 hostname（同一 PID 命名空间）→ PID 判活（权威）
 *   · 不同 hostname（容器 / 另一台机器）→ PID 无意义，改看心跳（持有者每 tick 续）
 *   · 没有 hostname 的老记录 → 按同命名空间处理（与本版之前行为一致）
 */
export function lockHolderAlive(lock, { now = Date.now() } = {}) {
  if (!lock) return false
  const sameNamespace = !lock.hostname || lock.hostname === os.hostname()
  if (sameNamespace) return pidAlive(lock.pid)
  const beat = Number(lock.heartbeatAt) || Number(lock.startedAt) || 0
  return Math.max(0, now - beat) <= lockStaleMs()
}

/** "谁持有、为什么" 的人话（acquireLock 的拒绝理由，与 status 的展示共用同一套措辞） */
export function lockHeldReason(lock, { now = Date.now() } = {}) {
  if (!lock) return null
  const who = `pid=${lock.pid}（${lock.host || 'unknown'}${lock.hostname ? ` @ ${lock.hostname}` : ''}）`
  const sameNamespace = !lock.hostname || lock.hostname === os.hostname()
  if (sameNamespace) return `定时器已由 ${who} 持有`
  const beat = Number(lock.heartbeatAt) || Number(lock.startedAt) || 0
  const age = Math.round(Math.max(0, now - beat) / 1000)
  return (
    `定时器已由另一个 PID 命名空间/主机的实例持有：${who}，心跳 ${age}s 前。` +
    `宿主与容器不能同时跑定时器（会双发）——要切换请先停掉另一个。`
  )
}

/**
 * 取锁。返回 `{ ok, lock, reclaimed, reason }`：
 *   · `ok: true`  = 本进程持有（含"接管了陈旧锁"）
 *   · `ok: false` = 另一个**活着**的实例持有，调用方应放弃 arm（而不是硬闯）
 *
 * ## 为什么不能只看 PID（2026-09-25，Docker 模式实测踩到）
 *
 * `pidAlive()` 是 `kill(pid, 0)`，**只在同一个 PID 命名空间里有意义**。
 * 容器与宿主是两个命名空间，于是：
 *   · 宿主上的原生桥还在跑时，容器里的桥读到宿主的 pid → 容器里"查不到这个进程" →
 *     判定陈旧 → **接管**；而宿主那个桥在**自己的内存里**仍然持有锁 → 两边同时 armed。
 *     2026-09-25 实测：容器桥 `lockHeldByUs=true`、宿主 scheduler 也报"本进程持有"
 *     → 到点**双发**（发布与通知都会重）。
 *   · 反方向同理：容器写下的 pid 在宿主上可能恰好被别的进程占用（Linux 宿主机上几乎必然），
 *     那时宿主桥会**永远拿不到锁** → `armedReason='no-lock'` → 定时器静默失效。
 *
 * 所以判活分两种情形：
 *   · **同 hostname**（同一命名空间）→ 用 PID 判活（权威）
 *   · **不同 hostname**（容器 / 另一台机器）→ PID 不可判 → 改看**心跳**：
 *     持有者每个 tick 刷新 `heartbeatAt`，心跳还新鲜就认为它活着（拒绝接管）。
 * 老的锁记录（没有 hostname）按"同命名空间"处理，行为与本版之前完全一致。
 */
export function acquireLock({ host = 'bridge', now = Date.now(), instanceId = newLockId() } = {}) {
  const dir = ensureDir(schedulerDir())
  const existing = readLock()
  const ours = existing
    ? existing.instanceId
      ? existing.instanceId === instanceId
      : Number(existing.pid) === process.pid
    : false

  if (existing && !ours) {
    // 「记的 pid 就是本进程」= 崩溃后 PID 被复用：那时旧实例已经没了，我们才是活着那个
    // → 必须接管，不能因为 pidAlive(自己) 为真而把自己挡在门外（旧实现就带这条）。
    const selfPid =
      (!existing.hostname || existing.hostname === os.hostname()) &&
      Number(existing.pid) === process.pid
    if (!selfPid && lockHolderAlive(existing, { now }))
      return {
        ok: false,
        lock: existing,
        reclaimed: false,
        reason: lockHeldReason(existing, { now }),
      }
  }

  const reclaimed = !!existing && !ours
  const lock = {
    pid: process.pid,
    host,
    startedAt: now,
    hostname: os.hostname(),
    heartbeatAt: now,
    instanceId,
  }
  const tmp = lockFile(dir) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(lock))
  fs.renameSync(tmp, lockFile(dir))
  return { ok: true, lock, reclaimed, reason: reclaimed ? '接管了陈旧锁' : null }
}

/** 新的实例标识（每次 acquire 生成一个，用于"只刷新/只释放自己的锁"） */
export function newLockId() {
  return crypto.randomUUID()
}

/**
 * 心跳老化阈值（毫秒）。持有者每个 tick（缺省 60s）刷一次，所以 5 分钟足够宽松。
 * `CROSSPOST_SCHEDULER_LOCK_STALE_MS` 供测试压小。
 */
export function lockStaleMs() {
  const n = Number(process.env.CROSSPOST_SCHEDULER_LOCK_STALE_MS)
  return Number.isFinite(n) && n > 0 ? n : 5 * 60_000
}

/**
 * 刷新自己的心跳（每 tick 调一次）。只有**当前文件仍是自己的**才写。
 *
 * 为什么还要检查归属：锁可能被别人（或用户手工）删掉/接管 —— 那时我们必须知道
 * 自己已经不是持有者了，否则会一边丢锁一边继续点火（那正是"双发"的另一半）。
 * 返回 `{ ok:false, reason:'lock-lost' }` 时调用方应把定时器视为未 arm。
 */
export function heartbeatLock(lock, { now = Date.now() } = {}) {
  if (!lock || !lock.instanceId) return { ok: false, reason: 'no-lock', lock: null }
  const cur = readLock()
  if (!cur || cur.instanceId !== lock.instanceId)
    return { ok: false, reason: 'lock-lost', lock: cur }
  const next = { ...cur, heartbeatAt: now }
  try {
    const tmp = lockFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next))
    fs.renameSync(tmp, lockFile())
  } catch (e) {
    return {
      ok: false,
      reason: 'heartbeat-write-failed',
      error: String((e && e.message) || e),
      lock: cur,
    }
  }
  return { ok: true, lock: next }
}

/** 释放锁（只删自己的；不是自己持有的 → 不动，避免误删别人的） */
export function releaseLock(lock = null) {
  const cur = readLock()
  if (!cur) return false
  // 有 instanceId 就按 instanceId 比（跨命名空间的 PID 相等是巧合，不能当凭据）；
  // 老记录/老调用方按 PID 比，保持与之前一致的行为。
  if (lock && lock.instanceId) {
    if (cur.instanceId !== lock.instanceId) return false
  } else if (Number(cur.pid) !== process.pid) {
    return false
  }
  try {
    fs.unlinkSync(lockFile())
    return true
  } catch {
    return false
  }
}
