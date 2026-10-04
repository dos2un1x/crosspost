// 写作流水线模板「照抄就能用」（开箱即用）
//
// `examples/writing-pipeline-template/` 是**要被人复制走的骨架**，不是给自己看的示例。
// 它一旦腐烂（manifest 过不了校验、脚本产出的草稿引擎解析不出来、README 不再说清
// "改哪几处"），抄它的人会在很远的地方才踩到坑。所以这里把它钉成可执行的契约：
//
//   ① manifest 必须过**真实校验器**（不是手写断言，校验规则只有一份）
//   ② 槽位声明必须过 `validateDeclaration()`
//   ③ README 必须说清"改哪三处"
//   ④ README 指向的 provider 参考实现必须真的在
//   ⑤ `scripts/generate.sh` 产出的草稿必须能被引擎解析（id/日期/栏目/标题全中）
//
// 第⑤条是重点：它把"模板产出的草稿格式是引擎认的"变成机器保证——自定义栏目
// （`weekly`）也必须被解析成 `weekly`，而不是掉进 `manual`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { validateManifest } from '../src/projects.mjs'
import { validateDeclaration } from '../src/scheduler/spec.mjs'
import { parseDraftFile } from '../src/articles.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const TEMPLATE = path.join(REPO, 'examples', 'writing-pipeline-template')

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(TEMPLATE, rel), 'utf8'))
const readText = (rel) => fs.readFileSync(path.join(TEMPLATE, rel), 'utf8')

test('模板①：项目注册能过引擎的 manifest 校验', () => {
  const raw = readJson('.crosspost/project.json')
  const v = validateManifest(raw, path.join(TEMPLATE, '.crosspost', 'project.json'))
  assert.deepEqual(v.errors, [], `模板 manifest 过不了校验（抄它的人第一步就会卡住）：${v.errors}`)
  assert.equal(raw.id, 'my-pipeline', 'id 必须是让使用者一眼知道要改的占位值')
})

test('模板②：槽位声明能过声明的校验', () => {
  const raw = readJson('.crosspost/schedule.json')
  const v = validateDeclaration(raw, {
    projectRoot: TEMPLATE,
    sourcePath: path.join(TEMPLATE, '.crosspost', 'schedule.json'),
  })
  assert.deepEqual(v.errors, [], `模板槽位声明过不了校验：${v.errors}`)
  // 模板演示的正是"自定义栏目"——内建 6 个栏目之外的名字
  assert.ok(Object.keys(v.slots).includes('weekly'), '模板应当演示一个自定义栏目')
})

test('模板③：README 说清"改哪三处"', () => {
  const md = readText('README.md')
  assert.match(md, /改三处/, '模板 README 必须有一节明确"改三处"，否则抄的人不知道从哪下手')
  for (const must of ['project.json', 'schedule.json', 'SKILL.md'])
    assert.ok(md.includes(must), `模板 README 没提到 ${must}（它是必须改的那三处之一）`)
})

test('模板④：README 指向的 provider 参考实现都在', () => {
  const md = readText('README.md')
  const dir = TEMPLATE
  const refs = [...new Set([...md.matchAll(/\]\((\.\.\/[^)\s]+)\)/g)].map((m) => m[1]))]
  assert.ok(
    refs.length > 0,
    'README 里没有指向参考实现的相对路径——它必须告诉读者 provider 不用自己写',
  )
  const missing = refs.filter((rel) => !fs.existsSync(path.resolve(dir, rel)))
  assert.deepEqual(missing, [], `模板 README 指向了不存在的文件：${missing.join('、')}`)
  for (const must of ['../generate-provider-http/server.mjs', '../slot-runner-http/server.mjs'])
    assert.ok(refs.includes(must), `模板 README 必须指向 ${must}（provider 直接复用，不重复实现）`)
})

test('模板⑤：generate.sh 产出的草稿能被引擎解析（自定义栏目不许掉进 manual）', (t) => {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' })
  if (probe.error) {
    t.skip('本机没有 bash')
    return
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-pipeline-template-'))
  const script = path.join(TEMPLATE, 'scripts', 'generate.sh')
  const r = spawnSync('bash', [script, 'weekly', '模板自检'], {
    encoding: 'utf8',
    env: { ...process.env, PIPELINE_DATA_DIR: out },
  })
  assert.equal(r.status, 0, `模板生成器跑失败（抄它的人第一步就跑不通）：${r.stderr}`)

  const files = fs.readdirSync(out).filter((f) => f.endsWith('.md'))
  assert.equal(files.length, 1, `模板生成器应当产出一篇草稿，实际：${files.join('、') || '（无）'}`)

  const p = parseDraftFile(path.join(out, files[0]))
  assert.equal(
    p.slot,
    'weekly',
    '自定义栏目必须被解析出来（掉进 manual 说明栏目判定又变成了白名单）',
  )
  assert.equal(p.title, '模板自检', 'frontmatter 的 title 要能被解析')
  assert.match(p.date || '', /^\d{4}-\d{2}-\d{2}$/, '文件名里的日期段要能被解析')
  assert.ok(p.topic && p.topic !== files[0], '主题段要能被解析出来')

  fs.rmSync(out, { recursive: true, force: true })
})
