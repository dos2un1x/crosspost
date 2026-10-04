// 内容域备份：**每个域各自打包、各自保留 30 份**（v2.74）
//
// ## 为什么需要它
//
// v2.74 把默认域与项目域彻底分开：默认域 = 引擎自有的空域
// （`.local/drafts` + `.local/project-state/_default/articles`），项目域 =
// 写作项目自己的（manifest `dataDir` + `<localRoot>/project-state/<id>/articles`）。
//
// 而备份此前只认"默认域"：`getArticlesDir()` + `paths.draftsDir`。别名还在时它恰好
// 等于项目域，所以**每日备份看上去覆盖了真数据**；别名一撤，同样的代码就会
// 静默变成"每天备份一个空目录"——没有人会收到报错，只是**以为有备份而已**。
//
// 这个文件钉三件事：
//   ① 默认域与项目域**各产出一个包**，且包内只含本域的文件（不串味、不互为子集）
//   ② 保留策略是**按域独立**的（一个域的包数不会挤掉另一个域的额度）
//   ③ 若两个域解析到**同一物理目录**（v2.74 之前的别名接线），只备份一次——
//      否则同目录会产出两份包并互相挤占额度
//
// ## 零副作用
//
// 全部在临时目录里跑：`CROSSPOST_CONFIG`（否则本机 `projectsDirs` 会漏进来）、
// `CROSSPOST_PATHS`、`CROSSPOST_LOCAL_ROOT`、`CROSSPOST_PROJECTS_DIRS` 四个变量
// 把项目根、引擎簿记、默认域一起关进同一个临时目录，结束即删。
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
const BACKUP_MOD = path.join(REPO, 'bridge', 'backup.mjs')
const PID = 'bk-proj'

/** 一次性实验台：默认域、项目域、登记表、机器配置全在临时目录里 */
function makeBox({ aliasDefaultToProject = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-backup-domains-'))
  const b = {
    root,
    local: path.join(root, 'local'),
    projects: path.join(root, 'projects'),
    config: path.join(root, 'config.json'),
    pathsFile: path.join(root, 'paths.json'),
    defaultDrafts: path.join(root, 'default-drafts'),
    defaultArticles: path.join(root, 'default-articles'),
    projDrafts: path.join(root, 'proj-drafts'),
    projStore: path.join(root, 'local', 'project-state', PID, 'articles'),
  }
  fs.mkdirSync(path.join(b.projects, PID, '.crosspost'), { recursive: true })
  fs.writeFileSync(
    path.join(b.projects, PID, '.crosspost', 'project.json'),
    JSON.stringify({
      id: PID,
      name: '备份域测试项目',
      manifestVersion: 2,
      capabilities: { drafts: true, generate: false },
      dataDir: b.projDrafts,
    }),
  )
  // 隔离机器配置：本机 config.json 里 projectsDirs 指向写作项目（v2.55 踩过）
  fs.writeFileSync(b.config, JSON.stringify({ schedule: {} }))
  fs.writeFileSync(
    b.pathsFile,
    JSON.stringify({
      localRoot: b.local,
      draftsDir: b.defaultDrafts,
      // 别名接线（v2.74 之前）：默认域记录目录 == 项目域记录目录
      articlesDir: aliasDefaultToProject ? b.projStore : b.defaultArticles,
      logsDir: path.join(root, 'logs'),
      historyDir: path.join(root, 'history'),
      topicPoolFile: path.join(root, 'history', 'topic-pool.json'),
    }),
  )
  for (const d of [b.defaultDrafts, b.defaultArticles, b.projDrafts, b.projStore])
    fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(b.defaultArticles, 'default-only.json'), '{"id":"default-only"}')
  fs.writeFileSync(path.join(b.defaultDrafts, 'default-only.md'), '# 默认域草稿\n')
  fs.writeFileSync(path.join(b.projStore, 'proj-only.json'), '{"id":"proj-only"}')
  fs.writeFileSync(path.join(b.projDrafts, 'proj-only.md'), '# 项目域草稿\n')
  return b
}

const envFor = (b) => ({
  ...process.env,
  CROSSPOST_CONFIG: b.config,
  CROSSPOST_PATHS: b.pathsFile,
  CROSSPOST_LOCAL_ROOT: b.local,
  CROSSPOST_PROJECTS_DIRS: b.projects,
})

