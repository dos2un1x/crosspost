// 版本契约测试（P1：契约版本化对外暴露）
//
// 锁死"接入方能稳定读到版本"这件事：
//   · versionInfo() 字段名固定（接入方会依赖字段名，改名属破坏性变更）
//   · contract 版本与 projects.mjs 的 MANIFEST_VERSION 不得漂移
//     —— 二者一个对内一个对外，指向同一件事，漂移了接入方就会按错版本适配
//   · 引擎版本必须能真实读出（不是 'unknown'）
//   · CLI / HTTP 两个出口都必须带上版本块
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CONTRACT_VERSION, engineVersion, versionInfo } from '../src/version.mjs'
import { MANIFEST_VERSION } from '../src/projects.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')

/** 跑一条 git 命令并返回 stdout；失败（无 git / 非仓库）返回 '' —— 相关断言一律跳过 */
function gitOut(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

test('版本①：versionInfo 结构稳定（接入方依赖字段名）', () => {
  const v = versionInfo()
  assert.deepEqual(Object.keys(v).sort(), ['contract', 'engine', 'node'])
  assert.equal(typeof v.engine, 'string')
  assert.equal(typeof v.contract, 'number')
  assert.equal(typeof v.node, 'string')
})

test('版本②：引擎版本可真实读出（不能是 unknown）', () => {
  const v = engineVersion()
  assert.notEqual(v, 'unknown', '读不到版本，接入方将无法对账')
  // v2.108 起真值是 git tag（去掉前导 v），所以形态是 `2.107` 或 `2.107-3-g5258228`
  assert.match(v, /^\d+\.\d+/, `版本号格式异常: ${v}`)
})

test('版本②b：有 git 时必须等于 `git describe`（不再靠手工递增 package.json）', () => {
  let described = ''
  try {
    described = execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    /* 无 git（tarball 部署）→ 跳过：此时按设计回退 package.json */
  }
  if (!described) return
  assert.equal(
    engineVersion(),
    described.replace(/^v/, ''),
    'engineVersion 与 git describe 不一致——这个字段是接入方的对账依据，不能漂',
  )
})

test('版本②c：无 git 环境必须回退 package.json（tarball 部署不能被版本读取搞死）', async () => {
  // 反向断言：把 version.mjs 与一个假的 package.json 放进**不是 git 仓库**的临时目录，
  // 断言它退回 package.json 的值——否则"git 优先"在部署包里会变成 unknown，
  // 而这个字段的作用恰恰是让部署方能对账。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-version-'))
  const fakeRuntime = path.join(tmp, 'crosspost-runtime')
  fs.mkdirSync(path.join(fakeRuntime, 'src'), { recursive: true })
  fs.copyFileSync(
    path.join(REPO, 'crosspost-runtime', 'src', 'version.mjs'),
    path.join(fakeRuntime, 'src', 'version.mjs'),
  )
  fs.writeFileSync(
    path.join(fakeRuntime, 'package.json'),
    JSON.stringify({ name: 'crosspost-runtime', version: '9.9.9' }),
  )
  const mod = await import(
    pathToFileURL(path.join(fakeRuntime, 'src', 'version.mjs')).href + '?t=' + Date.now()
  )
  assert.equal(mod.engineVersion(), '9.9.9', '无 git 时应回退 package.json')
  assert.equal(mod.engineVersionSource(), 'package.json')
  assert.equal(mod.versionInfo().engine, '9.9.9')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('版本②d：无 git 回退值必须与最近 tag 同主次版本（否则部署包报旧版本）', () => {
  // 为什么需要它：干净 clone 冒烟的沙箱里**没有 `.git`**（它自己断言这一点），
  // 于是 `engineVersion()` 走 package.json 回退分支。回退值一旦不跟着发布走，
  // 无 git 的部署就会报出一个旧版本——v2.0 时它停在 2.107.0，而发布已经是 v2.0。
  // "一个不会自己暴露的旧版本字段"正是 v2.108 修过的那类问题，这里给它一道断言。
  const tag = gitOut(['describe', '--tags', '--abbrev=0'])
  if (!tag) return // 无 git / 无 tag：跳过（回退机制本身由 ②c 覆盖）
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO, 'crosspost-runtime', 'package.json'), 'utf8'),
  )
  const majorMinor = (s) => String(s).replace(/^v/, '').split('.').slice(0, 2).join('.')
  assert.equal(
    majorMinor(pkg.version),
    majorMinor(tag),
    `crosspost-runtime/package.json 是 ${pkg.version}，而最近 tag 是 ${tag}——无 git 部署会报出旧版本`,
  )
})

