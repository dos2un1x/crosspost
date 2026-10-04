// bridge HTTP API 集成测试（node:test，零外部依赖）
// 运行: node --test tests/bridge.test.mjs
// 说明：spawn 一个独立 bridge 实例（随机端口），验证鉴权/删除授权/静态服务/路径穿越。
// 注意：与正式 bridge（9539/9540）并行安全（不同端口）；token.local 为全局文件，测试只读。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.resolve(__dirname, '..', '..', 'bridge', 'run-bridge.mjs')

// 随机空闲 WS 端口（避免并行测试/CI 端口冲突）；HTTP = WS + 1
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

// 2026-09-17：端口改为"每次尝试现取"，并校验 bootstrap 响应：
// 此前 `freePort()` 取到端口后立即释放，再由子进程去 bind —— 存在 TOCTOU：
// 并行执行的 fetch-util.test.mjs 用 listen(0) 起 stub server 时，操作系统可能正好把
// 这个刚释放的端口号发给它，于是 bridge 的 HTTP listen 拿不到端口，而本测试的轮询
// 打到 stub 上收到 "hi"（非 JSON）→ 一直重试到 120s → 整个文件 15 个用例全挂。
// 现在：响应必须是带 token 的 JSON，否则判定"端口被别的测试进程占了"，换端口重试。
let WS_PORT = 0
let HTTP_PORT = 0
let BASE = ''

let child = null
let token = ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 测试沙箱目录（v2.40 补齐隔离）。
 *
 * **为什么必须全量隔离**：本文件会真的打 `POST /proxy/delete`，那条路径会走到
 * `deleteDraft` → `pushHumanFeedback()` → 写 `historyDir/editorial-memory.json`。
 * 此前只隔离了 ever-authed / platforms-state 两个**状态文件**，草稿/文章库/历史
 * 一律落到**真实部署目录**。实测后果（2026-09-19 发现）：
 *
 *   使用者真实的接入项目里的 `history/editorial-memory.json`
 *   里 `humanFeedback` 被写满 30 条 `{type:'article-delete', id:'no-such-id-xyz'}`
 *   （正是本测试的假 id），而该数组上限就是 30 —— **真实人工反馈被整段挤掉**。
 *   这份文件会被注入下一轮选题 prompt（避雷摘要），所以污染直接影响写作质量信号。
 *
 * 教训：**"测试写到了真实数据目录"是最难发现的一类破坏**——测试全绿，数据在悄悄烂。
 * 凡 spawn 引擎/桥的测试，必须把引擎读的每一个可写路径都指到临时目录。
 */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-bridge-test-'))

/**
 * 项目夹具（2026-09-28 测试审计补）。
 *
 * 此前本文件**没有**隔离 `CROSSPOST_PROJECTS_DIRS`：于是 `/proxy/schedule` 里那段
 * "项目槽位契约"在 CI 上找不到项目 → `if (!pid) return` 整段跳过（报告里看着通过，
 * 实际零信号）；在本机则跑在**使用者真实接入的项目**上，判定随本机数据而变。
 * 现在自带一个沙箱项目，契约断言在任何机器上都真的执行。
 */
const PROJECTS = path.join(SANDBOX, 'projects')
const FIXTURE_PROJECT = 'bridge-test-proj'
fs.mkdirSync(path.join(PROJECTS, FIXTURE_PROJECT, '.crosspost'), { recursive: true })
fs.mkdirSync(path.join(PROJECTS, FIXTURE_PROJECT, 'drafts'), { recursive: true })
fs.writeFileSync(
  path.join(PROJECTS, FIXTURE_PROJECT, '.crosspost', 'project.json'),
  JSON.stringify({
    id: FIXTURE_PROJECT,
    name: '桥契约测试项目',
    manifestVersion: 2,
    capabilities: { drafts: true, generate: false, schedule: true },
    dataDir: 'drafts',
  }),
)
// 槽位**只能来自项目声明**，所以夹具项目要自带一份 schedule.json
fs.writeFileSync(
  path.join(PROJECTS, FIXTURE_PROJECT, '.crosspost', 'schedule.json'),
  JSON.stringify({
    version: 1,
    slots: { 'probe-slot': { name: '契约探针', time: '06:07', command: ['/bin/echo', 'ok'] } },
  }),
)

