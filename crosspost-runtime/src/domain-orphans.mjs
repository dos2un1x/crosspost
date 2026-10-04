/**
 * 默认域残留记录（domain orphans）——发现、计划、合并（v2.106）
 *
 * ## 这是什么问题
 *
 * 内容域的**簿记**（`project-state/<id>/articles/*.json`）此前只看"请求上下文"：
 * 没有项目上下文时，一切记录都写进默认域。于是一个**没有项目上下文**的会话
 * （GUI 的 web 预设没有 `CROSSPOST_PROJECT`）用绝对路径发布了**接入方项目目录**里的草稿时，会出现：
 *
 *   · 默认域里：一条完整的"已发布"记录（含 wechat mediaId / notify / history）
 *   · 项目域里：一条从 frontmatter 扫出来的空壳（`status: draft`、`history: []`）
 *   · Console：默认视图多了 3 行本不属于它的文章；项目视图把已推送的文章显示成"草稿"
 *
 * v2.106 起写入侧已按草稿归属纠正（`project-context.mjs` 的 `draftScopeOverride`）；
 * 本模块负责**把历史上已经写错位置的记录并回去**，并给 doctor 一条只读检查。
 *
 * ## 合并语义（保守：只搬"事实"，不搬"身份"）
 *
 * 默认域那条记录是**发布事实的来源**（mediaId / 通知回执 / history），项目域那条
 * 可能带项目特有的字段（`dir`、留存信息等）。所以：
 *   · 事实字段以默认域为准：title/file/slot/date/style/decision/review/risk/score/
 *     status/wechat/platforms/notify
 *   · 项目域独有的字段**原样保留**（不在上面这张清单里的一律不覆盖）
 *   · `history` 取并集（按 `at` 排序去重），`createdAt` 取更早、`updatedAt` 取更晚
 *   · 默认域里的同名附带产物（如 `<id>.html`）一并搬进项目簿记目录
 *
 * 身份字段（`id`）不一致时**拒绝**该条，绝不猜。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { defaultArticlesDir } from './articles.mjs'
import { projectOwningDraftFile } from './project-context.mjs'

const require = createRequire(import.meta.url)

/** 以默认域为"事实来源"的字段 */
const FACT_FIELDS = [
  'title',
  'file',
  'slot',
  'date',
  'style',
  'decision',
  'review',
  'risk',
  'score',
  'status',
  'wechat',
  'platforms',
  'notify',
]

/** 簿记目录里的附带产物扩展名（json 是记录本身，单独处理） */
const ARTIFACT_EXT = ['.html', '.png', '.jpg', '.jpeg', '.webp']

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 默认域里"其实属于某个项目"的记录。
 *
 * @returns {Array<{id:string, record:object, recordPath:string, project:string, artifacts:string[]}>}
 */