/**
 * 包元数据契约（2026-09-25，仓库改名 crosspost + `@crosspost/*` 命名）。
 *
 * 为什么需要：`repository` 是"代码回指"，同一个仓库的各个包**必须指向同一处**
 * ——两份不同的 URL 会让 GitHub 建出两处代码归属，而这类漂移代码全绿、功能正常，
 * 只有 `npm publish` 或仓库页面才看得出。
 *
 * 判据：**全有或全无**——要么各包都不声明 `repository`（还没配远端时的状态），
 * 要么声明的是同一个 URL。不把某个 URL 钉进测试，是为了让远程配好那天不必回来改它。
 * 未标 `private`（= 会被发布出去）的包还必须带 `license` 与 `files`，见版本⑧。
 */
test('版本⑦：各包 repository 要么都不声明，要么指向同一个仓库', () => {
  const roots = [
    REPO,
    path.join(REPO, 'crosspost-runtime'),
    // 2026-09-28 测试审计：`crosspost-runtime/core` 是**唯一**真会被发布出去的包，
    // 原名单里没有它 —— 它的 repository 漂了永远不会红。
    path.join(REPO, 'crosspost-runtime', 'core'),
    path.join(REPO, 'bridge'),
  ]
  // `repository` 可以写成字符串或 {url}——两种都接受，只比对取出来的 URL
  const urlOf = (r) => (typeof r === 'string' ? r : (r && r.url) || '')
  const declared = []
  for (const root of roots) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    if (pkg.repository) declared.push([path.relative(REPO, root) || '.', urlOf(pkg.repository)])
  }
  // 还没配远端 = 一个都没声明：这是合法状态，不是失败
  if (declared.length === 0) return
  const blank = declared.filter(([, url]) => !url)
  assert.deepEqual(blank, [], `这些包声明了 repository 却没给出 url：${JSON.stringify(blank)}`)
  const urls = [...new Set(declared.map(([, url]) => url))]
  assert.equal(
    urls.length,
    1,
    `各包的 repository 必须指向同一个仓库（否则 GitHub 会建两处代码归属）：\n` +
      declared.map(([r, url]) => `  ${r}/package.json → ${url}`).join('\n'),
  )
})

test('版本⑧：会被发布的包必须声明 license 与 files', () => {
  // `private: true` 的包不进 npm，不受这条约束（它们是工作区内部件）
  //
  // 2026-09-28 测试审计：原名单三个包**全是** `private: true` → 循环体一次都不执行
  // （等价于 `assert.deepEqual([], [])`），而唯一可发布的 `crosspost-runtime/core` 不在名单里。
  const roots = [
    REPO,
    path.join(REPO, 'crosspost-runtime'),
    path.join(REPO, 'crosspost-runtime', 'core'),
    path.join(REPO, 'bridge'),
  ]
  const missing = []
  let checked = 0
  for (const root of roots) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    if (pkg.private === true) continue
    checked++
    for (const field of ['license', 'files'])
      if (!pkg[field]) missing.push(`${path.relative(REPO, root) || '.'} 缺 ${field}`)
  }
  assert.ok(checked > 0, '没有任何可发布包被检查到：这条断言又退化成恒真了')
  assert.deepEqual(
    missing,
    [],
    `以下可发布包缺发布元数据（license 缺失会让使用者无从判断许可；files 缺失会把整仓推上 npm）：\n${missing.join('\n')}`,
  )
})

