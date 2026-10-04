// 平台能力矩阵契约测试（2026-09-18，v2.05）
//
// 背景：改造前「平台数量」有 5 个互相矛盾的口径
//   README 27 · MCP 工具描述硬编码"28 平台" · platform-ids.mjs 27 ·
//   config.json.platforms.default 12 · preset 文案"11 平台"
// 根因不是"写错了数字"，而是**没有任何东西阻止数字各处手写**。
//
// 因此本测试锁死两件事：
//   ① 矩阵内部自洽（分级与清单互相一致，计数由清单派生而非独立维护）
//   ② 各出口与矩阵一致 —— Console 的常量模块、config 默认派发清单、
//      以及引擎源码中不得再出现手写的平台数量文案
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildPlatformMatrix,
  platformTier,
  platformEntry,
  ENABLED_PLATFORMS,
  platformCountPhrase,
} from '../src/platform-matrix.mjs'
import { TARGET_PLATFORMS, CHECK_ONLY_PLATFORMS } from '../src/platform-ids.mjs'
import { defaultConfig } from '../src/commands/setup.mjs'
import { PANEL_PLATFORMS, PLATFORM_GROUPS } from '../../bridge/console/modules/const.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const REPO = path.resolve(ROOT, '..')

test('矩阵①：清单与分级自洽，计数由清单派生', () => {
  const m = buildPlatformMatrix()
  assert.equal(m.platforms.length, TARGET_PLATFORMS.length, '矩阵条目数应等于 TARGET_PLATFORMS')

  const byTier = { enabled: 0, 'check-only': 0, beta: 0 }
  for (const p of m.platforms) byTier[p.tier]++

  assert.equal(m.counts.all, TARGET_PLATFORMS.length)
  assert.equal(m.counts.enabled, byTier.enabled)
  assert.equal(m.counts['check-only'], byTier['check-only'])
  assert.equal(m.counts.beta, byTier.beta)
  assert.equal(
    m.counts.enabled + m.counts['check-only'] + m.counts.beta,
    m.counts.all,
    '三档之和必须等于总数（不允许有平台落不进任何一档）',
  )
})

test('矩阵②：check-only 优先于 enabled（微信/抖音即便在默认清单里也是仅检查）', () => {
  for (const id of CHECK_ONLY_PLATFORMS) {
    assert.ok(ENABLED_PLATFORMS.includes(id), `${id} 应同时在已支持清单里（可勾选）`)
    assert.equal(platformTier(id), 'check-only', `${id} 的 tier 必须是 check-only`)
    assert.equal(platformEntry(id).defaultDispatch, false, `${id} 不应进入默认派发`)
    assert.ok(platformEntry(id).note, `${id} 应带说明文案`)
  }
})

test('矩阵③：defaultDispatch = 已支持 − 仅检查平台', () => {
  const m = buildPlatformMatrix()
  const expected = ENABLED_PLATFORMS.filter((id) => !CHECK_ONLY_PLATFORMS.includes(id))
  assert.deepEqual(m.defaultDispatch, expected)
  assert.equal(m.counts.defaultDispatch, expected.length)
})

test('矩阵④：config 默认派发清单与矩阵一致（禁止两处各写一份）', () => {
  const cfg = defaultConfig()
  const m = buildPlatformMatrix()
  assert.deepEqual(
    [...cfg.platforms.default].sort(),
    [...m.defaultSelected].sort(),
    'setup 生成的 config.platforms.default 必须等于矩阵的 defaultSelected',
  )
})

test('矩阵⑤：Console 的平台清单与矩阵一致（禁止前端手写名单）', () => {
  const m = buildPlatformMatrix()
  const matrixIds = m.platforms.map((p) => p.id)
  assert.deepEqual(
    [...PANEL_PLATFORMS].sort(),
    [...matrixIds].sort(),
    'Console 的 PANEL_PLATFORMS 必须等于矩阵全部平台（否则界面会出现引擎不认识的平台）',
  )

  // Console 分组里出现的平台必须都在矩阵里
  // （2026-09-28 测试审计：这里原先读 `g.platforms`，而 const.mjs 的分组字段是 `ids` ——
  //  循环体从不执行，断言恒真。字段名写错是最隐蔽的一类假绿：读起来完全合理。）
  const known = new Set(matrixIds)
  const unknown = []
  for (const g of PLATFORM_GROUPS) {
    for (const p of g.ids || []) if (!known.has(p)) unknown.push(`${g.key}:${p}`)
  }
  assert.ok(
    PLATFORM_GROUPS.every((g) => Array.isArray(g.ids) && g.ids.length > 0),
    '每个 Console 分组都必须有非空 ids：否则本断言又会退化成恒真',
  )
  assert.deepEqual(unknown, [], `Console 分组中出现矩阵未知的平台：${unknown.join(', ')}`)
})

