// 调度声明与槽位规格（v2.3，调度子系统）
//
// ## 这个文件钉住什么
//
// v2.3 起，槽位的**命令**唯一来源是项目声明 `.crosspost/schedule.json`
// （不再从操作系统的 plist 里"学"）。于是"声明怎么写才算合法"就成了契约，
// 必须逐条钉住：
//   · 合法声明 → 解析出 argv / cwd / env / logDir
//   · 非法声明 → **拒绝并说明原因**（不是静默忽略某一行）
//   · 相对路径按项目根解析，且**不得逃出项目根**（声明不能指向别人家）
//   · shell 语法不做任何解释：`&&`、`$VAR` 在 argv 里就是普通字符串
//   · 命令能不能跑起来要预检出来（`commandMissing`），不能等"到点才发现"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_SLOT_TEMPLATES,
  commandAvailable,
  loadDeclaration,
  mergeSlotSpecs,
  normalizeSlotId,
  normalizeSlotTime,
  resolveCommand,
  validateDeclaration,
} from '../src/scheduler/spec.mjs'

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-decl-'))
  fs.mkdirSync(path.join(root, '.crosspost'), { recursive: true })
  fs.mkdirSync(path.join(root, 'pipeline', 'logs'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'scripts', 'run_once.sh'), '#!/bin/bash\nexit 0\n')
  return root
}

const writeDeclaration = (root, obj) => {
  fs.writeFileSync(path.join(root, '.crosspost', 'schedule.json'), JSON.stringify(obj, null, 2))
}

test('声明①：合法声明解析出 argv / cwd / env / logDir，且像路径的参数按项目根展开', () => {
  const root = makeProject()
  writeDeclaration(root, {
    version: 1,
    slots: {
      hotspot: {
        name: '热点解读①',
        time: '8:30',
        command: ['bash', 'scripts/run_once.sh', 'hotspot'],
        cwd: 'pipeline',
        env: { CLAUDE_BIN: '/usr/local/bin/claude' },
        logDir: 'pipeline/logs',
      },
    },
  })
  const d = loadDeclaration(root)
  assert.equal(d.found, true)
  assert.equal(d.ok, true, d.errors.join('; '))
  const s = d.slots.hotspot
  assert.equal(s.time, '08:30', 'H:M 简写要规范化')
  assert.equal(s.name, '热点解读①')
  assert.deepEqual(s.argv, ['bash', path.join(root, 'scripts/run_once.sh'), 'hotspot'])
  assert.equal(s.argv[2], 'hotspot', '不像路径的参数必须原样保留（引擎不猜语义）')
  assert.equal(s.cwd, path.join(root, 'pipeline'))
  assert.equal(s.logDir, path.join(root, 'pipeline', 'logs'))
  assert.deepEqual(s.env, { CLAUDE_BIN: '/usr/local/bin/claude' })
  fs.rmSync(root, { recursive: true, force: true })
})

