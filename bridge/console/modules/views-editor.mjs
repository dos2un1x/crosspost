// 编写工作台视图（2026-09-05）：左侧 CM6 编辑 · 右侧实时预览
// 复用后端 /proxy/render（与发布同源渲染）、/proxy/styles、/proxy/draft/<id>、
// /proxy/save-draft（新建=createDraft / 编辑=updateDraft）、/proxy/cover。
// 纯前端无构建；CM6 由 vendor/codemirror.mjs 单文件（~530KB）提供，仅在编辑器首次打开时动态加载
// （view 模块设为惰性 import，否则每次进控制台都会拉取，拖慢首屏）。
import { getJSON } from './api.mjs'
import { postJSON } from './api.mjs'
import { isKnownSlot, slotChoices } from './slot-lexicon.mjs'
import { store } from './state.mjs'
import { $, escapeHtml, escapeAttr, todayStr, styleDisplayName, groupStyles } from './utils.mjs'
import {
  attachSync,
  setPreviewBlocks,
  rebindPreview,
  editorSelectionHandler,
  syncPreviewFromEditor,
  clearBlockHighlight,
} from './editor-sync.mjs'

// CodeMirror 模块缓存：首次打开编辑器时才 dynamic import，避免 530KB 全量拉到首屏。
let cmModule
function loadCodeMirror() {
  if (!cmModule) cmModule = import('../vendor/codemirror.mjs')
  return cmModule
}

export async function initEditorView() {
  // 暴露 store 供测试/调试访问（无副作用；便于 Playwright 验证同步行为）
  if (typeof window !== 'undefined') window.__store = store
  // 初始化控件（幂等；CM6 编辑器在首次 loadEditor 时惰性建，避免切走再切回重复建）
  bindEditorControls()
}

/** 进入编写视图：根据路由 id 决定新建 / 编辑既有草稿 */
export async function loadEditor(id) {
  // 样式 + 封面模板元信息（下拉），失败静默
  await populateStyleSelects()
  // 若带 id：回填既有草稿；否则新建（清空，保留上次样式）
  if (id) {
    try {
      const r = await getJSON(`/proxy/draft/${encodeURIComponent(id)}`)
      if (!r || r.error) throw new Error((r && r.error) || '读取草稿失败')
      fillFromDraft(r)
      store.editor.id = id
    } catch (e) {
      store.editor.id = null
      resetEditor()
      setEditorState('加载草稿失败: ' + String(e.message || e), 'err')
    }
  } else {
    // 切换到「编写」tab 且未指定 id：若本地有未保存草稿则恢复，否则新建空稿
    if (store.editor.id) {
      // 已在编辑某草稿 → 保持当前会话状态（再次进入不重置）
    } else if (store.editor.draft && store.editor.dirty) {
      // 有内存未保存草稿且并非编辑既有 → 保留
      if (store.editor.editor) store.editor.editor.setValue(store.editor.draft.markdown || '')
    } else if (!(await maybeRestoreAutosave())) {
      // 尝试恢复 localStorage 未保存草稿；无则新建空稿
      resetEditor()
    }
  }
  // 首次进入（或 CM6 被销毁后）需要 build 编辑器
  // 填充栏目下拉（基于当前 draft 的 slot；fillFromDraft/resetEditor/maybeRestoreAutosave 已设 #ed-slot.value，
  // 这里再用当前值生成 option，保证选中项一致）
  populateSlotSelect((store.editor.draft && store.editor.draft.slot) || 'manual')
  await ensureEditorBuilt()
  refreshEditorPreview(true)
  renderEditorState()
}

/* ── 编辑器组件 ───────────────────── */
/** 正在建的编辑器（单飞：并发调用共享同一个 Promise，不各建一个） */
let editorBuildInflight = null

/**
 * 惰性建编辑器（幂等）。
 *
 * 2026-09-29：加**飞行中去重**。此前只有 `if (store.editor.editor) return` 一道门，
 * 而进入编写页会并发走到这里（`switchView('editor')` 与 hash 处理器各一条路，
 * 两次都在 await 之后才进来）→ 门被同时穿过，同一个 host 里建出**两个** CodeMirror：
 * 先建的空稿盖住有内容的那一个，源码窗格看起来是空的（而 store 与右侧预览是对的）。
 * 现在并发只会建一个；app.js 那侧也改成"一次导航只调一次 loadEditor"。
 */
