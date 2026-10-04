#!/usr/bin/env node
/**
 * 一键初始化命令入口：
 *   node crosspost-runtime/src/commands/setup.mjs [--json] [--no-build] [--no-install] [--start] [--open]
 *   （等价于 npm run setup）
 *
 * 退出码：0 成功；1 失败（Node 版本不足 / 目录不可写 / 依赖安装失败 / core 构建失败）
 *
 * 2026-09-22（v2.104）：`setup` 现在负责**装齐子包依赖**再构建 —— 干净 clone 上
 * `npm install` 只装根 devDeps，core 的构建依赖 `tsup` 与 bridge 的 `ws` 都缺（见 src/deps.mjs）。
 * 2026-09-25（v2.3.1）：core 不再单独装 —— 它的整棵依赖图由 `crosspost-runtime` 那棵树承载
 * （npm 把 `file:./core` 当工作区 hoist），所以这里只剩 `runtime → bridge` 两步。
 */
import { runSetup, buildCore, SETUP_REPO_ROOT } from './setup.mjs'
import { installDeps, manualInstallCommands, coreBuilt } from '../deps.mjs'
import { execFile } from 'node:child_process'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const noBuild = argv.includes('--no-build')
const noInstall = argv.includes('--no-install')
const start = argv.includes('--start')
const open = argv.includes('--open')

const ICON = {
  ok: '✔',
  created: '＋',
  kept: '＝',
  info: '·',
  pending: '…',
  skipped: '－',
  fail: '✖',
}

function printSetup(r) {
  const lines = []
  lines.push('')
  lines.push(`CrossPost 初始化  Node ${process.versions.node}`)
  lines.push('─'.repeat(64))
  for (const s of r.steps) {
    lines.push(`${ICON[s.status] || '·'} ${s.id.padEnd(16)} ${s.detail}`)
    if (s.hint) lines.push(`    ↳ ${s.hint}`)
  }
  lines.push('─'.repeat(64))
  return lines.join('\n')
}

const result = await runSetup({ runBuild: !noBuild, runInstall: !noInstall, start, open })

if (!result.ok) {
  if (json) console.log(JSON.stringify(result, null, 2))
  else process.stderr.write(printSetup(result) + '\n初始化中止。\n')
  process.exit(1)
}

/** 把某条 step 就地替换（保持顺序与打印格式） */
function replaceStep(step) {
  const idx = result.steps.findIndex((s) => s.id === step.id)
  if (idx >= 0) result.steps[idx] = step
}

// 子包依赖：pending 时真的装（core 的构建依赖 tsup 就在 runtime 那棵树里）
const depsStep = result.steps.find((s) => s.id === 'deps-install')
if (depsStep && depsStep.status === 'pending') {
  const ids = depsStep.packages || []
  if (!json) process.stderr.write(`安装子包依赖（${ids.join(' → ')}）…\n`)
  const inst = await installDeps(result.repoRoot, ids, (line) => {
    if (!json) process.stderr.write(line)
  })
  if (inst.ok) {
    replaceStep({
      id: 'deps-install',
      status: 'created',
      detail: `已安装：${ids.join(' → ')}（${inst.results.map((r) => `${r.id} ${Math.round(r.ms / 1000)}s`).join(' · ')}）`,
    })
  } else {
    const last = inst.results[inst.results.length - 1] || {}
    replaceStep({
      id: 'deps-install',
      status: 'fail',
      detail: `${inst.failedAt}：${String(last.error || '安装失败').slice(0, 200)}`,
      hint: `手工安装：${manualInstallCommands().join('；')}`,
    })
    if (json) console.log(JSON.stringify(result, null, 2))
    else
      process.stderr.write(
        printSetup(result) + '\n子包依赖安装失败，请先修复网络/权限后重跑 npm run setup。\n',
      )
    process.exit(1)
  }
}

// core 构建（仅在**产物缺失**时执行，避免每次 setup 都跑一遍）
//
// 这里曾经也判"目录在不在"（2026-09-25 修）：Docker 模式下 core/dist 是容器私有卷，
// 首次挂载是个空目录 → 目录判据为真 → 永远不构建 → 容器里 core 缺失。判据与
// setup.mjs / entrypoint / doctor 统一走 deps.mjs 的 coreBuilt()。
if (!noBuild && !coreBuilt(SETUP_REPO_ROOT)) {
  if (!json) process.stderr.write('构建 @crosspost/core …\n')
  const b = await buildCore(SETUP_REPO_ROOT)
  replaceStep({
    id: 'core-build',
    status: b.ok ? 'created' : 'fail',
    detail: b.ok ? '构建完成' : b.error,
  })
  if (!b.ok) {
    if (json) console.log(JSON.stringify(result, null, 2))
    else
      process.stderr.write(printSetup(result) + '\ncore 构建失败，请先修复后重跑 npm run setup。\n')
    process.exit(1)
  }
}

if (json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  process.stdout.write(printSetup(result) + '\n')
  process.stdout.write(
    [
      '',
      '下一步：',
      '  1) 启动桥（二选一）',
      '       · 前台：node bridge/run-bridge.mjs',
      '       · 守护(macOS)：bridge/install-launchd.sh install',
      '  2) 安装浏览器扩展',
      '       · 打开 chrome://extensions → 开启开发者模式',
      '       · 「加载已解压的扩展程序」→ 选择 bridge/chrome-proxy-extension',
      '  3) 在同一个浏览器里登录你要发布的平台账号',
      '  4) 复查：npm run doctor      打开 Console：http://127.0.0.1:9540/',
      '',
    ].join('\n'),
  )
}

if (open) {
  // 打开扩展安装页（仅 macOS/Linux 桌面；失败不影响 setup 结果）
  execFile('open', ['-a', 'Google Chrome', 'chrome://extensions'], () => {})
}

if (start) {
  const bridge = path.join(SETUP_REPO_ROOT, 'bridge', 'run-bridge.mjs')
  process.stdout.write(`前台启动桥：node ${bridge}\n`)
  const child = execFile(process.execPath, [bridge], { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code || 0))
}
