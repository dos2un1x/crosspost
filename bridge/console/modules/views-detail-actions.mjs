// 详情抽屉操作 + 事件绑定（2026-09-01 从 views-detail.mjs 拆分：重推/补记/留存/编辑/归档/删除/抖音 + initDetailView）
import { postJSON } from './api.mjs'
import { PLATFORM_NAMES } from './const.mjs'
import { store, getDefaultPlatforms, ensureDefaults } from './state.mjs'
import { $, statusText, fmtTime } from './utils.mjs'
import { loadArticles } from './views-articles.mjs'
import {
  openDetail,
  closeDetail,
  bindEditLivePreview,
  bindPlatformAuthRefresh,
  renderPreview,
} from './views-detail.mjs'

/* ── 通知状态文案（2026-09-11）────────────────────────────────────────
 * 重推区与抖音手动推送区共用，避免两处口径不一致。
 * 只有 status==='ok' 才说"已接收"；飞书按幂等键去重（ok=true 但复用旧 messageId、不产生新消息）
 * 必须单独提示，否则会出现"提示已发送、群里却没有"的假成功。 */
function notifyText(n) {
  if (!n) return null
  if (n.deduped)
    return `⚠ 飞书已去重，本次未产生新消息（幂等键 ${String(n.key || '').slice(0, 24)}… 复用了 ${String(n.messageId || '').slice(0, 12)}…）`
  if (n.status === 'ok')
    return '✓ 渠道 API 已接收' + (n.messageId ? `（${String(n.messageId).slice(0, 12)}…）` : '')
  if (n.status === 'fail') return '✕ 失败: ' + (n.error || '未知原因')
  if (n.status === 'disabled') return '未发送（通知未启用：设置页 notify.enabled=false）'
  if (n.status === 'off') return '未发送（通知通道设为 off）'
  return '未发送（' + n.status + '）'
}

