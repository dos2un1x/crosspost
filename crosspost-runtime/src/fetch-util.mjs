#!/usr/bin/env node
/**
 * 统一 fetch 超时/退避封装（质量计划 A1，2026-08-28）
 *
 * - fetchWithTimeout(url, opts, timeoutMs)：AbortController 超时，超时抛 Error('fetch timeout: <url>')
 * - fetchRetry(url, opts, { attempts, baseDelayMs, timeoutMs, retryOn })：
 *   指数退避（baseDelay×2^n）重试；默认网络错误 / 5xx 重试，4xx 不重试直接返回；
 *   retryOn(value) 回调可覆盖判定（value 为 Response 或抛出的 Error）；
 *   retryOn 显式返回 false 时该次失败不再重试。
 */

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`fetch timeout: ${url}`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function isResponse(v) {
  return v && typeof v === 'object' && typeof v.status === 'number' && typeof v.ok === 'boolean'
}

/**
 * 是否重试：默认网络错误/超时/5xx 重试，4xx 不重试；
 * retryOn(value) 传入时以其返回值为准（false = 不重试）。
 */
function shouldRetry(value, retryOn) {
  if (typeof retryOn === 'function') return retryOn(value) !== false
  if (isResponse(value)) return value.status >= 500
  return true // 网络错误/超时：默认重试
}

export async function fetchRetry(
  url,
  opts = {},
  { attempts = 3, baseDelayMs = 500, timeoutMs = 15000, retryOn } = {},
) {
  let lastErr
  for (let n = 0; n < attempts; n += 1) {
    try {
      const resp = await fetchWithTimeout(url, opts, timeoutMs)
      if (!shouldRetry(resp, retryOn)) return resp
      lastErr = new Error(`HTTP ${resp.status} for ${url}`)
    } catch (e) {
      lastErr = e
      // 网络错误/超时默认重试；retryOn 显式拒绝则不重试
      if (typeof retryOn === 'function' && retryOn(e) === false) throw e
    }
    if (n < attempts - 1) {
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** n))
    }
  }
  throw lastErr
}
