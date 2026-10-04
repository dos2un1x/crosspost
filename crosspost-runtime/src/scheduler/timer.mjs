/**
 * 触发策略（v2.3，调度子系统）——**纯函数**，不碰 IO、不碰时钟以外的东西
 *
 * 这一层是 v2.3 从操作系统手里接过来的语义。以前"到点会不会跑"由 launchd 的
 * `StartCalendarInterval` 与 systemd 的 `OnCalendar` 决定，我们只能猜；现在规则全在这里，
 * 因此可以被穷举测试（含跨天、DST、睡眠恢复、崩溃重启）。
 *
 * 规则（docs/scheduling.md 有同一张表）：
 *   ① 每个槽位**每天最多自动跑一次**——睡眠、重启、崩溃都不会重复发文
 *   ② 到点前 → 等；到点后仍在补跑窗口内 → 补跑（记为 catchup）
 *   ③ 超过窗口 → 当天放弃（记为 missed-window），并给出明天的下一次触发点
 *   ④ 上次"有头无尾"（intent 写了但没结果）→ 当天不重跑，标 unfinished
 *   ⑤ 人工触发不受 ① 限制（`force: true`）
 */
import { tzNextOccurrence, tzDayKey, tzInstantForWallClock, tzParts, normalizeTz } from '../tz.mjs'

/** `decideFire` 的动作 */
export const ACTIONS = {
  FIRE: 'fire',
  WAIT: 'wait',
  SKIP: 'skip',
}

/** `decideFire` 的原因（同时是 Console 的可见文案键） */
export const REASONS = {
  DISABLED: 'disabled',
  COMMAND_MISSING: 'command-missing',
  /** 项目声明了远程（http）执行器，但端点不可用（被策略拒绝 / 字段不合法） */
  EXECUTOR_UNAVAILABLE: 'executor-unavailable',
  ALREADY_TODAY: 'already-ran-today',
  UNFINISHED: 'unfinished',
  NOT_DUE: 'not-due',
  DUE: 'due',
  CATCHUP: 'catchup',
  MISSED: 'missed-window',
  MANUAL: 'manual',
}

/** 到点后多久内算"准点"而不是"补跑"（进运行记录用） */
export const ON_TIME_SLACK_MINUTES = 2

/** 今天（按槽位时区）该槽位的计划时刻；返回绝对瞬间 */
export function scheduledToday(spec, now = Date.now()) {
  const p = tzParts(spec.tz, now)
  return tzInstantForWallClock(spec.tz, p.year, p.month, p.day, ...splitTime(spec.time))
}

/** 下一个（严格晚于 now 的）计划时刻 */
export function nextOccurrence(spec, now = Date.now()) {
  return tzNextOccurrence(spec.time, normalizeTz(spec.tz), now)
}

function splitTime(hhmm) {
  const [h, m] = String(hhmm)
    .split(':')
    .map((x) => Number(x))
  return [h, m]
}

/** 方便 Console 显示的 `YYYY-MM-DD HH:MM`（按槽位时区） */
export function formatAt(tz, ts) {
  const p = tzParts(tz, ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

/**
 * 一次判定：现在该不该跑这个槽位。
 *
 * @param {object} o
 * @param {object} o.spec   槽位规格（含 time/tz/enabled/commandAvailable）
 * @param {number} o.now    当前时间（毫秒）
 * @param {object} o.record 今天该槽位的运行记录摘要（见 store.slotDayState）
 * @param {number} o.catchUpMaxMinutes 补跑窗口（0 = 不补跑）
 * @param {boolean} [o.force] 人工触发：跳过 ①②④
 * @returns {{action:'fire'|'wait'|'skip', reason:string, trigger?:string, at?:number, next:number}}
 */
export function decideFire({
  spec,
  now = Date.now(),
  record = {},
  catchUpMaxMinutes = 120,
  force = false,
}) {
  const tz = normalizeTz(spec.tz)
  const next = nextOccurrence(spec, now)
  if (force)
    return { action: ACTIONS.FIRE, reason: REASONS.MANUAL, trigger: 'manual', at: now, next }
  if (!spec.enabled) return { action: ACTIONS.SKIP, reason: REASONS.DISABLED, next }
  if (spec.commandAvailable === false)
    return { action: ACTIONS.SKIP, reason: REASONS.COMMAND_MISSING, next }

  const today = tzDayKey(tz, now)
  if (record.completedDay === today)
    return { action: ACTIONS.SKIP, reason: REASONS.ALREADY_TODAY, next }
  if (record.unfinishedDay === today)
    return { action: ACTIONS.SKIP, reason: REASONS.UNFINISHED, next }

  const at = scheduledToday(spec, now)
  if (now < at.getTime())
    return { action: ACTIONS.WAIT, reason: REASONS.NOT_DUE, at: at.getTime(), next: at.getTime() }

  const lateMinutes = (now - at.getTime()) / 60000
  const window = Number.isFinite(catchUpMaxMinutes) ? Math.max(0, catchUpMaxMinutes) : 120
  if (window === 0 || lateMinutes > window)
    return { action: ACTIONS.SKIP, reason: REASONS.MISSED, at: at.getTime(), next }
  return {
    action: ACTIONS.FIRE,
    reason: lateMinutes <= ON_TIME_SLACK_MINUTES ? REASONS.DUE : REASONS.CATCHUP,
    trigger: lateMinutes <= ON_TIME_SLACK_MINUTES ? 'schedule' : 'catchup',
    at: at.getTime(),
    next,
  }
}

/**
 * 分段睡眠：一次最多睡 `maxSliceMs`，醒来后由调用方重新判定。
 *
 * 为什么不直接睡到下一个触发点：机器休眠、时钟被改、DST 跳变都会让"睡够 N 毫秒"
 * 与"墙钟到点"脱钩。分段醒来重新判定是唯一不用信任长睡眠的写法。
 * 代价是每分钟一次空判定（纯计算，无 IO）。
 */
export const DEFAULT_SLICE_MS = 60000

export function sliceSleepMs(nextAt, now = Date.now(), maxSliceMs = DEFAULT_SLICE_MS) {
  const delta = Math.max(0, nextAt - now)
  return Math.min(delta, maxSliceMs)
}
