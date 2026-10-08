// preset 插件挂载契约测试（2026-10-03，DSH 0.2.0 换预设载体时建立）
//
// 为什么需要它：`preset/crosspost/plugins/crosspost.js` 是一个**消费宿主服务的静态插件**——
// 它 `inject: ['tools','fs','shell','subprocess','timer']`，并依赖这些服务的**具体形状**：
//
//   · `ctx.tools.register(defineTool({...}))`  —— 工具注册
//   · `ctx.get('shell').resolve({command})` + `.run(spec)` → `{ stdout: { text } }`
//   · `ctx.get('subprocess').spawn({ argv, cwd, stdio, graceMs, env })` —— 自拉起桥
//   · `ctx.get('fs').resolve/writeText/readText`
//   · `ctx.get('timer').timeout(ms)`、`ctx.effect(fn)`
//
// 这些形状**每升级一次 DSH 都可能变**，而症状是"工具在、调不动"或"桥起不来"——
// 0.2.0 这次就实证过一次同类事故：`@deepseek-ai/dsh-workflow-worker-thread` 整包被换掉，
// 预设里那一行静默消失（`preset/upgrade-check.sh` 第 3b 节现在专门抓这个）。
// 早前的护栏只做到"插件能被 import"（deployment-consistency 的第 3 条）——**import 成功
// 不等于服务形状还对**。这里用一个**桩 ctx** 真跑一遍 apply + 真调一个工具，把形状钉住。
//
// 环境假设：需要 `@deepseek-ai/dsh-tools`（即本机装了 DSH）。干净 clone 里跳过而不是失败
// ——与 deployment-consistency 的同名取舍一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const PLUGIN = path.join(REPO, 'preset', 'crosspost', 'plugins', 'crosspost.js')

function canResolveDshTools() {
  try {
    createRequire(path.join(REPO, 'preset', 'crosspost', 'plugins', 'x.js')).resolve(
      '@deepseek-ai/dsh-tools',
    )
    return true
  } catch {
    return false
  }
}

/** 7 个 xp_* 工具名（单一真源：本数组 + 下面的挂载断言） */
const EXPECTED_TOOLS = [
  'xp_status',
  'xp_list_platforms',
  'xp_check_auth',
  'xp_sync_article',
  'xp_extract_article',
  'xp_upload_image_file',
  'xp_proxy_test',
]

/**
 * 桩 ctx：只实现插件真正用到的那些成员，并把调用记下来。
 * 有意**不**追求与 Cordis 一致（那是宿主的事），只追求"形状对不上就报错"。
 */
function makeStubCtx({ shellReply = '{}' } = {}) {
  const registered = []
  const shellCalls = []
  const spawned = []
  const disposers = []
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    get(name) {
      if (name === 'fs')
        return {
          resolve: async (p) => p,
          writeText: async (target, text) => {
            fs.writeFileSync(target, text)
          },
          readText: async (target) => fs.readFileSync(target, 'utf8'),
        }
      if (name === 'shell')
        return {
          resolve: (spec) => {
            assert.ok(spec && typeof spec.command === 'string', 'shell.resolve 需要 { command }')
            return { __spec: spec }
          },
          run: async (spec) => {
            shellCalls.push(spec)
            return { stdout: { text: shellReply } }
          },
        }
      if (name === 'subprocess')
        return {
          spawn: (opts) => {
            spawned.push(opts)
            return { terminate: () => spawned.push({ __terminated: true }) }
          },
        }
      if (name === 'timer') return { timeout: async () => {} }
      return undefined
    },
    effect: (fn) => {
      disposers.push(fn())
    },
  }
  return { ctx, registered, shellCalls, spawned, disposers }
}

test('preset 插件挂载：注入 5 个宿主服务，注册 7 个 xp_* 工具', async (t) => {
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过挂载检查')
    return
  }
  const mod = await import(new URL(`file://${PLUGIN}`).href)
  assert.deepEqual(
    mod.inject,
    ['tools', 'fs', 'shell', 'subprocess', 'timer'],
    'inject 列表变了：宿主少给/改名任何一个，apply 里 ctx.get 就会拿到 undefined',
  )

  const { ctx, registered } = makeStubCtx()
  mod.apply(ctx)
  assert.deepEqual(
    registered.map((r) => r.name).sort(),
    [...EXPECTED_TOOLS].sort(),
    '注册的工具集与预期不一致（少一个 = 会话里少一个能力；多一个 = 忘了更新本测试）',
  )
  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string', `${tool.name} 缺 description`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺 execute`)
    assert.ok(tool.parameters && typeof tool.parameters === 'object', `${tool.name} 缺 parameters`)
    assert.ok(tool.output && tool.output.schema, `${tool.name} 缺 output.schema`)
  }
})