/**
 * 沙箱配置 + 其余隔离项。
 *
 * `CROSSPOST_CONFIG`：此前没隔离 → `/proxy/status` 的范围判定**读的是使用者的真实配置**
 * （本机一份、CI 一份空默认，两边判定不同）。`CROSSPOST_SCHEDULER_DIR` /
 * `CROSSPOST_LEGACY_TASKS_DIR`：桥会起内置定时器，不隔离就会去抢本机真实的调度锁、
 * 并扫真实的 `~/Library/LaunchAgents`。与 `editorial-memory.json` 那次污染同一类问题。
 */
const CONFIG = path.join(SANDBOX, 'config.json')
fs.writeFileSync(
  CONFIG,
  JSON.stringify({ proxyMode: true, proxyHttpPort: 0, projectsDirs: [PROJECTS] }),
)

const SANDBOX_ISO = {
  CROSSPOST_LOCAL_ROOT: path.join(SANDBOX, 'local'),
  CROSSPOST_DRAFTS_DIR: path.join(SANDBOX, 'drafts'),
  CROSSPOST_ARTICLES_DIR: path.join(SANDBOX, 'articles'),
  CROSSPOST_HISTORY_DIR: path.join(SANDBOX, 'history'),
  CROSSPOST_TOPIC_POOL: path.join(SANDBOX, 'history', 'topic-pool.json'),
  CROSSPOST_LOGS_DIR: path.join(SANDBOX, 'logs'),
  CROSSPOST_CONFIG: CONFIG,
  CROSSPOST_PROJECTS_DIRS: PROJECTS,
  CROSSPOST_PROJECTS_DIR: PROJECTS,
  CROSSPOST_SCHEDULER_DIR: path.join(SANDBOX, 'scheduler'),
  CROSSPOST_LEGACY_TASKS_DIR: path.join(SANDBOX, 'no-legacy-tasks'),
}
fs.mkdirSync(SANDBOX_ISO.CROSSPOST_DRAFTS_DIR, { recursive: true })
fs.mkdirSync(SANDBOX_ISO.CROSSPOST_HISTORY_DIR, { recursive: true })
fs.mkdirSync(SANDBOX_ISO.CROSSPOST_ARTICLES_DIR, { recursive: true })

/**
 * 真实部署里**绝对不该被本测试改动**的文件（跑完逐字比对）。
 *
 * 路径**从引擎自己的配置推**：`config.json.projectsDirs` 下一层的
 * `history/editorial-memory.json`。不在仓库里写死某个接入项目的目录 ——
 * 那样只有一台机器成立，也把私有目录名带进了公开仓库。
 */
const REAL_FILES_NOT_TO_TOUCH = (() => {
  const out = []
  try {
    const cfg = JSON.parse(
      fs.readFileSync(
        process.env.CROSSPOST_CONFIG || path.join(REPO, 'crosspost-runtime', 'config.json'),
        'utf8',
      ),
    )
    for (const dir of cfg.projectsDirs || []) {
      let names = []
      try {
        names = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const n of names) {
        const p = path.join(dir, n, 'history', 'editorial-memory.json')
        if (fs.existsSync(p)) out.push(p)
      }
    }
  } catch {
    /* 无本机配置：断言退化为空表（与本文件在 CI 上的行为一致） */
  }
  return out
})()

