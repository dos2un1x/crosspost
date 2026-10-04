// 选题库视图（2026-08-24 app.js 拆分 Phase 1）
import { getJSON, postJSON } from './api.mjs'
import { TOPICS_PAGE_SIZE } from './const.mjs'
import { slotName } from './slot-lexicon.mjs'
import { store } from './state.mjs'
import { $, escapeHtml, fmtTime, renderPager } from './utils.mjs'
import { loadArticles } from './views-articles.mjs'

/**
 * 读选题库并重渲染列表。
 * @param {{ keepBanner?: boolean }} [opts] keepBanner=true 时不动状态条——
 *   轮询收尾会先写结果再调本函数（用于回填关联文章），此时必须保留结果条。
 */
export async function loadTopics(opts = {}) {
  // 取数与渲染**分开兜底**：渲染异常不等于连不上桥。
  //
  // 为什么必须分开（2026-10-04 实测）：选题库里出现过字段错位的记录（`title` 装进了分数，
  // 是个数字），渲染时 `(数字).slice()` 抛异常 → 被同一个 catch 捕获 → 页面显示
  // 「无法连接 Bridge: (t.title || '').slice is not a function」，把一个**数据形状**问题
  // 报成了**连接**问题，排查方向直接跑偏。
  let data = null
  let fetchError = null
  try {
    data = await getJSON('/proxy/topics')
  } catch (err) {
    fetchError = err
  }
  if (fetchError) {
    $('#topics-tbody').innerHTML =
      `<tr><td colspan="7" class="empty">无法连接 Bridge: ${escapeHtml(fetchError.message)}</td></tr>`
  } else {
    store.topics = data.topics || []
    // v2.111：/proxy/topics 顺带带回逐条任务视图，首屏就能画出「排队中（第 N 位）」
    if (Array.isArray(data.tasks)) applyTopicTasks(data.tasks)
    try {
      renderTopicFilters()
      applyTopicFilters()
    } catch (err) {
      $('#topics-tbody').innerHTML =
        `<tr><td colspan="7" class="empty">选题库渲染失败（条目字段类型异常）: ${escapeHtml(err.message)}</td></tr>`
    }
  }
  // 能力探测（v2.42）：后端 `/proxy/topics/generate` 在"未提供能力"时返回 **501**，
  // 路由注释里写的是"Console 依 provided:false 隐藏入口"——而此前 Console 从不问，
  // 于是页面上摆着 24 个点了必然失败的「一键生成」按钮。
  // 只有**显式** provided === false 才禁用：字段缺失（老的 mock / 桥未升级）时不改行为。
  try {
    const st = await getJSON('/proxy/topics/generate/status')
    store.topicGenProvided = st && st.provided === false ? false : true
    // v2.51：能力可以来自「项目 manifest 声明的 HTTP 端点」或「引擎进程内钩子」，
    // 多项目下同一个页面在不同项目上答案不同——把来源留在手边，别只留一个布尔。
    store.topicGenProvider = (st && st.provider) || null
    store.topicGenUnavailable = (st && st.unavailable) || null
    store.topicGenMaxConcurrency = (st && st.maxConcurrency) || 1
  } catch {
    store.topicGenProvided = true
    store.topicGenProvider = null
    store.topicGenUnavailable = null
  }
  applyGenerateAvailability()
  // 状态条只表达"生成/删除进行中的事"：轮询那一路在收尾时会自行写入结果；
  // 其余情况（首屏进入、手动刷新列表）一律收回，避免残留上次结果或 HTML 里的静态兜底文案。
  //
  // v2.111：判据从"没有活动任务"改成"**一条任务都没有**"。队列化之后"活动任务"
  // 只是任务表的一部分——刚失败/刚完成的任务同样属于"该显示的事"；按旧判据，
  // 切回选题页会把上一次失败的原因整条吞掉（只剩行内那几个字）。
  if (!opts.keepBanner && !hasAnyTask()) dismissTopicBanner()
  else if (!opts.keepBanner)
    renderTopicSummary({
      tasks: Object.values(store.topicTasks || {}),
      maxConcurrency: store.topicGenMaxConcurrency,
    })
  // v2.111：客户端队列状态跟服务端走——重新取一次任务表就不该再留旧的轮询时刻表
  if (!opts.keepBanner) stopTopicsPoll()
  // 有活（或刚入队但还没落表）就挂轮询；否则不挂——空转的定时器只是白白打扰桥
  syncTopicPoll()
}

/* ── 任务表（v2.111）────────────────────────────────────────────────────
   引擎从"单例任务"改成"队列"之后，前端也必须按**任务**而不是按"当前那一条"来思考：
   `store.topicTasks` 是 taskId → task 的映射，`store.topicTaskOf` 是
   `(slot|keyword)` → taskId 的反查表（选题库里一条选题对应哪条任务）。 */

/** 用后端返回的任务列表重建映射（全量；服务端视角的权威列表） */
function applyTopicTasks(list) {
  const tasks = {}
  const of = {}
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || !t.id) continue
    tasks[t.id] = t
    of[taskKey(t.slot, t.keyword)] = t.id
  }
  store.topicTasks = tasks
  store.topicTaskOf = of
}

/**
 * 把刚刚入队/收敛的**单条**任务并进映射，已结束的旧任务保留。
 *
 * 为什么不走 applyTopicTasks：全量替换的数据源可能是 `/proxy/topics`，而它只带
 * "服务端当前活动/最近"的任务；刚失败的那条很容易被下一次全量刷新挤掉，
 * 于是"失败原因"在汇总条上闪一下就不见了。合并保留它。
 */