test('preset 插件挂载：xp_status 真调一次（shell.resolve/run → JSON → 形状映射）', async (t) => {
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过挂载检查')
    return
  }
  const mod = await import(new URL(`file://${PLUGIN}`).href)
  const { ctx, registered, shellCalls } = makeStubCtx({
    shellReply: JSON.stringify({
      proxyMode: true,
      connected: true,
      lastProxyAt: '2026-10-03T00:00:00Z',
    }),
  })
  mod.apply(ctx)

  const tool = registered.find((r) => r.name === 'xp_status')
  const out = await tool.execute({}, {})

  assert.equal(
    shellCalls.length,
    1,
    'xp_status 应恰好走一次 shell.run（桩里 run 才拿得到 stdout.text）',
  )
  assert.match(
    String(shellCalls[0].__spec.command),
    /cli\.mjs proxyStatus$/,
    '命令行形状变了：插件按 `"<node>" "<…/cli.mjs>" proxyStatus` 拼接，宿主 shell 解析的是字符串命令',
  )
  assert.deepEqual(
    out,
    {
      proxyMode: true,
      proxyConnected: true,
      lastProxyAt: '2026-10-03T00:00:00Z',
      bridgeUp: true,
      error: null,
    },
    '输出形状变了（nativeCall → JSON.parse → safe() 那条链）',
  )
})

/** 临时替换全局 fetch，跑完恢复（插件用全局 fetch 探测"本机是否已有桥"） */
async function withFetch(stub, fn) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url))
    return stub(String(url), opts)
  }
  try {
    return { result: await fn(), calls }
  } finally {
    globalThis.fetch = real
  }
}

/** 等异步的探测/自拉起跑完（探测是 await 出来的，spawn 在其后） */
const settle = () => new Promise((r) => setTimeout(r, 20))

test('preset 插件挂载：没有桥时自拉起，dispose 收掉（subprocess.spawn 形状）', async (t) => {
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过挂载检查')
    return
  }
  const mod = await import(new URL(`file://${PLUGIN}`).href)
  const { ctx, spawned, disposers } = makeStubCtx()
  const { calls } = await withFetch(
    // 探测失败 = 本机没有桥 → 应当自拉起
    () => Promise.reject(new Error('ECONNREFUSED')),
    async () => {
      mod.apply(ctx)
      await settle()
    },
  )

  assert.equal(calls.length, 1, '自拉起前必须先探测一次（探测口径见插件里的 bridgeAlive）')
  assert.match(calls[0], /\/proxy\/bootstrap$/, '探测走免鉴权的 /proxy/bootstrap（与 doctor 同源）')
  assert.equal(spawned.length, 1, '没有桥时应当自拉起一次桥')
  const opts = spawned[0]
  assert.ok(Array.isArray(opts.argv) && opts.argv.length >= 2, 'subprocess.spawn 需要 argv 数组')
  assert.equal(
    opts.argv[0],
    process.env.CROSSPOST_NODE || process.execPath,
    'argv[0] 应是当前 node',
  )
  assert.match(
    String(opts.argv[1]),
    /bridge[\\/]run-bridge\.mjs$/,
    'argv[1] 应指向 bridge/run-bridge.mjs（经 runtime 软链的路径推导）',
  )
  assert.ok(
    typeof opts.cwd === 'string' && fs.existsSync(opts.cwd),
    `spawn 的 cwd 必须存在（实际 ${opts.cwd}）——它由 runtime 软链推导，软链断掉就会落到不存在的路径`,
  )
  assert.equal(typeof opts.graceMs, 'number', 'subprocess.spawn 需要 graceMs（宿主用它兜住退出）')
  assert.ok(opts.stdio && typeof opts.stdio === 'object', 'subprocess.spawn 需要 stdio 描述')

  assert.equal(disposers.length, 1, 'ctx.effect 应登记 1 个 disposer')
  disposers[0]()
  assert.ok(
    spawned.some((s) => s.__terminated),
    'dispose 必须调用 handle.terminate()，否则会话结束会留下孤儿子进程',
  )
})

