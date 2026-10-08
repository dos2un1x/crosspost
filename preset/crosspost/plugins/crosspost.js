// 多平台发布助手（单通道：原生代理）— 7 个 xp_* 工具 + bridge 自拉起
// 桥接模式（早期外部扩展 MCP / mcp-server / token）已于 2026-08 移除
//
// 2026-09-12：运行时统一经预设目录内的软链 `runtime → crosspost-runtime` 解析（`../runtime/...`），
// 使同一份源码在两种布局下都成立：
//   · 仓库布局      preset/crosspost/plugins/     → preset/crosspost/runtime      → ../../crosspost-runtime（相对）
//   · 用户预设布局  ~/.dsh/.agent-presets/crosspost/plugins/ → …/crosspost/runtime → <克隆位置>/crosspost-runtime（绝对）
// 教训：原先写 '../../../crosspost-runtime/...' 只在仓库布局下正确；从用户预设目录挂载时会解析成
// ~/.dsh/crosspost-runtime 并报 `Cannot find module …/paths.mjs`（预设切换失败的直接原因）。
import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lazyPaths } from '../runtime/src/paths.mjs'
import { readConfig } from '../runtime/src/config-cache.mjs'
import { TARGET_PLATFORMS } from '../runtime/src/platform-ids.mjs'
// 发布来源守卫（2026-09-12）：与 MCP 面同一判定源——定时链路（WECHAT_AUTO_SCHEDULED=1）与一键生成
// （WECHAT_AUTO_DRAFT_ONLY=1）禁止用 xp_sync_article 绕过「生成后自动推送」开关
import {
  resolvePublishOrigin,
  lowLevelPublishBlocked,
  lowLevelBlockReason,
} from '../runtime/src/publish-origin.mjs'
const name = 'crosspost-tools'
const inject = ['tools', 'fs', 'shell', 'subprocess', 'timer']
// 平台白名单单一来源：platform-ids.mjs（与 cli TARGET_PLATFORMS 同源，2026-08-24 统一）
const NATIVE_WHITELIST = TARGET_PLATFORMS
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 路径统一配置（paths.json）：插件自身位置推导 crosspost-runtime 根（经 ../runtime 软链）
const RUNTIME_ROOT = path.resolve(__dirname, '../runtime')
// v2.02：路径懒解析 + node 取当前进程可执行文件
// （原先顶层 loadPaths() 固化路径；NODE 硬编码 /usr/local/bin/node，
//   在 Apple Silicon 无 Homebrew 的环境不存在 → 插件调用全部失败）
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
const paths = lazyPaths()
const BRIDGE_SCRIPT =
  paths.bridgeScript || path.join(RUNTIME_ROOT, '..', 'bridge', 'run-bridge.mjs')
const NODE = process.env.CROSSPOST_NODE || process.execPath
const WORKSPACE = paths.workspace || path.join(RUNTIME_ROOT, '..', 'bridge')
const NATIVE_ROOT = RUNTIME_ROOT
const NATIVE_CLI = path.join(RUNTIME_ROOT, 'src', 'cli.mjs')

/**
 * 桥的 HTTP 地址。端口口径与引擎自身对齐：
 *   · 桥自己读 `config.json` 的 `proxyHttpPort`（默认 9540）；
 *   · doctor / CLI 侧还认 `SYNC_PROXY_WS_PORT`（WS 端口，HTTP = WS + 1）。
 * 读配置失败就退回默认——探测只为决定"要不要自拉起"，宁可探不到也不能抛。
 */
function bridgeHttpPort() {
  let cfg = {}
  try {
    cfg = readConfig() || {}
  } catch {}
  const fromCfg = Number(cfg.proxyHttpPort)
  if (Number.isFinite(fromCfg) && fromCfg > 0) return fromCfg
  const ws = Number(process.env.SYNC_PROXY_WS_PORT)
  return (Number.isFinite(ws) && ws > 0 ? ws : 9539) + 1
}

const bridgeBase = () => `http://127.0.0.1:${bridgeHttpPort()}`

/**
 * 本机是否已有桥在应答。
 * 判定口径与 `doctor` 同源：`/proxy/bootstrap` 是**免鉴权**的（桥只对静态页面与它免鉴权），
 * 拿得到 token 就说明那个端口上站着的是**我们的桥**（而不是别的服务恰好占用）。
 */
