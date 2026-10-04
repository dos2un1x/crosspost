#!/usr/bin/env node
/**
 * 一键验收报告（v2.24）
 *
 * 目的：把"新代码有没有搞坏生产"压缩成**一条命令、一屏结论**。
 *
 * 为什么需要它：验收原本要在 4 份文档里翻 6~8 条命令，逐条看输出、
 * 还要自己判断"这个 0 是没跑还是通过"。人一旦嫌麻烦就会跳过检查，
 * 而这类工程最贵的失败模式恰恰是"没人看"——比如 v2.23 那个把导航挤到 0 宽的
 * 布局缺陷，肉眼在宽屏上完全正常，只有自动断言才抓得到。
 *
 * 只读性保证（与 production-path-smoke 同一标准）：
 *   · 所有检查都是既有的只读命令（doctor / 契约 / runtime / 生产冒烟 /
 *     不可变性 / 定时链路）
 *   · 受保护 md 在前后各取一次指纹，**任何改动即判失败**
 *   · 需要副作用的检查（Chrome 冒烟）前置条件不满足时**跳过而非失败**
 *
 * 用法：
 *   npm run verify:acceptance              # 全量（约 2 分钟）
 *   npm run verify:acceptance -- --fast    # 跳过 runtime 全量测试与 Chrome 冒烟
 *
 * 退出码：0 = 全部通过（跳过不算失败）；1 = 有失败
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getArticlesDir, getDraftsDir } from '../src/articles.mjs'
import { resolveProjectStoreDir } from '../src/projects.mjs'
import { engineVersion, engineVersionSource } from '../src/version.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
const REPO = path.resolve(RUNTIME, '..')
const NODE = process.execPath
const FAST = process.argv.includes('--fast')

/** 受保护 md 的扫描根（与 verify-immutable 一致） */
const IMMUTABLE_ROOT = process.env.CROSSPOST_IMMUTABLE_ROOT || REPO

const results = []
/**
 * 记一条检查结果。
 *
 * `kind`（v2.43）区分**代码失败**与**需要人来决定的数据/环境问题**：
 * 前者意味着"这次改动有问题"，后者意味着"系统某个真实状态需要处理"。
 * 两者都会让验收不通过，但混在一个"失败"计数里会让人误判——
 * 实测就发生过：验收报 `✖ 1 项失败`，而那一条其实是**使用者生产数据里
 * 早已存在的测试垃圾**（需要他决定是否清理），代码本身 14 项全绿。
 */
const record = (name, status, evidence, ms, kind = 'code', subOut = '') => {
  results.push({ name, status, evidence, ms, kind })
  const icon = status === 'pass' ? '✔' : status === 'fail' ? '✖' : '－'
  const tag = status === 'fail' && kind === 'data' ? '【待人工处理】' : ''
  console.log(`${icon} ${tag}${name}${evidence ? ' — ' + evidence : ''}`)
  // 失败时把**子套件的失败明细**打出来（v2.46）。
  // 此前只显示 `27/29 项通过`——知道少了两项，但不知道是哪两项，
  // 排查只能靠"再跑一遍看运气"，这正是它变成偶发假失败后最难受的地方。
  if (status === 'fail' && subOut) {
    const lines = String(subOut)
      .split('\n')
      .filter((l) => /^\s*[✗✖]/.test(l) || /^\s*not ok /.test(l))
      .slice(0, 6)
    for (const l of lines) console.log(`      ↳ ${l.trim()}`)
    if (lines.length === 0) console.log('      ↳ （子套件未打印失败明细，需单独重跑）')
  }
}

/** 跑一条命令，返回 { code, out } */
function run(args, { cwd = REPO, env = {}, timeoutMs = 900000, file = NODE } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err, ms: Date.now() - t0 })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: String(e.message), ms: Date.now() - t0 })
    })
  })
}

/* ── 桥调用（只读）：读 bridge/token.local，带 X-CrossPost-Token 打本地桥 ────────
 * 与第 0 项里那段 /proxy/status 同源，抽出来给「smzdm CSRF 通道」复用。
 * 桥没起 / 端口不通 / 没 token → 返回 null，调用方据此**跳过**而不是判负。 */
function bridgeToken() {
  try {
    return fs.readFileSync(path.join(REPO, 'bridge', 'token.local'), 'utf8').trim()
  } catch {
    return null
  }
}

async function bridgeCall(method, params, timeoutMs = 30000) {
  const token = bridgeToken()
  if (!token) return null
  try {
    const res = await fetch('http://127.0.0.1:9540/proxy/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CrossPost-Token': token },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** 仓库内 md 的内容指纹（排除 node_modules / .git / 符号链接）
 *
 * 注意范围：**只覆盖仓库内**。生产草稿在仓库外（位置由接入项目的 manifest 声明），
 * 由第 5 项 `verify:immutable` 用带基线的权威检查覆盖（它包含 md-backup + drafts）。
 * 这一项是"验收过程本身有没有误伤"的兜底，两者不可互相替代。 */
function mdFingerprint(root) {
  const out = new Map()
  const walk = (dir, depth) => {
    if (depth > 12) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const p = path.join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          out.set(p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))
        } catch {
          /* 读不到就跳过（权限等） */
        }
      }
    }
  }
  walk(root, 0)
  return out
}

/** 解析 stdout 里最后一行 JSON */
function lastJson(out) {
  const lines = String(out).trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i])
    } catch {
      /* 继续向上找 */
    }
  }
  return null
}

