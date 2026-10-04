#!/usr/bin/env node
/**
 * CrossPost 文章库：crosspost-runtime/articles/<id>.json（每篇一文件）
 *
 * 职责：
 *  - 扫描草稿目录 drafts/ 并登记为记录（status: draft）
 *  - 读改写记录（发布器写：wechat/platforms/notify/history）
 *  - 列表/详情查询（面板经 bridge 只读）
 *
 * 存储约定：
 *  - articleId = 草稿文件名（去 .md），如 2026-08-19-hotspot-dsh-record
 *  - 记录主字段反映"最近一次发布结果"；每次发布/重推追加 history
 *  - 状态机：draft(未推) → published(全成功) / partial(部分失败) / failed(全失败)
 *
 * 目录可配（优先级从高到低）：项目上下文 / 项目声明的 drafts 目录 > config.json.draftsDir >
 * env CROSSPOST_DRAFTS_DIR > paths.json > 内置默认（仓库内 .local/drafts）
 * 记录目录可配：env CROSSPOST_ARTICLES_DIR（测试/沙箱用）
 *
 * 2026-09-19（v2.22）**内容域 project 维度接线**：
 *   两个目录解析函数都接入请求级项目上下文（src/project-context.mjs）。
 *   无上下文时行为与接线前**逐字一致**；有上下文则落在该项目的目录里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { loadPaths } from './paths.mjs'
import { readConfig } from './config-cache.mjs'
import { currentProjectDataDir, currentProjectStoreDir } from './project-context.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/**
 * 文章库存放位置。
 *
 * 2026-09-18（v2.01）：保留 `ARTICLES_DIR` 常量以兼容既有引用（它在 import 期解析，
 * 会固化该次取值）；新增 `getArticlesDir()` 供**需要懒解析**的场景使用——隔离沙箱
 * 与多项目接入都依赖"读取时才解析"，否则同一进程内无法切换数据源。
 *
 * 2026-09-19（v2.22）：`getArticlesDir(projectId?)` 增加项目维度。**内部读写一律
 * 走本函数**，不要再直接用 `ARTICLES_DIR` 常量，否则多项目下会漏接。
 *
 * 2026-09-19（v2.66）：`getArticlesDir()` 又多了 `paths.json` 的 `articlesDir` 一层，
 * 于是本常量与"当前生效目录"**可能不一致**（它只认环境变量与内置默认）。
 * 实测确认全仓已无任何读取方（只有注释提到它）——**它就是那个陷阱本身**：
 * 保留只为不破坏既有 import，新代码请一律用 `getArticlesDir()`。
 */
export const ARTICLES_DIR = process.env.CROSSPOST_ARTICLES_DIR || path.join(ROOT, 'articles')

/**
 * 懒解析版文章库目录。
 *
 * 解析优先级：
 *   ① 显式 projectId 且注册表解析成功 → 该项目的引擎簿记目录
 *   ② 请求级上下文里的 project 同上（HTTP/CLI 边界建立，见 project-context.mjs）
 *   ③ env CROSSPOST_ARTICLES_DIR > `paths.json` 的 `articlesDir` > `<runtime>/articles`
 *
 * **向后兼容铁律**：无参数且无上下文时的返回值必须与 v2.21 之前**逐字一致** ——
 * 所以最后一层仍是历史上那个 `<runtime>/articles`；新增的 `paths.json` 层只在
 * **显式配置过** `articlesDir` 时才改变结果（v2.66）。
 *
 * **项目上下文永远压过 ③**：这是项目隔离的底线——配了默认库也不许把某个项目的
 * 记录写进"默认"位置。
 *
 * @param {string} [projectId]
 */
export function getArticlesDir(projectId) {
  const explicit = projectId ? projectStoreDirFor(projectId) : null
  const dir = explicit || (projectId ? null : currentProjectStoreDir())
  // 显式 env 只覆盖"默认路径"语义；已解析出的项目目录优先（项目隔离必须成立）
  if (dir) return dir
  return defaultArticlesDir()
}