function mergeTopicTask(t) {
  if (!t || !t.id) return
  store.topicTasks[t.id] = t
  store.topicTaskOf[taskKey(t.slot, t.keyword)] = t.id
}

function taskKey(slot, keyword) {
  return `${slot || ''}\u0000${keyword || ''}`
}

/** 这条选题当前的生成任务（活动或最近终态），没有则 null */
function taskFor(row) {
  const id = store.topicTaskOf[taskKey(row.slot, row.keyword)]
  return id ? store.topicTasks[id] || null : null
}

/** 任务表里有没有任何任务（活动或终态）；汇总条据此决定要不要显示 */
function hasAnyTask() {
  return Object.keys(store.topicTasks || {}).length > 0
}

function hasActiveTasks() {
  return Object.values(store.topicTasks || {}).some(
    (t) => t.state === 'queued' || t.state === 'running',
  )
}

/** 能力未提供时：禁用所有「一键生成」按钮并说明原因（而不是让人点了才知道） */
function applyGenerateAvailability() {
  const btns = document.querySelectorAll('#topics-tbody [data-gen-slot]')
  const batch = $('#topics-gen-pending')
  if (store.topicGenProvided === false) {
    const why =
      (store.topicGenUnavailable && store.topicGenUnavailable.reason) ||
      '当前接入项目未提供「一键生成」能力（引擎不再代跑外部脚本）'
    for (const b of btns) {
      b.disabled = true
      b.title = `${why} · 运行 npm run doctor 查看详情`
    }
    if (batch) {
      batch.disabled = true
      batch.title = `${why} · 运行 npm run doctor 查看详情`
    }
    return
  }
  // v2.51：可用时也把来源写在按钮上——"这个按钮背后是谁"应当一点就知，
  // 否则切了项目之后没人能解释为什么某天能点、某天不能点。
  const p = store.topicGenProvider
  if (p && (p.source || p.url)) {
    const max = store.topicGenMaxConcurrency || 1
    const desc = `「一键生成」由 ${p.source || p.kind} 提供${p.url ? ` · 端点 ${p.url}` : ''} · 引擎并发上限 ${max}`
    for (const b of btns) if (!b.title) b.title = desc
    if (batch) batch.title = `${desc}（当前筛选结果里的未生成选题会依次排队）`
  }
}

/** 收起状态条（回到 idle）：隐藏 + 清空（index.html 的静态兜底文案只服务"JS 尚未接管"的窗口） */
function dismissTopicBanner() {
  const el = $('#topics-banner')
  if (!el) return
  el.className = 'tgen tgen--idle hidden'
  el.textContent = ''
  el.removeAttribute('aria-busy')
}

function renderTopicFilters() {
  const sel = $('#tf-slot')
  const cur = sel.value
  const slots = [...new Set(store.topics.map((t) => t.slot))].sort((a, b) =>
    slotName(a).localeCompare(slotName(b)),
  )
  sel.innerHTML =
    '<option value="">全部栏目</option>' +
    slots.map((s) => `<option value="${s}">${escapeHtml(slotName(s))}</option>`).join('')
  sel.value = cur
}

function applyTopicFilters() {
  store.topicsFilter = {
    slot: $('#tf-slot').value,
    status: $('#tf-status').value,
    date: $('#tf-date').value,
    q: $('#tf-q').value.trim().toLowerCase(),
  }
  store.topicsPage = 1
  renderTopics()
}

function filteredTopics() {
  const f = store.topicsFilter
  // 行模板里的 title/keyword/reason 一律 `String(x ?? '')` 后再用：写入侧的字段错位
  // 曾让 title 装进分数（数字），`(数字).slice()` 抛异常又被取数兜底误报成「无法连接 Bridge」。
  // 这些说明只能写在模板**外面**——模板字面量里的反引号会把模板提前结束（语法仍然合法，行为已坏）。
  const list = store.topics.filter((t) => {
    if (f.slot && t.slot !== f.slot) return false
    if (f.status && t.status !== f.status) return false
    if (
      f.q &&
      !(
        String(t.keyword || '')
          .toLowerCase()
          .includes(f.q) ||
        String(t.title || '')
          .toLowerCase()
          .includes(f.q)
      )
    )
      return false
    if (f.date) {
      const days = f.date === '7d' ? 7 : 30
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
      if ((t.date || '') < cutoff) return false
    }
    return true
  })
  // 内建栏目按固定序；项目自定义的栏目排在其后（`indexOf` 未命中是 -1，会把它抢到最前，
  // 所以这里显式映射成"已知序之后"）——栏目 id 由项目声明，引擎不设白名单。
  const SLOT_ORDER = ['morning', 'hotspot', 'noon', 'hotspot2', 'tips', 'evening']
  const slotRank = (slot) => {
    const i = SLOT_ORDER.indexOf(slot)
    return i >= 0 ? i : SLOT_ORDER.length
  }
  const STATUS_ORDER = ['generated', 'adopted', 'rejected'] // 同一天内 可操作(生成/未生成) 优先，落选沉底
  list.sort(
    (a, b) =>
      (b.date || '').localeCompare(a.date || '') ||
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      slotRank(a.slot) - slotRank(b.slot) ||
      (a.rank ?? 99) - (b.rank ?? 99),
  )
  return list
}