/** 启动一次 bridge 并等它就绪；失败（端口被占/未起来）返回 null，由调用方换端口重试 */
async function startBridgeOnce(wsPort) {
  const httpPort = wsPort + 1
  const proc = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      ...SANDBOX_ISO,
      SYNC_PROXY_WS_PORT: String(wsPort),
      // 2026-09-12：测试实例用临时状态文件，避免污染真实 ever-authed.json / platforms-state.json
      CROSSPOST_EVER_AUTHED_PATH: path.join(os.tmpdir(), `bridge-test-ever-authed-${wsPort}.json`),
      CROSSPOST_PLATFORMS_STATE_PATH: path.join(os.tmpdir(), `bridge-test-state-${wsPort}.json`),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  // 转发子进程输出（pipe 但默认未消费→ 丢弃），让 CI 日志暴露 bridge 启动失败原因
  proc.stderr.on('data', (d) => process.stderr.write('[bridge-stderr] ' + d))
  proc.on('exit', (code, sig) => process.stderr.write(`[bridge-exit] code=${code} sig=${sig}\n`))

  const readyDebug = !!process.env.READY_DEBUG
  const start = Date.now()
  const deadline = Date.now() + 30000 // 单次尝试 30s（隔离启动约 0.3s）
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    const t0 = Date.now()
    try {
      const r = await fetch(`http://127.0.0.1:${httpPort}/proxy/bootstrap`)
      if (r.ok) {
        const body = await r.json().catch(() => null)
        // 响应必须是 bootstrap 的 {token}：否则说明这个端口上是别人的 stub server
        if (body && typeof body.token === 'string' && body.token) {
          if (readyDebug)
            process.stderr.write(`[ready] 成功 #${attempt} t=${t0 - start}ms port=${httpPort}\n`)
          return { proc, httpPort, token: body.token }
        }
        process.stderr.write(
          `[ready] 端口 ${httpPort} 返回的不是 bootstrap（可能被并行测试的 stub server 占用），换端口重试\n`,
        )
        break
      }
      if (readyDebug)
        process.stderr.write(
          `[ready] #${attempt} t=${t0 - start}ms status=${r.status} port=${httpPort}\n`,
        )
    } catch (e) {
      if (readyDebug)
        process.stderr.write(
          `[ready] #${attempt} t=${t0 - start}ms err=${(e && (e.code || e.message)) || e} port=${httpPort}\n`,
        )
    }
    await sleep(300)
  }
  try {
    proc.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  return null
}

/** 文件指纹（不存在 → `<absent>`），用于"真实数据目录一字未动"的断言 */
function fingerprint(file) {
  try {
    const buf = fs.readFileSync(file)
    return crypto.createHash('sha256').update(buf).digest('hex')
  } catch {
    return '<absent>'
  }
}

/** 跑测试**之前**的真实文件指纹（after 里逐字比对） */
const REAL_BEFORE = new Map(REAL_FILES_NOT_TO_TOUCH.map((f) => [f, fingerprint(f)]))

before(async () => {
  for (let i = 1; i <= 5; i++) {
    const wsPort = await freePort()
    const started = await startBridgeOnce(wsPort)
    if (started) {
      child = started.proc
      token = started.token
      WS_PORT = wsPort
      HTTP_PORT = started.httpPort
      BASE = `http://127.0.0.1:${HTTP_PORT}`
      return
    }
    process.stderr.write(`[ready] 第 ${i} 次启动未就绪（多为端口与并行测试撞车），换端口重试\n`)
  }
  throw new Error('bridge 测试实例 5 次尝试均未就绪')
})

after(() => {
  if (child) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* */
    }
  }

  // ── 隔离护栏（v2.40）──
  // 本测试会真的打删除接口；一旦隔离变量被误删，它就会往**真实部署**的
  // history/editorial-memory.json 里写假条目（实测发生过：30 条上限被
  // {type:'article-delete', id:'no-such-id-xyz'} 写满，真实人工反馈被整段挤掉）。
  // 这条断言让"隔离失效"立刻变成失败，而不是等使用者发现写作质量变差。
  const changed = [...REAL_BEFORE.entries()]
    .filter(([f, before]) => fingerprint(f) !== before)
    .map(([f]) => f)
  if (changed.length) {
    throw new Error(
      `本测试改动了真实数据文件（隔离失效）：\n  ${changed.join('\n  ')}\n` +
        '检查 SANDBOX_ISO 里是否漏了某个 CROSSPOST_* 变量。',
    )
  }

  fs.rmSync(SANDBOX, { recursive: true, force: true })
})

/** 原生 http 请求（不规范化路径，用于穿越测试） */
function rawRequest(rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: HTTP_PORT, path: rawPath, headers, method: 'GET' },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test('bootstrap 返回 token', () => {
  assert.ok(token.length >= 20, 'token 非空')
})

