// 「一键生成」HTTP 提供者契约测试（P2 / v2.51）
//
// 锁死 docs/integration.md §5 的机器可校验部分：
//   · manifest v2 的对象形态声明（校验规则、未知字段、密钥只放变量名）
//   · 提供者解析的三层优先级，以及**层与层之间没有回退**这条铁律
//   · 端点策略守卫（默认只允许环回；重定向不算通过）
//   · 同步 / 异步两种响应形态，以及所有失败路径都返回**结构化错误**而不是抛异常
//
// ── 为什么这个文件的最后两个用例是"污染守卫" ──────────────────────
// 本项目已经两次被"验证工具自己写生产数据"咬到：
//   ① `bridge.test.mjs` 未隔离 historyDir → 生产编辑记忆的 humanFeedback 被 30 条
//      测试假条目写满（上限就是 30，真实反馈不可恢复）
//   ② `test:smoke:production` 号称只读，实际给真实文章记录追加了 38 条 dryRun 历史
// 所以本文件全程把 `CROSSPOST_TOPIC_POOL` / `CROSSPOST_LOGS_DIR` / `CROSSPOST_CONFIG`
// 指向临时沙箱，并在最后**用内容特征**（一个随机 keyword）反向确认它没漏进生产选题库。
// 认内容而不是认"文件变没变"，是因为定时链路本来就会写那个文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import { createGenerateServer } from '../../examples/generate-provider-http/server.mjs'
import {
  applyHostGateway,
  checkEndpointPolicy,
  dialNote,
  resolveGenerateProvider,
  callGenerateProvider,
  probeEndpoint,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_OVERALL_TIMEOUT_MS,
} from '../src/generate.mjs'
import { MANIFEST_VERSION, validateGenerateCapability, listProjects } from '../src/projects.mjs'
import { loadPaths } from '../src/paths.mjs'

/* ── 沙箱：所有路径都落在临时目录，绝不碰生产 ─────────────────────── */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-generate-'))
const PROJECTS = path.join(SANDBOX, 'projects')
const LOGS = path.join(SANDBOX, 'logs')
const TOPIC_POOL = path.join(SANDBOX, 'topic-pool.json')
const HISTORY = path.join(SANDBOX, 'history')
for (const d of [PROJECTS, LOGS, HISTORY]) fs.mkdirSync(d, { recursive: true })

// 生产侧（沙箱外的真实配置）的选题库路径 —— 仅用于最后的污染守卫
const PROD_TOPIC_POOL = (() => {
  try {
    return loadPaths().topicPoolFile
  } catch {
    return null
  }
})()

process.env.CROSSPOST_LOCAL_ROOT = path.join(SANDBOX, 'local')
process.env.CROSSPOST_LOGS_DIR = LOGS
process.env.CROSSPOST_HISTORY_DIR = HISTORY
process.env.CROSSPOST_TOPIC_POOL = TOPIC_POOL
process.env.CROSSPOST_PROJECTS_DIR = PROJECTS
process.env.CROSSPOST_PROJECTS_DIRS = PROJECTS
// 指向一个**不存在**的配置文件 → readConfig() 返回 {}，等价于"全新安装"
process.env.CROSSPOST_CONFIG = path.join(SANDBOX, 'config-none.json')

const KEYWORD = `__gen_test_${Math.random().toString(36).slice(2, 10)}__`

/** 每个 config 用**不同的文件名**：config-cache 按 mtime 缓存，同文件同毫秒会命中旧值 */
function useConfig(name, obj) {
  const p = path.join(SANDBOX, `config-${name}.json`)
  fs.writeFileSync(p, JSON.stringify(obj, null, 2))
  process.env.CROSSPOST_CONFIG = p
  return p
}

function useNoConfig() {
  process.env.CROSSPOST_CONFIG = path.join(SANDBOX, 'config-none.json')
}

function writeProject(id, { capabilities = {}, dataDir, manifestVersion = MANIFEST_VERSION } = {}) {
  const dir = path.join(PROJECTS, id)
  fs.mkdirSync(path.join(dir, '.crosspost'), { recursive: true })
  const m = { id, name: `项目 ${id}`, manifestVersion, capabilities }
  if (dataDir) {
    fs.mkdirSync(path.join(dir, dataDir), { recursive: true })
    m.dataDir = dataDir
  }
  fs.writeFileSync(path.join(dir, '.crosspost', 'project.json'), JSON.stringify(m, null, 2))
  return dir
}

function removeProject(id) {
  fs.rmSync(path.join(PROJECTS, id), { recursive: true, force: true })
}

/* ── 起一个真 HTTP 服务（用示例实现，或测试自己的 handler） ───────── */

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  const port = await listen(server)
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve(null)
      }
    })
  })
}

