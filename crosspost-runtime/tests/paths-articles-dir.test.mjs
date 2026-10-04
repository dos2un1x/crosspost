/**
 * `paths.json` 的 `articlesDir` 层与优先级（v2.66 / Phase 2b 收尾）
 *
 * ## 为什么会有这一层
 *
 * `articlesDir`（文章库：记录 JSON + 渲染 HTML）此前**只能**用环境变量
 * `CROSSPOST_ARTICLES_DIR` 覆盖，与 `draftsDir`/`logsDir`/`historyDir` 不对称。
 * 而它恰恰是最需要配置的一项：单项目部署下，"默认文章库"事实上就是该项目的
 * 簿记目录——不配的话默认库与项目库两份并存，**谁写谁的**，于是同一篇记录在
 * 两边字段不同（实测：2026-09-19 21:4x，项目侧被抖音推送流程清掉了
 * `douyinCurrent`，默认侧还留着；另一条只出现在项目侧）。
 *
 * ## 为什么顺带加了 `CROSSPOST_PATHS`
 *
 * `paths.json` 此前是**写死的固定路径**：沙箱只能改环境变量、改不了文件，
 * 而这一层只认文件 → 测试没法把它关进临时目录，只能去动生产配置。
 * 这与 v2.47 修掉的 `CROSSPOST_CONFIG` 脑裂同类（tests/config-path-parity.test.mjs）。
 * 现在 `paths.json` 也能重定向，本文件才谈得上"测"。
 *
 * ## 本文件钉三件事
 *   ① paths.json 的 articlesDir 真的生效
 *   ② 环境变量仍压过它（既有优先级不变）
 *   ③ **项目上下文压过两者** —— 项目隔离的底线：配了默认库也不许把某个项目的
 *      记录写进"默认"位置
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
const PID = 'paths-project'

/** 实验台：paths.json / config.json / 项目 manifest / 各兜底目录全在临时目录 */
function makeBox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-paths-articles-'))
  const b = {
    root,
    aliased: path.join(root, 'aliased-articles'),
    envArticles: path.join(root, 'env-articles'),
    drafts: path.join(root, 'drafts'),
    local: path.join(root, 'local'),
    projects: path.join(root, 'projects'),
    projectDataDir: path.join(root, 'project-drafts'),
  }
  for (const d of [b.aliased, b.envArticles, b.drafts, b.projectDataDir])
    fs.mkdirSync(d, { recursive: true })
  fs.mkdirSync(path.join(b.projects, PID, '.crosspost'), { recursive: true })
  fs.writeFileSync(
    path.join(b.projects, PID, '.crosspost', 'project.json'),
    JSON.stringify({
      id: PID,
      name: 'paths articlesDir 测试',
      manifestVersion: 2,
      capabilities: { drafts: true, generate: false },
      dataDir: b.projectDataDir,
    }),
  )
  // 被测对象：paths.json 里把 articlesDir 指向 aliased
  b.pathsFile = path.join(root, 'paths.json')
  fs.writeFileSync(
    b.pathsFile,
    JSON.stringify({ draftsDir: b.drafts, articlesDir: b.aliased, localRoot: b.local }),
  )
  b.config = path.join(root, 'config.json')
  fs.writeFileSync(b.config, JSON.stringify({ schedule: {} }))
  return b
}

/** 跑一次 createDraft，返回记录实际落点（记录由 ensureDraftRecord 写入 getArticlesDir()） */
function createDraft(b, { topic, env }) {
  const req = path.join(b.root, `req-${topic}.json`)
  fs.writeFileSync(
    req,
    JSON.stringify({
      title: 'paths 探针',
      slot: 'tips',
      date: '2099-01-01',
      topic,
      markdown: '正文',
    }),
  )
  const r = spawnSync(process.execPath, [CLI, 'createDraft', req], {
    cwd: RUNTIME,
    encoding: 'utf8',
    env: {
      ...process.env,
      CROSSPOST_PATHS: b.pathsFile,
      CROSSPOST_CONFIG: b.config,
      CROSSPOST_LOCAL_ROOT: b.local,
      CROSSPOST_PROJECTS_DIRS: b.projects,
      // 刻意**不设** CROSSPOST_ARTICLES_DIR / CROSSPOST_DRAFTS_DIR：
      // 这一例要证明"只靠 paths.json 就够"
      ...env,
    },
  })
  assert.equal(r.status, 0, `CLI 退出码非 0：${r.stderr || r.stdout}`)
  const out = (() => {
    try {
      return JSON.parse(r.stdout)
    } catch {
      return {}
    }
  })()
  assert.ok(out.id, `未返回 id：${r.stdout}`)
  const id = out.id
  return {
    id,
    inAliased: fs.existsSync(path.join(b.aliased, `${id}.json`)),
    inEnv: fs.existsSync(path.join(b.envArticles, `${id}.json`)),
    inProject: fs.existsSync(path.join(b.local, 'project-state', PID, 'articles', `${id}.json`)),
    draftInPathsDrafts: fs.existsSync(path.join(b.drafts, `${id}.md`)),
  }
}

