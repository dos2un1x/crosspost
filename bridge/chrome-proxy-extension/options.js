// 扩展选项页（2026-09-12 由弹窗改名而来）：经本地桥 /proxy/platforms 获取平台登录状态并展示；
// 点扩展图标不再弹面板，而是直接打开 Console（见 sw.js 的 chrome.action.onClicked）
// 已登录 / 未登录 / **未检查** 三态分组，左右滑动切换（tab 点击 + 滑动同步）
// 连接配置（host/WS 端口）存 chrome.storage.local；HTTP API 端口自动 = WS + 1
//
// 2026-09-25：修掉「未登录 0」的假象 —— `/proxy/platforms` 只返回**勾选范围内**的平台，
// 未勾选的根本不在列表里，于是"范围内 12 个都已登录"被渲染成「未登录 0」，而全量查过之后
// 27 个里有 14 个是未登录的。分组判据见 platform-groups.mjs；「刷新状态」现在会轮询到
// 检查真正结束（后台全量查 ~10s），让"点刷新全量查"这句话兑现。
//
// 2026-09-25（v2.3.3）：页面换成 Console 的「编辑部」视觉语言（暖纸/墨/砖红 + 衬线标题 +
// 等宽数字），并补三件与本次改造直接相关的事：
//   · 顶部多一条**三态比例条**（已登录/未登录/未检查）——把 v2.3.2 修的"未检查"从措辞变成看得见的一段；
//   · 平台图标是远端 favicon，失败时行首不再留空洞：改用 platform-monogram.mjs 画字母牌；
//   · 报头连接状态拆成「标签 + 端口」两个节点（窄屏只显示端口），底栏计数进等宽徽章。
// 判据一字未改：这是纯视觉改造，`extension-options-dom.test.mjs` / `platform-groups` 的既有断言
// 一行都没改也必须全绿。
//
// 2026-09-25（v2.3.4）：把 tab 区做成**状态化**的（用户报"细化这个区域的多种状态"）。
//   · 主标签＝计数，且数字带三态色（`.seg`）：「未登录 0」红、「未检查 15」琥珀、
//     「已登录 12」绿；文字保持中性，颜色只挂在数字上。
//   · **未知画成 `–`**：一个平台都没核验过时不报「已登录 0」/「未登录 0」——
//     那是"没有数据"被画成"数据是 0"，与 v2.3.2 修掉的假象同族。
//   · 副标签＝这批数字的**可信度**（region-state.mjs 的状态机）：本轮已核验 / 复核中… /
//     3 小时前的核验 / 上次核对失败 / 扩展未连接 / 尚未核验 / 数据不可用。
//   · 顺带修一条真缺陷：`data.error`（**上一次检查**失败）此前被当成"取数失败"直接抛出，
//     于是"有一次检查没成功"会让整页清空成"无法获取平台状态"——现在按下面的
//     形状判定区分「桥取不到数」（致命）与「上次核对失败」（数字照常 + 副标签写明）。
// 用户列的四格（已登录已检查 / 已登录未检查 / 未登录已检查 / 未登录未检查）里，
// 后两格在本系统**取不到数据**：桥侧 platforms-state.json 只保留当前范围的平台
// （`pruneState()` 的注释就是"丢弃不在检查范围内的平台状态"），实测此刻只有勾选的 12 条。
// 所以未检查的登录态是**未知**，它是第三种状态，不是第四格 —— 详见 region-state.mjs 文件头。
import {
  CHECK_POLL_MS,
  CHECK_POLL_MAX_MS,
  groupPlatforms,
  scopeNoteText,
  uncheckedGroupTitle,
} from './platform-groups.mjs'
import { regionLabels, trustState } from './region-state.mjs'
import { monogramOf, toneOf } from './platform-monogram.mjs'

