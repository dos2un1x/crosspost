// fetch-util 单元测试（node:test，零外部依赖——本地起 HTTP server）
// 运行: node --test tests/fetch-util.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fetchWithTimeout, fetchRetry } from '../src/fetch-util.mjs'

/** 启动本地 server；handler(req,res) 返回后可多次响应，用于统计请求次数 */
function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', () =>
      resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }),
    )
  })
}

test('fetchWithTimeout：正常响应', async () => {
  const { srv, url } = await startServer((req, res) => {
    res.end('hi')
  })
  try {
    const r = await fetchWithTimeout(url)
    assert.equal(r.ok, true)
    assert.equal(await r.text(), 'hi')
  } finally {
    srv.close()
  }
})

test('fetchWithTimeout：超时抛 fetch timeout', async () => {
  const { srv, url } = await startServer(() => {
    /* 永不响应 */
  })
  try {
    await assert.rejects(fetchWithTimeout(url, {}, 100), /fetch timeout: /)
  } finally {
    srv.close()
  }
})

test('fetchRetry：4xx 不重试（仅 1 次请求）', async () => {
  let calls = 0
  const { srv, url } = await startServer((req, res) => {
    calls += 1
    res.statusCode = 404
    res.end('nf')
  })
  try {
    const r = await fetchRetry(url, {}, { attempts: 3, baseDelayMs: 10 })
    assert.equal(r.status, 404)
    assert.equal(calls, 1, '4xx 不重试')
  } finally {
    srv.close()
  }
})

test('fetchRetry：5xx 退避重试至成功（2 次 500 → 200）', async () => {
  let calls = 0
  const { srv, url } = await startServer((req, res) => {
    calls += 1
    if (calls <= 2) {
      res.statusCode = 500
      res.end('err')
    } else {
      res.statusCode = 200
      res.end('ok')
    }
  })
  try {
    const r = await fetchRetry(url, {}, { attempts: 3, baseDelayMs: 10 })
    assert.equal(r.ok, true)
    assert.equal(calls, 3, '5xx 重试至成功')
  } finally {
    srv.close()
  }
})

test('fetchRetry：5xx 重试耗尽后抛错', async () => {
  let calls = 0
  const { srv, url } = await startServer((req, res) => {
    calls += 1
    res.statusCode = 502
    res.end('bad')
  })
  try {
    await assert.rejects(fetchRetry(url, {}, { attempts: 2, baseDelayMs: 10 }), /HTTP 502 for /)
    assert.equal(calls, 2, '耗尽 attempts 次请求')
  } finally {
    srv.close()
  }
})

test('fetchRetry：网络错误重试后抛错', async () => {
  // 连接一个不存在的端口（本机未监听）→ ECONNREFUSED 属网络错误，默认重试
  await assert.rejects(fetchRetry('http://127.0.0.1:1/nope', {}, { attempts: 2, baseDelayMs: 5 }))
})

test('fetchRetry：retryOn 覆盖——4xx 也重试', async () => {
  let calls = 0
  const { srv, url } = await startServer((req, res) => {
    calls += 1
    if (calls === 1) {
      res.statusCode = 429
      res.end('slow')
    } else {
      res.statusCode = 200
      res.end('ok')
    }
  })
  try {
    const r = await fetchRetry(
      url,
      {},
      { attempts: 2, baseDelayMs: 10, retryOn: (v) => v.status === 429 },
    )
    assert.equal(r.ok, true)
    assert.equal(calls, 2, 'retryOn 决定 429 也重试')
  } finally {
    srv.close()
  }
})

test('fetchRetry：retryOn 显式 false 不再重试（直接返回响应）', async () => {
  let calls = 0
  const { srv, url } = await startServer((req, res) => {
    calls += 1
    res.statusCode = 500
    res.end('err')
  })
  try {
    const r = await fetchRetry(url, {}, { attempts: 3, baseDelayMs: 5, retryOn: () => false })
    assert.equal(r.status, 500)
    assert.equal(calls, 1, 'retryOn=false 不重试，响应原样返回')
  } finally {
    srv.close()
  }
})