test('paths.json 的 articlesDir 生效：不设任何 env 也落到配置目录', () => {
  const b = makeBox()
  const r = createDraft(b, { topic: 'frompaths' })
  assert.ok(r.inAliased, '记录应落在 paths.json 的 articlesDir（此前只能靠 env 覆盖）')
  assert.equal(r.inEnv, false, '未设 env 时不该落到 env 目录')
  assert.equal(r.inProject, false, '无项目上下文时不该落到项目簿记')
  assert.ok(r.draftInPathsDrafts, '草稿应落在 paths.json 的 draftsDir（同一份文件里的另一层）')
})

test('环境变量仍压过 paths.json（既有优先级不变）', () => {
  const b = makeBox()
  const r = createDraft(b, { topic: 'envwins', env: { CROSSPOST_ARTICLES_DIR: b.envArticles } })
  assert.ok(r.inEnv, 'CROSSPOST_ARTICLES_DIR 必须压过 paths.json 的 articlesDir')
  assert.equal(r.inAliased, false, 'env 生效时不该再写配置目录')
})

test('项目上下文压过 env 与 paths.json（项目隔离的底线）', () => {
  const b = makeBox()
  const req = path.join(b.root, 'req-proj.json')
  fs.writeFileSync(
    req,
    JSON.stringify({
      title: 'paths 探针',
      slot: 'tips',
      date: '2099-01-01',
      topic: 'projwins',
      markdown: '正文',
    }),
  )
  const r = spawnSync(process.execPath, [CLI, `--project=${PID}`, 'createDraft', req], {
    cwd: RUNTIME,
    encoding: 'utf8',
    env: {
      ...process.env,
      CROSSPOST_PATHS: b.pathsFile,
      CROSSPOST_CONFIG: b.config,
      CROSSPOST_LOCAL_ROOT: b.local,
      CROSSPOST_PROJECTS_DIRS: b.projects,
      // 两个"默认库"来源都设上，看项目上下文能不能同时压过它们
      CROSSPOST_ARTICLES_DIR: b.envArticles,
    },
  })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.ok(out.id, r.stdout)
  const inProject = fs.existsSync(
    path.join(b.local, 'project-state', PID, 'articles', `${out.id}.json`),
  )
  assert.ok(inProject, '指定项目时，记录必须写进该项目簿记，不能被默认库截胡')
  assert.equal(
    fs.existsSync(path.join(b.envArticles, `${out.id}.json`)),
    false,
    '项目隔离必须压过 CROSSPOST_ARTICLES_DIR',
  )
  assert.equal(
    fs.existsSync(path.join(b.aliased, `${out.id}.json`)),
    false,
    '项目隔离必须压过 paths.json 的 articlesDir',
  )
})

test('paths.json 未配 articlesDir 时保持历史默认（<runtime>/articles），不引入行为变化', () => {
  const b = makeBox()
  // 重写一份**没有** articlesDir 的 paths.json
  const noArticles = path.join(b.root, 'paths-noarticles.json')
  fs.writeFileSync(noArticles, JSON.stringify({ draftsDir: b.drafts, localRoot: b.local }))
  const req = path.join(b.root, 'req-legacy.json')
  fs.writeFileSync(
    req,
    JSON.stringify({
      title: 'paths 探针',
      slot: 'tips',
      date: '2099-01-01',
      topic: 'legacy',
      markdown: '正文',
    }),
  )
  // 用子进程读一次解析结果（不写任何东西）：打印 getArticlesDir()
  const r = spawnSync(
    process.execPath,
    [
      '-e',
      'import(process.argv[1]).then(m => process.stdout.write(m.getArticlesDir()))',
      path.join(RUNTIME, 'src', 'articles.mjs'),
    ],
    {
      cwd: RUNTIME,
      encoding: 'utf8',
      env: {
        ...process.env,
        CROSSPOST_PATHS: noArticles,
        CROSSPOST_CONFIG: b.config,
        CROSSPOST_LOCAL_ROOT: b.local,
        CROSSPOST_PROJECTS_DIRS: b.projects,
      },
    },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.equal(
    r.stdout.trim(),
    path.join(RUNTIME, 'articles'),
    '未配置时必须逐字退回历史默认（向后兼容铁律）',
  )
})
