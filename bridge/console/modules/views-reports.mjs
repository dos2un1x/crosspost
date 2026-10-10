// 报表视图（2026-08-24 app.js 拆分 Phase 1；2026-10-10 改版）
//
// 口径：三库全量（文章 / 留存 / 归档，id 互斥不重复），与顶栏"共 N 篇"一致。
//
// 改版要点（旧版是六张等宽长条卡：第一屏没有结论、大片空白、成功率 12 行全 100%）：
//   · 顶部 KPI 条先给结论（本周产出与环比、今日费用、平台成功率、AI 门禁达标率、留存与待发），
//     下面才是分解图 —— 读者不必自己做完加法才知道"这周怎么样"；
//   · 产出与去向合成一条堆叠条（点得开对应的库），替代原先"状态构成"那七行；
//   · 平台成功率收成芯片（有失败的排前面），不必为 12 个 100% 付 250px 屏高；
//   · 费用：金额两位小数、token 按万缩写，并给出**今日每篇明细**（点开该篇抽屉）；
//   · 新增 AI 门禁卡（数据来自记录里的 `aiDetect` 快照，引擎在 `listCosts.meta.aiGate` 汇总）。
import { getJSON } from './api.mjs'
import { PLATFORM_NAMES } from './const.mjs'
import { slotName, slotOrderKeys } from './slot-lexicon.mjs'
import { store } from './state.mjs'
import { $, escapeHtml, escapeAttr, todayStr, mondayOf, fmtMD } from './utils.mjs'
import { refreshStats } from './views-articles.mjs'
import { openDetail } from './views-detail.mjs'
import { dailySeries, linePath, sortSlots, weeklyCompare } from './report-series.mjs'

/** 汇总三库记录（文章/留存/归档），归一化 status + 打 src 标签（id 互斥不重复） */
function allRecords() {
  const tag = (src) => (r) => ({ ...r, src })
  return [
    ...(store.articles || []).map(tag('articles')),
    ...(store.retained || []).map((r) => ({ ...r, src: 'retained', status: 'retained' })),
    ...(store.archived || []).map(tag('archive')),
  ]
}

/** 有平台推送记录的（文章+归档；留存从未真正推送故无 platforms） */
function recordsWithPlatforms() {
  return allRecords().filter((a) => a.platforms && typeof a.platforms === 'object')
}

/** 金额：一位小数以下才给三位，避免 `¥1.5941` 这种没有意义的精度 */
const money = (v) =>
  v === null || v === undefined ? '—' : v >= 0.1 ? `¥${v.toFixed(2)}` : `¥${v.toFixed(3)}`

/** 带符号的差额（环比）：固定两位小数、负号用 `−`——同一列里 `+¥0.036` 与 `+¥0.23` 混排很难扫 */
const signedMoney = (v) =>
  v === null || v === undefined ? '' : `${v <= 0 ? '−' : '+'}¥${Math.abs(v).toFixed(2)}`

/** token：按万缩写（11,497,118 → 1,150 万），不足一万才给原数 */
const tokens = (n) => {
  const v = Number(n) || 0
  return v >= 1e4 ? `${Math.round(v / 1e4).toLocaleString('zh-CN')} 万` : v.toLocaleString('zh-CN')
}

/** 需要等费用/门禁统计的格子先显示这个（别拿"未检测/未匹配"冒充"还没算完"） */
const LOADING = '<span class="c-dim">统计中…</span>'

/** 本次报表渲染的令牌：三库是后台补齐的，迟到的旧批次不得覆盖新批次 */
let reportsSeq = 0

/** `/proxy/costs` 的返回（KPI 条与两张费用卡共用；三库卡不等它） */
let costCache = null

/** 栏目记分卡的排序状态（默认按产量降序；点表头改） */
let slotSort = { key: 'total', dir: 'desc' }

// 源码：https://github.com/dos2un1x/crosspost（作者 dos2un1x）
export async function loadReports() {
  // 2026-08-31：统一由 refreshStats 并行拉三库并填 store（替代 loadArticles，避免渲染文章视图的副作用 + 空 store 竞态）。
  // 2026-09-25（容器模式）：**不再 await 三库**——先立刻画一遍（拿已有的 store），
  //   三库到货后按令牌重渲染；费用卡自己异步加载，与三库请求并行。
  const seq = ++reportsSeq
  renderReportTrio()
  renderKpi()
  // 不 await：费用卡异步，KPI 里的费用格等它回来再补
  renderReportCosts()
  refreshStats().then(() => {
    if (seq === reportsSeq) {
      renderReportTrio()
      renderKpi()
    }
  })
}

/** 近 8 周的产出计数（周一为周起点） */
function weeklySeries() {
  const all = allRecords()
  const weeklySet = all.filter((a) => a.status !== 'draft' || (a.history && a.history.length))
  const thisMonday = mondayOf(new Date())
  const weekly = []
  for (let i = 7; i >= 0; i--) {
    const m = new Date(thisMonday)
    m.setDate(m.getDate() - i * 7)
    weekly.push({ start: m, count: 0 })
  }
  for (const a of weeklySet) {
    const am = mondayOf(a.date || a.updatedAt)
    const idx = weekly.findIndex((w) => w.start.getTime() === am.getTime())
    if (idx >= 0) weekly[idx].count++
  }
  return weekly
}

