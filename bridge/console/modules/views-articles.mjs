// 文章列表视图（2026-08-24 app.js 拆分 Phase 1）
import { getJSON, postJSON } from './api.mjs'
import { PLATFORM_NAMES } from './const.mjs'
import { slotName } from './slot-lexicon.mjs'
import { store, getDefaultPlatforms } from './state.mjs'
import {
  $,
  escapeHtml,
  escapeAttr,
  statusText,
  fmtTime,
  riskBadge,
  renderScoreCell,
  pageSlice,
  renderPager,
} from './utils.mjs'
import { openDetail } from './views-detail.mjs'

/** 刷新右上角统计（2026-08-30：从 loadArticles 抽出，任何视图切换/刷新都可调用）。
 *  并行拉文章+留存+归档 → 填充 store → renderStats。失败静默（不阻塞调用方）。
 *  2026-08-30 脏数据修复：scanAndList 顶层不再泄漏 archived/retained，
 *  store.articles 只含文章 active（published/partial/failed/draft）；
 *  留存/归档分项改由 store.retained / store.archived（此处一并拉取）提供。 */
export async function refreshStats() {
  const [data, retData, arcData] = await Promise.all([
    getJSON('/proxy/articles').catch(() => ({ articles: [] })),
    getJSON('/proxy/retained').catch(() => ({ retained: [] })),
    getJSON('/proxy/archive').catch(() => ({ archived: [] })),
  ])
  store.articles = data.articles || []
  store.retained = retData.retained || []
  store.archived = arcData.archived || []
  renderStats()
}

/** 加载文章列表 + 统计（入口/刷新/跨视图回调用）
 *  2026-08-29 统计口径修正：右上角汇总 = 文章 + 留存 + 归档 三库。
 *  2026-08-30 拆分：统计刷新独立为 refreshStats（供全局 switchView 调用），
 *  loadArticles 保留文章视图专属逻辑（douyin banner / applyFilters）。
 *
 *  2026-09-22（v2.103）**首屏快路径**：表格只依赖 `/proxy/articles`，不再等另外两库。
 *  为什么：reader 车道是**串行队列**（v2.101 之后每条车道一个进程、内部串行），
 *  三库串起来实测 ~90ms（archive 37ms + retained 33ms + articles 20ms），而表格只需要 articles。
 *  改后表格一到就渲染，留存/归档两库**后台补齐**统计条（数字口径完全不变，只是晚 ~70ms 到）。
 *  副作用是好的：归档/留存/删除等动作调 loadArticles 时，表格也不再等那两库。 */
export async function loadArticles() {
  const data = await getJSON('/proxy/articles').catch(() => ({ articles: [] }))
  store.articles = data.articles || []
  renderDouyinBanner()
  applyFilters()
  fillStatsInBackground()
}

/** 后台补齐统计条所需的另外两库（合并并发调用，避免连点/切视图时叠请求） */
let fillInflight = null
function fillStatsInBackground() {
  if (fillInflight) return fillInflight
  fillInflight = Promise.all([
    getJSON('/proxy/retained').catch(() => ({ retained: [] })),
    getJSON('/proxy/archive').catch(() => ({ archived: [] })),
  ])
    .then(([retData, arcData]) => {
      store.retained = retData.retained || []
      store.archived = arcData.archived || []
      renderStats()
    })
    .finally(() => {
      fillInflight = null
    })
  return fillInflight
}

/** 全局抖音状态条：当前抖音草稿箱是哪篇（单槽覆盖） */
export function renderDouyinBanner() {
  const cur = store.articles.find((a) => a.douyinCurrent)
  const el = $('#douyin-banner')
  el.innerHTML = cur
    ? `<span class="dy-label">📱 抖音草稿箱当前：</span><span class="dy-title">《${escapeHtml(cur.title || cur.id)}》</span><span style="color:rgba(255,255,255,0.55)">（${fmtTime(cur.douyinPushedAt)} 推送）</span><span style="margin-left:auto;font-size:11px;color:rgba(255,255,255,0.5)">推新内容将覆盖</span>`
    : `<span class="dy-label">📱 抖音草稿箱：</span><span class="dy-empty">暂无推送记录（手动推送后这里会显示当前草稿）</span>`
}