/** 造一个"内联声明"的 provider 对象（绕过 manifest，专测调用层） */
function providerFor(url, extra = {}) {
  return {
    provided: true,
    kind: 'http',
    url,
    statusUrl: null,
    timeoutMs: 2000,
    pollIntervalMs: 250,
    overallTimeoutMs: 5000,
    tokenEnv: null,
    projectId: null,
    source: '测试内联',
    ...extra,
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 一、manifest v2 声明校验
 * ══════════════════════════════════════════════════════════════════ */

test('契约①：v1 的布尔形态仍然合法（升版不拒绝既有项目）', () => {
  // 布尔是 v1 就有的形态：`true` = 项目声明自己提供该能力（跨进程时另配 url）。
  // 校验函数对布尔必须放行——它此前会对 true 报"值必须是布尔或对象"，自相矛盾。
  assert.deepEqual(validateGenerateCapability(true), [])
  assert.deepEqual(validateGenerateCapability(false), [])
})

test('契约②：合法的 v2 对象形态通过校验', () => {
  const ok = {
    kind: 'http',
    url: 'http://127.0.0.1:8787/generate',
    statusUrl: 'http://127.0.0.1:8787/status',
    timeoutMs: 60000,
    pollIntervalMs: 2000,
    overallTimeoutMs: 3600000,
    tokenEnv: 'CROSSPOST_GENERATE_TOKEN',
    description: '项目侧生成服务',
  }
  assert.deepEqual(validateGenerateCapability(ok), [])
})

test('契约③：非法声明逐条报错（未知字段 / kind / url 协议 / 数值范围 / 密钥泄露）', () => {
  const cases = [
    [{ kind: 'http', url: 'http://127.0.0.1:1/x', command: 'rm -rf /' }, /未知字段: command/],
    [{ url: 'http://127.0.0.1:1/x' }, /kind 必须是 http/],
    [{ kind: 'shell', url: 'http://127.0.0.1:1/x' }, /kind 必须是 http/],
    [{ kind: 'http' }, /url 必须是非空字符串/],
    [{ kind: 'http', url: 'not a url' }, /url 不是合法 URL/],
    [{ kind: 'http', url: 'file:///etc/passwd' }, /协议必须是 http\/https/],
    [{ kind: 'http', url: 'http://127.0.0.1:1/x', timeoutMs: 0 }, /timeoutMs 必须是/],
    [{ kind: 'http', url: 'http://127.0.0.1:1/x', timeoutMs: 999999999 }, /timeoutMs 必须是/],
    [{ kind: 'http', url: 'http://127.0.0.1:1/x', pollIntervalMs: 10 }, /pollIntervalMs 必须是/],
    [
      { kind: 'http', url: 'http://127.0.0.1:1/x', tokenEnv: 'not-a-name!' },
      /tokenEnv 必须是合法的环境变量名/,
    ],
    [{ kind: 'http', url: 'http://127.0.0.1:1/x', token: 'secret-in-repo' }, /未知字段: token/],
    ['http://x', /值必须是布尔或对象/],
  ]
  for (const [decl, re] of cases) {
    const errs = validateGenerateCapability(decl)
    assert.ok(
      errs.some((e) => re.test(e)),
      `期望命中 ${re}，实际 ${JSON.stringify(errs)}（输入 ${JSON.stringify(decl)}）`,
    )
  }
})

test('契约④：manifest 拒绝"密钥写进 manifest"，但接受环境变量名', () => {
  const withSecret = { kind: 'http', url: 'http://127.0.0.1:1/x', token: 'abc' }
  assert.ok(validateGenerateCapability(withSecret).length > 0)
  const withEnvName = { kind: 'http', url: 'http://127.0.0.1:1/x', tokenEnv: 'MY_TOKEN' }
  assert.deepEqual(validateGenerateCapability(withEnvName), [])
})

/* ══════════════════════════════════════════════════════════════════
 * 二、端点策略守卫
 * ══════════════════════════════════════════════════════════════════ */

test('策略①：环回地址一律放行（127.x / localhost / ::1 / 0.0.0.0）', () => {
  for (const u of [
    'http://127.0.0.1:8787/generate',
    'http://127.9.9.9/generate',
    'http://localhost:8787/generate',
    'http://[::1]:8787/generate',
    'http://0.0.0.0:8787/generate',
    'https://127.0.0.1/generate',
  ]) {
    const r = checkEndpointPolicy(u, {})
    assert.equal(r.ok, true, `${u} 应放行，实际 ${JSON.stringify(r)}`)
  }
})

test('策略②：默认**拒绝**远程主机（manifest 不能让引擎去打任意地址）', () => {
  const r = checkEndpointPolicy('http://evil.example.com/generate', {})
  assert.equal(r.ok, false)
  assert.match(r.reason, /不是环回地址/)
  // 也不能靠 302 绕过——调用层用 redirect:'manual'，这里确认策略本身不认跳转
  assert.match(r.reason, /allowHosts/)
})

test('策略③：登记后才放行远程主机（host 或 host:port 两种写法都认）', () => {
  const url = 'http://gen.internal:9000/generate'
  assert.equal(checkEndpointPolicy(url, { allowHosts: ['gen.internal'] }).ok, true)
  assert.equal(checkEndpointPolicy(url, { allowHosts: ['gen.internal:9000'] }).ok, true)
  assert.equal(checkEndpointPolicy(url, { allowHosts: ['gen.internal:9'] }).ok, false)
  assert.equal(checkEndpointPolicy(url, { allowRemote: true }).ok, true)
})

test('策略④：非 http(s) 协议与非法 URL 一律拒绝', () => {
  for (const u of ['file:///etc/passwd', 'ftp://127.0.0.1/x', 'gopher://127.0.0.1/x']) {
    const r = checkEndpointPolicy(u, {})
    assert.equal(r.ok, false, `${u} 不该放行`)
  }
  assert.equal(checkEndpointPolicy('not-a-url', {}).ok, false)
})

/* ══════════════════════════════════════════════════════════════════
 * 三、提供者解析（三层优先级 + 层间不回退）
 * ══════════════════════════════════════════════════════════════════ */

test('解析①：无项目、无配置 → 未提供，且给出可读原因', () => {
  useNoConfig()
  const r = resolveGenerateProvider(null)
  assert.equal(r.provided, false)
  assert.equal(r.code, 'generate_not_provided')
  assert.match(r.reason, /没有项目上下文/)
})

test('解析②：项目 manifest 声明 http → 解析出端点与默认参数', () => {
  useNoConfig()
  writeProject('p-http', {
    capabilities: {
      generate: {
        kind: 'http',
        url: 'http://127.0.0.1:8787/generate',
        statusUrl: 'http://127.0.0.1:8787/status',
      },
    },
  })
  try {
    const r = resolveGenerateProvider('p-http')
    assert.equal(r.provided, true)
    assert.equal(r.kind, 'http')
    assert.equal(r.url, 'http://127.0.0.1:8787/generate')
    assert.equal(r.statusUrl, 'http://127.0.0.1:8787/status')
    assert.equal(r.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
    assert.equal(r.overallTimeoutMs, DEFAULT_OVERALL_TIMEOUT_MS)
    assert.match(r.source, /项目 p-http/)
  } finally {
    removeProject('p-http')
  }
})

test('解析③：项目没声明 / 只给了 v1 的 true / 根本没注册 —— 三种原因必须可区分', () => {
  useNoConfig()
  writeProject('p-none', { capabilities: { drafts: true }, dataDir: 'drafts' })
  writeProject('p-bool', { capabilities: { generate: true }, dataDir: 'drafts' })
  try {
    const a = resolveGenerateProvider('p-none')
    assert.equal(a.code, 'generate_not_declared')
    const b = resolveGenerateProvider('p-bool')
    assert.equal(b.code, 'generate_inprocess_required')
    assert.match(b.reason, /进程内/)
    const c = resolveGenerateProvider('does-not-exist')
    assert.equal(c.code, 'project_not_registered')
  } finally {
    removeProject('p-none')
    removeProject('p-bool')
  }
})

test('解析④：项目声明了被策略拒绝的远程端点 → 明确报"被策略拒绝"，而不是静默不可用', () => {
  useNoConfig()
  writeProject('p-remote', {
    capabilities: { generate: { kind: 'http', url: 'http://gen.remote.example/generate' } },
  })
  try {
    const r = resolveGenerateProvider('p-remote')
    assert.equal(r.provided, false)
    assert.equal(r.code, 'generate_endpoint_blocked')
    assert.match(r.reason, /不是环回地址/)
  } finally {
    removeProject('p-remote')
  }
})

test('解析⑤：引擎配置登记后，同一个远程端点即可用', () => {
  useConfig('allow', { generate: { allowHosts: ['gen.remote.example'] } })
  writeProject('p-remote2', {
    capabilities: { generate: { kind: 'http', url: 'http://gen.remote.example/generate' } },
  })
  try {
    assert.equal(resolveGenerateProvider('p-remote2').provided, true)
  } finally {
    removeProject('p-remote2')
    useNoConfig()
  }
})

test('解析⑥：无项目上下文时用引擎默认声明（generate.provider）', () => {
  useConfig('default', {
    generate: { provider: { kind: 'http', url: 'http://127.0.0.1:9999/generate' } },
  })
  try {
    const r = resolveGenerateProvider(null)
    assert.equal(r.provided, true)
    assert.match(r.source, /引擎配置/)
  } finally {
    useNoConfig()
  }
})

test('解析⑦（铁律）：选中了项目就以该项目 manifest 为准，**绝不回退**到引擎默认', () => {
  // 引擎配了默认端点，同时选中一个"没声明 generate"的项目：
  // 此时必须报"该项目未声明"，而不是悄悄用引擎默认值——
  // 否则就是 v2.33 修掉的"界面写着项目 A、实际显示项目 B"那一类缺陷。
  useConfig('default2', {
    generate: { provider: { kind: 'http', url: 'http://127.0.0.1:9999/generate' } },
  })
  writeProject('p-silent', { capabilities: { drafts: true }, dataDir: 'drafts' })
  try {
    const r = resolveGenerateProvider('p-silent')
    assert.equal(r.provided, false, '不得回退到引擎默认端点')
    assert.equal(r.code, 'generate_not_declared')
    // 同一份配置下，不指定项目时默认端点是可用的 —— 证明配置本身没问题
    assert.equal(resolveGenerateProvider(null).provided, true)
  } finally {
    removeProject('p-silent')
    useNoConfig()
  }
})

/* ══════════════════════════════════════════════════════════════════
 * 三之二、宿主网关重写（2026-09-25，Docker 形态实测加的）
 *
 * 现场：宿主 8787 明明有服务在听，容器里 `127.0.0.1:8787` 是 ECONNREFUSED，
 * 而 `host.docker.internal:8787` 通 —— 因为容器里的回环指容器自己。
 * manifest 是**接入方**的文件，不该为了跑容器而改（改了原生形态又坏）。
 * ══════════════════════════════════════════════════════════════════ */

test('网关①：applyHostGateway 只重写**回环**主机名，端口/路径/查询原样保留', () => {
  const gw = 'host.docker.internal'
  const r1 = applyHostGateway('http://127.0.0.1:8787/generate?x=1', gw)
  assert.equal(r1.rewrote, true)
  assert.equal(r1.url, 'http://host.docker.internal:8787/generate?x=1')
  assert.equal(r1.from, '127.0.0.1')
  assert.equal(r1.to, gw)

  // localhost / ::1 同样算回环
  assert.equal(
    applyHostGateway('http://localhost:1234/a', gw).url,
    'http://host.docker.internal:1234/a',
  )
  assert.equal(
    applyHostGateway('http://[::1]:1234/a', gw).url,
    'http://host.docker.internal:1234/a',
  )

  // 远程主机**绝不动**（否则等于把别人的端点点到宿主网关上去）
  const remote = applyHostGateway('https://api.example.com/generate', gw)
  assert.equal(remote.rewrote, false)
  assert.equal(remote.url, 'https://api.example.com/generate')

  // 非法 URL 不炸、原样返回（交给后面的策略/请求去报错）
  assert.equal(applyHostGateway('not a url', gw).url, 'not a url')
  assert.equal(applyHostGateway('not a url', gw).rewrote, false)
})

test('网关②：不设 CROSSPOST_HOST_GATEWAY 时**行为与今天逐字节相同**', () => {
  const saved = process.env.CROSSPOST_HOST_GATEWAY
  delete process.env.CROSSPOST_HOST_GATEWAY
  useNoConfig()
  writeProject('p-gw-off', {
    capabilities: { generate: { kind: 'http', url: 'http://127.0.0.1:8787/generate' } },
  })
  try {
    const r = applyHostGateway('http://127.0.0.1:8787/generate')
    assert.equal(r.rewrote, false)
    assert.equal(r.url, 'http://127.0.0.1:8787/generate')

    const p = resolveGenerateProvider('p-gw-off')
    assert.equal(p.url, 'http://127.0.0.1:8787/generate')
    assert.equal(p.requestUrl, p.url, '没设网关时"声明"与"实拨"必须相同')
    assert.equal(p.gateway, null)
  } finally {
    removeProject('p-gw-off')
    if (saved === undefined) delete process.env.CROSSPOST_HOST_GATEWAY
    else process.env.CROSSPOST_HOST_GATEWAY = saved
  }
})

test('网关③：设了网关 → 声明值与实拨值分开；statusUrl 一并重写', () => {
  const saved = process.env.CROSSPOST_HOST_GATEWAY
  process.env.CROSSPOST_HOST_GATEWAY = 'host.docker.internal'
  useNoConfig()
  writeProject('p-gw-on', {
    capabilities: {
      generate: {
        kind: 'http',
        url: 'http://127.0.0.1:8787/generate',
        statusUrl: 'http://127.0.0.1:8787/status',
      },
    },
  })
  try {
    const p = resolveGenerateProvider('p-gw-on')
    assert.equal(p.url, 'http://127.0.0.1:8787/generate', '展示/策略仍用声明值')
    assert.equal(p.requestUrl, 'http://host.docker.internal:8787/generate', '实拨走网关')
    assert.equal(p.statusUrl, 'http://127.0.0.1:8787/status')
    assert.equal(
      p.requestStatusUrl,
      'http://host.docker.internal:8787/status',
      'statusUrl 也要重写',
    )
    assert.deepEqual(p.gateway, { from: '127.0.0.1', to: 'host.docker.internal' })
    // 报错文案要能看出"声明 → 实拨"，否则会报一个没拨过的地址
    assert.match(
      dialNote(p),
      /声明 http:\/\/127\.0\.0\.1:8787\/generate → 实际拨号 http:\/\/host\.docker\.internal:8787\/generate/,
    )
  } finally {
    removeProject('p-gw-on')
    if (saved === undefined) delete process.env.CROSSPOST_HOST_GATEWAY
    else process.env.CROSSPOST_HOST_GATEWAY = saved
  }
})

test('网关④：策略仍按**声明值**判 —— 重写出来的非环回宿主机不会被当成"未登记端点"', () => {
  const saved = process.env.CROSSPOST_HOST_GATEWAY
  process.env.CROSSPOST_HOST_GATEWAY = 'host.docker.internal'
  useNoConfig()
  // 声明的是环回 → 策略放行；重写后是 host.docker.internal（非环回）→ 若拿重写值去判就会被拒。
  writeProject('p-gw-policy', {
    capabilities: { generate: { kind: 'http', url: 'http://127.0.0.1:8787/generate' } },
  })
  writeProject('p-gw-remote', {
    capabilities: { generate: { kind: 'http', url: 'http://10.0.0.9:8787/generate' } },
  })
  try {
    const p = resolveGenerateProvider('p-gw-policy')
    assert.equal(p.provided, true, '环回声明 + 网关重写 → 仍然可用（策略只看声明值）')
    // 而真正未登记的远程端点，有没有网关都必须被拒
    const bad = resolveGenerateProvider('p-gw-remote')
    assert.equal(bad.provided, false)
    assert.equal(bad.code, 'generate_endpoint_blocked')
  } finally {
    removeProject('p-gw-policy')
    removeProject('p-gw-remote')
    if (saved === undefined) delete process.env.CROSSPOST_HOST_GATEWAY
    else process.env.CROSSPOST_HOST_GATEWAY = saved
  }
})

test('网关⑤：probeEndpoint 探的是**实拨地址**（否则会"体检说连不上、其实能生成"）', async () => {
  const saved = process.env.CROSSPOST_HOST_GATEWAY
  // 起一个只监听 127.0.0.1 的假端点，把"网关"指向 127.0.0.1 本身，
  // 而声明写成 localhost —— 只有探实拨值才会通。
  const srv = http.createServer((_req, res) => res.end('{}'))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  process.env.CROSSPOST_HOST_GATEWAY = '127.0.0.1'
  useNoConfig()
  writeProject('p-gw-probe', {
    capabilities: { generate: { kind: 'http', url: `http://localhost:${port}/generate` } },
  })
  try {
    const p = resolveGenerateProvider('p-gw-probe')
    assert.equal(p.requestUrl, `http://127.0.0.1:${port}/generate`)
    const probe = await probeEndpoint(p)
    assert.equal(probe.reachable, true, '探实拨地址应当连通')
    assert.equal(probe.declaredUrl, p.url, '结果里要能看出声明值，便于排障')
  } finally {
    removeProject('p-gw-probe')
    srv.close()
    if (saved === undefined) delete process.env.CROSSPOST_HOST_GATEWAY
    else process.env.CROSSPOST_HOST_GATEWAY = saved
  }
})

/* ══════════════════════════════════════════════════════════════════
 * 四、调用层：同步 / 异步 / 全部失败路径
 * ══════════════════════════════════════════════════════════════════ */

test('调用①：同步模式 —— 端点直接回 done', async () => {
  let seen = null
  await withServer(
    async (req, res) => {
      seen = await readJsonBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ taskId: 't-1', logFile: '/tmp/a.log', logTail: 'ok' }))
    },
    async (base) => {
      const r = await callGenerateProvider(providerFor(`${base}/generate`), {
        slot: 'noon',
        keyword: KEYWORD,
        projectId: 'p-x',
      })
      assert.deepEqual(r, {
        taskId: 't-1',
        draftId: null,
        logFile: '/tmp/a.log',
        logTail: 'ok',
      })
      assert.equal(seen.slot, 'noon')
      assert.equal(seen.keyword, KEYWORD)
      assert.equal(seen.projectId, 'p-x')
      assert.equal(seen.contractVersion, 2)
    },
  )
})

