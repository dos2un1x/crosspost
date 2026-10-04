#!/usr/bin/env node
/**
 * 一次性修复：把**默认域里其实属于某个项目**的簿记记录并回项目域（v2.106）
 *
 *   node crosspost-runtime/src/scripts/repair-domain-orphans.mjs            # 只打印计划（默认）
 *   node crosspost-runtime/src/scripts/repair-domain-orphans.mjs --apply    # 备份后执行
 *   node crosspost-runtime/src/scripts/repair-domain-orphans.mjs --json
 *
 * 为什么需要它（真实事故，2026-09-22 21:45–21:53）：
 *   一个**没有项目上下文**的会话用绝对路径发布了 **接入方项目目录**里的 3 篇草稿。
 *   发布是真的（已进微信草稿箱 + 通知已发），但记录写进了默认域 —— 于是
 *   默认域显示"已发布"、项目域显示"草稿"，Console 默认视图还多了 3 行不属于它的文章。
 *   写入侧已由 v2.106 修掉（按草稿归属纠正域）；本脚本负责把**历史**状态并回去。
 *
 * 安全边界：
 *   · 默认 **dry-run**，只有 `--apply` 才写
 *   · 写之前把所有涉及的默认域/项目域原件备份到 `<localRoot>/repairs/<时间戳>-domain-orphans/`
 *   · 先写项目域、再删默认域（中断也不会丢记录）；只搬"事实字段"，项目域独有字段保留
 *   · 幂等：再跑一次计划为空
 */
import { planDomainOrphanRepair, applyDomainOrphanRepair } from '../domain-orphans.mjs'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const json = argv.includes('--json')

const plan = planDomainOrphanRepair()

if (json) {
  const out = {
    ok: plan.ok,
    dryRun: !apply,
    blocked: plan.blocked.map((b) => ({ id: b.id, reason: b.reason })),
    items: plan.items.map((it) => ({
      id: it.id,
      project: it.project,
      target: it.targetPath,
      hasTargetRecord: !!it.target,
      artifacts: it.artifacts.map((a) => a.from),
      factsFromDefault: it.factsFromDefault,
      keptFromProject: it.keptFromProject,
    })),
  }
  if (apply && plan.ok) Object.assign(out, applyDomainOrphanRepair(plan))
  console.log(JSON.stringify(out, null, 2))
  process.exit(plan.ok ? 0 : 1)
}

console.log('')
console.log('默认域残留记录（属于项目却写在了默认域）')
console.log('─'.repeat(72))
if (!plan.items.length && !plan.blocked.length) {
  console.log('✔ 没有残留：默认域干净（v2.74 的设计：默认 ≠ 项目）')
  console.log('─'.repeat(72))
  process.exit(0)
}
for (const it of plan.items) {
  console.log(`· ${it.id}  →  项目 ${it.project}`)
  console.log(`    默认域记录：${it.defaultRecordPath}`)
  console.log(
    `    项目域记录：${it.targetPath}${it.target ? '（已存在，将合并）' : '（不存在，将新建）'}`,
  )
  console.log(`    取默认域的事实字段：${it.factsFromDefault.join('、')}`)
  if (it.keptFromProject.length) console.log(`    保留项目域字段：${it.keptFromProject.join('、')}`)
  if (it.artifacts.length)
    console.log(`    一并搬运附件：${it.artifacts.map((a) => a.from).join('、')}`)
}
for (const b of plan.blocked) console.log(`✖ 跳过 ${b.id}：${b.reason}`)
console.log('─'.repeat(72))

if (!plan.ok) {
  console.log('有跳过项：先人工确认（脚本不会动它们）。')
  process.exit(1)
}
if (!apply) {
  console.log(`计划 ${plan.items.length} 条。确认无误后加 --apply 执行（会先备份）。`)
  process.exit(0)
}

const r = applyDomainOrphanRepair(plan)
if (!r.ok) {
  console.log(`✖ 执行失败：${r.error}`)
  process.exit(1)
}
console.log(`✔ 已并回 ${r.applied.length} 条；备份：${r.backupRoot}`)
for (const a of r.applied) console.log(`    ${a.id} → ${a.project}`)
