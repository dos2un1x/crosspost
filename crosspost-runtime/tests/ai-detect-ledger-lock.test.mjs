// 台账跨进程锁的单测（2026-10-10）——`addUsage` 的读-改-写必须整体互斥
//
// 为什么单独留这条：台账是**预算的唯一依据**。`addUsage` 是"读台账 → 加一笔 → 原子写回"，
// 单看写是原子的（tmp+rename），但两个进程同时"读到旧值 → 各加一笔 → 各自写回"时，
// 后写的会覆盖先写的 —— 计数凭空少一笔，预算就算多了，可能超支。
// 并发补检会天天踩到（那条链路已按你的要求去掉，但"两处同时检测"本身仍会发生：
// 定时链路与手工会话撞车、或另一个 agent 同时在跑），所以锁与这条测试都留着。
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-ledger-lock-'))
const LOCAL = path.join(TMP, 'local')
fs.mkdirSync(LOCAL, { recursive: true })
const AI_DETECT = fileURLToPath(new URL('../src/ai-detect.mjs', import.meta.url))

const env = {
  ...process.env,
  CROSSPOST_LOCAL_ROOT: LOCAL,
  CROSSPOST_PROJECT: '',
  /* 4 个进程同时抢一把锁：满载机器（套件 8 路并行）上 3s 的等待上限会被调度抖动顶穿，
   * 触发"抢不到就降级无锁"→ 少记一笔 → 用例报红。这里给足窗口，被测的仍是**真锁**。 */
  CROSSPOST_LEDGER_LOCK_TIMEOUT_MS: '20000',
}
const ledgerPath = path.join(LOCAL, 'ai-detect-usage.json')
const readCalls = () => {
  if (!fs.existsSync(ledgerPath)) return 0
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).calls || 0
}

/** 起一个子进程，往台账里记 N 笔（每笔都走 addUsage 的读-改-写） */
function worker(n) {
  const script = `import(${JSON.stringify(AI_DETECT)}).then((m) => {
    for (let i = 0; i < ${n}; i++) m.addUsage(100, new Date(), 1, 'test-key')
  })`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))))
  })
}

test('addUsage：4 个进程各记 25 笔 → 台账正好 100 笔（无锁会少记）', async () => {
  await Promise.all([worker(25), worker(25), worker(25), worker(25)])
  assert.equal(readCalls(), 100, '并发读-改-写丢了计数（锁没生效）')
  // 顺带确认锁文件已释放：残留会让后续检测白等（陈旧锁 10s 才被接管）
  assert.equal(fs.existsSync(`${ledgerPath}.lock`), false, '锁文件该在写完时释放')
})

test('addUsage：单进程串行同样准确（回归：加锁没改变普通路径）', async () => {
  const before = readCalls()
  await worker(5)
  assert.equal(readCalls() - before, 5)
})