test('调用②：异步模式 —— 受理后轮询 statusUrl 直到 done，并把进度回调出去', async () => {
  let polls = 0
  const progress = []
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/status')) {
        polls++
        const done = polls >= 3
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            taskId: 't-2',
            state: done ? 'done' : 'running',
            logFile: '/tmp/b.log',
            logTail: `第 ${polls} 次`,
          }),
        )
        return
      }
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ taskId: 't-2', state: 'running', logFile: '/tmp/b.log' }))
    },
    async (base) => {
      const r = await callGenerateProvider(
        providerFor(`${base}/generate`, {
          statusUrl: `${base}/status`,
          pollIntervalMs: 250,
          overallTimeoutMs: 8000,
        }),
        {
          slot: 'noon',
          keyword: KEYWORD,
          onProgress: (p) => progress.push(p.logTail),
        },
      )
      assert.equal(r.taskId, 't-2')
      assert.equal(polls, 3, '应在第 3 次轮询读到 done 后停止')
      assert.deepEqual(progress.filter(Boolean), ['第 1 次', '第 2 次', '第 3 次'])
    },
  )
})

test('调用③：端点回 running 但没声明 statusUrl → 明确报契约缺项（不假装成功）', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ taskId: 't-3', state: 'running' }))
    },
    async (base) => {
      const r = await callGenerateProvider(providerFor(`${base}/generate`), { slot: 'noon' })
      assert.equal(r.error, 'generate_provider_async_unsupported')
      assert.match(r.message, /statusUrl/)
    },
  )
})

