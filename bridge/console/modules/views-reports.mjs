// 报表视图（2026-08-24 app.js 拆分 Phase 1）
// 2026-08-31 口径修正：报表纳入三库全量（文章/留存/归档），不再只看文章库。
import { getJSON } from './api.mjs'
import { PLATFORM_NAMES } from './const.mjs'
import { slotName, slotOrderKeys } from './slot-lexicon.mjs'
import { store } from './state.mjs'
import { $, escapeHtml, escapeAttr, todayStr, mondayOf, fmtMD } from './utils.mjs'
import { refreshStats } from './views-articles.mjs'

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

/** 本次报表渲染的令牌：三库是后台补齐的，迟到的旧批次不得覆盖新批次 */
let reportsSeq = 0

export async function loadReports() {
  // 2026-08-31：统一由 refreshStats 并行拉三库并填 store（替代 loadArticles，避免渲染文章视图的副作用 + 空 store 竞态）。
  // 2026-09-25（2026-09-25 容器模式）：**不再 await 三库**。容器里三库要走 Docker Desktop 的
  //   bind mount（每篇记录一次跨挂载读），用户体感就是"报表要等两拍"。改成：
  //   ① 立刻画一遍（拿到已有的 store，首屏不等三库）；
  //   ② /proxy/costs 费用卡与三库请求**并行**发出（原先串在 refreshStats 后面）；
  //   ③ 三库到货后按令牌重渲染一次（口径与改动前逐字一致，只是晚一拍）。
  const seq = ++reportsSeq
  renderReportTrio()
  // 不 await：费用卡自己异步加载，且这三个请求与三库请求同时发出
  renderReportCosts()
  refreshStats().then(() => {
    if (seq === reportsSeq) renderReportTrio()
  })
}

/** 三库卡片渲染（周产出量 / 平台成功率 / 状态构成 / 栏目产量）。
 *  2026-09-25 抽成函数：三库是后台补齐的，到货后要能用**同一段口径**重画一次。 */
