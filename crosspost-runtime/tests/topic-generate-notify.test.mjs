// 选题库「一键生成」终态通知测试（2026-10-07）
//
// 需求：Console 选题库点「一键生成」跑完要发飞书通知——成功发"草稿已生成"、失败发原因。
// 这里锁死四件最容易做错的事：
//
//   ① **走项目级 notify 配置**：任务队列是全局的、跑完时当初那个请求的上下文早已结束，
//      而 `notify` 是项目级配置。测试用"引擎配置指向**诱饵**端点 + 项目覆盖层指向真端点"
//      来证明通知没有串项目（发错群是这类改造最典型的故障，且线上很难发现）。
//   ② **成功/失败都发**：失败正是无人值守时最该知道的事。
//   ③ **取消不发**：用户自己刚点的按钮，他就在 Console 前面。
//   ④ **通知是旁路**：通道没配/发送失败绝不影响任务终态，也不能把异常抛进队列。
//
// 与 topic-generate-queue.test.mjs 同样的纪律：全部路径落在临时沙箱，绝不碰生产选题库/日志/config。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createGenerateServer } from '../../examples/generate-provider-http/server.mjs'
import { MANIFEST_VERSION } from '../src/projects.mjs'

/* ── 沙箱 ─────────────────────────────────────────────────────────── */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-topic-notify-'))
const PROJECTS = path.join(SANDBOX, 'projects')
for (const d of [PROJECTS]) fs.mkdirSync(d, { recursive: true })

process.env.CROSSPOST_PROJECTS_DIR = PROJECTS
process.env.CROSSPOST_PROJECTS_DIRS = PROJECTS

const PROJECT_ID = 'p-notify'
let seq = 0
/** 每个用例一套独立的 localRoot / 引擎配置 / 日志 / 选题库：配置缓存按**路径**失效，换路径最省心 */
const envs = []

function freshEnv() {
  seq += 1
  const root = path.join(SANDBOX, `case-${seq}`)
  const local = path.join(root, 'local')
  const logs = path.join(root, 'logs')
  for (const d of [root, local, logs]) fs.mkdirSync(d, { recursive: true })
  process.env.CROSSPOST_LOCAL_ROOT = local
  process.env.CROSSPOST_LOGS_DIR = logs
  process.env.CROSSPOST_HISTORY_DIR = path.join(root, 'history')
  process.env.CROSSPOST_TOPIC_POOL = path.join(root, 'topic-pool.json')
  process.env.CROSSPOST_ARTICLES_DIR = path.join(root, 'articles')
  process.env.CROSSPOST_CONFIG = path.join(root, 'engine-config.json')
  const e = { root, local, logs }
  envs.push(e)
  return e
}

/**
 * 诱饵端点：引擎级 notify 指向它。项目覆盖层生效时它**一个请求都不该收到**——
 * 收到了就说明通知发在了"引擎默认上下文"里，也就是发错了群。
 */
function startHookServer() {
  const hits = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      try {
        hits.push(JSON.parse(body))
      } catch {
        hits.push({ raw: body })
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        hits,
        url: `http://127.0.0.1:${server.address().port}/hook`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

/** 生成提供者（成功 / 失败两种） */
async function withProvider({ fail = false } = {}) {
  const dir = path.join(SANDBOX, `gen-${(seq += 1)}`)
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(dir, 'generate.sh')
  fs.writeFileSync(
    script,
    fail
      ? '#!/bin/sh\necho "boom: 数据源连不上" >&2\nexit 3\n'
      : '#!/bin/sh\necho "[draft-id] 2099-01-01-noon-$2"\nexit 0\n',
    { mode: 0o755 },
  )
  const server = createGenerateServer({
    bin: '/bin/sh',
    args: [script],
    logsDir: path.join(dir, 'logs'),
    concurrency: 2,
    timeoutMs: 20000,
  })
  const port = await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  )
  return { server, port, close: () => new Promise((r) => server.close(r)) }
}

// CrossPost · maintained by dos2un1x · https://github.com/dos2un1x/crosspost
function writeProject(port) {
  const dir = path.join(PROJECTS, PROJECT_ID)
  fs.mkdirSync(path.join(dir, '.crosspost'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'drafts'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.crosspost', 'project.json'),
    JSON.stringify(
      {
        id: PROJECT_ID,
        name: '通知测试项目',
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

/** 引擎级 notify（诱饵）+ 项目覆盖层 notify（真端点）：只有后者该被用到 */
function writeNotifyConfig(env, { decoyUrl, projectUrl, projectNotify = true }) {
  fs.writeFileSync(
    process.env.CROSSPOST_CONFIG,
    JSON.stringify(
      { notify: { enabled: true, channel: 'webhook', webhookUrl: decoyUrl } },
      null,
      2,
    ),
  )
  const file = path.join(env.local, 'project-state', PROJECT_ID, 'config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        notify: projectNotify ? { channel: 'webhook', webhookUrl: projectUrl } : { enabled: false },
      },
      null,
      2,
    ),
  )
}

function writeTopicPool() {
  const f = path.join(PROJECTS, PROJECT_ID, 'history', 'topic-pool.json')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(
    f,
    JSON.stringify(
      {
        topics: [
          {
            id: 't-notify-1',
            date: '2099-01-01',
            slot: 'noon',
            keyword: '__notify_e2e__',
            title: '',
            score: 90,
            status: 'adopted',
            reason: '',
          },
        ],
      },
      null,
      2,
    ),
  )
}

function waitFor(fn, { timeout = 15000, step = 40 } = {}) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout
    const tick = async () => {
      if (await fn()) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(tick, step)
    }
    tick()
  })
}

/* 懒加载：env 设好之后再 import（与既有测试一致） */
const topics = await import('../../bridge/topics.mjs')
const { withProject } = await import('../src/project-context.mjs')

topics.setConfigReader(() => {
  try {
    return JSON.parse(fs.readFileSync(process.env.CROSSPOST_CONFIG, 'utf8'))
  } catch {
    return {}
  }
})

after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true })
})

