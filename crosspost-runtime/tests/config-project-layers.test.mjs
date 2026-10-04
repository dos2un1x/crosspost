// 配置分层（v2.77）：引擎级设置 + 项目级设置
//
// ## 为什么需要它
//
// `config.json` 此前是单份全局文件，把两类东西混在一起：引擎实例属性（代理端口/超时/并发/
// 注册表扫描目录）与**项目属性**（槽位开关、推哪些平台、通知对象、评分阈值、品牌、封面、
// 样式启用清单、生成后自动推送）。多项目下后者必须各自独立，否则 A 项目的设置会作用到 B。
//
// v2.77 规则：
//   · 生效值 = 引擎 `config.json` 深合并 `<localRoot>/project-state/<id>/config.json`
//   · **只有白名单里的项目级键能被覆盖**（未知键一律算引擎级）——所以项目改不动注册表
//   · 默认域（未选项目）= 引擎 config 本身
//
// 本文件钉住：分类、覆盖、不可覆盖（hijack 守卫）、两项目互不影响、写入只落项目级键。
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-cfg-layers-'))
  const b = {
    root,
    local: path.join(root, 'local'),
    projects: path.join(root, 'projects'),
    config: path.join(root, 'config.json'),
  }
  fs.mkdirSync(b.projects, { recursive: true })
  // 引擎配置：含引擎级键与"默认层"的项目级键
  fs.writeFileSync(
    b.config,
    JSON.stringify({
      proxyMode: true,
      proxyHttpPort: 9540,
      concurrency: 3,
      projectsDirs: [b.projects],
      schedule: { tips: false, morning: true },
      notify: { enabled: true, channel: 'lark', larkChatId: 'engine-default' },
      scoring: { threshold: 68 },
      platforms: { default: ['zhihu'] },
    }),
  )
  for (const id of ['pa', 'pb']) {
    const dir = path.join(b.projects, id)
    fs.mkdirSync(path.join(dir, '.crosspost'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'drafts'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.crosspost', 'project.json'),
      JSON.stringify({
        id,
        name: `配置分层项目 ${id}`,
        manifestVersion: 2,
        capabilities: { drafts: true, generate: false },
        dataDir: 'drafts',
      }),
    )
  }
  b.projectConfig = (id) => path.join(b.local, 'project-state', id, 'config.json')
  return b
}

const envFor = (b) => ({
  ...process.env,
  CROSSPOST_CONFIG: b.config,
  CROSSPOST_LOCAL_ROOT: b.local,
  CROSSPOST_PROJECTS_DIRS: b.projects,
  CROSSPOST_PROJECTS_DIR: b.projects,
})

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

const MODS = {
  layers: JSON.stringify(path.join(RUNTIME, 'src', 'config-layers.mjs')),
  cache: JSON.stringify(path.join(RUNTIME, 'src', 'config-cache.mjs')),
  ctx: JSON.stringify(path.join(RUNTIME, 'src', 'project-context.mjs')),
  worker: JSON.stringify(path.join(REPO, 'bridge', 'cli-worker.mjs')),
}

