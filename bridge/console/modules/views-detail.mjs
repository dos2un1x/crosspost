// 详情抽屉视图（2026-08-24 app.js 拆分 Phase 1）
import { getJSON, postJSON } from './api.mjs'
import { PLATFORM_NAMES, RISK_NAMES } from './const.mjs'
import { slotName } from './slot-lexicon.mjs'
import {
  store,
  getDefaultPlatforms,
  ensureDefaults,
  ensurePlatformAuth,
  onPlatformAuthChange,
} from './state.mjs'
import {
  $,
  escapeHtml,
  statusText,
  fmtTime,
  fmtNum,
  styleDisplayName,
  groupStyles,
} from './utils.mjs'

export async function openDetail(id) {
  // 记录打开抽屉时所在视图（仅文章视图改写 URL，避免从其他视图打开时劫持地址栏）
  const tab = document.querySelector('.tab.active')
  const fromView = (tab && tab.dataset.view) || 'articles'
  store.detail = { id, record: null, draft: null, fromView, failedIds: [] }
  store.selectedPlatforms = new Set()
  // 2026-09-11：**只有"关闭→打开"这一次才清空重推结果行**。
  // 注意 openDetail 也被内部用作"刷新当前抽屉"（重推/补记/留存后 await openDetail(store.detail.id)），
  // 若无条件清空，会把刚写入的结果/提示词条在几百毫秒后擦掉（实测：结果行先出现、350ms 后被清空）。
  // 判据：进入本函数时抽屉是否处于隐藏态——隐藏=用户新开抽屉，已显示=内部刷新。
  const drawerWasHidden = $('#detail-drawer').classList.contains('hidden')
  if (drawerWasHidden) {
    // #d-douyin-result 由 renderDetail 清空；#e-msg/#m-msg/#r-msg 在各自面板打开时清空；只有重推结果此前漏了
    const repubRes = $('#d-repub-result')
    if (repubRes) {
      repubRes.textContent = ''
      repubRes.className = 'repub-result'
    }
  }
  // deep-link：不触发 hashchange（用 replaceState）
  if (fromView === 'articles' && location.hash !== '#/' + fromView + '/' + encodeURIComponent(id)) {
    history.replaceState(null, '', '#/' + fromView + '/' + encodeURIComponent(id))
  }
  $('#drawer-backdrop').classList.remove('hidden')
  $('#detail-drawer').classList.remove('hidden')
  $('#d-title').textContent = '加载中…'
  try {
    const [rec, dr] = await Promise.all([
      getJSON(`/proxy/articles/${encodeURIComponent(id)}`),
      getJSON(`/proxy/draft/${encodeURIComponent(id)}`).catch(() => null),
    ])
    store.detail.record = rec.article
    store.detail.draft = dr && !dr.error ? dr : null
    renderDetail({ freshOpen: drawerWasHidden })
  } catch (e) {
    $('#d-title').textContent = '加载失败'
    $('#d-meta').textContent = String(e.message || e)
  }
}

export function closeDetail() {
  $('#drawer-backdrop').classList.add('hidden')
  $('#detail-drawer').classList.add('hidden')
  $('#mark-panel').classList.add('hidden')
  $('#edit-panel').classList.add('hidden')
  $('#retain-panel').classList.add('hidden') // 2026-09-03：与 mark/edit 一致，避免遗留到下一篇仍展开
  const fromView = store.detail.fromView
  store.detail = { id: null, record: null, draft: null, fromView: null }
  // 还原为打开抽屉时的视图路径（文章），其余视图从未改写 URL
  if (fromView === 'articles' && location.hash.startsWith('#/' + fromView + '/')) {
    history.replaceState(null, '', '#/' + fromView)
  }
}

