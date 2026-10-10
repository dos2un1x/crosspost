#!/usr/bin/env node
/**
 * 记录对账（2026-10-09）：把"文件已经在留存库、记录却没写"的缺口补齐。
 *
 * 为什么需要它（真实事故，2026-10-09 一键生成 4 篇 + 定时 tips 1 篇）：
 *   写作 agent 跑在 `dsh --profile wechat-auto` 的 **workspace-write 沙箱**里（工作区 =
 *   写作项目根），而引擎簿记在 `<引擎仓库>/.local/project-state/<项目>/articles/` —— 越界，
 *   于是 `retainArticle` 把文件移进 `drafts/rejected/` 之后写记录报 `EPERM`：**文件走了、
 *   记录没写**。后果有三条，都不是"看起来不整齐"这么轻：
 *     ① Console 留存库那一行没有留存原因/时间，抽屉显示「⚠ 无记录」；
 *     ② `npm run verify:immutable` 把这次"移动"判成**删除/未声明新增**——它的规则要求
 *        移动必须"内容 + 记录双证"（记录里写着 dir 或 status=retained），缺记录就红；
 *     ③ 事后复盘分不清"这篇没跑过"与"跑过但过程没记下来"（`recordHealth` 只负责*发现*）。
 *
 * 为什么是"引擎对账"而不是"放宽沙箱"：丢记录的不是某个调用方，而是**任何在沙箱里动文件的
 * 写入方**（裸 `mv`、claude 回退链路、跑到一半被中断）。把判断建立在**文件系统事实**上，
 * 谁丢的记录都能补回来；放开沙箱只是把权限放大，下一次换个入口照样丢。
 *
 * 取向与 `repair-domain-orphans.mjs` 一致：**默认 dry-run**、写前备份、幂等、不猜内容
 * （推导不到原因就写诚实占位，指向 run 日志，绝不编造 AI 数值）。
 *
 * 范围：`drafts/rejected`（低分库）+ `drafts/risk`（风险库）。
 *   `drafts/archive/` **不在**范围内 —— 归档的状态词是 `archived`、记录语义也不同，
 *   要纳入得先把那边的事实核清，别顺手把它一起"对账"成留存。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ensureDraftRecord,
  getDraftsDir,
  getRecord,
  parseDraftFile,
  recordHealth,
  upsertRecord,
} from './articles.mjs'
import { localRoot } from './paths.mjs'
import { getTopicPoolFile } from './resources.mjs'
import { readPoolFile } from './topic-pool.mjs'

/** 对账范围：目录 → 记录里的状态词（多一处就要多一套语义，别在这里随手加） */
export const REPAIR_DIRS = { rejected: 'retained', risk: 'retained' }

/**
 * 回填器写进 reason 的标记串。它**不是**原因，只是"这条是被一键生成采纳的"，
 * 所以对账时把它当空值看待（否则会把一句标记抄成留存原因）。
 */
const REASON_MARKERS = new Set(['Console 一键生成'])

/** 推导不到原因时的诚实占位（指向真正的现场：run 日志） */
function placeholderReason(date, slot) {
  return `对账补写：留存原因见 wechat-auto/logs/run-${slot || '?'}-${date || '?'}*.log（原写入方未能落记录）`
}

/**
 * 从选题库给某篇找一个**可信的** reason：`articleId` 精确命中且不是标记串。
 * 读不到库/命中不到/命中的是标记串 → 返回 null（不猜）。
 */
function reasonFromPool(pool, id) {
  if (!pool || !Array.isArray(pool.topics)) return null
  const hit = pool.topics.find((t) => t && String(t.articleId || '') === id)
  const reason = hit && typeof hit.reason === 'string' ? hit.reason.trim() : ''
  if (!reason || REASON_MARKERS.has(reason)) return null
  return reason
}

/** 读选题库（可选增强，读不到就是 null —— 对账不能因为选题库坏了而停摆） */
function readPoolSafe() {
  try {
    return readPoolFile(getTopicPoolFile())
  } catch {
    return null
  }
}

/**
 * 生成对账计划（**只读**，不写盘）。
 *
 * @param {{draftIds?: string[]|null}} [opts] `draftIds` 给了就只查这几篇（流水线收尾时用）
 * @returns {{ok:boolean, items:object[], okCount:number, subs:string[]}}
 */
