/**
 * 扩展 Service Worker 的**信封层 / 平台页面操作层** loopback（假 chrome 驱动真 sw.js）
 *
 * ## 为什么要有这条测试
 *
 * 扩展层以前没有任何自动化测试：`sw.js` 从来不会被加载，桥与扩展之间的**帧字段名**、
 * **错误语义**、**op 位置参数顺序**一旦被写坏，现场表现只是"发布失败/卡 120s 后超时"，
 * 排障代价极高。这里用假 chrome + 假 WebSocket 把真实的 `sw.js` 当 ES 模块加载起来
 * （仓库既有范式：extension-options-dom.test.mjs 用 query 串绕开模块缓存），
 * 从 WS 帧这一层黑盒驱动它，钉住 8 条最容易写坏的行为：
 *
 *   ① 心跳/推送帧不带 number 型 id（带了桥就整条丢弃 → 90s 后误判离线）
 *   ② 回包字段名 `result`/`error`，成功时 error 必须 falsy；未知 method / 未知 op 必须失败
 *   ③ tabs：query 过滤无 id 项、create 的 active 真值、waitForLoad 默认 30s + 静置 1s + 清理
 *   ④ pageOp 注入契约：world='MAIN'、target.tabId、args 位置顺序原样透传
 *   ⑤ op 的 {success:false,error} 信封 → 桥侧错误帧（文案原样上抛）
 *   ⑥ DNR 临时规则安装/撤销配对，结束不残留；请求失败也要撤销
 *   ⑦ proxyFetch 回包字段（status 必须是 number，否则 Node 侧重建 Response 直接抛错）
 *   ⑧ 断线重连：3s 一次、不叠加、旧 socket 不打断新连接
 *
 * ## 覆盖不到的（必须人工）
 *
 * 真实浏览器对 `chrome.*` 的语义、真实平台站点、DNR 真实生效、MV3 真实回收时序。
 * 本机系统 Chrome 153 已忽略 `--load-extension`（extension-options-dom.test.mjs 有实测记录），
 * 所以"起真浏览器加载扩展"在这台机器上不可行，真链路只能人工在别的浏览器/用户目录上做。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SW = path.resolve(__dirname, '..', '..', 'bridge', 'chrome-proxy-extension', 'sw.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, { timeout = 2000, step = 5 } = {}) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时')
    await sleep(step)
  }
}

/** 可手动触发/计数的监听器盒 */
function listenerBox() {
  const fns = new Set()
  return {
    addListener: (fn) => fns.add(fn),
    removeListener: (fn) => fns.delete(fn),
    hasListener: (fn) => fns.has(fn),
    get size() {
      return fns.size
    },
    fire: (...args) => {
      for (const fn of [...fns]) fn(...args)
    },
  }
}

/** 假 Response：字段形状按 proxyFetch 回包需要的成员给全 */
function createResponse(body, opts = {}) {
  const status = opts.status ?? 200
  const bytes =
    body instanceof Uint8Array
      ? body
      : new TextEncoder().encode(body === undefined || body === null ? '' : String(body))
  const headers = new Map(
    Object.entries(opts.headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]),
  )
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: opts.statusText ?? 'OK',
    url: opts.url ?? 'https://stub.test/final',
    redirected: !!opts.redirected,
    headers: {
      get: (k) =>
        headers.has(String(k).toLowerCase()) ? headers.get(String(k).toLowerCase()) : null,
      has: (k) => headers.has(String(k).toLowerCase()),
      forEach: (cb) => headers.forEach((v, k) => cb(v, k)),
      entries: () => headers.entries(),
      keys: () => headers.keys(),
      [Symbol.iterator]: () => headers.entries(),
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
    async text() {
      return new TextDecoder().decode(bytes)
    },
    async json() {
      return JSON.parse(new TextDecoder().decode(bytes))
    },
  }
}

/** 内存版 IndexedDB（只实现小红书草稿用到的形状） */
/**
 * 按 MV3 的真实方式执行一个被注入的页面函数：**用源码重建**，因此它只能看见形参与页面全局。
 *
 * 这不是"更严格的测试口味"，而是浏览器的事实：`chrome.scripting.executeScript({ func })` 传的是
 * 序列化后的函数，模块作用域一律不可见。回环里若直接调用同一个函数对象，这条约束就被绕过，
 * 于是"页面 op 引用了模块级常量"这类错误全绿、只在真浏览器里炸。
 */
function injectFromSource(o) {
  const rebuilt = new Function(`return (${o.func.toString()})`)()
  return rebuilt(...(o.args || []))
}

function createFakeIndexedDB({
  dbNames = ['draft-database-v1'],
  storeNames = ['article-draft'],
} = {}) {
  const records = new Map()
  let opened = 0
  let closed = 0
  const db = {
    objectStoreNames: {
      length: storeNames.length,
      contains: (n) => storeNames.includes(n),
      item: (i) => storeNames[i],
      [Symbol.iterator]: () => storeNames[Symbol.iterator](),
    },
    close() {
      closed += 1
    },
    transaction() {
      const tx = { error: null, oncomplete: null, onerror: null, onabort: null }
      const later = (fn) => setTimeout(fn, 0)
      tx.objectStore = () => ({
        put(record) {
          records.set(record && record.draftId, structuredClone(record))
          setTimeout(() => tx.oncomplete && tx.oncomplete(), 0)
          return {}
        },
        // 读/删工具走的是同一条仓：`xhsReadDrafts` 用 getAll、`xhsDeleteDraft` 用 delete/clear。
        getAll() {
          const req = { result: [...records.values()], error: null, onsuccess: null, onerror: null }
          later(() => req.onsuccess && req.onsuccess())
          return req
        },
        delete(key) {
          const req = { result: undefined, error: null, onsuccess: null, onerror: null }
          records.delete(key)
          later(() => req.onsuccess && req.onsuccess())
          return req
        },
        clear() {
          const req = { result: undefined, error: null, onsuccess: null, onerror: null }
          records.clear()
          later(() => req.onsuccess && req.onsuccess())
          return req
        },
      })
      return tx
    },
  }
  return {
    records,
    stats: () => ({ opened, closed }),
    factory: {
      databases: async () => dbNames.map((name) => ({ name, version: 1 })),
      open: () => {
        opened += 1
        const req = {
          result: db,
          error: null,
          transaction: null,
          onsuccess: null,
          onerror: null,
          onblocked: null,
          onupgradeneeded: null,
        }
        setTimeout(() => req.onsuccess && req.onsuccess(), 0)
        return req
      },
    },
  }
}

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url, registry) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    this.sent = []
    this.registry = registry
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    registry.push(this)
  }

  send(text) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('WebSocket is not open')
    this.sent.push(String(text))
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    if (this.onclose) this.onclose({ code: 1000 })
  }

  /* ---- 以下是测试侧的手柄 ---- */
  open() {
    this.readyState = FakeWebSocket.OPEN
    if (this.onopen) this.onopen({})
  }

  deliver(frame) {
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame)
    if (this.onmessage) this.onmessage({ data })
  }
}

