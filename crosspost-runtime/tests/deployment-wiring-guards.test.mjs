// 「谁负责刷新 / 谁负责判定」这类**接线**的静态护栏（v2.81）
//
// 为什么需要专门一个文件：这两个 bug 都不是算法错，而是**接线错**——
// 单测全绿、类型也对，只是调用点少了一次、或者读错了源：
//
//   ① Console 设置页的「封面 × 结束语模板」只在 `initStyleSection()` 里加载过**一次**，
//      而 `loadSettings()`（每次进设置页、每次切换项目都会跑）没有刷新它 →
//      切换项目后这一块永远是第一个项目的值。用户报的"封面×结束语模板没有区分项目"就是它。
//   ② 定时门禁（接入方的 `run_once.sh`）直接读**引擎** `config.json` 判定
//      `schedule[slot] === false`，而槽位开关从 v2.77 起是**项目级**设置 →
//      "Console 里看着是开的、到点却被 [SKIP]"（或反之）。门禁必须问引擎。
//
// 这两条都是"少了/读错了某个调用"，没有比读源码更直接的断言方式；
// 与其让它们在真机上以静默方式复现，不如在这里钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
const REPO = path.resolve(RUNTIME, '..')
const CONSOLE = path.join(REPO, 'bridge', 'console', 'modules')

/**
 * 接入方（写作项目）的定时门禁脚本 —— 它**必然在引擎仓库之外**（引擎不得代跑接入方脚本）。
 *
 * 位置从引擎自己的配置推：`config.json.projectsDirs` 的第一项是写作仓库根，
 * 脚本住在它的 `.claude/skills/<skill>/scripts/run_once.sh`。不在仓库里写死具体项目名 ——
 * 那样只有一台机器成立，也把私有目录名带进公开仓库。找不到就是"本机没有接入方脚本"。
 */
const RUN_ONCE = (() => {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(process.env.CROSSPOST_CONFIG || path.join(RUNTIME, 'config.json'), 'utf8'),
    )
    const hostRepo = (cfg.projectsDirs || [])[0]
    if (!hostRepo) return null
    for (const skill of fs.readdirSync(path.join(hostRepo, '.claude', 'skills'))) {
      const p = path.join(hostRepo, '.claude', 'skills', skill, 'scripts', 'run_once.sh')
      if (fs.existsSync(p)) return p
    }
  } catch {
    /* 无本机配置 / 无该目录 */
  }
  return null
})()

