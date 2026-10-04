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
import { listArchive } from './publish.mjs'

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