/** 产出记录（口径：状态不是 draft，或已有 history —— 与每周柱状图同源） */
function outputRecords() {
  return allRecords().filter((a) => a.status !== 'draft' || (a.history && a.history.length))
}

/** `YYYY-MM-DD` 键（取文章 date，退到 updatedAt 的日期部分） */
const recordDay = (a) => a.date || String(a.updatedAt || '').slice(0, 10)

/**
 * 「上周同期」的产出数（周一 … 今天这一天的对应日）。
 *
 * 为什么不能直接比"上周整周"：今天是周内第 N 天，本周只跑了一半，
 * 拿半周去比整周只会得出"产出腰斩"这种假结论。同口径比较才说明问题。
 */
function lastWeekSameSpan() {
  const now = new Date()
  const off = (now.getDay() + 6) % 7 // 0=周一 … 6=周日
  const thisMonday = mondayOf(now)
  const lastMonday = new Date(thisMonday)
  lastMonday.setDate(lastMonday.getDate() - 7)
  const lastEnd = new Date(lastMonday)
  lastEnd.setDate(lastEnd.getDate() + off)
  const key = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const from = key(lastMonday)
  const to = key(lastEnd)
  const n = outputRecords().filter((a) => {
    const d = recordDay(a)
    return d && d >= from && d <= to
  }).length
  return { n, from, to }
}

/** 平台成功率聚合（按成功率升序：有问题的排前面；同率按总量降序） */
function platformAgg() {
  const agg = {}
  for (const a of recordsWithPlatforms()) {
    for (const [id, p] of Object.entries(a.platforms || {})) {
      if (p.status !== 'ok' && p.status !== 'fail') continue
      agg[id] = agg[id] || { id, ok: 0, fail: 0 }
      agg[id][p.status]++
    }
  }
  return Object.values(agg).sort((a, b) => {
    const ra = a.ok / (a.ok + a.fail)
    const rb = b.ok / (b.ok + b.fail)
    return ra - rb || b.ok + b.fail - (a.ok + a.fail)
  })
}

/**
 * KPI 条：六格，每格一个数 + 一句上下文。
 * 这里只做**读数与对比**，不写结论性措辞（"表现不错"这类判断留给读者）。
 */
function renderKpi() {
  const el = $('#rp-kpi')
  if (!el) return
  const tiles = []

  // ① 本周产出（与**上周同期**比：半周比整周会得出"腰斩"这种假结论）
  const weekly = weeklySeries()
  const cur = weekly[weekly.length - 1] || { count: 0 }
  const prevSpan = lastWeekSameSpan()
  const delta = cur.count - prevSpan.n
  const deltaTxt = delta === 0 ? '与上周同期持平' : `较上周同期 ${delta > 0 ? '+' : ''}${delta} 篇`
  const deltaCls = delta > 0 ? 'up' : delta < 0 ? 'down' : ''
  tiles.push({
    k: '本周产出（至今）',
    v: `${cur.count}<em>篇</em>`,
    sub: `上周同口径 ${prevSpan.n} 篇 · <span class="${deltaCls}">${deltaTxt}</span>`,
  })

  // ② 今日费用（并给近 7 日均值作参照）
  const cs = ((costCache && costCache.costs) || []).filter((c) => c.matched && c.cost !== null)
  const todayCs = cs.filter((c) => c.date === todayStr())
  const days = {}
  for (const c of cs) days[c.date || '?'] = (days[c.date || '?'] || 0) + c.cost
  const dayVals = Object.values(days)
  const avgDay = dayVals.length ? dayVals.reduce((a, b) => a + b, 0) / dayVals.length : null
  const todayCost = todayCs.reduce((a, c) => a + c.cost, 0)
  tiles.push({
    k: '今日费用',
    v: costCache ? money(todayCost) : '…',
    sub: costCache ? `${todayCs.length} 篇 · 近 7 日均 ${money(avgDay)}` : '统计中…',
  })

  // ③ 平台成功率（文章 + 归档的推送结果）
  const agg = platformAgg()
  const totalOk = agg.reduce((a, x) => a + x.ok, 0)
  const totalAll = agg.reduce((a, x) => a + x.ok + x.fail, 0)
  tiles.push({
    k: '平台成功率',
    v: totalAll ? `${Math.round((totalOk / totalAll) * 100)}<em>%</em>` : '—',
    sub: totalAll ? `${totalOk}/${totalAll} 次 · ${agg.length} 个平台` : '暂无推送记录',
  })

  // ④ AI 门禁（近 7 天）
  const gate = costCache && costCache.meta && costCache.meta.aiGate
  const g = gate ? gate.recent : null
  const rate = g && g.passRate !== null && g.passRate !== undefined ? g.passRate : null
  tiles.push({
    k: 'AI 门禁·近 7 天',
    v: rate === null ? (costCache ? '—' : '…') : `${Math.round(rate * 100)}<em>%</em>`,
    sub: g
      ? `达标 ${g.pass} · 超标 ${g.fail} · 未检测 ${g.skip}${g.unknown ? ` · 未认 ${g.unknown}` : ''}`
      : '统计中…',
  })

  // ⑤⑥ 留存 / 在库未推送（点得开对应视图）
  const retained = store.retained || []
  const low = retained.filter((r) => r.dir !== 'risk').length
  const risk = retained.filter((r) => r.dir === 'risk').length
  tiles.push({
    k: '留存待处理',
    v: `${retained.length}<em>篇</em>`,
    sub: `低分 ${low} · 风险 ${risk}`,
    goto: '#/retained',
  })
  const inLib = (store.articles || []).filter((a) => a.status === 'draft').length
  tiles.push({
    k: '在库未推送',
    v: `${inLib}<em>篇</em>`,
    sub: inLib ? '草稿箱里等着发' : '文章库为空',
    goto: '#/articles',
  })

  el.innerHTML = tiles
    .map(
      (t) =>
        `<div class="kpi-tile${t.goto ? ' clickable' : ''}"${t.goto ? ` data-goto="${t.goto}"` : ''}>
      <div class="kpi-k">${t.k}</div>
      <div class="kpi-v">${t.v}</div>
      <div class="kpi-sub">${t.sub}</div></div>`,
    )
    .join('')
  el.querySelectorAll('.kpi-tile[data-goto]').forEach((t) =>
    t.addEventListener('click', () => {
      location.hash = t.dataset.goto
    }),
  )
}