test('调用④：端点报告 failed / 4xx / 5xx → 一律映射成可读的失败，绝不抛异常', async () => {
  const status = { code: 500, body: { error: 'boom', message: '生成器崩了' } }
  await withServer(
    (req, res) => {
      res.writeHead(status.code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status.body))
    },
    async (base) => {
      const r = await callGenerateProvider(providerFor(`${base}/generate`), { slot: 'noon' })
      assert.equal(r.error, 'generate_provider_failed')
      assert.match(r.message, /生成器崩了/, '项目侧的人话必须透传到 Console')

      status.code = 200
      status.body = { state: 'failed', message: '内容审核不通过' }
      const r2 = await callGenerateProvider(providerFor(`${base}/generate`), { slot: 'noon' })
      assert.equal(r2.error, 'generate_provider_failed')
      assert.match(r2.message, /内容审核不通过/)

      status.body = { error: 'rejected', message: '今天不生成这个栏目' }
      const r3 = await callGenerateProvider(providerFor(`${base}/generate`), { slot: 'noon' })
      assert.equal(r3.error, 'generate_provider_rejected')
      assert.match(r3.message, /今天不生成/)
    },
  )
})

test('调用⑤：重定向 / 非 JSON / 未知 state → 三种坏响应各有专属错误码', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { location: 'http://evil.example.com/' })
      res.end()
    },
    async (base) => {
      const r = await callGenerateProvider(providerFor(`${base}/generate`), { slot: 'noon' })
      assert.equal(r.error, 'generate_provider_redirect')
    },
  )

  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>不是 JSON</html>')
    },
    async (base) => {
      const r = await callGenerateProvider(providerFor(`${base}/generate`), { slot: 'noon' })
      assert.equal(r.error, 'generate_provider_bad_response')
    },
  )

  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ state: 'wat' }))
    },
    async (base) => {
      const r = await callGenerateProvider(providerFor(`${base}/generate`), { slot: 'noon' })
      assert.equal(r.error, 'generate_provider_bad_response')
      assert.match(r.message, /未知 state/)
    },
  )
})

