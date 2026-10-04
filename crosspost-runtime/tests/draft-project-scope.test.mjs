/**
 * 「草稿属于哪个项目」决定簿记写进哪个域（v2.106）
 *
 * ## 这条测试守的是真实事故
 *
 * 2026-09-22 21:45–21:53：一个**没有项目上下文**的会话（GUI 的 web 预设没有
 * `CROSSPOST_PROJECT`）用绝对路径发布了**接入方项目目录**里的 3 篇草稿。
 * 发布是真的（已进微信草稿箱、通知已发），但记录写进了**默认域** ——
 * 默认域显示"已发布"、项目域显示"草稿"，Console 默认视图多了 3 行不属于它的文章。
 *
 * 判据（可证伪）：**写操作按草稿归属纠正域，读操作继续跟随上下文**。
 *
 * ## 为什么这么测
 *
 * · 全部在**临时沙箱**里：项目根、引擎 localRoot、paths.json / config.json 都是临时的，
 *   生产簿记与真实 drafts 一个字节都不碰。
 * · 走的是 `cli.mjs`（真入口，`main()` 与 IPC 共用 `dispatch()`），不是内部函数 ——
 *   否则测不出"入口有没有接上"这一层（v2.92 的教训：单测全绿、接线是断的）。
 * · `markPublished` / `updateDraft` 是**零网络**的写路径（不渲染、不派发、不通知），
 *   所以这条测试可以在离线的 CI 里跑。
 *
 * 假通过检查：把 `cli.mjs` + `project-context.mjs` 换回改前副本，本题①②必失败
 * （记录落在默认域、响应里没有 projectDerived）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
const CLI = path.join(RUNTIME, 'src', 'cli.mjs')

const tmpRoots = []
function tmpdir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cp-${tag}-`))
  tmpRoots.push(d)
  return d
}
process.on('exit', () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true })
})

/**
 * 一次性实验台：
 *   <box>/engine/.local            ← 引擎 localRoot（默认域簿记在这里）
 *   <box>/engine/paths.json        ← 指向上面
 *   <box>/engine/config.json       ← projectsDirs 指向项目根
 *   <box>/proj/wechat-ish/
 *     .crosspost/project.json      ← 声明 dataDir: drafts
 *     drafts/<id>.md               ← 项目草稿
 */
function makeBox() {
  const box = tmpdir('draft-scope')
  const engine = path.join(box, 'engine')
  const local = path.join(engine, '.local')
  const proj = path.join(box, 'proj', 'wechat-ish')
  const drafts = path.join(proj, 'drafts')
  fs.mkdirSync(drafts, { recursive: true })
  fs.mkdirSync(path.join(proj, '.crosspost'), { recursive: true })
  fs.mkdirSync(local, { recursive: true })
  fs.writeFileSync(
    path.join(proj, '.crosspost', 'project.json'),
    JSON.stringify(
      {
        id: 'wechat-ish',
        name: '测试用项目',
        manifestVersion: 2,
        dataDir: 'drafts',
        capabilities: { drafts: true },
      },
      null,
      2,
    ),
  )
  const pathsFile = path.join(engine, 'paths.json')
  fs.writeFileSync(
    pathsFile,
    JSON.stringify({
      localRoot: local,
      draftsDir: path.join(local, 'drafts'),
      logsDir: path.join(local, 'logs'),
      historyDir: path.join(local, 'history'),
      articlesDir: path.join(local, 'project-state', '_default', 'articles'),
      projectsDir: path.join(local, 'projects'),
      sessionsDirs: [],
    }),
  )
  const cfgFile = path.join(engine, 'config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ projectsDirs: [path.join(box, 'proj')] }))
  return { box, engine, local, proj, drafts, pathsFile, cfgFile }
}

/** 在沙箱里跑一次 CLI（真入口），返回解析后的 JSON */
function runCli(box, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CROSSPOST_LOCAL_ROOT: box.local,
      CROSSPOST_PATHS: box.pathsFile,
      CROSSPOST_CONFIG: box.cfgFile,
      CROSSPOST_PROJECTS_DIR: path.join(box.box, 'proj'),
      // 兜底：别让测试继承生产里可能存在的项目身份
      CROSSPOST_PROJECT: '',
      CROSSPOST_ARTICLES_DIR: '',
      CROSSPOST_DRAFTS_DIR: '',
    },
  })
  const line =
    String(r.stdout || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .pop() || ''
  try {
    return { code: r.status, out: JSON.parse(line), raw: r.stdout, err: r.stderr }
  } catch {
    return { code: r.status, out: null, raw: r.stdout, err: r.stderr }
  }
}

