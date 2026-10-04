/**
 * CrossPost Bridge — 迷你代理扩展 Service Worker
 *
 * 职责：
 *  1. WS 客户端连接本地桥（默认 ws://127.0.0.1:9539），处理：
 *     - proxyFetch: 用浏览器本体 fetch(credentials:'include') 代发平台请求，
 *       DNR 临时注入 Origin/Referer（与官方扩展同机制）
 *     - getAllCookies: 读指定域全部 cookie（含 HttpOnly），供 bilibili CSRF 等使用
 *     - ping
 *  2. alarm 保活（30s，防 MV3 SW 回收断 WS）
 *
 * 2026-09-18（v2.04）注释更正：此前文件头声明的 `exportCookies` 与
 * 「每 10 分钟自动导出 Cookie → POST /import-cookies」在实现中并不存在
 * （dispatch 实际注册的是 `getAllCookies`，桥也没有 /import-cookies 路由）。
 * 注释与实际行为不符会在排障时把人引向死路，故按实现更正。
 *
 * 配置存 chrome.storage.local：{ bridgeHost, wsPort, httpPort, token }
 */

const DEFAULT_CFG = { bridgeHost: '127.0.0.1', wsPort: 9539, token: '' }

let cfg = { ...DEFAULT_CFG }
let ws = null
let reconnectTimer = null

// ===== 配置加载 =====
function loadCfg() {
  return chrome.storage.local.get(['bridgeHost', 'wsPort', 'token']).then((v) => {
    cfg = Object.assign({}, DEFAULT_CFG, v)
    return cfg
  })
}

// 选项页保存连接配置后热重载：重新读 storage + 断开重连（无需重载扩展）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'reloadCfg') {
    loadCfg()
      .then(() => {
        if (ws) {
          try {
            ws.close()
          } catch {}
          ws = null
        }
        clearReconnect()
        connect()
        sendResponse({ ok: true, cfg })
      })
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
    return true
  }
})

loadCfg().then(() => {
  ensureClientId()
  connect()
})

/* ── 点扩展图标 → 打开 Console（2026-09-12 方案 D）────────────────────────
 * 原先图标弹出 320px 面板（popup.html）展示平台登录状态；现在状态面板统一在 Console，
 * 图标直接打开 Console 平台状态页（HTTP 端口恒 = WS + 1，与 run-bridge.mjs 的
 * startProxyHttp(wsPort + 1) 同一约定）。已开着 Console 时聚焦那个标签页，不重复开。
 * 注意：action.onClicked 只有在 manifest 里没有 default_popup 时才会触发。
 * 连接配置（bridgeHost / wsPort / token）仍在扩展选项页：chrome://extensions → 本扩展 → 扩展程序选项。 */
function consoleUrl() {
  return `http://${cfg.bridgeHost}:${cfg.wsPort + 1}/`
}
chrome.action.onClicked.addListener(async () => {
  const url = consoleUrl()
  try {
    const tabs = await chrome.tabs.query({ url: url + '*' })
    const hit = tabs && tabs[0]
    if (hit && typeof hit.id === 'number') {
      await chrome.tabs.update(hit.id, { active: true })
      if (typeof hit.windowId === 'number') {
        await chrome.windows.update(hit.windowId, { focused: true }).catch(() => {})
      }
      return
    }
  } catch {
    /* 查询失败（权限/窗口异常）→ 直接新开一个标签页 */
  }
  chrome.tabs.create({ url })
})

// ===== WS 客户端 =====
/* ── 代理来源身份（2026-09-12）─────────────────────────────────────────
 * 真实故障：面板开在 Google Chrome，而代理扩展运行在 360Chrome → 桥拿 B 浏览器的
 * Cookie 去查「你在 A 浏览器登录的平台」，4 个平台永远失败，界面上看不出任何线索。
 * 这里上报一个**每个浏览器用户目录各自稳定**的 clientId（首次运行生成后存
 * chrome.storage.local；两个浏览器各有自己的 storage，因此天然可区分）+ UA + 版本，
 * 桥侧据此记录来源、并在来源切换时告警。 */
let clientId = ''
async function ensureClientId() {
  if (clientId) return clientId
  try {
    const v = await chrome.storage.local.get(['clientId'])
    if (v && v.clientId) {
      clientId = String(v.clientId)
    } else {
      clientId = (
        'c' +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 8) +
        (self.crypto && self.crypto.randomUUID ? self.crypto.randomUUID().slice(0, 6) : '')
      ).slice(0, 12)
      await chrome.storage.local.set({ clientId })
    }
  } catch {
    /* storage 不可用（极少见）→ 退化为空 id，桥侧只记 UA */
  }
  return clientId
}

/** 心跳/连接状态推送（2026-09-11）：无 id 的消息，桥侧按 proxy-status 处理。
 *  时机：连接建立 + 每次保活 alarm（30s）+ 断开前尽力推送。
 *  桥侧以「距最近心跳是否超阈值」判定在线，覆盖 close 推送送不达（SW 被回收）的情况。 */
function pushStatus(connected) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'proxy-status',
          connected: !!connected,
          at: Date.now(),
          // 2026-09-12：身份三件套（桥侧记入 /proxy/status.ext.client 并在切换时告警）
          clientId: clientId || null,
          ua: typeof navigator !== 'undefined' ? navigator.userAgent : null,
          version:
            chrome.runtime && chrome.runtime.getManifest
              ? chrome.runtime.getManifest().version
              : null,
        }),
      )
    }
  } catch {
    /* 推送失败不影响主流程 */
  }
}

/* ── 与桥之间的 WS 信封层 ─────────────────────────────────────────────
 * connect / clearReconnect / scheduleReconnect 管连接，send 管出帧，
 * handleMessage 解析入帧，dispatch 按 method 收口。
 *
 * 三条不可动摇的约定：
 *  1) 回包的 error 为真即失败，所以成功帧里不能出现空的 error 对象；失败帧的
 *     error.message 必须是字符串（桥只读它，并把它包成 Node 的 Error.message）。
 *  2) 推送帧（心跳）绝不能带 number 型 id——桥会拿它去匹配 pending 请求，
 *     匹配不到就整条丢弃，表现为"WS 明明连着，90s 后却被判离线"。
 *  3) 出帧只在 socket OPEN 时发生；断开就丢弃，不排队、不跨重连补发（桥自己重试）。
 */
const RECONNECT_DELAY_MS = 3000

function bridgeWsUrl() {
  return `ws://${cfg.bridgeHost}:${cfg.wsPort}`
}

function connect() {
  // 守卫：已经在连或已连上就不再开第二条（防雪崩）
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  let sock
  try {
    sock = new WebSocket(bridgeWsUrl())
  } catch (e) {
    console.error('[proxy] 建立 WS 失败：', errorText(e))
    scheduleReconnect()
    return
  }
  ws = sock
  sock.onopen = () => {
    clearReconnect()
    // 连上就上报身份 + 一次心跳：桥据此立刻置为在线并记录 clientId/ua/version
    ensureClientId()
      .then(() => pushStatus(true))
      .catch(() => {
        /* 身份拿不到也要把心跳发出去，桥只看 connected !== false */
        try {
          pushStatus(true)
        } catch {}
      })
  }
  sock.onmessage = (ev) => {
    const data = ev && typeof ev === 'object' && 'data' in ev ? ev.data : ev
    handleMessage(data).catch((e) => console.error('[proxy] 处理请求帧异常：', errorText(e)))
  }
  sock.onclose = () => {
    // 已被替换掉的旧 socket 不再动全局引用（否则会把新连接置空、挡死重连）
    if (ws !== sock) return
    try {
      pushStatus(false)
    } catch {
      /* 断开时推不出去是常态，桥自己也会看 socket close */
    }
    ws = null
    scheduleReconnect()
  }
  sock.onerror = () => {
    /* 不单独处理：报错之后必然收到 close */
  }
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, RECONNECT_DELAY_MS)
}

/**
 * 发出一帧文本，返回 'sent' | 'closed' | 'unserializable'。
 * 'unserializable' 是独立状态：它意味着回包根本没发出去，调用方必须改回错误帧，
 * 否则桥要等满 120s 再重试三次。
 */