/**
 * **默认域**（无项目上下文）的簿记目录（v2.106）。
 *
 * 为什么单独导出：`getArticlesDir()` 会跟随当前项目上下文，而 `doctor` 需要在
 * **项目上下文里**仍能检查默认域是否残留着"本该属于某个项目"的记录
 * （2026-09-22 那 3 条就是从这里看出来的：默认域显示已发布、项目域显示草稿）。
 * 口径与 `getArticlesDir()` 的无上下文分支**逐字一致**。
 */
export function defaultArticlesDir() {
  const env = process.env.CROSSPOST_ARTICLES_DIR
  if (env) return env
  // v2.66：paths.json 的 articlesDir（单项目部署下指向该项目的簿记目录，
  // 让"默认"与"项目"落到同一个物理目录，从根上消除两份簿记的漂移）
  return loadPaths().articlesDir || path.join(ROOT, 'articles')
}

/** 显式 projectId → 引擎簿记目录（解析失败返回 null，调用方回退默认） */
function projectStoreDirFor(projectId) {
  const { resolveProjectStoreDir } = requireProjects()
  const r = resolveProjectStoreDir(projectId)
  return r && r.dir ? r.dir : null
}

/**
 * 确保文章库目录存在并返回它（v2.22）。
 *
 * 为什么需要：项目维度的目录**首次使用时并不存在**（引擎按需创建），
 * 而 HTML 归档等写出点历史上依赖目录已由记录写入顺带建好。
 * 统一走本函数，避免"有记录 → 目录在 → 未记录 → 写失败"的间歇性报错。
 */
export function ensureArticlesDir() {
  const dir = getArticlesDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 引擎**内建**栏目（Console 的兜底名表与默认样式用它）。
 *
 * 它**不是"合法栏目的全部"**——栏目 id 由项目声明（`.crosspost/schedule.json` +
 * 项目配置的 `slots[]`），引擎只校验形状。判"某个槽位 id 合不合法"用
 * `normalizeSlotId()`（`scheduler/spec.mjs`）；判"草稿文件名里的栏目段长什么样"
 * 用下面的 `DRAFT_SLOT_SEGMENT_RE`。
 */
export const BUILTIN_SLOTS = new Set(['morning', 'hotspot', 'noon', 'hotspot2', 'tips', 'evening'])

/**
 * 草稿文件名里**栏目段**允许的形状：小写字母开头，只含小写字母与数字，**不含横线**。
 *
 * 为什么比 `SLOT_ID_RE`（允许横线）更严：文件名形态是 `<日期>-<栏目>-<主题>`，而主题里
 * 几乎一定有横线。若栏目段也允许横线，`2026-01-01-deep-dive-ai` 就无法唯一解析
 * （`deep-dive` + `ai`，还是 `deep` + `dive-ai`？）。所以：**栏目 id 建议不带横线**——
 * 带横线的 id 在声明与显示上仍可用，但它的草稿文件名还原不出栏目（会被解析成第一段）。
 */
export const DRAFT_SLOT_SEGMENT_RE = /^[a-z][a-z0-9]*$/

/** 2026-08-28 安全加固：articleId 白名单校验（防路径穿越）。
 *  id 来自文件名/用户输入，含路径分隔符或 .. 会越界读写删除任意文件。
 *  合法 id：YYYY-MM-DD-slot-keyword 形态（字母数字下划线点横线）。 */
/**
 * id 白名单：**必须是单个路径段**，且以字母/数字开头。
 *
 * 为什么用 `\p{L}\p{N}` 而不是 `\w`（2026-10-04）：JS 的 `\w` 是 ASCII-only，
 * 而真实草稿里存在中文 slug（`drafts/risk/2026-08-21-noon-柯洁装弱智赢AI.md`）——
 * 旧写法把这两篇判成"非法 id"，于是它们在引擎侧**做不了任何留存/恢复操作**。
 * 换成 Unicode 字母/数字后覆盖全部 399 篇真实草稿（实测 0 拒绝）。
 *
 * 顺带收紧（旧写法允许、现在拒绝）：`.` / `..` / `__proto__` / 空串 / 任何含空格、
 * 路径分隔符、控制字符的 id —— 首字符必须是字母或数字，所以"点开头的隐藏名"一律不合法。
 */
const SAFE_ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u

export function assertSafeId(id) {
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
    throw new Error(
      `非法 articleId: ${String(id).slice(0, 40)}（只允许单个路径段：字母/数字/下划线/点/横线，可含中文）`,
    )
  }
  return id
}

