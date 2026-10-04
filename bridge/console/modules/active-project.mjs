// 当前项目的单一来源（Console 侧）
//
// 为什么单独一个模块：`api.mjs`（所有请求的收口）与 `project-switch.mjs`（UI）都要读它。
// 若两者互相 import 会形成循环依赖；浏览器原生 ESM 虽能容忍循环，但"谁先求值"
// 会让行为变得难以推理。这里把**状态**抽成无依赖模块，两边都只依赖它。
//
// 「当前项目」的语义（与引擎侧一致）：
//   · `''` = 不指定项目 → 桥走默认路径（单项目部署的既有行为，逐字不变）
//   · 非空 id = 该项目的注册 id（引擎按 .crosspost/project.json 解析）
// 切换器是**可选项**，不是使用门槛：没有接入任何项目时 Console 一切照旧。
const STORAGE_KEY = 'crosspost.activeProject'

/** 当前选中的项目 id（`''` = 未指定/默认） */
export function activeProject() {
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    // 隐私模式 / 存储被禁用：退化为"未指定项目"，不影响任何功能
    return ''
  }
}

/** 设置当前项目（空值 = 清除）；变更后广播事件供内容视图刷新 */
export function setActiveProject(id) {
  const v = typeof id === 'string' ? id.trim() : ''
  try {
    if (v) localStorage.setItem(STORAGE_KEY, v)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 同上：忽略，退化为"仅本次会话" */
  }
  window.dispatchEvent(new CustomEvent('crosspost:project-changed', { detail: { id: v } }))
}

export { STORAGE_KEY }
