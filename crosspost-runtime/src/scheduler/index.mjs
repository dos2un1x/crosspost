/**
 * 调度子系统（v2.3）：引擎自有的跨平台定时器
 *
 * ## 它取代了什么
 *
 * v2.3 之前，槽位由 macOS 的 launchd 触发（plist + `launchctl enable/bootstrap`），
 * Linux 上"调度未实现"，容器/Windows 无从谈起。整个触发链依赖 **OS 的日历语义**，
 * 于是"意图"与"注册态"会漂移——2026-09-17 的事故（Console 里关了，次日仍照跑）
 * 就是 macOS 26 把 `StartCalendarInterval` 实现为 XPC 日历活动、
 * 而 `launchctl disable` 只写禁用标记造成的。那一类故障在这里**不可能发生**：
 * 启停就是我们自己的状态。
 *
 * ## 结构
 *
 *   spec.mjs   声明 → SlotSpec（命令从项目声明来，配置只管名称/时间/开关）
 *   timer.mjs  纯策略：什么时候该跑（每天最多一次、补跑窗口、有头无尾不重跑）
 *   runner.mjs 到点执行：argv 直传、日志与旧 launchd 同名、重叠跳过
 *   store.mjs  运行记录（runs-<日期>.jsonl）+ 单实例锁
 *   index.mjs  本文件：把上面四件拼成一个可启动/可停止/可查询的调度器
 *
 * ## 两个宿主，一个实现
 *
 *   · 桥进程内（Console/HTTP 都在，缺省）
 *   · 独立进程 `scheduler-cli.mjs run`（CLI-only 部署 / 容器 / Windows 服务）
 *
 * 两者都走单实例锁：第二个启动的会**拒绝 arm** 并说明锁的持有者，
 * 而不是"两个定时器各跑一遍"。
 */
import { readEngineConfig, readEffectiveConfig } from '../config-layers.mjs'
import { getProject, listProjects, projectRootOf, resolveProjectDataDir } from '../projects.mjs'
import { getLogsDir } from '../resources.mjs'
import { normalizeTz, tzDayKey } from '../tz.mjs'
import { loadDeclaration, mergeSlotSpecs, normalizeSlotId } from './spec.mjs'
import {
  ACTIONS,
  REASONS,
  DEFAULT_SLICE_MS,
  decideFire,
  formatAt,
  nextOccurrence,
} from './timer.mjs'
import { createRunner } from './runner.mjs'
import { resolveScheduleProvider, toSpecExecutor } from '../schedule-provider.mjs'
import { readSlotLastRun, readLogsDir } from './logs.mjs'
import {
  acquireLock,
  appendRun,
  heartbeatLock,
  lockHolderAlive,
  pruneRuns,
  readLock,
  releaseLock,
  schedulerDir,
  slotDayState,
} from './store.mjs'

export const DEFAULT_CATCHUP_MINUTES = 120
export const DEFAULT_MAX_CONCURRENT = 2

/** 从引擎配置读出调度设置（都是引擎级键：与"哪个项目"无关） */
export function schedulerSettings(cfg = readEngineConfig()) {
  const s = (cfg && cfg.scheduler) || {}
  return {
    // 时区**只**由显式配置决定：`CROSSPOST_SCHEDULER_TZ` > `config.scheduler.tz` > 缺省。
    // 刻意不读容器/宿主机的 `TZ`——那会让"同一条槽位声明在不同机器上到点时刻不一样"，
    // 正是"与容器自身时区无关"要避免的漂移。
    tz: normalizeTz(process.env.CROSSPOST_SCHEDULER_TZ || s.tz),
    catchUpMaxMinutes:
      Number.isFinite(Number(s.catchUpMaxMinutes)) && Number(s.catchUpMaxMinutes) >= 0
        ? Number(s.catchUpMaxMinutes)
        : DEFAULT_CATCHUP_MINUTES,
    maxConcurrent:
      Number.isFinite(Number(s.maxConcurrent)) && Number(s.maxConcurrent) > 0
        ? Number(s.maxConcurrent)
        : DEFAULT_MAX_CONCURRENT,
  }
}