/**
 * 草稿目录。
 *
 * 解析优先级（**带 projectId 时**）：
 *   ① projectId 已注册且 manifest 有效 → 用它**声明的** dataDir（即使该路径当前不存在）
 *   ② projectId 未注册 / manifest 无效 → 回退默认路径（不打断既有用法）
 *   无 projectId 时：
 *   ③ 请求级上下文里有 project（v2.22，HTTP/CLI 边界建立）→ 同 ①，失败回退
 *   ④ env CROSSPOST_DRAFTS_DIR > config.json.draftsDir > paths.json > 默认
 *
 * **v2.33 语义统一（重要）**：此前 ① 走 `resolveProjectDataDir()`，而它对
 * "manifest 有效但 dataDir 不存在"也返回 error → 回退**默认目录**。
 * 后果是：用户选中一个数据源不可达的项目，看到的却是**另一个项目（默认目录）的文章**，
 * 而界面写着该项目名。更糟的是写操作（归档/留存/发布）会落到那个目录里。
 * 现在注册且有效的项目**永远用它声明的路径**（不存在就是空视图），
 * 与请求级上下文的行为一致——宁可显示为空，不可显示为别人的内容。
 * `resolveProjectDataDir()` 仍然保留"不可达"这一区分，供 doctor / Console 报原因。
 *
 * **向后兼容铁律**：`getDraftsDir()` 无参调用在**无项目上下文**时的返回值必须与引入
 * 本参数之前**逐字一致**。有测试锁死这一点（tests/projects-contract.test.mjs）。
 *
 * @param {string|undefined} projectId 可选；指定时走项目注册表
 */
export function getDraftsDir(projectId) {
  if (projectId) {
    const declared = declaredDraftsDir(projectId)
    if (declared) return declared
  } else {
    // v2.22：仅当确实存在请求级项目上下文时才介入——无上下文时这条分支不触碰任何
    // 额外状态，保证"没传 project"的调用路径与接线前完全等价。
    const ctxDir = currentProjectDataDir()
    if (ctxDir) return ctxDir
  }
  const cfg = readConfig() // 2026-08-28：缓存读取
  if (cfg.draftsDir) return cfg.draftsDir
  return loadPaths().draftsDir
}

/**
 * 取某项目**声明的**草稿目录（不检查可达性），未注册/无效/未声明 drafts → null。
 *
 * 与 `currentProjectDataDir()` 同一语义（后者走请求级上下文），两者必须一致，
 * 否则"显式传参"与"上下文传参"会对同一个项目给出不同的目录。
 */
function declaredDraftsDir(projectId) {
  const { resolveProject } = requireProjects()
  const r = resolveProject(projectId)
  if (r && r.mode === 'project' && r.project && r.project.provider)
    return r.project.provider.dataDir || null
  return null
}

/**
 * projects.mjs 的惰性同步加载器（避开顶层循环依赖）。
 *
 * 为什么需要：projects.mjs 与本模块都依赖 paths/config，顶层静态 import 会成环。
 * 而 `getDraftsDir(projectId)` 必须是**同步**函数（14 处调用点都在同步上下文里）。
 *
 * 依赖 Node ≥22 的 `require(esm)` 能力（本项目强制 Node ≥24，已实测可用）；
 * 若不可用则退化为"不解析项目"，等价于无 projectId 的行为——**绝不因此抛错**。
 */
let _projectsMod = null
function requireProjects() {
  if (_projectsMod) return _projectsMod
  try {
    _projectsMod = createRequire(import.meta.url)('./projects.mjs')
  } catch {
    _projectsMod = { resolveProjectDataDir: () => ({ error: 'projects module unavailable' }) }
  }
  return _projectsMod
}

/** 从文件路径推断所属子目录（顶层为 null；drafts/<sub>/ 下为 sub 名）
 *  2026-08-28：子目录流水线草稿（留存 rejected/risk、归档 archive）要带 dir 标记供隔离与筛选 */
