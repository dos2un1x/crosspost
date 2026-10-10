// 报表的时间序列计算（2026-10-10）：纯函数、无 DOM 依赖，可直接 node --test。
//
// 为什么单独一个模块：报表里的折线图与周对比都要"按天/按周把费用聚起来"，这段算术
// 一旦写进渲染函数就只能靠肉眼看图验证。抽出来之后 `tests/report-series.test.mjs`
// 能把边界（没数据的天、跨月、周的起点、无产量的周）逐条钉住。
//
// 口径：只吃 `matched && cost !== null` 的行（由调用方先过滤），**没数据的天记 0**——
// 流水线某天没产出就是 0，不是"缺失"；这与"会话没匹配上"是两回事（后者不进序列）。
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost

/** `YYYY-MM-DD`（北京时间口径由调用方的 today 决定，这里只做本地日期算术） */
function key(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `YYYY-MM-DD` → 当天 00:00 的 Date（不碰时区，纯字面量解析） */
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

/**
 * 近 N 天的每日费用（旧 → 新，含没有产出的一天）。
 *
 * @param {Array<{date:string, cost:number}>} rows 已过滤过 matched 的费用行
 * @param {{days?:number, today:string}} opts `today` 传 `YYYY-MM-DD`（报表用 `todayStr()`）
 * @returns {Array<{date:string, cost:number, n:number, label:string}>}
 */
export function dailySeries(rows, opts = {}) {
  const days = Math.max(1, Number(opts.days) || 30)
  const today = parseDay(opts.today) || new Date()
  const byDay = new Map()
  for (const r of rows || []) {
    if (!r || r.cost === null || r.cost === undefined) continue
    const k = String(r.date || '').slice(0, 10)
    if (!k) continue
    const cur = byDay.get(k) || { cost: 0, n: 0 }
    cur.cost += Number(r.cost) || 0
    cur.n++
    byDay.set(k, cur)
  }
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const k = key(d)
    const hit = byDay.get(k) || { cost: 0, n: 0 }
    out.push({ date: k, cost: hit.cost, n: hit.n, label: `${k.slice(5, 7)}-${k.slice(8, 10)}` })
  }
  return out
}

/**
 * 近 N 周的周对比（旧 → 新），每周给费用、篇数与**每篇均价**。
 *
 * 为什么用"每篇均价"而不是总额：总额受产量影响（某周多写两篇就贵），
 * 均价才回答"钱有没有花得更省"。
 *
 * @param {Array<{date:string, cost:number}>} rows
 * @param {{weeks?:number, today:string}} opts
 * @returns {Array<{start:string, end:string, cost:number, n:number, avg:number|null, delta:number|null}>}
 *   `delta` = 与**上一周**的均价差（元；上一周无数据或均价为 0 时给 null，别编比值）
 */
export function weeklyCompare(rows, opts = {}) {
  const weeks = Math.max(1, Number(opts.weeks) || 6)
  const today = parseDay(opts.today) || new Date()
  const monday = new Date(today)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)) // 周一为起点
  monday.setHours(0, 0, 0, 0)
  const byWeek = new Map()
  for (const r of rows || []) {
    if (!r || r.cost === null || r.cost === undefined) continue
    const d = parseDay(r.date)
    if (!d) continue
    const w = new Date(d)
    w.setDate(w.getDate() - ((w.getDay() + 6) % 7))
    w.setHours(0, 0, 0, 0)
    const k = key(w)
    const cur = byWeek.get(k) || { cost: 0, n: 0 }
    cur.cost += Number(r.cost) || 0
    cur.n++
    byWeek.set(k, cur)
  }
  const out = []
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(monday)
    start.setDate(start.getDate() - i * 7)
    const end = new Date(start)
    end.setDate(end.getDate() + 6)
    const hit = byWeek.get(key(start)) || { cost: 0, n: 0 }
    out.push({
      start: key(start),
      end: key(end),
      cost: hit.cost,
      n: hit.n,
      avg: hit.n ? hit.cost / hit.n : null,
      delta: null,
    })
  }
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1].avg
    const cur = out[i].avg
    out[i].delta = prev && cur !== null ? cur - prev : null
  }
  return out
}

/**
 * 折线的 SVG path（viewBox 坐标；等宽拉伸由 `preserveAspectRatio="none"` + 非缩放描边负责）。
 *
 * @param {number[]} values 纵轴值（≥0）
 * @param {{w?:number, h?:number, max?:number}} opts `max` 缺省取序列最大值（全 0 时按 1 处理）
 */
export function linePath(values, opts = {}) {
  const w = Number(opts.w) || 600
  const h = Number(opts.h) || 120
  const list = (values || []).map((v) => Number(v) || 0)
  if (!list.length) return ''
  const max = Number(opts.max) > 0 ? Number(opts.max) : Math.max(1, ...list)
  const step = list.length > 1 ? w / (list.length - 1) : 0
  return list
    .map((v, i) => {
      const x = Math.round((i * step + Number.EPSILON) * 100) / 100
      const y = Math.round((h - (v / max) * h + Number.EPSILON) * 100) / 100
      return `${i === 0 ? 'M' : 'L'}${x},${y}`
    })
    .join(' ')
}

/**
 * 栏目记分卡的排序（2026-10-10）。
 *
 * 为什么要可排序：这张表默认按产量排，而"哪个栏目有问题"要看的是**达标率/特征占比**——
 * 让读者自己一列一列扫，等于把结论藏在第 6 列。点表头即排，结论就上到第一行。
 *
 * 规则：`null`（无数据）**永远排最后**，不管升序降序——"没有数"不是"数很小"，
 * 让它冒到榜首只会误导；同值时按产量降序兜底，保证顺序稳定可复现。
 *
 * @param {Array<object>} rows 形如 `{key, total, retRate, avgCost, gRate, avgValue}`
 * @param {{key?:string, dir?:'asc'|'desc'}} [opts] `key` 缺省 `total`，`dir` 缺省 `desc`
 */
export function sortSlots(rows, opts = {}) {
  const key = opts.key || 'total'
  const dir = opts.dir === 'asc' ? 'asc' : 'desc'
  const mul = dir === 'asc' ? 1 : -1
  return [...(rows || [])].sort((a, b) => {
    const va = a ? a[key] : null
    const vb = b ? b[key] : null
    const na = va === null || va === undefined || Number.isNaN(va)
    const nb = vb === null || vb === undefined || Number.isNaN(vb)
    if (na && nb) return (b.total || 0) - (a.total || 0)
    if (na) return 1
    if (nb) return -1
    if (va === vb) return (b.total || 0) - (a.total || 0)
    return (va - vb) * mul
  })
}
