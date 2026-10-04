// 选题库「一键生成」任务队列契约测试（v2.111）
//
// 锁死 `bridge/topics.mjs` 从"单例任务"改成"注册表 + FIFO 队列"之后的机器可校验部分：
//   · 默认并发 1：入队 N 条严格串行，且**不再拒绝**第 2 条（旧实现直接 409）
//   · maxConcurrency=2：真的重叠（两条同时 running）
//   · 去重 / 队列容量 / 取消（排队中 vs 运行中）
//   · 一条失败不拖垮队列（后续任务照跑）
//   · 选题库回填：锁 + 歧义不写
//
// 与 generate-provider.test.mjs 同样的纪律：全部路径落在临时沙箱，
// **绝不碰生产**选题库/日志/config。
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createGenerateServer } from '../../examples/generate-provider-http/server.mjs'
import { MANIFEST_VERSION } from '../src/projects.mjs'

/* ── 沙箱 ─────────────────────────────────────────────────────────── */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-topic-queue-'))
const PROJECTS = path.join(SANDBOX, 'projects')
const LOGS = path.join(SANDBOX, 'logs')
const TOPIC_POOL = path.join(SANDBOX, 'topic-pool.json')
const HISTORY = path.join(SANDBOX, 'history')
const ARTICLES = path.join(SANDBOX, 'articles')
for (const d of [PROJECTS, LOGS, HISTORY, ARTICLES]) fs.mkdirSync(d, { recursive: true })

process.env.CROSSPOST_LOCAL_ROOT = path.join(SANDBOX, 'local')
process.env.CROSSPOST_LOGS_DIR = LOGS
process.env.CROSSPOST_HISTORY_DIR = HISTORY
process.env.CROSSPOST_TOPIC_POOL = TOPIC_POOL
process.env.CROSSPOST_PROJECTS_DIR = PROJECTS
process.env.CROSSPOST_PROJECTS_DIRS = PROJECTS
process.env.CROSSPOST_ARTICLES_DIR = ARTICLES
// 指向一个**不存在**的配置文件 → 等价于"全新安装"（并发走默认值）
process.env.CROSSPOST_CONFIG = path.join(SANDBOX, 'config-none.json')

const PROJECT_ID = 'p-queue'
const KEYWORD = (n) => `__queue_test_${n}_${Math.random().toString(36).slice(2, 8)}__`

/** 每个用例一个独立脚本 + 独立日志目录，避免互相干扰 */
let seq = 0
async function withProvider({ concurrency = 2, sleepMs = 250, fail = false } = {}) {
  seq += 1
  const dir = path.join(SANDBOX, `gen-${seq}`)
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(dir, 'generate.sh')
  fs.writeFileSync(
    script,
    fail
      ? '#!/bin/sh\nexit 3\n'
      : // 契约：脚本在 stdout 打一行 `[draft-id] <id>` 即被提供者捡取并回报给引擎。
        // 用 keyword（第 2 个参数）造 id，顺带验证"每条任务各有各的 draftId"。
        `#!/bin/sh\nsleep ${(sleepMs / 1000).toFixed(2)}\necho "[draft-id] 2099-01-01-noon-$2"\nexit 0\n`,
    { mode: 0o755 },
  )
  const server = createGenerateServer({
    bin: '/bin/sh',
    args: [script],
    logsDir: path.join(dir, 'logs'),
    concurrency,
    timeoutMs: 20000,
  })
  const port = await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  )
  return {
    server,
    port,
    close: () => new Promise((r) => server.close(r)),
  }
}

