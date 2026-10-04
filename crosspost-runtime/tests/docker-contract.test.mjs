// Docker 打包契约（v2.3）
//
// ## 为什么这些断言值得写
//
// 容器化最容易出的两类错都不会在"跑起来看看"时暴露：
//   · **端口发错**：`"9539:9539"` 会把本地 API 暴露到局域网（本该只发宿主环回）
//   · **路径不一致**：容器里路径与宿主不同 → paths.json/config.json/manifest 里的
//     绝对路径全部失效，表现为"容器起来了但什么都读不到"
//   · **依赖共用**：把宿主的 node_modules 给 Linux 容器用 → `sharp` 这类原生依赖直接崩
// 所以这里做三件事：用 YAML 解析**结构化**断言 compose、字符串断言 Dockerfile/entrypoint，
// 并在装了 docker 的机器上实跑 `docker compose config -q`（没装就 skip，写明理由）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')

const DOCKERFILE = path.join(REPO, 'Dockerfile')
const COMPOSE = path.join(REPO, 'docker-compose.yml')
const ENTRYPOINT = path.join(REPO, 'docker', 'entrypoint.sh')
const DOCKERIGNORE = path.join(REPO, '.dockerignore')

const read = (f) => fs.readFileSync(f, 'utf8')
const hasDocker = spawnSync('docker', ['--version'], { encoding: 'utf8' }).status === 0

test('Docker①：四个文件都在，且 compose 能被 YAML 解析出结构', () => {
  for (const f of [DOCKERFILE, COMPOSE, ENTRYPOINT, DOCKERIGNORE])
    assert.ok(fs.existsSync(f), `缺少 ${path.relative(REPO, f)}`)
  const compose = parseYaml(read(COMPOSE))
  assert.ok(compose.services && compose.services.crosspost, 'compose 必须有 crosspost 服务')
  assert.ok(compose.volumes, '依赖树要用命名卷（不能与宿主共用 node_modules）')
})

test('Docker②：端口只发布到宿主环回（本地 API 的边界，不能漏到局域网）', () => {
  const c = parseYaml(read(COMPOSE)).services.crosspost
  const ports = c.ports.map(String)
  for (const p of ['127.0.0.1:9539:9539', '127.0.0.1:9540:9540'])
    assert.ok(ports.includes(p), `端口应逐字写成 ${p}（实际：${ports.join(', ')}）`)
  for (const p of ports)
    assert.match(p, /^127\.0\.0\.1:/, `端口 ${p} 必须限定在 127.0.0.1（否则会暴露到局域网）`)
  assert.equal(c.network_mode, undefined, '不使用 host 网络（macOS 上不可用，且会绕过端口发布）')
})

test('Docker③：同路径挂载 + 容器私有依赖卷（绝对路径零改写的前提）', () => {
  const c = parseYaml(read(COMPOSE)).services.crosspost
  const vols = c.volumes.map(String)
  assert.ok(
    vols.includes('${HOME}:${HOME}'),
    'HOME 必须同路径挂载：引擎按绝对路径解析项目/会话/数据目录',
  )
  assert.ok(
    vols.includes('${CROSSPOST_REPO}:${CROSSPOST_REPO}'),
    '仓库必须同路径挂载：paths.json/config.json/manifest 存的是绝对路径',
  )
  for (const tail of [
    'crosspost-runtime/node_modules',
    'bridge/node_modules',
    'crosspost-runtime/core/dist',
  ])
    assert.ok(
      vols.some((v) => v.includes(`:${'${CROSSPOST_REPO}'}/${tail}`)),
      `依赖/构建产物必须用容器私有卷：${tail}（宿主与容器的原生依赖不能共用）`,
    )
  // v2.3.1：core 不再单独装依赖树（它的整图由 crosspost-runtime 那棵承载），
  // 给它再挂一个卷就是多挂一份永远为空的目录 —— 钉住"别再回来"。
  assert.ok(
    !vols.some((v) => v.includes('crosspost-runtime/core/node_modules')),
    'core 不再有自己的依赖树卷（见 src/deps.mjs 文件头）',
  )
})