async function ensureEditorBuilt() {
  if (store.editor.editor) return
  if (editorBuildInflight) return editorBuildInflight
  editorBuildInflight = (async () => {
    const host = $('#ed-editor-host')
    const value = currentMarkdown()
    const { createEditor } = await loadCodeMirror()
    store.editor.editor = createEditor({
      parent: host,
      value,
      onChange: () => {
        store.editor.dirty = true
        schedulePreview()
        markAutosave()
        renderEditorState()
      },
      onSelection: (sel) => {
        editorSelectionHandler(sel)
        // v2.98.1：光标移动（不改文字）也要更新格式栏点亮态
        syncFormatbarState()
      },
    })
    attachSync({ editorHandle: store.editor.editor, previewFrame: $('#ed-preview-frame') })
  })()
  try {
    await editorBuildInflight
  } finally {
    editorBuildInflight = null
  }
}

// © dos2un1x · https://github.com/dos2un1x/crosspost
function currentMarkdown() {
  return (store.editor.draft && store.editor.draft.markdown) || ''
}

function getEditorValue() {
  return store.editor.editor ? store.editor.editor.getValue() : currentMarkdown()
}

/* ── 回填 / 重置 ──────────────────── */
function fillFromDraft(dr) {
  store.editor.draft = {
    title: dr.title || '',
    slot: isKnownSlot(dr.slot) ? dr.slot : 'manual',
    date: dr.date || todayStr(),
    markdown: dr.markdown || '',
  }
  store.editor.style = dr.style || 'swiss'
  store.editor.dirty = false
  $('#ed-title').value = store.editor.draft.title
  $('#ed-date').value = store.editor.draft.date
  $('#ed-slot').value = store.editor.draft.slot
  $('#ed-style').value = store.editor.style
  $('#ed-style-dup').value = store.editor.style
  if (store.editor.editor) store.editor.editor.setValue(store.editor.draft.markdown)
  clearAutosave()
  renderEditorState()
}

function resetEditor() {
  store.editor.id = null
  store.editor.draft = {
    title: '',
    slot: 'manual',
    date: todayStr(),
    markdown: '',
  }
  store.editor.style = store.editor.style || 'swiss'
  store.editor.dirty = false
  $('#ed-title').value = ''
  $('#ed-date').value = todayStr()
  $('#ed-slot').value = 'manual'
  $('#ed-style').value = store.editor.style
  $('#ed-style-dup').value = store.editor.style
  if (store.editor.editor) store.editor.editor.setValue('')
  clearAutosave()
  renderEditorState()
}

/* ── 元信息下拉 ───────────────────── */
/**
 * 填充栏目下拉：**项目声明的槽位**（按时间序）+ 手动（2026-09-25 改）。
 *
 * 改前用的是前端常量 `SLOT_NAMES` 的全集（早报/热点①/深度/热点②/技巧/晚间/手动）：
 * 名字与项目声明不一致（"热点①" vs "热点解读①"），而且会列出本项目根本没声明的栏目
 * （本机的「早报」），项目以后新声明的栏目又选不到。
 *
 * `cur` 是回填历史草稿时的原值：若它不在项目声明里（例如旧文章的 `morning`），
 * 也必须作为一项出现 —— 否则下拉会落到第一项，等于**静默改掉**这篇稿的栏目。
 */
function populateSlotSelect(cur) {
  const sel = $('#ed-slot')
  const choices = slotChoices(isKnownSlot(cur) ? cur : null)
  if (!choices.length) {
    sel.innerHTML = ''
    return
  }
  const ids = choices.map((c) => c.id)
  // 保留原值：`cur` 是系统认得的栏目就选它，否则退回 manual（与改前一致）
  const curSlot = cur && ids.includes(cur) ? cur : ids.includes('manual') ? 'manual' : ids[0]
  sel.innerHTML = choices
    .map(
      (c) =>
        `<option value="${escapeAttr(c.id)}" ${c.id === curSlot ? 'selected' : ''}>${escapeHtml(c.label)}</option>`,
    )
    .join('')
}

/** v2.98.2：样式下拉的显示文字 = `代号 · 短释义`。
 *  接口的 desc 是一整句（"瑞士国际主义风格。白底红色，网格感强，专业克制。适合技术文章…"），
 *  取第一个短句并截到 12 字 —— 目的是在 16 项的下拉里能一眼分辨，不是把说明搬进来。 */