export function planRecordRepair(opts = {}) {
  const only = Array.isArray(opts.draftIds) && opts.draftIds.length ? new Set(opts.draftIds) : null
  const draftsDir = getDraftsDir()
  const pool = readPoolSafe()
  const items = []
  const conflicts = []
  let okCount = 0
  for (const [sub, status] of Object.entries(REPAIR_DIRS)) {
    const dir = path.join(draftsDir, sub)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const file = path.join(dir, f)
      const id = f.replace(/\.md$/, '')
      if (only && !only.has(id)) continue
      const parsed = parseDraftFile(file)
      if (!parsed || !parsed.id) continue
      const rec = getRecord(id)
      const health = recordHealth(rec)
      const hasRetain = !!(rec && (rec.retainedDir || rec.dir) === sub)
      const statusOk = !!(rec && rec.status === status)
      if (rec && hasRetain && statusOk && health.health === 'ok') {
        okCount += 1
        continue
      }
      // 有过程、但描述的**不是这份产物**（记录说 archive/risk，磁盘上留存库还留着一份同名残本）
      // → 只报告、绝不自动改写。同一个 id 在多个目录各有一份是既有的历史遗留，
      //   把它"对账"成 retained 等于用一次自动写入覆盖掉更晚的归档/风险处置决定。
      if (rec && health.health === 'ok') {
        conflicts.push({
          id,
          file,
          dir: sub,
          recordStatus: rec.status || null,
          recordDir: rec.retainedDir || rec.dir || null,
          recordFile: rec.file || null,
          reason:
            '记录描述的是另一份产物（状态/目录与留存库这一份不一致）；同一 id 在多个目录各有一份，需人工确认，不自动改写',
        })
        continue
      }
      const fromRecord =
        rec && typeof rec.retainedReason === 'string' && rec.retainedReason.trim()
          ? rec.retainedReason.trim()
          : ''
      const fromPool = fromRecord ? null : reasonFromPool(pool, id)
      const reason = fromRecord || fromPool || placeholderReason(parsed.date, parsed.slot)
      items.push({
        id,
        file,
        dir: sub,
        status,
        // 无记录 = create；有记录但**一条过程都没有**（骨架）= fix。
        // 后者正是 2026-10-09 的形状：retainArticle 移了文件、记录写盘 EPERM，
        // scanAndList 只按 frontmatter 登记了 status=draft、history=[] 的骨架。
        action: rec ? 'fix' : 'create',
        reason,
        reasonSource: fromRecord ? 'record' : fromPool ? 'pool' : 'placeholder',
        prevStatus: rec ? rec.status || null : null,
        prevHealth: health.health,
      })
    }
  }
  return { ok: true, items, conflicts, okCount, subs: Object.keys(REPAIR_DIRS) }
}

/**
 * 应用计划：**先备份**涉及的记录原件 → 逐条补写。
 *
 * 为什么 `at` 取文件 mtime：留存是**过去**发生的（通常是几小时前），写"现在"会把时间线
 * 说成假的；mtime 才是这次移动的真实时刻。取不到 mtime 才退回当前时间。
 *
 * 幂等：补好的记录会同时满足 `dir`/`status`/`health` 三条，重复执行结果为空计划。
 */
export function applyRecordRepair(plan, { backupRoot } = {}) {
  if (!plan || !plan.ok) return { ok: false, error: '计划未通过', applied: [] }
  if (!plan.items.length) return { ok: true, backupRoot: null, applied: [] }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = backupRoot || path.join(localRoot(), 'repairs', `${stamp}-records`)
  fs.mkdirSync(root, { recursive: true })
  const applied = []
  for (const it of plan.items) {
    // ① 备份已有记录（没有记录就没有可备份的东西——那也是这次要补的事实）
    const before = getRecord(it.id)
    if (before)
      fs.writeFileSync(path.join(root, `${it.id}.json`), JSON.stringify(before, null, 2) + '\n')
    // ② 建/取记录 → 补留存事实 → 写盘
    const parsed = parseDraftFile(it.file)
    if (!parsed) continue
    const cur = ensureDraftRecord(parsed)
    let at = new Date().toISOString()
    try {
      at = fs.statSync(it.file).mtime.toISOString()
    } catch {
      /* 取不到 mtime 就用当前时间（仅在文件刚被删/权限异常时发生） */
    }
    cur.status = it.status
    cur.dir = it.dir
    cur.retainedDir = it.dir
    cur.retainedReason = it.reason
    cur.file = it.file
    cur.history = Array.isArray(cur.history) ? cur.history : []
    cur.history.push({
      action: 'retain',
      dir: it.dir,
      reason: it.reason,
      at,
      source: 'reconciled',
    })
    upsertRecord(cur)
    applied.push({ id: it.id, dir: it.dir, action: it.action, reasonSource: it.reasonSource, at })
  }
  return { ok: true, backupRoot: root, applied }
}

/**
 * 一步到位：计划（可选只查某几篇）→ 需要时才写。
 * 流水线收尾调用 `reconcileRecords({ apply: true, draftIds: [draftId] })`；
 * 运维/自检调用不带 `draftIds` 就是全量对账。
 */
export function reconcileRecords({ apply = false, draftIds = null, backupRoot } = {}) {
  const plan = planRecordRepair({ draftIds })
  const need = plan.items.length
  if (!apply || !need) return { ...plan, applied: [], need }
  const res = applyRecordRepair(plan, { backupRoot })
  return { ...plan, ...res, need }
}

// author: dos2un1x · repo: https://github.com/dos2un1x/crosspost
