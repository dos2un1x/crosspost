// API 封装（2026-08-24 app.js 拆分 Phase 0）
// 本地 API token：同源 /proxy/bootstrap 获取，之后所有请求带 header
// 2026-09-01 P1-8：加 AbortController 超时（默认 90s，长接口显式覆盖），
//   防个别请求挂起无限 spinner；失败时透出响应体 error（不再只抛 HTTP 状态码）。
// 2026-09-19 v2.22：带上当前项目的 `X-CrossPost-Project`（切换器选择）。这是
//   **唯一收口**——所有内容域请求经此自动落到所选项目的数据源；未选项目时
//   不带该头，桥走默认路径，生产单项目行为逐字不变。
import { API } from './const.mjs'
import { activeProject } from './active-project.mjs'

let apiToken = null
/** 在飞的 token 请求（2026-09-21 v2.101）：首屏实测**发了 6 次** `/proxy/bootstrap` ——
 *  app.js 并发调多个模块的取数函数，它们都赶在第一次 token 回来之前进入 ensureToken，
 *  于是各自 fetch 一次。缓存**在飞的 Promise**（而不是只缓存结果）后恒为 1 次。 */
let tokenPromise = null

export async function ensureToken() {
  if (apiToken) return apiToken
  if (!tokenPromise) {
    tokenPromise = fetch(API + '/proxy/bootstrap')
      .then(async (resp) => {
        if (!resp.ok) throw new Error('无法获取 API token (HTTP ' + resp.status + ')')
        const d = await resp.json()
        apiToken = d.token || ''
        return apiToken
      })
      .finally(() => {
        tokenPromise = null // 失败后允许下次重试；成功时 apiToken 已命中，不会再发
      })
  }
  return tokenPromise
}

/** 统一请求：带 token header + 超时；非 2xx 时优先透出后端 error 文案 */
export async function api(path, opts = {}) {
  await ensureToken()
  const headers = { ...(opts.headers || {}), 'X-CrossPost-Token': apiToken }
  const project = activeProject()
  if (project) headers['X-CrossPost-Project'] = project
  const timeoutMs = opts.timeoutMs || 90000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(API + path, { ...opts, headers, signal: controller.signal })
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      // v2.42：把后端的错误**码**与**可读说明**都带出来。
      // 此前只 `throw new Error(body.error)`，于是 `body.message`（后端精心写的
      // 解释，如"当前接入项目未提供「一键生成」能力…"）被丢掉，
      // 使用者只看到一个 `generate_not_provided` 之类的错误码。
      // `code` 让调用方能分支处理，`message` 保证默认展示是人话。
      const err = new Error(body.message || body.error || `HTTP ${resp.status}`)
      err.code = body.error || null
      err.status = resp.status
      throw err
    }
    return resp.json()
  } catch (e) {
    if (e && e.name === 'AbortError')
      throw new Error(`请求超时(${Math.round(timeoutMs / 1000)}s): ${path}`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export const getJSON = (p, opts = {}) => api(p, opts)
export const postJSON = (p, body, opts = {}) =>
  api(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: opts.timeoutMs,
  })