const $ = (id) => document.getElementById(id)
const DEFAULTS = { bridgeHost: '127.0.0.1', wsPort: 9539 }
/** 缓存周期的兜底（真值由 /proxy/status 的 platforms.cacheMs 给；这里只在老桥时用） */
const DEFAULT_CACHE_MS = 3600000
let cfg = { ...DEFAULTS }
/**
 * 桥侧的运行状态（决定 tab 副标签的可信度文案）：
 *   · reachable：本地桥能不能取到数（fetch 失败 → false）
 *   · connected：桥在跑但**浏览器扩展**没连（检查靠它代发请求，所以数字只能是上一轮的）
 *   · cacheMs：桥的检查缓存周期（超过它就是"旧账"）
 */
const bridge = { reachable: true, connected: true, cacheMs: DEFAULT_CACHE_MS }

async function loadCfg() {
  const v = await chrome.storage.local.get(['bridgeHost', 'wsPort'])
  cfg = Object.assign({}, DEFAULTS, v)
  $('cfgHost').value = cfg.bridgeHost
  $('cfgWsPort').value = cfg.wsPort
  setCfgCur()
  return cfg
}
function bridgeBase() {
  // HTTP API 端口恒 = WS + 1（run-bridge.mjs 硬编码 startProxyHttp(wsPort + 1)）
  return 'http://' + cfg.bridgeHost + ':' + (cfg.wsPort + 1)
}

// 平台 homepage 映射（与 crosspost-runtime 适配器 meta 一致；zip-download 为本地导出无网页）
const HOMEPAGES = {
  zhihu: 'https://www.zhihu.com',
  csdn: 'https://editor.csdn.net/md/',
  weixin: 'https://mp.weixin.qq.com',
  bilibili: 'https://member.bilibili.com/platform/upload/text',
  baijiahao: 'https://baijiahao.baidu.com/',
  toutiao: 'https://mp.toutiao.com/profile_v4/graphic/publish',
  xiaohongshu: 'https://creator.xiaohongshu.com',
  jianshu: 'https://www.jianshu.com',
  yidian: 'https://mp.yidianzixun.com',
  dayu: 'https://mp.dayu.com/dashboard/account/profile',
  smzdm: 'https://post.smzdm.com/tougao/',
  douban: 'https://www.douban.com/note/create',
  xueqiu: 'https://mp.xueqiu.com/writeV2',
  sohu: 'https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1',
  woshipm: 'https://www.woshipm.com',
  juejin: 'https://juejin.cn',
  weibo: 'https://card.weibo.com/article/v5/editor',
  yuque: 'https://www.yuque.com/dashboard',
  cto51: 'https://blog.51cto.com/blogger/publish',
  imooc: 'https://www.imooc.com/article',
  oschina: 'https://my.oschina.net',
  segmentfault: 'https://segmentfault.com/user/draft',
  cnblogs: 'https://www.cnblogs.com',
  'zip-download': '',
  eastmoney: 'https://mp.eastmoney.com',
  douyin: 'https://creator.douyin.com',
  netease: 'https://mp.163.com/#/article-publish',
  sohufocus: 'https://mp.focus.cn/fe/index.html#/info/draft',
}

let lastPlatforms = []
/** 平台显示名（未检查的平台只在 /proxy/platform-matrix 里有名字；查一次缓存住） */
let platformNames = {}
/** 本地 API token（bootstrap 拿一次即可） */
let token = null

function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

function itemHtml(p, i) {
  const name = p.name || platformNames[p.id] || p.id
  // 图标失败/缺失时行首不留空洞：.icon-wrap + 字母牌（CSS 在 .broken 时显形）
  const wrap =
    '<span class="icon-wrap' +
    (p.icon ? '' : ' broken') +
    '">' +
    (p.icon ? '<img class="icon" src="' + esc(p.icon) + '">' : '') +
    monoHtml(name, p.id) +
    '</span>'
  // 未登录统一显示「✗ 未登录」（不展示各平台五花八门的 error 文案）
  const statusHtml = p.isAuthenticated ? '✓ 已登录' : '✗ 未登录'
  const cls = p.isAuthenticated ? 'ok' : 'no'
  return (
    '<div class="' +
    itemClass() +
    '"' +
    itemStyle(i) +
    '>' +
    wrap +
    '<div class="info"><div class="name">' +
    esc(name) +
    '</div>' +
    (p.username ? '<div class="user">' + esc(p.username) + '</div>' : '') +
    '</div>' +
    '<span class="plat-id">' +
    esc(p.id) +
    '</span>' +
    '<span class="status ' +
    cls +
    '">' +
    statusHtml +
    '</span>' +
    '</div>'
  )
}