/** 在子进程里跑 `backupArticles()`（真实 tar，真实保留策略），回吐 JSON */
function runBackup(b) {
  const script = `
    import { backupArticles } from ${JSON.stringify(BACKUP_MOD)}
    const r = await backupArticles()
    process.stdout.write(JSON.stringify(r))
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    encoding: 'utf8',
    env: envFor(b),
    timeout: 60000,
  })
  assert.equal(r.status, 0, `备份子进程退出码非 0：${r.stderr || r.stdout}`)
  return JSON.parse(r.stdout)
}

/** 列出 tar 包内的条目（相对路径） */
function tarEntries(file) {
  const r = spawnSync('/usr/bin/tar', ['-tzf', file], { encoding: 'utf8' })
  assert.equal(r.status, 0, `tar -tzf 失败：${r.stderr}`)
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

test('两个内容域各出一个包，包内只有本域文件', () => {
  const b = makeBox()
  try {
    const r = runBackup(b)
    assert.equal(r.ok, true, `备份应成功：${JSON.stringify(r.domains)}`)
    assert.deepEqual(
      r.domains.map((d) => d.id).sort(),
      ['default', PID].sort(),
      '默认域与项目域都必须被备份到',
    )
    assert.equal(r.files.length, 2, `应产出 2 个包，实际 ${r.files.length}`)

    const def = r.domains.find((d) => d.id === 'default')
    const proj = r.domains.find((d) => d.id === PID)
    const defEntries = tarEntries(def.file)
    const projEntries = tarEntries(proj.file)

    assert.ok(
      defEntries.some((e) => e.endsWith('default-only.json')),
      `默认域的包应含默认域记录：${defEntries.join(',')}`,
    )
    assert.ok(
      defEntries.some((e) => e.endsWith('default-only.md')),
      `默认域的包应含默认域草稿：${defEntries.join(',')}`,
    )
    assert.ok(
      projEntries.some((e) => e.endsWith('proj-only.json')),
      `项目域的包应含项目域记录：${projEntries.join(',')}`,
    )
    assert.ok(
      projEntries.some((e) => e.endsWith('proj-only.md')),
      `项目域的包应含项目域草稿：${projEntries.join(',')}`,
    )
    // 不串味：项目域的正文不能出现在默认域的包里，反之亦然
    assert.ok(!defEntries.some((e) => e.includes('proj-only')), '默认域的包不应含项目域文件')
    assert.ok(!projEntries.some((e) => e.includes('default-only')), '项目域的包不应含默认域文件')
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('保留策略按域独立：项目域裁到 30，不影响默认域', () => {
  const b = makeBox()
  try {
    // 项目域预置 35 个旧包（默认域一个都不预置）
    const projBackupDir = path.join(path.dirname(b.projStore), 'backups')
    fs.mkdirSync(projBackupDir, { recursive: true })
    for (let i = 0; i < 35; i++)
      fs.writeFileSync(
        path.join(projBackupDir, `articles-2026-01-01-00-00-${String(i).padStart(2, '0')}.tar.gz`),
        'x',
      )

    const r = runBackup(b)
    assert.equal(r.ok, true, `备份应成功：${JSON.stringify(r.domains)}`)

    const projCount = fs
      .readdirSync(projBackupDir)
      .filter((f) => f.startsWith('articles-') && f.endsWith('.tar.gz')).length
    assert.equal(projCount, 30, `项目域应保留 30 份，实际 ${projCount}`)

    const defBackupDir = path.join(path.dirname(b.defaultArticles), 'backups')
    const defCount = fs
      .readdirSync(defBackupDir)
      .filter((f) => f.startsWith('articles-') && f.endsWith('.tar.gz')).length
    assert.equal(defCount, 1, `默认域不该被项目域的裁剪波及，实际 ${defCount} 份`)
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('两个域指向同一物理目录时只备份一次（别名接线不再重复占额度）', () => {
  const b = makeBox({ aliasDefaultToProject: true })
  try {
    const r = runBackup(b)
    assert.equal(r.ok, true, `备份应成功：${JSON.stringify(r.domains)}`)
    assert.equal(r.domains.length, 1, `同目录只应备份一次，实际 ${r.domains.length} 次`)
    assert.equal(r.files.length, 1)
    // 去重后剩下的是默认域那条（项目域因目录相同被跳过）
    assert.equal(r.domains[0].id, 'default')
    const entries = tarEntries(r.files[0])
    assert.ok(
      entries.some((e) => e.endsWith('proj-only.json')),
      `同目录时应把该目录的内容打包：${entries.join(',')}`,
    )
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('缺失的域被跳过而不是报错（一个域的存在与否不影响另一个）', () => {
  const b = makeBox()
  try {
    // 默认域两个目录都删掉 → 该域 skip，项目域照常
    fs.rmSync(b.defaultArticles, { recursive: true, force: true })
    fs.rmSync(b.defaultDrafts, { recursive: true, force: true })
    const r = runBackup(b)
    assert.equal(r.ok, true, '缺失域不应让整体失败')
    const def = r.domains.find((d) => d.id === 'default')
    const proj = r.domains.find((d) => d.id === PID)
    assert.ok(def && !def.file, `默认域应跳过：${JSON.stringify(def)}`)
    assert.ok(proj && proj.file, `项目域应照常产出：${JSON.stringify(proj)}`)
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('存在但为空的域也跳过：不产出空包、也不建 backups 目录', () => {
  const b = makeBox()
  try {
    // v2.74 的默认域就是"存在但空"：目录在、没内容
    fs.rmSync(path.join(b.defaultArticles, 'default-only.json'))
    fs.rmSync(path.join(b.defaultDrafts, 'default-only.md'))
    const r = runBackup(b)
    assert.equal(r.ok, true)
    const def = r.domains.find((d) => d.id === 'default')
    assert.ok(def && !def.file, `空域应跳过：${JSON.stringify(def)}`)
    assert.ok(!fs.existsSync(path.join(b.root, 'backups')), '空域不应产生 backups 目录')
    const proj = r.domains.find((d) => d.id === PID)
    assert.ok(proj && proj.file, '项目域不应受影响')
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('当日已备份过则不再重复产出（桥每次重启都会调它）', () => {
  const b = makeBox()
  try {
    const projBackupDir = path.join(path.dirname(b.projStore), 'backups')
    fs.mkdirSync(projBackupDir, { recursive: true })
    const now = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const existing = path.join(projBackupDir, `articles-${now}.tar.gz`)
    fs.writeFileSync(existing, 'x')

    const script = `
      import { maybeBackupArticles, getBackupStatus } from ${JSON.stringify(BACKUP_MOD)}
      await maybeBackupArticles()
      process.stdout.write(JSON.stringify(getBackupStatus()))
    `
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO,
      encoding: 'utf8',
      env: envFor(b),
      timeout: 60000,
    })
    assert.equal(r.status, 0, `子进程失败：${r.stderr || r.stdout}`)
    const files = fs
      .readdirSync(projBackupDir)
      .filter((f) => f.startsWith('articles-') && f.endsWith('.tar.gz'))
    assert.deepEqual(files, [path.basename(existing)], `不应产生新包，实际 ${files.join(',')}`)
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})