/** 三库卡片渲染（KPI 之外的分解图；三库到货后按同一段口径重画一次） */
function renderReportTrio() {
  const all = allRecords()

  // ── 每周产出量 ──
  const weekly = weeklySeries()
  const maxW = Math.max(1, ...weekly.map((w) => w.count))
  const thisMonday = mondayOf(new Date())
  const wEl = $('#rp-weekly')
  if (wEl)
    wEl.innerHTML = weekly
      .map((w) => {
        const end = new Date(w.start)
        end.setDate(end.getDate() + 6)
        const isThis = w.start.getTime() === thisMonday.getTime()
        return `<div class="rp-bar-col">
      <div class="rp-bar" style="height:${Math.round((w.count / maxW) * 100)}%" title="${fmtMD(w.start)} ~ ${fmtMD(end)} · 产出 ${w.count} 篇（文章+留存+归档）">
        <span class="cnt">${w.count}</span>
      </div>
      <span class="rp-bar-label">${isThis ? '本周' : fmtMD(w.start)}</span>
    </div>`
      })
      .join('')

  // ── 产出与去向（一条堆叠条 + 逐项说明，点得开对应的库） ──
  const archived = (store.archived || []).length
  const retainedLow = (store.retained || []).filter((r) => r.dir !== 'risk').length
  const retainedRisk = (store.retained || []).filter((r) => r.dir === 'risk').length
  const st = { published: 0, partial: 0, failed: 0, draft: 0 }
  for (const a of store.articles || []) if (st[a.status] !== undefined) st[a.status]++
  const buckets = [
    { name: '已发布', v: st.published, color: 'var(--ok)', goto: '#/articles' },
    { name: '部分成功', v: st.partial, color: 'var(--partial)', goto: '#/articles' },
    { name: '失败', v: st.failed, color: 'var(--fail)', goto: '#/articles' },
    { name: '未推送', v: st.draft, color: 'var(--skip)', goto: '#/articles' },
    { name: '已归档', v: archived, color: 'var(--paper-3)', goto: '#/archive' },
    { name: '留存·低分', v: retainedLow, color: 'var(--partial)', goto: '#/retained' },
    { name: '留存·风险', v: retainedRisk, color: 'var(--fail)', goto: '#/retained' },
  ].filter((b) => b.v > 0)
  const sum = buckets.reduce((a, b) => a + b.v, 0)
  const flowEl = $('#rp-flow')
  if (flowEl) {
    flowEl.innerHTML = sum
      ? `<div class="rp-flow-bar">${buckets
          .map(
            (b) =>
              `<span style="flex:${b.v};background:${b.color}" title="${b.name} ${b.v} 篇"></span>`,
          )
          .join('')}</div>` +
        buckets
          .map(
            (b) =>
              `<div class="rp-flow-row" data-goto="${b.goto}">
        <span class="dsw" style="background:${b.color}"></span>
        <span class="fname">${b.name}</span>
        <span class="fnum">${b.v}</span>
        <span class="fpct">${Math.round((b.v / sum) * 100)}%</span></div>`,
          )
          .join('') +
        `<div class="rp-flow-row" style="cursor:default">
        <span class="dsw" style="background:transparent"></span>
        <span class="fname" style="color:var(--ink-faint)">合计</span>
        <span class="fnum">${sum}</span><span class="fpct">100%</span></div>`
      : '<div style="color:var(--ink-faint);font-size:13px">暂无产出</div>'
    flowEl.querySelectorAll('.rp-flow-row[data-goto]').forEach((r) =>
      r.addEventListener('click', () => {
        location.hash = r.dataset.goto
      }),
    )
  }

  // ── 栏目记分卡（产量 × 留存率 × 每篇费用 × AI 门禁；2026-10-10） ──
  //
  // 为什么是一张表而不是又一组条：这两件事分开看都不难（产量卡、门禁卡各一张），
  // **交叉**才出信息 —— "贵且难过门禁"的栏目一眼跳出来，而那正是最该改的栏目。
  const slotOrder = slotOrderKeys()
  const emptySlot = () => ({ total: 0, live: 0, retained: 0, low: 0, risk: 0, archived: 0 })
  const slotC = {}
  for (const a of all) {
    const k = a.slot || 'manual'
    const s = (slotC[k] = slotC[k] || emptySlot())
    s.total++
    if (a.src === 'retained') {
      s.retained++
      if (a.dir === 'risk') s.risk++
      else s.low++
    } else if (a.src === 'archive') {
      s.archived++
    } else {
      s.live++
    }
  }
  // 每篇费用（只算能追到会话的产出；n = 有用例的篇数，避免"1 篇的特例"被当成栏目均价）
  const costBySlot = {}
  for (const c of (costCache && costCache.costs) || []) {
    if (!c.matched || c.cost === null) continue
    const k = c.slot || 'manual'
    const d = (costBySlot[k] = costBySlot[k] || { cost: 0, n: 0 })
    d.cost += c.cost
    d.n++
  }
  // AI 门禁（按栏目）
  const gate = costCache && costCache.meta && costCache.meta.aiGate
  const gateSlots = (gate && gate.all && gate.all.slots) || {}
  const extraKeys = Object.keys(slotC).filter((k) => !slotOrder.includes(k))
  const allKeys = [...slotOrder, ...extraKeys]
  // 每行先算成**扁平对象**（纯函数 sortSlots 吃的就是它）：渲染只负责排版，排序可单测
  const rowsRaw = allKeys.map((k) => {
    const s = slotC[k] || emptySlot()
    const cost = costBySlot[k]
    const g = gateSlots[k] || null
    const det = g ? (g.pass || 0) + (g.fail || 0) : 0
    return {
      key: k,
      total: s.total,
      live: s.live,
      retained: s.retained,
      low: s.low,
      risk: s.risk,
      archived: s.archived,
      retRate: s.total ? s.retained / s.total : null,
      avgCost: cost && cost.n ? cost.cost / cost.n : null,
      costN: cost ? cost.n : 0,
      pass: g ? g.pass || 0 : 0,
      detected: det,
      gRate: det ? (g.pass || 0) / det : null,
      avgValue: g && g.avgValue !== null && g.avgValue !== undefined ? g.avgValue : null,
    }
  })
  const slotRows = sortSlots(rowsRaw, slotSort)
  const slotEl = $('#rp-slots')
  const slotSub = $('#rp-slots-sub')
  if (slotSub) {
    // 三列各自的**覆盖缺口**要摆明：否则"未匹配/未检测"看起来像实现坏了，其实是数据没覆盖到
    const all = allRecords()
    const costTotal = ((costCache && costCache.costs) || []).length
    const costOk = ((costCache && costCache.costs) || []).filter(
      (c) => c.matched && c.cost !== null,
    ).length
    const detTotal = gate && gate.all ? gate.all.total : 0
    slotSub.textContent = !costCache
      ? '按栏目把产量、留存率、每篇费用与 AI 门禁交叉起来。费用与门禁统计中…（要解压会话缓存，首次约几秒）'
      : `按栏目把产量、留存率、每篇费用与 AI 门禁交叉起来：一眼看出哪个栏目最费钱、最难达标。` +
        // 这里是纯文本节点，别写 markdown 记号（`**` 会原样显示）
        `覆盖：费用可追溯 ${costOk}/${costTotal} 篇、AI 检测 ${detTotal}/${all.length} 篇 —— ` +
        `没覆盖到的格子会写「未匹配 / 未检测」并说明成因，那不是实现坏了`
  }
  if (slotEl) {
    const arrow = (k) => (slotSort.key === k ? (slotSort.dir === 'asc' ? ' ↑' : ' ↓') : '')
    const th = (k, label, cls = '') =>
      `<th class="sortable ${cls}" data-sort="${k}" title="点一下按「${label}」排序">${label}${arrow(k)}</th>`
    slotEl.innerHTML =
      `<table class="rp-table"><thead><tr>
      <th>栏目</th>
      ${th('total', '产量')}
      <th class="c-bar">在库 / 留存 / 归档</th>
      ${th('retRate', '留存率')}
      ${th('gRate', 'AI 达标')}
      ${th('avgValue', '平均 AI 特征')}
      ${th('avgCost', '每篇费用')}
    </tr></thead><tbody>` +
      slotRows
        .map((r) => {
          // 配色分档（按**绝对水平**，不按相对排名）：
          //   留存率：≤30% 绿 · 30~60% 琥珀 · >60% 红（这条线之上多半是选题/写法有系统问题）
          //   平均特征：≤25% 绿 · 25~30% 琥珀 · >30% 红（30% 是门禁阈值本身）
          const retCls = (x) => (x === null ? '' : x <= 0.3 ? '' : x <= 0.6 ? 'warn' : 'bad')
          const valCls = (v) => (v === null ? '' : v <= 0.25 ? '' : v <= 0.3 ? 'warn' : 'bad')
          const valColor = (v) =>
            v > 0.3 ? 'var(--fail)' : v > 0.25 ? 'var(--partial)' : 'var(--ok)'
          // 问题行：越过门禁线，或达标率不到一半 —— 让"该看哪几行"不用读数字
          const flag =
            (r.avgValue !== null && r.avgValue > 0.3) || (r.gRate !== null && r.gRate < 0.5)
          const seg = (n, cls) =>
            n > 0 ? `<span style="flex:${n};background:var(--${cls})" title="${n} 篇"></span>` : ''
          const stack = r.total
            ? `<span class="rp-mini">${seg(r.live, 'ok')}${seg(r.retained, 'partial')}${seg(r.archived, 'skip')}</span>`
            : '<span class="rp-mini"></span>'
          return `<!-- 注意别给 <tr> 挂 rp-row：那是旧「一行一条进度条」的 flex 行样式，会把表格行变成 flex -->
        <tr${flag ? ' class="is-flag"' : ''}>
        <td class="c-name">${escapeHtml(slotName(r.key))}${flag ? '<span class="c-flag" title="越过门禁线（平均特征 >30%）或达标率不到一半">!</span>' : ''}</td>
        <td class="c-num">${r.total}</td>
        <td class="c-bar" title="在库 ${r.live} · 留存 ${r.retained}（低分 ${r.low} / 风险 ${r.risk}） · 归档 ${r.archived}">${stack}</td>
        <td class="c-metric">${
          r.retRate === null
            ? '<span class="c-dim">未留存过</span>'
            : `<span class="rp-mini"><i class="${retCls(r.retRate)}" style="width:${Math.round(r.retRate * 100)}%"></i></span><b style="color:${r.retRate <= 0.3 ? 'var(--ok)' : r.retRate <= 0.6 ? 'var(--partial)' : 'var(--fail)'}">${Math.round(r.retRate * 100)}%</b>`
        }</td>
        <td class="c-metric">${
          !costCache
            ? LOADING
            : r.gRate === null
              ? '<span class="c-dim" title="这个栏目还没有检测记录：AI 门禁 2026-10-05 起才生效，更早的稿子没跑过；历史数据保持原样，不补检">未检测</span>'
              : `<span class="rp-mini"><i style="width:${Math.round(r.gRate * 100)}%"></i></span><b>${r.pass}/${r.detected}</b>`
        }</td>
        <td class="c-metric">${
          !costCache
            ? LOADING
            : r.avgValue === null
              ? '<span class="c-dim">—</span>'
              : `<b class="${valCls(r.avgValue)}" style="color:${valColor(r.avgValue)}" title="门禁阈值 30.0%">${(r.avgValue * 100).toFixed(1)}%</b>`
        }</td>
        <td class="c-metric">${
          !costCache
            ? LOADING
            : r.avgCost === null
              ? '<span class="c-dim" title="这些篇目的会话已不可追溯（会话文件被清理或不是本机生成的），费用无从归因">未匹配</span>'
              : `<b>${money(r.avgCost)}</b><span class="c-dim"> · ${r.costN} 篇</span>`
        }</td></tr>`
        })
        .join('') +
      `</tbody></table>` +
      // 空白格的成因写在**格子的 tooltip 里**（悬停即见），这里只留一行最短的说明——
      // 面板是给人扫的，多行解释会把表格本身挤下去。
      `<div class="gap-note">未匹配 = 会话已不在本机，费用无从归因 · 未检测 = 门禁 2026-10-05 才生效，历史不补</div>`
    slotEl.querySelectorAll('th.sortable').forEach((h) =>
      h.addEventListener('click', () => {
        const k = h.dataset.sort
        slotSort =
          slotSort.key === k
            ? { key: k, dir: slotSort.dir === 'asc' ? 'desc' : 'asc' }
            : { key: k, dir: k === 'total' ? 'desc' : 'asc' }
        renderReportTrio() // 只重画三库那几张（费用卡的数据没变）
      }),
    )
  }

  // ── 平台成功率（芯片：有失败的排前面） ──
  const agg = platformAgg()
  const pEl = $('#rp-platforms')
  const pSub = $('#rp-platforms-sub')
  const totalOk = agg.reduce((a, x) => a + x.ok, 0)
  const totalFail = agg.reduce((a, x) => a + x.fail, 0)
  if (pSub)
    pSub.textContent = agg.length
      ? `${agg.length} 个平台 · 累计 ${totalOk} 次成功 / ${totalFail} 次失败（文章 + 归档；留存未推送不计）`
      : ''
  if (pEl)
    pEl.innerHTML = agg.length
      ? agg
          .map((x) => {
            const total = x.ok + x.fail
            const rate = Math.round((x.ok / total) * 100)
            const cls = rate === 100 ? 'ok' : rate >= 80 ? '' : 'bad'
            return `<span class="chip ${cls}" title="${PLATFORM_NAMES[x.id] || x.id}：成功 ${x.ok} · 失败 ${x.fail}">${PLATFORM_NAMES[x.id] || x.id} ${rate}% <em>${x.ok}/${total}</em></span>`
          })
          .join('')
      : '<div style="color:var(--ink-faint);font-size:13px">暂无平台数据</div>'
}