async function renderDetail({ freshOpen = false } = {}) {
  const rec = store.detail.record
  const dr = store.detail.draft
  // 2026-09-11：平台登录状态改为**非阻塞**——/proxy/platforms 已纯缓存直读，
  // 冷启动立即返回 init=true（后台检查中）；不再让抽屉等平台检查，徽标随后由订阅更新。
  ensurePlatformAuth()
  loadPushMode() // 非阻塞读取「自动推送」开关状态（只影响提示文案）
  const title = rec && rec.title ? rec.title : (dr && dr.title) || store.detail.id
  $('#d-title').textContent = title
  const status = rec ? rec.status : 'draft'
  $('#d-status').className = 'badge ' + status
  $('#d-status').textContent = statusText(status)
  // 元信息拆成「摘要行」+「文件路径行」（2026-09-11）：路径完整可读（可换行），
  // 并整行挂 title 便于鼠标悬停看到不省略的原文。
  const metaHead = [
    rec && rec.date ? rec.date : (dr && dr.date) || '',
    rec && rec.slot ? slotName(rec.slot) : (dr && dr.slot) || '',
    rec && rec.style ? `样式 ${styleDisplayName(rec.style)}` : '',
  ].filter(Boolean)
  const metaFile = (dr && dr.file) || (rec && rec.file) || ''
  // 2026-09-11：路径行要求「一行显示、不要换行、字号要看得清」——三者不可兼得
  //（完整绝对路径 82 字符 ≈ 545px，一行可用宽度约 360px），因此：
  //  · 默认按可读字号（11.5px）一行显示，超出部分省略（不换行）；
  //  · 悬停/键盘聚焦时用浮动层显示**完整绝对路径**（不占布局高度，可整段选中拷贝）。
  const metaEl = $('#d-meta')
  metaEl.innerHTML =
    (metaHead.length ? `<span class="meta-seg">${escapeHtml(metaHead.join('  ·  '))}</span>` : '') +
    (metaFile
      ? `<span class="meta-seg meta-file" tabindex="0"><bdi>${escapeHtml(metaFile)}</bdi>` +
        `<span class="meta-file-full" role="tooltip">${escapeHtml(metaFile)}</span></span>`
      : '')
  metaEl.title = [...metaHead, metaFile].filter(Boolean).join('  ·  ')

  // 样式下拉（2026-08-25：按组分类 + 显示名 + desc 悬停提示；value 恒为真实样式名）
  // 2026-08-30：不显示已禁用样式（动态随 /proxy/styles 的 enabled 配置变化）。
  // 若文章当前样式本身被禁用，则保留为「当前（已禁用）」单选项，避免下拉丢值导致预览/重推用错样式。
  const styles = await getJSON('/proxy/styles').catch(() => ({ styles: [] }))
  const styleList = styles.styles || []
  const curStyle = (rec && rec.style) || 'swiss'
  if (!styleList.length) {
    $('#d-style').innerHTML =
      `<option value="${escapeHtml(curStyle)}">${escapeHtml(curStyle)}</option>`
  } else {
    const enabledStyles = styleList.filter((s) => s.enabled !== false)
    const curDisabled = enabledStyles.every((s) => s.name !== curStyle)
    const groups = groupStyles(enabledStyles)
    $('#d-style').innerHTML =
      (curDisabled
        ? `<option value="${escapeHtml(curStyle)}" selected>当前（已禁用）</option>`
        : '') +
      [...groups.entries()]
        .map(
          ([_key, g]) => `
        <optgroup label="${escapeHtml(g.title)}">${g.items
          .map(
            (s) => `
          <option value="${escapeHtml(s.name)}" ${s.name === curStyle ? 'selected' : ''} title="${escapeHtml(String(s.desc ?? '').slice(0, 120))}">${escapeHtml(styleDisplayName(s.name))}</option>`,
          )
          .join('')}
        </optgroup>`,
        )
        .join('')
  }

  // 封面模板下拉（2026-08-27）已随「生成封面」入口于 2026-09-10 摘除，本抽屉不再渲染它

  // 原文
  $('#d-raw').textContent = dr ? dr.markdown : '(草稿文件不存在或已删除)'

  // 记录网格
  $('#d-record-grid').innerHTML = renderRecordGrid(rec)
  // 风险分类下拉保存
  $('#d-record-grid')
    .querySelectorAll('.risk-sel')
    .forEach((sel) => {
      sel.addEventListener('change', async () => {
        const hint = sel.parentElement.querySelector('.risk-hint')
        try {
          const r = await postJSON('/proxy/set-risk', { id: sel.dataset.id, risk: sel.value })
          if (r.error) throw new Error(r.error)
          hint.textContent = '已保存 ✓'
          hint.className = 'risk-hint ok'
        } catch (e) {
          hint.textContent = '失败: ' + String(e.message || e)
          hint.className = 'risk-hint err'
        }
      })
    })

  // 时间线
  $('#d-history').innerHTML = renderTimeline(rec)

  // 生成消耗（token + 费用，2026-08-22）：异步加载，失败静默
  renderCost(store.detail.id)

  // 并发发布数读全局配置（2026-08-25 自 DSH 设置页合并）：失败回退 3
  getJSON('/proxy/config')
    .then((c) => {
      store.proxyConcurrency = (c && c.concurrency) || 3
    })
    .catch(() => {})

  // 平台 chips（默认选中失败平台；无记录时全选配置默认平台）
  const failedIds = rec
    ? Object.entries(rec.platforms || {})
        .filter(([, p]) => p.status === 'fail')
        .map(([id]) => id)
    : []
  const hasAnyRecord = rec && rec.status !== 'draft'
  await ensureDefaults()
  const base = getDefaultPlatforms()
  if (failedIds.length) store.selectedPlatforms = new Set(failedIds)
  else if (!hasAnyRecord) store.selectedPlatforms = new Set(base)
  else store.selectedPlatforms = new Set()
  renderChips(failedIds)

  // 微信 checkbox（有记录则按上次，无记录默认开）
  $('#d-wechat').checked = rec ? (rec.wechat ? rec.wechat.status !== 'skip' : true) : true

  // 抖音推送区：显示当前抖音草稿箱内容
  const dyCur = store.articles.find((a) => a.douyinCurrent)
  const dyText = dyCur
    ? dyCur.id === store.detail.id
      ? '✓ 这篇就是当前抖音草稿'
      : `当前草稿箱：《${dyCur.title || dyCur.id}》（${fmtTime(dyCur.douyinPushedAt)}）`
    : '当前草稿箱：空'
  $('#d-douyin-current').textContent = dyText
  // 2026-09-11：「当前草稿箱」已并入推送按钮同一行，长标题会被省略号截断 →
  // 把全文放进 title，悬停即可看到完整文案（不占高度）。
  $('#d-douyin-current').title = dyText
  // 2026-09-11：只在**用户新开抽屉**时清空抖音结果行；内部刷新（推送/补记/留存后 await openDetail）
  // 不能清，否则刚推送完的"成功/通知状态"会立刻消失（实测被 renderDetail 擦掉）。
  if (freshOpen) $('#d-douyin-result').textContent = ''

  // 编辑面板初始值 + 归档按钮文字 + 留存按钮状态
  $('#e-title').value = title
  $('#e-markdown').value = dr ? dr.markdown : ''
  const archiveBtn = $('#d-archive')
  archiveBtn.innerHTML =
    status === 'archived'
      ? '<span class="b-ic">📦</span>取消归档'
      : '<span class="b-ic">📦</span>归档'
  const retainBtn = $('#d-retain')
  if (status === 'retained') {
    retainBtn.disabled = true
    retainBtn.innerHTML = '<span class="b-ic">🗂️</span>已留存'
  } else if (status === 'archived') {
    retainBtn.disabled = true
    retainBtn.innerHTML = '<span class="b-ic">🗂️</span>已归档'
  } else {
    retainBtn.disabled = false
    retainBtn.innerHTML = '<span class="b-ic">🗂️</span>留存'
  }

  // 自动渲染预览
  if (dr) renderPreview()
}