test('调用⑥：连不上 / 不响应 → unreachable / timeout（有界，不吊死）', async () => {
  // 先占一个端口再关掉，拿到一个"确定没人监听"的地址
  const dead = http.createServer(() => {})
  const deadPort = await listen(dead)
  await new Promise((r) => dead.close(r))
  const r = await callGenerateProvider(
    providerFor(`http://127.0.0.1:${deadPort}/generate`, { timeoutMs: 1000 }),
    { slot: 'noon' },
  )
  assert.equal(r.error, 'generate_provider_unreachable')

  // 端点接到请求但永不响应 → 必须在 timeoutMs 内失败
  await withServer(
    () => {
      /* 故意不响应 */
    },
    async (base) => {
      const t0 = Date.now()
      const rt = await callGenerateProvider(providerFor(`${base}/generate`, { timeoutMs: 400 }), {
        slot: 'noon',
      })
      assert.equal(rt.error, 'generate_provider_timeout')
      assert.ok(Date.now() - t0 < 5000, '超时必须生效，不能无限等待')
    },
  )
})

test('调用⑦：异步任务整任务超时 → generate_provider_timeout（不是静默挂着）', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        req.url.startsWith('/status')
          ? JSON.stringify({ taskId: 't-7', state: 'running' })
          : JSON.stringify({ taskId: 't-7', state: 'running' }),
      )
    },
    async (base) => {
      const t0 = Date.now()
      const r = await callGenerateProvider(
        providerFor(`${base}/generate`, {
          statusUrl: `${base}/status`,
          pollIntervalMs: 250,
          overallTimeoutMs: 1000,
        }),
        { slot: 'noon' },
      )
      assert.equal(r.error, 'generate_provider_timeout')
      assert.ok(Date.now() - t0 < 6000)
    },
  )
})

