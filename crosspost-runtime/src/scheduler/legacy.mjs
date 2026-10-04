/**
 * 旧调度任务的识别与解析（v2.3，只读，迁移用）
 *
 * v2.3 把"到点触发"从操作系统搬进了引擎，但**旧任务不会自己消失**：
 * 本机实测还剩 6 个（5 个写作槽位 plist + 1 个日历提醒 plist）。不清掉的话
 * 每天会被两套东西各触发一次——重复生成、重复推送（虽然恒草稿，但白烧时间与 token）。
 *
 * 这个模块只做三件事：
 *   · `legacyTasks()`  扫出旧任务（launchd plist / systemd 单元），**只读**
 *   · `parsePlist()`   把 plist 里的命令/时间/环境/日志目录读出来（迁移的唯一依据）
 *   · `relativeIfInside()` 把绝对路径写成相对项目根的形态，让声明文件可读、可携带
 *
 * 判据是"**有没有到点触发**"，不是"名字像不像"（2026-09-25 修正）：只按文件名认会把
 * 项目自己的**常驻执行器服务**（`RunAtLoad + KeepAlive`，自己不会到点跑）报成旧调度任务，
 * 并建议去迁移它。无触发的那些进 `legacyDaemons()`，只作中性提示。
 *
 * 为什么保留它（而不是删干净）：这是一条**永久**的防线，不是历史包袱。
 * 只要有人手工 bootstrap 一个旧 plist，双发就会回来；检测是只读的、20 行量级。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 旧 label/单元名前缀：引擎自有命名空间 + 历史前缀（既有部署用过 `com.wechatauto.*`） */
export const LEGACY_PREFIXES = ['com.crosspost.', 'com.wechatauto.']

/** 明确**不是**槽位调度的任务：桥自身守护、项目自己的生成提供者 */
export const NON_SLOT_NAMES = new Set(['bridge', 'generate-provider', 'scheduler'])

/**
 * 引擎内置任务的历史 label —— **留给历史遗留 plist 的卸载路径**。
 *
 * 日历提醒（`calendar-remind`）在 2026-09-25 随日历模块退役，引擎不再自带任何任务。
 * 但这张表**不能跟着删**：别的机器上可能还装着 `com.*.calendar-remind.plist`，
 * 迁移器若不认得它，就会把它当成**项目槽位**学进 `.crosspost/schedule.json`
 * —— 那条声明指向已经删掉的 `remind_calendar.sh`，等于"迁移"亲手造出一个必炸的槽位。
 * 认出来才能只卸载、不学习。
 */
export const ENGINE_LEGACY_SLOTS = new Set(['calendar-remind'])

/** 旧任务的扫描目录（`CROSSPOST_LEGACY_TASKS_DIR` 供测试隔离） */
export function legacyAgentsDir() {
  if (process.env.CROSSPOST_LEGACY_TASKS_DIR) return process.env.CROSSPOST_LEGACY_TASKS_DIR
  return path.join(process.env.HOME || '', 'Library', 'LaunchAgents')
}

export function legacySystemdDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config')
  return process.env.CROSSPOST_LEGACY_SYSTEMD_DIR || path.join(base, 'systemd', 'user')
}

/**
 * label → `{ project, slot }`。
 *
 * 形态：`<前缀><槽位>`（默认域）或 `<前缀><项目>.<槽位>`（项目域）。
 * 不是槽位调度的（桥自身、生成提供者）→ `null`。
 */
export function parseLegacyLabel(name) {
  const prefix = LEGACY_PREFIXES.find((p) => name.startsWith(p))
  if (!prefix) return null
  const rest = name.slice(prefix.length)
  if (!rest) return null
  if (NON_SLOT_NAMES.has(rest)) return null
  const dot = rest.indexOf('.')
  const project = dot < 0 ? '' : rest.slice(0, dot)
  const slot = dot < 0 ? rest : rest.slice(dot + 1)
  if (!slot || slot.includes('.')) return null
  if (NON_SLOT_NAMES.has(slot)) return null
  return { project, slot }
}

/**
 * 一个 launchd plist 里有没有"到点触发"。
 *
 * 为什么必须看这个（2026-09-25，本机实测踩到）：判断"会与内置定时器双发"的前提是
 * **这个任务自己有触发**。而 2026-09-25 新加的**槽位执行器**（能力钩子，见
 * `docs/scheduling.md` §4b）恰好也是一个 launchd 任务，形态却是
 * `RunAtLoad + KeepAlive` 的**常驻服务**：它只是一直在听 HTTP，自己不会到点跑任何东西。
 * 旧实现只按**文件名**认（`com.wechatauto.*` 就报），于是把执行器服务报成
 * "旧的系统调度任务仍在……请执行 scheduler migrate 迁移并清理"——照这句做，
 * 迁移器会读到一个没有时间点的 plist 并把它标成 blocked（迁移不了，白折腾）。
 *
 * 两种触发形态都要认：`StartCalendarInterval`（到点）与 `StartInterval`（每隔 N 秒）。
 * 都没有 → 只有 KeepAlive/RunAtLoad，是服务不是调度。
 */
