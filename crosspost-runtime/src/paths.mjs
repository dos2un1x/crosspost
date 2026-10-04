/**
 * CrossPost 路径配置（2026-08-24 路径配置化；2026-09-18 v2.01 引擎自治）
 *
 * 统一读取 crosspost-runtime/paths.json，消除代码内硬编码绝对路径。
 * 优先级：环境变量 > paths.json > 内置默认（默认落在 <repo>/.local 下）。
 *
 * 2026-09-18（v2.01）：内置默认不再指向任何外部写作项目；`generateOnceScript`
 * （曾指向仓库外的接入方生成脚本）已随"引擎不得代跑接入方
 * 业务脚本"一并移除，一键生成改由项目的 manifest 声明（见 docs/integration.md）。
 *
 * 2026-09-19（v2.26）措辞修正：该键**不是从配置里被删掉，而是引擎不再读取它**。
 * `paths.json` 是 gitignored 的本机部署配置，历史版本可能仍留着
 * `generateOnceScript` —— 读到它请视为**死字段**（下面的返回值里没有这个键，
 * `loadPaths()` 也从不读它），不要据此以为引擎还会执行项目的 shell 脚本。
 *
 * 环境变量：
 *   CROSSPOST_LOCAL_ROOT     引擎本地数据根（默认 <repo>/.local）
 *   CROSSPOST_DRAFTS_DIR     草稿目录
 *   CROSSPOST_LOGS_DIR       运行日志目录
 *   CROSSPOST_HISTORY_DIR    历史数据目录（topics/topic-pool/backups）
 *   CROSSPOST_TOPIC_POOL     选题库文件
 *   CROSSPOST_PROJECTS_DIR   项目注册表扫描目录（含 .crosspost/project.json）
 *   CROSSPOST_SESSIONS_DIRS  会话目录（逗号分隔，token 计量用）
 *
 * 2026-09-24（v2.3，调度子系统）：删掉 `launchAgentsDir`
 * （`CROSSPOST_LAUNCH_AGENTS` 一并移除）。它存在的前提是"槽位由 launchd 触发、
 * 引擎要往 `~/Library/LaunchAgents` 写 plist"，而 v2.3 起触发由引擎自带定时器负责
 * （`crosspost-runtime/src/scheduler/`）。旧任务的**只读检测**仍在
 * （`scheduler/legacy.mjs`），但那不需要一条路径配置——迁移期的一次性关注点
 * 不值得再养一个长期配置键。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/** 展开 ~ 前缀为用户主目录 */
function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * paths.json 的**当前生效路径**（v2.66）。
 *
 * 与 `config-cache.mjs` 的 `configPath()` 同构：`CROSSPOST_PATHS` > `<runtime>/paths.json`。
 *
 * 为什么必须可重定向：`paths.json` 此前是**写死的固定路径**，于是任何沙箱都只能
 * 改环境变量、改不了文件——而 `articlesDir`（以及 localRoot 等）恰恰只认文件。
 * 这与 v2.47 修掉的 `CROSSPOST_CONFIG` 脑裂是同一类问题：**沙箱里读着生产配置**。
 * 有了它，测试可以真正把整个路径层关进临时目录。
 */
export function pathsPath() {
  return process.env.CROSSPOST_PATHS || path.join(ROOT, 'paths.json')
}

/**
 * paths.json 读取（按**路径**+mtime 缓存，2026-09-19 v2.66）。
 *
 * 为什么加缓存：本函数此前**每次调用都 readFileSync + JSON.parse**，而 v2.66 起
 * `getArticlesDir()` 也要经它解析 `articlesDir`——而 `getArticlesDir()` 在
 * `recordPath()` 里，即**读一条记录就走一次**（285 条 = 285 次文件读）。
 * 规则与 `config-cache.mjs` 完全一致：mtime 未变则零重读，文件一改下次即新值；
 * 缓存按路径分开记，同一进程内切换 `CROSSPOST_PATHS` 不会串味。
 */
const pathsFileCache = new Map() // path -> { mtimeMs, data }

function readPathsFile() {
  const p = pathsPath()
  try {
    const st = fs.statSync(p)
    const hit = pathsFileCache.get(p)
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.data
    const d = JSON.parse(fs.readFileSync(p, 'utf8'))
    const data = typeof d === 'object' && d ? d : {}
    pathsFileCache.set(p, { mtimeMs: st.mtimeMs, data })
    return data
  } catch {
    pathsFileCache.delete(p)
    return {}
  }
}

/**
 * 引擎本地数据根目录：<repo>/.local
 *
 * 2026-09-18（v2.01，引擎自治）：引擎的**默认**数据位置从外部写作项目
 * （某个具体写作项目的目录）改为**仓库内 `.local/`**（gitignored）。
 * 理由：写作项目与引擎仓库永久分离，引擎不得假定磁盘上存在某个具体项目；
 * `.local/` 是引擎自身的运行数据区，删除即回到全新状态。
 *
 * 接入方项目的数据位置由 `paths.json` / 环境变量显式指定，不再有隐式默认。
 */
export function localRoot() {
  return expandHome(process.env.CROSSPOST_LOCAL_ROOT || path.resolve(ROOT, '..', '.local'))
}