function send(payload) {
  let text
  try {
    text = JSON.stringify(payload)
  } catch {
    return 'unserializable'
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return 'closed'
  try {
    ws.send(text)
    return 'sent'
  } catch {
    return 'closed'
  }
}

function errorText(e) {
  if (e && typeof e.message === 'string' && e.message) return e.message
  if (e === undefined || e === null) return '扩展处理请求时发生未知错误'
  const s = String(e)
  return s || '扩展处理请求时发生未知错误'
}

function errorFrame(id, code, message) {
  return { id, error: { code, message } }
}

/**
 * 请求帧 → 回包帧。垃圾帧（非 JSON / 非对象 / id 不是 number）一律静默丢弃：
 * 回一个没有 id 的错误帧会被桥当成推送丢掉，只会让现场更乱。
 */
async function handleMessage(raw) {
  let msg
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : String(raw))
  } catch {
    return
  }
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') return
  const id = msg.id
  // 只有"扩展本地配了非空 token 且与请求不一致"才算鉴权失配；没配 token 不是拒绝理由
  if (cfg.token && msg.token !== cfg.token) {
    send(errorFrame(id, 403, '扩展本地 token 与桥不一致：请在扩展选项页核对连接配置'))
    return
  }
  let result
  try {
    result = await dispatch(msg.method, msg.params)
  } catch (e) {
    send(errorFrame(id, -1, errorText(e)))
    return
  }
  if (send({ id, result }) === 'unserializable') {
    send(errorFrame(id, -1, `method ${String(msg.method)} 的结果无法序列化为 JSON`))
  }
}

async function dispatch(method, params) {
  const p = params && typeof params === 'object' ? params : {}
  switch (method) {
    case 'proxyFetch':
      return proxyFetch(p)
    case 'getCookie':
      return getCookie(p)
    case 'getAllCookies':
      return getAllCookies(p)
    case 'pageOp':
      return pageOp(p)
    case 'tabsQuery':
      return tabsQuery(p.url)
    case 'tabsCreate':
      return tabsCreate(p.url, p.active)
    case 'tabsWaitForLoad':
      return tabsWaitForLoad(p.tabId, p.timeoutMs)
    case 'tabsClose':
      return tabsClose(p.tabId)
    case 'ping':
      return { pong: true, ts: Date.now(), ua: navigator.userAgent }
    default:
      throw new Error(`未知的桥请求方法：${method === undefined ? '(缺失)' : String(method)}`)
  }
}

/* ── tabs 原语 ────────────────────────────────────────────────────────
 * 三个原语都只是 chrome.tabs 的转发：复用还是新建由适配器决定，本层不缓存
 * tabId、不排序 query 结果（排序会让调用方选到另一个 tab）。 */
async function tabsQuery(url) {
  const list = await chrome.tabs.query({ url })
  return (Array.isArray(list) ? list : [])
    .filter((t) => t && typeof t.id === 'number')
    .map((t) => ({ id: t.id, url: t.url }))
}

async function tabsCreate(url, active) {
  // active 用真值判断：缺省/false 都是后台打开；刚创建时 url 很可能还没有
  const tab = await chrome.tabs.create({ url, active: !!active })
  return { id: tab && tab.id, url: tab && tab.url }
}

const TABS_LOAD_DEFAULT_MS = 30000
const TABS_SETTLE_MS = 1000

/**
 * 等 onUpdated 报 status==='complete'，再静置 1s 后 resolve。
 * 只听 onUpdated 会漏掉"调用前就已经加载完"的 tab（不会再触发 complete），
 * 所以先查一次当前状态；超时仍然是失败，不替调用方容忍。
 */
async function tabsWaitForLoad(tabId, timeoutMs) {
  const limit = timeoutMs || TABS_LOAD_DEFAULT_MS
  return await new Promise((resolve, reject) => {
    let deadline = null
    let settleTimer = null
    let done = false
    const cleanup = () => {
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated)
      } catch {
        /* 监听器已经不存在 */
      }
      if (deadline) clearTimeout(deadline)
      if (settleTimer) clearTimeout(settleTimer)
      deadline = null
      settleTimer = null
    }
    const finish = () => {
      if (done) return
      done = true
      cleanup()
      // 静置：页面自己的初始化（SPA 路由/骨架渲染）还没完，适配器马上要注入 op
      settleTimer = setTimeout(resolve, TABS_SETTLE_MS)
    }
    const fail = (e) => {
      if (done) return
      done = true
      cleanup()
      reject(e)
    }
    function onUpdated(id, info) {
      if (id !== tabId || !info || info.status !== 'complete') return
      finish()
    }
    deadline = setTimeout(
      () => fail(new Error(`等待标签页 ${tabId} 加载完成超时（${limit}ms）`)),
      limit,
    )
    chrome.tabs.onUpdated.addListener(onUpdated)
    try {
      Promise.resolve(chrome.tabs.get(tabId)).then(
        (tab) => {
          if (tab && tab.status === 'complete') finish()
        },
        () => {
          /* 查不到就当还没加载完，继续等 onUpdated */
        },
      )
    } catch {
      /* 没有 tabs.get 的宿主就只靠 onUpdated */
    }
  })
}

async function tabsClose(tabId) {
  if (!tabId) return { closed: false }
  await chrome.tabs.remove(tabId)
  return { closed: true }
}

// ===== pageOp：在平台页面（MAIN world）执行预定义操作 =====
// MV3 SW 的 CSP 禁止 eval/new Function，无法把 Node 传来的函数源码重建为函数；
// 因此这里把适配器需要页面执行的操作预定义为纯函数（PAGE_OPS），经
// chrome.scripting.executeScript(world:'MAIN') 注入页面执行——页面全局
// （fetch/indexedDB/_webmsxyw 等）在 MAIN world 里可用。
// 页面操作定义为独立函数（chrome.scripting.executeScript 要求 func 是独立函数）
// 页面探测（调试）：localStorage/sessionStorage/全局变量里的 token/csrf 线索
async function pageProbe() {
  const out = { localStorage: [], sessionStorage: [], globals: [] }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (/csrf|token|sign|smzdm/i.test(k || ''))
        out.localStorage.push({ k, v: String(localStorage.getItem(k)).slice(0, 200) })
    }
  } catch (e) {
    out.localStorageErr = e.message
  }
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (/csrf|token|sign|smzdm/i.test(k || ''))
        out.sessionStorage.push({ k, v: String(sessionStorage.getItem(k)).slice(0, 200) })
    }
  } catch (e) {
    out.sessionStorageErr = e.message
  }
  try {
    for (const g of [
      '_csrf',
      'csrfToken',
      'csrf_token',
      'token',
      'smzdm',
      'SMZDM',
      '__INITIAL_STATE__',
      'window.__data',
    ]) {
      if (typeof window[g] !== 'undefined')
        out.globals.push({ g, v: JSON.stringify(window[g]).slice(0, 300) })
    }
  } catch (e) {
    out.globalsErr = e.message
  }
  return out
}

// 读当前活动标签页 DOM（wn_extract_article 的 activeTab 通道）
// 返回标题/URL/正文 HTML 分块（分块避免 executeScript 大字符串序列化失败）
// 正文提取：优先 #js_content（公众号）、article/main 等语义容器，兜底 body
async function readActiveTab() {
  const out = { title: '', url: '', htmlChunks: [], len: 0, selector: '' }
  try {
    out.title = (document.title || '').trim()
    out.url = location.href
    let root = null
    const candidates = [
      '#js_content',
      'article',
      'main',
      '.article-content',
      '.post-content',
      '.rich_media_content',
      '.content',
      '#content',
      'body',
    ]
    for (const sel of candidates) {
      const el = document.querySelector(sel)
      if (el) {
        root = el
        out.selector = sel
        break
      }
    }
    if (!root) root = document.body || document.documentElement
    const html = root.outerHTML || ''
    out.len = html.length
    // 每块约 40KB，防 executeScript 序列化失败（大字符串返回会变 undefined）
    const CHUNK = 40000
    for (let i = 0; i < html.length; i += CHUNK) {
      out.htmlChunks.push(html.slice(i, i + CHUNK))
    }
    return out
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) }
  }
}