let bootSeq = 0

/**
 * 装好假世界并加载真 sw.js。
 * @param {object} opts tabs/tabStatus/cookies/storage/executeHandler/fetchHandler/dnrFail/indexedDB
 */
async function boot(opts = {}) {
  bootSeq += 1
  const saved = {
    chrome: globalThis.chrome,
    WebSocket: globalThis.WebSocket,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    self: Object.getOwnPropertyDescriptor(globalThis, 'self'),
    indexedDB: globalThis.indexedDB,
    fetch: globalThis.fetch,
    window: globalThis.window,
  }

  const sockets = []
  const tabUpdates = listenerBox()
  const state = {
    storage: { bridgeHost: '127.0.0.1', wsPort: 9539, token: '', ...(opts.storage || {}) },
    execute: [],
    dnr: [],
    dnrRules: new Map(),
    dnrFail: !!opts.dnrFail,
    tabCalls: [],
    cookieCalls: [],
    alarmCalls: [],
    timers: [],
    tabs: opts.tabs || [],
    tabStatus: opts.tabStatus || 'loading',
    cookies: opts.cookies || [],
    fetchCalls: [],
    fetchHandler: opts.fetchHandler || (() => createResponse('{"ok":true}')),
    // 默认的注入行为＝**真浏览器**：MV3 把 `func` 序列化后注入页面执行，页面函数因此只能看见
    // 自己的形参与页面全局，**看不见 Service Worker 的模块作用域**。这里用源码重建函数来复现这条
    // 约束 —— 直接 `o.func(...)` 在同一进程里跑会让"引用了模块级常量/助手"的写法永远绿，
    // 只在真浏览器里炸（2026-09-29 实测：`XHS_RECORD_TEMPLATE is not defined`）。
    executeHandler: opts.executeHandler || (async (o) => [{ result: await injectFromSource(o) }]),
  }

  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const all = { ...state.storage }
          if (keys === undefined || keys === null) return all
          if (typeof keys === 'string') return keys in all ? { [keys]: all[keys] } : {}
          if (Array.isArray(keys)) {
            const out = {}
            for (const k of keys) if (k in all) out[k] = all[k]
            return out
          }
          const out = { ...keys }
          for (const k of Object.keys(keys)) if (k in all) out[k] = all[k]
          return out
        },
        set: async (obj) => Object.assign(state.storage, obj),
        remove: async (k) => {
          delete state.storage[k]
        },
      },
    },
    runtime: {
      id: 'stub-extension-id',
      getManifest: () => ({ version: '0.2.4' }),
      onMessage: listenerBox(),
      onInstalled: listenerBox(),
      onStartup: listenerBox(),
    },
    action: { onClicked: listenerBox() },
    alarms: {
      create: (name, info) => state.alarmCalls.push({ name, info }),
      clearAll: (cb) => {
        if (cb) cb()
      },
      onAlarm: listenerBox(),
    },
    tabs: {
      query: async (q) => {
        state.tabCalls.push({ op: 'query', q })
        return state.tabs
      },
      create: async (o) => {
        state.tabCalls.push({ op: 'create', o })
        return { id: opts.newTabId ?? 900, url: undefined }
      },
      remove: async (id) => {
        state.tabCalls.push({ op: 'remove', id })
      },
      update: async (...a) => {
        state.tabCalls.push({ op: 'update', a })
      },
      get: async (id) => {
        state.tabCalls.push({ op: 'get', id })
        return { id, status: state.tabStatus }
      },
      onUpdated: tabUpdates,
    },
    windows: {
      getLastFocused: async () => ({ id: 1 }),
      update: async () => {},
    },
    scripting: {
      executeScript: async (o) => {
        state.execute.push(o)
        return state.executeHandler(o)
      },
    },
    cookies: {
      get: async (o) => {
        state.cookieCalls.push({ op: 'get', ...o })
        return state.cookies.find((c) => c.name === o.name) || null
      },
      getAll: async (o) => {
        state.cookieCalls.push({ op: 'getAll', ...o })
        return state.cookies
      },
    },
    declarativeNetRequest: {
      RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
      HeaderOperation: { SET: 'set' },
      getDynamicRules: async () => [...state.dnrRules.values()],
      updateDynamicRules: async (spec) => {
        state.dnr.push(spec)
        if (state.dnrFail) throw new Error('declarativeNetRequest 被拒绝')
        for (const id of spec.removeRuleIds || []) state.dnrRules.delete(id)
        for (const rule of spec.addRules || []) state.dnrRules.set(rule.id, rule)
      },
    },
  }

  const idb = opts.indexedDB === undefined ? createFakeIndexedDB() : opts.indexedDB
  state.indexeddb = idb

  globalThis.chrome = chrome
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url) {
      super(url, sockets)
    }
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'loopback-agent/1.0' },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'self', {
    value: globalThis,
    configurable: true,
    writable: true,
  })
  globalThis.window = globalThis
  if (idb) globalThis.indexedDB = idb.factory
  else delete globalThis.indexedDB
  globalThis.fetch = async (url, init) => {
    state.fetchCalls.push({ url: String(url), init })
    return state.fetchHandler(String(url), init || {})
  }

  const url = pathToFileURL(SW).href + `?loopback=${bootSeq}`
  await import(url)
  await waitFor(() => sockets.length > 0)

  const sock = sockets[0]
  const parse = (s) =>
    s.sent.map((t) => {
      try {
        return JSON.parse(t)
      } catch {
        return { __unparsed: t }
      }
    })
  const frames = (s = sock) => parse(s)
  const replies = (s = sock) => frames(s).filter((f) => typeof f.id === 'number')
  const pushes = (s = sock) => frames(s).filter((f) => typeof f.id !== 'number')

  return {
    state,
    chrome,
    sock,
    sockets,
    frames,
    replies,
    pushes,
    tabUpdates,
    storage: state.storage,
    /** 送一条请求帧并等它的回包 */
    async request(id, method, params, token) {
      sock.deliver({ id, method, params, token })
      await waitFor(() => replies().some((f) => f.id === id))
      return replies().find((f) => f.id === id)
    },
    async dispose() {
      globalThis.chrome = saved.chrome
      globalThis.WebSocket = saved.WebSocket
      if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator)
      else delete globalThis.navigator
      if (saved.self) Object.defineProperty(globalThis, 'self', saved.self)
      else delete globalThis.self
      if (saved.window === undefined) delete globalThis.window
      else globalThis.window = saved.window
      if (saved.indexedDB === undefined) delete globalThis.indexedDB
      else globalThis.indexedDB = saved.indexedDB
      globalThis.fetch = saved.fetch
      await sleep(0)
    },
  }
}