async function bridgeAlive() {
  try {
    const res = await fetch(`${bridgeBase()}/proxy/bootstrap`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return false
    const body = await res.json().catch(() => null)
    return Boolean(body && typeof body.token === 'string')
  } catch {
    return false
  }
}

function apply(ctx) {
  let bridgeHandle = null
  let reqCounter = 0
  const fs = ctx.get('fs')
  const subprocess = ctx.get('subprocess')
  const shell = ctx.get('shell')
  const timer = ctx.get('timer')

  async function spawnBridge(attempt = 0) {
    if (!subprocess || bridgeHandle) return
    // 先探测：**本机已经有桥在应答就不要再起一个**（2026-10-04 实测踩到）。
    //
    // 为什么：容器形态 / launchd 形态通常已经跑着一个桥。预设插件再自拉起一个，
    // 会变成"两个桥"——后果不是"多一个进程"这么轻：
    //   · 调度锁只有一个（`<localRoot>/scheduler/lock`，跨宿主/容器用心跳判活）。
    //     第二个桥会按设计被拒（桥的原文："宿主与容器不能同时跑定时器（会双发）"），
    //     而**容器只在启动时抢一次锁、不重试** → 定时器实际归那个自拉起的桥所有，
    //     它的寿命绑在 DSH 会话上：GUI 一关，定时器静默停摆直到重启容器。
    //   · 两个桥同时轮询平台登录态、各开一份 Console，端口靠绑定顺序决定谁服务。
    // 判定口径与 `doctor` 同源：`/proxy/bootstrap` 是**免鉴权**的（桥只对静态页面与它免鉴权），
    // 能拿到 token 就说明站在那个端口上的**是我们的桥**（而不是别的服务恰好占用）。
    if (await bridgeAlive()) {
      try {
        ctx.logger?.info?.(
          '[crosspost] 本机已有桥在 %s 应答，跳过预设的自拉起（避免双桥抢调度锁）',
          bridgeBase(),
        )
      } catch {}
      return
    }
    try {
      bridgeHandle = subprocess.spawn({
        argv: [NODE, BRIDGE_SCRIPT],
        cwd: WORKSPACE,
        stdio: { stdin: 'ignore', stdout: 'collect', stderr: 'collect' },
        graceMs: 2000,
        env: {},
      })
    } catch {
      bridgeHandle = null
      if (attempt < 3) {
        if (timer) await timer.timeout(1000)
        return spawnBridge(attempt + 1)
      }
    }
  }
  async function stopBridge() {
    if (bridgeHandle) {
      try {
        bridgeHandle.terminate()
      } catch {}
      bridgeHandle = null
    }
  }
  function safe(v) {
    if (v === undefined) return null
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(safe)
    const o = {}
    for (const k of Object.keys(v)) o[k] = safe(v[k])
    return o
  }
  async function shellJson(command) {
    const spec = shell.resolve({ command })
    const res = await shell.run(spec)
    const out = (res.stdout && res.stdout.text) || ''
    try {
      return JSON.parse(out)
    } catch {
      return { parseError: out.slice(0, 500) }
    }
  }
  /**
   * 调原生 CLI（shell 字符串形态）。
   *
   * v2.22 内容域 project 维度：若本会话声明了 `CROSSPOST_PROJECT`，自动补
   * `--project=<id>`——与 CLI/MCP/HTTP 共用同一套项目解析，四面对同一项目行为一致。
   * 未声明时不追加任何参数（生产单项目路径逐字不变）。
   */
  async function nativeCall(args, outFile) {
    const redirect = outFile ? ' > ' + outFile : ''
    const proj = String(process.env.CROSSPOST_PROJECT || '').trim()
    // 只接受 manifest 允许的 id 字符集（^[A-Za-z0-9._-]+$），防 shell 注入
    const safeProj = /^[A-Za-z0-9._-]+$/.test(proj) ? proj : ''
    const needFlag = safeProj && !String(args).includes('--project=')
    const full = needFlag ? args + ' --project=' + safeProj : args
    return shellJson(NODE + ' ' + NATIVE_CLI + ' ' + full + redirect)
  }
  function assertNativeWhitelist(platforms) {
    const bad = (platforms || []).filter((id) => !NATIVE_WHITELIST.includes(id))
    if (bad.length > 0) return '原生模式暂不支持: ' + bad.join(', ')
    return null
  }
  async function proxyStatus() {
    const proxy = await nativeCall('proxyStatus').catch(() => ({}))
    return {
      proxyMode: !!(proxy && proxy.proxyMode),
      proxyConnected: !!(proxy && proxy.connected),
      lastProxyAt: (proxy && proxy.lastProxyAt) || null,
      bridgeUp: !!(proxy && !proxy.error),
      error: (proxy && proxy.error) || null,
    }
  }
  function registerTool(name_, description, parameters, execute) {
    const tool = defineTool({
      name: name_,
      description: description,
      parameters: parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        try {
          return safe(await execute(args || {}))
        } catch (e) {
          return { error: String((e && e.message) || e) }
        }
      },
    })
    ctx.tools.register(tool)
  }

  registerTool(
    'xp_status',
    '多平台发布助手状态（经浏览器代理通道）：代理连接、proxyMode。',
    {},
    async () => proxyStatus(),
  )
  registerTool(
    'xp_list_platforms',
    '列出全部已知平台的登录状态（含全部公开平台：douban/xueqiu/sohu/woshipm/juejin/weibo/yuque/cto51/imooc/oschina/segmentfault/cnblogs/zip-download/eastmoney）（经浏览器代理）。',
    {},
    async () => {
      const r = await nativeCall('listPlatforms')
      if (r && r.error) return { error: r.error }
      return { platforms: r && r.platforms }
    },
  )
  registerTool(
    'xp_check_auth',
    '检查指定平台登录状态（经浏览器代理）。',
    { platform: { type: 'string', description: '平台 ID', required: true } },
    async (args) => {
      const err = assertNativeWhitelist([args.platform])
      if (err) return { error: err }
      const r = await nativeCall('checkAuth ' + args.platform)
      return { platform: args.platform, result: r }
    },
  )
  registerTool(
    'xp_sync_article',
    '把文章发布到目标平台（草稿，经浏览器代理）。目标平台限于已知平台清单（含头条/小红书经 content script 页面通道自动打开平台页、什么值得买纯 fetch）。',
    {
      platforms: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '目标平台 ID 列表',
      },
      title: { type: 'string', required: true, description: '文章标题（纯文本）' },
      markdown: { type: 'string', description: 'Markdown 正文（不含标题行）' },
      content: { type: 'string', description: 'HTML 正文（可选）' },
      cover: { type: 'string', description: '封面图 URL（可选）' },
      concurrency: { type: 'number', description: '并发发布数（默认取配置，1-10）' },
    },
    async (args) => {
      // 2026-09-12：定时/一键生成链路禁止直接派发（必须经 publish_article 受开关门控）
      const _origin = resolvePublishOrigin()
      if (lowLevelPublishBlocked(_origin))
        return {
          error: `xp_sync_article 被来源守卫拒绝（origin=${_origin}）：${lowLevelBlockReason(_origin)}`,
        }
      const err = assertNativeWhitelist(args.platforms)
      if (err) return { error: err }
      if (!args.title) return { error: '缺少 title' }
      if (!args.markdown && !args.content) return { error: 'markdown 或 content 至少提供一个' }
      reqCounter += 1
      const reqPath = NATIVE_ROOT + '/native-req-' + reqCounter + '.json'
      const target = await fs.resolve(reqPath)
      const body = {
        platforms: args.platforms,
        article: {
          title: args.title,
          markdown: args.markdown,
          html: args.content,
          cover: args.cover,
        },
      }
      if (args.concurrency) body.concurrency = args.concurrency
      await fs.writeText(target, JSON.stringify(body))
      const r = await nativeCall('syncArticle ' + reqPath)
      return { results: (r && r.results) || r }
    },
  )
  registerTool(
    'xp_extract_article',
    '从 URL 或已打开的标签页提取文章（标题/正文 Markdown/HTML/封面）。',
    {
      url: {
        type: 'string',
        description: '文章 URL：activeTab 模式下用它匹配已打开的标签页；否则直接抓取该 URL',
      },
      activeTab: {
        type: 'boolean',
        description:
          '为 true 时从浏览器已打开的标签页提取（优先匹配 url 对应的标签页，未匹配则读最后聚焦窗口的活动标签页）',
      },
    },
    async (args) => {
      reqCounter += 1
      let r
      if (args.activeTab) {
        const outPath = NATIVE_ROOT + '/native-extract-' + reqCounter + '.json'
        r = await nativeCall('extractActiveTab' + (args.url ? ' ' + args.url : ''), outPath)
      } else if (args.url) {
        const outPath = NATIVE_ROOT + '/native-extract-' + reqCounter + '.json'
        r = await nativeCall('extractArticle ' + args.url, outPath)
      } else {
        return { error: '需要 url 或 activeTab 参数' }
      }
      if (!r || r.parseError) return { error: '提取失败: ' + JSON.stringify(r) }
      const outTarget = await fs.resolve(outPath)
      const text = await fs.readText(outTarget)
      try {
        const parsed = JSON.parse(text)
        return {
          article: parsed.article || null,
          error: parsed.error || null,
          source: parsed.source || null,
        }
      } catch {
        return { error: '解析提取结果失败' }
      }
    },
  )
  registerTool(
    'xp_upload_image_file',
    '把本地图片上传到指定平台图床（默认 zhihu）。',
    {
      filePath: { type: 'string', required: true, description: '本地图片绝对路径' },
      platform: { type: 'string', description: '图床平台，默认 zhihu' },
    },
    async (args) => {
      if (!args.filePath) return { error: '缺少 filePath' }
      const r = await nativeCall(
        'uploadImageFile ' + args.filePath + ' ' + (args.platform || 'zhihu'),
      )
      return { result: r }
    },
  )
  registerTool(
    'xp_proxy_test',
    '验收工具：经浏览器代理通道请求 httpbin 系服务，返回实际请求头，验证来源检测一致性。',
    {},
    async () => {
      const r = await nativeCall('proxyTest')
      return r
    },
  )
  ctx.effect(() => {
    spawnBridge()
    return () => {
      stopBridge()
    }
  })
}
export { name, inject, apply }