/** 生成消耗（token + 费用）：详情抽屉异步加载，失败静默显示 "—"
 *  2026-08-28 精确计费：展示生成过程时间窗（burst 切分），金额 = 该过程窗口内的消耗 */
async function renderCost(id) {
  const el = $('#d-cost')
  if (!el) return
  el.innerHTML =
    '<span class="spinner" style="border-color:rgba(22,24,35,.3);border-top-color:#161823"></span>'
  try {
    const r = await getJSON(`/proxy/cost/${encodeURIComponent(id)}`).catch(() => null)
    const c = r && r.cost
    if (!c || !c.matched || !c.tokens) {
      el.innerHTML =
        '<span style="color:var(--ink-faint);font-size:12.5px">无会话记录（早期文章或非 dsh 生成，无法追溯）</span>'
      return
    }
    const t = c.tokens
    const hasHidden = c.hiddenCost > 0
    // 2026-08-29：调用次数 = Σ sessions.steps（每 step = 一次 LLM 请求）；
    // 平均上下文 = (input+cache)/调用次数 —— 说明多轮交互下前缀缓存读取量累计
    const callCount = (c.sessions || []).reduce((a, s) => a + (s.steps || 0), 0)
    const avgCtx = callCount > 0 ? Math.round((t.input + t.cache) / callCount) : 0
    const rows = [
      [
        '生成过程',
        c.processWindow
          ? `${fmtTime(c.processWindow.from)} → ${fmtTime(c.processWindow.to)}（${Math.max(1, Math.round((c.processWindow.to - c.processWindow.from) / 60000))} 分钟）`
          : '—',
      ],
      ['调用次数', `${fmtNum(callCount)} 次 LLM 请求 · 平均上下文 ${fmtNum(avgCtx)} tokens`],
      ['总 token', fmtNum(t.total)],
      ['主对话（实测）', fmtNum(t.input + t.cache + t.output)],
      ['  输入（未命中缓存）', fmtNum(t.input)],
      ['  输入（缓存命中）', fmtNum(t.cache)],
      ['  输出', `${fmtNum(t.output)}（推理 ${fmtNum(t.reasoning)}）`],
    ]
    if (hasHidden) {
      rows.push([
        '隐藏调用（估算）',
        `${fmtNum(t.hidden)} · web搜索 ${c.hiddenMeta.searches} 次 + 标题 ${c.hiddenMeta.titles} 次`,
      ])
    }
    rows.push(['生成会话', c.sessions && c.sessions.length ? `${c.sessions.length} 轮` : '—'])
    const body = rows
      .map(
        ([k, v]) =>
          `<div class="cost-row"><span class="k">${k}</span><span class="v">${v}</span></div>`,
      )
      .join('')
    const mainTxt = hasHidden
      ? `<div class="cost-sub">主对话 ¥${c.mainCost.toFixed(4)} · 隐藏估算 ¥${c.hiddenCost.toFixed(4)}</div>`
      : ''
    el.innerHTML = `<div class="cost-total">¥ <b>${c.cost.toFixed(4)}</b></div>${mainTxt}${body}`
  } catch {
    el.innerHTML = '<span style="color:var(--ink-faint);font-size:12.5px">费用计算失败</span>'
  }
}