function renderReportTrio() {
  const all = allRecords()

  // 周产出量（近 8 周，周一为周起点；标签=周起始日，tooltip=完整范围，当前周标"本周"）
  // 2026-08-31：统计全库（文章/留存/归档），留存/归档 status≠draft 亦计入 → 标题改为「每周产出量」
  const weeklySet = all.filter((a) => a.status !== 'draft' || (a.history && a.history.length))
  const now = new Date()
  const thisMonday = mondayOf(now)
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
  const maxW = Math.max(1, ...weekly.map((w) => w.count))
  $('#rp-weekly').innerHTML = weekly
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

  // 平台成功率（文章+归档；留存无平台数据，不计入）
  const agg = {}
  for (const a of recordsWithPlatforms()) {
    for (const [id, p] of Object.entries(a.platforms || {})) {
      if (p.status !== 'ok' && p.status !== 'fail') continue
      agg[id] = agg[id] || { ok: 0, fail: 0 }
      agg[id][p.status]++
    }
  }
  const rows = Object.entries(agg).sort(
    (a, b) => b[1].ok / (b[1].ok + b[1].fail) - a[1].ok / (a[1].ok + a[1].fail),
  )
  $('#rp-platforms').innerHTML = rows.length
    ? rows
        .map(([id, s]) => {
          const total = s.ok + s.fail
          const rate = Math.round((s.ok / total) * 100)
          const cls = rate === 100 ? '' : rate >= 80 ? 'warn' : 'bad'
          return `<div class="rp-row">
      <span class="rname">${PLATFORM_NAMES[id] || id}</span>
      <span class="rbar"><i class="${cls}" style="width:${rate}%"></i></span>
      <span class="rnum">${s.ok}/${total} · ${rate}%</span></div>`
        })
        .join('')
    : '<div style="color:var(--ink-faint);font-size:13px">暂无平台数据</div><div style="color:var(--ink-faint);font-size:11px;margin-top:6px">留存库文章未推送，不计入平台成功率</div>'

  // 栏目产量（全库三库）：2026-09-12 起按栏目**区分「留存」与「归档」**
  // 口径：产量 = 三库合计（文章+留存+归档，id 互斥不重复，与顶栏"共 N 篇"一致）；
  //       留存 = drafts/rejected（低分）+ drafts/risk（高风险）；归档 = drafts/archive/。
  //       7 个类型恒列出（无产出显示 0，便于横向比较），按产量降序、同产按定义顺序。
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
      s.live++ // 文章库（在库、未留存未归档）
    }
  }
  // 7 个已定义类型恒列出（无产出显示 0）；数据里出现的新栏目（未来新增类型）追加在后，绝不丢数
  const extraKeys = Object.keys(slotC).filter((k) => !slotOrder.includes(k))
  const allKeys = [...slotOrder, ...extraKeys]
  const slotRows = allKeys
    .map((k) => [k, slotC[k] || emptySlot()])
    .sort((a, b) => b[1].total - a[1].total || allKeys.indexOf(a[0]) - allKeys.indexOf(b[0]))
  const maxS = Math.max(1, ...slotRows.map(([, s]) => s.total))
  $('#rp-slots').innerHTML = slotRows
    .map(([k, s]) => {
      const pct = Math.round((s.total / maxS) * 100)
      const seg = (n, cls) => (n > 0 ? `<span class="seg ${cls}" style="flex:${n}"></span>` : '')
      const zero = (n) => (n ? '' : ' zero')
      // 无产量的栏目不画条（避免 min-width 造成的 2px 假条）
      const fill = s.total
        ? `<span class="fill" style="width:${pct}%">${seg(s.live, 'live')}${seg(s.retained, 'ret')}${seg(s.archived, 'arc')}</span>`
        : ''
      return `<div class="rp-row rp-row-slot">
      <span class="rname">${escapeHtml(slotName(k))}</span>
      <span class="rbar rbar-stack" title="${escapeAttr(slotName(k))}：在库 ${s.live} · 留存 ${s.retained}（低分 ${s.low} / 风险 ${s.risk}） · 归档 ${s.archived} · 合计 ${s.total}">${fill}</span>
      <span class="rnum">${s.total} 篇</span>
      <span class="rsplit">
        <span class="rs rs-ret${zero(s.retained)}" title="留存（drafts/rejected 低分 ${s.low} · drafts/risk 风险 ${s.risk}）">留存 ${s.retained}</span>
        <span class="rs rs-arc${zero(s.archived)}" title="已归档（drafts/archive/）">归档 ${s.archived}</span>
      </span></div>`
    })
    .join('')

  // 状态构成（文章按状态；归档/留存单独分桶）
  const st = { published: 0, partial: 0, failed: 0, draft: 0 }
  for (const a of all) {
    if (a.src !== 'articles') continue // 归档/留存单独桶
    if (st[a.status] !== undefined) st[a.status]++
  }
  const archived = (store.archived || []).length
  const retainedLow = (store.retained || []).filter((r) => r.dir === 'rejected').length
  const retainedRisk = (store.retained || []).filter((r) => r.dir === 'risk').length
  const buckets = [
    { k: 'published', name: '已发布', v: st.published, color: 'var(--ok)' },
    { k: 'partial', name: '部分成功', v: st.partial, color: 'var(--partial)' },
    { k: 'failed', name: '失败', v: st.failed, color: 'var(--fail)' },
    { k: 'draft', name: '未推送', v: st.draft, color: 'var(--skip)' },
    { k: 'archived', name: '已归档', v: archived, color: 'var(--paper-3)' },
    { k: 'rejected', name: '留存·低分', v: retainedLow, color: 'var(--partial)' },
    { k: 'risk', name: '留存·风险', v: retainedRisk, color: 'var(--fail)' },
  ]
  const maxSt = Math.max(1, ...buckets.map((b) => b.v))
  $('#rp-status').innerHTML = buckets
    .map(
      (b) =>
        `<div class="donut-row">
      <span class="dsw" style="background:${b.color}"></span>
      <span class="dname">${b.name}</span>
      <span class="rp-row" style="flex:1;margin:0"><span class="rbar"><i style="width:${Math.round((b.v / maxSt) * 100)}%;background:${b.color}"></i></span></span>
      <span class="dnum">${b.v}</span></div>`,
    )
    .join('')
}

