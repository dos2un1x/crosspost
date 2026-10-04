/**
 * 会话费用预热**分块**回归测试（node:test，零外部依赖）
 *
 * 背景（2026-09-22 v2.102.1 实测）：278 个会话整块预热要 6.5s，而 costs 车道是**串行队列** ——
 * 桥启动整块预热时，"重启后 1.2s 内调 /proxy/costs"实测要等 **7.46s**（用户开机后第一次
 * 打开报表就是这个体感）。桥侧改为每块 20 个会话循环调用后，插进来的请求最多等一块。
 *
 * 本文件钉住那条让"最多等一块"成立的性质：**`prewarmSessions({offset, limit})` 必须只处理一块**
 * （旧实现忽略参数、一次全干，在本文件下必然失败）。判据是确定性的计数断言，不用计时（不会抖）。
 *
 * 隔离：会话目录指向临时目录里的合成会话（不碰真实 209MB 会话库），
 * 会话费用缓存/索引落在临时路径。
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-prewarm-'))
const SESSIONS = path.join(TMP, 'sessions')
process.env.CROSSPOST_SESSIONS_DIRS = SESSIONS
process.env.CROSSPOST_ARTICLE_COST_FILE = path.join(TMP, 'article-cost.json')
process.env.CROSSPOST_CONFIG = path.join(TMP, 'config.json')

const N = 5
/** 合成会话：一行 assistant/message + usage（token-cost 的解析入口认这个形状） */
function seedSession(i) {
  const dir = path.join(SESSIONS, `sess-${i}`)
  fs.mkdirSync(dir, { recursive: true })
  const line = JSON.stringify({
    type: 'assistant/message',
    time: 1758000000000 + i * 60000,
    data: {
      usage: {
        inputTokens: 1000 + i,
        cacheReadTokens: 500,
        outputTokens: 200,
        reasoningTokens: 50,
      },
    },
  })
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl'), line + '\n')
}

let tc
before(async () => {
  fs.mkdirSync(SESSIONS, { recursive: true })
  fs.writeFileSync(process.env.CROSSPOST_CONFIG, JSON.stringify({}))
  for (let i = 0; i < N; i++) seedSession(i)
  tc = await import('../../crosspost-runtime/src/token-cost.mjs')
})

test('① 一块只处理 limit 个会话（旧实现忽略参数、一次全干 ⇒ 必挂）', () => {
  const r1 = tc.prewarmSessions({ offset: 0, limit: 2 })
  assert.equal(
    r1.warmed,
    2,
    `第一块应只处理 2 个，实际 ${r1.warmed}（一次全干 = 6.5s 占满 costs 车道）`,
  )
  assert.equal(r1.total, N, '应报告总会话数，供桥侧判断还要不要续块')
  assert.equal(r1.done, false, '还有剩余时 done 必须为 false')
  const r2 = tc.prewarmSessions({ offset: 2, limit: 2 })
  assert.equal(r2.warmed, 2)
  assert.equal(r2.done, false)
  const r3 = tc.prewarmSessions({ offset: 4, limit: 2 })
  assert.equal(r3.warmed, 1, '最后一块只剩 1 个')
  assert.equal(r3.done, true, '最后一块 done 必须为 true')
})

test('② 不传参数仍一次预热全部（向后兼容旧调用点）', () => {
  const r = tc.prewarmSessions()
  assert.equal(r.warmed, N)
  assert.equal(r.total, N)
  assert.equal(r.done, true)
})

test('③ 越界偏移安全收尾（done=true、不抛错）', () => {
  const r = tc.prewarmSessions({ offset: 999, limit: 20 })
  assert.equal(r.warmed, 0)
  assert.equal(r.done, true)
})

test('④ 分块预热与整块预热等价（会话费用缓存内容一致）', () => {
  const sessions = tc.listSessions()
  const byChunks = sessions.map((s) => tc.calcSessionCost(s.path))
  tc.prewarmSessions() // 再来一遍整块
  const whole = sessions.map((s) => tc.calcSessionCost(s.path))
  assert.deepEqual(byChunks, whole, '分块与整块必须给出同一份会话费用')
  assert.equal(byChunks.filter((c) => c !== null).length, N, '合成会话都应解析出费用')
})

test('⑤ 两个会话索引（2.66MB / 2.28MB）在一批里只落盘读一次（与批大小无关）', () => {
  // 改前：calcSessionCost / loadSessionEvents 每会话各读一次索引 —— 实测 278 个会话预热 5587ms，
  // 基本全是这两个 JSON 的重复解析（磁盘缓存本来是命中的）。判据取"落盘读次数"而不是耗时。
  const s0 = tc.sessionIndexStats()
  tc.prewarmSessions()
  const d1 = tc.sessionIndexStats()
  const prewarmReads = d1.reads - s0.reads
  assert.ok(
    prewarmReads <= 4,
    `预热 ${N} 个会话的索引落盘读应 ≤4 次（两个索引各 1~2 次），实际 ${prewarmReads} 次（每会话一次 = 旧实现的病）`,
  )

  const s1 = tc.sessionIndexStats()
  tc.listCosts([
    {
      id: 'a',
      date: '2026-09-01',
      slot: 'noon',
      title: 't',
      createdAt: '2026-09-01T12:00:00+08:00',
    },
  ])
  const d2 = tc.sessionIndexStats()
  assert.ok(
    d2.reads - s1.reads <= 4,
    `单篇查询的索引落盘读应 ≤4 次，实际 ${d2.reads - s1.reads} 次`,
  )
})
