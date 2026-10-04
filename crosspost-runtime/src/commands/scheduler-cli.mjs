#!/usr/bin/env node
/**
 * `scheduler`：引擎自带定时器的**独立宿主**（v2.3）
 *
 * ## 为什么需要它
 *
 * 定时器缺省住在桥进程里（Console/HTTP 都在，最常用）。但桥不是所有部署都会常开：
 * 只用 CLI / MCP 的部署、容器里只跑一个进程的部署、Windows 上挂成服务的部署——
 * 它们需要"只跑调度"的最小入口，而不必为了定时去开一整个桥。
 *
 * ## 与桥的关系：**互斥**
 *
 * 两个宿主共用 `<localRoot>/scheduler/lock`：先启动的持有，后者明确拒绝 arm 并说明
 * 持有者是谁（而不是两个定时器把每天的计划各跑一遍）。
 *
 * ## 用法
 *
 *   node crosspost-runtime/src/commands/scheduler-cli.mjs run        # 前台常驻（Ctrl-C 退出）
 *   node crosspost-runtime/src/commands/scheduler-cli.mjs status     # 当前状态（--json 机器可读）
 *   node crosspost-runtime/src/commands/scheduler-cli.mjs trigger <槽位> [--project=<id>]
 *   node crosspost-runtime/src/commands/scheduler-cli.mjs tasks      # 列出还留着的旧系统任务
 *   node crosspost-runtime/src/commands/scheduler-cli.mjs migrate [--dry-run] [--project=<id>]
 */
import { createScheduler } from '../scheduler/index.mjs'
import { legacyDaemons, legacyTasks } from '../scheduler/legacy.mjs'
import { schedulerDir } from '../scheduler/store.mjs'
import { formatMigrationReport, runSchedulerMigrate } from './scheduler-migrate.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'status'
const flag = (name) => argv.includes(`--${name}`)
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
const json = flag('json')

function printStatus(st) {
  if (json) {
    process.stdout.write(JSON.stringify(st, null, 2) + '\n')
    return
  }
  const lines = []
  lines.push(`CrossPost 调度器（backend=${st.backend} tz=${st.tz} 宿主=${st.host}）`)
  lines.push(
    `锁：${st.lockHeldByUs ? '本进程持有' : st.lock ? `pid=${st.lock.pid}（${st.lock.host || '?'}${st.lock.hostname ? ` @ ${st.lock.hostname}` : ''}）持有` : '空闲'}` +
      (st.lockHeldByUs && st.lock && st.lock.heartbeatAt
        ? ` · 心跳 ${Math.max(0, Math.round((Date.now() - st.lock.heartbeatAt) / 1000))}s 前`
        : '') +
      ` · 运行中 ${st.runningCount} · 已触发 ${st.firesTotal} 次 · 补跑窗口 ${st.catchUpMaxMinutes} 分钟`,
  )
  if (st.lockReason) lines.push(`      ↳ ${st.lockReason}`)
  lines.push(`数据目录：${st.schedulerDir}`)
  for (const s of st.slots) {
    const state = s.commandMissing
      ? '✖ 命令不可用'
      : !s.enabled
        ? '－ 已关闭'
        : s.running
          ? '▶ 运行中'
          : s.completedToday
            ? '✔ 今日已跑'
            : s.unfinished
              ? '! 今日未收尾'
              : s.armed
                ? '· 已启用'
                : st.armedByOther
                  ? '· 已启用（由另一个实例持有定时器）'
                  : `· 未生效(${s.armedReason || '?'})`
    lines.push(`  [项目] ${s.slot.padEnd(18)} ${s.time}  ${state}  下次 ${s.next}`)
    if (s.commandMissing && s.commandReason) lines.push(`        ↳ ${s.commandReason}`)
  }
  for (const n of st.notes || []) lines.push(`! ${n}`)
  for (const w of (st.warnings || []).slice(0, 10)) lines.push(`! ${w}`)
  process.stdout.write(lines.join('\n') + '\n')
}

