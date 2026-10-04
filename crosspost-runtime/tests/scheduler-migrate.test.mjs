// 迁移器（v2.3）：把旧的 launchd/systemd 调度任务迁成项目声明并卸载
//
// ## 为什么这条路径值得单独一组测试
//
// 迁移是**一次性、动别人系统目录**的动作（`~/Library/LaunchAgents`），做错两种后果：
//   · 漏迁 → 旧任务继续触发，与内置定时器**双发**（重复生成、重复推送）
//   · 迁错 → 命令/时间/环境丢一样，第二天该跑的不跑
// 所以这里既不碰真实目录（`CROSSPOST_LEGACY_TASKS_DIR` 沙箱 + 假 launchctl），
// 又把三件事钉死：**学得对、备份得住、幂等**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  legacyDaemons,
  legacyTasks,
  parseLegacyLabel,
  parsePlist,
  plistScheduleTrigger,
} from '../src/scheduler/legacy.mjs'
import {
  formatMigrationReport,
  planMigration,
  runSchedulerMigrate,
} from '../src/commands/scheduler-migrate.mjs'

const SLOT_PLIST = (
  label,
  script,
  slot,
  hour,
  minute,
  extra = '',
) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${label}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/bash</string>
\t\t<string>${script}</string>
\t\t<string>${slot}</string>
\t</array>
\t<key>StartCalendarInterval</key>
\t<dict>
\t\t<key>Hour</key>
\t\t<integer>${hour}</integer>
\t\t<key>Minute</key>
\t\t<integer>${minute}</integer>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${path.dirname(script)}/../logs/scheduler-${slot}.out.log</string>
\t<key>StandardErrorPath</key>
\t<string>${path.dirname(script)}/../logs/scheduler-${slot}.err.log</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>CLAUDE_BIN</key>
\t\t<string>/Users/x/.local/bin/claude</string>
\t\t<key>PATH</key>
\t\t<string>/usr/local/bin:/usr/bin:/bin</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<false/>
</dict>
${extra}</plist>
`

/** 一个"像生产那样"的沙箱：项目 + LaunchAgents 目录（含槽位 plist 与日历提醒） */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-migrate-'))
  const project = 'proj'
  const projectRoot = path.join(root, 'projects', project)
  const scripts = path.join(projectRoot, 'scripts')
  const agents = path.join(root, 'LaunchAgents')
  fs.mkdirSync(path.join(projectRoot, '.crosspost'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'drafts'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true })
  fs.mkdirSync(scripts, { recursive: true })
  fs.mkdirSync(agents, { recursive: true })
  fs.writeFileSync(path.join(scripts, 'run_once.sh'), '#!/bin/bash\nexit 0\n')
  fs.writeFileSync(
    path.join(projectRoot, '.crosspost', 'project.json'),
    JSON.stringify({
      id: project,
      name: 'P',
      manifestVersion: 2,
      capabilities: { drafts: true, schedule: true },
      dataDir: 'drafts',
    }),
  )
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ projectsDirs: [path.join(root, 'projects')] }),
  )
  // 两个项目槽位（单个时间点）+ 一个日历提醒（**数组**形态：08:00 与 12:00）
  fs.writeFileSync(
    path.join(agents, `com.crosspost.${project}.hotspot.plist`),
    SLOT_PLIST(
      `com.crosspost.${project}.hotspot`,
      path.join(scripts, 'run_once.sh'),
      'hotspot',
      8,
      30,
    ),
  )
  fs.writeFileSync(
    path.join(agents, `com.crosspost.${project}.noon.plist`),
    SLOT_PLIST(`com.crosspost.${project}.noon`, path.join(scripts, 'run_once.sh'), 'noon', 12, 30),
  )
  fs.writeFileSync(
    path.join(agents, 'com.crosspost.calendar-remind.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.crosspost.calendar-remind</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>${path.join(root, 'remind_calendar.sh')}</string></array>
<key>StartCalendarInterval</key><array>
<dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
<dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
</array>
</dict></plist>
`,
  )
  // 桥自身的守护与项目自己的提供者：**不得**被当成槽位
  fs.writeFileSync(
    path.join(agents, 'com.crosspost.bridge.plist'),
    '<plist><dict><key>Label</key><string>com.crosspost.bridge</string></dict></plist>',
  )
  fs.writeFileSync(
    path.join(agents, 'com.wechatauto.generate-provider.plist'),
    '<plist><dict><key>Label</key><string>com.wechatauto.generate-provider</string></dict></plist>',
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
  process.env.CROSSPOST_LEGACY_TASKS_DIR = agents
  process.env.CROSSPOST_LEGACY_SYSTEMD_DIR = path.join(root, 'no-systemd')

  return {
    root,
    project,
    projectRoot,
    agents,
    declaration: path.join(projectRoot, '.crosspost', 'schedule.json'),
    done() {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

test('迁移①：只认槽位任务 —— 桥守护与项目自己的提供者不算（否则会误删别人的任务）', () => {
  const box = fixture()
  try {
    const tasks = legacyTasks()
    const labels = tasks.map((t) => t.label || t.unit).sort()
    assert.deepEqual(labels, [
      'com.crosspost.calendar-remind',
      `com.crosspost.${box.project}.hotspot`,
      `com.crosspost.${box.project}.noon`,
    ])
    assert.equal(parseLegacyLabel('com.crosspost.bridge'), null)
    assert.equal(parseLegacyLabel('com.wechatauto.generate-provider'), null)
    assert.deepEqual(parseLegacyLabel(`com.crosspost.${box.project}.hotspot`), {
      project: box.project,
      slot: 'hotspot',
    })
    assert.deepEqual(parseLegacyLabel('com.crosspost.calendar-remind'), {
      project: '',
      slot: 'calendar-remind',
    })
  } finally {
    box.done()
  }
})

test('迁移①b：常驻执行器服务（无触发）不是旧调度任务 —— 不报、不迁、不卸', () => {
  const box = fixture()
  try {
    // 2026-09-25 的真身：槽位执行器（能力钩子）也是 launchd 任务，但只有 RunAtLoad+KeepAlive。
    // 旧实现只按文件名认 `com.wechatauto.*`，于是把它做成"待迁移的旧任务"。
    fs.writeFileSync(
      path.join(box.agents, 'com.wechatauto.slot-runner.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.wechatauto.slot-runner</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>${path.join(
        box.projectRoot,
        'scripts',
        'slot_runner.sh',
      )}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
</dict></plist>
`,
    )
    const labels = legacyTasks().map((t) => t.label || t.unit)
    assert.ok(
      !labels.includes('com.wechatauto.slot-runner'),
      '无到点触发 = 不可能与内置定时器双发，不该进旧任务清单',
    )
    assert.deepEqual(
      legacyDaemons().map((d) => d.label),
      ['com.wechatauto.slot-runner'],
      '但它也不能凭空消失：要能被单独查出来（Console 上作中性提示）',
    )
    // 关键：Console 上那句"请执行 scheduler migrate"如果照做，会拿到一个没有时间点的
    // plist（blocked），白折腾一轮 —— 所以它必须完全不进迁移计划。
    const plan = planMigration({ project: box.project })
    assert.deepEqual(
      plan.others.map((o) => o.label),
      [],
      '不该被列成"别人的任务"',
    )
    assert.deepEqual(plan.blocked, [], '更不该被列成 blocked')
    assert.ok(
      !plan.uninstall.some((t) => t.label === 'com.wechatauto.slot-runner'),
      '常驻服务绝不能被卸载',
    )
  } finally {
    box.done()
  }
})

test('迁移①c：触发形态的分类器 —— 时钟触发算旧任务；常驻/事件触发不算；认不出的形态按任务', () => {
  assert.equal(
    plistScheduleTrigger('<plist><dict><key>KeepAlive</key><true/></dict></plist>'),
    null,
  )
  assert.equal(
    plistScheduleTrigger('<plist><dict><key>RunAtLoad</key><true/></dict></plist>'),
    null,
  )
  assert.deepEqual(plistScheduleTrigger('<key>StartInterval</key><integer>600</integer>'), {
    kind: 'interval',
    seconds: 600,
  })
  assert.deepEqual(
    plistScheduleTrigger(
      '<key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>',
    ),
    { kind: 'calendar', times: 1 },
  )
  // 认得出"有时钟触发"、认不出时间点（写法怪）→ 不能沉默，按任务处理
  assert.deepEqual(plistScheduleTrigger('<key>StartCalendarInterval</key><dict/>'), {
    kind: 'unknown',
  })
  // 事件触发不是"到点"，不构成与内置定时器双发
  assert.equal(
    plistScheduleTrigger('<key>WatchPaths</key><array><string>/tmp/x</string></array>'),
    null,
  )
})

test('迁移②：plist 解析读得出命令/时间/环境/日志目录（含 StartCalendarInterval 数组）', () => {
  const box = fixture()
  try {
    const p = parsePlist(
      fs.readFileSync(path.join(box.agents, 'com.crosspost.calendar-remind.plist'), 'utf8'),
    )
    assert.deepEqual(p.times, ['08:00', '12:00'], '数组形态必须两个时间点都读出来')
    const slot = parsePlist(
      fs.readFileSync(path.join(box.agents, `com.crosspost.${box.project}.noon.plist`), 'utf8'),
    )
    assert.deepEqual(slot.times, ['12:30'])
    assert.deepEqual(slot.argv.slice(1), [
      path.join(box.projectRoot, 'scripts', 'run_once.sh'),
      'noon',
    ])
    assert.equal(slot.env.CLAUDE_BIN, '/Users/x/.local/bin/claude')
    assert.equal(slot.logDir, path.join(box.projectRoot, 'logs'))
  } finally {
    box.done()
  }
})

test('迁移③：dry-run 只出计划 —— 不写声明、不动 plist，且把 cwd 变化摆出来', async () => {
  const box = fixture()
  try {
    const before = fs.readdirSync(box.agents).sort()
    const r = await runSchedulerMigrate({ project: box.project, dryRun: true })
    assert.equal(r.ok, true, r.errors?.join('; '))
    assert.deepEqual(r.willAdd.sort(), ['hotspot', 'noon'])
    assert.equal(
      r.slots.find((s) => s.slot === 'hotspot').command[1],
      'scripts/run_once.sh',
      '项目根内的路径写成相对形态',
    )
    assert.equal(r.slots.find((s) => s.slot === 'hotspot').cwd, '.')
    assert.ok(
      r.cwdChanged.some((c) => c.startsWith('hotspot')),
      'cwd 的变化必须显式列出',
    )
    assert.ok(r.engineTasks.some((t) => t.label === 'com.crosspost.calendar-remind'))
    assert.equal(fs.existsSync(box.declaration), false, 'dry-run 绝不写声明文件')
    assert.deepEqual(fs.readdirSync(box.agents).sort(), before, 'dry-run 绝不移动 plist')
  } finally {
    box.done()
  }
})

test('迁移④：执行 —— 写声明（含 env/logDir/cwd）、备份并移走旧 plist、注销 launchctl', async () => {
  const box = fixture()
  try {
    const calls = []
    const r = await runSchedulerMigrate({
      project: box.project,
      execFileImpl: (bin, args, _opts, cb) => {
        calls.push([bin, ...args])
        cb(null, '', '')
      },
    })
    assert.equal(r.ok, true, r.errors?.join('; '))
    const decl = JSON.parse(fs.readFileSync(box.declaration, 'utf8'))
    assert.equal(decl.version, 1)
    assert.deepEqual(Object.keys(decl.slots).sort(), ['hotspot', 'noon'])
    assert.deepEqual(decl.slots.hotspot.command, ['/bin/bash', 'scripts/run_once.sh', 'hotspot'])
    assert.equal(decl.slots.hotspot.cwd, '.')
    assert.equal(decl.slots.hotspot.time, '08:30')
    assert.equal(decl.slots.hotspot.env.CLAUDE_BIN, '/Users/x/.local/bin/claude')
    assert.equal(decl.slots.hotspot.logDir, 'logs')

    // 旧任务：已从 LaunchAgents 移走（含引擎的日历提醒），备份留在 scheduler 目录下
    const left = fs.readdirSync(box.agents).sort()
    assert.deepEqual(left, ['com.crosspost.bridge.plist', 'com.wechatauto.generate-provider.plist'])
    const backupFiles = fs.readdirSync(r.backupDir).sort()
    assert.ok(backupFiles.includes(`com.crosspost.${box.project}.hotspot.plist`))
    assert.ok(backupFiles.includes('com.crosspost.calendar-remind.plist'))
    assert.equal(legacyTasks().length, 0, '迁移后不应再有旧任务（双发风险解除）')
    // launchctl bootout 只对 launchd 任务发（本机是 macOS 才发；其他平台 0 次）
    if (process.platform === 'darwin')
      assert.ok(
        calls.some((c) => c[1] === 'bootout'),
        '应注销旧任务',
      )
  } finally {
    box.done()
  }
})

test('迁移⑤：幂等 —— 已有声明的槽位不覆盖；重建的旧任务仍会被卸载', async () => {
  const box = fixture()
  try {
    const quiet = (b, a, o, cb) => cb(null, '', '')
    await runSchedulerMigrate({ project: box.project, execFileImpl: quiet })
    const first = fs.readFileSync(box.declaration, 'utf8')

    // 场景：有人又把 hotspot 的 plist 装了回来（迁移前那种旧任务），再跑一次迁移
    fs.writeFileSync(
      path.join(box.agents, `com.crosspost.${box.project}.hotspot.plist`),
      SLOT_PLIST(
        `com.crosspost.${box.project}.hotspot`,
        path.join(box.projectRoot, 'scripts', 'run_once.sh'),
        'hotspot',
        9,
        0,
      ),
    )
    const r2 = await runSchedulerMigrate({ project: box.project, execFileImpl: quiet })
    assert.equal(r2.ok, true)
    assert.deepEqual(r2.willAdd, [], '声明里已有的槽位不再写入')
    assert.deepEqual(r2.kept, ['hotspot'], '已有条目必须原样保留（不覆盖用户改过的时间/命令）')
    assert.ok(
      r2.removed.some((x) => x.label.endsWith('.hotspot')),
      '重建的旧任务仍要被卸载',
    )
    assert.equal(fs.readFileSync(box.declaration, 'utf8'), first, '第二次运行不应改动声明内容')
    assert.equal(legacyTasks().length, 0)
  } finally {
    box.done()
  }
})

test('迁移⑥：多个时间点的槽位**拒绝**迁移（不猜拆分），且不卸载它', async () => {
  const box = fixture()
  try {
    // 把 noon 换成两个时间点（这是"项目槽位声明只能有一个时间"的边界）
    fs.writeFileSync(
      path.join(box.agents, `com.crosspost.${box.project}.noon.plist`),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.crosspost.${box.project}.noon</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>${path.join(box.projectRoot, 'scripts', 'run_once.sh')}</string><string>noon</string></array>
<key>StartCalendarInterval</key><array>
<dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>30</integer></dict>
<dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>10</integer></dict>
</array>
</dict></plist>
`,
    )
    const plan = planMigration({ project: box.project })
    assert.equal(plan.ok, true)
    assert.equal(plan.blocked.length, 1)
    assert.match(plan.blocked[0].reason, /2 个时间点/)
    assert.ok(
      !plan.uninstall.some((t) => t.slot === 'noon'),
      '被跳过的任务绝不能卸载（卸载了就等于"少跑一次"且没人知道）',
    )
    assert.ok(plan.uninstall.some((t) => t.slot === 'hotspot'))
  } finally {
    box.done()
  }
})

test('迁移⑦：报告是给人看的 —— 关键信息（声明路径、备份、cwd 变化、跳过原因）都在', () => {
  const box = fixture()
  try {
    const plan = planMigration({ project: box.project })
    const text = formatMigrationReport({
      ok: true,
      dryRun: true,
      project: box.project,
      projectRoot: box.projectRoot,
      declarationFile: box.declaration,
      willAdd: plan.slots.map((s) => s.slot),
      kept: [],
      slots: plan.slots,
      engineTasks: plan.engineTasks,
      uninstall: plan.uninstall.map((t) => t.label),
      blocked: [],
      errors: [],
      cwdChanged: ['hotspot: /（launchd 缺省）→ .'],
    })
    assert.match(text, /dry-run/)
    assert.match(text, /schedule\.json/)
    assert.match(text, /工作目录变化/)
    assert.match(text, /com\.crosspost\.calendar-remind/)
  } finally {
    box.done()
  }
})
