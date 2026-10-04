/**
 * Node RuntimeInterface — CrossPost 核心的 Node 侧实现（N2 纯代理模式）
 *
 * fetch 一律经代理通道：请求规格 → 本地桥 /proxy/request → 迷你扩展用浏览器本体
 * fetch(credentials:'include') 代发（含 DNR 注入 Origin/Referer）→ 还原 Response。
 * 平台看到的来源 = 真实浏览器；cookie 由浏览器自动携带（无需本进程 cookie 快照）。
 *
 * getCookie（bilibili CSRF 等）经代理向扩展查询（chrome.cookies，含 HttpOnly）。
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { loadPaths } from './paths.mjs'
import { versionInfo } from './version.mjs'
import { readConfig } from './config-cache.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ===== FileReader 垫片（Node 无此全局） =====
class FileReader {
  constructor() {
    this.result = null
    this.onload = null
    this.onerror = null
  }
  readAsDataURL(blob) {
    Promise.resolve()
      .then(async () => {
        const buf = Buffer.from(await blob.arrayBuffer())
        const mime = blob.type || 'application/octet-stream'
        this.result = `data:${mime};base64,${buf.toString('base64')}`
        if (this.onload) this.onload({ target: this })
      })
      .catch((e) => {
        if (this.onerror) this.onerror(new Error(`FileReader error: ${e && e.message}`))
      })
  }
  readAsText(blob) {
    Promise.resolve()
      .then(async () => {
        const buf = Buffer.from(await blob.arrayBuffer())
        this.result = buf.toString('utf8')
        if (this.onload) this.onload({ target: this })
      })
      .catch(() => {})
  }
}
globalThis.FileReader = FileReader

// ===== 代理配置 =====
const DEFAULT_PROXY = { proxyHost: '127.0.0.1', proxyHttpPort: 9540, timeoutMs: 150000 }

function urlFilterMatches(filter, url) {
  if (!filter) return true
  if (filter.includes('://')) {
    const m = filter.match(/^\*?:\/\/([^/*]+)(.*)$/)
    if (m) {
      const [, hostPattern, pathPattern] = m
      let host
      try {
        host = new URL(url).hostname
      } catch {
        return false
      }
      const hostOk = host === hostPattern || host.endsWith('.' + hostPattern.replace(/^\*\./, ''))
      if (!hostOk) return false
      if (pathPattern && pathPattern !== '/*' && pathPattern !== '*') {
        const p = new URL(url).pathname
        const pat = pathPattern.replace(/\*/g, '.*').replace(/\//g, '\\/')
        if (!new RegExp('^' + pat).test(p)) return false
      }
      return true
    }
    return url.includes(filter)
  }
  return url.includes(filter)
}