/** 从项目根推导的固定路径（不随 paths.json 变化，故集中在此避免重复） */
function repoPaths() {
  const bridgeDir = path.resolve(ROOT, '..', 'bridge')
  return {
    workspace: bridgeDir,
    bridgeScript: path.join(bridgeDir, 'run-bridge.mjs'),
    tokenFile: path.join(bridgeDir, 'token.local'),
  }
}

/**
 * 读取全部路径配置（展开 ~）。每次调用重读文件——配置极少变化，
 * 且保持与 config.json 同步读取行为一致；性能敏感路径可缓存调用方。
 *
 * 优先级：环境变量 > paths.json > 内置默认（默认落在 <repo>/.local 下）。
 *
 * 注意：本函数返回的是**普通对象**，调用方若在模块顶层 `const paths = loadPaths()`
 * 即会把该次解析结果固化到进程整个生命周期。需要懒解析请用 {@link lazyPaths}。
 */
export function loadPaths() {
  const cfg = readPathsFile()
  // localRoot 的配置来源也包含 paths.json（与其它键一致：env > 文件 > 默认）。
  // 注意：不能直接调用 localRoot() 取其默认，否则 paths.json 里的 localRoot 会被忽略，
  // 而 setup 生成的 paths.json 恰恰以该键为各项派生路径的依据（v2.04 修复）。
  const local = expandHome(
    process.env.CROSSPOST_LOCAL_ROOT || cfg.localRoot || path.resolve(ROOT, '..', '.local'),
  )
  const fixed = repoPaths()
  const defaults = {
    // 引擎自有默认：仓库内 .local/，不含任何外部项目路径
    draftsDir: path.join(local, 'drafts'),
    logsDir: path.join(local, 'logs'),
    historyDir: path.join(local, 'history'),
    topicPoolFile: path.join(local, 'history', 'topic-pool.json'),
    // 文章库（记录 + HTML 归档）默认仍在引擎目录内（<runtime>/articles，历史位置，
    // 不改默认值＝向后兼容）。2026-09-19 v2.66：**新增可配置层**，见下方返回对象。
    articlesDir: path.join(ROOT, 'articles'),
    // 项目注册表扫描目录（P1）：接入项目在此放 .crosspost/project.json
    projectsDir: path.join(local, 'projects'),
    sessionsDirs: ['~/.dsh/sessions'],
    ...fixed,
  }
  const env = process.env
  return {
    localRoot: local,
    draftsDir: expandHome(env.CROSSPOST_DRAFTS_DIR || cfg.draftsDir || defaults.draftsDir),
    // 2026-09-19（v2.66）：articlesDir 此前**只能**用环境变量 `CROSSPOST_ARTICLES_DIR`
    // 覆盖，与 draftsDir/logsDir/historyDir 不对称 —— 而它恰恰是最需要配置的一项：
    // 单项目部署下"默认文章库"就是该项目的簿记目录（否则默认库与项目库两份并存，
    // 谁写谁的、字段级漂移）。现在四者同构：env > paths.json > 内置默认。
    // 注意 `articles.mjs` 的优先级更高一层：**项目上下文永远压过这里**。
    articlesDir: expandHome(env.CROSSPOST_ARTICLES_DIR || cfg.articlesDir || defaults.articlesDir),
    logsDir: expandHome(env.CROSSPOST_LOGS_DIR || cfg.logsDir || defaults.logsDir),
    historyDir: expandHome(env.CROSSPOST_HISTORY_DIR || cfg.historyDir || defaults.historyDir),
    topicPoolFile: expandHome(
      env.CROSSPOST_TOPIC_POOL || cfg.topicPoolFile || defaults.topicPoolFile,
    ),
    projectsDir: expandHome(env.CROSSPOST_PROJECTS_DIR || cfg.projectsDir || defaults.projectsDir),
    bridgeScript: expandHome(cfg.bridgeScript || defaults.bridgeScript),
    workspace: expandHome(cfg.workspace || defaults.workspace),
    tokenFile: expandHome(cfg.tokenFile || defaults.tokenFile),
    sessionsDirs: env.CROSSPOST_SESSIONS_DIRS
      ? env.CROSSPOST_SESSIONS_DIRS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map(expandHome)
      : (cfg.sessionsDirs || defaults.sessionsDirs).map(expandHome),
  }
}

/**
 * 懒解析路径访问器（v2.01 新增）。
 *
 * 用于替换模块顶层的 `const paths = loadPaths()`——那种写法在 import 期就把
 * 路径固化，导致：① 桥启动后无法感知配置变化；② 多项目接入时所有项目共用
 * 同一份路径，架构上不可能成立（见桥 topics/schedule/backup 三处）。
 *
 * 每次属性读取都重新解析，行为与直接调用 loadPaths() 完全一致，且保证
 * 调用方拿到的始终是当前配置解析结果。
 */
export function lazyPaths() {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined
        return loadPaths()[prop]
      },
      has(_t, prop) {
        return prop in loadPaths()
      },
      ownKeys() {
        return Reflect.ownKeys(loadPaths())
      },
      getOwnPropertyDescriptor(_t, prop) {
        const v = loadPaths()[prop]
        return v === undefined ? undefined : { value: v, enumerable: true, configurable: true }
      },
    },
  )
}