test('preset 插件挂载：本机已有桥 → 不再自拉起（双桥会抢调度锁）', async (t) => {
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过挂载检查')
    return
  }
  const mod = await import(new URL(`file://${PLUGIN}`).href)
  const { ctx, spawned } = makeStubCtx()
  await withFetch(
    // 已有桥在应答（/proxy/bootstrap 返回 token）
    async () => ({ ok: true, json: async () => ({ token: 'stub-token' }) }),
    async () => {
      mod.apply(ctx)
      await settle()
    },
  )

  assert.equal(
    spawned.length,
    0,
    '本机已有桥时不得再起一个：两个桥会抢同一个调度锁（容器会按设计拒绝，' +
      '而定时器就此绑在自拉起的那个桥上，GUI 一关就静默停摆）',
  )
})

test('preset 插件挂载：端口上不是我们的桥（拿不到 token）→ 仍然自拉起', async (t) => {
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过挂载检查')
    return
  }
  const mod = await import(new URL(`file://${PLUGIN}`).href)
  const { ctx, spawned } = makeStubCtx()
  await withFetch(
    // 端口上确实有服务，但不是我们的桥（没有 token）——不能因此就不拉起
    async () => ({ ok: true, json: async () => ({ hello: 'not-our-bridge' }) }),
    async () => {
      mod.apply(ctx)
      await settle()
    },
  )
  assert.equal(spawned.length, 1, '判定要认结构（token），不能只看"端口有人应答"')
})

// ── 人用斜杠指令（plugins/commands.js）────────────────────────────────────────
//
// 这组测试守两件事：
//   ① **注册面**：`ctx.commands.register` 的入参形状（name/description/handler）——它变了
//      指令就会静默消失（与 xp_* 工具那一组同族的失败模式）；
//   ② **内容域**：涉及内容的指令必须传 `--project=`。GUI 会话的 web profile 没有
//      `CROSSPOST_PROJECT`，不带项目时读的是**默认域（空的）**——这正是"查不到项目内容"的成因。
//      测试用 stub 断言第二条 spawn 的 argv 里真的有 `--project=<本机唯一在册项目>`。

const COMMANDS_PLUGIN = path.join(REPO, 'preset', 'crosspost', 'plugins', 'commands.js')

const EXPECTED_COMMANDS = [
  'crosspost-status',
  'crosspost-projects',
  'crosspost-platforms',
  'crosspost-styles',
  'crosspost-drafts',
  'crosspost-costs',
  'crosspost-help',
]

/**
 * 桩 ctx（commands 版）：实现 `commands.register`、`subprocess.spawn`（含可读的 collected
 * stdout）、`timer.timeout`，并按 **method 名**给每次 CLI 调用一个可编程的 JSON 回复。
 * `effect` 会驱动生成器（本插件用 `ctx.effect(function*(){ yield register(...) })`）。
 */
function makeCommandsStubCtx({ cliReplies = {} } = {}) {
  const registeredCommands = []
  const spawnedArgvs = []
  const ctx = {
    commands: {
      register: (def) => {
        registeredCommands.push(def)
        return () => {}
      },
    },
    get(name) {
      if (name === 'subprocess')
        return {
          spawn: (opts) => {
            spawnedArgvs.push(opts.argv)
            const method = opts.argv[2]
            const reply =
              typeof cliReplies[method] === 'function'
                ? cliReplies[method](opts.argv)
                : cliReplies[method]
            const text =
              JSON.stringify(
                reply === undefined ? { error: `stub 没有为 ${method} 准备回复` } : reply,
              ) + '\n'
            return {
              done: Promise.resolve({ exitCode: 0, signal: null }),
              collected: {
                stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
                stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
              },
              terminate: () => {},
            }
          },
        }
      // 永不 resolve：超时分支在本测试里不参与（避免与 done 抢答）
      if (name === 'timer') return { timeout: () => new Promise(() => {}) }
      return undefined
    },
    effect: (fn) => {
      const gen = fn()
      if (gen && typeof gen.next === 'function') {
        let step = gen.next()
        while (!step.done) step = gen.next()
      }
    },
  }
  return { ctx, registeredCommands, spawnedArgvs }
}

