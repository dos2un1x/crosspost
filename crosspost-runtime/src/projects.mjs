/**
 * 项目注册表（P1）——让引擎按**显式契约**认识接入的写作项目。
 *
 * 设计边界（docs/integration.md §2）：
 *   · 引擎**只读 manifest**，不猜测任何项目布局；没有 manifest 就是"未接入"
 *   · manifest 是**声明**，不允许注入可执行代码。`generate` 能力有两种提供方式：
 *     引擎进程内注册钩子（`registerGenerateProvider()`，bridge/topics.mjs），
 *     或 v2 起用对象形态声明一个 HTTP 端点（`{kind:"http",url:"…"}`）——
 *     后者是**纯数据**，让项目与引擎可以分属不同进程/不同仓库。
 *   · 数据访问一律经"提供者"抽象（paths / none），引擎不直接假定目录结构
 *
 * 为什么需要这层：P0 让引擎不再内嵌某一个项目；P1 要让引擎能同时服务**多个**
 * 项目（Console 项目切换器、按项目隔离的数据视图）。没有显式注册表，
 * "多项目"就只能靠路径约定硬凑，那等于把内嵌耦合换成约定耦合。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPaths } from './paths.mjs'
import { readConfig } from './config-cache.mjs'

/** 当前 manifest 契约版本 */
export const MANIFEST_VERSION = 2

/** 引擎已知的能力名（与 docs/integration.md §2 一致） */
export const KNOWN_CAPABILITIES = [
  'drafts',
  'topics',
  // 2026-09-25：`calendar` 随**日历文章模块**一起从白名单删除。它是"不认识的能力名即报错"
  // 那类校验，所以这是一次**破坏性**契约变更：老 manifest 里若还写着 `calendar: true`，
  // 项目会整个变非法（不是"日历视图没了"）。本机接入的项目**从未声明过**它，
  // 所以没有需要先改的 manifest；若将来在别处看到，请从那个项目的 .crosspost/project.json 删掉。
  'retention',
  'reports',
  'generate',
  // v2.3：项目提供 `.crosspost/schedule.json`（槽位命令声明）。
  // 为什么值得单列一个能力：v2.3 起槽位的**命令**只能来自项目声明
  // （不再从操作系统里"学"），于是"这个项目有没有可调度的槽位"变成一则
  // 项目侧事实，声明出来 Console 才能说清"没槽位"与"没声明"的区别。
  'schedule',
]

/**
 * 支持**对象形态**的能力（manifest v2 起）。
 *
 * v1 的能力值只能是布尔：`true` 表达"这个项目有这项能力"，但**没说怎么提供**——
 * 对 `drafts` 这类"引擎直接读目录"的能力够用（目录由 `dataDir` 给出），
 * 对 `generate` 这种"必须调用项目侧代码"的能力就无处可写，于是 P0 只能把它
 * 做成**引擎进程内**注册钩子 —— 项目与引擎必须同进程，跨进程部署做不到。
 *
 * v2 给这类能力加了对象形态：**纯数据**地描述一个跨进程提供者。
 * 仍然不允许注入可执行代码（不许出现 command/script/argv 之类的字段）：
 * 引擎只会按 `url` 发一次 HTTP 请求。
 */
export const OBJECT_CAPABILITIES = ['generate', 'schedule']

/** `generate` 提供者当前支持的 kind（v2 只有 http） */
export const GENERATE_KINDS = ['http']

/**
 * 槽位执行器当前支持的 kind（2026-09-25，同样只有 http）。
 *
 * 为什么槽位也要对象形态：`command` 那条路的语义是"**基座**在自己的进程/容器里
 * 跑项目的业务脚本"——容器化以后必然炸（linux 容器里跑不了宿主原生装的 `dsh`，
 * 2026-09-25 18:10 实测）。声明成 http 之后，到点只是"引擎发一次 HTTP"，执行
 * 发生在项目那边（`src/schedule-provider.mjs`）。
 */
export const SCHEDULE_KINDS = ['http']