/* ── 重推 ─────────────────────────── */
async function republish() {
  const btn = $('#d-republish')
  const resultEl = $('#d-repub-result')
  btn.disabled = true
  resultEl.className = 'repub-result'
  resultEl.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>发布中（恒草稿）…'
  const body = {
    id: store.detail.id,
    style: $('#d-style').value,
    platforms: [...store.selectedPlatforms],
    wechat: $('#d-wechat').checked,
    concurrency: store.proxyConcurrency || 3,
    // 2026-09-11：显式标记"人工触发"。后端以此豁免「生成后自动推送」开关的门控——
    // 否则 autoPush 关闭时这里会静默跳过全部平台（返回 platforms:{} 但 UI 仍显示成功）。
    manual: true,
  }
  if (!body.platforms.length && !body.wechat) {
    resultEl.textContent = '请至少选择一个平台或微信'
    btn.disabled = false
    return
  }
  try {
    const r = await postJSON('/proxy/publish', body, { timeoutMs: 600000 })
    if (r.error) throw new Error(r.error)
    const plats = r.platforms || {}
    const okN = Object.values(plats).filter((p) => p.status === 'ok').length
    const failList = Object.entries(plats)
      .filter(([, p]) => p.status === 'fail')
      .map(([id]) => id)
    const skipList = Object.entries(plats)
      .filter(([, p]) => p.status === 'skip')
      .map(([id]) => id)
    // 2026-09-11：未登录跳过的平台在响应里同时以 r.skip（id 数组）给出，而 summary.platforms
    // 未必都带上 skip 条目——两者合并，避免"选了 N 个、只报 N-1 个、也没说是谁"的观感。
    for (const id of r.skip || []) if (!skipList.includes(id)) skipList.push(id)
    // 2026-09-11：零派发分支改为**事实陈述**——手动推送明确不受「生成后自动推送」开关限制，
    // 不能把"没有任何平台结果"归因于那个开关（那正是上一版文案的错误之处）。
    // 特例：所选平台只有抖音 → 后端抖音铁律会把它从 platforms 里剔除（targetPlatforms 为空、
    // skip 也为空），这不是"异常"，而是"抖音走专用入口"，必须直接告诉用户怎么做。
    const reqPlats = Array.isArray(body.platforms) ? body.platforms : []
    const wc = r.wechat || { status: 'skip' }
    // 2026-09-11：微信也要如实列原因（此前只显示"跳过"，看不出是没勾、缺凭证还是被开关吞了）
    const wcText =
      wc.status === 'ok'
        ? '✓ 已存草稿'
        : wc.status === 'fail'
          ? '✕ ' + (wc.error || '失败')
          : body.wechat === false
            ? '未勾选'
            : '未执行（未勾选或后端未执行，原因见 bridge 日志）'
    // 2026-09-11：通知状态如实映射——此前把 'disabled'/'off'/'none' 都落进兜底分支显示成"已发送"，
    // 会造成"没发飞书却提示已发送"。现在只有 status==='ok' 才说已发送。（函数已提到模块级供抖音区复用）

    // 零平台结果的两种情况必须分开：
    //  a) 没选平台、但**微信成功了** → 这不是错误，正常报"平台 0/0"（此前这个分支会误报
    //     "本次未选择任何平台"，把成功的微信推送当成失败）；
    //  b) 没选平台且微信也没执行 / 选了平台却一个结果都没有 → 才是异常，按抖音特例/全跳过/后端无结果细分。
    const wechatRan = wc.status === 'ok' || wc.status === 'fail'
    if (!Object.keys(plats).length && !wechatRan) {
      resultEl.className = 'repub-result err'
      const allSkipped = skipList.length > 0 && skipList.length >= reqPlats.length
      const onlyDouyin = reqPlats.includes('douyin') && reqPlats.length === 1
      if (onlyDouyin) {
        resultEl.innerHTML =
          `⚠ 抖音不走「重推到所选平台」——请用上方「📱 推送到抖音（覆盖草稿箱）」按钮` +
          `<br><span class="card-sub">通用重推链路会剔除抖音（防自动链路误推抖音）；草稿已保存。</span>`
      } else if (!reqPlats.length) {
        resultEl.innerHTML =
          `⚠ 本次未选择任何平台，且微信未执行：${wcText}` +
          `<br><span class="card-sub">若要只推微信，请确认勾选了「微信草稿」；手动推送不受「生成后自动推送」开关限制。</span>`
      } else if (allSkipped) {
        resultEl.innerHTML =
          `⚠ 所选平台全部被跳过（未登录）：${skipList.map((i) => PLATFORM_NAMES[i] || i).join('、')}` +
          `<br><span class="card-sub">登录对应平台后重试即可；草稿已保存。</span>`
      } else {
        resultEl.innerHTML =
          `⚠ 未触发任何平台派发（请求平台 ${reqPlats.length} 个，后端未返回派发结果）` +
          `<br><span class="card-sub">手动推送不受「生成后自动推送」开关限制；草稿已保存。` +
          `请把这条与 bridge 日志里的 <code>[publish]</code> 记录一起发给管理员排查。</span>`
      }
      console.warn('[publish] 零派发响应:', { id: store.detail.id, req: body, resp: r })
      await loadArticles()
      await openDetail(store.detail.id)
      return
    }

    const lines = []
    const reqTotal = reqPlats.length
    lines.push(`微信: ${wcText}`)
    lines.push(
      `平台: ${okN}/${Object.keys(plats).length} 成功${failList.length ? '，失败: ' + failList.map((i) => PLATFORM_NAMES[i] || i).join(',') : ''}${skipList.length ? '，未登录跳过: ' + skipList.map((i) => PLATFORM_NAMES[i] || i).join(',') : ''}${reqTotal > Object.keys(plats).length + skipList.length ? `，另有 ${reqTotal - Object.keys(plats).length - skipList.length} 个平台无结果` : ''}`,
    )
    const nt = notifyText(r.notify)
    if (nt) lines.push(`通知: ${nt}`)
    resultEl.className =
      'repub-result ' + (failList.length || (okN === 0 && wc.status !== 'ok') ? '' : 'ok')
    resultEl.textContent = lines.join(' | ') // 后端 runPublishArticle 已统一脱敏（redactSecrets）
    await loadArticles()
    await openDetail(store.detail.id) // 刷新记录
  } catch (e) {
    resultEl.className = 'repub-result err'
    resultEl.textContent = '重推失败: ' + String(e.message || e)
  } finally {
    btn.disabled = false
  }
}

/* ── P5 手动补记 ───────────────────── */
function renderMarkChips() {
  const chips = $('#m-platforms')
  const ids = [
    ...new Set([
      ...getDefaultPlatforms(),
      ...Object.keys((store.detail.record && store.detail.record.platforms) || {}),
    ]),
  ]
  chips.innerHTML = ids
    .map(
      (id) =>
        `<span class="chip ${store.markSelected.has(id) ? 'on' : ''}" data-p="${id}">${PLATFORM_NAMES[id] || id}</span>`,
    )
    .join('')
  chips.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => {
      const id = c.dataset.p
      if (store.markSelected.has(id)) store.markSelected.delete(id)
      else store.markSelected.add(id)
      c.classList.toggle('on')
    }),
  )
}