test('指令插件挂载：注册 7 条 crosspost-* 人用指令（形状 + 描述 + handler）', async (t) => {
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过挂载检查')
    return
  }
  const mod = await import(new URL(`file://${COMMANDS_PLUGIN}`).href)
  assert.deepEqual(
    mod.inject,
    ['commands', 'subprocess', 'timer'],
    '注入的服务列表变了：宿主少给/改名任何一个，指令就挂不上或跑不了',
  )

  const { ctx, registeredCommands } = makeCommandsStubCtx()
  mod.apply(ctx)

  assert.deepEqual(
    registeredCommands.map((c) => c.name).sort(),
    [...EXPECTED_COMMANDS].sort(),
    '注册的指令集与预期不一致（少一条 = 输入框里少一条；多一条 = 忘了更新本测试）',
  )
  for (const cmd of registeredCommands) {
    assert.equal(
      typeof cmd.description,
      'string',
      `${cmd.name} 缺 description（` / ` 菜单要显示它）`,
    )
    assert.ok(cmd.description.length > 0, `${cmd.name} description 不能为空`)
    assert.equal(typeof cmd.handler, 'function', `${cmd.name} 缺 handler`)
    // 声明 `input` 会让客户端把它当"需要参数"：菜单回车/直接回车都只 **claim**（名字留在
    // 输入框里等参数），**不执行**——使用者看到的就是"列出指令后回车无法执行"。
    // 这些指令的参数都可省略，所以一条都不许声明。
    assert.equal(
      cmd.input,
      undefined,
      `${cmd.name} 不应声明 input：声明了它第一次回车只做"认领"，要按两次才执行`,
    )
  }
})

test('指令插件：/crosspost-status 真跑一次（argv 无 shell + 输出成形）', async (t) => {
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过挂载检查')
    return
  }
  const mod = await import(new URL(`file://${COMMANDS_PLUGIN}`).href)
  const { ctx, registeredCommands, spawnedArgvs } = makeCommandsStubCtx({
    cliReplies: {
      proxyStatus: {
        connected: true,
        proxyMode: true,
        version: { engine: '9.9.9-test', node: '24.0.0' },
        autoPush: { enabled: false },
        ext: { seen: true, client: { version: '0.2.7' }, compat: { message: '扩展兼容' } },
        platforms: {
          count: 12,
          checkedAt: Date.now(),
          scope: { mode: 'scoped', checkOnly: ['weixin'] },
        },
      },
    },
  })
  mod.apply(ctx)
  const cmd = registeredCommands.find((c) => c.name === 'crosspost-status')
  const res = await cmd.handler({ rawInput: '', signal: undefined })

  assert.equal(res.kind, 'success', `应当成功：${JSON.stringify(res)}`)
  assert.match(res.text, /CrossPost 状态/)
  assert.match(res.text, /9\.9\.9-test/, '引擎版本要出现在输出里')
  assert.match(res.text, /自动推送开关.*关闭/, 'autoPush 是派发唯一权威，必须在状态里可见')

  assert.equal(spawnedArgvs.length, 1)
  assert.equal(spawnedArgvs[0][2], 'proxyStatus')
  assert.ok(
    !spawnedArgvs[0].some((a) => /[;&|]/.test(String(a))),
    'argv 里不应出现 shell 元字符（本插件走 argv 形态，不经 shell）',
  )
})