async function withHarness(opts, fn) {
  const h = await boot(opts)
  try {
    await fn(h)
  } finally {
    await h.dispose()
  }
}

/* ───────────────────────── ① 心跳 / 推送帧 ───────────────────────── */

test('① 心跳推送帧不带 number 型 id，且带齐桥消费的字段名', async () => {
  await withHarness({}, async (h) => {
    h.sock.open()
    await waitFor(() => h.frames().length >= 1)
    const push = h.pushes()[0]
    assert.equal('id' in push, false, '推送帧带了 id —— 桥会拿它去匹配 pending，匹配不到就整条丢弃')
    assert.equal(push.type, 'proxy-status')
    assert.equal(push.connected, true)
    assert.equal(typeof push.at, 'number')
    assert.equal(typeof push.clientId, 'string')
    assert.ok(push.clientId.length > 0 && push.clientId.length <= 12, 'clientId 必须是 12 字符以内')
    assert.equal(push.ua, 'loopback-agent/1.0')
    assert.equal(push.version, '0.2.4', 'version 必须是 manifest 的 x.y.z')

    // 保活 alarm（30s）到点也要推一次心跳，同样不能带 id
    const before = h.frames().length
    h.chrome.alarms.onAlarm.fire({ name: 'crosspost-proxy-keepalive' })
    await waitFor(() => h.frames().length > before)
    const alarmPush = h.pushes().pop()
    assert.equal('id' in alarmPush, false)
    assert.equal(alarmPush.connected, true)
  })
})

/* ───────────────────────── ② 回包字段与错误语义 ───────────────────────── */

test('② 回包字段名/成功时 error falsy；未知 method 与未知 op 都必须是失败', async () => {
  await withHarness({}, async (h) => {
    h.sock.open()
    const ok = await h.request(1, 'ping', {})
    assert.deepEqual(Object.keys(ok).sort(), ['id', 'result'])
    assert.equal(ok.error, undefined, '成功回包不能带真值 error')
    assert.equal(ok.result.pong, true)

    const bad = await h.request(2, 'no-such-method', {})
    assert.equal('result' in bad, false)
    assert.equal(typeof bad.error.message, 'string')
    assert.ok(bad.error.message.length > 0, 'error.message 必填且非空')
    assert.ok(bad.error.message.includes('no-such-method'))

    const badOp = await h.request(3, 'pageOp', { tabId: 7, op: 'no-such-op', args: [] })
    assert.ok(badOp.error && badOp.error.message.includes('no-such-op'))
    assert.equal(h.state.execute.length, 0, '未知 op 不能走到注入')

    // 垃圾帧：非 JSON / 非对象 / id 不是 number → 静默丢弃，不回错误帧
    const before = h.replies().length
    h.sock.deliver('{not json')
    h.sock.deliver({ id: '1', method: 'ping' })
    h.sock.deliver({ method: 'ping' })
    h.sock.deliver(42)
    await sleep(30)
    assert.equal(h.replies().length, before, '垃圾帧必须静默丢弃（回错误帧会被桥当推送丢掉）')
  })
})

test('②b token 只有"本地配了非空且不一致"才拒绝；空 token 不是拒绝理由', async () => {
  await withHarness({ storage: { token: 'local-secret' } }, async (h) => {
    h.sock.open()
    const denied = await h.request(11, 'ping', {}, 'wrong')
    assert.equal(denied.error.code, 403)
    assert.equal(typeof denied.error.message, 'string')
    const allowed = await h.request(12, 'ping', {}, 'local-secret')
    assert.equal(allowed.error, undefined)
  })
  await withHarness({ storage: { token: '' } }, async (h) => {
    h.sock.open()
    const allowed = await h.request(13, 'ping', {}) // 桥带了 token，扩展没配 → 放行
    assert.equal(allowed.error, undefined)
  })
})

test('②c 结果无法 JSON 化时必须改回错误帧（不能静默不发）', async () => {
  const circular = { success: true }
  circular.self = circular
  await withHarness({ executeHandler: () => [{ result: circular }] }, async (h) => {
    h.sock.open()
    const f = await h.request(21, 'pageOp', { tabId: 5, op: 'pageProbe', args: [] })
    assert.ok(f.error && f.error.message.length > 0)
    assert.equal('result' in f, false)
  })
})

/* ───────────────────────── ③ tabs ───────────────────────── */