export function renderStats() {
  const c = { published: 0, partial: 0, failed: 0, draft: 0 }
  for (const a of store.articles) if (c[a.status] !== undefined) c[a.status]++
  const active = c.published + c.partial + c.failed + c.draft // 文章视图默认可见（非归档非留存）
  // 2026-08-30 脏数据修复：留存/归档分项改由专属库 store.retained/store.archived 提供
  //（scanAndList 顶层已排除 archived/retained，store.articles 里不再有它们的计数）
  const retained = (store.retained || []).length
  const archived = (store.archived || []).length
  const total = active + retained + archived // 三库全量汇总，不重复
  // 顶栏：只保留全局汇总（共/文章/留存/归档）——2026-08-29 精简防溢出
  $('#stats').innerHTML =
    `<span>共 <b>${total}</b> 篇</span>` +
    `<span>文章 <b>${active}</b></span>` +
    `<span>留存 <b style="color:var(--partial)">${retained}</b></span>` +
    `<span>归档 <b style="color:var(--ink-faint)">${archived}</b></span>`
  // 文章工具栏：状态细分（已发/部分/失败/未推）——归属文章列表上下文，不占顶栏
  const note = $('#article-status-note')
  if (note) {
    note.innerHTML =
      `<span class="dot ok"></span>成功 <b class="ok" style="color:var(--ok)">${c.published}</b>` +
      `<span class="dot fail"></span>失败 <b style="color:var(--fail)">${c.failed}</b>` +
      `<span class="dot partial"></span>部分 <b style="color:var(--partial)">${c.partial}</b>` +
      `<span class="dot skip"></span>未推 <b style="color:var(--skip)">${c.draft}</b>`
  }
  // 栏目过滤选项
  const slots = [...new Set(store.articles.map((a) => a.slot).filter(Boolean))].sort()
  const sel = $('#filter-slot')
  const cur = sel.value
  sel.innerHTML =
    '<option value="">全部栏目</option>' +
    slots
      .map(
        (s) =>
          `<option value="${s}" ${s === cur ? 'selected' : ''}>${escapeHtml(slotName(s))}</option>`,
      )
      .join('')
  // 归档库栏目筛选（2026-08-30：归档库顶栏下拉应基于 store.archived 的栏目；为空时回退文章栏目）
  const af = $('#af-slot')
  if (af) {
    const afSlots = [...new Set((store.archived || []).map((a) => a.slot).filter(Boolean))].sort()
    const afCur = af.value
    af.innerHTML =
      '<option value="">全部栏目</option>' +
      (afSlots.length ? afSlots : slots)
        .map(
          (s) =>
            `<option value="${s}" ${s === afCur ? 'selected' : ''}>${escapeHtml(slotName(s))}</option>`,
        )
        .join('')
  }
  renderPlatformStats()
}

/** 平台推送统计（P3）：各平台成功/失败篇数（前端聚合,零后端） */
export function renderPlatformStats() {
  const agg = {}
  for (const a of store.articles) {
    for (const [id, p] of Object.entries(a.platforms || {})) {
      if (p.status !== 'ok' && p.status !== 'fail') continue
      agg[id] = agg[id] || { ok: 0, fail: 0 }
      agg[id][p.status]++
    }
  }
  const ids = [...new Set([...getDefaultPlatforms(), ...Object.keys(agg)])]
  $('#platform-stats').innerHTML = ids
    .map((id) => {
      const s = agg[id]
      if (!s) return ''
      return `<span class="pstat">${PLATFORM_NAMES[id] || id} <b class="okc">${s.ok}</b><b class="failc">${s.fail}</b></span>`
    })
    .join('')
}

export function applyFilters() {
  store.articlePage = 1
  const slot = $('#filter-slot').value
  const status = $('#filter-status').value
  const risk = $('#filter-risk').value
  const q = $('#filter-q').value.trim().toLowerCase()
  const list = store.articles.filter((a) => {
    // 2026-08-30：文章模块不再展示归档/留存（各自专属库）；scanAndList 顶层已排除，
    // 此处为防御性保留（archive/retained 不再出现在 store.articles）。
    if (slot && a.slot !== slot) return false
    if (status === 'pending') {
      if (a.status !== 'partial' && a.status !== 'failed') return false
    } else if (status && a.status !== status) return false
    if (risk && (a.risk || 'unclassified') !== risk) return false
    if (
      q &&
      !(
        String(a.title ?? '')
          .toLowerCase()
          .includes(q) ||
        String(a.id ?? '')
          .toLowerCase()
          .includes(q)
      )
    )
      return false
    return true
  })
  renderTable(list)
}