test('无 token → 401；错 token → 401；带 token → 200', async () => {
  const noToken = await fetch(BASE + '/proxy/status')
  assert.equal(noToken.status, 401)
  const wrong = await fetch(BASE + '/proxy/status', { headers: { 'X-CrossPost-Token': 'wrong' } })
  assert.equal(wrong.status, 401)
  const ok = await fetch(BASE + '/proxy/status', { headers: { 'X-CrossPost-Token': token } })
  assert.equal(ok.status, 200)
})

test('query token 参数不再鉴权（A3：token 仅 header）', async () => {
  const r = await fetch(`${BASE}/proxy/status?token=${encodeURIComponent(token)}`)
  assert.equal(r.status, 401, '?token= 查询串应被拒绝（凭据只走 header）')
  const withHeader = await fetch(`${BASE}/proxy/status?token=${encodeURIComponent(token)}`, {
    headers: { 'X-CrossPost-Token': token },
  })
  assert.equal(withHeader.status, 200, 'header 鉴权不受查询串影响')
})

test('health 端点自检', async () => {
  const r = await fetch(BASE + '/proxy/health', { headers: { 'X-CrossPost-Token': token } })
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.equal(d.ok, true)
  assert.equal(typeof d.uptimeMs, 'number')
  assert.equal(d.tokenConfigured, true)
  // 2026-09-12：代理来源身份字段（排查"登录态对不上"的第一现场）
  assert.ok('client' in d, 'health 应含代理来源 client 字段')
  // 2026-09-21（v2.100）：三 worker 健康面 —— 排查"Console 变慢"的第一现场。
  // 事故背景：worker 被杀成永久冷启动态后**没有任何日志与字段**能看出降级，只能靠推理。
  assert.ok(d.workers && typeof d.workers === 'object', 'health 应含 workers 健康面')
  for (const role of ['reader', 'costs', 'writer', 'heavy']) {
    const w = d.workers[role]
    assert.ok(w, `workers.${role} 应存在`)
    for (const k of ['alive', 'restarts', 'coolingDown', 'outputBytes']) {
      assert.ok(k in w, `workers.${role} 应含 ${k}`)
    }
  }
  // 桥刚起来时 reader 可能还在预热（prewarmWorkers 错峰 1.5s），但字段语义必须自洽：
  // alive 为真 ⇒ 有 pid 与 uptime；coolingDown 为真 ⇒ 有 failedUntil 时间戳。
  const rw = d.workers.reader
  if (rw.alive) {
    assert.equal(typeof rw.pid, 'number')
    assert.ok(rw.uptimeMs >= 0)
  }
  if (rw.coolingDown) assert.equal(typeof rw.failedUntil, 'number')
})

// 2026-09-12：平台检查范围 = 默认推送平台 ∪ (锁定平台 ∩ 曾登录)。
// 回归：范围外的历史失败平台（bilibili/jianshu/douban/woshipm）不得进入失败重查集。
test('/proxy/status 暴露检查范围与失败明细（范围约束不变式）', async () => {
  const r = await fetch(BASE + '/proxy/status', { headers: { 'X-CrossPost-Token': token } })
  assert.equal(r.status, 200)
  const d = await r.json()
  const p = d.platforms || {}
  const sc = p.scope
  assert.ok(sc && Array.isArray(sc.ids), 'status 应含 platforms.scope.ids')
  assert.ok(['scoped', 'fallback-all'].includes(sc.mode), `scope.mode 非法: ${sc.mode}`)
  assert.equal(sc.count, sc.ids.length)
  assert.equal(typeof sc.all, 'number')
  assert.ok(sc.ids.length > 0 && sc.ids.length <= sc.all)
  // 锁定平台只能来自 LOCKED_PLATFORMS
  for (const id of sc.lockedInScope || []) assert.ok(['weixin', 'douyin'].includes(id))
  // 失败集合必须被检查范围约束（这是本次改造的核心不变式）
  const inScope = new Set(sc.ids)
  for (const id of p.failedRetryIds || [])
    assert.ok(inScope.has(id), `${id} 不在检查范围内却进入重查集`)
  for (const id of p.needsLoginIds || [])
    assert.ok(inScope.has(id), `${id} 不在检查范围内却进入终态集`)
  for (const fd of p.failedDetail || [])
    assert.ok(inScope.has(fd.id), `${fd.id} 不在检查范围内却出现在失败明细`)
  // 退避与终态参数（前端展示用）
  assert.ok(Array.isArray(p.backoffSteps) && p.backoffSteps.length >= 2)
  assert.equal(typeof p.giveUpAfterMs, 'number')
})

