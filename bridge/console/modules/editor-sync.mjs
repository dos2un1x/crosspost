// 编写工作台：编辑器 ↔ 预览 滚动/选区同步引擎（2026-09-05）
//
// 前提：预览 iframe 为 sandbox="allow-same-origin"（无 allow-scripts），父页面可读 iframe DOM；
// 渲染产物由后端 /proxy/render 在顶层块元素上打了 data-block="N"，并在 blocks 里返回
// [{startLine,endLine,type}]（N 与 blocks 下标一致）。
//
// 同步单向映射：
//   编辑器行号 →（blocks[startLine..endLine] 命中块 N）→ iframe [data-block=N] 元素
//   反向：iframe 当前可见块 N → blocks[N].startLine → 编辑器对应行
//
// 防环：syncLock 标志，A→B 期间暂停 B→A，避免无限抖动。
import { store } from './state.mjs'

export const SYNC_HIGHLIGHT_CLASS = 'cm-sync-block'

let editor = null // createEditor 句柄
let frame = null // #ed-preview-frame iframe
let syncLock = false

/** 注入高亮样式 + 预览基础重置到 iframe（同源可写 head；渲染产物无样式表）
 *  - 高亮：同步块 outline
 *  - 重置：html/body 去掉默认 margin/padding，让渲染内容顶格，与左侧编辑器 line 1 对齐
 *    （否则 iframe body 默认 8px 边距 + 外层 <section> 顶部 padding 会把首块下移，左右滚动不同步） */
function ensureHighlightStyle() {
  try {
    const doc = frame.contentDocument
    if (!doc) return
    if (doc.getElementById('cm-sync-style')) return
    const style = doc.createElement('style')
    style.id = 'cm-sync-style'
    style.textContent =
      `.${SYNC_HIGHLIGHT_CLASS}{outline:2px solid rgba(180,67,47,.65);outline-offset:2px;background:rgba(180,67,47,.08);transition:outline .15s,background .15s;}` +
      `html,body{margin:0;padding:0;background:transparent;}` +
      `body{font-size:15px;line-height:1.75;}`
    ;(doc.head || doc.documentElement).appendChild(style)
  } catch {
    /* 同源失败静默 */
  }
}

/** 取预览 iframe 内 [data-block=N] 元素 */
function blockEl(n) {
  try {
    return frame.contentDocument && frame.contentDocument.querySelector(`[data-block="${n}"]`)
  } catch {
    return null
  }
}

/** 清除所有块高亮 */
export function clearBlockHighlight() {
  try {
    const doc = frame.contentDocument
    if (!doc) return
    doc
      .querySelectorAll(`.${SYNC_HIGHLIGHT_CLASS}`)
      .forEach((el) => el.classList.remove(SYNC_HIGHLIGHT_CLASS))
  } catch {
    /* 忽略 */
  }
}

/** 高亮单个块（并清除其他） */
export function highlightBlock(n) {
  clearBlockHighlight()
  if (n == null || n < 0) return
  const el = blockEl(n)
  if (el) el.classList.add(SYNC_HIGHLIGHT_CLASS)
}

/** 根据编辑器选中区间求「所在块下标」，无命中返回 -1 */
function blockIndexForSelection(sel) {
  if (!sel) return -1
  const blocks = store.editor.blocks
  if (!blocks || !blocks.length) return -1
  const line = editor ? editor.getCursorLine() : 1
  // 用光标行命中块：startLine<=line<=endLine；否则取光标前最近块
  for (let i = 0; i < blocks.length; i++) {
    if (line >= blocks[i].startLine && line <= blocks[i].endLine) return i
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].startLine <= line) return i
  }
  return -1
}

/** 编辑器滚动 → 预览滚动（对应当前可见顶部行所在块） */
function onEditorScroll() {
  if (syncLock || !store.editor.syncOn || !frame) return
  syncLock = true
  try {
    const pos = editor && editor.getScrollTopPos && editor.getScrollTopPos()
    if (pos == null) return
    const line = editor.view.state.doc.lineAt(pos).number
    const idx = blockIndexForLine(line)
    if (idx >= 0) {
      const el = blockEl(idx)
      if (el) {
        ensureHighlightStyle()
        el.scrollIntoView({ block: 'start', behavior: 'auto' })
      }
    }
  } catch {
    /* 忽略 */
  } finally {
    setTimeout(() => {
      syncLock = false
    }, 40)
  }
}

/** 渲染/输入后按编辑器当前顶部行重新对齐预览（type/enter 不会触发 scroll 事件，须显式对齐）。
 *  在 refreshEditorPreview 重新 srcdoc（iframe 重载、预览回到顶部）后调用，恢复左右位置一致。 */
export function syncPreviewFromEditor() {
  if (!store.editor.syncOn || !editor || !frame) return
  onEditorScroll()
}

function blockIndexForLine(line) {
  const blocks = store.editor.blocks
  for (let i = 0; i < blocks.length; i++) {
    if (line >= blocks[i].startLine && line <= blocks[i].endLine) return i
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].startLine <= line) return i
  }
  return -1
}

