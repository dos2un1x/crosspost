// 平台 ID 契约测试（2026-09-10 阶段 D1）
// 单一来源 = src/platform-ids.mjs 的 TARGET_PLATFORMS。
// 保证「适配器 meta.id」『运行时 ADAPTER_CLASSES key』『TARGET_PLATFORMS』三者不漂移。
// 历史案例：Cto51Adapter.meta.id 曾为 '51cto'，与运行时 'cto51' 不一致（已修）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TARGET_PLATFORMS, CHECK_ONLY_PLATFORMS } from '../src/platform-ids.mjs'
import { ADAPTER_CLASSES } from '../src/commands/platforms.mjs'
import * as core from '@crosspost/core/adapters'
// Console 常量模块零 import（纯常量），Node 可直接读——用于锁死「锁定平台」两侧口径
import { PF_LOCKED, PLATFORM_GROUPS } from '../../bridge/console/modules/const.mjs'

// 跳过的导出：抽象基类（无平台 meta）+ 微信官方 API 通道（独立于多平台分发，不属于 TARGET_PLATFORMS）
const SKIP = new Set(['BaseAdapter', 'CodeAdapter', 'WeixinOfficialAdapter'])

function instantiateAdapters() {
  const out = []
  const failures = []
  for (const [name, value] of Object.entries(core)) {
    // 仅适配器类（PascalCase 且以 Adapter 结尾）；排除 getAdapter 等函数导出
    if (typeof value !== 'function' || !/^[A-Z][A-Za-z0-9]*Adapter$/.test(name)) continue
    if (SKIP.has(name)) continue
    try {
      out.push([name, new value()])
    } catch (e) {
      failures.push(`${name}: ${e && e.message}`)
    }
  }
  return { out, failures }
}

test('所有平台适配器均可无参实例化', () => {
  const { out, failures } = instantiateAdapters()
  assert.deepEqual(failures, [], `实例化失败: ${failures.join('; ')}`)
  assert.ok(out.length >= 27, `适配器数量异常: ${out.length}`)
})

test('适配器 meta.id 集合与 TARGET_PLATFORMS 完全一致', () => {
  const { out } = instantiateAdapters()
  const ids = out.map(([, a]) => a.meta.id).sort()
  const targets = [...TARGET_PLATFORMS].sort()
  assert.deepEqual(
    ids,
    targets,
    `适配器 meta.id 与 TARGET_PLATFORMS 漂移:\n  适配器=${ids.join(',')}\n  目标=${targets.join(',')}`,
  )
})

test('运行时 ADAPTER_CLASSES 的 key 与其 meta.id 一致', () => {
  const mismatches = []
  for (const [key, Cls] of Object.entries(ADAPTER_CLASSES)) {
    const id = new Cls().meta.id
    if (id !== key) mismatches.push(`${key} → meta.id=${id}`)
  }
  assert.deepEqual(mismatches, [], `ADAPTER_CLASSES key 与 meta.id 漂移: ${mismatches.join('; ')}`)
})

test('ADAPTER_CLASSES 覆盖全部 TARGET_PLATFORMS', () => {
  const keys = Object.keys(ADAPTER_CLASSES).sort()
  const targets = [...TARGET_PLATFORMS].sort()
  assert.deepEqual(keys, targets)
})

// 2026-09-12（模型 A）：勾选 = 推送 + 检查；"仅检查"平台（微信/抖音）的勾选只纳入检查、
// 不进通用派发。三处口径必须一致：platform-ids.mjs ↔ publish.mjs ↔ console const.mjs。
test('仅检查平台口径一致：CHECK_ONLY_PLATFORMS ↔ Console PF_LOCKED ↔ PLATFORM_GROUPS.locked', () => {
  assert.deepEqual(Object.keys(PF_LOCKED).sort(), [...CHECK_ONLY_PLATFORMS].sort())
  const lockedGroup = PLATFORM_GROUPS.find((g) => g.key === 'locked')
  assert.ok(lockedGroup, 'PLATFORM_GROUPS 缺少 locked 分组')
  assert.deepEqual([...lockedGroup.ids].sort(), [...CHECK_ONLY_PLATFORMS].sort())
  for (const id of CHECK_ONLY_PLATFORMS) {
    assert.ok(TARGET_PLATFORMS.includes(id), `${id} 不是有效平台 id`)
    assert.ok(PF_LOCKED[id], `${id} 缺少"仅检查/不派发"的说明文案`)
    assert.ok(PF_LOCKED[id].includes('仅检查'), `${id} 文案应说明勾选只表示纳入检查`)
  }
})
