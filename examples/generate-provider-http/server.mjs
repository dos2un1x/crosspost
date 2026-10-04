#!/usr/bin/env node
/**
 * 「一键生成」HTTP 提供者 —— **参考实现**（项目侧，不属于引擎）。
 *
 * 引擎（CrossPost）只声明并调用一个 HTTP 端点；这个进程是"端点"这一侧长什么样。
 * 它被刻意写成零依赖的单文件，因为它的作用是**说明契约**，不是充当框架：
 * 任何语言、任何框架实现同样的三个端点都等价。
 *
 * 契约（完整定义见 docs/integration.md §5）：
 *
 *   POST /generate        {"slot","keyword","projectId","contractVersion"}
 *     → 202 {"taskId","state":"running","logFile"}     受理（异步）
 *     → 200 {"taskId","state":"done",   "logFile","logTail"}  同步完成
 *     → 4xx/5xx {"error","message"}                    拒绝/失败
 *
 *   GET  /status?taskId=xxx
 *     → 200 {"taskId","state":"running"|"done"|"failed","logFile","logTail","message"}
 *
 *   GET  /health
 *     → 200 {"ok":true,...}                            探活（引擎不做探活，给人用）
 *
 * 为什么参考实现走**异步**：真实生成要跑几分钟到几十分钟。同步模式（一个 HTTP
 * 请求挂到跑完）在任何一个中间层（代理、容器、项目侧重启）被掐断后，引擎就
 * 不知道任务还在不在跑了。异步模式下状态在项目侧，引擎重启也能重新问。
 *
 * 启动：
 *   GENERATE_BIN=/path/to/generate.sh \
 *   GENERATE_LOGS_DIR=/path/to/logs \
 *   GENERATE_TOKEN=$(openssl rand -hex 16) \
 *   node server.mjs
 *
 * 然后在项目 manifest 里声明：
 *   "capabilities": {
 *     "generate": {
 *       "kind": "http",
 *       "url": "http://127.0.0.1:8787/generate",
 *       "statusUrl": "http://127.0.0.1:8787/status",
 *       "tokenEnv": "CROSSPOST_GENERATE_TOKEN"
 *     }
 *   }
 *
 * 安全说明：`GENERATE_BIN` 以 **argv** 方式启动（不经 shell），`slot`/`keyword`
 * 只作为参数传递，因此选题文案里出现 `;`、`$()`、反引号也不会变成命令执行。
 * 这是这个文件里最要紧的一行设计——生成端点的入参最终来自网页表单。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const LOG_TAIL_CHARS = 4000

/**
 * 建一个生成提供者服务（测试直接 import 本函数，不必起子进程）。
 * @param {{bin:string, args?:string[], token?:string|null, logsDir?:string,
 *          workdir?:string, timeoutMs?:number, concurrency?:number, now?:()=>number}} opts
 */
