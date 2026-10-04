// 跨文件清单一致性守卫（2026-09-10 阶段 E）
//
// 背景：仓库有多份「手维护」的平台/槽位清单，历史上已真实发生过一次漂移
//       （Cto51Adapter.meta.id 为 '51cto'，而运行时单一来源是 'cto51'）。
// 本测试把这一类漂移锁死：任一处不一致即失败，并点名具体平台/槽位与两侧取值。
//
// 只 import「无顶层副作用」的模块：cli.mjs 末尾有裸顶层块会立即执行 main()，故不可 import。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TARGET_PLATFORMS } from '../src/platform-ids.mjs'
import { BUILTIN_SLOTS } from '../src/articles.mjs'
import { PLATFORM_NAMES as NOTIFY_NAMES } from '../src/notify.mjs'
import { DEFAULT_PLATFORMS as PUBLISH_DEFAULTS, SLOT_STYLE_MAP } from '../src/commands/publish.mjs'
import {
  DEFAULT_PLATFORMS as CONSOLE_DEFAULTS,
  PANEL_PLATFORMS,
  PLATFORM_NAMES as CONSOLE_NAMES,
  SLOT_NAMES,
} from '../../bridge/console/modules/const.mjs'
import * as core from '@crosspost/core/adapters'

// 抽象基类无平台 meta；微信官方 API 通道独立于多平台分发，不属于 TARGET_PLATFORMS
const SKIP = new Set(['BaseAdapter', 'CodeAdapter', 'WeixinOfficialAdapter'])
const sort = (iter) => [...iter].sort()
/** 仓库根（本文件在 crosspost-runtime/tests/ 下） */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function collectAdapterNames() {
  const map = {}
  for (const [name, Cls] of Object.entries(core)) {
    if (typeof Cls !== 'function' || !/^[A-Z][A-Za-z0-9]*Adapter$/.test(name)) continue
    if (SKIP.has(name)) continue
    const a = new Cls()
    map[a.meta.id] = a.meta.name
  }
  return map
}

const ADAPTER_NAMES = collectAdapterNames()
const ADAPTER_IDS = sort(Object.keys(ADAPTER_NAMES))

test('前置：适配器集合与 TARGET_PLATFORMS 一致', () => {
  assert.deepEqual(ADAPTER_IDS, sort(TARGET_PLATFORMS))
})

test('publish.DEFAULT_PLATFORMS 与 console.DEFAULT_PLATFORMS 一致', () => {
  assert.deepEqual(
    sort(PUBLISH_DEFAULTS),
    sort(CONSOLE_DEFAULTS),
    `默认平台清单漂移:\n  publish=${sort(PUBLISH_DEFAULTS)}\n  console=${sort(CONSOLE_DEFAULTS)}`,
  )
})

test('DEFAULT_PLATFORMS 与 PANEL_PLATFORMS 均 ⊆ TARGET_PLATFORMS', () => {
  const target = new Set(TARGET_PLATFORMS)
  const badDefaults = PUBLISH_DEFAULTS.filter((p) => !target.has(p))
  const badPanel = PANEL_PLATFORMS.filter((p) => !target.has(p))
  assert.deepEqual(badDefaults, [], `默认平台不在 TARGET_PLATFORMS: ${badDefaults}`)
  assert.deepEqual(badPanel, [], `面板平台不在 TARGET_PLATFORMS: ${badPanel}`)
})

test('PANEL_PLATFORMS ⊇ DEFAULT_PLATFORMS', () => {
  const panel = new Set(PANEL_PLATFORMS)
  const missing = PUBLISH_DEFAULTS.filter((p) => !panel.has(p))
  assert.deepEqual(missing, [], `面板缺少默认平台: ${missing}`)
})

test('console.PLATFORM_NAMES 覆盖全部适配器，且与 notify.PLATFORM_NAMES 取值一致', () => {
  const missing = ADAPTER_IDS.filter((id) => !CONSOLE_NAMES[id])
  assert.deepEqual(missing, [], `console 缺平台显示名: ${missing}`)
  const diff = ADAPTER_IDS.filter(
    (id) => CONSOLE_NAMES[id] && NOTIFY_NAMES[id] && CONSOLE_NAMES[id] !== NOTIFY_NAMES[id],
  ).map((id) => `${id}: console=${CONSOLE_NAMES[id]} vs notify=${NOTIFY_NAMES[id]}`)
  assert.deepEqual(diff, [], `平台显示名不一致: ${diff.join('; ')}`)
})