test('版本②e：根 README 的「当前版本」行必须与最近 tag 一致', () => {
  // 产品文档里只允许出现**一个**版本号（README 顶部那一行，见 docs/README 的规程）。
  // 它由人手写，所以必须有断言盯着——本项目的规矩是"手写一定会漂，给它一条命令"。
  const tag = gitOut(['describe', '--tags', '--abbrev=0'])
  if (!tag) return
  const md = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8')
  const m = /当前版本\s*\*\*(v[0-9][0-9.]*)\*\*/.exec(md)
  assert.ok(m, 'README 里找不到「当前版本 **vX.Y**」——发布时忘了改，或格式被改坏')
  assert.equal(m[1], tag, `README 写 ${m[1]}，最近 tag 是 ${tag}`)
})

test('版本③：契约版本与 manifest 版本一致（对内对外指向同一件事）', () => {
  assert.equal(
    CONTRACT_VERSION,
    MANIFEST_VERSION,
    'CONTRACT_VERSION（对外）与 MANIFEST_VERSION（对内）必须同步递增，否则接入方会按错版本适配',
  )
})

test('版本④：CLI proxyStatus 返回 version 块（MCP status 工具经此转发）', () => {
  const cli = fs.readFileSync(path.join(REPO, 'crosspost-runtime', 'src', 'cli.mjs'), 'utf8')
  assert.match(cli, /version:\s*versionInfo\(\)/, 'CLI proxyStatus 未附加 version')
})

test('版本⑤：桥的 /proxy/status 返回 version 块（HTTP 消费者依赖）', () => {
  const bridge = fs.readFileSync(path.join(REPO, 'bridge', 'run-bridge.mjs'), 'utf8')
  assert.match(bridge, /version:\s*versionInfo\(\)/, '桥 status 未附加 version')
})

test('版本⑥：桥不可用时仍能读到版本（版本信息不该依赖桥）', () => {
  const rt = fs.readFileSync(
    path.join(REPO, 'crosspost-runtime', 'src', 'runtime-node.mjs'),
    'utf8',
  )
  // 降级分支（`connected: false`）必须**全部**带 version。
  //
  // 2026-09-28 测试审计：原先按"同一行里既有 `resolve({` 又有 `connected: false`"筛，
  // 于是**跨行写法**的降级分支整条漏掉（`runtime-node.mjs` 里 `req.on('error')` 那段就是），
  // 断言只覆盖 3 条中的 2 条，却看起来像"全量检查"。
  // 现在按括号配对切出每个 `resolve({...})` 块再判，并用"块数 == `connected: false` 出现次数"
  // 自证，防止抽取再次悄悄退化回恒真。
  const blocks = []
  for (let i = rt.indexOf('resolve({'); i !== -1; i = rt.indexOf('resolve({', i + 1)) {
    let depth = 0
    let end = i
    for (; end < rt.length; end++) {
      const ch = rt[end]
      if (ch === '(' || ch === '{') depth++
      else if (ch === ')' || ch === '}') {
        depth--
        if (depth === 0) break
      }
    }
    blocks.push(rt.slice(i, end + 1))
  }
  const degraded = blocks.filter((b) => /connected:\s*false/.test(b))
  const occurrences = (rt.match(/connected:\s*false/g) || []).length
  assert.ok(degraded.length > 0, '未找到 runtime 的降级分支')
  assert.equal(
    degraded.length,
    occurrences,
    `有 ${occurrences - degraded.length} 个降级分支没被本断言覆盖（多半又出现跨行写法）`,
  )
  const missing = degraded.filter((b) => !/version:\s*versionInfo\(\)/.test(b))
  assert.deepEqual(missing, [], `以下降级分支缺少 version:\n${missing.join('\n')}`)
})