export function createGenerateServer(opts = {}) {
  const bin = opts.bin
  if (!bin) throw new Error('createGenerateServer 需要 bin（要执行的生成命令，不经 shell）')
  const baseArgs = Array.isArray(opts.args) ? opts.args : []
  const token = opts.token || null
  const logsDir = opts.logsDir || path.join(process.cwd(), 'logs')
  const workdir = opts.workdir || process.cwd()
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30 * 60 * 1000
  const concurrency = Number(opts.concurrency) > 0 ? Number(opts.concurrency) : 1

  /** taskId → {state, logFile, logTail, message, slot, keyword, startedAt, finishedAt} */
  const tasks = new Map()
  const running = () => [...tasks.values()].filter((t) => t.state === 'running').length

  function send(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  }

  function authorized(req) {
    if (!token) return true
    const h = req.headers.authorization || ''
    return h === `Bearer ${token}`
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

  function startTask({ slot, keyword }) {
    const taskId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    fs.mkdirSync(logsDir, { recursive: true })
    const logFile = path.join(logsDir, `generate-${slot}-${taskId}.log`)
    const task = {
      taskId,
      state: 'running',
      logFile,
      logTail: '',
      // 生成的**文章/草稿 id**（不是 taskId）。生成脚本在 stdout 打印一行
      // `[draft-id] <id>` 即可，这里捡出来上报 —— 引擎据此在 Console 里给出
      // "查看《…》"链接、并把 articleId 回填进选题库。缺这一项时引擎只能拿
      // taskId 当文章 id，链接会指向不存在的文章（v2.54 修）。
      draftId: null,
      message: null,
      slot,
      keyword,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    }
    tasks.set(taskId, task)

    let out = fs.createWriteStream(logFile, { flags: 'a' })
    // argv 传参、**不经 shell**：入参来自网页表单，拼 shell 等于给自己开洞
    const child = spawn(bin, [...baseArgs, String(slot), String(keyword)], {
      cwd: workdir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let carry = ''
    const onChunk = (buf) => {
      out.write(buf)
      const text = buf.toString()
      task.logTail = (task.logTail + text).slice(-LOG_TAIL_CHARS)
      // 标记行可能被切在两个 chunk 之间，所以留一小段进位再匹配
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

    const settle = (state, message) => {
      if (task.state !== 'running') return
      clearTimeout(timer)
      task.state = state
      task.message = message || null
      task.finishedAt = new Date().toISOString()
      try {
        out.end()
      } catch {
        /* ignore */
      }
    }
    child.on('error', (e) => settle('failed', `启动生成命令失败: ${e.message}`))
    child.on('close', (code, signal) => {
      if (task.message && /未结束/.test(task.message)) settle('failed', task.message)
      else if (code === 0) settle('done', null)
      else settle('failed', `生成命令退出码 ${code}${signal ? `（signal ${signal}）` : ''}`)
    })
    return task
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && u.pathname === '/health')
        return send(res, 200, { ok: true, running: running(), tasks: tasks.size })

      if (!authorized(req))
        return send(res, 401, { error: 'unauthorized', message: '缺少或错误的 Authorization 头' })

      if (req.method === 'POST' && u.pathname === '/generate') {
        let body = {}
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return send(res, 400, { error: 'bad_request', message: '请求体不是合法 JSON' })
        }
        const { slot, keyword } = body
        if (!slot || !keyword)
          return send(res, 400, { error: 'bad_request', message: 'slot 与 keyword 必填' })
        if (running() >= concurrency)
          return send(res, 409, {
            error: 'busy',
            message: `已有 ${running()} 个生成任务在运行（并发上限 ${concurrency}）`,
          })
        const task = startTask({ slot, keyword })
        // 异步受理：立刻回 taskId，进度由 GET /status 提供
        return send(res, 202, {
          taskId: task.taskId,
          draftId: task.draftId,
          state: task.state,
          logFile: task.logFile,
          logTail: task.logTail,
        })
      }

      if (req.method === 'GET' && u.pathname === '/status') {
        const id = u.searchParams.get('taskId')
        const task = id ? tasks.get(id) : null
        if (!task)
          return send(res, 404, {
            error: 'unknown_task',
            message: id ? `未知 taskId: ${id}` : '缺少 taskId',
          })
        return send(res, 200, {
          taskId: task.taskId,
          draftId: task.draftId,
          state: task.state,
          logFile: task.logFile,
          logTail: task.logTail,
          message: task.message,
          slot: task.slot,
          keyword: task.keyword,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
        })
      }

      return send(res, 404, {
        error: 'not_found',
        message: `无此端点: ${req.method} ${u.pathname}`,
      })
    } catch (e) {
      return send(res, 500, { error: 'internal', message: String((e && e.message) || e) })
    }
  })

  server.tasks = tasks
  return server
}

/** 直接运行本文件时按环境变量起服务 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.GENERATE_PORT) || 8787
  const host = process.env.GENERATE_HOST || '127.0.0.1'
  const bin = process.env.GENERATE_BIN
  if (!bin) {
    console.error('需要 GENERATE_BIN（要执行的生成命令，例如项目里的 scripts/generate.sh）')
    process.exit(2)
  }
  const server = createGenerateServer({
    bin,
    args: process.env.GENERATE_ARGS ? process.env.GENERATE_ARGS.split(' ').filter(Boolean) : [],
    token: process.env.GENERATE_TOKEN || null,
    logsDir: process.env.GENERATE_LOGS_DIR || path.join(process.cwd(), 'logs'),
    workdir: process.env.GENERATE_WORKDIR || process.cwd(),
    timeoutMs: Number(process.env.GENERATE_TIMEOUT_MS) || 30 * 60 * 1000,
    concurrency: Number(process.env.GENERATE_CONCURRENCY) || 1,
  })
  server.listen(port, host, () => {
    console.log(
      `生成提供者已启动：http://${host}:${port}（POST /generate · GET /status · GET /health）`,
    )
    if (!process.env.GENERATE_TOKEN)
      console.log(
        '提示：未设置 GENERATE_TOKEN。仅环回访问时风险有限，但建议设置并在 manifest 用 tokenEnv 引用。',
      )
  })
}
