/**
 * 「按改动范围跑测试」这个工具自身的测试（v2.107）
 *
 * 为什么工具也要测：它决定**哪些测试会被跳过** —— 工具错了就是"少跑了测试却显示绿灯"，
 * 比不筛还危险。所以这里钉住三件事：
 *   ① 引用抽取真的抓得到三类写法：静态 import、`import(new URL('../x.mjs', …))`、`path.join(REPO,'a','b.mjs')`
 *      （第二类曾整类漏掉：`cli-worker-resilience.test.mjs` 就是这么引用 cli-worker 的）
 *   ② 枢纽（被很多测试直接引用的模块）**不被展开**，但"改枢纽的直接依赖"会做一跳放大
 *   ③ 保守规则永远成立：没有归属的源码改动 / 全局文件 / 选中比例过高 → **回退全量**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const MOD = pathToFileURL(
  path.join(REPO, 'crosspost-runtime', 'src', 'scripts', 'scoped-tests.mjs'),
).href
const tool = await import(MOD)

// 夹具必须**放在仓库内**：`directRefs()` 只保留仓库内的引用（那是防误报的一道闸），
// 放 /tmp 会让所有引用都被过滤掉、测试变成假绿。`.local/` 已在 .gitignore 里。
const boxes = []
function tmpbox(tag) {
  const root = path.join(REPO, '.local', 'tmp-scoped-tests')
  fs.mkdirSync(root, { recursive: true })
  const d = fs.mkdtempSync(path.join(root, `${tag}-`))
  boxes.push(d)
  return d
}
process.on('exit', () => {
  for (const d of boxes) fs.rmSync(d, { recursive: true, force: true })
})

test('① 引用抽取：静态 import / import(new URL(…)) / path.join(…) 三类都要抓到', () => {
  const dir = tmpbox('refs')
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'b'), { recursive: true })
  for (const f of ['a/one.mjs', 'a/two.mjs', 'b/three.mjs']) {
    fs.writeFileSync(path.join(dir, f), '// x\n')
  }
  const t = path.join(dir, 'a', 'probe.test.mjs')
  fs.writeFileSync(
    t,
    [
      `import { x } from './one.mjs'`,
      `const m = await import(new URL('./two.mjs', import.meta.url).href)`,
      `const p = path.join(${JSON.stringify(dir)}, 'b', 'three.mjs')`,
    ].join('\n'),
  )
  const refs = tool.directRefs(t)
  const names = refs.map((r) => path.relative(dir, r)).sort()
  assert.deepEqual(names, ['a/one.mjs', 'a/two.mjs', 'b/three.mjs'])
})

test('② 枢纽不被展开：闭包停在枢纽，但仍记录枢纽自己', () => {
  const dir = tmpbox('hubs')
  const hub = path.join(dir, 'hub.mjs')
  const leaf = path.join(dir, 'leaf.mjs')
  fs.writeFileSync(leaf, '// leaf\n')
  fs.writeFileSync(hub, `import './leaf.mjs'\n`)
  const t = path.join(dir, 't.test.mjs')
  fs.writeFileSync(t, `import './hub.mjs'\n`)

  const withHub = tool.closureOf(t, { hubs: new Set([hub]) })
  assert.ok(withHub.has(hub), '枢纽自己必须在集合里（改了它就该选中引用它的测试）')
  assert.ok(!withHub.has(leaf), '枢纽的依赖不再展开（否则 cli.mjs 会把全世界拉进来）')

  const noHub = tool.closureOf(t, { hubs: new Set() })
  assert.ok(noHub.has(leaf), '不设枢纽时闭包照常展开')
})

test('③ findHubs：被 ≥ min 个测试直接引用的文件才算枢纽', () => {
  const dir = tmpbox('findhubs')
  const shared = path.join(dir, 'shared.mjs')
  fs.writeFileSync(shared, '// s\n')
  const tests = []
  for (let i = 0; i < 3; i++) {
    const t = path.join(dir, `t${i}.test.mjs`)
    fs.writeFileSync(t, `import './shared.mjs'\n`)
    tests.push(t)
  }
  assert.equal(tool.findHubs(tests, { min: 3 }).has(shared), true)
  assert.equal(tool.findHubs(tests, { min: 4 }).has(shared), false)
})

test('④ selectScoped：保守规则（无归属 / 全局文件 / 比例过高 → 全量）', () => {
  const dir = tmpbox('select')
  const src = path.join(dir, 'src.mjs')
  const orphan = path.join(dir, 'orphan.mjs')
  const testA = path.join(dir, 'a.test.mjs')
  const testB = path.join(dir, 'b.test.mjs')
  fs.writeFileSync(src, '// s\n')
  fs.writeFileSync(orphan, '// o\n')
  fs.writeFileSync(testA, '// a\n')
  fs.writeFileSync(testB, '// b\n')

  const unit = [testA, testB]
  const map = new Map([
    [testA, new Set([testA, src])],
    [testB, new Set([testB])],
  ])

  const hit = tool.selectScoped([src], map, { unit, smoke: [], coreUnit: [] })
  assert.equal(hit.full, false)
  assert.deepEqual(hit.selected, [testA])

  const noOwner = tool.selectScoped([orphan], map, { unit, smoke: [], coreUnit: [] })
  assert.equal(noOwner.full, true, '没有被任何测试引用的源码改动必须回退全量')
  assert.match(noOwner.reasons.join(' '), /没有被任何测试引用/)

  const global = tool.selectScoped([path.join(REPO, 'package.json')], map, {
    unit,
    smoke: [],
    coreUnit: [],
  })
  assert.equal(global.full, true, 'package.json 这类全局文件必须回退全量')

  const almostAll = tool.selectScoped(
    [src],
    new Map([
      [testA, new Set([testA, src])],
      [testB, new Set([testB, src])],
    ]),
    {
      unit,
      smoke: [],
      coreUnit: [],
    },
  )
  assert.equal(almostAll.full, true, '选中比例 ≥70% 时不如直接跑全量')
})

test('⑤ selectScoped：小枢纽的直接依赖改动会做一跳放大，大枢纽只提示', () => {
  const dir = tmpbox('amplify')
  const mk = (n) => {
    const p = path.join(dir, n)
    fs.writeFileSync(p, '// x\n')
    return p
  }
  const dep = mk('dep.mjs')
  const smallHub = mk('small-hub.mjs')
  const bigHub = mk('big-hub.mjs')
  const t1 = mk('t1.test.mjs') // 引用 smallHub
  const t2 = mk('t2.test.mjs') // 引用 bigHub
  const t3 = mk('t3.test.mjs') // 也引用 bigHub
  const t4 = mk('t4.test.mjs') // 也引用 bigHub
  const unit = [t1, t2, t3, t4]
  const map = new Map([
    [t1, new Set([t1, smallHub])],
    [t2, new Set([t2, bigHub])],
    [t3, new Set([t3, bigHub])],
    [t4, new Set([t4, bigHub])],
  ])
  const hubs = new Set([smallHub, bigHub])
  const hubDependents = new Map([
    [smallHub, [t1]],
    [bigHub, [t2, t3, t4]],
  ])
  const hubDirectImports = new Map([
    [smallHub, new Set([dep])],
    [bigHub, new Set([dep])],
  ])

  // 改 dep：小枢纽（1 个引用测试）放大；大枢纽（3 个 > amplifyMax=2）只提示
  const r = tool.selectScoped([dep], map, {
    unit,
    smoke: [],
    coreUnit: [],
    hubs,
    hubDependents,
    hubDirectImports,
    amplifyMax: 2,
  })
  assert.deepEqual(r.selected, [t1], '小枢纽的引用测试应被带上')
  assert.equal(r.tooWide.length, 1, '大枢纽只提示、不放大')
  assert.match(r.tooWide[0].hub, /big-hub/)
  assert.equal(r.full, false)
})

test('⑥ 工具自身的入口守卫 + core 测试能被发现（两个都踩过）', async () => {
  // 入口守卫：import 本模块不能触发"跑测试"（否则任何 import 都会跑一遍全量）
  const src = fs.readFileSync(
    path.join(REPO, 'crosspost-runtime', 'src', 'scripts', 'scoped-tests.mjs'),
    'utf8',
  )
  assert.match(src, /const isEntry/, '必须有入口守卫（否则一 import 就跑全量）')
  assert.match(src, /if \(isEntry\) main\(\)/, '只有作为入口才执行 main()')

  const { coreUnit } = tool.enumerateTests()
  assert.ok(
    coreUnit.length > 0,
    'core 的 __tests__ 目录不能被跳过（曾经当成内部目录跳掉，core 测试数=0）',
  )
  assert.ok(
    coreUnit.every((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx')),
    'core 测试应只含 *.test.ts(x)',
  )
})
