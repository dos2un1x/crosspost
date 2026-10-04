// 槽位执行器**参考实现**的契约测试（examples/slot-runner-http/server.mjs）
//
// 这个文件存在的意义：参考实现是"项目侧该长什么样"的唯一可执行说明，它一旦与
// 引擎契约漂移，接的人就会照着错的样板写。所以这里**两头都钉**：
//   · server 自己的端点语义（受理/状态/取消/互斥/退出码/鉴权）
//   · 引擎的 `callScheduleProvider()` 直接打这个 server —— 两边真的对得上
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createSlotRunner } from '../../examples/slot-runner-http/server.mjs'
import { callScheduleProvider } from '../src/schedule-provider.mjs'

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-slotrunner-'))
const LOGS = path.join(SANDBOX, 'logs')
fs.mkdirSync(LOGS, { recursive: true })

/** 假槽位脚本：按第一个参数决定行为（argv 直传，不经 shell） */
const FAKE = path.join(SANDBOX, 'fake-slot.sh')
fs.writeFileSync(
  FAKE,
  [
    '#!/bin/bash',
    'echo "slot=$1 run=$CROSSPOST_SLOT_RUN_ID runner=$CROSSPOST_SLOT_RUNNER"',
    'case "$1" in',
    '  slow) sleep 1; echo "[draft-id] draft-xyz"; exit 0 ;;',
    '  boom) echo "数据源全挂"; exit 3 ;;',
    '  ok)   echo "fine"; exit 0 ;;',
    '  *)    echo "unknown"; exit 9 ;;',
    'esac',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

// 本文件是全仓少数没有清理自己沙箱的测试之一：跑完留下 cp-slotrunner-* 目录
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }))

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  )
}

async function withRunner(opts, fn) {
  const runner = createSlotRunner({ bin: FAKE, logsDir: LOGS, workdir: SANDBOX, ...opts })
  const server = http.createServer(runner.handler)
  const port = await listen(server)
  try {
    return await fn(`http://127.0.0.1:${port}`, runner)
  } finally {
    runner.stopAll()
    await new Promise((r) => server.close(r))
  }
}

async function waitDone(base, taskId, ms = 8000) {
  const deadline = Date.now() + ms
  for (;;) {
    const r = await fetch(`${base}/slot/status?taskId=${taskId}`).then((x) => x.json())
    if (r.state !== 'running') return r
    if (Date.now() > deadline) throw new Error('任务未在预期时间内结束')
    await new Promise((r2) => setTimeout(r2, 50))
  }
}

test('参考实现①：/health 说明自己是谁（bin/workdir/在跑数）', async () => {
  await withRunner({}, async (base) => {
    const h = await fetch(`${base}/health`).then((r) => r.json())
    assert.equal(h.ok, true)
    assert.equal(h.bin, FAKE)
    assert.equal(h.running, 0)
  })
})

test('参考实现②：受理是异步的（202 + running），跑完状态端点给 exit 与 logTail', async () => {
  await withRunner({}, async (base) => {
    const res = await fetch(`${base}/slot/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'ok', date: '2026-09-25', runId: 'run-1' }),
    })
    assert.equal(res.status, 202)
    const accepted = await res.json()
    assert.equal(accepted.state, 'running')
    assert.ok(accepted.taskId)
    assert.ok(accepted.logFile)

    const done = await waitDone(base, accepted.taskId)
    assert.equal(done.state, 'done')
    assert.equal(done.exit, 0)
    assert.match(done.logTail, /slot=ok/)
    assert.match(done.logTail, /run=run-1/, 'runId 要落到项目侧日志里（对账键）')
    assert.match(done.logTail, /runner=1/, '要能区分"引擎远程发起"与本地直跑')
  })
})

test('参考实现③：非零退出码如实上报（不能把跑失败报成 done）', async () => {
  await withRunner({}, async (base) => {
    const accepted = await fetch(`${base}/slot/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'boom' }),
    }).then((r) => r.json())
    const done = await waitDone(base, accepted.taskId)
    assert.equal(done.state, 'failed')
    assert.equal(done.exit, 3, '退出码原样上报（引擎拿它记账 lastExit）')
    assert.match(done.logTail, /数据源全挂/)
  })
})

test('参考实现④：同槽位不重叠 → 409（拒绝而不是排队）', async () => {
  await withRunner({}, async (base) => {
    const first = await fetch(`${base}/slot/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'slow' }),
    })
    assert.equal(first.status, 202)
    const second = await fetch(`${base}/slot/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'slow' }),
    })
    assert.equal(second.status, 409)
    const body = await second.json()
    assert.equal(body.error, 'slot_busy')

    // 另一个槽位不受影响（互斥是**按槽位**，不是全局串行）
    const other = await fetch(`${base}/slot/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'ok' }),
    })
    assert.equal(other.status, 202)
    // 清掉 slow，别让 5s 的 sleep 拖住收尾
    const t = await first.json()
    await fetch(`${base}/slot/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: t.taskId }),
    })
  })
})

test('参考实现⑤：声明了 allowedSlots 时未知槽位 404（不静默跑错东西）', async () => {
  await withRunner({ allowedSlots: ['ok', 'tips'] }, async (base) => {
    const r = await fetch(`${base}/slot/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'nope' }),
    })
    assert.equal(r.status, 404)
    assert.equal((await r.json()).error, 'slot_unknown')
  })
})

test('参考实现⑥：非法槽位 id / 缺 slot → 400（argv 边界不能靠运气）', async () => {
  await withRunner({}, async (base) => {
    for (const body of [{}, { slot: '../etc' }, { slot: 'Bad Case' }]) {
      const r = await fetch(`${base}/slot/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(r.status, 400, `${JSON.stringify(body)} 应被拒`)
    }
  })
})

test('参考实现⑦：token 配置后未带 Bearer → 401', async () => {
  await withRunner({ token: 'secret' }, async (base) => {
    assert.equal((await fetch(`${base}/health`)).status, 401)
    const ok = await fetch(`${base}/health`, { headers: { authorization: 'Bearer secret' } })
    assert.equal(ok.status, 200)
  })
})

test('参考实现⑧：`[draft-id]` 会被捡出来（定时轮也可能产出草稿）', async () => {
  await withRunner({}, async (base) => {
    const accepted = await fetch(`${base}/slot/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'slow' }),
    }).then((r) => r.json())
    const done = await waitDone(base, accepted.taskId, 9000)
    assert.equal(done.draftId, 'draft-xyz')
  })
})

test('契约对接：引擎的 callScheduleProvider 直接打这个参考实现，两边对得上', async () => {
  await withRunner({}, async (base) => {
    const provider = {
      provided: true,
      kind: 'http',
      url: `${base}/slot/run`,
      statusUrl: `${base}/slot/status`,
      requestUrl: `${base}/slot/run`,
      requestStatusUrl: `${base}/slot/status`,
      timeoutMs: 2000,
      pollIntervalMs: 250,
      overallTimeoutMs: 8000,
      tokenEnv: null,
      projectId: 'p',
      source: '测试',
    }
    const ok = await callScheduleProvider(provider, {
      slot: 'ok',
      date: '2026-09-25',
      runId: 'r-e2e',
      deadlineMs: Date.now() + 8000,
    })
    assert.equal(ok.ok, true)
    assert.equal(ok.exit, 0)

    const bad = await callScheduleProvider(provider, { slot: 'boom', runId: 'r-e2e-2' })
    assert.equal(bad.ok, false, '参考实现报 failed 时，引擎必须拿到 ok:false')
    assert.equal(bad.exit, 3, '退出码要穿过引擎这一层，供 journal 记账')
  })
})