test('③ tabsQuery 过滤无 id 项；tabsCreate 的 active 缺省为后台打开', async () => {
  await withHarness(
    {
      tabs: [
        { id: 11, url: 'https://creator.xiaohongshu.com/publish' },
        { url: 'https://creator.xiaohongshu.com/other' }, // 没有 id → 必须滤掉
        { id: 12, url: 'https://creator.xiaohongshu.com/second' },
      ],
    },
    async (h) => {
      h.sock.open()
      const q = await h.request(31, 'tabsQuery', { url: 'https://creator.xiaohongshu.com/*' })
      assert.deepEqual(q.result, [
        { id: 11, url: 'https://creator.xiaohongshu.com/publish' },
        { id: 12, url: 'https://creator.xiaohongshu.com/second' },
      ])
      const created = await h.request(32, 'tabsCreate', { url: 'https://post.smzdm.com/tougao/' })
      assert.equal(created.result.id, 900)
      const call = h.state.tabCalls.find((c) => c.op === 'create')
      assert.equal(call.o.active, false, 'active 缺省必须是后台打开')
      const active = await h.request(33, 'tabsCreate', { url: 'https://x.test/', active: 1 })
      assert.equal(active.result.id, 900)
      assert.equal(h.state.tabCalls.filter((c) => c.op === 'create').pop().o.active, true)
    },
  )
})

test('③b tabsWaitForLoad：缺省 30s、完成后再静置 1s、监听器与定时器都清掉；超时必 reject', async () => {
  const timers = []
  const cleared = []
  const realTimeout = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = (cb, ms, ...a) => {
    timers.push(ms)
    return realTimeout(cb, ms, ...a)
  }
  globalThis.clearTimeout = (t) => {
    cleared.push(t)
    return realClear(t)
  }
  try {
    await withHarness({ tabStatus: 'loading' }, async (h) => {
      h.sock.open()
      const pending = h.request(41, 'tabsWaitForLoad', { tabId: 77 })
      await sleep(20)
      assert.equal(h.tabUpdates.size, 1, '必须挂上 onUpdated 监听')
      assert.ok(timers.includes(30000), `缺省超时应是 30000ms，实际记录了 ${timers.join(',')}`)

      h.tabUpdates.fire(77, { status: 'complete' })
      await sleep(20)
      assert.equal(h.tabUpdates.size, 0, '完成分支必须 removeListener')
      assert.ok(timers.includes(1000), '完成后必须静置 1000ms')
      await await pending
      assert.equal(h.replies().find((f) => f.id === 41).id, 41)

      // 超时分支：显式小超时 → 必须 reject 且清理干净
      const beforeTimers = timers.length
      const timeoutReply = await h.request(42, 'tabsWaitForLoad', { tabId: 78, timeoutMs: 40 })
      assert.ok(timeoutReply.error, '超时必须失败，不能"超时也 resolve"')
      assert.ok(timeoutReply.error.message.length > 0)
      assert.ok(timers.slice(beforeTimers).includes(40))
      assert.equal(h.tabUpdates.size, 0, '超时分支必须 removeListener')
    })
  } finally {
    globalThis.setTimeout = realTimeout
    globalThis.clearTimeout = realClear
  }
})

test('③c tabsWaitForLoad 对调用前就已经加载完的 tab 也能成功（先查一次当前状态）', async () => {
  await withHarness({ tabStatus: 'complete' }, async (h) => {
    h.sock.open()
    const f = await h.request(43, 'tabsWaitForLoad', { tabId: 79, timeoutMs: 5000 })
    assert.equal(f.error, undefined)
    assert.equal(h.replies().find((r) => r.id === 43).id, 43)
  })
})

test('③d tabsClose：真的调用 chrome.tabs.remove；缺 tabId 时不动浏览器', async () => {
  // 2026-09-28 测试审计：sw.js 的 dispatch 表 9 个方法里，`tabsClose` 是全仓**零覆盖**的一个
  // （PAGE_OPS 23 个 op 也只有 8 个被触达）。补上这一条，让"表里的方法都至少被验过一次"成立。
  await withHarness({ tabs: [{ id: 11, url: 'https://a.test/' }] }, async (h) => {
    h.sock.open()
    const closed = await h.request(45, 'tabsClose', { tabId: 11 })
    assert.deepEqual(closed.result, { closed: true })
    assert.deepEqual(
      h.state.tabCalls.filter((c) => c.op === 'remove').map((c) => c.id),
      [11],
    )
    const noId = await h.request(46, 'tabsClose', {})
    assert.deepEqual(noId.result, { closed: false })
    assert.equal(
      h.state.tabCalls.filter((c) => c.op === 'remove').length,
      1,
      '缺 tabId 不该去动浏览器',
    )
  })
})

/* ───────────────────────── ④⑤ pageOp 注入契约 ───────────────────────── */

test('④ pageOp：world=MAIN、target.tabId 原样、args 位置顺序原样传给页面函数', async () => {
  await withHarness({ fetchHandler: () => createResponse('{"status_code":0}') }, async (h) => {
    h.sock.open()
    const args = [
      'https://creator.douyin.com/web/api/media/upload/auth/v5/?aid=1',
      'POST',
      { creation_id: 'cid-1' },
    ]
    const r = await h.request(51, 'pageOp', { tabId: 4242, op: 'douyinPublish', args })
    assert.equal(r.error, undefined)
    // 注入函数真跑了一遍：回包就是平台自己的形状
    assert.deepEqual(r.result, { success: true, data: { status_code: 0 } })
    const call = h.state.execute[0]
    assert.equal(call.world, 'MAIN', 'MAIN world 是硬要求（CSP 下 SW 里无法重建函数）')
    assert.deepEqual(call.target, { tabId: 4242 })
    assert.equal(call.func.name, 'douyinPublish')
    assert.deepEqual(call.args, args, 'args 必须按位置原样透传')
    const post = h.state.fetchCalls[0]
    assert.equal(post.init.method, 'POST')
    assert.equal(post.init.credentials, 'include')
    assert.deepEqual(post.init.headers, { 'Content-Type': 'application/json' })
    assert.equal(post.init.body, '{"creation_id":"cid-1"}', '对象 body 必须 JSON.stringify')

    // GE 形态：args 按位置少给 → 没有 body 也没有 content-type
    const r2 = await h.request(52, 'pageOp', {
      tabId: 4242,
      op: 'douyinPublish',
      args: ['https://creator.douyin.com/get', 'GET'],
    })
    assert.equal(r2.error, undefined)
    assert.deepEqual(h.state.execute[1].args, ['https://creator.douyin.com/get', 'GET'])
    const get = h.state.fetchCalls[1]
    assert.equal(get.init.body, undefined)
    assert.equal(get.init.headers, undefined)
  })
})

