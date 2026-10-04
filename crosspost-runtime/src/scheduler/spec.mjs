/**
 * 调度槽位声明（v2.3，调度子系统）
 *
 * ## 为什么需要"声明"
 *
 * v2.3 之前，槽位的**命令**是从操作系统里**学**出来的：引擎读 `~/Library/LaunchAgents`
 * 里既有的 plist，取它的 `ProgramArguments`（`bash <项目脚本> <槽位>`）+ 环境变量 + 日志路径，
 * 再据此生成新的 plist。那套做法与 macOS 强绑定，且"命令从哪来"这件事只存在于别人的
 * 系统文件里——Linux / 容器 / Windows 上无从得知。
 *
 * 现在命令由**项目自己声明**：项目根下 `.crosspost/schedule.json`。它是项目侧的数据文件
 * （不是引擎 manifest，也不允许内联 shell）：
 *
 *   { "version": 1,
 *     "slots": { "hotspot": { "time": "08:30",
 *                             "command": ["bash", "scripts/run_once.sh", "hotspot"],
 *                             "cwd": "pipeline",
 *                             "env": { "CLAUDE_BIN": "/Users/x/.local/bin/claude" },
 *                             "logDir": "pipeline/logs" } } }
 *
 * 为什么是 argv 数组而不是一行 shell：引擎**不解析、不拼接、不展开** shell 语法，
 * 只把数组原样交给 `spawn(cmd, args)`。这样"声明"不可能变成注入任意 shell 的口子，
 * 也让三平台上语义一致（Windows 上不存在 `$VAR`、`&&`、glob 这些 shell 特性）。
 *
 * ## 执行器（2026-09-25）：命令不是唯一的执行方式
 *
 * 上面这套 `command` 的**硬伤**是：引擎在自己的进程/容器里跑项目的业务脚本。
 * 容器化以后这一点会变成硬故障（linux 容器里跑不了宿主原生装的 `dsh`）。所以
 * 项目可以在 manifest 里声明 `capabilities.schedule = {kind:'http',url,…}`，
 * 此时"到点该跑了"变成一次 HTTP 调用，**执行发生在项目自己那边**
 * （解析与策略见 `src/schedule-provider.mjs`）。
 *
 * 本文件里它只体现为一个字段：`spec.executor = null`（本地命令，缺省）或
 * `{kind:'http',…}`。声明了 http 却不可用（端点被策略拒绝/字段不合法）时，
 * 规格里是 `{kind:'http',unavailable:true,reason}`，并让 `commandAvailable=false`
 * —— **绝不回落到本地 spawn**（回落会让边界重新变模糊）。
 *
 * ## 边界（写进 docs/scheduling.md）
 *
 * · 引擎**只读**声明文件；增删槽位命令要去改项目里的那个文件（引擎不往别人仓库里写）。
 * · 相对路径（`cwd` / `logDir` / `command` 里像路径的参数）一律相对**项目根**解析，
 *   且必须落在项目根内——声明不能借 `..` 指到项目外。
 * · 命令是否真的可执行由 `commandAvailable()` 预检，结果照实报给 Console/doctor，
 *   **不静默跳过**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { expandHomePath } from '../tz.mjs'

/** 槽位 id 形状（与既有约定一致：小写字母开头，允许数字与横线） */
export const SLOT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

/** 声明文件位置（相对项目根） */
export const DECLARATION_DIR = '.crosspost'
export const DECLARATION_FILE = 'schedule.json'

/** 声明文件自身的契约版本（与 manifestVersion 无关，各管各的） */
export const DECLARATION_VERSION = 1

/** 全新项目（还没写过 `slots`）看到的**模板**：只是提示，不能运行（没有命令） */
export const DEFAULT_SLOT_TEMPLATES = [
  { slot: 'morning', label: '早报速览', time: '08:10' },
  { slot: 'hotspot', label: '热点解读①', time: '08:30' },
  { slot: 'noon', label: '深度分析①', time: '12:30' },
  { slot: 'hotspot2', label: '热点解读②', time: '13:10' },
  { slot: 'tips', label: '热点解读③', time: '18:10' },
  { slot: 'evening', label: '深度分析②', time: '20:30' },
]

