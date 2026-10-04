#!/usr/bin/env node
/**
 * 开箱即用报告（OOB）—— 把"陌生人 clone 下来能不能装起来、用起来"压成一条命令、一屏结论。
 *
 * ## 与 `verify:acceptance` 的分工
 *
 *   · `verify:acceptance` = **本机生产状态**（草稿 / 接入项目 / 桥 / 调度 / 发布链路）有没有被新代码改坏；
 *   · `verify:oob`        = 换一台**没有 node_modules、没有本机运行态**的机器，照文档能不能起来。
 *
 * 后者刻意不依赖本机生产状态 —— 只有 E6 会看一眼本机，且拿不到时**跳过而不是失败**
 * （在别人的 runner 上"没有 9540 上的桥"是正常状态，不是代码红）。
 *
 * ## 两档
 *
 *   默认（快、离线、可进 CI）：
 *     E1 空环境     零项目接入也能装 / 起 / 自检 / 渲染
 *     E4 文档自足   产品文档引用的仓库路径都在干净 clone 里
 *     E5 发布物洁净 无运行态/凭据、vendored 有归属、无作者家目录
 *     E6 本机状态   doctor 0 失败 + Console 可达（拿不到就跳过）
 *   `--full` 追加：
 *     E2 干净 clone 照 README 两步装起来，再真起一次桥（需网络，2–6 分钟）
 *     E3 容器       容器形态的依赖与产物（需 Docker；**不发布端口**，可与在跑的原生桥并存）
 *
 * 退出码：0 = 无失败（跳过不算失败）；1 = 有失败。
 */
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { versionInfo } from '../src/version.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
const REPO = path.resolve(RUNTIME, '..')
const NODE = process.execPath
const FULL = process.argv.includes('--full')

const results = []
const record = (name, status, evidence, ms) => {
  results.push({ name, status, evidence, ms })
  const icon = status === 'pass' ? '✔' : status === 'fail' ? '✖' : '－'
  console.log(`${icon} ${name}${evidence ? ' — ' + evidence : ''}`)
}