/** 字母牌：平台名首字（知乎→「知」、CSDN→「CS」）+ 由 id 定档的纸系底色 */
function monoHtml(name, id) {
  return (
    '<span class="icon-mono" data-tone="' +
    toneOf(id) +
    '" aria-hidden="true">' +
    esc(monogramOf(name)) +
    '</span>'
  )
}

/**
 * 首次渲染的错峰动画（`--i` 越大越晚上浮）。
 *
 * 只在**首屏**加：`load()` 之后每次轮询都会重渲染整个列表，若每轮都动画，
 * 页面会每 1.5s 整体抖一次 —— 那种"动效"是缺陷不是美感。
 */
let revealed = false
function itemClass() {
  return 'item' + (revealed ? '' : ' reveal')
}
function itemStyle(i) {
  return revealed ? '' : ' style="--i:' + Math.min(i, 12) * 8 + 'ms"'
}

/**
 * 平台图标是**远端 favicon**（`p.icon` 是 https 链接），加载失败就把它藏掉，
 * 并给行首那一格换成平台名自己的字母牌（不再留空洞）。
 *
 * ⚠️ 必须用 `addEventListener`，**不能用 `onerror="…"` 内联属性**：MV3 扩展页的 CSP 是
 * `script-src 'self'`，内联事件处理器会被直接拦掉并在控制台报 CSP 违规
 * （2026-09-25 真浏览器实测；这个坑此前一直存在，只是没人看控制台）。
 * 真浏览器冒烟的判据仍是 `img.icon` 的 computed visibility = hidden，未放宽。
 */
function bindIconFallbacks(container) {
  for (const img of container.querySelectorAll('img.icon')) {
    img.addEventListener(
      'error',
      () => {
        img.style.visibility = 'hidden'
        const wrap = img.closest('.icon-wrap')
        if (wrap) wrap.classList.add('broken')
      },
      { once: true },
    )
  }
}

/**
 * tab 主标签：**文字中性 + 数字带三态色**。
 * `已登录 12` → `已登录 <b class="seg ok">12</b>`；`未登录 0 · 未检查 15` 同理两段。
 * `–`（未知）不上色。分段之间的 ` · ` 与 platform-groups 的输出逐字一致 ——
 * 于是 `#tabOk`/`#tabNo` 的 textContent 仍等于 `loggedTabText`/`notLoggedTabText`（单测钉住）。
 */
function tabMainHtml(parts) {
  return parts
    .map((p) => {
      const m = /^(.*?)(\d+)$/.exec(p.text)
      if (!m || !p.tone || p.tone === 'none') return '<span>' + esc(p.text) + '</span>'
      return '<span>' + esc(m[1]) + '<b class="seg ' + p.tone + '">' + esc(m[2]) + '</b></span>'
    })
    .join('<span class="sep"> · </span>')
}