test('⑤ op 回 {success:false,error} → 扩展层抛出，文案原样变成桥侧错误帧', async () => {
  await withHarness(
    {
      executeHandler: () => [
        { result: { success: false, error: '页面拒绝了这次发布（err_no=1001）' } },
      ],
    },
    async (h) => {
      h.sock.open()
      const failed = await h.request(61, 'pageOp', {
        tabId: 8,
        op: 'toutiaoPublish',
        args: ['u', 'b'],
      })
      assert.equal('result' in failed, false)
      assert.equal(failed.error.message, '页面拒绝了这次发布（err_no=1001）')
    },
  )
  // 没有 error 字段时也必须给一句能自解释的失败文案
  await withHarness({ executeHandler: () => [{ result: { success: false } }] }, async (h) => {
    h.sock.open()
    const f = await h.request(62, 'pageOp', { tabId: 8, op: 'toutiaoPublish', args: [] })
    assert.ok(f.error && f.error.message.includes('toutiaoPublish'))
  })
  // 非 readActiveTab 的 op 不允许 tabId=null（不替调用方瞎猜标签页）
  await withHarness({}, async (h) => {
    h.sock.open()
    const f = await h.request(63, 'pageOp', { tabId: null, op: 'xhsSaveDraft', args: [] })
    assert.ok(f.error, 'tabId 为空且不是 readActiveTab 时必须失败')
    assert.equal(h.state.execute.length, 0)
  })
  // readActiveTab 允许 tabId=null：退到最后聚焦窗口的活动标签页
  await withHarness(
    {
      tabs: [{ id: 5, url: 'https://a.test/' }, { url: 'no-id' }, { id: 6 }],
      // readActiveTab 的注入体要读 document（只有真浏览器里才有）：这里只钉派发侧——定位 + 原样传参
      executeHandler: () => [
        {
          result: {
            success: true,
            url: 'https://a.test/',
            title: 'T',
            htmlChunks: ['<p/>'],
            len: 3,
          },
        },
      ],
    },
    async (h) => {
      h.sock.open()
      const f = await h.request(64, 'pageOp', {
        tabId: null,
        op: 'readActiveTab',
        args: ['.article'],
      })
      assert.equal(f.error, undefined)
      assert.equal(h.state.execute[0].target.tabId, 5, 'tabId 为空时要自己定位标签页')
      assert.deepEqual(h.state.execute[0].args, ['.article'], 'args 仍要原样传给页面函数')
    },
  )
})

/* ───────────────────────── ⑥ DNR 安装/撤销配对 ───────────────────────── */

test('⑥ proxyFetch 的 dnrHeaders：临时装 → 用 → finally 撤；请求失败也要撤且不残留', async () => {
  const payload = new Uint8Array([1, 2, 3, 250])
  await withHarness(
    {
      fetchHandler: () =>
        createResponse(payload, {
          status: 200,
          statusText: 'OK',
          url: 'https://mp.toutiao.com/final',
          redirected: true,
          headers: { 'Content-Type': 'text/plain' },
        }),
    },
    async (h) => {
      h.sock.open()
      const reply = await h.request(71, 'proxyFetch', {
        url: 'https://mp.toutiao.com/api',
        method: 'GET',
        headers: { accept: '*/*' },
        bodyBase64: null,
        dnrHeaders: { Origin: 'https://mp.toutiao.com', Referer: 'https://mp.toutiao.com/' },
        timeoutMs: 0,
      })
      assert.equal(reply.error, undefined)

      // ⑦ proxyFetch 回包字段：Node 侧逐字段重建 Response，status 非 number 会直接抛错
      const res = reply.result
      assert.equal(typeof res.status, 'number')
      assert.equal(res.status, 200)
      assert.equal(res.statusText, 'OK')
      assert.equal(typeof res.headers, 'object')
      assert.equal(res.headers['content-type'], 'text/plain', 'headers 必须是小写名 → 字符串')
      assert.equal(typeof res.bodyBase64, 'string')
      assert.deepEqual(new Uint8Array(Buffer.from(res.bodyBase64, 'base64')), payload)
      assert.equal(res.finalUrl, 'https://mp.toutiao.com/final')
      assert.equal(typeof res.redirected, 'boolean')
      assert.equal(res.redirected, true)
      assert.equal(typeof res.at, 'number')

      // 安装：枚举取值 + 收窄作用域
      const install = h.state.dnr[0]
      assert.ok(install, 'dnrHeaders 非空必须装一条临时规则')
      // 本条 SW 生命周期的首装要把整段 id 先清一遍（动态规则是持久的，上次 SW 被杀的残规则会串味）
      assert.deepEqual(
        install.removeRuleIds,
        [4100, 4101, 4102, 4103, 4104, 4105, 4106, 4107],
        '首装必须先清整段 id',
      )
      const rule = install.addRules[0]
      assert.ok(install.removeRuleIds.includes(rule.id), '安装的 id 必须落在清扫段内')
      assert.equal(rule.action.type, 'modifyHeaders', '必须取 RuleActionType 枚举，不写数字字面量')
      assert.deepEqual(rule.condition.initiatorDomains, ['stub-extension-id'])
      assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest'])
      assert.deepEqual(
        rule.action.requestHeaders.map((x) => [x.header, x.operation, x.value]),
        [
          ['Origin', 'set', 'https://mp.toutiao.com'],
          ['Referer', 'set', 'https://mp.toutiao.com/'],
        ],
      )
      // 撤销：同一个 id 被删掉，且动态规则表回到空
      const remove = h.state.dnr[1]
      assert.deepEqual(remove.removeRuleIds, [rule.id], 'finally 必须按安装时返回的 id 撤销')
      assert.equal(remove.addRules, undefined)
      assert.equal(
        h.state.dnrRules.size,
        0,
        '发布结束后动态规则不能残留（残留会污染之后所有扩展 XHR）',
      )
      // 浏览器启动 / 扩展安装升级时还要再清一遍整段（§4.3 的清扫）
      h.chrome.runtime.onStartup.fire()
      assert.deepEqual(
        h.state.dnr[2].removeRuleIds,
        [4100, 4101, 4102, 4103, 4104, 4105, 4106, 4107],
        'onStartup 必须清整段 DNR id',
      )
    },
  )

  // 请求失败路径：finally 依然要撤
  await withHarness(
    {
      fetchHandler: () => {
        throw new Error('network down')
      },
    },
    async (h) => {
      h.sock.open()
      const reply = await h.request(72, 'proxyFetch', {
        url: 'https://mp.toutiao.com/api',
        method: 'POST',
        headers: {},
        dnrHeaders: { Origin: 'https://mp.toutiao.com' },
        timeoutMs: 0,
      })
      assert.ok(reply.error, '网络异常必须失败')
      assert.equal(h.state.dnr.length, 2, '失败也要撤销临时规则')
      assert.equal(h.state.dnrRules.size, 0)
    },
  )

  // 安装失败 → 该次 proxyFetch 必须失败（不能"没装上就算了"继续发）
  await withHarness({ dnrFail: true }, async (h) => {
    h.sock.open()
    const reply = await h.request(73, 'proxyFetch', {
      url: 'https://mp.toutiao.com/api',
      method: 'GET',
      dnrHeaders: { Origin: 'https://mp.toutiao.com' },
    })
    assert.ok(reply.error && reply.error.message.includes('declarativeNetRequest'))
    assert.equal(h.state.fetchCalls.length, 0, '没装上就不能继续发请求')
  })
})