/** 槽位执行器允许出现的字段（与 generate 同构，另加 cancelUrl） */
export const SCHEDULE_FIELDS = [
  'kind',
  'url',
  'statusUrl',
  'cancelUrl',
  'timeoutMs',
  'pollIntervalMs',
  'overallTimeoutMs',
  'tokenEnv',
  'description',
]

/** `schedule.http.timeoutMs` 上限（单次受理调用的硬上限） */
export const SCHEDULE_MAX_TIMEOUT_MS = 300000

/** `schedule.http.pollIntervalMs` 上限 */
export const SCHEDULE_MAX_POLL_MS = 60000

/** `schedule.http.overallTimeoutMs` 上限（单次槽位的整任务上限，24h） */
export const SCHEDULE_MAX_OVERALL_MS = 86400000

/** `generate.http.timeoutMs` 上限（引擎一侧的硬上限，防止项目声明一个永不到期的调用） */
export const GENERATE_MAX_TIMEOUT_MS = 300000

/** `generate.http` 允许出现的字段（未知字段一律报错，见 validateGenerateCapability） */
export const GENERATE_FIELDS = [
  'kind',
  'url',
  'statusUrl',
  'timeoutMs',
  'pollIntervalMs',
  'overallTimeoutMs',
  'tokenEnv',
  'description',
]

/** `generate.http.pollIntervalMs` 上限（轮询不能密到把项目侧打成 DoS） */
export const GENERATE_MAX_POLL_MS = 30000

/** `generate.http.overallTimeoutMs` 上限（异步任务的整任务上限，24h） */
export const GENERATE_MAX_OVERALL_MS = 86400000

/** manifest 文件名与所在目录（相对项目根） */
export const MANIFEST_DIR = '.crosspost'
export const MANIFEST_FILE = 'project.json'

/**
 * 解析 manifest 路径来源（按优先级）：
 *   ① config.projects[].root / config.projectsDirs（显式登记）
 *   ② env CROSSPOST_PROJECTS_DIRS（逗号分隔）
 *   ③ loadPaths().projectsDir（默认 <repo>/.local/projects）
 *
 * 每个来源都是一个"项目根目录"：manifest 位于其下的 .crosspost/project.json。
 * 也接受直接给出 .crosspost 目录或 project.json 文件本身。
 */
export function projectRoots() {
  const out = []
  const push = (p) => {
    if (!p || typeof p !== 'string') return
    const abs = path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME || ''))
    if (!out.includes(abs)) out.push(abs)
  }

  // ① config
  try {
    const cfg = readConfig()
    for (const d of cfg.projectsDirs || []) push(d)
    for (const p of cfg.projects || []) {
      if (p && typeof p === 'object') push(p.root)
      else push(p)
    }
  } catch {
    /* 配置不可读时继续用其它来源 */
  }

  // ② env
  const envDirs = process.env.CROSSPOST_PROJECTS_DIRS
  if (envDirs) for (const d of envDirs.split(',')) push(d.trim())

  // ③ 引擎自有默认
  try {
    const lp = loadPaths()
    if (lp.projectsDir) push(lp.projectsDir)
  } catch {
    /* 忽略 */
  }

  return out
}

/**
 * 校验 v2 的**对象形态** `generate` 能力声明，返回错误列表（空数组 = 合法）。
 *
 * 契约要点（见 docs/integration.md §5）：
 *   · `kind: 'http'` + `url` 是必填；引擎只会向这个 url 发一次 POST
 *   · 生成往往要跑几分钟，所以支持**异步模式**：POST 返回 `state:"running"` 时，
 *     若声明了 `statusUrl`，引擎按 `pollIntervalMs` 轮询 `GET <statusUrl>?taskId=…`
 *     直到 done/failed，整任务上限 `overallTimeoutMs`
 *   · `tokenEnv` 只放**环境变量名**，密钥本身绝不写进 manifest
 *     （manifest 会随项目进版本库，写密钥等于泄密）
 *   · 未知字段一律报错——manifest 是显式契约，静默忽略会让"我明明配了"变成悬案
 */