test('调用⑧：tokenEnv 指向的环境变量非空时才带 Authorization（manifest 里不留密钥）', async () => {
  let auth = null
  await withServer(
    (req, res) => {
      auth = req.headers.authorization || null
      if (req.headers.authorization !== 'Bearer s3cret') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized', message: '令牌不对' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ taskId: 't-8' }))
    },
    async (base) => {
      const p = providerFor(`${base}/generate`, { tokenEnv: 'CROSSPOST_TEST_GEN_TOKEN' })
      delete process.env.CROSSPOST_TEST_GEN_TOKEN
      const bad = await callGenerateProvider(p, { slot: 'noon' })
      assert.equal(bad.error, 'generate_provider_failed')
      assert.match(bad.message, /401/)
      assert.equal(auth, null, '没有配环境变量时不该凭空造一个头')

      process.env.CROSSPOST_TEST_GEN_TOKEN = 's3cret'
      try {
        const good = await callGenerateProvider(p, { slot: 'noon' })
        assert.equal(good.taskId, 't-8')
        assert.equal(auth, 'Bearer s3cret')
      } finally {
        delete process.env.CROSSPOST_TEST_GEN_TOKEN
      }
    },
  )
})

/* ══════════════════════════════════════════════════════════════════
 * 五、参考实现（examples/generate-provider-http）本身要真的能用
 * ══════════════════════════════════════════════════════════════════ */

test('参考实现①：受理 / 轮询 / 完成全流程，且 slot+keyword 以 argv 传递（不经 shell）', async () => {
  const logsDir = path.join(SANDBOX, 'provider-logs')
  const script = path.join(SANDBOX, 'fake-generate.sh')
  fs.writeFileSync(
    script,
    '#!/bin/sh\n' +
      'echo "slot=$1 keyword=$2"\n' +
      'sleep 0.3\n' +
      'echo "done"\n' +
      // 约定：生成脚本用这一行报告"我产出了哪个草稿"
      'echo "[draft-id] 2026-09-19-noon-fake-article"\n' +
      'exit 0\n',
    { mode: 0o755 },
  )
  const server = createGenerateServer({
    bin: '/bin/sh',
    args: [script],
    logsDir,
    concurrency: 1,
    timeoutMs: 10000,
  })
  const port = await listen(server)
  try {
    const provider = providerFor(`http://127.0.0.1:${port}/generate`, {
      statusUrl: `http://127.0.0.1:${port}/status`,
      pollIntervalMs: 250,
      overallTimeoutMs: 15000,
    })
    // 关键词里塞 shell 元字符：argv 传参下它只能是普通字符串
    const nasty = `${KEYWORD}; touch ${SANDBOX}/PWNED; $(id)`
    const r = await callGenerateProvider(provider, { slot: 'noon', keyword: nasty })
    assert.equal(r.error, undefined, `应成功，实际 ${JSON.stringify(r)}`)
    assert.ok(r.taskId, '应回传 taskId')
    assert.match(r.logTail, /slot=noon/)
    assert.match(r.logTail, /keyword=.*__gen_test_/)
    // v2.54：draftId 必须是**脚本报告的文章 id**，不是提供者的 taskId
    assert.equal(
      r.draftId,
      '2026-09-19-noon-fake-article',
      '应捡取 stdout 里的 [draft-id] 标记并上报（引擎据此建 Console 链接）',
    )
    assert.notEqual(r.draftId, r.taskId, 'draftId 与 taskId 绝不能是同一个值')
    assert.ok(
      !fs.existsSync(path.join(SANDBOX, 'PWNED')),
      'keyword 里的 shell 命令**绝不能**被执行',
    )
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('调用⑨：draftId 与 taskId 分离 —— 没报告时必须留空，**不得**用 taskId 顶替', async () => {
  // 同步完成、但脚本不打印 [draft-id]：引擎必须如实返回 draftId=null。
  // 用 taskId 顶替会让选题库写入一个不存在的 articleId，Console 的
  // 「查看《…》」链接必然 404 —— 这正是 v2.54 修掉的缺陷。
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ taskId: 'only-a-task-id', logTail: 'no marker here' }))
    },
    async (base) => {
      const r = await callGenerateProvider(providerFor(`${base}/generate`), { slot: 'noon' })
      assert.equal(r.taskId, 'only-a-task-id')
      assert.equal(r.draftId, null, '没报告 draftId 就必须是 null，不能拿 taskId 顶替')
    },
  )

  // 报告了 [draft-id] 的异步路径同样要带上它
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        req.url.startsWith('/status')
          ? JSON.stringify({ taskId: 't-9', state: 'done', draftId: '2026-09-19-tips-real' })
          : JSON.stringify({ taskId: 't-9', state: 'running' }),
      )
    },
    async (base) => {
      const r = await callGenerateProvider(
        providerFor(`${base}/generate`, { statusUrl: `${base}/status`, pollIntervalMs: 250 }),
        { slot: 'noon' },
      )
      assert.equal(r.draftId, '2026-09-19-tips-real')
      assert.equal(r.taskId, 't-9', 'taskId 仍要保留（排障用，与 draftId 各归各）')
    },
  )
})