/** 预览滚动 → 编辑器滚动（取顶部可见 block → 源码 startLine） */
function onPreviewScroll() {
  if (syncLock || !store.editor.syncOn || !editor) return
  syncLock = true
  try {
    const doc = frame.contentDocument
    if (!doc) return
    const els = doc.querySelectorAll('[data-block]')
    if (!els.length) return
    const scrollTop = frame.contentWindow.scrollY || doc.documentElement.scrollTop || 0
    let current = 0
    for (const el of els) {
      const top = el.getBoundingClientRect().top + scrollTop
      if (top <= scrollTop + 60) {
        current = Number(el.getAttribute('data-block')) || 0
      } else break
    }
    const block = store.editor.blocks[current]
    if (block) {
      const pos = editor.view.state.doc.line(block.startLine).from
      editor.scrollToPos(pos, 'start')
    }
  } catch {
    /* 忽略 */
  } finally {
    setTimeout(() => {
      syncLock = false
    }, 40)
  }
}

/** 编辑器选区变化 → 预览高亮对应块（供 views-editor onSelection 调用） */
export function editorSelectionHandler(sel) {
  if (!store.editor.syncOn) return
  const idx = blockIndexForSelection(sel)
  if (idx >= 0) highlightBlock(idx)
}

/** 预览点击 → 编辑器光标跳到对应源码行 */
function onPreviewClick(e) {
  if (!store.editor.syncOn || !editor) return
  const target = e.target && e.target.closest ? e.target.closest('[data-block]') : null
  if (!target) return
  const n = Number(target.getAttribute('data-block'))
  if (Number.isFinite(n)) {
    const block = store.editor.blocks[n]
    if (block) {
      const from = editor.view.state.doc.line(block.startLine).from
      editor.view.dispatch({ selection: { anchor: from, head: from } })
      editor.view.focus()
    }
  }
}

/** 让左侧源码与右侧预览**同一套字形**（v2.97.4）。
 *
 *  为什么必须"从渲染产物里读"而不是写死一套：
 *  正文的字形由**所选风格**决定 —— 实测启用中的 16 个风格：
 *    · 字号都是 15px（这点一致）
 *    · 行高 1.75(swiss) / 1.8(ink,apple,bytedance…) / 1.88(product) / 1.9(default,modern,tech…)
 *           / 1.92(darktech) / 1.95(minimal) / 2.0(longform)
 *    · 字族 sans（多数）/ **Cormorant Garamond 衬线**（ink）/ PingFang 打头（apple 系）
 *  写死任何一套 ⇒ 用户一换风格左右就不一致，正好违背"要一直保持一致"。
 *
 *  读法：渲染产物在顶层块上打了 data-block，正文块就是 `<p data-block="N">`。
 *  取首个 `<p>` 的 computed font-family / font-size / line-height（computed 的 line-height
 *  已是 px 绝对值，可直接用），写到编辑器宿主 `#ed-editor-host` 的 CSS 变量上，
 *  由 `.cm-host .cm-scroller` 消费 —— 于是 `.cm-content` 与行号槽都跟着走。
 *  任何一步失败都静默退回 CSS 里的默认值（--sans / 15px / 1.75）。 */
function applyProseTypography() {
  const host = document.getElementById('ed-editor-host')
  if (!host || !frame) return
  try {
    const doc = frame.contentDocument
    if (!doc || !doc.body) return
    const el =
      doc.querySelector('p[data-block]') || doc.querySelector('p') || doc.body.firstElementChild
    if (!el) return
    const cs = (doc.defaultView || window).getComputedStyle(el)
    if (cs.fontFamily) host.style.setProperty('--ed-prose-font', cs.fontFamily)
    if (cs.fontSize) host.style.setProperty('--ed-prose-size', cs.fontSize)
    if (cs.lineHeight && cs.lineHeight !== 'normal') {
      host.style.setProperty('--ed-prose-lh', cs.lineHeight)
    }
  } catch {
    /* 同源失败 / 过渡期：沿用 CSS 默认值 */
  }
}

/** 绑定预览滚动/点击（同源后可读 DOM；srcdoc 每次 load 重绑） */
function bindPreviewEvents() {
  if (!frame || !frame.contentDocument) return
  try {
    ensureHighlightStyle()
    applyProseTypography()
    const win = frame.contentWindow
    const doc = frame.contentDocument
    win.removeEventListener('scroll', onPreviewScroll)
    doc.removeEventListener('click', onPreviewClick)
    win.addEventListener('scroll', onPreviewScroll, { passive: true })
    doc.addEventListener('click', onPreviewClick)
  } catch {
    /* 跨源/过渡期忽略 */
  }
}

/** 初始化：绑定编辑器句柄 + 预览 iframe 事件（幂等） */
export function attachSync({ editorHandle, previewFrame }) {
  editor = editorHandle
  frame = previewFrame
  if (!frame) return
  // 编辑器滚动
  if (editor && editor.view) {
    editor.view.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true })
  }
  // 预览滚动/点击：srcdoc 每次加载都触发 load，用常驻 load 监听统一绑定（首次 + 每次重渲染）
  frame.addEventListener('load', bindPreviewEvents)
  if (frame.contentDocument) bindPreviewEvents()
}

/** 设置预览块映射（渲染返回后调用） */
export function setPreviewBlocks(blocks) {
  store.editor.blocks = Array.isArray(blocks) ? blocks : []
}

/** 每次预览 srcdoc 更新后调用。srcdoc 是异步的：iframe 会重新加载并触发 load →
 *  attachSync 里常驻的 load 监听会自动重新 bindPreviewEvents，故这里无需重复绑，
 *  只需确保样式已注入（若已同源可立即注入，先于 load 完成）。
 */
export function rebindPreview() {
  ensureHighlightStyle()
  applyProseTypography()
}
