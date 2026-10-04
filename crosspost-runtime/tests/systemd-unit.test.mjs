/**
 * systemd 用户单元安装脚本的契约测试（v2.110）
 *
 * 为什么值得测：`bridge/install-systemd.sh` 是"非 macOS 开箱即用"这条线的第 2 步，
 * 而它与 launchd 版**共用** node 解析与 PATH 渲染（`bridge/scripts/resolve-node.sh`）——
 * 共用是刻意的（v2.37 的教训：写死 node 路径与缺 PATH 这两类缺陷只在别人机器上暴露，
 * 两份实现必然只修一边），但共用之后**两个安装器都得有断言**，否则"只测了 macOS 那份"
 * 会让人误以为 systemd 那份也是对的。
 *
 * 本测试全程只跑 `print`（不写文件、不调 systemctl），并把 HOME 指到临时目录：
 * 与 launchd 版同一套纪律 —— 测试不能碰使用者的真实用户单元目录。
 *
 * 平台无关：`print` 在 macOS / Linux 上都必须能生成单元（CI 在 ubuntu 上跑它，
 * 开发机在 macOS 上跑它），只有 install/status/uninstall 才需要 systemctl。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(REPO, 'bridge', 'install-systemd.sh')

const tmproot = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-systemd-'))
process.on('exit', () => fs.rmSync(tmproot, { recursive: true, force: true }))

function mkHome(tag) {
  const home = path.join(tmproot, `home-${tag}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(home, { recursive: true })
  return home
}

/** 跑 `print`，返回 { stdout, stderr, status, home }（HOME 指向临时目录，绝不碰真实用户单元） */
function runPrint(port = '9539', env = {}) {
  const home = mkHome('print')
  const r = spawnSync('/bin/bash', [SCRIPT, 'print', port], {
    cwd: REPO,
    encoding: 'utf8',
    env: { HOME: home, PATH: process.env.PATH || '/usr/bin:/bin', ...env },
  })
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, home }
}

const unitValue = (unit, key) => {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(unit)
  return m ? m[1] : null
}

test('print 可用，且单元结构完整（ExecStart/工作目录/重启/安装目标）', () => {
  const { stdout, status, stderr } = runPrint()
  assert.equal(status, 0, `print 应成功退出：${stderr}`)
  for (const section of ['[Unit]', '[Service]', '[Install]']) {
    assert.ok(stdout.includes(section), `单元缺少 ${section}`)
  }
  assert.equal(unitValue(stdout, 'Type'), 'simple')
  assert.equal(unitValue(stdout, 'WorkingDirectory'), REPO, 'WorkingDirectory 应是仓库根')
  assert.equal(unitValue(stdout, 'Restart'), 'always', '崩溃必须自动重启')
  assert.equal(unitValue(stdout, 'WantedBy'), 'default.target', '用户单元要挂到 default.target')

  // ExecStart 必须是 `<node> <仓库>/bridge/run-bridge.mjs`
  const exec = unitValue(stdout, 'ExecStart')
  assert.ok(exec, '单元缺少 ExecStart')
  const parts = exec.split(' ')
  assert.equal(parts.length, 2, `ExecStart 应是 "node 脚本" 两段：${exec}`)
  assert.equal(parts[1], path.join(REPO, 'bridge', 'run-bridge.mjs'))
  assert.ok(path.isAbsolute(parts[0]), `node 路径应是绝对路径：${parts[0]}`)
  assert.ok(fs.existsSync(parts[0]), `node 路径必须真实存在：${parts[0]}`)

  // 结构健全性：合法的 INI 形状（键名非空、除 systemd 允许重复的指令外段内键不重复）。
  // 这是 `systemd-analyze verify`（CI 里跑）之前的本地防线：渲染模板改了缩进或拼错键名时，
  // 不能让"生成成功"假装成"单元可用"。
  // `Environment` 是 systemd **允许多次出现**的指令（多个赋值累加），所以它不参与"键唯一"判定。
  const REPEATABLE = new Set(['Environment'])
  const sections = new Map()
  let cur = null
  for (const line of stdout.split('\n')) {
    if (/^\[.+\]$/.test(line)) {
      cur = line
      assert.ok(!sections.has(cur), `段重复：${cur}`)
      sections.set(cur, new Set())
      continue
    }
    if (!line || line.startsWith('#')) continue
    assert.ok(cur, `键出现在任何段之前：${line}`)
    const eq = line.indexOf('=')
    assert.ok(eq > 0, `不是合法的 key=value：${line}`)
    const key = line.slice(0, eq)
    if (!REPEATABLE.has(key)) {
      assert.ok(!sections.get(cur).has(key), `段 ${cur} 内键重复：${key}`)
    }
    sections.get(cur).add(key)
  }
  assert.deepEqual([...sections.keys()], ['[Unit]', '[Service]', '[Install]'])
  assert.equal(
    stdout.split('\n').filter((l) => l.startsWith('Environment=')).length,
    2,
    '应有两条 Environment=（端口 + PATH）',
  )
})