function topicStatusBadge(t) {
  if (t.status === 'generated') return '<span class="tstatus gen">✓ 已生成</span>'
  if (t.status === 'adopted') return '<span class="tstatus pend">◔ 未生成</span>'
  return `<span class="tstatus rej">✕ 落选</span>${t.reason ? `<div class="t-reason" title="${escapeHtml(t.reason)}">${escapeHtml(String(t.reason ?? '').slice(0, 40))}</div>` : ''}`
}

/** 任务时长（与 topicGenElapsed 同规则，但按任务对象） */
function shortElapsed(t, now = Date.now()) {
  const t0 = Date.parse((t && t.startedAt) || (t && t.enqueuedAt) || '')
  if (!t0) return ''
  const t1 = t && t.finishedAt ? Date.parse(t.finishedAt) : now
  const s = Math.max(0, Math.round((t1 - t0) / 1000))
  const dur = s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
  return t && t.finishedAt ? dur : `已运行 ${dur}`
}

/**
 * 该选题「生成」这一列的内容（v2.111）。
 *
 * 旧版是"每行一个按钮 + 页面顶部一条全局状态条"：连点两条时第二条会被后端拒绝，
 * 而界面上唯一的状态条已经被第一条占着，于是看起来像"点了没反应"。
 * 现在状态就近显示在行内，按钮随任务状态变形（排队/生成中/完成链接/失败重试）。
 */
function topicGenCell(t) {
  const task = taskFor(t)
  const esc = (s) => escapeHtml(String(s ?? ''))
  const active = task && (task.state === 'queued' || task.state === 'running')
  const cell = (inner) => `<td class="tgen-cell" data-gen-cell="${esc(t.id)}">${inner}</td>`

  if (active) {
    const label =
      task.state === 'running'
        ? `生成中 · ${shortElapsed(task)}`
        : `排队中（第 ${task.queuePosition || '?'} 位）`
    return cell(
      `<button class="btn mini ghost" disabled>${esc(label)}</button>` +
        `<button class="btn mini ghost" data-gen-cancel="${esc(task.id)}" title="停止跟踪这条任务">取消</button>`,
    )
  }

  if (task && task.state === 'failed') {
    const why = task.error || task.errorCode || '生成失败'
    return cell(
      `<button class="btn mini primary" data-gen-slot="${esc(t.slot)}" data-gen-keyword="${esc(t.keyword)}" data-gen-id="${esc(t.id)}" data-gen-date="${esc(t.date)}">重试</button>` +
        `<div class="t-reason" title="${esc(why)}">${esc(why.slice(0, 60))}</div>`,
    )
  }

  if (task && task.state === 'canceled') {
    return cell(
      `<button class="btn mini ghost" data-gen-slot="${esc(t.slot)}" data-gen-keyword="${esc(t.keyword)}" data-gen-id="${esc(t.id)}" data-gen-date="${esc(t.date)}">重新生成</button>` +
        `<div class="t-reason">${esc(task.error || '已取消')}</div>`,
    )
  }

  if (task && task.state === 'done' && task.draftId) {
    const title = t.articleTitle || task.draftId
    return cell(
      `<a class="t-article" href="#/articles/${encodeURIComponent(task.draftId)}">查看《${esc(title)}》</a>` +
        `<div class="t-reason">用时 ${esc(shortElapsed(task))}</div>`,
    )
  }

  // 无任务：能生成的给按钮，已生成的不给（与旧行为一致）
  const canGen = t.status !== 'generated' || !t.articleId
  if (!canGen) return cell('<span style="color:var(--ink-faint)">—</span>')
  return cell(
    `<button class="btn mini ${t.status === 'rejected' ? 'ghost' : 'primary'}" data-gen-slot="${esc(t.slot)}" data-gen-keyword="${esc(t.keyword)}" data-gen-id="${esc(t.id)}" data-gen-date="${esc(t.date)}">一键生成</button>`,
  )
}