/** 渲染 tab 区（主标签 + 可信度副标签）；`labels` 来自 region-state.mjs 的 regionLabels() */
function renderTabs(labels) {
  const okMain = $('tabOk')
  const noMain = $('tabNo')
  const okSub = $('tabOkSub')
  const noSub = $('tabNoSub')
  // 页面可能已经被关掉/跳走（轮询的定时器还在飞）——那时 DOM 已经没了，直接放弃这次渲染。
  // 与 renderSummary 里 `if (!el) return` 同一套防御：不为了一个已经消失的页面抛异常。
  if (!okMain || !noMain || !okSub || !noSub) return
  okMain.innerHTML = tabMainHtml(labels.tabOk.parts)
  noMain.innerHTML = tabMainHtml(labels.tabNo.parts)
  okSub.textContent = labels.tabOk.sub
  okSub.className = 'tab-sub ' + labels.tabOk.subTone
  noSub.textContent = labels.tabNo.sub
  noSub.className = 'tab-sub ' + labels.tabNo.subTone
  // 两行视觉标签拆开后，无障碍读到的名字要能连起来（`已登录 12 · 本轮已核验`）
  for (const [i, t] of [labels.tabOk, labels.tabNo].entries()) {
    const el = $('tabs').children[i]
    if (el) el.setAttribute('aria-label', t.text + ' · ' + t.sub)
  }
}

function renderPane(container, items, emptyText) {
  if (!items.length) {
    container.innerHTML = '<div class="empty">' + esc(emptyText || '暂无平台') + '</div>'
    return
  }
  container.innerHTML = items.map((p, i) => itemHtml(p, i)).join('')
  bindIconFallbacks(container)
}

/**
 * 未检查的平台（未勾选，桥根本没查过它的登录态）。
 * 图标恒为**虚框字母牌**：`/proxy/platforms` 不给范围外平台的图标，而我们**不该**在这里显示
 * "已登录/未登录"——那正是这条 bug 的形态。
 */
function uncheckedItemHtml(id, i) {
  const name = platformNames[id] || id
  return (
    '<div class="' +
    itemClass() +
    '"' +
    itemStyle(i) +
    '>' +
    '<span class="icon-wrap unknown">' +
    monoHtml(name, id) +
    '</span>' +
    '<div class="info"><div class="name">' +
    esc(name) +
    '</div><div class="user">未勾选，登录态未知</div></div>' +
    '<span class="plat-id">' +
    esc(id) +
    '</span>' +
    '<span class="status unk">未检查</span>' +
    '</div>'
  )
}

/** 第二个面板：**未登录**（查过且未登录）与**未检查**（没查过）分成两组 */
function renderNotLoggedPane(g) {
  const body = $('paneNo').querySelector('.pane-body')
  const parts = []
  if (g.no.length) parts.push(g.no.map((p, i) => itemHtml(p, i)).join(''))
  if (g.uncheckedIds.length) {
    parts.push('<div class="group-title">' + esc(uncheckedGroupTitle(g)) + '</div>')
    parts.push(g.uncheckedIds.map((id, i) => uncheckedItemHtml(id, g.no.length + i)).join(''))
  }
  body.innerHTML = parts.length ? parts.join('') : '<div class="empty">暂无平台</div>'
  bindIconFallbacks(body)
}

function setActivePane(index) {
  const tabs = document.querySelectorAll('#tabs .tab')
  tabs.forEach((t, i) => {
    const on = i === index
    t.classList.toggle('active', on)
    t.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  const panes = $('panes')
  // 用 `index × clientWidth` 而不是两个 offsetLeft 相减（v2.3.3）：
  // 每个 pane 恒为容器 100% 宽，乘法无歧义；而 offsetLeft 之差依赖
  // "pane 与 .panes 同属一个 offsetParent" —— 一旦给 .panes 加 position 就会算错，
  // 那种错法只在点击 tab 时才暴露（且看起来像"点了没反应"）。
  panes.scrollTo({ left: index * panes.clientWidth, behavior: 'smooth' })
}

/** 同步 tab 高亮 + aria-selected（滑动与点击共用） */
function markActiveTab(idx) {
  document.querySelectorAll('#tabs .tab').forEach((t, i) => {
    const on = i === idx
    t.classList.toggle('active', on)
    t.setAttribute('aria-selected', on ? 'true' : 'false')
  })
}

// 滑动时同步 tab 高亮
function bindSwipeSync() {
  const panes = $('panes')
  let raf = null
  panes.addEventListener('scroll', () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = null
      markActiveTab(panes.scrollLeft > panes.clientWidth / 2 ? 1 : 0)
    })
  })
  // tab 点击 / 键盘切换（tablist 的常规键盘行为：Enter/Space 激活、左右方向键换栏）
  const tabs = [...document.querySelectorAll('#tabs .tab')]
  tabs.forEach((t, i) => {
    const go = () => setActivePane(Number(t.dataset.pane) || 0)
    t.addEventListener('click', go)
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        go()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const next = tabs.length === 2 ? 1 - i : (i + 1) % tabs.length
        setActivePane(next)
        if (tabs[next]) tabs[next].focus()
      }
    })
  })
}

