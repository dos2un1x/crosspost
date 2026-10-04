/**
 * 槽位执行器（v2.3，调度子系统）：到点那一刻真的把项目命令跑起来
 *
 * ## 与旧路径的行为对齐（这是迁移能"零改项目脚本"的前提）
 *
 * 旧 launchd 任务给槽位写的日志是 `<项目工作区>/logs/scheduler-<槽位>.out.log|err.log`
 * （plist 的 `StandardOutPath`/`StandardErrorPath`）。执行器**沿用同样的文件名**，
 * 于是：
 *   · 项目侧脚本自己写的 `logs/run-<槽位>-<日期>.log` 不受影响（`readSlotLastRun` 仍读它）
 *   · 用 `tail -f scheduler-hotspot.out.log` 的既有习惯继续成立
 *
 * ## 三条纪律
 *
 *   ① **先记账再 spawn**：`started` 记录落盘失败不阻塞执行，但顺序不能反——
 *      崩溃时"有头无尾"是重启后不重跑的判据。
 *   ② **argv 直传**：`spawn(cmd, args)`，不经 shell。声明里写什么就是什么，
 *      引擎不展开 `$VAR`、不解释 `&&`、不做 glob（三平台语义一致）。
 *   ③ **同一槽位不重叠**：上一次还没结束就跳过这一次并计数（`overlapSkipped`），
 *      不是排队——排队会让"12:30 那次"在 14:00 才开始，比跳过更糟。
 *
 * ## 两种执行器（2026-09-25）
 *
 *   · **本地命令**（缺省，`spec.executor == null`）：上面这套 `spawn`，命令来自项目声明。
 *   · **远程 http**（`spec.executor.kind === 'http'`）：引擎不 spawn 项目脚本，只按
 *     `capabilities.schedule` 声明的端点发一次 HTTP（受理 → 轮询），**执行发生在项目那边**。
 *     记账格式与本地完全一致（同写 `started`/`finished` + exit/duration），所以界面与
 *     日统计无需改动；远程失败也**必须**记账（否则会退化成界面上那句"今日已跑"）。
 *     远程契约与策略见 `src/schedule-provider.mjs`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { appendRun, newRunId } from './store.mjs'
import { tzDayKey } from '../tz.mjs'
import {
  callScheduleProvider,
  cancelScheduleProvider,
  resolveScheduleProvider,
} from '../schedule-provider.mjs'

/** 子进程环境里由引擎补上的标记（供发布链路识别"这次是定时触发的"） */
export const SCHEDULER_ENV = {
  CROSSPOST_SCHEDULED_BY: 'crosspost-scheduler',
}

