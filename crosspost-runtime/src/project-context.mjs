/**
 * 请求级项目上下文（P1 内容域 `project` 维度接线）——`v2.22`
 *
 * ## 要解决的问题
 *
 * `v2.15` 给 `getDraftsDir(projectId)` 加了项目维度，但**没有任何调用点传参**：
 * 内容域有 80+ 处记录读写、14 处 `getDraftsDir()` 调用，逐点加参数既容易漏，
 * 也把"项目"这个概念泄漏进每一个业务函数签名。
 *
 * 这里改用 **AsyncLocalStorage**：在**请求边界**（CLI 一次执行 / 桥一次 HTTP 请求）
 * 建立一次上下文，此后该调用链上所有 `getDraftsDir()` / `getArticlesDir()`
 * 自动落在对应项目的目录里，**业务代码一行都不用改**。
 *
 * ## 为什么这样是安全的（向后兼容铁律）
 *
 * · **无 project 时不建立上下文**（`withProject('')` 直接 `fn()`），
 *   `store.getStore()` 恒为 `undefined` → 解析函数全走原来的默认路径分支，
 *   返回值与引入本模块之前**逐字一致**。生产单项目部署完全不受影响。
 * · 项目解析失败（未注册 / manifest 无效 / 数据源不可达）时，调用方**回退默认路径**
 *   而不是抛错——引入多项目不该把既有用法打断。
 * · 上下文随调用链结束自然失效（AsyncLocalStorage 按链隔离），无跨请求串味。
 *
 * ## 与 `--project=` 的关系
 *
 * 三个入口共用同一个标志，保证"同一个项目在 CLI / MCP / HTTP 三面语义一致"：
 *   · CLI：`node cli.mjs listArticles --project=my-writing`
 *   · 桥 → CLI worker：`runCli()` 在上下文存在时自动补 `--project=<id>`
 *   · HTTP：`X-CrossPost-Project: my-writing` 或 `?project=my-writing`
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** 命令行/IPC 透传标志（值形如 `--project=my-writing`） */
export const PROJECT_FLAG = '--project='

/** Console / 第三方调用方的请求头（Node 已把请求头名规范化为小写） */
export const PROJECT_HEADER = 'x-crosspost-project'

const store = new AsyncLocalStorage()

/**
 * 在项目上下文中执行 fn。
 *
 * · `projectId` 为空 → **不建立上下文**，直接执行（零开销、行为逐字不变）
 * · 否则建立上下文，并把项目解析结果惰性缓存进去（每个请求只扫一次注册表）
 *
 * @template T
 * @param {string|undefined|null} projectId
 * @param {() => T} fn
 * @returns {T}
 */
export function withProject(projectId, fn) {
  const id = typeof projectId === 'string' ? projectId.trim() : ''
  if (!id) return fn()
  return store.run({ project: id, resolved: null, storeDir: undefined }, fn)
}

/** 当前上下文里的项目 id（无上下文 / 空值 → `''`） */
export function currentProject() {
  const s = store.getStore()
  return (s && s.project) || ''
}

/** 是否存在项目上下文（供 doctor / 测试断言"当前是否在项目域内"） */
export function hasProjectContext() {
  return !!store.getStore()
}

/**
 * projects.mjs 的惰性同步加载器。
 *
 * 为什么惰性：`articles.mjs` 会在**请求路径上**调用本模块，而 `projects.mjs`
 * 又依赖 `paths`/`config-cache`；lazy require 让依赖方向单向、可测、且失败可降级。
 * 依赖 Node ≥22 的 `require(esm)`（本项目强制 Node ≥24，已实测可用）。
 */
let _projectsMod
let _projectsTried = false
function projectsMod() {
  if (_projectsTried) return _projectsMod
  _projectsTried = true
  try {
    _projectsMod = createRequire(import.meta.url)('./projects.mjs')
  } catch {
    _projectsMod = null // 退化：不解析项目 == 无 project 的行为，绝不抛错
  }
  return _projectsMod
}

/**
 * 解析当前上下文的项目（**每请求只解析一次**，结果缓存在上下文对象上）。
 *
 * @returns {{mode:string, project:object|null, error?:string}|null}
 *   `null` = 当前不在任何项目上下文里
 */
export function currentProjectResolution() {
  const s = store.getStore()
  if (!s) return null
  if (!s.resolved) {
    const m = projectsMod()
    s.resolved = m
      ? m.resolveProject(s.project)
      : { mode: 'default', project: null, error: 'projects module unavailable' }
  }
  return s.resolved
}

/** 当前上下文的草稿目录；无上下文或解析失败 → `null`（调用方回退默认路径） */
export function currentProjectDataDir() {
  const r = currentProjectResolution()
  if (!r || r.mode !== 'project' || !r.project || !r.project.provider) return null
  return r.project.provider.dataDir || null
}