function renderRecordGrid(rec) {
  if (!rec)
    return '<div class="rg-item"><span class="k">尚未发布</span><div class="v">这篇文章还没有推送记录。</div></div>'
  const items = []
  // 风险分类（2026-08-20）：显示 + 人工修改（保存 /proxy/set-risk）
  const curRisk = rec.risk || 'unclassified'
  items.push(
    `<div class="rg-item"><span class="k">风险分类</span><div class="v"><select class="risk-sel" data-id="${escapeHtml(rec.id)}">${['unclassified', 'none', 'ad', 'investment', 'pr', 'person'].map((r) => `<option value="${r}" ${r === curRisk ? 'selected' : ''}>${RISK_NAMES[r] || r}</option>`).join('')}</select><span class="risk-hint">${rec.riskHint === 'person' && rec.riskSource === 'rule-hint' ? '⚠ 疑似人名（规则提示，待人工确认）' : ''}</span></div></div>`,
  )
  // 手动留存信息（2026-08-21）：显示留存目录与原因
  if (rec.status === 'retained' || rec.retainedDir) {
    const dirName =
      rec.retainedDir === 'risk' ? '风险库（drafts/risk/）' : '低分库（drafts/rejected/）'
    items.push(
      `<div class="rg-item"><span class="k">留存</span><div class="v"><span class="badge retained">已留存</span> → ${escapeHtml(dirName)}${rec.retainedReason ? ' · 原因：' + escapeHtml(rec.retainedReason) : ''}</div></div>`,
    )
  }
  // 质量评分（§5.5）：记录头部展示
  if (rec.score && rec.score.total !== undefined) {
    const s = rec.score
    const dimTxt = s.dims
      ? Object.entries(s.dims)
          .map(([k, v]) => `${escapeHtml(k)} ${v}`)
          .join(' · ')
      : ''
    items.push(
      `<div class="rg-item"><span class="k">质量评分</span><div class="v"><span class="score-badge">${s.total}</span><span style="color:var(--ink-faint)"> / 100</span>${s.rewrites ? ` <span class="score-rewrite">重写 ${s.rewrites} 次</span>` : ''}${s.at ? '<br><span style="color:var(--ink-faint);font-size:11px">' + fmtTime(s.at) + '</span>' : ''}${dimTxt ? '<br><span style="color:var(--ink-faint);font-size:11px">' + dimTxt + '</span>' : ''}</div></div>`,
    )
  }
  // 编辑决策 / 独立审稿快照（2026-08-26 阶段 C-3）
  if (rec.decision || rec.review) {
    items.push(
      `<div class="rg-item"><span class="k">编辑决策</span><div class="v" style="font-size:11.5px;color:var(--ink-soft);line-height:1.5">${escapeHtml(rec.decision || '—')}</div></div>`,
    )
    items.push(
      `<div class="rg-item"><span class="k">独立审稿</span><div class="v" style="font-size:11.5px;color:var(--ink-soft);line-height:1.5">${escapeHtml(rec.review || '—')}</div></div>`,
    )
  }
  // 发布产物 HTML 归档（2026-08-26 阶段 C-2）
  const htmlEntry = (rec.history || [])
    .slice()
    .reverse()
    .find((h) => h.htmlFile || h.dryRunHtml)
  if (htmlEntry) {
    const f = htmlEntry.htmlFile || htmlEntry.dryRunHtml
    items.push(
      `<div class="rg-item"><span class="k">产物归档</span><div class="v"><code style="font-size:11px">${escapeHtml(f)}</code><span style="color:var(--ink-faint);font-size:11px"> · 文章库 articles/</span></div></div>`,
    )
  }
  if (rec.wechat && rec.wechat.status !== 'none') {
    const w = rec.wechat
    const openLink = w.mediaId
      ? ` <a href="https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=10&appmsgid=${encodeURIComponent(w.mediaId)}&token=&lang=zh_CN" target="_blank" rel="noopener">↗ 打开草稿</a>`
      : ''
    items.push(
      `<div class="rg-item"><span class="k">微信草稿</span><div class="v ${w.status === 'ok' ? '' : 'err'}">${w.status === 'ok' ? '✓ 已存草稿' : '✕ ' + escapeHtml(w.error || '失败')}${w.mediaId ? '<br><code style="font-size:11px">' + escapeHtml(w.mediaId) + '</code>' + openLink : ''}</div></div>`,
    )
  }
  const pf = rec.platforms || {}
  const okN = Object.values(pf).filter((p) => p.status === 'ok').length
  const failN = Object.values(pf).filter((p) => p.status === 'fail').length
  items.push(
    `<div class="rg-item"><span class="k">平台推送</span><div class="v">${okN} 成功 / ${failN} 失败 / ${Object.keys(pf).length} 共推</div></div>`,
  )
  if (rec.notify && rec.notify.status) {
    const n = rec.notify
    items.push(
      `<div class="rg-item"><span class="k">通知</span><div class="v">${n.status === 'ok' ? '✓ 已发送' : n.status === 'fail' ? '✕ ' + escapeHtml(n.error || '') : n.status}${n.messageId ? '<br><code style="font-size:11px">' + escapeHtml(n.messageId) + '</code>' : ''}</div></div>`,
    )
  }
  if (rec.notify && rec.notify.channel)
    items.push(
      `<div class="rg-item"><span class="k">通知渠道</span><div class="v">${escapeHtml(rec.notify.channel)}</div></div>`,
    )
  items.push(
    `<div class="rg-item"><span class="k">创建 / 更新</span><div class="v">${fmtTime(rec.createdAt)}<br>${fmtTime(rec.updatedAt)}</div></div>`,
  )
  return items.join('')
}