export function createRunner({
  env = process.env,
  spawnImpl = spawn,
  now = () => Date.now(),
  onEvent = null,
} = {}) {
  /** key → { runId, startedAt, pid, child, slotId } */
  const running = new Map()
  let overlapSkipped = 0
  let stopRequested = false

  const emit = (evt) => {
    try {
      if (onEvent) onEvent(evt)
    } catch {
      /* 观测回调不能影响执行 */
    }
  }

  function isRunning(key) {
    return running.has(key)
  }

  function start(spec, { trigger = 'schedule' } = {}) {
    // ── 执行器分派（2026-09-25）───────────────────────────────────────────
    // 项目在 manifest 里声明了 `capabilities.schedule={kind:'http',…}` 时，到点这件事
    // 变成一次 HTTP 调用，**执行发生在项目自己那边**（引擎不再 spawn 项目脚本）。
    // 记账格式与本地 spawn 完全一致（同样写 started/finished + exit/duration），
    // 所以 Console、`/proxy/schedule`、`completedToday/lastExit/daysSince` 全部无需改动。
    if (spec && spec.executor && spec.executor.kind === 'http') return startHttp(spec, { trigger })
    if (!spec || !Array.isArray(spec.command) || !spec.command.length)
      return { ok: false, reason: 'no-command' }
    if (running.has(spec.key)) {
      overlapSkipped += 1
      emit({ type: 'overlap', key: spec.key, slot: spec.id })
      return { ok: false, reason: 'overlap' }
    }
    if (stopRequested) return { ok: false, reason: 'stopping' }

    const startedAt = now()
    const day = tzDayKey(spec.tz, startedAt)
    const runId = newRunId()
    const base = {
      v: 1,
      runId,
      key: spec.key,
      projectId: spec.projectId || '',
      slotId: spec.id,
      scope: 'project', // 引擎不再自带任务：槽位一律属于项目（2026-09-25）
      backend: 'internal',
      trigger,
      tz: spec.tz,
      day,
      command: spec.command,
      cwd: spec.cwd || null,
    }
    // ① 意图先落盘
    appendRun({ ...base, phase: 'started', startedAt })

    const logDir = spec.logDir || path.join(spec.projectRoot || process.cwd(), 'logs')
    let outFd = null
    let errFd = null
    let outFile = null
    let errFile = null
    try {
      fs.mkdirSync(logDir, { recursive: true })
      outFile = path.join(logDir, `scheduler-${spec.id}.out.log`)
      errFile = path.join(logDir, `scheduler-${spec.id}.err.log`)
      outFd = fs.openSync(outFile, 'a')
      errFd = fs.openSync(errFile, 'a')
    } catch (e) {
      appendRun({
        ...base,
        phase: 'finished',
        startedAt,
        endedAt: now(),
        exit: null,
        durationMs: 0,
        error: `无法写日志文件: ${String((e && e.message) || e)}`,
      })
      return { ok: false, reason: 'log-unwritable', error: String((e && e.message) || e) }
    }

    const childEnv = { ...env, ...(spec.env || {}), ...SCHEDULER_ENV, TZ: spec.tz }
    let child
    try {
      child = spawnImpl(spec.command[0], spec.command.slice(1), {
        cwd: spec.cwd || undefined,
        env: childEnv,
        stdio: ['ignore', outFd, errFd],
      })
    } catch (e) {
      closeQuietly(outFd, errFd)
      appendRun({
        ...base,
        phase: 'finished',
        startedAt,
        endedAt: now(),
        exit: null,
        durationMs: 0,
        error: `spawn 失败: ${String((e && e.message) || e)}`,
      })
      return { ok: false, reason: 'spawn-failed', error: String((e && e.message) || e) }
    }

    const entry = { runId, startedAt, pid: child.pid ?? null, child, slotId: spec.id }
    running.set(spec.key, entry)
    emit({
      type: 'start',
      key: spec.key,
      slot: spec.id,
      pid: entry.pid,
      runId,
      logFiles: { out: outFile, err: errFile },
    })

    const finish = (exit, signal, error) => {
      if (!running.has(spec.key) || running.get(spec.key).runId !== runId) return
      running.delete(spec.key)
      closeQuietly(outFd, errFd)
      const endedAt = now()
      appendRun({
        ...base,
        phase: 'finished',
        startedAt,
        endedAt,
        exit: exit === undefined ? null : exit,
        signal: signal || null,
        durationMs: Math.max(0, endedAt - startedAt),
        ...(error ? { error } : {}),
      })
      emit({
        type: 'exit',
        key: spec.key,
        slot: spec.id,
        runId,
        exit,
        signal,
        durationMs: endedAt - startedAt,
      })
    }

    child.on('error', (e) => finish(null, null, `运行失败: ${String((e && e.message) || e)}`))
    child.on('exit', (code, signal) => finish(code, signal))
    if (typeof child.removeAllListeners === 'function' && !child.on) {
      // 不应发生：spawn 一定返回 EventEmitter
    }

    return {
      ok: true,
      runId,
      pid: entry.pid,
      startedAt,
      logFiles: { out: outFile, err: errFile },
    }
  }

  /**
   * 远程执行器：把"到点该跑这个槽位"交给**项目自己的执行器**（HTTP 契约）。
   *
   * 与本地 spawn 的三点差别，都是有意的：
   *   ① 不在本地建 `scheduler-<槽位>.out.log` 作为**执行日志**（日志在项目那边）；
   *     但项目回报的 `logTail` 仍会落到那个文件里 —— 运维 `tail -f` 的老习惯继续成立。
   *   ② 失败也要**记账**（exit=1/error），否则"远程失败"会变成界面上的"今日已跑"。
   *   ③ 不设 `CROSSPOST_SCHEDULED_BY`（那是给本地子进程的标记；远程端由契约参数 `runId` 识别）。
   */
  function startHttp(spec, { trigger = 'schedule' } = {}) {
    if (running.has(spec.key)) {
      overlapSkipped += 1
      emit({ type: 'overlap', key: spec.key, slot: spec.id })
      return { ok: false, reason: 'overlap' }
    }
    if (stopRequested) return { ok: false, reason: 'stopping' }

    const startedAt = now()
    const day = tzDayKey(spec.tz, startedAt)
    const runId = newRunId()
    const exec = spec.executor
    const base = {
      v: 1,
      runId,
      key: spec.key,
      projectId: spec.projectId || '',
      slotId: spec.id,
      scope: 'project', // 引擎不再自带任务：槽位一律属于项目（2026-09-25）
      backend: 'internal',
      trigger,
      tz: spec.tz,
      day,
      executor: 'http',
      url: exec.url,
      command: null,
      cwd: null,
    }
    appendRun({ ...base, phase: 'started', startedAt })
    emit({
      type: 'start',
      key: spec.key,
      slot: spec.id,
      pid: null,
      runId,
      executor: 'http',
      url: exec.url,
    })

    const entry = { runId, startedAt, pid: null, remote: true, slotId: spec.id, spec, taskId: null }
    running.set(spec.key, entry)

    const finishRemote = (exit, error, extra = {}) => {
      running.delete(spec.key)
      const endedAt = now()
      appendRun({
        ...base,
        phase: 'finished',
        startedAt,
        endedAt,
        exit: exit === undefined ? null : exit,
        signal: null,
        durationMs:
          Number.isFinite(extra.durationMs) && extra.durationMs !== null
            ? extra.durationMs
            : Math.max(0, endedAt - startedAt),
        ...(extra.taskId ? { taskId: extra.taskId } : {}),
        ...(extra.logFile ? { remoteLogFile: extra.logFile } : {}),
        ...(error ? { error } : {}),
      })
      emit({
        type: 'exit',
        key: spec.key,
        slot: spec.id,
        runId,
        exit,
        signal: null,
        durationMs: Math.max(0, endedAt - startedAt),
        executor: 'http',
      })
    }

    const writeRemoteBreadcrumb = (tail) => {
      // 即使项目没回报 logTail 也写一行头：运维要能从本地看到"这一班是远程跑的、
      // 什么时候、什么端点"，否则本地日志会**看起来像什么都没发生**。
      try {
        const dir = spec.logDir || path.join(spec.projectRoot || process.cwd(), 'logs')
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(
          path.join(dir, `scheduler-${spec.id}.out.log`),
          `\n===== 远程执行器 ${spec.id} @ ${new Date(startedAt).toISOString()} (runId=${runId}, url=${exec.url}) =====\n${tail || '(项目未回报 logTail)'}\n`,
        )
      } catch {
        /* 面包屑写不进去不影响任务本身（它在项目那边跑） */
      }
    }

    // 声明即生效：这里**重新解析一次**（拿当下策略/网关），失败不回落到本地 spawn。
    const provider = resolveScheduleProvider(spec.projectId)
    if (!provider.provided) {
      finishRemote(null, `执行器不可用：${provider.reason}`)
      return { ok: false, reason: 'executor-unavailable', error: provider.reason }
    }
    entry.provider = provider

    const deadlineMs = startedAt + provider.overallTimeoutMs
    // 刻意**不 await**：`start()` 的调用方（tick / 人工触发）沿用本地 spawn 的同步返回语义，
    // 远程跑多久与记账无关 —— 结束时由 finishRemote 落 `finished`。
    callScheduleProvider(provider, {
      slot: spec.id,
      date: day,
      runId,
      deadlineMs,
      projectId: spec.projectId,
      onProgress: (p) => {
        if (p && p.taskId) entry.taskId = p.taskId
      },
    })
      .then((r) => {
        writeRemoteBreadcrumb(r.logTail)
        if (r.ok) {
          finishRemote(r.exit ?? 0, null, {
            durationMs: r.durationMs,
            taskId: r.taskId,
            logFile: r.logFile,
          })
          return
        }
        finishRemote(r.exit ?? 1, r.message || r.error || '远程执行器失败', {
          durationMs: r.durationMs,
          taskId: r.taskId,
          logFile: r.logFile,
        })
      })
      .catch((e) => {
        finishRemote(1, `远程执行器异常: ${String((e && e.message) || e)}`)
      })

    return { ok: true, runId, pid: null, startedAt, executor: 'http', remote: true }
  }

  function closeQuietly(...fds) {
    for (const fd of fds) {
      if (fd === null || fd === undefined) continue
      try {
        fs.closeSync(fd)
      } catch {
        /* 已经关了 */
      }
    }
  }

  /** 停掉所有子进程 / 尽力取消远程任务（桥/调度进程退出时调用） */
  function stop() {
    stopRequested = true
    const killed = []
    for (const [key, e] of running) {
      try {
        if (e.child && typeof e.child.kill === 'function') {
          e.child.kill('SIGTERM')
          killed.push(key)
        } else if (e.remote) {
          // 远程任务：取消是**尽力而为**（项目没实现 cancelUrl 时只停止跟踪）。
          // 刻意不 await：stop() 的调用方是进程退出路径，不能等网络。
          if (e.provider && e.taskId) {
            cancelScheduleProvider(e.provider, e.taskId).catch(() => {})
          }
          running.delete(key)
          killed.push(key)
        }
      } catch {
        /* 进程可能刚好退了 */
      }
    }
    return killed
  }

  return {
    start,
    stop,
    isRunning,
    runningCount: () => running.size,
    runningKeys: () => [...running.keys()],
    overlapSkipped: () => overlapSkipped,
    runningInfo: (key) => {
      const e = running.get(key)
      return e ? { runId: e.runId, pid: e.pid, startedAt: e.startedAt, remote: !!e.remote } : null
    },
  }
}
