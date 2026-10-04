/**
 * 调度域（桥侧薄壳，2026-08-24 拆分；**v2.3 换成引擎自带定时器**）
 *
 * ## 这一层现在是什么
 *
 * v2.3 起，定时调度是**引擎能力**（`crosspost-runtime/src/scheduler/`）：
 * 声明 → SlotSpec → 纯策略判定 → argv 直传执行，跨平台同一套语义。
 * 本文件只剩三件事：
 *   ① 把 Console/HTTP 的读写接到调度器上（`/proxy/schedule*` 的四个 handler）
 *   ② 把"项目作用域"翻译成调度器的查询参数（`currentProject()` → `projectId`）
 *   ③ 迁移期的一支**只读**检测：`~/Library/LaunchAgents` / `~/.config/systemd/user`
 *      下还留着旧的槽位任务吗？留着就必须说出来——旧任务会与新定时器**双发**。
 *
 * ## 被删掉的是什么（约 600 行）
 *
 * plist 生成/学习（`buildSlotPlistXml`/`readPlistTemplate`）、`launchctl` 命令计划与
 * 幂等回退（`slotCommands`/`applySlotCommands`）、label 前缀探测（`detectLabelPrefix`）、
 * 槽位命名空间迁移（`migrateSlotNamespace`）、launchctl 状态判定（`parseDisabled`/`parseLoaded`）。
 * 它们存在的前提是"触发由操作系统负责"，而那个前提已经没有了。
 *
 * **保留**：`bridge/install-launchd.sh` 与 `bridge/install-systemd.sh`——它们守护的是
 * **桥进程**（"谁在跑那个定时器"），与槽位调度是两件事。
 * `launchctl` 现在只在本文件的**只读迁移检测**里被提及，不再被调用。
 */
import path from 'node:path'
import { readFullRuntimeConfig, writeConfigScoped } from './cli-worker.mjs'
import { currentProject } from '../crosspost-runtime/src/project-context.mjs'
import {
  DEFAULT_SLOT_TEMPLATES,
  declarationPath,
  normalizeSlotId,
  normalizeSlotTime,
} from '../crosspost-runtime/src/scheduler/spec.mjs'
import { getProject, projectRootOf } from '../crosspost-runtime/src/projects.mjs'
import { legacyTasks, parseLegacyLabel } from '../crosspost-runtime/src/scheduler/legacy.mjs'
import {
  createScheduler,
  projectSpecs,
  schedulerSettings,
} from '../crosspost-runtime/src/scheduler/index.mjs'

/** 历史导出：模板槽位（`label` 是旧字段名，Console 早期版本用过） */
export const SLOT_DEFS = DEFAULT_SLOT_TEMPLATES.map((d) => ({
  slot: d.slot,
  label: d.label,
  time: d.time,
}))

export { normalizeSlotId, normalizeSlotTime }

/** 桥内那一个调度器实例（`bridge/run-bridge.mjs` 启动/停止它） */
const scheduler = createScheduler({ host: 'bridge' })

/** 后端只有一个（引擎自带定时器）；保留此导出是为了不改既有调用点 */
export function schedulerProvider() {
  return 'internal'
}

/** 当前调度所属项目（请求上下文里那个）；无上下文 → `''`（默认域） */
export function currentScheduleProject() {
  try {
    return currentProject() || ''
  } catch {
    return ''
  }
}

/** 启动/停止调度器（桥的 `stopAll` 必须调用 stop，否则子进程会被落成孤儿） */
export function startScheduler() {
  return scheduler.start()
}

export function stopScheduler() {
  return scheduler.stop()
}

export function schedulerInstance() {
  return scheduler
}

/* ── 迁移期只读检测 ──────────────────────────────────────────── */

/**
 * 还留着的旧调度任务（launchd plist / systemd 单元）。
 *
 * 实现搬到了引擎侧（`crosspost-runtime/src/scheduler/legacy.mjs`），因为迁移器
 * （`scheduler migrate`）也要用同一套解析——两份实现必然只修一边。
 * 这里保留同名导出，Console/doctor 的调用点不用改。
 */
export function legacyTaskDetected() {
  return legacyTasks()
}

export { parseLegacyLabel }

/* ── 查询 ────────────────────────────────────────────────────── */

/** 某项目的调度声明文件路径（给 Console/报错提示用；项目未注册 → null） */
export function declarationFileOf(projectId) {
  const proj = projectId ? getProject(projectId) : null
  if (!proj || !proj.valid) return null
  return declarationPath(projectRootOf(proj.sourcePath))
}

/** 某项目当前生效的槽位定义（不含运行态；Console 的静态渲染用它） */
export function effectiveSlots(projectId = currentScheduleProject()) {
  const { specs } = projectSpecs(projectId, { tz: schedulerSettings().tz })
  return specs.map((s) => ({
    id: s.id,
    name: s.name,
    time: s.time,
    configTime: s.configTime,
    enabled: s.enabled,
    source: s.source,
    command: s.command,
    commandMissing: s.commandAvailable === false,
  }))
}