test('端口写进 Environment，且非数字端口必须被挡住（否则单元会被 systemd 拒载）', () => {
  const a = runPrint('9600')
  assert.equal(unitValue(a.stdout, 'Environment'), 'SYNC_PROXY_WS_PORT=9600')
  const b = runPrint('abc')
  assert.notEqual(b.status, 0, '非数字端口必须非零退出')
  assert.match(`${b.stderr}${b.stdout}`, /端口必须是数字/)
})

test('守护进程 PATH：node 目录在首位、无重复段、含系统默认目录', () => {
  const { stdout } = runPrint()
  // 单元里有两行 Environment=，PATH 是第二行
  const lines = stdout.split('\n').filter((l) => l.startsWith('Environment=PATH='))
  assert.equal(lines.length, 1, '必须恰好一行 Environment=PATH=')
  const p = lines[0].slice('Environment=PATH='.length)
  const parts = p.split(':')
  assert.deepEqual(parts, [...new Set(parts)], 'PATH 不应有重复段（单元是给人看与排查的）')
  const nodeDir = path.dirname(unitValue(stdout, 'ExecStart').split(' ')[0])
  assert.equal(parts[0], nodeDir, 'node 所在目录应在 PATH 首位')
  for (const need of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    assert.ok(parts.includes(need), `PATH 应含系统默认目录 ${need}`)
  }
})

test('解析不到 node 时 print 明确失败（且给出 CROSSPOST_NODE 修法）', () => {
  const home = mkHome('fail')
  const r = spawnSync('/bin/bash', [SCRIPT, 'print', '9539'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { HOME: home, PATH: '/nonexistent-bin', CROSSPOST_NODE: '/nonexistent/node' },
  })
  assert.notEqual(r.status, 0, '找不到 node 时必须非零退出，而不是生成一个跑不起来的单元')
  assert.match(`${r.stderr}${r.stdout}`, /找不到.*node|CROSSPOST_NODE/)
  assert.equal(
    fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'crosspost-bridge.service')),
    false,
    '失败时不该留下半成品单元',
  )
})

test('平台闸的边界：print 只生成、不碰系统；install/status/uninstall 必须先过 require_linux', () => {
  // 为什么用源码断言：非 Linux 平台闸没法在测试里模拟（`$OSTYPE` 由 bash 自己设置，
  // 环境变量传不进去），而"误删闸门"或"把闸门挪进 print"都是真实风险：
  //   · 误删闸门 → Linux 之外的用户拿到一条 command-not-found，而不是指路信息；
  //   · 闸门挪进 print → CI（ubuntu）与开发机（macOS）都无法生成/校验单元。
  const src = fs.readFileSync(SCRIPT, 'utf8')

  const branchBody = (label) => {
    const i = src.indexOf(`\n  ${label}`)
    assert.ok(i > 0, `找不到子命令分支 ${label}`)
    return src.slice(i, src.indexOf('\n    ;;', i))
  }

  const printBody = branchBody('print | --print-unit)')
  assert.doesNotMatch(printBody, /require_linux/, 'print 不该要求 Linux/systemd')
  assert.doesNotMatch(
    printBody,
    /systemctl/,
    'print 不该调用 systemctl（CI 与 macOS 都要能生成单元）',
  )

  for (const cmd of ['install)', 'status)', 'uninstall)']) {
    const body = branchBody(cmd)
    assert.match(body, /require_linux/, `${cmd} 分支必须先调 require_linux`)
  }
  assert.match(src, /macOS 用 bridge\/install-launchd\.sh/, '错误信息要指到 macOS 的对应脚本')
})