// 什么值得买：取发稿用的 CSRF token（该端点有 WAF，只有页面上下文能过）
async function smzdmGetToken() {
  const ENDPOINT = 'https://post.smzdm.com/api/editor/get_token'
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    const text = await resp.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return {
        success: false,
        error: `什么值得买 token 接口没有返回 JSON（HTTP ${resp.status}）：${text.slice(0, 200)}`,
      }
    }
    // 回包形状（2026-09-29 实测，页面上下文与扩展 SW 上下文各测一次，两边一致）：
    //   {"error_code":0,"error_msg":"","data":{"token":"<64 位 hex>"}}
    // 注意这里**只有一层 data**。改写前的写法是 `const data = await resp.json(); data.data.token`——
    // 那个局部变量 `data` 就是整个回包，等价于 body.data.token；曾把它误读成"回包还嵌一层"，
    // 写成 body.data.data.token → 恒为 undefined → 发布端报"取不到 CSRF token"（2026-09-29 事故）。
    const token = body && body.data ? body.data.token : undefined
    if (typeof token !== 'string' || token === '') {
      // 与同族 op neteaseGetToken 一致：拿不到就 success:false 并带上回包摘要。
      // 若沿用"成功 + 空 token"，引擎侧只能报一句"取不到 CSRF token"，看不出平台到底回了什么。
      return {
        success: false,
        error: `什么值得买 token 接口没有下发 token（HTTP ${resp.status}）：${text.slice(0, 200)}`,
      }
    }
    return { success: true, token }
  } catch (e) {
    return { success: false, error: `什么值得买 token 请求失败：${(e && e.message) || e}` }
  }
}

// 小红书：读取 IndexedDB 草稿列表（调试/验收用，返回关键字段）
// args[0] 为 draftId 时返回该草稿的完整对象（值级对比用）
async function xhsReadDrafts(draftIdOnly) {
  try {
    const req = indexedDB.open('draft-database-v1')
    const db = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = (ev) =>
        reject(
          new Error('open error: ' + (ev.target && ev.target.error ? ev.target.error.message : '')),
        )
    })
    if (!db.objectStoreNames.contains('article-draft')) {
      db.close()
      return { success: true, storeExists: false, drafts: [] }
    }
    const tx = db.transaction(['article-draft'], 'readonly')
    const store = tx.objectStore('article-draft')
    const all = await new Promise((resolve, reject) => {
      const g = store.getAll()
      g.onsuccess = () => resolve(g.result || [])
      g.onerror = (ev) =>
        reject(
          new Error(
            'getAll error: ' + (ev.target && ev.target.error ? ev.target.error.message : ''),
          ),
        )
    })
    db.close()
    if (draftIdOnly) {
      const target = (all || []).find((x) => x && x.draftId === draftIdOnly) || null
      return { success: true, full: target }
    }
    // richJson 结构摘要：递归 type + attrs keys + 文本样例（防大对象序列化失败）
    const summarize = (node, depth) => {
      if (!node || typeof node !== 'object') return node
      if (depth > 4) return '...'
      const out = { type: node.type || null }
      if (node.attrs && typeof node.attrs === 'object') out.attrs = Object.keys(node.attrs)
      if (typeof node.text === 'string') out.text = node.text.slice(0, 30)
      if (Array.isArray(node.content))
        out.content = node.content.slice(0, 6).map((c) => summarize(c, depth + 1))
      if (Array.isArray(node.marks)) out.marks = node.marks.map((m) => (m && m.type) || null)
      return out
    }
    const drafts = (all || []).map((d) => {
      const c = (d && d.content) || {}
      const as = c.articleStore || {}
      const ss = c.shortDraftStore || {}
      const ps = c.publishStore || {}
      return {
        draftId: d ? d.draftId : null,
        timeStamp: d ? d.timeStamp : null,
        articleTitle: as.articleTitle || null,
        title: (c.draftStore && c.draftStore.title) || null,
        isShort: ss.isShort ?? null,
        publishType: ps.publishType ?? null,
        articleEditorMode: as.articleEditorMode ?? null,
        articleContentSample: String(as.articleContent || '').slice(0, 150),
        // `&&` 链在 `textCardList` 缺失时求值成 undefined，再 `.slice` 就抛
        // "Cannot read properties of undefined" —— 这条读工具是验收与排查用的，必须对
        // "记录里没有这个分支"（例如老记录 / 别处写入的简化记录）保持可用。
        textCardTextSample: String(
          (ss.textCardList && ss.textCardList[0] && ss.textCardList[0].text) || '',
        ).slice(0, 150),
        storeKeys: Object.keys(c),
        articleStoreKeys: Object.keys(as),
        richJson: summarize(as.richJson, 0),
      }
    })
    return { success: true, storeExists: true, count: drafts.length, drafts }
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) }
  }
}

// 小红书：删除 IndexedDB 草稿（args[0] = draftId 删除单篇，'*' 或空 = 清空全部）
async function xhsDeleteDraft(draftId) {
  try {
    const req = indexedDB.open('draft-database-v1')
    const db = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = (ev) =>
        reject(
          new Error('open error: ' + (ev.target && ev.target.error ? ev.target.error.message : '')),
        )
    })
    if (!db.objectStoreNames.contains('article-draft')) {
      db.close()
      return { success: false, error: '草稿库里没有 article-draft 对象仓' }
    }
    const tx = db.transaction(['article-draft'], 'readwrite')
    const store = tx.objectStore('article-draft')
    if (!draftId || draftId === '*') {
      await new Promise((resolve, reject) => {
        const c = store.clear()
        c.onsuccess = () => resolve()
        c.onerror = (ev) =>
          reject(
            new Error(
              'clear error: ' + (ev.target && ev.target.error ? ev.target.error.message : ''),
            ),
          )
      })
    } else {
      await new Promise((resolve, reject) => {
        const d = store.delete(draftId)
        d.onsuccess = () => resolve()
        d.onerror = (ev) =>
          reject(
            new Error(
              'delete error: ' + (ev.target && ev.target.error ? ev.target.error.message : ''),
            ),
          )
      })
    }
    db.close()
    return { success: true, deleted: !draftId || draftId === '*' ? 'all' : draftId }
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) }
  }
}

/* ── 页面操作：以下函数都会被序列化后注入平台页面的 MAIN world 执行 ──────
 * 因此每个函数自带 try/catch，只能返回可结构化序列化的 {success,...} 信封，
 * 不能闭包引用 SW 作用域里的任何东西（参数由 pageOp 按位置传入）。 */

// 头条：在发布页上下文里 POST 一份调用方已经拼好的表单体（页面 cookie 由浏览器带上）
async function toutiaoPublish(url, body) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
    })
    const text = await resp.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      // WAF/登录跳转页会回 HTML；把片段带上，否则现场只剩一句"解析失败"
      return {
        success: false,
        error: `头条发布接口没有返回 JSON（HTTP ${resp.status}）：${text.slice(0, 200)}`,
      }
    }
    // 不看 HTTP 状态：非 2xx 但 JSON 合法时仍按成功信封回，由调用方判 err_no
    return { success: true, data: data }
  } catch (e) {
    return { success: false, error: `头条发布请求未成功：${(e && e.message) || e}` }
  }
}