function styleOptionLabel(name, desc) {
  const label = styleDisplayName(name)
  const first = String(desc || '')
    .split(/[。；;，,、（(]/)[0]
    .trim()
  if (!first) return label
  return `${label} · ${Array.from(first).slice(0, 12).join('')}`
}

async function populateStyleSelects() {
  const styles = await getJSON('/proxy/styles').catch(() => ({ styles: [] }))
  const list = (styles.styles || []).filter((s) => s.enabled !== false)
  const groups = groupStyles(list)
  const cur = store.editor.style
  if (!list.length) {
    $('#ed-style').innerHTML = `<option value="${escapeHtml(cur)}">${escapeHtml(cur)}</option>`
    $('#ed-style-dup').innerHTML = $('#ed-style').innerHTML
    return
  }
  // v2.98.2：选项文字从"只有英文代号"（swiss / ink / darktech …16 个）改成
  // 「代号 · 短释义」，释义取接口给的 desc 的第一个短句（截到 12 字）。
  // 改前 desc 只挂在 title 上 —— 原生 <option title> 的提示在多数情况下根本弹不出来。
  const opts = [...groups.entries()]
    .map(
      ([, g]) =>
        `<optgroup label="${escapeHtml(g.title)}">${g.items.map((s) => `<option value="${escapeAttr(s.name)}" ${s.name === cur ? 'selected' : ''} title="${escapeAttr(String(s.desc ?? '').slice(0, 120))}">${escapeHtml(styleOptionLabel(s.name, s.desc))}</option>`).join('')}</optgroup>`,
    )
    .join('')
  $('#ed-style').innerHTML = opts
  $('#ed-style-dup').innerHTML = opts
}

/* ── 实时预览 ─────────────────────── */
function schedulePreview() {
  clearTimeout(store.editor.timer)
  store.editor.timer = setTimeout(() => refreshEditorPreview(), 450)
}

async function refreshEditorPreview(_immediate = false) {
  const markdown = getEditorValue()
  const style = $('#ed-style').value || store.editor.style
  store.editor.style = style
  const frame = $('#ed-preview-frame')
  const state = $('#ed-preview-state')
  if (state) {
    state.textContent = '渲染中…'
    state.className = 'editor-pane-state'
  }
  try {
    const r = await postJSON('/proxy/render', { markdown, style })
    if (r.error) throw new Error(r.error)
    frame.srcdoc = r.html || '<p style="padding:20px">渲染结果为空</p>'
    // 2026-09-05 同步：保存块映射 + 重新绑定预览事件（srcdoc 重载后需重绑）
    setPreviewBlocks(r.blocks || [])
    rebindPreview()
    // 2026-09-09：srcdoc 重载会重置预览滚动到顶部；等 iframe load 后再按编辑器当前行对齐，
    // 使输入/回车换行后左右仍保持位置同步（单纯依赖 scroll 事件不覆盖输入场景）。
    setTimeout(() => syncPreviewFromEditor(), 60)
    if (state) {
      state.textContent = '已渲染'
      state.className = 'editor-pane-state ok'
    }
  } catch (e) {
    frame.srcdoc = `<p style="padding:20px;color:#b4432f">渲染失败: ${escapeHtml(String(e.message || e))}</p>`
    if (state) {
      state.textContent = '渲染失败'
      state.className = 'editor-pane-state err'
    }
  }
}

/** 编辑器光标/选区所在块下标（基于 store.editor.blocks 的 startLine/endLine） */

/* ── 保存（手动）──────────────────── */
async function saveEditor() {
  const title = ($('#ed-title').value || '').trim()
  if (!title) {
    setEditorState('请先填写标题', 'warn')
    return
  }
  const markdown = getEditorValue()
  const body = {
    title,
    markdown,
    slot: $('#ed-slot').value,
    date: $('#ed-date').value,
    style: $('#ed-style').value,
    // 新建时从标题生成 ASCII 主题 slug（文件名约束：[\w.-]+，剥离中文）
    topic: slugifyFilename(title),
  }
  if (store.editor.id) body.id = store.editor.id
  setEditorState('保存中…')
  try {
    const r = await postJSON('/proxy/save-draft', body)
    if (r.error) throw new Error(r.error)
    store.editor.id = r.id
    store.editor.dirty = false
    clearAutosave()
    setEditorState(`已保存 ✓ (${r.id})`, 'ok')
    // 回填标题（中文标题可能被净化，但 title 本身保留）
    return r
  } catch (e) {
    setEditorState('保存失败: ' + String(e.message || e), 'err')
    return null
  }
}

function slugifyFilename(s) {
  const ascii = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return ascii || 'draft'
}

/* ── localStorage 自动恢复 ────────── */
function markAutosave() {
  try {
    localStorage.setItem(
      'crosspost-editor-live',
      JSON.stringify({
        title: $('#ed-title').value,
        date: $('#ed-date').value,
        slot: $('#ed-slot').value,
        style: store.editor.style,
        markdown: getEditorValue(),
        at: Date.now(),
      }),
    )
  } catch {
    /* 配额忽略 */
  }
}

function clearAutosave() {
  try {
    localStorage.removeItem('crosspost-editor-live')
  } catch {}
}

/** 启动时若存在未保存 live 且不在编辑任何已存草稿，则提示恢复（可选） */
export async function maybeRestoreAutosave() {
  try {
    const raw = localStorage.getItem('crosspost-editor-live')
    if (!raw) return false
    const live = JSON.parse(raw)
    if (!live || !live.markdown) return false
    if (store.editor.id) return false // 编辑既有草稿时不覆盖
    store.editor.draft = {
      title: live.title || '',
      slot: live.slot || 'manual',
      date: live.date || todayStr(),
      markdown: live.markdown,
    }
    store.editor.style = live.style || 'swiss'
    store.editor.dirty = true
    $('#ed-title').value = live.title || ''
    $('#ed-date').value = live.date || todayStr()
    $('#ed-slot').value = live.slot || 'manual'
    $('#ed-style').value = store.editor.style
    $('#ed-style-dup').value = store.editor.style
    await ensureEditorBuilt()
    refreshEditorPreview(true)
    renderEditorState()
    return true
  } catch {
    return false
  }
}

/* ── 一键清空 ─────────────────────── */
function clearEditorForEditor() {
  const res = $('#ed-clear-result')
  if (!store.editor.dirty && !(store.editor.draft && store.editor.draft.markdown)) {
    if (res) {
      res.className = 'repub-result err'
      res.textContent = '没有可清空的内容'
    }
    return
  }
  if (!window.confirm('确定清空当前标题与正文？此操作不可撤销。')) return
  // 复用 resetEditor 的字段清理（清 title/date/slot/style + 编辑器正文 + 置为全新草稿）
  resetEditor()
  if (store.editor.editor) store.editor.editor.setValue('')
  if (store.editor.editor) refreshEditorPreview(true)
  if (res) {
    res.className = 'repub-result ok'
    res.textContent = '已清空 ✓'
  }
}

/* ── 格式工具栏 ───────────────────── */
function applyFormatbar(kind) {
  const ed = store.editor.editor
  if (!ed) return
  const { state, dispatch } = ed.view
  const sel = state.selection.main
  const text = state.doc.sliceString(sel.from, sel.to)
  let insert = ''
  let from = sel.from
  let to = sel.to
  const pad = (pre, post, wrap) => {
    const mid = text ? text : wrap
    insert = pre + mid + post
    from = sel.from + pre.length
    to = sel.from + pre.length + mid.length
  }
  switch (kind) {
    case 'b':
      pad('**', '**', '加粗')
      break
    case 'i':
      pad('*', '*', '斜体')
      break
    case 'code':
      pad('`', '`', 'code')
      break
    case 'quote':
      insert = '\n> ' + (text || '引用')
      from = sel.from + 3
      to = sel.from + 3 + (text ? text.length : 2)
      break
    case 'h2':
      insert =
        (sel.from === 0 || state.doc.sliceString(sel.from - 1, sel.from) === '\n' ? '' : '\n') +
        '## ' +
        (text || '标题')
      from = sel.from + insert.length - (text ? text.length : 2)
      to = sel.from + insert.length
      break
    case 'h3':
      insert =
        (sel.from === 0 || state.doc.sliceString(sel.from - 1, sel.from) === '\n' ? '' : '\n') +
        '### ' +
        (text || '标题')
      from = sel.from + insert.length - (text ? text.length : 2)
      to = sel.from + insert.length
      break
    case 'ul':
      insert = '\n- ' + (text || '列表项')
      from = sel.from + 3
      to = sel.from + 3 + (text ? text.length : 3)
      break
    case 'ol':
      insert = '\n1. ' + (text || '列表项')
      from = sel.from + 4
      to = sel.from + 4 + (text ? text.length : 3)
      break
    case 'link':
      insert = '[链接文本](https://)'
      from = sel.from + 1
      to = sel.from + 5
      break
    case 'img':
      insert = '![图片描述](https://)'
      from = sel.from + 2
      to = sel.from + 6
      break
    // v2.99（C3）：两个最常用、改前却没有入口的**块级**语法
    case 'hr': {
      // 分割线必须独占一行：不在行首就先补一个换行（与 h2/h3 同一套判断）
      const head =
        sel.from === 0 || state.doc.sliceString(sel.from - 1, sel.from) === '\n' ? '' : '\n'
      insert = head + '---\n'
      from = sel.from + insert.length
      to = from
      break
    }
    case 'codeblock': {
      // 围栏代码块：把选中的整段包进 ``` 里；没选内容就放一行占位并选中它
      const head =
        sel.from === 0 || state.doc.sliceString(sel.from - 1, sel.from) === '\n' ? '' : '\n'
      const body = text || '在这里写代码'
      insert = head + '```\n' + body + '\n```\n'
      from = sel.from + head.length + 4
      to = from + body.length
      break
    }
    default:
      return
  }
  dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: from, head: to },
  })
  ed.view.focus()
  store.editor.dirty = true
  schedulePreview()
  markAutosave()
  renderEditorState()
}