test('声明②：非法声明逐条报错（未知字段 / 版本 / 槽位 id / 命令形态 / env 类型）', () => {
  const root = makeProject()
  const cases = [
    [{ version: 1, slots: {}, extra: 1 }, /未知字段: extra/],
    [{ version: 99, slots: {} }, /高于引擎支持/],
    [{ version: 1, slots: { Bad_Id: { command: ['/bin/echo'] } } }, /非法槽位 id/],
    [{ version: 1, slots: { ok: { command: 'bash x.sh' } } }, /command 必须是/],
    [{ version: 1, slots: { ok: { command: [] } } }, /command 必须是/],
    [{ version: 1, slots: { ok: { command: ['bash', ''], time: '08:00' } } }, /command\[1\]/],
    [
      { version: 1, slots: { ok: { command: ['/bin/echo'], env: { A: 1 } } } },
      /env.A 必须是字符串/,
    ],
    [
      { version: 1, slots: { ok: { command: ['/bin/echo'], env: { '1x': 'y' } } } },
      /env 变量名非法/,
    ],
    [{ version: 1, slots: { ok: { command: ['/bin/echo'], nope: true } } }, /未知字段 nope/],
  ]
  for (const [raw, re] of cases) {
    const v = validateDeclaration(raw, { projectRoot: root })
    assert.equal(v.ok, false, `应判非法：${JSON.stringify(raw)}`)
    assert.match(v.errors.join('; '), re)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

test('声明③：路径不得逃出项目根（cwd / logDir / 命令里的路径参数都要挡）', () => {
  const root = makeProject()
  for (const raw of [
    { version: 1, slots: { a: { command: ['/bin/echo'], cwd: '../outside' } } },
    { version: 1, slots: { a: { command: ['/bin/echo'], logDir: '/tmp/elsewhere' } } },
    { version: 1, slots: { a: { command: ['bash', '../../escape.sh'] } } },
    { version: 1, slots: { a: { command: ['/bin/echo'], cwd: '/etc' } } },
  ]) {
    const v = validateDeclaration(raw, { projectRoot: root })
    assert.equal(v.ok, false, `应判非法：${JSON.stringify(raw)}`)
    assert.match(v.errors.join('; '), /逃出项目根/)
  }
  const ok = validateDeclaration(
    { version: 1, slots: { a: { command: ['bash', 'scripts/run_once.sh'], cwd: '.' } } },
    { projectRoot: root },
  )
  assert.equal(ok.ok, true, ok.errors.join('; '))
  fs.rmSync(root, { recursive: true, force: true })
})

test('声明④：shell 语法不做任何解释（argv 直传，`&&`/`$VAR` 只是普通参数）', () => {
  const root = makeProject()
  const argv = resolveCommand(['bash', '-lc', 'echo $HOME && ls'], root)
  assert.deepEqual(argv.errors, [])
  assert.deepEqual(argv.argv, ['bash', '-lc', 'echo $HOME && ls'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('声明⑤：文件缺失 → found:false；JSON 坏 → ok:false 且报解析错', () => {
  const root = makeProject()
  assert.equal(loadDeclaration(root).found, false)
  fs.writeFileSync(path.join(root, '.crosspost', 'schedule.json'), '{ "version": 1, ')
  const d = loadDeclaration(root)
  assert.equal(d.found, true)
  assert.equal(d.ok, false)
  assert.match(d.errors.join('; '), /JSON 解析失败/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('声明⑥：命令可解析性预检（PATH 查找 + 绝对路径 + 找不到时给人话原因）', () => {
  const okBin = commandAvailable([process.execPath, 'x'], { env: process.env })
  assert.equal(okBin.ok, true)
  assert.equal(okBin.resolved, process.execPath)
  const missing = commandAvailable(['definitely-not-a-real-command-xyz'], { env: process.env })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /PATH 里找不到命令/)
  const missingAbs = commandAvailable(['/definitely/not/here/bin'], { env: process.env })
  assert.equal(missingAbs.ok, false)
  assert.match(missingAbs.reason, /找不到可执行文件/)
})

test('槽位规格①：配置只覆盖名称/时间/开关，命令永远来自声明', () => {
  const root = makeProject()
  writeDeclaration(root, {
    version: 1,
    slots: { hotspot: { name: '声明里的名字', time: '08:30', command: ['/bin/echo', 'x'] } },
  })
  const declaration = loadDeclaration(root)
  const merged = mergeSlotSpecs({
    projectId: 'p',
    projectRoot: root,
    declaration,
    configSlots: [{ id: 'hotspot', name: '配置里的名字', time: '09:15', enabled: false }],
    scheduleMap: {},
    tz: 'Asia/Shanghai',
    dataDir: path.join(root, 'drafts'),
    logsDir: path.join(root, 'logs'),
  })
  const s = merged.specs.find((x) => x.id === 'hotspot')
  assert.equal(s.name, '配置里的名字', '名称以配置（UI 权威）为准')
  assert.equal(s.time, '09:15', '时间以配置为准')
  assert.equal(s.enabled, false, 'enabled 来自 config.slots[].enabled')
  assert.deepEqual(s.command, ['/bin/echo', 'x'], '命令来自声明')
  assert.equal(s.source, 'declaration')
  fs.rmSync(root, { recursive: true, force: true })
})

test('槽位规格②：开关优先级 —— config.schedule > config.slots[].enabled > 缺省开', () => {
  const root = makeProject()
  writeDeclaration(root, {
    version: 1,
    slots: {
      a: { command: ['/bin/echo'] },
      b: { command: ['/bin/echo'] },
      c: { command: ['/bin/echo'] },
    },
  })
  const declaration = loadDeclaration(root)
  const merged = mergeSlotSpecs({
    projectId: 'p',
    projectRoot: root,
    declaration,
    configSlots: [{ id: 'a', time: '08:00', enabled: true }],
    scheduleMap: { a: false },
    tz: 'Asia/Shanghai',
    logsDir: path.join(root, 'logs'),
  })
  const by = Object.fromEntries(merged.specs.map((s) => [s.id, s]))
  assert.equal(by.a.enabled, false, 'schedule[slot]=false 是唯一"停"的写法（压过 slots.enabled）')
  assert.equal(by.b.enabled, true, '没有任何记录 → fail-open 跑')
  assert.equal(by.c.enabled, true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('槽位规格③：没有声明就没有命令 —— 槽位仍可见，但写明缺什么（不静默消失）', () => {
  const root = makeProject()
  const merged = mergeSlotSpecs({
    projectId: 'p',
    projectRoot: root,
    declaration: { found: false, ok: true, slots: {} },
    configSlots: [{ id: 'hotspot', name: '热点', time: '08:30' }],
    scheduleMap: {},
    tz: 'Asia/Shanghai',
    logsDir: path.join(root, 'logs'),
  })
  const s = merged.specs.find((x) => x.id === 'hotspot')
  assert.ok(s, '配置里的槽位必须仍然可见（否则用户以为它不存在）')
  assert.equal(s.commandAvailable, false)
  assert.match(s.commandReason, /schedule\.json/)
  assert.match(merged.warnings.join('; '), /没有命令声明/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('槽位规格④：模板只在"配置与声明都为空"时铺底（删掉的槽位不会自己回来）', () => {
  const root = makeProject()
  const empty = mergeSlotSpecs({
    projectId: 'p',
    projectRoot: root,
    declaration: { found: false, ok: true, slots: {} },
    configSlots: undefined,
    scheduleMap: {},
    tz: 'Asia/Shanghai',
  })
  // 2026-09-28 测试审计：原断言写死 `6`，加第 7 个模板就假红。判据其实是
  // "模板生效了"，所以与模板清单本身比集合（console-smoke.mjs 也已明确"行数不再写死 6"）。
  assert.deepEqual(
    empty.specs.map((s) => s.id).sort(),
    DEFAULT_SLOT_TEMPLATES.map((t) => t.slot).sort(),
    '全新项目看到的槽位必须**恰好**是模板清单（顺序无关）',
  )
  assert.ok(empty.specs.every((s) => s.source === 'template' && s.commandAvailable === false))

  const written = mergeSlotSpecs({
    projectId: 'p',
    projectRoot: root,
    declaration: { found: false, ok: true, slots: {} },
    configSlots: [],
    scheduleMap: {},
    tz: 'Asia/Shanghai',
  })
  assert.equal(written.specs.length, 0, '显式写过 slots（哪怕空数组）就是权威定义集')
  fs.rmSync(root, { recursive: true, force: true })
})

test('槽位规格⑤：id 与时间规范化（含简写与非法的边界）', () => {
  assert.equal(normalizeSlotId('Hotspot'), 'hotspot')
  assert.equal(normalizeSlotId('hot_spot'), '')
  assert.equal(normalizeSlotId('-x'), '')
  assert.equal(normalizeSlotId('a'.repeat(33)), '')
  assert.equal(normalizeSlotTime('6:7'), '06:07')
  assert.equal(normalizeSlotTime('23:59'), '23:59')
  assert.equal(normalizeSlotTime('24:00'), '')
  assert.equal(normalizeSlotTime('08:60'), '')
  assert.equal(normalizeSlotTime('八点'), '')
})
