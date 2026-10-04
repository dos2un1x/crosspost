/**
 * 子包依赖的**唯一事实来源**（v2.104；v2.3.1 收敛为两棵树）——`setup` 安装、`doctor` 检查、
 * 干净 clone 冒烟共用一套判据。
 *
 * 为什么需要这个文件（这是一条真实存在的"开箱即用"断点）：
 *   根 `package.json` **没有 workspaces**，`npm install` 只装根 devDeps（eslint/prettier/typescript）；
 *   真实依赖在两个子包（`crosspost-runtime` / `bridge`），而它们的 `node_modules` 与
 *   `crosspost-runtime/core/dist` 都在 `.gitignore` 里（不入库）。
 *   于是"干净 clone 照 README 的三步走"会在两处失败：
 *     · `npm run setup` 的 core 构建缺 `tsup`（core 的构建依赖）
 *     · `node bridge/run-bridge.mjs` 缺 `ws`（run-bridge.mjs 顶部 require('ws')）
 *   本机看不出来，只是因为这台机器上这些 `node_modules` 早就装好了 ——
 *   连"空环境冒烟"也看不出来：它隔离的是**数据**（CROSSPOST_LOCAL_ROOT），不是**依赖**。
 *
 * 判据的取舍：**"关键依赖能否存在"而不是"node_modules 目录在不在"**。
 * 装到一半的目录是存在的，但用起来就炸；那种环境更应该被点出来，而不是被放行。
 *
 * ── 为什么 `crosspost-runtime/core` 不在这里（v2.3.1）────────────────────────────
 * `crosspost-runtime/package.json` 用 `"@crosspost/core": "file:./core"`，而 npm 把这种
 * **目录链接当工作区**处理：core 的整棵依赖图（含它自己的 devDeps）会被 hoist 进
 * `crosspost-runtime/node_modules`。三条实测依据（2026-09-25）：
 *   ① `crosspost-runtime/package-lock.json` 只声明 6 条顶层依赖，却有 450 条 —— 含 core 全部
 *      12 个依赖与 `tsup`/`vitest`/`typescript`/`@vitest/coverage-v8`；用
 *      `npm install --package-lock-only` 从 manifest 重推，结果一致。
 *   ② 只复制 runtime+core 的 manifest 与源码到临时沙箱（**core 不带自己的 node_modules**）：
 *      `npm ci` 后父树 221MB / 295 个顶层包，core 的依赖与 devDeps 全在；
 *      `npm -C crosspost-runtime/core run build` 用**祖先 `.bin` 里的 tsup** 成功产出 dist。
 *   ③ npm 会把**所有祖先** `node_modules/.bin` 注入脚本 PATH —— 所以 core 的三条脚本
 *      （build/typecheck/test）都不需要自己那棵树。
 * 所以 core 单独那份 `node_modules`（本机实测 196MB，229 个顶层包与父树同名同版本）是**纯重复**。
 * 别再加回来：`doctor` 会在它复现时给一条 warn，`fresh-clone-smoke` 会在 setup 之后断言它不存在。
 *
 * 本模块**只用 node 内置模块**（与 `setup.mjs` 同一条约束）：它必须在
 * "依赖一个都还没装"的时候就能跑起来，否则安装动作本身无处安放。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * 两个子包，以及各自的**关键依赖**探针。
 *
 * `runtime` 的探针里带上 core 的构建依赖（`tsup`/`js-md5`）：core 的依赖就装在 runtime 树里
 * （见文件头 ①-③），于是"core 构建不出来"这条判据仍然被覆盖，只是判在 runtime 树上。
 *
 * 探针只挑"缺了立刻炸"的那几个，不是把 dependencies 全列一遍 ——
 * 后者会随版本漂移，且没有必要：一个装了一半的树，第一个缺的包已经足够暴露问题。
 */
export const SUBPACKAGES = [
  {
    id: 'runtime',
    label: 'crosspost-runtime（引擎运行时 + core 构建依赖）',
    dir: 'crosspost-runtime',
    probes: ['jsdom', 'ws', '@crosspost/core', 'tsup', 'js-md5'],
  },
  {
    id: 'bridge',
    label: 'bridge（桥自身的运行时依赖）',
    dir: 'bridge',
    probes: ['ws'],
  },
]

/** 旧版（≤ v2.3）单独安装的 core 依赖树：v2.3.1 起不再安装，`doctor` 用它检出冗余树 */
export const LEGACY_CORE_TREE = 'crosspost-runtime/core/node_modules'