/** 把项目 manifest 指向刚起的端点 */
function writeProject(port) {
  const dir = path.join(PROJECTS, PROJECT_ID)
  fs.mkdirSync(path.join(dir, '.crosspost'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'drafts'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.crosspost', 'project.json'),
    JSON.stringify(
      {
        id: PROJECT_ID,
        name: '队列测试项目',
        manifestVersion: MANIFEST_VERSION,
        dataDir: 'drafts',
        capabilities: {
          drafts: true,
          generate: {
            kind: 'http',
            url: `http://127.0.0.1:${port}/generate`,
            statusUrl: `http://127.0.0.1:${port}/status`,
            pollIntervalMs: 250,
            overallTimeoutMs: 20000,
            timeoutMs: 5000,
          },
        },
      },
      null,
      2,
    ),
  )
  return dir
}

/** 项目级选题库（**跟着项目走**：<工作区>/history/topic-pool.json） */
function projectPoolFile() {
  return path.join(PROJECTS, PROJECT_ID, 'history', 'topic-pool.json')
}
function writePool(rows) {
  const f = projectPoolFile()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ topics: rows }, null, 2))
}
function readPool() {
  return JSON.parse(fs.readFileSync(projectPoolFile(), 'utf8')).topics
}

/* 懒加载：必须在 env 设好之后（路径按调用解析，但保持与既有测试一致的写法） */
const topics = await import('../../bridge/topics.mjs')
const { withProject } = await import('../src/project-context.mjs')

// 与桥一致地注入配置读取器（否则队列容量/并发只能吃默认值，配置项根本测不到）
topics.setConfigReader(() => {
  try {
    return JSON.parse(fs.readFileSync(process.env.CROSSPOST_CONFIG, 'utf8'))
  } catch {
    return {}
  }
})

/** 轮询直到条件成立（或超时）；返回是否成立 */
async function waitFor(fn, { timeout = 15000, step = 50 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await fn()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, step))
  }
}

const statusOf = () => withProject(PROJECT_ID, () => topics.getTopicGenStatus())
const js = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 等"真正跑完"。
 *
 * 只等 `running===0 && queued===0` **不够**：队列把下一条标成 running 与
 * `runTask` 真正收敛终态之间有一个微任务间隙，刚好卡在那一刻会读到
 * "running=0 但完成后条数还没涨"的中间态（实测踩到：断言 3 条、实际 0 条）。
 * 所以再要求"没有任何任务停在 running，且队列为空"。
 */
async function waitQuiet({ timeout = 30000 } = {}) {
  const ok = await waitFor(
    async () => {
      const st = await statusOf()
      if (st.running !== 0 || st.queued !== 0) return false
      const tasks = topics.getTopicGenTasks().tasks
      return tasks.every((t) => t.state !== 'running' && t.state !== 'queued')
    },
    { timeout },
  )
  assert.ok(ok, '队列应在超时内静默')
  return topics.getTopicGenTasks().tasks
}

beforeEach(() => {
  writePool([])
  delete process.env.CROSSPOST_TOPIC_GEN_MAX_CONCURRENCY
  // 模块状态是进程内单例：用例之间的终态任务必须清掉，否则"完成条数"断言会虚高
  topics.resetTopicGenState()
})

after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true })
})

/* ══════════════════════════════════════════════════════════════════
 * 一、默认串行：入队不再被拒
 * ══════════════════════════════════════════════════════════════════ */

test(
  '队列①：默认并发 1 —— 连入队 3 条全部被受理（旧实现第 2 条直接 409）',
  { timeout: 60000 },
  async () => {
    const p = await withProvider({ sleepMs: 300 })
    writeProject(p.port)
    try {
      const kws = [KEYWORD(1), KEYWORD(2), KEYWORD(3)]
      const rs = kws.map((kw) =>
        withProject(PROJECT_ID, () => topics.startTopicGenerate('noon', kw)),
      )
      for (const [i, r] of rs.entries()) {
        assert.equal(r.ok, true, `第 ${i + 1} 条应受理，实际 ${JSON.stringify(r)}`)
        assert.ok(r.task && r.task.id, '必须回任务 id（Console 靠它显示排队位次）')
      }
      // 第 1 条直接开跑，第 2/3 条排队 —— 位次是 1-based
      assert.equal(rs[0].task.state, 'running', '并发 1 时第 1 条应立即开跑')
      assert.equal(rs[1].task.state, 'queued')
      assert.equal(rs[2].task.state, 'queued')
      assert.equal(rs[1].position, 1, '第 2 条是队列第 1 位')
      assert.equal(rs[2].position, 2, '第 3 条是队列第 2 位')
      assert.equal(rs[0].maxConcurrency, 1, '默认并发必须是 1（真并行需项目侧先放开锁）')

      const st = await statusOf()
      assert.equal(st.maxConcurrency, 1)
      assert.equal(st.running, 1)
      assert.equal(st.queued, 2)

      // 严格串行：任何时刻 running 都不超过 1
      let maxSeen = 0
      const timer = setInterval(async () => {
        try {
          const s = await statusOf()
          maxSeen = Math.max(maxSeen, s.running)
        } catch {
          /* ignore */
        }
      }, 40)
      const tasks = await waitQuiet()
      clearInterval(timer)
      assert.equal(maxSeen, 1, `并发 1 时 running 峰值应恒为 1，实际 ${maxSeen}`)

      assert.equal(tasks.filter((t) => t.state === 'done').length, 3, '三条都应 done')
      // 每条任务各自记自己的草稿 id（不再互相覆盖）
      const drafts = new Set(tasks.map((t) => t.draftId).filter(Boolean))
      assert.equal(drafts.size, 3, '三条任务应各有各的 draftId')
    } finally {
      await p.close()
    }
  },
)