function renderTimeline(rec) {
  if (!rec || !rec.history || !rec.history.length)
    return '<li class="partial" style="color:var(--ink-faint)">暂无发布历史</li>'
  return rec.history
    .map((h) => {
      const cls = h.action === 'dryRun' ? 'partial' : h.failed && h.failed.length ? 'partial' : 'ok'
      const failedTxt = h.failed && h.failed.length ? `，失败: ${h.failed.join(',')}` : ''
      const errTxt =
        h.errors && h.errors.length
          ? '<br><span style="color:var(--fail)">' +
            escapeHtml(h.errors.map((e) => `${e.what}: ${e.error}`).join('; ')) +
            '</span>'
          : ''
      return `<li class="${cls}">
      <div class="tl-head">${h.action === 'dryRun' ? '渲染测试' : '发布'} · 微信 ${h.wechat || '—'} · 平台 ${h.platforms || '—'}${h.score !== undefined ? ` · 评分 ${h.score}` : ''}${failedTxt}</div>
      <div class="tl-time">${fmtTime(h.at)}</div>
      ${h.style ? `<div class="tl-detail">样式: ${escapeHtml(styleDisplayName(h.style))}</div>` : ''}
      <div class="tl-detail">${escapeHtml(h.note || '')}</div>${errTxt}
    </li>`
    })
    .join('')
}