test('适配器 meta.name 与 notify.PLATFORM_NAMES 一致', () => {
  const diff = ADAPTER_IDS.filter(
    (id) => NOTIFY_NAMES[id] && ADAPTER_NAMES[id] !== NOTIFY_NAMES[id],
  ).map((id) => `${id}: adapter=${ADAPTER_NAMES[id]} vs notify=${NOTIFY_NAMES[id]}`)
  assert.deepEqual(diff, [], `适配器名与 notify 不一致: ${diff.join('; ')}`)
})

test('console.SLOT_NAMES 至少覆盖内建栏目 ∪ {manual}', () => {
  // 合法栏目不再是一个有限集合——栏目 id 由项目声明（见 slot-lexicon 的"词典优先"）。
  // `SLOT_NAMES` 只是**词典拿不到时的兜底名表**，所以断言的是"至少覆盖内建"，不是"恰好等于"。
  const actual = new Set(Object.keys(SLOT_NAMES))
  const missing = [...BUILTIN_SLOTS, 'manual'].filter((s) => !actual.has(s))
  assert.deepEqual(
    missing,
    [],
    `兜底名表漏了内建栏目（词典拿不到时这些栏目会显示成裸 id）: ${missing.join('、')}`,
  )
})

/**
 * 栏目名的**第二个副本**不许再长出来（2026-09-25）。
 *
 * 为什么单独守这一条：上面那条只锁了 `SLOT_NAMES` 的**键**，没锁**名**。而名字的真正
 * 权威源已经搬到项目声明里（`/proxy/schedule` 的 `label` = 配置名 > 声明名 > 模板名），
 * 于是"锁了键"完全挡不住漂移 —— 实测本机已经漂成这样：
 *
 *     项目声明（设置→调度）   前端常量（文章/报表/归档/选题/详情/编写）
 *     热点解读①               热点①
 *     深度分析                 深度
 *     AI技巧·工具              技巧
 *     教学/娱乐                晚间
 *
 * 现在所有栏目名都必须经 `slot-lexicon.mjs` 的 `slotName()`（词典 → 常量兜底 → 原样 id）
 * 取；常量只做"词典拿不到时"的兜底。所以：**除 slot-lexicon.mjs 之外，任何 Console 模块
 * 都不许再直接索引 `SLOT_NAMES`** —— 那样就是又开了一份会漂的副本。
 */
test('console 栏目名只有一个入口：除 slot-lexicon 外不得直接索引 SLOT_NAMES', () => {
  const modulesDir = path.join(REPO, 'bridge', 'console', 'modules')
  const offenders = []
  for (const f of fs.readdirSync(modulesDir)) {
    if (!f.endsWith('.mjs')) continue
    if (f === 'slot-lexicon.mjs') continue // 词典模块自己就是那份兜底
    if (f === 'const.mjs') continue // 定义处
    const src = fs.readFileSync(path.join(modulesDir, f), 'utf8')
    if (/SLOT_NAMES\s*\[/.test(src) || /Object\.(keys|entries)\(SLOT_NAMES\)/.test(src))
      offenders.push(f)
  }
  assert.deepEqual(
    offenders,
    [],
    `这些模块还在自己查栏目名（应改用 slot-lexicon 的 slotName/slotChoices）: ${offenders.join('、')}`,
  )
})

test('publish.SLOT_STYLE_MAP 键 ⊆ 内建栏目', () => {
  // 内建栏目才有引擎自带的默认样式；项目自定义的栏目由 `styles.perSlot` 或 frontmatter 指定，
  // 都没有时按 swiss 兜底（见 publish.mjs 的样式解析链）。
  const slots = new Set(BUILTIN_SLOTS)
  const bad = Object.keys(SLOT_STYLE_MAP).filter((s) => !slots.has(s))
  assert.deepEqual(bad, [], `SLOT_STYLE_MAP 含非内建槽位: ${bad}`)
})
