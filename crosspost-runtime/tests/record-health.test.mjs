// 记录健康度（`recordHealth`）契约测试（2026-10-08）
//
// ## 这条链此前缺了什么
//
// 管线的**记录写盘会失败**，而失败之后没有任何地方看得出来。实测：`retainArticle` 已经把
// 文件移进 `drafts/rejected/`，但写 `project-state/<项目>/articles/<id>.json.tmp` 报 `EPERM`
// （state 目录在调用方沙箱之外、当时也没有审批通道）。文件走了、账没记，于是下一次
// `scanAndList()` 只按 frontmatter 登记一条骨架：`history: []`、`notify: none`、
// `platforms: {}`，没有 `aiDetect`/`decision`/`review`。Console 的「记录概览」只剩
// 「风险分类 / 质量评分 / 平台推送 0·0·0 / 通知 none」——**看着像"这篇没发过"，
// 实际是"过程没记下来"**，复盘时是两个完全不同的结论，而且当时冒烟全绿、没人发现。
//
// 本文件钉三件事：
//   ① `recordHealth()` 的判据（没 history = empty；有 history = ok）；
//   ② 列表（`scanAndList`）与详情（`getArticle`）**用同一个**派生字段，避免"列表有警告、详情没有"；
//   ③ 记录写失败时 `retainArticle` **不回滚文件移动**，而是把"文件已就位、记录没写、重跑可补录"
//      如实报出来——重跑真的能补录（`findDraftFile` 会到 `rejected/` 子目录里找到它）。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-rechealth-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

