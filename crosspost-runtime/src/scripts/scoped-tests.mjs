#!/usr/bin/env node
/**
 * **按改动范围**跑测试（v2.107）——把"每次改完都跑全量"换成"跑与改动有关的那些"。
 *
 * ## 为什么需要它
 *
 * 全量 `npm run check` = typecheck + eslint 全仓 + prettier 全仓 + core 316 例 + runtime 421 例，
 * 一次 ~2 分钟；再加 `verify:acceptance` 20 项 ~200 秒。**每改一个文件就跑一遍**，
 * 真正的编辑时间被测试时间淹掉 —— 而绝大多数改动只碰一两个模块。
 *
 * ## 怎么判断"有关的那些"
 *
 * 不用人工维护映射表（那会腐化）。证据来自测试文件自身：
 *   ① ESM `import` / `import()` / `require()` 的相对路径 → 逐层**传递闭包**（源码之间也算）
 *   ② `path.join(REPO, 'bridge', 'run-bridge.mjs')` 这类**拼接出来的路径**（spawn 型测试不 import 被测模块）
 *   ③ 直接出现的看起来像仓库路径的字符串（`'../../bridge/cli-worker.mjs'` 等）
 * 于是"改了哪个源文件 → 哪些测试引用了它（直接或间接）"是可判定的。
 *
 * ## 安全边界（宁可多跑，不可漏跑）
 *
 *   · 改了**没被任何测试引用**的代码 → 回退跑**全量**（打印原因）
 *   · 改了 package.json / lock / eslint / tsconfig / paths.json / config.json / CI → 全量
 *   · 选中的测试 ≥ 全部单测的 70% → 直接全量（省得拼装）
 *   · smoke / 验收脚本（console-smoke、empty-env-smoke、acceptance-report…）默认**只提示不跑**
 *     （它们慢且需要真机条件）—— 要跑加 `--with-smoke`
 *
 * ## 与全量的分工（纪律）
 *
 *   编辑中/编辑后：`npm run test:scoped`（秒级~十几秒）
 *   提交前：`npm run test:scoped --with-smoke`（改了 Console/bridge 行为时）
 *   打 tag / 发布前：**全量** `npm run check` + `npm run verify:acceptance`
 *   CI：每日全量（.github/workflows/ci.yml）
 *
 * 用法：
 *   node crosspost-runtime/src/scripts/scoped-tests.mjs                 # 工作区改动（含未提交/未跟踪）
 *   node … --since v2.106.3                                             # 与某个 ref 比较（含工作区）
 *   node … --files bridge/run-bridge.mjs,crosspost-runtime/src/cli.mjs  # 显式指定
 *   node … --with-smoke                                                 # 连相关 smoke 一起跑
 *   node … --list                                                       # 只列选择结果，不执行
 *   node … --json                                                       # 机器可读
 *   node … --no-lint                                                    # 跳过 eslint/prettier（只跑测试）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..', '..') // crosspost-runtime
const REPO = path.resolve(RUNTIME, '..')
const CORE = path.join(RUNTIME, 'core')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name, def = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}

const WITH_SMOKE = flag('--with-smoke')
const LIST_ONLY = flag('--list')
const AS_JSON = flag('--json')
const NO_LINT = flag('--no-lint')
const SINCE = opt('--since')
const EXPLICIT = opt('--files')

/* ────────────────────────────── 收集改动文件 ────────────────────────────── */

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' })
  return r.status === 0 ? r.stdout : ''
}

function changedFiles() {
  if (EXPLICIT) {
    return EXPLICIT.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => path.resolve(REPO, p))
  }
  const out = new Set()
  // 已提交部分（与 ref 比较）
  if (SINCE) {
    for (const line of git(['diff', '--name-only', `${SINCE}...HEAD`]).split('\n')) {
      if (line.trim()) out.add(path.resolve(REPO, line.trim()))
    }
  }
  // 工作区（已跟踪的改动 + 未跟踪的新文件；忽略 ignored）
  for (const line of git(['status', '--porcelain', '--untracked-files=all']).split('\n')) {
    if (!line.trim()) continue
    const p = line.slice(3).trim()
    const target = p.includes(' -> ') ? p.split(' -> ')[1] : p
    if (target) out.add(path.resolve(REPO, target))
  }
  if (!SINCE && out.size === 0) {
    // 没有改动 → 用最近一次提交（方便"刚 commit 完想看影响面"）
    for (const line of git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n')) {
      if (line.trim()) out.add(path.resolve(REPO, line.trim()))
    }
    out._fromHead = true
  }
  return [...out]
}