// ===== FormData 序列化（代理通道用） =====
async function serializeFormData(fd) {
  const boundary = '----wcsproxy' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const chunks = []
  for (const [k, v] of fd.entries()) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"`))
    if (v instanceof Blob) {
      const name = (v.name || 'file').replace(/"/g, '')
      chunks.push(
        Buffer.from(
          `; filename="${name}"\r\nContent-Type: ${v.type || 'application/octet-stream'}\r\n\r\n`,
        ),
      )
      chunks.push(Buffer.from(await v.arrayBuffer()))
    } else {
      chunks.push(Buffer.from('\r\n\r\n'))
      chunks.push(Buffer.from(String(v)))
    }
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { buf: Buffer.concat(chunks), boundary }
}

// ===== 代理响应还原 =====
class ProxyResponse {
  constructor(spec) {
    this.status = spec.status
    this.statusText = spec.statusText || ''
    this.url = spec.finalUrl || ''
    this.redirected = !!spec.redirected
    this.ok = spec.status >= 200 && spec.status < 300
    this._headers = new Headers(spec.headers || {})
    this._buf = spec.bodyBase64 ? Buffer.from(spec.bodyBase64, 'base64') : Buffer.alloc(0)
  }
  get headers() {
    return this._headers
  }
  async json() {
    return JSON.parse(this._buf.toString('utf8'))
  }
  async text() {
    return this._buf.toString('utf8')
  }
  async arrayBuffer() {
    const ab = this._buf.buffer.slice(
      this._buf.byteOffset,
      this._buf.byteOffset + this._buf.byteLength,
    )
    return ab
  }
  async blob() {
    return new Blob([this._buf], {
      type: this._headers.get('content-type') || 'application/octet-stream',
    })
  }
  clone() {
    const headers = {}
    for (const [k, v] of this._headers.entries()) headers[k] = v
    return new ProxyResponse({
      status: this.status,
      statusText: this.statusText,
      finalUrl: this.url,
      redirected: this.redirected,
      headers,
      bodyBase64: this._buf.toString('base64'),
    })
  }
}

/**
 * 创建 Node 运行时（纯代理模式）
 * @param {object} opts { storageFile }
 */
export function createNodeRuntime(opts = {}) {
  const storageFile = opts.storageFile || null

  // ===== 代理配置加载（2026-09-01：统一走 config-cache） =====
  const proxyCfg = { ...DEFAULT_PROXY }
  Object.assign(proxyCfg, readConfig())

  // ===== 本地 API token（2026-08-24 P0-3：bridge 生成于 bridge/token.local，内部调用带 header） =====
  let apiToken = ''
  try {
    apiToken = fs.readFileSync(loadPaths().tokenFile, 'utf8').trim()
  } catch {
    /* bridge 未启动/无 token 文件：请求不带 header（bridge 会 401，proxyStatus 等轻量探测容忍） */
  }

  // ===== storage =====
  let storageData = {}
  if (storageFile && fs.existsSync(storageFile)) {
    try {
      storageData = JSON.parse(fs.readFileSync(storageFile, 'utf8'))
    } catch {
      /* ignore */
    }
  }
  function persistStorage() {
    if (!storageFile) return
    fs.mkdirSync(path.dirname(storageFile), { recursive: true })
    fs.writeFileSync(storageFile, JSON.stringify(storageData, null, 2))
  }

  // ===== session / header rules =====
  const sessionData = new Map()
  let headerRulesList = []
  let ruleIdCounter = 0

  // ===== 代理通道调用 =====
  function proxyCall(method, params) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ method, params })
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      }
      if (apiToken) headers['X-CrossPost-Token'] = apiToken
      const req = http.request(
        {
          hostname: proxyCfg.proxyHost,
          port: proxyCfg.proxyHttpPort,
          path: '/proxy/request',
          method: 'POST',
          timeout: proxyCfg.timeoutMs,
          headers,
        },
        (res) => {
          let buf = ''
          res.on('data', (c) => (buf += c))
          res.on('end', () => {
            try {
              const body = JSON.parse(buf)
              if (body.error) reject(new Error(body.error))
              else resolve(body.result)
            } catch {
              reject(new Error('proxy response parse failed: ' + buf.slice(0, 200)))
            }
          })
        },
      )
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('proxy request timeout'))
      })
      req.on('error', (e) => reject(new Error('proxy channel error: ' + e.message)))
      req.end(data)
    })
  }

  // ===== 代理模式 fetch 主体 =====
  async function proxyFetchImpl(url, options) {
    const headers = new Headers(options.headers || {})
    const specHeaders = {}
    for (const [k, v] of headers.entries()) specHeaders[k] = v

    // header 规则 → DNR 注入（Origin/Referer 等浏览器禁改头）
    const dnrHeaders = {}
    for (const rule of headerRulesList) {
      if (urlFilterMatches(rule.urlFilter, url)) Object.assign(dnrHeaders, rule.headers || {})
    }

    // body 序列化
    let bodyBase64 = null
    const body = options.body
    if (body != null && body !== '') {
      if (typeof body === 'string') {
        bodyBase64 = Buffer.from(body, 'utf8').toString('base64')
      } else if (body instanceof URLSearchParams) {
        bodyBase64 = Buffer.from(body.toString(), 'utf8').toString('base64')
      } else if (body instanceof Blob) {
        bodyBase64 = Buffer.from(await body.arrayBuffer()).toString('base64')
        if (!specHeaders['content-type'] && body.type) specHeaders['content-type'] = body.type
      } else if (body instanceof FormData) {
        const { buf, boundary } = await serializeFormData(body)
        bodyBase64 = buf.toString('base64')
        if (!specHeaders['content-type'])
          specHeaders['content-type'] = `multipart/form-data; boundary=${boundary}`
      } else if (typeof body === 'object') {
        bodyBase64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64')
        if (!specHeaders['content-type']) specHeaders['content-type'] = 'application/json'
      }
    }

    const spec = {
      url,
      method: (options.method || 'GET').toUpperCase(),
      headers: specHeaders,
      bodyBase64,
      dnrHeaders,
      timeoutMs: proxyCfg.timeoutMs,
    }
    const result = await proxyCall('proxyFetch', spec)
    if (!result || typeof result.status !== 'number')
      throw new Error('proxyFetch 返回异常: ' + JSON.stringify(result).slice(0, 200))
    return new ProxyResponse(result)
  }

  const runtime = {
    type: 'node',

    async fetch(url, options = {}) {
      return proxyFetchImpl(url, options)
    },

    // cookies API 在纯代理模式下由浏览器代管；保留空实现以兼容 RuntimeInterface 契约
    cookies: {
      async get() {
        return []
      },
      async set() {
        /* no-op */
      },
      async remove() {
        /* no-op */
      },
    },

    // 经代理向扩展查询 cookie（bilibili CSRF 等，含 HttpOnly）
    async getCookie(domain, name) {
      try {
        const result = await proxyCall('getCookie', {
          domain: String(domain || ''),
          name: String(name || ''),
        })
        return result && typeof result.value === 'string' ? result.value : null
      } catch {
        return null
      }
    },

    // 在平台页面（MAIN world）执行预定义操作（头条/小红书发布需要页面 JS 签名）
    // op 必须是扩展侧 PAGE_OPS 里预定义的操作名；args 为传给该操作的参数数组
    async pageOp(tabId, op, args) {
      const result = await proxyCall('pageOp', { tabId, op, args: args || [] })
      if (result && result.success === false) throw new Error(result.error || 'page op failed')
      return result
    },

    // tabs：查询/创建标签页、等待加载、在页面执行操作（经代理转发到扩展）
    tabs: {
      async query(url) {
        try {
          const r = await proxyCall('tabsQuery', { url: String(url) })
          return Array.isArray(r) ? r : []
        } catch {
          return []
        }
      },
      async create(url, active) {
        return proxyCall('tabsCreate', { url: String(url), active: !!active })
      },
      async waitForLoad(tabId, timeoutMs) {
        await proxyCall('tabsWaitForLoad', { tabId, timeoutMs })
      },
      async close(tabId) {
        await proxyCall('tabsClose', { tabId })
      },
    },

    storage: {
      async get(key) {
        return storageData[key] ?? null
      },
      async set(key, value) {
        storageData[key] = value
        persistStorage()
      },
      async remove(key) {
        delete storageData[key]
        persistStorage()
      },
    },

    session: {
      async get(key) {
        return sessionData.get(key) ?? null
      },
      async set(key, value) {
        sessionData.set(key, value)
      },
    },

    headerRules: {
      async add(rule) {
        ruleIdCounter += 1
        const id = `rule_${ruleIdCounter}`
        headerRulesList.push({ ...rule, id })
        return id
      },
      async remove(id) {
        headerRulesList = headerRulesList.filter((r) => r.id !== id)
      },
      async clear() {
        headerRulesList = []
      },
    },

    dom: {
      async parseHTML(html) {
        const dom = new JSDOM(html)
        return dom.window.document
      },
      querySelector(doc, selector) {
        return doc.querySelector(selector)
      },
      querySelectorAll(doc, selector) {
        return Array.from(doc.querySelectorAll(selector))
      },
      getTextContent(el) {
        return el ? el.textContent || '' : ''
      },
      getInnerHTML(el) {
        return el ? el.innerHTML : ''
      },
    },

    // 代理状态（供 CLI/工具查询）
    proxyStatus: async () => {
      const proxyHttpPort = proxyCfg.proxyHttpPort
      return new Promise((resolve) => {
        const headers = apiToken ? { 'X-CrossPost-Token': apiToken } : undefined
        const req = http.get(
          {
            hostname: proxyCfg.proxyHost,
            port: proxyHttpPort,
            path: '/proxy/status',
            timeout: 3000,
            headers,
          },
          (res) => {
            let buf = ''
            res.on('data', (c) => (buf += c))
            res.on('end', () => {
              try {
                resolve({ ...JSON.parse(buf), proxyMode: true })
              } catch {
                resolve({ connected: false, proxyMode: true, version: versionInfo() })
              }
            })
          },
        )
        req.on('error', () =>
          resolve({
            connected: false,
            proxyMode: true,
            error: 'bridge unreachable',
            version: versionInfo(),
          }),
        )
        req.on('timeout', () => {
          req.destroy()
          resolve({ connected: false, proxyMode: true, error: 'timeout', version: versionInfo() })
        })
      })
    },
  }

  return runtime
}