async function saveMark() {
  const msg = $('#m-msg')
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>保存中…'
  const body = {
    id: store.detail.id,
    wechat: $('#m-wechat').checked ? 'ok' : 'none',
    mediaId: $('#m-media-id').value.trim() || undefined,
    platforms: [...store.markSelected].map((p) => ({ platform: p, status: 'ok' })),
    note: $('#m-note').value.trim() || undefined,
  }
  try {
    const r = await postJSON('/proxy/mark-published', body)
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = `已补记（状态: ${statusText(r.status)}）✓`
    $('#mark-panel').classList.add('hidden')
    await loadArticles()
    await openDetail(store.detail.id)
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '补记失败: ' + String(e.message || e)
  }
}

async function confirmRetain() {
  const msg = $('#r-msg')
  msg.className = 'repub-result'
  const dir = document.querySelector('input[name="retain-dir"]:checked')
  if (!dir) {
    msg.className = 'repub-result err'
    msg.textContent = '请选择留存目录'
    return
  }
  const reason = $('#r-reason').value.trim() || undefined
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>留存中…'
  try {
    const r = await postJSON('/proxy/retain', { id: store.detail.id, dir: dir.value, reason })
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = `✓ 已留存至${dir.value === 'risk' ? '风险库' : '低分库'}${reason ? `（${reason}）` : ''}`
    await loadArticles()
    closeDetail() // 2026-08-30：留存成功后自动关闭抽屉（closeDetail 会隐藏 retain-panel）
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '留存失败: ' + String(e.message || e)
  }
}

async function saveEdit() {
  const msg = $('#e-msg')
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>保存中…'
  try {
    const r = await postJSON('/proxy/update-draft', {
      id: store.detail.id,
      title: $('#e-title').value.trim(),
      markdown: $('#e-markdown').value,
    })
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = '已保存 ✓'
    showEditPanel(false)
    await loadArticles()
    await openDetail(store.detail.id)
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '保存失败: ' + String(e.message || e)
  }
}

