/**
 * `scheduler migrate`：把旧的操作系统调度任务迁进引擎（v2.3，一次性、幂等）
 *
 * ## 为什么必须跑
 *
 * v2.3 退役了 launchd/systemd 槽位后端，但**旧任务不会自己消失**：本机实测还有
 * 6 个（5 个写作槽位 + 日历提醒）。不迁移就是每天被两套东西各触发一次——重复生成、
 * 重复推送（恒草稿虽兜住"误发"，但白烧时间与 token，且日志会互相污染）。
 * （2026-09-25：日历提醒本身已随日历模块退役，但那条旧 plist 仍可能留在别的机器上，
 *   所以这条卸载路径必须继续认得它 —— 见 `scheduler/legacy.mjs` 的 `ENGINE_LEGACY_SLOTS`。）
 *
 * ## 它做什么
 *
 *   ① 学：读旧槽位 plist 的 `ProgramArguments` / `StartCalendarInterval` /
 *      `EnvironmentVariables` / `StandardOutPath`，生成项目侧声明
 *      `.crosspost/schedule.json`（**命令的唯一来源**，v2.3 起不再从系统里学）
 *   ② 记：把旧 plist **移动**到 `<localRoot>/scheduler/legacy-backup/<时间戳>/`
 *      （移动而不是复制删除：一步到位、可回滚、不会出现"备份失败但原件已删"）
 *   ③ 卸：`launchctl bootout`（注销）+ 文件已被移走；systemd 侧 `disable --now` + 移文件
 *   ④ 报：dry-run 把将学的槽位、将写的声明、将卸的任务、**cwd 的变化**全部打出来
 *
 * ## 一处必须让人看见的行为变化
 *
 * launchd 的 `ProgramArguments` 任务**没有 `WorkingDirectory`**，所以旧行为是
 * `cwd=/`（launchd 的缺省工作目录）。声明里我们写成项目根——这是刻意的修正
 * （项目脚本的相对路径本来就该相对项目根），但它**确实变了**，因此 dry-run 必须
 * 把这条差异单独列出来让人确认，而不是埋在 JSON 里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { listProjects, projectRootOf } from '../projects.mjs'
import { readEffectiveConfig } from '../config-layers.mjs'
import { soleProjectId } from '../resources.mjs'
import {
  DECLARATION_DIR,
  DECLARATION_FILE,
  declarationPath,
  loadDeclaration,
} from '../scheduler/spec.mjs'
import {
  ENGINE_LEGACY_SLOTS,
  legacyTasks,
  looksLikePathArg,
  parsePlist,
  relativeIfInside,
} from '../scheduler/legacy.mjs'
import { schedulerDir } from '../scheduler/store.mjs'

const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19)

function runCmd(bin, args, { execFileImpl = execFile, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFileImpl(bin, args, { timeout }, (err, stdout, stderr) =>
      resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? String(err.message || err) : null,
      }),
    )
  })
}

/**
 * 只算不写：迁移计划（dry-run 与真正执行走同一条计划，避免两条实现漂移）。
 */
