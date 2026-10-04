/**
 * 时区工具（2026-08-24 时区统一）：
 * 计费/调度等业务时间一律按 Asia/Shanghai（北京时间）判定，
 * 不依赖运行机器本地时区设置。
 *
 * 2026-09-24（v2.3，调度子系统）：本模块从"只服务北京时间"扩展成**任意 IANA 时区的
 * 墙钟换算**，因为引擎自有定时器要能兑现使用者声明的时区（`scheduler.tz`）。
 *
 * 为什么必须自己做换算而不是用 `new Date().setHours()`：后者按**进程本地时区**解释，
 * 于是同一份配置在宿主机、容器（TZ 不同）、CI 上会落在不同的绝对时刻——
 * 这是"调度看着配对了、实际偏移"的根因。这里用 `Intl` 的时区库做两件事：
 *   ① 把任意瞬间拆成某时区的墙钟（`tzParts`）
 *   ② 把某时区的墙钟还原成绝对瞬间（`tzInstantForWallClock`，迭代修正偏移）
 * 纯函数、零第三方依赖，因此三种平台上都能在 macOS 上被测试。
 */
import path from 'node:path'

/** 业务默认时区（与历史行为一致：计费/调度都按北京时间） */
export const DEFAULT_TZ = 'Asia/Shanghai'

const TZ = DEFAULT_TZ

/** 时区名 → Intl 格式化器（按需创建并缓存；`formatToParts` 是唯一可靠的非本地时区取值方式） */
const partFmtCache = new Map()
function partFormatter(tz) {
  let f = partFmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hour12: false,
    })
    partFmtCache.set(tz, f)
  }
  return f
}

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const pad2 = (n) => String(n).padStart(2, '0')

/** 时区名是否被运行环境认识（不认识就回退默认时区，而不是让调度整体失败） */
export function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false
  try {
    partFormatter(tz)
    return true
  } catch {
    return false
  }
}

/** 规范化时区名：非法/缺失 → 默认时区 */
export function normalizeTz(tz) {
  return isValidTz(tz) ? String(tz).trim() : DEFAULT_TZ
}

/**
 * 把某个瞬间拆成**指定时区**的墙钟部件。
 *
 * 注意 en-US + hour12:false 下午夜会给出 `24`，这里归一为 `0`
 * （历史 `bjHHMM` 也做过同样处理，属既有约定）。
 */
export function tzParts(tz, ts = Date.now()) {
  const zone = normalizeTz(tz)
  const parts = {}
  for (const p of partFormatter(zone).formatToParts(new Date(ts))) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_MAP[parts.weekday] ?? null,
  }
}

/**
 * 指定时区在某个瞬间的 UTC 偏移（分钟，东为正）。
 *
 * 做法：把该时区的墙钟当成 UTC 读出来，与真实瞬间相减。秒以下截断，
 * 避免毫秒抖动把偏移算成小数。
 */
export function tzOffsetMinutes(tz, ts = Date.now()) {
  const p = tzParts(tz, ts)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const truncated = Math.floor(new Date(ts).getTime() / 1000) * 1000
  return Math.round((asUtc - truncated) / 60000)
}

/**
 * 把指定时区的**墙钟**还原成绝对瞬间（Date）。
 *
 * 迭代修正：先用"墙钟当 UTC"做初值，再按该瞬间的真实偏移回推，直到收敛。
 * DST 切换日不存在的时刻会收敛到邻近合法瞬间（不假装能表示它，策略层另有说明）；
 * 存在的时刻（含切换日另一侧）都能精确落点。
 */
export function tzInstantForWallClock(tz, year, month, day, hour, minute) {
  const zone = normalizeTz(tz)
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  let guess = target
  for (let i = 0; i < 4; i++) {
    const off = tzOffsetMinutes(zone, guess)
    const next = target - off * 60000
    if (next === guess) break
    guess = next
  }
  return new Date(guess)
}

/** 指定时区里的日期串 `YYYY-MM-DD`（runs 文件名与"今日"判定的唯一口径） */
export function tzDayKey(tz, ts = Date.now()) {
  const p = tzParts(tz, ts)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}

/** 指定时区里的 `HH:MM` */
export function tzHHMM(tz, ts = Date.now()) {
  const p = tzParts(tz, ts)
  return `${pad2(p.hour)}:${pad2(p.minute)}`
}

/**
 * 下一个 `HH:MM` 触发点（严格晚于 `now`）。
 *
 * 为什么连续试三天而不是"今天不行就 +86400000"：跨 DST 时一天不是 86400 秒，
 * 加固定毫秒会把 08:30 变成 07:30 或 09:30。按**墙钟**逐日试才是对的。
 */
export function tzNextOccurrence(hhmm, tz = DEFAULT_TZ, now = Date.now()) {
  const zone = normalizeTz(tz)
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!m) throw new Error(`非法时间（应为 HH:MM）: ${hhmm}`)
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) throw new Error(`非法时间（应为 HH:MM）: ${hhmm}`)
  const p = tzParts(zone, now)
  for (let d = 0; d <= 2; d++) {
    const at = tzInstantForWallClock(zone, p.year, p.month, p.day + d, hour, minute)
    if (at.getTime() > now) return at
  }
  // 理论上到不了这里（+2 天必然在 now 之后）；兜底避免返回过去时刻
  return tzInstantForWallClock(zone, p.year, p.month, p.day + 3, hour, minute)
}

/** 两个瞬间是否落在**同一时区日**——"每天最多自动跑一次"的判据 */
export function isSameTzDay(tz, a, b = Date.now()) {
  return tzDayKey(tz, a) === tzDayKey(tz, b)
}

/** 北京时间日期字符串 YYYY-MM-DD */
export function bjDate(ts) {
  return tzDayKey(TZ, ts)
}

/** 北京时间 HH:MM（24h） */
export function bjHHMM(ts) {
  return tzHHMM(TZ, ts)
}

/** 北京时间星期几（0=周日 … 6=周六） */
export function bjWeekday(ts) {
  return tzParts(TZ, ts).weekday
}

/** 北京时间完整判定对象 */
export function bjTime(ts) {
  const d = new Date(ts)
  return { date: bjDate(d), hhmm: bjHHMM(d), weekday: bjWeekday(d) }
}

/** `~` 展开（与 paths.mjs 的规则一致）；调度声明里的路径用它 */
export function expandHomePath(p) {
  if (typeof p !== 'string') return p
  const home = process.env.HOME || ''
  if (p === '~') return home
  if (p.startsWith('~/')) return path.join(home, p.slice(2))
  return p
}