/**
 * 当前上下文的**引擎簿记目录**（文章记录库 articles/）。
 *
 * 设计取舍：记录库是**引擎的簿记**（缺了可从 drafts 重新扫描生成），不是项目数据。
 * 因此放在引擎自己的 localRoot 下（`<localRoot>/project-state/<id>/articles`），
 * 不写进接入项目的仓库——接入方只需按契约提供 drafts 目录。
 * 没有 project 时仍用既有默认 `articles/`（生产路径逐字不变）。
 *
 * **每请求只算一次**（v2.32）：本函数的调用点在**循环里**——`recordPath()` 被
 * `upsertRecord()` 每条记录调两次，而 `scanAndList` 会为每篇新草稿登记一次。
 * 不缓存的话每次都要 `getProject()` → `listProjects()` 整表扫描（实测约 0.3ms/次，
 * 200 次 57ms；草稿量上千时是秒级浪费）。缓存挂在上下文对象上，随请求结束释放。
 */
export function currentProjectStoreDir() {
  const s = store.getStore()
  if (!s) return null
  if (s.storeDir === undefined) {
    s.storeDir = computeProjectStoreDir()
  }
  return s.storeDir
}

function computeProjectStoreDir() {
  const r = currentProjectResolution()
  if (!r || r.mode !== 'project' || !r.project || !r.project.id) return null
  const m = projectsMod()
  if (!m || typeof m.resolveProjectStoreDir !== 'function') return null
  const s = m.resolveProjectStoreDir(r.project.id)
  return s && s.dir ? s.dir : null
}

/**
 * 当前上下文的**内容工作区**：`manifest.dataDir` 的父目录（v2.76）。
 *
 * 约定：项目的周边资源（`history/`、`logs/`）都放在内容工作区下——
 * 例如某个项目的 `dataDir` 是 `<root>/pipeline/drafts`，父目录正是 `<root>/pipeline`，
 * 也就是它自己的 `history/`、`logs/` 所在之处：**一个字节都不用搬**。
 * dataDir 是绝对路径（如验收沙箱的 `<tmp>/drafts`）时，工作区就是它的父目录，
 * 于是沙箱自动获得一套完全隔离的资源。
 *
 * 无上下文 / 项目解析失败 → `null`（调用方回退默认域）。每上下文只算一次。
 */
export function currentProjectWorkspace() {
  const s = store.getStore()
  if (!s) return null
  if (s.workspace === undefined) {
    const d = currentProjectDataDir()
    s.workspace = d ? path.dirname(path.resolve(d)) : null
  }
  return s.workspace
}

/** 当前上下文的 `history/`（编辑记忆、选题库、选题库备份都在这里）；无上下文 → `null` */
export function currentProjectHistoryDir() {
  const w = currentProjectWorkspace()
  return w ? path.join(w, 'history') : null
}

/** 当前上下文的 `logs/`（定时轮日志、一键生成日志）；无上下文 → `null` */
export function currentProjectLogsDir() {
  const w = currentProjectWorkspace()
  return w ? path.join(w, 'logs') : null
}

/** 当前上下文的选题库文件（`<工作区>/history/topic-pool.json`）；无上下文 → `null` */
export function currentProjectTopicPoolFile() {
  const h = currentProjectHistoryDir()
  return h ? path.join(h, 'topic-pool.json') : null
}

/**
 * 当前上下文的**项目设置文件**：`<localRoot>/project-state/<id>/config.json`（v2.76）。
 *
 * 放引擎侧而不是项目仓里：设置是**引擎行为**（推哪些平台、通知发到哪、评分阈值、槽位开关），
 * 与文章记录同处一本账；项目仓里只留它自己的写作数据（草稿 / 选题库 / 编辑记忆 / 日志）。
 */
export function currentProjectConfigFile() {
  const r = currentProjectResolution()
  if (!r || r.mode !== 'project' || !r.project || !r.project.id) return null
  const m = projectsMod()
  if (!m || typeof m.resolveProjectStoreDir !== 'function') return null
  const s = m.resolveProjectStoreDir(r.project.id)
  if (!s || !s.dir) return null
  // <localRoot>/project-state/<id>/articles → 上一级 → <id>/config.json
  return path.join(path.dirname(s.dir), 'config.json')
}

/**
 * 从参数数组里摘出 `--project=<id>`，返回 `{ project, args }`。
 *
 * 摘除后剩余参数**顺序与内容不变**——各 handler 的位置参数语义不受影响
 * （例如 `styles delete <name>`）。
 *
 * @param {unknown[]} argv
 */
export function extractProjectFlag(argv) {
  const out = []
  let project = ''
  for (const a of Array.isArray(argv) ? argv : []) {
    const s = typeof a === 'string' ? a : String(a)
    if (s.startsWith(PROJECT_FLAG)) {
      const v = s.slice(PROJECT_FLAG.length).trim()
      if (v) project = v
      continue
    }
    out.push(a)
  }
  return { project, args: out }
}

/**
 * 解析一次请求要使用的项目 id。
 *
 * 优先级：显式请求头 > `?project=` 查询参数 > body.project（调用方先行读出）。
 * 只做**语法**提取，不做注册校验——校验留给 `currentProjectResolution()`，
 * 这样"传了但无效"与"没传"在错误提示上才可区分。
 *
 * @param {{headers?:object, query?:URLSearchParams}} c
 * @param {string} [bodyProject]
 */
