#!/usr/bin/env node
/**
 * CrossPost MCP Server 协议自测（stdio JSON-RPC 客户端）
 *
 * 用法：
 *   node mcp-server/test-mcp.mjs                     # **只读**套件（默认，安全）
 *   node mcp-server/test-mcp.mjs status list_styles  # 只跑指定工具
 *   CROSSPOST_MCP_LIVE=1 node mcp-server/test-mcp.mjs  # 含写操作（见下）
 *
 * ## 写操作会产生真实副作用，因此默认关闭（v2.24 修正）
 *
 * 本脚本此前无参数时 `want()` 恒为 true，于是"默认"实际执行了**整套写操作**，
 * 而文件头却写着"默认测试: initialize → tools/list → callTool status"——
 * 注释与行为不符，谁照着注释跑一次就会在真实账号里留下痕迹（实测踩到）：
 *
 *   · `sync_article`     → 在知乎**草稿箱**创建 1 篇真实草稿（引擎无删除该草稿的能力）
 *   · `publish_styled`   → 同上，再创建 1 篇
 *   · `wechat_draft`     → 创建公众号草稿后**立即删除**（净零）
 *   · `create_style`     → 在全局样式目录写入 custom-mcp-green（现已链式清理）
 *   · `wechat_draft_delete` → 用无效 mediaId 走错误路径，不产生副作用
 *
 * 现在：写操作需显式 `CROSSPOST_MCP_LIVE=1` 才执行；`create_style` 跑完即删（净零）。
 * 知乎草稿仍无法自动清理——live 模式会在结束前打印提醒。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NODE = process.env.CROSSPOST_NODE || process.execPath
const SERVER = path.resolve(__dirname, 'index.mjs')

/** 写操作总开关：未显式开启时只跑只读工具 */
const LIVE = process.env.CROSSPOST_MCP_LIVE === '1'

const child = spawn(NODE, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
let nextId = 1
const pending = new Map()

child.stdout.on('data', (d) => {
  buf += d.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})

function send(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n')
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('timeout: ' + method))
      }
    }, 300000)
  })
}

const only = process.argv.slice(2)
function want(t) {
  if (!LIVE && LIVE_TOOLS.has(t)) {
    // 只统计"本来会跑"的（未显式指定其它工具时），避免 pollution 汇总噪音
    if (!skipped.includes(t)) skipped.push(t)
    return false
  }
  return only.length === 0 || only.includes(t)
}

/** 会产生持久副作用的工具（需 CROSSPOST_MCP_LIVE=1） */
const LIVE_TOOLS = new Set([
  'sync_article',
  'publish_styled',
  'wechat_draft',
  'wechat_draft_delete',
  'create_style',
  // 真装会往自有样式目录写 55 个文件；默认只跑 dryRun（见下），零副作用
  'install_styles',
])