/* ───────────────────────── ⑧ 重连 ───────────────────────── */

test('⑧ 断线：3s 固定重连一次、不叠加；旧 socket 的 close 不打断新连接', async () => {
  const timers = []
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = (cb, ms, ...a) => {
    timers.push(ms)
    return realTimeout(cb, ms, ...a)
  }
  try {
    await withHarness({}, async (h) => {
      h.sock.open()
      await sleep(20)
      h.sock.close() // 触发 onclose
      await sleep(20)
      assert.ok(timers.includes(3000), '重连间隔应是 3000ms')
      assert.equal(h.state.dnr.length, 0)
      // 再触发一次 close 不能叠加定时器
      const n = timers.filter((t) => t === 3000).length
      h.sock.close()
      await sleep(20)
      assert.equal(timers.filter((t) => t === 3000).length, n, '已在重连中就不能再排一个')
      // 到点后必须真的重新连（新 socket 出现）
      await waitFor(() => h.sockets.length >= 2, { timeout: 4000 })
      const fresh = h.sockets[1]
      assert.equal(fresh.url, 'ws://127.0.0.1:9539')
      // 旧 socket 再 close 一次，不能把新连接的引用置空
      h.sockets[0].close()
      await sleep(20)
      fresh.open()
      await waitFor(() => h.pushes(fresh).length >= 1)
      assert.equal(h.pushes(fresh)[0].connected, true)
    })
  } finally {
    globalThis.setTimeout = realTimeout
  }
})

/* ───────────────────────── 平台 op 的事实 ───────────────────────── */

test('op：xhsSaveDraft 记录字段路径（库/仓/draftId 主键）与失败路径', async () => {
  const idb = createFakeIndexedDB()
  await withHarness({ indexedDB: idb }, async (h) => {
    h.sock.open()
    const rich = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })
    const reply = await h.request(81, 'pageOp', {
      tabId: 1,
      op: 'xhsSaveDraft',
      args: ['draft-uuid-1', '标题甲', rich, 'user-9', '1234'],
    })
    assert.equal(reply.error, undefined)
    assert.equal(reply.result.success, true)
    const rec = idb.records.get('draft-uuid-1')
    assert.ok(rec, '记录必须以 draftId 为主键写进 article-draft')
    assert.equal(rec.uid, 'user-9')
    assert.equal(typeof rec.timeStamp, 'number')
    assert.equal(rec.content.articleStore.title, '标题甲')
    assert.equal(rec.content.articleStore.articleTitle, '标题甲')
    assert.equal(rec.content.articleStore.richJson, rich, 'richJson 必须原样存，不得改写')
    assert.equal(rec.content.articleStore.wordCount, 1234)
    assert.equal(rec.content.draftStore.title, '标题甲')
    assert.equal(rec.content.draftStore.desc, '')
    assert.deepEqual(rec.content.draftStore.imgList, [])
    assert.ok('privacyInfo' in rec.content.settingStore)
    // ── 2026-09-29：记录的**完整结构**才是契约 ─────────────────────────────
    // 只写"我们自己用到的几条路径"时，草稿箱能列出记录但点「编辑」打不开。
    // 这里钉的是"平台编辑器要的那棵树在不在"，而不是某几个标量：
    assert.deepEqual(
      Object.keys(rec.content).sort(),
      [
        'articleStore',
        'contextStore',
        'draftStore',
        'publishStore',
        'settingStore',
        'shortDraftStore',
      ],
      'content 六组一个都不能少',
    )
    for (const path of [
      ['contextStore', 'coverContext', 'cover', 'frame'],
      ['contextStore', 'previewAuditContext', 'detail'],
      ['draftStore', 'video', 'frame'],
      ['draftStore', 'cover', 'frame'],
      ['settingStore', 'fileRelate'],
      ['articleStore', 'coverSetting'],
      ['shortDraftStore', 'textCardList'],
      ['publishStore', 'codec'],
    ]) {
      const leaf = path.reduce((o, k) => (o === undefined || o === null ? o : o[k]), rec.content)
      assert.ok(leaf !== undefined, `缺字段：content.${path.join('.')}`)
    }
    // 标量取自"平台自己写出的记录"（模板），不是实现自由发挥；改它必须回到真编辑器验证
    assert.equal(
      rec.content.shortDraftStore.isShort,
      true,
      '模板里的取值，改变要重新用真编辑器验证',
    )
    assert.equal(typeof rec.content.publishStore.publishType, 'number')
    assert.equal(typeof rec.content.publishStore.status, 'number')
    assert.equal(typeof rec.content.publishStore.step, 'number')
    assert.equal(typeof rec.content.publishStore.uploadState, 'number')
    // 动态值必须被覆盖（模板里是 0）
    assert.ok(
      rec.content.shortDraftStore.textCardList[0].createTime > 0 &&
        rec.content.shortDraftStore.textCardList[0].createTime === rec.timeStamp,
      'textCardList 的 createTime 要跟着本次写入的时间戳走',
    )
    assert.equal(idb.stats().closed, 1, '成功后必须关库')

    // 非数 wordCount → 0
    await h.request(82, 'pageOp', {
      tabId: 1,
      op: 'xhsSaveDraft',
      args: ['draft-uuid-2', 't', rich, 'u', 'not-a-number'],
    })
    assert.equal(idb.records.get('draft-uuid-2').content.articleStore.wordCount, 0)
  })

  // 库不存在：失败且不留下空库
  const missing = createFakeIndexedDB({ dbNames: [] })
  await withHarness({ indexedDB: missing }, async (h) => {
    h.sock.open()
    const reply = await h.request(83, 'pageOp', {
      tabId: 1,
      op: 'xhsSaveDraft',
      args: ['d', 't', '{}', 'u', 1],
    })
    assert.ok(reply.error, '库不存在的结论必须是失败')
    assert.equal(missing.stats().opened, 0, '不该为了写草稿顺手创建一个空库')
  })

  // 仓不存在：失败并关库
  const noStore = createFakeIndexedDB({ storeNames: [] })
  await withHarness({ indexedDB: noStore }, async (h) => {
    h.sock.open()
    const reply = await h.request(84, 'pageOp', {
      tabId: 1,
      op: 'xhsSaveDraft',
      args: ['d', 't', '{}', 'u', 1],
    })
    assert.ok(reply.error && reply.error.message.includes('article-draft'))
    assert.equal(noStore.stats().closed, 1, '仓不存在也要关库')
  })
})