/* ────────────────────────── 从文件里抽"引用了谁" ────────────────────────── */

const RE_IMPORT = /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g
const RE_DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
const RE_REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
/** path.join/resolve 的参数里那些带引号的片段（spawn 型测试就是这样写出被测脚本路径的） */
const RE_JOIN = /\b(?:path\.)?(?:join|resolve)\(\s*([^)]*)\)/g
// 注意要**允许以 ./ 或 ../ 开头**：`import(new URL('../../bridge/cli-worker.mjs', import.meta.url).href)`
// 这种写法曾整类漏掉（cli-worker-resilience.test.mjs 就是对 cli-worker 的唯一回归测试）。
const RE_QUOTED =
  /['"]((?:\.{1,2}\/)*[A-Za-z0-9_@][A-Za-z0-9_@./-]*\.(?:mjs|js|ts|json|yml|yaml))['"]/g

const exists = (p) => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** 把一个候选（相对/绝对）在几个基准目录下试成真实文件路径 */
function resolveCandidate(cand, bases) {
  if (!cand || cand.startsWith('node:') || !/^[./A-Za-z]/.test(cand)) return null
  for (const base of bases) {
    const p = path.isAbsolute(cand) ? cand : path.resolve(base, cand)
    if (exists(p)) return p
  }
  return null
}

/**
 * 抽出一个文件"引用到的仓库内文件"（直接引用，不含传递闭包）。
 * @returns {string[]} 绝对路径
 */
export function directRefs(absFile) {
  let text
  try {
    text = fs.readFileSync(absFile, 'utf8')
  } catch {
    return []
  }
  const dir = path.dirname(absFile)
  const bases = [dir, REPO, RUNTIME]
  const out = new Set()

  const add = (cand) => {
    const p = resolveCandidate(String(cand || '').trim(), bases)
    if (p && p !== absFile && p.startsWith(REPO)) out.add(p)
  }

  for (const re of [RE_IMPORT, RE_DYNAMIC, RE_REQUIRE]) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) add(m[1])
  }
  // path.join(REPO, 'bridge', 'x.mjs') → 把引号片段按顺序拼起来
  RE_JOIN.lastIndex = 0
  for (const m of text.matchAll(RE_JOIN)) {
    const parts = [...String(m[1]).matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
    if (!parts.length) continue
    add(parts.join('/'))
    add(parts[parts.length - 1])
  }
  RE_QUOTED.lastIndex = 0
  for (const m of text.matchAll(RE_QUOTED)) add(m[1])
  return [...out]
}

/**
 * 传递闭包（源码之间继续展开），深度上限 8 防环。
 *
 * `hubs`（枢纽文件）**不展开**：枢纽 = 被很多测试直接引用的模块（如 `cli.mjs`、`run-bridge.mjs`）。
 * 不设这道闸，"任意一个被 cli.mjs import 的模块"都会把"所有 spawn cli.mjs 的 e2e 测试"全选中
 * —— 实测改一个 `commands/setup.mjs` 会选中 21 个测试文件，等于没筛。
 * "经枢纽间接依赖"由 `selectScoped` 按**枢纽的直接依赖表**做一跳放大（有上限，见 AMPLIFY_MAX）。
 */
export function closureOf(absFile, { depth = 8, hubs = new Set(), expandHubs = false } = {}) {
  const parents = new Map() // 子文件 → 引入它的父文件（用于 --explain 打印路径）
  const seen = new Set([absFile])
  const queue = [...directRefs(absFile).map((f) => [f, absFile, 1])]
  while (queue.length) {
    const [f, parent, d] = queue.shift()
    if (!seen.has(f)) {
      seen.add(f)
      if (!parents.has(f)) parents.set(f, parent)
    }
    if (d > depth) continue
    if (!expandHubs && hubs.has(f) && f !== absFile) continue // 枢纽：记录，不展开
    for (const r of directRefs(f)) if (!seen.has(r)) queue.push([r, f, d + 1])
  }
  seen.parents = parents
  return seen
}

