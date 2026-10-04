/**
 * 「干净 clone 能装起来」的确定性回归（v2.104；v2.3.1 收敛为两棵树）
 *
 * 为什么必须有这个测试：这是一个**只在干净 clone 上出现**的真实断点 ——
 * 根 `package.json` 没有 workspaces，`npm install` 只装根 devDeps；
 * core 的构建依赖 `tsup`、bridge 的运行时依赖 `ws` 分散在子包里且都不入库。
 * 本机这些 `node_modules` 早就装好了，所以 20 项验收全绿的同时，
 * "照 README 装"这条路是断的。**红的环境只有一台干净机器能复现** ——
 * 于是这里用临时骨架把那种环境**做出来**，而不是等它自己出现。
 *
 * 断言的五件事：
 *   ① 判据是**关键依赖**而不是"node_modules 目录存在"（装到一半的树必须被点出来）
 *   ② 缺失时 `runSetup` 给出**可执行**的计划（顺序 runtime→bridge + 手工命令）
 *   ③ `installDeps` 真的按顺序调用 npm（用 PATH 上的 stub 记录调用），失败即停
 *   ④ 安装动作发生在**注入的 repoRoot** 里，真实仓库一个字节都不动
 *   ⑤ `setup.mjs` / `deps.mjs` 只用 node 内置模块 —— 这是"依赖还没装就能装依赖"的前提
 *   ⑥（v2.3.1 防回退）`core` 不再是安装单元，且它的构建探针判在 runtime 那棵树上
 *
 * 假通过检查（见备份 evidence）：把 `setup.mjs` 换回改前版本，本题必然失败
 * （旧实现根本没有 `deps-install` 这一步）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  SUBPACKAGES,
  missingDeps,
  manualInstallCommands,
  installDeps,
  legacyCoreTreeExists,
  coreBuilt,
  coreDistFreshness,
  CORE_DIST_ENTRIES,
} from '../src/deps.mjs'
import { runSetup } from '../src/commands/setup.mjs'
// `pathsPath()`：断言"配置落点真的在沙箱里"。不 import `configPath` —— setup 通过
// `configPath()` 落 config.json，这里只需要钉住 paths 这一侧（config 的隔离由 sha 断言覆盖）。
import { pathsPath } from '../src/paths.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')

/** 临时目录登记，进程退出时统一清理 */
const tmpRoots = []
function tmpdir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cp-${tag}-`))
  tmpRoots.push(d)
  return d
}
process.on('exit', () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true })
})

const sha = (file) =>
  fs.existsSync(file)
    ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    : null

/**
 * 路径/配置的沙箱根 —— **必须在任何 runSetup() 之前**装好。
 *
 * 为什么需要它（2026-10-01 定时 CI 变红的根因）：
 *   `runSetup({ repoRoot: 沙箱 })` 只决定"构建产物装到哪"，而 `paths.json` / `config.json`
 *   的落点走的是 `pathsPath()` / `configPath()` —— 规则是
 *   `CROSSPOST_PATHS || <runtime>/paths.json`，**与注入的 repoRoot 无关**。
 *   于是不设这两个变量时，本文件会把一份由 `defaultPaths(local, sandboxRoot)` 算出来的
 *   **沙箱骨架绝对路径**写进**真实仓库**的 `crosspost-runtime/paths.json`（本机安装物、已 gitignore）。
 *
 *   那些 `cp-deps-skeleton-*` 临时目录在本进程退出时被清掉，仓库里剩下的就是一批
 *   **指向已删除目录的死路径**；随后 `workspace-naming.test.mjs` 会读这份文件并断言
 *   "每个绝对路径都必须真实存在" → 断言失败。临时目录是否已被清掉取决于子进程退出时序，
 *   所以表现为**随机红**（同一份代码本机绿、CI 红）。
 *
 * 指向沙箱之后：写入发生在 `tmpRoots` 里，随其它临时目录一起清理，
 * 仓库那份安装物**字节不变**；下面 `repoPathsBefore` 就是用来钉住这一点的。
 */
const sandbox = tmpdir('setup-env')
const sandboxPaths = path.join(sandbox, 'paths.json')
const sandboxConfig = path.join(sandbox, 'config.json')
process.env.CROSSPOST_PATHS = sandboxPaths
process.env.CROSSPOST_CONFIG = sandboxConfig

/** 仓库自己的 paths.json 基线（在任何写入之前取；null = 本来就不存在） */
const realPathsFile = path.join(RUNTIME, 'paths.json')
const repoPathsBefore = sha(realPathsFile)

/** 造一个"干净 clone 的仓库骨架"：只有 package.json / lock，没有 node_modules */
function skeleton() {
  const root = tmpdir('deps-skeleton')
  for (const pkg of SUBPACKAGES) {
    const dir = path.join(root, pkg.dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg.id }, null, 2))
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }))
  }
  return root
}

/** 造出某个子包的"关键依赖都在"的样子 */
function satisfy(root, id) {
  const pkg = SUBPACKAGES.find((p) => p.id === id)
  for (const probe of pkg.probes) {
    fs.mkdirSync(path.join(root, pkg.dir, 'node_modules', ...probe.split('/')), { recursive: true })
  }
}

test('① 判据是关键依赖，不是 node_modules 目录存在', () => {
  const root = skeleton()

  // 干净骨架：两个子包都缺，顺序即安装顺序
  assert.deepEqual(
    missingDeps(root).map((m) => m.id),
    ['runtime', 'bridge'],
  )
  assert.deepEqual(missingDeps(root)[0].missing, SUBPACKAGES[0].probes)

  // "装到一半"：目录在、包不在 —— 必须仍判缺失
  fs.mkdirSync(path.join(root, 'bridge', 'node_modules'), { recursive: true })
  const still = missingDeps(root).find((m) => m.id === 'bridge')
  assert.ok(still, '只有空目录时 bridge 仍应判缺失')
  assert.deepEqual(still.missing, ['ws'])

  // 包真的在了 → 不再报
  satisfy(root, 'bridge')
  assert.equal(
    missingDeps(root).find((m) => m.id === 'bridge'),
    undefined,
  )

  // 全齐 → 空
  satisfy(root, 'runtime')
  assert.deepEqual(missingDeps(root), [])
})

test('①b（v2.3.1 防回退）core 不再是安装单元，它的构建探针判在 runtime 树上', () => {
  assert.deepEqual(
    SUBPACKAGES.map((p) => p.id),
    ['runtime', 'bridge'],
    'core 的依赖由 crosspost-runtime 那棵树承载（npm 把 file:./core 当工作区 hoist）——不要加回来',
  )
  const runtime = SUBPACKAGES.find((p) => p.id === 'runtime')
  for (const probe of ['tsup', 'js-md5'])
    assert.ok(
      runtime.probes.includes(probe),
      `${probe} 是 core 的构建依赖，探针必须落在 runtime 树上（否则"core 构建不出来"不再被发现）`,
    )
  assert.ok(
    !manualInstallCommands().some((c) => c.includes('crosspost-runtime/core')),
    '手工安装命令里不该再有 core',
  )
})

test('①c 冗余 core 树判据：vitest 的 .vite 缓存不算，真装过才算（防假提醒）', () => {
  const tree = (root) => path.join(root, 'crosspost-runtime', 'core', 'node_modules')

  const empty = tmpdir('deps-legacy-empty')
  assert.equal(legacyCoreTreeExists(empty), false, '目录都不存在 → 没有旧树')

  const cache = tmpdir('deps-legacy-cache')
  fs.mkdirSync(path.join(tree(cache), '.vite'), { recursive: true })
  assert.equal(
    legacyCoreTreeExists(cache),
    false,
    '只有 vitest 缓存 → 不是旧树（否则 4KB 的缓存也会报"可回收 200MB"）',
  )

  const installed = tmpdir('deps-legacy-installed')
  fs.mkdirSync(path.join(tree(installed), 'js-md5'), { recursive: true })
  assert.equal(legacyCoreTreeExists(installed), true, '有 core 的依赖包 → 是旧树')

  const locked = tmpdir('deps-legacy-locked')
  fs.mkdirSync(tree(locked), { recursive: true })
  fs.writeFileSync(path.join(tree(locked), '.package-lock.json'), '{}')
  assert.equal(legacyCoreTreeExists(locked), true, '有 npm 写的 .package-lock.json → 是旧树')
})

test('①d（2026-09-25 防回退）core 构建判据是**产物**，不是"目录在不在"', async () => {
  // 为什么单列这一条：Docker 模式把 crosspost-runtime/core/dist 挂成容器私有卷，
  // 首次挂载的是**空目录**——"目录存在"恒为真，于是 setup / setup-cli / entrypoint /
  // doctor 四处全部以为 core 已构建，容器里 core 永远缺：
  //   import('@crosspost/core') → ERR_MODULE_NOT_FOUND
  // 而容器 healthy、Console 打得开（桥本体不 import core），CLI worker 才炸。
  // 本机（宿主上 dist 早就构建好了）永远复现不出这个断点，所以用空目录把它做出来。
  const root = skeleton()
  const dist = path.join(root, 'crosspost-runtime', 'core', 'dist')

  // ① 空目录（= 容器私有卷首次挂载的样子）→ 必须判"未构建"
  fs.mkdirSync(dist, { recursive: true })
  assert.equal(coreBuilt(root), false, '空 dist 目录不算已构建（这正是 Docker 模式的那个坑）')

  // ② 只构建了一半（入口缺一）→ 仍然算未构建：引擎的某条 import 会炸
  fs.mkdirSync(path.join(dist, 'adapters'), { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.mjs'), '// stub')
  assert.equal(coreBuilt(root), false, '四个入口产物缺一即未构建')

  // ③ 四个入口齐全 → 已构建
  for (const rel of CORE_DIST_ENTRIES.slice(1)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), '// stub')
  }
  assert.equal(coreBuilt(root), true)

  // ④ 判据必须与 core/package.json 的 exports 对得上（漂了就等于没判）
  const corePkg = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'core', 'package.json'), 'utf8'))
  const exported = Object.values(corePkg.exports).map((v) =>
    path.join('crosspost-runtime', 'core', v.import.replace(/^\.\//, '')),
  )
  assert.deepEqual(
    [...CORE_DIST_ENTRIES].sort(),
    [...exported].sort(),
    'CORE_DIST_ENTRIES 必须等于 core/package.json 里 exports 指向的产物',
  )

  // ⑤ setup 的 core-build 步骤：空目录 → pending（会去构建），而不是 kept
  const prev = process.env.CROSSPOST_LOCAL_ROOT
  process.env.CROSSPOST_LOCAL_ROOT = path.join(root, '.local')
  try {
    fs.rmSync(dist, { recursive: true, force: true })
    fs.mkdirSync(dist, { recursive: true })
    const plan = await runSetup({ repoRoot: root, runInstall: false })
    assert.equal(
      plan.steps.find((s) => s.id === 'core-build').status,
      'pending',
      '空 dist 目录必须让 setup 报 pending（旧实现报 kept，于是永不构建）',
    )
    for (const rel of CORE_DIST_ENTRIES) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), '// stub')
    }
    const plan2 = await runSetup({ repoRoot: root, runInstall: false })
    assert.equal(plan2.steps.find((s) => s.id === 'core-build').status, 'kept')
  } finally {
    if (prev === undefined) delete process.env.CROSSPOST_LOCAL_ROOT
    else process.env.CROSSPOST_LOCAL_ROOT = prev
  }
})

test('①e core 产物**比源码旧**也要判得出来（"在不在"问不出这件事）', async () => {
  // 为什么单列这一条：容器里 core/dist 是**私有卷**，`docker compose restart` 只重启进程、
  // 不重建产物。四个产物都在，`coreBuilt` 恒为 true —— 引擎于是跑着几天前编译出来的适配器，
  // 报出来的错误文案与仓库代码对不上（2026-09-29 smzdm 事故就是被这条带偏的）。
  const root = skeleton()
  const distEntry = path.join(root, CORE_DIST_ENTRIES[0])
  const srcDir = path.join(root, 'crosspost-runtime', 'core', 'src', 'adapters')
  const srcFile = path.join(srcDir, 'smzdm.ts')

  // ① 产物不在 → 判不出来（null）。调用方据此跳过，别把"读不到"当成陈旧。
  assert.equal(coreDistFreshness(root), null, '产物缺失时不给结论')

  fs.mkdirSync(path.dirname(distEntry), { recursive: true })
  fs.writeFileSync(distEntry, '// stub')

  // ② 源码树读不到 → 同样不给结论
  assert.equal(coreDistFreshness(root), null, '源码树不存在时不给结论')

  fs.mkdirSync(srcDir, { recursive: true })
  fs.writeFileSync(srcFile, '// stub')

  // ③ 源码比产物新（= 私有卷停在旧构建那个场景）→ 必须判陈旧
  const old = new Date('2026-01-01T00:00:00Z')
  const recent = new Date('2026-06-01T00:00:00Z')
  fs.utimesSync(distEntry, old, old)
  fs.utimesSync(srcFile, recent, recent)
  const stale = coreDistFreshness(root)
  assert.equal(stale.stale, true, '源码更新即为陈旧')
  assert.ok(stale.behindMs > 0, '落后时长要能算出来（doctor 用它写提醒）')

  // ④ 刚构建过（产物更新）→ 不算陈旧
  fs.utimesSync(distEntry, recent, recent)
  assert.equal(coreDistFreshness(root).stale, false)
})

test('② 缺依赖时 runSetup 给出可执行计划，且不碰真实仓库', async () => {
  const root = skeleton()
  const sandboxLocal = path.join(root, '.local')
  const pathsFile = path.join(root, 'crosspost-runtime', 'paths.json')
  const prevEnv = {
    CROSSPOST_LOCAL_ROOT: process.env.CROSSPOST_LOCAL_ROOT,
    CROSSPOST_PATHS: process.env.CROSSPOST_PATHS,
    CROSSPOST_CONFIG: process.env.CROSSPOST_CONFIG,
  }
  process.env.CROSSPOST_LOCAL_ROOT = sandboxLocal
  process.env.CROSSPOST_PATHS = pathsFile
  process.env.CROSSPOST_CONFIG = path.join(root, 'config.json')

  // 真实仓库的两个配置文件：调用前后必须逐字节不变
  const realPaths = realPathsFile
  const realConfig = path.join(RUNTIME, 'config.json')
  const before = { paths: repoPathsBefore, config: sha(realConfig) }

  try {
    const plan = await runSetup({ repoRoot: root, start: false, open: false })
    const step = plan.steps.find((s) => s.id === 'deps-install')
    assert.ok(step, 'runSetup 必须产出 deps-install 步骤（旧实现没有它）')
    assert.equal(step.status, 'pending')
    assert.deepEqual(step.packages, ['runtime', 'bridge'], '安装顺序必须是 runtime → bridge')
    for (const cmd of manualInstallCommands()) {
      assert.ok(step.hint.includes(cmd), `hint 里应能照抄到：${cmd}`)
    }

    // 跳过安装时给出同一个手工命令，且状态是 skipped 而不是 pending
    const plan2 = await runSetup({ repoRoot: root, runInstall: false })
    const step2 = plan2.steps.find((s) => s.id === 'deps-install')
    assert.equal(step2.status, 'skipped')
    assert.ok(step2.hint.includes(manualInstallCommands()[0]))

    // 依赖齐全时是 kept（幂等：不重复安装）
    satisfy(root, 'runtime')
    satisfy(root, 'bridge')
    const plan3 = await runSetup({ repoRoot: root })
    assert.equal(plan3.steps.find((s) => s.id === 'deps-install').status, 'kept')

    // 真实仓库一个字节都没动 —— 两条都要判：
    //   a) 内容哈希等于**调用前**的基线（`before` 必须来自模块级基线，不能在调用后现取，
    //      否则"新建了一个"这种情况会拿建好的文件与自己比，永远相等 = 假通过）
    //   b) 本来不存在的话，现在也必须仍然不存在（新建即污染，必须判红）
    if (repoPathsBefore === null) {
      assert.equal(fs.existsSync(realPaths), false, `测试不该在仓库里新建 ${realPaths}`)
    } else {
      assert.equal(sha(realPaths), before.paths, '真实 paths.json 不该被改写')
    }
    assert.equal(sha(realConfig), before.config, '真实 config.json 不该被改写')
    // 而注入的仓库里确实生成了配置
    assert.equal(pathsPath(), pathsFile, 'pathsPath() 必须落在沙箱里（否则这一条测的是生产文件）')
    assert.ok(fs.existsSync(pathsFile), '注入的 repoRoot 里应生成 paths.json')
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('②b 本文件全程不得污染仓库的 paths.json（安装物属主是使用者，不是测试）', () => {
  // 与「②」的分工：「②」钉的是"那三次调用的前后不变"，这一条钉的是"**整个文件**跑完后的净效果"——
  // 以后有人再加一个 runSetup 调用点却忘了把 CROSSPOST_PATHS 指到沙箱，这里会红。
  // 它就是 2026-10-01 定时 CI 变红那件事的防回归断言。
  assert.equal(
    sha(realPathsFile),
    repoPathsBefore,
    `本文件把 ${realPathsFile} 改动了（应为 ${repoPathsBefore === null ? '仍不存在' : '字节不变'}）。` +
      '原因几乎总是：新增的 runSetup() 调用点没有把 CROSSPOST_PATHS 指向沙箱 —— ' +
      'pathsPath() 是 `CROSSPOST_PATHS || <runtime>/paths.json`，与注入的 repoRoot 无关。',
  )
})

test('③ installDeps 按顺序真的调用 npm，失败即停', async (t) => {
  if (process.platform === 'win32') {
    t.skip('stub 用 sh 脚本，Windows 上不适用（引擎目前只承诺 macOS）')
    return
  }
  const root = skeleton()
  const stubDir = path.join(root, 'stub-bin')
  const log = path.join(root, 'npm-calls.log')
  fs.mkdirSync(stubDir, { recursive: true })

  // ✓ 顺序：所有子包都成功
  fs.writeFileSync(path.join(stubDir, 'npm'), `#!/bin/sh\necho "$PWD|$1" >> "${log}"\nexit 0\n`, {
    mode: 0o755,
  })
  const prevPath = process.env.PATH
  process.env.PATH = `${stubDir}:${prevPath}`
  try {
    const ok = await installDeps(root, ['runtime', 'bridge'])
    assert.equal(ok.ok, true)
    assert.deepEqual(
      ok.results.map((r) => r.id),
      ['runtime', 'bridge'],
    )
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(calls.length, 2)
    // 注意：macOS 上 os.tmpdir() 是 /var/… 的软链，shell 打印的 PWD 是 /private/var/… —— 两边都取 realpath
    const realRoot = fs.realpathSync(root)
    assert.deepEqual(
      calls.map((l) => path.relative(realRoot, l.split('|')[0])),
      ['crosspost-runtime', 'bridge'],
      '调用顺序与工作目录都必须对',
    )
    assert.ok(
      calls.every((l) => l.split('|')[1] === 'ci'),
      '有 package-lock.json 时必须用 npm ci（可复现）',
    )

    // ✗ 失败即停：runtime 失败后不再碰 bridge
    fs.rmSync(log)
    fs.writeFileSync(
      path.join(stubDir, 'npm'),
      `#!/bin/sh\necho "$PWD|$1" >> "${log}"\ncase "$PWD" in *crosspost-runtime) exit 1;; esac\nexit 0\n`,
      { mode: 0o755 },
    )
    const bad = await installDeps(root, ['runtime', 'bridge'])
    assert.equal(bad.ok, false)
    assert.equal(bad.failedAt, 'runtime')
    assert.deepEqual(
      bad.results.map((r) => r.id),
      ['runtime'],
    )
    assert.equal(
      fs.readFileSync(log, 'utf8').trim().split('\n').length,
      1,
      '失败后不应继续装 bridge',
    )
  } finally {
    process.env.PATH = prevPath
  }
})

test('④ setup / deps 只用 node 内置模块（依赖还没装就能跑）', () => {
  for (const rel of ['src/deps.mjs', 'src/commands/setup.mjs', 'src/commands/setup-cli.mjs']) {
    const src = fs.readFileSync(path.join(RUNTIME, rel), 'utf8')
    const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    assert.ok(specs.length > 0, `${rel} 应有 import`)
    for (const s of specs) {
      assert.ok(
        s.startsWith('node:') || s.startsWith('.'),
        `${rel} 引入了非内置模块 ${s} —— 那时依赖还没装，setup 就跑不起来`,
      )
    }
  }
})