/* 2026-09-25：`ENGINE_SLOT_DEFS` / `engineSlotSpecs()` / `REPO_ROOT` 随**日历提醒**一起删除。
 *
 * 引擎曾经自带两个槽位（08:00 / 12:00 的日历提醒），因此规格层要有"引擎槽位"这一形态：
 * 命令由引擎固定、Console 只允许开关。日历模块退役后**引擎不再自带任何任务**，
 * 于是那一整套（`scope` 字段、引擎配置层写开关、Console 的"引擎任务"徽标与文案）
 * 全部成了永远为假的路，留着只会让下一个人以为还有第二条调度入口。 */

/** 规范化槽位 id（非法 → `''`；`slot` 是历史别名） */
export function normalizeSlotId(input) {
  const s = String(input ?? '')
    .trim()
    .toLowerCase()
  if (!SLOT_ID_RE.test(s)) return ''
  return s
}

/** 规范化 `HH:MM`（接受 `H:M` 简写：`6:7` → `06:07`；非法 → `''`） */
export function normalizeSlotTime(input) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(input ?? '').trim())
  if (!m) return ''
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return ''
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** 声明文件路径 */
export function declarationPath(projectRoot) {
  return projectRoot ? path.join(projectRoot, DECLARATION_DIR, DECLARATION_FILE) : null
}

/** 某个路径是否落在项目根内（含项目根本身） */
export function isInside(root, abs) {
  if (!root || !abs) return false
  const rel = path.relative(path.resolve(root), path.resolve(abs))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 解析相对项目根的路径，并保证不逃出项目根。
 * 绝对路径同样必须落在项目根内（否则报错，不做"静默改用相对路径"这种猜测）。
 */
export function resolveInsideProject(projectRoot, p) {
  const raw = expandHomePath(String(p ?? '').trim())
  if (!raw) return { error: '路径为空' }
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot || '.', raw)
  if (!isInside(projectRoot, abs))
    return { error: `路径逃出项目根：${p} → ${abs}（相对路径按项目根解析，且必须落在项目根内）` }
  return { abs }
}

/** `command` 的某个参数是否"看起来是路径"（只有这类参数才做项目根解析） */
function looksLikePath(arg) {
  return typeof arg === 'string' && (arg.includes('/') || arg.includes('\\') || arg.startsWith('.'))
}

/**
 * 校验并展开 `command`：
 *   ① 必须是非空字符串数组
 *   ② "像路径"的参数按项目根解析，且必须落在项目根内
 *   ③ 其余参数（如槽位名 `hotspot`）原样保留——引擎不猜它的语义
 */
export function resolveCommand(command, projectRoot) {
  const errors = []
  if (!Array.isArray(command) || command.length === 0) {
    return { errors: ['command 必须是非空字符串数组（argv，不是 shell 命令串）'] }
  }
  const argv = []
  command.forEach((part, i) => {
    if (typeof part !== 'string' || !part.trim()) {
      errors.push(`command[${i}] 必须是非空字符串`)
      return
    }
    if (i > 0 && looksLikePath(part)) {
      const r = resolveInsideProject(projectRoot, part)
      if (r.error) {
        errors.push(`command[${i}]：${r.error}`)
        return
      }
      argv.push(r.abs)
      return
    }
    argv.push(part)
  })
  return { argv, errors }
}

/**
 * 命令是否真的能跑起来（只做静态可达性检查，不执行任何东西）。
 *
 * · `argv[0]` 含路径分隔符 → 当作路径解析（相对 `cwd`），要求是文件
 * · 否则按 `PATH` 查找（Windows 上同时试 `PATHEXT`）
 *
 * 返回 `{ ok, resolved, reason }`：`reason` 是给 Console/doctor 照抄的说明，
 * 因为"声明写了但机器上没这个命令"必须显式暴露，而不是到点静默失败。
 */