/** 取出某个函数的函数体（按大括号配对；够用于本文件的静态检查） */
function functionBody(src, signature) {
  const at = src.indexOf(signature)
  if (at < 0) return null
  const open = src.indexOf('{', at)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

test('Console：进设置页必须刷新「封面 × 结束语模板」（它是项目级设置）', () => {
  const settings = fs.readFileSync(path.join(CONSOLE, 'views-settings.mjs'), 'utf8')
  const body = functionBody(settings, 'export async function loadSettings(')
  assert.ok(body, '找不到 loadSettings 定义')
  assert.match(
    body,
    /loadCoverTplSettings\s*\(/,
    'loadSettings() 必须调用 loadCoverTplSettings()——否则切换项目后这一块不跟着变（v2.81 事故）',
  )
  assert.match(body, /loadStyleLib\s*\(/, '样式库同理（它是项目级设置）')

  const styles = fs.readFileSync(path.join(CONSOLE, 'views-settings-styles.mjs'), 'utf8')
  assert.match(styles, /export async function loadCoverTplSettings\(/, '该函数必须可被外部调用')
  const init = functionBody(styles, 'export function initStyleSection(') || ''
  assert.ok(
    !/\n\s*loadCoverTplSettings\(\)/.test(init),
    'initStyleSection() 不该再自己加载一次（它只在启动时跑一次，正是旧 bug 的来源）',
  )
})

test('定时门禁必须问引擎（槽位开关是项目级设置）', (t) => {
  if (!RUN_ONCE || !fs.existsSync(RUN_ONCE)) {
    // 接入方脚本不一定在本机（本项只对本机部署有意义）。
    // 必须 t.skip 而不是 return —— return 会让它在报告里显示"通过"（这类"静默跳过"
    // 正是本会话反复抓到的假绿；顺带说：第一版就是靠写错的路径名去猜位置，
    // 于是它一直在静默跳过，现在改成从引擎配置推 + 明确 skip）。
    t.skip(
      `本机没有接入方脚本（config.projectsDirs 下未找到 .claude/skills/*/scripts/run_once.sh）`,
    )
    return
  }
  const src = fs.readFileSync(RUN_ONCE, 'utf8')
  // 必须是**代码**里的调用，不能只是注释里提一句
  const callLines = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('#') && /\bslotEnabled\b/.test(l))
  assert.ok(
    callLines.length > 0,
    'run_once.sh 的门禁必须在代码里调用 `slotEnabled`——直接读引擎 config.json 会与项目级 schedule 脱节（v2.81 事故）',
  )
  assert.ok(
    callLines.some((l) => /NODE_BIN|CLI_JS/.test(l)),
    '调用必须走引擎 CLI（$NODE_BIN $CLI_JS … slotEnabled）',
  )
  // 兜底仍在（引擎不可用时退回直接读配置，fail-open），但不能作为**主**判据：
  // 主判据调用必须出现在兜底读取之前。
  const primary = src.search(/\bslotEnabled\b/)
  const fallback = src.indexOf('readFileSync(process.argv[1], "utf8")')
  if (fallback >= 0) assert.ok(primary < fallback, '引擎调用必须排在兜底读取之前')
})

/**
 * 2026-09-25：Console「工作流」页与其 `/proxy/workflow` 端点已删除，
 * 该页**唯一独有的信号**（槽位连续多天没有产出）迁进「设置 → 自动推送调度」。
 *
 * 为什么值得单独一条静态护栏：这条信号治的是"定时在跑、但一直没产出"——
 * 到点才发现的那类失败。它迁过来之后没有任何浏览器冒烟会覆盖它（造 stale 数据
 * 需要伪造项目调度日志），一旦被后人顺手删掉，界面就回到"看着一切正常"。
 * 这里钉三处：判据、行内徽标、顶部提示——缺一处用户就定位不到是哪一班。
 */
test('Console：工作流页迁出的「连续多天无产出」信号必须仍在设置页', () => {
  const settings = fs.readFileSync(path.join(CONSOLE, 'views-settings.mjs'), 'utf8')
  assert.match(settings, /const STALE_DAYS = 2/, 'stale 判据阈值（2 天）必须还在')

  const m = /function isStaleSlot\(s\) \{[\s\S]*?\n\}/.exec(settings)
  assert.ok(m, '找不到 isStaleSlot() 判据（原工作流健康卡的判据迁到这里）')
  assert.match(m[0], /s\.enabled/, '判据必须要求槽位已启用')
  assert.match(m[0], /commandMissing/, '判据必须排除"缺命令声明"（那是另一种失败，已有专门提示）')
  assert.match(m[0], /daysSince > STALE_DAYS/, '判据必须比对 STALE_DAYS')

  assert.match(settings, /sched-drift is-stale/, '槽位行必须渲染 stale 徽标（要能定位到是哪一班）')
  assert.match(settings, /staleSlots\(status\.slots\)/, '顶部提示区必须说出 stale 的槽位与天数')
})

/**
 * Console 不得再把**引擎的事实**抄一份写在界面上（2026-09-25）。
 *
 * 这一类事故的复现路径很安静：引擎改了常量，界面文案不动，于是界面开始说假话，而且
 * 没有任何门禁会红。已实测到的两处：
 *   · 报表费用卡硬写"按 DeepSeek deepseek-v4-flash 官方价" —— 型号在 `token-cost.mjs`
 *     的 `PRICING` 里，而且那句还漏了"按峰谷计价"（引擎按 `peakHours` 分时计价）；
 *   · 备份卡硬写"保留最近 30 份" —— 份数是 `bridge/backup.mjs` 的 `KEEP_BACKUPS`。
 *
 * 现在两处都改成按接口字段渲染（`/proxy/costs` 的 `meta.pricing`、`/proxy/backup` 的 `keep`）。
 * 这条护栏挡住"再抄一份"：Console 源码里不许出现型号字面量与份数字面量。
 */
test('Console 不得硬写引擎常量：型号与备份份数必须来自接口', () => {
  const files = [
    path.join(REPO, 'bridge', 'console', 'index.html'),
    ...fs
      .readdirSync(CONSOLE)
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => path.join(CONSOLE, f)),
  ]
  const offenders = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    // 型号字面量（如 deepseek-v4-flash）：出现在注释里说明来历是可以的，
    // 因此只在**非注释行**上判定。
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l))
      .join('\n')
    if (/\bdeepseek-[a-z0-9][a-z0-9.-]*/i.test(code))
      offenders.push(`${path.basename(f)}: 出现模型型号字面量（应由 meta.pricing.model 给）`)
    if (/保留最近\s*\d+\s*份/.test(code))
      offenders.push(`${path.basename(f)}: 出现备份份数字面量（应由 /proxy/backup 的 keep 给）`)
  }
  assert.deepEqual(offenders, [], offenders.join('；'))
})

