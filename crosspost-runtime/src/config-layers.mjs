/**
 * 配置分层（v2.77）：**引擎级设置** + **项目级设置**
 *
 * ## 为什么分层
 *
 * `config.json` 此前是**单份全局文件**，把两类完全不同的东西混在一起：
 *
 * · **引擎级**（这台机器/这个引擎实例的属性）：代理模式与端口、超时、并发、注册表扫描目录、
 *   平台轮询间隔。它们跟"哪个写作项目"无关。
 * · **项目级**（这个公众号/这个写作项目的属性）：槽位开关与栏目时间、推哪些平台、
 *   通知发到哪、评分阈值、品牌、封面设置、样式启用清单、生成后自动推送。
 *
 * 混在一起的后果：多项目时"换项目"只换了内容域，槽位开关/平台清单/通知对象/评分阈值
 * 仍是同一份——A 项目的设置会作用到 B 项目。v2.77 起项目级设置落到
 * `<localRoot>/project-state/<id>/config.json`（**引擎侧**：设置是引擎行为，与文章记录同处一本账），
 * 生效值 = 引擎 config 深合并上项目覆盖层。
 *
 * ## 分类是**白名单**，未知键一律算引擎级
 *
 * 这条是刻意的防御：万一以后有人新增一个键却忘了归类，它会被写进引擎文件（而不是
 * 悄悄写进某个项目的覆盖层），也不会让某个项目能改到引擎行为。
 * 尤其 `projectsDirs`/`projects` 这类决定"有哪些项目"的键**永远**来自引擎文件——
 * 否则一个项目就能改写注册表（还能造成解析递归）。
 *
 * ## 写入
 *
 * 桥是唯一写者（沿用既有单写者设计）：`/proxy/config` POST 按分类拆分，
 * 项目级键写进项目覆盖层、引擎级键写进引擎 config。默认域（未选项目）下项目级键
 * 写进引擎 config，语义就是"所有项目共用的默认值"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadPaths } from './paths.mjs'
import { configPath } from './config-path.mjs'
import { currentProject, currentProjectConfigFile } from './project-context.mjs'

/**
 * 项目级键（白名单）。含注释里的每个键都必须真的是"每个项目可以不一样"的东西。
 */
export const PROJECT_KEYS = new Set([
  'schedule', // 槽位开关（门禁；'slots' 里也带 enabled，写时两者同步）
  'slots', // **动态槽位定义**（v2.84）：[{id,name,time,enabled}] —— id/名称/时间都可改
  'platforms', // 推哪些平台（platforms.default）
  'notify', // 通知发到哪（飞书群/开关）
  'scoring', // 评分阈值与投资信号
  'branding', // 公众号品牌（名称/图标）
  'coverSettings', // 封面模板/水印
  'styles', // 样式启用清单 + 每槽默认样式
  'autoPush', // 生成后自动推送
])

/** 键属于哪一层：'project' | 'engine'（未知键 → engine） */
export function classifyKey(key) {
  return PROJECT_KEYS.has(key) ? 'project' : 'engine'
}

/** 把一次 patch 拆成 `{ engine, project }` 两半（默认域下 project 那半会写进引擎文件） */
export function splitPatch(patch) {
  const engine = {}
  const project = {}
  for (const [k, v] of Object.entries(patch || {})) {
    if (classifyKey(k) === 'project') project[k] = v
    else engine[k] = v
  }
  return { engine, project }
}

/** 深合并（对象递归、数组与标量后者覆盖；`null` 覆盖） */
export function deepMerge(base, patch) {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v
  }
  return out
}

/** 某个项目的设置文件路径；无项目 → `null` */
export function projectConfigPathOf(projectId) {
  if (projectId) {
    const local = loadPaths().localRoot
    return path.join(local, 'project-state', projectId, 'config.json')
  }
  return currentProjectConfigFile()
}

/**
 * 读项目覆盖层（文件缺失/损坏 → `{}`）。
 *
 * 按 mtime 缓存：`readConfig()` 在热路径上被反复调用（scanAndList 每篇、发布每一步），
 * 每次都读盘不可接受；写者只有桥（可能另有进程），mtime 失效保证写完即新值。
 */
const overlayCache = new Map() // path -> { mtime, data }
export function readProjectConfig(projectId) {
  const file = projectConfigPathOf(projectId)
  if (!file) return {}
  let mtime = 0
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    return {}
  }
  const hit = overlayCache.get(file)
  if (hit && hit.mtime === mtime) return hit.data
  let data = {}
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (d && typeof d === 'object' && !Array.isArray(d)) data = d
  } catch {
    data = {}
  }
  overlayCache.set(file, { mtime, data })
  return data
}

/**
 * 原子写项目覆盖层（tmp+rename，与文章库/编辑记忆同一手法）。
 *
 * · 只接受项目级键：传进来的引擎级键会被**丢掉**并返回在 `ignored` 里（调用方负责提示）
 * · 合并语义是**顶层键替换**（不是深合并）：调用方给的都是完整值，且这样 `schedule: {}`
 *   才能真正清空某个键——深合并做不到"删除"，只会留下旧值。
 */
export function writeProjectConfig(projectId, patch) {
  const file = projectConfigPathOf(projectId)
  if (!file) return { error: '未指定项目（项目级设置需要项目上下文）' }
  const { engine, project } = splitPatch(patch)
  const merged = { ...readProjectConfig(projectId), ...project }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return { file, config: merged, ignored: Object.keys(engine) }
}

/**
 * 把项目覆盖层叠到引擎配置上。
 *
 * **只有 `PROJECT_KEYS` 里的键会被覆盖**——即使有人手改项目覆盖层塞进 `projectsDirs`，
 * 也不会生效（注册表不可被项目改写）。未选项目 → 原样返回引擎配置。
 */
export function withProjectOverlay(engineCfg, projectId) {
  const id = projectId === undefined ? currentProject() : projectId
  if (!id) return engineCfg || {}
  const overlay = readProjectConfig(id)
  const picked = {}
  for (const k of Object.keys(overlay)) if (PROJECT_KEYS.has(k)) picked[k] = overlay[k]
  if (!Object.keys(picked).length) return engineCfg || {}
  return deepMerge(engineCfg || {}, picked)
}

/** 引擎 config 的原始读（自带 mtime 缓存；与 config-cache 的规则同源：`config-path.mjs`） */
const cache = new Map() // path -> { mtime, data }
export function readEngineConfig() {
  const file = configPath()
  let mtime = 0
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    return {}
  }
  const hit = cache.get(file)
  if (hit && hit.mtime === mtime) return hit.data
  let data = {}
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (d && typeof d === 'object' && !Array.isArray(d)) data = d
  } catch {
    data = {}
  }
  cache.set(file, { mtime, data })
  return data
}

/** 当前生效配置 = 引擎 config + 当前项目的覆盖层（无项目 → 引擎 config） */
export function readEffectiveConfig(projectId) {
  return withProjectOverlay(readEngineConfig(), projectId)
}

/** 生效配置里哪些键来自项目覆盖层（Console 用它显示"本项已被项目覆盖"） */
export function projectOverriddenKeys(projectId) {
  const id = projectId === undefined ? currentProject() : projectId
  if (!id) return []
  const overlay = readProjectConfig(id)
  return Object.keys(overlay).filter((k) => PROJECT_KEYS.has(k))
}
