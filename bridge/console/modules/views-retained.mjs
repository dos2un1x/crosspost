// 留存库视图（2026-08-24 app.js 拆分 Phase 1）
// © dos2un1x · https://github.com/dos2un1x/crosspost
import { getJSON, postJSON } from './api.mjs'
import { SCORE_PASS } from './const.mjs'
import { slotName } from './slot-lexicon.mjs'
import { store } from './state.mjs'
import {
  $,
  escapeHtml,
  riskBadge,
  pageSlice,
  renderPager,
  fmtTime,
  stripSpecRefs,
} from './utils.mjs'
import { openDetail } from './views-detail.mjs'

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
    tbody.innerHTML = '<tr><td colspan="8" class="placeholder">留存库为空</td></tr>'
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
      // 留存原因（2026-10-09）：这一列回答"它为什么进了留存库"。
      // 三种状态要分清（只看 `retainedReason` 会把"有记录但没填原因"误报成"没记录"）：
      //   ① 有原因       → 显示原因（长文本截断，hover 看全文）
      //   ② 有记录无原因 → 「未填原因」：旧记录就是这样，不是故障
      //   ③ 没有记录     → 「⚠ 无记录」：写入方（有沙箱的写作 agent）移了文件却没写记录，
      //                    用工具栏的「补录缺失记录」修
      const reason = String(r.retainedReason || '').trim()
      const at = r.retainedAt ? fmtTime(r.retainedAt) : ''
      const atLine = at ? `<span class="ret-reason-at">${escapeHtml(at)}</span>` : ''
      let reasonCell
      if (reason) {
        const shown = stripSpecRefs(reason) // 展示用：条款号换说法（记录原文不动）
        reasonCell = `<td class="cell-reason"><span class="ret-reason" title="${escapeHtml(shown)}">${escapeHtml(shown)}</span>${atLine}</td>`
      } else if (r.hasRecord) {
        reasonCell = `<td class="cell-reason"><span class="ret-reason faint" title="记录里没有留存原因（旧记录常见：留存时没写原因）">未填原因</span>${atLine}</td>`
      } else {
        reasonCell = `<td class="cell-reason"><span class="ret-reason missing" title="没有文章库记录：常见成因是写入方移了文件却写不进记录（沙箱），可用工具栏「补录缺失记录」补齐">⚠ 无记录</span></td>`
      }
      return `<tr class="ret-${dirClass} row-click" data-id="${escapeHtml(r.id)}" title="点开查看记录（只读）">
      <td class="cell-date">${escapeHtml(r.date || '—')}</td>
      <td><span class="cell-slot">${escapeHtml(slotName(r.slot) || '—')}</span></td>
      <td class="cell-title"><span class="has-file">${escapeHtml(r.title || r.id)}</span></td>
      <td class="cell-kind"><span class="ret-kind ${dirClass}"><span class="dot ${low ? 'partial' : 'fail'}"></span>${dirName}</span></td>
      <td>${r.score !== null && r.score !== undefined ? `<span class="score-badge ${r.score >= SCORE_PASS ? '' : 'fail'}">${r.score}</span>` : '—'}</td>
      <td>${riskBadge(risk) || '<span style="color:var(--ink-faint)">—</span>'}</td>
      ${reasonCell}
      <td class="retained-ops">
        <button class="btn small ghost" data-op="restore" data-id="${escapeHtml(r.id)}" title="移回草稿目录，不推送">恢复</button>
        <button class="btn small danger" data-op="delete" data-id="${escapeHtml(r.id)}" title="永久删除（唯一删除入口）">删除</button>
      </td>
    </tr>`
    })
    .join('')
  // 2026-10-10：留存稿也能点开抽屉（**只读**）——留存原因、AI 检测判定、
  // 决策与审稿都在记录里，此前留存库只有"恢复/删除"两个按钮，看不到为什么被留存。
  tbody.querySelectorAll('tr.row-click').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return // 恢复/删除 按钮不该顺带把抽屉打开
      openDetail(tr.dataset.id, { readOnly: true })
    })
  })
  tbody
    .querySelectorAll('button[data-op]')
    .forEach((btn) =>
      btn.addEventListener('click', () => retainedOp(btn.dataset.op, btn.dataset.id)),
    )
}

/* ── 记录对账（2026-10-09）──
 * 先 dry-run 拿计划（只读），有缺口才问一次确认，再 apply。
 * 为什么不直接 apply：这一步会写引擎簿记，让人在"看到要补几篇"之后再点头。 */
async function repairRecords() {
  const msg = $('#retained-msg')
  const btn = $('#retained-repair')
  msg.className = 'repub-result'
  btn.disabled = true
  msg.innerHTML = '<span class="spinner tone-accent"></span>核对中…'
  try {
    const plan = await getJSON('/proxy/repair-records')
    if (plan.error) throw new Error(plan.error)
    const items = plan.items || []
    const conflicts = plan.conflicts || []
    if (!items.length) {
      msg.className = 'repub-result ok'
      msg.textContent =
        `无缺失记录（已核对 ${plan.okCount || 0} 篇）` +
        (conflicts.length
          ? `；另有 ${conflicts.length} 篇记录与文件对不上（同名多份，需人工确认）`
          : '')
      return
    }
    const names = items
      .map((i) => i.id)
      .slice(0, 5)
      .join('、')
    if (
      !confirm(
        `要补写 ${items.length} 篇留存记录（写前会把记录原件备份到 .local/repairs/）：\n${names}` +
          `${items.length > 5 ? ` 等 ${items.length} 篇` : ''}\n\n继续？`,
      )
    ) {
      msg.textContent = '已取消'
      return
    }
    msg.innerHTML = '<span class="spinner tone-accent"></span>补录中…'
    const r = await postJSON('/proxy/repair-records', {})
    if (r.error) throw new Error(r.error)
    const n = (r.applied || []).length
    msg.className = 'repub-result ok'
    msg.textContent =
      `已补录 ${n} 篇` +
      (r.backupRoot ? `（备份: ${r.backupRoot}）` : '') +
      ((r.conflicts || []).length ? `；另有 ${r.conflicts.length} 篇需人工确认` : '')
    await loadRetained()
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '补录失败: ' + String(e.message || e)
  } finally {
    btn.disabled = false
  }
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
  $('#retained-repair').addEventListener('click', () => repairRecords())
}