export function planMigration({ project, tasks = legacyTasks() } = {}) {
  const warnings = []
  const blocked = []
  const projects = listProjects().filter((p) => p.valid && p.id)
  const projectId = project || soleProjectId() || ''
  if (!projectId) {
    return {
      ok: false,
      error: projects.length
        ? `本机有 ${projects.length} 个合法项目（${projects.map((p) => p.id).join('、')}）：请显式指定 --project=<id>`
        : '本机没有已注册的写作项目：先在 config.json 的 projectsDirs 指向的目录里放 .crosspost/project.json',
      warnings,
      blocked,
    }
  }
  const proj = projects.find((p) => p.id === projectId)
  if (!proj) {
    return { ok: false, error: `未注册（或无效）的项目：${projectId}`, warnings, blocked }
  }
  const projectRoot = projectRootOf(proj.sourcePath)
  const cfg = readEffectiveConfig(projectId)
  const configSlots = Array.isArray(cfg.slots) ? cfg.slots : []
  const nameOf = (id) => {
    const hit = configSlots.find((s) => String((s && (s.id || s.slot)) || '') === id)
    return (hit && hit.name) || null
  }

  const mine = tasks.filter((t) => t.kind === 'launchd' && t.project === projectId)
  const engine = tasks.filter(
    (t) => ENGINE_LEGACY_SLOTS.has(t.slot) || ENGINE_LEGACY_SLOTS.has(t.unit),
  )
  const others = tasks.filter(
    (t) => !mine.includes(t) && !engine.includes(t) && (t.project === projectId || !t.project),
  )

  const slots = []
  const plannedTasks = []
  for (const t of mine) {
    let parsed
    try {
      parsed = parsePlist(fs.readFileSync(t.file, 'utf8'))
    } catch (e) {
      blocked.push({ label: t.label, reason: `读不到 plist：${String((e && e.message) || e)}` })
      continue
    }
    if (!parsed.argv.length) {
      blocked.push({ label: t.label, reason: 'ProgramArguments 为空（不认识的任务形态）' })
      continue
    }
    if (parsed.times.length !== 1) {
      // 一个槽位声明只能有一个时间：多个时间点的项目槽位需要人工拆分，
      // 我们不猜（猜错就是"迁移后少跑一次"或者"多跑一次"）。
      blocked.push({
        label: t.label,
        reason: `plist 里有 ${parsed.times.length} 个时间点（${parsed.times.join('、')}）：请在 ${DECLARATION_DIR}/${DECLARATION_FILE} 里手工拆成多个槽位`,
      })
      continue
    }
    const argv = parsed.argv.map((a) =>
      looksLikePathArg(a) && path.isAbsolute(a) ? relativeIfInside(projectRoot, a) : a,
    )
    slots.push({
      slot: t.slot,
      label: t.label,
      time: parsed.times[0],
      name: nameOf(t.slot) || t.slot,
      command: argv,
      cwd: '.',
      env: parsed.env,
      logDir: parsed.logDir ? relativeIfInside(projectRoot, parsed.logDir) : null,
      oldCwd: null,
      cwdChanged: true,
      oldEnv: parsed.env,
      oldLogDir: parsed.logDir,
      source: 'launchd',
    })
    plannedTasks.push(t)
  }

  return {
    ok: true,
    project: projectId,
    projectRoot,
    declarationFile: declarationPath(projectRoot),
    slots,
    engineTasks: engine.map((t) => ({ label: t.label || t.unit, file: t.file, ...safeParse(t) })),
    // 只卸载"真的学出来"的任务：被 blocked 的必须留在原地——卸载了就等于
    // "少跑一次"且没人知道（迁移报告里会写出原因）。
    uninstall: [...plannedTasks, ...engine],
    others: others.map((t) => ({
      label: t.label || t.unit,
      file: t.file,
      project: t.project,
      slot: t.slot,
    })),
    warnings,
    blocked,
  }
}

function safeParse(t) {
  try {
    const p = parsePlist(fs.readFileSync(t.file, 'utf8'))
    return { argv: p.argv, times: p.times }
  } catch {
    return { argv: [], times: [] }
  }
}

/** 生成声明文件内容（与既有条目合并：已存在的槽位**保持原样**，只补缺失） */
export function mergeDeclaration(existing, slots, { projectRoot } = {}) {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...existing }
      : { version: 1 }
  if (!Number.isInteger(base.version)) base.version = 1
  base.slots = base.slots && typeof base.slots === 'object' ? { ...base.slots } : {}
  const added = []
  const kept = []
  for (const s of slots) {
    if (base.slots[s.slot]) {
      kept.push(s.slot)
      continue
    }
    const entry = { name: s.name, time: s.time, command: s.command, cwd: s.cwd }
    if (s.env && Object.keys(s.env).length) entry.env = s.env
    if (s.logDir) entry.logDir = s.logDir
    base.slots[s.slot] = entry
    added.push(s.slot)
  }
  void projectRoot
  return { declaration: base, added, kept }
}

/**
 * 执行迁移。
 *
 * @param {object} o
 * @param {string} [o.project] 项目 id（缺省：本机唯一合法项目）
 * @param {boolean} [o.dryRun] 只打印计划，不写盘、不注销
 * @param {boolean} [o.keepTasks] 生成声明但**不卸载**旧任务（默认卸载）
 * @param {Function} [o.execFileImpl] 测试注入（假 launchctl/systemctl）
 */