test('Docker④：运行时该有的东西都在（init/restart/优雅停止/健康检查/宿主网关/时区）', () => {
  const c = parseYaml(read(COMPOSE)).services.crosspost
  assert.equal(c.init, true, '作为 PID 1 要能收信号（否则桥收不到 SIGTERM）')
  assert.equal(c.restart, 'unless-stopped')
  assert.ok(c.stop_grace_period, '要给 stop_grace_period（收 worker 与槽位子进程需要时间）')
  assert.ok(c.healthcheck && c.healthcheck.test, 'healthcheck 必填')
  const probe = JSON.stringify(c.healthcheck.test)
  assert.match(probe, /127\.0\.0\.1:9540\//, '探针打 HTTP 9540')
  assert.ok(
    !/proxy\/health/.test(probe),
    '探针不能用 /proxy/health（那需要 token）——用免鉴权静态页',
  )
  assert.ok(
    (c.extra_hosts || []).some((h) => String(h).includes('host.docker.internal')),
    '要让容器能回连宿主服务（项目侧 generate provider）',
  )
  for (const k of ['CROSSPOST_REPO', 'HOME', 'TZ'])
    assert.ok(c.environment[k] !== undefined, `环境变量 ${k} 必填（${k} 决定路径与调度时区）`)
})

test('Docker⑤：镜像只提供运行时 —— 不 COPY 代码、跳过浏览器下载、带上 tz/git/curl', () => {
  const d = read(DOCKERFILE)
  assert.match(d, /^FROM node:24/m, '基线镜像应钉在 Node 24（三处 engines 都要求 ≥24）')
  assert.ok(
    !/COPY\s+\.\s/.test(d) && !/COPY\s+\.\s+\./.test(d),
    '镜像不得把仓库整包 COPY 进去：代码以同路径挂载为准（否则镜像与仓库会漂移）',
  )
  assert.match(d, /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1/, '默认不装浏览器（缺失时样式采样自动降级）')
  for (const pkg of ['curl', 'git', 'tzdata', 'gosu']) assert.ok(d.includes(pkg), `镜像需要 ${pkg}`)
  assert.match(d, /COPY docker\/entrypoint\.sh/, '入口脚本要进镜像')
  // 2026-09-25：`docker compose exec` 不走 ENTRYPOINT —— 没有这个短名的话，
  // 文档 §6 里的 `docker compose exec crosspost doctor` 会 exit 127（真容器里实测过）。
  assert.match(
    d,
    /ln -s \/usr\/local\/bin\/crosspost-entrypoint \/usr\/local\/bin\/crosspost/,
    '镜像要装 `crosspost` 短名，否则 exec 那条路（体检/调度/CLI）根本没有可执行文件',
  )
})

test('Docker⑤b：可选运行时（zstd / 飞书 CLI）与宿主网关默认值都钉住', () => {
  // 为什么单列：这三样都是"容器里少一个，某个能力就静默降级"的东西，
  // 而它们各自都有过真实的踩坑记录（见各条注释）。钉住，别再悄悄拿掉。
  const d = read(DOCKERFILE)
  // ① zstd：会话文件是 zstd 压缩的，费用报表（token-cost）要解它（2026-09-25 加）
  assert.match(
    d,
    /apt-get install[^\n]*\bzstd\b/,
    '镜像必须装 zstd（否则费用报表在容器里必然降级）',
  )

  // ② 飞书 CLI：始终装最新；但 npm 11.19 起默认不跑依赖的 install 脚本 ——
  //    而 @larksuite/cli 正是靠 postinstall 去下平台二进制的。不放开的话
  //    "包在、命令在、二进制不在"，运行时才炸（真踩过）。
  assert.match(d, /LARK_CLI_VERSION="latest"/, 'lark-cli 默认装最新（可传版本钉住，留空则跳过）')
  assert.match(
    d,
    /allow-scripts=@larksuite\/cli/,
    'npm 11 起必须显式放行 install 脚本，否则平台二进制根本不会下载',
  )
  assert.match(d, /lark-cli --version/, '装完要自证版本（`lark-cli version` 是未知命令）')
  assert.match(d, /test -x [^\n]*bin\/lark-cli/, '还要断言二进制真的落地（防"装上了却不能用"）')

  // ③ 宿主网关：容器里的 127.0.0.1 指向容器自己，compose 默认要把回环重写成它
  const c = parseYaml(read(COMPOSE)).services.crosspost
  assert.match(
    String(c.environment.CROSSPOST_HOST_GATEWAY || ''),
    /host\.docker\.internal/,
    'compose 要默认带上 CROSSPOST_HOST_GATEWAY（项目 manifest 里的宿主端点才连得上）',
  )
  assert.ok(
    (c.extra_hosts || []).some((h) => String(h).includes('host.docker.internal')),
    '网关名要能解析（extra_hosts host-gateway）',
  )
})

test('Docker⑥：构建上下文是白名单（不把 .local/ 与 md-backup/ 送给 daemon）', () => {
  const ig = read(DOCKERIGNORE)
  const lines = ig
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  assert.equal(lines[0], '*', '第一行必须是 *（先全排除）')
  for (const need of ['!Dockerfile', '!docker/'])
    assert.ok(lines.includes(need), `白名单缺少 ${need}`)
})

test('Docker⑦：entrypoint 的契约（校验仓库路径 / 幂等装依赖 / 分派 / 可选降权）', () => {
  const e = read(ENTRYPOINT)
  assert.match(e, /set -euo pipefail/)
  assert.match(e, /CROSSPOST_REPO/, '必须校验 CROSSPOST_REPO')
  assert.match(e, /不是 CrossPost 仓库/, '路径写错时要给出可执行的报错')
  assert.match(e, /setup-cli\.mjs/, '缺依赖时自动跑 setup（幂等）')
  assert.match(e, /gosu/, 'Linux 宿主上按 CROSSPOST_UID/GID 降权')
  // 2026-09-25 实测：分派曾写成 `exec /bin/bash`（不带 "$@"），于是
  // `docker compose run --rm crosspost sh -c 'cmd'` **静默什么都不做**（退出码还是 0）。
  assert.match(e, /exec \/bin\/bash "\$@"/, 'sh 分派必须透传参数（否则 sh -c 静默失效）')
  for (const cmd of ['bridge', 'scheduler', 'doctor'])
    assert.match(e, new RegExp(`\\b${cmd}\\)`), `分派缺少 ${cmd}`)
  assert.ok(!/chown -R[^\n]*\$REPO\s*$/m.test(e), '不得对整棵仓库 chown（那会改写宿主权限）')
})

test('Docker⑦b：依赖判据必须共用 src/deps.mjs，且 core 判"产物"不判"目录"', () => {
  // 2026-09-25 实测踩到的坑（真容器里复现过）：
  //   容器私有卷 `core-dist` 首次挂载是个**空目录**，而 entrypoint 当年在这里手抄了一份
  //   探针，core 那一条写成 `existsSync(core/dist)` —— 目录恒存在 → 永远不构建 →
  //   容器里 `import('@crosspost/core')` 直接 ERR_MODULE_NOT_FOUND，
  //   而 `docker compose ps` 显示 **healthy**、Console 也打得开（桥本体不 import core）。
  // 所以这里有两条护栏：①判据走共享模块（不许再手抄一份）；②不许回到目录判据。
  const e = read(ENTRYPOINT)
  assert.match(e, /deps\.mjs/, '依赖判据必须走 src/deps.mjs（子包依赖判据的唯一事实来源）')
  assert.match(e, /coreBuilt/, 'core 是否构建要走 coreBuilt（产物判据）')
  assert.match(e, /missingDeps/, '子包依赖要走 missingDeps（与 setup / doctor 同一份探针）')
  assert.ok(
    !/existsSync\([^)]*core\/dist/.test(e),
    '别再回到"core/dist 目录在不在"的判据：容器里那是空卷，目录恒存在 → 永不构建',
  )
})

test('Docker⑧：装了 docker 就实跑 compose 校验，没装就明确 skip', (t) => {
  if (!hasDocker) {
    t.skip('本机没有 docker：容器实跑由使用者按 docs/docker.md 执行')
    return
  }
  const r = spawnSync('docker', ['compose', '-f', COMPOSE, 'config', '-q'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, CROSSPOST_REPO: REPO, HOME: process.env.HOME || '/root' },
  })
  assert.equal(r.status, 0, `docker compose config 失败：${r.stderr || r.stdout}`)
})
