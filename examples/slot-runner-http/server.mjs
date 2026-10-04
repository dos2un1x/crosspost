#!/usr/bin/env node
/**
 * 「槽位执行器」HTTP 提供者 —— **参考实现**（项目侧，不属于引擎）。
 *
 * 引擎（CrossPost）只声明并调用一个 HTTP 端点；这个进程是"端点"那一侧长什么样。
 * 与 `generate-provider-http/server.mjs` 同源同风格（零依赖单文件），因为它的作用
 * 是**说明契约**，不是充当框架：任何语言、任何框架实现同样三个端点都等价。
 *
 * ## 它为什么存在（2026-09-25）
 *
 * 引擎的槽位有两条执行路径（见 `src/schedule-provider.mjs`）：
 *
 *   · 本地命令：项目在 `.crosspost/schedule.json` 里写 `command`，**基座在自己的
 *     进程/容器里 spawn 它** —— 原生形态没问题；容器化以后必然炸（linux 容器里跑
 *     不了宿主原生装的 `dsh`；2026-09-25 18:10 实测：三个原生模块加载失败、exit=1、
 *     零产出，而界面还写着"今日已跑"）。
 *   · 本文件这条路：项目在 manifest 里声明
 *         "capabilities": { "schedule": { "kind": "http", "url": "http://127.0.0.1:8788/slot/run",
 *                                          "statusUrl": "http://127.0.0.1:8788/slot/status" } }
 *     到点只是"引擎发一次 HTTP"，**脚本在项目自己的环境里跑**（该有的 dsh / python3 /
 *     局域网访问都在这一侧）。
 *
 * ## 契约（完整定义见 docs/scheduling.md §「谁来执行」）
 *
 *   POST /slot/run    {"slot","date","runId","deadlineMs","projectId","contractVersion"}
 *     → 202 {"taskId","state":"running","logFile"}             受理（异步；槽位动辄几分钟）
 *     → 200 {"taskId","state":"done","exit","durationMs",…}     同步完成
 *     → 409 {"error":"slot_busy","message"}                     同槽位已有实例在跑
 *     → 4xx/5xx {"error","message"}                             拒绝/失败
 *
 *   GET  /slot/status?taskId=xxx
 *     → 200 {"taskId","state":"running"|"done"|"failed","exit","durationMs","logFile","logTail","message"}
 *
 *   POST /slot/cancel {"taskId"}
 *     → 200 {"ok":true,"state"}        尽力而为（引擎退出时会调；未实现也只是"停止跟踪"）
 *
 *   GET  /health
 *     → 200 {"ok":true,"bin":…,"running":n}                    探活（引擎不做自动探活，给人/doctor 用）
 *
 * ## 三条纪律（与引擎侧一致）
 *
 *   ① **argv 传参，不经 shell**：`slot` 来自请求体，拼 shell 等于给自己开洞。
 *   ② **同槽位不重叠**：上一次没结束就拒绝这一次（引擎侧也有同样的保护，两层都要有
 *      —— 引擎重启后它自己的内存态会丢，而项目侧的互斥必须独立成立）。
 *   ③ **退出码如实上报**：`exit` 是引擎记账的唯一判据（`completedToday/lastExit/daysSince`），
 *      不能把"跑失败"报成 state=done。
 *
 * 启动（项目侧接线；起手骨架见 examples/writing-pipeline-template/）：
 *   SLOT_BIN=/path/to/run_once.sh PORT=8788 node server.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const LOG_TAIL_CHARS = 4000

/**
 * 建一个槽位执行器服务（测试直接 import 本函数，不必起子进程）。
 *
 * @param {{bin:string, args?:string[], token?:string|null, logsDir?:string, workdir?:string,
 *          timeoutMs?:number, allowedSlots?:string[]|null, now?:()=>number, maxTasks?:number}} opts
 */