function renderTopics() {
  const list = filteredTopics()
  const total = list.length
  const pages = Math.max(1, Math.ceil(total / TOPICS_PAGE_SIZE))
  if (store.topicsPage > pages) store.topicsPage = pages
  const pageList = list.slice(
    (store.topicsPage - 1) * TOPICS_PAGE_SIZE,
    store.topicsPage * TOPICS_PAGE_SIZE,
  )

  $('#topics-summary').textContent =
    `共 ${total} 条 · 已生成 ${list.filter((t) => t.status === 'generated').length} · 未生成 ${list.filter((t) => t.status === 'adopted').length} · 落选 ${list.filter((t) => t.status === 'rejected').length}`

  // 批量入口的可用性与计数：只算"当前筛选结果里还没生成、也不在队列里"的那些
  const pending = list.filter((t) => {
    if (t.status === 'generated' && t.articleId) return false
    const task = taskFor(t)
    return !(task && (task.state === 'queued' || task.state === 'running'))
  })
  const batch = $('#topics-gen-pending')
  if (batch) {
    const disabled = !pending.length || store.topicGenProvided === false
    batch.disabled = disabled
    batch.textContent = pending.length
      ? `一键生成全部未生成（${pending.length}）`
      : '一键生成全部未生成'
    batch.dataset.pendingCount = String(pending.length)
  }

  const tb = $('#topics-tbody')
  if (!pageList.length) {
    $('#topics-empty').classList.remove('hidden')
    tb.innerHTML = ''
  } else {
    $('#topics-empty').classList.add('hidden')
    tb.innerHTML = pageList
      .map((t) => {
        // 评分展示：有分显示分值；legacy（v2 规则前无评分）降级显示"旧"，其余无分显示 —（2026-08-24 迁移）
        const sc =
          typeof t.topicScore === 'number'
            ? `<span class="score-badge ${t.topicScore >= 40 ? 'pass' : 'fail'}">${t.topicScore}</span>`
            : t.legacy
              ? '<span style="color:var(--ink-faint);font-size:11px" title="v2 评分规则前数据，无历史评分">旧</span>'
              : '<span style="color:var(--ink-faint)">—</span>'
        const linked = t.articleId
          ? `<a href="#/articles/${encodeURIComponent(t.articleId)}" class="t-article">${escapeHtml(t.articleTitle || t.articleId)}</a><div class="t-reason">${escapeHtml(t.articleStatus || '')}</div>`
          : '<span style="color:var(--ink-faint)">—</span>'
        // 落选选题可删除（仅 rejected；删除前自动备份）；generated/adopted 不可删
        const delBtn =
          t.status === 'rejected'
            ? `<button class="btn mini danger" data-del-id="${escapeHtml(t.id)}" data-del-keyword="${escapeHtml(t.keyword)}" title="删除落选选题（自动备份，不可恢复）">删除</button>`
            : ''
        const actCell =
          [delBtn].filter(Boolean).join(' ') || '<span style="color:var(--ink-faint)">—</span>'
        return `<tr data-topic-id="${escapeHtml(t.id)}">
        <td class="nowrap">${t.date || ''}</td>
        <td class="nowrap">${escapeHtml(slotName(t.slot))}</td>
        <td><b>${escapeHtml(t.keyword || '')}</b>${t.title ? `<div class="t-reason">${escapeHtml(String(t.title ?? '').slice(0, 48))}</div>` : ''}</td>
        <td>${sc}</td>
        <td>${topicStatusBadge(t)}</td>
        <td>${linked}</td>
        ${topicGenCell(t)}
        <td class="nowrap">${actCell}</td>
      </tr>`
      })
      .join('')
  }
  renderPager(
    $('#topics-pager'),
    total,
    store.topicsPage,
    (pg) => {
      store.topicsPage = pg
      renderTopics()
    },
    TOPICS_PAGE_SIZE,
  )
  applyGenerateAvailability()
}

/* ── 选题库「一键生成」状态条（2026-09-17 重构；2026-10-01 v2.111 改为汇总条）──
   状态条从"单任务详情"降级为**汇总**：逐条进度现在就近显示在表格行内
   （见 topicGenCell）。这样连点/批量入队时，界面不再"只有一条能被表示"。

   ① topicBannerView 是纯函数（状态对象 → HTML），四态结构固定；
   ② running 期间只由计时器更新时长文本；
   ③ 颜色/结构全部走 .tgen 组件族（styles.css），明暗两主题自动成立。 */

/** 状态对象 → 状态条 HTML（纯函数，无 DOM/请求依赖，便于单测） */
export function topicBannerView(st = {}) {
  const s = st.state || 'idle'
  if (s === 'idle') return ''
  const slot = slotName(st.slot) || ''
  const kw = String(st.keyword || '')
  const kwHtml = kw
    ? `<div class="tgen-meta"><span class="tgen-kw" title="${escapeHtml(kw)}">${escapeHtml(kw)}</span><span class="tgen-time" data-tgen-time>${escapeHtml(topicGenElapsed(st))}</span></div>`
    : ''
  // 内容条：footer 有内容时与 meta 同层排一行，避免多出一条空气泡
  const addBar = (footer) =>
    (footer ? `<div class="tgen-bar-slot">${footer}</div>` : '') +
    '<div class="tgen-bar"><i></i></div>'

  if (s === 'running') {
    const sub = st.sub || '正在生成（仅写草稿，不推送）'
    return `
      <div class="tgen-head">
        <span class="tgen-dot"></span>
        <span class="tgen-title">${escapeHtml(st.title || '生成中')}${slot ? ` · ${escapeHtml(slot)}` : ''}</span>
        <span class="tgen-pill">${escapeHtml(st.pill || '仅写草稿，不推送')}</span>
      </div>
      <div class="tgen-head"><span class="tgen-sub">${escapeHtml(sub)}</span></div>
      ${kwHtml}
      ${addBar('')}`
  }

  if (s === 'done') {
    const title = st.articleTitle || st.draftId || ''
    const link = st.draftId
      ? `<a href="#/articles/${encodeURIComponent(st.draftId)}">查看《${escapeHtml(title)}》</a>`
      : ''
    return `
      <div class="tgen-head">
        <span class="tgen-dot"></span>
        <span class="tgen-title">${escapeHtml(st.title || '生成完成')}${slot ? ` · ${escapeHtml(slot)}` : ''}</span>
        <span class="tgen-sub">${escapeHtml(st.sub || '草稿已进入文章列表（未推送）')}</span>
      </div>
      ${kwHtml}
      ${addBar(`<div class="tgen-actions">${link}</div>`)}`
  }

  // failed（或删除等一过性操作的结果：由调用方给 title/sub/pill/tone）
  const head = st.sub || '生成失败'
  const tail = st.logTail ? String(st.logTail).slice(0, 400) : ''
  const details = tail
    ? `<details class="tgen-details"><summary>失败日志（尾部 400 字符）</summary><pre>${escapeHtml(tail)}</pre></details>`
    : ''
  const retry =
    s === 'failed' && st.slot && st.keyword
      ? `<button class="btn mini ghost" data-tgen-retry="${escapeHtml(st.slot)}" data-tgen-kw="${escapeHtml(st.keyword)}">重试</button>`
      : ''
  return `
      <div class="tgen-head">
        <span class="tgen-dot"></span>
        <span class="tgen-title">${escapeHtml(st.title || '生成失败')}${slot ? ` · ${escapeHtml(slot)}` : ''}</span>
        <span class="tgen-sub">${escapeHtml(head)}</span>
      </div>
      ${kwHtml}
      ${addBar(`<div class="tgen-actions">${retry}</div>${details}`)}`
}