export async function runSchedulerMigrate({
  project,
  dryRun = false,
  keepTasks = false,
  now = Date.now(),
  execFileImpl = execFile,
  tasks,
} = {}) {
  const plan = planMigration({ project, tasks: tasks || legacyTasks() })
  if (!plan.ok) return plan

  const backupDir = path.join(schedulerDir(), 'legacy-backup', stamp(now))
  const existing = loadDeclaration(plan.projectRoot)
  const existingRaw = existing.found ? safeReadJson(plan.declarationFile) : null
  const merged = mergeDeclaration(existingRaw, plan.slots, { projectRoot: plan.projectRoot })

  const result = {
    ok: true,
    dryRun: !!dryRun,
    project: plan.project,
    projectRoot: plan.projectRoot,
    declarationFile: plan.declarationFile,
    backupDir,
    willAdd: merged.added,
    kept: merged.kept,
    slots: plan.slots,
    engineTasks: plan.engineTasks,
    uninstall: plan.uninstall.map((t) => t.label || t.unit),
    blocked: plan.blocked,
    warnings: plan.warnings,
    removed: [],
    errors: [],
    cwdChanged: plan.slots
      .filter((s) => s.cwdChanged)
      .map((s) => `${s.slot}: /（launchd 缺省）→ ${s.cwd}`),
  }
  if (dryRun) return result

  // ① 声明文件（先备份既有内容；写盘用 tmp+rename）
  try {
    fs.mkdirSync(path.join(plan.projectRoot, DECLARATION_DIR), { recursive: true })
    if (existing.found) {
      fs.mkdirSync(backupDir, { recursive: true })
      fs.copyFileSync(plan.declarationFile, path.join(backupDir, 'schedule.json.bak'))
    }
    const tmp = plan.declarationFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(merged.declaration, null, 2) + '\n')
    fs.renameSync(tmp, plan.declarationFile)
  } catch (e) {
    result.ok = false
    result.errors.push(`写声明文件失败：${String((e && e.message) || e)}`)
    return result
  }

  // ② 卸载旧任务（移动 plist 到备份目录；systemd 先 disable 再移文件）
  if (!keepTasks) {
    fs.mkdirSync(backupDir, { recursive: true })
    for (const t of plan.uninstall) {
      try {
        if (t.kind === 'launchd') {
          if (process.platform === 'darwin' && fs.existsSync('/bin/launchctl')) {
            const uid = process.getuid ? process.getuid() : 501
            await runCmd('/bin/launchctl', ['bootout', `gui/${uid}/${t.label}`], { execFileImpl })
          }
          const dest = path.join(backupDir, path.basename(t.file))
          fs.renameSync(t.file, dest)
          result.removed.push({ label: t.label, file: t.file, backup: dest })
        } else {
          const unit = t.unit
          if (fs.existsSync('/usr/bin/systemctl') || fs.existsSync('/bin/systemctl')) {
            await runCmd('systemctl', ['--user', 'disable', '--now', unit], { execFileImpl })
          }
          for (const ext of ['service', 'timer']) {
            const f = path.join(path.dirname(t.file), `${unit}.${ext}`)
            if (!fs.existsSync(f)) continue
            const dest = path.join(backupDir, path.basename(f))
            fs.renameSync(f, dest)
            result.removed.push({ label: `${unit}.${ext}`, file: f, backup: dest })
          }
        }
      } catch (e) {
        result.errors.push(`卸载 ${t.label || t.unit} 失败：${String((e && e.message) || e)}`)
      }
    }
  }
  return result
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 人类可读的迁移报告（CLI 直接打印） */
export function formatMigrationReport(r) {
  if (!r.ok) return `迁移未执行：${r.error}`
  const lines = []
  lines.push('')
  lines.push(`CrossPost 调度迁移${r.dryRun ? '（dry-run，未改动任何文件）' : ''}`)
  lines.push('─'.repeat(64))
  lines.push(`项目       ${r.project}（${r.projectRoot}）`)
  lines.push(`声明文件   ${r.declarationFile}`)
  if (r.willAdd.length) lines.push(`将写入槽位 ${r.willAdd.join('、')}`)
  if (r.kept.length) lines.push(`已存在保留 ${r.kept.join('、')}（声明里已有，不覆盖）`)
  for (const s of r.slots) {
    lines.push(
      `  · ${s.slot}  ${s.time}  ${s.command.join(' ')}` +
        `${s.env && Object.keys(s.env).length ? `  env=${Object.keys(s.env).join(',')}` : ''}`,
    )
  }
  if (r.cwdChanged.length) {
    lines.push('工作目录变化（必须确认）：')
    for (const c of r.cwdChanged) lines.push(`  ! ${c}`)
  }
  if (r.engineTasks.length)
    lines.push(
      `引擎任务   ${r.engineTasks.map((t) => t.label).join('、')}（引擎侧已不再自带任务，直接卸载旧任务；不要把它学成槽位）`,
    )
  lines.push(`${r.dryRun ? '将卸载' : '已卸载'}  ${r.uninstall.join('、') || '（无）'}`)
  if (!r.dryRun) lines.push(`备份       ${r.backupDir}`)
  for (const b of r.blocked) lines.push(`✖ 跳过 ${b.label}：${b.reason}`)
  for (const e of r.errors) lines.push(`✖ ${e}`)
  lines.push('─'.repeat(64))
  if (r.dryRun) lines.push('确认无误后去掉 --dry-run 重跑即可（幂等）。')
  return lines.join('\n')
}

/* ── CLI ─────────────────────────────────────────────────────── */

if (process.argv[1] && process.argv[1].endsWith('scheduler-migrate.mjs')) {
  const argv = process.argv.slice(2)
  const projectArg = argv.find((a) => a.startsWith('--project='))
  const r = await runSchedulerMigrate({
    project: projectArg ? projectArg.slice('--project='.length) : undefined,
    dryRun: argv.includes('--dry-run'),
    keepTasks: argv.includes('--keep-tasks'),
  })
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else process.stdout.write(formatMigrationReport(r) + '\n')
  process.exit(r.ok ? 0 : 1)
}
