/**
 * 历史回填适配器：解析 `<prefix> run-<slot>-<date>.log` 摘要行 → 文章库记录。
 *
 * 2026-09-18（v2.01，引擎自治）从 `commands/publish.mjs` 抽出并**改为显式可选**。
 *
 * 为什么抽出：本解析器实现的是**某一个接入项目的历史日志格式**
 * （形如 `[2026-09-01 08:10:03] [morning] 选题=… 标题=… 发布=成功 分发=8/11 成功 …`），
 * 不是引擎的通用能力。原先它在引擎主流程中默认可用，并直接读 `drafts/` 同级
 * 的 `logs/` 目录——等于引擎默认假定磁盘上存在某个具体项目的数据布局。
 *
 * 现状：默认**关闭**。只有接入方在 config.json 显式开启时才参与：
 *
 *   { "adapters": { "backfillFromRunLogs": { "enabled": true,
 *                                            "logsDir": "/path/to/logs",
 *                                            "filePattern": "^run-.*\\.log$" } } }
 *
 * 未开启时 `runLogBackfill()` 返回结构化 `capability_disabled`，由调用方原样上报，
 * 不静默跳过、不猜测目录、不读取引擎之外的路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readConfig } from '../config-cache.mjs'

/** 该适配器在内置默认下是否启用（false = 引擎不参与此类回填） */
export const DEFAULT_ENABLED = false

/** 读取适配器配置（含默认值） */
export function readAdapterConfig() {
  const cfg = readConfig()
  const a = (cfg.adapters && cfg.adapters.backfillFromRunLogs) || {}
  return {
    enabled: a.enabled === true, // 显式开启才生效（默认关闭）
    logsDir: a.logsDir || '',
    filePattern: a.filePattern || '^run-.*\\.log$',
  }
}

/**
 * 解析单行摘要（原 `parseRunLogLine`，逐字保留以维持既有行为与测试）。
 * 格式不匹配返回 null。
 */
export function parseRunLogLine(line) {
  const m = /^\[(\d{4}-\d{2}-\d{2})[^\]]*\] \[(\w+)\]/.exec(line)
  if (!m) return null
  const date = m[1]
  const slot = m[2]
  const titleM = /标题=([^]*?)(?=\s+(?:发布|备选标题)=)/.exec(line)
  const pubM = /发布=([^]*?)(?=\s+(?:分发|备选标题)=|$)/.exec(line)
  const distM = /分发=(\d+)\/(\d+)\s+成功/.exec(line)
  const failM = /失败平台=([^]*?)(?=\s+备选标题=|$)/.exec(line)
  const pub = pubM ? pubM[1].trim() : ''
  const mediaM = /media_?[Ii]d[= ]([A-Za-z0-9_-]+)/.exec(pub)
  return {
    date,
    slot,
    title: titleM ? titleM[1].trim() : null,
    pub,
    wechatOk: /^成功/.test(pub),
    wechatFailReason: /^失败/.test(pub) ? pub : null,
    mediaId: mediaM ? mediaM[1] : null,
    okN: distM ? Number(distM[1]) : null,
    totalN: distM ? Number(distM[2]) : null,
    distNote: distM
      ? line.match(/分发=\S[^]*?(?=\s+(?:备选标题)=|$)/)?.[0]?.replace(/^分发=/, '') || null
      : null,
    failedPlatforms: failM ? failM[1].trim() : null,
  }
}

/**
 * 读取并聚合日志目录中的摘要行 → Map<`date|slot`, rows[]>。
 * 未启用或缺目录时返回 { error }（结构化，不抛错）。
 */
export function collectRunLogRows() {
  const a = readAdapterConfig()
  if (!a.enabled) {
    return {
      error: 'capability_disabled',
      message:
        '历史回填（按运行日志摘要）默认关闭：该能力解析的是特定接入项目的日志格式，不属于引擎通用能力。' +
        '如确需使用，请在 config.json 设置 adapters.backfillFromRunLogs.enabled=true 并指定 logsDir。',
      capability: 'backfillFromRunLogs',
    }
  }
  const dir = a.logsDir
  if (!dir) {
    return {
      error: 'adapter_misconfigured',
      message: 'adapters.backfillFromRunLogs.enabled=true 但未提供 logsDir。',
      capability: 'backfillFromRunLogs',
    }
  }
  if (!fs.existsSync(dir)) {
    return { error: `日志目录不存在: ${dir}`, capability: 'backfillFromRunLogs' }
  }

  const re = new RegExp(a.filePattern)
  const agg = new Map()
  for (const f of fs.readdirSync(dir).filter((x) => re.test(x))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    for (const line of text.split('\n')) {
      const p = parseRunLogLine(line)
      if (!p) continue
      const key = `${p.date}|${p.slot}`
      if (!agg.has(key)) agg.set(key, [])
      agg.get(key).push(p)
    }
  }
  return { agg, logsDir: dir }
}
