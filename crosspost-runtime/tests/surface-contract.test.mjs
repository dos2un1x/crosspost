// 工具面契约测试（2026-09-18，v2.05）
//
// 背景：引擎有 4 个接口面（CLI / MCP / HTTP+Console / DSH preset），
// 而"哪些方法该暴露为 MCP 工具"此前只靠注释与人工记忆维护
// （见 docs/api-surfaces.md；早年这份清单靠人工同步，现在由本测试双向锁死）。
// 结果就是：新增 CLI 方法后，MCP 面可能漏暴露，或反过来在 MCP 里重复实现业务逻辑。
//
// 本测试把这条契约机械化，**双向**锁死：
//   ① MCP 注册的每个工具，必须对应一个真实存在的 CLI handler（命名：camelCase → snake_case）
//   ② CLI 的每个 handler，必须落在「已暴露给 MCP」或「显式声明的内部面」之一
//      —— 后者必须在 INTERNAL_ONLY 中登记并写明理由，禁止"默默多出来"
//
// 因此新增 CLI 方法时，你必须做一个明确选择（暴露 or 登记为内部面），
// 而不是让两个面悄悄漂移。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CLI_PATH = path.join(ROOT, 'src', 'cli.mjs')
// © dos2un1x · https://github.com/dos2un1x/crosspost
const MCP_PATH = path.join(ROOT, 'mcp-server', 'index.mjs')

/**
 * MCP 工具名 → CLI handler 的**显式映射**。
 *
 * 大部分工具走默认约定 camelCase ↔ snake_case（如 sync_article ↔ syncArticle），
 * 但以下 5 个是历史命名，不遵守约定。此处显式登记——登记表本身即契约的一部分：
 * 新增工具若命名不符合约定，必须加进这里，否则契约①会失败。
 */
export const TOOL_TO_HANDLER = {
  status: 'proxyStatus', // 对外叫 status，内部是 proxyStatus
  publish_styled: 'syncStyledArticle', // 对外叫 publish_styled（渲染+发布），内部是 syncStyledArticle
  create_style: 'styles', // 样式域统一由 styles 一个 handler 分派（action 区分）
  styles_delete: 'styles',
  styles_rename: 'styles',
  install_styles: 'styles', // 同上：MCP 侧只是 `styles install ...` 的薄封装
  generate_cover: 'generateCover', // 该工具用动态 cmd 数组调用，故显式登记
}

/** 解析 MCP 工具名 → CLI handler 名（先查显式映射，再走 camelCase 约定） */
export function resolveHandlerForTool(tool) {
  if (TOOL_TO_HANDLER[tool]) return TOOL_TO_HANDLER[tool]
  return tool.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

/** camelCase → snake_case（MCP 工具命名约定） */
export const toSnake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())

/** 从 cli.mjs 的 HANDLERS 注册表提取方法名（单一来源） */
export function extractCliHandlers(src) {
  const m = /const HANDLERS = \{([\s\S]*?)\n\}\n/.exec(src)
  assert.ok(m, '未能在 cli.mjs 中找到 HANDLERS 注册表——若改名，请同步更新本测试')
  return [...m[1].matchAll(/^ {2}([a-zA-Z][A-Za-z0-9]*):/gm)].map((x) => x[1])
}

/** 从 mcp-server 提取注册的工具名 */
export function extractMcpTools(src) {
  return [...src.matchAll(/^ {2}'([a-z_]+)',$/gm)].map((x) => x[1])
}

/**
 * 刻意**不**暴露给 MCP 的 CLI 方法及理由。
 *
 * 这些方法属于「Console 界面专用」或「引擎内部维护」，不是接入方的公开契约。
 * 把它们暴露出去会：
 *   · 让外部调用方依赖界面内部实现（改 UI 就得改 MCP），
 *   · 且与「同一能力只在一个面实现」的铁律冲突。
 *
 * 新增方法若落进这里，必须归类并写明理由；若属于对外能力，就应当加 MCP 工具。
 */
