// 扩展↔桥 协议兼容性契约测试（P1）
//
// 锁死"版本不匹配必须可见"这件事。此前扩展版本只被显示、从不被判定，
// 于是版本不匹配表现为「扩展显示已连接，发布却静默失败」——最难排查的一类故障。
//
// 关键设计取舍（测试要保护它）：
//   判定是**告警不拒绝**。桥不得因为扩展版本旧就拒绝服务——那会把一次
//   可用的会话变成完全不可用。判定结果只用于提示与排障。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MIN_EXTENSION_VERSION,
  parseVersion,
  versionLessThan,
  checkExtensionCompatibility,
} from '../src/extension-compat.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')

test('扩展兼容①：parseVersion 解析语义化版本，非法返回 null', () => {
  assert.deepEqual(parseVersion('0.2.1'), [0, 2, 1])
  assert.deepEqual(parseVersion('1.10.3'), [1, 10, 3])
  assert.deepEqual(parseVersion(' 0.2.1 '), [0, 2, 1])
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion('v0.2'), null, '非三段式应判为非法')
  assert.equal(parseVersion(null), null)
  assert.equal(parseVersion(undefined), null)
})

test('扩展兼容②：versionLessThan 逐段比较（不是字符串比较）', () => {
  // 字符串比较会错：'0.10.0' < '0.9.0' 为真，语义化版本应为假
  assert.equal(versionLessThan('0.9.0', '0.10.0'), true, '0.9.0 应小于 0.10.0')
  assert.equal(versionLessThan('0.10.0', '0.9.0'), false)
  assert.equal(versionLessThan('0.2.0', '0.2.1'), true)
  assert.equal(versionLessThan('0.2.1', '0.2.1'), false)
  assert.equal(versionLessThan('garbage', '0.2.1'), false, '无法解析时不声称更小')
})

test('扩展兼容③：当前最小版本被判定为兼容', () => {
  const r = checkExtensionCompatibility(MIN_EXTENSION_VERSION)
  assert.equal(r.status, 'ok')
  assert.equal(r.compatible, true)
  assert.equal(r.extVersion, MIN_EXTENSION_VERSION)
})

test('扩展兼容④：低于最小版本 → outdated 且 incompatible，并给出可执行动作', () => {
  const r = checkExtensionCompatibility('0.1.9')
  assert.equal(r.status, 'outdated')
  assert.equal(r.compatible, false)
  assert.match(r.message, /低于/)
  assert.ok(r.action && /chrome:\/\/extensions/.test(r.action), '应给出重新加载扩展的具体路径')
})

test('扩展兼容⑤：主版本不同 → major-mismatch', () => {
  const r = checkExtensionCompatibility('1.0.0')
  assert.equal(r.status, 'major-mismatch')
  assert.equal(r.compatible, false)
  assert.ok(r.action)
})

test('扩展兼容⑥：无扩展连接 → absent，但**不算不兼容**（没连不等于版本错）', () => {
  for (const v of [null, undefined, '']) {
    const r = checkExtensionCompatibility(v)
    assert.equal(r.status, 'absent')
    assert.equal(r.compatible, true, '未连接不应被报成"不兼容"，否则会把两种故障混为一谈')
    assert.ok(r.action, '应给出安装/加载扩展的动作')
  }
})

test('扩展兼容⑦：版本无法解析 → unknown，且**不阻断**（宁可不报也不误报不可用）', () => {
  const r = checkExtensionCompatibility('garbage')
  assert.equal(r.status, 'unknown')
  assert.equal(r.compatible, true)
})

test('扩展兼容⑧：判定结果是纯数据（桥可安全内联进 JSON 响应）', () => {
  const r = checkExtensionCompatibility('0.2.1')
  for (const [k, v] of Object.entries(r)) {
    assert.ok(
      ['string', 'number', 'boolean'].includes(typeof v) || v === null,
      `字段 ${k} 不是可 JSON 序列化的标量（实际 ${typeof v}）`,
    )
  }
})

test('扩展兼容⑨：告警不拒绝 —— 桥不得因版本判定而阻断请求', () => {
  // 结构性断言：桥源里只应"读取并使用"判定结果，不应出现基于 compat 的 4xx/5xx 响应。
  // 若未来确要拒绝旧扩展，必须显式修改本测试并升级 CONTRACT 说明——那是破坏性变更。
  const bridge = fs.readFileSync(path.join(REPO, 'bridge', 'run-bridge.mjs'), 'utf8')
  // 2026-09-28 测试审计：原先直接 `slice(indexOf(锚点))` —— 锚点一旦消失，indexOf 返回 -1，
  // `slice(-1)` 只取到最后一个字符，断言**恒真**。所以先把锚点本身钉住。
  const idx = bridge.indexOf('compat: checkExtensionCompatibility')
  assert.ok(idx >= 0, '桥源里找不到 ext.compat 锚点：本断言会失去意义（修锚点或改本测试）')
  const nearby = bridge.slice(idx, idx + 200)
  assert.ok(
    !/sendJson\((4\d\d|5\d\d)/.test(nearby),
    '扩展兼容判定附近出现错误响应——违反"告警不拒绝"策略',
  )
})

test('扩展兼容⑪：出厂扩展的版本不得低于 MIN_EXTENSION_VERSION', () => {
  // 这条不变量此前**没有任何测试守**：MIN 一旦被抬到高于仓库自带的扩展版本，
  // 所有装"加载已解压的扩展"的用户都会看到「扩展过旧」，而全仓测试照样全绿。
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO, 'bridge', 'chrome-proxy-extension', 'manifest.json'), 'utf8'),
  )
  assert.ok(manifest.version, '扩展 manifest 缺 version')
  assert.equal(
    versionLessThan(manifest.version, MIN_EXTENSION_VERSION),
    false,
    `出厂扩展 ${manifest.version} 低于 MIN_EXTENSION_VERSION ${MIN_EXTENSION_VERSION}：` +
      `仓库自带的扩展会被判"过旧"，用户照着 README 装完就是告警态`,
  )
})

test('扩展兼容⑩：桥与 doctor 都接入了判定（防只在一处生效）', () => {
  const bridge = fs.readFileSync(path.join(REPO, 'bridge', 'run-bridge.mjs'), 'utf8')
  assert.match(
    bridge,
    /ext:\s*\{[\s\S]*?compat:\s*checkExtensionCompatibility/,
    '桥未暴露 ext.compat',
  )
  const doctor = fs.readFileSync(path.join(REPO, 'crosspost-runtime', 'src', 'doctor.mjs'), 'utf8')
  assert.match(doctor, /checkExtensionCompatibility/, 'doctor 未接入兼容判定')
  assert.match(doctor, /extension-version/, 'doctor 未产出 extension-version 检查项')
})
