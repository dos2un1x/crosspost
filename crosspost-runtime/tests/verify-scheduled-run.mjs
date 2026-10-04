#!/usr/bin/env node
/**
 * 定时链路运行验证（v2.16）
 *
 * 用途：确认当日定时槽位**真的跑了**，以及**跑在新代码上**。
 *
 * 为什么需要：`test:smoke:production` 只能证明"代码路径完好"，不能证明
 * "今天真的执行了"——而后者是我无法替你验证的（验证它就要触发生成，那会写 drafts/）。
 * 本脚本只读日志与运行态，把这件事变成一条命令。
 *
 * 判定依据（全部只读）：
 *   ① 今日各槽位的 run-<slot>-<date>.log 是否存在
 *   ② 日志尾部是否有 [END] 收尾行（无 [END] 通常是中途失败或被截断）
 *   ③ 日志中的「发布=」「分发=」摘要行（该链路自报的发布结果）
 *   ④ 日志中出现过的样式与评分（确认走的是正常流程而非早退）
 *
 * 用法：
 *   node crosspost-runtime/tests/verify-scheduled-run.mjs            # 今天
 *   node crosspost-runtime/tests/verify-scheduled-run.mjs 2026-09-18  # 指定日期
 *
 * 退出码：0 = 所有**应跑**槽位都有收尾记录；1 = 有槽位缺失或无 [END]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractProjectFlag } from '../src/project-context.mjs'
import { getLogsDir, soleProjectId } from '../src/resources.mjs'
import { listProjects } from '../src/projects.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')

// 日志目录：优先测试覆盖，其次**项目级解析**（v2.76），最后才是引擎默认域。
//
// 历史：曾经写死某个写作项目的 logs 目录（绝对路径）—— P0 明确要求引擎侧
// 不得假定某个具体写作项目的磁盘位置（v2.56 修）。v2.76 起日志**跟着项目走**
// （`<内容工作区>/logs`），所以这里也要按项目解析：
//   ① `--project=<id>`（多项目机器必须显式给）
//   ② 本机唯一合法项目（单项目部署的便利默认，`soleProjectId()`）
//   ③ 默认域：env `CROSSPOST_SMOKE_LOGS`/`CROSSPOST_LOGS_DIR` > `paths.json` > 内置
const { project: PROJECT_FLAG, args: REST_ARGS } = extractProjectFlag(process.argv.slice(2))
const PROJECT = PROJECT_FLAG || soleProjectId()
const LOGS_DIR = process.env.CROSSPOST_SMOKE_LOGS || getLogsDir(PROJECT || undefined)

const SLOTS = ['morning', 'hotspot', 'noon', 'hotspot2', 'tips', 'evening']

/** 各槽位的计划执行时间（与 SLOT_DEFS 一致），用于判断"是否已经到点" */
const SLOT_TIME = {
  morning: '08:10',
  hotspot: '08:30',
  noon: '12:30',
  hotspot2: '13:10',
  tips: '18:10',
  evening: '20:30',
}

/**
 * 读取引擎 config 的 schedule 原始配置（仅用于展示）。
 */
