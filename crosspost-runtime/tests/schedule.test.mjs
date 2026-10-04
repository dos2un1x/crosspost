// 调度域（桥侧薄壳，v2.3）：Console/HTTP 读写接到引擎定时器上
//
// ## 这个文件钉住什么
//
// v2.3 把 launchd 后端整段删掉（plist 生成/学习、launchctl 装卸、命名空间迁移），
// 于是**薄壳的契约**就是新的边界，逐条钉：
//   · `/proxy/schedule` 的字段（Console 与验收都依赖它）
//   · 开关写到**哪一层**：项目槽位 → 项目覆盖层；引擎任务 → 引擎层（即使有项目上下文）
//   · 新增/改名/改时间**不再创建任何系统任务**：命令只能来自项目声明
//   · 删除只删"引擎侧记录"：声明过的槽位与引擎任务都拒绝删除（命令在项目仓库里）
//   · 迁移期只读检测：还留着的旧系统任务必须被报出来（双发的唯一防线）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withProject } from '../src/project-context.mjs'
import { writeProjectConfig } from '../src/config-layers.mjs'
import { legacyDaemons } from '../src/scheduler/legacy.mjs'

const PROJECT = 'proj'

/** 桥侧薄壳（在仓库根的 bridge/ 下；这里是 crosspost-runtime/tests/） */
const SHELL = new URL('../../bridge/schedule.mjs', import.meta.url).href
void fileURLToPath

