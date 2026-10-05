#!/usr/bin/env node
/**
 * CrossPost MCP Server（stdio）
 *
 * 把 crosspost-runtime CLI 的能力包装为标准 MCP 工具（当前 18 个），
 * 供两类客户端接入：
 *   - DSH 内部：host 组合中 @deepseek-ai/dsh-mcp-client 一行（工具名 mcp__crosspost__*）
 *   - 外部 MCP 客户端：Claude Desktop / Cursor / Claude Code 在 mcpServers 配置本进程
 *
 * 协议：MCP stdio（JSON-RPC 2.0 over stdin/stdout）
 * 依赖：@modelcontextprotocol/sdk + zod（跨平台运行时根依赖声明，经 crosspost-runtime/node_modules 解析；
 *   曾依赖 ~/.dsh/profiles 软链解析，2026-09-07 改为已声明依赖以避免被 npm prune）
 *
 * 用法：
 *   node mcp-server/index.mjs
 *   node 路径默认取 process.execPath（当前进程的 node，永远存在），
 *   可用 CROSSPOST_NODE 显式覆盖（2026-09-18 v2.02：原先硬编码 /usr/local/bin/node，
 *   在 Apple Silicon 无 Homebrew 的环境该路径不存在，会导致 MCP 工具全挂）
 */
import { spawn } from 'node:child_process'
import { platformCountPhrase } from '../src/platform-matrix.mjs'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
// 发布来源判定（2026-09-12）：定时链路（WECHAT_AUTO_SCHEDULED=1）与一键生成（WECHAT_AUTO_DRAFT_ONLY=1）
// 由 shell 注入的 env 标记判定，AI 无法自我豁免；底层发布工具对这两类来源一律拒绝（防绕过总开关）。
import {
  resolvePublishOrigin,
  lowLevelBlockReason,
  lowLevelPublishBlocked,
} from '../src/publish-origin.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NODE = process.env.CROSSPOST_NODE || process.execPath
const CLI = path.resolve(__dirname, '../src/cli.mjs')

let reqCounter = 0

/**
 * 本 MCP 会话的目标项目（v2.22）。
 *
 * 语义：MCP 是"一进程一项目"模型——为某个写作项目起的 server 只服务该项目，
 * 因此用 `CROSSPOST_PROJECT` 在**会话级**声明一次即可，不必让每个工具都带 project。
 * 与 CLI（`--project=`）/ HTTP（`X-CrossPost-Project`）共用同一套解析，
 * 三面对同一个项目给出一致行为。未设置时完全走默认路径（生产单项目行为逐字不变）。
 */
const defaultProject = () => (process.env.CROSSPOST_PROJECT || '').trim()

/** 项目透传标志（与 crosspost-runtime/src/project-context.mjs 的 PROJECT_FLAG 一致） */
const PROJECT_ARG = '--project='

/**
 * 调 cli.mjs 子进程，解析 stdout JSON。
 *
 * @param {string[]} args
 * @param {number} timeoutMs
 * @param {string} [project] 显式项目（优先于会话级 `CROSSPOST_PROJECT`）
 */
function callCli(args, timeoutMs = 180000, project = '') {
  const proj = (project || defaultProject()).trim()
  const hasFlag = args.some((a) => typeof a === 'string' && a.startsWith(PROJECT_ARG))
  const argv = proj && !hasFlag ? [...args, PROJECT_ARG + proj] : args
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      reject(new Error('cli 超时: ' + argv[0] + ' (>' + timeoutMs + 'ms)'))
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error('cli 输出解析失败 (exit=' + code + '): ' + String(err).slice(0, 300)))
      }
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

/** 统一返回 MCP content 文本 */
function text(v) {
  return {
    content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
  }
}
function errText(v) {
  return {
    content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
    isError: true,
  }
}

/**
 * 底层发布工具来源守卫（2026-09-12）。
 * 定时链路 / 一键生成链路禁止直接调 sync_article / publish_styled / wechat_draft——
 * 否则 AI 可在 publish_article 被「生成后自动推送」开关跳过后改调底层工具绕过总开关。
 * @returns {string|null} 拒绝原因（null = 放行）
 */
function lowLevelGuard(tool) {
  const origin = resolvePublishOrigin()
  if (!lowLevelPublishBlocked(origin)) return null
  return `${tool} 被来源守卫拒绝（origin=${origin}）：${lowLevelBlockReason(origin)}`
}

const server = new McpServer({ name: 'crosspost', version: '1.0.0' })