test(
  '队列②：去重 —— 同一 (slot,keyword) 在队列/运行中时拒绝重复入队',
  { timeout: 60000 },
  async () => {
    const p = await withProvider({ sleepMs: 400 })
    writeProject(p.port)
    try {
      const kw = KEYWORD(1)
      const a = withProject(PROJECT_ID, () => topics.startTopicGenerate('noon', kw))
      const b = withProject(PROJECT_ID, () => topics.startTopicGenerate('noon', kw))
      assert.equal(a.ok, true)
      assert.equal(b.error, 'already_queued', '重复点同一选题不该开出第二条任务')
      assert.ok(b.task && b.task.id, '应回既有任务，供界面提示"已在队列中"')
      assert.equal(b.task.id, a.task.id)
      await waitQuiet()
    } finally {
      await p.close()
    }
  },
)

test('队列③：失败不拖垮队列 —— 第一条失败，后续照跑', { timeout: 60000 }, async () => {
  const p = await withProvider({ fail: true, sleepMs: 50 })
  writeProject(p.port)
  try {
    const rs = [KEYWORD(1), KEYWORD(2)].map((kw) =>
      withProject(PROJECT_ID, () => topics.startTopicGenerate('noon', kw)),
    )
    for (const r of rs) assert.equal(r.ok, true)
    const tasks = await waitQuiet()
    assert.equal(tasks.filter((t) => t.state === 'failed').length, 2, '两条都应如实记为 failed')
    assert.ok(tasks[0].error, '失败必须带人话 error（不能只有错误码）')
    assert.ok(tasks[0].errorCode, '同时保留错误码，供排障')
  } finally {
    await p.close()
  }
})

test('队列④：并发 2 —— 真的重叠（不再靠项目侧串行兜底）', { timeout: 60000 }, async () => {
  const p = await withProvider({ concurrency: 2, sleepMs: 500 })
  writeProject(p.port)
  process.env.CROSSPOST_TOPIC_GEN_MAX_CONCURRENCY = '2'
  try {
    const rs = [KEYWORD(1), KEYWORD(2), KEYWORD(3)].map((kw) =>
      withProject(PROJECT_ID, () => topics.startTopicGenerate('noon', kw)),
    )
    for (const r of rs) assert.equal(r.ok, true)
    assert.equal(rs[0].task.state, 'running')
    assert.equal(rs[1].task.state, 'running', '并发 2 时第 2 条也应立刻开跑')
    assert.equal(rs[2].task.state, 'queued', '第 3 条仍应排队')

    const st = await statusOf()
    assert.equal(st.maxConcurrency, 2)
    assert.equal(st.running, 2)
    assert.equal(st.queued, 1)

    const tasks = await waitQuiet()
    assert.equal(tasks.filter((t) => t.state === 'done').length, 3)
  } finally {
    delete process.env.CROSSPOST_TOPIC_GEN_MAX_CONCURRENCY
    await p.close()
  }
})