export function commandAvailable(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const bin = Array.isArray(argv) ? argv[0] : null
  if (!bin) return { ok: false, resolved: null, reason: 'command 为空' }
  const hasSep = bin.includes('/') || bin.includes('\\')
  if (hasSep) {
    const abs = path.isAbsolute(bin) ? bin : path.resolve(cwd, bin)
    try {
      if (fs.statSync(abs).isFile()) return { ok: true, resolved: abs, reason: null }
    } catch {
      /* 落到下面的"找不到" */
    }
    return { ok: false, resolved: abs, reason: `找不到可执行文件：${abs}` }
  }
  const dirs = String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
  const exts =
    process.platform === 'win32'
      ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : ['']
  for (const d of dirs) {
    for (const ext of exts) {
      const cand = path.join(d, bin + ext)
      try {
        if (fs.statSync(cand).isFile()) return { ok: true, resolved: cand, reason: null }
      } catch {
        /* 继续找 */
      }
    }
  }
  return {
    ok: false,
    resolved: null,
    reason: `PATH 里找不到命令：${bin}（当前 PATH=${env.PATH || '（空）'}）`,
  }
}

/**
 * 校验声明文件内容。
 *
 * 与 manifest 的校验风格一致：**未知字段报错而不是静默忽略**（静默忽略会让
 * "我明明配了时间"变成悬案），但未知的**槽位**当然允许（那正是声明的用途）。
 */
export function validateDeclaration(raw, { projectRoot, sourcePath } = {}) {
  const errors = []
  const warnings = []
  const slots = {}
  const allowed = ['version', 'slots']
  const allowedSlotKeys = ['name', 'time', 'command', 'cwd', 'env', 'logDir', 'description']

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['声明必须是 JSON 对象'], warnings, slots }
  }
  for (const k of Object.keys(raw))
    if (!allowed.includes(k)) errors.push(`未知字段: ${k}（允许 ${allowed.join(' / ')}）`)

  const v = raw.version
  if (!Number.isInteger(v) || v < 1) errors.push('version 必须是正整数')
  else if (v > DECLARATION_VERSION)
    errors.push(`version=${v} 高于引擎支持的 ${DECLARATION_VERSION}（请升级引擎）`)

  if (raw.slots === undefined) errors.push('缺少 slots（对象：槽位 id → 定义）')
  else if (!raw.slots || typeof raw.slots !== 'object' || Array.isArray(raw.slots))
    errors.push('slots 必须是对象（槽位 id → 定义）')
  else {
    for (const [rawId, def] of Object.entries(raw.slots)) {
      const id = normalizeSlotId(rawId)
      if (!id) {
        errors.push(`非法槽位 id: ${rawId}（小写字母开头，允许字母/数字/横线，≤32 字符）`)
        continue
      }
      if (!def || typeof def !== 'object' || Array.isArray(def)) {
        errors.push(`槽位 ${id}: 定义必须是对象`)
        continue
      }
      const entry = { id }
      for (const k of Object.keys(def))
        if (!allowedSlotKeys.includes(k)) errors.push(`槽位 ${id}: 未知字段 ${k}`)

      if (def.name !== undefined) {
        if (typeof def.name !== 'string' || !def.name.trim())
          errors.push(`槽位 ${id}: name 必须是非空字符串`)
        else entry.name = def.name.trim()
      }
      if (def.time !== undefined) {
        const t = normalizeSlotTime(def.time)
        if (!t) errors.push(`槽位 ${id}: time 必须是 HH:MM（当前 ${JSON.stringify(def.time)}）`)
        else entry.time = t
      }
      if (def.description !== undefined) {
        if (typeof def.description !== 'string') errors.push(`槽位 ${id}: description 必须是字符串`)
        else entry.description = def.description
      }

      // `command` 可选（2026-09-25）：项目声明了 **http 执行器**时，脚本在项目那边跑，
      // 基座不需要本地命令。两种情况都在规格层说清楚：
      //   · 有 command   → 本地执行器（缺省路径）
      //   · 无 command   → 只有在项目声明了 http 执行器时才不报警（见 mergeSlotSpecs）
      if (def.command === undefined) {
        // 什么都不加：规格层会按"有没有执行器"决定要不要提醒
      } else {
        const resolved = resolveCommand(def.command, projectRoot)
        if (resolved.errors && resolved.errors.length) {
          for (const e of resolved.errors) errors.push(`槽位 ${id}: ${e}`)
        } else {
          entry.command = def.command
          entry.argv = resolved.argv
        }
      }

      if (def.cwd !== undefined) {
        const r = resolveInsideProject(projectRoot, def.cwd)
        if (r.error) errors.push(`槽位 ${id}: cwd ${r.error}`)
        else entry.cwd = r.abs
      }
      if (def.logDir !== undefined) {
        const r = resolveInsideProject(projectRoot, def.logDir)
        if (r.error) errors.push(`槽位 ${id}: logDir ${r.error}`)
        else entry.logDir = r.abs
      }
      if (def.env !== undefined) {
        if (!def.env || typeof def.env !== 'object' || Array.isArray(def.env))
          errors.push(`槽位 ${id}: env 必须是对象（字符串 → 字符串）`)
        else {
          const env = {}
          for (const [k, val] of Object.entries(def.env)) {
            if (typeof val !== 'string') errors.push(`槽位 ${id}: env.${k} 必须是字符串`)
            else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
              errors.push(`槽位 ${id}: env 变量名非法: ${k}`)
            else env[k] = val
          }
          entry.env = env
        }
      }
      if (!errors.some((e) => e.startsWith(`槽位 ${id}:`))) slots[id] = entry
    }
  }

  if (errors.length === 0 && Object.keys(slots).length === 0) warnings.push('声明里没有任何槽位')

  return { ok: errors.length === 0, errors, warnings, slots, sourcePath }
}

