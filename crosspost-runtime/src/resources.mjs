/**
 * 项目级资源解析（v2.76）：选题库 / 编辑记忆 / 日志 / 项目设置
 *
 * ## 为什么需要这个模块
 *
 * 内容域（草稿 + 文章记录）从 v2.22/v2.74 起就是**按项目**解析的，但周边资源一直是全局的：
 * `paths.json` 的 `logsDir` / `historyDir` / `topicPoolFile` 是**单份**机器配置。于是
 * "换一个项目"只换了草稿与记录目录，选题库、编辑记忆、日志、设置仍然指向同一个地方——
 * 多项目下等于互相串味（Console 里切项目也看不出来）。
 *
 * ## 解析规则：资源跟着**内容工作区**走
 *
 * 项目域：`<内容工作区>/history`、`<内容工作区>/logs`；内容工作区 = manifest `dataDir` 的父目录
 * （见 `project-context.mjs` 的 `currentProjectWorkspace()`）。对任何一个接入的项目而言，
 * 这正好就是它自己的 `history/`、`logs/`——**零迁移**，写作侧
 * persona/脚本写的字面路径继续成立。
 *
 * 默认域（无项目上下文）：沿用既有优先级
 * `env（CROSSPOST_HISTORY_DIR / CROSSPOST_LOGS_DIR / CROSSPOST_TOPIC_POOL）> paths.json > 内置默认`。
 *
 * **优先级与其他内容域一致：项目 > env > paths.json > 内置默认。**
 * 也就是说在项目上下文里，env 不再能把这些资源指到别处——这正是"项目之间必须独立"的含义；
 * 测试要隔离请把项目的 `dataDir` 放进临时目录（沙箱工作区随之隔离）。
 *
 * ## 显式 projectId
 *
 * 每个函数都接受可选的 `projectId`（CLI 脚本、校验器用），优先级高于当前上下文。
 * 显式 id 解析失败 → **回退默认域**（与 `articles.mjs` 对未注册项目的处理一致，不抛错）。
 */
import path from 'node:path'
import { loadPaths } from './paths.mjs'
import { resolveProjectDataDir, listProjects } from './projects.mjs'
import {
  currentProject,
  currentProjectDataDir,
  currentProjectStoreDir,
} from './project-context.mjs'

/**
 * 解析某个项目（或当前上下文）的资源目录。
 *
 * @param {string} [projectId] 显式项目 id；缺省用当前上下文
 * @returns {{id:string, workspace:string, draftsDir:string, historyDir:string,
 *   logsDir:string, topicPoolFile:string, editorialMemoryFile:string,
 *   configFile:string}|null}
 *   `null` = 没有项目上下文、或显式 id 解析不出来（调用方回退默认域）
 */
export function resolveResources(projectId) {
  const explicit = typeof projectId === 'string' ? projectId.trim() : ''
  const id = explicit || currentProject()
  if (!id) return null

  let drafts = null
  if (explicit) {
    const r = resolveProjectDataDir(explicit)
    if (r && r.dir) drafts = r.dir
  } else {
    drafts = currentProjectDataDir()
  }
  if (!drafts) return null

  const workspace = path.dirname(path.resolve(drafts))
  const historyDir = path.join(workspace, 'history')
  // 设置放引擎侧：<localRoot>/project-state/<id>/config.json
  const storeDir = explicit ? null : currentProjectStoreDir()
  const configFile = storeDir
    ? path.join(path.dirname(storeDir), 'config.json')
    : path.join(loadPaths().localRoot, 'project-state', id, 'config.json')

  return {
    id,
    workspace,
    draftsDir: path.resolve(drafts),
    historyDir,
    logsDir: path.join(workspace, 'logs'),
    topicPoolFile: path.join(historyDir, 'topic-pool.json'),
    editorialMemoryFile: path.join(historyDir, 'editorial-memory.json'),
    configFile,
  }
}

/** 当前上下文的资源（无上下文 → `null`） */
export function currentResources() {
  return resolveResources()
}

const cfg = () => loadPaths()

/** 日志目录：项目 > env > paths.json > 内置 */
export function getLogsDir(projectId) {
  const r = resolveResources(projectId)
  if (r) return r.logsDir
  return process.env.CROSSPOST_LOGS_DIR || cfg().logsDir
}

/** history 目录（编辑记忆 / 选题库 / 选题库备份的父目录） */
export function getHistoryDir(projectId) {
  const r = resolveResources(projectId)
  if (r) return r.historyDir
  return process.env.CROSSPOST_HISTORY_DIR || cfg().historyDir
}

/** 选题库文件 */
export function getTopicPoolFile(projectId) {
  const r = resolveResources(projectId)
  if (r) return r.topicPoolFile
  return process.env.CROSSPOST_TOPIC_POOL || cfg().topicPoolFile
}

/** 编辑记忆文件 */
export function getEditorialMemoryPath(projectId) {
  const r = resolveResources(projectId)
  if (r) return r.editorialMemoryFile
  return path.join(getHistoryDir(projectId), 'editorial-memory.json')
}

/** 项目设置文件；默认域 → `null`（默认域设置就是引擎的 `config.json` 本身） */
export function getProjectConfigFile(projectId) {
  const r = resolveResources(projectId)
  return r ? r.configFile : null
}

/**
 * 便利函数：本机**唯一**的合法项目 id（0 个或 ≥2 个 → `''`）。
 *
 * 给 `verify:scheduled` 这类"没有请求上下文、但本机只服务一个项目"的
 * 引擎侧脚本用：多项目机器上必须显式传 `--project=`，避免猜错项目。
 */
export function soleProjectId() {
  try {
    const valid = listProjects().filter((p) => p && p.valid && p.id)
    return valid.length === 1 ? valid[0].id : ''
  } catch {
    return ''
  }
}
