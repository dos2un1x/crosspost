// 项目级资源解析（v2.76）：选题库 / 编辑记忆 / 日志 必须**跟着项目走**
//
// ## 为什么需要它
//
// 内容域（草稿 + 文章记录）从 v2.22/v2.74 起就按项目解析，但周边资源一直是全局的：
// `paths.json` 的 `logsDir` / `historyDir` / `topicPoolFile` 是**单份**机器配置。
// 于是"换个项目"只换了草稿与记录，选题库、编辑记忆、日志仍然指向同一个地方——
// 多项目下互相串味，而 Console 里切项目完全看不出来。
//
// v2.76 的规则：资源跟着**内容工作区**走（= manifest `dataDir` 的父目录）：
//   · 项目域：`<工作区>/history`（选题库 / 编辑记忆 / 日历状态 / 选题库备份）、`<工作区>/logs`
//   · 默认域：env > `paths.json` > 内置默认（与内容域同一套优先级）
//
// 对任何接入项目而言 `<工作区>` 就是它自己的项目目录，所以**迁移量为零**；
// 本文件用两个沙箱项目钉住"互不相同、且项目压过 env"。
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

function makeBox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-resources-'))
  const b = {
    root,
    local: path.join(root, 'local'),
    projects: path.join(root, 'projects'),
    config: path.join(root, 'config.json'),
    pathsFile: path.join(root, 'paths.json'),
    defaultHistory: path.join(root, 'default-history'),
    defaultLogs: path.join(root, 'default-logs'),
    defaultPool: path.join(root, 'default-pool', 'topic-pool.json'),
  }
  fs.writeFileSync(b.config, JSON.stringify({ schedule: {} }))
  fs.writeFileSync(
    b.pathsFile,
    JSON.stringify({
      localRoot: b.local,
      logsDir: b.defaultLogs,
      historyDir: b.defaultHistory,
      topicPoolFile: b.defaultPool,
    }),
  )
  for (const d of [b.defaultHistory, b.defaultLogs, path.dirname(b.defaultPool)])
    fs.mkdirSync(d, { recursive: true })

  // pa：相对 dataDir（工作区 = <projects>/pa）
  const writeProject = (id, dataDir) => {
    const dir = path.join(b.projects, id)
    fs.mkdirSync(path.join(dir, '.crosspost'), { recursive: true })
    fs.mkdirSync(path.resolve(dir, dataDir), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.crosspost', 'project.json'),
      JSON.stringify({
        id,
        name: `资源测试项目 ${id}`,
        manifestVersion: 2,
        capabilities: { drafts: true, generate: false },
        dataDir,
      }),
    )
  }
  writeProject('pa', 'drafts')
  // pb：**绝对** dataDir（工作区 = 它的父目录），覆盖"沙箱型项目"这一路
  b.pbWorkspace = path.join(root, 'absolute', 'pb-workspace')
  writeProject('pb', path.join(b.pbWorkspace, 'drafts'))
  return b
}

const envFor = (b) => ({
  ...process.env,
  CROSSPOST_CONFIG: b.config,
  CROSSPOST_PATHS: b.pathsFile,
  CROSSPOST_LOCAL_ROOT: b.local,
  CROSSPOST_PROJECTS_DIRS: b.projects,
  CROSSPOST_PROJECTS_DIR: b.projects,
  // env 层刻意也指到默认域：用来证明"项目上下文压过 env"
  CROSSPOST_HISTORY_DIR: b.defaultHistory,
  CROSSPOST_LOGS_DIR: b.defaultLogs,
  CROSSPOST_TOPIC_POOL: b.defaultPool,
})

/** 在子进程里跑一段脚本并解析它输出的 JSON（避免污染本进程的模块级缓存） */
function runInChild(b, script) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    encoding: 'utf8',
    env: envFor(b),
    timeout: 60000,
  })
  assert.equal(r.status, 0, `子进程失败：${r.stderr || r.stdout}`)
  return JSON.parse(r.stdout)
}