// 小红书：把长文草稿写进创作者页面的 IndexedDB（只写草稿，不发任何发布请求）
async function xhsSaveDraft(draftId, title, richJson, uid, wordCount) {
  /**
   * 写进小红书草稿库的**完整记录模板**（顶层 + content 六组）。
   *
   * 为什么必须是完整结构：平台编辑器打开草稿时读的是记录里的**整套字段树**
   * （contextStore / draftStore / settingStore / articleStore / shortDraftStore / publishStore），
   * 不只是我们关心的那几条路径。只写最小路径时，草稿箱**能列出**这条记录，但点「编辑」**打不开**
   * （2026-09-29 实测：改写把记录裁到 6 条路径，编辑按钮点选失效）。
   *
   * 模板来源：平台自己写出的那条记录的字段路径与填充值（本仓库归档里经过线上验证的一份，
   * 逐字段搬成**数据常量**——字段名与取值是平台 IndexedDB 的 schema，不是我们的自由创作；
   * 标量取值按规格 §3.3.2 §7-① 属于"实现自选、以真链路能打开草稿为准绳"）。
   *
   * 需要随平台改版更新时，按 `md-backup/maintaining/cleanroom/spec-extension-layer.md` §3.3.2 的
   * 「重新采样」步骤：让平台自己写一条长文草稿，用 `xhsReadDrafts(draftId)` 读回整条记录，替换本常量。
   *
   * 动态值（这几个在写入时覆盖，模板里一律归零）：draftId / uid / timeStamp /
   * content.draftStore.title / content.articleStore.{title, articleTitle, richJson, wordCount} /
   * content.shortDraftStore.textCardList[*].createTime
   */
  const XHS_RECORD_TEMPLATE = {
    draftId: '',
    uid: '',
    timeStamp: 0,
    content: {
      contextStore: {
        liveContext: { time: 0, title: '' },
        previewAuditContext: {
          status: 0,
          detail: {
            hasLimit: true,
            remainingCalls: 0,
            taskId: '',
            taskType: '1',
            status: 0,
            taskResultInfo: { detectionStatus: 1, optimizationPoints: [] },
          },
          isChange: false,
        },
        coverContext: {
          coverUrl: '',
          cover: {
            width: 0,
            height: 0,
            fileid: '',
            frame: { ts: 0, isUserSelect: false, isUpload: false },
            stickers: { version: 2, neptune: [] },
            fonts: [],
            coverTemplateId: '',
            extra_info_json: '',
          },
          templateBlob: null,
          rate: 0,
          recommendCoverIdx: -1,
        },
        goodsContext: { goodsInfo: {}, goodsPreviewDetail: [] },
        bizRelationContext: { bizRelation: [] },
        recommendCovers: [],
      },
      draftStore: {
        descInnerHTML: '',
        descLength: 0,
        video: {
          width: 0,
          height: 0,
          fileid: '',
          fsize: 0,
          duration: 0,
          videoId: '',
          videoMarks: [],
          timelines: [],
          frame: { ts: 0, userSelect: false },
          transcodeVideoFileId: '',
          coverInfo: {},
        },
        videoInfo: null,
        audioInfo: null,
        videoMeta: '',
        audioMeta: '',
        cover: {
          width: 0,
          height: 0,
          fileid: '',
          frame: { ts: 0, isUserSelect: false, isUpload: false },
          stickers: { neptune: [], version: 2 },
          fonts: [],
        },
        chapters: [],
        markers: [],
        needTranscode: false,
        imgList: [],
        colorGroup: null,
        title: '',
        desc: '',
        ats: [],
        hashTag: [],
      },
      settingStore: {
        privacyInfo: { opType: 1, type: 0, userIds: [] },
        collectionId: '',
        orderId: '',
        brandAccountId: '',
        noteSketch: { id: '', name: '' },
        original: false,
        originalDateStamp: '',
        coProduceBind: { enable: true },
        noteCopyBind: { copyable: true },
        coOrderId: '',
        interactionPermissionBind: { commentPermission: 0 },
        fileRelate: {
          fileId: '',
          docId: '',
          docName: '',
          docShowName: '',
          docType: '',
          docSize: 0,
        },
      },
      articleStore: {
        articleContent: '',
        summeryContent: '',
        orderPattern: '',
        richJson: '',
        // 平台自己写的记录里同时有 title 与 articleTitle（写入时两者都覆盖成本次标题）
        title: '',
        articleTitle: '',
        articleEditorMode: 0,
        wordCount: 0,
        authorAndSummaryTemp: { author: '', summary: '', readingStats: '' },
        selectedThemeId: 6,
        selectedColorIndexMap: {},
        blob2Map: {},
        coverSetting: { styleType: 0, showAuthor: true, showReadingStats: true, showSummery: true },
        editPageSource: 'import',
        schemaCopy: {},
        url2FileIdMap: {},
      },
      shortDraftStore: {
        isShort: true,
        editStatus: 0,
        textCardList: [
          {
            createTime: 0,
            text: '',
            originText: '',
            length: 0,
            image: '',
            imageFileId: '',
            isManualInsert: false,
          },
        ],
        coverList: [],
        currentCoverIdx: 0,
        cacheData: {},
      },
      publishStore: {
        publishType: 1,
        imageNoteOrigin: 0,
        systemId: 'web',
        step: 0,
        uploadState: 2,
        status: 0,
        codec: 'unknown',
      },
    },
  }
  const DB_NAME = 'draft-database-v1'
  const STORE_NAME = 'article-draft'
  const OPEN_TIMEOUT_MS = 10000
  const fail = (msg) => ({ success: false, error: msg })
  const asNumber = Number(wordCount)
  const words = Number.isFinite(asNumber) ? asNumber : 0
  const noLibrary = `本地没有小红书草稿库 ${DB_NAME}：请先在这个浏览器里打开一次「草稿箱 → 长文笔记」`

  if (typeof indexedDB === 'undefined') return fail('当前页面没有 IndexedDB，写不进小红书草稿')

  let db = null
  let upgraded = false
  // open 一个不存在的库会顺手创建它；先探一次，避免留下没有对象仓的空库
  if (typeof indexedDB.databases === 'function') {
    try {
      const known = await indexedDB.databases()
      if (Array.isArray(known) && !known.some((d) => d && d.name === DB_NAME))
        return fail(noLibrary)
    } catch {
      /* 探不到就照常打开，由下面的仓检查兜底 */
    }
  }
  try {
    db = await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`打开小红书草稿库 ${DB_NAME} 超时（${OPEN_TIMEOUT_MS}ms）`))
      }, OPEN_TIMEOUT_MS)
      let req
      try {
        req = indexedDB.open(DB_NAME)
      } catch (e) {
        clearTimeout(timer)
        reject(e)
        return
      }
      req.onsuccess = () => {
        if (settled) {
          try {
            req.result.close()
          } catch {
            /* 连接已在关闭中 */
          }
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(req.result)
      }
      req.onerror = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(req.error || new Error(`打开小红书草稿库 ${DB_NAME} 失败`))
      }
      req.onblocked = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`打开小红书草稿库 ${DB_NAME} 被阻塞：请关掉其它占用该库的页面`))
      }
      req.onupgradeneeded = () => {
        // 走到升级说明库本来不存在：中止升级，不要留下空库（平台没建仓照样写不进）
        upgraded = true
        try {
          req.transaction.abort()
        } catch {
          /* 中止失败就让 onsuccess 分支关掉连接 */
        }
      }
    })
  } catch (e) {
    return fail(upgraded ? noLibrary : `打开小红书草稿库失败：${(e && e.message) || e}`)
  }

  const storeNames = db.objectStoreNames
  if (
    !storeNames ||
    typeof storeNames.contains !== 'function' ||
    !storeNames.contains(STORE_NAME)
  ) {
    const existing =
      storeNames && typeof storeNames.length === 'number'
        ? Array.from(storeNames).join(', ')
        : '(未知)'
    try {
      db.close()
    } catch {
      /* 连接可能已关闭 */
    }
    return fail(`小红书草稿库 ${DB_NAME} 里没有对象仓 ${STORE_NAME}（现有：${existing}）`)
  }

  let record
  try {
    // 以**完整模板**为底（平台编辑器要整套字段树），再覆盖调用方给的那几个值。
    // 深拷贝：模板是模块级常量，多次写入不能互相污染。
    record = JSON.parse(JSON.stringify(XHS_RECORD_TEMPLATE))
    // 记录以 draftId 为内联主键；字段路径是与保留的读/删工具共用的契约
    record.draftId = draftId
    record.uid = uid
    record.timeStamp = Date.now()
    record.content.draftStore.title = title
    record.content.articleStore.title = title
    record.content.articleStore.articleTitle = title
    record.content.articleStore.richJson = richJson
    record.content.articleStore.wordCount = words
    const cards = record.content.shortDraftStore.textCardList
    if (Array.isArray(cards)) for (const card of cards) card.createTime = record.timeStamp
  } catch (e) {
    try {
      db.close()
    } catch {
      /* 连接可能已关闭 */
    }
    return fail(`组装小红书草稿记录失败：${(e && e.message) || e}`)
  }

  try {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('写入事务失败'))
      tx.onabort = () => reject(tx.error || new Error('写入事务被中止'))
      try {
        tx.objectStore(STORE_NAME).put(record)
      } catch (e) {
        reject(e)
      }
    })
    try {
      db.close()
    } catch {
      /* 连接可能已关闭 */
    }
    return { success: true, draftId: draftId }
  } catch (e) {
    try {
      db.close()
    } catch {
      /* 连接可能已关闭 */
    }
    return fail(`写入小红书草稿失败：${(e && e.message) || e}`)
  }
}