/** 逻辑状态名 → DOM 修饰类名（done/failed 对外统一表现为"完成色/失败色" ok/err） */
const BANNER_TONE = { done: 'ok', failed: 'err' }

/** 写入状态条：classList 恒为 tgen + 状态修饰；idle 隐藏（不再借用 .pstats）
 *  tone 可显式覆盖（"删除落选选题"用 tone:'accent'——一过性操作，不假装生成成功/失败） */
function renderTopicBanner(st = {}) {
  const el = $('#topics-banner')
  if (!el) return
  const state = st.state || 'idle'
  const tone = st.tone || BANNER_TONE[state] || 'accent'
  el.className = `tgen tgen--${state} tgen--${tone}${state === 'idle' ? ' hidden' : ''}`
  el.innerHTML = topicBannerView(st)
  if (state === 'running') el.setAttribute('aria-busy', 'true')
  else el.removeAttribute('aria-busy')
}

/** 失败态（前端异常 / 能力未提供 / 端点连不上 等）：沿用状态条结构，保留重试入口
 *
 * v2.42：允许调用方用 `ctx.title` / `ctx.sub` 覆盖默认文案——"当前接入项目未提供
 * 该能力"与"生成失败（exit=?）"是两回事，混在一起会让人以为功能坏了。 */
function renderTopicBannerError(msg, ctx = {}) {
  const el = $('#topics-banner')
  renderTopicBanner({
    ...ctx,
    state: 'failed',
    title: ctx.title || undefined,
    sub: ctx.sub || '启动失败',
    logTail: ctx.logTail || String(msg || ''),
  })
  if (el) el.classList.remove('hidden')
}

/** 时长文案：running 用 startedAt→now（每秒刷新），done/failed 用 startedAt→finishedAt 并带起跑时刻 */
export function topicGenElapsed(st = {}, now = Date.now()) {
  const t0 = Date.parse(st.startedAt || '')
  if (!t0) return ''
  const t1 = st.finishedAt ? Date.parse(st.finishedAt) : now
  if (!t1) return ''
  const s = Math.max(0, Math.round((t1 - t0) / 1000))
  const dur = s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
  if (st.finishedAt) return `${fmtTime(st.startedAt)} 起跑 · 用时 ${dur}`
  return `已运行 ${dur}`
}

/* ── 汇总条 + 轮询（v2.111）──────────────────────────────────────────── */

/**
 * 汇总条视图（纯函数，便于单测）：把一组任务压成一行"几个在跑、几个在排队"。
 *
 * 它刻意**不**替代行内状态——行内才是权威，汇总条只回答"整体还有多少活"，
 * 并在全部结束时给一句可点的收尾语。
 */
export function topicGenSummaryView(st = {}, now = Date.now()) {
  const tasks = Array.isArray(st.tasks) ? st.tasks : []
  if (!tasks.length) return { state: 'idle', html: '' }
  const active = tasks.filter((t) => t.state === 'queued' || t.state === 'running')
  const running = active.filter((t) => t.state === 'running')
  const queued = active.filter((t) => t.state === 'queued')
  const failed = tasks.filter((t) => t.state === 'failed')
  const done = tasks.filter((t) => t.state === 'done')
  const max = st.maxConcurrency || 1

  if (active.length) {
    const head = running[0]
    const bits = []
    bits.push(`生成中 ${running.length}${max > 1 ? `/${max}` : ''}`)
    if (queued.length) bits.push(`排队 ${queued.length}`)
    if (done.length) bits.push(`完成 ${done.length}`)
    if (failed.length) bits.push(`失败 ${failed.length}`)
    const kw = head ? String(head.keyword || '') : String((queued[0] && queued[0].keyword) || '')
    const slot = slotName((head || queued[0] || {}).slot) || ''
    return {
      state: 'running',
      html: `
      <div class="tgen-head">
        <span class="tgen-dot"></span>
        <span class="tgen-title">正在生成${slot ? ` · ${escapeHtml(slot)}` : ''}</span>
        <span class="tgen-pill">${escapeHtml(bits.join(' · '))}</span>
      </div>
      <div class="tgen-head"><span class="tgen-sub">仅写草稿，不推送 · 逐条进度见下方每一行的「操作」列</span></div>
      ${
        kw
          ? `<div class="tgen-meta"><span class="tgen-kw" title="${escapeHtml(kw)}">${escapeHtml(kw)}</span><span class="tgen-time" data-tgen-time>${escapeHtml(head ? shortElapsed(head, now) : '')}</span></div>`
          : ''
      }
      <div class="tgen-bar"><i></i></div>`,
    }
  }

  // 没有活动任务：给一句收尾（成功给链接、失败给原因）
  const last = [...tasks].sort(
    (a, b) => Date.parse(b.finishedAt || 0) - Date.parse(a.finishedAt || 0),
  )[0]
  const okN = done.length
  const failN = failed.length
  const title = failN ? `本次生成：完成 ${okN} · 失败 ${failN}` : `本次生成完成（${okN} 条）`
  const failedTask = last && last.state === 'failed' ? last : failed[0]
  const link =
    last && last.state === 'done' && last.draftId
      ? `<a href="#/articles/${encodeURIComponent(last.draftId)}">查看《${escapeHtml(last.draftId)}》</a>`
      : ''
  const retry =
    failedTask && failedTask.slot && failedTask.keyword
      ? `<button class="btn mini ghost" data-tgen-retry="${escapeHtml(failedTask.slot)}" data-tgen-kw="${escapeHtml(failedTask.keyword)}">重试最后一条失败</button>`
      : ''
  // 失败明细可展开：日志尾与错误原文是排障的唯一线索，降级成"汇总条"不能把它丢掉
  const tail = failedTask && failedTask.logTail ? String(failedTask.logTail).slice(0, 400) : ''
  const details = tail
    ? `<details class="tgen-details"><summary>失败日志（尾部 400 字符）</summary><pre>${escapeHtml(tail)}</pre></details>`
    : ''
  return {
    state: failN ? 'failed' : 'done',
    html: `
      <div class="tgen-head">
        <span class="tgen-dot"></span>
        <span class="tgen-title">${escapeHtml(title)}</span>
        <span class="tgen-sub">${escapeHtml(failedTask ? failedTask.error || '详见行内说明' : '草稿已进入文章列表（未推送）')}</span>
      </div>
      <div class="tgen-bar-slot"><div class="tgen-actions">${link}${retry}</div>${details}</div>
      <div class="tgen-bar"><i></i></div>`,
  }
}