/* ── 状态 / 字数 / 事件 ───────────── */
function renderEditorState() {
  const raw = getEditorValue()
  const trimmed = raw.trim()
  const count = Array.from(trimmed).length
  const paras = trimmed ? trimmed.split(/\n\s*\n/).filter(Boolean).length : 0
  const el = $('#ed-count')
  // v2.97：读数从「0 字」扩成「0 字 · 0 段」。写文章时"多少段"比"多少字"更接近手感
  // （段落是结构，字数是长度），而改前只有一个字数。
  // v2.98.2：再补"约几分钟"。中文按 400 字/分钟估（写作者判断篇幅用），
  // 空稿不显示（"约 0 分钟"是噪音）。
  if (el) {
    const mins = count > 0 ? Math.max(1, Math.round(count / 400)) : 0
    el.textContent =
      count > 0 ? `${count} 字 · ${paras} 段 · 约 ${mins} 分钟` : `${count} 字 · ${paras} 段`
  }
  // v2.97：空态。两栏在空稿时都是**纯白加一根裸行号**，没有任何"该干什么"的指引。
  // 用一个 class 驱动 CSS 里的居中提示层（提示层 pointer-events:none，不挡点击聚焦）。
  const empty = count === 0
  const pane = document.querySelector('.editor-pane')
  const prev = document.querySelector('.preview-pane')
  if (pane) pane.classList.toggle('is-empty', empty)
  if (prev) prev.classList.toggle('is-empty', empty)
  const dirty = store.editor.dirty
  const saveBtn = $('#ed-save')
  if (saveBtn) saveBtn.textContent = dirty ? '保存 ●' : '保存'
  // v2.98.1：行首标记是打出来的（不是移动光标出来的），所以每次重绘也要刷新点亮态
  syncFormatbarState()
}