export function validateGenerateCapability(v) {
  return validateHttpCapability(v, {
    capability: 'generate',
    fields: GENERATE_FIELDS,
    kinds: GENERATE_KINDS,
    maxTimeoutMs: GENERATE_MAX_TIMEOUT_MS,
    maxPollMs: GENERATE_MAX_POLL_MS,
    maxOverallMs: GENERATE_MAX_OVERALL_MS,
    extraCheckUrl: () => {},
  })
}

/**
 * 校验 v2 的**对象形态** `schedule` 能力声明（槽位执行器）。
 *
 * 与 `generate` 同构（见 `validateGenerateCapability` 的契约要点），差别只有两点：
 *   · 多一个可选 `cancelUrl`（基座进程退出时尽力取消；未声明则只能"停止跟踪"）
 *   · 语义是"到点该跑这个槽位了"，而不是"生成一篇稿"
 *
 * 声明 `true`（v1 形态）仍然合法，含义不变：**本地命令执行器**
 * （槽位 `command` 在基座进程里跑）—— 向后兼容，容器化部署则需要 http 形态。
 */
export function validateScheduleCapability(v) {
  return validateHttpCapability(v, {
    capability: 'schedule',
    fields: SCHEDULE_FIELDS,
    kinds: SCHEDULE_KINDS,
    maxTimeoutMs: SCHEDULE_MAX_TIMEOUT_MS,
    maxPollMs: SCHEDULE_MAX_POLL_MS,
    maxOverallMs: SCHEDULE_MAX_OVERALL_MS,
    extraCheckUrl: (checkUrl) => checkUrl('cancelUrl', false),
  })
}

/** `generate` / `schedule` 共用的 HTTP 提供者校验（字段表与上限由调用方给） */
function validateHttpCapability(
  v,
  { capability, fields, kinds, maxTimeoutMs, maxPollMs, maxOverallMs, extraCheckUrl },
) {
  const errors = []
  // v1 形态：布尔本身合法（调用方通常已在布尔分支里跳过本函数，但本函数
  // 应当是"全定义"的——否则它会对 true 报"值必须是布尔或对象"，自相矛盾）
  if (typeof v === 'boolean') return errors
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    errors.push(`值必须是布尔或对象（${capability} 支持 {kind:"http",url:"…"}）`)
    return errors
  }
  for (const k of Object.keys(v))
    if (!fields.includes(k)) errors.push(`未知字段: ${k}（允许 ${fields.join(' / ')}）`)

  if (!kinds.includes(v.kind))
    errors.push(`kind 必须是 ${kinds.join('|')}（当前 ${JSON.stringify(v.kind)}）`)

  const checkUrl = (field, required) => {
    const val = v[field]
    if (val === undefined) {
      if (required) errors.push(`${field} 必须是非空字符串`)
      return
    }
    if (typeof val !== 'string' || !val.trim()) {
      errors.push(`${field} 必须是非空字符串`)
      return
    }
    let u = null
    try {
      u = new URL(val)
    } catch {
      errors.push(`${field} 不是合法 URL: ${val}`)
    }
    if (u && !['http:', 'https:'].includes(u.protocol))
      errors.push(`${field} 协议必须是 http/https（当前 ${u.protocol}）`)
  }
  checkUrl('url', true)
  checkUrl('statusUrl', false)
  if (typeof extraCheckUrl === 'function') extraCheckUrl(checkUrl)

  const intIn = (field, max, min = 1) => {
    if (v[field] === undefined) return
    if (!(Number.isInteger(v[field]) && v[field] >= min && v[field] <= max))
      errors.push(`${field} 必须是 ${min}..${max} 的整数`)
  }
  intIn('timeoutMs', maxTimeoutMs)
  intIn('pollIntervalMs', maxPollMs, 250)
  intIn('overallTimeoutMs', maxOverallMs, 1000)

  if (
    v.tokenEnv !== undefined &&
    !(typeof v.tokenEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.tokenEnv))
  )
    errors.push('tokenEnv 必须是合法的环境变量名（只写变量名，不要写密钥本身）')

  if (v.description !== undefined && typeof v.description !== 'string')
    errors.push('description 必须是字符串')

  return errors
}