export function listDefaultDomainOrphans() {
  const defDir = path.resolve(defaultArticlesDir())
  if (!fs.existsSync(defDir)) return []
  const out = []
  for (const name of fs.readdirSync(defDir)) {
    if (!name.endsWith('.json')) continue
    const p = path.join(defDir, name)
    const rec = readJson(p)
    if (!rec || !rec.id || !rec.file) continue
    const project = projectOwningDraftFile(rec.file)
    if (!project) continue
    const id = String(rec.id)
    const artifacts = ARTIFACT_EXT.map((ext) => path.join(defDir, `${id}${ext}`)).filter((f) =>
      fs.existsSync(f),
    )
    out.push({ id, record: rec, recordPath: p, project, artifacts })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** 项目簿记目录（解析失败 → `''`，调用方跳过） */
function projectStoreDir(projectId) {
  const { resolveProjectStoreDir } = require('./projects.mjs')
  const r = resolveProjectStoreDir(projectId)
  return r && r.dir ? path.resolve(r.dir) : ''
}

/**
 * 生成合并计划（只读，不写盘）。
 *
 * @returns {{ok:boolean, blocked:Array, items:Array}}
 */
export function planDomainOrphanRepair() {
  const items = []
  const blocked = []
  const defDir = path.resolve(defaultArticlesDir())
  for (const o of listDefaultDomainOrphans()) {
    const dir = projectStoreDir(o.project)
    if (!dir) {
      blocked.push({ ...o, reason: `项目 ${o.project} 的簿记目录解析失败` })
      continue
    }
    if (dir === defDir) {
      blocked.push({ ...o, reason: '项目簿记目录与默认域是同一个目录（无需搬）' })
      continue
    }
    const targetPath = path.join(dir, `${o.id}.json`)
    const target = fs.existsSync(targetPath) ? readJson(targetPath) : null
    if (target && target.id && String(target.id) !== o.id) {
      blocked.push({ ...o, reason: `目标记录 id 不一致（${target.id} ≠ ${o.id}）` })
      continue
    }
    items.push({
      id: o.id,
      project: o.project,
      defaultRecordPath: o.recordPath,
      targetPath,
      target: target || null,
      merged: mergeRecords(target, o.record),
      artifacts: o.artifacts.map((f) => ({ from: f, to: path.join(dir, path.basename(f)) })),
      factsFromDefault: FACT_FIELDS.filter((k) => o.record[k] !== undefined),
      // `history`/`createdAt`/`updatedAt` 是**合并**（并集/取极值），不算"原样保留"
      keptFromProject: target
        ? Object.keys(target).filter(
            (k) => !FACT_FIELDS.includes(k) && !['history', 'createdAt', 'updatedAt'].includes(k),
          )
        : [],
    })
  }
  return { ok: blocked.length === 0, blocked, items }
}

/** 合并：事实以 `source`（默认域）为准，`target`（项目域）的其它字段原样保留 */
export function mergeRecords(target, source) {
  if (!target) return { ...source }
  const merged = { ...target }
  for (const k of FACT_FIELDS) {
    if (source[k] !== undefined) merged[k] = source[k]
  }
  const hist = []
  const seen = new Set()
  for (const h of [...(target.history || []), ...(source.history || [])]) {
    if (!h) continue
    const key = `${h.at || ''}|${h.action || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    hist.push(h)
  }
  hist.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
  merged.history = hist
  const times = [target.createdAt, source.createdAt].filter(Boolean).sort()
  if (times.length) merged.createdAt = times[0]
  const upd = [target.updatedAt, source.updatedAt, ...hist.map((h) => h.at)].filter(Boolean).sort()
  if (upd.length) merged.updatedAt = upd[upd.length - 1]
  return merged
}

/**
 * 应用修复。**先备份**（默认域原件 + 项目域原件 → `<localRoot>/repairs/<时间戳>/`），
 * 再逐条写项目域、搬附件、最后删默认域记录。
 *
 * 幂等：已经搬过的记录不再出现在 `listDefaultDomainOrphans()` 里；重复执行结果为空计划。
 */
export function applyDomainOrphanRepair(plan, { backupRoot } = {}) {
  if (!plan || !plan.ok) return { ok: false, error: '计划未通过（有 blocked 项）', applied: [] }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root =
    backupRoot ||
    path.join(path.resolve(defaultArticlesDir(), '../../..'), 'repairs', `${stamp}-domain-orphans`)
  fs.mkdirSync(root, { recursive: true })
  const applied = []
  for (const it of plan.items) {
    // ① 备份
    const bdir = path.join(root, it.project)
    fs.mkdirSync(bdir, { recursive: true })
    fs.copyFileSync(it.defaultRecordPath, path.join(bdir, `default-${it.id}.json`))
    if (fs.existsSync(it.targetPath))
      fs.copyFileSync(it.targetPath, path.join(bdir, `project-${it.id}.json`))
    for (const a of it.artifacts)
      fs.copyFileSync(a.from, path.join(bdir, `artifact-${path.basename(a.from)}`))
    // ② 写项目域（先写，成功后再删默认域 —— 任何中断都不会丢记录）
    fs.mkdirSync(path.dirname(it.targetPath), { recursive: true })
    fs.writeFileSync(it.targetPath, JSON.stringify(it.merged, null, 2) + '\n')
    // ③ 搬附件
    for (const a of it.artifacts) {
      if (a.from === a.to) continue
      if (fs.existsSync(a.to)) fs.rmSync(a.to)
      fs.renameSync(a.from, a.to)
    }
    // ④ 删默认域记录
    fs.rmSync(it.defaultRecordPath)
    applied.push({ id: it.id, project: it.project, targetPath: it.targetPath })
  }
  return { ok: true, backupRoot: root, applied }
}

/** 供 doctor 使用：只读地列出"默认域里属于项目的记录"的 id */
export function defaultDomainOrphanIds() {
  return listDefaultDomainOrphans().map((o) => o.id)
}