// v2.3：槽位调度状态契约——触发由**引擎内置定时器**负责，不再是 launchd 注册态。
// 契约要点（Console 与验收都依赖）：
//   · 槽位集合按项目解析：**默认域为空**（引擎不再自带任务），带项目头时才是该项目的槽位
//   · 每个槽位必须能回答"命令能不能跑"（commandMissing/commandReason）与"下次什么时候"
//   · 定时器自身状态（backend/tz/锁）必须在顶层暴露——它才是"到点会不会触发"的判据
test('/proxy/schedule 暴露内置定时器状态与每个槽位的可跑性（v2.3）', async () => {
  const r = await fetch(BASE + '/proxy/schedule', { headers: { 'X-CrossPost-Token': token } })
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.equal(d.backend, 'internal')
  assert.equal(d.supported, true)
  assert.equal(typeof d.tz, 'string')
  // 2026-09-25：日历提醒退役后默认域**没有任何槽位**（引擎不再自带任务）。
  // 这条断言反过来守着一件事：默认域的空不是"接口坏了"，而是设计。
  assert.ok(Array.isArray(d.slots), 'slots 必须是数组（默认域允许为空）')
  assert.deepEqual(d.slots, [], '默认域没有槽位：槽位按项目安装')
  assert.ok(Array.isArray(d.legacyTasks), '迁移期检测结果必须在响应里（双发的唯一防线）')
  assert.equal(typeof d.lockHeldByUs, 'boolean')
  assert.equal(typeof d.catchUpMaxMinutes, 'number')

  // 带项目头时才是该项目的槽位 —— 契约的其余部分（可跑性字段、label）在这里检查。
  // label 尤其重要：Console 各视图的栏目名**只**从这里取（2026-09-25），
  // 前端不再自备一份会漂的常量；少一个 label，界面就会退回兜底常量或露出裸 id。
  const reg = await (
    await fetch(BASE + '/proxy/projects', { headers: { 'X-CrossPost-Token': token } })
  ).json()
  const pid = ((reg.projects || []).find((p) => p && p.valid && p.id) || {}).id || ''
  // 夹具项目是**本文件自带**的，找不到就是注册表/扫描坏了 —— 不许再静默跳过
  assert.ok(pid, '沙箱夹具项目未被注册：项目扫描或 manifest 校验坏了')
  const pr = await fetch(BASE + '/proxy/schedule', {
    headers: { 'X-CrossPost-Token': token, 'X-CrossPost-Project': pid },
  })
  const pd = await pr.json()
  assert.ok(pd.slots.length > 0, `项目 ${pid} 应当有自己的槽位`)
  for (const s of pd.slots) {
    assert.equal(typeof s.enabled, 'boolean', `${s.slot}.enabled 必须是布尔`)
    assert.equal(typeof s.armed, 'boolean', `${s.slot}.armed 必须是布尔`)
    assert.equal(typeof s.commandMissing, 'boolean', `${s.slot}.commandMissing 必须是布尔`)
    assert.equal(typeof s.next, 'string', `${s.slot}.next 必须是可读的下一次触发`)
    assert.equal(typeof s.running, 'boolean', `${s.slot}.running 必须是布尔`)
    assert.equal(typeof s.label, 'string', `${s.slot}.label 必须是字符串`)
  }
})