export const INTERNAL_ONLY = {
  // ── 环境与自检（面向终端用户与 CI，不适合作为 AI 工具） ──
  doctor: '环境自检：终端/CI 用，有独立 CLI 入口（doctor-cli.mjs）',
  doctorText: '环境自检的人类可读形式：同上',
  setup: '一键初始化：安装期动作，不应由 AI 会话触发',

  // ── 内容域：Console 界面专用（P1 将随项目接入契约收敛） ──
  listArticles: 'Console 文章列表',
  getArticle: 'Console 详情抽屉',
  readDraft: 'Console 草稿阅读',
  updateDraft: 'Console 编写工作台（写操作仅限人工在界面触发）',
  createDraft: 'Console 新建草稿',
  deleteDraft: 'Console 删除草稿（删除类，须人工携带 authorized）',
  archiveArticle: 'Console 归档/取消归档',
  setArticleStatus: 'Console 状态标记',
  markPublished: 'Console 单篇标记已发布',
  markAllPublished: 'Console 批量标记已发布',
  listArchive: 'Console 归档库',
  retainArticle: 'Console 留存（移动文件，须人工触发）',
  listRetained: 'Console 留存库',
  retainedAction: 'Console 留存项操作',
  classifyArticles: 'Console 批量分类/留存',
  setArticleRisk: 'Console 风险标记',
  publishDouyin: 'Console 抖音手动推送（单槽覆盖式，仅人工）',

  // ── 运营数据：Console 报表/费用视图 ──
  articleCost: 'Console 单篇费用',
  listCosts: 'Console 费用报表',
  prewarmCosts: '费用会话预热（内部性能动作）',

  // ── 通知：由发布器内部或 Console 触发 ──
  notify: '发布器内部调用（不经外部工具）',
  notifyTest: 'Console「发送测试通知」按钮',
  // v2.81：定时门禁（接入方的定时脚本到点时问一句）——槽位开关是项目级设置，
  // 门禁必须与 Console 同源，所以它得按项目解析后再回答
  slotEnabled: '定时门禁（项目脚本 run_once.sh 到点时问一句；与调度器同源）',

  // ── 样式/封面：MCP 已有对应工具，这些是 Console 专用变体 ──
  styles: 'Console 样式库原始列表（MCP 用 list_styles）',
  listCoverTemplates: 'Console 封面模板列表',
  generateCoverGallery: 'Console 封面九宫格预览',
  generateEndingCard: 'Console 结尾卡生成',

  // ── 其他 ──
  syncStyledArticle: 'MCP 用 publish_styled 覆盖；此为 CLI 内部变体',
  extractActiveTab: '依赖浏览器活动标签页，Console 专用',
  resolveProject: '桥内部路由决策：判断该请求走默认路径还是项目数据源（不是对外能力）',
  proxyStatus: '代理通道内部状态',
  wechatDrafts: 'Console 微信草稿列表',
  backfill: '历史回填（可选适配器，默认关闭）',

  // ── 选题库：写入已暴露给 MCP（工具 topic_pool_upsert），这里是只读/预检的两条 ──
  // 三条命令共用同一个 handler 与同一份实现（src/topic-pool.mjs）：
  //   · `topicPoolUpsert` → 暴露为 MCP 工具 `topic_pool_upsert`（AI 会话侧），
  //     同时项目侧脚本仍走 CLI（`cli.mjs topicPoolUpsert`）——两条路同一个实现；
  //   · 下面两条是人排查用的预检/观测，进工具面只会白占上下文。
  topicPoolValidate: '只校验行形状、不碰磁盘（脚本/维护侧先问一句；无 AI 使用场景）',
  topicPoolShow: '只读观测（路径 + 各状态计数），排查"这条为什么没入库"',
}

test('契约①：每个 MCP 工具都必须对应真实存在的 CLI handler', () => {
  const cliSrc = fs.readFileSync(CLI_PATH, 'utf8')
  const mcpSrc = fs.readFileSync(MCP_PATH, 'utf8')
  const handlers = new Set(extractCliHandlers(cliSrc))
  const tools = extractMcpTools(mcpSrc)

  assert.ok(tools.length > 0, '未提取到任何 MCP 工具——注册写法可能已变')

  const orphan = tools.filter((t) => !handlers.has(resolveHandlerForTool(t)))
  assert.deepEqual(
    orphan,
    [],
    `以下 MCP 工具在 cli.mjs 的 HANDLERS 中找不到对应方法：${orphan.join(', ')}\n` +
      '铁律：业务逻辑只在 cli.mjs 实现，MCP 面只做薄封装。',
  )
})