export function createSlotRunner(opts = {}) {
  const bin = opts.bin
  if (!bin) throw new Error('createSlotRunner 需要 bin（要执行的槽位命令，不经 shell）')
  const baseArgs = Array.isArray(opts.args) ? opts.args : []
  const token = opts.token || null
  const logsDir = opts.logsDir || path.join(process.cwd(), 'logs')
  const workdir = opts.workdir || process.cwd()
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60 * 60 * 1000
  const allowedSlots =
    Array.isArray(opts.allowedSlots) && opts.allowedSlots.length
      ? opts.allowedSlots.map(String)
      : null
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const maxTasks = Number(opts.maxTasks) > 0 ? Number(opts.maxTasks) : 200

  /** taskId → 任务态 */
  const tasks = new Map()
  /** slot → taskId（同槽位互斥；引擎侧也有一层，但项目侧必须独立成立） */
  const runningBySlot = new Map()

  function send(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  }

  function authorized(req) {
    if (!token) return true
    return (req.headers.authorization || '') === `Bearer ${token}`
  }

  function readBody(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (d) => {
        raw += d
        if (raw.length > limit) {
          reject(new Error('请求体过大'))
          req.destroy()
        }
      })
      req.on('end', () => resolve(raw))
      req.on('error', reject)
    })
  }

  /** 只保留最近 maxTasks 条（长跑进程不该无限长大） */
  function pruneTasks() {
    if (tasks.size <= maxTasks) return
    for (const [id, t] of tasks) {
      if (t.state === 'running') continue
      tasks.delete(id)
      if (tasks.size <= maxTasks) break
    }
  }

  /**
   * 受理一次槽位运行。同步返回任务态（受理语义），执行在后台。
   * @returns {{error:string,message:string,status:number}|{taskId:string,state:string,logFile:string,slot:string}}
   */
  function startSlot({ slot, date, runId, deadlineMs, projectId } = {}) {
    const sid = String(slot || '').trim()
    if (!sid) return { error: 'slot_required', message: 'slot 必填', status: 400 }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(sid))
      return { error: 'slot_invalid', message: `槽位 id 非法: ${sid}`, status: 400 }
    if (allowedSlots && !allowedSlots.includes(sid))
      return {
        error: 'slot_unknown',
        message: `本执行器没有声明槽位 ${sid}（允许：${allowedSlots.join(' / ')}）`,
        status: 404,
      }
    if (runningBySlot.has(sid))
      return {
        error: 'slot_busy',
        message: `槽位 ${sid} 已有实例在跑（taskId=${runningBySlot.get(sid)}），本次拒绝而不是排队`,
        status: 409,
      }

    const taskId = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    fs.mkdirSync(logsDir, { recursive: true })
    const stamp = date ? String(date) : new Date(now()).toISOString().slice(0, 10)
    const logFile = path.join(logsDir, `slot-${sid}-${stamp}-${taskId}.log`)
    const task = {
      taskId,
      slot: sid,
      date: stamp,
      runId: runId || null,
      projectId: projectId || null,
      state: 'running',
      exit: null,
      logFile,
      logTail: '',
      draftId: null,
      message: null,
      startedAt: now(),
      finishedAt: null,
      child: null,
    }
    tasks.set(taskId, task)
    runningBySlot.set(sid, taskId)
    pruneTasks()

    // 开跑前先写一行"谁让我跑的"——排障时这一行能省掉半小时（引擎侧的 runId 是对账键）
    try {
      fs.appendFileSync(
        logFile,
        `[${new Date(task.startedAt).toISOString()}] [RUNNER] slot=${sid} date=${stamp}` +
          ` runId=${runId || '-'} projectId=${projectId || '-'}` +
          `${Number.isFinite(deadlineMs) ? ` deadlineMs=${deadlineMs}` : ''}\n`,
      )
    } catch {
      /* 日志写不进去不该挡住执行 */
    }

    // argv 传参、**不经 shell**：slot 来自请求体
    const child = spawn(bin, [...baseArgs, sid], {
      cwd: workdir,
      env: {
        ...process.env,
        // 供项目脚本识别"这次是引擎发起的远程运行"（与本地 spawn 的
        // CROSSPOST_SCHEDULED_BY 区分开；runId 用于与引擎 journal 对账）
        CROSSPOST_SLOT_RUNNER: '1',
        ...(runId ? { CROSSPOST_SLOT_RUN_ID: String(runId) } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    task.child = child

    const out = fs.createWriteStream(logFile, { flags: 'a' })
    let carry = ''
    const onChunk = (buf) => {
      out.write(buf)
      const text = buf.toString()
      task.logTail = (task.logTail + text).slice(-LOG_TAIL_CHARS)
      carry = (carry + text).slice(-512)
      const m = /^\s*\[draft-id\]\s*(\S+)\s*$/m.exec(carry)
      if (m) task.draftId = m[1]
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)

    const timer = setTimeout(() => {
      task.message = `超过 ${timeoutMs}ms 未结束，已终止`
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }, timeoutMs)

    const settle = (state, exit, message) => {
      if (task.state !== 'running') return
      clearTimeout(timer)
      task.state = state
      task.exit = Number.isInteger(exit) ? exit : null
      task.message = message || null
      task.finishedAt = now()
      task.durationMs = Math.max(0, task.finishedAt - task.startedAt)
      runningBySlot.delete(sid)
      try {
        out.end()
      } catch {
        /* ignore */
      }
    }
    child.on('error', (e) => settle('failed', null, `启动槽位命令失败: ${e.message}`))
    child.on('close', (code, signal) => {
      // 退出码如实上报：0 = done，其余（含被信号杀掉）= failed
      const exit = Number.isInteger(code) ? code : null
      if (code === 0) settle('done', 0, null)
      else
        settle(
          'failed',
          exit,
          signal ? `被信号 ${signal} 终止（exit=${exit ?? 'null'}）` : `退出码 ${exit ?? 'null'}`,
        )
    })

    return { taskId, state: 'running', logFile, slot: sid }
  }

  function viewOf(task) {
    return {
      taskId: task.taskId,
      slot: task.slot,
      state: task.state,
      exit: task.exit,
      durationMs: task.durationMs ?? null,
      logFile: task.logFile,
      logTail: task.logTail,
      draftId: task.draftId,
      message: task.message,
    }
  }

  /** 尽力而为地终止一个任务；未找到返回 not-found（引擎只"停止跟踪"，不会因此失败） */
  function cancelSlot(taskId) {
    const task = tasks.get(String(taskId || ''))
    if (!task) return { ok: false, error: 'task_not_found' }
    if (task.state === 'running' && task.child) {
      try {
        task.child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    return { ok: true, state: task.state }
  }

  /** HTTP handler（独立出来便于测试直接挂到 http.createServer） */
  function handler(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (!authorized(req)) {
      send(res, 401, { error: 'unauthorized' })
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, {
        ok: true,
        bin,
        workdir,
        running: runningBySlot.size,
        slots: allowedSlots,
        tasks: tasks.size,
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/slot/run') {
      readBody(req)
        .then((raw) => {
          let body = null
          try {
            body = JSON.parse(raw || '{}')
          } catch {
            send(res, 400, { error: 'bad_json', message: '请求体不是合法 JSON' })
            return
          }
          const r = startSlot(body || {})
          if (r.error) {
            send(res, r.status || 400, { error: r.error, message: r.message })
            return
          }
          // 缺省异步受理（槽位动辄几分钟；同步会挂在一个 HTTP 请求上）
          send(res, 202, { taskId: r.taskId, state: r.state, logFile: r.logFile })
        })
        .catch((e) => send(res, 400, { error: 'bad_request', message: String(e.message || e) }))
      return
    }

    if (req.method === 'GET' && url.pathname === '/slot/status') {
      const task = tasks.get(String(url.searchParams.get('taskId') || ''))
      if (!task) {
        send(res, 404, { error: 'task_not_found' })
        return
      }
      send(res, 200, viewOf(task))
      return
    }

    if (req.method === 'POST' && url.pathname === '/slot/cancel') {
      readBody(req)
        .then((raw) => {
          let body = null
          try {
            body = JSON.parse(raw || '{}')
          } catch {
            body = null
          }
          const r = cancelSlot(body && body.taskId)
          send(res, r.ok ? 200 : 404, r)
        })
        .catch((e) => send(res, 400, { error: 'bad_request', message: String(e.message || e) }))
      return
    }

    send(res, 404, { error: 'not_found', message: `未知端点 ${req.method} ${url.pathname}` })
  }

  function stopAll() {
    const killed = []
    for (const [slot, taskId] of runningBySlot) {
      const task = tasks.get(taskId)
      if (task && task.child) {
        try {
          task.child.kill('SIGTERM')
          killed.push(slot)
        } catch {
          /* ignore */
        }
      }
    }
    return killed
  }

  return { handler, startSlot, cancelSlot, viewOf, tasks, runningBySlot, stopAll }
}

/* ── CLI：`node server.mjs`（项目侧通常用一个 shell 脚本把它接进自己的流水线） ── */

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)

if (isMain) {
  const bin = process.env.SLOT_BIN
  if (!bin) {
    console.error('[slot-runner] 缺少 SLOT_BIN（要执行的槽位脚本，例如 run_once.sh）')
    process.exit(2)
  }
  const host = process.env.HOST || '127.0.0.1'
  const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8788
  const runner = createSlotRunner({
    bin,
    token: process.env.SLOT_TOKEN || null,
    logsDir: process.env.SLOT_LOGS_DIR || path.join(process.cwd(), 'logs', 'slot-runner'),
    workdir: process.env.SLOT_WORKDIR || process.cwd(),
    timeoutMs:
      Number(process.env.SLOT_TIMEOUT_MS) > 0 ? Number(process.env.SLOT_TIMEOUT_MS) : undefined,
    allowedSlots: process.env.SLOT_IDS
      ? process.env.SLOT_IDS.split(',').map((s) => s.trim())
      : null,
  })
  const server = http.createServer(runner.handler)
  server.listen(port, host, () => {
    console.log(`[slot-runner] listening on http://${host}:${port}  bin=${bin}`)
  })
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      const killed = runner.stopAll()
      console.log(`[slot-runner] ${sig}: 已终止 ${killed.length} 个在跑的槽位`)
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 3000).unref()
    })
  }
}