/**
 * core 的**构建产物入口**——就是 `core/package.json` 的 `exports` 指向的那四个文件。
 *
 * 为什么用"产物"而不是"目录"当判据（2026-09-25，Docker 模式实测踩到）：
 * compose 把 `crosspost-runtime/core/dist` 挂成**容器私有命名卷**（Docker③ 的意图是让容器
 * 自己构建，不复用宿主的产物）。首次挂载时那个卷是**空的**，但挂载点目录**存在**——
 * 于是 entrypoint 的依赖探针、setup 的 core-build 判据（两处 `fs.existsSync(distDir)`）
 * 全部通过，`setup` 跳过构建，容器里 `core/dist` 永远是空的：
 *   `import('@crosspost/core')` → ERR_MODULE_NOT_FOUND（adapters/index.mjs 找不到）
 * 而**容器仍然 healthy、Console 打得开**（桥本体不 import core）——CLI worker 才炸。
 * 这正是"体检全绿但引擎已死"的一类假通过。
 *
 * 本模块是子包依赖判据的**唯一事实来源**：entrypoint / setup / setup-cli / doctor 四处
 * 共用它，避免再出现"一处改了、另一处还是目录判据"的漂移。
 */
export const CORE_DIST_ENTRIES = [
  'crosspost-runtime/core/dist/index.mjs',
  'crosspost-runtime/core/dist/adapters/index.mjs',
  'crosspost-runtime/core/dist/render/index.mjs',
  'crosspost-runtime/core/dist/runtime/index.mjs',
]

/**
 * core **是否真的构建好了**：四个入口产物**全部**存在才算（缺一个 = 引擎某条 import 会炸）。
 * 目录存在但为空（容器私有卷的首次挂载）→ `false`，于是 setup 会去构建。
 */
export function coreBuilt(repoRoot) {
  return CORE_DIST_ENTRIES.every((rel) => fs.existsSync(path.join(repoRoot, rel)))
}

/** 递归取一棵目录树里的最新 mtime（毫秒）；目录不存在返回 0 */
function newestMtimeMs(dir, filter) {
  let newest = 0
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        walk(p)
      } else if (filter(e.name)) {
        try {
          const m = fs.statSync(p).mtimeMs
          if (m > newest) newest = m
        } catch {
          /* 读不到就跳过 */
        }
      }
    }
  }
  walk(dir)
  return newest
}

/**
 * core 产物**是不是比源码旧**（2026-09-29 事故：扩展侧一行读错字段，而容器里 `core/dist`
 * 是**私有卷**、停在 4 天前——`docker compose restart` 只重启进程、不重建产物，
 * 于是引擎里跑的是改写前的适配器，报出来的错误文案与仓库代码对不上，排查被带去看 WAF）。
 *
 * 判据只用 mtime，不猜内容：`core/dist/index.mjs` 早于 `core/src` 里最新一个 `.ts`
 * 就要报出来。**不判 fail**（源码改了还没构建是常见中间态），由调用方决定措辞。
 *
 * 返回 `null` 表示"无法判定"（产物不在或源码树读不到）——调用方据此跳过，别把读不到当陈旧。
 */
export function coreDistFreshness(repoRoot) {
  const distEntry = path.join(repoRoot, CORE_DIST_ENTRIES[0])
  let distMs = 0
  try {
    distMs = fs.statSync(distEntry).mtimeMs
  } catch {
    return null
  }
  const srcMs = newestMtimeMs(path.join(repoRoot, 'crosspost-runtime/core/src'), (n) =>
    n.endsWith('.ts'),
  )
  if (!srcMs) return null
  return { distMs, srcMs, stale: srcMs > distMs, behindMs: Math.max(0, srcMs - distMs) }
}

/** 旧树里"装过东西"的判据：npm 的包目录或它写的 `.package-lock.json` */
const LEGACY_CORE_PROBES = ['js-md5', 'tsup', 'mathjax-full']

/**
 * 旧版那份 core 依赖树**是不是真的还在**（不是"目录在不在"）。
 *
 * 为什么不能只看目录：`vitest` 会在 `crosspost-runtime/core/node_modules/.vite` 下建缓存目录，
 * 于是"删掉旧树"之后那个 `node_modules` 还会自己长回来 —— v2.3.1 实测踩到：跑完
 * `npm run check`（core 的 vitest）之后，验收里的 doctor 立刻多出一条"可回收 200MB"的
 * 假提醒，而实际只有 4KB 的缓存。判据必须落在"装过依赖"这件事上。
 */
