/**
 * 编辑记忆（editorial-memory.json，2026-08-25 起）
 *
 * 选题/写作/人工反馈的累积记忆，注入下轮选题 prompt（近期偏好 + 避雷）。
 * 文件：`<historyDir>/editorial-memory.json`。**historyDir 自 v2.76 起按项目解析**
 * （`resources.mjs` 的 `getEditorialMemoryPath()`：项目上下文 → `<内容工作区>/history`；
 * 无上下文 → env `CROSSPOST_HISTORY_DIR` > `paths.json` > 内置默认）。
 * 此前是 import 期固化的**单份全局文件**，多项目下会互相串味。原子写（tmp+rename）。
 *
 * 三类记录：
 *   recentArticles — 每轮落盘文章 {date,slot,keyword,title,score,thesis,status}（AI 侧 persona 写入）
 *   topicFeedback  — 每轮候选反馈 {date,slot,keyword,action:adopt|reject,reason}（AI 侧 persona 写入）
 *   humanFeedback  — 人工在 Console 的删除反馈 {date,type:article-delete|topic-delete,id,keyword?,reason?}（bridge/cli 写入）
 *
 * 保留上限（防膨胀）：recentArticles ≤ 30 / topicFeedback ≤ 60 / humanFeedback ≤ 30（超限删最旧）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getEditorialMemoryPath } from './resources.mjs'

/**
 * 编辑记忆文件路径（**每次调用都重新解析**）。
 *
 * 2026-09-19（v2.76）：此前是 `export const EDITORIAL_MEMORY_PATH = path.join(paths.historyDir, …)`
 * ——import 期固化，项目上下文中也会写到全局那一份。项目隔离要求它跟着当前项目走，
 * 所以改为函数；旧的常量已无任何读取方（全仓 grep 只有本文件自己）。
 */
export function editorialMemoryPath() {
  return getEditorialMemoryPath()
}

const CAPS = { recentArticles: 30, topicFeedback: 60, humanFeedback: 30 }

/** 读编辑记忆，文件缺失/损坏返回空结构 */
export function readEditorialMemory() {
  try {
    const d = JSON.parse(fs.readFileSync(editorialMemoryPath(), 'utf8'))
    return {
      recentArticles: Array.isArray(d.recentArticles) ? d.recentArticles : [],
      topicFeedback: Array.isArray(d.topicFeedback) ? d.topicFeedback : [],
      humanFeedback: Array.isArray(d.humanFeedback) ? d.humanFeedback : [],
    }
  } catch {
    return { recentArticles: [], topicFeedback: [], humanFeedback: [] }
  }
}

/** 原子写编辑记忆（tmp+rename） */
export function writeEditorialMemory(mem) {
  const target = editorialMemoryPath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const data = {
    _note:
      '编辑记忆(2026-08-25 起):选题/写作/人工反馈累积,注入下轮选题 prompt;recentArticles<=30/topicFeedback<=60/humanFeedback<=30',
    ...mem,
  }
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, target)
  return data
}

/** 追加一条记录并截断超限（原子写）；kind ∈ recentArticles|topicFeedback|humanFeedback */
export function appendEditorialMemory(kind, entry) {
  if (!Object.prototype.hasOwnProperty.call(CAPS, kind)) return
  const mem = readEditorialMemory()
  const list = mem[kind]
  list.push({ ...entry, date: entry.date || new Date().toISOString().slice(0, 10) })
  const cap = CAPS[kind]
  if (list.length > cap) mem[kind] = list.slice(list.length - cap)
  writeEditorialMemory(mem)
}

/**
 * 人工反馈（Console 删除等，由 bridge/cli 调用）：type=article-delete|topic-delete。
 * 记忆写入失败不抛错（不阻塞删除主流程）。
 */
export function pushHumanFeedback(type, payload = {}) {
  try {
    appendEditorialMemory('humanFeedback', { type, ...payload })
    return true
  } catch {
    return false
  }
}
