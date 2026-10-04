/**
 * fetch-util.mjs 的类型声明（供 core TS 侧引用，2026-08-28 质量计划 A1）
 */
export function fetchWithTimeout(
  url: string | URL | Request,
  opts?: RequestInit,
  timeoutMs?: number,
): Promise<Response>
export function fetchRetry(
  url: string | URL | Request,
  opts?: RequestInit,
  options?: {
    attempts?: number
    baseDelayMs?: number
    timeoutMs?: number
    retryOn?: (value: Response | Error) => boolean
  },
): Promise<Response>