export function legacyCoreTreeExists(repoRoot) {
  const tree = path.join(repoRoot, LEGACY_CORE_TREE)
  if (!fs.existsSync(tree)) return false
  if (fs.existsSync(path.join(tree, '.package-lock.json'))) return true
  return LEGACY_CORE_PROBES.some((p) => fs.existsSync(path.join(tree, p)))
}

/** npm 可执行名（Windows 上是 npm.cmd；引擎目前只承诺 macOS，但这条路不该再多一个坑） */
export function npmBin(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** 某个探针在磁盘上的位置 */
export function probePath(repoRoot, pkg, probe) {
  return path.join(repoRoot, pkg.dir, 'node_modules', ...probe.split('/'))
}

/** 子包目录与它有没有 lock（有 lock 用 `npm ci`，没有退 `npm install`） */
export function packageSpec(repoRoot, pkg) {
  const dir = path.join(repoRoot, pkg.dir)
  return { dir, hasLock: fs.existsSync(path.join(dir, 'package-lock.json')) }
}

/**
 * 缺失的子包（按 `SUBPACKAGES` 顺序；全部就绪返回 `[]`）。
 * 每项形如 `{ id, label, dir, probes, missing: ['ws', …] }`。
 */
export function missingDeps(repoRoot) {
  const out = []
  for (const pkg of SUBPACKAGES) {
    const missing = pkg.probes.filter((p) => !fs.existsSync(probePath(repoRoot, pkg, p)))
    if (missing.length) out.push({ ...pkg, missing })
  }
  return out
}

/** 安装参数：有 lock 必须用 ci（可复现），没有才退 install */
export function installArgs({ hasLock }) {
  return hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund']
}

/** 给用户照抄的手工命令 —— 与 `installDeps()` 实际执行的动作一致（不写"另一套说法"） */
export function manualInstallCommands() {
  return SUBPACKAGES.map((p) => `npm -C ${p.dir} ci --no-audit --no-fund`)
}

/** 一行摘要（doctor / setup 共用同一措辞，避免两处说法漂移） */
export function missingDepsSummary(missing) {
  return missing.map((m) => `${m.dir} 缺 ${m.missing.join('、')}`).join('；')
}

/**
 * 跑一条 npm 命令。
 *
 * 用 `spawn` 而不是 `execFile` —— 这条纪律是 v2.100 用一次线上事故换来的：
 * `execFile` 的 `maxBuffer` 会在输出超过阈值时**杀掉子进程**，对常驻 worker 是灾难。
 * 这里虽然是一次性命令，但没有理由把同一个坑留在代码里：只留最后几行输出用于报错。
 */
function runNpm(cmd, args, cwd, onLog) {
  return new Promise((resolve) => {
    let tail = ''
    let settled = false
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const collect = (d) => {
      const text = String(d)
      tail = (tail + text).slice(-4000)
      if (onLog) onLog(text)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        resolve({ ok: false, error: `安装超时（>600s）：${cwd}`, tail })
      }
    }, 600000)
    const done = (ok, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, error, tail })
    }
    child.on('error', (e) => done(false, `无法启动 ${cmd}：${e.message}`))
    child.on('close', (code) =>
      done(code === 0, code === 0 ? undefined : `${cmd} ${args[0]} 退出码 ${code}`),
    )
  })
}

/**
 * 按 `SUBPACKAGES` 顺序安装给定 id 的子包依赖。
 *
 * 失败即停（不继续装后面的）：第一条失败的输出已经足够定位问题，
 * 继续装只会把"到底是哪一步坏的"淹掉。
 *
 * @returns {Promise<{ ok: boolean, results: Array<{id:string, ok:boolean, dir:string, error?:string, ms:number}>, failedAt?: string }>}
 */
export async function installDeps(repoRoot, ids, onLog) {
  const wanted = new Set(ids || [])
  const targets = SUBPACKAGES.filter((p) => wanted.has(p.id))
  const results = []
  for (const pkg of targets) {
    const spec = packageSpec(repoRoot, pkg)
    const args = installArgs(spec)
    const t0 = Date.now()
    const r = await runNpm(npmBin(), args, spec.dir, onLog)
    results.push({
      id: pkg.id,
      ok: r.ok,
      dir: pkg.dir,
      ms: Date.now() - t0,
      ...(r.ok ? {} : { error: r.error, tail: r.tail }),
    })
    if (!r.ok) return { ok: false, results, failedAt: pkg.id }
  }
  return { ok: true, results }
}
