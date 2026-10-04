// 许可合规守卫（2026-09-27）：GPL-3.0-only 是全仓唯一的许可
//
// 为什么会有这份测试 —— 三条**真实**缺口，都是靠人眼逐个文件看才发现的：
//   ① `preset/crosspost/package.json` 漏写 `license`（全仓唯一一个没有的）；
//   ② `@crosspost/core` 的 npm 发布物里**没有许可证全文**：npm 只看包目录，根目录那份
//      `LICENSE` 不会自动进去，而 `"license": "GPL-3.0-only"` 只是 SPDX 标识符、不是全文 ——
//      GPL-3.0 §4 要求分发时随附许可证，所以那份发布物当时是不合规的；
//   ③ 依赖许可从来没被机器检查过，一次手工审计才发现 10 个 `LGPL-3.0-or-later` 条目。
// 这里把三件事都钉住：漏写许可 / 发布物缺全文 / 引入 GPL 不兼容依赖，都会红。
//
// **这不是法律意见**：它只是"白名单 + 文件齐备性"的机器检查。真要对外发布，建议让法务过一眼。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')

/** 全仓唯一的许可标识。改这里等于改全仓许可策略（LICENSE 正文与文档要一起改） */
const LICENSE_ID = 'GPL-3.0-only'

/** 已登记的包。新增/移动 `package.json` 必须来这里登记，否则「许可①」会红 */
const PACKAGES = [
  'package.json',
  'crosspost-runtime/package.json',
  'crosspost-runtime/core/package.json',
  'bridge/package.json',
  'preset/crosspost/package.json',
]

const LOCKS = [
  'package-lock.json',
  'crosspost-runtime/package-lock.json',
  'bridge/package-lock.json',
]

const abs = (rel) => path.join(REPO, rel)
const readPkg = (rel) => JSON.parse(fs.readFileSync(abs(rel), 'utf8'))
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/**
 * 允许出现在依赖树里的许可。GPL-3.0 与这些相容：
 *   · 宽松类：MIT / MIT-0 / ISC / BSD-* / 0BSD / Apache-2.0 / BlueOak-1.0.0 / PSF-2.0 /
 *     Python-2.0 —— 注意 Apache-2.0 与 GPL-2.0 **不**相容、与 GPL-3.0 相容，
 *     这也是本仓选 GPL-3.0 而不是 GPL-2.0 的原因之一；
 *   · `LGPL-3.0-or-later`：与 GPL-3.0 相容（sharp 的平台原生库 libvips 就是它；
 *     我们不改动它、且按独立包分发）；
 *   · `GPL-3.0-only`：本仓自己的包（锁文件里 `core` 条目会镜像它）。
 */
const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'GPL-3.0-only',
  'ISC',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'PSF-2.0',
  'Python-2.0',
])

/** 锁文件里出现的非 SPDX 写法 → 归一到白名单里的键 */
const ALIASES = new Map([['MIT (http://mootools.net/license.txt)', 'MIT']])

/**
 * 纯函数：返回不在白名单里的许可（`AND` / `OR` 组合按每一段分别判定）。
 * 独立成纯函数是为了「许可⑤」能用假数据证明它真的会判红，而不必污染真实依赖树。
 */
function disallowedLicenses(licenses) {
  const bad = []
  for (const raw of licenses) {
    const text = String(raw).trim()
    const canon = ALIASES.get(text) || text
    for (const part of canon.split(/\s+(?:AND|OR)\s+/)) {
      const id = ALIASES.get(part.trim()) || part.trim()
      if (!ALLOWED.has(id)) bad.push(text)
    }
  }
  return bad
}

/** 递归找仓库里所有 `package.json`（跳过依赖树、归档与隐藏目录） */
function discoverPackageJsons() {
  const found = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'md-backup' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'package.json') found.push(path.relative(REPO, p))
    }
  }
  walk(REPO)
  return found.sort()
}

/** 该文件是否未被 git 跟踪（用于判断 prepack 的临时副本有没有被 postpack 清掉） */
function isUntracked(absPath) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', absPath], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim().startsWith('??')
  } catch {
    return false
  }
}

/** 会被发布出去的包（`private !== true`）—— 本仓今天只有 `@crosspost/core` */
const publishable = PACKAGES.filter((rel) => readPkg(rel).private !== true)

test('许可①：仓库里每个 package.json 都已在测试里登记', () => {
  assert.deepEqual(
    discoverPackageJsons(),
    [...PACKAGES].sort(),
    '仓库里的 package.json 与 PACKAGES 清单不一致：新增/移动的包要在本文件里登记，' +
      '否则它的许可不会被任何断言检查（这正是 preset 那个包漏写 license 时没人发现的原因）',
  )
})