const defaultStore = (box) => path.join(box.local, 'project-state', '_default', 'articles')
const projectStore = (box) => path.join(box.local, 'project-state', 'wechat-ish', 'articles')
const listJson = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []

function writeDraft(box, id, extra = '') {
  fs.writeFileSync(
    path.join(box.drafts, `${id}.md`),
    `---\ntitle: 测试草稿 ${id}\nslot: noon\ndate: 2026-09-22\n${extra}---\n\n正文\n`,
  )
}

test('① 无项目上下文时，markPublished 按草稿归属写进项目簿记（默认域保持为空）', () => {
  const box = makeBox()
  const id = '2026-09-22-noon-scope-a'
  writeDraft(box, id)
  const req = path.join(box.box, 'req.json')
  fs.writeFileSync(req, JSON.stringify({ id, note: '测试补记' }))

  const r = runCli(box, ['markPublished', req])
  assert.equal(r.code, 0, `CLI 应退出 0：${r.raw} ${r.err}`)
  assert.ok(r.out && !r.out.error, `不应报错：${JSON.stringify(r.out)}`)
  assert.equal(r.out.projectDerived, 'wechat-ish', '响应里应写明这次按归属纠正了域')

  const inProject = listJson(projectStore(box))
  const inDefault = listJson(defaultStore(box))
  assert.deepEqual(inProject, [`${id}.json`], '记录应写进项目簿记')
  assert.deepEqual(inDefault, [], '默认域必须保持为空')
  const rec = JSON.parse(fs.readFileSync(path.join(projectStore(box), `${id}.json`), 'utf8'))
  assert.equal(rec.id, id)
  assert.ok(Array.isArray(rec.history) && rec.history.length > 0, 'history 应已写入')
})

test('② 无项目上下文时，updateDraft 改的是项目里那份草稿（不在默认域另建一份）', () => {
  const box = makeBox()
  const id = '2026-09-22-noon-scope-b'
  writeDraft(box, id)
  const req = path.join(box.box, 'req.json')
  fs.writeFileSync(req, JSON.stringify({ id, title: '改过的标题', markdown: '改过的正文' }))

  const r = runCli(box, ['updateDraft', req])
  assert.equal(r.code, 0, `CLI 应退出 0：${r.raw} ${r.err}`)
  assert.ok(r.out && !r.out.error, `不应报错：${JSON.stringify(r.out)}`)
  assert.equal(r.out.projectDerived, 'wechat-ish')

  const projFile = fs.readFileSync(path.join(box.drafts, `${id}.md`), 'utf8')
  assert.match(projFile, /改过的标题/, '项目里那份草稿应被更新')
  assert.match(projFile, /改过的正文/)
  const stray = path.join(box.local, 'drafts', `${id}.md`)
  assert.equal(fs.existsSync(stray), false, '默认域不该多出一份草稿副本')
  assert.deepEqual(listJson(defaultStore(box)), [], '默认域不得有记录')
  // 注：本用例**不断言**项目簿记里有记录 —— `updateDraft` 的既有语义是
  // "只在记录已存在时同步 title"，改前它在默认域里根本找不到这份草稿（返回"草稿不存在"）。
})

