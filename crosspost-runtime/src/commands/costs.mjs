/**
 * 费用输入域（2026-09-01 从 cli.mjs 迁出）：三库全量费用入参聚合。
 *
 * 2026-08-31 报表口径：文章+留存+归档三库全量，id 互斥不重复。
 * 留存/归档记录用记录簿记补 createdAt（首次登记=生成时刻）作为可靠锚点；
 * 无记录/无 createdAt 时回退文件 mtime（articleCost 内部处理）。
 * 仅供 listCosts（报表费用）使用。
 *
 * 2026-09-25（容器模式性能）：**一次 `listRecords()` 建 Map**，
 * 取代原先"留存 190 + 归档 126 各一次 `getRecord`、`listArchive` 内再 126 次"
 * 的逐篇读盘（容器 bind mount 上每次 ~0.5ms，实测 /proxy/costs 670ms → 现在 ~250ms）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { scanAndList, listRecords, parseDraftFile, getDraftsDir } from '../articles.mjs'
import { parseGateSnapshot } from '../ai-detect.mjs'
import { listArchive } from './publish.mjs'

// CrossPost · maintained by dos2un1x · https://github.com/dos2un1x/crosspost
export function allCostRecords() {
  const list = scanAndList() // 顶层文章（已排除归档/留存）
  const byId = new Map(listRecords().map((r) => [r.id, r]))
  // 留存（rejected=低分 / risk=高风险）：与 listRetained 同口径扫描，补 createdAt
  for (const sub of ['rejected', 'risk']) {
    const dir = path.join(getDraftsDir(), sub)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const p = path.join(dir, f)
      const parsed = parseDraftFile(p)
      const rec = byId.get(parsed.id)
      list.push({
        id: f.replace(/\.md$/, ''),
        file: p,
        date: parsed.date,
        slot: parsed.slot,
        title: parsed.title,
        createdAt: rec && rec.createdAt,
      })
    }
  }
  // 归档库：listArchive() 全量，补 createdAt
  for (const a of listArchive()) {
    const rec = byId.get(a.id)
    list.push({ ...a, createdAt: (rec && rec.createdAt) || a.createdAt })
  }
  return list
}

/**
 * AI 门禁汇总（报表用，2026-10-10）：按记录里的 `aiDetect` 快照统计达标/超标/未检测。
 *
 * 数据来自 `listRecords()`（调用方本就为费用全量加载过一次），所以这里**不额外读盘**。
 * `unknown` 单独计数：认不出来的快照既不算达标也不算超标——达标率的分母只放
 * "真的检测过"的篇数，否则格式一变报表就会悄悄变好看。
 *
 * @param {{sinceDays?:number}} [opts] `sinceDays` 只统计最近 N 天（按文章 date）
 */
export function aiGateStats(opts = {}) {
  const days = Number(opts.sinceDays)
  const cutoff =
    Number.isFinite(days) && days > 0
      ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
      : ''
  const acc = {
    total: 0,
    pass: 0,
    fail: 0,
    skip: 0,
    unknown: 0,
    avgValue: null,
    chars: 0,
    slots: {},
  }
  let valueSum = 0
  let valueN = 0
  for (const rec of listRecords()) {
    if (cutoff && rec.date && rec.date < cutoff) continue
    if (!rec.aiDetect) continue
    const p = parseGateSnapshot(rec.aiDetect)
    acc.total++
    acc[p.verdict] = (acc[p.verdict] || 0) + 1
    if (p.chars) acc.chars += p.chars
    const slot = rec.slot || 'manual'
    const s = (acc.slots[slot] = acc.slots[slot] || {
      pass: 0,
      fail: 0,
      skip: 0,
      unknown: 0,
      valueSum: 0,
      valueN: 0,
      avgValue: null,
    })
    s[p.verdict] = (s[p.verdict] || 0) + 1
    if (p.verdict !== 'skip' && typeof p.value === 'number') {
      valueSum += p.value
      valueN++
      // 按栏目也给均值：报表要回答"哪个栏目最难达标"（达标率之外还要看特征占比离阈值多远）
      s.valueSum = Math.round((s.valueSum + p.value) * 10000) / 10000
      s.valueN++
      s.avgValue = Math.round((s.valueSum / s.valueN) * 10000) / 10000
    }
  }
  acc.avgValue = valueN ? valueSum / valueN : null
  acc.detected = acc.pass + acc.fail
  acc.passRate = acc.detected ? acc.pass / acc.detected : null
  return acc
}