// ── 顶部状态卡渲染（2026-09-12 美化）────────────────────────────────────
/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:MM / M-D HH:MM（精确时间挂在 title 上） */
function fmtAgo(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const diff = Date.now() - ts
  const hhmm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (diff < 60e3) return '刚刚'
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前'
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前'
  const isYesterday = new Date(Date.now() - 86400e3).toDateString() === d.toDateString()
  return (isYesterday ? '昨天 ' : d.getMonth() + 1 + '-' + d.getDate() + ' ') + hhmm
}

/**
 * 渲染顶部状态卡（六种状态都走这里，避免出现空白格）。
 * 与上次渲染结果合并：点「刷新状态」时只翻成"检查中…"，数字不会瞬间变回"—"（避免闪一下）。
 *
 * v2.3.3 三件视觉相关的事：
 *   · `unk`（未检查数）**必须由调用方传**，不能用 `scope.all - 已查数` 反推 ——
 *     「查过但不属勾选范围」的平台会让两者不等（`extension-platform-groups.test.mjs` 用例③）。
 *   · 未登录数 >0 时那一格才转红（一个红色的 `0` 是噪音）；有未检查时说明行转琥珀。
 *   · 三态比例条（#covBar）三段宽度 + data-* 可观测真值；拿不到范围时整条不显示。
 * @param {{ok?:number|null, no?:number|null, unk?:number|null,
 *          scope?:{count:number,all:number}|null, note?:string|null, warn?:boolean,
 *          checking?:boolean, checkedAt?:number|null, err?:string|null}} s
 */
let lastSummary = null
function renderSummary(s) {
  const st = Object.assign({}, lastSummary, s || {})
  lastSummary = st
  // 数字格：未知时用静音短占位（.unk），不要继承"已登录"的绿色
  const setVal = (id, val, unit) => {
    const el = document.getElementById(id)
    if (!el) return
    el.className = 'sum-value' + (val == null ? ' unk' : '')
    el.innerHTML = val == null ? '–' : String(val) + (unit || '')
  }
  const sc = st.scope || null
  setVal('sumOk', st.ok == null ? null : st.ok)
  setVal('sumNo', st.no == null ? null : st.no)
  setVal(
    'sumScope',
    sc ? sc.count : null,
    sc ? '<span class="sum-unit">/' + sc.all + '</span>' : '',
  )

  // 未登录格：只有 >0 才转红（cell 的 className 不被 setVal 覆写，可以安全地挂 .warn）
  const noVal = document.getElementById('sumNo')
  const noCell = noVal ? noVal.closest('.sum-cell') : null
  if (noCell) noCell.classList.toggle('warn', Number(st.no) > 0)

  const bar = document.getElementById('covBar')
  if (bar) {
    const all = sc ? sc.all : 0
    const counts = [Number(st.ok) || 0, Number(st.no) || 0, Number(st.unk) || 0]
    bar.dataset.ok = String(counts[0])
    bar.dataset.no = String(counts[1])
    bar.dataset.unk = String(counts[2])
    bar.hidden = !(all > 0 && (counts[0] || counts[1] || counts[2]))
    const pct = (n) => (all > 0 ? (n / all) * 100 : 0).toFixed(2) + '%'
    bar.style.setProperty('--ok', pct(counts[0]))
    bar.style.setProperty('--no', pct(counts[1]))
    bar.style.setProperty('--unk', pct(counts[2]))
  }

  const meta = document.getElementById('sumMeta')
  const timeEl = document.getElementById('sumTime')
  const noteEl = document.getElementById('sumNote')
  if (!meta || !timeEl || !noteEl) return
  noteEl.className = 'sum-note' + (st.warn ? ' warn' : '')

  if (st.err) {
    meta.className = 'sum-meta err'
    timeEl.textContent = '连接失败：' + st.err
    timeEl.removeAttribute('title')
    noteEl.textContent = ''
    return
  }
  meta.className = 'sum-meta'
  if (st.checking) {
    timeEl.innerHTML = '<span class="sum-spin"></span><span>检查中…</span>'
  } else if (st.checkedAt) {
    timeEl.textContent = '上次检查 ' + fmtAgo(st.checkedAt)
  } else {
    timeEl.textContent = '等待检查…'
  }
  if (st.checkedAt) timeEl.title = new Date(st.checkedAt).toLocaleString('zh-CN', { hour12: false })
  else timeEl.removeAttribute('title')
  noteEl.textContent = st.note || ''
}