test('参考实现②：并发上限生效（第二个任务得到 409，被映射成可读的"正忙"）', async () => {
  const logsDir = path.join(SANDBOX, 'provider-logs2')
  const script = path.join(SANDBOX, 'slow-generate.sh')
  fs.writeFileSync(script, '#!/bin/sh\nsleep 2\nexit 0\n', { mode: 0o755 })
  const server = createGenerateServer({
    bin: '/bin/sh',
    args: [script],
    logsDir,
    concurrency: 1,
    timeoutMs: 10000,
  })
  const port = await listen(server)
  try {
    const provider = providerFor(`http://127.0.0.1:${port}/generate`, {
      statusUrl: `http://127.0.0.1:${port}/status`,
      pollIntervalMs: 200,
      overallTimeoutMs: 10000,
    })
    // 关键：**不要 await 第一个**。callGenerateProvider 从调用方看是"跑到完"的
    // （异步模式下它会一直轮询到 done），所以"并发"必须真的重叠才测得到。
    const first = callGenerateProvider(provider, { slot: 'noon', keyword: 'a' })
    await new Promise((r) => setTimeout(r, 400)) // 等第一个任务确实被受理并在跑
    const second = await callGenerateProvider(provider, { slot: 'noon', keyword: 'b' })
    // v2.111：409 从"失败"里拆出来了。项目侧还在跑 ≠ 生成失败——
    // 落成 generate_provider_failed 会让用户去排错，而其实只需要等一会。
    assert.equal(second.error, 'generate_provider_busy')
    assert.equal(second.busy, true, '必须能机器识别这是"忙"，供引擎决定是否退避重试')
    assert.match(second.message, /409|正忙|并发|busy/)
    const firstOut = await first
    assert.ok(firstOut.taskId, `第一个任务应正常跑完，实际 ${JSON.stringify(firstOut)}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('参考实现②b：409 的退避重试按开关走（关：一次就回；开：重试后仍忙则如实上报）', async () => {
  // 用一个**永远回 409** 的桩端点来数 POST 次数：这比"靠 sleep 卡项目侧并发"
  // 稳定得多——时间敏感的重试用真实并发去测，必然在慢机器上飘。
  let posts = 0
  await withServer(
    async (req, res) => {
      if (req.method === 'POST') posts += 1
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'busy', message: '已有 1 个生成任务在运行（并发上限 1）' }))
    },
    async (base) => {
      const provider = providerFor(`${base}/generate`, { statusUrl: `${base}/status` })

      // ① 默认：只发一次，回结构化"正忙"（不偷偷重试）
      posts = 0
      const noRetry = await callGenerateProvider(provider, { slot: 'noon', keyword: 'x' })
      assert.equal(noRetry.error, 'generate_provider_busy')
      assert.equal(noRetry.busy, true)
      assert.equal(posts, 1, `缺省不该重试，实际发了 ${posts} 次`)

      // ② 打开退避：会重试若干次；退避基数 2s，所以这里只断言"确实多发了"
      posts = 0
      const retried = await callGenerateProvider(provider, {
        slot: 'noon',
        keyword: 'y',
        allowBusyRetry: true,
      })
      assert.equal(retried.error, 'generate_provider_busy', '一直忙就要如实上报，不能装作失败/成功')
      assert.ok(posts > 1, `打开退避后应重发，实际只发了 ${posts} 次`)
      assert.match(retried.message, /正忙/)
    },
  )
})

test('参考实现③：未设 token 时不做鉴权；设了 token 则 401（探活端点除外）', async () => {
  const server = createGenerateServer({
    bin: '/bin/sh',
    args: ['-c', 'true'],
    token: 'topsecret',
    logsDir: path.join(SANDBOX, 'provider-logs3'),
  })
  const port = await listen(server)
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.status)
    assert.equal(health, 200, '/health 不需要鉴权')
    const unauth = await fetch(`http://127.0.0.1:${port}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'noon', keyword: 'x' }),
    }).then((r) => r.status)
    assert.equal(unauth, 401)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

/* ══════════════════════════════════════════════════════════════════
 * 六、桥接层：能力状态可自证 + 不写生产
 * ══════════════════════════════════════════════════════════════════ */

test('桥接①：未提供能力时 startTopicGenerate 立即给出结构化拒绝，且不产生副作用', async () => {
  useNoConfig()
  const logsBefore = fs.readdirSync(LOGS)
  const topics = await import('../../bridge/topics.mjs')
  const r = await topics.startTopicGenerate('noon', '不该被生成的关键词')
  assert.equal(r.error, 'generate_not_provided')
  assert.equal(r.provided, false)
  assert.ok(r.reason, '必须带上可读原因（Console 直接展示它）')
  assert.deepEqual(fs.readdirSync(LOGS), logsBefore, '未提供能力时不该写任何日志文件')
  fs.writeFileSync(TOPIC_POOL, JSON.stringify({ topics: [] }))
})

test('桥接②：走 manifest 声明的 HTTP 端点跑通一次「一键生成」，并回填选题库', async () => {
  const logsDir = path.join(SANDBOX, 'bridge-provider-logs')
  const script = path.join(SANDBOX, 'bridge-generate.sh')
  fs.writeFileSync(
    script,
    '#!/bin/sh\necho "生成中 slot=$1 keyword=$2"\necho "[draft-id] 2026-09-19-noon-e2e-article"\nexit 0\n',
    { mode: 0o755 },
  )
  const server = createGenerateServer({ bin: '/bin/sh', args: [script], logsDir, timeoutMs: 10000 })
  const port = await listen(server)

  writeProject('p-e2e', {
    capabilities: {
      drafts: true,
      generate: {
        kind: 'http',
        url: `http://127.0.0.1:${port}/generate`,
        statusUrl: `http://127.0.0.1:${port}/status`,
        pollIntervalMs: 250,
        overallTimeoutMs: 15000,
      },
    },
    dataDir: 'drafts',
  })
  // v2.76：选题库**跟着项目走**——`p-e2e` 的 dataDir='drafts' 落在 <PROJECTS>/p-e2e/drafts，
  // 内容工作区就是 <PROJECTS>/p-e2e，于是它的选题库在 <工作区>/history/topic-pool.json。
  // 默认域那一份（env CROSSPOST_TOPIC_POOL = TOPIC_POOL）不再被项目写入碰到，下面一并断言。
  const projectPool = path.join(PROJECTS, 'p-e2e', 'history', 'topic-pool.json')
  fs.mkdirSync(path.dirname(projectPool), { recursive: true })
  fs.writeFileSync(
    TOPIC_POOL,
    JSON.stringify({ topics: [{ slot: 'noon', keyword: '默认域不该被碰', status: 'adopted' }] }),
  )
  fs.writeFileSync(
    projectPool,
    JSON.stringify({ topics: [{ slot: 'noon', keyword: KEYWORD, status: 'adopted' }] }),
  )

  try {
    const topics = await import('../../bridge/topics.mjs')
    const { withProject } = await import('../src/project-context.mjs')
    const r = withProject('p-e2e', () => topics.startTopicGenerate('noon', KEYWORD))
    assert.equal(r.ok, true, `应受理，实际 ${JSON.stringify(r)}`)
    assert.equal(r.task.providerKind, 'http')

    // 轮询到收敛（异步模式：受理不等于完成）
    // v2.111：判据从"代表任务不是 running"改成"**没有任何任务**在跑或排队"。
    // 队列化之后 `st.state` 是"代表任务"的状态，单看它可能在还有排队任务时就报 done。
    let st = null
    for (let i = 0; i < 60; i++) {
      st = withProject('p-e2e', () => topics.getTopicGenStatus())
      const busy = st.tasks.some((t) => t.state === 'running' || t.state === 'queued')
      if (!busy) break
      await new Promise((r2) => setTimeout(r2, 100))
    }
    assert.equal(st.state, 'done', `最终状态应为 done，实际 ${JSON.stringify(st)}`)
    assert.equal(st.provided, true, '在项目上下文里应报"能力已提供"')
    assert.equal(st.provider.kind, 'http')
    assert.match(st.provider.url, /127\.0\.0\.1/)
    // v2.54：draftId 必须是**生成脚本报告的草稿 id**（不是提供者 taskId）
    assert.equal(st.draftId, '2026-09-19-noon-e2e-article')
    assert.ok(st.providerTaskId, '提供者的 taskId 另存 providerTaskId，供排障')
    assert.notEqual(st.draftId, st.providerTaskId, 'draftId 与 taskId 必须各归各')
    assert.match(st.logTail, /生成中 slot=noon/, '日志尾应透传到状态接口')

    // 回填：**项目自己的**选题库那条应从 adopted 变 generated 并带上 articleId
    const pool = JSON.parse(fs.readFileSync(projectPool, 'utf8'))
    const t = pool.topics.find((x) => x.keyword === KEYWORD)
    assert.equal(t.status, 'generated')
    assert.equal(t.articleId, st.draftId)

    // 隔离：默认域那一份必须原封不动（只有"默认域不该被碰"那一条，且没有测试关键词）
    const defPool = JSON.parse(fs.readFileSync(TOPIC_POOL, 'utf8'))
    assert.equal(
      defPool.topics.find((x) => x.keyword === KEYWORD),
      undefined,
      '项目写入不该落到默认域选题库',
    )
  } finally {
    removeProject('p-e2e')
    await new Promise((r) => server.close(r))
  }
})

test('探活①：probeEndpoint 只做 TCP 连接（连得上 true / 没人听 false）', async () => {
  const server = http.createServer(() => {})
  const port = await listen(server)
  try {
    const ok = await probeEndpoint({ url: `http://127.0.0.1:${port}/generate` })
    assert.equal(ok.reachable, true, JSON.stringify(ok))
  } finally {
    await new Promise((r) => server.close(r))
  }
  const dead = http.createServer(() => {})
  const deadPort = await listen(dead)
  await new Promise((r) => dead.close(r))
  const bad = await probeEndpoint({ url: `http://127.0.0.1:${deadPort}/generate`, timeoutMs: 800 })
  assert.equal(bad.reachable, false)
  assert.ok(bad.reason, '不可达必须带原因，否则 doctor 只能报"失败"')
})

/* ══════════════════════════════════════════════════════════════════
 * 七、污染守卫 —— 必须放在最后（依赖前面所有用例都跑过）
 * ══════════════════════════════════════════════════════════════════ */

test('守卫①：本次测试的随机 keyword 没有漏进生产选题库', () => {
  if (!PROD_TOPIC_POOL || !fs.existsSync(PROD_TOPIC_POOL)) {
    // 生产选题库不存在 = 不存在"漏进去"的可能（全新安装场景）
    return
  }
  const raw = fs.readFileSync(PROD_TOPIC_POOL, 'utf8')
  assert.ok(
    !raw.includes(KEYWORD),
    `测试关键词 ${KEYWORD} 出现在生产选题库 ${PROD_TOPIC_POOL} 里 —— 隔离失效，必须修`,
  )
  assert.ok(!raw.includes('__gen_test_'), `生产选题库里出现了任何测试关键词：${PROD_TOPIC_POOL}`)
})

test('守卫②：本测试文件所写的文件全部落在临时沙箱内', () => {
  assert.ok(SANDBOX.startsWith(os.tmpdir()), 'SANDBOX 必须在系统临时目录下')
  assert.ok(TOPIC_POOL.startsWith(SANDBOX))
  assert.ok(LOGS.startsWith(SANDBOX))
  if (PROD_TOPIC_POOL) assert.ok(!PROD_TOPIC_POOL.startsWith(SANDBOX), '生产路径不该落在沙箱里')
})

test('守卫③：项目注册表只剩本沙箱的目录（没有污染真实项目扫描结果）', () => {
  // PROJECTS 是沙箱目录；这里确认注册表扫到的项目都来自沙箱
  for (const p of listProjects()) {
    assert.ok(
      p.sourcePath.startsWith(PROJECTS),
      `注册表扫到了沙箱外的项目：${p.sourcePath}（会污染真实部署）`,
    )
  }
})
