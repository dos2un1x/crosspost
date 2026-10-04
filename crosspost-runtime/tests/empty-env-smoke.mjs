/**
 * 空环境冒烟（2026-09-18，v2.05）——**引擎自治的核心验收**
 *
 * 验收标准（来自 docs/architecture.md）：
 *   「引擎在磁盘上不存在任何写作项目时，能完成安装、启动、诊断与渲染预览。」
 *
 * 本脚本在**临时目录**里从零跑一遍完整生命周期，全程不触碰：
 *   · 主工作区
 *   · 任何接入方项目目录
 *   · 生产端口 9539/9540
 *
 * 步骤：
 *   1. 建临时 sandbox（CROSSPOST_LOCAL_ROOT 指向它）
 *   2. 跑 setup（生成 paths.json/config.json + 数据目录）
 *   3. 跑 doctor（断言 0 失败项）
 *   4. 起隔离桥（随机高端口），断言 /proxy/health 与 /proxy/platform-matrix 可用
 *   5. 跑 renderPreview（断言能渲染出 HTML）
 *   6. 断言 sandbox 之外没有新文件产生
 *
 * 运行：node crosspost-runtime/tests/empty-env-smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
const REPO = path.resolve(RUNTIME, '..')
const NODE = process.execPath

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`)
}

const run = (args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(NODE, args, {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, out, err }))
  })

// 随机高端口，避免与生产/其它沙箱冲突
const WS_PORT = 26000 + Math.floor(Math.random() * 2000)
const HTTP_PORT = WS_PORT + 1

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-empty-env-'))
const localRoot = path.join(sandbox, '.local')
const cfgFile = path.join(sandbox, 'config.json')

const env = {
  CROSSPOST_LOCAL_ROOT: localRoot,
  CROSSPOST_CONFIG: cfgFile,
  CROSSPOST_DRAFTS_DIR: path.join(localRoot, 'drafts'),
  CROSSPOST_LOGS_DIR: path.join(localRoot, 'logs'),
  CROSSPOST_HISTORY_DIR: path.join(localRoot, 'history'),
  CROSSPOST_TOPIC_POOL: path.join(localRoot, 'history', 'topic-pool.json'),
  CROSSPOST_ARTICLES_DIR: path.join(localRoot, 'articles'),
  CROSSPOST_EVER_AUTHED_PATH: path.join(localRoot, 'ever-authed.json'),
  CROSSPOST_PLATFORMS_STATE_PATH: path.join(localRoot, 'platforms-state.json'),
  SYNC_PROXY_WS_PORT: String(WS_PORT),
}

let bridge = null

try {
  console.log(`\n空环境冒烟：sandbox=${sandbox}\n端口 WS=${WS_PORT} HTTP=${HTTP_PORT}\n`)

  // ── 1. 记录基线：sandbox 之外不得产生文件 ──
  const repoArticles = path.join(RUNTIME, 'articles')
  const beforeArticles = fs.existsSync(repoArticles) ? fs.readdirSync(repoArticles).length : 0
  const beforeToken = fs.existsSync(path.join(REPO, 'bridge', 'token.local'))
    ? fs.statSync(path.join(REPO, 'bridge', 'token.local')).mtimeMs
    : null

  // ── 2. setup（幂等初始化） ──
  // 用 CLI handler 而非 cli 脚本，确保走的是同一实现
  const setup = await run([path.join(RUNTIME, 'src', 'cli.mjs'), 'setup'], env)
  let setupOut = null
  try {
    setupOut = JSON.parse(setup.out.trim().split('\n').pop())
  } catch {
    /* 下面断言会报出来 */
  }
  check(
    'setup 成功',
    setup.code === 0 && setupOut && setupOut.ok === true,
    setupOut ? `steps=${setupOut.steps.length}` : setup.err.slice(0, 200),
  )
  check('setup 生成数据目录', fs.existsSync(path.join(localRoot, 'drafts')))
  check(
    'setup 解析出沙箱数据根（未指向任何接入方目录）',
    !!(setupOut && setupOut.localRoot === localRoot),
    setupOut ? setupOut.localRoot : '',
  )

  // ── 3. doctor：0 失败项 ──
  const doctor = await run([path.join(RUNTIME, 'src', 'commands', 'doctor-cli.mjs'), '--json'], {
    ...env,
    // 桥还没起，doctor 会把"桥未运行"记为 warn（不是 fail）
  })
  let report = null
  try {
    report = JSON.parse(doctor.out)
  } catch {
    /* 断言会报出 */
  }
  check(
    'doctor 无失败项（fail=0）',
    !!(report && report.summary.fail === 0),
    report ? JSON.stringify(report.summary) : doctor.err.slice(0, 200),
  )
  // 判据为什么改（v2.6）：原口径是"报告里不得出现 REPO 之外的绝对路径"，
  // 而 `preset-installed` 一项报的是**引擎自己装进 DSH profile 的软链位置**
  // （`~/.dsh/profiles/<profile>/node_modules/preset-crosspost`）——它同样是 REPO 之外的
  // 绝对路径，于是**照 README 装过预设的机器恒红**。假报警会训练人忽略这份自检，
  // 所以换成两段真口径：
  //   ① doctor 的 `projects` 项必须说"未接入"，且扫描根落在沙箱里（沙箱确实是空的）；
  //   ② 报告里不得出现本机**已注册项目**的根目录（那才是"接入方项目依赖"）。
  const hostProjectRoots = (() => {
    const out = []
    const norm = (p) => path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()))
    try {
      const cfgPath = process.env.CROSSPOST_CONFIG || path.join(RUNTIME, 'config.json')
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      for (const d of cfg.projectsDirs || []) if (d) out.push(norm(d))
      for (const p of cfg.projects || []) {
        const root = typeof p === 'string' ? p : p && p.root
        if (root) out.push(norm(root))
      }
    } catch {
      /* 读不到本机配置 = 没有已注册项目，② 自然成立 */
    }
    return [...new Set(out)]
  })()
  const projectsCheck = report && report.checks && report.checks.find((c) => c.id === 'projects')
  const leakedRoot = hostProjectRoots.find((root) => JSON.stringify(report || {}).includes(root))
  check(
    'doctor 未检测到接入方项目依赖',
    !!(
      projectsCheck &&
      String(projectsCheck.title).startsWith('未接入写作项目') &&
      String(projectsCheck.detail || '').includes(sandbox) &&
      !leakedRoot
    ),
    leakedRoot
      ? `报告里出现了本机已注册项目：${leakedRoot}`
      : projectsCheck
        ? `${projectsCheck.title} · ${projectsCheck.detail}`
        : '报告里没有 projects 项',
  )

  // ── 4. 起隔离桥 ──
  bridge = spawn(NODE, [path.join(REPO, 'bridge', 'run-bridge.mjs')], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let bridgeLog = ''
  bridge.stdout.on('data', (d) => (bridgeLog += d))
  bridge.stderr.on('data', (d) => (bridgeLog += d))

  // 等就绪（最多 15s）
  const ready = await new Promise((resolve) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (/通道就绪/.test(bridgeLog)) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - t0 > 15000) {
        clearInterval(timer)
        resolve(false)
      }
    }, 200)
  })
  check('隔离桥启动就绪', ready, ready ? '' : bridgeLog.slice(-300))

  if (ready) {
    const base = `http://127.0.0.1:${HTTP_PORT}`
    // /proxy/bootstrap 免鉴权
    let token = null
    try {
      const r = await fetch(`${base}/proxy/bootstrap`)
      token = r.ok ? (await r.json()).token : null
    } catch {
      /* 下面断言 */
    }
    check('bootstrap 可获取 token', !!token)

    // /proxy/health 需鉴权
    let health = null
    try {
      const r = await fetch(`${base}/proxy/health`, {
        headers: token ? { 'X-CrossPost-Token': token } : {},
      })
      health = r.ok ? await r.json() : null
    } catch {
      /* 下面断言 */
    }
    check('health 可用', !!(health && health.ok === true))

    // 平台能力矩阵
    let matrix = null
    try {
      const r = await fetch(`${base}/proxy/platform-matrix`, {
        headers: token ? { 'X-CrossPost-Token': token } : {},
      })
      matrix = r.ok ? await r.json() : null
    } catch {
      /* 下面断言 */
    }
    check(
      '平台能力矩阵可用',
      !!(matrix && matrix.counts && matrix.counts.all > 0),
      matrix ? JSON.stringify(matrix.counts) : '',
    )

    // 未鉴权必须 401（安全回归）
    let unauth = 0
    try {
      unauth = (await fetch(`${base}/proxy/health`)).status
    } catch {
      /* ignore */
    }
    check('未带 token 访问受保护路由返回 401', unauth === 401, `status=${unauth}`)
  }

  // ── 5. 渲染预览（引擎原生能力，无需任何项目） ──
  // 写一个临时 md 到 sandbox 之外不影响，这里直接用 markdown 参数
  const renderReq = path.join(sandbox, 'render-req.json')
  fs.writeFileSync(
    renderReq,
    JSON.stringify({ markdown: '# 标题\n\n正文 **加粗** 与引用\n\n> 引用一行\n' }),
  )
  const render = await run([path.join(RUNTIME, 'src', 'cli.mjs'), 'renderPreview', renderReq], env)
  let rendered = null
  try {
    rendered = JSON.parse(render.out.trim().split('\n').pop())
  } catch {
    /* 断言 */
  }
  check(
    'renderPreview 可渲染（无需任何项目接入）',
    !!(
      rendered &&
      typeof (rendered.html || rendered.body) === 'string' &&
      (rendered.html || rendered.body).length > 0
    ),
    rendered
      ? `html len=${String(rendered.html || rendered.body).length}`
      : render.err.slice(0, 200),
  )

  // ── 6. 生产数据未被污染 ──
  const afterArticles = fs.existsSync(repoArticles) ? fs.readdirSync(repoArticles).length : 0
  const afterToken = fs.existsSync(path.join(REPO, 'bridge', 'token.local'))
    ? fs.statSync(path.join(REPO, 'bridge', 'token.local')).mtimeMs
    : null
  check(
    '主工作区文章库未被写入',
    afterArticles === beforeArticles,
    `${beforeArticles} → ${afterArticles}`,
  )
  check(
    '主工作区 bridge/token.local 未被改写',
    afterToken === beforeToken,
    `mtime ${beforeToken} → ${afterToken}`,
  )
} finally {
  if (bridge) {
    bridge.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
  }
  fs.rmSync(sandbox, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  ✖ ${f.name} — ${f.detail}`)
}
process.exit(failed.length ? 1 : 0)