/* ── v2.98.1：格式栏的两个手感改进 ──────────────────────────────────────── */

/** 光标所在块的语法 → 对应按钮点亮。
 *  改前这 10 个按钮是"永远不知道自己是否生效"的：光标明明停在 `## 小节` 这一行，
 *  H2 和 H3 看起来一模一样。这里只看**块级前缀**（H2 / H3 / 引用 / 两种列表）——
 *  行内语法（`**粗体**`）无法从"当前行"判断出来，所以 B / I 不点亮，不给假信息。
 *  只是视觉提示，**不写 `aria-pressed`**：这些按钮是"插入标记"而不是开关，
 *  谎报 toggle 语义反而会误导读屏。 */
function syncFormatbarState() {
  const ed = store.editor.editor
  if (!ed || !ed.view) return
  let text = ''
  try {
    text = ed.view.state.doc.line(ed.getCursorLine()).text
  } catch {
    text = ''
  }
  const t = text.replace(/^\s+/, '')
  // 围栏代码块的"当前行在不在里面"只能靠数围栏：从第 1 行数到光标行，
  // 奇数次 = 在围栏内。上限 3000 行（长文里也不会每次按键都扫全篇）。
  let inFence = false
  try {
    const doc = ed.view.state.doc
    const upto = Math.min(ed.getCursorLine(), 3000)
    let fences = 0
    for (let i = 1; i <= upto; i++) if (/^\s*```/.test(doc.line(i).text)) fences++
    inFence = fences % 2 === 1
  } catch {
    inFence = false
  }
  const on = {
    h2: /^##\s/.test(t) && !/^###\s/.test(t),
    h3: /^###\s/.test(t),
    quote: /^>/.test(t),
    ul: /^[-*+]\s/.test(t),
    ol: /^\d+\.\s/.test(t),
    hr: /^(-{3,}|\*{3,}|_{3,})$/.test(t),
    codeblock: inFence || /^\s*```/.test(text),
  }
  document.querySelectorAll('.editor-pane .fb[data-fb]').forEach((b) => {
    b.classList.toggle('is-active', !!on[b.dataset.fb])
  })
}

/** 格式栏的键盘可达性：整条工具条**一个** Tab 停靠点，`←/→` 漫游、`Home/End` 跳首尾
 *  （ARIA toolbar 惯例）。改前 10 个按钮各占一个停靠点 —— `#view-editor` 里 18 个可聚焦
 *  元素中有 10 个是格式按钮，从「保存」到预览头「样式」要按 11 次 Tab。
 *  焦点落在哪个按钮上，就把 `tabindex=0` 交给它（鼠标点击也一样，因为 focus 会触发），
 *  这样 Shift+Tab 回到工具条时能回到"上次用的那个"。 */
function bindFormatbarRoving() {
  const btns = [...document.querySelectorAll('.editor-pane .fb[data-fb]')]
  if (!btns.length) return
  btns.forEach((b, i) => {
    b.addEventListener('focus', () => {
      btns.forEach((x, k) => (x.tabIndex = k === i ? 0 : -1))
    })
    b.addEventListener('keydown', (e) => {
      let next = null
      if (e.key === 'ArrowRight') next = (i + 1) % btns.length
      else if (e.key === 'ArrowLeft') next = (i - 1 + btns.length) % btns.length
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = btns.length - 1
      if (next === null) return
      e.preventDefault()
      btns[next].focus()
    })
  })
}

/** v2.99.1（C2）：编写页直达推送。
 *
 *  改前：编写页只能存草稿，要推微信得绕到「文章」列表 → 打开详情抽屉 → 点「重推」。
 *
 *  安全边界（**这一版的全部设计都围绕它**）：
 *   ① 走的是与详情抽屉「重推」**完全相同**的既有通道 `/proxy/publish`，不新增任何后端路径；
 *   ② 只推微信草稿：显式传 `platforms: []`（空数组 ≠ 缺省，缺省才会展开 config 的
 *      platforms.default）—— 不可能因为"默认平台"被顺带推到别处；
 *   ③ 恒为草稿：这条链路的后端语义就是"创建草稿"，不存在发表/群发；
 *   ④ `manual: true` 与抽屉「重推」一字不差 —— 只是标记"人工触发"。定时链路
 *      （WECHAT_AUTO_SCHEDULED=1）的 autoPush 门控**没有**被这一版放宽，也没有新增豁免类；
 *   ⑤ 先保存、后推送：保存失败（例如标题为空）就**不推送**，不会推一篇标题为空的稿子。
 */
function bindPushToWechat() {
  const btn = $('#ed-push')
  const panel = $('#ed-push-confirm')
  const go = $('#ed-push-go')
  const cancel = $('#ed-push-cancel')
  const result = $('#ed-push-result')
  if (!btn || !panel || !go || !cancel) return
  const close = () => {
    panel.classList.add('hidden')
    btn.setAttribute('aria-expanded', 'false')
    if (result) result.textContent = ''
  }
  const open = () => {
    panel.classList.remove('hidden')
    btn.setAttribute('aria-expanded', 'true')
    if (result) result.textContent = ''
    go.focus()
  }
  btn.setAttribute('aria-expanded', 'false')
  btn.setAttribute('aria-haspopup', 'dialog')
  btn.addEventListener('click', () => (panel.classList.contains('hidden') ? open() : close()))
  cancel.addEventListener('click', close)
  // Esc 关闭（与抽屉一致）。只在面板打开时拦截，避免抢掉别处的 Esc。
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
      btn.focus()
    }
  })
  go.addEventListener('click', async () => {
    go.disabled = true
    cancel.disabled = true
    if (result) {
      result.className = 'repub-result'
      result.textContent = '保存草稿…'
    }
    try {
      // ① 先存草稿（复用同一个 saveEditor；空标题它自己会 return null 并给出提示）
      const saved = await saveEditor()
      if (!saved || !store.editor.id) {
        if (result) {
          result.className = 'repub-result err'
          result.textContent = '未推送：草稿没保存成功（先填写标题）'
        }
        return
      }
      if (result) result.textContent = '推送微信草稿中（恒草稿）…'
      // ② 再推微信：platforms 显式空数组（缺省才会展开默认平台），manual 与抽屉重推一致
      const r = await postJSON(
        '/proxy/publish',
        {
          id: store.editor.id,
          style: $('#ed-style').value || store.editor.style,
          platforms: [],
          wechat: true,
          concurrency: store.proxyConcurrency || 3,
          manual: true,
        },
        { timeoutMs: 600000 },
      )
      if (r && r.error) throw new Error(r.error)
      const wc = (r && r.wechat) || { status: 'skip' }
      // v2.106：这次推送的草稿若属于某个接入项目，而当前域并不是它（例如切到「默认域」
      // 后仍开着项目里的草稿），引擎会**按草稿归属**记账并把项目 id 回在 `projectDerived`。
      // 如实显示出来 —— 否则用户会以为"记录没了"，或反过来以为默认域也能放项目文章。
      const derived = r && r.projectDerived ? ` · 记录已归入项目 ${r.projectDerived}` : ''
      if (result) {
        result.className = 'repub-result ' + (wc.status === 'ok' ? 'ok' : 'err')
        result.textContent =
          wc.status === 'ok'
            ? `已存微信草稿 ✓（未发表、未推其它平台）${derived}`
            : '微信未执行：' + (wc.error || wc.status || '后端未返回结果')
      }
    } catch (e) {
      if (result) {
        result.className = 'repub-result err'
        result.textContent = '推送失败：' + String(e.message || e)
      }
    } finally {
      go.disabled = false
      cancel.disabled = false
    }
  })
}