export function projectFromRequest(c, bodyProject) {
  const h = (c && c.headers) || {}
  const hv = h[PROJECT_HEADER] || h['X-CrossPost-Project'] || ''
  if (typeof hv === 'string' && hv.trim()) return hv.trim()

  const q = c && c.query
  if (q && typeof q.get === 'function') {
    const qv = q.get('project')
    if (qv && qv.trim()) return qv.trim()
  }

  if (typeof bodyProject === 'string' && bodyProject.trim()) return bodyProject.trim()
  return ''
}

// ─────────────────────────── 草稿归属项目（v2.106） ───────────────────────────

/**
 * 这条草稿属于哪个项目？
 *
 * ## 为什么需要它（一次真实事故）
 *
 * 2026-09-22 21:45–21:53：一个**没有项目上下文**的会话（GUI 的 web 预设没有
 * `CROSSPOST_PROJECT`）用 MCP `publish_article` 带**绝对路径**发布了 3 篇
 * **接入方项目目录**里的草稿。发布成功了，但簿记写进了**默认域**
 * （`.local/project-state/_default/articles`）——于是同一条记录在两处说法不同：
 * 默认域显示"已发布"、项目域显示"草稿"，Console 的默认域里还多了 3 行本不属于它的文章。
 *
 * 根因不是某一条入口写错了，而是**"簿记的域"只看请求上下文，从不看草稿本身属于谁**。
 * 项目注册表里 `manifest.dataDir` 是**声明过的**事实，所以"这条草稿属于哪个项目"
 * 是可以**判定**的（不是猜测）。写操作据此纠正域，读操作保持跟随上下文（视图语义）。
 *
 * ## 匹配规则
 *
 * · 草稿路径落在某项目声明的 drafts 目录内（含子目录）→ 该项目
 * · 多个项目都命中（目录嵌套）→ 取**最长**前缀，结果确定
 * · 不属于任何项目 → `''`（保持调用方原有行为）
 * · 项目解析失败 / 数据源不可达 → 跳过该项目（沿用既有"回退默认"语义，绝不抛错）
 *
 * 路径比较前先 `realpath`（存在时），避免 `/tmp` → `/private/tmp` 这类软链差异。
 */
function normPath(p) {
  const abs = path.resolve(String(p))
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs)
  } catch {
    return abs
  }
}

/** 全部**有效**项目 × 它们声明的草稿目录（按目录长度降序 = 最长前缀优先） */
function projectDraftDirs() {
  const m = projectsMod()
  if (!m || typeof m.listProjects !== 'function' || typeof m.resolveProjectDataDir !== 'function')
    return []
  const out = []
  try {
    for (const p of m.listProjects() || []) {
      if (!p || !p.valid || !p.id) continue
      const r = m.resolveProjectDataDir(p.id)
      if (!r || !r.dir) continue
      out.push({ id: p.id, dir: normPath(r.dir) })
    }
  } catch {
    return []
  }
  return out.sort((a, b) => b.dir.length - a.dir.length)
}

/** 草稿文件落在哪个项目的 drafts 目录里（无归属 → `''`） */
export function projectOwningDraftFile(file) {
  if (!file) return ''
  const abs = normPath(file)
  for (const { id, dir } of projectDraftDirs()) {
    if (abs === dir || abs.startsWith(dir + path.sep)) return id
  }
  return ''
}

/**
 * 按 id 在各项目的草稿目录里找 `<id>.md`（子目录顺序与 publish.mjs 的 findDraftFile 一致）。
 *
 * @returns {{project:string, file:string}|null}
 */
export function findDraftInProjects(id) {
  const name = String(id || '').trim()
  if (!name || /[\\/]/.test(name) || name.includes('..')) return null
  const subs = ['', 'archive', 'rejected', 'risk', 'retained']
  for (const { id: pid, dir } of projectDraftDirs()) {
    for (const sub of subs) {
      const p = path.join(dir, sub, `${name}.md`)
      if (fs.existsSync(p)) return { project: pid, file: p }
    }
  }
  return null
}

/**
 * 请求里那条草稿的归属项目。
 *
 * @param {{file?:string, id?:string}|null|undefined} ref `file` 优先（绝对路径最明确）
 * @returns {string} 项目 id；`''` = 不属于任何项目 / 无法判定
 */
export function projectOwningDraftRef(ref) {
  if (!ref) return ''
  if (ref.file) {
    const byFile = projectOwningDraftFile(ref.file)
    if (byFile) return byFile
  }
  if (ref.id) {
    const found = findDraftInProjects(ref.id)
    if (found) return found.project
  }
  return ''
}

/**
 * 「按草稿归属执行」的判据：返回需要**切换**到的项目 id（无需切换 → `''`）。
 *
 * 只有"归属明确 + 与当前上下文不同"才切换：
 * · 已在归属项目的上下文里 → 不切（零开销、行为逐字不变）
 * · 草稿不属于任何项目 → 不切（默认域自己的草稿就该写在默认域）
 */
export function draftScopeOverride(ref) {
  const owner = projectOwningDraftRef(ref)
  if (!owner) return ''
  if (owner === currentProject()) return ''
  return owner
}
