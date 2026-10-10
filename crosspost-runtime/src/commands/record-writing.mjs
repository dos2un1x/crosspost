#!/usr/bin/env node
/**
 * `recordWriting`（2026-10-10）：把**编辑决策**与**独立审稿**写进文章记录。
 *
 * 为什么需要它：这两个字段的写入者本来只有发布器（`publish_article` 的 `decision` / `review` 入参），
 * 而 draft-only 链路（一键生成 / 定时生成）从不调发布器 —— 于是 §2.5 的决策行与 §5.6 的审稿行
 * **产出了却没落点**：Console 抽屉的「编辑决策」「独立审稿」两张卡永远是空的，事后只能翻日志。
 * 一键生成的稿子尤其明显：它们本来就不发布，等于这两样从来没有记录。
 *
 * 用法（CLI 与 MCP 面 `record_writing` 同一个实现）：
 *   node cli.mjs recordWriting --id=<草稿id> --decision="<§2.5 原文>" --review="<§5.6 原文>" --note="…"
 *   · 只给一个也行（另一个字段保持原值，不会被清掉）；
 *   · `--file=<绝对路径>` 与 `--id` 二选一；`--id` 会到各项目草稿树（含 rejected/risk/archive）里找；
 *   · 三个都没给 → 报错（别写一条空历史）。
 * 记录里追加一条 `{action:"writing", decision?, review?, note?}`，Console 的发布历史显示为
 * **写作快照**，并把决策主线与审稿结论渲染成结构化的一行。
 * dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseFlags } from '../argv.mjs'
import { getDraftsDir } from '../articles.mjs'
import { findDraftFile } from './publish.mjs'
import { findDraftInProjects } from '../project-context.mjs'
import { writeDraftRecord } from '../draft-record.mjs'

/** 与 aiDetect 的 `--id` 同一套解析：先当前项目草稿树，再跨项目/子目录兜底 */
function resolveDraft(ref) {
  const raw = String(ref || '').trim()
  if (!raw) return null
  if (path.isAbsolute(raw) || raw.includes(path.sep)) {
    const abs = path.resolve(raw)
    return fs.existsSync(abs) ? abs : null
  }
  const top = path.join(getDraftsDir(), `${raw}.md`)
  if (fs.existsSync(top)) return top
  const found = findDraftFile(raw)
  if (found) return found.file
  const elsewhere = findDraftInProjects(raw)
  return elsewhere ? elsewhere.file : null
}

export async function runRecordWriting(args) {
  const flags = parseFlags(args, { booleans: [] })
  const id = typeof flags.id === 'string' ? flags.id : ''
  const file = typeof flags.file === 'string' ? flags.file : ''
  const decision = typeof flags.decision === 'string' ? flags.decision.trim() : ''
  const review = typeof flags.review === 'string' ? flags.review.trim() : ''
  const note = typeof flags.note === 'string' ? flags.note.trim() : ''
  if (!id && !file) return { error: '缺少输入：--id=<草稿id> 或 --file=<草稿绝对路径>' }
  if (!decision && !review && !note) {
    return { error: '至少给一项：--decision / --review / --note（否则只会写出一条空历史）' }
  }
  const target = resolveDraft(file || id)
  if (!target) return { error: `找不到草稿：${file || id}` }
  const patch = {}
  if (decision) patch.decision = decision
  if (review) patch.review = review
  const entry = {
    action: 'writing',
    ...(decision ? { decision } : {}),
    ...(review ? { review } : {}),
    ...(note ? { note } : {}),
  }
  const out = writeDraftRecord({ file: target, patch, entry })
  // 记账失败不算命令失败（判定/快照本身已经产出），但要把原因如实带出来
  return { ok: !out.recordError, ...out }
}