/** v2.99（C1）：窄屏（≤900px）两栏会堆成单栏，预览被推到下方且**没有任何提示** ——
 *  "预览没了"是这一页在窄屏最容易踩的坑。给一个只在窄屏出现的分段控件切换显示哪一栏。
 *
 *  实现要点：隐藏规则写在 `@media (max-width: 900px)` 里，所以宽屏下就算带着
 *  `.narrow-source` 这个类，两栏也照样都在 —— 不需要在任何地方判断视口宽度。
 *  切回"正文"时要 requestMeasure()：编辑器刚从 display:none 恢复可见，
 *  CodeMirror 需要重新量一次尺寸，否则行宽/滚动条会算错。 */
function bindNarrowSwitch() {
  const sw = $('#ed-narrow-switch')
  const layout = document.querySelector('.editor-layout')
  if (!sw || !layout) return
  const setMode = (mode) => {
    layout.classList.toggle('narrow-source', mode === 'source')
    layout.classList.toggle('narrow-preview', mode === 'preview')
    sw.querySelectorAll('button[data-narrow]').forEach((b) =>
      b.setAttribute('aria-pressed', b.dataset.narrow === mode ? 'true' : 'false'),
    )
    if (mode === 'preview') {
      refreshEditorPreview(true)
    } else if (store.editor.editor && store.editor.editor.view.requestMeasure) {
      store.editor.editor.view.requestMeasure()
    }
  }
  sw.querySelectorAll('button[data-narrow]').forEach((b) =>
    b.addEventListener('click', () => setMode(b.dataset.narrow)),
  )
  setMode('source') // 默认进"正文"：进这一页第一件事是打字
}

