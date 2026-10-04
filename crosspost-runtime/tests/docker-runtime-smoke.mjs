#!/usr/bin/env node
/**
 * Docker 运行形态的可复跑冒烟（默认**不动端口、不动你的数据**）
 *
 * ## 它为什么存在
 *
 * `docker-contract.test.mjs` 只校验**静态契约**（compose 结构、Dockerfile、entrypoint 文本），
 * 它永远不会发现"容器起来了、healthy、Console 也打得开，而引擎已经死了"这一类断点 ——
 * 2026-09-25 就真踩到过一次：`core/dist` 是容器私有卷首次挂载的**空目录**，而当时四处判据
 * 都是"目录在不在"→ 永远不构建 → `import('@crosspost/core')` 直接 ERR_MODULE_NOT_FOUND，
 * CLI worker 全崩，而 `docker compose ps` 显示 **healthy**。
 * 所以这一条跑的是**真容器**，判据落在"引擎能不能干活"上，而不是"容器在不在"。
 *
 * ## 两种模式
 *
 *   node crosspost-runtime/tests/docker-runtime-smoke.mjs
 *       · 不发布端口、用容器内的临时 localRoot → **可以与原生桥/别的容器并存**，随时可跑
 *       · 检查：镜像内容 / entrypoint 负路径 / setup（依赖 + core 四个入口产物）/ doctor / CLI
 *
 *   node crosspost-runtime/tests/docker-runtime-smoke.mjs --full
 *       · 走文档 §2 的原味流程（发布 127.0.0.1:9539/9540）
 *       · **要求这两个端口是空的**（原生桥没停就直接拒绝，而不是静默跳过）
 *       · 额外检查：Console 可达、端口只发环回、扩展来源判定、调度锁由容器桥持有
 *
 * ## 刻意不做的事
 *
 *   · 不接入 `verify:acceptance`（不改变那 21 项的口径）
 *   · 不接入 CI（runner 上要不要拉镜像、花多少分钟是另一个决定）
 * 两者都可以再谈，但先不悄悄加进去。
 *
 * 没装 docker / 守护没起来 → **明确 skip**（打印理由、退出码 0），不假装通过。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const FULL = process.argv.includes('--full')
const KEEP = process.argv.includes('--keep')
const IMAGE = 'crosspost-runtime:local'
const WS_PORT = 9539
const HTTP_PORT = 9540

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok === null ? '·' : ok ? '✔' : '✖'} ${name}${detail ? `  —— ${detail}` : ''}`)
}
const skipAll = (why) => {
  console.log(`· skip：${why}`)
  console.log('  （这一条要真 docker；没装/没起来时它明确跳过，而不是假装通过）')
  process.exit(0)
}

const run = (args, opts = {}) =>
  spawnSync('docker', args, {
    cwd: REPO,
    encoding: 'utf8',
    env: {
      ...process.env,
      CROSSPOST_REPO: REPO,
      HOME: process.env.HOME || os.homedir(),
      ...(opts.env || {}),
    },
    timeout: opts.timeoutMs || 900_000,
  })

// ── 0. docker 可用性 ─────────────────────────────────────────────
if (spawnSync('docker', ['--version'], { encoding: 'utf8' }).status !== 0)
  skipAll('本机没有 docker（容器形态由使用者按 docs/docker.md 验证）')
const info = run(['info'])
if (info.status !== 0)
  skipAll(
    `docker 守护没起来（docker info 失败：${(info.stderr || '').trim().split('\n')[0] || '?'}）`,
  )

console.log(`Docker 运行形态冒烟（${FULL ? '--full：文档原味流程' : '默认：不动端口'}）`)
console.log(`仓库：${REPO}`)
console.log('─'.repeat(72))

// ── 1. 镜像 ─────────────────────────────────────────────────────
{
  const has = run(['image', 'inspect', IMAGE, '--format', '{{.Id}}'])
  if (has.status !== 0) {
    console.log(`· 镜像 ${IMAGE} 不存在 → 先构建（首次要拉基础镜像 + apt，几分钟）`)
    const b = run(['compose', 'build'])
    record('docker compose build', b.status === 0, b.status === 0 ? '' : tail(b.stderr || b.stdout))
  } else {
    record(`镜像 ${IMAGE} 已存在`, true, '（要重建：docker compose build）')
  }
}

// 镜像里**没有仓库**、但该有的运行时都在（Docker⑤ 的动态版本）
{
  const r = run([
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    IMAGE,
    '-c',
    [
      'test ! -e ' + REPO + ' || { echo "镜像里有仓库"; exit 9; }',
      'node -v',
      'command -v curl git gosu crosspost',
    ].join('; '),
  ])
  record(
    '镜像只提供运行时（无仓库代码；node/curl/git/gosu/crosspost 短名齐备）',
    r.status === 0,
    r.status === 0 ? (r.stdout || '').trim().split('\n').join(' · ') : tail(r.stderr),
  )
}

// ── 2. entrypoint 负路径（契约的另一半：错的时候要说人话）────────
{
  const noRepo = run(['run', '--rm', IMAGE])
  record(
    '没给 CROSSPOST_REPO → 退出码 1 + 指路文案',
    noRepo.status === 1 && /未设置 CROSSPOST_REPO/.test(noRepo.stderr + noRepo.stdout),
    `exit=${noRepo.status}`,
  )
  const badRepo = run(['run', '--rm', '-e', 'CROSSPOST_REPO=/tmp', IMAGE])
  record(
    '指向非仓库目录 → 明确报"不是 CrossPost 仓库"',
    badRepo.status === 1 && /不是 CrossPost 仓库/.test(badRepo.stderr + badRepo.stdout),
    `exit=${badRepo.status}`,
  )
}

// ── 3. 端口（--full 才需要；占用时直接拒绝，而不是静默降级）─────
const portTaken = (port) => {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.trim().length > 0
}
if (FULL && (portTaken(WS_PORT) || portTaken(HTTP_PORT))) {
  console.error(
    `✖ --full 需要 ${WS_PORT}/${HTTP_PORT} 空闲：现在被占用（原生桥还没停？）\n` +
      `  先 bridge/install-launchd.sh uninstall（或 docker compose down），再跑。\n` +
      `  不用 --full 的话默认模式不发布端口、可以与它并存。`,
  )
  process.exit(1)
}

// ── 4. 隔离的 localRoot：默认模式绝不碰使用者的 .local ──────────
const SMOKE_LOCAL = `/tmp/crosspost-docker-smoke-${Date.now()}`
const isoEnv = FULL ? {} : { CROSSPOST_LOCAL_ROOT: SMOKE_LOCAL }
const runInCompose = (cmd, extraEnv = {}) => {
  const args = ['compose', 'run', '--rm', '-T']
  for (const [k, v] of Object.entries({ ...isoEnv, ...extraEnv })) args.push('-e', `${k}=${v}`)
  args.push('crosspost', ...cmd)
  return run(args)
}

// setup：依赖 + core 构建（这是"开箱即用"的那一步）
{
  const r = runInCompose(['setup'])
  record(
    'setup 在容器里跑通（依赖 + core 构建）',
    r.status === 0,
    r.status === 0 ? '' : tail(r.stderr || r.stdout),
  )
}

// core 的**四个入口产物**必须都在（判据是产物，不是目录）
{
  const r = runInCompose([
    'sh',
    '-c',
    'cd "$CROSSPOST_REPO/crosspost-runtime" && for f in index.mjs adapters/index.mjs render/index.mjs runtime/index.mjs; do [ -f "core/dist/$f" ] || { echo "缺 core/dist/$f"; exit 9; }; done && node -e "import(\'@crosspost/core/adapters\').then(()=>console.log(\'core OK\')).catch(e=>{console.log(String(e.code||e.message));process.exit(9)})"',
  ])
  record(
    'core 四个入口产物齐备且可加载（容器 healthy 而引擎已死的那类断点）',
    r.status === 0 && /core OK/.test(r.stdout || ''),
    r.status === 0 ? '' : tail(r.stderr || r.stdout),
  )
}

// doctor：只要求 0 失败（桥没跑时的 WARN 是预期的）
{
  const r = runInCompose(['doctor'])
  const out = (r.stdout || '') + (r.stderr || '')
  const m = /✖ (\d+) 失败/.exec(out)
  record(
    '容器内 doctor：0 失败项',
    r.status === 0 && (!m || m[1] === '0'),
    m ? `失败 ${m[1]}` : tail(out),
  )
}

// CLI 分派（doctor/setup/… 走的就是它；exec 那条路另有短名，见 --full）
{
  const r = runInCompose(['cli', 'listArticles'])
  record('CLI 分派可用（cli listArticles）', r.status === 0, r.status === 0 ? '' : tail(r.stderr))
}

// zstd：镜像该带（费用报表解压会话要用）。2026-09-25 加的，别再丢。
{
  const r = runInCompose(['sh', '-c', 'command -v unzstd || { echo "缺 unzstd"; exit 9; }'])
  record('镜像带 unzstd（费用报表解压会话）', r.status === 0, r.status === 0 ? '' : tail(r.stderr))
}

// 飞书 CLI：**没装允许**（webhook 通道的用户会 build-arg 留空跳过），
// 但**装了就必须真的能跑** —— npm 11.19 起默认不跑依赖的 install 脚本，
// 而 @larksuite/cli 正是靠 postinstall 下二进制：结果是"命令在、二进制不在"。
{
  const r = runInCompose([
    'sh',
    '-c',
    'if command -v lark-cli >/dev/null 2>&1; then lark-cli --version; else echo "SKIP: 镜像未装 lark-cli"; fi',
  ])
  const out = (r.stdout || '') + (r.stderr || '')
  const skipped = /SKIP: 镜像未装/.test(out)
  record(
    `飞书 CLI：装了就真能跑${skipped ? '（本镜像未装，跳过）' : ''}`,
    r.status === 0 && (skipped || /lark-cli version/i.test(out)),
    r.status === 0 ? '' : tail(out),
  )
}

// ── 5. --full：文档原味流程（起桥、发布端口）────────────────────
if (FULL) {
  const up = run(['compose', 'up', '-d', '--wait'], { timeoutMs: 600_000 })
  record(
    'docker compose up -d --wait（healthy）',
    up.status === 0,
    up.status === 0 ? '' : tail(up.stderr),
  )

  // Console 可达（宿主侧）
  let consoleOk = false
  for (let i = 0; i < 30 && !consoleOk; i++) {
    const c = spawnSync('curl', ['-fsS', '-o', '/dev/null', `http://127.0.0.1:${HTTP_PORT}/`], {
      encoding: 'utf8',
    })
    consoleOk = c.status === 0
    if (!consoleOk) spawnSync('sleep', ['2'])
  }
  record('Console 可达（http://127.0.0.1:9540/）', consoleOk)

  // 端口只在宿主环回
  const lsof = spawnSync(
    'lsof',
    ['-nP', `-iTCP:${WS_PORT}`, `-iTCP:${HTTP_PORT}`, '-sTCP:LISTEN'],
    {
      encoding: 'utf8',
    },
  )
  const lines = (lsof.stdout || '').trim().split('\n').slice(1).filter(Boolean)
  record(
    '端口只发布到 127.0.0.1（不出局域网）',
    lines.length > 0 && lines.every((l) => /127\.0\.0\.1:(9539|9540)\b/.test(l)),
    lines.map((l) => l.trim().split(/\s+/).slice(-2).join(' ')).join(' / '),
  )

  // 扩展来源判定（扩展来源应通、普通网页来源应被拒）
  {
    const require = createRequire(path.join(REPO, 'bridge', 'package.json'))
    const { WebSocket } = require('ws')
    const attempt = (origin) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`, { origin, handshakeTimeout: 5000 })
        const done = (r) => {
          try {
            ws.close()
          } catch {
            /* ignore */
          }
          resolve(r)
        }
        ws.on('open', () => done('OPEN'))
        ws.on('unexpected-response', (_q, res) => done(`REJECTED(${res.statusCode})`))
        ws.on('error', (e) => done(`ERROR(${(e && e.message) || e})`))
      })
    const a = await attempt('chrome-extension://crosspost-smoke')
    const b = await attempt('http://evil.example')
    record(
      'WS 只认扩展来源（chrome-extension:// 通、网页来源被拒）',
      a === 'OPEN' && !String(b).startsWith('OPEN'),
      `扩展=${a} 网页=${b}`,
    )
  }

  // 调度锁由容器桥持有（走桥自己的接口，lockHeldByUs 是在桥进程内算的）
  {
    const tok = fs.readFileSync(path.join(REPO, 'bridge', 'token.local'), 'utf8').trim()
    const r = spawnSync(
      'curl',
      [
        '-sS',
        '-m',
        '10',
        '-H',
        `X-CrossPost-Token: ${tok}`,
        `http://127.0.0.1:${HTTP_PORT}/proxy/schedule`,
      ],
      { encoding: 'utf8' },
    )
    let st = null
    try {
      st = JSON.parse(r.stdout || '{}')
    } catch {
      /* ignore */
    }
    record(
      '调度锁由容器桥持有（lockHeldByUs）',
      !!st && st.lockHeldByUs === true,
      st ? `lock=${JSON.stringify(st.lock)}` : tail(r.stdout || r.stderr),
    )
  }

  if (!KEEP) {
    const down = run(['compose', 'down'])
    record('收尾：docker compose down', down.status === 0)
  } else {
    record('保留容器运行（--keep）', true)
  }
}

// 清理隔离的 localRoot（只对默认模式有意义；容器内的 /tmp 随容器消失）
if (!FULL) void SMOKE_LOCAL

/* ── 汇总 ── */
const failed = results.filter((r) => !r.ok)
console.log('─'.repeat(72))
if (!failed.length) {
  console.log(`✔ 通过：${results.length} 项`)
  process.exit(0)
}
console.log(`✖ 未通过：${failed.length}/${results.length} 项`)
for (const f of failed) console.log(`   ✖ ${f.name}  —— ${f.detail}`)
process.exit(1)

function tail(s, n = 6) {
  return String(s || '')
    .trim()
    .split('\n')
    .slice(-n)
    .join(' | ')
}