async function renderChips(failedIds) {
  await ensureDefaults()
  const chips = $('#d-platforms')
  if (!chips) return
  store.detail.failedIds = failedIds || store.detail.failedIds || []
  const base = getDefaultPlatforms()
  const ids = [
    ...new Set([
      ...base,
      ...Object.keys((store.detail.record && store.detail.record.platforms) || {}),
    ]),
  ].filter((id) => {
    // 2026-09-11：抖音不进「重推到所选平台」——后端抖音铁律会把它从 platforms 里剔除
    // （自动/通用链路永不推抖音），勾了它只会得到"零派发"。抖音有专用推送入口（下方抖音推送区）。
    // 2026-09-12（模型 A）：微信同理排除——它的勾选只表示"纳入登录检查"，
    // 草稿走官方通道（上方「微信草稿」复选框），通用派发再走一遍会多出一份浏览器版草稿。
    const skip = id === 'douyin' || id === 'weixin'
    if (skip) store.selectedPlatforms.delete(id)
    return !skip
  })
  chips.innerHTML = ids
    .map((id) => {
      const on = store.selectedPlatforms.has(id)
      const isFail = (failedIds || []).includes(id)
      const authed = store.platformAuth[id]
      // 2026-09-11：undefined = 检查中/未知，不再误显示"未登录"；仅明确 false 才标未登录
      // 2026-09-12：检查范围外（默认推送平台之外、且不是曾登录过的锁定平台）标注「未检查」——
      // 既不冒充"未登录"，也不让人以为它的登录态是新鲜的；推送时后端 prefilterAuthed 仍会现场预检。
      const scopeIds =
        store.platformsScope && Array.isArray(store.platformsScope.ids)
          ? store.platformsScope.ids
          : null
      const authTag =
        authed === false
          ? '<em class="chip-auth">未登录</em>'
          : authed === undefined && store.platformsRefreshing
            ? '<em class="chip-auth">检查中</em>'
            : authed === undefined && scopeIds && !scopeIds.includes(id)
              ? '<em class="chip-auth">未检查</em>'
              : ''
      return `<span class="chip ${on ? 'on' : ''} ${isFail ? 'failmark' : ''}" data-p="${id}">${PLATFORM_NAMES[id] || id}${authTag}</span>`
    })
    .join('')
  chips.querySelectorAll('.chip').forEach((c) => {
    c.addEventListener('click', () => {
      const id = c.dataset.p
      if (store.selectedPlatforms.has(id)) store.selectedPlatforms.delete(id)
      else store.selectedPlatforms.add(id)
      c.classList.toggle('on')
    })
  })
}

