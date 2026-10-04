/**
 * 槽位日志读取（v2.3）：把"最近一次真的跑了"从**项目自己的日志**里读出来
 *
 * 为什么仍以项目日志为准：真正跑完整条流水线的是项目的 `run_once.sh`，它写的
 * `logs/run-<槽位>-<日期>.log`（末行 `[END]`）才是"这次跑完了"的第一手证据；
 * 引擎的运行记录（`scheduler/runs-*.jsonl`）只回答"引擎有没有触发、退出码多少"。
 * 两个口径各有分工，**不合并**——合并只会让"触发了但项目脚本早退"这种事看不出来。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 某槽位最近一次完成（`[END]`）的时间与"距今天数"。
 *
 * @param {string} slotId 槽位 id
 * @param {string} logsDir 该槽位的日志目录
 * @param {string[]} [dirFiles] 已读过的目录列表（调用方批量复用时避免每槽重扫）
 */
export function readSlotLastRun(slotId, logsDir, dirFiles) {
  try {
    const files = (dirFiles || (fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [])).filter(
      (f) => new RegExp(`^run-${slotId}-\\d{4}-\\d{2}-\\d{2}\\.log$`).test(f),
    )
    if (!files.length) return { lastRunAt: null, daysSince: null }
    const dates = files
      .map((f) => f.match(/(\d{4}-\d{2}-\d{2})/)?.[1])
      .filter(Boolean)
      .sort()
    const last = dates[dates.length - 1]
    let lastAt = null
    try {
      const text = fs.readFileSync(path.join(logsDir, files[files.length - 1]), 'utf8')
      const ends = [...text.matchAll(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)\] \[END\]/g)]
      if (ends.length) lastAt = ends[ends.length - 1][1].replace(' ', 'T')
    } catch {
      /* 读不到就用日期兜底 */
    }
    const dayMs = 24 * 3600 * 1000
    const lastDate = new Date(last + 'T00:00:00')
    const daysSince = Math.floor((Date.now() - lastDate.getTime()) / dayMs)
    return { lastRunAt: lastAt || last + 'T00:00:00', daysSince }
  } catch {
    return { lastRunAt: null, daysSince: null }
  }
}

/** 一次目录扫描的结果，供多个槽位复用（6 槽 = 1 次 readdir 而不是 6 次） */
export function readLogsDir(logsDir) {
  try {
    return fs.readdirSync(logsDir)
  } catch {
    return []
  }
}