/* ── 纯函数：文案 ─────────────────────────────────────────────────── */
test('通知文案：成功说清"哪个选题 / 哪份草稿 / 花了多久"，且恒草稿不自动发布', () => {
  const p = topics.buildTopicNotifyPayload(
    {
      id: 7,
      state: 'done',
      slot: 'noon',
      keyword: 'AI 眼镜进入日常',
      draftId: '2099-01-01-noon-ai-glasses',
      startedAt: '2099-01-01T00:00:00.000Z',
      finishedAt: '2099-01-01T00:02:13.000Z',
    },
    { title: '眼镜终于不烫手了' },
  )
  assert.match(p.title, /选题已生成草稿/)
  assert.match(p.summary, /栏目=noon/)
  assert.match(p.summary, /AI 眼镜进入日常/)
  assert.match(p.summary, /2099-01-01-noon-ai-glasses/)
  assert.match(p.summary, /眼镜终于不烫手了/, '有草稿标题就要带上标题，只给 id 没人看得懂')
  assert.match(p.summary, /2 分 13 秒/)
  assert.match(p.footer, /不自动发布/)
  assert.equal(p.links.length, 0)
})

test('通知文案：失败必须带上原因与日志位置（无人值守时这是唯一的线索）', () => {
  const p = topics.buildTopicNotifyPayload({
    id: 8,
    state: 'failed',
    slot: 'noon',
    keyword: '数据源挂了',
    error: '生成提供者超时',
    errorCode: 'generate_provider_timeout',
    logFile: '/tmp/x/run-noon-manual-8.log',
    logTail: 'boom: 数据源连不上',
  })
  assert.match(p.title, /选题生成失败/)
  assert.match(p.summary, /失败原因=生成提供者超时/)
  assert.match(p.summary, /generate_provider_timeout/)
  assert.match(p.summary, /run-noon-manual-8\.log/)
  assert.match(p.summary, /boom: 数据源连不上/)
  // 幂等键按任务 id 走：同一任务重复发会撞 key（飞书据此去重），不同任务不互相顶掉
  assert.match(p.idempotencyKeyBase, /^crosspost-topicgen-8$/)
})

/* ── 端到端 ───────────────────────────────────────────────────────── */
test('生成成功：真发一条通知到**项目级**端点（引擎级诱饵端点一个请求都不该收到）', async () => {
  const env = freshEnv()
  const hook = await startHookServer()
  const decoy = await startHookServer()
  const prov = await withProvider()
  try {
    writeProject(prov.port)
    writeTopicPool()
    writeNotifyConfig(env, { decoyUrl: decoy.url, projectUrl: hook.url })

    // 预置草稿文件：提供者回报的 draftId 是可预测的（脚本里是 `2099-01-01-noon-$2`），
    // 于是这条断言真正走通"按 draftId 去项目草稿目录读标题"那条 best-effort 链路，
    // 而不是只在纯函数用例里喂一个假 draft 对象。
    const draftFile = path.join(PROJECTS, PROJECT_ID, 'drafts', '2099-01-01-noon-__notify_e2e__.md')
    fs.writeFileSync(draftFile, '---\ntitle: 菜市场里的算术\n---\n\n正文\n', 'utf8')

    const started = await withProject(PROJECT_ID, () =>
      topics.startTopicGenerate('noon', '__notify_e2e__', { topicId: 't-notify-1' }),
    )
    assert.equal(started.ok, true, JSON.stringify(started))
    const taskId = started.task.id

    assert.ok(
      await waitFor(() =>
        topics.getTopicGenTasks().tasks.some((t) => t.id === taskId && t.state === 'done'),
      ),
      '任务应生成成功',
    )

    // 通知是异步的：等它落定（而不是 sleep 一个魔法数字）
    assert.ok(await waitFor(() => hook.hits.length > 0), '应在项目级端点收到一条通知')
    assert.equal(decoy.hits.length, 0, '引擎级诱饵端点收到通知 = 发错群（项目上下文丢了）')

    const body = JSON.stringify(hook.hits[0])
    assert.match(body, /__notify_e2e__/, '通知里要有选题关键词')
    assert.match(body, /栏目=noon/)
    assert.match(body, /2099-01-01-noon-__notify_e2e__/, '通知里要有草稿 id')
    assert.match(body, /菜市场里的算术/, '通知里要带上草稿标题（只给 id 没人看得懂）')

    // 任务状态接口也要能看到投递结果（Console/排障用）
    const task = topics.getTopicGenTasks().tasks.find((t) => t.id === taskId)
    assert.equal(task.notify && task.notify.status, 'ok', JSON.stringify(task.notify))
  } finally {
    await hook.close()
    await decoy.close()
    await prov.close()
  }
})