/** 校验 manifest 结构，返回 { ok, errors, manifest } */
export function validateManifest(raw, sourcePath) {
  const errors = []
  const m = raw && typeof raw === 'object' ? raw : {}

  if (typeof m.id !== 'string' || !m.id.trim()) errors.push('缺少非空 id')
  else if (!/^[A-Za-z0-9._-]+$/.test(m.id))
    errors.push(`id 含非法字符: ${m.id}（仅允许字母数字._-）`)

  if (typeof m.name !== 'string' || !m.name.trim()) errors.push('缺少非空 name')

  const mv = m.manifestVersion
  if (!Number.isInteger(mv) || mv < 1) errors.push('manifestVersion 必须是正整数')
  else if (mv > MANIFEST_VERSION)
    errors.push(`manifestVersion=${mv} 高于引擎支持的 ${MANIFEST_VERSION}（请升级引擎）`)

  const caps = m.capabilities
  if (caps !== undefined) {
    if (typeof caps !== 'object' || caps === null || Array.isArray(caps))
      errors.push('capabilities 必须是对象')
    else {
      for (const [k, v] of Object.entries(caps)) {
        if (!KNOWN_CAPABILITIES.includes(k)) {
          errors.push(`未知能力: ${k}`)
          continue
        }
        // v1 形态：布尔，表达"有/没有这项能力"
        if (typeof v === 'boolean') continue
        // v2 形态：对象（generate / schedule），表达"怎么跨进程提供"
        if (!OBJECT_CAPABILITIES.includes(k)) {
          errors.push(
            `能力 ${k} 的值必须是布尔（v2 仅 ${OBJECT_CAPABILITIES.join('/')} 支持对象形式）`,
          )
          continue
        }
        const validate = k === 'schedule' ? validateScheduleCapability : validateGenerateCapability
        for (const e of validate(v)) errors.push(`能力 ${k}: ${e}`)
      }
    }
  }

  // drafts 能力必须给出 dataDir
  if (caps && caps.drafts === true && (typeof m.dataDir !== 'string' || !m.dataDir.trim()))
    errors.push('声明 drafts 能力时必须提供 dataDir')

  return { ok: errors.length === 0, errors, manifest: m, sourcePath }
}

/**
 * 展开候选 manifest 位置。
 *
 * 每个"项目根"来源都支持两种形态（两种都要，因为使用方式不同）：
 *   ① 来源本身就是**一个项目**（根下有 .crosspost/project.json）
 *   ② 来源是**容器目录**，其每个直接子目录是一个项目（引擎默认
 *      `<repo>/.local/projects` 就是这种）
 *
 * 初版只实现了 ①，导致把 /tmp/xxx 指向容器目录时一个项目都发现不了——
 * 这是"扫描根"与"项目根"语义混淆导致的真实缺陷。
 */
function candidateManifestPaths() {
  const out = []
  const pushIf = (p) => {
    if (!out.includes(p)) out.push(p)
  }
  for (const root of projectRoots()) {
    // ① 根自身是项目
    pushIf(root)
    // ② 直接子目录是项目（跳过隐藏目录与依赖目录）
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      pushIf(path.join(root, e.name))
    }
  }
  return out
}

/** 从候选路径读出 manifest（支持：项目根 / .crosspost 目录 / project.json 文件） */
function readManifestAt(candidate) {
  const tries = [
    path.join(candidate, MANIFEST_DIR, MANIFEST_FILE),
    path.join(candidate, MANIFEST_FILE),
    candidate,
  ]
  for (const p of tries) {
    try {
      if (!fs.statSync(p).isFile()) continue
    } catch {
      continue
    }
    try {
      return { raw: JSON.parse(fs.readFileSync(p, 'utf8')), sourcePath: p }
    } catch (e) {
      return { raw: null, sourcePath: p, parseError: String((e && e.message) || e) }
    }
  }
  return null
}

