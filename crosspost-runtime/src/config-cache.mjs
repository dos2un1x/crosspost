#!/usr/bin/env node
/**
 * config.json 缓存读取（2026-08-28）
 *
 * 背景：cli/articles/publish/notify/wechat 等 8 处每次调用都 JSON.parse 全量重读 config.json，
 * 高频路径（scanAndList 每篇、每次发布多步）重复 IO。此处按 mtime 缓存，文件未变零重读。
 *
 * 注意：本模块只读；config 写入一律走 bridge 的 writeRuntimeConfig（单写者），
 * mtime 失效保证写入后下次读取即新值。
 *
 * ── 2026-09-19（v2.47）修隔离漏洞：本模块此前**不认 `CROSSPOST_CONFIG`** ──
 *
 * `bridge/cli-worker.mjs` 用 `CROSSPOST_CONFIG` 解析配置路径（桥的读与写都认它），
 * 而引擎侧一律走本模块 —— 于是任何设了该变量的沙箱都处于**脑裂**状态：
 * 桥读写沙箱配置、引擎读**生产**配置。实测：
 *
 *   CROSSPOST_CONFIG=/tmp/x/config.json（里面 threshold=999）下：
 *     readFullRuntimeConfig().scoring.threshold === 999   // 桥侧，对
 *     readConfig().scoring.threshold          === 68      // 引擎侧，读了生产
 *
 * 危害不只是"测试不干净"：`empty-env-smoke` 声称的"空环境"其实读着生产配置，
 * 而任何在沙箱里触发发布/通知的用例都会拿到**生产**的 notify 配置
 * （今天所有这类用例都显式 `notify:false`，所以还没炸）。
 *
 * 现在两边用**同一条规则**：`CROSSPOST_CONFIG` > `<runtime>/config.json`。
 * 生产不设该变量 → 行为逐字不变。
 */
import fs from 'node:fs'
import { DEFAULT_CONFIG_PATH, configPath } from './config-path.mjs'
import { withProjectOverlay } from './config-layers.mjs'

/**
 * 默认配置路径（不随 env 变化）。历史引用仍可用，但**不要**拿它做读写决策；
 * 需要"当前生效路径"请用 `configPath()`。
 */
export const CONFIG_PATH = DEFAULT_CONFIG_PATH

/**
 * 当前生效的 config.json 路径。
 *
 * v2.77 起解析规则**唯一来源**是 `config-path.mjs`（此前这里与 `bridge/cli-worker.mjs`
 * 各写一份，正是 v2.47 脑裂事故的成因）；本函数保留为转发，供既有引用继续使用。
 */
export { configPath }

// 缓存按**路径**分开记：同一进程内切换 CROSSPOST_CONFIG（测试常见）不会串味
const cache = new Map() // path -> { mtime, data }

/**
 * 读取完整 config.json（失败返回空对象，与历史行为一致）。
 *
 * **v2.77 起叠加项目覆盖层**：项目级键（`config-layers.mjs` 的白名单）以当前项目的
 * `<localRoot>/project-state/<id>/config.json` 为准。引擎级键（proxy / timeout / 并发 /
 * `projectsDirs` …）**永远**来自引擎文件——即使有人手改覆盖层塞进去也不生效，
 * 注册表因此不可能被项目改写。
 *
 * 无项目上下文（含引擎自身读注册表时的调用）→ 行为与分层前**逐字一致**。
 */
export function readConfig() {
  return withProjectOverlay(readEngineConfigCached())
}

/** 引擎 config 原文（不含项目覆盖层）：给"只想要引擎级事实"的调用方 */
export function readEngineConfig() {
  return readEngineConfigCached()
}

function readEngineConfigCached() {
  const file = configPath()
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return {}
  }
  const hit = cache.get(file)
  if (hit && st.mtimeMs === hit.mtime) return hit.data
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    data = {}
  }
  cache.set(file, { mtime: st.mtimeMs, data })
  return data
}