/** 跑一条命令，返回 { code, out, err, ms }；`file` 默认是 node，跑 npm 脚本时传 'npm' */
function run(args, { cwd = RUNTIME, env = {}, timeoutMs = 1800000, file = NODE } = {}) {
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

/** 从 `N/M 通过` 或 `ℹ pass N` 里取通过数 */
function counts(text) {
  const passed = /(\d+)\s*\/\s*(\d+)\s*通过/.exec(text)
  if (passed) return { pass: Number(passed[1]), total: Number(passed[2]) }
  const nodeTest = /ℹ pass (\d+)/.exec(text)
  if (nodeTest) return { pass: Number(nodeTest[1]), total: null }
  const docker = /✔ 通过：(\d+) 项/.exec(text)
  if (docker) return { pass: Number(docker[1]), total: Number(docker[1]) }
  return null
}

/** 失败时给出可读的失败行，而不是整段输出 */
const failureLines = (r, n = 4) =>
  String(r.out + r.err)
    .split('\n')
    .filter((l) => /✖|失败项|not ok|Error|错误/.test(l))
    .slice(0, n)
    .map((l) => l.trim())
    .join(' | ')

const smoke = async (name, file, evidenceName, { env = {}, timeoutMs } = {}) => {
  const r = await run([path.join('tests', file)], { env, timeoutMs })
  const c = counts(r.out)
  record(
    name,
    r.code === 0 ? 'pass' : 'fail',
    r.code === 0
      ? c
        ? `${c.pass}/${c.total ?? '?'} 项通过`
        : `${evidenceName} 通过`
      : failureLines(r),
    r.ms,
  )
}

console.log(`\n══════════ 开箱即用报告 ${new Date().toLocaleString('zh-CN')} ══════════`)
console.log(`仓库：${REPO}`)
console.log(`引擎：v${versionInfo().engine} · Node ${process.versions.node}`)
console.log(`模式：${FULL ? '全量（含干净 clone 与容器两路）' : '默认（快、离线）'}\n`)

/* ── E1 空环境 ── */
await smoke('E1 空环境（零项目接入也能装 / 起 / 自检 / 渲染）', 'empty-env-smoke.mjs', '空环境')

/* ── E4 文档自足 ── */
{
  const r = await run(['--test', path.join('tests', 'docs-hygiene.test.mjs')])
  const c = counts(r.out)
  record(
    'E4 文档自足（引用的仓库路径在发布物里 · 链接有效 · 文档地图完整 · 注释引用的文档存在）',
    r.code === 0 ? 'pass' : 'fail',
    r.code === 0 ? `${c ? c.pass : '?'} 条断言通过` : failureLines(r),
    r.ms,
  )
}

/* ── E5 发布物洁净 ── */
{
  const r = await run(['--test', path.join('tests', 'release-artifact.test.mjs')])
  const c = counts(r.out)
  const size = /发布物：([\d]+ 个文件 \/ [\d.]+ MB)/.exec(r.out)
  record(
    'E5 发布物洁净（无运行态 / vendored 有归属 / 无作者家目录）',
    r.code === 0 ? 'pass' : 'fail',
    r.code === 0 ? `${c ? c.pass : '?'} 条断言通过${size ? ` · ${size[1]}` : ''}` : failureLines(r),
    r.ms,
  )
}

/* ── E6 本机状态（拿不到就跳过） ── */
{
  const r = await run(['run', 'doctor', '--', '--json'], { cwd: REPO, file: 'npm' })
  let report = null
  try {
    report = JSON.parse(r.out.slice(r.out.indexOf('{')))
  } catch {
    /* 落到失败分支 */
  }
  record(
    'E6 本机状态：doctor 0 失败项',
    !report ? 'fail' : report.summary.fail === 0 ? 'pass' : 'fail',
    report
      ? `${report.summary.pass} 通过 / ${report.summary.warn} 提醒 / ${report.summary.fail} 失败`
      : failureLines(r),
    r.ms,
  )
}
{
  const t0 = Date.now()
  let ok = false
  try {
    const res = await fetch('http://127.0.0.1:9540/', { signal: AbortSignal.timeout(3000) })
    ok = res.ok
  } catch {
    /* 没起桥 = 跳过 */
  }
  record(
    'E6 本机状态：Console 可达（未起桥时跳过）',
    ok ? 'pass' : 'skip',
    ok ? 'http://127.0.0.1:9540/' : '本机没有在跑的桥',
    Date.now() - t0,
  )
}

/* ── E2 / E3（仅 --full） ── */
if (FULL) {
  await smoke(
    'E2 干净 clone（照 README 两步装起来 + 真起一次桥）',
    'fresh-clone-smoke.mjs',
    '干净 clone',
    {
      timeoutMs: 1800000,
    },
  )
  // 容器这一路**不传 `--full`**：带 --full 的变体会发布 9539/9540，
  // 而本机常驻桥正占着 9540（它会明确拒绝而不是静默降级）。默认模式不发布端口、
  // 可以与在跑的桥并存，验证的正是"容器里能不能装起来、产物齐不齐"。
  await smoke('E3 容器（容器形态的依赖与产物，不占端口）', 'docker-runtime-smoke.mjs', '容器', {
    timeoutMs: 1800000,
  })
} else {
  record('E2 干净 clone', 'skip', '需要网络与数分钟（--full 才跑）', 0)
  record('E3 容器', 'skip', '需要 Docker（--full 才跑）', 0)
}

/* ── 汇总 ── */
const pass = results.filter((r) => r.status === 'pass').length
const fails = results.filter((r) => r.status === 'fail')
const skip = results.filter((r) => r.status === 'skip').length
const totalMs = results.reduce((a, r) => a + (r.ms || 0), 0)

console.log('\n' + '─'.repeat(66))
if (fails.length === 0) {
  console.log(`✔ 开箱即用：${pass} 项通过${skip ? `，${skip} 项跳过` : ''}，0 项失败`)
} else {
  console.log(
    `✖ 开箱即用：${pass} 项通过，**${fails.length} 项失败**${skip ? `，${skip} 项跳过` : ''}`,
  )
  for (const r of fails) console.log(`   ✖ ${r.name} — ${r.evidence}`)
}
console.log(`   耗时约 ${Math.round(totalMs / 1000)}s`)
console.log('─'.repeat(66) + '\n')

process.exit(fails.length === 0 ? 0 : 1)