test('矩阵⑥：面向用户的文案里不得再出现手写的平台数量', () => {
  // 允许出现"平台数量"字样的地方：矩阵模块自身、测试、以及注释里的历史说明。
  //
  // 2026-09-28 审计：原先只扫 3 个引擎文件，于是**用户可见**的那两处（DSH 预设的工具描述）
  // 一直写着「28 平台」而真值是 27 —— 没有任何门禁看得见。扫描面扩到这里：
  //   · preset 的工具描述是用户在工具列表里直接读到的文案
  //   · Console 的 const.mjs 是前端唯一一份平台分组清单（它曾写死"28 平台"）
  const files = [
    'crosspost-runtime/mcp-server/index.mjs',
    'crosspost-runtime/src/notify.mjs',
    'crosspost-runtime/src/commands/platforms.mjs',
    'preset/crosspost/plugins/crosspost.js',
    'bridge/console/modules/const.mjs',
  ]
  const bad = []
  for (const rel of files) {
    const abs = path.join(REPO, rel)
    if (!fs.existsSync(abs)) continue
    const src = fs.readFileSync(abs, 'utf8')
    src.split('\n').forEach((line, i) => {
      // 只查字符串/模板字面量里的数字+平台，忽略纯注释行
      const trimmed = line.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
      if (/\d+\s*(?:个)?\s*平台/.test(line)) bad.push(`${rel}:${i + 1}: ${trimmed.slice(0, 80)}`)
    })
  }
  assert.deepEqual(
    bad,
    [],
    `以下位置仍手写平台数量，应改为从 platform-matrix.mjs 派生：\n${bad.join('\n')}`,
  )
})

test('矩阵⑦：platformCountPhrase 与矩阵计数一致', () => {
  const m = buildPlatformMatrix()
  const phrase = platformCountPhrase()
  assert.ok(phrase.includes(String(m.counts.all)), `文案应含总数 ${m.counts.all}：${phrase}`)
  assert.ok(
    phrase.includes(String(m.counts.defaultDispatch)),
    `文案应含默认派发数 ${m.counts.defaultDispatch}：${phrase}`,
  )
})

test('矩阵⑧：平台中文名不得缺失（否则界面会显示 id）', () => {
  const m = buildPlatformMatrix()
  const missing = m.platforms.filter((p) => !p.name || p.name === p.id).map((p) => p.id)
  assert.deepEqual(missing, [], `以下平台缺少中文名：${missing.join(', ')}`)
})

test('矩阵⑨：preset.yml 的平台文案不得与矩阵矛盾（对用户可见的事实声明）', () => {
  // preset.yml 的 description 会显示给用户（DSH 预设列表）。
  // 它目前手写着「11 平台（…B站…）」——与矩阵矛盾：
  //   · 已支持是 12 个（含抖音），不是 11 个
  //   · B站是 beta，不在默认清单里；抖音才在已支持里（仅检查）
  // 这类矛盾正是 P0 要消除的「多口径」问题，只不过它写在 YAML 里而非代码里。
  //
  // 本测试**只断言矛盾存在与否**，不强行规定文案措辞——修法应由维护者选定
  // （或改为从矩阵派生）。矛盾未修时它会明确报出两端取值，便于对照。
  const presetYml = path.join(REPO, 'preset', 'crosspost', 'preset.yml')
  if (!fs.existsSync(presetYml)) return // 无 preset 则跳过
  const text = fs.readFileSync(presetYml, 'utf8')
  const m = buildPlatformMatrix()

  // 提取文案里形如「N 平台」/「N 个平台」的数字。
  // 2026-09-28 测试审计：原正则不认「个」，而 preset.yml 恰好写的是「12 个平台」「15 个 beta 平台」
  // —— claimed 永远是空数组，这条检查形同不存在。known 也漏了 counts.beta（文案里那个正确的数）。
  const claimed = [...text.matchAll(/(\d+)\s*(?:个)?\s*平台/g)].map((x) => Number(x[1]))
  const contradictions = []
  assert.ok(claimed.length > 0, 'preset.yml 里没有可核对的数量口径：文案改了写法就该同步本测试')

  for (const n of claimed) {
    const known = [
      m.counts.all,
      m.counts.enabled,
      m.counts.beta,
      m.counts.defaultDispatch,
      m.defaultSelected.length,
    ]
    if (!known.includes(n)) {
      contradictions.push(
        `文案声称「${n} 平台」，但矩阵的合法口径只有：全部 ${m.counts.all} / 已支持 ${m.counts.enabled} / beta ${m.counts.beta} / 默认派发 ${m.counts.defaultDispatch} / 默认勾选 ${m.defaultSelected.length}`,
      )
    }
  }

  // 文案列举的平台名必须与矩阵的某个口径集合一致（避免"11 平台"这类枚举式漂移）
  {
    // 若文案显式枚举了 platform 名称清单（含「/」分隔），检查其是否混入 beta
    const listMatch = /[（(]([^）)]*[/、][^）)]*)[）)]/.exec(text)
    if (listMatch) {
      const listed = listMatch[1]
        .split(/[/、]/)
        .map((x) => x.trim())
        .filter(Boolean)
      const betaNames = m.platforms.filter((x) => x.tier === 'beta').map((x) => x.name)
      const listedBetas = listed.filter((n) => betaNames.includes(n))
      if (listedBetas.length) {
        contradictions.push(
          `文案把 beta 平台当作已支持平台列举：${listedBetas.join('、')}（beta 需在 Console 显式启用）`,
        )
      }
    }
  }

  assert.deepEqual(
    contradictions,
    [],
    `preset/crosspost/preset.yml 与平台能力矩阵矛盾（对用户可见）：\n  ` +
      contradictions.join('\n  ') +
      `\n修法：把 description 改为与矩阵一致，或改为从 platform-matrix.mjs 派生。`,
  )
})