export function inferDraftDir(file) {
  const dir = path.basename(path.dirname(file))
  return dir && dir !== path.basename(getDraftsDir()) ? dir : null
}

/** 解析草稿文件：文件名 YYYY-MM-DD-<slot>-<topic>.md + frontmatter title/score */
export function parseDraftFile(file) {
  const base = path.basename(file, '.md')
  const m = /^(\d{4}-\d{2}-\d{2})-([a-zA-Z0-9]+?)-(.*)$/.exec(base)
  const date = m ? m[1] : null
  const slot = m && DRAFT_SLOT_SEGMENT_RE.test(m[2]) ? m[2] : 'manual'
  const topic = m ? m[3] : base
  let title = base
  let score = null
  let scoreDims = null
  let risk = null
  let coverTemplate = null
  let endingCard = null
  let style = null
  try {
    const text = fs.readFileSync(file, 'utf8')
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (fm) {
      const tm = /^\s*title\s*:\s*(.+?)\s*$/m.exec(fm[1])
      if (tm) title = tm[1].trim()
      // 质量评分（§5.5 写入，发布器自动提取入库）
      const sm = /^\s*score\s*:\s*(\d{1,3})\s*$/m.exec(fm[1])
      if (sm) score = Number(sm[1])
      const sdm = /^\s*score_dims\s*:\s*(.+?)\s*$/m.exec(fm[1])
      if (sdm) {
        try {
          scoreDims = JSON.parse(sdm[1])
        } catch {
          /* 非 JSON 忽略 */
        }
      }
      // 风险属性（2026-08-20：ad/investment/pr，逗号分隔；无风险写 none 或省略）
      const rm = /^\s*risk\s*:\s*(.+?)\s*$/m.exec(fm[1])
      if (rm) {
        const r = rm[1].trim().toLowerCase()
        risk = r && r !== 'none' ? r : null
      }
      // 封面模板（2026-08-27：13 款 COVER_TEMPLATES，如 cover-template: cyber）
      const ctm = /^\s*cover-template\s*:\s*(.+?)\s*$/m.exec(fm[1])
      if (ctm) coverTemplate = ctm[1].trim()
      // 结束语图片开关（2026-08-27：ending-card: false 关闭）
      const ecm = /^\s*ending-card\s*:\s*(true|false)\s*$/m.exec(fm[1])
      if (ecm) endingCard = ecm[1] === 'true'
      // 样式（2026-08-27：AI 按内容所选，发布优先于栏目映射）
      const stm = /^\s*style\s*:\s*(.+?)\s*$/m.exec(fm[1])
      if (stm) style = stm[1].trim()
    }
  } catch {
    /* keep base */
  }
  return {
    id: base,
    file,
    dir: inferDraftDir(file),
    title,
    slot,
    date,
    topic,
    score,
    scoreDims,
    risk,
    coverTemplate,
    endingCard,
    style,
  }
}

export function recordPath(id) {
  assertSafeId(id) // 2026-08-28：路径穿越防护（所有记录读写必经此函数）
  return path.join(getArticlesDir(), `${id}.json`)
}

/* ── 记录层快照缓存（2026-09-25，容器模式性能）─────────────────────
 *
 * 为什么需要：留存库 / 归档库 / 报表三个入口此前**每次打开**都要重读几百个小文件
 * （`/proxy/archive` = 126 md + 126 记录 + 319 记录；`/proxy/costs` = 1400+ 次），
 * 而宿主原生读一个小文件 ~0.07ms、容器里过 Docker Desktop 的 bind mount 要 ~0.5ms
 * ——2026-09-25 实测：同一批 522 个记录文件，容器私有 overlay 8ms、挂载路径 255ms。
 * 于是这三个模块在容器模式下比原生慢 6–7×（现网实测：listArchive 41ms → 265ms）。
 *
 * 判活依据：**记录目录的 mtime**。所有写入都是 tmp + rename（见 upsertRecord），
 * 必然更新目录 mtime；宿主侧项目脚本写记录同样会更新它，所以跨进程也看得见。
 * 缓存粒度是"每个 CLI 进程"（`cli.mjs --ipc` 常驻，见 bridge/cli-worker.mjs），
 * 进程内的写顺带就地刷新缓存条目。
 *
 * 返回一律**浅拷贝**：调用方（例如 `upsertRecord` 的读改写）会就地改对象，
 * 缓存快照绝不能被外部改写。
 *
 * 关掉：`CROSSPOST_DISABLE_RECORD_CACHE=1`（排障 / 需要"逐字回到改动前"时）。
 * ─────────────────────────────────────────────────────────────────────── */