test('许可②：每个包都声明同一个许可标识', () => {
  const bad = []
  for (const rel of PACKAGES) {
    const id = readPkg(rel).license
    if (id !== LICENSE_ID) bad.push(`${rel} → ${id === undefined ? '（缺 license 字段）' : id}`)
  }
  assert.deepEqual(
    bad,
    [],
    `以下包的许可不是 ${LICENSE_ID}（换许可要连同 LICENSE 正文与文档一起改）：\n  ${bad.join('\n  ')}`,
  )
})

test('许可③：可发布的包，打包产物里必须带许可证全文', () => {
  const bad = []
  for (const rel of publishable) {
    const pkg = readPkg(rel)
    const cwd = path.dirname(abs(rel))
    let list
    try {
      const out = execFileSync(NPM, ['pack', '--dry-run', '--json'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      // npm 可能在前面带几行提示，从第一个 '[' 开始解析
      list = JSON.parse(out.slice(out.indexOf('[')))[0].files.map((f) => f.path)
    } catch (e) {
      bad.push(`${rel}（${pkg.name}）打包失败：${e.message}`)
      continue
    }
    if (!list.includes('LICENSE')) {
      bad.push(
        `${rel}（${pkg.name}）的发布物里没有 LICENSE —— 根目录那份不会自动进去；` +
          '要么用 prepack 复制进来，要么在包目录里提交一份',
      )
    }
    // prepack 会往包目录复制一份临时 LICENSE，postpack 必须把它清掉（否则工作树被搞脏）
    if (pkg.scripts && pkg.scripts.postpack && fs.existsSync(path.join(cwd, 'LICENSE'))) {
      if (isUntracked(path.join(cwd, 'LICENSE'))) {
        bad.push(`${rel} 的 postpack 没清掉 prepack 留下的临时 LICENSE`)
      }
    }
  }
  assert.deepEqual(bad, [], `许可证没能随发布物走（GPL-3.0 §4）：\n  ${bad.join('\n  ')}`)
})

test('许可④：可发布的包必须给出源码可得性（GPL-3.0 §6）', () => {
  const bad = []
  for (const rel of publishable) {
    const pkg = readPkg(rel)
    const hasRepo = Boolean(pkg.repository)
    const shipsSrc = Array.isArray(pkg.files) && pkg.files.includes('src')
    if (!hasRepo && !shipsSrc) {
      bad.push(
        `${rel}（${pkg.name}）既没有 repository、也没把 src 放进 files —— ` +
          '收到目标代码的人拿不到对应源码',
      )
    }
  }
  assert.deepEqual(bad, [], `源码可得性缺失（GPL-3.0 §6）：\n  ${bad.join('\n  ')}`)
})

test('许可⑤：白名单函数本身能判红（用假数据，不碰真实依赖树）', () => {
  for (const bad of [
    'GPL-2.0-only',
    'AGPL-3.0',
    'SSPL-1.0',
    'UNLICENSED',
    'CC-BY-NC-4.0',
    'MIT AND GPL-2.0-only',
  ]) {
    assert.equal(disallowedLicenses([bad]).length, 1, `${bad} 应被判为不允许，但白名单放过了它`)
  }
  for (const good of [
    'MIT',
    'Apache-2.0',
    'ISC',
    'BSD-3-Clause',
    'LGPL-3.0-or-later',
    'GPL-3.0-only',
    'MIT (http://mootools.net/license.txt)',
    'Apache-2.0 AND LGPL-3.0-or-later AND MIT',
  ]) {
    assert.deepEqual(disallowedLicenses([good]), [], `${good} 应被允许，但白名单判它违规`)
  }
})

test('许可⑥：三个锁文件里的依赖许可全在白名单内', () => {
  const offenders = []
  let checked = 0
  for (const lock of LOCKS) {
    if (!fs.existsSync(abs(lock))) continue
    const j = JSON.parse(fs.readFileSync(abs(lock), 'utf8'))
    for (const [key, v] of Object.entries(j.packages || {})) {
      // link 条目指向本仓自己的包（许可由「许可②」负责），不在这里重复判
      if (!key || v.link) continue
      checked++
      if (v.license === undefined) {
        offenders.push(`${lock} :: ${key} 未声明 license`)
        continue
      }
      for (const bad of disallowedLicenses([v.license])) {
        offenders.push(`${lock} :: ${key} :: ${bad}`)
      }
    }
  }
  assert.ok(
    checked > 100,
    `只检查到 ${checked} 个依赖 —— 锁文件可能没装或路径变了，这条断言已失去意义`,
  )
  assert.deepEqual(
    offenders,
    [],
    '发现 GPL-3.0 不兼容（或未声明）的依赖许可，先确认再往白名单里加：\n  ' +
      offenders.join('\n  '),
  )
})