/** 枢纽文件：被 ≥ HUB_MIN 个测试**直接**引用的源码（自动发现，不写死清单） */
export function findHubs(tests, { min = 6 } = {}) {
  const count = new Map()
  for (const t of tests) {
    for (const r of directRefs(t)) count.set(r, (count.get(r) || 0) + 1)
  }
  return new Set([...count.entries()].filter(([, n]) => n >= min).map(([f]) => f))
}

/** test → 引用的文件集合（枢纽不展开），并保留父链供 --explain 用 */
export function buildMap(tests, { hubs = new Set() } = {}) {
  const map = new Map()
  for (const f of tests) map.set(f, closureOf(f, { hubs }))
  return map
}

/* ─────────────────────────────── 测试清单 ─────────────────────────────── */

function listFiles(dir, filter, acc = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) listFiles(p, filter, acc)
    else if (filter(e.name, p)) acc.push(p)
  }
  return acc
}

export function enumerateTests() {
  const runtimeDir = path.join(RUNTIME, 'tests')
  const all = fs.existsSync(runtimeDir)
    ? fs
        .readdirSync(runtimeDir)
        .filter((f) => f.endsWith('.mjs'))
        .map((f) => path.join(runtimeDir, f))
    : []
  const unit = all.filter((f) => f.endsWith('.test.mjs'))
  const smoke = all.filter((f) => !f.endsWith('.test.mjs'))
  const coreUnit = listFiles(
    path.join(CORE, 'src'),
    (name) => name.endsWith('.test.ts') || name.endsWith('.test.tsx'),
  )
  return { unit, smoke, coreUnit }
}

/* ────────────────────────────── 选择 ────────────────────────────── */

/**
 * 一跳放大的上限：枢纽的引用测试数 ≤ 这个值时才自动带上。
 * 超过（如 `cli.mjs` 的 21 个）只**提示** —— 自动带上就等于没筛，而全量本来也不贵多少。
 */
export const AMPLIFY_MAX = 8

/** 改了这些就必须全量：构建/依赖/配置/CI 本身 */
const FULL_TRIGGERS = [
  'package.json',
  'package-lock.json',
  '.nvmrc',
  '.npmrc',
  'eslint.config.js',
  'tsconfig.json',
  '.prettierrc',
  '.prettierignore',
  'cordis.yml',
  'cordis.patch.yml',
  'crosspost-runtime/paths.json',
  'crosspost-runtime/config.json',
]

const isDoc = (p) => p.endsWith('.md') || p.includes(`${path.sep}docs${path.sep}`)
const isSource = (p) => /\.(mjs|js|cjs|ts|tsx)$/.test(p)

/**
 * @returns {{selected:string[], coreSelected:string[], relevantSmoke:string[],
 *            full:boolean, reasons:string[], unattributed:string[], fromHead?:boolean}}
 */
