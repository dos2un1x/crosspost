/**
 * doctor 的 MCP 握手探针测试（v2.29）
 *
 * 为什么值得单独测：这条检查的价值**全在负例上**。
 * 正例（真实 server 能握手）看一眼 doctor 输出就知道了；真正要防的是
 * "文件在、握手挂了"却仍报 ✔ ——那正是定时链路当天全灭的样子。
 *
 * 覆盖三种情形：
 *   ① 真实 mcp-server → 可握手，工具数 ≥ 19（19 个 registerTool）
 *   ② 语法错误的 server → 不可握手，且理由里带得上 stderr / code（可诊断）
 *   ③ 秒退的 server    → 不可握手（不挂在 10s 超时上）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeMcpServer } from '../src/doctor.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REAL = path.resolve(__dirname, '..', 'mcp-server', 'index.mjs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-doctor-mcp-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

test('正例：真实 MCP server 可握手且工具数 ≥ 19', async () => {
  if (!fs.existsSync(REAL)) {
    // 仓库不完整时跳过而不是失败（与 deployment-consistency 同一取舍）
    return
  }
  const r = await probeMcpServer(REAL)
  assert.equal(r.ok, true, `应能握手：${JSON.stringify(r)}`)
  assert.ok(r.tools >= 19, `工具数应 ≥19，实际 ${r.tools}`)
})

test('负例：语法错误的 server 不可握手，理由可诊断', async () => {
  const bad = path.join(tmp, 'broken.mjs')
  fs.writeFileSync(bad, 'this is not javascript ((( \n')
  const r = await probeMcpServer(bad)
  assert.equal(r.ok, false, '语法错误必须判负，否则定时链路全灭也报 ✔')
  assert.ok(
    /进程提前退出|SyntaxError|Error/.test(r.reason || ''),
    `理由应可诊断，实际：${r.reason}`,
  )
})

test('负例：启动即退出的 server 不可握手', async () => {
  const quitter = path.join(tmp, 'quitter.mjs')
  fs.writeFileSync(quitter, 'process.exit(3)\n')
  const r = await probeMcpServer(quitter)
  assert.equal(r.ok, false)
  assert.ok(/进程提前退出|code=3/.test(r.reason || ''), `理由应含退出码，实际：${r.reason}`)
})

test('负例：不存在的文件不可握手', async () => {
  const r = await probeMcpServer(path.join(tmp, 'nope.mjs'))
  assert.equal(r.ok, false)
})
