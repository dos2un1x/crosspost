/**
 * 常驻 CLI worker 的**寿命**回归测试（node:test，零外部依赖）
 *
 * 背景（2026-09-21 v2.100 事故）：bridge 的三个常驻 worker 用 `execFile(..., maxBuffer: 64MB)`
 * 拉起。Node 对 execFile 会按**进程整个生命周期**累计 stdout+stderr 字节（lib/child_process.js
 * 的 onChildStdout/onChildStderr），超过 maxBuffer 就 kill 子进程并回调
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` —— **调用方自己挂了 data 监听也照样计数**。
 * worker 是"故意长期存活"的进程，而每轮 Console 页面加载要过 ~0.9MB JSON，
 * 64MB ≈ 65 次加载就撞死一次；撞够 5 次后旧实现的 `failed` 把它**永久**降级为
 * "每个请求冷启动一次 cli.mjs"（≈1.2s/次），表现就是"整个 Console 不再瞬开"。
 *
 * 本文件用**假 CLI**把这条链路压到秒级、可复现：
 *   ① 先锁住病因本身（execFile + 小 maxBuffer ⇒ 常驻子进程被杀）
 *   ② 再锁住修复：换成 spawn 后，累计输出超过旧阈值 64MB 时 worker **仍然存活**
 *   ③ 锁住"可达上限但不永久残废"：连续退出进入冷却期，期间回退冷启动仍能出结果
 *
 * ②在旧实现（execFile + 64MB）下必然失败 —— 这正是它能防住本次回归的原因。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 隔离：假 CLI + 临时配置路径必须在 import cli-worker 之前设好（模块顶层求值）──────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cliworker-'))
const FAKE_CLI = path.join(TMP, 'fake-cli.mjs')
process.env.CROSSPOST_CLI_PATH = FAKE_CLI
process.env.CROSSPOST_CONFIG = path.join(TMP, 'config.json')

/** 假 CLI：--ipc 常驻并按方法决定行为；一次性模式打印 JSON（回退路径用） */
const FAKE_SRC = `
const PAD = 'x'.repeat(1024 * 1024) // 1MB：几十次请求即可越过旧的 64MB 阈值
const argv = process.argv.slice(2)
const reply = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (argv.includes('--ipc')) {
  let buf = ''
  let queue = Promise.resolve()
  process.stdin.setEncoding('utf8')
  // 关键：**串行**处理，与 cli.mjs 的 ipcLoop 同语义（queue = queue.then(...)）。
  // 若这里并发回答，车道隔离用例就测不出东西了 —— 实测第一版就是并发回答，
  // 于是"listCosts 在 reader 上"的旧路由也能通过（假通过）。
  const handle = async (req) => {
    // 模拟"处理该请求时崩溃"（用于冷却期测试）：archiveArticle 属 WRITE_METHODS → writer role
    if (String(req.method).startsWith('die') || req.method === 'archiveArticle') process.exit(3)
    // 模拟"重活占住队列"（用于车道隔离测试）：listCosts 拖 600ms 再回
    if (req.method === 'listCosts') { await sleep(600); return reply({ seq: req.seq, ok: true, slow: true }) }
    if (String(req.method).startsWith('list')) return reply({ seq: req.seq, ok: true, pad: PAD })
    return reply({ seq: req.seq, ok: true, small: true })
  }
  process.stdin.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let req = {}
      try { req = JSON.parse(line) } catch { continue }
      queue = queue.then(() => handle(req))
    }
  })
  process.stdin.on('end', () => process.exit(0))
} else {
  process.stdout.write(JSON.stringify({ ok: true, oneShot: true, method: argv[0] }) + '\\n')
}
`

let worker // 延迟 import：必须在 env 设好之后
before(async () => {
  fs.writeFileSync(FAKE_CLI, FAKE_SRC)
  fs.writeFileSync(process.env.CROSSPOST_CONFIG, JSON.stringify({}))
  worker = await import(new URL('../../bridge/cli-worker.mjs', import.meta.url).href)
})

// 常驻 worker 会占住事件循环（子进程 stdin/stdout 管道）→ 必须显式收掉，否则测试进程不退出
after(() => {
  try {
    worker?.stopWorkers()
  } catch {}
})