test('两个项目的资源互不相同，且都落在各自的内容工作区下', () => {
  const b = makeBox()
  try {
    const out = runInChild(
      b,
      `
      import { resolveResources } from ${JSON.stringify(path.join(RUNTIME, 'src', 'resources.mjs'))}
      const pa = resolveResources('pa')
      const pb = resolveResources('pb')
      process.stdout.write(JSON.stringify({ pa, pb }))
      `,
    )
    assert.equal(out.pa.workspace, path.join(b.projects, 'pa'))
    assert.equal(out.pa.topicPoolFile, path.join(b.projects, 'pa', 'history', 'topic-pool.json'))
    assert.equal(
      out.pa.editorialMemoryFile,
      path.join(b.projects, 'pa', 'history', 'editorial-memory.json'),
    )
    assert.equal(out.pa.logsDir, path.join(b.projects, 'pa', 'logs'))

    // 绝对 dataDir 的项目：工作区 = dataDir 的父目录
    assert.equal(out.pb.workspace, b.pbWorkspace)
    assert.equal(out.pb.topicPoolFile, path.join(b.pbWorkspace, 'history', 'topic-pool.json'))

    for (const key of ['topicPoolFile', 'editorialMemoryFile', 'logsDir', 'historyDir'])
      assert.notEqual(out.pa[key], out.pb[key], `两个项目的 ${key} 必须不同`)
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('项目上下文压过 env：env 再也指不动项目内的资源', () => {
  const b = makeBox()
  try {
    const out = runInChild(
      b,
      `
      import { withProject } from ${JSON.stringify(path.join(RUNTIME, 'src', 'project-context.mjs'))}
      import { getTopicPoolFile, getHistoryDir, getLogsDir, getEditorialMemoryPath }
        from ${JSON.stringify(path.join(RUNTIME, 'src', 'resources.mjs'))}
      const inPa = withProject('pa', () => ({
        pool: getTopicPoolFile(), history: getHistoryDir(), logs: getLogsDir(), mem: getEditorialMemoryPath(),
      }))
      const noCtx = { pool: getTopicPoolFile(), history: getHistoryDir(), logs: getLogsDir(), mem: getEditorialMemoryPath() }
      process.stdout.write(JSON.stringify({ inPa, noCtx }))
      `,
    )
    // 项目内：全部落在 <工作区> 下，env（指向 default-*）失效
    assert.equal(out.inPa.pool, path.join(b.projects, 'pa', 'history', 'topic-pool.json'))
    assert.equal(out.inPa.logs, path.join(b.projects, 'pa', 'logs'))
    assert.ok(!out.inPa.pool.startsWith(b.root + path.sep + 'default-pool'))
    // 默认域：仍按 env > paths.json
    assert.equal(out.noCtx.pool, b.defaultPool)
    assert.equal(out.noCtx.history, b.defaultHistory)
    assert.equal(out.noCtx.logs, b.defaultLogs)
    assert.equal(out.noCtx.mem, path.join(b.defaultHistory, 'editorial-memory.json'))
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('编辑记忆真的写进项目工作区（不只是解析器自说自话）', () => {
  const b = makeBox()
  try {
    const memFile = path.join(b.projects, 'pa', 'history', 'editorial-memory.json')
    const out = runInChild(
      b,
      `
      import { withProject } from ${JSON.stringify(path.join(RUNTIME, 'src', 'project-context.mjs'))}
      import { pushHumanFeedback, editorialMemoryPath, readEditorialMemory }
        from ${JSON.stringify(path.join(RUNTIME, 'src', 'editorial-memory.mjs'))}
      // 注意：读路径与读内容都必须在**项目上下文内**——上下文外拿到的是默认域那一份
      const res = withProject('pa', () => {
        pushHumanFeedback('topic-delete', { id: 'x1', keyword: 'kw' })
        return { path: editorialMemoryPath(), human: readEditorialMemory().humanFeedback.length }
      })
      process.stdout.write(JSON.stringify(res))
      `,
    )
    assert.equal(out.path, memFile)
    assert.ok(out.human >= 1, '人工反馈应写进项目自己的编辑记忆')
    const onDisk = JSON.parse(fs.readFileSync(memFile, 'utf8'))
    assert.ok(onDisk.humanFeedback.some((x) => x.id === 'x1'))
    // 默认域那一份没被碰
    assert.ok(
      !fs.existsSync(path.join(b.defaultHistory, 'editorial-memory.json')),
      '项目写入不该落到默认域编辑记忆',
    )
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('显式 projectId 优先于上下文；解析不出来则回退默认域（不抛错）', () => {
  const b = makeBox()
  try {
    const out = runInChild(
      b,
      `
      import { withProject } from ${JSON.stringify(path.join(RUNTIME, 'src', 'project-context.mjs'))}
      import { getTopicPoolFile, resolveResources }
        from ${JSON.stringify(path.join(RUNTIME, 'src', 'resources.mjs'))}
      process.stdout.write(JSON.stringify({
        explicitWins: withProject('pa', () => getTopicPoolFile('pb')),
        unknown: withProject('pa', () => getTopicPoolFile('不存在的项目')),
        none: resolveResources('不存在的项目'),
      }))
      `,
    )
    assert.equal(out.explicitWins, path.join(b.pbWorkspace, 'history', 'topic-pool.json'))
    assert.equal(out.unknown, b.defaultPool, '显式 id 解析失败应回退默认域')
    assert.equal(out.none, null)
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('soleProjectId：只有一个合法项目时给 id，0 个或 ≥2 个给空串', () => {
  const b = makeBox()
  try {
    const script = `
      import { soleProjectId } from ${JSON.stringify(path.join(RUNTIME, 'src', 'resources.mjs'))}
      process.stdout.write(JSON.stringify({ id: soleProjectId() }))
    `
    assert.equal(runInChild(b, script).id, '', '两个项目 → 不该猜')
    // 删掉一个 → 只剩 pb
    fs.rmSync(path.join(b.projects, 'pa'), { recursive: true, force: true })
    assert.equal(runInChild(b, script).id, 'pb')
    // 再删掉 → 空
    fs.rmSync(path.join(b.projects, 'pb'), { recursive: true, force: true })
    assert.equal(runInChild(b, script).id, '')
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('doctor 在项目上下文里给出该项目自己的域（无上下文则只有引擎级）', () => {
  const b = makeBox()
  try {
    const CLI = path.join(RUNTIME, 'src', 'cli.mjs')
    const run = (args = []) =>
      JSON.parse(
        spawnSync(process.execPath, [CLI, 'doctor', ...args], {
          cwd: REPO,
          encoding: 'utf8',
          env: envFor(b),
          timeout: 120000,
        }).stdout,
      )
    // 先给 pa 写一个覆盖层：这样 project:config 才该说"覆盖了…"
    const ovFile = path.join(b.local, 'project-state', 'pa', 'config.json')
    fs.mkdirSync(path.dirname(ovFile), { recursive: true })
    fs.writeFileSync(ovFile, JSON.stringify({ schedule: { tips: true } }))
    const scoped = run(['--project=pa'])
    const plain = run()

    // 有项目上下文：带上项目段 + 五条 project:* 检查
    assert.equal(scoped.project && scoped.project.id, 'pa')
    assert.equal(
      scoped.checks.filter((c) => String(c.id).startsWith('project:')).length,
      5,
      '应有一条一条的项目级检查（草稿/簿记/资源/设置/一键生成）',
    )
    assert.ok(
      String(scoped.project.draftsDir).startsWith(b.projects),
      `项目草稿目录应落在沙箱项目里：${scoped.project.draftsDir}`,
    )
    assert.ok(
      String(scoped.project.configFile).startsWith(b.local),
      `项目设置文件应在 localRoot 下：${scoped.project.configFile}`,
    )
    assert.deepEqual(scoped.project.overridden, ['schedule'])
    assert.ok(
      scoped.checks.some((c) => c.id === 'project:config' && /覆盖了/.test(c.detail)),
      '有覆盖层时 detail 应列出覆盖的键',
    )

    // 无上下文：逐字保持引擎级（21 项，无 project 段）
    assert.equal(plain.project, null)
    assert.equal(
      plain.checks.filter((c) => String(c.id).startsWith('project:')).length,
      0,
      '未选项目时不该出现项目级检查',
    )
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})
