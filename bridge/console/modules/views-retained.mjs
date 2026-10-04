// 留存库视图（2026-08-24 app.js 拆分 Phase 1）
import { getJSON, postJSON } from './api.mjs'
import { SCORE_PASS } from './const.mjs'
import { slotName } from './slot-lexicon.mjs'
import { store } from './state.mjs'
import { $, escapeHtml, riskBadge, pageSlice, renderPager } from './utils.mjs'

export async function loadRetained() {
  const el = $('#retained-tbody')
  el.innerHTML = '<tr><td colspan="7" class="placeholder">加载中…</td></tr>'
  try {
    const data = await getJSON('/proxy/retained')
    store.retained = data.retained || []
    renderRetained()
  } catch (e) {
    el.innerHTML = `<tr><td colspan="7" class="placeholder">加载失败: ${escapeHtml(e.message)}</td></tr>`
  }
}

function renderRetained() {
  const dir = $('#rf-dir').value
  const risk = $('#rf-risk').value
  const q = $('#rf-q').value.trim().toLowerCase()
  const list = store.retained.filter((r) => {
    if (dir && r.dir !== dir) return false
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
  const nLow = store.retained.filter((r) => r.dir === 'rejected').length
  const nRisk = store.retained.filter((r) => r.dir === 'risk').length
  $('#retained-count').innerHTML =
    `<span>低分 <b>${nLow}</b></span><span>高风险 <b>${nRisk}</b></span><span style="color:var(--ink-faint)">自动链路永不触碰 · 仅人工处理</span>`
  const tbody = $('#retained-tbody')
  const shown = pageSlice(list, store.retainedPage)
  renderPager($('#retained-pager'), list.length, store.retainedPage, (pg) => {
    store.retainedPage = pg
    renderRetained()
  })
  if (!shown.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="placeholder">留存库为空</td></tr>'
    return
  }
  tbody.innerHTML = shown
    .map((r) => {
      // 风险：记录 risk（人工确认过）优先，其次草稿 frontmatter risk
      const risk = r.recordRisk || r.risk || null
      // 库别：rejected=低分 / risk=高风险（2026-08-30 添加直观区分，复用工具栏图例配色）
      const low = r.dir === 'risk' ? false : true
      const dirClass = low ? 'low' : 'risk'
      const dirName = low ? '低分' : '高风险'
      return `<tr class="ret-${dirClass}">
      <td class="cell-date">${escapeHtml(r.date || '—')}</td>
      <td><span class="cell-slot">${escapeHtml(slotName(r.slot) || '—')}</span></td>
      <td class="cell-title"><span class="has-file">${escapeHtml(r.title || r.id)}</span></td>
      <td class="cell-kind"><span class="ret-kind ${dirClass}"><span class="dot ${low ? 'partial' : 'fail'}"></span>${dirName}</span></td>
      <td>${r.score !== null && r.score !== undefined ? `<span class="score-badge ${r.score >= SCORE_PASS ? '' : 'fail'}">${r.score}</span>` : '—'}</td>
      <td>${riskBadge(risk) || '<span style="color:var(--ink-faint)">—</span>'}</td>
      <td class="retained-ops">
        <button class="btn small ghost" data-op="restore" data-id="${escapeHtml(r.id)}" title="移回草稿目录，不推送">恢复</button>
        <button class="btn small danger" data-op="delete" data-id="${escapeHtml(r.id)}" title="永久删除（唯一删除入口）">删除</button>
      </td>
    </tr>`
    })
    .join('')
  tbody
    .querySelectorAll('button[data-op]')
    .forEach((btn) =>
      btn.addEventListener('click', () => retainedOp(btn.dataset.op, btn.dataset.id)),
    )
}

async function retainedOp(op, id) {
  const msg = $('#retained-msg')
  msg.className = 'repub-result'
  if (op === 'delete' && !confirm(`确认永久删除《${id}》？（不可恢复）`)) return
  msg.innerHTML = '<span class="spinner tone-accent"></span>处理中…'
  try {
    const r = await postJSON('/proxy/retained/' + op, { id, authorized: op === 'delete' })
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = op === 'restore' ? '✓ 已恢复至草稿目录' : '✓ 已删除'
    // 成功提示自动消失（3.5s），避免残留
    setTimeout(() => {
      msg.className = 'repub-result'
      msg.textContent = ''
    }, 3500)
    await loadRetained()
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = String(e.message || e)
  }
}

/** 视图初始化：绑定留存库事件 */
export function initRetainedView() {
  $('#rf-dir').addEventListener('change', () => {
    store.retainedPage = 1
    renderRetained()
  })
  $('#rf-risk').addEventListener('change', () => {
    store.retainedPage = 1
    renderRetained()
  })
  $('#rf-q').addEventListener('input', () => {
    store.retainedPage = 1
    renderRetained()
  })
}
