// 多平台发布助手 —— 人用斜杠指令（preset 面）
//
// 为什么有这个文件（2026-10-03）：DSH 输入框的 `/` 菜单只列**人用指令**
// （`commands` 服务），而 MCP 工具（`mcp__crosspost__*`）属于**模型面**的工具注册表
// ——输入框从来不列工具（实测：菜单分组只有 指令/文件与文件夹/对话/子智能体/工作区/进行中，
// 且 `dsh-client-ui-input-trigger` 根本不引用 `tools`）。于是"人想在 GUI 里直接查
// CrossPost 的项目/草稿/平台状态"没有入口。这些指令补上这个入口。
//
// 一条指令 = 一次 `crosspost-runtime/src/cli.mjs` 调用。选 CLI 而不是 MCP：
//   · CLI 与 MCP 服务端**共用同一套判定源与数据**（项目域、平台白名单、样式表都来自
//     `crosspost-runtime/src/`），所以两边的答案一致；
//   · 不必再起一个 MCP 子进程，也不必把 MCP 的 tool schema 映射成人用指令。
//
// 作用域（这条很关键，决定了"只在多平台发布助手会话里有"）：
//   注册走 `ctx.commands.register`，而 `ScopedLayers.effect(ctx, …)` 用 **ctx 的 scope**
//   建层——preset 的 standing scope 是会话 agent scope 的父级，于是这些指令只对
//   **选中本预设的会话**可见。实证：上游四个官方预设各自声明 `command-goal` 而不冲突
//   （若注册是全局的，第二次挂载就会抛 "already registered"）。
//
// 安全边界：
//   · 全部走 `subprocess.spawn({ argv })`——**不经过 shell**，人给的参数（项目 id / 日期 /
//     平台 id）仍然逐条按白名单校验，双保险；
//   · 只做**只读**指令。发草稿/推平台这类动作仍由模型侧的工具（带来源守卫与 autoPush 门控）
//     承担，不放在一行裸指令后面。
//
// 数据域（容易踩）：GUI 会话的 `web` profile **没有** `CROSSPOST_PROJECT`，默认域是空的
// （`listArticles` 不带项目 = 0 条）。所以涉及内容的指令必须显式传 `--project=`；
// 本机只有一个在册项目时默认用它（并在输出里写明用了哪个）。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lazyPaths } from '../runtime/src/paths.mjs'

const name = 'crosspost-commands'
const inject = ['commands', 'subprocess', 'timer']

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 引擎根：经预设目录内的 `runtime` 软链解析（`preset/crosspost/runtime → crosspost-runtime`） */
const RUNTIME_ROOT = path.resolve(__dirname, '../runtime')
const NATIVE_CLI = path.join(RUNTIME_ROOT, 'src', 'cli.mjs')
/** node 取当前进程可执行文件，可用 CROSSPOST_NODE 覆盖（与 plugins/crosspost.js 同款） */
const NODE = process.env.CROSSPOST_NODE || process.execPath
/** 单条指令的时间上限：`listCosts` 首次会预热会话索引，留足余量 */
const TIMEOUT_MS = 90000
/** 输出上限：够装下平台/草稿/费用清单，又不会把一整棵 JSON 灌进卡片 */
const MAX_OUT_BYTES = 4 * 1024 * 1024

/** 人给的 token 只允许这些形状（argv 已经免了 shell 注入，这里防的是"当成项目 id 传进去"） */
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 把 CLI 的 stdout 单行 JSON 解析出来；失败时保留原文前若干字符供人排查 */
function parseCliJson(text) {
  const line = String(text || '').trim()
  if (!line) return { error: 'CLI 没有输出（可能桥未启动）' }
  const lastLine =
    line
      .split('\n')
      .filter((l) => l.trim())
      .pop() || line
  try {
    return JSON.parse(lastLine)
  } catch {
    return { error: 'CLI 输出无法解析为 JSON', raw: lastLine.slice(0, 400) }
  }
}