let _snapshot = null // { dir, mtimeMs, entries: Map<id, record>, list: record[] }
const _missing = new Set() // 快照未命中的 id（负缓存：避免反复 stat 不存在的文件）
let _writeOk = true // 一次写失败后停止维护缓存，交给 mtime 判活

/** 读次数计数器（测试与 bench 用；与 token-cost.mjs 的 costIndexStats 同风格） */
const _io = { reads: 0, writes: 0, scans: 0 }

/** 记录 I/O 统计快照（只读） */
export function recordIoStats() {
  return { ..._io }
}

/** 重置记录 I/O 统计（测试用） */
export function resetRecordIoStats() {
  _io.reads = 0
  _io.writes = 0
  _io.scans = 0
}

/** 清空快照缓存（测试用；生产不调用——mtime 判活已足够） */
export function invalidateRecordCache() {
  _snapshot = null
  _missing.clear()
  _writeOk = true
}

function recordCacheEnabled() {
  return process.env.CROSSPOST_DISABLE_RECORD_CACHE !== '1'
}

/** 目录 mtime；目录不存在 → null（"空库"也是合法快照，用 0 与 null 区分） */
function dirMtime(dir) {
  try {
    return fs.statSync(dir).mtimeMs
  } catch {
    return null
  }
}

function entriesOf(list) {
  const m = new Map()
  for (const r of list) if (r && r.id) m.set(r.id, r)
  return m
}

/** 全量重扫记录目录（= 改动前每次调用的价格），同时刷新快照 */
function rescan(dir) {
  _io.scans += 1
  _missing.clear() // 重扫即"重新看一遍磁盘"：负缓存必须同步作废，否则会记住不存在的结论
  let list = []
  if (fs.existsSync(dir)) {
    list = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          _io.reads += 1
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }
  // 关键顺序：先读完、后取 mtime。读期间发生的写会让快照的 mtime 落后于真实值，
  // 于是下一个请求判定为"变了"→ 重扫（宁可多扫一次，不可丢掉一次写）。
  _snapshot = { dir, mtimeMs: dirMtime(dir) ?? 0, entries: entriesOf(list), list }
  return _snapshot
}

/** 取当前记录目录的快照；目录 mtime 未变则零文件读 */
function snapshot() {
  const dir = getArticlesDir()
  if (!recordCacheEnabled()) return rescan(dir)
  const s = _snapshot
  if (s && s.dir === dir && dirMtime(dir) === s.mtimeMs) return s
  return rescan(dir)
}

/** 就地维护快照（写入后调用）：目录 mtime 变了就重扫，否则只改单条 */
function refreshAfterWrite(dir) {
  if (!_writeOk || !recordCacheEnabled()) return
  const s = _snapshot
  if (!s || s.dir !== dir) return
  const mtime = dirMtime(dir)
  if (mtime !== s.mtimeMs) {
    _writeOk = false // 交给 mtime 判活，避免缓存与磁盘长期偏离
    return
  }
  _snapshot = { ...s, entries: new Map(s.entries), list: [...s.list] }
}

/** 写入成功后把一条记录并进快照（新增或替换） */
function mergeSnapshot(rec, dir) {
  if (!_writeOk || !recordCacheEnabled()) return
  const s = _snapshot
  if (!s || s.dir !== dir) return
  const entries = new Map(s.entries)
  entries.set(rec.id, rec)
  const list = s.list.filter((r) => r && r.id !== rec.id)
  list.push(rec)
  _snapshot = { dir: s.dir, mtimeMs: dirMtime(dir) ?? s.mtimeMs, entries, list }
}