/** 本地 API 读一次（token 只 bootstrap 一次；老版本桥无 bootstrap → 不带 header） */
async function apiGet(path) {
  const base = bridgeBase()
  if (token === null) {
    try {
      const bootRes = await fetch(base + '/proxy/bootstrap')
      token = (await bootRes.json()).token || ''
    } catch {
      token = '' // 老版本 bridge 无 bootstrap：无 token 请求（若桥要求 token 会 401 走错误分支）
    }
  }
  const res = await fetch(base + path, { headers: token ? { 'X-CrossPost-Token': token } : {} })
  return res.json()
}

/** 平台显示名：只有 /proxy/platform-matrix 覆盖全部 27 个（未检查的平台也在里面） */
async function ensurePlatformNames() {
  if (Object.keys(platformNames).length) return
  try {
    const m = await apiGet('/proxy/platform-matrix')
    for (const p of (m && m.platforms) || []) if (p && p.id) platformNames[p.id] = p.name || p.id
  } catch {
    /* 名字拿不到就退回 id：不阻塞主流程 */
  }
}

/** 把一次 /proxy/platforms 响应渲染出来（三态分组 + 状态卡 + tab 状态 + 两个面板） */
function renderPlatforms(data) {
  if (!document.getElementById('tabs')) return // 页面已关闭：别往不存在的 DOM 上写
  const platforms = data.platforms || []
  lastPlatforms = platforms
  const g = groupPlatforms({
    platforms,
    scope: data.scope || null,
    lastMode: data.lastMode || null,
  })
  // tab 区：主标签＝计数（数字带三态色），副标签＝这批数字的可信度。
  // 可信度来自 region-state.mjs：核验时间/是否在复核/上次是否失败/扩展是否连着/
  // 是否一个都没核过。注意 `data.error` 是**上一次检查**的失败记录（不是本次取数失败）。
  const trust = trustState({
    reachable: bridge.reachable,
    connected: bridge.connected,
    checkedAt: data.checkedAt || null,
    refreshing: !!data.refreshing,
    init: !!data.init,
    checkError: data.error || null,
    cacheMs: bridge.cacheMs,
    checked: g.coverage.checked,
    ageText: fmtAgo(data.checkedAt),
  })
  const labels = regionLabels({ groups: g, trust })
  renderTabs(labels)
  // 打开按钮计数（zip-download 为本地导出，无网页可开）：数字进等宽徽章，
  // 按钮文案因此变短 —— 320 下两个 flex:1 的按钮曾把「打开已登录平台（12）」挤到贴边。
  const openable = g.ok.filter((p) => HOMEPAGES[p.id])
  $('openCount').textContent = String(openable.length)
  // 顶部状态卡（2026-09-12）：三格统计 + 相对时间 + 检查范围说明。
  // 「检查范围」显示的是**本轮实际查到的平台数**（全量查之后就是 27/27），
  // 而不是"配置里勾了几个"——后者在"点刷新全量查"之后会把 27 个说成 12 个。
  // 未检查数由 g.uncheckedIds 给出（**不能**用 all - checked 反推，见 renderSummary 注释）。
  renderSummary({
    ok: g.ok.length,
    no: g.no.length,
    unk: g.uncheckedIds.length,
    scope: { count: g.coverage.checked, all: g.coverage.all },
    note: scopeNoteText(g),
    warn: g.uncheckedIds.length > 0,
    checking: !!(data.refreshing || data.init),
    checkedAt: data.checkedAt || null,
  })

  if (!platforms.length && !g.uncheckedIds.length) {
    $('paneOk').querySelector('.pane-body').innerHTML =
      '<div class="empty">' + esc(labels.emptyOk) + '</div>'
    $('paneNo').querySelector('.pane-body').innerHTML = '<div class="empty">暂无平台</div>'
    revealed = true // 占位态也把首屏动画用掉，避免下一次真渲染时突然抖一下
    return
  }
  renderPane($('paneOk').querySelector('.pane-body'), g.ok, labels.emptyOk)
  renderNotLoggedPane(g)
  revealed = true // 首屏错峰只做一次（轮询每 1.5s 重渲染，不能每轮都抖）
}