/** 沙箱项目：<box>/projects/pa（dataDir 相对 → 工作区 = 项目目录），可放顶层草稿与 rejected/ 稿 */
function makeBox() {
  const root = fs.mkdtempSync(path.join(tmp, 'box-'))
  const projects = path.join(root, 'projects')
  const projDir = path.join(projects, 'pa')
  const config = path.join(root, 'config.json')
  const pathsFile = path.join(root, 'paths.json')
  fs.mkdirSync(path.join(projDir, 'drafts', 'rejected'), { recursive: true })
  fs.mkdirSync(path.join(projDir, '.crosspost'), { recursive: true })
  fs.writeFileSync(
    path.join(projDir, '.crosspost', 'project.json'),
    JSON.stringify({
      id: 'pa',
      name: '记录健康度测试项目',
      manifestVersion: 2,
      capabilities: { drafts: true, generate: false },
      dataDir: 'drafts',
    }),
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

const writeDraft = (box, id, dir = '') => {
  const p = path.join(box.projDir, 'drafts', dir, `${id}.md`)
  fs.writeFileSync(
    p,
    ['---', 'title: 一篇测试稿', 'score: 90', 'risk: none', '---', '', '正文……', ''].join('\n'),
  )
  return p
}
const recordPath = (box, id) =>
  path.join(box.root, 'local', 'project-state', 'pa', 'articles', `${id}.json`)
const run = (box, ...args) =>
  spawnSync(process.execPath, [CLI, ...args, '--project=pa'], {
    cwd: REPO,
    encoding: 'utf8',
    env: box.env,
  })
const runJson = (box, ...args) => {
  const r = run(box, ...args)
  assert.equal(r.status, 0, r.stderr || r.stdout)
  return JSON.parse(r.stdout)
}

const ID = '2026-10-08-tips-rechealth-probe'

test('recordHealth：判据是"有没有 history"（缺失/空数组都是 empty）', async () => {
  const { recordHealth } = await import('../src/articles.mjs')
  assert.deepEqual(recordHealth({ history: [{ action: 'draft-only' }] }), {
    health: 'ok',
    entries: 1,
  })
  assert.deepEqual(recordHealth({ history: [] }), { health: 'empty', entries: 0 })
  assert.deepEqual(recordHealth({}), { health: 'empty', entries: 0 }, '缺字段 = 没有过程记录')
  assert.deepEqual(recordHealth(null), { health: 'empty', entries: 0 })
  // 历史里全是不成功的条目也算 ok：它记下了"发生过什么"，与"没记下来"是两回事
  assert.equal(
    recordHealth({ history: [{ action: 'draft-only', failed: ['zhihu'] }] }).health,
    'ok',
  )
})

test('空骨架登记 → 列表与详情都标 recordHealth=empty（同一个判据）', () => {
  const box = makeBox()
  writeDraft(box, ID) // 只按 frontmatter 扫描登记，没有任何生成/发布过程
  const list = runJson(box, 'listArticles')
  const row = list.articles.find((a) => a.id === ID)
  assert.ok(row, '顶层草稿必须被登记进列表')
  assert.equal(row.recordHealth, 'empty', '没有任何 history → 空骨架')
  assert.ok(!row.history || row.history.length === 0, '此时记录里确实没有过程条目')

  const detail = runJson(box, 'getArticle', ID)
  assert.equal(detail.article.recordHealth, 'empty', '详情与列表必须同判据')
})

test('留存之后 → recordHealth=ok（补上了一次真实处置）', () => {
  const box = makeBox()
  writeDraft(box, ID)
  const out = runJson(box, 'retainArticle', `--id=${ID}`, '--dir=rejected', '--reason=测试留存')
  assert.equal(out.ok, true)
  const rec = JSON.parse(fs.readFileSync(recordPath(box, ID), 'utf8'))
  assert.equal(rec.history.length, 1)
  const detail = runJson(box, 'getArticle', ID)
  assert.equal(detail.article.recordHealth, 'ok')
})

test('记录写失败：文件不回流、错误可执行，重跑即可补录（幂等修复路径）', () => {
  const box = makeBox()
  const draft = writeDraft(box, ID)
  // 把记录目录做成"写不进去"：以同名**目录**占住 <id>.json 的位置 → writeFileSync(.tmp) 成功、
  // rename 到该路径必定失败（EISDIR/ENOTDIR/EPERM），等价复现"文件移走了、记录没写成"。
  const recPath = recordPath(box, ID)
  fs.mkdirSync(path.dirname(recPath), { recursive: true })
  fs.mkdirSync(recPath, { recursive: true })

  const r = run(box, 'retainArticle', `--id=${ID}`, '--dir=rejected', '--reason=测试留存')
  const body = JSON.parse(r.stdout || '{}')
  assert.equal(body.ok, false, `应如实报失败，实际：${r.stdout}`)
  assert.equal(body.fileMoved, true, '必须说明文件已经移动（不是"什么都没发生"）')
  assert.ok(body.recordError, '必须带上底层错误原文，便于判断是权限还是别的原因')
  assert.match(body.error, /需重跑本命令补录/)
  assert.equal(
    fs.existsSync(path.join(box.projDir, 'drafts', 'rejected', `${ID}.md`)),
    true,
    '不回滚文件移动：留存的目的是让它离开自动发布路径',
  )
  assert.equal(fs.existsSync(draft), false)

  // 排掉写入障碍后重跑同一条命令 → 记录补上（findDraftFile 会到 rejected/ 里找到它）
  fs.rmdirSync(recPath)
  const again = runJson(box, 'retainArticle', `--id=${ID}`, '--dir=rejected', '--reason=补录')
  assert.equal(again.ok, true)
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'))
  assert.equal(rec.status, 'retained')
  assert.equal(rec.dir, 'rejected')
  assert.equal(rec.retainedReason, '补录')
  assert.equal(rec.history.filter((h) => h.action === 'retain').length, 1, '失败那次没有写进历史')
})

test('归档同一条纪律：记录写失败时也如实报 fileMoved（不静默）', () => {
  const box = makeBox()
  writeDraft(box, ID)
  const recPath = recordPath(box, ID)
  fs.mkdirSync(path.dirname(recPath), { recursive: true })
  fs.mkdirSync(recPath, { recursive: true })
  const r = run(box, 'archiveArticle', `--id=${ID}`)
  const body = JSON.parse(r.stdout || '{}')
  assert.equal(body.ok, false, `应如实报失败，实际：${r.stdout}`)
  assert.equal(body.fileMoved, true)
  assert.ok(body.recordError)
  assert.equal(fs.existsSync(path.join(box.projDir, 'drafts', 'archive', `${ID}.md`)), true)
})
