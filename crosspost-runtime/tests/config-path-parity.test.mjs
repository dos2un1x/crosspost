/**
 * 配置路径**同源**契约测试（v2.47）
 *
 * 背景（实测撞到的隔离漏洞）：`CROSSPOST_CONFIG` 此前只被 **bridge 侧**认
 * （`bridge/cli-worker.mjs` 的 `CONFIG_PATH`），而**引擎侧**一律走
 * `crosspost-runtime/src/config-cache.mjs`，那里把路径写成了 import 期常量、不认 env。
 *
 * 结果是任何设了该变量的沙箱都**脑裂**：桥读写沙箱配置、引擎读**生产**配置。
 * 实测 `CROSSPOST_CONFIG=/tmp/x/config.json`（threshold=999）下
 * `readFullRuntimeConfig().scoring.threshold === 999` 而 `readConfig()... === 68`。
 *
 * 危害不只是"测试不干净"：`empty-env-smoke` 声称的"空环境"其实读着生产配置，
 * 而任何在沙箱里触发发布/通知的用例都会拿到**生产**的 notify 配置。
 *
 * 本文件把"两侧必须同源"钉成断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cfg-parity-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

const writeCfg = (name, marker) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, JSON.stringify({ scoring: { threshold: marker } }))
  return p
}

const A = writeCfg('a.json', 999)
const B = writeCfg('b.json', 111)

// 必须在**动态 import 之前**设好：cli-worker 的 CONFIG_PATH 是模块顶层求值的
process.env.CROSSPOST_CONFIG = A
const cacheMod = await import(new URL('../src/config-cache.mjs', import.meta.url).href)
const { configPath, readConfig, CONFIG_PATH } = cacheMod
const cliWorker = await import(new URL('../../bridge/cli-worker.mjs', import.meta.url).href)

test('两侧解析出**同一个**配置路径（同源铁律）', () => {
  assert.equal(cliWorker.CONFIG_PATH, configPath(), '桥侧与引擎侧的 config 路径必须一致')
  assert.equal(configPath(), A)
})

test('readConfig() 反映 CROSSPOST_CONFIG 指向的文件（而不是生产配置）', () => {
  assert.equal(readConfig().scoring.threshold, 999)
})

test('缓存按路径分开记：切换 env 后值跟着切，不串味', () => {
  process.env.CROSSPOST_CONFIG = B
  try {
    assert.equal(readConfig().scoring.threshold, 111)
    process.env.CROSSPOST_CONFIG = A
    assert.equal(readConfig().scoring.threshold, 999, '切回来仍应是 A 的值')
  } finally {
    process.env.CROSSPOST_CONFIG = A
  }
})

test('不设 CROSSPOST_CONFIG 时回到默认路径（生产行为逐字不变）', () => {
  delete process.env.CROSSPOST_CONFIG
  try {
    assert.equal(configPath(), CONFIG_PATH)
    assert.equal(path.basename(configPath()), 'config.json')
    assert.ok(configPath().startsWith(RUNTIME), '默认路径应在 runtime 目录下')
  } finally {
    process.env.CROSSPOST_CONFIG = A
  }
})

test('CONFIG_PATH 仍是"默认路径"常量（不能拿它当生效路径）', () => {
  assert.equal(CONFIG_PATH, path.join(RUNTIME, 'config.json'))
  assert.notEqual(CONFIG_PATH, configPath(), '设了 env 时两者必须不同——这正是要区分的')
})