/** 汇总条写入（tone 跟随"有失败则 err，否则 ok"） */
function renderTopicSummary(st) {
  const el = $('#topics-banner')
  if (!el) return
  const view = topicGenSummaryView(st)
  if (view.state === 'idle') {
    dismissTopicBanner()
    return
  }
  const tone = view.state === 'failed' ? 'err' : view.state === 'done' ? 'ok' : 'accent'
  el.className = `tgen tgen--${view.state} tgen--${tone}`
  el.innerHTML = view.html
  if (view.state === 'running') el.setAttribute('aria-busy', 'true')
  else el.removeAttribute('aria-busy')
}

/** 运行中：只更新时长文本（不重建整条 HTML，避免每秒重排 + 丢焦点） */
function tickTopicBannerTime(st) {
  const el = document.querySelector('#topics-banner [data-tgen-time]')
  if (!el || !el.offsetParent) return
  const running = (st.tasks || []).find((t) => t.state === 'running')
  el.textContent = running ? shortElapsed(running) : ''
}

function stopTopicBannerTick() {
  if (store.topicBannerTick) {
    clearInterval(store.topicBannerTick)
    store.topicBannerTick = null
  }
}

function startTopicBannerTick() {
  stopTopicBannerTick()
  store.topicBannerTick = setInterval(() => {
    tickTopicBannerTime({ tasks: Object.values(store.topicTasks || {}) })
  }, 1000)
}

/** 停止任务轮询（离开选题视图或全部结束时调；幂等） */
export function stopTopicsPoll() {
  if (store.topicGenPoll) {
    clearInterval(store.topicGenPoll)
    store.topicGenPoll = null
  }
  stopTopicBannerTick()
}

/**
 * 有没有"还要看着"的生成：刚入队还没落表（`topicGenPending`）、有活动任务、
 * 或本轮还没做过收尾。
 *
 * `topicGenPending` 这一条是必需的：从"点了生成"到任务真的出现在任务表里有
 * 最多 4 秒空窗，只看活动任务会在这段空窗里判"没事可看"，于是刚挂上的轮询
 * 立刻被撤掉——用户点了生成，界面从此不动（这个坑在冒烟里假红过三次）。
 */
function shouldWatchGen() {
  if (store.topicGenPending) return true
  if (hasActiveTasks()) return true
  return !store.topicGenDone
}

/**
 * 挂/停轮询。三个出入口都经过它：进入选题页、有人点了生成、轮询收尾完成。
 *
 * 之前是"没活动任务就停表"，停表之后**再也没有任何信号能让它活过来**
 * （实测：第一条失败 → 点「重试」→ 界面从此不动，只剩一个没有链接的"完成"条）。
 */
function syncTopicPoll() {
  if (!shouldWatchGen()) {
    stopTopicsPoll()
    return
  }
  if (store.topicGenPoll) return
  store.topicGenPoll = setInterval(pollTopicTasks, 4000)
  startTopicBannerTick()
}

/** 有人发起了新的生成（单条或批量）：重新开始守望（含停表之后的再次入队） */
function beginTopicGen() {
  store.topicGenPending = true
  store.topicGenDone = false
  syncTopicPoll()
}

/**
 * 轮询逐条任务（4s）。
 *
 * 节奏是"有活就继续问、没活就收尾一次再停表"：
 *   · 每轮只做一次轻量 GET + 就地 patch（`/proxy/topics` 有 138KB，队列跑几分钟，
 *     每 4 秒重拉并重建 40 行表格会把浏览器和桥一起拖慢，还会丢掉行内按钮焦点）；
 *   · 从"有活"变"没活"的那一轮做一次全量刷新（补关联文章标题、取回选题库最新状态），
 *     打上 `topicGenDone` 再停表。停表后**只有新任务入队**（`beginTopicGen`）能重启它。
 *
 * 收尾那一步只用合并（`mergeTopicTask`）而不重建映射：服务端的任务列表可能已经把
 * 刚失败的那条挤掉，重建会让"失败原因"在汇总条上闪一下就不见了。
 */