/** 调度总状态（Console 的 `/proxy/schedule`）
 *
 * 保持 `async`：调用方一律写 `await getScheduleStatus()`（`/proxy/schedule` 的 handler
 * 与 `schedule.test.mjs` / `verify-scheduled-run.mjs` 都是），且历史上这里有
 * `getScheduleStatus().catch(...)` 的兜底写法 —— 同步化只会让任何残留的 `.catch`/Promise
 * 链立刻 TypeError，把"排程读不到"升级成整页 500，没有收益。 */
export async function getScheduleStatus() {
  const projectId = currentScheduleProject()
  const st = scheduler.status({ projectId })
  const legacy = legacyTaskDetected()
  const notes = []
  if (!st.lockHeldByUs)
    notes.push(
      '内置定时器当前不由本进程持有：另一个宿主（独立 scheduler 进程）在跑，或调度尚未启动。',
    )
  if (legacy.length)
    notes.push(
      `检测到 ${legacy.length} 个旧的系统调度任务（${legacy
        .map((l) => l.unit || path.basename(l.file).replace(/\.plist$/, ''))
        .join('、')}）：它们与内置定时器会**双发**，请执行 scheduler migrate 迁移并清理。`,
    )
  const settings = schedulerSettings()
  const decl = projectId
    ? projectSpecs(projectId, { tz: settings.tz })
    : { specs: [], warnings: [] }
  return {
    ...st,
    provider: 'internal',
    supported: true,
    project: projectId || null,
    tz: settings.tz,
    legacyTasks: legacy,
    notes,
    // 去重：`status()` 内部已经采过一遍全部项目（含本项目的告警），下面这一遍是为了
    // 拿本项目的 `declaration`。同一句话不去重就会在 Console 里连出两条
    // （2026-09-25 在容器里看到 "…未声明 capabilities.schedule" 显示两遍）。
    //
    // 这里**只有旧调度任务**（会双发、有动作可做）。"名字像旧任务但没有到点触发"的
    // 常驻服务（槽位执行器那类）不进本响应：它既不是失败也无动作，曾因此在 Console
    // 顶部常驻一行废话。要查用 `npm run doctor` 或 `scheduler-cli.mjs tasks`。
    warnings: [...new Set([...st.warnings, ...(decl.warnings || [])])],
    declaration: decl.specs.length
      ? { file: decl.specs[0].declarationFile, projectRoot: decl.specs[0].projectRoot }
      : null,
    // 生效层的槽位开关（项目域 = 覆盖层 > 引擎层）：Console 用它显示开关的真实来源
    config: readFullRuntimeConfig().schedule || {},
  }
}

/* ── 写入（桥是唯一写者） ─────────────────────────────────────── */

function findSpec(slot) {
  const id = normalizeSlotId(slot)
  if (!id) return null
  const projectId = currentScheduleProject()
  const st = scheduler.status({ projectId })
  return { id, projectId, row: st.slots.find((s) => s.slot === id) || null }
}

/**
 * 槽位开关。
 *
 * 槽位全部来自项目 → 一律写**项目覆盖层**（`schedule` 是项目级键，见 config-layers 的白名单）。
 * `schedule[slot] === false` 是唯一"停"的写法：未设 → 跑（与门禁 `cli slotEnabled` 的
 * fail-open 语义逐字一致，既有 `run_once.sh` 不用改）。
 *
 * 2026-09-25：原先还有一支"引擎内置任务（日历提醒）写引擎层"的分支；引擎侧日历提醒退役后
 * 槽位不再有两种作用域，那一支随之删除（留着它就是一条永远为假的路）。
 */
export async function setScheduleSlot(slot, enabled) {
  const found = findSpec(slot)
  if (!found) return { error: 'invalid_slot_id', message: '槽位 id 非法' }
  const { id, projectId, row } = found
  if (!row) {
    return {
      error: 'unknown_slot',
      message: `这个项目里没有槽位 ${id}：先在 ${projectId ? `.crosspost/schedule.json` : '项目'} 里声明它`,
    }
  }
  const want = !!enabled
  writeConfigScoped((cfg) => {
    cfg.schedule = cfg.schedule || {}
    cfg.schedule[id] = want
    if (Array.isArray(cfg.slots))
      for (const s of cfg.slots) if (normalizeSlotId(s && (s.id || s.slot)) === id) s.enabled = want
  })
  scheduler.refresh()
  scheduler.tick()
  const after = scheduler.status({ projectId }).slots.find((s) => s.slot === id)
  return {
    ok: true,
    slot: id,
    enabled: want,
    armed: after ? after.armed : null,
    backend: 'internal',
    next: after ? after.next : null,
  }
}