/**
 * 后台检查落地前一直轮询（`?refresh=1` 只触发、不等待）。
 *
 * 为什么必须轮询：不带轮询时，点「刷新状态」那一刻拿到的是**旧快照**（refreshing=true），
 * 用户看到 12 个平台的旧结果就关掉了 —— "点刷新全量查"这句话等于没兑现，
 * 而全量查只要 ~10s。这里等到 `refreshing` 落下再渲染，结果就摆在眼前。
 */
async function pollUntilSettled() {
  const t0 = Date.now()
  for (;;) {
    if (Date.now() - t0 > CHECK_POLL_MAX_MS) return
    await new Promise((r) => setTimeout(r, CHECK_POLL_MS))
    let data = null
    try {
      data = await apiGet('/proxy/platforms')
    } catch {
      return // 桥断了：保留当前画面，别把它刷成空白
    }
    if (!data || !Array.isArray(data.platforms)) return
    renderPlatforms(data)
    if (!data.refreshing && !data.init) return
  }
}

async function load(force) {
  $('paneOk').querySelector('.pane-body').innerHTML = '<div class="loading">正在检查...</div>'
  $('paneNo').querySelector('.pane-body').innerHTML = ''
  renderSummary({ checking: true })
  try {
    const status = await apiGet('/proxy/status')
    // 连接胶囊拆成「标签 + 端口」两个节点：已连接时窄屏只显示端口（真值），
    // 断连/失败时显示中文原因（那才是要读的字）。见 options.css 的宽度预算注释。
    bridge.connected = !!status.connected
    bridge.reachable = true
    // 缓存周期由桥给（config.platformsCacheMs）：tab 的副标签靠它判断"这批数字是不是旧账"
    const pmeta = (status && status.platforms) || {}
    bridge.cacheMs = Number(pmeta.cacheMs) || DEFAULT_CACHE_MS
    setConn(bridge.connected, bridge.connected ? '代理已连接' : '代理未连接')

    await ensurePlatformNames()
    // 刷新按钮强制全量重新检查（?refresh=1 → 桥侧 mode='all'，27 个平台）：
    // 立即返回旧快照并转后台，所以随后要轮询到检查结束。
    const data = await apiGet('/proxy/platforms' + (force ? '?refresh=1' : ''))
    // ⚠️ 按**响应形状**区分两类错误（v2.3.4）：
    //   · 连 `platforms` 数组都没有 → 桥没给数据（token 错、路由错、老桥），致命；
    //   · 有 `platforms` 且有 `error` → 那是**上一次检查**的失败记录，桥照样给了缓存，
    //     不该把整页清空成"无法获取平台状态"（旧行为会让"有一次检查没成功"看起来像
    //     "彻底取不到数"，把本来可信的缓存也丢掉）。交给 tab 副标签写明即可。
    if (!Array.isArray(data.platforms)) throw new Error(data.error || '响应格式异常')
    renderPlatforms(data)
    if (data.refreshing || data.init) await pollUntilSettled()
  } catch (e) {
    // 桥取不到数：数字与 tab 一起清空（**不能留着旧计数**：那正是"把旧账当现状"）
    bridge.reachable = false
    setConn(false, '连接失败')
    clearTabs('数据不可用')
    renderSummary({ err: String((e && e.message) || e), ok: null, no: null, scope: null, note: '' })
    $('paneOk').querySelector('.pane-body').innerHTML =
      '<div class="error">无法获取平台状态<small>' + esc(e.message) + '</small></div>'
  }
}