function readSchedule() {
  try {
    const cfgPath =
      process.env.CROSSPOST_CONFIG || path.join(REPO, 'crosspost-runtime', 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    return cfg.schedule || {}
  } catch {
    return {}
  }
}

const SCHEDULE = readSchedule()

/**
 * 各槽位的**实际启用状态**——从引擎取，不在这里重新解释配置。
 *
 * 为什么必须问引擎：引擎的规则是
 *     `scheduleCfg[slot] !== undefined ? !!scheduleCfg[slot] : launchctl 实际状态`
 * 即 **config 未提及该槽位时，以 launchd 是否已加载为准**（也就是"启用"）。
 * 本机 config.schedule 只有 {tips:false, morning:false, evening:false}，
 * hotspot/noon/hotspot2 三个键根本不存在——但它们实际是**启用**的。
 *
 * 初版在这里自己解释配置，把"未提及"当成"未启用"，
 * 于是把真实在跑的 3 个槽位报成"未启用"，同时又把 3 个确实关闭的槽位
 * 报成"✖ 已到点但没有日志"，两头都错。测试替引擎做判断，就会和引擎不一致。
 *
 * 2026-09-20（v2.81）：槽位开关是**项目级**设置（v2.77 起），而 `getScheduleStatus()`
 * 在**没有项目上下文**时读的是引擎 config 那一份 —— 于是这里会报"未启用"，
 * 而真正的门禁（`run_once.sh`，现已改问 `cli.mjs slotEnabled`）按项目解析后照跑：
 * 本项因此**看不见**"Console 看着开、到点却被 SKIP"这类事故。现在把整个校验放进
 * 项目上下文里（与门禁同源），报告口径才等于"到点会不会真跑"。
 */
let ENABLED = null
async function loadEnabled() {
  if (ENABLED) return ENABLED
  try {
    const [mod, ctx] = await Promise.all([
      import(new URL('../../bridge/schedule.mjs', import.meta.url).href),
      import('../src/project-context.mjs'),
    ])
    // 在项目上下文里问（与门禁/Console 同源；PROJECT 见文件头解析规则）
    const st = await (PROJECT
      ? ctx.withProject(PROJECT, () => mod.getScheduleStatus())
      : mod.getScheduleStatus())
    ENABLED = new Map(
      st.slots.map((s) => [s.slot, { enabled: !!s.enabled, provider: st.provider }]),
    )
  } catch {
    // 取不到就退回"全部视为启用"——宁可不报未启用，也不要制造假告警
    ENABLED = new Map(SLOTS.map((s) => [s, { enabled: true, provider: 'unknown' }]))
  }
  return ENABLED
}

/** 该槽位是否被启用 */
function isEnabled(slot) {
  return ENABLED ? !!(ENABLED.get(slot) || {}).enabled : true
}

const date =
  REST_ARGS[0] ||
  (() => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  })()

const nowHHMM = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
})()

/** 该槽位"应当已经跑过"= 已启用 且 计划时间已过 */
function isDue(slot) {
  return isEnabled(slot) && nowHHMM >= SLOT_TIME[slot]
}

await loadEnabled()

const rows = []
for (const slot of SLOTS) {
  const file = path.join(LOGS_DIR, `run-${slot}-${date}.log`)
  const exists = fs.existsSync(file)
  let endLine = null
  let publish = null
  let distribute = null
  let style = null
  let score = null
  if (exists) {
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      /* 读失败按无内容处理 */
    }
    const ends = [...text.matchAll(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)\] \[END\]/g)]
    const starts = [...text.matchAll(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)\] \[START\]/g)]
    // 同一个槽位一天可能跑**多轮**（手动补跑 + 定时，或验证用的手工轮次），
    // 所以必须认「最后一轮」：
    //   · 收尾 = 最后一个 [END] 出现在最后一个 [START] **之后**
    //     —— 否则最新一轮中途挂了，仍会被早先那条 [END] 伪装成"正常收尾"；
    //   · 发布/分发/样式/质量分取**最后一次**出现
    //     —— 否则报表展示的是当天第一轮的数据，掩盖最新一轮的真实结果。
    // （v2.56：本机 2026-09-19 就是"手动验证轮 + 18:10 定时轮"同日两轮的真实场景。）
    const lastEnd = ends.length ? ends[ends.length - 1] : null
    const lastStart = starts.length ? starts[starts.length - 1] : null
    if (lastEnd && (!lastStart || lastEnd.index > lastStart.index)) endLine = lastEnd[1]
    const lastOf = (re) => {
      const m = [...text.matchAll(re)]
      return m.length ? m[m.length - 1][1] : null
    }
    publish = lastOf(/发布=([^\s]+)/g)
    distribute = lastOf(/分发=([^\s]+)/g)
    style = lastOf(/样式=(\S+)/g)
    score = lastOf(/质量分=(\d+)/g)
  }
  rows.push({ slot, file, exists, endLine, publish, distribute, style, score, due: isDue(slot) })
}