async function pollTopicTasks() {
  // 收尾那一轮包含一次全量刷新（异步），可能比 4s 间隔还久。没有这道闸，
  // 下一拍会叠进来并发读任务表，并把刚写入的终态重新渲染成中间态。
  if (store.topicGenPolling) return
  store.topicGenPolling = true
  try {
    const st = await getJSON('/proxy/topics/generate/tasks')
    applyTopicTasks(st.tasks || [])
    patchTopicRows()
    renderTopicSummary(st)
    if (hasActiveTasks()) {
      // 任务表里真的看到了活：入队的空窗结束
      store.topicGenPending = false
      startTopicBannerTick()
      return
    }
    // 本轮收尾：全量刷新一次，然后用本轮已确认的终态合并回来
    await loadTopics({ keepBanner: true })
    await loadArticles()
    for (const t of st.tasks || []) mergeTopicTask(t)
    patchTopicRows()
    renderTopicSummary(st)
    store.topicGenDone = true
    stopTopicsPoll()
  } catch {
    // 单次轮询失败（桥重启/网络抖动）不判死：下一次继续
  } finally {
    store.topicGenPolling = false
  }
}

/** 就地更新每行的生成列 + 汇总条（不重建整表） */
function patchTopicRows() {
  const rows = document.querySelectorAll('#topics-tbody [data-topic-id]')
  for (const tr of rows) {
    const id = tr.dataset.topicId
    const topic = (store.topics || []).find((t) => t.id === id)
    if (!topic) continue
    const oldCell = tr.querySelector('[data-gen-cell]')
    if (!oldCell) continue
    const wrap = document.createElement('tbody')
    wrap.innerHTML = topicGenCell(topic)
    const next = wrap.firstElementChild
    if (next) oldCell.replaceWith(next)
  }
  renderTopics()
}

/**
 * 一键生成（draft-only，恒不推送）——入队 + 就地进入「排队中/生成中」。
 *
 * v2.111：后端改为**入队即返回**（202 与任务 id），所以这里不再"先假装 running
 * 再等第一次轮询"，而是把后端给的真实任务状态画出来（可能是排队，也可能是直接开跑）。
 */
async function startTopicGenerate(slot, keyword, topicId = null, date = null) {
  const key = taskKey(slot, keyword)
  const btn = document.querySelector(
    `[data-gen-slot="${CSS.escape(slot)}"][data-gen-keyword="${CSS.escape(keyword)}"]`,
  )
  if (btn) {
    btn.disabled = true
    btn.textContent = '排队中…'
  }
  try {
    const r = await postJSON('/proxy/topics/generate', { slot, keyword, topicId, date })
    // v2.42：优先透出后端的**人类可读 message**。
    // 此前只 `throw new Error(r.error)`，于是"当前接入项目未提供「一键生成」能力"
    // 这句解释被丢掉，使用者只看到 `generate_not_provided` 这个错误码，
    // 会以为功能坏了——实际是 P0 起改由项目侧提供能力（见 doctor 的 generate-capability）。
    if (r.error) {
      const e = new Error(r.message || r.error)
      e.code = r.error
      throw e
    }
    // 把刚入队的任务立刻登记下来，随后轮询接管（首帧不用等 4 秒）
    const task = r.task || null
    if (task && task.id) {
      mergeTopicTask(task)
      patchTopicRows()
    } else {
      await loadTopics({ keepBanner: true })
    }
    // 一旦真的入队了就重新守望（可能在上一批收尾停表之后）
    beginTopicGen()
  } catch (e) {
    stopTopicBannerTick()
    // 「能力未提供」不是"生成失败"：给出可执行的说明，并提示去 doctor 看详情
    const notProvided = e && e.code === 'generate_not_provided'
    const unreachable = e && e.code === 'generate_endpoint_unreachable'
    renderTopicBannerError(String(e.message || e), {
      slot,
      keyword,
      startedAt: new Date().toISOString(),
      ...(notProvided
        ? {
            title: '「一键生成」不可用',
            sub: '当前接入项目未提供该能力（引擎不再代跑外部脚本）· 可运行 npm run doctor 查看详情',
          }
        : unreachable
          ? {
              title: '「一键生成」端点连不上',
              sub: '项目侧的生成提供者没在监听，可运行 npm run doctor 查看详情',
            }
          : { title: '「一键生成」未能排队', sub: String(e.message || e) }),
    })
    const active = store.topicTaskOf[key]
    if (!active) {
      const b = document.querySelector(
        `[data-gen-slot="${CSS.escape(slot)}"][data-gen-keyword="${CSS.escape(keyword)}"]`,
      )
      if (b) {
        b.disabled = false
        b.textContent = '一键生成'
      }
    }
  }
}

/**
 * 批量入队：把给定选题一次排进队列（走 `/generate/batch`，避免 N 个并发 POST）。
 * 引擎侧按并发上限依次开跑，所以这里只负责"排进去 + 如实报告被拒的"。
 */
async function startTopicGenerateBatch(rows) {
  const items = rows.map((t) => ({ slot: t.slot, keyword: t.keyword, topicId: t.id, date: t.date }))
  renderTopicBanner({
    state: 'running',
    title: `正在把 ${items.length} 条选题排进生成队列`,
    sub: '引擎按并发上限依次执行；逐条进度见每一行的「操作」列',
    startedAt: new Date().toISOString(),
  })
  try {
    const r = await postJSON('/proxy/topics/generate/batch', { items })
    if (r.error) throw new Error(r.message || r.error)
    applyTopicTasks(r.tasks || [])
    if (Array.isArray(r.tasks) && r.tasks.length) {
      for (const t of r.tasks) store.topicTaskOf[taskKey(t.slot, t.keyword)] = t.id
    }
    // 被拒的逐条说明（去重命中 / 队列满 / 参数不合法）——不静默吞掉
    const failures = Array.isArray(r.failures) ? r.failures : []
    await loadTopics({ keepBanner: true })
    beginTopicGen()
    if (failures.length) {
      renderTopicBannerError(
        failures
          .map((f) => `${slotName(f.slot)}/${f.keyword || '—'}：${f.message || f.error}`)
          .join('\n'),
        {
          title: `已排队 ${r.queued} 条 · ${failures.length} 条未入队`,
          sub: '未入队的原因见下方',
        },
      )
    }
  } catch (e) {
    renderTopicBannerError(String(e.message || e), {
      title: '批量入队失败',
      sub: '生成队列可能已满或端点不可用；可单条重试，或运行 npm run doctor 查看详情',
    })
  }
}