/** 把 tab 区清成"未知"（`已登录 –` / `未登录 –` + 给定的可信度副标签） */
function clearTabs(subText) {
  const labels = regionLabels({
    groups: groupPlatforms({}),
    trust: trustState({ reachable: false }),
  })
  labels.tabOk.sub = subText
  labels.tabNo.sub = subText
  renderTabs(labels)
}

/**
 * 报头连接状态（v2.3.3 拆两个节点）。
 * @param {boolean} ok 是否连着本地桥
 * @param {string} label 中文原因（连上时是「代理已连接」，窄屏下由 CSS 隐藏）
 */
function setConn(ok, label) {
  $('dot').className = ok ? 'dot on' : 'dot off'
  $('connLabel').textContent = label
  $('connPort').textContent = ok ? ':' + cfg.wsPort : ''
  const conn = $('conn')
  if (conn) conn.className = 'conn ' + (ok ? 'ok' : 'off')
}

/** 把当前 host:port 写进「连接配置」那一行的右侧（等宽，随时可对账） */
function setCfgCur() {
  const el = $('cfgCur')
  if (el) el.textContent = cfg.bridgeHost + ':' + cfg.wsPort
}

document.getElementById('refresh').addEventListener('click', () => load(true))
// 保存连接配置：写 chrome.storage.local → 通知 SW 热重连 → 用新端口刷新状态
document.getElementById('saveCfg').addEventListener('click', async () => {
  const hint = $('cfgHint')
  const host = ($('cfgHost').value || '').trim() || DEFAULTS.bridgeHost
  const wsPort = parseInt($('cfgWsPort').value, 10) || DEFAULTS.wsPort
  if (wsPort < 1 || wsPort > 65535) {
    hint.textContent = '端口需在 1-65535 之间'
    return
  }
  await chrome.storage.local.set({ bridgeHost: host, wsPort })
  await chrome.storage.local.remove('httpPort') // 清理旧版独立 HTTP 端口配置
  cfg = { bridgeHost: host, wsPort }
  setCfgCur()
  hint.textContent = '正在重连 ws://' + host + ':' + wsPort + ' ...'
  try {
    const r = await chrome.runtime.sendMessage({ type: 'reloadCfg' })
    hint.textContent =
      r && r.ok
        ? '已保存并重连 ws://' + host + ':' + wsPort
        : '已保存，但 SW 重连失败: ' + ((r && r.error) || '未知')
  } catch {
    hint.textContent = '已保存（SW 需重载扩展后生效）'
  }
  load(false)
})
// 一键打开所有已登录平台（经 chrome.tabs.create 新标签打开；zip-download 无网页跳过）
document.getElementById('openLogged').addEventListener('click', () => {
  const openable = lastPlatforms.filter((p) => p.isAuthenticated && HOMEPAGES[p.id])
  if (!openable.length) return
  for (const p of openable) {
    chrome.tabs.create({ url: HOMEPAGES[p.id], active: false })
  }
  window.close()
})
bindSwipeSync()
loadCfg().then(() => load(false))