/** 每个用例一个完整沙箱：引擎配置 + 一个项目（manifest + 声明）+ 调度数据目录 */
function fixture({ declaration = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-shell-'))
  const projectRoot = path.join(root, 'projects', PROJECT)
  fs.mkdirSync(path.join(projectRoot, '.crosspost'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'drafts'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'scripts', 'run_once.sh'), '#!/bin/bash\nexit 0\n')
  fs.writeFileSync(
    path.join(projectRoot, '.crosspost', 'project.json'),
    JSON.stringify({
      id: PROJECT,
      name: 'P',
      manifestVersion: 2,
      capabilities: { drafts: true, schedule: true },
      dataDir: 'drafts',
    }),
  )
  if (declaration)
    fs.writeFileSync(
      path.join(projectRoot, '.crosspost', 'schedule.json'),
      JSON.stringify({
        version: 1,
        slots: {
          hotspot: {
            name: '热点解读①',
            time: '08:30',
            command: ['bash', 'scripts/run_once.sh', 'hotspot'],
          },
          noon: {
            name: '深度分析①',
            time: '12:30',
            command: ['bash', 'scripts/run_once.sh', 'noon'],
          },
        },
      }),
    )
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ projectsDirs: [path.join(root, 'projects')] }),
  )

  const envKeys = [
    'CROSSPOST_CONFIG',
    'CROSSPOST_LOCAL_ROOT',
    'CROSSPOST_PROJECTS_DIRS',
    'CROSSPOST_PROJECTS_DIR',
    'CROSSPOST_SCHEDULER_DIR',
    'CROSSPOST_LEGACY_TASKS_DIR',
    'CROSSPOST_LEGACY_SYSTEMD_DIR',
  ]
  const prev = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]))
  process.env.CROSSPOST_CONFIG = path.join(root, 'config.json')
  process.env.CROSSPOST_LOCAL_ROOT = path.join(root, 'local')
  process.env.CROSSPOST_PROJECTS_DIRS = path.join(root, 'projects')
  process.env.CROSSPOST_PROJECTS_DIR = path.join(root, 'no-default')
  process.env.CROSSPOST_SCHEDULER_DIR = path.join(root, 'scheduler')
  process.env.CROSSPOST_LEGACY_TASKS_DIR = path.join(root, 'agents')
  process.env.CROSSPOST_LEGACY_SYSTEMD_DIR = path.join(root, 'no-systemd')

  return {
    root,
    projectRoot,
    engineConfig: path.join(root, 'config.json'),
    overlay: path.join(root, 'local', 'project-state', PROJECT, 'config.json'),
    declarationFile: path.join(projectRoot, '.crosspost', 'schedule.json'),
    done() {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

test('薄壳①：默认域没有任何槽位（槽位按项目安装；引擎不再自带任务）', async () => {
  const box = fixture()
  try {
    const mod = await import(SHELL)
    const st = await mod.getScheduleStatus()
    assert.equal(st.provider, 'internal')
    assert.equal(st.supported, true)
    assert.equal(st.project, null)
    // 2026-09-25：日历提醒退役后，引擎不再自带任何任务 → 默认域就是空的
    //（不是"没装调度器"，所以仍要给出 backend/tz 这些"定时器还在"的事实）
    assert.deepEqual(st.slots, [])
    assert.equal(st.backend, 'internal')
    assert.equal(typeof st.tz, 'string')
    assert.equal(st.lockHeldByUs, false, '没启动调度器时不该声称持有锁')
    assert.match(st.notes.join(' '), /内置定时器当前不由本进程持有/)
  } finally {
    box.done()
  }
})

test('薄壳②：项目域 —— 声明提供命令，配置提供名称/时间/开关；缺声明的槽位写明缺什么', async () => {
  const box = fixture()
  try {
    writeProjectConfig(PROJECT, {
      slots: [
        { id: 'hotspot', name: '我改的名字', time: '09:05', enabled: true },
        { id: 'legacy-only', name: '历史遗留', time: '07:00' },
      ],
      schedule: { noon: false },
    })
    const mod = await import(SHELL)
    const st = await withProject(PROJECT, () => mod.getScheduleStatus())
    assert.equal(st.project, PROJECT)
    const by = Object.fromEntries(st.slots.map((s) => [s.slot, s]))
    assert.equal(by.hotspot.label, '我改的名字', '显示名（Console 的 label 字段）以配置为权威')
    assert.equal(by.hotspot.time, '09:05')
    assert.equal(by.hotspot.source, 'declaration')
    assert.equal(by.hotspot.commandMissing, false)
    assert.deepEqual(by.hotspot.command[1], path.join(box.projectRoot, 'scripts', 'run_once.sh'))
    assert.equal(by.noon.enabled, false, 'schedule[noon]=false 是唯一"停"的写法')
    assert.equal(by.noon.source, 'declaration')
    assert.equal(by['legacy-only'].source, 'config')
    assert.equal(by['legacy-only'].commandMissing, true)
    assert.match(by['legacy-only'].commandReason, /schedule\.json/)
    assert.ok(by['legacy-only'], '没有命令声明的槽位仍然可见（不能静默消失）')
  } finally {
    box.done()
  }
})

test('薄壳③：开关只写项目覆盖层（引擎侧已不再有任务，引擎层不该被写）', async () => {
  const box = fixture()
  try {
    writeProjectConfig(PROJECT, {
      slots: [{ id: 'hotspot', name: '热点解读①', time: '08:30', enabled: true }],
    })
    const mod = await import(SHELL)
    const r1 = await withProject(PROJECT, () => mod.setScheduleSlot('hotspot', false))
    assert.equal(r1.ok, true)
    assert.equal(readJson(box.overlay).schedule.hotspot, false)
    assert.equal(readJson(box.engineConfig).schedule, undefined, '项目槽位的开关不该落进引擎配置')
    // 同名槽位在两个项目之间必须独立
    assert.equal(readJson(box.overlay).slots.find((s) => s.id === 'hotspot').enabled, false)

    // 2026-09-25：引擎侧任务退役后，默认域里没有任何槽位可开关 ——
    // 曾经的 calendar-remind-am 走"写引擎层"那一支，现在必须是 unknown_slot
    const r2 = await mod.setScheduleSlot('calendar-remind-am', false)
    assert.equal(r2.ok, undefined)
    assert.equal(r2.error, 'unknown_slot')
  } finally {
    box.done()
  }
})

test('薄壳④：upsert 只改名称/时间/开关；没声明命令的槽位被结构化拒绝（给出该写哪一行）', async () => {
  const box = fixture()
  try {
    const mod = await import(SHELL)
    const ok = await withProject(PROJECT, () =>
      mod.upsertScheduleSlot({ id: 'hotspot', name: '新的', time: '6:7', enabled: true }),
    )
    assert.equal(ok.ok, true, JSON.stringify(ok))
    assert.equal(ok.time, '06:07')
    assert.equal(ok.backend, 'internal')
    const overlay = readJson(box.overlay)
    assert.equal(overlay.slots.find((s) => s.id === 'hotspot').time, '06:07')
    assert.equal(overlay.schedule.hotspot, true)

    const bad = await withProject(PROJECT, () =>
      mod.upsertScheduleSlot({ id: 'ghost', name: '幽灵', time: '07:00' }),
    )
    assert.equal(bad.error, 'no_slot_spec')
    assert.match(bad.message, /schedule\.json/)
    assert.equal(bad.declarationFile, box.declarationFile, '必须告诉调用方该改哪个文件')

    const noProject = await mod.upsertScheduleSlot({ id: 'hotspot', name: 'x', time: '07:00' })
    assert.equal(noProject.error, 'no_project_context')
    assert.equal(fs.existsSync(box.declarationFile), true, '引擎不得改动项目声明文件')
  } finally {
    box.done()
  }
})

test('薄壳⑤：删除只删引擎侧记录 —— 声明过的槽位一律拒绝（命令在项目仓库里）', async () => {
  const box = fixture()
  try {
    const mod = await import(SHELL)
    const declared = await withProject(PROJECT, () => mod.removeScheduleSlot('hotspot'))
    assert.equal(declared.error, 'declared_slot_not_removable')
    assert.match(declared.message, /schedule\.json/)

    // 只有"配置里有、项目里没有"的残留槽位删得掉（v2.3 之前留下的历史条目）
    writeProjectConfig(PROJECT, { slots: [{ id: 'stale-slot', name: '历史', time: '07:00' }] })
    const r = await withProject(PROJECT, () => mod.removeScheduleSlot('stale-slot'))
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(
      (readJson(box.overlay).slots || []).some((s) => s.id === 'stale-slot'),
      false,
    )
    assert.ok(fs.existsSync(box.declarationFile), '声明文件原样保留')
  } finally {
    box.done()
  }
})

test('薄壳⑥：迁移期只读检测 —— 还留着的旧系统任务必须被报出来（双发的唯一防线）', async () => {
  const box = fixture()
  try {
    // 真的旧调度任务：有 `StartCalendarInterval`（这正是"会双发"的判据）
    fs.writeFileSync(
      path.join(box.root, 'agents', `com.crosspost.${PROJECT}.hotspot.plist`),
      '<plist><dict><key>Label</key><string>x</string><key>StartCalendarInterval</key>' +
        '<dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>' +
        '</dict></plist>',
    )
    fs.writeFileSync(
      path.join(box.root, 'agents', 'com.crosspost.bridge.plist'),
      '<plist><dict><key>Label</key><string>bridge</string></dict></plist>',
    )
    // 槽位执行器（2026-09-25）：同一个命名空间、但只有 RunAtLoad+KeepAlive。
    // 旧实现只按文件名认，把它报成"旧调度任务……请执行 scheduler migrate 迁移并清理"。
    fs.writeFileSync(
      path.join(box.root, 'agents', 'com.wechatauto.slot-runner.plist'),
      '<plist><dict><key>Label</key><string>com.wechatauto.slot-runner</string>' +
        '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>',
    )
    const mod = await import(SHELL)
    const found = mod.legacyTaskDetected()
    assert.deepEqual(
      found.map((t) => t.label),
      [`com.crosspost.${PROJECT}.hotspot`],
      '桥自身的守护不是槽位任务，不能算旧调度任务',
    )
    // 无触发的常驻服务要能从引擎侧单独查出来（doctor / `scheduler tasks` 用它），
    // 但**不进桥的 /proxy/schedule 响应**：那正是它当年在 Console 顶部常驻成一句
    // 废话的路径（既不是失败、也没有动作可做）。
    assert.deepEqual(
      legacyDaemons().map((d) => d.label),
      ['com.wechatauto.slot-runner'],
      '无触发的常驻服务要单独归到 daemons —— 既不报成旧任务，也不能凭空消失',
    )
    const st = await mod.getScheduleStatus()
    assert.match(st.notes.join(' '), /双发/)
    assert.match(st.notes.join(' '), /scheduler migrate/)
    assert.ok(!('legacyDaemons' in st), '常驻服务不在这份响应里（Console 提示区只讲失败）')
    assert.ok(
      !st.notes.join(' ').includes('slot-runner'),
      '提示区不得出现常驻服务：它不是失败、没有动作，常驻只会稀释真话',
    )
  } finally {
    box.done()
  }
})

test('薄壳⑦：启动/停止调度器 —— 拿锁、arm、释放；被别的活进程持锁时明确拒绝', async () => {
  const box = fixture()
  try {
    const mod = await import(SHELL)
    const started = mod.startScheduler()
    assert.equal(started.ok, true, JSON.stringify(started))
    assert.equal(started.specs, 2, '只有 2 个项目槽位（引擎不再自带任务）')
    const mid = await withProject(PROJECT, () => mod.getScheduleStatus())
    assert.equal(mid.lockHeldByUs, true)
    assert.ok(
      mid.slots.some((s) => s.armed),
      '项目槽位拿到锁后应当被 arm',
    )
    const stopped = mod.stopScheduler()
    assert.equal(stopped.ok, true)
    assert.equal(
      fs.existsSync(path.join(process.env.CROSSPOST_SCHEDULER_DIR, 'lock')),
      false,
      '停止要释放锁',
    )

    // 冒充"另一个活进程"持锁（pid=1 一定存在）→ 必须拒绝并说明持有者
    fs.mkdirSync(process.env.CROSSPOST_SCHEDULER_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(process.env.CROSSPOST_SCHEDULER_DIR, 'lock'),
      JSON.stringify({ pid: 1, host: 'standalone' }),
    )
    const second = mod.startScheduler()
    assert.equal(second.ok, false)
    assert.match(second.lock.reason, /已由 pid=1/)
    assert.equal(mod.stopScheduler().ok, true)
  } finally {
    box.done()
  }
})

test('薄壳⑧：effectiveSlots 反映合并后的槽位定义（Console 静态渲染用）', async () => {
  const box = fixture()
  try {
    writeProjectConfig(PROJECT, { schedule: { noon: false } })
    const mod = await import(SHELL)
    const rows = await withProject(PROJECT, async () => mod.effectiveSlots(PROJECT))
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    assert.deepEqual(Object.keys(by).sort(), ['hotspot', 'noon'])
    assert.equal(by.hotspot.time, '08:30')
    assert.equal(by.noon.enabled, false)
    assert.equal(by.hotspot.commandMissing, false)
    void box
  } finally {
    box.done()
  }
})

/* ── 告警的真伪（2026-09-25，容器实测发现） ────────────────────────────────
 * 这两条守的是 Console 上**会被人照着做事**的文字。当时 `capabilities.schedule`
 * 声明成 `{kind:'http',…}`（本项目真的就是这么声明的），却弹出
 * "manifest 未声明 capabilities.schedule" —— 反向结论；而且同一句话显示两遍。
 * 判据写成"对象形态不算声明"是能力钩子落地时漏改的一处：`true` 与对象**都算声明**。 */
test('薄壳⑨：capabilities.schedule 用对象形态声明时，不报"未声明"；真正缺失时才报，且只报一次', async () => {
  const box = fixture()
  try {
    const mod = await import(SHELL)
    const manifestPath = path.join(box.projectRoot, '.crosspost', 'project.json')
    const writeManifest = (capabilities) =>
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          id: PROJECT,
          name: 'P',
          manifestVersion: 2,
          capabilities,
          dataDir: 'drafts',
        }),
      )

    // ① 对象形态（v2 执行器）= 已声明 → 不许出现"未声明"
    writeManifest({
      drafts: true,
      schedule: { kind: 'http', url: 'http://127.0.0.1:8788/slot/run' },
    })
    const remote = await withProject(PROJECT, () => mod.getScheduleStatus())
    assert.equal(
      remote.warnings.filter((w) => w.includes('未声明 capabilities.schedule')).length,
      0,
      '对象形态也是"已声明"，报成未声明就是把 Console 的话说反了',
    )
    assert.deepEqual(
      remote.warnings.filter((w, i) => remote.warnings.indexOf(w) !== i),
      [],
      '同一句告警显示两遍 = 采了两遍没去重',
    )

    // ② 真的没声明 → 必须报出来，控制组证明上面不是"把这行删了"
    writeManifest({ drafts: true })
    const missing = await withProject(PROJECT, () => mod.getScheduleStatus())
    assert.equal(
      missing.warnings.filter((w) => w.includes('未声明 capabilities.schedule')).length,
      1,
      '真缺声明时这条提示仍然要有（且只有一条）',
    )

    // ③ v1 布尔形态 = 已声明（本地执行器），同样不许报
    writeManifest({ drafts: true, schedule: true })
    const local = await withProject(PROJECT, () => mod.getScheduleStatus())
    assert.equal(
      local.warnings.filter((w) => w.includes('未声明 capabilities.schedule')).length,
      0,
      '布尔 true 一直是"已声明"，这条判据不能为对象形态而反过来漏掉它',
    )
  } finally {
    box.done()
  }
})