/** 报表：生成费用（按栏目汇总 + 近 7 日每日费用） */
async function renderReportCosts() {
  try {
    const r = await getJSON('/proxy/costs').catch(() => null)
    const all = (r && r.costs) || []
    const cs = all.filter((c) => c.matched && c.cost !== null)
    // 2026-09-11：会话格式自检提示。DSH 升级曾把会话文件/usage 位置换掉（v0 → v3），
    // 后端读不到会话 → 全部文章 matched=false → 两张卡都是"暂无数据"，但看不出原因。
    // 后端 listCosts 现在返回 meta（可见会话按代际计数 + 零 usage 会话数），这里把它变成一个
    // 只在"有文章却一篇都没匹配上"时出现的提示行。
    const meta = (r && r.meta) || null
    // 计价口径按接口渲染（2026-09-25）：型号/价格表版本/峰谷规则都是引擎的事实
    // （`token-cost.mjs` 的 `PRICING`）。这里**不再自己写型号**——副本会漂，而且改前
    // 那句"按 DeepSeek deepseek-v4-flash 官方价"还漏了"按峰谷计价"。
    const sub = $('#rp-cost-sub')
    if (sub) {
      const p = meta && meta.pricing
      const peak = Array.isArray(p && p.peakHours)
        ? p.peakHours.map(([a, b]) => `${a}-${b} 时`).join('、')
        : ''
      sub.textContent = p
        ? `统计今日全量产出费用（文章 + 留存 + 归档）。按 ${p.model} 价格表` +
          `${p.version ? `（${p.version} 版` : '（'}` +
          `${peak ? ` · 高峰 ${peak}` : ''}${p.weekendIdleFrom ? ` · 周末 ${p.weekendIdleFrom} 起全天低谷` : ''}）` +
          ` × 会话 usage 事件逐 step 计费（仅可追溯会话）`
        : sub.textContent // 旧桥没有 pricing → 保留中性兜底文案（宁缺不假）
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
    // 左卡：今日费用（当天文章，含留存/归档——它们有 date 字段）
    const todayCs = cs.filter((c) => c.date === todayStr())
    if (todayCs.length) {
      const total = todayCs.reduce((a, c) => a + c.cost, 0)
      const totalTokens = todayCs.reduce((a, c) => a + (c.tokens ? c.tokens.total : 0), 0)
      const hiddenTokens = todayCs.reduce((a, c) => a + (c.tokens ? c.tokens.hidden || 0 : 0), 0)
      const bySlot = {}
      for (const c of todayCs)
        bySlot[c.slot || 'manual'] = (bySlot[c.slot || 'manual'] || 0) + c.cost
      const maxC = Math.max(0.001, ...Object.values(bySlot))
      $('#rp-cost').innerHTML =
        `<div class="cost-summary">合计 <b>¥${total.toFixed(4)}</b> · ${totalTokens.toLocaleString('zh-CN')} tokens · ${todayCs.length} 篇</div>` +
        (hiddenTokens
          ? `<div class="cost-sub">其中隐藏调用估算（web 搜索/标题）${hiddenTokens.toLocaleString('zh-CN')} tokens</div>`
          : '') +
        Object.entries(bySlot)
          .sort((a, b) => b[1] - a[1])
          .map(
            ([k, v]) =>
              `<div class="rp-row">
            <span class="rname">${escapeHtml(slotName(k))}</span>
            <span class="rbar"><i style="width:${Math.round((v / maxC) * 100)}%"></i></span>
            <span class="rnum">¥${v.toFixed(4)}</span></div>`,
          )
          .join('')
    } else {
      $('#rp-cost').innerHTML =
        '<div style="color:var(--ink-faint);font-size:13px">今日暂无可追溯费用数据</div>' +
        formatHint
    }
    // 右卡：近 7 日（全量数据，各天独立，不因左卡空而中断）
    if (!cs.length) {
      $('#rp-cost-daily').innerHTML =
        '<div style="color:var(--ink-faint);font-size:13px">暂无可追溯会话的费用数据</div>' +
        formatHint
      return
    }
    const days = {}
    for (const c of cs) days[c.date || '?'] = (days[c.date || '?'] || 0) + c.cost
    const dayList = Object.entries(days)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 7)
    const maxD = Math.max(0.001, ...dayList.map(([, v]) => v))
    $('#rp-cost-daily').innerHTML = dayList.length
      ? dayList
          .map(
            ([d, v]) =>
              `<div class="rp-row">
            <span class="rname">${d}${d === todayStr() ? ' <em style="color:var(--accent,#b4432f);font-style:normal">(今天)</em>' : ''}</span>
            <span class="rbar"><i style="width:${Math.round((v / maxD) * 100)}%"></i></span>
            <span class="rnum">¥${v.toFixed(4)}</span></div>`,
          )
          .join('')
      : '<div style="color:var(--ink-faint);font-size:13px">暂无数据</div>'
  } catch {
    $('#rp-cost').innerHTML =
      '<div style="color:var(--ink-faint);font-size:13px">费用数据加载失败</div>'
  }
}

/** 视图初始化：绑定报表事件 */
export function initReportsView() {
  $('#rp-refresh').addEventListener('click', loadReports)
}