/** 读并校验项目声明（文件不存在 → `{ found: false }`） */
export function loadDeclaration(projectRoot) {
  const file = declarationPath(projectRoot)
  if (!file) return { found: false, projectRoot: projectRoot || null, file: null }
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { found: false, projectRoot, file }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return {
      found: true,
      projectRoot,
      file,
      ok: false,
      errors: [`JSON 解析失败: ${String((e && e.message) || e)}`],
      warnings: [],
      slots: {},
    }
  }
  const v = validateDeclaration(raw, { projectRoot, sourcePath: file })
  return { found: true, projectRoot, file, ...v }
}

/**
 * 把"配置里的槽位定义"（`config.slots`）+ 声明 + 模板合并成槽位规格列表。
 *
 * 优先级（与既有语义一致，只是命令来源换了）：
 *   名称/时间：`config.slots[]`（Console 编辑的 UI 权威）> 声明 > 模板
 *   开关：`config.schedule[id]`（缺省 → fail-open 跑）
 *   命令：只来自声明（没有声明就没有命令，也就跑不了——这是 v2.3 的取舍）
 */
export function mergeSlotSpecs({
  projectId,
  projectRoot,
  declaration,
  configSlots,
  scheduleMap,
  tz,
  dataDir,
  logsDir,
  executor = null,
  now = Date.now(),
} = {}) {
  const warnings = []
  const declared = (declaration && declaration.slots) || {}
  const configured = Array.isArray(configSlots) ? configSlots : []
  const slotsWritten = Array.isArray(configSlots)

  const byId = new Map()
  const ensure = (id) => {
    const sid = normalizeSlotId(id)
    if (!sid) return null
    let e = byId.get(sid)
    if (!e) {
      e = { id: sid }
      byId.set(sid, e)
    }
    return e
  }

  // ① 模板铺底（仅在配置与声明都没有任何槽位时；否则模板会污染"我删掉的槽位又回来了"）
  if (!slotsWritten && Object.keys(declared).length === 0)
    for (const d of DEFAULT_SLOT_TEMPLATES) {
      const e = ensure(d.slot)
      if (!e) continue
      e.name = d.label
      e.time = d.time
      e.source = 'template'
    }

  // ② 声明（**命令的唯一来源**；名称/时间只是缺省值，配置可以覆盖）
  for (const [id, def] of Object.entries(declared)) {
    const e = ensure(id)
    if (!e) continue
    e.declared = def
    e.source = 'declaration'
    if (!e.name && def.name) e.name = def.name
    if (!e.time && def.time) e.time = def.time
  }

  // ③ 配置（名称/时间/启用的 UI 权威：**覆盖**声明里的缺省）
  for (const s of configured) {
    const e = ensure(s && (s.id || s.slot))
    if (!e) continue
    const t = normalizeSlotTime(s && s.time)
    if (t) e.time = t
    if (s && s.name) e.name = String(s.name)
    if (!e.source) e.source = 'config'
    if (typeof (s && s.enabled) === 'boolean') e.enabledFromConfig = s.enabled
  }

  const specs = []
  // 项目级执行器（2026-09-25）：`{kind:'http',url,…}` = 基座不跑项目脚本，只发 HTTP 给项目自己的执行器；
  // `{kind:'http',unavailable:true,reason}` = 项目声明了但不可用 → **不回落到本地 spawn**，照实报不可用；
  // `null` = 旧的本地命令执行器（向后兼容）。
  const exec = executor && executor.kind === 'http' ? executor : null
  const execUnavailable = !!(exec && exec.unavailable)
  for (const s of byId.values()) {
    const def = s.declared || null
    const source = def ? 'declaration' : s.source === 'template' ? 'template' : 'config'
    const argv = def ? def.argv : null
    const cwd = (def && def.cwd) || projectRoot || null
    const avail = argv
      ? commandAvailable(argv, { cwd: cwd || process.cwd(), env: process.env })
      : null
    if (execUnavailable) warnings.push(`槽位 ${s.id}: 执行器不可用：${exec.reason}`)
    else if (!argv && !exec)
      warnings.push(`槽位 ${s.id} 没有命令声明：在项目根放 ${DECLARATION_DIR}/${DECLARATION_FILE}`)
    else if (!exec && avail && !avail.ok) warnings.push(`槽位 ${s.id}: ${avail.reason}`)
    const enabled = Object.prototype.hasOwnProperty.call(scheduleMap || {}, s.id)
      ? !!scheduleMap[s.id]
      : typeof s.enabledFromConfig === 'boolean'
        ? s.enabledFromConfig
        : true
    specs.push({
      key: `${projectId || ''}|${s.id}`,
      projectId: projectId || '',
      projectRoot: projectRoot || null,
      id: s.id,
      name: s.name,
      description: def && def.description,
      time: normalizeSlotTime(s.time) || '09:00',
      configTime: normalizeSlotTime(s.time) || undefined,
      tz,
      enabled,
      executor: exec,
      command: argv || null,
      declaredCommand: def ? def.command : null,
      cwd,
      env: (def && def.env) || {},
      logDir: (def && def.logDir) || logsDir || null,
      source,
      removable: source === 'config',
      editable: !!def,
      commandAvailable: exec ? !execUnavailable : !!avail && avail.ok,
      commandReason: exec
        ? execUnavailable
          ? `执行器不可用：${exec.reason}`
          : null
        : avail
          ? avail.reason
          : `未声明命令（缺 ${DECLARATION_DIR}/${DECLARATION_FILE}）`,
      commandResolved: exec ? exec.url : avail ? avail.resolved : null,
      dataDir: dataDir || null,
      now,
    })
  }

  // 排序：按时间，其次按 id（"时刻表"的自然顺序，与 v2.95 一致）
  specs.sort((a, b) =>
    a.time === b.time ? a.id.localeCompare(b.id) : a.time.localeCompare(b.time),
  )
  return { specs, warnings }
}