test('契约②：每个 CLI handler 必须「已暴露给 MCP」或「已登记为内部面」', () => {
  const cliSrc = fs.readFileSync(CLI_PATH, 'utf8')
  const mcpSrc = fs.readFileSync(MCP_PATH, 'utf8')
  const handlers = extractCliHandlers(cliSrc)
  const exposed = new Set(extractMcpTools(mcpSrc))

  const exposedHandlers = new Set([...exposed].map(resolveHandlerForTool))
  const unclassified = handlers.filter((h) => {
    if (exposedHandlers.has(h)) return false
    return !(h in INTERNAL_ONLY)
  })

  assert.deepEqual(
    unclassified,
    [],
    `以下 CLI handler 既未暴露为 MCP 工具，也未登记为内部面：${unclassified.join(', ')}\n` +
      '请二选一：① 在 mcp-server 加对应工具；② 登记进本测试的 INTERNAL_ONLY 并写明理由。\n' +
      '（登记本身就是"这个能力不对外"的显式设计决策，别让它默认漂移。）',
  )
})

test('契约③：INTERNAL_ONLY 不得登记已失效的方法（防登记表腐化）', () => {
  const cliSrc = fs.readFileSync(CLI_PATH, 'utf8')
  const handlers = new Set(extractCliHandlers(cliSrc))
  const stale = Object.keys(INTERNAL_ONLY).filter((k) => !handlers.has(k))
  assert.deepEqual(
    stale,
    [],
    `INTERNAL_ONLY 中登记的以下方法已不存在于 cli.mjs：${stale.join(', ')}。请删除条目。`,
  )
})

test('契约④：INTERNAL_ONLY 的条目必须有非空理由', () => {
  const empty = Object.entries(INTERNAL_ONLY)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < 4)
    .map(([k]) => k)
  assert.deepEqual(empty, [], `以下条目缺理由：${empty.join(', ')}`)
})

test('契约⑤：MCP 工具名不得重复', () => {
  const mcpSrc = fs.readFileSync(MCP_PATH, 'utf8')
  const tools = extractMcpTools(mcpSrc)
  const seen = new Set()
  const dup = tools.filter((t) => (seen.has(t) ? true : (seen.add(t), false)))
  assert.deepEqual(dup, [], `重复注册的 MCP 工具：${dup.join(', ')}`)
})

test('契约⑥：CLI handler 名不得重复', () => {
  const cliSrc = fs.readFileSync(CLI_PATH, 'utf8')
  const handlers = extractCliHandlers(cliSrc)
  const seen = new Set()
  const dup = handlers.filter((h) => (seen.has(h) ? true : (seen.add(h), false)))
  assert.deepEqual(dup, [], `重复注册的 CLI handler：${dup.join(', ')}`)
})

test('契约⑦：TOOL_TO_HANDLER 映射不得指向不存在的 CLI 方法', () => {
  const cliSrc = fs.readFileSync(CLI_PATH, 'utf8')
  const handlers = new Set(extractCliHandlers(cliSrc))
  const bad = Object.entries(TOOL_TO_HANDLER)
    .filter(([, h]) => !handlers.has(h))
    .map(([t, h]) => `${t}→${h}`)
  assert.deepEqual(bad, [], `映射指向不存在的方法：${bad.join(', ')}`)
})

test('契约⑧：TOOL_TO_HANDLER 只登记真实存在的 MCP 工具', () => {
  const mcpSrc = fs.readFileSync(MCP_PATH, 'utf8')
  const tools = new Set(extractMcpTools(mcpSrc))
  const stale = Object.keys(TOOL_TO_HANDLER).filter((t) => !tools.has(t))
  assert.deepEqual(stale, [], `映射中登记的以下工具已不存在：${stale.join(', ')}`)
})