export function selectScoped(
  changed,
  map,
  {
    unit,
    smoke,
    coreUnit,
    hubs = new Set(),
    hubDirectImports = new Map(),
    hubDependents = new Map(),
    amplifyMax = AMPLIFY_MAX,
  },
) {
  const reasons = []
  const selected = new Set()
  const coreSelected = new Set()
  const relevantSmoke = new Set()
  const unattributed = []
  const explain = new Map() // 改动文件 → 命中的测试（含路径）
  const tooWide = [] // 想放大但枢纽太大（> amplifyMax）→ 只提示，不自动跑
  let full = false

  const rel = (p) => path.relative(REPO, p)
  const testSet = new Set([...unit, ...coreUnit])

  const pushFull = (why) => {
    full = true
    reasons.push(why)
  }

  for (const c of changed) {
    if (FULL_TRIGGERS.some((t) => rel(c) === t || rel(c).startsWith(t))) {
      pushFull(`改了影响面全局的文件：${rel(c)}`)
      continue
    }
    // 测试文件本身：直接选中它
    if (testSet.has(c)) {
      if (unit.includes(c)) selected.add(c)
      if (coreUnit.includes(c)) coreSelected.add(c)
      continue
    }
    if (smoke.includes(c)) {
      relevantSmoke.add(c)
      continue
    }
    if (isDoc(c)) continue // 文档只受 prettier 管

    let hit = false
    const addHit = (test, why) => {
      hit = true
      if (unit.includes(test)) selected.add(test)
      else if (coreUnit.includes(test)) coreSelected.add(test)
      else if (smoke.includes(test)) relevantSmoke.add(test)
      if (!explain.has(c)) explain.set(c, { test: rel(test), via: why })
    }

    for (const [test, refs] of map) {
      if (!refs.has(c)) continue
      addHit(test, '直接引用')
    }
    // 一跳放大：`bridge/cli-worker.mjs` 被 `run-bridge.mjs`（枢纽）直接引用，
    // 于是"改了 cli-worker"要把"引用 run-bridge 的那些测试"也拉回来（否则 v2.100 那类
    // worker 行为的回归会被漏掉）。但**只在小枢纽上做**：`cli.mjs` 有 21 个引用测试，
    // 放大它等于没筛 —— 那种情况只提示，由人决定。
    for (const [hubFile, imports] of hubDirectImports) {
      if (hubFile === c || !imports.has(c)) continue
      const deps = hubDependents.get(hubFile) || []
      if (deps.length && deps.length <= amplifyMax) {
        for (const test of deps) addHit(test, `经枢纽 ${rel(hubFile)}（${deps.length} 个引用测试）`)
      } else if (deps.length > amplifyMax) {
        tooWide.push({ hub: rel(hubFile), count: deps.length })
      }
    }
    if (!hit && isSource(c)) unattributed.push(rel(c))
  }

  if (unattributed.length) {
    pushFull(`以下改动没有被任何测试引用（保守跑全量）：${unattributed.join('、')}`)
  }
  if (unit.length && selected.size / unit.length >= 0.7) {
    pushFull(`选中的单测已达 ${selected.size}/${unit.length}（≥70%）`)
  }

  return {
    selected: [...selected].sort(),
    coreSelected: [...coreSelected].sort(),
    relevantSmoke: [...relevantSmoke].sort(),
    full,
    reasons,
    unattributed,
    explain,
    hubs: [...hubs].map(rel).sort(),
    tooWide,
  }
}

/* ────────────────────────────── 执行 ────────────────────────────── */

/** 入口守卫：被 import（测试）时不执行主流程 —— 否则一 import 就把全量测试跑一遍 */
const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