test('分类是白名单：引擎级键不会被写进项目覆盖层', () => {
  const b = makeBox()
  try {
    const out = runInChild(
      b,
      `
      import { classifyKey, splitPatch } from ${MODS.layers}
      const s = splitPatch({
        schedule: { tips: true }, notify: { channel: 'off' },
        proxyHttpPort: 9600, projectsDirs: ['/evil'], 某个未来的键: 1,
      })
      process.stdout.write(JSON.stringify({
        keys: { schedule: classifyKey('schedule'), notify: classifyKey('notify'),
                styles: classifyKey('styles'), autoPush: classifyKey('autoPush'),
                tags: classifyKey('proxyHttpPort'), dirs: classifyKey('projectsDirs'),
                unknown: classifyKey('某个未来的键') },
        engine: Object.keys(s.engine).sort(), project: Object.keys(s.project).sort(),
      }))
      `,
    )
    assert.deepEqual(out.keys, {
      schedule: 'project',
      notify: 'project',
      styles: 'project',
      autoPush: 'project',
      tags: 'engine',
      dirs: 'engine',
      unknown: 'engine',
    })
    assert.deepEqual(out.engine, ['projectsDirs', 'proxyHttpPort', '某个未来的键'])
    assert.deepEqual(out.project, ['notify', 'schedule'])
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('项目覆盖层生效：项目级键被覆盖，引擎级键纹丝不动（hijack 守卫）', () => {
  const b = makeBox()
  try {
    // 手写覆盖层，故意塞进一个引擎级键 projectsDirs —— 它必须被忽略
    fs.mkdirSync(path.dirname(b.projectConfig('pa')), { recursive: true })
    fs.writeFileSync(
      b.projectConfig('pa'),
      JSON.stringify({
        schedule: { tips: true },
        notify: { larkChatId: 'pa-group' },
        platformsDirs: undefined,
        projectsDirs: ['/evil'],
        proxyHttpPort: 9999,
      }),
    )
    const out = runInChild(
      b,
      `
      import { readConfig } from ${MODS.cache}
      import { withProject } from ${MODS.ctx}
      const def = readConfig()
      const pa = withProject('pa', () => readConfig())
      process.stdout.write(JSON.stringify({
        def: { schedule: def.schedule, chat: def.notify.larkChatId, port: def.proxyHttpPort, dirs: def.projectsDirs },
        pa: { schedule: pa.schedule, chat: pa.notify.larkChatId, port: pa.proxyHttpPort, dirs: pa.projectsDirs },
      }))
      `,
    )
    // 项目级：pa 覆盖生效
    assert.equal(out.pa.schedule.tips, true)
    assert.equal(out.pa.schedule.morning, true, '未覆盖的子字段应保留引擎默认')
    assert.equal(out.pa.chat, 'pa-group')
    assert.equal(out.def.schedule.tips, false, '默认域不受项目覆盖影响')
    assert.equal(out.def.chat, 'engine-default')
    // 引擎级：覆盖层里塞了也不生效
    assert.equal(out.pa.port, 9540, 'proxyHttpPort 必须来自引擎文件')
    assert.deepEqual(
      out.pa.dirs,
      [b.projects],
      'projectsDirs 必须来自引擎文件（注册表不可被项目改写）',
    )
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('两个项目的覆盖层互不影响', () => {
  const b = makeBox()
  try {
    const out = runInChild(
      b,
      `
      import { writeProjectConfig } from ${MODS.layers}
      import { readConfig } from ${MODS.cache}
      import { withProject } from ${MODS.ctx}
      writeProjectConfig('pa', { schedule: { tips: true }, notify: { channel: 'off' } })
      writeProjectConfig('pb', { schedule: { morning: false } })
      process.stdout.write(JSON.stringify({
        pa: withProject('pa', () => readConfig()),
        pb: withProject('pb', () => readConfig()),
        def: readConfig(),
      }))
      `,
    )
    assert.equal(out.pa.schedule.tips, true)
    assert.equal(out.pa.schedule.morning, true, 'pa 没动 morning')
    assert.equal(out.pa.notify.channel, 'off')
    assert.equal(out.pb.schedule.morning, false)
    assert.equal(out.pb.schedule.tips, false, 'pb 没动 tips')
    assert.equal(out.pb.notify.channel, 'lark', 'pb 没动通知渠道')
    assert.equal(out.def.schedule.tips, false)
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('writeProjectConfig 丢弃引擎级键并在 ignored 里回报', () => {
  const b = makeBox()
  try {
    const out = runInChild(
      b,
      `
      import { writeProjectConfig, readProjectConfig } from ${MODS.layers}
      const r = writeProjectConfig('pa', { schedule: { tips: true }, proxyHttpPort: 1, projectsDirs: ['/x'] })
      process.stdout.write(JSON.stringify({ r, onDisk: readProjectConfig('pa') }))
      `,
    )
    assert.deepEqual(out.r.ignored.sort(), ['projectsDirs', 'proxyHttpPort'])
    assert.deepEqual(Object.keys(out.onDisk).sort(), ['schedule'])
    assert.equal(out.onDisk.schedule.tips, true)
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('顶层键替换语义：`schedule: {}` 能真正清空项目覆盖，深合并做不到', () => {
  const b = makeBox()
  try {
    const out = runInChild(
      b,
      `
      import { writeProjectConfig, readProjectConfig } from ${MODS.layers}
      writeProjectConfig('pa', { schedule: { tips: true, morning: false } })
      const first = readProjectConfig('pa')
      writeProjectConfig('pa', { schedule: {} })
      process.stdout.write(JSON.stringify({ first, after: readProjectConfig('pa') }))
      `,
    )
    assert.deepEqual(out.first.schedule, { tips: true, morning: false })
    assert.deepEqual(out.after.schedule, {}, '清空必须真的清空（深合并会留下旧值）')
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('writeConfigScoped：项目上下文里只写覆盖层，默认域写引擎文件', () => {
  const b = makeBox()
  try {
    const out = runInChild(
      b,
      `
      import { writeConfigScoped, readEngineConfigFile } from ${MODS.worker}
      import { withProject } from ${MODS.ctx}
      import { readProjectConfig, readEngineConfig } from ${MODS.layers}
      const inProj = withProject('pa', () => writeConfigScoped((cfg) => { cfg.schedule = { tips: true } }))
      const engineAfterProjectWrite = readEngineConfigFile().schedule
      const inDefault = writeConfigScoped((cfg) => { cfg.schedule = { evening: true } })
      process.stdout.write(JSON.stringify({
        inProj, inDefault,
        overlay: readProjectConfig('pa'),
        engineAfterProjectWrite,
        engineNow: readEngineConfig().schedule,
      }))
      `,
    )
    assert.equal(out.inProj.scope, 'project')
    assert.equal(out.inProj.project, 'pa')
    assert.deepEqual(out.overlay.schedule, { tips: true })
    assert.deepEqual(
      out.engineAfterProjectWrite,
      { tips: false, morning: true },
      '项目内的 schedule 改动不该落到引擎 config',
    )
    assert.equal(out.inDefault.scope, 'engine')
    assert.deepEqual(out.engineNow, { evening: true }, '默认域改动写引擎 config')
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('桥侧生效配置与引擎侧一致（readFullRuntimeConfig 也走分层）', () => {
  const b = makeBox()
  try {
    const out = runInChild(
      b,
      `
      import { writeProjectConfig } from ${MODS.layers}
      import { readFullRuntimeConfig } from ${MODS.worker}
      import { withProject } from ${MODS.ctx}
      writeProjectConfig('pa', { schedule: { tips: true }, autoPush: { enabled: true } })
      const pa = withProject('pa', () => readFullRuntimeConfig())
      const def = readFullRuntimeConfig()
      process.stdout.write(JSON.stringify({
        paTips: pa.schedule.tips, paPush: pa.autoPush.enabled, paPort: pa.proxyHttpPort,
        defTips: def.schedule.tips, defPush: !!(def.autoPush && def.autoPush.enabled),
      }))
      `,
    )
    assert.equal(out.paTips, true)
    assert.equal(out.paPush, true)
    assert.equal(out.paPort, 9540)
    assert.equal(out.defTips, false)
    assert.equal(out.defPush, false)
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

test('slotEnabled：定时门禁按**项目**回答（与 Console 同源）', () => {
  const b = makeBox()
  try {
    const out = runInChild(
      b,
      `
      import { writeProjectConfig } from ${MODS.layers}
      import { spawnSync } from 'node:child_process'
      const CLI = ${JSON.stringify(path.join(RUNTIME, 'src', 'cli.mjs'))}
      const run = (slot, args = []) => {
        const r = spawnSync(process.execPath, [CLI, 'slotEnabled', slot, ...args], { encoding: 'utf8' })
        return JSON.parse(r.stdout)
      }
      // 项目覆盖层把 tips 打开、把 morning 关掉（引擎配置里 morning=true、tips=false）
      writeProjectConfig('pa', { schedule: { morning: true, hotspot: false, noon: false, hotspot2: false, tips: true, evening: false } })
      process.stdout.write(JSON.stringify({
        engineTips: run('tips'),
        engineMorning: run('morning'),
        projTips: run('tips', ['--project=pa']),
        projMorning: run('morning', ['--project=pa']),
        unknown: run('不存在的槽位'),
      }))
      `,
    )
    // 默认域（无项目上下文 → 引擎 config）
    assert.equal(out.engineTips.run, false, '引擎配置 tips=false → 不跑')
    assert.equal(out.engineMorning.run, true, '引擎配置 morning 未显式关（true）→ 跑')
    // 项目域：覆盖层说了算
    assert.equal(out.projTips.run, true, '项目覆盖层 tips=true → 跑')
    assert.equal(out.projMorning.run, true, '项目覆盖层 morning=true → 跑')
    assert.equal(out.unknown.error !== undefined, true, '未知槽位要报错而不是默认放行')
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true })
  }
})

/* ────────────────────────── 文档承诺的配置必须有读者 ────────────────────────── */

/** 收集引擎侧源码（定义处排除，否则"定义了就算有人读"）。 */
function sourceFiles() {
  const out = []
  const walk = (dir, depth = 0) => {
    if (depth > 8) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'vendor' || e.name === 'dist') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/\.(mjs|js|ts)$/.test(e.name)) out.push(p)
    }
  }
  walk(path.join(RUNTIME, 'src'))
  walk(path.join(REPO, 'bridge'))
  // `config-layers.mjs` 是**定义处**（白名单与分类规则），不算读者
  return out.filter((f) => path.basename(f) !== 'config-layers.mjs')
}

/**
 * 从 `docs/configuration.md` 的键表里抽出"文档承诺的配置名"。
 *
 * 为什么这么抽：这类缺陷的形状是"文档写了 `styles.perSlot`，而没有任何代码读它"
 * （`labelPrefix` 是同一个病，只是它连文档都没进）。手写一张清单会跟着文档一起漂，
 * 所以直接从文档的**键列与形状列**里取标识符——文档说要有的，代码里就得有人读。
 */
function documentedConfigNames() {
  const md = fs.readFileSync(path.join(REPO, 'docs', 'configuration.md'), 'utf8')
  const names = new Set()
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1)
    if (cells.length < 2) continue
    for (const cell of cells.slice(0, 2)) {
      for (const m of cell.matchAll(/`([^`]+)`/g)) {
        const text = m[1]
        for (const id of text.matchAll(/[A-Za-z][A-Za-z0-9_]{2,}/g)) names.add(id[0])
      }
    }
  }
  return [...names]
}

test('文档承诺的配置名必须有读者（禁止"文档写了、代码里没人读"的死键）', () => {
  const files = sourceFiles()
  assert.ok(files.length > 50, `源码收集异常（只找到 ${files.length} 个文件）`)
  const blobs = files.map((f) => fs.readFileSync(f, 'utf8'))
  const names = documentedConfigNames()
  assert.ok(
    names.includes('perSlot'),
    '没从文档里抽到 `perSlot`——抽取规则或文档结构变了，这条断言会变成空转',
  )
  const dead = names.filter((n) => !blobs.some((b) => b.includes(n)))
  assert.deepEqual(
    dead,
    [],
    `这些配置名在 docs/configuration.md 里承诺了，但引擎/桥的源码里一处都没读：\n  ` +
      dead.join('\n  ') +
      `\n\n要么让配置真的生效，要么把文档里那句承诺删掉。`,
  )
})