/** 刷新「自动推送」模式提示 + 记录到 store（2026-09-11）
 *  手动重推/抖音推送不受该开关影响，但要让用户看清当前模式，避免再次误以为是"重推坏了"。 */
export function renderPushModeHint() {
  const el = $('#d-push-mode')
  if (!el) return
  el.className = store.autoPushEnabled ? 'repub-result ok' : 'repub-result'
  el.textContent = store.autoPushEnabled
    ? '自动推送：开启（定时链路自动派发）'
    : '自动推送：关闭（定时链路仅存草稿；手动重推/抖音推送不受影响）'
}

/** 读取 /proxy/status 的自动推送开关状态（非阻塞；失败静默，保持上次值） */
export async function loadPushMode() {
  try {
    const st = await getJSON('/proxy/status')
    if (st && st.autoPush) store.autoPushEnabled = !!st.autoPush.enabled
    renderPushModeHint()
  } catch {
    /* 状态不可用时保持上次显示 */
  }
}

/** 平台状态变化后刷新抽屉 chips（2026-09-11）：仅在抽屉打开且文章未切换时重渲染 */
export function bindPlatformAuthRefresh() {
  onPlatformAuthChange(() => {
    if (!store.detail.id) return
    if (!$('#detail-drawer') || $('#detail-drawer').classList.contains('hidden')) return
    renderChips(store.detail.failedIds)
  })
}

/* ── 渲染预览 ─────────────────────── */
async function renderPreviewText(markdown, style) {
  const btn = $('#d-render')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>渲染中'
  try {
    const r = await postJSON('/proxy/render', { markdown, style })
    if (r.error) throw new Error(r.error)
    $('#d-preview-frame').srcdoc = r.html || '<p style="padding:20px">渲染结果为空</p>'
  } catch (e) {
    $('#d-preview-frame').srcdoc =
      `<p style="padding:20px;color:#b4432f">渲染失败: ${escapeHtml(String(e.message || e))}</p>`
  } finally {
    btn.disabled = false
    btn.textContent = '渲染预览'
  }
}

export async function renderPreview() {
  if (!store.detail.draft) return
  const style = $('#d-style').value
  await renderPreviewText(store.detail.draft.markdown, style)
}

/* ── 生成封面（2026-08-27：13 款模板，替换旧 style）
   2026-09-10：抽屉 UI 入口已摘除（index.html 的 #d-cover / #d-cover-result 与
   views-detail-actions.mjs 的绑定）。函数**保留**以便随时恢复：后台 /proxy/cover 未做任何改动，
   恢复 = 加回 HTML 按钮 + 一行 import/绑定。封面本身仍由推送链路按设置页默认模板自动生成。
   ───────────────────────────────────── */
export async function generateCover() {
  const btn = $('#d-cover')
  const res = $('#d-cover-result')
  btn.disabled = true
  try {
    const title = ($('#d-title').textContent || '').trim() || '未命名'
    const template = ($('#d-cover-template') && $('#d-cover-template').value) || 'nebula'
    const r = await postJSON('/proxy/cover', { title, template })
    res.className = 'repub-result ' + (r.cover2_35_1 ? 'ok' : 'err')
    res.textContent = r.cover2_35_1 ? `✅ ${r.cover2_35_1} / ${r.cover1_1}` : r.error || '生成失败'
  } catch (e) {
    res.className = 'repub-result err'
    res.textContent = '封面生成失败: ' + String(e.message || e)
  } finally {
    btn.disabled = false
  }
}

// 编辑面板实时预览（debounce）
export function bindEditLivePreview() {
  $('#e-markdown').addEventListener('input', () => {
    clearTimeout(store.previewTimer)
    store.previewTimer = setTimeout(() => {
      if (!$('#edit-panel').classList.contains('hidden')) {
        const style = $('#d-style').value
        renderPreviewText($('#e-markdown').value, style)
      }
    }, 700)
  })
  $('#e-title').addEventListener('input', () => {
    clearTimeout(store.previewTimer)
    store.previewTimer = setTimeout(() => {
      if (!$('#edit-panel').classList.contains('hidden')) {
        const style = $('#d-style').value
        renderPreviewText($('#e-markdown').value, style)
      }
    }, 900)
  })
}