console.log(`\n定时链路运行验证 —— 日期 ${date}（当前 ${nowHHMM}）`)
console.log(`日志目录：${LOGS_DIR}${PROJECT ? `（项目 ${PROJECT}）` : '（默认域）'}`)
if (!PROJECT && !process.env.CROSSPOST_SMOKE_LOGS) {
  const n = (() => {
    try {
      return listProjects().filter((p) => p && p.valid && p.id).length
    } catch {
      return 0
    }
  })()
  if (n > 1)
    console.log(`⚠ 本机有 ${n} 个合法项目，未指定 --project=，只看默认域日志（多半是空的）`)
}
console.log('─'.repeat(78))
console.log('槽位      计划    日志   收尾([END])  发布         分发        样式')
console.log('─'.repeat(78))
for (const r of rows) {
  const disabled = !isEnabled(r.slot)
  const mark = disabled ? '—' : !r.due ? '·' : r.exists ? (r.endLine ? '✔' : '⚠') : '✖'
  const plans = SLOT_TIME[r.slot]
  const hasLog = r.exists ? '有' : disabled ? '未启用' : r.due ? '缺' : '—'
  const end = r.endLine ? r.endLine.slice(11) : r.exists && r.due ? '无' : '—'
  console.log(
    `${mark} ${r.slot.padEnd(9)} ${plans}  ${hasLog.padEnd(5)} ${String(end).padEnd(11)} ` +
      `${String(r.publish || '—').padEnd(12)} ${String(r.distribute || '—').padEnd(11)} ${r.style || '—'}`,
  )
}
console.log('─'.repeat(78))

const due = rows.filter((r) => r.due)
const missing = due.filter((r) => !r.exists)
const noEnd = due.filter((r) => r.exists && !r.endLine)
const ok = due.filter((r) => r.exists && r.endLine)

const disabledSlots = SLOTS.filter((s) => !isEnabled(s))
console.log(
  `  已启用且到点 ${due.length} 个：✔ 正常收尾 ${ok.length}，⚠ 有日志无收尾 ${noEnd.length}，✖ 无日志 ${missing.length}`,
)
if (disabledSlots.length) {
  console.log(`  未启用（引擎判定，不要求有日志）：${disabledSlots.join(', ')}`)
  if (ENABLED) {
    const prov = [...ENABLED.values()][0]?.provider
    console.log(`  （启用状态取自引擎 getScheduleStatus()，provider=${prov}）`)
  }
}
if (!due.length && !disabledSlots.length) {
  console.log('  今天还没有到任何槽位的执行时间。')
}
if (noEnd.length) {
  console.log('\n⚠ 有日志但无 [END] —— 通常意味着该轮中途失败或被截断：')
  for (const r of noEnd) console.log(`    ${r.slot}：${r.file}`)
  console.log('    查看尾部：tail -30 <上面的文件>')
}
if (missing.length) {
  console.log('\n✖ 已到点但没有日志：')
  for (const r of missing) {
    console.log(`    ${r.slot}（计划 ${SLOT_TIME[r.slot]}）`)
  }
  console.log('    排查顺序：')
  console.log('      1) launchctl list | grep wechatauto   # 槽位是否 loaded')
  console.log(
    '      2) 该槽位的 plist 是否存在：~/Library/LaunchAgents/com.wechatauto.<slot>.plist',
  )
  console.log('      3) crosspost-runtime/config.json 的 schedule.<slot> 是否为 true')
  console.log(`         （当前 config.schedule = ${JSON.stringify(SCHEDULE)}）`)
  console.log('      4) 桥是否在跑：curl -s http://127.0.0.1:9540/proxy/health')
}
if (ok.length) {
  console.log('\n各槽位自报结果：')
  for (const r of ok) {
    console.log(
      `    ${r.slot.padEnd(9)} 发布=${r.publish || '?'}  分发=${r.distribute || '?'}  样式=${r.style || '?'}  质量分=${r.score || '?'}`,
    )
  }
  console.log('\n  提示：`发布=成功` 只代表链路自报成功；草稿是否真的进了各平台后台，')
  console.log('        仍建议在 Console（http://127.0.0.1:9540/）或平台后台抽看一篇。')
}

console.log('')
process.exit(missing.length || noEnd.length ? 1 : 0)