// 2026-09-25：引擎的事实不许被前端抄第二份（型号 / 备份份数）。两条接口各给一份：
//   · /proxy/costs 的 meta.pricing —— 报表费用卡的"按什么价、什么规则"来自它
//     （改前卡片自己硬写型号，既会漂又漏了"按峰谷计价"）
//   · /proxy/backup 的 keep —— 备份卡的"保留最近 N 份"来自它（改前硬写 30）
test('/proxy/costs 与 /proxy/backup 把计价口径与保留份数交给界面（2026-09-25）', async () => {
  const h = { headers: { 'X-CrossPost-Token': token } }
  const costs = await (await fetch(BASE + '/proxy/costs', h)).json()
  assert.equal(typeof costs.meta, 'object')
  assert.equal(typeof costs.meta.pricing, 'object', 'meta.pricing 必须在（Console 靠它渲染口径）')
  assert.equal(typeof costs.meta.pricing.model, 'string')
  assert.ok(Array.isArray(costs.meta.pricing.peakHours), '峰谷时段要一起给（那张卡片原先漏了这层）')

  const backup = await (await fetch(BASE + '/proxy/backup', h)).json()
  assert.equal(typeof backup.keep, 'number', 'backup.keep 必须在（份数不再由界面写死）')
  assert.ok(backup.keep > 0)
})

// 2026-09-12（模型 A）：单平台「🔍 查一下」= GET /proxy/platforms?check=<id>
// 未勾选的平台可随时单查，但**不得**因此进入自动重查集（范围约束照旧）。
test('?check= 单平台查询：不影响检查范围，也不把未勾选平台放进重查集', async () => {
  const r = await fetch(BASE + '/proxy/platforms?check=sohufocus&wait=1', {
    headers: { 'X-CrossPost-Token': token },
  })
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.ok(d.scope && Array.isArray(d.scope.ids), 'check 查询仍应返回范围信息')
  const st = await fetch(BASE + '/proxy/status', { headers: { 'X-CrossPost-Token': token } })
  const p = (await st.json()).platforms
  assert.ok(
    !(p.failedRetryIds || []).includes('sohufocus'),
    '未勾选平台不得进入失败重查集（单点查询不订阅自动重查）',
  )
  assert.ok(!(p.scope.ids || []).includes('sohufocus'), '单点查询不得改变检查范围')
})

test('核心只读路由带 token 可用', async () => {
  for (const p of [
    '/proxy/articles',
    '/proxy/topics',
    '/proxy/archive',
    '/proxy/retained',
    '/proxy/backup',
  ]) {
    const r = await fetch(BASE + p, { headers: { 'X-CrossPost-Token': token } })
    assert.equal(r.status, 200, `${p} 应 200`)
  }
})

// 2026-09-12：扩展身份（哪个浏览器在替你发请求）。
// 真实故障：面板开在 Google Chrome、代理扩展运行在 360Chrome → 4 个平台永远"未登录"却毫无线索。
// 这里用假扩展客户端验证：身份被记录、来源切换被识别并写告警日志。
// 注意用 connected:false 推送 → 桥只记身份、不触发平台检查（保持测试不 spawn CLI）。
test('扩展身份：心跳带 clientId/ua → ext.client 记录，来源切换写告警日志', async () => {
  const WS = createRequire(path.join(__dirname, '..', '..', 'bridge', 'run-bridge.mjs'))('ws')
  const stderr = []
  child.stderr.on('data', (d) => stderr.push(String(d)))
  const heartbeat = (clientId, ua) =>
    new Promise((resolve, reject) => {
      const ws = new WS(`ws://127.0.0.1:${WS_PORT}`, { origin: 'chrome-extension://bridge-test' })
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'proxy-status',
            connected: false,
            at: Date.now(),
            clientId,
            ua,
            version: '0.2.0',
          }),
        )
        setTimeout(() => {
          try {
            ws.close()
          } catch {
            /* */
          }
          resolve()
        }, 150)
      })
      ws.on('error', reject)
    })
  const readClient = async () => {
    const r = await fetch(BASE + '/proxy/status', { headers: { 'X-CrossPost-Token': token } })
    return (await r.json()).ext.client
  }
  await heartbeat('cAAA111', 'Mozilla/5.0 Chrome/132.0.0.0 Safari/537.36')
  const c1 = await readClient()
  assert.equal(c1 && c1.clientId, 'cAAA111')
  assert.ok(String(c1.ua).includes('Chrome/132'), 'UA 应被记录')

  await heartbeat('cBBB222', 'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36')
  const c2 = await readClient()
  assert.equal(c2 && c2.clientId, 'cBBB222', '来源切换后应记录新客户端')
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(
    stderr.join('').includes('代理来源切换'),
    `来源切换应写告警日志，实际 stderr: ${stderr.join('').slice(-200)}`,
  )
})
test('静态页 200 + CSP 头；模块子目录可访问', async () => {
  const r = await fetch(BASE + '/')
  assert.equal(r.status, 200)
  assert.ok(r.headers.get('content-security-policy'), '有 CSP 头')
  const m = await fetch(BASE + '/console/modules/utils.mjs')
  assert.equal(m.status, 200)
  assert.ok((m.headers.get('content-type') || '').includes('javascript'), 'mjs MIME 正确')
})

