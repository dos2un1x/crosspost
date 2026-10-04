/* CrossPost Console — 入口（2026-08-24 app.js 拆分：共享层 + 视图模块） */
'use strict'

import { $ } from './modules/utils.mjs'
import { initTheme } from './modules/theme.mjs'
import { initArticlesView, loadArticles, refreshStats } from './modules/views-articles.mjs'
import { openDetail, closeDetail } from './modules/views-detail.mjs'
import { initDetailView } from './modules/views-detail-actions.mjs'
import { initTopicsView, loadTopics, stopTopicsPoll } from './modules/views-topics.mjs'
import { initRetainedView, loadRetained } from './modules/views-retained.mjs'
import { initArchiveView, loadArchive } from './modules/views-archive.mjs'
import { initReportsView, loadReports } from './modules/views-reports.mjs'
import { initSettingsView, loadSettings, stopSettingsPoll } from './modules/views-settings.mjs'
import { initEditorView, loadEditor } from './modules/views-editor.mjs'
import { initOnboardingView, loadOnboarding } from './modules/views-onboarding.mjs'
import { initProjectSwitcher } from './modules/project-switch.mjs'
import { loadBrand } from './modules/brand.mjs'
import { loadSlotLexicon } from './modules/slot-lexicon.mjs'

/* ── 视图切换 ─────────────────────── */
/**
 * @param {string} name 视图名
 * @param {{editorId?: string}} [opts] `editorId` = 深链 `#/editor/<id>` 里的草稿 id
 *
 * 为什么把 editorId 收进来（2026-09-29）：`#/editor/<id>` 此前会走两条路 ——
 * `switchView('editor')` 自己调一次 `loadEditor()`（无 id），hash 处理器紧接着又调
 * `loadEditor(id)`。两次都在 await 之后才进 `ensureEditorBuilt`，于是「是否已建」那道门
 * 被同时穿过：同一个 host 里建出**两个** CodeMirror，且先建的空稿盖住了有内容的那一个
 * （源码窗格没字，而 store 与右侧预览是对的）。现在一次导航只调一次 `loadEditor`。
 */
function switchView(name, opts = {}) {
  // 离开设置视图即停止状态轮询（2026-09-11：避免后台空转；只读 /proxy/status 也不该常驻）
  if (name !== 'settings') stopSettingsPoll()
  // 同理（v2.97）：离开选题视图即停"逐条生成任务"轮询。任务本身在**引擎侧**继续跑，
  // 这里只停前端轮询——回到选题页时 loadTopics() 会重新把任务表取回来。
  if (name !== 'topics') stopTopicsPoll()
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'))
  document
    .querySelectorAll('.tab')
    .forEach((t) => t.classList.toggle('active', t.dataset.view === name))
  // 注意：变量名不能叫 el —— 部分视图模块导入了模块级 el() 构造器，
  // 同名局部 const 会造成 TDZ 冲突（v2.03 实测踩到）。
  const viewEl = $('#view-' + name)
  if (!viewEl) {
    // 已删除视图的旧链接（2026-09-25 删「工作流」页）：回落到文章页，别停在
    // "所有 view 都被摘掉 active" 的空白内容区。replaceState 归一 hash，
    // 不触发 hashchange —— 否则会再走一轮 switchView 与取数。
    history.replaceState(null, '', '#/articles')
    return switchView('articles')
  }
  viewEl.classList.add('active')
  if (name === 'onboarding') {
    loadOnboarding()
  } else if (name === 'articles') loadArticles()
  else {
    // 非文章视图：统计刷新与当前视图解耦（2026-08-30 修复：刷新/切到选题等视图
    // 不调用 loadArticles → 右上角 #stats 空白；统一由 refreshStats 兜底。loadArticles 已含，故 else 分支单独调）
    refreshStats()
    if (name === 'topics') loadTopics()
    if (name === 'retained') loadRetained()
    if (name === 'archive') loadArchive()
    if (name === 'settings') loadSettings()
    if (name === 'reports') loadReports()
    if (name === 'editor') loadEditor(opts.editorId)
  }
}

/* ── 启动 ─────────────────────────── */
window.addEventListener('load', async () => {
  // 主题初始化（2026-08-29 深色模式：按钮图标同步 + 切换绑定）
  initTheme()
  // 视图初始化（事件绑定，幂等）
  initArticlesView()
  initDetailView()
  initTopicsView()
  initRetainedView()
  initArchiveView()
  initReportsView()
  initSettingsView()
  initEditorView()
  initOnboardingView()
  // 项目切换器（P1）：拉取 /proxy/projects；失败不影响平台域功能
  initProjectSwitcher()
  // 栏目词典（2026-09-25）：渲染**之前**先取到"本项目怎么称呼各栏目"，
  // 否则首屏会先用前端兜底常量画一遍（"热点①"），到货后再换成项目声明的名字
  // （"热点解读①"）—— 同一页看两次不同名字，比慢一拍更糟。
  // 拿不到就用兜底常量，`loadSlotLexicon` 自己吞失败（5s 超时，不拖首屏）。
  await loadSlotLexicon()
  // 项目切换（v2.22）：内容域所有请求都带当前项目（收口在 modules/api.mjs），
  // 因此切换后**必须重新取数**，否则页面仍显示上一个项目的数据（静默串味）。
  // 只重放"当前视图"，不触发切换器自身的重载，无循环。
  if (!window.__cpProjectRefreshBound) {
    window.__cpProjectRefreshBound = true
    window.addEventListener('crosspost:project-changed', async () => {
      // 词典换了项目 → 先换成新项目的叫法，再重放当前视图（同上：避免先错后对）
      await loadSlotLexicon()
      const m = (location.hash || '#/articles').match(/^#\/([a-z-]+)/)
      switchView(m ? m[1] : 'articles')
    })
  }
  // 品牌图标（左上角 CP + favicon）：每次加载按 config.branding.icon 应用一次
  loadBrand()
  // 初始视图（支持 #/articles/<id>、#/editor/<id> 深链）
  const h = location.hash || '#/articles'
  const dm = h.match(/^#\/articles\/(.+)$/)
  const em = h.match(/^#\/editor\/(.+)$/)
  if (em) {
    switchView('editor', { editorId: decodeURIComponent(em[1]) })
  } else if (dm) {
    switchView('articles')
    openDetail(decodeURIComponent(dm[1]))
  } else {
    // 普通路由：刷新到列表视图时关闭残留抽屉（2026-08-30）
    closeDetail()
    switchView(h.replace('#/', ''))
  }
})

window.addEventListener('hashchange', () => {
  const h = location.hash || '#/articles'
  const dm = h.match(/^#\/articles\/(.+)$/)
  const em = h.match(/^#\/editor\/(.+)$/)
  if (em) {
    switchView('editor', { editorId: decodeURIComponent(em[1]) })
    return
  }
  if (dm) {
    switchView('articles')
    openDetail(decodeURIComponent(dm[1]))
    return
  }
  // 切到列表视图时关闭残留抽屉（2026-08-30 修复：抽屉覆盖新视图残留）
  closeDetail()
  switchView(h.replace('#/', ''))
})