export function main() {
  const t0 = Date.now()
  const changed = changedFiles()
  const { unit, smoke, coreUnit } = enumerateTests()
  // 枢纽（被很多测试直接引用的模块）自动发现：不写死清单，改了它会腐化
  const hubs = findHubs([...unit, ...coreUnit])
  const map = buildMap([...unit, ...coreUnit, ...smoke], { hubs })
  // 枢纽的**直接依赖表** + 谁引用这个枢纽 —— 用于"一跳放大"（见 selectScoped）
  const hubDirectImports = new Map([...hubs].map((h) => [h, new Set(directRefs(h))]))
  const hubDependents = new Map([...hubs].map((h) => [h, []]))
  for (const [test, refs] of map) {
    for (const h of hubs) if (refs.has(h)) hubDependents.get(h).push(test)
  }
  const plan = selectScoped(changed, map, {
    unit,
    smoke,
    coreUnit,
    hubs,
    hubDirectImports,
    hubDependents,
  })

  const rel = (p) => path.relative(REPO, p)
  // 已**删除**的文件不进 lint/prettier：它们在磁盘上不存在，`eslint <path>` 与
  // `prettier --check <path>` 都会以"找不到文件"退出，把一次纯删除的改动报成红灯
  // （2026-09-25 删 Console 工作流页时实测踩到；全仓 eslint / format:check 仍会兜底）。
  const codeChanged = changed.filter(
    (c) => fs.existsSync(c) && isSource(c) && !c.includes(`${path.sep}node_modules${path.sep}`),
  )
  const coreTouched = changed.some((c) => c.startsWith(CORE))

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          changed: changed.map(rel),
          full: plan.full,
          reasons: plan.reasons,
          unit: plan.selected.map(rel),
          core: plan.coreSelected.map(rel),
          smokeRelevant: plan.relevantSmoke.map(rel),
          counts: { unit: unit.length, core: coreUnit.length, smoke: smoke.length },
        },
        null,
        2,
      ),
    )
    if (LIST_ONLY) process.exit(0)
  }

  if (!AS_JSON) {
    console.log(`\n按改动范围跑测试  （改了 ${changed.length} 个文件）`)
    for (const c of changed) console.log(`  · ${rel(c)}`)
    if (plan.reasons.length) for (const r of plan.reasons) console.log(`  ! ${r}`)
    if (plan.full) {
      console.log('→ 结论：**跑全量**（上方原因）')
    } else {
      console.log(
        `→ 选中 ${plan.selected.length} 个 runtime 测试 · ${plan.coreSelected.length} 个 core 测试`,
      )
      for (const s of plan.selected) console.log(`    ✓ ${rel(s)}`)
      for (const s of plan.coreSelected) console.log(`    ✓ ${rel(s)}`)
      if (plan.relevantSmoke.length) {
        console.log(
          `  （相关但没有默认跑，加 --with-smoke：${plan.relevantSmoke.map(rel).join('、')}）`,
        )
      }
      for (const w of plan.tooWide || []) {
        console.log(
          `  ⚠ 该改动被枢纽 ${w.hub} 直接引用，而它有 ${w.count} 个引用测试（>${AMPLIFY_MAX}）：` +
            '没有自动带上 —— 保守起见可加 --with-smoke 或跑全量。',
        )
      }
    }
  }

  if (LIST_ONLY) process.exit(0)

  const failures = []
  const run = (cmd, args, cwd, label) => {
    const s = Date.now()
    const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
    const ms = Date.now() - s
    console.log(`\n[${label}] ${r.status === 0 ? '✔' : '✖'} ${(ms / 1000).toFixed(1)}s`)
    if (r.status !== 0) failures.push(label)
    return r.status === 0
  }

  if (!NO_LINT && codeChanged.length) {
    run('npx', ['eslint', ...codeChanged.map(rel)], REPO, 'eslint（只查改动的文件）')
    run('npx', ['prettier', '--check', ...codeChanged.map(rel)], REPO, 'prettier（只查改动的文件）')
  }
  if (NO_LINT && codeChanged.length === 0 && !plan.full) {
    console.log('\n（只有文档改动：跳过测试，必要时跑 prettier --check）')
  }

  if (plan.full) {
    run('npm', ['run', '--silent', 'typecheck'], REPO, 'typecheck')
    run('npm', ['run', '--silent', 'test:core'], REPO, 'core 全量（vitest）')
    run(process.execPath, ['--test', ...unit], RUNTIME, `runtime 全量（${unit.length} 个文件）`)
    run('npm', ['run', '--silent', 'lint'], REPO, 'eslint（全仓）')
    run('npm', ['run', '--silent', 'format:check'], REPO, 'prettier（全仓）')
  } else {
    const runtimeTargets = WITH_SMOKE ? [...plan.selected, ...plan.relevantSmoke] : plan.selected
    if (runtimeTargets.length) {
      run(
        process.execPath,
        ['--test', ...runtimeTargets],
        RUNTIME,
        `runtime 选中（${runtimeTargets.length} 个文件）`,
      )
    }
    if (plan.coreSelected.length) {
      run('npx', ['vitest', 'run', ...plan.coreSelected.map(rel)], CORE, 'core 选中（vitest）')
    } else if (coreTouched) {
      run('npm', ['run', '--silent', 'typecheck'], REPO, 'typecheck（改了 core）')
    }
    if (!runtimeTargets.length && !plan.coreSelected.length && !codeChanged.length) {
      console.log('\n✔ 没有需要跑的测试')
    }
    if (plan.relevantSmoke.length && !WITH_SMOKE) {
      console.log(
        `\n（提示：${plan.relevantSmoke.map(rel).join('、')} 与本次改动相关，但默认不跑；` +
          '打 tag 前请跑全量 + verify:acceptance）',
      )
    }
  }

  const total = ((Date.now() - t0) / 1000).toFixed(1)
  if (failures.length) {
    console.log(`\n✖ 失败：${failures.join('、')}（共 ${total}s）`)
    process.exit(1)
  }
  console.log(
    `\n✔ 按范围跑完（共 ${total}s）—— 打 tag / 发布前记得跑全量：npm run check && npm run verify:acceptance`,
  )
}

if (isEntry) main()