function renderTable(list) {
  const tbody = $('#article-tbody')
  const shown = pageSlice(list, store.articlePage)
  $('#empty-state').classList.toggle('hidden', shown.length > 0)
  renderPager($('#article-pager'), list.length, store.articlePage, (pg) => {
    store.articlePage = pg
    renderTable(list)
  })
  if (!shown.length) {
    tbody.innerHTML = ''
    return
  }
  tbody.innerHTML = shown
    .map((a) => {
      const wechat = a.wechat || { status: 'none' }
      const wechatCell =
        wechat.status === 'ok'
          ? '<span class="badge published">✓ 已存</span>'
          : wechat.status === 'fail'
            ? '<span class="badge failed">✕</span>'
            : '<span class="dot skip"></span>'
      return `<tr data-id="${escapeHtml(a.id)}" class="${store.selected.has(a.id) ? 'sel' : ''}">
      <td class="sel-col"><input type="checkbox" class="row-sel" data-id="${escapeHtml(a.id)}" ${store.selected.has(a.id) ? 'checked' : ''}></td>
      <td class="cell-date">${escapeHtml(a.date || '—')}</td>
      <td><span class="cell-slot">${escapeHtml(slotName(a.slot) || '—')}</span></td>
      <td class="cell-title"><span class="${a.hasFile === false ? 'no-file' : 'has-file'}">${escapeHtml(a.title || a.id)}</span>${a.douyinCurrent ? '<span class="dy-badge">📱 当前草稿</span>' : ''}</td>
      <td class="cell-risk">${riskBadge(a.risk) || '<span style="color:var(--ink-faint)">—</span>'}</td>
      <td class="cell-score">${renderScoreCell(a.score)}</td>
      <td class="cell-style">${escapeHtml(a.style || '—')}</td>
      <td>${wechatCell}</td>
      <td class="matrix-col">${renderMatrix(a.platforms || {}, a.status)}</td>
      <td><span class="badge ${a.status}">${statusText(a.status)}</span></td>
      <td class="cell-date">${fmtTime(a.updatedAt)}</td>
    </tr>`
    })
    .join('')
  tbody.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.row-sel')) return // checkbox 不触发详情
      openDetail(tr.dataset.id)
    })
  })
  tbody.querySelectorAll('.row-sel').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.id
      if (cb.checked) store.selected.add(id)
      else store.selected.delete(id)
      cb.closest('tr').classList.toggle('sel', cb.checked)
      updateBatchBar()
    })
  })
}

function renderMatrix(platforms, status) {
  const ids = Object.keys(platforms)
  if (!ids.length) {
    // 无平台明细：draft=未推送；已发布（含用户手动维护）= 显示"已发布（明细未记录）"
    return status && status !== 'draft'
      ? '<span style="color:var(--ok);font-size:12px">✓ 已发布（明细未记录）</span>'
      : '<span style="color:var(--ink-faint);font-size:12px">未推送</span>'
  }
  const order = [...getDefaultPlatforms(), ...ids.filter((i) => !getDefaultPlatforms().includes(i))]
  return `<div class="matrix">${order
    .map((id) => {
      const p = platforms[id]
      if (!p) return '' // 该平台无记录（明细不完整的文章），不渲染
      const cls = p.status === 'ok' ? 'ok' : p.status === 'fail' ? 'fail' : 'skip'
      const name = PLATFORM_NAMES[id] || id
      const tip =
        p.status === 'ok'
          ? `<b>${name}</b> ✓ 成功${p.postUrl ? ' · 草稿链接' : ''}`
          : p.status === 'fail'
            ? `<b>${name}</b> ✕ ${escapeHtml((p.error || '失败').slice(0, 60))}`
            : `<b>${name}</b> — 未推`
      const inner =
        p.status === 'ok' && p.postUrl
          ? `<a href="${escapeAttr(p.postUrl)}" target="_blank" rel="noopener">✓<span class="tip">${tip}</span></a>`
          : `✕<span class="tip">${tip}</span>`
      return `<span class="mcell ${cls}">${inner}</span>`
    })
    .join('')}</div>`
}

/* ── P6 批量操作 ───────────────────── */
function updateBatchBar() {
  const bar = $('#batch-bar')
  const show = store.selected.size > 0
  bar.classList.toggle('hidden', !show)
  if (!show) $('#batch-retain-panel').classList.add('hidden')
  if (show) $('#sel-count').textContent = `已选 ${store.selected.size} 篇`
}

async function batchArchive() {
  const msg = $('#batch-msg')
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>归档中…'
  let fail = 0
  for (const id of [...store.selected]) {
    try {
      const r = await postJSON('/proxy/archive', { id, action: 'archive' })
      if (r.error) fail++
    } catch {
      fail++
    }
  }
  msg.className = 'repub-result ' + (fail ? '' : 'ok')
  msg.textContent = fail
    ? `${store.selected.size - fail}/${store.selected.size} 已归档，失败 ${fail}`
    : `已归档 ${store.selected.size} 篇 ✓`
  store.selected.clear()
  $('#thead-sel-all').checked = false
  updateBatchBar()
  await loadArticles()
}