test(
  '队列⑤：取消 —— 排队中直接出队；运行中只停止跟踪（终态不会被后到的 done 覆盖）',
  { timeout: 60000 },
  async () => {
    const p = await withProvider({ sleepMs: 600 })
    writeProject(p.port)
    try {
      const a = withProject(PROJECT_ID, () => topics.startTopicGenerate('noon', KEYWORD(1)))
      const b = withProject(PROJECT_ID, () => topics.startTopicGenerate('noon', KEYWORD(2)))
      assert.equal(b.task.state, 'queued')

      // 排队中的那条：取消后应从队列消失，且不影响运行中的那条
      const c1 = topics.cancelTopicGenerate(b.task.id)
      assert.equal(c1.ok, true)
      assert.equal(c1.wasRunning, false)
      assert.equal(c1.task.state, 'canceled')
      const stAfterCancel = await statusOf()
      assert.equal(stAfterCancel.queued, 0, '取消排队任务应立刻出队')

      // 运行中的那条：取消只停止跟踪，如实说明项目侧可能仍在跑
      const c2 = topics.cancelTopicGenerate(a.task.id)
      assert.equal(c2.ok, true)
      assert.equal(c2.wasRunning, true)
      assert.match(c2.task.error, /项目侧/)
      // 等提供者真的跑完：终态必须仍是 canceled（否则用户会看到"取消了又变成功"）
      await js(1800)
      const after = topics.getTopicGenTasks().tasks.find((t) => t.id === a.task.id)
      assert.equal(after.state, 'canceled', `终态应保持 canceled，实际 ${after.state}`)

      // 取消一条已结束的任务：拒绝并说明，不静默成功
      const c3 = topics.cancelTopicGenerate(b.task.id)
      assert.ok(c3.error, '已结束的任务不该"取消成功"')
    } finally {
      await p.close()
    }
  },
)

test('队列⑥：队列容量可配，超出即拒（不无限堆积）', { timeout: 60000 }, async () => {
  const p = await withProvider({ sleepMs: 400 })
  writeProject(p.port)
  // 队列上限 2：第 1 条 running + 第 2 条 queued = 已满，第 3 条被拒
  const cfg = path.join(SANDBOX, 'config-queue-max.json')
  fs.writeFileSync(cfg, JSON.stringify({ topicsGenerateQueueMax: 2 }))
  process.env.CROSSPOST_CONFIG = cfg
  try {
    const rs = [KEYWORD(1), KEYWORD(2), KEYWORD(3)].map((kw) =>
      withProject(PROJECT_ID, () => topics.startTopicGenerate('noon', kw)),
    )
    assert.equal(rs[0].ok, true)
    assert.equal(rs[1].ok, true)
    assert.equal(
      rs[2].error,
      'queue_full',
      `第 3 条应被队列容量拒绝，实际 ${JSON.stringify(rs[2])}`,
    )
    assert.match(rs[2].message, /队列已满/)
    await waitQuiet()
  } finally {
    process.env.CROSSPOST_CONFIG = path.join(SANDBOX, 'config-none.json')
    await p.close()
  }
})

test('队列⑦：并发上限被夹取到 [1,5]（非法配置不会把功能改坏）', { timeout: 60000 }, async () => {
  const p = await withProvider({ sleepMs: 100 })
  writeProject(p.port)
  try {
    for (const [raw, want] of [
      ['0', 1],
      ['99', 5],
      ['abc', 1],
      ['3', 3],
    ]) {
      process.env.CROSSPOST_TOPIC_GEN_MAX_CONCURRENCY = raw
      const st = await statusOf()
      assert.equal(
        st.maxConcurrency,
        want,
        `CROSSPOST_TOPIC_GEN_MAX_CONCURRENCY=${raw} 应夹取为 ${want}`,
      )
    }
  } finally {
    delete process.env.CROSSPOST_TOPIC_GEN_MAX_CONCURRENCY
    await p.close()
  }
})

/* ══════════════════════════════════════════════════════════════════
 * 二、选题库回填
 * ══════════════════════════════════════════════════════════════════ */