/** 一个项目的槽位规格（含声明、配置、日志目录） */
export function projectSpecs(projectId, { tz, now = Date.now() } = {}) {
  const proj = getProject(projectId)
  if (!proj || !proj.valid) return { specs: [], warnings: [`项目 ${projectId} 未注册或无效`] }
  const root = projectRootOf(proj.sourcePath)
  const cfg = readEffectiveConfig(projectId)
  const decl = loadDeclaration(root)
  const dataDir = (resolveProjectDataDir(projectId) || {}).dir || null
  const logsDir = getLogsDir(projectId)
  const warnings = []
  if (decl.found && decl.errors && decl.errors.length)
    warnings.push(...decl.errors.map((e) => `.crosspost/schedule.json: ${e}`))
  else if (!decl.found && Array.isArray(cfg.slots) && cfg.slots.length)
    warnings.push(
      `项目 ${projectId} 的槽位没有命令声明：在项目根放 .crosspost/schedule.json（可用 scheduler migrate 从既有 launchd 任务生成）`,
    )
  // "声明了"有两种形态，**都算声明**：`true`（v1，本地命令执行器）与
  // `{kind:'http',…}`（v2，项目自己跑）。这里因此只看真值，**不比 `=== true`**：
  // 2026-09-25 在容器里实测到反向结论 —— 接入方明明声明的是 http 对象，
  // 旧判据却把"已声明"报成"未声明"，而这行字是要显示在 Console 上的。
  if (decl.found && decl.ok && proj.capabilities && !proj.capabilities.schedule)
    warnings.push(
      `项目 ${projectId} 已有调度声明，但 manifest 未声明 capabilities.schedule（建议补上，Console 才能提示）`,
    )
  // 执行器（2026-09-25）：manifest 声明了 http 执行器时，基座**不跑**项目脚本，
  // 只按端点发 HTTP；声明了但不可用 → 不回落到本地 spawn，照实报不可用。
  const scheduleProvider = resolveScheduleProvider(projectId)
  const executor = toSpecExecutor(scheduleProvider)
  if (executor && executor.unavailable)
    warnings.push(`项目 ${projectId} 的槽位执行器不可用：${executor.reason}`)
  const merged = mergeSlotSpecs({
    projectId,
    projectRoot: root,
    declaration: decl.ok ? decl : { slots: {} },
    configSlots: cfg.slots,
    scheduleMap: cfg.schedule || {},
    tz,
    dataDir,
    logsDir,
    executor,
    now,
  })
  const specs = merged.specs.map((s) => ({
    ...s,
    declarationFile: decl.file,
    declarationFound: !!decl.found,
  }))
  return { specs, warnings: [...warnings, ...merged.warnings] }
}

/** 全部需要被调度的规格：每个有效项目的槽位（引擎不再自带任务，见 spec.mjs 的说明） */
export function collectSpecs({ tz, now = Date.now() } = {}) {
  const cfg = readEngineConfig()
  const settings = schedulerSettings(cfg)
  const zone = tz || settings.tz
  const warnings = []
  const specs = []
  let projects = []
  try {
    projects = listProjects().filter((p) => p.valid && p.id)
  } catch (e) {
    warnings.push(`项目注册表不可读: ${String((e && e.message) || e)}`)
  }
  for (const p of projects) {
    const r = projectSpecs(p.id, { tz: zone, now })
    specs.push(...r.specs)
    warnings.push(...r.warnings)
  }
  return { specs, warnings, settings: { ...settings, tz: zone } }
}

/**
 * 创建调度器。宿主（桥 / 独立进程）只负责 start/stop 与查询，触发语义全在这里。
 */