// 1. status —— 代理/桥接状态
server.registerTool(
  'status',
  {
    title: 'CrossPost 状态',
    description: '多平台发布助手状态（经浏览器代理通道）：proxyMode、扩展连接、Bridge 状态。',
    inputSchema: {},
  },
  async () => {
    try {
      return text(await callCli(['proxyStatus']))
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 1b. projects —— 已接入的写作项目注册表（P1 接入契约）
server.registerTool(
  'projects',
  {
    title: '已接入的写作项目',
    description:
      '列出经 .crosspost/project.json 接入引擎的写作项目：id / 名称 / 声明的能力 / ' +
      '数据源可达性。未接入任何项目时返回空列表（引擎仍可用，平台域功能不依赖项目）。',
    inputSchema: { projectId: z.string().optional().describe('可选：只查某个项目 id') },
  },
  async ({ projectId }) => {
    try {
      return text(await callCli(projectId ? ['projects', projectId] : ['projects']))
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 2. list_platforms —— 全部已支持平台的登录状态（数量见平台能力矩阵，勿手写）
server.registerTool(
  'list_platforms',
  {
    title: '列出平台登录状态',
    description: `列出${platformCountPhrase()}的登录状态（经浏览器代理）：isAuthenticated / username / error。`,
    inputSchema: {},
  },
  async () => {
    try {
      const r = await callCli(['listPlatforms'])
      return text({ platforms: (r && r.platforms) || r })
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 3. check_auth —— 单平台登录检查
server.registerTool(
  'check_auth',
  {
    title: '检查平台登录',
    description: '检查指定平台登录状态（经浏览器代理）。',
    inputSchema: {
      platform: z.string().describe('平台 ID，如 zhihu/csdn/juejin'),
    },
  },
  async (args) => {
    try {
      return text(await callCli(['checkAuth', args.platform]))
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 4. extract_article —— URL 或活动标签页提取正文
server.registerTool(
  'extract_article',
  {
    title: '提取文章正文',
    description:
      '从 URL 或已打开的浏览器标签页提取文章（标题/正文 Markdown/HTML/封面）。activeTab 为 true 时读活动标签页（url 可选，用于匹配指定标签页）。',
    inputSchema: {
      url: z
        .string()
        .optional()
        .describe('文章 URL；activeTab 模式下用它匹配已打开的标签页，否则直接抓取该 URL'),
      activeTab: z.boolean().optional().describe('为 true 时从浏览器已打开的标签页提取'),
    },
  },
  async (args) => {
    try {
      let r
      if (args && args.activeTab) {
        r = await callCli(['extractActiveTab'].concat(args.url ? [args.url] : []))
      } else if (args && args.url) {
        r = await callCli(['extractArticle', args.url])
      } else {
        return errText('需要 url 或 activeTab 参数')
      }
      return text({
        article: (r && r.article) || null,
        error: (r && r.error) || null,
        source: (r && r.source) || null,
      })
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 5. sync_article —— 并发发布草稿（恒为草稿模式）
server.registerTool(
  'sync_article',
  {
    title: '同步文章为平台草稿',
    description: `把文章发布到目标平台（恒为草稿，不直接发布，防封禁；经浏览器代理）。目标平台限${platformCountPhrase()}。并发发布，结果按请求顺序返回。`,
    inputSchema: {
      platforms: z.array(z.string()).describe('目标平台 ID 列表，如 ["zhihu","csdn","juejin"]'),
      title: z.string().describe('文章标题（纯文本）'),
      markdown: z.string().optional().describe('Markdown 正文（不含标题行）'),
      content: z.string().optional().describe('HTML 正文（可选，与 markdown 二选一）'),
      cover: z.string().optional().describe('封面图 URL（可选）'),
      concurrency: z.number().optional().describe('并发发布数（默认取配置，1-10）'),
    },
  },
  async (args) => {
    try {
      // 2026-09-12：定时/一键生成链路禁止直接派发（必须经 publish_article 受开关门控）
      const blocked = lowLevelGuard('sync_article')
      if (blocked) return errText(blocked)
      if (!args.platforms || !args.platforms.length) return errText('缺少 platforms')
      if (!args.title) return errText('缺少 title')
      if (!args.markdown && !args.content) return errText('markdown 或 content 至少提供一个')
      reqCounter += 1
      const reqPath = path.join(
        os.tmpdir(),
        'crosspost-mcp-req-' + process.pid + '-' + reqCounter + '.json',
      )
      const body = {
        platforms: args.platforms,
        article: {
          title: args.title,
          markdown: args.markdown || '',
          html: args.content || '',
          cover: args.cover,
        },
      }
      if (args.concurrency) body.concurrency = args.concurrency
      fs.writeFileSync(reqPath, JSON.stringify(body))
      try {
        const r = await callCli(['syncArticle', reqPath], 300000)
        return text({ results: (r && r.results) || r })
      } finally {
        try {
          fs.unlinkSync(reqPath)
        } catch {}
      }
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 6. upload_image_file —— 本地图片上传图床
server.registerTool(
  'upload_image_file',
  {
    title: '上传本地图片到图床',
    description: '把本地图片上传到指定平台图床（默认 zhihu）。返回图片 URL，可作正文插图/封面。',
    inputSchema: {
      filePath: z.string().describe('本地图片绝对路径'),
      platform: z.string().optional().describe('图床平台，默认 zhihu'),
    },
  },
  async (args) => {
    try {
      if (!args.filePath) return errText('缺少 filePath')
      const r = await callCli(['uploadImageFile', args.filePath, args.platform || 'zhihu'])
      return text(r)
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 7. proxy_test —— 来源检测验证
server.registerTool(
  'proxy_test',
  {
    title: '代理来源检测验证',
    description:
      '验收工具：经浏览器代理通道请求 httpbin 系服务，返回实际请求头，验证来源检测一致性（浏览器原生 UA/Sec-Fetch）。',
    inputSchema: {},
  },
  async () => {
    try {
      return text(await callCli(['proxyTest']))
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 8. list_styles —— 样式清单（P4）
server.registerTool(
  'list_styles',
  {
    title: '列出可用样式',
    description: '列出可用样式（内置 10 + custom）：name / category / desc。',
    inputSchema: {},
  },
  async () => {
    try {
      return text(await callCli(['listStyles']))
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 9. render_preview —— 带样式渲染预览（P4）
server.registerTool(
  'render_preview',
  {
    title: 'Markdown 带样式渲染预览',
    description:
      '用指定样式渲染 Markdown 为微信兼容 styled HTML（纯本地零网络）。返回完整 HTML，供检查样式效果。',
    inputSchema: {
      markdown: z.string().describe('Markdown 正文'),
      style: z.string().optional().describe('样式名（默认 swiss；内置 10 + custom-*）'),
    },
  },
  async (args) => {
    try {
      if (!args.markdown) return errText('缺少 markdown')
      reqCounter += 1
      const mdPath = path.join(os.tmpdir(), `crosspost-mcp-render-${process.pid}-${reqCounter}.md`)
      fs.writeFileSync(mdPath, args.markdown, 'utf8')
      try {
        const r = await callCli(['renderPreview', mdPath, args.style || 'swiss'])
        if (r && r.error) return errText(r.error)
        return text({ style: r.style, warnings: r.warnings, html: r.html })
      } finally {
        try {
          fs.unlinkSync(mdPath)
        } catch {}
      }
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 10. generate_cover —— 封面生成（P4，2026-08-27：style → 13 款 template）
server.registerTool(
  'generate_cover',
  {
    title: '生成封面 PNG',
    description:
      '根据标题 + 封面模板生成双尺寸封面 PNG（2.35:1 主图 + 1:1 缩略，本地程序化渲染，免费无版权，中文正常）。模板：nebula 星云 / orb3d 3D球 / aurora 极光 / particles 粒子 / glasscard 玻璃卡 / spectrum 频谱 / bokeh 光斑 / cyber 霓虹 / skyline 天际线 / mountains 山峦 / bignum 大数字 / iridescent 虹彩 / minimal 极简留白。返回 PNG 文件路径。',
    inputSchema: {
      title: z.string().describe('文章标题'),
      template: z.string().optional().describe('封面模板（默认 nebula；13 款可选）'),
      subtitle: z.string().optional().describe('副标题（可选）'),
      tag: z.string().optional().describe('栏目角标（可选）'),
      outDir: z.string().optional().describe('输出目录（默认 /tmp/crosspost-cover）'),
    },
  },
  async (args) => {
    try {
      if (!args.title) return errText('缺少 title')
      const outDir = args.outDir || path.join(os.tmpdir(), 'crosspost-cover')
      const cmd = ['generateCover', args.title, args.template || 'nebula', `--out-dir=${outDir}`]
      if (args.subtitle) cmd.push(`--subtitle=${args.subtitle}`)
      if (args.tag) cmd.push(`--tag=${args.tag}`)
      const r = await callCli(cmd)
      return text(r)
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 11. publish_styled —— 带样式多平台存草稿（P4）
server.registerTool(
  'publish_styled',
  {
    title: '带样式发布为平台草稿',
    description:
      '用样式引擎渲染 Markdown（内置 10 样式 + 公式 + 脚注 + 引用 + ASCII 表格）后同步到目标平台（恒为草稿，经浏览器代理）。图片经 zhihu 图床（本地/外链自动上传）。',
    inputSchema: {
      platforms: z.array(z.string()).describe('目标平台 ID 列表，如 ["zhihu","csdn","weixin"]'),
      title: z.string().describe('文章标题'),
      markdown: z.string().describe('Markdown 正文'),
      style: z.string().optional().describe('样式名（默认 swiss）'),
      cover: z.string().optional().describe('封面图 URL（可选）'),
      concurrency: z.number().optional().describe('并发发布数（默认取配置，1-10）'),
    },
  },
  async (args) => {
    try {
      // 2026-09-12：同上，防绕过总开关
      const blocked = lowLevelGuard('publish_styled')
      if (blocked) return errText(blocked)
      if (!args.platforms || !args.platforms.length) return errText('缺少 platforms')
      if (!args.title) return errText('缺少 title')
      if (!args.markdown) return errText('缺少 markdown')
      reqCounter += 1
      const reqPath = path.join(
        os.tmpdir(),
        'crosspost-mcp-styled-' + process.pid + '-' + reqCounter + '.json',
      )
      const body = {
        platforms: args.platforms,
        article: {
          title: args.title,
          markdown: args.markdown,
          style: args.style || 'swiss',
          cover: args.cover,
        },
      }
      if (args.concurrency) body.concurrency = args.concurrency
      fs.writeFileSync(reqPath, JSON.stringify(body))
      try {
        const r = await callCli(['syncStyledArticle', reqPath], 300000)
        return text({
          results: (r && r.results) || r,
          style: r && r.style,
          warnings: r && r.warnings,
        })
      } finally {
        try {
          fs.unlinkSync(reqPath)
        } catch {}
      }
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 12. wechat_draft —— 官方 API 通道存微信草稿（P4）
server.registerTool(
  'wechat_draft',
  {
    title: '微信官方API存草稿',
    description:
      '用 AppID/AppSecret 直连微信官方 API 创建公众号草稿（恒草稿）：样式渲染 + 正文图官方 CDN 上传 + 封面自动生成上传。需在 crosspost-runtime/.env 或 config.json 配置 WECHAT_APP_ID/WECHAT_APP_SECRET。',
    inputSchema: {
      title: z.string().describe('文章标题'),
      markdown: z.string().describe('Markdown 正文'),
      style: z.string().optional().describe('样式名（默认 swiss）'),
      thumb: z.string().optional().describe('封面本地文件路径（缺省自动生成）'),
      author: z.string().optional().describe('作者（可选，空则不显示）'),
      digest: z.string().optional().describe('摘要（可选，空则不显示）'),
      sourceUrl: z.string().optional().describe('原文链接 content_source_url（可选）'),
    },
  },
  async (args) => {
    try {
      // 2026-09-12：同上，防绕过总开关
      const blocked = lowLevelGuard('wechat_draft')
      if (blocked) return errText(blocked)
      if (!args.title) return errText('缺少 title')
      if (!args.markdown) return errText('缺少 markdown')
      reqCounter += 1
      const reqPath = path.join(
        os.tmpdir(),
        'crosspost-mcp-wechat-' + process.pid + '-' + reqCounter + '.json',
      )
      const body = {
        article: {
          title: args.title,
          markdown: args.markdown,
          style: args.style || 'swiss',
          thumb: args.thumb,
          author: args.author,
          digest: args.digest,
          sourceUrl: args.sourceUrl,
        },
      }
      fs.writeFileSync(reqPath, JSON.stringify(body))
      try {
        const r = await callCli(['wechatDraft', reqPath], 300000)
        return text(r)
      } finally {
        try {
          fs.unlinkSync(reqPath)
        } catch {}
      }
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 13. analyze_style —— 样式提取（P6）
server.registerTool(
  'analyze_style',
  {
    title: '提取样式',
    description:
      '从 URL 或本地 HTML 分析文章视觉样式并保存为 custom 样式（Playwright 计算样式 + 标题/引用结构识别，channel:chrome 复用系统浏览器）。',
    inputSchema: {
      url: z.string().optional().describe('文章 URL（Playwright 打开页面分析）'),
      htmlPath: z.string().optional().describe('本地 HTML 文件路径'),
      name: z.string().optional().describe('样式名（缺省由文章标题生成 custom-xxx）'),
    },
  },
  async (args) => {
    try {
      if (args.url)
        return text(
          await callCli(
            ['analyzeStyle', args.url].concat(args.name ? [`--name=${args.name}`] : []),
          ),
        )
      if (args.htmlPath)
        return text(
          await callCli(
            ['analyzeStyle', args.htmlPath].concat(args.name ? [`--name=${args.name}`] : []),
          ),
        )
      return errText('需要 url 或 htmlPath')
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 14. create_style —— 新增样式（P6）
server.registerTool(
  'create_style',
  {
    title: '新增样式',
    description:
      '克隆模板 + 参数定制创建新样式（如 name="品牌绿" from="swiss" params={accent:"#2f9e44"}）。创建后立即可用于 render_preview/publish_styled。',
    inputSchema: {
      name: z.string().describe('样式名（自动补 custom- 前缀）'),
      from: z.string().optional().describe('模板样式（默认 swiss；内置或已存在 custom）'),
      params: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          '覆盖字段：bg/accent/text/secondary/font/borderWidth/desc/headingProfile/headingStructure/blockquoteStructure 等（旧式下划线字段名仍被接受）',
        ),
    },
  },
  async (args) => {
    try {
      if (!args.name) return errText('缺少 name')
      const setArgs = Object.entries(args.params || {}).map(([k, v]) => `--set=${k}=${v}`)
      return text(
        await callCli(
          ['styles', 'new', args.name]
            .concat(args.from ? ['--from', args.from] : [])
            .concat(setArgs),
        ),
      )
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 14b. install_styles —— 安装样式包 / 迁移旧样式目录
server.registerTool(
  'install_styles',
  {
    title: '安装样式包',
    description:
      '把一份样式包装进自有样式目录（一个样式一个 JSON，装完即可在 list_styles 与 Console 下拉里选到）。' +
      '缺省装仓库自带的起手包（crosspost-runtime/styles/，55 个）；也可以指向旧样式目录做一次性迁移' +
      '（旧拼写会被翻译、已废弃的 cssTemplate 会被忽略、颜色字段里的 !important 与渐变会被规整成 hex）。' +
      '逐个校验：坏文件只报错不写盘。',
    inputSchema: {
      dir: z.string().optional().describe('样式包目录（缺省 = 仓库自带的起手包）'),
      force: z.boolean().optional().describe('已存在的同名样式是否覆盖（默认 false，跳过）'),
      dryRun: z.boolean().optional().describe('只报告不写盘（校验规则与真装一致）'),
    },
  },
  async (args) => {
    try {
      const argv = ['styles', 'install']
      if (args.dir) argv.push(args.dir)
      if (args.force) argv.push('--force')
      if (args.dryRun) argv.push('--dry')
      return text(await callCli(argv))
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 15. styles_delete —— 删除样式（用户 2026-08-19 追加）
server.registerTool(
  'styles_delete',
  {
    title: '删除样式',
    description:
      '删除一个 custom 样式（内置样式无法删除，会返回"样式不存在"）。删除后立即可用 list_styles 验证。',
    inputSchema: {
      name: z
        .string()
        .describe('样式名（自动补 custom- 前缀），如 custom-deepseek-harness手把手详细安装教'),
    },
  },
  async (args) => {
    try {
      if (!args.name) return errText('缺少 name')
      return text(await callCli(['styles', 'delete', args.name]))
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 16. styles_rename —— 重命名样式（用户 2026-08-19 追加）
server.registerTool(
  'styles_rename',
  {
    title: '重命名样式',
    description: '重命名 custom 样式（自动补 custom- 前缀；内置样式无法重命名）。',
    inputSchema: {
      oldName: z.string().describe('旧样式名，如 custom-xxx 或 xxx'),
      newName: z.string().describe('新样式名'),
    },
  },
  async (args) => {
    try {
      if (!args.oldName || !args.newName) return errText('缺少 oldName / newName')
      return text(await callCli(['styles', 'rename', args.oldName, args.newName]))
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 17. wechat_draft_delete —— 删除微信官方通道草稿（2026-08-19 追加）
server.registerTool(
  'wechat_draft_delete',
  {
    title: '删除微信草稿',
    description:
      '按 mediaId 删除微信官方 API 通道创建的公众号草稿（不可恢复）。mediaId 取自 wechat_draft 返回的 mediaId，或经 CLI wechatDrafts 列表核对标题后使用。',
    inputSchema: {
      mediaId: z.string().describe('草稿 mediaId（wechat_draft 返回的 mediaId）'),
    },
  },
  async (args) => {
    try {
      if (!args.mediaId) return errText('缺少 mediaId')
      return text(await callCli(['wechatDraftDelete', args.mediaId], 60000))
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 18. publish_article —— 发布一体化（省 token 核心，2026-08-19 追加）
// 2026-09-12 修复回归：09-11 曾在此硬编码 `manual: true`（“AI 显式调用=人工触发”），
// 但**定时链路本身就是 AI 会话**（接入方的定时脚本 → 它的 DSH profile → 本 MCP），
// 于是「生成后自动推送」开关在定时链路上被恒真豁免（09-12 08:10/08:30 两轮真推了微信+8 平台）。
// 现在来源由 shell 注入的 env 判定：定时链路 manual=false（且 runtime 再冻结一次），
// 被跳过时返回 dispatch:'skipped' + skipReason 供 AI 如实汇报。
server.registerTool(
  'publish_article',
  {
    title: '发布一体化（微信+多平台+记录+通知，一步完成）',
    description:
      '读草稿文件 → 校验 → 样式渲染 → 微信官方通道存草稿 → 多平台存草稿（失败自动重试 1 次）→ 写文章库记录 → 按配置发通知。恒为草稿，绝不自动发表。平台列表缺省取 config.json platforms.default（面板设置页可配置）；未登录平台发布器自动跳过（skip，通知注明），不报失败。**是否真的派发受 config.json.autoPush「生成后自动推送」开关门控：定时链路（WECHAT_AUTO_SCHEDULED=1）永不豁免——开关关闭时只落草稿并返回 dispatch:"skipped" 与 skipReason；交互式会话/CLI/Console 属人工触发，不受开关限制，但也不得改调 sync_article/publish_styled/wechat_draft 绕过**。AI 只需调用这一次即可完成全部发布流程，返回结构化结果（微信 mediaId、各平台 postUrl、未登录跳过列表）。',
    inputSchema: {
      file: z.string().optional().describe('草稿文件绝对路径（与 id 二选一）'),
      id: z.string().optional().describe('草稿 id（文件名去 .md，如 2026-08-19-hotspot-xxx）'),
      project: z
        .string()
        .optional()
        .describe(
          '目标写作项目 id（可选；缺省取会话级 CROSSPOST_PROJECT，再缺省走默认草稿目录）。' +
            '指定后会按 .crosspost/project.json 解析该项目的草稿目录再找 id，避免发错项目的同 id 草稿',
        ),
      style: z
        .string()
        .optional()
        .describe(
          '样式名（默认按栏目映射：morning=swiss/noon=editorial/evening=ink/tips=ink/hotspot=editorial）',
        ),
      platforms: z
        .array(z.string())
        .optional()
        .describe(
          '平台 ID 列表（缺省取 config.json platforms.default，面板设置页可配置；未登录平台自动跳过；douyin 仅走手动通道）',
        ),
      wechat: z.boolean().optional().describe('是否走微信官方通道（默认 true）'),
      notify: z
        .boolean()
        .optional()
        .describe('发布后是否按配置发通知（默认 true，通知由发布器直发不经 AI）'),
      concurrency: z.number().optional().describe('多平台并发数（默认 5，1-10）'),
      score: z
        .number()
        .optional()
        .describe(
          '文章质量评分（0-100，§5.5 自评写 frontmatter 时可省略，发布器自动读取；显式传入时优先）',
        ),
      scoreDims: z
        .record(z.string(), z.number())
        .optional()
        .describe('评分维度明细（可选，随 score 入库）'),
      rewrites: z.number().optional().describe('低分重写次数（可选，随 score 入库）'),
      decision: z
        .string()
        .optional()
        .describe(
          '编辑决策快照（可选，§4.0 决策行「决策=主线|理由|重复风险」原文，随记录/历史入库，可复盘）',
        ),
      review: z
        .string()
        .optional()
        .describe(
          '独立审稿快照（可选，§5.6 审稿行「审稿=分 行动=publish|revise|block 修订=n」原文，随记录/历史入库，可复盘）',
        ),
      aiDetect: z
        .string()
        .optional()
        .describe(
          'AI 检测快照（可选，§5.55 门禁行原文，如「AI检测=pass(口径=confidence 值=12.3% 阈值=30.0% …)」；' +
            '随记录/历史入库，并出现在发布通知里。**检测被跳过时也要传**（reason 会写进去），否则事后无法区分"通过"与"没检测"）',
        ),
    },
  },
  async (args) => {
    try {
      // 2026-09-12：来源由 env 标记判定（见 publish-origin.mjs）——
      //   scheduled（run_once.sh 定时链路）→ manual=false，受「生成后自动推送」开关门控（永不豁免）
      //   draft-only（generate_once.sh 一键生成）→ 直接拒绝（persona 已禁止，这里兜代码层）
      //   manual（交互式会话 / CLI / Console）→ manual=true，视为人工触发
      const origin = resolvePublishOrigin()
      if (origin === 'draft-only') {
        return errText(
          '一键生成链路（WECHAT_AUTO_DRAFT_ONLY=1）禁止任何发布调用：草稿已落盘，请到 Console 手动推送',
        )
      }
      // 留痕：万一将来 dsh 改环境变量清洗规则导致标记丢失，run-*.log 里立刻可见
      console.error(`[mcp] publish_article origin=${origin} file=${args.file || args.id || '-'}`)
      const req = {
        file: args.file,
        id: args.id,
        style: args.style,
        platforms: args.platforms,
        wechat: args.wechat,
        notify: args.notify,
        concurrency: args.concurrency,
        score: args.score,
        scoreDims: args.scoreDims,
        rewrites: args.rewrites,
        decision: args.decision,
        review: args.review,
        aiDetect: args.aiDetect,
        // 2026-09-12：来源与 manual 均由上面的可信标记推导（定时链路恒 false）
        origin,
        manual: origin === 'manual',
      }
      const tmp = path.join(os.tmpdir(), `crosspost-mcp-publish-${Date.now()}.json`)
      fs.writeFileSync(tmp, JSON.stringify(req), 'utf8')
      // project 经 CLI 的 --project= 建立请求级上下文（草稿查找 + 记录落盘都随之隔离）
      const r = await callCli(['publishArticle', tmp], 600000, args.project)
      try {
        fs.unlinkSync(tmp)
      } catch {}
      return text(r)
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 21. topic_pool_upsert —— 项目选题库：写入本轮候选（AI 会话侧入口）
//
// 为什么给 AI 面单独开一个工具（而不是让它继续跑项目侧脚本）：
//   · **行形状写进 schema**：`rows[].title` 是必填（可为空串）、`status` 是 enum、
//     `score` 是数字——漏字段/给错类型在**工具调用**就被挡住，而不是等写进文件后
//     由 Console 表现异常才发现（写入规则本身仍在 src/topic-pool.mjs，唯一实现）。
//   · **不经 shell**：脚本路径要把候选 JSON 塞进 bash 单引号（keyword 里的引号、
//     `$`、反斜杠都可能变形），这里走结构化参数。
// 脚本/定时链路仍用 `cli.mjs topicPoolUpsert`（同一个 handler，同一份实现）。
server.registerTool(
  'topic_pool_upsert',
  {
    title: '选题库：写入本轮候选',
    description:
      '把本轮候选（含落选）写入项目选题库，按 (date, slot, keyword) upsert：' +
      '命中的条目就地更新、未命中的追加，绝不移除同日同 slot 的其它条目，' +
      '已 generated 的条目不降级。任何一行不合格 → 整次写入被拒（一个字节都不落盘），' +
      '返回里带逐条原因。目标项目由连接配置（CROSSPOST_PROJECT）决定，无需传项目。',
    inputSchema: {
      date: z.string().describe('候选所属日期，YYYY-MM-DD'),
      slot: z.string().describe('槽位 id，例如 hotspot / hotspot2 / tips / noon / evening'),
      rows: z
        .array(
          z.object({
            keyword: z.string().min(1).describe('候选关键词（与 date+slot 一起构成唯一键）'),
            title: z
              .string()
              .describe(
                '文章标题；采用项写实际标题，落选给空串 ""。**必须给**：漏了这个字段会让后面所有字段错位',
              ),
            score: z.number().min(0).max(100).nullable().describe('五维评分 0-100；没有就给 null'),
            status: z
              .enum(['adopted', 'generated', 'rejected'])
              .describe('adopted=采用未生成 / generated=已生成文章 / rejected=落选'),
            reason: z.string().describe('落选原因（与低分维度对应）；采用项给空串'),
            articleId: z.string().optional().describe('已生成文章时给草稿文件名（去 .md）'),
          }),
        )
        .min(1)
        .describe('本轮候选：3-5 条，采用项与落选都要写'),
      manual: z.boolean().optional().describe('一键生成分支：只写自己这一条（status=generated）'),
      articleId: z.string().optional().describe('manual 分支的草稿文件名（去 .md）'),
    },
  },
  async ({ date, slot, rows, manual, articleId }) => {
    const args = [
      'topicPoolUpsert',
      `--date=${date}`,
      `--slot=${slot}`,
      `--json=${JSON.stringify(rows)}`,
    ]
    if (manual) args.push('--manual')
    if (articleId) args.push(`--article-id=${articleId}`)
    try {
      const r = await callCli(args)
      // 被拒时 CLI 以退出码 1 结束并给出 {error}（逐条原因），要如实报成工具错误
      if (r && r.error) return errText(r.error)
      return text(r)
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 22. ai_detect —— 朱雀 AIGC 检测：这篇稿子被判 AI 的浓度有多高
//
// 为什么给 AI 会话面单开一个工具：写作流水线要在发布前**拿到一个外部判分**，
// 而"哪几段像 AI 写的"必须落到正文的具体字符区间上才改得动。朱雀在
// `is_merge:false` 时返回 `segment_labels[].position`（字符区间），引擎把它映射回
// markdown 原文的字符偏移，这里只回传被判 AI 的片段（**不回传全量分段**，省上下文）。
//
// 返回里 `verdict` 三态，看清再动手：
//   · pass  —— 低于阈值，可以继续走审稿/发布；
//   · fail  —— 超阈值，按 `rewriteTargets`（片段序号）定向改写后复检；
//   · skip  —— **这次没检测成**（无 key / 配额不足 / 接口故障 / 正文 < 350 字）。
//              必须如实按"未检测"处理并记日志，**不得当成 pass**（那等于静默放行）。
// 台账：当月 token 用量落在 <repo>/.local/ai-detect-usage.json，超预算即 skip。
server.registerTool(
  'ai_detect',
  {
    title: 'AI 检测：朱雀 AIGC 文本检测',
    description:
      '用腾讯朱雀（EdgeOne Makers 内置模型 @makers/zhuque-text）检测一篇文章的 AI 生成浓度，' +
      '返回整体判定（pass/fail/skip）、AI 特征字符占比，以及**被判 AI 的片段**（含回映射到正文的字符区间与预览）。' +
      '检测对象是剥离 markdown 标记后的纯文本（正文需 >350 字，过短直接 skip）。' +
      '凭证走 crosspost-runtime/.env 的 ZHUQUE_API_KEY；无凭证或配额不足时返回 skip 而不是报错——' +
      '调用方必须把 skip 记成「未检测」，不得当成通过。',
    inputSchema: {
      file: z.string().optional().describe('草稿文件绝对路径（与 id / text 三选一）'),
      id: z
        .string()
        .optional()
        .describe('草稿文件名去 .md（在当前项目草稿目录里找；与 file / text 三选一）'),
      text: z.string().optional().describe('直接给正文（基线回测/排查用；与 file / id 三选一）'),
      project: z
        .string()
        .optional()
        .describe('目标项目 id（可选；缺省取会话级 CROSSPOST_PROJECT）'),
      mode: z
        .enum(['distribution', 'metric'])
        .optional()
        .describe(
          '判定口径模式（缺省取 config.json → aiDetect.gate.mode）：' +
            'distribution=三分布同时达标（人工≥humanMin、AI特征≤aiMax、疑似≤uncertainMax，三项之和为 1）；' +
            'metric=旧的单指标口径（只看 metric/threshold）',
        ),
      humanMin: z
        .number()
        .optional()
        .describe(
          'distribution 模式：人工特征占比下限 0-1（缺省 config → aiDetect.gate.humanMin）',
        ),
      aiMax: z
        .number()
        .optional()
        .describe('distribution 模式：AI 特征占比上限 0-1（缺省 config → aiDetect.gate.aiMax）'),
      uncertainMax: z
        .number()
        .optional()
        .describe(
          'distribution 模式：疑似 AI 占比上限 0-1（缺省 config → aiDetect.gate.uncertainMax）',
        ),
      enforce: z
        .enum(['observe', 'block'])
        .optional()
        .describe(
          '门禁强度（缺省 config → aiDetect.gate.enforce）：observe=只报不拦（**不进入重写循环**，省配额）；' +
            'block=硬门禁（按 rewriteTargets 定向改写，仍不达标则留存）。返回里 action 字段给出本次应执行的动作',
        ),
      metric: z
        .enum(['confidence', 'labels_ai', 'both'])
        .optional()
        .describe(
          '旧口径的单指标（仅 mode=metric 时生效，缺省取 config.json → aiDetect.gate.metric）：' +
            'confidence=整体 AI 浓度（官网顶部那个数）/ labels_ai=AI 特征字符占比 / both=两者都低于阈值',
        ),
      threshold: z.number().optional().describe('旧口径的判定阈值 0-1（仅 mode=metric 时生效）'),
      budget: z.boolean().optional().describe('只看当月用量与预算，不调用接口'),
    },
  },
  async ({
    file,
    id,
    text: rawText,
    mode,
    humanMin,
    aiMax,
    uncertainMax,
    enforce,
    metric,
    threshold,
    budget,
    project,
  }) => {
    const args = ['aiDetect']
    if (budget) args.push('--budget')
    else if (file) args.push(`--file=${file}`)
    else if (id) args.push(`--id=${id}`)
    else if (rawText !== undefined) args.push(`--text=${rawText}`)
    else return errText('缺少输入：file / id / text 至少给一个')
    if (mode) args.push(`--mode=${mode}`)
    if (humanMin !== undefined) args.push(`--human-min=${humanMin}`)
    if (aiMax !== undefined) args.push(`--ai-max=${aiMax}`)
    if (uncertainMax !== undefined) args.push(`--uncertain-max=${uncertainMax}`)
    if (enforce) args.push(`--enforce=${enforce}`)
    if (metric) args.push(`--metric=${metric}`)
    if (threshold !== undefined) args.push(`--threshold=${threshold}`)
    try {
      // 检测本身 ≤60s（fetch 超时），CLI 留给它的余量按 180s 走
      const r = await callCli(args, 180000, project)
      if (r && r.error) return errText(r.error)
      return text(r)
    } catch (e) {
      return errText(String((e && e.message) || e))
    }
  },
)

// 启动（stdio）
const transport = new StdioServerTransport()
await server.connect(transport)