/**
 * 新增/修改槽位的**显示与时间**（不再创建任何系统任务）。
 *
 * v2.3 起"命令"只能来自项目声明 `.crosspost/schedule.json`，所以：
 *   · 声明里有这个槽位 → 名称/时间/开关写进项目配置（UI 权威）
 *   · 声明里没有 → 结构化报错，并给出该写哪一行（引擎不替项目编造命令）
 */
export async function upsertScheduleSlot({ id, name, time, enabled } = {}) {
  const projectId = currentScheduleProject()
  const slotId = normalizeSlotId(id)
  if (!slotId)
    return { error: 'invalid_slot_id', message: '槽位 id 只允许小写字母/数字/横线，且以字母开头' }
  const hhmm = normalizeSlotTime(time)
  if (!hhmm) return { error: 'invalid_time', message: '时间格式应为 HH:MM（00:00–23:59）' }
  if (!projectId)
    return {
      error: 'no_project_context',
      message: '槽位属于项目：先在顶部选一个项目（槽位只能来自项目声明，引擎不自带任务）',
    }

  const row = scheduler.status({ projectId }).slots.find((s) => s.slot === slotId)
  if (!row)
    return {
      error: 'no_slot_spec',
      message:
        `槽位 ${slotId} 没有命令声明。v2.3 起槽位的命令由项目声明：` +
        `在该项目根的 .crosspost/schedule.json 的 slots 里加一条（例：` +
        `"${slotId}": { "time": "${hhmm}", "command": ["bash", "scripts/run_once.sh", "${slotId}"] }` +
        `），保存后回到这里改名称/时间/开关。`,
      slot: slotId,
      declarationFile: declarationFileOf(projectId),
    }

  const before = row.enabled
  const want = typeof enabled === 'boolean' ? enabled : before
  writeConfigScoped((cfg) => {
    const list = Array.isArray(cfg.slots) ? [...cfg.slots] : []
    const entry = {
      id: slotId,
      name: String(name || row.label || slotId),
      time: hhmm,
      enabled: want,
    }
    const at = list.findIndex((x) => normalizeSlotId(x && (x.id || x.slot)) === slotId)
    if (at >= 0) list[at] = entry
    else list.push(entry)
    cfg.slots = list
    cfg.schedule = cfg.schedule || {}
    cfg.schedule[slotId] = want
  })
  scheduler.refresh()
  scheduler.tick()
  const after = scheduler.status({ projectId }).slots.find((s) => s.slot === slotId)
  return {
    ok: true,
    slot: slotId,
    action: row.source === 'declaration' ? 'updated' : 'created',
    time: hhmm,
    enabled: want,
    next: after ? after.next : null,
    backend: 'internal',
  }
}

/**
 * 删除槽位定义（只删**引擎侧**那条记录）。
 *
 * 命令声明在项目文件里，引擎不替项目改它——所以声明过的槽位这里会明确拒绝，
 * 并把该改的文件告诉调用方；只有"配置里有、项目里没有"的残留槽位才删得掉
 * （那正是 v2.3 之前留下的历史条目）。
 */
export async function removeScheduleSlot(id) {
  const projectId = currentScheduleProject()
  const slotId = normalizeSlotId(id)
  if (!slotId) return { error: 'invalid_slot_id' }
  if (!projectId) return { error: 'no_project_context', message: '槽位属于项目：先选一个项目' }
  const st = scheduler.status({ projectId })
  const row = st.slots.find((s) => s.slot === slotId)
  if (row && row.source === 'declaration')
    return {
      error: 'declared_slot_not_removable',
      message:
        `槽位 ${slotId} 的命令声明在项目里（.crosspost/schedule.json）。` +
        `请从该文件删掉这一条；引擎不往接入项目的仓库里写配置。` +
        `（只想停跑的话，直接把开关关掉即可。）`,
    }
  writeConfigScoped((cfg) => {
    if (Array.isArray(cfg.slots))
      cfg.slots = cfg.slots.filter((x) => normalizeSlotId(x && (x.id || x.slot)) !== slotId)
    if (cfg.schedule) delete cfg.schedule[slotId]
  })
  scheduler.refresh()
  scheduler.tick()
  return { ok: true, slot: slotId, action: 'removed', remaining: effectiveSlots(projectId).length }
}

/** 手动触发一次（不受"每天最多一次"限制） */
export function triggerScheduleSlot({ slot, projectId } = {}) {
  const pid = projectId === undefined ? currentScheduleProject() : projectId
  return scheduler.trigger({ projectId: pid, slotId: slot })
}

/** 调度器数据目录（诊断用） */
export function schedulerDataDir() {
  return scheduler.status({}).schedulerDir
}