function showEditPanel(show) {
  $('#edit-panel').classList.toggle('hidden', !show)
  if (show) {
    $('#e-title').focus()
    $('#edit-panel').scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

async function toggleArchive() {
  const cur = store.detail.record ? store.detail.record.status : 'draft'
  const target = cur === 'archived' ? 'restore' : 'archive'
  try {
    const r = await postJSON('/proxy/archive', { id: store.detail.id, action: target })
    if (r.error) throw new Error(r.error)
    await loadArticles()
    closeDetail() // 2026-08-30：归档成功后自动关闭抽屉
  } catch (e) {
    alert('归档操作失败: ' + String(e.message || e))
  }
}

async function deleteCurrent() {
  if (
    !confirm(`确定删除《${$('#d-title').textContent}》？\n将同时删除草稿文件与推送记录，不可恢复。`)
  )
    return
  try {
    const r = await postJSON('/proxy/delete-draft', { id: store.detail.id, authorized: true })
    if (r.error) throw new Error(r.error)
    closeDetail()
    await loadArticles()
  } catch (e) {
    alert('删除失败: ' + String(e.message || e))
  }
}

async function pushDouyin() {
  const btn = $('#d-douyin')
  const resultEl = $('#d-douyin-result')
  const dyCur = store.articles.find((a) => a.douyinCurrent)
  const curText = dyCur
    ? `《${dyCur.title || dyCur.id}》（${fmtTime(dyCur.douyinPushedAt)} 推送）`
    : '空'
  if (
    !confirm(
      `将把《${$('#d-title').textContent}》推送到抖音草稿箱，\n会覆盖现有草稿（当前：${curText}）。\n\n确认推送？（抖音仅手动推送，不会进自动链路）`,
    )
  )
    return
  btn.disabled = true
  resultEl.className = 'repub-result'
  resultEl.title = ''
  resultEl.innerHTML =
    '<span class="spinner" style="border-color:var(--line);border-top-color:var(--ink)"></span>推送中…'
  try {
    const r = await postJSON(
      '/proxy/publish-douyin',
      { id: store.detail.id, style: $('#d-style').value },
      { timeoutMs: 600000 },
    )
    if (r.error) throw new Error(r.error)
    const dy = r.platforms && r.platforms.douyin
    // 2026-09-11：抖音推送同样会发飞书通知（后端 runPublishDouyin 默认 notify=true），
    // 这里把通知状态如实显示出来（与重推区同一套文案），不再只报推送结果。
    const nt = notifyText(r.notify)
    const notifySeg = nt ? ` | 通知: ${nt}` : ''
    if (dy && dy.status === 'ok') {
      resultEl.className = 'repub-result ok'
      resultEl.textContent = `✓ 已覆盖抖音草稿箱${dy.postUrl ? ' · 打开草稿' : ''}${notifySeg}`
      // 2026-09-11：抖音结果行现在是单行省略（把高度让给文章区），全文放进 title 兜底
      resultEl.title = resultEl.textContent
      await loadArticles()
      // 内部刷新当前抽屉（抽屉已显示 → freshOpen=false，不会清空本结果行）
      await openDetail(store.detail.id)
    } else {
      // 2026-09-11：失败原因不再丢成"未知原因"——按 平台 error → 顶层 error → errors[] 明细 → 原始状态 四级取因
      const fromErrors = ((r.errors || []).find((e) => e && e.what === 'platform:douyin') || {})
        .error
      const reason =
        (dy && dy.error) ||
        r.error ||
        fromErrors ||
        (dy ? `平台返回 status=${dy.status}（未附原因）` : '响应缺少 platforms.douyin')
      resultEl.className = 'repub-result err'
      resultEl.textContent = '抖音推送失败: ' + reason + notifySeg
      resultEl.title =
        resultEl.textContent +
        '\n' +
        JSON.stringify({
          douyin: dy || null,
          errors: r.errors || [],
          notify: r.notify || null,
        }).slice(0, 800)
      console.error('[douyin] 推送失败原始响应:', r)
    }
  } catch (e) {
    resultEl.className = 'repub-result err'
    resultEl.textContent = '推送失败: ' + String(e.message || e)
    resultEl.title = resultEl.textContent
  } finally {
    btn.disabled = false
  }
}

/** 视图初始化：绑定详情抽屉事件（入口启动时调用一次） */
export function initDetailView() {
  bindEditLivePreview()
  bindPlatformAuthRefresh() // 2026-09-11：平台检查完成后刷新抽屉 chips
  $('#d-close').addEventListener('click', closeDetail)
  $('#drawer-backdrop').addEventListener('click', closeDetail)
  // 2026-08-30：按 ESC 关闭抽屉——先关子面板（避免误丢编辑），再关抽屉
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (!$('#detail-drawer').classList.contains('hidden')) {
      const panels = ['#edit-panel', '#mark-panel', '#retain-panel']
      const open = panels.find((p) => !$(p).classList.contains('hidden'))
      if (open) {
        $(open).classList.add('hidden')
        return
      }
      closeDetail()
    }
  })
  $('#d-render').addEventListener('click', renderPreview)
  // 生成封面按钮（2026-09-10 摘除）：恢复 = 加回 index.html 的 #d-cover 按钮 + 此处一行绑定 + import generateCover
  $('#d-republish').addEventListener('click', republish)
  $('#d-douyin').addEventListener('click', pushDouyin)
  $('#d-edit').addEventListener('click', () =>
    showEditPanel($('#edit-panel').classList.contains('hidden')),
  )
  // 2026-09-05：跳转编写工作台（#/editor/<id>），关闭抽屉
  $('#d-write').addEventListener('click', () => {
    const id = store.detail.id
    if (!id) return
    closeDetail()
    location.hash = '#/editor/' + encodeURIComponent(id)
  })
  $('#e-cancel').addEventListener('click', () => showEditPanel(false))
  $('#e-save').addEventListener('click', saveEdit)
  $('#d-archive').addEventListener('click', toggleArchive)
  $('#d-delete').addEventListener('click', deleteCurrent)
  // P5 手动补记
  $('#d-mark').addEventListener('click', async () => {
    const panel = $('#mark-panel')
    const show = panel.classList.contains('hidden')
    if (show) {
      const rec = store.detail.record
      await ensureDefaults()
      store.markSelected = new Set(getDefaultPlatforms())
      $('#m-media-id').value = (rec && rec.wechat && rec.wechat.mediaId) || ''
      $('#m-note').value = ''
      $('#m-wechat').checked = !(rec && rec.wechat && rec.wechat.status === 'fail')
      $('#m-msg').textContent = ''
      renderMarkChips()
    }
    panel.classList.toggle('hidden', !show)
  })
  $('#m-cancel').addEventListener('click', () => $('#mark-panel').classList.add('hidden'))
  $('#m-save').addEventListener('click', saveMark)
  // 手动留存
  $('#d-retain').addEventListener('click', () => {
    const panel = $('#retain-panel')
    const show = panel.classList.contains('hidden')
    if (show) {
      $('#r-reason').value = ''
      $('#r-msg').textContent = ''
      document.querySelectorAll('input[name="retain-dir"]').forEach((r) => {
        r.checked = r.value === 'rejected'
      })
    }
    panel.classList.toggle('hidden', !show)
  })
  $('#r-cancel').addEventListener('click', () => $('#retain-panel').classList.add('hidden'))
  $('#r-confirm').addEventListener('click', confirmRetain)
  // 抽屉 tab 切换
  document.querySelectorAll('.dtab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.dtab').forEach((x) => x.classList.toggle('active', x === t))
      document
        .querySelectorAll('.dtab-pane')
        .forEach((p) => p.classList.toggle('active', p.id === 'pane-' + t.dataset.dtab))
    }),
  )
}
