/**
 * 内容域备份（文章库 + 草稿）每日一份 tar.gz，**每个内容域各自保留最近 `KEEP_BACKUPS` 份**
 * （从 run-bridge.mjs 拆分，2026-08-24）
 *
 * 2026-09-18（v2.01，引擎自治）：路径改为**懒解析**。原先把 articles/backups/drafts
 * 三个目录在 import 期固化，导致隔离沙箱与多项目接入时读到真实数据（见
 * docs/security.md §3 的写入边界）。现每次调用重新解析；文章库位置改从
 * articles.mjs 取，以尊重 CROSSPOST_ARTICLES_DIR。
 *
 * 2026-09-19（v2.74）：**改为按内容域逐个备份**，不再只绑"默认域"。
 * 背景：v2.74 起默认域与项目域彻底分开（默认域空、项目域才是真数据）。此前
 * `getArticlesDir()` / `paths.draftsDir` 取的都是默认域——别名在时它恰好等于项目域，
 * 所以看不出问题；别名一撤，每日备份会**静默变成"备份空目录"**。
 * 现在遍历：默认域 + 每个合法注册项目域，各自打包进**自己的** `backups/`。
 * 判定与去重见 `backupDomains()`；同物理目录只备份一次。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { lazyPaths } from '../crosspost-runtime/src/paths.mjs'
import { getArticlesDir } from '../crosspost-runtime/src/articles.mjs'
import {
  listProjects,
  resolveProjectStoreDir,
  resolveProjectDataDir,
} from '../crosspost-runtime/src/projects.mjs'

const paths = lazyPaths()
let lastBackupDate = ''

/**
 * 每个内容域各自保留的包数。
 *
 * 导出并被 `/proxy/backup` 带出去（2026-09-25）：Console 的备份卡副标题原先硬写着
 * "保留最近 30 份" —— 那是本模块常量的**第二份副本**，改这里不会改那里。现在卡片
 * 按接口给的 `keep` 渲染，副本消失。
 */
export const KEEP_BACKUPS = 30

/**
 * 待备份的内容域清单：默认域 + 每个合法注册项目域。
 *
 * · 默认域：`getArticlesDir()` + `paths.draftsDir`（v2.74 后是引擎自有的空域，但**照样要列**，
 *   因为用户完全可以在默认域里写作——那时它就是真数据）
 * · 项目域：登记表 `listProjects()` 里 valid 的项目，记录目录取
 *   `resolveProjectStoreDir()`（`<localRoot>/project-state/<id>/articles`），草稿目录取
 *   `resolveProjectDataDir()`（manifest 的 `dataDir`）
 * · **按记录目录去重**：某个项目若与默认域解析到同一物理目录（v2.74 之前就是这种接线），
 *   只备份一次，避免同目录产出两份互相挤占保留额度的包。
 *
 * 单个项目解析失败不影响其余（各 try 各自兜住）。导出供诊断/doctor 查看"到底会备份哪些域"。
 */
export function backupDomains() {
  const out = []
  const push = (id, label, articlesDir, draftsDir) => {
    if (!id || !articlesDir || !draftsDir) return
    const abs = path.resolve(articlesDir)
    if (out.some((d) => path.resolve(d.articlesDir) === abs)) return
    out.push({ id, label, articlesDir, draftsDir })
  }

  push('default', '默认域', getArticlesDir(), paths.draftsDir)

  let projects = []
  try {
    projects = listProjects()
  } catch {
    projects = []
  }
  for (const p of projects) {
    if (!p || !p.valid || !p.id) continue
    try {
      const a = resolveProjectStoreDir(p.id)
      const d = resolveProjectDataDir(p.id)
      if (a && a.dir && d && d.dir) push(p.id, p.name || p.id, a.dir, d.dir)
    } catch {
      /* 单个项目解析失败不阻塞其它域 */
    }
  }
  return out
}

/** 备份输出目录：该内容域文章库同级 backups/ */
function backupDirOf(articlesDir) {
  return path.join(path.dirname(articlesDir), 'backups')
}