export function plistScheduleTrigger(xml) {
  const text = String(xml || '')
  // 只认**时钟触发**（这两把键）——警告的原话是"会与内置定时器**双发**"，而双发的前提
  // 是"同一时刻各触发一次"。`KeepAlive`/`RunAtLoad` 是常驻与登录自启，
  // `WatchPaths`/`Sockets` 是事件触发，都不是"到点"。
  const hasCalendar = text.includes('<key>StartCalendarInterval</key>')
  const hasInterval = text.includes('<key>StartInterval</key>')
  if (!hasCalendar && !hasInterval) return null
  const times = [
    ...text.matchAll(
      /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g,
    ),
  ]
  if (hasCalendar && times.length) return { kind: 'calendar', times: times.length }
  const every = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)
  if (every && Number(every[1]) > 0) return { kind: 'interval', seconds: Number(every[1]) }
  // 键在了、形态却认不出来（写法怪/新键）：**按任务处理**。这里宁可误报也不能沉默 ——
  // 沉默的代价是某天被触发两次而没人知道，"误报"的代价只是多看一眼。
  return { kind: 'unknown' }
}

/**
 * 扫旧任务与"像旧任务、其实不是"的常驻服务（只读；目录不存在 → 空数组）。
 *
 * 返回 `{ tasks, daemons }`：
 *   · `tasks`   —— 有触发、真的会双发的旧调度任务（要报、要迁、要卸）
 *   · `daemons` —— 名字落在旧命名空间、但**没有触发**的常驻服务（槽位执行器/生成提供者那类）。
 *     不报成"旧调度任务"，但要**说出来**（Console 上一行中性提示）：否则下一个人
 *     看到自己的执行器服务凭空消失，只会更困惑——这正是本次那个误报的镜像错误。
 *
 * 读不出的 plist **算任务**（保守）：读不到内容就证明不了它无害，宁可按双发处理。
 */
export function scanLegacy({ agentsDir, systemdDir } = {}) {
  const tasks = []
  const daemons = []
  const la = agentsDir || legacyAgentsDir()
  try {
    for (const f of fs.readdirSync(la)) {
      if (!f.endsWith('.plist')) continue
      const label = f.replace(/\.plist$/, '')
      const parsed = parseLegacyLabel(label)
      if (!parsed) continue
      const file = path.join(la, f)
      let trigger = null
      let readable = true
      try {
        trigger = plistScheduleTrigger(fs.readFileSync(file, 'utf8'))
      } catch {
        readable = false
      }
      const entry = { kind: 'launchd', file, label, ...parsed }
      if (trigger || !readable) tasks.push({ ...entry, trigger, readable })
      else daemons.push(entry)
    }
  } catch {
    /* 目录不存在（非 macOS / 全新环境）→ 没有旧任务 */
  }
  const sd = systemdDir || legacySystemdDir()
  try {
    const files = fs.readdirSync(sd)
    const seen = new Set()
    for (const f of files) {
      const m = /^(crosspost-.+)\.(service|timer)$/.exec(f)
      if (!m) continue
      if (seen.has(m[1])) continue
      seen.add(m[1])
      const entry = { kind: 'systemd', file: path.join(sd, f), unit: m[1], project: '', slot: m[1] }
      // 只有 `.service` 而没有配套 `.timer` = 没人到点拉起它，同 launchd 的无触发形态
      if (files.includes(`${m[1]}.timer`)) tasks.push(entry)
      else daemons.push(entry)
    }
  } catch {
    /* 同上 */
  }
  return { tasks, daemons }
}

/** 扫出旧调度任务（只读；目录不存在 → 空数组） */
export function legacyTasks(opts) {
  return scanLegacy(opts).tasks
}

/** 扫出"名字像旧任务、其实是无触发的常驻服务"（槽位执行器等；只读） */
export function legacyDaemons(opts) {
  return scanLegacy(opts).daemons
}

const unesc = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 解析槽位 plist（只认引擎需要的那几个键）。
 *
 * 关键点：`StartCalendarInterval` 既可能是**单个 dict**（写作槽位），
 * 也可能是**数组**（日历提醒 08:00 + 12:00）——两种都要读得出来，
 * 否则迁移会在"数组那一个"上悄悄漏掉一个时间点。
 */
export function parsePlist(xml) {
  const text = String(xml || '')
  const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1] || null
  const argvBlock =
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] || ''
  const argv = [...argvBlock.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unesc(m[1]))
  const times = [
    ...text.matchAll(
      /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g,
    ),
  ].map((m) => `${pad2(Number(m[1]))}:${pad2(Number(m[2]))}`)
  const envBlock =
    /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] || ''
  const env = {}
  for (const m of envBlock.matchAll(/<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/g))
    env[unesc(m[1])] = unesc(m[2])
  const outPath = /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
  const errPath = /<key>StandardErrorPath<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
  // path.resolve 而不是 path.dirname：plist 里常见 `…/scripts/../logs/x.log` 这种写法，
  // 不归一化会让"声明里的 logDir"看起来指向另一个目录（迁移报告也就不可读）。
  const logDir = outPath
    ? path.dirname(path.resolve(unesc(outPath)))
    : errPath
      ? path.dirname(path.resolve(unesc(errPath)))
      : null
  return { label, argv, times, env, logDir }
}

/** 绝对路径在项目根内 → 写成相对形态（声明文件更可读、可携带）；否则原样 */
export function relativeIfInside(projectRoot, abs) {
  if (!projectRoot || !abs) return abs
  const rel = path.relative(projectRoot, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs
  return rel
}

/** 判断某个 argv 是否像路径（与 spec.mjs 的规则一致） */
export function looksLikePathArg(arg) {
  return typeof arg === 'string' && (arg.includes('/') || arg.startsWith('.'))
}