async function batchRetainConfirm() {
  const panel = $('#batch-retain-panel')
  const msg = $('#br-msg')
  msg.className = 'repub-result'
  const dirEl = document.querySelector('input[name="br-dir"]:checked')
  if (!dirEl) {
    msg.className = 'repub-result err'
    msg.textContent = '请选择留存目录'
    return
  }
  const dir = dirEl.value
  const reason = $('#br-reason').value.trim() || undefined
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>留存中…'
  let fail = 0
  for (const id of [...store.selected]) {
    try {
      const r = await postJSON('/proxy/retain', { id, dir, reason })
      if (r.error) fail++
    } catch {
      fail++
    }
  }
  msg.className = 'repub-result ' + (fail ? '' : 'ok')
  msg.textContent = fail
    ? `${store.selected.size - fail}/${store.selected.size} 已留存至${dir === 'risk' ? '风险库' : '低分库'}，失败 ${fail}`
    : `已留存 ${store.selected.size} 篇至${dir === 'risk' ? '风险库' : '低分库'} ✓`
  panel.classList.add('hidden')
  store.selected.clear()
  $('#thead-sel-all').checked = false
  updateBatchBar()
  await loadArticles()
}

async function batchDelete() {
  if (
    !confirm(
      `确定删除所选 ${store.selected.size} 篇文章？\n将同时删除草稿文件与推送记录，不可恢复。`,
    )
  )
    return
  const msg = $('#batch-msg')
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>删除中…'
  let fail = 0
  for (const id of [...store.selected]) {
    try {
      const r = await postJSON('/proxy/delete-draft', { id, authorized: true })
      if (r.error) fail++
    } catch {
      fail++
    }
  }
  msg.className = 'repub-result ' + (fail ? '' : 'ok')
  msg.textContent = fail
    ? `${store.selected.size - fail}/${store.selected.size} 已删除，失败 ${fail}`
    : `已删除 ${store.selected.size} 篇 ✓`
  store.selected.clear()
  $('#thead-sel-all').checked = false
  updateBatchBar()
  await loadArticles()
}

function batchClear() {
  store.selected.clear()
  $('#article-tbody')
    .querySelectorAll('.row-sel')
    .forEach((cb) => {
      cb.checked = false
      cb.closest('tr').classList.remove('sel')
    })
  $('#thead-sel-all').checked = false
  $('#batch-retain-panel').classList.add('hidden')
  updateBatchBar()
}

function bindBatchRetainPanel() {
  $('#batch-retain').addEventListener('click', () => {
    // 打开批量留存面板（内嵌，radio 选目录 + 可选原因）
    const panel = $('#batch-retain-panel')
    const show = panel.classList.contains('hidden')
    if (show) {
      $('#br-title').textContent = `批量留存 ${store.selected.size} 篇`
      $('#br-reason').value = ''
      $('#br-msg').textContent = ''
      document.querySelectorAll('input[name="br-dir"]').forEach((r) => {
        r.checked = r.value === 'rejected'
      })
    }
    panel.classList.toggle('hidden', !show)
  })
}

/** 视图初始化：绑定本视图事件（入口启动时调用一次） */
export function initArticlesView() {
  $('#btnRefresh').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    try {
      await loadArticles()
    } catch (err) {
      // `loadArticles` 自己吞掉取数失败（拿不到就按空列表画），所以这里拿到的一定是**渲染**异常
      // ——不能再写"无法连接 Bridge"：那会把数据形状问题报成连接问题（2026-10-04 实测）。
      alert('文章列表渲染失败: ' + err.message)
    }
    btn.disabled = false
  })
  $('#filter-slot').addEventListener('change', applyFilters)
  $('#filter-status').addEventListener('change', applyFilters)
  $('#filter-risk').addEventListener('change', applyFilters)
  // 2026-08-28 D3：搜索输入 300ms 防抖（全量过滤+重渲染在输入时成本高）
  let filterDebounce = null
  $('#filter-q').addEventListener('input', () => {
    clearTimeout(filterDebounce)
    filterDebounce = setTimeout(applyFilters, 300)
  })
  $('#thead-sel-all').addEventListener('change', (e) => {
    const checked = e.currentTarget.checked
    // 全选当前过滤结果
    const vis = [...$('#article-tbody').querySelectorAll('.row-sel')]
    vis.forEach((cb) => {
      cb.checked = checked
    })
    vis.forEach((cb) => {
      if (checked) store.selected.add(cb.dataset.id)
      else store.selected.delete(cb.dataset.id)
      cb.closest('tr').classList.toggle('sel', checked)
    })
    updateBatchBar()
  })
  $('#batch-clear').addEventListener('click', batchClear)
  $('#batch-archive').addEventListener('click', batchArchive)
  bindBatchRetainPanel()
  $('#br-cancel').addEventListener('click', () => $('#batch-retain-panel').classList.add('hidden'))
  $('#br-confirm').addEventListener('click', batchRetainConfirm)
  $('#batch-delete').addEventListener('click', batchDelete)
}