/** AI 门禁卡：达标率 + 三段构成 + 平均特征占比 + 按栏目（哪个栏目最难达标） */
function renderGate() {
  const el = $('#rp-gate')
  if (!el) return
  const gate = costCache && costCache.meta && costCache.meta.aiGate
  if (!gate) {
    el.innerHTML = '<div style="color:var(--ink-faint);font-size:13px">统计中…</div>'
    return
  }
  const g = gate.recent && gate.recent.total ? gate.recent : gate.all
  const detected = g.detected || 0
  const rate = detected ? g.pass / detected : null
  const seg = (n, color, label) =>
    n > 0 ? `<span style="flex:${n};background:${color}" title="${label} ${n} 篇"></span>` : ''
  const rows = Object.entries(g.slots || {})
    .map(([k, s]) => {
      const tot = (s.pass || 0) + (s.fail || 0) + (s.skip || 0) + (s.unknown || 0)
      return { k, ...s, tot, rate: s.pass + s.fail ? s.pass / (s.pass + s.fail) : null }
    })
    .filter((r) => r.tot > 0)
    .sort(
      (a, b) => (a.rate === null ? 2 : a.rate) - (b.rate === null ? 2 : b.rate) || b.tot - a.tot,
    )
  el.innerHTML =
    `<div class="gate-head">
      <span class="gate-rate">${rate === null ? '—' : Math.round(rate * 100) + '%'}</span>
      <span class="gate-note">达标率 · 检测过 ${detected} 篇${g.skip ? `（另有 ${g.skip} 篇未检测）` : ''}</span>
    </div>` +
    `<div class="gate-bar">${seg(g.pass, 'var(--ok)', '达标')}${seg(g.fail, 'var(--fail)', '超标')}${seg(g.skip, 'var(--skip)', '未检测')}${seg(g.unknown, 'var(--paper-3)', '未认')}</div>` +
    `<div class="gate-note" style="margin-bottom:8px">达标 ${g.pass} · 超标 ${g.fail} · 未检测 ${g.skip}` +
    (g.unknown ? ` · 未认 ${g.unknown}` : '') +
    (g.avgValue !== null && g.avgValue !== undefined
      ? ` · 平均 AI 特征 <b style="color:var(--ink)">${(g.avgValue * 100).toFixed(1)}%</b>（阈值 30.0%）`
      : '') +
    `</div>` +
    `<div class="rp-list">` +
    rows
      .map((r) => {
        const w = r.rate === null ? 0 : Math.round(r.rate * 100)
        const cls = r.rate === null ? 'bad' : r.rate >= 1 ? '' : r.rate >= 0.5 ? 'warn' : 'bad'
        return `<div class="rp-row">
      <span class="rname">${escapeHtml(slotName(r.k))}</span>
      <span class="rbar" title="${escapeHtml(slotName(r.k))}：达标 ${r.pass || 0} · 超标 ${r.fail || 0}${r.skip ? ` · 未检测 ${r.skip}` : ''}"><i class="${cls}" style="width:${w}%"></i></span>
      <span class="rnum">${r.pass || 0}/${(r.pass || 0) + (r.fail || 0)}</span></div>`
      })
      .join('') +
    `</div>`
}