// 小红书：取图片上传凭证 → 直传对象存储 → 回一个能在正文里引用的预览地址
async function xhsUploadPermit(base64, mime) {
  const ORIGIN = 'https://creator.xiaohongshu.com'
  const PERMIT_PATH =
    '/api/media/v1/upload/creator/permit?biz_name=spectrum&scene=image&file_count=1&version=1&source=web'
  const contentType = mime || 'image/jpeg'
  const fail = (msg) => ({ success: false, error: msg })
  try {
    const headers = { Accept: 'application/json, text/plain, */*' }
    // 页面签名：用「路径+query」调页面自己的签名函数；签不出来也照发，平台会拒
    try {
      const sign = window._webmsxyw
      if (typeof sign === 'function') {
        const signed = sign(PERMIT_PATH)
        if (signed && typeof signed === 'object') {
          for (const name of ['X-s', 'X-t', 'X-s-common']) {
            const v = signed[name]
            if (v !== undefined && v !== null && v !== '') headers[name] = String(v)
          }
        }
      }
    } catch {
      /* 签名抖动不阻断：缺签名头的结果是平台回一个业务错误 */
    }

    const permitResp = await fetch(ORIGIN + PERMIT_PATH, {
      method: 'GET',
      credentials: 'include',
      headers: headers,
    })
    const permitText = await permitResp.text()
    let permit
    try {
      permit = JSON.parse(permitText)
    } catch {
      return fail(
        `小红书上传凭证接口没有返回 JSON（HTTP ${permitResp.status}）：${permitText.slice(0, 200)}`,
      )
    }
    const permits = permit && permit.data ? permit.data.uploadTempPermits : null
    if (!permit || !permit.success || !permit.data || !Array.isArray(permits) || !permits.length) {
      return fail(
        `小红书拒绝了上传凭证请求（HTTP ${permitResp.status}）：${permitText.slice(0, 200)}`,
      )
    }
    const chosen =
      permits.find((p) => p && p.uploadAddr === 'ros-upload.xiaohongshu.com') || permits[0]
    if (!chosen || !chosen.uploadAddr) {
      return fail(`小红书上传凭证缺少 uploadAddr：${permitText.slice(0, 200)}`)
    }
    const fileId = Array.isArray(chosen.fileIds) ? chosen.fileIds[0] : null
    if (!fileId) return fail(`小红书上传凭证缺少 fileIds：${permitText.slice(0, 200)}`)

    let bytes
    try {
      const bin = atob(String(base64 || ''))
      bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
    } catch (e) {
      return fail(`图片 base64 解码失败：${(e && e.message) || e}`)
    }

    const uploadResp = await fetch(`https://${chosen.uploadAddr}/${fileId}`, {
      method: 'PUT',
      headers: {
        Authorization: chosen.token,
        'x-cos-security-token': chosen.token,
        'Content-Type': contentType,
      },
      body: new Blob([bytes], { type: contentType }),
    })
    if (!uploadResp.ok) {
      return fail(
        `小红书对象存储直传失败：HTTP ${uploadResp.status} ${uploadResp.statusText || ''}`.trim(),
      )
    }
    // 预览地址只在响应头里；拿不到就让调用方回退到 xhscdn 的拼法
    const preview = uploadResp.headers.get('x-ros-preview-url')
    return { success: true, fileId: fileId, previewUrl: preview || null }
  } catch (e) {
    return fail(`小红书图片上传未成功：${(e && e.message) || e}`)
  }
}

// 抖音：创作中心的通用页面内 fetch 通道（草稿/凭证/Apply/Commit/预览都走它）
async function douyinPublish(url, method, body) {
  try {
    const init = { method: method, credentials: 'include' }
    // 只有 body 为真值才带 content-type；字符串原样发，其它 JSON.stringify
    if (body) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
    }
    const resp = await fetch(url, init)
    const text = await resp.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      return {
        success: false,
        error: `抖音接口没有返回 JSON（HTTP ${resp.status}）：${text.slice(0, 200)}`,
      }
    }
    // 不看 HTTP 状态：业务成败由调用方读 status_code 判定
    return { success: true, data: data }
  } catch (e) {
    return { success: false, error: `抖音页面请求失败：${(e && e.message) || e}` }
  }
}

// 网易号：取页面脚本挂上来的 ursToken（window.neg.getToken()）
async function neteaseGetToken() {
  try {
    const neg = window.neg
    if (!neg || typeof neg.getToken !== 'function') {
      return { success: false, error: '网易号页面没有挂载 window.neg.getToken()，取不到 ursToken' }
    }
    const res = await neg.getToken()
    if (!res || res.code !== 200) {
      return {
        success: false,
        error: `网易号 getToken 返回的 code 不是 200（实际：${res ? String(res.code) : '(空回包)'}）`,
      }
    }
    if (!res.token) return { success: false, error: '网易号 getToken 返回里没有 token' }
    return { success: true, token: res.token }
  } catch (e) {
    return { success: false, error: `网易号取 ursToken 失败：${(e && e.message) || e}` }
  }
}