test('指令插件：/crosspost-drafts 必须落到项目域（带 --project=，否则读到空的默认域）', async (t) => {
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过挂载检查')
    return
  }
  const mod = await import(new URL(`file://${COMMANDS_PLUGIN}`).href)
  const { ctx, registeredCommands, spawnedArgvs } = makeCommandsStubCtx({
    cliReplies: {
      projects: {
        count: 1,
        valid: 1,
        invalid: 0,
        projects: [{ id: 'wechat-auto', name: '写作流水线', valid: true, capabilities: {} }],
      },
      // 真实形状：`score` 是对象 {total,at}，`platforms` 是 map（平台→结果）
      // ——曾经按标量/数组格式化，输出里出现 `分[object Object]`、平台数恒为 0。
      listArticles: {
        articles: [
          {
            id: 'a1',
            date: '2026-10-03',
            slot: 'hotspot2',
            status: 'published',
            title: '示例标题',
            score: { total: 92, at: '2026-10-03T16:05:20.704Z' },
            platforms: { zhihu: { status: 'ok' }, csdn: { status: 'ok' } },
          },
        ],
      },
    },
  })
  mod.apply(ctx)
  const cmd = registeredCommands.find((c) => c.name === 'crosspost-drafts')
  const res = await cmd.handler({ rawInput: '', signal: undefined })

  assert.equal(res.kind, 'success', `应当成功：${JSON.stringify(res)}`)
  assert.match(res.text, /wechat-auto/, '输出要点明用了哪个项目域')
  assert.match(res.text, /1 条/)
  assert.match(res.text, /分92/, `score 是对象 {{total}}，必须取 total（实际输出：\n${res.text}）`)
  assert.doesNotMatch(res.text, /object Object/, '字段形状变了，格式化又退化成 [object Object]')
  assert.match(res.text, /平台2/, `platforms 是 map，平台数要按 key 计（实际输出：\n${res.text}）`)
  assert.equal(spawnedArgvs.length, 2, '先查注册表定项目，再查该项目的记录')
  assert.deepEqual(spawnedArgvs[0].slice(2), ['projects'])
  assert.ok(
    spawnedArgvs[1].includes('--project=wechat-auto'),
    `第二条调用必须带 --project=wechat-auto，实际 ${JSON.stringify(spawnedArgvs[1])}`,
  )
})

test('指令插件：参数按白名单校验，非法 token 直接报错且不 spawn（argv 注入面）', async (t) => {
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过挂载检查')
    return
  }
  const mod = await import(new URL(`file://${COMMANDS_PLUGIN}`).href)
  const { ctx, registeredCommands, spawnedArgvs } = makeCommandsStubCtx()
  mod.apply(ctx)
  const costs = registeredCommands.find((c) => c.name === 'crosspost-costs')

  const badRes = await costs.handler({ rawInput: '2026-10-03; rm -rf /', signal: undefined })
  assert.equal(badRes.kind, 'error', '非法 token 必须报错')
  assert.match(badRes.text, /不合法/)
  assert.equal(spawnedArgvs.length, 0, '校验必须在 spawn 之前——非法输入不得启动任何子进程')

  const helpCmd = registeredCommands.find((c) => c.name === 'crosspost-help')
  const helpRes = await helpCmd.handler({ rawInput: '', signal: undefined })
  assert.equal(helpRes.kind, 'success')
  assert.match(helpRes.text, /crosspost-costs/, 'help 必须自述全部指令')
  assert.match(helpRes.text, /只读/, 'help 要说明这些指令的边界（只读、不发布）')
})

test('指令插件：/crosspost-styles 按真实形状渲染（styles 是对象数组，禁止 [object Object]）', async (t) => {
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过挂载检查')
    return
  }
  const mod = await import(new URL(`file://${COMMANDS_PLUGIN}`).href)
  const { ctx, registeredCommands } = makeCommandsStubCtx({
    // 真实形状：`available_styles` 是字符串数组，`styles` 是对象数组
    cliReplies: {
      listStyles: {
        available_styles: ['swiss', 'custom-classic'],
        styles: [
          { name: 'swiss', category: 'core', desc: '白纸黑字配一抹朱红', enabled: true },
          { name: 'custom-classic', category: 'custom', desc: '经典版式', enabled: true },
          { name: 'zz-old', category: 'custom', desc: '旧样式', enabled: false },
        ],
        counts: { total: 65, enabled: 4, disabled: 61 },
      },
    },
  })
  mod.apply(ctx)
  const cmd = registeredCommands.find((c) => c.name === 'crosspost-styles')
  const res = await cmd.handler({ rawInput: '', signal: undefined })

  assert.equal(res.kind, 'success', `应当成功：${JSON.stringify(res)}`)
  assert.match(res.text, /swiss（core）/, '启用清单要按名字渲染，并带上分类')
  assert.match(res.text, /未启用 1 个：zz-old/, '未启用的名字要渲染出来（不是对象）')
  assert.doesNotMatch(
    res.text,
    /object Object/,
    `styles 是对象数组，按标量格式化会渲染成 [object Object]：\n${res.text}`,
  )
})