/** 取消一条任务（排队中=出队；运行中=引擎不再跟踪，项目侧可能仍在跑完） */
async function cancelTopicTask(id) {
  try {
    const r = await postJSON('/proxy/topics/generate/cancel', { id })
    if (r.error) throw new Error(r.message || r.error)
    if (r.task) {
      store.topicTasks[r.task.id] = r.task
    }
    patchTopicRows()
    syncTopicPoll()
    renderTopicSummary({ tasks: Object.values(store.topicTasks || {}) })
  } catch (e) {
    renderTopicBannerError(String(e.message || e), { title: '取消失败', sub: '' })
  }
}

/** 删除落选选题（仅 rejected；删除前 bridge 自动备份；generated/adopted 接口拒绝） */
async function deleteTopic(id, keyword) {
  const tone = { tone: 'accent', pill: '删除前自动备份' }
  renderTopicBanner({
    ...tone,
    state: 'running',
    title: '删除中',
    sub: '正在移除落选选题（备份 topic-pool.json 后生效）',
    keyword: keyword || id,
    startedAt: new Date().toISOString(),
  })
  try {
    const r = await postJSON('/proxy/topics/delete', { id, authorized: true })
    if (r.error) throw new Error(r.error)
    renderTopicBanner({
      ...tone,
      state: 'done',
      title: '已删除',
      sub: `落选选题「${(r.deleted && r.deleted.keyword) || keyword || id}」已移除（剩余 ${r.remaining} 条选题）`,
    })
    await loadTopics()
  } catch (e) {
    renderTopicBanner({
      ...tone,
      state: 'failed',
      title: '删除失败',
      sub: String(e.message || e),
    })
  }
}

/** 视图初始化：绑定选题库事件 */
export function initTopicsView() {
  $('#tf-slot').addEventListener('change', applyTopicFilters)
  $('#tf-status').addEventListener('change', applyTopicFilters)
  $('#tf-date').addEventListener('change', applyTopicFilters)
  $('#tf-q').addEventListener('input', applyTopicFilters)
  $('#topics-tbody').addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-del-id]')
    if (delBtn) {
      const id = delBtn.dataset.delId
      const keyword = delBtn.dataset.delKeyword
      if (
        !confirm(
          `删除落选选题「${keyword}」？\n\n将从选题库移除（已自动备份 topic-pool.json，备份文件在 history/backups/）。\n仅允许删除落选(rejected)选题，此操作不可撤销。`,
        )
      )
        return
      deleteTopic(id, keyword)
      return
    }
    const cancelBtn = e.target.closest('[data-gen-cancel]')
    if (cancelBtn) {
      cancelTopicTask(cancelBtn.dataset.genCancel)
      return
    }
    const btn = e.target.closest('[data-gen-slot]')
    if (!btn) return
    const slot = btn.dataset.genSlot
    const keyword = btn.dataset.genKeyword
    const date = btn.dataset.genDate
    const topicId = btn.dataset.genId
    if (
      !confirm(
        `一键生成（仅写草稿，不推送）？\n\n栏目: ${slotName(slot)}（${date}）\n选题: ${keyword}\n\n生成后草稿进入文章列表，由人工后续操作。`,
      )
    )
      return
    startTopicGenerate(slot, keyword, topicId, date)
  })
  // 批量入口：只作用于**当前筛选结果**，确认框写明条数（这是唯一会一次排很多任务的地方）
  $('#topics-gen-pending').addEventListener('click', () => {
    const n = Number($('#topics-gen-pending').dataset.pendingCount || 0)
    if (!n) return
    const rows = filteredTopics().filter((t) => {
      if (t.status === 'generated' && t.articleId) return false
      const task = taskFor(t)
      return !(task && (task.state === 'queued' || task.state === 'running'))
    })
    if (
      !confirm(
        `把当前筛选结果里的 ${rows.length} 条未生成选题排进生成队列？\n\n` +
          `引擎并发上限 ${store.topicGenMaxConcurrency || 1}，超出的会依次排队；每条都会真实消耗一次生成额度。\n` +
          `全部仅写草稿，不推送。`,
      )
    )
      return
    startTopicGenerateBatch(rows)
  })
  // 状态条上的「重试」（失败态）：用原 slot + 关键词再跑一次（恒 draft-only）。
  // 状态条在 #topics-tbody 之外，故单独委托。
  $('#topics-banner').addEventListener('click', (e) => {
    const retry = e.target.closest('[data-tgen-retry]')
    if (!retry) return
    const slot = retry.dataset.tgenRetry
    const keyword = retry.dataset.tgenKw
    if (!confirm(`重试一键生成（仅写草稿，不推送）？\n\n栏目: ${slotName(slot)}\n选题: ${keyword}`))
      return
    startTopicGenerate(slot, keyword)
  })
}