/** v2.98.2：预览头工具组。
 *  ① 同步开关：`store.editor.syncOn` 在 state.mjs 里写着"滚动/选区同步开关"，
 *     editor-sync.mjs 里 5 处在读它，但**界面上从来没有开关** —— 这版把它接出来。
 *     关掉时顺手清掉预览里的块高亮（否则最后停留的那一块会一直亮着）。
 *  ② 刷新：绕过 450ms 防抖立刻重渲染。
 *  ③ 在新标签页打开：用 Blob URL 打开渲染产物（iframe 里是缩在窗格中的，
 *     发布前需要看"整页长什么样"）。 */
const SYNC_PREF_KEY = 'crosspost-editor-sync'

function bindPreviewTools() {
  const toggle = $('#ed-sync-toggle')
  const refresh = $('#ed-preview-refresh')
  const open = $('#ed-preview-open')
  // 恢复上次选择（缺省 true；localStorage 只存 UI 偏好，与 config.json 无关）
  try {
    const raw = localStorage.getItem(SYNC_PREF_KEY)
    if (raw === '0') store.editor.syncOn = false
    else if (raw === '1') store.editor.syncOn = true
  } catch {
    /* 隐私模式下忽略 */
  }
  const paintToggle = () => {
    if (!toggle) return
    toggle.setAttribute('aria-pressed', store.editor.syncOn ? 'true' : 'false')
    toggle.classList.toggle('is-off', !store.editor.syncOn)
  }
  paintToggle()
  if (toggle) {
    toggle.addEventListener('click', () => {
      store.editor.syncOn = !store.editor.syncOn
      if (!store.editor.syncOn) clearBlockHighlight()
      else syncPreviewFromEditor()
      try {
        localStorage.setItem(SYNC_PREF_KEY, store.editor.syncOn ? '1' : '0')
      } catch {
        /* 忽略 */
      }
      paintToggle()
    })
  }
  if (refresh) refresh.addEventListener('click', () => refreshEditorPreview(true))
  if (open) {
    open.addEventListener('click', () => {
      const frame = $('#ed-preview-frame')
      const html = (frame && frame.srcdoc) || ''
      if (!html) return
      // ★ 必须自己补 charset：srcdoc 会继承父文档的 UTF-8，Blob URL **不会** ——
      //   实测漏掉时新标签页里的中文全是乱码（"刷新测试标题" → "鍒锋柊娴嬭瘯鏍囬"）。
      const doc = /<head[\s>]/i.test(html)
        ? html.replace(/<head([\s>])/i, '<head$1<meta charset="utf-8">')
        : `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>${html}</body></html>`
      const url = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }))
      const win = window.open(url, '_blank')
      // 释放 blob：等新窗口拿到内容后再回收，否则可能白页
      setTimeout(() => URL.revokeObjectURL(url), 60000)
      if (win) win.focus()
    })
  }
}