// 页面通用探测：读取当前页面 script src 与内联代码片段（调试用）
async function pageReadScripts() {
  try {
    const scripts = Array.from(document.querySelectorAll('script')).map((s) => ({
      src: s.src || '',
      inline: (s.textContent || '').slice(0, 2000),
    }))
    return { ok: true, count: scripts.length, scripts: scripts.slice(0, 40) }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

// woshipm 编辑器探测：读取标题框实际值（排查标题被 HTML 属性污染的 bug）
async function woshipmProbeEditor() {
  try {
    const out = { url: location.href, title: document.title, inputs: [], globals: {} }
    // 所有 input/textarea 的 name/id/value + outerHTML 前缀（识别 autocomplete 污染）
    Array.from(document.querySelectorAll('input, textarea')).forEach((el) => {
      out.inputs.push({
        name: el.name || '',
        id: el.id || '',
        type: el.type || '',
        value: (el.value || '').slice(0, 300),
        placeholder: el.placeholder || '',
        outer: el.outerHTML.slice(0, 250),
      })
    })
    // 常见编辑器全局（woshipm 用 Vue/React？）
    const gs = ['__DATA__', '__INITIAL_STATE__', 'post_title', 'tinymce', 'jQuery', 'Vue', 'wp']
    for (const g of gs) {
      try {
        const v = window[g]
        if (v !== undefined && v !== null)
          out.globals[g] =
            typeof v === 'string'
              ? v.slice(0, 300)
              : '[' + (v.constructor ? v.constructor.name : typeof v) + ']'
      } catch {
        /* ignore */
      }
    }
    return { ok: true, ...out }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

// 通用 DOM 探测：读取页面渲染后的按钮/链接/文本（调试用，如找删除入口）
async function probePageDom() {
  try {
    const html = document.body ? document.body.innerHTML : ''
    const text = document.body ? document.body.innerText : ''
    const out = {
      url: location.href,
      title: document.title,
      buttons: [],
      links: [],
      texts: [],
      bodyLen: text.length,
      htmlLen: html.length,
      htmlHead: html.slice(0, 3000),
      htmlTail: html.slice(-3000),
    }
    Array.from(
      document.querySelectorAll(
        'button, a.btn, [class*="del"], [class*="Del"], [class*="remove"], [class*="delete"], [class*="trash"], [class*="Trash"]',
      ),
    ).forEach((el) => {
      const t = (el.innerText || el.textContent || '').trim().slice(0, 50)
      if (t)
        out.buttons.push({
          tag: el.tagName,
          text: t,
          cls: String(el.className).slice(0, 60),
          href: el.href || '',
          onclick: el.getAttribute('onclick') || '',
        })
    })
    // 常见删除文案的按钮（无 class 匹配时）
    Array.from(document.querySelectorAll('button, a, span, div')).forEach((el) => {
      const t = (el.innerText || '').trim()
      if (/^删|删除|移除|Remove|Delete|Trash/i.test(t) && t.length < 20) {
        out.texts.push({
          tag: el.tagName,
          text: t,
          cls: String(el.className).slice(0, 60),
          href: el.href || '',
          parent: el.parentElement ? (el.parentElement.className + '').slice(0, 60) : '',
        })
      }
    })
    out.buttons = out.buttons.slice(0, 20)
    out.texts = out.texts.slice(0, 20)
    return { ok: true, ...out }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

// 豆瓣编辑器逆向：读取脚本 src、全局变量、表单字段、保存按钮
async function doubanProbeEditor() {
  try {
    const out = {
      scripts: [],
      globals: {},
      bodyText: '',
      forms: [],
      inputs: [],
      saveBtn: '',
      allBodyKeys: [],
    }
    Array.from(document.querySelectorAll('script')).forEach((s) => {
      if (s.src) out.scripts.push(s.src)
    })
    const gs = [
      '__DATA__',
      '_DATA',
      '__INITIAL_STATE__',
      'ck',
      '_ck',
      'note_id',
      'noteId',
      'upload_auth_token',
      'topic_id',
      'topicId',
    ]
    for (const g of gs) {
      try {
        const val = window[g]
        if (val !== undefined && val !== null) out.globals[g] = JSON.stringify(val).slice(0, 500)
      } catch {
        /* ignore */
      }
    }
    // 所有 input/textarea/select 的 name/value
    Array.from(document.querySelectorAll('input, textarea, select')).forEach((el) => {
      out.inputs.push({
        name: el.name || '',
        id: el.id || '',
        value: (el.value || '').slice(0, 200),
        type: el.type || '',
      })
    })
    // 保存按钮
    const btn =
      document.querySelector('.DRE-topic-editor-draft-save') ||
      document.querySelector('[class*=save]')
    if (btn) out.saveBtn = btn.outerHTML.slice(0, 500)
    // 全局变量名清单（window 上含 ck/token/note/topic 的）
    try {
      out.allBodyKeys = Object.keys(window)
        .filter((k) => /ck|token|note|topic|draft|save/i.test(k))
        .slice(0, 40)
    } catch {
      /* cross-origin */
    }
    out.bodyText = document.body ? document.body.innerHTML.slice(0, 2000) : ''
    return { ok: true, ...out }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

// 豆瓣：读取页面底部草稿箱区域（topic/create 页面底部有草稿列表）
async function doubanReadDraftBox() {
  try {
    // 滚动到底部触发渲染
    window.scrollTo(0, document.body.scrollHeight)
    await new Promise((r) => setTimeout(r, 800))
    const out = { url: location.href, title: document.title, draftEls: [], bottomText: '' }
    // 找含"草稿"文本的元素及其容器
    Array.from(document.querySelectorAll('div, span, li, a, h2, h3')).forEach((el) => {
      const t = (el.innerText || el.textContent || '').trim()
      if (t && t.length < 60 && /草稿|draft|Draft/i.test(t)) {
        out.draftEls.push({
          tag: el.tagName,
          text: t,
          cls: String(el.className).slice(0, 80),
          href: el.href || '',
        })
      }
    })
    // 页面底部 3000 字符 innerText
    const bodyText = document.body ? document.body.innerText : ''
    out.bottomText = bodyText.slice(-3000)
    out.draftEls = out.draftEls.slice(0, 25)
    return { ok: true, ...out }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

// 豆瓣：读取页面已发生的网络请求（performance resource timing）
async function doubanPerf() {
  try {
    const entries = performance.getEntriesByType('resource')
    const out = entries
      .filter((e) => /douban|rexxar|dwarf|note|topic/i.test(e.name))
      .slice(-20)
      .map((e) => ({ name: e.name.slice(0, 200), initiatorType: e.initiatorType }))
    return { ok: true, count: out.length, entries: out }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

// 通用资源/接口探测：读取页面 performance 中的 XHR/fetch 请求（调试用，逆向删除/保存接口）
async function probePagePerf() {
  try {
    const entries = performance.getEntriesByType('resource')
    const out = entries
      .filter(
        (e) =>
          e.initiatorType === 'xmlhttprequest' ||
          e.initiatorType === 'fetch' ||
          /\/__api\/|admin-ajax|\.php\?/i.test(e.name),
      )
      .slice(-40)
      .map((e) => ({
        name: e.name.slice(0, 250),
        initiatorType: e.initiatorType,
        duration: Math.round(e.duration),
      }))
    return { ok: true, count: out.length, entries: out }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

// 通用页面内 fetch：在页面 MAIN world 执行 fetch（自动带页面 cookie/凭证），用于调试调用 __api 等接口
// args = [url, method, bodyJson, headersJson]（executeScript 展开传参）
async function pageFetch(url, method, bodyJson, headersJson) {
  try {
    if (!url) return { success: false, error: 'missing url' }
    const opts = { method: method || 'GET', credentials: 'include' }
    if (headersJson) {
      try {
        opts.headers = JSON.parse(headersJson)
      } catch {
        /* ignore */
      }
    }
    if (bodyJson && method !== 'GET') {
      if (!opts.headers) opts.headers = {}
      if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json'
      opts.body = bodyJson
    }
    const resp = await fetch(url, opts)
    const text = await resp.text()
    return { success: true, status: resp.status, text: text.slice(0, 4000) }
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) }
  }
}
async function doubanWebpackProbe(moduleId, start, length, keyword, maxHits) {
  try {
    const chunk = window.webpackChunktopic_editor
    const out = { hasChunk: !!chunk, moduleCount: 0, apiHits: [], bigModules: [], slice: null }
    if (!chunk) return { ok: true, ...out }
    const modules = chunk.find((c) => Array.isArray(c) && c[1] && typeof c[1] === 'object')
    if (!modules) return { ok: true, ...out }
    out.moduleCount = Object.keys(modules[1]).length
    // 特定模块切片模式：args=[moduleId, start, length]
    if (moduleId && start !== undefined && start !== null) {
      const mid = String(moduleId)
      const s = Number(start) || 0
      const l = Number(length) || 15000
      const m = modules[1][mid]
      if (m) {
        try {
          out.slice = { module: mid, start: s, len: l, text: m.toString().slice(s, s + l) }
        } catch {
          out.error = 'toString failed'
        }
      } else {
        out.error =
          'module not found: ' +
          mid +
          ' (keys: ' +
          Object.keys(modules[1]).slice(0, 10).join(',') +
          ')'
      }
      return { ok: true, ...out }
    }
    // 模块内关键词搜索模式：args=[moduleId, null, null, keyword, maxHits]
    if (moduleId && keyword) {
      const mid = String(moduleId)
      const kw = String(keyword)
      const m = modules[1][mid]
      const out2 = { ok: true, module: mid, keyword: kw, hits: [] }
      if (m) {
        try {
          const src = m.toString()
          let i = -1
          let count = 0
          const mh = Number(maxHits) || 5
          while ((i = src.indexOf(kw, i + 1)) !== -1 && count < mh) {
            out2.hits.push(src.slice(Math.max(0, i - 200), i + 500).replace(/\n/g, ' '))
            count++
          }
        } catch {
          out2.error = 'toString failed'
        }
      } else {
        out2.error = 'module not found: ' + mid
      }
      return out2
    }
    const keywords = [
      '/j/note/autosave',
      'topic/save',
      'note_id',
      'upload_auth_token',
      '/j/topic',
      'saveDraft',
      'autosave',
      'note/create',
      '/j/',
      'create_note',
      'topic/create',
    ]
    for (const [mid, m] of Object.entries(modules[1])) {
      let src = ''
      try {
        src = m.toString()
      } catch {
        continue
      }
      if (src.length > 20000 && out.bigModules.length < 3) {
        out.bigModules.push({ module: mid, len: src.length, head: src.slice(0, 15000) })
      }
      for (const kw of keywords) {
        const i = src.indexOf(kw)
        if (i !== -1) {
          out.apiHits.push({
            module: mid,
            keyword: kw,
            snippet: src
              .slice(Math.max(0, i - 100), i + 250)
              .replace(/\n/g, ' ')
              .slice(0, 350),
          })
        }
      }
      if (out.apiHits.length > 15) break
    }
    return { ok: true, ...out }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}
// 豆瓣：往编辑器填入标题/内容，触发保存并捕获网络请求（fetch+XHR 拦截）
// args: [title, content]
async function doubanFillAndSave(title, content) {
  const captured = []
  const origFetch = window.fetch
  const origOpen = XMLHttpRequest.prototype.open
  const origSend = XMLHttpRequest.prototype.send
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        captured.push({
          type: 'fetch',
          url: String(url).slice(0, 300),
          method: (init && init.method) || 'GET',
        })
      } catch {
        /* ignore */
      }
      return origFetch.apply(this, arguments)
    }
  }
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cap = { method: String(method || 'GET'), url: String(url || '').slice(0, 300) }
    return origOpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      if (this.__cap) {
        this.__cap.headers = this.__cap.headers || []
        this.__cap.headers.push(String(k) + ': ' + String(v).slice(0, 100))
      }
    } catch {
      /* ignore */
    }
    return origSetRequestHeader.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__cap) {
        this.__cap.body = String(body || '').slice(0, 500)
        captured.push(this.__cap)
      }
    } catch {
      /* ignore */
    }
    return origSend.apply(this, arguments)
  }
  try {
    // 填标题（仅 input/textarea 用 setter；contenteditable 跳过标题直接写正文）
    const titleEl =
      document.querySelector('input[placeholder], textarea[placeholder]') ||
      document.querySelector('input, textarea')
    if (titleEl) {
      const proto =
        titleEl instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')
      if (setter && setter.set) setter.set.call(titleEl, title)
      titleEl.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // 填正文（lexical contenteditable）
    const editor = document.querySelector('[contenteditable="true"]')
    if (editor) {
      editor.focus()
      document.execCommand('insertText', false, content)
    }
    await new Promise((r) => setTimeout(r, 1000))
    // 点保存
    const btn =
      document.querySelector('.DRE-topic-editor-draft-save') ||
      document.querySelector('[class*=draft-save]') ||
      document.querySelector('[class*=save]')
    if (btn) btn.click()
    await new Promise((r) => setTimeout(r, 4000))
    window.fetch = origFetch
    XMLHttpRequest.prototype.open = origOpen
    XMLHttpRequest.prototype.send = origSend
    XMLHttpRequest.prototype.setRequestHeader = origSetRequestHeader
    return { ok: true, captured }
  } catch (err) {
    window.fetch = origFetch
    XMLHttpRequest.prototype.open = origOpen
    XMLHttpRequest.prototype.send = origSend
    XMLHttpRequest.prototype.setRequestHeader = origSetRequestHeader
    return { ok: false, error: (err && err.message) || String(err), captured }
  }
}

// 豆瓣：点击"保存草稿"按钮并捕获网络请求（fetch + XHR 都拦截）
async function doubanSaveProbe() {
  const captured = []
  const origFetch = window.fetch
  const origOpen = XMLHttpRequest.prototype.open
  const origSend = XMLHttpRequest.prototype.send
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        captured.push({
          type: 'fetch',
          url: String(url).slice(0, 250),
          method: (init && init.method) || 'GET',
        })
      } catch {
        /* ignore */
      }
      return origFetch.apply(this, arguments)
    }
  }
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__capUrl = String(url).slice(0, 250)
    this.__capMethod = String(method || 'GET')
    return origOpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function () {
    try {
      if (this.__capUrl)
        captured.push({ type: 'xhr', url: this.__capUrl, method: this.__capMethod })
    } catch {
      /* ignore */
    }
    return origSend.apply(this, arguments)
  }
  try {
    const btn =
      document.querySelector('.DRE-topic-editor-draft-save') ||
      document.querySelector('[class*=draft-save]') ||
      document.querySelector('[class*=save]')
    if (!btn) return { ok: false, error: '保存按钮未找到', captured }
    btn.click()
    await new Promise((r) => setTimeout(r, 4000))
    window.fetch = origFetch
    XMLHttpRequest.prototype.open = origOpen
    XMLHttpRequest.prototype.send = origSend
    return { ok: true, captured }
  } catch (err) {
    window.fetch = origFetch
    XMLHttpRequest.prototype.open = origOpen
    XMLHttpRequest.prototype.send = origSend
    return { ok: false, error: (err && err.message) || String(err), captured }
  }
}

// 豆瓣：页面内调用 API（用 XHR 与 axios 同机制，跨域兼容），返回响应前 2000 字符
// args: [url, method, bodyStr, csrfToken, contentType]
async function doubanApi(url, method, bodyStr, csrfToken, contentType) {
  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest()
      xhr.open(method || 'GET', url, true)
      xhr.withCredentials = true
      if (contentType) xhr.setRequestHeader('Content-Type', contentType)
      else if (bodyStr) xhr.setRequestHeader('Content-Type', 'application/json')
      if (csrfToken) xhr.setRequestHeader('X-CSRF-TOKEN', csrfToken)
      xhr.onload = () =>
        resolve({
          ok: true,
          status: xhr.status,
          text: String(xhr.responseText || '').slice(0, 2000),
        })
      xhr.onerror = () => resolve({ ok: false, error: 'XHR error' })
      xhr.send(bodyStr || null)
    } catch (err) {
      resolve({ ok: false, error: (err && err.message) || String(err) })
    }
  })
}

// 豆瓣：页面内 fetch 任意 URL 并搜索关键词（绕过 CDN/WAF 对 SW fetch 的 418 拦截）
// 页面内搜索后只返回匹配片段（避免 executeScript 大字符串序列化失败）
// args: [url, method, bodyStr, keyword]；bodyStr 以 json: 前缀表示 JSON body
async function doubanFetch(url, method, bodyStr, keyword) {
  try {
    const opts = { method: method || 'GET', credentials: 'include' }
    let kw = keyword
    if (bodyStr) {
      if (bodyStr.startsWith('json:')) {
        opts.headers = { 'Content-Type': 'application/json' }
        opts.body = bodyStr.slice(5)
        kw = keyword
      } else {
        opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
        opts.body = bodyStr
      }
    }
    const resp = await fetch(url, opts)
    const text = await resp.text()
    const hits = []
    if (kw) {
      let i = -1
      let count = 0
      while ((i = text.indexOf(kw, i + 1)) !== -1 && count < 8) {
        hits.push(text.slice(Math.max(0, i - 80), i + 160))
        count++
      }
    }
    return { ok: true, status: resp.status, len: text.length, hits, head: text.slice(0, 200) }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

/* ── pageOp 派发 ──────────────────────────────────────────────────────
 * 23 个 op 名一个都不能少（名字是冻结契约）；表里的函数都会被注入页面执行，
 * 只有 readActiveTab 允许 tabId 为空——那时由本层替它定位标签页。
 * 这里刻意不排队、不缓存 tabId、不做去重：桥超时后会换新 id 重发，op 必须可安全重放。 */
const PAGE_OPS = {
  toutiaoPublish,
  xhsSaveDraft,
  xhsUploadPermit,
  douyinPublish,
  neteaseGetToken,
  smzdmGetToken,
  readActiveTab,
  xhsReadDrafts,
  xhsDeleteDraft,
  pageProbe,
  pageReadScripts,
  woshipmProbeEditor,
  probePageDom,
  probePagePerf,
  pageFetch,
  doubanFetch,
  doubanProbeEditor,
  doubanSaveProbe,
  doubanFillAndSave,
  doubanWebpackProbe,
  doubanApi,
  doubanPerf,
  doubanReadDraftBox,
}

/** readActiveTab 的 tabId 为空时：先按 args[0] 当 URL 模式找，再退到最后聚焦窗口的活动标签页 */
async function resolveActiveTabId(urlPattern) {
  if (typeof urlPattern === 'string' && urlPattern) {
    try {
      const hit = (await tabsQuery(urlPattern)).find((t) => typeof t.id === 'number')
      if (hit) return hit.id
    } catch {
      /* 不是合法的 match pattern（例如传的是 CSS 选择器）就继续往下找 */
    }
  }
  const filters = [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
  ]
  for (const filter of filters) {
    try {
      const list = await chrome.tabs.query(filter)
      const hit = (Array.isArray(list) ? list : []).find((t) => t && typeof t.id === 'number')
      if (hit) return hit.id
    } catch {
      /* 换下一种查法 */
    }
  }
  return null
}

async function pageOp(params) {
  const tabId = typeof params.tabId === 'number' ? params.tabId : null
  const op = typeof params.op === 'string' ? params.op : ''
  const args = Array.isArray(params.args) ? params.args : []
  const fn = PAGE_OPS[op]
  if (typeof fn !== 'function') throw new Error(`未知的页面操作 op：${op || '(缺失)'}`)

  let target = tabId
  if (target === null) {
    if (op !== 'readActiveTab') {
      throw new Error(`页面操作 ${op} 需要 tabId（只有 readActiveTab 允许为空）`)
    }
    target = await resolveActiveTabId(args[0])
    if (target === null) throw new Error('找不到可用于 readActiveTab 的标签页：请先打开目标页面')
  }

  const injected = await chrome.scripting.executeScript({
    target: { tabId: target },
    world: 'MAIN',
    func: fn,
    args: args,
  })
  const result = injected && injected.length ? injected[0].result : undefined
  if (result === undefined) {
    console.warn(
      `[proxy] op ${op} 没有拿到可序列化的结果（注入函数可能抛错或返回了不可序列化的值）`,
    )
  }
  // 页面函数统一返回 {success:false,error}; 在这里抛出，文案会原样变成引擎侧 Error.message
  if (result && typeof result === 'object' && result.success === false) {
    throw new Error(
      typeof result.error === 'string' && result.error ? result.error : `页面操作 ${op} 未成功`,
    )
  }
  return result
}

// ===== cookies：桥侧代读 =====
// getAllCookies 走「域后缀」语义（整站盘点，含 HttpOnly）；getCookie 走「主机精确」语义
// （剥掉前导点后拼 https://<domain>/，靠 URL 匹配 cookie 的作用域），两者不可互换。
async function getAllCookies(params) {
  const domain = String((params && params.domain) || '').replace(/^\.+/, '')
  const list = await chrome.cookies.getAll({ domain: domain })
  return (Array.isArray(list) ? list : []).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    session: !!c.session,
    expirationDate: c.expirationDate,
    sameSite: c.sameSite,
  }))
}