const git = (args) =>
  new Promise((resolve) => {
    const c = spawn('git', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.on('close', () => resolve(out.trim()))
    c.on('error', () => resolve(''))
  })

/* ────────────────────────── 开始 ────────────────────────── */

console.log(`\n══════════ 一键验收报告 ${new Date().toLocaleString('zh-CN')} ══════════`)
console.log(`仓库：${REPO}`)
console.log(`模式：${FAST ? '快速（跳过 runtime 全量与 Chrome 冒烟）' : '全量'}\n`)

const before = mdFingerprint(IMMUTABLE_ROOT)
console.log(`受保护 md 基线：${before.size} 个\n`)

// ── 0. 版本与环境 ──
const head = await git(['rev-parse', '--short', 'HEAD'])
const tag = await git(['describe', '--tags', '--abbrev=0'])
const dirty = await git(['status', '--porcelain'])
{
  const major = Number(process.versions.node.split('.')[0])
  record(
    'Node 版本满足引擎要求（≥24）',
    major >= 24 ? 'pass' : 'fail',
    `Node ${process.versions.node}`,
    0,
  )
  record(
    '工作区干净（部署状态可复现）',
    dirty === '' ? 'pass' : 'fail',
    dirty === ''
      ? `${head} @ ${tag || '无 tag'}`
      : `${dirty.split('\n').length} 个文件有未提交改动`,
    0,
  )

  // 版本 tag 完整性（v2.48）：每个 `v2.*` tag 都必须**可达自 HEAD**。
  //
  // 为什么需要它：打完 tag 之后又 `git commit --amend` 修了个格式，
  // 于是 tag 指向被 amend 掉的**孤儿提交**（`git describe` 也退回上一个 tag）。
  // 危害：使用者信任的"随时 `git reset --hard vX.YY` 回滚"落到一个不在 main 上的
  // 提交；验收报告里显示的版本号也会是错的。这类问题**不会自己暴露**，只有断言能抓。
  {
    const allTags = (await git(['tag', '-l', 'v2.*'])).split('\n').filter(Boolean)
    const merged = new Set(
      (await git(['tag', '--merged', 'HEAD', '-l', 'v2.*'])).split('\n').filter(Boolean),
    )
    const orphan = allTags.filter((t) => !merged.has(t))
    record(
      '版本 tag 完整性（每个 v2.* 都可从 HEAD 回溯到）',
      allTags.length > 0 && orphan.length === 0 ? 'pass' : 'fail',
      allTags.length === 0
        ? '没有任何 v2.* tag'
        : orphan.length === 0
          ? `${allTags.length} 个 tag 全部可达`
          : `✖ 以下 tag 指向不在 main 上的提交：${orphan.join(', ')}（多为 amend 造成）`,
      0,
    )
    if (orphan.length) {
      console.log('      ↳ 修法：git tag -f -a <tag> <该版本在 main 上的提交>')
    }
  }
}

// ── 0b. 引擎版本一致性（v2.108）──
//
// 为什么需要它：`versionInfo().engine` 是**接入方的对账依据**（`/proxy/status` 与 MCP status
// 都带它），而它此前读 `crosspost-runtime/package.json` 的 version —— 那句注释写着"每个 tag
// 递增"，实际没有任何步骤去改它，于是它长期停在 `0.1.0`，而仓库已经发到 v2.107。
// 一个永远说 0.1.0 的版本字段等于没有，而它不会自己暴露（没有人会去核对一个看着正常的字符串）。
// 现在真值是 `git describe`，本项就是那条"不会自己暴露"的断言。
//
// 桥侧只作提示、不判负：桥是常驻进程，模块只在 spawn 时加载，版本落后正是
// "改了常驻 worker 加载的代码没重启桥"的信号（v2.66 / v2.83 踩过两次），
// 印出来比判负更有用（判负会与"验收第 2 项要求工作区干净"之类的正常场景混在一起）。
{
  const described = await git(['describe', '--tags', '--always', '--dirty'])
  const expect = described ? described.replace(/^v/, '') : ''
  const got = engineVersion()
  const src = engineVersionSource()
  const ok = !!expect && got === expect
  record(
    '引擎版本一致性（version.engine = git describe）',
    ok ? 'pass' : 'fail',
    ok
      ? `${got}（取自 ${src}）`
      : `报告 ${got}（取自 ${src}），期望 ${expect || '（git describe 无输出）'}`,
    0,
  )
  if (!ok) {
    console.log('      ↳ 修法：package.json 只是无 git 环境的回退值；有 git 时以 tag 为准')
  }

  // 桥侧提示（不判负）
  const bridgeEngine = await (async () => {
    try {
      const token = fs.readFileSync(path.join(REPO, 'bridge', 'token.local'), 'utf8').trim()
      const res = await fetch('http://127.0.0.1:9540/proxy/status', {
        headers: { 'X-CrossPost-Token': token },
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) return null
      const j = await res.json()
      return (j && j.version && j.version.engine) || null
    } catch {
      return null
    }
  })()
  if (bridgeEngine && bridgeEngine !== got) {
    console.log(
      `      ↳ 提醒：桥报告的版本是 ${bridgeEngine}（落后于 ${got}）——桥是常驻进程，` +
        '改了它加载的代码就要重启：launchctl kickstart -k gui/$(id -u)/com.crosspost.bridge',
    )
  } else if (bridgeEngine) {
    console.log(`      ↳ 桥报告版本一致：${bridgeEngine}`)
  }
}

// ── 1. doctor（环境自检）──
// 注意：**不写项数**。doctor 的项数随环境变化（是否带项目上下文、桥/扩展是否就绪），
// 手写一个数只会漂——它此前写"19 项"，而实际早已是 23。
{
  // 用 cli.mjs doctor（**结构化 JSON**），不是 doctor-cli.mjs（人类可读文本）。
  const r = await run([path.join(RUNTIME, 'src', 'cli.mjs'), 'doctor'])
  const j = lastJson(r.out)
  const s = (j && j.summary) || {}
  const pass = s.pass || 0
  const warn = s.warn || 0
  const fail = s.fail === undefined ? -1 : s.fail
  record(
    'doctor 环境自检',
    fail === 0 && pass > 0 ? 'pass' : 'fail',
    `${pass} 通过 / ${warn} 提醒 / ${fail < 0 ? '?' : fail} 失败（共 ${s.total || '?'} 项）`,
    r.ms,
  )
  if (fail !== 0) {
    for (const c of (j && j.checks) || []) {
      if (c.severity === 'fail') console.log(`      ↳ 失败项：${c.title} — ${c.detail || ''}`)
    }
  }
}

// ── 2. 契约测试（工具面 + 平台矩阵 + 项目上下文 + 生成能力跨进程契约）──
//
// `generate-provider.test.mjs`（v2.51）之所以点名进来而不是只靠 runtime 全量：
// 它锁的是**跨进程契约**（manifest v2 声明 HTTP 生成端点、端点策略守卫、
// 同步/异步两种响应形态）——P2 之前「一键生成」在真实部署里永远是死的，
// 而这类"配置看起来对、功能实际没有"的缺陷，本项目已经踩过多次。
{
  const r = await run([
    '--test',
    path.join('crosspost-runtime', 'tests', 'surface-contract.test.mjs'),
    path.join('crosspost-runtime', 'tests', 'platform-matrix-contract.test.mjs'),
    path.join('crosspost-runtime', 'tests', 'project-context.test.mjs'),
    path.join('crosspost-runtime', 'tests', 'generate-provider.test.mjs'),
    path.join('crosspost-runtime', 'tests', 'deployment-consistency.test.mjs'),
  ])
  const m = /^# pass (\d+)/m.exec(r.out) || /ℹ pass (\d+)/.exec(r.out)
  const f = /^# fail (\d+)/m.exec(r.out) || /ℹ fail (\d+)/.exec(r.out)
  const skipped = /ℹ skipped (\d+)/.exec(r.out)
  record(
    '契约测试（工具面 / 平台矩阵 / 项目上下文 / 生成契约 / 部署一致性）',
    r.code === 0 ? 'pass' : 'fail',
    `pass=${m ? m[1] : '?'} fail=${f ? f[1] : '?'} skip=${skipped ? skipped[1] : 0}`,
    r.ms,
  )
}

// ── 3. 空环境冒烟（**引擎自治的核心验收**，约 4s）──
//
// 为什么不能省：其余检查都在**本机生产配置**下跑，唯独这一项回答的是
// "把引擎放到一个磁盘上没有任何写作项目的机器上，它能不能装起来、跑起来、
// 自检、渲染"。这正是 P0「引擎自治」的验收标准，也是"开箱即用"的字面含义。
// 它在临时沙箱里跑完整生命周期（setup → doctor → 隔离桥 → 渲染预览），
// 并断言主工作区与接入方目录**零写入**。
{
  const r = await run([path.join(RUNTIME, 'tests', 'empty-env-smoke.mjs')], { timeoutMs: 300000 })
  const ok = (r.out.match(/^✔/gm) || []).length
  const failed = (r.out.match(/^✖/gm) || []).length
  const total = /(\d+)\/(\d+) 通过/.exec(r.out)
  record(
    '空环境冒烟（零项目接入也能装/跑/自检/渲染，且不写主工作区）',
    r.code === 0 && failed === 0 ? 'pass' : 'fail',
    total ? `${total[1]}/${total[2]} 项通过` : `${ok} 通过 / ${failed} 失败`,
    r.ms,
  )
}

// ── 4. runtime 全量测试 ──
if (FAST) {
  record('runtime 全量测试', 'skip', '--fast', 0)
} else {
  const r = await run(['--test', 'tests/*.test.mjs'], { cwd: RUNTIME })
  const m = /ℹ pass (\d+)/.exec(r.out)
  const f = /ℹ fail (\d+)/.exec(r.out)
  record(
    'runtime 全量测试',
    r.code === 0 ? 'pass' : 'fail',
    `pass=${m ? m[1] : '?'} fail=${f ? f[1] : '?'}`,
    r.ms,
  )
}

// ── 4b. core（渲染引擎 + 平台适配器）测试 ──
//
// 为什么必须有（v2.45）：这是仓库里**最大**的测试套件（文件数与例数见运行输出，
// 覆盖 Markdown 渲染、样式引擎、封面/结束卡、以及 zhihu/weixin 适配器），
// 而 `verify:acceptance` 此前只跑 runtime 的 293 例 —— **一多半测试不在验收里**。
// 更值得警惕的是：定时链路因为 `autoPush` 关闭，每天只产草稿、**从不真正派发**，
// 所以适配器正确性完全靠这些测试守着。
//
// 约 19s（vitest），因此 `--fast` 也跳过。
if (FAST) {
  record('core 渲染/适配器测试', 'skip', '--fast', 0)
} else {
  // core 的测试跑在 vitest 上，入口是 npm script → 用 npm 而不是 node
  const r = await run(['run', '--silent', 'test:coverage'], {
    cwd: path.join(RUNTIME, 'core'),
    file: 'npm',
  })
  const t = /Tests\s+(\d+) passed/.exec(r.out)
  const tf = /Test Files\s+(\d+) passed/.exec(r.out)
  const anyFail = /(\d+) failed/.exec(r.out)
  record(
    'core 渲染/适配器测试（验收此前没跑）',
    r.code === 0 && !anyFail ? 'pass' : 'fail',
    t ? `Tests ${t[1]} passed · Files ${tf ? tf[1] : '?'}` : '见输出',
    r.ms,
  )
}

// ── 4c. 代码规范（lint + 格式）──
//
// 为什么放进验收（v2.60）：`npm run check` 里有 lint/format，但验收此前不跑它们，
// 于是"验收 19/19 全绿"与"lint 其实是红的"可以同时成立。实测就发生了：
// v2.57 新增的 shell 变量探测器里 `[^\x00-\x7f]` 触发 `no-control-regex`，
// 而它一直没被任何一条常跑命令暴露出来 —— 直到手工跑 `npm run check` 才现形。
// 一条只在"有人记得手动跑"时才生效的检查，等于没有。两条命令都很便宜。
{
  const lint = await run(['run', '--silent', 'lint'], { file: 'npm' })
  const fmt = await run(['run', '--silent', 'format:check'], { file: 'npm' })
  const ok = lint.code === 0 && fmt.code === 0
  const bad = []
  if (lint.code !== 0)
    bad.push('lint：' + (lint.out + lint.err).trim().split('\n').slice(-6).join(' / '))
  if (fmt.code !== 0)
    bad.push('格式：' + (fmt.out + fmt.err).trim().split('\n').slice(-4).join(' / '))
  record(
    '代码规范（eslint + prettier 格式检查）',
    ok ? 'pass' : 'fail',
    ok ? 'lint 0 问题 · 格式一致' : bad.join(' · '),
    lint.ms + fmt.ms,
  )
}

// ── 5. 生产链路只读冒烟 ──
{
  const r = await run([path.join(RUNTIME, 'tests', 'production-path-smoke.mjs')])
  const ok = (r.out.match(/^✔/gm) || []).length
  const failed = (r.out.match(/^✖/gm) || []).length
  const base = /草稿基线：(\d+)/.exec(r.out)
  record(
    '生产链路只读冒烟（发布路径完好且不写草稿）',
    r.code === 0 && failed === 0 ? 'pass' : 'fail',
    `${ok} 通过 / ${failed} 失败${base ? ` · 草稿 ${base[1]} 个` : ''}`,
    r.ms,
  )
}

// ── 6. 受保护 md 不可变性 ──
{
  const r = await run([path.join(RUNTIME, 'tests', 'verify-immutable.mjs')])
  const mod = /内容被修改：(\d+)/.exec(r.out)
  const del = /被删除：(\d+)/.exec(r.out)
  const mv = /已移动[^：]*：(\d+)/.exec(r.out) // v2.91：归档/留存导致的目录变更
  const ret = /已留存\/归档的新增[^：]*：(\d+)/.exec(r.out)
  const und = /未声明的新增：(\d+)/.exec(r.out)
  const modN = mod ? Number(mod[1]) : -1
  const delN = del ? Number(del[1]) : -1
  /**
   * 归因（v2.91）：**内容没改、也没被删**，只是出现了未声明的新文件时，这一条是
   * "使用者生产数据里有个引擎不认识的产物"，不是代码缺陷 —— 标成 kind='data'，
   * 报告里显示【待人工处理】。它仍然让验收不通过（不掩盖），只是不再和
   * "受保护 md 被改了"混成一个"代码失败"。
   *
   * 硬边界：只有 修改=0 且 删除=0 才允许这样归因；一旦有内容变更或删除，
   * 一律按 kind='code' 报，绝不被归成"数据问题"。
   */
  const addsOnly = modN === 0 && delN === 0 && und && Number(und[1]) > 0
  record(
    '受保护 md 未被修改/删除（本项目最硬的约束）',
    r.code === 0 ? 'pass' : 'fail',
    `修改=${modN < 0 ? '?' : modN} 删除=${delN < 0 ? '?' : delN}` +
      ` 移动=${mv ? mv[1] : '?'} 留存/归档新增=${ret ? ret[1] : '?'}` +
      ` 未声明新增=${und ? und[1] : 0}`,
    r.ms,
    addsOnly ? 'data' : 'code',
  )
}

// ── 6b. 生产编辑记忆未被**测试**污染（v2.40）──
//
// 这是本项目发现过的最隐蔽的一类破坏：测试全绿，生产数据在悄悄烂。
// `bridge.test.mjs` 会真的打 `POST /proxy/delete`，那条路径经 `deleteDraft` →
// `pushHumanFeedback()` 写 `history/editorial-memory.json`；而它当时只隔离了
// 两个状态文件，于是**真实部署**的 `humanFeedback` 被写满 30 条
// `{type:'article-delete', id:'no-such-id-xyz'}`（正是测试的假 id），
// 而该数组上限就是 30 —— 真实人工反馈被整段挤掉，且无备份可恢复。
//
// 这条检查认的是**内容特征**（垃圾 id），不是"文件有没有变"——因此不会与
// 定时链路的正常写入冲突，却能立刻抓住同类回归。
{
  const histFile =
    process.env.CROSSPOST_SMOKE_EDITORIAL_MEMORY ||
    // 路径**从引擎配置推**（`projectsDirs` 下一层的 `history/editorial-memory.json`），
    // 不在仓库里写死某个接入项目的目录 —— 那样只有一台机器成立，也把私有目录名带进公开仓库。
    (() => {
      try {
        const cfg = JSON.parse(
          fs.readFileSync(
            process.env.CROSSPOST_CONFIG || path.join(RUNTIME, 'config.json'),
            'utf8',
          ),
        )
        for (const dir of cfg.projectsDirs || []) {
          let names = []
          try {
            names = fs.readdirSync(dir)
          } catch {
            continue
          }
          for (const n of names) {
            const p = path.join(dir, n, 'history', 'editorial-memory.json')
            if (fs.existsSync(p)) return p
          }
        }
      } catch {
        /* 无本机配置 → 视为无污染（与文件不存在时同一条分支） */
      }
      return null
    })()
  let junk = -1
  let total = -1
  try {
    const d = JSON.parse(fs.readFileSync(histFile, 'utf8'))
    const hf = Array.isArray(d.humanFeedback) ? d.humanFeedback : []
    total = hf.length
    junk = hf.filter((x) => JSON.stringify(x).includes('no-such-id-xyz')).length
  } catch {
    /* 文件不存在 → 视为无污染 */
    junk = 0
  }
  record(
    '生产编辑记忆未被测试污染（humanFeedback 无测试假 id）',
    junk === 0 ? 'pass' : 'fail',
    junk === -1
      ? '读不到（跳过）'
      : junk === 0
        ? `humanFeedback ${total} 条，无测试条目`
        : `⚠ humanFeedback ${total} 条中有 ${junk} 条测试垃圾（真实人工反馈已被挤出上限）`,
    0,
    'data', // 需要人来决定是否清理，不是本次改动的代码问题
  )
  if (junk > 0) {
    console.log(`      ↳ 位置：${histFile}`)
    console.log('      ↳ 成因：`bridge.test.mjs` 未隔离 historyDir（已修）')
    console.log(
      '      ↳ 清理（可自行执行；本脚本不写生产数据）：\n' +
        `         python3 -c "import json;p='${histFile}';d=json.load(open(p));` +
        `d['humanFeedback']=[x for x in d['humanFeedback'] if 'no-such-id-xyz' not in json.dumps(x)];` +
        `json.dump(d,open(p,'w'),ensure_ascii=False,indent=2)"`,
    )
  }
}

// ── 7. 定时链路 ──
//
// 2026-09-20（v2.81）：本项此前只看"跑了没"，**看不见**"到点会不会被门禁 SKIP"——
// 而槽位开关是项目级设置后，门禁（接入方的定时脚本）与 Console 一旦读的不是同一份，
// 就会出现"Console 看着开、到点却被跳过"。现在把**门禁自己的回答**也拉进来做交叉核对。
{
  const r = await run([path.join(RUNTIME, 'tests', 'verify-scheduled-run.mjs')])
  const line = /已启用且到点 (\d+) 个：✔ 正常收尾 (\d+)，⚠ 有日志无收尾 (\d+)，✖ 无日志 (\d+)/.exec(
    r.out,
  )
  const cli = path.join(RUNTIME, 'src', 'cli.mjs')
  const slots = ['morning', 'hotspot', 'noon', 'hotspot2', 'tips', 'evening']
  const gate = {}
  for (const slot of slots) {
    const g = await run([cli, 'slotEnabled', slot])
    const j = lastJson(g.out)
    if (j && typeof j.run === 'boolean') gate[slot] = j
  }
  const explicitOn = slots.filter((x) => gate[x] && gate[x].value === true)
  const explicitOff = slots.filter((x) => gate[x] && gate[x].value === false)
  const offLine = /未启用（引擎判定，不要求有日志）：([^\n]*)/.exec(r.out)
  const reportedOff = offLine
    ? offLine[1]
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
    : []
  // 只比对"配置里显式写了的槽位"：未写时门禁是 fail-open（跑），状态会回退 launchctl，
  // 两者语义不同，硬比会制造假失败。
  const mismatched = [
    ...explicitOff
      .filter((x) => !reportedOff.includes(x))
      .map((x) => `${x}(门禁 off 但报告说启用)`),
    ...explicitOn.filter((x) => reportedOff.includes(x)).map((x) => `${x}(门禁 on 但报告说未启用)`),
  ]
  const gateOk = Object.keys(gate).length > 0 && mismatched.length === 0
  record(
    '定时链路运行情况',
    r.code === 0 && gateOk ? 'pass' : 'fail',
    (line
      ? `到点 ${line[1]} · 正常 ${line[2]} · 未收尾 ${line[3]} · 无日志 ${line[4]}`
      : '见输出') +
      ` · 门禁将跑：${explicitOn.join('/') || '(无)'}` +
      (explicitOff.length ? ` · 门禁已关：${explicitOff.join('/')}` : '') +
      (mismatched.length ? ` · ⚠ 与报告不一致：${mismatched.join('；')}` : ''),
    r.ms,
    'code',
  )
}

// ── 7b. 定时链路的**组合前提**：那个 profile 还能不能组合 ──
//
// 为什么单列一项（v2.53）：`verify-scheduled-run.mjs` 回答的是"今天这几个槽位跑了没"，
// 那是**事后**证据；而真正会让明天 08:30 静默不产出的，是 profile **组合不出来**
// （YAML 缩进写坏、叠加层文件丢了）。那种失败发生在 launchd 里，用户看不到——
// 等发现时已经是"今天没有文章"。
//
// 2026-09-19 的迁移把写作规范本体（cordis.patch.yml）移到接入方仓库、
// `~/.dsh` 侧只留软链，于是"软链断了/指错地方"成了一个全新的静默失败模式。
// 这项检查同时钉住两件事：**能组合**（exit 0）+ **叠加层确实生效**
// （patch 里声明的每个 `- id:` 都出现在组合结果里，而不是被静默跳过）。
{
  // 定时链路用的那个 profile：从本机 DSH profile 目录里**发现**，不在仓库里写死 profile 名
  // （那是某台机器的部署细节）。判据：叠加层是**软链**（写作规范本体在仓库外）的那个；
  // 没有软链时退回"确实声明了叠加行"的那个；都没有 → 本机没有定时链路 → 跳过。
  const profilesRoot = path.join(
    process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    'profiles',
  )
  const profileName = (() => {
    try {
      const withPatch = fs
        .readdirSync(profilesRoot)
        .filter((n) => fs.existsSync(path.join(profilesRoot, n, 'cordis.patch.yml')))
      const patchOf = (n) => path.join(profilesRoot, n, 'cordis.patch.yml')
      const linked = withPatch.filter((n) => {
        try {
          return fs.lstatSync(patchOf(n)).isSymbolicLink()
        } catch {
          return false
        }
      })
      if (linked.length) return linked[0]
      return (
        withPatch.find((n) => {
          try {
            return /^\s*- id:/m.test(fs.readFileSync(patchOf(n), 'utf8'))
          } catch {
            return false
          }
        }) || null
      )
    } catch {
      return null
    }
  })()
  const profileDir = profileName ? path.join(profilesRoot, profileName) : profilesRoot
  const patch = path.join(profileDir, 'cordis.patch.yml')
  const dshBin = [process.env.DSH_BIN, path.join(os.homedir(), '.local', 'bin', 'dsh')].find(
    (p) => p && fs.existsSync(p),
  )

  if (!fs.existsSync(profileDir) || !dshBin) {
    record(
      `定时链路 profile 组合前提（${profileName || '未发现带叠加层的 profile'}）`,
      'skip',
      !fs.existsSync(profileDir) ? '本机无该 profile' : '未找到 dsh 可执行文件',
      0,
    )
  } else {
    // 跑在项目根（与 publish_once.sh 一致），组合结果与运行环境同源；
    // 项目根不存在时退回仓库（本机之外的机器上仍能完成"能组合"这一判断）
    // 接入方仓库根（组合结果与运行环境同源）从引擎配置推，不在仓库里写死具体项目名
    const hostRepo = (() => {
      try {
        const cfg = JSON.parse(
          fs.readFileSync(
            process.env.CROSSPOST_CONFIG || path.join(RUNTIME, 'config.json'),
            'utf8',
          ),
        )
        return (cfg.projectsDirs || [])[0] || null
      } catch {
        return null
      }
    })()
    const cwd =
      [process.env.CROSSPOST_MIGRATION_CWD, hostRepo, REPO].find((p) => p && fs.existsSync(p)) ||
      REPO
    const r = await run([dshBin, '--profile', profileName, '--dump-config'], {
      cwd,
      timeoutMs: 120000,
    })
    const lines = r.out.split('\n').length
    // 叠加层声明的每个 row id 都必须出现在组合结果里
    let declared = []
    try {
      declared = [...fs.readFileSync(patch, 'utf8').matchAll(/^\s*- id:\s*(\S+)/gm)].map(
        (m) => m[1],
      )
    } catch {
      declared = []
    }
    const missing = declared.filter((id) => !new RegExp(`- id:\\s*${id}\\b`).test(r.out))
    const ok = r.code === 0 && lines > 100 && declared.length > 0 && missing.length === 0
    record(
      `定时链路 profile 组合前提（${profileName} 能组合且叠加层已生效）`,
      ok ? 'pass' : 'fail',
      r.code !== 0
        ? `dump-config 退出码 ${r.code}：${(r.err || r.out).split('\n').slice(-2).join(' ')}`
        : `组合 ${lines} 行 · 叠加层声明 ${declared.length} 项${missing.length ? ` · 缺失 ${missing.join(',')}` : ' · 全部生效'}`,
      r.ms,
      'code',
      ok ? '' : r.out + r.err,
    )
  }
}

// ── 8. 项目维度真的生效（对照实测，而不是只看单测）──
//
// 这一项要证明的是"**指定项目时不会串到默认内容域**"。所以必须拿一个
// **数据目录确实不同于默认**的项目来对照 —— v2.54 踩到：
// 真实写作项目接进注册表后，它的 dataDir 就是引擎的默认草稿目录
// （"默认视图"本来服务的就是这个项目），对着它断言"必须无交集"必然失败，
// 而那不是缺陷、是当时的设计。
//
// v2.74 反过来了：默认域与项目域**必须分开**（默认域是引擎自有的空域，
// `paths.json` 的 draftsDir/articlesDir 不再借用任何项目的目录）。
// 于是本项断言随之改写：
//   · 旧的 `默认>0` 是"默认视图服务这个项目"那个设计留下的尾巴，删掉——
//     它会把"默认域该是空的"判成失败，正好判反
//   · 改钉**结构性分离**：没有任何注册项目的草稿目录或记录目录与默认域同物理目录
//     （v2.74 之前别名接线时，项目记录目录就与默认域相同）
//   · 沙箱项目自己的 1 篇、与默认视图交集 0 —— 这条照旧，它证明隔离仍然有效
// 为什么不直接断言 `默认==0`：默认域是**允许**被写的（用户可以不选项目就在里面写）。
// "空"是当前状态，"与项目不同目录"才是要一直成立的不变量；把状态当断言会制造假失败。
//
// v2.60 修正：此前是"在已注册项目里找一个 dataDir 不同的"，找不到就 skip。
// 那等于把本项的**覆盖能力寄托在机器上恰好留着一个示例项目**上 ——
// 示例项目一删（它是 `.local/` 下的合成数据，本来就该删），本项就静默降级成
// skip，而报告里 skip 和 pass 一样都是不失败，等于悄悄丢掉一条覆盖。
// 现在改为**自己搭样本**：临时目录里现写一个 manifestVersion 2 的最小项目，
// 用 `CROSSPOST_LOCAL_ROOT` 一个变量把它的项目根与引擎簿记目录
// （`<localRoot>/project-state/<id>/articles`）一起关进同一个临时目录，
// 结束时整目录删除，仓库与生产内容域零残留。这样本项的通过与否只取决于
// 引擎行为，不再取决于机器状态。
{
  const cli = path.join(RUNTIME, 'src', 'cli.mjs')
  const defaultDrafts = path.resolve(getDraftsDir())
  const defaultArticles = path.resolve(getArticlesDir())
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-acceptance-proj-'))
  const TMP_ID = 'acceptance-sandbox'
  const tmpData = path.join(tmpRoot, 'drafts')
  const env = { CROSSPOST_LOCAL_ROOT: path.join(tmpRoot, 'local') }
  let ms = 0

  try {
    fs.mkdirSync(path.join(env.CROSSPOST_LOCAL_ROOT, 'projects', TMP_ID, '.crosspost'), {
      recursive: true,
    })
    fs.mkdirSync(tmpData, { recursive: true })
    fs.writeFileSync(
      path.join(env.CROSSPOST_LOCAL_ROOT, 'projects', TMP_ID, '.crosspost', 'project.json'),
      JSON.stringify(
        {
          id: TMP_ID,
          name: '验收用临时项目',
          manifestVersion: 2,
          capabilities: { drafts: true, generate: false },
          dataDir: tmpData,
        },
        null,
        2,
      ),
    )
    // 必须放一篇真草稿：空目录下"交集为 0"是句废话（空集与任何集合都无交集），
    // 只有该项目自身有内容、而默认视图里没有它，才证明得了"没串味"。
    fs.writeFileSync(
      path.join(tmpData, '2099-01-01-tmp-acceptance-sample.md'),
      '---\ntitle: 验收临时样本\nscore: 60\nrisk: none\n---\n' +
        '验收用临时草稿，位于系统临时目录，本次验收结束即随目录删除。\n',
    )

    const reg = await run([cli, 'projects'], { env })
    ms += reg.ms
    const projects = ((lastJson(reg.out) || {}).projects || []).filter(
      (p) => p.valid && p.id && p.provider && p.provider.dataDir,
    )
    const self = projects.find((p) => p.id === TMP_ID)
    // 结构性分离：默认域不得与任何注册项目的草稿目录或记录目录同物理目录
    // （v2.74 之前别名把默认记录目录指到项目簿记上，这一条就是拦它的）
    const aliasing = projects.filter(
      (p) => p.id !== TMP_ID && path.resolve(p.provider.dataDir) === defaultDrafts,
    )
    const storeAliasing = projects.filter((p) => {
      if (p.id === TMP_ID) return false
      try {
        const r = resolveProjectStoreDir(p.id)
        return !!(r && r.dir && path.resolve(r.dir) === defaultArticles)
      } catch {
        return false
      }
    })

    if (!self) {
      // 自己搭的样本注册不上 = 注册表/路径来源本身有问题，不能降级成 skip
      record(
        '内容域项目隔离（对照实测）',
        'fail',
        `临时项目 ${TMP_ID} 未能注册（CROSSPOST_LOCAL_ROOT=${env.CROSSPOST_LOCAL_ROOT}）` +
          `· 当前注册表 ${projects.map((p) => p.id).join(', ') || '(空)'}`,
        ms,
      )
    } else {
      const def = await run([cli, 'listArticles'], { env })
      const scoped = await run([cli, 'listArticles', `--project=${TMP_ID}`], { env })
      ms += def.ms + scoped.ms
      const base = lastJson(def.out)
      const s = lastJson(scoped.out)
      const nDef = base && base.articles ? base.articles.length : -1
      const nScoped = s && s.articles ? s.articles.length : -1
      const idsDef = new Set(((base && base.articles) || []).map((a) => a.id))
      const overlap = ((s && s.articles) || []).filter((a) => idsDef.has(a.id)).length

      // v2.74：默认域必须与任何注册项目的域**不是同一物理目录**（草稿与记录两侧都查）；
      // 沙箱项目自成 1 篇、互不串味。默认域篇数只作为观察值上报——它允许被写，不能当断言。
      const ok =
        nDef >= 0 &&
        nScoped === 1 &&
        overlap === 0 &&
        aliasing.length === 0 &&
        storeAliasing.length === 0
      record(
        `内容域项目隔离（--project=${TMP_ID} 自备样本，与默认目录不同且互不串味）`,
        ok ? 'pass' : 'fail',
        `默认域 ${nDef} 篇 · ${TMP_ID} ${nScoped} 篇（应为 1）· 交集 ${overlap}（应为 0）` +
          ` · 默认记录目录=${defaultArticles}` +
          ` · 样本 dataDir=${tmpData}` +
          (aliasing.length ? ` · ⚠ ${aliasing.length} 个项目与默认**草稿**目录同目录` : '') +
          (storeAliasing.length
            ? ` · ⚠ ${storeAliasing.length} 个项目与默认**记录**目录同目录`
            : ''),
        ms,
      )
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// ── 9. Console 真浏览器冒烟（需要生产桥在跑 + 系统 Chrome）──
{
  const bridgeUp = await new Promise((resolve) => {
    const c = spawn(
      '/usr/bin/curl',
      [
        '-sS',
        '-m',
        '3',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        'http://127.0.0.1:9540/proxy/bootstrap',
      ],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.on('close', () => resolve(out.trim() === '200'))
    c.on('error', () => resolve(false))
  })
  const hasChrome = fs.existsSync('/Applications/Google Chrome.app')
  if (FAST) {
    record('Console 真浏览器冒烟', 'skip', '--fast', 0)
  } else if (!bridgeUp) {
    record('Console 真浏览器冒烟', 'skip', '生产桥未在 9540 运行', 0)
  } else if (!hasChrome) {
    record('Console 真浏览器冒烟', 'skip', '未找到系统 Chrome', 0)
  } else {
    const r = await run([path.join(RUNTIME, 'tests', 'console-smoke.mjs')], {
      env: { CONSOLE_TEST_PORT: '9540' },
    })
    const m = /通过 (\d+)\/(\d+)/.exec(r.out)
    record(
      'Console 真浏览器冒烟（含导航可达性）',
      r.code === 0 ? 'pass' : 'fail',
      m ? `${m[1]}/${m[2]} 项通过` : '见输出',
      r.ms,
      'code',
      r.out,
    )

    // 接入与自检页（v2.31 纳入验收）：四步排查 + 平台矩阵芯片数 + **项目切换器与
    // 注册表状态一致**。后者是 P1 的用户可见面——选中项目后内容域会跟着切，
    // 所以"切换器是否可用、选项是否列全"必须与 /proxy/projects 对得上。
    const o = await run([path.join(RUNTIME, 'tests', 'console-onboarding-smoke.mjs')], {
      env: { CONSOLE_TEST_PORT: '9540' },
    })
    const om = /(\d+)\/(\d+) 通过/.exec(o.out)
    record(
      'Console 接入与自检页（项目切换器与注册表一致）',
      o.code === 0 ? 'pass' : 'fail',
      om ? `${om[1]}/${om[2]} 项通过` : '见输出',
      o.ms,
      'code',
      o.out,
    )

    // 选题「一键生成」状态条四态（v2.45 纳入）：v2.42 我改过它的错误态渲染
    // （能力未提供时要显示"不可用"而不是"生成失败（exit=?）"），
    // 而这条链路的四态此前只在单独跑时验证过。它用 page.route 拦掉真实生成请求，
    // 不会触碰生产。
    const b = await run([path.join(RUNTIME, 'tests', 'console-topics-banner.mjs')], {
      env: { CONSOLE_TEST_PORT: '9540' },
    })
    const bm = /通过 (\d+)\/(\d+)/.exec(b.out)
    record(
      'Console 选题状态条四态（idle/running/done/failed）',
      b.code === 0 ? 'pass' : 'fail',
      bm ? `${bm[1]}/${bm[2]} 项通过` : '见输出',
      b.ms,
      'code',
      b.out,
    )
  }
}

// ── 10. MCP 协议面（**定时链路真正走的接口**）──
//
// v2.46：**刻意排在 Console 浏览器检查之后**。这一项会经浏览器扩展发真实外网请求
// （httpbin / zhihu 登录态检查），会把代理通道占住一会儿；此前它排在 Console 检查
// 之前，紧接着做的 Console 冒烟偶发报 27/29（设置页要从扩展拉 12 个平台状态）。
// 让"会打网络"的检查排在最后，浏览器检查就稳定了。
//
// 为什么必须有这一项：`verify:acceptance` 此前完全没碰 MCP，而
// 定时链路的发布链路恰恰是 MCP（profile 里注册的是
// mcp-crosspost → mcp-server/index.mjs），不是 CLI、也不是 xp_* 预设插件。
// "CLI 冒烟通过" 不等于 "定时链路能跑"。
//
// test-mcp.mjs 自 v2.25 起默认只读（写操作需 CROSSPOST_MCP_LIVE=1），可安全调用。
// 只断言握手 + 工具清单——单个工具依赖外部网络/浏览器代理，失败时只提示不判负
// （那是环境问题，不是这次改动的问题）。
{
  const r = await run([path.join(RUNTIME, 'mcp-server', 'test-mcp.mjs')], { timeoutMs: 300000 })
  const m = /^tools: (.+)$/m.exec(r.out)
  const toolCount = m ? m[1].split(',').length : 0
  const failed = (r.out.match(/^❌/gm) || []).length
  const readOnly = /模式：只读/.test(r.out)
  record(
    'MCP 协议面（定时链路走的接口：握手 + 工具清单）',
    r.code === 0 && toolCount >= 19 ? 'pass' : 'fail',
    `${toolCount} 个工具可列出${readOnly ? ' · 默认只读模式' : ' · ⚠非只读模式'}` +
      (failed ? ` · 单工具失败 ${failed} 个（环境相关，不计负）` : ''),
    r.ms,
  )
  if (!readOnly) {
    console.log('      ↳ 警告：MCP 自测未处于只读模式，可能已在真实平台留下草稿')
  }
}

// ── 10b. smzdm CSRF 通道（页面上下文取 token）──
//
// 为什么单列一项（2026-09-29 事故）：扩展侧把回包读成 `body.data.data.token`，而接口只回
// **一层** data（`body.data.token`）→ op 恒回 `{success:true, token:null}` → smzdm 推送 100% 失败，
// 而当时整套测试全绿 —— 唯一固定这个 op 形状的用例把**错的形状**当成了契约。
//
// 判据只打**通道**，不发布、不留草稿：
//   · 先 pageFetch 拿一次真回包。拿不到 `data.token`（没登录 / 撞上 WAF 挑战页）→ 跳过（环境问题，不判负）；
//   · 真回包里有 token，再看 op 自己读没读出来：读出来 = pass，读不出 = fail —— 那正是这次那个 bug。
// 这样既抓得住"读错字段层级"，又不会因为"今天没登录"把验收判红。
{
  if (FAST) {
    record('smzdm CSRF 通道（页面上下文取 token）', 'skip', '--fast', 0)
  } else {
    const tabs = await bridgeCall('tabsQuery', { url: 'https://post.smzdm.com/*' })
    const tabId = tabs && Array.isArray(tabs.result) && tabs.result[0] ? tabs.result[0].id : null
    if (tabId === null) {
      record('smzdm CSRF 通道（页面上下文取 token）', 'skip', '没有 post.smzdm.com 的标签页', 0)
    } else {
      // 真值：同一条通道、同一个页面上下文，直接读回包
      const raw = await bridgeCall('pageOp', {
        tabId,
        op: 'pageFetch',
        args: [
          'https://post.smzdm.com/api/editor/get_token',
          'GET',
          null,
          '{"Accept":"application/json"}',
        ],
      })
      let realToken = null
      try {
        const text = raw && raw.result && raw.result.text
        const body = text ? JSON.parse(text) : null
        realToken =
          body && body.data && typeof body.data.token === 'string' && body.data.token
            ? body.data.token
            : null
      } catch {
        realToken = null
      }
      if (!realToken) {
        record(
          'smzdm CSRF 通道（页面上下文取 token）',
          'skip',
          '这次页面上下文没拿到 token（未登录或撞上 WAF），无法判定通道',
          0,
        )
      } else {
        const op = await bridgeCall('pageOp', { tabId, op: 'smzdmGetToken', args: [] })
        const got = op && op.result ? op.result.token : undefined
        const ok = typeof got === 'string' && got !== ''
        record(
          'smzdm CSRF 通道（页面上下文取 token）',
          ok ? 'pass' : 'fail',
          ok
            ? `接口回 data.token（${realToken.slice(0, 8)}…），op 也读到了（${got.slice(0, 8)}…）`
            : `接口明明回了 data.token（${realToken.slice(0, 8)}…），op 却回 ${JSON.stringify(got)}` +
                ' —— 多半是 op 读错了字段层级（见 bridge/chrome-proxy-extension/sw.js 的 smzdmGetToken）',
          0,
        )
      }
    }
  }
}

// ── 11. 受保护 md 复核（跑完所有检查后必须一字未变）──
{
  const after = mdFingerprint(IMMUTABLE_ROOT)
  const added = [...after.keys()].filter((k) => !before.has(k))
  const removed = [...before.keys()].filter((k) => !after.has(k))
  const changed = [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k))
  record(
    '验收过程本身未改动仓库内任何 md（前后指纹复核）',
    changed.length === 0 && removed.length === 0 ? 'pass' : 'fail',
    `新增 ${added.length} · 删除 ${removed.length} · 修改 ${changed.length}`,
    0,
  )
  if (added.length) {
    for (const p of added.slice(0, 8)) console.log(`      ↳ 新增：${path.relative(REPO, p)}`)
    if (added.length > 8) console.log(`      ↳ …另有 ${added.length - 8} 个`)
  }
}

// ── 11b. 调度子系统契约（v2.3）──
//
// 为什么单列一项：v2.3 把"到点触发"从操作系统搬进了引擎（删掉 launchd 后端约 600 行），
// 于是**以前由系统兜住的语义现在全是我们自己的责任**：
//   · 声明的校验（argv / 路径不得逃出项目根 / 未知字段报错）
//   · 触发策略（每天最多一次、补跑窗口、崩在中间不重跑、时区与 DST）
//   · 执行器（先写 intent 再 spawn、日志名与旧任务一致、重叠跳过、单实例锁）
//   · 旧任务迁移（学得对、备份得住、幂等、多时间点拒绝）
//   · Docker 打包不变量（端口只发环回、同路径挂载、依赖私有卷）
// 这些都在**本机可跑**（不需要 Linux / systemd / docker），所以纳入验收而不是"相信它没问题"。
//
// 退役项说明：原来这一位是「文档计数」（v2.1 已退役，见文件末尾注释）。
{
  const files = [
    'scheduler-spec.test.mjs',
    'scheduler-timer.test.mjs',
    'scheduler-runner.test.mjs',
    'scheduler-migrate.test.mjs',
    'docker-contract.test.mjs',
  ].map((f) => path.join('crosspost-runtime', 'tests', f))
  const r = await run(['--test', ...files], { timeoutMs: 180000 })
  const m = /# pass (\d+)/.exec(r.out) || /pass (\d+)/.exec(r.out)
  const f2 = /# fail (\d+)/.exec(r.out) || /fail (\d+)/.exec(r.out)
  const passN = m ? Number(m[1]) : null
  const failN = f2 ? Number(f2[1]) : null
  const skipped = /# skipped (\d+)/.exec(r.out)
  record(
    '调度子系统契约（声明 / 触发策略 / 执行器 / 迁移 / 容器打包）',
    r.code === 0 && failN === 0 && passN > 0 ? 'pass' : 'fail',
    `pass=${passN ?? '?'} fail=${failN ?? '?'} skip=${skipped ? skipped[1] : 0}` +
      '（退役：原「文档计数」项，见文件末尾）',
    r.ms,
    'code',
    r.code === 0 ? '' : r.out + r.err,
  )
}

// ── 12.（已退役）文档计数 ──
//
// v2.0 时这里校验根 README 的"计数自检"生成块（`<!-- counts:begin -->`）：把
// 用例数 / 平台数 / 目录 md 数等与本次实测逐字段比对。v2.1 起产品文档只讲
// "是什么 / 怎么用"，这类内部回归数字从文档里消失，生成块失去宿主，于是整套机制退役：
// `src/scripts/docs-counts.mjs`、`tests/docs-counts.test.mjs`、`docs:counts` 脚本、
// 以及本项一并删除（验收项 22 → 21）。
//
// 若将来又需要在文档里放机器实测的数字，正确做法是重新引入一个**宿主明确**的生成块，
// 而不是回到手写。

/* ────────────────────────── 汇总 ────────────────────────── */
const pass = results.filter((r) => r.status === 'pass').length
const fails = results.filter((r) => r.status === 'fail')
const fail = fails.length
const codeFail = fails.filter((r) => r.kind !== 'data').length
const dataFail = fail - codeFail
const skip = results.filter((r) => r.status === 'skip').length
const totalMs = results.reduce((a, r) => a + (r.ms || 0), 0)

console.log('\n' + '─'.repeat(66))
if (fail === 0) {
  console.log(`✔ 验收通过：${pass} 项通过${skip ? `，${skip} 项跳过` : ''}，0 项失败`)
} else {
  console.log(
    `✖ 验收未通过：${pass} 项通过，**${fail} 项失败**` +
      (dataFail
        ? `（其中 ${dataFail} 项是**待人工处理的既有状态**、${codeFail} 项是代码问题）`
        : '') +
      (skip ? `，${skip} 项跳过` : ''),
  )
  for (const r of results.filter((x) => x.status === 'fail')) {
    console.log(`   ✖ ${r.name} — ${r.evidence}`)
  }
}
console.log(`   耗时约 ${Math.round(totalMs / 1000)}s`)
console.log('─'.repeat(66) + '\n')

process.exit(fail === 0 ? 0 : 1)
