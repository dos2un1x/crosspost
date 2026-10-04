#!/usr/bin/env node
/**
 * 干净 clone 冒烟（v2.104）——把"照文档装，能不能装起来"变成一条可复现的命令。
 *
 * 为什么需要它：`empty-env-smoke.mjs` 隔离的是**数据**（`CROSSPOST_LOCAL_ROOT`），
 * 不是**依赖** —— 它在本机这些 `node_modules` 早已装好的仓库里跑，所以 20 项验收全绿的同时，
 * "另一台机器照 README 装"这条路是断的。本脚本在 /tmp 里造出**真的干净 clone**：
 *
 *   1. 用 `git ls-files` 把**当前工作区**的 tracked 文件复制进临时目录
 *      （不是 `git archive HEAD` —— 那样测的是 HEAD，未提交的改动会被漏掉）
 *   2. 按 README 走：`npm install` → `npm run setup`
 *   3. 反向断言（**这是本脚本存在的理由**）：`npm install` 之后、`setup` 之前，
 *      两棵引擎依赖树都不存在 —— 证明"只装根依赖是不够的"
 *   4. `npm run setup` 必须自己把两个子包装齐并把 core 构建出来（exit 0）；
 *      且**不得**再生产 `crosspost-runtime/core/node_modules`（v2.3.1 收敛的回归守卫）
 *   5. `npm run doctor` 必须 0 失败项；隔离端口上真起一次桥并拿到 health
 *
 * 运行：
 *   node crosspost-runtime/tests/fresh-clone-smoke.mjs       # 约 2–6 分钟，需要网络
 *   KEEP=1 node …                                            # 保留沙箱供检查
 *   SKIP_NPM=1 node …                                        # 跳过 npm（调试脚本本身）
 *
 * 不进 `verify:acceptance`：它需要网络与几分钟，而验收必须快且离线可跑。
 * 它属于 CI（`ci.yml` 的 fresh-clone 步骤）与手动复核。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const NODE = process.execPath
const KEEP = !!process.env.KEEP
const SKIP_NPM = !!process.env.SKIP_NPM

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`)
}

const spawnAsync = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => resolve({ code: -1, out, err: String(e.message) }))
    child.on('close', (code) => resolve({ code, out, err }))
  })

const WS_PORT = 26000 + Math.floor(Math.random() * 3000)
const HTTP_PORT = WS_PORT + 1
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-fresh-clone-'))

const env = {
  ...process.env,
  CROSSPOST_LOCAL_ROOT: path.join(sandbox, '.local'),
  CROSSPOST_PATHS: path.join(sandbox, 'crosspost-runtime', 'paths.json'),
  CROSSPOST_CONFIG: path.join(sandbox, 'config.json'),
  CROSSPOST_PROJECTS_DIR: path.join(sandbox, '.local', 'projects'),
  SYNC_PROXY_WS_PORT: String(WS_PORT),
}

let bridge = null

try {
  console.log(`\n干净 clone 冒烟：sandbox=${sandbox}\n端口 WS=${WS_PORT} HTTP=${HTTP_PORT}\n`)

  // ── 1. 复制当前工作区的文件（含**未提交但未忽略**的新文件） ──
  //
  // 用 `--cached --others --exclude-standard` 而不是 `ls-files`：
  // 后者只列已入库的文件，会把"本次新增、还没 commit"的文件漏掉，
  // 于是冒烟测的是一个比工作区更旧的世界（第一次跑就踩到：sandbox 里缺 deps.mjs）。
  const COPY_CMD =
    'git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf - | tar -xf - -C'
  const copy = spawnSync('bash', ['-c', `${COPY_CMD} '${sandbox.replace(/'/g, "'\\''")}'`], {
    cwd: REPO,
    encoding: 'utf8',
  })
  const fileCount = spawnSync(
    'bash',
    ['-c', 'git ls-files --cached --others --exclude-standard | wc -l'],
    { cwd: REPO, encoding: 'utf8' },
  ).stdout.trim()
  check(
    '沙箱就位（工作区文件已复制，不含 .git/node_modules）',
    copy.status === 0 && !fs.existsSync(path.join(sandbox, '.git')),
    `文件数 = ${fileCount}（cached + 未忽略的未跟踪文件）`,
  )
  check(
    '沙箱里没有任何 node_modules（这才是干净 clone）',
    !fs.existsSync(path.join(sandbox, 'node_modules')) &&
      !fs.existsSync(path.join(sandbox, 'bridge', 'node_modules')) &&
      !fs.existsSync(path.join(sandbox, 'crosspost-runtime', 'node_modules')) &&
      !fs.existsSync(path.join(sandbox, 'crosspost-runtime', 'core', 'node_modules')),
  )

  // ── 2. README 第 1 步：npm install（只装根 devDeps） ──
  if (SKIP_NPM) {
    console.log('－ 跳过 npm（SKIP_NPM=1）')
  } else {
    const inst = await spawnAsync('npm', ['install', '--no-audit', '--no-fund'], { cwd: sandbox })
    check(
      'npm install 成功（README 第 1 步）',
      inst.code === 0,
      inst.err.trim().split('\n').at(-1) || '',
    )
  }

  // ── 3. 反向断言：光装根依赖是不够的（缺陷现场） ──
  const sandboxDeps = await import(
    pathToFileURL(path.join(sandbox, 'crosspost-runtime', 'src', 'deps.mjs')).href
  )
  if (!SKIP_NPM) {
    const missingAfterRootInstall = sandboxDeps.missingDeps(sandbox).map((m) => m.id)
    check(
      '反向断言：npm install 之后两个子包依赖仍全缺（v2.104 修的就是这里）',
      missingAfterRootInstall.join(',') === 'runtime,bridge',
      `缺：${missingAfterRootInstall.join('、') || '（无）'}`,
    )
    check(
      '反向断言：npm install 一个引擎依赖树都没建（只装了根 devDeps）',
      !fs.existsSync(path.join(sandbox, 'crosspost-runtime', 'node_modules')) &&
        !fs.existsSync(path.join(sandbox, 'bridge', 'node_modules')),
    )
  }

  // ── 4. README 第 2 步：npm run setup（应自装依赖 + 构建 core） ──
  const setup = await spawnAsync('npm', ['run', 'setup'], { cwd: sandbox, env })
  check(
    'npm run setup 成功（README 第 2 步）',
    setup.code === 0,
    setup.err.trim().split('\n').at(-1) || '',
  )
  check(
    'setup 自己报告装了子包（runtime → bridge）',
    /已安装：runtime → bridge/.test(setup.out) || /已安装：runtime → bridge/.test(setup.err),
    (setup.err.match(/安装子包依赖[^\n]*/) || [''])[0],
  )
  check(
    '两个子包的关键依赖就位',
    sandboxDeps.missingDeps(sandbox).length === 0,
    sandboxDeps
      .missingDeps(sandbox)
      .map((m) => `${m.id}:${m.missing.join('/')}`)
      .join(' ') || 'runtime/bridge 全就绪',
  )
  check(
    'core 已构建（dist 存在）',
    fs.existsSync(path.join(sandbox, 'crosspost-runtime', 'core', 'dist')),
  )
  // v2.3.1 回归守卫：core 的依赖由 runtime 那棵树承载，setup 不该再单独装一份
  // （本机实测那份重复树 196MB；它一旦回来，说明安装逻辑被改回去了）。
  // 判据落在**包**而不是目录：vitest 会在那个路径下建 `.vite` 缓存目录。
  check(
    'setup 之后没有多余的 core 依赖树',
    !fs.existsSync(path.join(sandbox, 'crosspost-runtime', 'core', 'node_modules', 'tsup')) &&
      !fs.existsSync(path.join(sandbox, 'crosspost-runtime', 'core', 'node_modules', 'js-md5')),
  )

  // ── 5. doctor：0 失败项（含新增的 deps-installed 检查） ──
  //
  // 注意：`npm run doctor` 会把 `> crosspost@0.1.0 doctor` 两行**打到 stdout**，
  // 所以从第一个 `{` 开始解析（第一版直接 JSON.parse 整段 → 永远 null，两条断言假红）。
  const doctor = await spawnAsync('npm', ['run', 'doctor', '--', '--json'], { cwd: sandbox, env })
  let report = null
  try {
    report = JSON.parse(doctor.out.slice(doctor.out.indexOf('{')))
  } catch {
    /* 断言会报出 */
  }
  check(
    'doctor 0 失败项',
    !!(report && report.summary.fail === 0),
    report ? JSON.stringify(report.summary) : (doctor.out + doctor.err).slice(0, 200),
  )
  check(
    'doctor 的子包依赖检查为通过',
    !!(report && report.checks.some((c) => c.id === 'deps-installed' && c.severity === 'ok')),
    report ? (report.checks.find((c) => c.id === 'deps-installed') || {}).title : '',
  )

  // ── 5b. 无 git 部署的版本真值（v2.1） ──
  //
  // 沙箱**故意不含 `.git`**（上面第 1 项就断言了这一点），所以 `engineVersion()`
  // 走的是 package.json 回退分支——正是"tarball / 无 git 部署"的真实形态。
  // 回退值一旦不跟着发布走，干净 clone 出来的引擎就会报一个旧版本
  // （v2.0 时它停在 2.107.0，而发布已经是 v2.0——这条漂移不会被任何断言发现，除非有这一项）。
  {
    const versionMod = await import(
      pathToFileURL(path.join(sandbox, 'crosspost-runtime', 'src', 'version.mjs')).href +
        '?t=' +
        Date.now()
    )
    const got = versionMod.versionInfo().engine
    const pkgVersion = JSON.parse(
      fs.readFileSync(path.join(sandbox, 'crosspost-runtime', 'package.json'), 'utf8'),
    ).version
    const tag = spawnSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: REPO,
      encoding: 'utf8',
    }).stdout?.trim()
    const majorMinor = (s) => String(s).replace(/^v/, '').split('.').slice(0, 2).join('.')
    check(
      '沙箱（无 .git）报的版本 = 回退值，且与仓库 tag 同主次版本',
      got === pkgVersion && (!tag || majorMinor(got) === majorMinor(tag)),
      `报 ${got} · package.json ${pkgVersion} · 仓库 tag ${tag || '（无）'}`,
    )
  }

  // ── 6. 真起一次桥（干净 clone 上没有扩展、没有项目，这正是"平台域不依赖项目"） ──
  bridge = spawn(NODE, [path.join(sandbox, 'bridge', 'run-bridge.mjs')], {
    cwd: sandbox,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  bridge.stdout.on('data', (d) => (log += d))
  bridge.stderr.on('data', (d) => (log += d))
  const ready = await new Promise((resolve) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (/通道就绪/.test(log)) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - t0 > 20000) {
        clearInterval(timer)
        resolve(false)
      }
    }, 200)
  })
  check('隔离桥启动就绪（干净 clone 上）', ready, ready ? '' : log.slice(-300))

  if (ready) {
    let token = null
    try {
      const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/proxy/bootstrap`)
      token = r.ok ? (await r.json()).token : null
    } catch {
      /* 断言 */
    }
    const fetchHealth = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/proxy/health`, {
          headers: token ? { 'X-CrossPost-Token': token } : {},
        })
        return r.ok ? await r.json() : null
      } catch {
        return null
      }
    }
    const health = await fetchHealth()
    check('干净 clone 上 health 可用', !!(health && health.ok === true))

    // 四条车道是**预热**出来的（错峰 400ms、各自 ~1.4s），所以要有界等待而不是取一次快照：
    // 第一版没等，于是这条断言在车道还没热起来时假红（实测 detail 打印出了四个 key 却报 false）。
    const LANES = ['reader', 'costs', 'writer', 'heavy']
    const lanes = await new Promise((resolve) => {
      const t0 = Date.now()
      const timer = setInterval(async () => {
        const h = await fetchHealth()
        const allUp = h && h.workers && LANES.every((k) => h.workers[k]?.alive)
        if (allUp || Date.now() - t0 > 15000) {
          clearInterval(timer)
          resolve(h)
        }
      }, 500)
    })
    check(
      '四条常驻 worker 车道都起来了',
      !!(lanes && lanes.workers && LANES.every((k) => lanes.workers[k]?.alive)),
      lanes?.workers
        ? LANES.map((k) => `${k}=${lanes.workers[k]?.alive ? 'alive' : 'down'}`).join(' ')
        : '健康检查拿不到 workers',
    )
  }
} finally {
  if (bridge) {
    bridge.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
  }
  if (KEEP) console.log(`\n沙箱保留：${sandbox}`)
  else fs.rmSync(sandbox, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  ✖ ${f.name} — ${f.detail}`)
}
process.exit(failed.length ? 1 : 0)