/**
 * 构建「提供者」：引擎据此访问该项目的数据源。
 *
 * v1 只实现 `paths` 提供者（manifest 声明 dataDir）；`generate` 的 `http`
 * 提供者在 v2 落地于 `src/generate.mjs`（本函数只管**数据**提供者）。
 * 能力缺项 → provider 为 `none`，调用方（Console）应显示"该项目未提供此能力"
 * 而不是报错。
 */
export function buildProvider(manifest, sourcePath) {
  const dataDir = typeof manifest.dataDir === 'string' ? manifest.dataDir : null

  // dataDir 相对项目根解析
  const projectRoot = projectRootOf(sourcePath)
  const absDataDir = dataDir
    ? path.isAbsolute(dataDir)
      ? dataDir
      : path.join(projectRoot || '.', dataDir)
    : null

  let reachable = false
  let reason = null
  if (!dataDir) {
    reason = '未声明 dataDir'
  } else if (!fs.existsSync(absDataDir)) {
    reason = `dataDir 不存在: ${absDataDir}`
  } else {
    reachable = true
  }

  return {
    kind: 'paths',
    dataDir: absDataDir,
    reachable,
    reason,
  }
}

/** 枚举全部已注册项目（含无效项，便于 doctor/Console 报出问题） */
export function listProjects() {
  const out = []
  const seen = new Set()

  for (const candidate of candidateManifestPaths()) {
    const found = readManifestAt(candidate)
    if (!found) continue

    if (found.parseError) {
      out.push({
        id: null,
        name: null,
        sourcePath: found.sourcePath,
        valid: false,
        errors: [`JSON 解析失败: ${found.parseError}`],
      })
      continue
    }

    const v = validateManifest(found.raw, found.sourcePath)
    if (v.manifest.id) {
      if (seen.has(v.manifest.id)) {
        out.push({
          id: v.manifest.id,
          name: v.manifest.name || null,
          sourcePath: found.sourcePath,
          valid: false,
          errors: [`id 重复（已注册于其它路径）: ${v.manifest.id}`],
        })
        continue
      }
      seen.add(v.manifest.id)
    }

    out.push({
      id: v.manifest.id || null,
      name: v.manifest.name || null,
      manifestVersion: v.manifest.manifestVersion ?? null,
      capabilities: v.manifest.capabilities || {},
      style: v.manifest.style || null,
      sourcePath: found.sourcePath,
      valid: v.ok,
      errors: v.errors,
      provider: v.ok ? buildProvider(v.manifest, found.sourcePath) : null,
      // 契约版本兼容性：过旧只告警不拒绝（保留一个版本周期）
      warnings:
        Number(v.manifest.manifestVersion) < MANIFEST_VERSION
          ? [`manifestVersion=${v.manifest.manifestVersion} 低于当前 ${MANIFEST_VERSION}，建议升级`]
          : [],
    })
  }

  return out
}

/** 按 id 取项目（未找到返回 null） */
export function getProject(id) {
  if (!id) return null
  return listProjects().find((p) => p.id === id) || null
}

/**
 * 起效项目（active project）。
 *
 * v1 语义（**保持向后兼容**）：未指定 project 时，引擎沿用 P0 的"单项目"行为
 * ——即不经过注册表，直接用默认路径（paths.json / env）。这保证既有部署
 * 在引入多项目能力后行为完全不变。
 *
 * 指定 project 时，走注册表；未注册或无效则返回 { error }，调用方应回退到
 * 默认行为而不是报错（避免"引入多项目"把老用法打断）。
 */
export function resolveProject(projectId) {
  if (!projectId) return { mode: 'default', project: null }
  const p = getProject(projectId)
  if (!p) return { mode: 'default', project: null, error: `未注册的项目: ${projectId}` }
  if (!p.valid)
    return {
      mode: 'default',
      project: null,
      error: `项目 ${projectId} 的 manifest 无效: ${p.errors.join('; ')}`,
    }
  return { mode: 'project', project: p }
}