/** 写入成功后把一条记录移出快照 */
function dropFromSnapshot(id, dir) {
  if (!_writeOk || !recordCacheEnabled()) return
  const s = _snapshot
  if (!s || s.dir !== dir) return
  const entries = new Map(s.entries)
  entries.delete(id)
  _snapshot = {
    dir: s.dir,
    mtimeMs: dirMtime(dir) ?? s.mtimeMs,
    entries,
    list: s.list.filter((r) => r && r.id !== id),
  }
}

/**
 * 单条记录读取。
 *
 * 命中快照 → 零文件读（这是留存/归档/报表从"每篇一次读盘"回到毫秒级的关键）；
 * 未命中 → 一次负缓存 + 回退一次读盘。
 *
 * **兼容铁律**：非法 id（历史遗留的中文文件名，例如
 * `drafts/risk/2026-08-21-noon-柯洁装弱智赢AI.md`）在改动前后都返回 `null` ——
 * 因为 `assertSafeId` 是在 try 块内、经 `recordPath(id)` 抛出的，会被 catch 吞掉。
 * 这类 id 永远不在快照里，所以快照路径天然不会碰到它们。
 */
export function getRecord(id) {
  const s = recordCacheEnabled() ? snapshot() : null
  if (s && typeof id === 'string') {
    const hit = s.entries.get(id)
    if (hit) return { ...hit }
    // 快照在（mtime 未变）+ 之前查过没有 → 直接判空，不再读盘。
    // 早退让"记录确实不存在"的重复查询只剩一次 stat，也让 `ensureDraftRecord` 不再二次读盘。
    if (_missing.has(id)) return null
  }
  try {
    _io.reads += 1
    return JSON.parse(fs.readFileSync(recordPath(id), 'utf8'))
  } catch {
    if (typeof id === 'string') _missing.add(id)
    return null
  }
}

/** 取记录 history 中最后一次指定 action 的时间戳（2026-09-01 抽 helper，消除 3 处 reverse().find 重复） */
export function lastHistoryAt(rec, action) {
  if (!rec || !Array.isArray(rec.history)) return null
  const h = [...rec.history].reverse().find((x) => x.action === action)
  return h ? h.at : null
}

/** 全量记录（快照命中时零文件读；返回浅拷贝数组，调用方改动不污染缓存） */
export function listRecords() {
  const snap = snapshot()
  return snap.list.map((r) => ({ ...r }))
}

/** 原子写（tmp + rename），防并发损坏 */
export function upsertRecord(record) {
  const dir = getArticlesDir()
  fs.mkdirSync(dir, { recursive: true }) // v2.22：项目维度
  record.updatedAt = new Date().toISOString()
  const tmp = recordPath(record.id) + '.tmp'
  _io.writes += 1
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2))
  fs.renameSync(tmp, recordPath(record.id))
  _missing.delete(record.id)
  refreshAfterWrite(dir)
  mergeSnapshot(record, dir)
  return record
}

/** 追加 history 条目 + 可选主字段 patch；不存在则先建 draft 骨架 */
export function appendHistory(id, entry, patch = {}) {
  const rec = getRecord(id) || {
    id,
    status: 'draft',
    wechat: { status: 'none' },
    platforms: {},
    notify: { status: 'none' },
    history: [],
    createdAt: new Date().toISOString(),
  }
  rec.history = rec.history || []
  rec.history.push({ ...entry, at: entry.at || new Date().toISOString() })
  Object.assign(rec, patch)
  if (patch.updatedAt === undefined) rec.updatedAt = new Date().toISOString()
  return upsertRecord(rec)
}