async function getCookie(params) {
  const domain = String((params && params.domain) || '').replace(/^\.+/, '')
  const name = String((params && params.name) || '')
  if (!domain || !name) throw new Error('getCookie 需要 domain 与 name 两个非空参数')
  const cookie = await chrome.cookies.get({ url: `https://${domain}/`, name: name })
  return {
    value: cookie && typeof cookie.value === 'string' ? cookie.value : null,
    name: name,
    domain: domain,
  }
}

// ===== proxyFetch =====
let dnrCounter = 0

async function proxyFetch(params) {
  const { url, method, headers, bodyBase64, dnrHeaders, timeoutMs } = params
  if (!url) throw new Error('missing url')
  const body = bodyBase64 ? base64ToUint8(bodyBase64) : undefined
  const useBody = body && method !== 'GET' && method !== 'HEAD'

  let ruleId = null
  if (dnrHeaders && Object.keys(dnrHeaders).length > 0) {
    ruleId = await installDnrHeaders(dnrHeaders)
  }

  try {
    const resp = await fetch(url, {
      method: method || 'GET',
      headers: headers || {},
      body: useBody ? body : undefined,
      credentials: 'include',
      redirect: 'follow',
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    const buf = new Uint8Array(await resp.arrayBuffer())
    const respHeaders = {}
    for (const [k, v] of resp.headers.entries()) {
      respHeaders[k] = v
    }
    return {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
      bodyBase64: bytesToBase64(buf),
      finalUrl: resp.url,
      redirected: resp.redirected,
      at: Date.now(),
    }
  } finally {
    if (ruleId !== null) await removeDnrRule(ruleId)
  }
}

/* ── DNR：一条请求内临时注入 Origin/Referer 这类脚本禁改的头 ─────────────
 * 动态规则是**持久**的（跨 SW 重启与浏览器重启），所以每次安装前先删同 id，
 * 并且每条 SW 生命周期里的第一次安装会把整段 id 清一遍：万一上次 SW 在 finally
 * 之前被杀，残规则不会污染之后所有扩展 XHR。 */
const DNR_RULE_ID_BASE = 4100
const DNR_RULE_SLOTS = 8
let dnrSwept = false

function dnrRuleIds() {
  const ids = []
  for (let i = 0; i < DNR_RULE_SLOTS; i += 1) ids.push(DNR_RULE_ID_BASE + i)
  return ids
}

/** 安装一条临时规则，返回规则 id（proxyFetch 在 finally 里按它撤销；无头可注入时返回 null） */
async function installDnrHeaders(dnrHeaders) {
  const entries = Object.entries(dnrHeaders || {})
  if (!entries.length) return null
  const dnr = chrome.declarativeNetRequest
  if (!dnr || typeof dnr.updateDynamicRules !== 'function') {
    throw new Error('扩展缺少 declarativeNetRequest 权限，无法注入 Origin/Referer 等请求头')
  }
  dnrCounter = (dnrCounter + 1) % DNR_RULE_SLOTS
  const id = DNR_RULE_ID_BASE + dnrCounter
  await dnr.updateDynamicRules({
    // 同一次调用里"先删后加"：重复安装同一 id 不报错；首装时顺带清掉整段
    removeRuleIds: dnrSwept ? [id] : dnrRuleIds(),
    addRules: [
      {
        id: id,
        priority: 1,
        action: {
          type: dnr.RuleActionType.MODIFY_HEADERS,
          requestHeaders: entries.map(([header, value]) => ({
            header: header,
            operation: dnr.HeaderOperation.SET,
            value: String(value),
          })),
        },
        condition: {
          // 必须收窄到扩展自己发起的 XHR：urlFilter '*' 不加限定会去改用户正常浏览的请求头
          urlFilter: '*',
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ['xmlhttprequest'],
        },
      },
    ],
  })
  dnrSwept = true
  return id
}

/** 浏览器启动 / 扩展安装升级时清掉整段 id（残留规则会串味到其它平台） */
function sweepDnrRules() {
  const dnr = chrome.declarativeNetRequest
  if (!dnr || typeof dnr.updateDynamicRules !== 'function') return
  Promise.resolve(dnr.updateDynamicRules({ removeRuleIds: dnrRuleIds() })).catch(() => {
    /* 清不掉不影响启动，下次安装还会再清一遍 */
  })
}

chrome.runtime.onStartup.addListener(sweepDnrRules)
chrome.runtime.onInstalled.addListener(sweepDnrRules)

async function removeDnrRule(id) {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [id] })
  } catch {
    /* ignore */
  }
}

// ===== 保活 =====
const KEEPALIVE_ALARM = 'crosspost-proxy-keepalive'

/** 装闹钟前先清空：旧前缀的闹钟在已安装的浏览器里还留着，不清就会一直空转 */
function armKeepalive() {
  chrome.alarms.clearAll(() => chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }))
}

chrome.runtime.onInstalled.addListener(() => {
  armKeepalive()
  connect()
})

chrome.runtime.onStartup.addListener(() => {
  armKeepalive()
  connect()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // 保活：若 WS 断开则重连（SW 活动本身也重置空闲计时）
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect()
      return
    }
    // 在线：随保活推送心跳（2026-09-11），桥侧据此判定扩展是否真的在线
    // 2026-09-12：心跳带身份 → SW 被回收后重建也保证 clientId 已就绪
    ensureClientId().then(() => pushStatus(true))
  }
})

// ===== base64 工具 =====
function base64ToUint8(b64) {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

function bytesToBase64(bytes) {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}
