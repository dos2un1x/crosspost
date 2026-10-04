// 发布物洁净（开箱即用检查 E5）
//
// 背景：`docs/**` 与 `README.md` 决定了"别人照文档能不能装起来"，而
// **什么会被别人拿到**是另一件事：`git ls-files --cached --others --exclude-standard`
// 列出的才是干净 clone 的文件集。两个都出过问题：
//   · 运行态文件（config.json / paths.json / token.*）被 tracked → 发布物里带着本机配置；
//   · vendored 产物没有同目录 README → 随发布物分发的第三方代码没有归属声明；
//   · 注释里写死作者家目录 → 换台机器文档就对不上。
//
// 与 `docs-hygiene.test.mjs` 的分工：那份管"文档里写了什么"，这份管"会发布出去什么"。
// 两条都用同一条 git 命令取文件集，与 `fresh-clone-smoke.mjs` 造沙箱的命令逐字一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')

/** 干净 clone 的文件集（相对仓库根）。无 git 时返回 null，调用方跳过。 */
function releaseFileSet() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean)
  } catch {
    return null
  }
}

/** 这些路径只该存在于本机：出现即意味着发布物泄漏了运行态或本机配置 */
const FORBIDDEN = [
  /(^|\/)\.env$/,
  /(^|\/)token\.[^/]*\.json$/,
  /(^|\/)token\.local$/,
  /(^|\/)storage\.json$/,
  /(^|\/)ever-authed\.json$/,
  /(^|\/)platforms-state\.json$/,
  /(^|\/)paths\.json$/,
  /(^|\/)config\.json$/,
  /(^|\/)brand\//,
  /^md-backup\//,
  /^\.local\//,
  /(^|\/)node_modules\//,
  /(^|\/)coverage\//,
  /(^|\/)\.DS_Store$/,
]

const files = releaseFileSet()

test('发布物①：不含运行态、凭据与本机配置', () => {
  if (!files) return
  const bad = files.filter((f) => FORBIDDEN.some((re) => re.test(f)))
  assert.deepEqual(
    bad,
    [],
    `这些文件不该出现在发布物里（在 .gitignore 里补上，或从索引里移出）：\n  ` + bad.join('\n  '),
  )
})

test('发布物②：vendored 产物必须有同目录 README 且写明许可', () => {
  if (!files) return
  const vendorDirs = [
    ...new Set(files.filter((f) => f.includes('vendor/')).map((f) => path.posix.dirname(f))),
  ]
  assert.ok(vendorDirs.length > 0, '发布物里一个 vendor/ 目录都没有——断言失去意义，请更新本测试')
  const bad = []
  for (const dir of vendorDirs) {
    const readme = path.join(REPO, dir, 'README.md')
    if (!fs.existsSync(readme)) {
      bad.push(`${dir}/ 缺 README.md（随发布物分发的第三方代码必须有归属声明）`)
      continue
    }
    const text = fs.readFileSync(readme, 'utf8')
    if (!/MIT|Apache|ISC|BSD|GPL/.test(text))
      bad.push(`${dir}/README.md 没写明许可（至少要有许可名与版权行）`)
    if (!/https?:\/\//.test(text)) bad.push(`${dir}/README.md 没给上游链接`)
  }
  assert.deepEqual(bad, [], `vendored 组件归属不完整：\n  ${bad.join('\n  ')}`)
})

test('发布物③：规模在预期量级内（防止把运行态目录带进来）', () => {
  if (!files) return
  let bytes = 0
  for (const f of files) {
    try {
      bytes += fs.statSync(path.join(REPO, f)).size
    } catch {
      /* 索引里有、磁盘上没有：由 smoke 的复制步骤负责暴露 */
    }
  }
  const mb = bytes / 1048576
  console.log(`ℹ 发布物：${files.length} 个文件 / ${mb.toFixed(2)} MB`)
  // 宽松上限：不是"精确计数门禁"，只是防呆（正常量级 ~300 文件 / ~4 MB）
  assert.ok(files.length <= 800, `发布物文件数异常：${files.length}（上限 800）`)
  assert.ok(mb <= 20, `发布物体积异常：${mb.toFixed(2)} MB（上限 20 MB）`)
})

test('发布物④：内容里不得出现真实家目录', () => {
  if (!files) return
  // 与 docs-hygiene 同一条正则：`/Users/me/…` 这类占位符允许，真实用户名不允许。
  const HOME = /\/Users\/(?!me\b|you\b|x\b|your\b|<)[A-Za-z0-9_.-]+\//
  const bad = []
  for (const f of files) {
    if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|zip|gz|tgz)$/i.test(f)) continue
    let text
    try {
      text = fs.readFileSync(path.join(REPO, f), 'utf8')
    } catch {
      continue
    }
    text.split('\n').forEach((line, i) => {
      if (HOME.test(line)) bad.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`)
    })
  }
  assert.deepEqual(
    bad,
    [],
    `发布物里写死了作者家目录（文档/注释一律用 /Users/me/… 这类占位符）：\n  ${bad.join('\n  ')}`,
  )
})