test(
  '回填①：按 topicId 精确回填（同 slot 同 keyword 多条时不再瞎猜）',
  { timeout: 60000 },
  async () => {
    const p = await withProvider({ sleepMs: 50 })
    writeProject(p.port)
    try {
      // 两条同 keyword 的选题（真实场景：同一天补录/重复候选），只有 id 能区分。
      // 注意：`KEYWORD(n)` 每次调用都是**新的随机串**，所以必须先取一次再复用，
      // 否则池子里的行与生成用的 keyword 根本不是同一个词（这个坑写测试时踩过）。
      const kw = KEYWORD(1)
      writePool([
        { id: 't-A', date: '2099-01-01', slot: 'noon', keyword: kw, status: 'adopted' },
        { id: 't-B', date: '2099-01-02', slot: 'noon', keyword: kw, status: 'adopted' },
      ])
      const r = withProject(PROJECT_ID, () =>
        topics.startTopicGenerate('noon', kw, { topicId: 't-B' }),
      )
      assert.equal(r.ok, true)
      await waitQuiet()
      const rows = readPool()
      assert.equal(rows.find((t) => t.id === 't-B').status, 'generated', '被指定的那条应回填')
      assert.equal(rows.find((t) => t.id === 't-A').status, 'adopted', '另一条不该被动')
    } finally {
      await p.close()
    }
  },
)

test(
  '回填②：无 topicId 且 (slot,keyword) 命中多条 → 不写（宁可少写，不可写错）',
  { timeout: 60000 },
  async () => {
    const p = await withProvider({ sleepMs: 50 })
    writeProject(p.port)
    try {
      const kw = KEYWORD(1)
      writePool([
        { id: 't-A', date: '2099-01-01', slot: 'noon', keyword: kw, status: 'adopted' },
        { id: 't-B', date: '2099-01-02', slot: 'noon', keyword: kw, status: 'adopted' },
      ])
      const r = withProject(PROJECT_ID, () => topics.startTopicGenerate('noon', kw))
      assert.equal(r.ok, true)
      await waitQuiet()
      const rows = readPool()
      assert.equal(rows.filter((t) => t.status === 'generated').length, 0, '歧义时一条都不该被改')
      const task = topics.getTopicGenTasks().tasks.find((t) => t.id === r.task.id)
      assert.match(String(task.warning), /命中多条/, '必须把歧义如实报出来，而不是静默跳过')
    } finally {
      await p.close()
    }
  },
)

test(
  '回填③：唯一命中时按 (slot,keyword) 正常回填（老路径不退化）',
  { timeout: 60000 },
  async () => {
    const p = await withProvider({ sleepMs: 50 })
    writeProject(p.port)
    try {
      const kw = KEYWORD(1)
      writePool([
        { id: 't-A', date: '2099-01-01', slot: 'noon', keyword: kw, status: 'adopted' },
        { id: 't-C', date: '2099-01-01', slot: 'noon', keyword: KEYWORD(9), status: 'adopted' },
      ])
      const r = withProject(PROJECT_ID, () => topics.startTopicGenerate('noon', kw))
      assert.equal(r.ok, true)
      await waitQuiet()
      const rows = readPool()
      const hit = rows.find((t) => t.id === 't-A')
      assert.equal(hit.status, 'generated')
      assert.ok(hit.articleId, '应写入真实 draftId')
      assert.equal(rows.find((t) => t.id === 't-C').status, 'adopted')
    } finally {
      await p.close()
    }
  },
)

test('队列⑧：未提供能力时入队被结构性拒绝（返回对象，不抛异常、不写日志）', () => {
  // 无项目上下文 + 引擎 config 无 generate.provider ⇒ 能力缺项。
  // 这条与 generate-provider.test.mjs「桥接①」同源，此处额外确认**返回对象而非 Promise**
  // —— 入队改成同步之后，调用方（HTTP 路由）不再需要 await，Console 也不会因为忘记
  // await 而拿到 undefined 再当成功处理。
  const r = topics.startTopicGenerate('noon', KEYWORD(4))
  assert.equal(r.error, 'generate_not_provided')
  assert.ok(r.message, '必须带可读说明（Console 直接展示）')
  assert.equal(r.provided, false)
})