const results = {}
const skipped = []
async function main() {
  console.log(
    LIVE
      ? '模式：LIVE（含写操作，会在真实平台账号留下草稿）\n'
      : '模式：只读（写操作已跳过；需要时设 CROSSPOST_MCP_LIVE=1）\n',
  )
  // 握手
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'crosspost-mcp-test', version: '0.0.1' },
  })
  results.initialize = init.result || init.error
  await send('notifications/initialized', {})

  // 工具列表
  const list = await send('tools/list', {})
  const tools = list.result && list.result.tools
  results.tools = (tools || []).map((t) => t.name)
  console.log('tools:', results.tools.join(', '))

  // 单工具调用
  async function callTool(name, args) {
    const r = await send('tools/call', { name, arguments: args || {} })
    const res = r.result || {}
    const texts = (res.content || []).map((c) => c.text).join('\n')
    let parsed
    try {
      parsed = JSON.parse(texts)
    } catch {
      parsed = texts
    }
    return { isError: !!res.isError, data: parsed }
  }

  if (want('status')) {
    const r = await callTool('status')
    results.status = r
  }
  if (want('check_auth')) {
    const r = await callTool('check_auth', { platform: 'zhihu' })
    results.check_auth = r
  }
  if (want('proxy_test')) {
    const r = await callTool('proxy_test')
    results.proxy_test = r
  }
  if (want('sync_article')) {
    const r = await callTool('sync_article', {
      platforms: ['zhihu'],
      title: 'CrossPost MCP 验证 ' + new Date().toISOString().slice(0, 19),
      markdown: '# MCP 验证\n\n这是一条经 MCP 协议发布的测试草稿。',
    })
    results.sync_article = r
  }

  // ── P4 渲染引擎工具 ────────────────────────────────────────────────
  if (want('list_styles')) {
    const r = await callTool('list_styles')
    results.list_styles = r
  }
  // 装样式包：默认只跑 dryRun（**零副作用**，只是逐条校验仓库自带的起手包），
  // 因此它在只读套件里也跑；真装要 CROSSPOST_MCP_LIVE=1（会往自有样式目录写文件）。
  if (only.length === 0 || only.includes('install_styles')) {
    const r = await callTool('install_styles', { dryRun: true })
    results.install_styles_dry = r
  }
  if (want('render_preview')) {
    const r = await callTool('render_preview', {
      markdown: '# 渲染测试\n\n> [!TIP] 知识科普\n> 提示内容\n\n公式 $E=mc^2$',
      style: 'swiss',
    })
    results.render_preview = r
  }
  if (want('generate_cover')) {
    const r = await callTool('generate_cover', {
      title: 'MCP 封面测试',
      style: 'swiss',
      outDir: '/tmp/cp-mcp-cover',
    })
    results.generate_cover = r
  }
  if (want('publish_styled')) {
    const r = await callTool('publish_styled', {
      platforms: ['zhihu'],
      title: 'CrossPost MCP styled 验证 ' + new Date().toISOString().slice(11, 19),
      markdown: '## 带样式发布\n\n> 引用验证\n\n- 样式引擎 ✅\n- MCP 通道 ✅',
      style: 'swiss',
    })
    results.publish_styled = r
  }
  if (want('wechat_draft')) {
    const r = await callTool('wechat_draft', {
      title: 'CrossPost MCP wechat 验证 ' + new Date().toISOString().slice(11, 19),
      markdown: '## 官方通道验证\n\nMCP → 官方 API 草稿。',
      style: 'swiss',
    })
    results.wechat_draft = r
    // 链式清理:建草稿后立即删除(净零,防草稿箱积压)
    const mediaId = r && !r.isError && r.data && r.data.mediaId
    if (mediaId) {
      results.wechat_draft_delete_chained = await callTool('wechat_draft_delete', { mediaId })
    }
  }
  if (want('wechat_draft_delete')) {
    // 单独验证工具注册与参数校验(用无效 mediaId 走错误路径,证明连通)
    results.wechat_draft_delete = await callTool('wechat_draft_delete', {
      mediaId: 'test-invalid-media-id',
    })
  }
  if (want('create_style')) {
    const r = await callTool('create_style', {
      name: 'mcp-green',
      from: 'swiss',
      params: { accent: '#2f9e44', bg: '#f7faf7' },
    })
    results.create_style = r
    // 链式清理（v2.24）：此前这个自定义样式会被永久留在全局样式目录里，
    // 出现在 Console 样式下拉框中（用户可见的测试残留）。建完即删，净零。
    if (r && !r.isError) {
      results.create_style_delete = await callTool('styles_delete', { name: 'mcp-green' })
    }
  }
  if (want('analyze_style')) {
    const r = await callTool('analyze_style', {
      htmlPath: '/tmp/cp-analyze-sample.html',
      name: 'mcp-brand',
    })
    results.analyze_style = r
  }

  // 汇总
  console.log('\n===== 测试结果 =====')
  for (const [k, v] of Object.entries(results)) {
    if (k === 'tools' || k === 'initialize') continue
    const ok = v && !v.isError
    console.log(`${ok ? '✅' : '❌'} ${k}: ${JSON.stringify(v && v.data).slice(0, 200)}`)
  }
  if (skipped.length) {
    console.log(`\n－ 已跳过（写操作，需 CROSSPOST_MCP_LIVE=1）：${skipped.join(', ')}`)
  }
  const zhihuDrafts = [results.sync_article, results.publish_styled].filter(
    (v) => v && !v.isError,
  ).length
  if (zhihuDrafts) {
    console.log(
      `\n⚠ 本次在知乎草稿箱创建了 ${zhihuDrafts} 篇测试草稿。引擎没有删除知乎草稿的能力，` +
        `请到 https://zhuanlan.zhihu.com/ 的草稿箱手动删除。`,
    )
  }
  child.kill('SIGTERM')
  process.exit(0)
}

main().catch((e) => {
  console.error('测试失败:', e.message)
  child.kill('SIGKILL')
  process.exit(1)
})