export function createScheduler({
  host = 'bridge',
  now = () => Date.now(),
  runner: injectedRunner = null,
  tickMs = Number(process.env.CROSSPOST_SCHEDULER_TICK_MS) || DEFAULT_SLICE_MS,
} = {}) {
  const runner = injectedRunner || createRunner({ now })
  let specs = []
  let specByKey = new Map()
  let warnings = []
  let settings = schedulerSettings()
  let lock = null
  let lockLossReason = null
  let started = false
  let stopped = false
  let timer = null
  let lastTickAt = null
  let lastDecisions = new Map() // key -> { action, reason, at, trigger, atMs }
  let firesTotal = 0
  let skippedNoLock = 0

  /**
   * 重新采集规格（引擎配置 + 每个项目的声明）。
   *
   * 为什么每次查询都重读（而不是缓存到下次启动）：最常见的部署顺序就是
   * "先起桥，再接入项目/写 `.crosspost/schedule.json`"——缓存会让新槽位一直看不见，
   * 表现为"我明明配了却没反应"。代价只有几次目录列举与几个小文件读，
   * 而 config 与 overlay 读取本身还带 mtime 缓存。
   */
  function refresh() {
    const t = now()
    const c = collectSpecs({ tz: settings.tz, now: t })
    specs = c.specs
    warnings = c.warnings
    settings = c.settings
    specByKey = new Map(specs.map((s) => [s.key, s]))
    return specs
  }

  function armedReasonOf(spec) {
    if (!spec) return 'unknown-slot'
    if (!lock || !lock.ok) return 'no-lock'
    if (!spec.enabled) return REASONS.DISABLED
    // 远程执行器声明了但不可用：这与"缺命令声明"是两件事，给单独的 reason
    if (spec.executor && spec.executor.unavailable) return REASONS.EXECUTOR_UNAVAILABLE
    if (spec.commandAvailable === false) return REASONS.COMMAND_MISSING
    return null
  }

  function isArmed(key) {
    const s = specByKey.get(key)
    return !!s && armedReasonOf(s) === null
  }

  /** 一次判定循环：所有槽位按策略决定"跑 / 等 / 跳"，并把决定留在状态里给 Console 看 */
  function tick() {
    // 每分钟重读一次规格：新项目接入、新声明落盘、槽位被删，都应当**自动生效**
    // （否则要重启宿主才会被看见——而"改了没反应"正是最难排查的那类问题）。
    refresh()
    const t = now()
    lastTickAt = t

    // 心跳：持有者每 tick 续一次。两个作用（2026-09-25，Docker 实测）：
    //   ① 让**别的 PID 命名空间**（容器 ⇄ 宿主）看得出"这个锁还有人活着"——
    //      跨命名空间 PID 判活无意义，见 store.mjs 里 acquireLock 的长注释；
    //   ② 一旦锁被别人接管/删掉，这里立刻知道，并把定时器降级为"未 arm"，
    //      而不是一边丢锁一边继续点火（那正是"双发"的另一半）。
    if (lock && lock.ok && lock.lock) {
      const beat = heartbeatLock(lock.lock, { now: t })
      lock = beat.ok
        ? { ...lock, lock: beat.lock }
        : {
            ok: false,
            lock: null,
            reclaimed: false,
            reason:
              beat.reason === 'lock-lost'
                ? '锁已被另一个实例接管（本进程不再 arm；停掉多余的实例后重启本进程即可恢复）'
                : `心跳写入失败：${beat.error || beat.reason}`,
          }
    }
    lockLossReason = lock && !lock.ok ? lock.reason || null : null

    for (const spec of specs) {
      const rec = slotDayState(spec.key, tzDayKey(spec.tz, t))
      const d = decideFire({
        spec,
        now: t,
        record: rec,
        catchUpMaxMinutes: settings.catchUpMaxMinutes,
      })
      lastDecisions.set(spec.key, { ...d, decidedAt: t })
      if (d.action !== ACTIONS.FIRE) continue
      if (!isArmed(spec.key)) {
        skippedNoLock += 1
        lastDecisions.set(spec.key, {
          ...d,
          action: ACTIONS.SKIP,
          reason: armedReasonOf(spec),
          decidedAt: t,
        })
        continue
      }
      if (runner.runningCount() >= settings.maxConcurrent) {
        lastDecisions.set(spec.key, {
          ...d,
          action: ACTIONS.SKIP,
          reason: 'max-concurrent',
          decidedAt: t,
        })
        continue
      }
      const res = runner.start(spec, { trigger: d.trigger || 'schedule' })
      if (res.ok) firesTotal += 1
      else if (res.reason === 'overlap')
        lastDecisions.set(spec.key, { ...d, reason: 'overlap', decidedAt: t })
    }
  }

  function schedule() {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(
      () => {
        tick()
        schedule()
      },
      Math.max(200, tickMs),
    )
    if (timer.unref) timer.unref()
  }

  function start() {
    if (started) return { ok: true, already: true, lock }
    refresh()
    // 诊断用开关：显式停用定时器（例如临时排查"是不是调度在捣乱"），
    // 只影响 arm，不影响状态查询——状态里会如实写 `disabledByUser`。
    if (process.env.CROSSPOST_SCHEDULER_DISABLE === '1')
      return { ok: false, lock: null, specs: specs.length, warnings, disabledByUser: true }
    stopped = false
    lock = acquireLock({ host, now: now() })
    pruneRuns({ keepDays: 180, todayKey: tzDayKey(settings.tz, now()) })
    started = true
    // 启动即判定一次：桥/机器恢复后，落在补跑窗口内的当天计划会立刻补跑
    tick()
    schedule()
    return { ok: !!lock.ok, lock, specs: specs.length, warnings }
  }

  function stop() {
    stopped = true
    started = false
    if (timer) clearTimeout(timer)
    timer = null
    const killed = runner.stop()
    releaseLock(lock && lock.lock ? lock.lock : null)
    lock = null
    lockLossReason = null
    return { ok: true, killed }
  }

  /** 人工触发（不受"每天一次"限制） */
  function trigger({ key, projectId, slotId, force = true } = {}) {
    const k = key || `${projectId || ''}|${normalizeSlotId(slotId)}`
    const spec = specByKey.get(k)
    if (!spec) return { ok: false, error: `未知槽位: ${k}` }
    if (spec.commandAvailable === false)
      return { ok: false, error: spec.commandReason || '命令不可用', slot: spec.id }
    const d = decideFire({
      spec,
      now: now(),
      record: slotDayState(spec.key, tzDayKey(spec.tz, now())),
      catchUpMaxMinutes: settings.catchUpMaxMinutes,
      force,
    })
    if (d.action !== ACTIONS.FIRE)
      return { ok: false, error: `未触发（${d.reason}）`, slot: spec.id }
    const res = runner.start(spec, { trigger: d.trigger || 'manual' })
    if (!res.ok) return { ok: false, error: res.reason, slot: spec.id }
    return { ok: true, slot: spec.id, ...res }
  }

  /** 状态查询：项目上下文决定显示哪些槽位（槽位全部属于项目；默认域因而为空） */
  function status({ projectId = '' } = {}) {
    // 每次查询都（按 1s 节流）重读规格：没启动调度器的进程查状态也要看到真实槽位，
    // 而不是"把没启动显示成没有槽位"，也不是"配置改了但界面还是旧的"。
    refresh()
    const t = now()
    const wanted = specs.filter((s) => s.projectId === (projectId || ''))
    const logsCache = new Map()
    const rows = wanted.map((spec) => {
      const rec = slotDayState(spec.key, tzDayKey(spec.tz, t))
      const ldir = spec.logDir
      if (ldir && !logsCache.has(ldir)) logsCache.set(ldir, readLogsDir(ldir))
      const last = readSlotLastRun(spec.id, ldir, ldir ? logsCache.get(ldir) : undefined)
      const runningInfo = runner.runningInfo(spec.key)
      const decision = lastDecisions.get(spec.key) || null
      const nextAt = nextOccurrence(spec, t)
      const armedReason = armedReasonOf(spec)
      return {
        slot: spec.id,
        key: spec.key,
        label: spec.name,
        source: spec.source,
        time: spec.time,
        configTime: spec.configTime,
        tz: spec.tz,
        enabled: spec.enabled,
        armed: armedReason === null,
        armedReason,
        decidedReason: decision ? decision.reason : null,
        // 执行器（2026-09-25）：Console 据此显示"这一班是在基座里跑（本地命令）
        // 还是发给项目的执行器（http）"，以及端点不可用时的原因。
        executor: spec.executor
          ? {
              kind: spec.executor.kind,
              url: spec.executor.url || null,
              statusUrl: spec.executor.statusUrl || null,
              gateway: spec.executor.gateway || null,
              unavailable: !!spec.executor.unavailable,
              reason: spec.executor.reason || null,
              source: spec.executor.source || null,
            }
          : { kind: 'command' },
        command: spec.command,
        declaredCommand: spec.declaredCommand,
        cwd: spec.cwd,
        logDir: spec.logDir,
        commandMissing: spec.commandAvailable === false,
        commandReason: spec.commandReason || null,
        declarationFile: spec.declarationFile || null,
        projectRoot: spec.projectRoot || null,
        removable: !!spec.removable,
        editable: !!spec.editable,
        next: formatAt(spec.tz, nextAt),
        nextAt: nextAt.getTime(),
        lastRunAt: last.lastRunAt,
        daysSince: last.daysSince,
        running: !!runningInfo,
        runningSince: runningInfo ? runningInfo.startedAt : null,
        lastExit: rec.lastExit,
        lastDurationMs: rec.lastDurationMs,
        completedToday: !!rec.completedDay,
        unfinished: !!rec.unfinishedDay,
        runsToday: rec.runs,
      }
    })
    rows.sort((a, b) =>
      a.time === b.time ? a.slot.localeCompare(b.slot) : a.time.localeCompare(b.time),
    )
    return {
      backend: 'internal',
      supported: true,
      host,
      tz: settings.tz,
      catchUpMaxMinutes: settings.catchUpMaxMinutes,
      maxConcurrent: settings.maxConcurrent,
      lock: lock && lock.ok ? { ...lock.lock } : readLock(),
      lockHeldByUs: !!(lock && lock.ok),
      // 「另一个实例持有、而且它还活着」→ 本进程不会触发，但**系统是有定时器的**。
      // 为什么必须单独给出来（2026-09-25，docker 实测）：`scheduler-cli status` 是**另一个
      // 进程**，手里永远没有锁，于是"今天还没跑过"的槽位一律显示 `未生效(no-lock)` ——
      // 照文档跑体检的人会以为"定时器坏了"，其实桥正拿着锁。两者必须区分开。
      armedByOther: !(lock && lock.ok) && lockHolderAlive(readLock()),
      // 锁没拿到 / 中途被接管时，槽位的 armedReason 只会说 'no-lock' —— 那是**现象**不是原因。
      // 原因（谁持有、跨命名空间、心跳多久）在这里。
      lockReason: lockLossReason || (lock && !lock.ok ? lock.reason || null : null),
      started,
      lastTickAt,
      firesTotal,
      skippedNoLock,
      overlapSkipped: runner.overlapSkipped(),
      runningCount: runner.runningCount(),
      schedulerDir: schedulerDir(),
      warnings,
      slots: rows,
    }
  }

  return {
    start,
    stop,
    refresh,
    tick,
    trigger,
    status,
    isArmed,
    get specs() {
      return specs
    },
    get settings() {
      return settings
    },
    get lock() {
      return lock
    },
    get runner() {
      return runner
    },
  }
}

export { ACTIONS, REASONS }
export { schedulerDir }
export { appendRun, releaseLock, acquireLock, readLock, slotDayState, pruneRuns }