/** 一行里的 token 数组（空输入 = []） */
const tokens = (raw) =>
  String(raw || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

/** 数字化的"最近时间"（毫秒）→ 本地可读；空值给 '—' */
function when(ms) {
  if (!ms || typeof ms !== 'number') return '—'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const yuan = (v) => (typeof v === 'number' ? `¥${v.toFixed(4)}` : '—')

/**
 * 列表类字段统一经它渲染：对象取 `name`/`id`，取不到才降级成 JSON——
 * **绝不让 `[object Object]` 出现在输出里**。
 *
 * 为什么要有这个helper（2026-10-04 实测踩到两次）：引擎的返回里"名字"并不总是字符串
 * （`listStyles` 的 `styles` 是 `{name,category,desc,…}` 对象数组；
 * `listArticles` 的 `score` 是 `{total,at}`、`platforms` 是 map）。
 * 按标量格式化就会渲染成 `[object Object]`，而这类错误**不报错、只出丑**，没人盯着就一直在。
 */
function label(v) {
  if (v === null || v === undefined) return ''
  if (typeof v !== 'object') return String(v)
  const named = v.name ?? v.id ?? v.key ?? v.title
  return typeof named === 'string' && named ? named : JSON.stringify(v)
}

/** 截到 n 个字符（超长文本进卡片前先收一收，避免一行被省略号吃掉关键信息） */
function clip(s, n) {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function apply(ctx) {
  const subprocess = ctx.get('subprocess')
  const timer = ctx.get('timer')
  const paths = lazyPaths()
  const CWD = paths.workspace || path.join(RUNTIME_ROOT, '..', 'bridge')

  /**
   * 跑一次 CLI（argv 形态，无 shell）并返回解析后的 JSON。
   * @param args - CLI 位置参数（method 在第一位）
   * @param signal - 界面传来的取消信号；超时由 TIMEOUT_MS 兜底
   */
  async function callCli(args, signal) {
    if (!subprocess) return { error: '本会话没有 subprocess 服务，CrossPost 指令不可用' }
    const handle = subprocess.spawn({
      argv: [NODE, NATIVE_CLI, ...args],
      cwd: CWD,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_OUT_BYTES },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 5000,
      ...(signal ? { signal } : {}),
    })
    const timed = timer ? timer.timeout(TIMEOUT_MS).then(() => 'timeout') : undefined
    const raced = timed ? await Promise.race([handle.done.then(() => 'done'), timed]) : 'done'
    if (raced === 'timeout') {
      handle.terminate()
      return { error: `指令超时（>${Math.round(TIMEOUT_MS / 1000)}s）：${args.join(' ')}` }
    }
    await handle.done.catch(() => undefined)
    const out = handle.collected.stdout?.readFrom(0).text ?? ''
    const err = handle.collected.stderr?.readFrom(0).text ?? ''
    const parsed = parseCliJson(out)
    if (parsed && typeof parsed.error === 'string') {
      // 保留 registry/project 等同批字段（项目类失败会一并带回注册表），只把 stderr 尾行补进文案
      const tail = err.trim() ? err.trim().split('\n').slice(-1)[0].slice(0, 200) : ''
      return { ...parsed, error: String(parsed.error) + (tail ? `（stderr: ${tail}）` : '') }
    }
    return parsed
  }

  /**
   * 解析"内容域"项目：显式参数优先，否则用本机唯一在册项目。
   * 不显式传 `--project=` 时 GUI 会话读的是**默认域**（空的）——这正是"查不到项目内容"的成因。
   */
  async function resolveProjectId(explicit, signal) {
    if (explicit) {
      if (!ID_RE.test(explicit)) return { error: `项目 id 形状不合法: ${explicit}` }
      return { id: explicit }
    }
    const reg = await callCli(['projects'], signal)
    if (reg.error) return { error: reg.error }
    const valid = (reg.projects || []).filter((p) => p && p.valid)
    if (valid.length === 1) return { id: valid[0].id, sole: true }
    if (valid.length === 0)
      return { error: '本机没有在册项目（/crosspost-projects 看注册表根目录）' }
    return {
      error:
        `本机有多个在册项目，请显式给一个：${valid.map((p) => p.id).join(' / ')}\n` +
        `用法：/crosspost-drafts <project>`,
    }
  }

  /** 文本结果（成功） */
  const ok = (text) => ({ kind: 'success', text })
  /** 失败结果 */
  const bad = (text) => ({ kind: 'error', text })

  // ⚠ 这些指令**都不声明 `input`**，这是有意为之（2026-10-04 实测踩到）：
  //
  //   DSH 客户端的决策表是「有 `input` = 需要参数」：
  //     · 菜单里回车/pick（`dispatch(pick)`）：`desc.input !== void 0` → 只 **claim**（把名字留在
  //       输入框里等参数），**不执行**；反之才 `runDetached` 立即执行。
  //     · 直接敲名字回车（`matchEnter`）：同样先 claim，要再按一次回车才真的跑。
  //   → 声明了 `input` 的指令从"敲一次"变成"敲两三次"，使用者看到的就是
  //     「列出指令后回车无法执行」。这几个指令的参数**都可省略**（项目默认取本机唯一在册、
  //     日期可省），所以不声明 `input`：
  //     · `/crosspost-drafts` + 回车        → 立即执行（用默认项目）
  //     · `/crosspost-drafts wechat-auto` + 回车 → 走正常提交路径，参数照旧生效
  //   参数提示因此并入 `description`（菜单里显示它）。**不要**为"更友好"再加回 `input`。
  const COMMANDS = [
    {
      name: 'crosspost-status',
      description: 'CrossPost 状态：桥 / 浏览器扩展 / 平台清单 / 自动推送开关',
      handler: async (inv) => {
        const d = await callCli(['proxyStatus'], inv.signal)
        if (d.error) return bad(d.error)
        const p = d.platforms || {}
        const scope = p.scope || {}
        const ext = d.ext || {}
        const client = ext.client || {}
        const lines = [
          'CrossPost 状态（经浏览器代理单通道）',
          `· 桥：${d.connected ? '运行中' : '未连接'}${d.error ? `（${d.error}）` : ''}` +
            ` · engine ${(d.version || {}).engine || '—'} · node ${(d.version || {}).node || '—'}`,
          `· 扩展：${ext.seen ? '已连接' : '未连接'}` +
            (client.version ? ` · v${client.version}` : '') +
            (client.ua ? ` · ${String(client.ua).includes('Chrome') ? 'Chrome' : '浏览器'}` : '') +
            ` · 最近 ${when(ext.lastPushAt)}` +
            ((ext.compat || {}).message ? ` · ${ext.compat.message}` : ''),
          `· 平台：在册 ${p.count ?? '—'} 个 · ${scope.mode || '—'} 模式 · 检查于 ${when(p.checkedAt)}` +
            (Array.isArray(scope.checkOnly) && scope.checkOnly.length
              ? ` · 仅检查 ${scope.checkOnly.join('/')}`
              : '') +
            (Array.isArray(p.needsLoginIds) && p.needsLoginIds.length
              ? ` · 需登录 ${p.needsLoginIds.join('/')}`
              : ''),
          `· 自动推送开关（派发唯一权威）：${(d.autoPush || {}).enabled ? '已开启' : '关闭'}`,
        ]
        return ok(lines.join('\n'))
      },
    },
    {
      name: 'crosspost-projects',
      description:
        'CrossPost 项目注册表与数据源可达性（可带项目 id：/crosspost-projects wechat-auto）',
      handler: async (inv) => {
        const [arg] = tokens(inv.rawInput)
        if (arg && !ID_RE.test(arg)) return bad(`项目 id 形状不合法: ${arg}`)
        const d = await callCli(arg ? ['projects', arg] : ['projects'], inv.signal)
        if (d.error) return bad(d.error)
        if (d.project) {
          const p = d.project
          const prov = p.provider || {}
          return ok(
            [
              `项目 ${p.id} — ${p.name || ''}`,
              `· 来源：${p.sourcePath || '—'}`,
              `· 数据源：${prov.kind || '—'} · ${prov.reachable ? '可达 ✓' : `不可达（${prov.reason || '原因未知'}）`}`,
              `· 能力：${Object.keys(p.capabilities || {}).join(', ') || '无'}`,
              ...(p.warnings?.length ? [`· 提醒：${p.warnings.join('；')}`] : []),
              ...(p.errors?.length ? [`· 错误：${p.errors.join('；')}`] : []),
            ].join('\n'),
          )
        }
        const rows = (d.projects || []).map((p) => {
          const prov = p.provider || {}
          return (
            `· ${p.id} — ${p.name || ''}` +
            ` · 数据源 ${prov.reachable ? '可达 ✓' : '不可达 ✗'}` +
            ` · 能力 ${Object.keys(p.capabilities || {}).join('/') || '无'}`
          )
        })
        return ok(
          [
            `项目注册表（在册 ${d.count ?? rows.length} 个 · 有效 ${d.valid ?? '—'} · 无效 ${d.invalid ?? 0}）`,
            `· 扫描根：${(d.roots || []).join(' · ') || '—'}`,
            ...rows,
          ].join('\n'),
        )
      },
    },
    {
      name: 'crosspost-platforms',
      description: '平台登录态，27 个已知平台（可带平台 id：/crosspost-platforms zhihu）',
      handler: async (inv) => {
        const [arg] = tokens(inv.rawInput)
        if (arg && !ID_RE.test(arg)) return bad(`平台 id 形状不合法: ${arg}`)
        const d = await callCli(['listPlatforms'], inv.signal)
        if (d.error) return bad(d.error)
        const list = (d.platforms || []).filter((p) => (arg ? p.id === arg : true))
        if (!list.length) return bad(`没有这个平台：${arg}`)
        const authed = list.filter((p) => p.isAuthenticated)
        const rest = list.filter((p) => !p.isAuthenticated)
        const fmt = (p) => `${p.name || p.id}${p.username ? `(${p.username})` : ''}`
        return ok(
          [
            `平台登录态（共 ${list.length} 个已知平台）`,
            `· 已登录 ${authed.length}：${authed.map(fmt).join('、') || '—'}`,
            `· 未登录 ${rest.length}：${rest.map(fmt).join('、') || '—'}`,
          ].join('\n'),
        )
      },
    },
    {
      name: 'crosspost-styles',
      description: '可用样式（发布时只能用这份启用清单里的名字）',
      handler: async (inv) => {
        const d = await callCli(['listStyles'], inv.signal)
        if (d.error) return bad(d.error)
        // 形状（实测）：`available_styles` 是**启用样式的名字数组**（字符串），
        // 而 `styles` 是**对象数组** `{name,category,desc,bg,accent,enabled}`。
        // 早先按字符串处理 `styles`，输出里就成了一串 `[object Object]`——列表类字段一律走
        // `label()`，别再假设标量。
        const enabledNames = (d.available_styles || []).map(label).filter(Boolean)
        const all = (d.styles || []).map((s) =>
          typeof s === 'object' && s !== null ? s : { name: s },
        )
        const byName = new Map(all.map((s) => [label(s), s]))
        const disabled = all.filter((s) => !enabledNames.includes(label(s)))
        const head = disabled.slice(0, 8).map(label).filter(Boolean)
        return ok(
          [
            `可用样式（启用 ${enabledNames.length} / 共 ${all.length}）`,
            ...enabledNames.map((n) => {
              const meta = byName.get(n)
              const desc = meta?.desc ? ` — ${clip(meta.desc, 34)}` : ''
              const cat = meta?.category ? `（${meta.category}）` : ''
              return `· ${n}${cat}${desc}`
            }),
            `· 未启用 ${disabled.length} 个${head.length ? `：${head.join('、')}${disabled.length > head.length ? ' …' : ''}` : ''}`,
            ...(Object.keys(d.counts || {}).length
              ? [
                  `· 计数：total=${d.counts.total ?? '—'} enabled=${d.counts.enabled ?? '—'} disabled=${d.counts.disabled ?? '—'}`,
                ]
              : []),
            '· 发布时只能用上面这份**启用清单**里的名字（写错会被回退 swiss）',
          ].join('\n'),
        )
      },
    },
    {
      name: 'crosspost-drafts',
      description: '文章/草稿记录，项目域（可带项目 id：/crosspost-drafts wechat-auto）',
      handler: async (inv) => {
        const [arg] = tokens(inv.rawInput)
        const proj = await resolveProjectId(arg, inv.signal)
        if (proj.error) return bad(proj.error)
        const d = await callCli(['listArticles', `--project=${proj.id}`], inv.signal)
        if (d.error) return bad(d.error)
        const arts = d.articles || []
        const head = arts.slice(0, 20)
        return ok(
          [
            `项目 ${proj.id} 的文章记录（${arts.length} 条${arts.length > head.length ? `，显示最近 ${head.length} 条` : ''}）` +
              (proj.sole ? ' · 项目=本机唯一在册' : ''),
            ...head.map((a) => {
              // 记录里的字段形状：`score` 是对象 {total,at}，`platforms` 是 map（平台→结果）
              const plats =
                a.platforms && typeof a.platforms === 'object' ? Object.keys(a.platforms).length : 0
              const score = typeof a.score === 'number' ? a.score : a.score && a.score.total
              return (
                `· ${a.date || '—'} ${String(a.slot || '-').padEnd(9)} ` +
                `[${a.status || '—'}]${score !== undefined && score !== null ? ` 分${score}` : ''}` +
                `${plats ? ` 平台${plats}` : ''} ${String(a.title || a.id || '').slice(0, 40)}`
              )
            }),
          ].join('\n'),
        )
      },
    },
    {
      name: 'crosspost-costs',
      description:
        'Token 费用报表，项目域（可带日期与项目：/crosspost-costs 2026-10-03 wechat-auto）',
      handler: async (inv) => {
        const args = tokens(inv.rawInput)
        let date = ''
        let projArg = ''
        for (const a of args) {
          if (DATE_RE.test(a)) date = a
          else if (ID_RE.test(a)) projArg = a
          else return bad(`参数形状不合法: ${a}（日期 YYYY-MM-DD / 项目 id）`)
        }
        const proj = await resolveProjectId(projArg, inv.signal)
        if (proj.error) return bad(proj.error)
        const cliArgs = ['listCosts', ...(date ? [date] : []), `--project=${proj.id}`]
        const d = await callCli(cliArgs, inv.signal)
        if (d.error) return bad(d.error)
        const costs = d.costs || []
        const matched = costs.filter((c) => c.cost !== null && c.cost !== undefined)
        const total = matched.reduce((a, c) => a + (c.cost || 0), 0)
        const head = costs.slice(0, 15)
        const meta = d.meta || {}
        return ok(
          [
            `项目 ${proj.id} 费用${date ? `（${date}）` : ''}（${costs.length} 篇 · 匹配到会话 ${matched.length} 篇）` +
              (proj.sole ? ' · 项目=本机唯一在册' : ''),
            `· 合计 ${yuan(total)} · 计价 ${(meta.pricing || {}).model || '—'}（¥/百万 tokens，${(meta.pricing || {}).version || '—'}）`,
            ...(meta.byGen ? [`· 会话代际：${JSON.stringify(meta.byGen)}`] : []),
            ...head.map(
              (c) =>
                `· ${c.date || '—'} ${String(c.slot || '-').padEnd(9)} ${yuan(c.cost).padEnd(10)} ` +
                `${String(c.title || '').slice(0, 36)}`,
            ),
          ].join('\n'),
        )
      },
    },
    {
      name: 'crosspost-help',
      description: '这些 CrossPost 指令的清单与数据来源',
      handler: async () =>
        ok(
          [
            'CrossPost 指令（只在「多平台发布助手」预设的会话里可用）',
            '· /crosspost-status              桥 / 扩展 / 平台 / 自动推送开关',
            '· /crosspost-projects [project]  项目注册表与数据源可达性',
            '· /crosspost-platforms [id]      平台登录态',
            '· /crosspost-styles              可用样式（发布时的启用清单）',
            '· /crosspost-drafts [project]    文章/草稿记录（项目域）',
            '· /crosspost-costs [date] [project]  Token 费用报表（项目域）',
            '· /crosspost-help                本清单',
            '',
            '数据来源：crosspost-runtime 的 CLI（与 mcp__crosspost__* 共用同一套判定源与数据）。',
            '全部只读：不写文件、不发草稿、不动平台。要发布/重推请让模型调 mcp__crosspost__* 工具',
            '（那边有来源守卫与「生成后自动推送」开关门控）。',
          ].join('\n'),
        ),
    },
  ]

  ctx.effect(function* () {
    // 逐条注册；生成的每个 disposer 由 cordis 收集，注册中途失败也会把已成功的那些撤回
    for (const cmd of COMMANDS) {
      yield ctx.commands.register(cmd)
    }
  }, 'crosspost-commands lifecycle')
}

export { name, inject, apply }