if (cmd === 'run') {
  const sched = createScheduler({ host: 'standalone' })
  const started = sched.start()
  if (!started.ok) {
    process.stderr.write(
      `未取得调度锁：${(started.lock && started.lock.reason) || '未知原因'}\n` +
        `（另一个进程在跑定时器：桥在运行，或已有 scheduler run。两者只需一个。）\n`,
    )
    process.exit(1)
  }
  process.stderr.write(
    `调度器已启动（${started.specs} 个槽位，tz=${sched.settings.tz}，数据目录 ${schedulerDir()}）\n` +
      `Ctrl-C 退出；状态：node crosspost-runtime/src/commands/scheduler-cli.mjs status\n`,
  )
  for (const w of started.warnings || []) process.stderr.write(`! ${w}\n`)
  const bye = () => {
    sched.stop()
    process.exit(0)
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
  setInterval(() => {}, 1 << 30)
} else if (cmd === 'status') {
  const st = createScheduler({ host: 'cli' }).status({ projectId: opt('project') || '' })
  printStatus(st)
} else if (cmd === 'trigger') {
  const slot = argv[1]
  if (!slot) {
    process.stderr.write('用法：scheduler trigger <槽位> [--project=<id>] [--json]\n')
    process.exit(1)
  }
  const st = createScheduler({ host: 'cli' }).trigger({
    slotId: slot,
    projectId: opt('project') || '',
  })
  if (json) process.stdout.write(JSON.stringify(st, null, 2) + '\n')
  else if (st.ok) process.stdout.write(`已触发 ${st.slot}（pid=${st.pid}）\n`)
  else process.stderr.write(`未触发：${st.error}\n`)
  process.exit(st.ok ? 0 : 1)
} else if (cmd === 'tasks') {
  const list = legacyTasks()
  const services = legacyDaemons()
  if (json) process.stdout.write(JSON.stringify({ legacyTasks: list, services }, null, 2) + '\n')
  else if (!list.length && !services.length)
    process.stdout.write('没有检测到旧的操作系统调度任务。\n')
  else {
    if (list.length) {
      process.stdout.write(
        `检测到 ${list.length} 个旧任务（迁移：scheduler migrate --dry-run）：\n`,
      )
      for (const t of list)
        process.stdout.write(
          `  [${t.kind}] ${t.label || t.unit}  项目=${t.project || '(默认域)'} 槽位=${t.slot}\n`,
        )
    } else {
      process.stdout.write('没有检测到旧的操作系统调度任务。\n')
    }
    // 无到点触发的常驻服务（槽位执行器/生成提供者）：**不是**旧任务，不用迁移。
    // 列出来是为了回答"我在 LaunchAgents 里看到的那个 plist 算什么"。
    // 措辞只讲可验证的事实（无到点触发）：推不出身份，就不替它下身份断言。
    if (services.length) {
      process.stdout.write(
        `另有 ${services.length} 个常驻服务（无到点触发，不是旧任务、不用迁移）：\n`,
      )
      for (const s of services) process.stdout.write(`  [${s.kind}] ${s.label || s.unit}\n`)
    }
  }
} else if (cmd === 'migrate') {
  const r = await runSchedulerMigrate({
    project: opt('project'),
    dryRun: flag('dry-run'),
    keepTasks: flag('keep-tasks'),
  })
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  else process.stdout.write(formatMigrationReport(r) + '\n')
  process.exit(r.ok ? 0 : 1)
} else {
  process.stderr.write(
    '用法：scheduler {run | status | trigger <槽位> | tasks | migrate}\n' +
      '  run      前台常驻定时器（与桥互斥，见 <localRoot>/scheduler/lock）\n' +
      '  status   当前槽位与下一次触发（--json）\n' +
      '  trigger  手动触发一次（不受"每天最多一次"限制）\n' +
      '  tasks    列出还留着的旧 launchd/systemd 调度任务\n' +
      '  migrate  把旧任务迁成项目声明并卸载（--dry-run）\n',
  )
  process.exit(1)
}