test('op：xhsReadDrafts 对"记录里没有 textCardList"不崩（读工具必须始终可用）', async () => {
  // 2026-09-29 实测：`ss.textCardList && ss.textCardList[0] && String(...)` 在 textCardList 缺失时
  // 求值成 undefined，紧接着 `.slice()` 抛 "Cannot read properties of undefined" ——
  // 于是"读草稿清单"这个排查/验收用的工具，在遇到简化记录时整体不可用。
  const idb = createFakeIndexedDB()
  idb.records.set('draft-x', {
    draftId: 'draft-x',
    uid: 'u',
    timeStamp: 1,
    content: { articleStore: { articleTitle: '甲' }, draftStore: { title: '甲' } },
  })
  await withHarness({ indexedDB: idb }, async (h) => {
    h.sock.open()
    const reply = await h.request(85, 'pageOp', { tabId: 1, op: 'xhsReadDrafts', args: [] })
    assert.equal(reply.error, undefined, '缺分支的记录不该让读工具失败')
    assert.equal(reply.result.success, true)
    assert.equal(reply.result.count, 1)
    assert.equal(reply.result.drafts[0].textCardTextSample, '')
  })
})

test('op：xhsUploadPermit 的端点/签名头/直传/预览头；neteaseGetToken 的 code 判定', async () => {
  const calls = []
  await withHarness(
    {
      fetchHandler: (url, init) => {
        calls.push({ url, init })
        if (url.includes('/api/media/v1/upload/creator/permit')) {
          return createResponse(
            JSON.stringify({
              success: true,
              data: {
                uploadTempPermits: [
                  { uploadAddr: 'other-bucket.test', token: 'tok-0', fileIds: ['fid-0'] },
                  {
                    uploadAddr: 'ros-upload.xiaohongshu.com',
                    token: 'tok-1',
                    fileIds: ['fid-1'],
                  },
                ],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return createResponse('', {
          status: 200,
          headers: { 'x-ros-preview-url': 'https://p.test/x.jpg' },
        })
      },
    },
    async (h) => {
      globalThis._webmsxyw = (pathAndQuery) => {
        h.state.signedWith = pathAndQuery
        return { 'X-s': 's1', 'X-t': 't1', 'X-s-common': 'c1' }
      }
      h.sock.open()
      const reply = await h.request(91, 'pageOp', {
        tabId: 2,
        op: 'xhsUploadPermit',
        args: [Buffer.from([9, 8, 7]).toString('base64'), 'image/png'],
      })
      assert.equal(reply.error, undefined)
      assert.equal(reply.result.fileId, 'fid-1', '优先选 uploadAddr === ros-upload.xiaohongshu.com')
      assert.equal(reply.result.previewUrl, 'https://p.test/x.jpg')
      assert.ok(
        h.state.signedWith.startsWith('/api/media/v1/upload/creator/permit?'),
        '签名要用路径+query',
      )

      const permit = calls[0]
      assert.ok(
        permit.url.startsWith(
          'https://creator.xiaohongshu.com/api/media/v1/upload/creator/permit?',
        ),
      )
      assert.ok(permit.url.includes('biz_name=spectrum'))
      assert.ok(permit.url.includes('scene=image'))
      assert.equal(permit.init.method, 'GET')
      assert.equal(permit.init.credentials, 'include')
      assert.equal(permit.init.headers['X-s'], 's1')
      assert.equal(permit.init.headers['X-s-common'], 'c1')
      const put = calls[1]
      assert.equal(put.url, 'https://ros-upload.xiaohongshu.com/fid-1')
      assert.equal(put.init.method, 'PUT')
      assert.equal(put.init.headers.Authorization, 'tok-1')
      assert.equal(put.init.headers['x-cos-security-token'], 'tok-1')
      assert.equal(put.init.headers['Content-Type'], 'image/png')
      assert.ok(put.init.body instanceof Blob)
      delete globalThis._webmsxyw
    },
  )

  // 网易：code 必须严格等于 200（数值），token 缺失算失败
  await withHarness({}, async (h) => {
    h.sock.open()
    globalThis.neg = { getToken: async () => ({ code: 200, token: 'urs-1' }) }
    const ok = await h.request(92, 'pageOp', { tabId: 3, op: 'neteaseGetToken', args: [] })
    assert.deepEqual(ok.result, { success: true, token: 'urs-1' })
    globalThis.neg = { getToken: async () => ({ code: 401 }) }
    const bad = await h.request(93, 'pageOp', { tabId: 3, op: 'neteaseGetToken', args: [] })
    assert.ok(bad.error && bad.error.message.includes('401'))
    globalThis.neg = {}
    const absent = await h.request(94, 'pageOp', { tabId: 3, op: 'neteaseGetToken', args: [] })
    assert.ok(absent.error)
    delete globalThis.neg
  })
})

test('op：smzdmGetToken 取 body.data.token（真实回包形状）；toutiaoPublish 不按 HTTP 状态判定', async () => {
  // 夹具逐字取自 2026-09-29 的实测回包（页面上下文与扩展 SW 上下文各测一次，两边一致）：
  // 只有**一层** data。曾把改写前那句 `const data = await resp.json(); data.data.token`
  // 误读成"回包还嵌一层"，写成 body.data.data.token → 线上恒为 null（当天 smzdm 全挂）。
  await withHarness(
    {
      fetchHandler: () =>
        createResponse(
          '{"error_code":0,"error_msg":"","data":{"token":"e26a55ba2e0d1fc5078557c0eb947e3c84ebdb46f4fc63a6825cecf60072d64b"}}',
        ),
    },
    async (h) => {
      h.sock.open()
      const reply = await h.request(101, 'pageOp', { tabId: 4, op: 'smzdmGetToken', args: [] })
      assert.deepEqual(reply.result, {
        success: true,
        token: 'e26a55ba2e0d1fc5078557c0eb947e3c84ebdb46f4fc63a6825cecf60072d64b',
      })
      assert.equal(h.state.fetchCalls[0].url, 'https://post.smzdm.com/api/editor/get_token')
      assert.equal(h.state.fetchCalls[0].init.method, 'GET')
      assert.equal(h.state.fetchCalls[0].init.headers.Accept, 'application/json')
    },
  )
  // 字段缺失（token 为 null / 空串 / 类型不对）→ success:false + 回包摘要：
  // 沿用"成功 + 空 token"会让引擎侧只能报一句"取不到 CSRF token"，看不出平台回了什么。
  for (const [id, payload] of [
    [102, '{"error_code":1,"error_msg":"请先登录","data":null}'],
    [103, '{"data":{}}'],
    [104, '{"data":{"token":null}}'],
    [105, '{"data":{"token":""}}'],
  ]) {
    await withHarness({ fetchHandler: () => createResponse(payload) }, async (h) => {
      h.sock.open()
      const reply = await h.request(id, 'pageOp', { tabId: 4, op: 'smzdmGetToken', args: [] })
      assert.ok(reply.error && typeof reply.error.message === 'string', `应回失败信封：${payload}`)
      assert.match(reply.error.message, /没有下发 token/)
    })
  }
  // 反过来把"嵌两层"钉死为**不是**真实形状：真实回包只有一层 data，别再把契约写错一次。
  await withHarness(
    { fetchHandler: () => createResponse('{"data":{"data":{"token":"csrf-1"}}}') },
    async (h) => {
      h.sock.open()
      const reply = await h.request(106, 'pageOp', { tabId: 4, op: 'smzdmGetToken', args: [] })
      assert.match(String(reply.error && reply.error.message), /没有下发 token/)
    },
  )
  // 头条：非 2xx + 合法 JSON 仍按成功信封回（由调用方读 err_no）
  await withHarness(
    {
      fetchHandler: () =>
        createResponse('{"err_no":1001,"message":"boom"}', { status: 500, statusText: 'ERR' }),
    },
    async (h) => {
      h.sock.open()
      const reply = await h.request(103, 'pageOp', {
        tabId: 4,
        op: 'toutiaoPublish',
        args: ['https://mp.toutiao.com/api', 'a=1'],
      })
      assert.equal(reply.error, undefined)
      assert.deepEqual(reply.result, { success: true, data: { err_no: 1001, message: 'boom' } })
      assert.equal(h.state.fetchCalls[0].init.method, 'POST')
      assert.equal(
        h.state.fetchCalls[0].init.headers['Content-Type'],
        'application/x-www-form-urlencoded',
      )
      assert.equal(h.state.fetchCalls[0].init.body, 'a=1')
    },
  )
  // 头条：回 HTML → 失败信封里要带片段
  await withHarness(
    { fetchHandler: () => createResponse('<html>login</html>', { status: 200 }) },
    async (h) => {
      h.sock.open()
      const reply = await h.request(104, 'pageOp', {
        tabId: 4,
        op: 'toutiaoPublish',
        args: ['https://mp.toutiao.com/api', 'a=1'],
      })
      assert.ok(reply.error && reply.error.message.includes('login'))
      assert.equal(h.state.execute.length, 1)
    },
  )
})

/* ───────────────────────── cookies ───────────────────────── */

test('cookies：getCookie 用主机精确语义拼 URL，getAllCookies 走域后缀且字段更全', async () => {
  await withHarness(
    {
      cookies: [
        {
          name: 'a',
          value: '1',
          domain: 'creator.xiaohongshu.com',
          path: '/',
          secure: true,
          httpOnly: true,
          session: false,
          expirationDate: 123,
          sameSite: 'lax',
        },
      ],
    },
    async (h) => {
      h.sock.open()
      const one = await h.request(111, 'getCookie', {
        domain: '.creator.xiaohongshu.com',
        name: 'a',
      })
      assert.deepEqual(one.result, { value: '1', name: 'a', domain: 'creator.xiaohongshu.com' })
      const call = h.state.cookieCalls.find((c) => c.op === 'get')
      assert.equal(
        call.url,
        'https://creator.xiaohongshu.com/',
        'domain 要去掉前导点再拼 https URL',
      )

      const miss = await h.request(112, 'getCookie', { domain: 'a.test', name: 'nope' })
      assert.equal(miss.result.value, null)

      const bad = await h.request(113, 'getCookie', { domain: '', name: 'a' })
      assert.ok(bad.error, 'domain/name 任一为空必须失败')

      const all = await h.request(114, 'getAllCookies', { domain: '.creator.xiaohongshu.com' })
      assert.deepEqual(Object.keys(all.result[0]), [
        'name',
        'value',
        'domain',
        'path',
        'secure',
        'httpOnly',
        'session',
        'expirationDate',
        'sameSite',
      ])
      assert.equal(
        h.state.cookieCalls.filter((c) => c.op === 'getAll').pop().domain,
        'creator.xiaohongshu.com',
      )
    },
  )
})
