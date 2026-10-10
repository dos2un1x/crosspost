// 归档库视图（2026-08-24 app.js 拆分 Phase 1）
import { getJSON, postJSON } from './api.mjs'
import { SCORE_PASS } from './const.mjs'
import { slotName } from './slot-lexicon.mjs'
import { store } from './state.mjs'
import { $, escapeHtml, riskBadge, fmtTime, pageSlice, renderPager } from './utils.mjs'
import { loadArticles } from './views-articles.mjs'
import { openDetail } from './views-detail.mjs'

// 作者：dos2un1x · 项目：https://github.com/dos2un1x/crosspost
export async function loadArchive() {
  const el = $('#archive-tbody')
  el.innerHTML = '<tr><td colspan="7" class="placeholder">加载中…</td></tr>'
  try {
    const data = await getJSON('/proxy/archive')
    store.archived = data.archived || []
    renderArchive()
  } catch (e) {
    el.innerHTML = `<tr><td colspan="7" class="placeholder">加载失败: ${escapeHtml(e.message)}</td></tr>`
  }
}

function renderArchive() {
  const slot = $('#af-slot').value
  const risk = $('#af-risk').value
  const q = $('#af-q').value.trim().toLowerCase()
  const list = store.archived.filter((r) => {
    if (slot && r.slot !== slot) return false
    if (risk && (r.risk || 'none') !== risk) return false
    if (
      q &&
      !(
        String(r.title ?? '')
          .toLowerCase()
          .includes(q) ||
        String(r.id ?? '')
          .toLowerCase()
          .includes(q)
      )
    )
      return false
    return true
  })
  $('#archive-count').innerHTML =
    `<span>归档 <b>${store.archived.length}</b> 篇</span><span style="color:var(--ink-faint)">草稿在 drafts/archive/ · 推送记录保留 · 仅人工操作</span>`
  const tbody = $('#archive-tbody')
  const shown = pageSlice(list, store.archivePage)
  renderPager($('#archive-pager'), list.length, store.archivePage, (pg) => {
    store.archivePage = pg
    renderArchive()
  })
  if (!shown.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="placeholder">归档库为空</td></tr>'
    return
  }
  tbody.innerHTML = shown
    .map((r) => {
      const missing = !r.hasFile
      return `<tr class="row-click" data-id="${escapeHtml(r.id)}" title="点开查看记录（只读）">
      <td class="cell-date">${escapeHtml(r.date || '—')}</td>
      <td><span class="cell-slot">${escapeHtml(slotName(r.slot) || '—')}</span></td>
      <td class="cell-title"><span class="${missing ? '' : 'has-file'}" ${missing ? 'style="color:var(--ink-faint)"' : ''}>${escapeHtml(r.title || r.id)}${missing ? ' <em style="font-style:normal;font-size:11px">（文件缺失）</em>' : ''}</span></td>
      <td>${r.score !== null && r.score !== undefined ? `<span class="score-badge ${r.score >= SCORE_PASS ? '' : 'fail'}">${r.score}</span>` : '—'}</td>
      <td>${riskBadge(r.risk) || '<span style="color:var(--ink-faint)">—</span>'}</td>
      <td>${r.archivedAt ? fmtTime(r.archivedAt) : '<span style="color:var(--ink-faint)">—</span>'}</td>
      <td class="retained-ops">
        ${missing ? '' : `<button class="btn small" data-op="restore" data-id="${escapeHtml(r.id)}" title="移回草稿目录，恢复为未归档">恢复</button>`}
        <button class="btn small danger" data-op="delete" data-id="${escapeHtml(r.id)}" title="永久删除草稿文件与记录（不可恢复）">删除</button>
      </td>
    </tr>`
    })
    .join('')
  tbody
    .querySelectorAll('button[data-op]')
    .forEach((btn) =>
      btn.addEventListener('click', () => archiveOp(btn.dataset.op, btn.dataset.id)),
    )
  // 2026-10-10：归档稿也能点开抽屉（**只读**：不显示编辑/留存/推送那些动作）——
  // 决策、审稿、AI 检测这些记录随文章一起归档了，此前只有"草稿"视图能看，
  // 一发布进归档库就再也查不到，复盘只能翻日志。
  tbody.querySelectorAll('tr.row-click').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return // 恢复/删除 按钮不该顺带把抽屉打开
      openDetail(tr.dataset.id, { readOnly: true })
    })
  })
}

async function archiveOp(op, id) {
  const msg = $('#archive-msg')
  msg.className = 'repub-result'
  if (
    op === 'delete' &&
    !confirm(`确认永久删除《${id}》？（草稿文件与推送记录一并删除，不可恢复）`)
  )
    return
  msg.innerHTML = '<span class="spinner tone-accent"></span>处理中…'
  try {
    const r = await postJSON('/proxy/archive', { id, action: op, authorized: op === 'delete' })
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = op === 'restore' ? '✓ 已恢复至文章列表' : '✓ 已删除'
    await loadArchive()
    if (op === 'restore') await loadArticles()
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = String(e.message || e)
  }
}

/** 视图初始化：绑定归档库事件 */
export function initArchiveView() {
  $('#af-slot').addEventListener('change', () => {
    store.archivePage = 1
    renderArchive()
  })
  $('#af-risk').addEventListener('change', () => {
    store.archivePage = 1
    renderArchive()
  })
  $('#af-q').addEventListener('input', () => {
    store.archivePage = 1
    renderArchive()
  })
}