test('路径穿越被拒（resolve + 前缀校验）', async () => {
  const r1 = await rawRequest('/console/../run-bridge.mjs')
  assert.equal(r1.status, 404, '上一级穿越应 404')
  const r2 = await rawRequest('/console/../../etc/passwd')
  assert.equal(r2.status, 404)
})

test('删除端点：无 authorized → 403；带 authorized → 进入业务逻辑', async () => {
  const H = { 'X-CrossPost-Token': token, 'Content-Type': 'application/json' }
  // delete-draft 无授权
  const r1 = await fetch(BASE + '/proxy/delete-draft', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ id: 'no-such' }),
  })
  assert.equal(r1.status, 403)
  const d1 = await r1.json()
  assert.ok(d1.error && d1.error.includes('授权'))
  // 带授权 → 业务处理（id 不存在返回 ok + note，而非 403）
  const r2 = await fetch(BASE + '/proxy/delete-draft', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ id: 'no-such-id-xyz', authorized: true }),
  })
  assert.equal(r2.status, 200)
  const d2 = await r2.json()
  assert.ok('ok' in d2, '进入业务逻辑（返回 ok 字段而非 403）')
  // topics/delete 无授权
  const r3 = await fetch(BASE + '/proxy/topics/delete', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ id: 'x' }),
  })
  assert.equal(r3.status, 403)
  // archive delete 无授权
  const r4 = await fetch(BASE + '/proxy/archive', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ id: 'x', action: 'delete' }),
  })
  assert.equal(r4.status, 403)
  // retained delete 无授权
  const r5 = await fetch(BASE + '/proxy/retained/delete', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ id: 'x' }),
  })
  assert.equal(r5.status, 403)
})

test('选题删除权限：generated/adopted 拒绝（接口层）', async () => {
  const H = { 'X-CrossPost-Token': token, 'Content-Type': 'application/json' }
  const r = await fetch(BASE + '/proxy/topics/delete', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ id: '2026-08-24-tips-1', authorized: true }),
  })
  // 该 id 若存在且非 rejected → 403 业务拒绝；不存在 → 404。均不应 200 ok:true
  const d = await r.json().catch(() => ({}))
  assert.ok(
    r.status === 403 || r.status === 404 || d.ok === undefined,
    `generated 选题不可删: ${r.status} ${JSON.stringify(d).slice(0, 80)}`,
  )
})

test('未知路由 → 404', async () => {
  const r = await fetch(BASE + '/proxy/not-a-route', { headers: { 'X-CrossPost-Token': token } })
  assert.equal(r.status, 404)
})

test('文章 id 错误契约（A2）：非法 id → 400，合法 id → 200', async () => {
  const H = { 'X-CrossPost-Token': token }
  const traversal = await rawRequest('/proxy/articles/..%2F..%2Fetc', H)
  assert.equal(traversal.status, 400, '路径穿越尝试应 400')
  const d1 = await traversal.body
  assert.ok(d1.includes('非法 articleId'), '400 响应带错误说明')
  const bad = await fetch(BASE + '/proxy/articles/%2Fetc%2Fpasswd', { headers: H })
  assert.equal(bad.status, 400, '含斜杠 id 应 400')
  // 合法 id（即使记录不存在）→ 200 + article:null（前端契约不变）
  const ok = await fetch(BASE + '/proxy/articles/no-such-id-xyz', { headers: H })
  assert.equal(ok.status, 200, '合法 id 应 200')
  const d2 = await ok.json()
  assert.ok('article' in d2 && d2.article === null, '不存在记录返回 article:null')
})