/** 报表：生成费用（今日合计 + 每篇明细 + 近 7 日每日） */
async function renderReportCosts() {
  try {
    const r = await getJSON('/proxy/costs').catch(() => null)
    costCache = r || null
    const all = (r && r.costs) || []
    const cs = all.filter((c) => c.matched && c.cost !== null)
    // 2026-09-11：会话格式自检提示。DSH 升级曾把会话文件/usage 位置换掉（v0 → v3），
    // 后端读不到会话 → 全部文章 matched=false → 两张卡都是"暂无数据"，但看不出原因。
    // 后端 listCosts 现在返回 meta（可见会话按代际计数 + 零 usage 会话数），这里把它变成一个
    // 只在"有文章却一篇都没匹配上"时出现的提示行。
    const meta = (r && r.meta) || null
    // 计价口径按接口渲染（2026-09-25）：峰谷时段是引擎的事实（token-cost.mjs 的 PRICING），
    // 这里只写"读者会追问的那两件事"：算的是哪些产出、为什么同样字数花的钱不同。
    const sub = $('#rp-cost-sub')
    if (sub) {
      const p = meta && meta.pricing
      const peak = Array.isArray(p && p.peakHours)
        ? p.peakHours.map(([a, b]) => `${a}-${b} 时`).join('、')
        : ''
      sub.textContent = p
        ? '统计今日全量产出费用（文章 + 留存 + 归档）。只算能追到会话的产出' +
          (peak ? `；单价随峰谷时段变化（高峰 ${peak}，周末全天低谷）` : '')
        : sub.textContent
    }
    const genText =
      meta && meta.byGen
        ? Object.entries(meta.byGen)
            .map(([g, n]) => `v${g}×${n}`)
            .join(' / ')
        : ''
    const formatHint =
      all.length && !cs.length && meta && meta.sessions
        ? `<div class="cost-sub">已扫描 ${meta.sessions} 个会话（${genText}）但 0 篇匹配到费用` +
          `${meta.zeroUsageCount ? `，其中 ${meta.zeroUsageCount} 个会话未解析出 usage` : ''}` +
          `；若刚升级过 DSH，多半是会话格式又变了</div>`
        : ''

    // ── 今日费用 + 每篇明细 ──
    const todayCs = cs.filter((c) => c.date === todayStr())
    const artEl = $('#rp-cost-articles')
    if (todayCs.length) {
      const total = todayCs.reduce((a, c) => a + c.cost, 0)
      const totalTokens = todayCs.reduce((a, c) => a + (c.tokens ? c.tokens.total : 0), 0)
      const hiddenTokens = todayCs.reduce((a, c) => a + (c.tokens ? c.tokens.hidden || 0 : 0), 0)
      const bySlot = {}
      for (const c of todayCs)
        bySlot[c.slot || 'manual'] = (bySlot[c.slot || 'manual'] || 0) + c.cost
      const maxC = Math.max(0.001, ...Object.values(bySlot))
      const cEl = $('#rp-cost')
      if (cEl)
        cEl.innerHTML =
          `<div class="cost-summary">合计 <b>${money(total)}</b> · ${tokens(totalTokens)} tokens · ${todayCs.length} 篇</div>` +
          (hiddenTokens
            ? `<div class="cost-sub">其中隐藏调用估算（web 搜索/标题）${tokens(hiddenTokens)} tokens</div>`
            : '') +
          Object.entries(bySlot)
            .sort((a, b) => b[1] - a[1])
            .map(
              ([k, v]) =>
                `<div class="rp-row">
            <span class="rname">${escapeHtml(slotName(k))}</span>
            <span class="rbar"><i style="width:${Math.round((v / maxC) * 100)}%"></i></span>
            <span class="rnum">${money(v)}</span></div>`,
            )
            .join('')
      // 每篇明细：贵在前；点开该篇抽屉（在库的走普通抽屉，归档/留存的走只读抽屉）
      if (artEl) {
        const drafts = new Set((store.articles || []).map((a) => a.id))
        artEl.innerHTML =
          `<div class="cost-sub" style="margin-bottom:2px">按费用排序 · 点开看该篇记录</div>` +
          [...todayCs]
            .sort((a, b) => b.cost - a.cost)
            .map(
              (c) =>
                `<div class="rp-art" data-id="${escapeAttr(c.id)}" title="${escapeAttr(c.title || c.id)} · ${money(c.cost)} · ${tokens(c.tokens ? c.tokens.total : 0)} tokens">
          <span class="rp-art-title">${escapeHtml(c.title || c.id)}</span>
          <span class="rp-art-slot">${escapeHtml(slotName(c.slot) || '')}</span>
          <span class="rp-art-tok">${tokens(c.tokens ? c.tokens.total : 0)}</span>
          <span class="rp-art-cost">${money(c.cost)}</span></div>`,
            )
            .join('')
        artEl
          .querySelectorAll('.rp-art')
          .forEach((row) =>
            row.addEventListener('click', () =>
              openDetail(row.dataset.id, { readOnly: !drafts.has(row.dataset.id) }),
            ),
          )
      }
    } else {
      const cEl = $('#rp-cost')
      if (cEl)
        cEl.innerHTML =
          '<div style="color:var(--ink-faint);font-size:13px">今日暂无可追溯费用数据</div>' +
          formatHint
      if (artEl) artEl.innerHTML = ''
    }

    // ── 费用趋势：近 30 天折线 + 近 6 周每篇均价 ──
    const dailyEl = $('#rp-cost-daily')
    const trendEl = $('#rp-trend')
    if (!cs.length) {
      if (trendEl)
        trendEl.innerHTML =
          '<span style="color:var(--ink-faint);font-size:13px">暂无可追溯会话的费用数据</span>'
      if (dailyEl) dailyEl.innerHTML = formatHint
      renderGate()
      renderKpi()
      renderReportTrio()
      return
    }
    // 折线：30 天每天一个点（没产出的天记 0）
    const series = dailySeries(cs, { days: 30, today: todayStr() })
    const vals = series.map((d) => d.cost)
    const total30 = vals.reduce((a, b) => a + b, 0)
    const n30 = series.reduce((a, d) => a + d.n, 0)
    const maxDay = Math.max(...vals)
    const avg = total30 / series.length
    const peak = series.reduce((a, d) => (d.cost > a.cost ? d : a), series[0] || { cost: 0 })
    if (trendEl) {
      // 纵轴：0 → 峰值（虚线 = 30 天日均，用来读"哪天明显偏高"）
      const W = 600
      const H = 120
      const path = linePath(vals, { w: W, h: H, max: maxDay })
      const area = path ? `${path} L${W},${H} L0,${H} Z` : ''
      const yAvg = maxDay > 0 ? H - (avg / maxDay) * H : H
      const dots = series
        .map((d, i) => {
          if (!d.n) return ''
          const x = series.length > 1 ? Math.round(i * (W / (series.length - 1)) * 100) / 100 : 0
          const y = maxDay > 0 ? Math.round((H - (d.cost / maxDay) * H) * 100) / 100 : H
          return `<circle class="tr-dot" cx="${x}" cy="${y}" r="2" vector-effect="non-scaling-stroke"><title>${d.date} · ${money(d.cost)} · ${d.n} 篇</title></circle>`
        })
        .join('')
      trendEl.innerHTML =
        `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="近 30 天每日费用折线">` +
        `<line class="tr-grid" x1="0" y1="${H}" x2="${W}" y2="${H}"></line>` +
        `<line class="tr-avg" x1="0" y1="${yAvg}" x2="${W}" y2="${yAvg}"></line>` +
        (area ? `<path class="tr-area" d="${area}"></path>` : '') +
        (path ? `<path class="tr-line" d="${path}"></path>` : '') +
        dots +
        `</svg>` +
        `<div class="rp-trend-axis"><span>${series[0] ? series[0].label : ''}</span><span>${series[series.length - 1] ? series[series.length - 1].label : ''}</span></div>` +
        `<div class="rp-trend-legend">近 30 天合计 <b>${money(total30)}</b> · 日均 ${money(avg)} · ${n30} 篇` +
        `<span class="sw"></span>日均线 · 峰值 ${peak.date ? `${peak.date.slice(5)} ${money(peak.cost)}` : '—'}</div>`
    }
    // 周对比：每篇均价（总额受产量影响，均价才回答"省没省"）
    const weeks = weeklyCompare(cs, { weeks: 6, today: todayStr() })
    if (dailyEl)
      dailyEl.innerHTML =
        `<div class="cost-sub" style="margin:6px 0 2px">近 6 周 · 每篇均价（周一起算；环比只与上周比，上周没数据就不给）</div>` +
        weeks
          .map((w) => {
            const maxAvg = Math.max(0.001, ...weeks.map((x) => x.avg || 0))
            const isThis = w.start === weeks[weeks.length - 1].start
            const delta =
              w.delta === null
                ? '<span class="c-dim">—</span>'
                : `<span style="color:${w.delta <= 0 ? 'var(--ok)' : 'var(--fail)'}">${signedMoney(w.delta)}</span>`
            return `<div class="rp-row">
            <span class="rname" style="min-width:148px">${w.start.slice(5)} ~ ${w.end.slice(5)}${isThis ? ' <em style="color:var(--accent,#b4432f);font-style:normal">(本周)</em>' : ''}<em style="color:var(--ink-faint);font-style:normal"> · ${w.n} 篇</em></span>
            <span class="rbar" title="${w.start} ~ ${w.end}：${money(w.cost)} · ${w.n} 篇 · 每篇均 ${w.avg === null ? '—' : money(w.avg)}"><i style="width:${w.avg === null ? 0 : Math.round((w.avg / maxAvg) * 100)}%"></i></span>
            <span class="rnum">${w.avg === null ? '<span class="c-dim">无产出</span>' : money(w.avg)}</span>
            <span class="rnum" style="min-width:64px">${delta}</span></div>`
          })
          .join('')
    renderGate()
    renderKpi()
    // 记分卡读的也是费用与门禁（costBySlot / gateSlots），**必须在这里一起重画**：
    // 它原先只在"三库到货"时重画，而三库常比费用先到 —— 那份"未检测/未匹配"就此定格，
    // 直到用户手动刷新页面（实测：t=2.5s 费用卡已有数、记分卡仍是空）。
    renderReportTrio()
  } catch {
    const cEl = $('#rp-cost')
    if (cEl)
      cEl.innerHTML = '<div style="color:var(--ink-faint);font-size:13px">费用数据加载失败</div>'
  }
}