/**
 * 取某项目的数据目录（草稿所在）。
 *
 * 用途：内容域的 `project` 维度（P1）。调用方**必须**区分两种语义：
 *   · 不传 projectId → 调用方应回到默认路径（P0 行为），不要调用本函数
 *   · 传了 projectId 且解析成功 → 用返回的 dir
 *   · 传了 projectId 但解析失败 → 返回 { error }，调用方应回退默认并提示
 *
 * 为什么返回对象而不是直接返回路径：`null` 无法区分"没注册"与"注册了但路径不可达"，
 * 而这两种情况给用户的提示完全不同。
 *
 * @param {string|undefined} projectId
 * @returns {{dir:string, projectId:string}|{error:string, projectId:string}}
 */
export function resolveProjectDataDir(projectId) {
  if (!projectId) return { error: '未指定 project', projectId: null }
  const p = getProject(projectId)
  if (!p) return { error: `未注册的项目: ${projectId}`, projectId }
  if (!p.valid) return { error: `项目 ${projectId} 的 manifest 无效`, projectId }
  if (p.provider && p.provider.reachable === false)
    return { error: `项目 ${projectId} 的数据源不可达: ${p.provider.reason}`, projectId }
  if (!p.provider || !p.provider.dataDir)
    return { error: `项目 ${projectId} 未提供数据目录（capabilities.drafts 未声明）`, projectId }
  return { dir: p.provider.dataDir, projectId }
}

/**
 * 从 manifest 源路径反推**项目根**。
 *
 * 支持本模块声明的三种 manifest 位置（见 `readManifestAt`）：
 *   · `<root>/.crosspost/project.json`  → `<root>`（标准布局）
 *   · `<root>/project.json`             → `<root>`
 *   · 直接指向 project.json 文件本身     → 同上（按所在目录判断）
 *
 * 为什么要按目录名判断而不是固定取上两级：旧实现无条件 `dirname(dirname(p))`，
 * 对非标准布局会把**项目根的父目录**当成项目根，相对 dataDir 于是解析到仓库外。
 * 生产当前只有标准布局，属预防性修正（有 tests/projects-contract.test.mjs 覆盖）。
 */
export function projectRootOf(sourcePath) {
  if (!sourcePath) return null
  const abs = path.resolve(sourcePath)
  const dir = path.dirname(abs)
  return path.basename(dir) === MANIFEST_DIR ? path.dirname(dir) : dir
}

/**
 * 取某项目的**引擎簿记目录**（文章记录库）。
 *
 * 语义边界（重要）：这不是项目数据目录，而是引擎自己的记录库——
 * 缺了可以从 drafts 重新扫描生成。因此它落在**引擎 localRoot** 下：
 *   `<localRoot>/project-state/<projectId>/articles`
 *
 * 为什么不放进接入项目的仓库：接入契约里项目只需要提供 `dataDir`（草稿目录）；
 * 引擎不该往别人的仓库里写自己范围的簿记文件。
 *
 * 注意：不要求 `dataDir` 存在（记录库可以先于草稿建成），只要求项目已注册且有效。
 *
 * @param {string|undefined} projectId
 * @returns {{dir:string, projectId:string}|{error:string, projectId:string|null}}
 */
export function resolveProjectStoreDir(projectId) {
  if (!projectId) return { error: '未指定 project', projectId: null }
  const p = getProject(projectId)
  if (!p) return { error: `未注册的项目: ${projectId}`, projectId }
  if (!p.valid) return { error: `项目 ${projectId} 的 manifest 无效`, projectId }
  const local = loadPaths().localRoot || defaultLocalRoot()
  return { dir: path.join(local, 'project-state', projectId, 'articles'), projectId }
}

/** 引擎 localRoot 的兜底值（与 paths.mjs 的默认一致：<repo>/.local） */
function defaultLocalRoot() {
  return (
    process.env.CROSSPOST_LOCAL_ROOT ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.local')
  )
}

/** 注册表健康摘要（供 doctor / Console 接入页展示） */
export function registrySummary() {
  const projects = listProjects()
  return {
    manifestVersion: MANIFEST_VERSION,
    roots: projectRoots(),
    count: projects.length,
    valid: projects.filter((p) => p.valid).length,
    invalid: projects.filter((p) => !p.valid).length,
    projects,
  }
}
