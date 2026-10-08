// 草稿处置（留存/归档）的契约测试
//
// ## 这条链此前缺了什么
//
// 写作侧"放弃低分稿"的动作是**裸 `mv`** 进 `drafts/rejected/`——而 `scanAndList` 只扫
// `drafts/` 顶层，所以这份文件永远不会被登记。后果有两层：
//   · Console 留存库/文章列表里看不到它（记录才是引擎的账）；
//   · `verify:immutable` 把它算成"**未声明的新增**"（它判定"归档/留存类新增"是否合规，
//     看的就是该 id 的**记录**里 `dir ∈ {archive,rejected,risk,calendar}` 或
//     `status ∈ {retained,archived}`）——于是一个正常的落选动作天天报警。
//
// 修法：处置走引擎（`retainArticle`），由它移动 + 落记录；本文件把这条契约钉住，
// 并覆盖"无记录时先按草稿建**完整**记录"（title/slot/date 不能为空）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
const REPO = path.resolve(RUNTIME, '..')
const CLI = path.join(RUNTIME, 'src', 'cli.mjs')

// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-disposition-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

/** 沙箱项目：<box>/projects/pa（工作区=<root>/proj），rejected/ 里放一篇落选稿 */
function makeBox() {
  const root = fs.mkdtempSync(path.join(tmp, 'box-'))
  const projects = path.join(root, 'projects')
  const projDir = path.join(projects, 'pa') // dataDir 是相对的 → 工作区 = 项目目录
  const config = path.join(root, 'config.json')
  const pathsFile = path.join(root, 'paths.json')
  fs.mkdirSync(path.join(projDir, 'drafts', 'rejected'), { recursive: true })
  fs.mkdirSync(path.join(projDir, '.crosspost'), { recursive: true })
  fs.writeFileSync(
    path.join(projDir, '.crosspost', 'project.json'),
    JSON.stringify({
      id: 'pa',
      name: '处置测试项目',
      manifestVersion: 2,
      capabilities: { drafts: true, generate: false },
      dataDir: 'drafts',
    }),
  )
  const draft = path.join(projDir, 'drafts', 'rejected', '2026-10-03-tips-某落选稿.md')
  fs.writeFileSync(
    draft,
    [
      '---',
      'title: 一个被落选的标题',
      'score: 92',
      'risk: unclassified',
      '---',
      '',
      '正文……',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(config, JSON.stringify({ schedule: {} }))
  fs.writeFileSync(
    pathsFile,
    JSON.stringify({
      localRoot: path.join(root, 'local'),
      logsDir: path.join(root, 'logs'),
      historyDir: path.join(root, 'history'),
      topicPoolFile: path.join(root, 'topic-pool.json'),
    }),
  )
  return {
    root,
    projDir,
    draft,
    env: {
      ...process.env,
      CROSSPOST_CONFIG: config,
      CROSSPOST_PATHS: pathsFile,
      CROSSPOST_LOCAL_ROOT: path.join(root, 'local'),
      CROSSPOST_PROJECTS_DIRS: projects,
      CROSSPOST_PROJECT: 'pa',
    },
  }
}

/** 项目级记录目录（引擎按项目解析：<localRoot>/project-state/<id>/articles） */
function recordPath(box, id) {
  return path.join(box.root, 'local', 'project-state', 'pa', 'articles', `${id}.json`)
}

// 直连 CLI 时**项目要显式给 `--project=`**（env 里的 CROSSPOST_PROJECT 是 MCP 服务器那侧
// 转成这个参数用的；一键式 CLI 不看它）——写作侧照抄本文件的调用形状即可。
const run = (box, ...args) =>
  spawnSync(process.execPath, [CLI, ...args, '--project=pa'], {
    cwd: REPO,
    encoding: 'utf8',
    env: box.env,
  })

const ID = '2026-10-03-tips-某落选稿'

test('留存：一行式 --id/--dir/--reason 能落一条完整记录（title/slot/date 不能为空）', () => {
  const box = makeBox()
  const r = run(
    box,
    'retainArticle',
    `--id=${ID}`,
    '--dir=rejected',
    '--reason=相似度去重（同题同角度）',
  )
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.ok, true)
  assert.equal(out.status, 'retained')
  assert.equal(out.dir, 'rejected')

  const rec = JSON.parse(fs.readFileSync(recordPath(box, ID), 'utf8'))
  assert.equal(rec.status, 'retained')
  assert.equal(rec.dir, 'rejected', 'dir 是 verify:immutable 认"已声明新增"的依据')
  assert.equal(rec.title, '一个被落选的标题', '无记录时应先按草稿建记录，而不是手搓空记录')
  assert.equal(rec.date, '2026-10-03')
  assert.equal(rec.slot, 'tips')
  assert.equal(rec.retainedReason, '相似度去重（同题同角度）')
  assert.ok(Array.isArray(rec.history) && rec.history[0].action === 'retain')

  assert.equal(fs.existsSync(box.draft), true, '文件必须还在 rejected/（移动是幂等的）')
})

test('留存：JSON 文件形态仍然可用（与一行式等价）', () => {
  const box = makeBox()
  const reqFile = path.join(box.root, 'req.json')
  fs.writeFileSync(reqFile, JSON.stringify({ id: ID, dir: 'risk', reason: '风险留存' }))
  const r = run(box, 'retainArticle', reqFile)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).dir, 'risk')
  const rec = JSON.parse(fs.readFileSync(recordPath(box, ID), 'utf8'))
  assert.equal(rec.dir, 'risk')
  assert.equal(rec.retainedReason, '风险留存')
})

test('留存：重复执行是幂等的（状态稳定、历史追加而不炸）', () => {
  const box = makeBox()
  for (let i = 0; i < 2; i += 1) {
    const r = run(box, 'retainArticle', `--id=${ID}`, '--dir=rejected', `--reason=第${i + 1}次`)
    assert.equal(r.status, 0, `第 ${i + 1} 次失败：${r.stderr}`)
  }
  const rec = JSON.parse(fs.readFileSync(recordPath(box, ID), 'utf8'))
  assert.equal(rec.status, 'retained')
  assert.equal(rec.dir, 'rejected')
  assert.equal(rec.history.filter((h) => h.action === 'retain').length, 2)
  assert.equal(fs.existsSync(box.draft), true)
})

test('留存：缺 id 时明确报错（不做无声的空操作）', () => {
  const box = makeBox()
  const r = run(box, 'retainArticle', '--dir=rejected')
  const body = JSON.parse(r.stdout || '{}')
  assert.ok(r.status !== 0 || body.error, `应报错，实际：${r.stdout}`)
})

test('id 白名单：接受中文 slug（真实草稿里存在），但拒绝路径穿越/空/点开头', async () => {
  const { assertSafeId } = await import('../src/articles.mjs')
  // 真实存在的两篇中文草稿（drafts/risk/）必须可用，否则引擎对它们做不了任何处置
  for (const ok of ['2026-08-21-noon-柯洁装弱智赢AI', '2026-08-22-evening-诡秘之主', 'a.b-c_1']) {
    assert.equal(assertSafeId(ok), ok)
  }
  for (const bad of ['../x', '..', '.', '__proto__', 'a/b', 'a\\b', 'a b', '', 'x\u0000y']) {
    assert.throws(() => assertSafeId(bad), /非法 articleId/, `应拒绝: ${JSON.stringify(bad)}`)
  }
})