/** 构造一条草稿登记记录（纯构造，不读写盘） */
function makeDraftRecord(parsed) {
  return {
    id: parsed.id,
    title: parsed.title,
    file: parsed.file,
    dir: parsed.dir || null,
    slot: parsed.slot,
    date: parsed.date,
    style: null,
    status: 'draft',
    risk: parsed.risk || 'unclassified',
    score:
      parsed.score !== null
        ? {
            total: parsed.score,
            ...(parsed.scoreDims ? { dims: parsed.scoreDims } : {}),
            at: new Date().toISOString(),
          }
        : undefined,
    wechat: { status: 'none' },
    platforms: {},
    notify: { status: 'none' },
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/** 登记一条草稿（无记录时）为 draft；同步 frontmatter 的 score/scoreDims/risk（2026-08-22：一键生成草稿评分入库） */
export function ensureDraftRecord(parsed) {
  // 2026-09-25：一次 getRecord 就够——此前写成 `if (getRecord(x)) return getRecord(x)`，
  // 每篇草稿要读两次盘（容器 bind mount 上是 2×0.5ms）。
  const found = getRecord(parsed.id)
  if (found) return found
  return upsertRecord(makeDraftRecord(parsed))
}

/** 记录缺评分但草稿 frontmatter 有评分时回填（2026-08-22：存量 draft-only 文章评分补录） */
export function backfillRecordScore(rec, parsed) {
  if (!rec || (rec.score && rec.score.total !== undefined)) return rec
  if (parsed.score === null) return rec
  const patch = {
    score: {
      total: parsed.score,
      ...(parsed.scoreDims ? { dims: parsed.scoreDims } : {}),
      at: new Date().toISOString(),
    },
  }
  if (!rec.risk || rec.risk === 'unclassified') patch.risk = parsed.risk || 'unclassified'
  return upsertRecord({ ...rec, ...patch })
}

/**
 * 扫描草稿目录 + 合并记录 → 列表（倒序）。
 * 无记录的草稿自动登记为 draft；无文件的记录标 hasFile:false（已删除/归档）。
 * 2026-08-22：记录缺评分时从 frontmatter 回填（一键生成草稿评分入库）。
 *
 * 2026-09-25：原先的 `{dir:'calendar'}` 子目录扫描（日历流水线草稿）随日历模块一并删除。
 * 留存/归档仍各有专属库与专属扫描函数（listRetained / listArchive），不经这里。
 */
export function scanAndList() {
  const records = new Map(listRecords().map((r) => [r.id, r]))
  const out = []
  const draftsDir = getDraftsDir()
  const seen = new Set()
  if (fs.existsSync(draftsDir)) {
    for (const f of fs.readdirSync(draftsDir)) {
      if (!f.endsWith('.md')) continue
      const p = path.join(draftsDir, f)
      const parsed = parseDraftFile(p)
      let rec = records.get(parsed.id)
      if (!rec) {
        // 2026-08-28：records Map 已全量加载，直接构造登记（避免 ensureDraftRecord 内部 getRecord 二次读盘）
        rec = makeDraftRecord(parsed)
        upsertRecord(rec)
        records.set(rec.id, rec)
      } else if (!(rec.score && rec.score.total !== undefined) && parsed.score !== null) {
        rec = backfillRecordScore(rec, parsed)
        records.set(rec.id, rec)
      }
      seen.add(rec.id)
      out.push({ ...rec, hasFile: true })
    }
  }
  for (const rec of records.values()) {
    if (seen.has(rec.id)) continue
    // 2026-08-30 脏数据修复：顶层文章列表必须排除已归档/已留存的记录——
    // runArchiveArticle/runRetainArticle 从不写 rec.dir（dir 恒为 null），
    // 仅靠 status 区分；若不加此判断，113 条 archived/retained 记录会以 hasFile:false
    // 泄漏进文章列表，污染 stats/平台统计/栏目下拉。归档/留存各有专属库，文章模块不展示。
    if (rec.status === 'archived' || rec.status === 'retained') continue
    out.push({ ...rec, hasFile: false })
  }
  // 2026-09-01 排序修正：按生成时间（createdAt，缺省 updatedAt/date）倒序——最后生成的在最前。
  // 原 date 倒序 + id 倒序在同日多篇时按 id 乱排（tips→noon→morning…看似随机）。
  const ts = (r) => {
    const t = new Date(r.createdAt || r.updatedAt || '').getTime()
    return Number.isFinite(t) ? t : 0
  }
  out.sort(
    (a, b) =>
      ts(b) - ts(a) || (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id),
  )
  return out
}

/** 删除记录文件（文章文件被删除时标记，或清理用） */
export function removeRecord(id) {
  try {
    const dir = getArticlesDir()
    fs.unlinkSync(recordPath(id))
    _missing.delete(id)
    refreshAfterWrite(dir)
    dropFromSnapshot(id, dir)
    return true
  } catch {
    return false
  }
}
