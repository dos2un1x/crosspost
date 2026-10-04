// 项目切换器（P1）——Console 通过它选择"当前工作项目"。
//
// 契约（docs/integration.md §1）：引擎只读项目的 .crosspost/project.json，
// 不推测布局。因此这里呈现三种状态：
//   · 未接入任何项目 → 选项显示"未接入项目（平台域可用）"，并禁用
//   · 有项目 → 列出 id/名称；标记不可达/无效的项目，避免用户选中后才失败
//   · 当前选中 → 存入 localStorage，供其它视图读取（P1 后续把 project 参数
//     带入 /proxy/* 内容域请求）
//
// 重要（向后兼容）：未接入项目时 Console 的平台域功能必须完全可用，
// 内容域视图显示空态而不是报错。切换器不得成为使用门槛。
import { $ } from './utils.mjs'
import { getJSON } from './api.mjs'
import { activeProject, setActiveProject } from './active-project.mjs'

// 兼容既有引用（views-onboarding 等）：状态的单一来源在 active-project.mjs
export { activeProject }

/** 渲染下拉选项 */
function renderOptions(select, registry) {
  const projects = (registry && registry.projects) || []
  const valid = projects.filter((p) => p.valid && p.id)
  const current = activeProject()

  select.innerHTML = ''

  const none = document.createElement('option')
  none.value = ''
  none.textContent = valid.length ? '不指定项目（平台域 / 默认路径）' : '未接入项目（平台域可用）'
  select.appendChild(none)

  for (const p of valid) {
    const opt = document.createElement('option')
    opt.value = p.id
    const broken = p.provider && p.provider.reachable === false
    opt.textContent = `${p.name || p.id}${broken ? '（数据源不可达）' : ''}`
    if (broken) opt.title = p.provider.reason || '数据源不可达'
    select.appendChild(opt)
  }

  // 无效项目也列出（让用户知道"有一个接入写错了"），但标记为不可选
  for (const p of projects.filter((x) => !x.valid)) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.disabled = true
    opt.textContent = `⚠ ${p.id || '(无法解析)'}：manifest 无效`
    opt.title = (p.errors || []).join('; ')
    select.appendChild(opt)
  }

  // 当前选中若已消失（项目被移除），回退到"不指定"
  if (current && !valid.some((p) => p.id === current)) {
    setActiveProject('')
    select.value = ''
  } else {
    select.value = current
  }

  select.disabled = valid.length === 0
  const wrap = $('#project-switch')
  if (wrap) {
    wrap.title = valid.length
      ? `已接入 ${valid.length} 个项目`
      : registry && registry.roots
        ? `未接入项目。把 .crosspost/project.json 放到：${registry.roots.join(' 或 ')}`
        : '未接入项目'
  }
}

/** 拉取注册表并渲染（幂等，可重复调用） */
export async function loadProjects() {
  const select = $('#project-select')
  if (!select) return
  let registry = null
  try {
    registry = await getJSON('/proxy/projects')
  } catch {
    /* 桥异常时保持"未接入"外观，不阻断页面 */
  }
  renderOptions(select, registry)

  // 变更提示（谁变更谁负责刷新内容域视图）
  //
  // 2026-09-19（v2.23）**顶栏宽度修复**：这里原先写的是整句说明
  // （如「已接入 1 个项目（未选择具体项目，使用默认路径）」23 字）。`.project-note`
  // 是 `white-space: nowrap`，把 `.project-switch` 撑到 530px、`.topbar-right` 撑到
  // 969px，而 `.topbar-right` 当时不可收缩 → `.tabs` 在 1280–1680px 窗口下被压到
  // 0–365px，**10 个导航 tab 有 7 个既看不见也点不到**（Playwright 实测：
  // 点击 #/topics 报 "intercepted pointer events by #project-note"）。
  //
  // 现在：顶栏只留**短状态**（≤8 字），完整说明挪到 `title` tooltip + 接入页第 4 步。
  //
  // 2026-09-20（v2.87）：顶栏拆成两行后 `.project-note` 不再与导航抢宽，于是这里改回
  // **自解释的完整短语**（不再出现 `1 个可选` / 「不指定项目（平台域 ▾ 1 .」这类半截话）；
  // 完整语义（默认域 = 引擎自有空域、项目域 = 该写作项目的数据目录）仍放 title。
  const banner = $('#project-note')
  if (banner) {
    const current = activeProject()
    const n = (registry && registry.valid) || 0
    if (!n) {
      banner.textContent = '未接入'
      banner.title = '未接入写作项目：平台域功能全部可用，内容视图为空。'
      banner.className = 'project-note'
    } else if (current) {
      banner.textContent = '已选 · 项目域'
      banner.title = `当前项目：${current}（内容域 = 该写作项目的数据目录）`
      banner.className = 'project-note ok'
    } else {
      banner.textContent = '未选择 · 默认域'
      banner.title = `已接入 ${n} 个项目（未选择具体项目，使用引擎默认空域）`
      banner.className = 'project-note'
    }
  }
  return registry
}

export function initProjectSwitcher() {
  const select = $('#project-select')
  if (select && !select.dataset.bound) {
    select.dataset.bound = '1'
    select.addEventListener('change', () => {
      setActiveProject(select.value)
      loadProjects()
    })
  }
  // 首次加载即拉取；失败也不抛出（Console 的平台域不依赖它）
  loadProjects().catch(() => {})
}