test('③ 已在归属项目上下文里 → 不重复纠正（无 projectDerived）', () => {
  const box = makeBox()
  const id = '2026-09-22-noon-scope-c'
  writeDraft(box, id)
  const req = path.join(box.box, 'req.json')
  fs.writeFileSync(req, JSON.stringify({ id, note: '显式带项目' }))

  const r = runCli(box, ['markPublished', req, '--project=wechat-ish'])
  assert.equal(r.code, 0, `CLI 应退出 0：${r.raw} ${r.err}`)
  assert.ok(r.out && !r.out.error)
  assert.equal(r.out.projectDerived, undefined, '已按显式项目执行，不该再报"纠正"')
  assert.deepEqual(listJson(projectStore(box)), [`${id}.json`])
  assert.deepEqual(listJson(defaultStore(box)), [])
})

test('④ 不属于任何项目的草稿 → 仍然写默认域（不越权搬运）', () => {
  const box = makeBox()
  const id = '2026-09-22-noon-scope-d'
  // 放在默认域的 drafts 目录里，任何项目都没有它
  const defDrafts = path.join(box.local, 'drafts')
  fs.mkdirSync(defDrafts, { recursive: true })
  fs.writeFileSync(
    path.join(defDrafts, `${id}.md`),
    `---\ntitle: 默认域草稿\nslot: noon\ndate: 2026-09-22\n---\n\n正文\n`,
  )
  const req = path.join(box.box, 'req.json')
  fs.writeFileSync(req, JSON.stringify({ id, note: '默认域自己的' }))

  const r = runCli(box, ['markPublished', req])
  assert.equal(r.code, 0, `CLI 应退出 0：${r.raw} ${r.err}`)
  assert.ok(r.out && !r.out.error)
  assert.equal(r.out.projectDerived, undefined, '无归属时不纠正')
  assert.deepEqual(listJson(defaultStore(box)), [`${id}.json`], '默认域草稿记录写默认域')
  assert.deepEqual(listJson(projectStore(box)), [])
})

test('⑤ 读路径不因归属而换域：默认域的列表看不到项目里的草稿', () => {
  const box = makeBox()
  writeDraft(box, '2026-09-22-noon-scope-e')

  const defList = runCli(box, ['listArticles'])
  assert.equal(defList.code, 0)
  assert.deepEqual(
    (defList.out.articles || []).map((a) => a.id),
    [],
    '默认域列表应为空',
  )

  const projList = runCli(box, ['listArticles', '--project=wechat-ish'])
  assert.equal(projList.code, 0)
  assert.deepEqual(
    (projList.out.articles || []).map((a) => a.id),
    ['2026-09-22-noon-scope-e'],
    '项目域列表应看得到',
  )
})

test('⑥ 事故原形：publishArticle 带项目草稿的**绝对路径** + 无项目上下文', () => {
  // 这一条才是 2026-09-22 那 3 条记录的产生方式：
  // 请求直接带 `file: /…/<项目>/drafts/<id>.md`（MCP 的 publish_article 支持 file），
  // 于是**绕过** findDraftFile —— 改前它会顺利用默认域的簿记把项目文章"发布"掉。
  const box = makeBox()
  const id = '2026-09-22-noon-scope-f'
  writeDraft(box, id)
  const req = path.join(box.box, 'req.json')
  fs.writeFileSync(
    req,
    JSON.stringify({
      file: path.join(box.drafts, `${id}.md`),
      platforms: [],
      wechat: false,
      dryRun: true,
    }),
  )

  const r = runCli(box, ['publishArticle', req])
  assert.equal(r.code, 0, `CLI 应退出 0：${r.raw} ${r.err}`)
  assert.ok(r.out && r.out.ok, `发布应成功：${JSON.stringify(r.out).slice(0, 300)}`)
  assert.equal(r.out.projectDerived, 'wechat-ish', '响应应写明按归属纠正了域')
  assert.deepEqual(listJson(projectStore(box)), [`${id}.json`], '记录应进项目簿记')
  assert.deepEqual(listJson(defaultStore(box)), [], '默认域必须保持为空')
  const html = fs.readdirSync(projectStore(box)).filter((f) => f.endsWith('.html'))
  assert.equal(html.length, 1, 'HTML 归档也应落在项目簿记目录（事故里它同样留在了默认域）')
})