/**
 * 「日历文章」模块删除后的**残留护栏**（2026-09-25）。
 *
 * 为什么需要它：这次删除的每一处都不是"一个文件"，而是**同一条通路的五份** ——
 * Console 视图 / 三条桥路由 / 四个 CLI 方法 / 「日历库」草稿子目录语义 / 两个引擎槽位
 * 加一个提醒脚本。删除时真正费劲的地方不是写新代码，而是把每一份都找齐；
 * 而**只删一半**的后果格外安静：界面上看不出来，只有到点跑不动或数据对不上时才暴露。
 *
 * 因此这里钉一条：源码树（`bridge/**` 与 `crosspost-runtime/src/**`）里，
 * **非注释行**不得再出现 `calendar` / `日历`。注释里可以提（"为什么删"本身是文档），
 * 这正是本仓库既有的判定方式（见上一条护栏：型号字面量同样只在非注释行判）。
 *
 * 两处**刻意保留**的例外，各自写明理由：
 *   · `scheduler/legacy.mjs`：解析的是 launchd 的 `StartCalendarInterval`
 *     （**外部格式的键名**，"日历"在那里指操作系统的到点语义，与本模块无关），
 *     同时它是 `ENGINE_LEGACY_SLOTS = ['calendar-remind']` 的落脚点 ——
 *     那张表必须留着，否则别人机器上残留的旧 plist 会被迁移器**学成项目槽位**；
 *   · `console/styles.css`：`::-webkit-calendar-picker-indicator` 是**原生时间输入框**
 *     的伪元素选择器，名字由浏览器规定，改不了也不该改。
 */
test('源码树不得残留「日历文章」模块的任何接线（注释与两处例外除外）', () => {
  const roots = [path.join(REPO, 'bridge'), path.join(RUNTIME, 'src')]
  const SKIP_DIRS = new Set(['node_modules', '.git'])
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, out)
      else out.push(p)
    }
    return out
  }
  const files = roots.flatMap((r) => walk(r)).filter((f) => /\.(mjs|js|html|css)$/.test(f))
  assert.ok(files.length > 20, `扫描到的源码文件太少（${files.length}）——roots 可能写错了`)

  const ALLOW = [
    {
      file: path.join(RUNTIME, 'src', 'scheduler', 'legacy.mjs'),
      why: '解析 launchd 的 StartCalendarInterval（外部键名）+ 保留历史 label 的卸载路径',
    },
  ]
  const ALLOW_LINE = /-webkit-calendar-picker-indicator/

  const offenders = []
  for (const f of files) {
    if (ALLOW.some((a) => a.file === f)) continue
    const src = fs.readFileSync(f, 'utf8')
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) return // 注释里讲"为什么删"是允许的
      if (ALLOW_LINE.test(line)) return // 原生时间控件的伪元素
      if (/calendar/i.test(line) || /日历/.test(line))
        offenders.push(`${path.relative(REPO, f)}:${i + 1}: ${line.trim().slice(0, 100)}`)
    })
  }
  assert.deepEqual(
    offenders,
    [],
    '以下位置还引用着已删除的「日历文章」模块（源码不许留半条通路）：\n' + offenders.join('\n'),
  )
})

/**
 * 报表视图的取数**接线**（2026-09-25，容器模式性能）。
 *
 * 为什么是静态护栏：报表首屏慢不是算法错，而是"谁等谁"的接线错——
 * `loadReports()` 原先 `await refreshStats()`（三库全量）**之后**才发 `/proxy/costs`，
 * 于是每次打开报表都要串两拍。容器模式下三库走 Docker Desktop 的 bind mount
 * （每篇记录一次跨挂载读），这个串行被放大成用户可感的等待。
 *
 * 正确接线：先画一遍（不等三库）→ 三库与 `/proxy/costs` **并行**发出 →
 * 三库到货后按令牌重渲染。任何一条退回"先 await 三库再发费用请求"，本护栏就红。
 */
test('Console：报表取数不得先串行等三库再发费用请求（2026-09-25 容器模式性能）', () => {
  const reports = fs.readFileSync(path.join(CONSOLE, 'views-reports.mjs'), 'utf8')
  const body = functionBody(reports, 'export async function loadReports(')
  assert.ok(body, '找不到 loadReports 定义')
  assert.doesNotMatch(
    body,
    /await\s+refreshStats\s*\(/,
    'loadReports() 不得 await refreshStats()——那会把报表首屏串行拖到三库之后（容器里每库都要跨挂载读几百个文件）',
  )
  assert.match(
    body,
    /refreshStats\(\)\s*\.then\s*\(/,
    'loadReports() 应以 refreshStats().then(...) 的**后台**形态刷新三库（到货后重渲染）',
  )
  assert.match(
    body,
    /renderReportCosts\s*\(/,
    'loadReports() 必须触发 renderReportCosts()——否则费用卡永远是空的',
  )
})