/** 目录是否存在且**有内容**。空目录不值得单独产出一个包（v2.74：默认域就是这种空域） */
function hasContent(dir) {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/** 单个内容域：打包 articles/ + drafts/（空/不存在的目录自动跳过），并按本目录的包数裁剪到 `KEEP_BACKUPS` */
function backupDomain(dom) {
  return new Promise((resolve) => {
    const { id, label, articlesDir, draftsDir } = dom
    const BACKUP_DIR = backupDirOf(articlesDir)
    const takeArticles = hasContent(articlesDir)
    const takeDrafts = hasContent(draftsDir)
    if (!takeArticles && !takeDrafts) {
      resolve({ id, label, ok: true, note: '内容域为空，跳过', articlesDir, draftsDir })
      return
    }
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true })
    } catch (e) {
      resolve({ id, label, ok: false, error: String((e && e.message) || e) })
      return
    }
    // 文件名带时间戳（2026-08-19 修复：仅日期会同日覆盖，丢失中间快照）
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const out = path.join(BACKUP_DIR, `articles-${stamp}.tar.gz`)

    // tar 的 -C <父> <名> 只能加**存在**的目录：bsdtar 对不存在的成员会报错退出
    // （旧注释以为"静默跳过"，实测会返回非零——v2.74 顺手按实际行为处理）
    const args = ['-czf', out]
    const add = (dirPath) => args.push('-C', path.dirname(dirPath), path.basename(dirPath))
    if (takeArticles) add(articlesDir)
    // 两个目录同名时只打一次，避免同一条目名出现两次
    if (takeDrafts && path.basename(draftsDir) !== path.basename(articlesDir)) add(draftsDir)

    execFile('/usr/bin/tar', args, { timeout: 120000 }, (err) => {
      if (err) {
        resolve({ id, label, ok: false, error: String(err.message || err), articlesDir })
        return
      }
      try {
        const files = fs
          .readdirSync(BACKUP_DIR)
          .filter((f) => f.startsWith('articles-') && f.endsWith('.tar.gz'))
          .sort()
        for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS)))
          fs.unlinkSync(path.join(BACKUP_DIR, f))
      } catch {
        /* 清理失败不阻塞 */
      }
      resolve({ id, label, ok: true, file: out, articlesDir, draftsDir })
    })
  })
}

/**
 * 备份**全部**内容域。返回结构保持向后兼容（`ok` / `file` 仍在），
 * 新增 `files[]`（本次产出的所有包）与 `domains[]`（逐域结果，含跳过原因）。
 */
export async function backupArticles() {
  const domains = backupDomains()
  const results = []
  for (const d of domains) results.push(await backupDomain(d))
  const files = results.filter((r) => r.file).map((r) => r.file)
  return {
    ok: results.every((r) => r.ok),
    file: files[0],
    files,
    domains: results,
    at: new Date().toISOString(),
  }
}

export async function maybeBackupArticles() {
  const today = new Date().toISOString().slice(0, 10)
  if (lastBackupDate === today) return
  // 跨重启的"当日只备一份"（v2.74）：本函数在桥**每次启动**时都会被调用，而
  // lastBackupDate 只在进程内存里 —— 实测今天 30 份包时间戳全在同一天、间隔几十分钟，
  // 即保留窗口实际是"最近 KEEP_BACKUPS 次重启"而不是 KEEP_BACKUPS 天。所以再查一次磁盘：
  // 任一域当天已有包就不再产出（手工点"立即备份"走 backupArticles()，不受此限）。
  const st = getBackupStatus()
  if ((st.domains || []).some((d) => d.lastAt && d.lastAt.slice(0, 10) === today)) {
    lastBackupDate = today
    console.error(`[bridge] 内容域备份: 今天已有（${st.lastBackup}），跳过`)
    return
  }
  lastBackupDate = today
  const r = await backupArticles()
  const parts = (r.domains || []).map((d) =>
    d.file
      ? `${d.label || d.id}: ${path.basename(d.file)}`
      : `${d.label || d.id}: ${d.note || '失败'}`,
  )
  console.error(
    `[bridge] 内容域备份: ${r.ok ? parts.join(' | ') : '失败 ' + JSON.stringify(r.domains)}`,
  )
}

/**
 * 备份状态：逐域汇总；顶层字段回答"最近一次备份是什么"（取**包数最多**的域，
 * 即真正有内容的那个），保持 `/proxy/health`、`/proxy/backup` 与面板既有取用方式不变。
 */
export function getBackupStatus() {
  const domains = backupDomains().map((d) => {
    const dir = backupDirOf(d.articlesDir)
    let files = []
    try {
      files = fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((f) => f.startsWith('articles-') && f.endsWith('.tar.gz'))
            .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => a.t - b.t)
        : []
    } catch {
      files = []
    }
    const last = files[files.length - 1]
    return {
      id: d.id,
      label: d.label,
      articlesDir: d.articlesDir,
      dir,
      count: files.length,
      lastBackup: last ? last.f : null,
      lastAt: last ? new Date(last.t).toISOString() : null,
      files: files
        .slice(-5)
        .reverse()
        .map((x) => x.f),
    }
  })
  // 顶层代表域 = **包数最多**的那个（真库），包数相同再看谁更新。
  // 为什么不是"最新的那个"：空域一旦产出过一个包，最新时间可能并列，
  // 于是"最近备份"会显示成那个几乎没内容的域（v2.74 实测踩到）。
  const primary =
    [...domains].sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1))[0] || null
  return {
    keep: KEEP_BACKUPS,
    lastBackup: primary ? primary.lastBackup : null,
    count: primary ? primary.count : 0,
    dir: primary ? primary.dir : null,
    files: primary ? primary.files : [],
    domains,
  }
}