test('① 病因：execFile 的 maxBuffer 会杀死常驻子进程（即使调用方挂了 data 监听）', async () => {
  const child = execFile(
    process.execPath,
    [
      '-e',
      // 持续输出直到被杀（**不**处理 SIGTERM —— 要断言"被信号杀死"而不是"自己退出"）
      `let n = 0
       setInterval(() => process.stdout.write('y'.repeat(900) + '\\n'), 5)`,
    ],
    { timeout: 0, maxBuffer: 5000 },
    (err) => {
      child.__err = err
    },
  )
  let seen = 0
  child.stdout.on('data', (d) => {
    seen += d.length // 用户自己的监听：数据确实收到了，但计数照样发生
  })
  const code = await new Promise((r) => child.on('exit', (c, s) => r({ c, s })))
  assert.equal(child.__err?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  assert.ok(seen > 0, '调用方监听确实收到了数据（说明计数与监听无关）')
  assert.equal(code.s, 'SIGTERM', '子进程是被 kill() 掉的，不是自己退出')
  // 这条就是"为什么常驻 worker 不能用 execFile"的证据链；实现见 cli-worker.mjs workerSpawnOptions()
})

test('② 修复：累计输出超过旧的 64MB 阈值后，reader worker 仍存活且零重启', async () => {
  const BYTES = 1024 * 1024
  const ROUNDS = 70 // 70MB > 旧的 64MB 阈值
  for (let i = 0; i < ROUNDS; i++) {
    const r = await worker.runCli(['listArchive'], 20000)
    assert.equal(
      r.ok,
      true,
      `第 ${i + 1} 次调用应正常返回，实际：${JSON.stringify(r).slice(0, 160)}`,
    )
    assert.ok(r.pad?.length === BYTES, '假 CLI 应按约定返回 1MB 填充')
  }
  const h = worker.workersHealth().reader
  assert.equal(h.alive, true, '越过 64MB 后 worker 必须仍然存活（旧实现此处已被 maxBuffer 杀掉）')
  assert.equal(h.restarts, 0, '不应发生任何重启')
  assert.ok(
    h.outputBytes > 64 * 1024 * 1024,
    `累计输出应已越过旧阈值，实际 ${(h.outputBytes / 1048576).toFixed(1)}MB`,
  )
})

test('③ 连续退出进冷却而非永久残废：冷却期回退冷启动仍能出结果', async () => {
  // archiveArticle 属 WRITE_METHODS → writer role；假 CLI 在处理该请求时 exit(3)
  for (let i = 0; i < 5; i++) await worker.runCli(['archiveArticle'], 20000)
  const h = worker.workersHealth().writer
  assert.equal(h.coolingDown, true, '连续退出达上限后应进入冷却期（旧实现是永久 failed）')
  assert.ok(h.failedUntil > Date.now(), 'failedUntil 应为未来时间戳')
  // 冷却期：功能必须仍然可用（回退一次性 execFile），只是慢
  const r = await worker.runCli(['archiveArticle'], 20000)
  assert.equal(r.oneShot, true, '冷却期应回退冷启动并且仍拿到结果')
  // 且 health 面必须能把"降级"这件事说清楚（本次事故此前完全没有可观测面）
  for (const role of ['reader', 'costs', 'writer', 'heavy']) {
    const w = worker.workersHealth()[role]
    for (const k of ['alive', 'restarts', 'coolingDown', 'outputBytes']) {
      assert.ok(k in w, `workers.${role} 应含 ${k}`)
    }
  }
})

test('④ 车道隔离：费用解析（慢活）不得阻塞纯读', async () => {
  // 复现 2026-09-21 实测：listCosts 挂在 reader 上时，并发的 listArchive 23ms → 2.34s；
  // 启动期 prewarmCosts 7.3s 期间首次读 8.6s。listCosts 现属 costs 车道。
  const slow = worker.runCli(['listCosts'], 20000)
  const t = Date.now()
  const fast = await worker.runCli(['listArchive'], 20000)
  const fastMs = Date.now() - t
  assert.equal(fast.ok, true)
  assert.ok(fastMs < 300, `慢活不得阻塞纯读：listArchive 用了 ${fastMs}ms（同队列时会 >600ms）`)
  const slowRes = await slow
  assert.equal(slowRes.slow, true, 'listCosts 应仍能正常返回（只是慢）')
  const h = worker.workersHealth()
  assert.ok(h.costs.alive && h.reader.alive, '两条车道的 worker 都应各自存活')
})