/** 动作反馈（保存中 / 已保存 / 失败 / 请先填写标题）写到**保存按钮旁边**的槽位。
 *  v2.97 之前它写的是 #ed-preview-state —— 同一个元素还被 refreshEditorPreview() 用来显示
 *  「渲染中 / 已渲染 / 渲染失败」，两边互相覆盖，而且保存的反馈出现在 600px 外的预览窗格。
 *  现在职责分开：#ed-save-state = 保存链路；#ed-preview-state = 渲染链路。 */
function setEditorState(msg, kind = '') {
  const el = $('#ed-save-state')
  if (el) {
    el.textContent = msg
    el.className = 'ed-save-state' + (kind ? ' ' + kind : '')
  }
}

function bindEditorControls() {
  // 标题/日期/栏目/样式变化 → 预览刷新 + autosave
  const onMeta = () => {
    store.editor.dirty = true
    schedulePreview()
    markAutosave()
    renderEditorState()
  }
  $('#ed-title').addEventListener('input', () => {
    store.editor.dirty = true
    markAutosave()
    renderEditorState()
  })
  $('#ed-date').addEventListener('change', onMeta)
  $('#ed-slot').addEventListener('change', onMeta)
  // 样式双下拉同步（顶栏 + 预览头）
  $('#ed-style').addEventListener('change', (e) => {
    store.editor.style = e.target.value
    $('#ed-style-dup').value = e.target.value
    onMeta()
  })
  $('#ed-style-dup').addEventListener('change', (e) => {
    store.editor.style = e.target.value
    $('#ed-style').value = e.target.value
    onMeta()
  })
  // 按钮
  $('#ed-new').addEventListener('click', async () => {
    store.editor.id = null
    resetEditor()
    await ensureEditorBuilt()
    refreshEditorPreview(true)
  })
  $('#ed-save').addEventListener('click', () => saveEditor())
  $('#ed-clear').addEventListener('click', () => clearEditorForEditor())
  // v2.98.2：预览头工具组（同步开关 / 刷新 / 新标签页打开）
  bindPreviewTools()
  // v2.99（C1）：窄屏「正文 / 预览」分段控件
  bindNarrowSwitch()
  // v2.99.1（C2）：编写页直达推送（存草稿 → 推微信草稿）
  bindPushToWechat()
  // 格式工具栏
  // v2.97：选择器收窄到左栏 —— 右栏的等高占位条里现在也有 .fb（隐藏、无 data-fb），
  // 不收窄就会给 10 个永远点不到的按钮挂上监听。
  document.querySelectorAll('.editor-pane .fb').forEach((btn) => {
    btn.addEventListener('click', () => applyFormatbar(btn.dataset.fb))
  })
  // v2.98.1：工具条键盘漫游（一个 Tab 停靠点 + ←/→/Home/End）
  bindFormatbarRoving()
  // 顶层编辑前确认离开（可选）：未保存时提示
  window.addEventListener('beforeunload', (e) => {
    if (store.editor.dirty) {
      e.preventDefault()
      e.returnValue = ''
    }
  })
  // v2.98：Cmd/Ctrl+S 保存。
  // 审计实测：改前**无人接管**这个组合键（派发可取消 keydown 返回 notPrevented: true），
  // 于是浏览器弹出「存储网页」—— 写作者最自然的保存手势，反而会下载一个网页副本。
  // 本函数只在 window load 时调一次（app.js:65 的 initEditorView），不会重复绑定。
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
    if (String(e.key).toLowerCase() !== 's') return
    const view = $('#view-editor')
    if (!view || !view.classList.contains('active')) return
    e.preventDefault()
    saveEditor()
  })
}