test('生成失败：照样发通知，并带上失败原因', async () => {
  const env = freshEnv()
  const hook = await startHookServer()
  const prov = await withProvider({ fail: true })
  try {
    writeProject(prov.port)
    writeTopicPool()
    writeNotifyConfig(env, { decoyUrl: 'http://127.0.0.1:1/never', projectUrl: hook.url })

    const started = await withProject(PROJECT_ID, () =>
      topics.startTopicGenerate('noon', '__notify_e2e_fail__', { topicId: 't-notify-1' }),
    )
    const taskId = started.task.id
    assert.ok(
      await waitFor(() =>
        topics.getTopicGenTasks().tasks.some((t) => t.id === taskId && t.state === 'failed'),
      ),
      '任务应失败',
    )
    assert.ok(await waitFor(() => hook.hits.length > 0), '失败也要发通知')
    const body = JSON.stringify(hook.hits[0])
    assert.match(body, /__notify_e2e_fail__/)
    assert.match(body, /失败原因=/)
  } finally {
    await hook.close()
    await prov.close()
  }
})

test('通知通道没配 / 发不出去：任务终态照常，不许把异常抛进队列', async () => {
  const env = freshEnv()
  const prov = await withProvider()
  try {
    writeProject(prov.port)
    writeTopicPool()
    // 通道留空 → sendNotify 返回 {status:'fail'}，但任务必须照常 done
    writeNotifyConfig(env, { decoyUrl: '', projectUrl: '' })

    const started = await withProject(PROJECT_ID, () =>
      topics.startTopicGenerate('noon', '__notify_e2e_nocfg__', { topicId: 't-notify-1' }),
    )
    const taskId = started.task.id
    assert.ok(
      await waitFor(() =>
        topics.getTopicGenTasks().tasks.some((t) => t.id === taskId && t.state === 'done'),
      ),
      '通知发不出去不该影响生成结果',
    )
    assert.ok(
      await waitFor(() => {
        const t = topics.getTopicGenTasks().tasks.find((x) => x.id === taskId)
        return t && t.notify
      }),
      '投递结果要如实记下来（失败也要记），不能静默',
    )
    const t = topics.getTopicGenTasks().tasks.find((x) => x.id === taskId)
    assert.equal(t.notify.status, 'fail')
    assert.match(String(t.notify.error), /webhook|webhookUrl|未配置/)
  } finally {
    await prov.close()
  }
})

test('取消不发通知：那是用户自己点的，他就在 Console 前面', async () => {
  const env = freshEnv()
  const hook = await startHookServer()
  const prov = await withProvider()
  try {
    writeProject(prov.port)
    writeTopicPool()
    writeNotifyConfig(env, { decoyUrl: '', projectUrl: hook.url })

    // 串行队列：第一条跑起来，第二条留在队列里 —— 取消它
    const first = await withProject(PROJECT_ID, () =>
      topics.startTopicGenerate('noon', '__notify_e2e_running__', { topicId: 't-notify-1' }),
    )
    const queued = await withProject(PROJECT_ID, () =>
      topics.startTopicGenerate('noon', '__notify_e2e_canceled__', { topicId: 't-notify-1' }),
    )
    assert.equal(queued.task.state, 'queued', JSON.stringify(queued))
    const canceled = await withProject(PROJECT_ID, () => topics.cancelTopicGenerate(queued.task.id))
    assert.equal(canceled.ok, true)

    // 等第一条（会发）落定，再看有没有多余的那条
    assert.ok(await waitFor(() => hook.hits.length > 0))
    await waitFor(() => false, { timeout: 300, step: 300 }) // 给"错误的那条"一点到达的时间
    const all = JSON.stringify(hook.hits)
    assert.ok(!all.includes('__notify_e2e_canceled__'), '取消不该发通知')
    const canceledTask = topics.getTopicGenTasks().tasks.find((t) => t.id === queued.task.id)
    assert.equal(canceledTask.state, 'canceled')
    assert.equal(canceledTask.notify, null, '被取消的任务不该有投递记录')
    assert.equal(hook.hits.length, 1, `只该有第一条的通知，实际 ${hook.hits.length} 条`)
    assert.ok(first.ok)
  } finally {
    await hook.close()
    await prov.close()
  }
})
