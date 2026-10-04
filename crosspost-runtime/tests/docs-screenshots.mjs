/**
 * README 截图生成器 —— 在隔离沙箱里拍 Console 的八个模块与浏览器扩展的选项页，
 * 把本机痕迹换成占位符后才落盘。
 *
 * 干什么：起一个**临时桥**（随机高端口 + 临时数据根 + 临时 paths.json + 空的自定义样式
 * 目录 + 自有 token 文件），用无头 Chrome 按 Console 导航的八个模块各拍一张**整页**图
 * （顶栏 + 该模块全部内容）；再起一个装了本仓库未打包扩展的临时浏览器 profile，
 * 拍一张扩展选项页（`chrome-extension://<扩展 ID>/options.html`）。按下快门前先把页面上的
 * 本机痕迹替换成占位符、并断言替换干净，最后才把 PNG 写进 `docs/images/`。
 * README「界面」一节引用的就是这九张图。
 *
 * 扩展选项页为什么单起一个浏览器：MV3 扩展只在新版无头（`--headless=new`）或 headed 下
 * 加载，而且它的数据（登录态、连接配置）走 `chrome.storage` 与扩展自己的 fetch，
 * 不能像 Console 那样挂在沙箱桥上。所以那一张用 `page.route` 喂示例载荷
 * （与报表页的费用卡同一手法：**示例数据**），平台名单与检查范围口径从
 * `buildPlatformMatrix()` 派生 —— 页面上没有一处名单是手写的。
 *
 * 为什么不「手工截图 + 事后涂黑」：
 *   · `docs-hygiene.test.mjs` 与 `release-artifact.test.mjs` 都禁止真实家目录进产品文档，
 *     但后者对二进制扩展名（png/jpg…）**整类跳过** —— 手工截图里的
 *     `/Users/<真实用户名>/…` 正好落在这条纪律的盲区里，门禁永远看不见；
 *   · 事后涂黑只遮住像素，真实字符串仍在 PNG 里；本脚本改的是**按下快门前**的 DOM，
 *     所以真实值根本进不了 PNG。
 *
 * 三层安全：
 *   ① 沙箱隔离：绝不碰生产 9539/9540，也绝不改写生产 `bridge/token.local`、
 *      `config.json`、`paths.json`（运行前后比 mtime+size），结束时杀桥 + 删沙箱；
 *      扩展选项页另起一个临时浏览器 profile，跑完同样删掉；
 *   ② 掩码：沙箱路径 / 仓库路径 / 真实用户名 / worker pid / 扩展 clientId / token / 端口
 *      一律替换为占位符（`/Users/me/…` 这类，与文档里既有的示例写法一致）；
 *   ③ 门禁：替换后遍历**每一个 frame** 的 DOM（可见文本 + 表单值 + 属性 + option 文本），
 *      命中任何真实值即中止，**一张图都不写**。门禁跑在即将被截图的同一份 DOM 上、
 *      其后不再改内容，因此「DOM 文本干净」⇒「PNG 像素干净」。
 *      为什么要遍历 frame：编写模块的右侧预览是 `srcdoc` iframe，只扫主框架就是漏检。
 *
 * 两处「示例数据」（都是 `page.route` 喂的固定载荷，图上没有一处来自真实环境）：
 *   · 报表页的 `/proxy/costs`：页面右下两张费用卡。原因是 `token-cost.mjs` 的会话缓存
 *     `/tmp/dsh-session-{index,cost}.json` 是硬编码且与生产桥共用的（只有文章费用文件有
 *     env 覆盖），真调它会写沙箱之外；计价口径那一行仍取自引擎自己导出的 `PRICING`。
 *   · 扩展选项页：整页的数据（登录态 / 检查范围 / 连接状态）。扩展的取数地址来自
 *     `chrome.storage`（默认 127.0.0.1:9539 = 生产桥），没法像 Console 那样指向沙箱桥，
 *     真让它去取数就等于把生产桥的登录态拍进 README。名单与数量仍从 `buildPlatformMatrix()`
 *     派生，不是手写的。
 *
 * 运行：npm run docs:screenshots   （本地维护者命令；需要系统 Chrome + playwright 自带的
 *                                   Chromium，不进 CI）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { PRICING } from '../src/token-cost.mjs'
import { defaultConfig } from '../src/commands/setup.mjs'
import { buildPlatformMatrix } from '../src/platform-matrix.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
const REPO = path.resolve(RUNTIME, '..')
const OUT_DIR = path.join(REPO, 'docs', 'images')
const NODE = process.execPath
/** 未打包扩展的目录：扩展选项页那张图就拍它 */
const EXT_DIR = path.join(REPO, 'bridge', 'chrome-proxy-extension')

const WS_PORT = 26000 + Math.floor(Math.random() * 3000)
const HTTP_PORT = WS_PORT + 1
const BASE = `http://127.0.0.1:${HTTP_PORT}`

/** 单张图的像素/体积上限（与 docs-images.test.mjs 同一口径；超了当场判负）。
 *  高度 9000px：最长的「设置」整页约 7950px（Chromium 单张上限远高于此）。 */
const MAX_PNG_BYTES = 4 * 1024 * 1024
const MAX_PNG_HEIGHT = 9000

/** 扩展选项页那张图：文件名与视口。
 *  视口 860 是"外壳 760 居中"两侧各留一点纸边的取景（`--shell` 在 ≥560px 时就是 760）。 */
const EXT_SHOT = 'extension-options.png'
const EXT_VIEWPORT = { width: 860, height: 900 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 输出小工具 ─────────────────────────────────────────────────── */
const notes = []
const ok = (name, detail = '') => {
  notes.push({ name, ok: true, detail })
  console.log(`✔ ${name}${detail ? ' — ' + detail : ''}`)
}
const bad = (name, detail = '') => {
  notes.push({ name, ok: false, detail })
  console.log(`✖ ${name}${detail ? ' — ' + detail : ''}`)
}
const warn = (name, detail = '') => console.log(`⚠ ${name}${detail ? ' — ' + detail : ''}`)

/** 北京口径的日期（与 Console 的 `todayStr()`、后端 `tz.mjs` 同一口径） */
function beijingDay(offset = 0) {
  const t = Date.now() + offset * 86400000
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(t))
}

/** PNG 尺寸（签名 8 字节 + IHDR：长度4/类型4/宽4/高4） */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const run = (args, env) =>
  new Promise((resolve) => {
    const child = spawn(NODE, args, {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code, out, err }))
    child.on('error', (e) => resolve({ code: -1, out, err: String(e.message) }))
  })

/* ── 沙箱 ───────────────────────────────────────────────────────── */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-screenshots-'))
const localRoot = path.join(sandbox, '.local')
const pathsFile = path.join(sandbox, 'crosspost-runtime', 'paths.json')
const cfgFile = path.join(sandbox, 'config.json')
const tokenFile = path.join(sandbox, 'token.local')
const stylesDir = path.join(sandbox, 'styles')
const demoDrafts = path.join(sandbox, 'demo-drafts')
/** 项目上下文里 `workspace = dirname(dataDir)`，选题库就落在 `<workspace>/history/` 下 */
const demoHistory = path.join(sandbox, 'history')
const demoRoot = path.join(localRoot, 'projects', 'demo-project')
const demoRecords = path.join(localRoot, 'project-state', 'demo-project', 'articles')

const env = {
  CROSSPOST_LOCAL_ROOT: localRoot,
  CROSSPOST_PATHS: pathsFile,
  CROSSPOST_CONFIG: cfgFile,
  CROSSPOST_PROJECTS_DIR: path.join(localRoot, 'projects'),
  // 空的自定义样式目录 → 页面上只有内置样式，不会列出本机样式
  CROSSPOST_CUSTOM_STYLES_DIR: stylesDir,
  CROSSPOST_LEGACY_STYLES: '0',
  // 纵深防御：万一有代码去读会话/费用文件，也只在沙箱里读
  CROSSPOST_SESSIONS_DIRS: path.join(sandbox, 'sessions'),
  CROSSPOST_ARTICLE_COST_FILE: path.join(sandbox, 'article-cost.json'),
  SYNC_PROXY_WS_PORT: String(WS_PORT),
}

/** 生产本机文件：全程必须一字不改 */
const PROD_FILES = [
  path.join(REPO, 'bridge', 'token.local'),
  path.join(RUNTIME, 'config.json'),
  path.join(RUNTIME, 'paths.json'),
]
const prodSnapshot = () =>
  PROD_FILES.map((f) => {
    try {
      const st = fs.statSync(f)
      return `${f}:${st.mtimeMs}:${st.size}`
    } catch {
      return `${f}:absent`
    }
  }).join('|')

/* ── 示例项目夹具（沙箱内；跑完整目录删除）─────────────────────────
 * 记录字段对齐 `crosspost-runtime/src/articles.mjs` 的 `makeDraftRecord`：
 * id/title/file/dir/slot/date/style/status/risk/score/wechat/platforms/notify/history/
 * createdAt/updatedAt；留存与归档还各带一条 history（`retain` / `archive`），
 * 那是 Console 上「留存时间 / 归档时间」的来源。 */
const DEMO_BODY = [
  '## 为什么值得单独做一层',
  '',
  '正文段落，**加粗**、`行内代码` 与列表都在这一层渲染：',
  '',
  '- 一篇 Markdown 只写一次',
  '- 平台差异交给适配器',
  '- 存草稿与发表分开',
  '',
  '> 引用一行，用来看引用样式。',
  '',
  '| 平台 | 默认派发 | 仅检查 |',
  '| --- | --- | --- |',
  '| 知乎 | ✔ | |',
  '| 微信公众号 | | ✔ |',
  '',
].join('\n')

const DEMO = [
  {
    day: 0,
    slot: 'morning',
    topic: 'markdown-to-drafts',
    title: '把一篇 Markdown 变成多平台草稿',
    score: 92,
    risk: 'none',
    style: 'swiss',
    status: 'published',
    wechat: { status: 'ok' },
    platforms: { zhihu: 'ok', csdn: 'ok', baijiahao: 'ok' },
  },
  {
    day: 1,
    slot: 'noon',
    topic: 'platform-matrix',
    title: '平台能力矩阵怎么读',
    score: 84,
    risk: 'none',
    style: 'editorial',
    status: 'partial',
    wechat: { status: 'none' },
    platforms: { zhihu: 'ok', csdn: 'fail', xiaohongshu: 'ok' },
  },
  {
    day: 2,
    slot: 'evening',
    topic: 'draft-only',
    title: '为什么默认只存草稿',
    score: 78,
    risk: 'none',
    style: 'ink',
    status: 'draft',
    wechat: { status: 'none' },
    platforms: {},
  },
  {
    day: 6,
    slot: 'tips',
    topic: 'style-pack',
    title: '从内置样式改出自己的样式',
    score: 61,
    risk: 'ad',
    style: 'notebook',
    status: 'failed',
    wechat: { status: 'fail' },
    platforms: { zhihu: 'fail', csdn: 'fail' },
  },
]

/** 留存库：低分（rejected/）与高风险（risk/）各一篇 */
const DEMO_RETAINED = [
  {
    day: 3,
    slot: 'evening',
    topic: 'low-score',
    title: '素材不足的一篇草稿',
    score: 52,
    risk: 'none',
    dir: 'rejected',
    reason: '素材不足，评分未过线，转入低分留存',
  },
  {
    day: 4,
    slot: 'hotspot',
    topic: 'risky-claim',
    title: '含风险表述的一篇草稿',
    score: 71,
    risk: 'investment',
    dir: 'risk',
    reason: '含投资相关表述，需人工确认后处理',
  },
]

/** 归档库：两篇已归档草稿 */
const DEMO_ARCHIVED = [
  {
    day: 8,
    slot: 'morning',
    topic: 'archived-morning',
    title: '过期的早报草稿',
    score: 66,
    risk: 'none',
    style: 'ink',
    platforms: { zhihu: 'ok' },
  },
  {
    day: 11,
    slot: 'tips',
    topic: 'archived-tips',
    title: '旧的小技巧草稿',
    score: 58,
    risk: 'ad',
    style: 'notebook',
    platforms: {},
  },
]

/** 选题库：generated 1 / adopted 2 / rejected 3；`linkIdx` 指回 DEMO 里的文章 */
const DEMO_TOPICS = [
  {
    day: 0,
    slot: 'morning',
    keyword: '多平台发布里的重复劳动',
    status: 'generated',
    score: 58,
    linkIdx: 0,
  },
  { day: 0, slot: 'noon', keyword: '浏览器扩展为什么是唯一出口', status: 'adopted', score: 51 },
  { day: 1, slot: 'evening', keyword: '恒草稿：为什么默认不发表', status: 'adopted', score: 47 },
  {
    day: 1,
    slot: 'tips',
    keyword: '样式包怎么起步',
    status: 'rejected',
    score: 33,
    reason: '与既有内容重复',
  },
  {
    day: 2,
    slot: 'hotspot',
    keyword: '平台登录态多久会过期',
    status: 'rejected',
    score: 29,
    reason: '话题过窄，撑不起一篇',
  },
  {
    day: 2,
    slot: 'morning',
    keyword: '多账号场景下的账号隔离',
    status: 'rejected',
    score: 24,
    reason: '偏离当前主线',
  },
]

const PLATFORM_ERROR = { fail: '登录态失效，请先在浏览器里重新登录该平台' }

function demoId(d) {
  return `${beijingDay(-d.day)}-${d.slot}-${d.topic}`
}

function writeDraft(dir, d, extraFrontmatter = '') {
  const id = demoId(d)
  const body = `${d.title}\n\n${DEMO_BODY}这是示例项目的示例草稿，用于生成文档截图。\n`
  fs.writeFileSync(
    path.join(dir, `${id}.md`),
    `---\ntitle: ${d.title}\nscore: ${d.score}\nrisk: ${d.risk}\nstyle: ${d.style}\n` +
      `${extraFrontmatter}---\n\n${body}`,
  )
  return id
}

function writeRecord(rec) {
  fs.writeFileSync(path.join(demoRecords, `${rec.id}.json`), JSON.stringify(rec, null, 2))
}

function writeFixture() {
  fs.mkdirSync(path.join(demoRoot, '.crosspost'), { recursive: true })
  for (const dir of ['', 'rejected', 'risk', 'archive']) {
    fs.mkdirSync(path.join(demoDrafts, dir), { recursive: true })
  }
  fs.mkdirSync(demoRecords, { recursive: true })
  fs.mkdirSync(demoHistory, { recursive: true })
  fs.writeFileSync(
    path.join(demoRoot, '.crosspost', 'project.json'),
    JSON.stringify(
      {
        manifestVersion: 2,
        id: 'demo-project',
        name: '示例写作项目',
        dataDir: demoDrafts,
        // generate 声明成 http 提供者：选题库的「一键生成」才是可用态而不是灰按钮。
        // 端点只出现在按钮 title 里（图上不可见），且是假地址。
        capabilities: {
          drafts: true,
          topics: true,
          retention: true,
          reports: true,
          generate: {
            kind: 'http',
            url: 'http://127.0.0.1:8787/generate',
            statusUrl: 'http://127.0.0.1:8787/status',
          },
        },
      },
      null,
      2,
    ),
  )

  const now = new Date().toISOString()

  // ① 文章（4 篇）
  for (const d of DEMO) {
    const id = writeDraft(demoDrafts, d)
    const platforms = {}
    for (const [pid, status] of Object.entries(d.platforms)) {
      platforms[pid] = {
        status,
        error: status === 'fail' ? PLATFORM_ERROR.fail : null,
        at: now,
        manualConfirmed: true,
        ...(status === 'ok' ? { postUrl: `https://example.com/${pid}/${id}` } : {}),
      }
    }
    writeRecord({
      id,
      title: d.title,
      file: path.join(demoDrafts, `${id}.md`),
      dir: null,
      slot: d.slot,
      date: beijingDay(-d.day),
      style: d.style,
      status: d.status,
      risk: d.risk,
      score: { total: d.score, at: now },
      wechat: { ...d.wechat, at: now },
      platforms,
      notify: { status: 'none' },
      history: [],
      createdAt: now,
      updatedAt: now,
    })
  }

  // ② 留存（2 篇）
  for (const d of DEMO_RETAINED) {
    const id = writeDraft(path.join(demoDrafts, d.dir), d)
    writeRecord({
      id,
      title: d.title,
      file: path.join(demoDrafts, d.dir, `${id}.md`),
      dir: null,
      slot: d.slot,
      date: beijingDay(-d.day),
      style: 'swiss',
      status: 'retained',
      risk: d.risk,
      retainedReason: d.reason,
      retainedDir: d.dir,
      score: { total: d.score, at: now },
      wechat: { status: 'none' },
      platforms: {},
      notify: { status: 'none' },
      history: [{ action: 'retain', at: now, dir: d.dir }],
      createdAt: now,
      updatedAt: now,
    })
  }

  // ③ 归档（2 篇）
  for (const d of DEMO_ARCHIVED) {
    const id = writeDraft(path.join(demoDrafts, 'archive'), d)
    const platforms = {}
    for (const [pid, status] of Object.entries(d.platforms)) {
      platforms[pid] = { status, error: null, at: now, manualConfirmed: true }
    }
    writeRecord({
      id,
      title: d.title,
      file: path.join(demoDrafts, 'archive', `${id}.md`),
      dir: null,
      slot: d.slot,
      date: beijingDay(-d.day),
      style: d.style,
      status: 'archived',
      risk: d.risk,
      score: { total: d.score, at: now },
      wechat: { status: 'none' },
      platforms,
      notify: { status: 'none' },
      history: [{ action: 'archive', at: now }],
      createdAt: now,
      updatedAt: now,
    })
  }

  // ④ 选题库
  const topics = DEMO_TOPICS.map((t, i) => ({
    id: `demo-topic-${i + 1}`,
    date: beijingDay(-t.day),
    slot: t.slot,
    keyword: t.keyword,
    status: t.status,
    topicScore: t.score,
    rank: i + 1,
    ...(t.reason ? { reason: t.reason } : {}),
    ...(t.linkIdx === undefined ? {} : { articleId: demoId(DEMO[t.linkIdx]) }),
  }))
  fs.writeFileSync(
    path.join(demoHistory, 'topic-pool.json'),
    JSON.stringify(
      {
        _note: '示例项目的示例选题库（文档截图夹具）。',
        topics,
      },
      null,
      2,
    ),
  )
}

/* ── 掩码（按下快门前改 DOM）与门禁（改完断言干净）─────────────────
 * 顺序即优先级：先精确串、后正则。每条都带 sample —— 用于探针自检
 * （探针命中不了 = 这条掩码已经烂掉，直接判负，不依赖页面恰好显示什么）。 */
function buildMasks({ token, username, clientId }) {
  const sandboxReal = (() => {
    try {
      return fs.realpathSync(sandbox)
    } catch {
      return sandbox
    }
  })()
  const homeEsc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const entries = [
    { id: 'demo-drafts', find: demoDrafts, to: '/Users/me/work/blog/drafts', sample: demoDrafts },
    { id: 'demo-project-dir', find: demoRoot, to: '/Users/me/work/blog', sample: demoRoot },
    {
      id: 'sandbox-real',
      find: sandboxReal,
      to: '/Users/me/crosspost/.local',
      sample: sandboxReal,
    },
    { id: 'sandbox-as-created', find: sandbox, to: '/Users/me/crosspost/.local', sample: sandbox },
    { id: 'repo-root', find: REPO, to: '/Users/me/crosspost', sample: REPO },
    {
      id: 'posix-tmp',
      source: '/tmp/[^\\s"\'）)·]+',
      flags: 'g',
      to: '/Users/me/tmp',
      sample: '/tmp/dsh-session-cost.json',
    },
    {
      id: 'macos-tmp',
      source: '/private/var/folders/[^\\s"\'）)·]+',
      flags: 'g',
      to: '/Users/me/crosspost/.local',
      sample: '/private/var/folders/ab/cdef/T/cp-screenshots-1/local',
    },
    {
      id: 'other-home',
      source: '/Users/(?!me\\b)[A-Za-z0-9_.-]+/',
      flags: 'g',
      to: '/Users/me/',
      sample: `/Users/${username}/work/blog/`,
    },
    {
      id: 'username',
      source: `\\b${homeEsc}\\b`,
      flags: 'g',
      to: 'me',
      sample: `${username} 的写作项目`,
    },
    {
      id: 'worker-pid',
      source: '\\bpid\\s+\\d+',
      flags: 'g',
      to: 'pid 12345',
      sample: 'pid 74040',
    },
    { id: 'api-token', find: token, to: 'token-xxxx', sample: token },
    {
      id: 'ext-client-id',
      source: clientId
        ? `\\b${clientId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
        : '\\bcm[a-z0-9]{8,}\\b',
      flags: 'g',
      to: 'client-xxxx',
      sample: clientId || 'cmuh53xr7nsu',
    },
    {
      id: 'sandbox-port',
      source: `\\b(?:${WS_PORT}|${HTTP_PORT})\\b`,
      flags: 'g',
      to: '9540',
      sample: `桥监听 ${HTTP_PORT}`,
    },
  ]
  // 探针：每条掩码都必须在探针里出现一次（顺序执行时不得被前一条吃掉）
  const probe = entries.map((e) => e.sample).join('\n')
  return {
    probe,
    entries: entries.map((e) => ({
      id: e.id,
      find: e.find === undefined ? null : e.find,
      source: e.source || null,
      flags: e.flags || '',
      to: e.to,
    })),
  }
}

/**
 * 生产 config 里"只属于这台机器"的长字符串（引擎默认值里没有的那些）。
 *
 * 为什么要它：这类泄漏（群 ID / webhook / 自定义路径）**没有任何掩码条目能预知** ——
 * 掩码只认识我显式列出的那些值。所以把"生产配置里的私有值"整类变成门禁：
 * 只要它出现在页面上，就说明沙箱读到了生产配置，宁可红、不可漏。
 * 引擎默认值（`defaultConfig()`）不在此列——沙箱本来就该长成一台干净实例的样子。
 */
function productionOnlyConfigValues() {
  const collect = (v, sink) => {
    if (typeof v === 'string' && v.trim()) sink.add(v.trim())
    else if (Array.isArray(v)) v.forEach((x) => collect(x, sink))
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => collect(x, sink))
  }
  const defaults = new Set()
  collect(defaultConfig(), defaults)
  const prod = new Set()
  try {
    collect(JSON.parse(fs.readFileSync(path.join(RUNTIME, 'config.json'), 'utf8')), prod)
  } catch {
    /* 没有生产配置：没有这一类可禁 */
  }
  return [...prod].filter((s) => s.length > 12 && !defaults.has(s))
}

/** 门禁禁止出现的东西：真实值的精确串 + 本机路径形态（正则都在 Node 侧转义好再下发） */
function buildDeny({ token, username, clientId }) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const raw = [
    { id: 'repo-root', find: REPO },
    { id: 'sandbox-root', find: sandbox },
    { id: 'api-token', find: token },
    { id: 'username', source: `\\b${esc(username)}\\b`, flags: 'g' },
    ...(clientId ? [{ id: 'ext-client-id', find: clientId }] : []),
    ...productionOnlyConfigValues().map((v, i) => ({ id: `prod-config-${i + 1}`, find: v })),
    { id: 'home-dir', source: '/Users/(?!me\\b)[A-Za-z0-9_.-]+/', flags: 'g' },
    { id: 'macos-tmp', source: '/private/var/folders/', flags: 'g' },
    { id: 'posix-tmp', source: '/tmp/', flags: 'g' },
    { id: 'ext-client-shape', source: '\\bcm[a-z0-9]{8,}', flags: 'g' },
    { id: 'sandbox-port', source: `\\b(?:${WS_PORT}|${HTTP_PORT})\\b`, flags: 'g' },
  ]
  return raw.map((d) => ({
    id: d.id,
    find: d.find === undefined ? null : d.find,
    source: d.source || null,
    flags: d.flags || '',
  }))
}

/**
 * 单个 frame 内一次跑完：探针自检 → 全 DOM 掩码 → 返回命中计数。
 * 用**字符串表达式**下发（CDP 求值不受页面 CSP 影响），保证掩码与自检是同一份实现。
 */
const MASK_EXPR = `(payload) => {
  const entries = payload.entries
  const count = {}
  for (const e of entries) count[e.id] = 0
  const sub = (s, bucket) => {
    let out = String(s)
    for (const e of entries) {
      const before = out
      if (e.find !== null) {
        if (out.includes(e.find)) out = out.split(e.find).join(e.to)
      } else if (e.source) {
        out = out.replace(new RegExp(e.source, e.flags), e.to)
      }
      if (out !== before) bucket[e.id] = (bucket[e.id] || 0) + 1
    }
    return out
  }
  // ① 探针自检：每条掩码都必须能在探针串上命中
  const probeBucket = {}
  sub(payload.probe, probeBucket)
  const missed = entries.filter((e) => !probeBucket[e.id]).map((e) => e.id)
  // ② 全 DOM 替换（文本节点 / 表单值 / 属性 / option）
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  for (const n of nodes) {
    const p = n.parentElement
    if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) continue
    n.nodeValue = sub(n.nodeValue, count)
  }
  for (const el of document.querySelectorAll('input, textarea')) {
    if (el.value) el.value = sub(el.value, count)
    if (el.placeholder) el.placeholder = sub(el.placeholder, count)
  }
  for (const el of document.querySelectorAll('[title]')) {
    el.setAttribute('title', sub(el.getAttribute('title'), count))
  }
  for (const el of document.querySelectorAll('[aria-label]')) {
    el.setAttribute('aria-label', sub(el.getAttribute('aria-label'), count))
  }
  for (const opt of document.querySelectorAll('option')) {
    opt.textContent = sub(opt.textContent, count)
  }
  return { hits: count, missed }
}`

/** 单个 frame 的门禁：遍历整份 DOM（含隐藏文本），命中任一禁止项即返回明细 */
const DENY_EXPR = `(payload) => {
  const parts = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const n = walker.currentNode
    const p = n.parentElement
    if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) continue
    parts.push(n.nodeValue)
  }
  for (const el of document.querySelectorAll('input, textarea')) {
    parts.push(el.value || '', el.placeholder || '')
  }
  for (const el of document.querySelectorAll('[title]')) parts.push(el.getAttribute('title') || '')
  for (const el of document.querySelectorAll('[aria-label]')) {
    parts.push(el.getAttribute('aria-label') || '')
  }
  for (const opt of document.querySelectorAll('option')) parts.push(opt.textContent || '')
  const blob = parts.join('\\n')
  const hits = []
  for (const d of payload.deny) {
    if (d.find !== null) {
      const at = blob.indexOf(d.find)
      if (at >= 0) hits.push({ id: d.id, sample: blob.slice(Math.max(0, at - 40), at + 60) })
    } else if (d.source) {
      const m = blob.match(new RegExp(d.source, d.flags))
      if (m) hits.push({ id: d.id, sample: blob.slice(Math.max(0, m.index - 40), m.index + 60) })
    }
  }
  return hits
}`

/* ── 八个模块（顺序 = Console 导航顺序）─────────────────────────── */
/** 视口：1440 宽是文章表格 11 列不横向溢出的最小宽度；DPR 2 供高清屏阅读 */
const VIEWPORT = { width: 1440, height: 900 }
const SHOTS = [
  { id: 'onboarding', file: 'console-onboarding.png', view: 'onboarding', label: '接入与自检' },
  {
    id: 'articles',
    file: 'console-articles.png',
    view: 'articles',
    label: '文章',
    needProject: true,
  },
  { id: 'editor', file: 'console-editor.png', view: 'editor', label: '编写', needProject: true },
  { id: 'topics', file: 'console-topics.png', view: 'topics', label: '选题库', needProject: true },
  {
    id: 'retained',
    file: 'console-retained.png',
    view: 'retained',
    label: '留存库',
    needProject: true,
  },
  {
    id: 'archive',
    file: 'console-archive.png',
    view: 'archive',
    label: '归档库',
    needProject: true,
  },
  { id: 'reports', file: 'console-reports.png', view: 'reports', label: '报表', needProject: true },
  {
    id: 'settings',
    file: 'console-settings.png',
    view: 'settings',
    label: '设置',
    needProject: true,
  },
]

/**
 * 切视图：编写走 Console 自己的深链 `#/editor/<id>`（其余点导航 tab）。
 * 深链是**曾经出过缺陷的那条路**（一次导航建出两个 CodeMirror）——故意走它，
 * 并由 waitForShot 断言"只有一个实例且源码窗格有字"，把缺陷挡在门外。
 */
async function gotoView(page, view, editorDraftId) {
  if (view === 'editor') {
    await page.evaluate(
      (h) => {
        location.hash = h
      },
      `#/editor/${encodeURIComponent(editorDraftId)}`,
    )
  } else {
    await page.click(`.tab[data-view="${view}"]`)
  }
  await page.waitForFunction(
    (v) => {
      const el = document.querySelector('#view-' + v)
      return !!el && el.classList.contains('active')
    },
    view,
    { timeout: 15000 },
  )
}

/**
 * 每个模块的"可判定等待"：等到页面上确实有东西再拍，不靠 sleep。
 * 返回的 detail 会进日志（说明这一张是靠什么判据确认渲染完成的）。
 */
async function waitForShot(page, shot, ctx) {
  const waitRows = (sel, n) =>
    page.waitForFunction(
      (a) => document.querySelectorAll(a.sel).length === a.n,
      { sel, n },
      { timeout: 30000 },
    )
  switch (shot.id) {
    case 'onboarding': {
      await page.waitForFunction(
        () => {
          const n = document.querySelector('#onboarding-checked')
          return !!n && (n.textContent || '').trim().length > 0
        },
        null,
        { timeout: 30000 },
      )
      await page.waitForFunction(
        (n) => document.querySelectorAll('#onboarding-matrix .ob-chip').length === n,
        ctx.expectChips,
        { timeout: 30000 },
      )
      const lanes = await page
        .waitForFunction(
          () => document.querySelectorAll('#onboarding-workers .ob-doctor-row').length >= 4,
          null,
          { timeout: 20000 },
        )
        .then(() => true)
        .catch(() => false)
      return lanes
        ? `芯片 ${ctx.expectChips} · 车道 4 条`
        : `芯片 ${ctx.expectChips} · 车道不足 4 条`
    }
    case 'articles':
      await waitRows('#article-tbody tr', DEMO.length)
      return `${DEMO.length} 行文章`
    case 'editor': {
      // 断言"深链进稿"这条路是好的：**只有一个** CodeMirror，且源码窗格里真的有字。
      // 没有这两条，脚本会心安理得地拍出一张"空编辑器"的图（曾经就是这样）。
      await page.waitForFunction(
        (a) => {
          const c = document.querySelector('.cm-content')
          return (
            document.querySelectorAll('.cm-editor').length === 1 &&
            !!c &&
            c.innerText.includes(a.marker) &&
            (document.querySelector('#ed-title') || {}).value === a.title
          )
        },
        { marker: ctx.editorMarker, title: DEMO[0].title },
        { timeout: 25000 },
      )
      // 预览由 loadEditor → refreshEditorPreview 渲染，等它出结果再拍
      await page.waitForFunction(
        () => {
          const f = document.querySelector('#ed-preview-frame')
          const st = document.querySelector('#ed-preview-state')
          return (
            !!f &&
            (f.getAttribute('srcdoc') || '').length > 200 &&
            !!st &&
            (st.textContent || '').includes('已渲染')
          )
        },
        null,
        { timeout: 30000 },
      )
      return `深链载稿（单实例 · 源码窗格有字）· 预览已渲染`
    }
    case 'topics': {
      await waitRows('#topics-tbody tr', DEMO_TOPICS.length)
      await page.waitForFunction(
        (n) => {
          const t = (document.querySelector('#topics-summary') || {}).textContent || ''
          return t.includes(`共 ${n} 条`)
        },
        DEMO_TOPICS.length,
        { timeout: 15000 },
      )
      return `${DEMO_TOPICS.length} 条选题`
    }
    case 'retained':
      await waitRows('#retained-tbody tr', DEMO_RETAINED.length)
      return `${DEMO_RETAINED.length} 行留存`
    case 'archive':
      await waitRows('#archive-tbody tr', DEMO_ARCHIVED.length)
      return `${DEMO_ARCHIVED.length} 行归档`
    case 'reports':
      await page.waitForFunction(
        () =>
          document.querySelectorAll('#rp-cost .rp-row').length > 0 &&
          document.querySelectorAll('#rp-cost-daily .rp-row').length > 0,
        null,
        { timeout: 30000 },
      )
      return '费用卡有数据'
    case 'settings':
      await page.waitForFunction(
        () => {
          const n = document.querySelector('#style-stat-num')
          return (
            document.querySelectorAll('#card-styles .style-card').length > 0 &&
            !!n &&
            (n.textContent || '').trim() !== '—'
          )
        },
        null,
        { timeout: 30000 },
      )
      return '样式库已渲染'
    default:
      return ''
  }
}

/**
 * 掩码 + 门禁，**遍历所有 frame**（编写模块的预览是 srcdoc iframe，只扫主框架会漏检）。
 * 任一 frame 注入失败也判负 —— 宁可红，不可漏。
 */
async function maskAndGate(page, masks, deny) {
  const hits = {}
  const frames = page.frames()
  for (const frame of frames) {
    let res
    try {
      res = await frame.evaluate(
        `(${MASK_EXPR})(${JSON.stringify({ entries: masks.entries, probe: masks.probe })})`,
      )
    } catch (e) {
      return { error: `frame 无法注入（${frame.url().slice(0, 80)}）：${e.message}` }
    }
    if (res.missed.length) return { error: `掩码自检失败：${res.missed.join(', ')}` }
    for (const [k, v] of Object.entries(res.hits)) if (v) hits[k] = (hits[k] || 0) + v
  }
  for (const frame of frames) {
    let denied
    try {
      denied = await frame.evaluate(`(${DENY_EXPR})(${JSON.stringify({ deny })})`)
    } catch (e) {
      return { error: `frame 门禁失败（${frame.url().slice(0, 80)}）：${e.message}` }
    }
    if (denied.length) {
      return {
        error: denied.map((d) => `${d.id} @ ${frame.url().slice(0, 40)}：${d.sample}`).join(' | '),
      }
    }
  }
  return { hits, frames: frames.length }
}

/** 报表页的两张费用卡是示例数据：拦掉 /proxy/costs，喂固定载荷 */
function demoCostsPayload(token) {
  const now = new Date().toISOString()
  const rows = [
    { day: 0, slot: 'morning', cost: 1.8241, total: 412000, hidden: 18000 },
    { day: 0, slot: 'noon', cost: 0.9132, total: 205000, hidden: 9000 },
    { day: 1, slot: 'noon', cost: 1.2077, total: 288000, hidden: 0 },
    { day: 2, slot: 'morning', cost: 0.8654, total: 196000, hidden: 0 },
    { day: 6, slot: 'tips', cost: 0.641, total: 141000, hidden: 0 },
  ]
  return {
    costs: rows.map((r, i) => ({
      id: `demo-cost-${i}`,
      matched: true,
      cost: r.cost,
      date: beijingDay(-r.day),
      slot: r.slot,
      at: now,
      tokens: { total: r.total, hidden: r.hidden },
    })),
    meta: {
      sessions: rows.length,
      byGen: { 3: rows.length },
      zeroUsageCount: 0,
      token,
      pricing: {
        model: PRICING.model,
        version: PRICING.version,
        peakHours: PRICING.peakHours,
        weekendIdleFrom: PRICING.weekendIdleFrom,
      },
    },
  }
}

/* ── 扩展选项页（第九张图）─────────────────────────────────────────
 * 那一页的数据源是扩展自己的 fetch（`chrome.storage` 里配的 host:port，默认 127.0.0.1:9539），
 * 没法像 Console 那样指向沙箱桥；真让它去取数就等于把生产桥的登录态拍进 README。
 * 所以与报表页的费用卡同一手法：`page.route` 喂固定载荷（**示例数据**）。
 * 但名单与口径不编：平台、检查范围、数量全部从 `buildPlatformMatrix()` 派生。
 */
function extDemoPayload(cacheMs) {
  const m = buildPlatformMatrix()
  const inScope = new Set(m.defaultSelected)
  const scopeIds = m.platforms.filter((p) => inScope.has(p.id)).map((p) => p.id)
  return {
    /** `/proxy/platform-matrix`：全部 27 个的名字（未检查的平台只有这里有名字） */
    matrix: { platforms: m.platforms.map(({ id, name }) => ({ id, name })) },
    /** `/proxy/platforms`：范围内 12 个都算已登录，范围外 15 个是"未检查" */
    platforms: {
      platforms: scopeIds.map((id) => ({
        id,
        name: m.platforms.find((p) => p.id === id).name,
        isAuthenticated: true,
      })),
      checkedAt: Date.now() - 2 * 60 * 1000, // 「上次检查 2 分钟前」
      refreshing: false,
      init: false,
      lastMode: 'scope',
      error: null,
      scope: {
        ids: scopeIds,
        mode: 'scoped',
        excluded: m.platforms.filter((p) => !inScope.has(p.id)).map((p) => p.id),
        all: m.counts.all,
        count: scopeIds.length,
      },
    },
    status: { connected: true, platforms: { cacheMs } },
  }
}

/**
 * 拍扩展选项页。
 *
 * 浏览器用 playwright **自带的 Chromium**，不是系统 Chrome ——
 * `extension-options-smoke.mjs` 实测：系统 Chrome 153 起忽略 `--load-extension`
 * （打开 chrome-extension:// 直接 ERR_BLOCKED_BY_CLIENT），而 MV3 扩展只在新版无头
 * （`--headless=new`）或 headed 下加载（playwright 的 `headless: true` 走 headless shell，
 * 不带扩展支持）。所以这里 `headless: false` + `--headless=new` 起一个临时 profile。
 *
 * 与 Console 那八张同一套纪律：喂示例载荷 → 等页面渲染成"该有的样子" → 掩码 + 门禁 →
 * 才截图。报头/底栏由 sticky 降级为静态（整页取景时不叠影、不悬在半途）。
 */
async function captureExtensionShot({ outDir, masks, deny, cacheMs }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-ext-shot-'))
  const demo = extDemoPayload(cacheMs)
  const want = demo.platforms.platforms.length
  const unchecked = demo.platforms.scope.excluded.length
  let ctx = null
  try {
    try {
      ctx = await chromium.launchPersistentContext(profile, {
        headless: false,
        args: [
          '--headless=new',
          `--disable-extensions-except=${EXT_DIR}`,
          `--load-extension=${EXT_DIR}`,
        ],
        viewport: EXT_VIEWPORT,
        deviceScaleFactor: 2,
        colorScheme: 'light',
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
      })
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (/Executable doesn't exist|install/i.test(msg)) {
        throw new Error('playwright 自带的 Chromium 未安装：npx playwright install chromium')
      }
      throw e
    }

    // 扩展 ID 从它自己的 service worker 来（未打包扩展的 ID 由**目录路径**决定，
    // 所以这里绝不能写死某个 ID：换台机器 clone 到别的路径就是另一个 ID）
    let sw = ctx.serviceWorkers()[0]
    for (let i = 0; i < 60 && !sw; i++) {
      await sleep(250)
      sw = ctx.serviceWorkers()[0]
    }
    if (!sw) throw new Error('扩展没加载起来（拿不到 service worker）')
    const extId = new URL(sw.url()).host

    const page = await ctx.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e.message)))
    await page.route('**/proxy/bootstrap*', (r) => r.fulfill({ json: { token: 'token-xxxx' } }))
    await page.route('**/proxy/status*', (r) => r.fulfill({ json: demo.status }))
    await page.route('**/proxy/platform-matrix*', (r) => r.fulfill({ json: demo.matrix }))
    await page.route('**/proxy/platforms*', (r) => r.fulfill({ json: demo.platforms }))

    await page.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'domcontentloaded' })
    // 判据：三格读数、可见栏的行数、以及 tab 上那句「未登录 0 · 未检查 15」全都到位才拍。
    // 只等"有行"会拍出一张还停在「正在检查...」的图；那句未检查数正是这一页要讲的事，
    // 它没渲染出来就说明页面还没到该有的样子。
    await page.waitForFunction(
      (a) => {
        const txt = (id) => ((document.getElementById(id) || {}).textContent || '').trim()
        const bar = document.getElementById('covBar')
        return (
          txt('sumOk') === String(a.want) &&
          txt('sumScope').startsWith(String(a.want) + '/') &&
          txt('tabNo').includes('未检查 ' + a.unchecked) &&
          !!bar &&
          !bar.hidden &&
          document.querySelectorAll('#paneOk .pane-body .item').length === a.want
        )
      },
      { want, unchecked },
      { timeout: 30000 },
    )
    await sleep(400) // 首屏错峰上浮（.item.reveal）落定
    await page.addStyleTag({
      content: '.header{position:static !important}.footer{position:static !important}',
    })

    const gate = await maskAndGate(page, masks, deny)
    if (gate.error) throw new Error(`扩展选项页上仍有真实值或掩码失效：${gate.error}`)

    const target = path.join(outDir, EXT_SHOT)
    await page.screenshot({ path: target, fullPage: true, animations: 'disabled' })

    const buf = fs.readFileSync(target)
    const size = pngSize(buf)
    if (buf.length > MAX_PNG_BYTES || size.height > MAX_PNG_HEIGHT) {
      throw new Error(
        `扩展选项页超上限：${(buf.length / 1048576).toFixed(2)}MB / ${size.width}×${size.height}px`,
      )
    }
    return {
      file: EXT_SHOT,
      target,
      bytes: buf.length,
      size,
      frames: gate.frames,
      pageErrors,
      hits: Object.entries(gate.hits)
        .filter(([, n]) => n > 0)
        .map(([id, n]) => `${id}×${n}`)
        .join(' '),
      detail: `已登录 ${want} · 未检查 ${unchecked} · 范围 ${want}/${demo.platforms.scope.all}`,
    }
  } finally {
    if (ctx) await ctx.close().catch(() => {})
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

/* ── 主流程 ─────────────────────────────────────────────────────── */
let bridge = null
let browser = null
let token = ''
let clientId = ''
const editorDraftId = demoId(DEMO[0])
/** 编写模块截图要断言源码窗格里真的有字（否则会拍出一张"空编辑器"的图） */
const EDITOR_MARKER = '为什么值得单独做一层'

try {
  console.log(`\n══════ README 截图生成（Console 八个模块 + 扩展选项页 · 整页）══════`)
  console.log(`沙箱：${sandbox}`)
  console.log(`隔离桥：WS ${WS_PORT} / HTTP ${HTTP_PORT}\n`)

  const prodBefore = prodSnapshot()

  /* 1. setup（在沙箱里生成 config / paths / 数据目录） */
  const setup = await run([path.join(RUNTIME, 'src', 'cli.mjs'), 'setup'], env)
  ok('沙箱 setup', setup.code === 0, setup.code === 0 ? '' : setup.err.slice(-200))

  /* 2. 沙箱自备 config.json / paths.json —— 这两份必须由 `setup` 写到沙箱里。
   *    `setup` 曾经把路径硬编码成 `<runtimeDir>/config.json`、`<runtimeDir>/paths.json`：
   *    沙箱（以及容器 / 多实例）下 CROSSPOST_* 被无视、两份都不生成，引擎随后读到的是
   *    **空配置** —— 设置页显示成"什么都配了、其实都是兜底值"，而人看不出哪里不对。
   *    这里断言 setup 真的认这两个变量，顺带守住这条修复。 */
  const cfgExists = fs.existsSync(cfgFile)
  const sandboxCfg = cfgExists ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {}
  ok(
    'setup 认 CROSSPOST_CONFIG（沙箱 config.json 由它生成）',
    !!(
      cfgExists &&
      sandboxCfg.notify &&
      sandboxCfg.notify.enabled === false &&
      sandboxCfg.notify.channel === 'webhook' &&
      sandboxCfg.scoring &&
      sandboxCfg.scoring.threshold === 68
    ),
    cfgExists
      ? `notify=${sandboxCfg.notify.channel}/${sandboxCfg.notify.enabled} · threshold=${sandboxCfg.scoring.threshold}`
      : '沙箱 config.json 未生成',
  )

  let pathsJson = {}
  const pathsExisted = fs.existsSync(pathsFile)
  try {
    pathsJson = JSON.parse(fs.readFileSync(pathsFile, 'utf8'))
  } catch {
    /* 下面判负 */
  }
  ok(
    'setup 认 CROSSPOST_PATHS（沙箱 paths.json 由它生成）',
    pathsExisted && pathsJson.localRoot === localRoot,
    pathsExisted ? 'localRoot=沙箱' : '沙箱 paths.json 未生成',
  )
  // 补 tokenFile：`defaultPaths()` 不管 token（桥的私产），不补桥就会去读并复用生产的
  // bridge/token.local。
  fs.mkdirSync(path.dirname(pathsFile), { recursive: true })
  pathsJson.tokenFile = tokenFile
  fs.writeFileSync(pathsFile, JSON.stringify(pathsJson, null, 2))
  ok('沙箱 paths.json 自备 token 文件', pathsJson.tokenFile === tokenFile)

  /* 3. 夹具 */
  writeFixture()
  ok(
    '示例项目夹具就位',
    `文章 ${DEMO.length} · 留存 ${DEMO_RETAINED.length} · 归档 ${DEMO_ARCHIVED.length} · 选题 ${DEMO_TOPICS.length}`,
  )

  /* 4. 起隔离桥 */
  bridge = spawn(NODE, [path.join(REPO, 'bridge', 'run-bridge.mjs')], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let bridgeLog = ''
  bridge.stdout.on('data', (d) => (bridgeLog += d))
  bridge.stderr.on('data', (d) => (bridgeLog += d))
  const ready = await new Promise((resolve) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (/通道就绪/.test(bridgeLog)) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - t0 > 20000) {
        clearInterval(timer)
        resolve(false)
      }
    }, 200)
  })
  ok('隔离桥就绪', ready, ready ? '' : bridgeLog.slice(-300))
  if (!ready) throw new Error('隔离桥未就绪')

  /* 5. token 必须来自沙箱自己 */
  const boot = await fetch(`${BASE}/proxy/bootstrap`)
  token = boot.ok ? (await boot.json()).token : ''
  const ownToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : ''
  let prodToken = ''
  try {
    prodToken = fs.readFileSync(path.join(REPO, 'bridge', 'token.local'), 'utf8').trim()
  } catch {
    /* 生产没有 token 文件：下面按"不相等"通过 */
  }
  ok(
    '桥用的是沙箱自有 token（未复用生产 token）',
    !!token && token === ownToken && token !== prodToken,
    `len=${token.length}`,
  )

  const api = async (p) => {
    const r = await fetch(`${BASE}${p}`, { headers: { 'X-CrossPost-Token': token } })
    return r.ok ? r.json() : null
  }
  const matrix = await api('/proxy/platform-matrix')
  const expectChips = (matrix && matrix.counts && matrix.counts.all) || 0
  ok('平台矩阵口径可用', expectChips > 0, `counts.all=${expectChips}`)

  const status = await api('/proxy/status')
  clientId = (status && status.ext && status.ext.client && status.ext.client.clientId) || ''
  /** 扩展选项页的示例载荷要用桥真实的检查缓存周期（决定 tab 副标签说"本轮已核验"还是"旧账"） */
  const cacheMs =
    (status && status.platforms && status.platforms.cacheMs) || defaultConfig().platformsCacheMs

  /* 6. 浏览器 */
  const masks = buildMasks({ token, username: os.userInfo().username, clientId })
  const deny = buildDeny({ token, username: os.userInfo().username, clientId })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: 'light',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  await context.addInitScript(() => {
    try {
      localStorage.setItem('console-theme', 'light')
    } catch {
      /* 无 localStorage 就跟随 colorScheme，已是 light */
    }
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message)))
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })

  await page.route('**/proxy/costs*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(demoCostsPayload(token)),
    }),
  )

  const outTmp = path.join(sandbox, 'out')
  fs.mkdirSync(outTmp, { recursive: true })
  const shotLog = []

  /* 7. 逐模块：切视图 → 等判定 → 掩码+门禁 → 整页截图 */
  for (const shot of SHOTS) {
    if (shot.needProject && shot.id === 'articles') {
      await page.selectOption('#project-select', 'demo-project')
      await page.waitForFunction(
        () => document.querySelector('#project-select').value === 'demo-project',
        null,
        { timeout: 15000 },
      )
    }
    await gotoView(page, shot.view, editorDraftId)
    const waitDetail = await waitForShot(page, shot, {
      expectChips,
      editorDraftId,
      editorMarker: EDITOR_MARKER,
    })
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    await page.evaluate(() => window.scrollTo(0, 0))
    // 顶栏是 sticky：整页取景时把它降级为普通流，位置与不滚动的首屏一致，且不会有叠影
    await page.addStyleTag({ content: '.topbar { position: static !important; }' })

    const gate = await maskAndGate(page, masks, deny)
    if (gate.error) {
      bad(`[${shot.label}] 掩码/门禁`, gate.error)
      throw new Error(`页面上仍有真实值或掩码失效，未写任何 PNG：${shot.label}`)
    }

    // 整页取景：文档顶部（顶栏 + 导航）→ 当前模块内容末尾。
    // 两条路都必要：`clip` 一旦超过视口高度就会被**静默裁到视口高度**（高模块会被截断），
    // 所以高模块必须走元素截图；而元素截图在内容比视口矮时会补齐到视口高度（留下一片死白），
    // 所以矮模块走 clip。两条路的画面完全一致，只是取高方式不同。
    const contentH = await page.evaluate((v) => {
      const el = document.querySelector('#view-' + v)
      const r = el.getBoundingClientRect()
      const pad = parseFloat(getComputedStyle(el).paddingBottom) || 0
      return Math.max(1, Math.ceil(r.bottom + window.scrollY - pad))
    }, shot.view)
    const target = path.join(outTmp, shot.file)
    const tall = contentH > VIEWPORT.height
    if (tall) {
      await (await page.$('html')).screenshot({ path: target, animations: 'disabled' })
    } else {
      await page.screenshot({
        path: target,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: contentH },
        animations: 'disabled',
      })
    }

    const buf = fs.readFileSync(target)
    const size = pngSize(buf)
    const hits = Object.entries(gate.hits)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${id}×${n}`)
      .join(' ')
    shotLog.push({ ...shot, target, bytes: buf.length, height: contentH, size, hits })
    if (buf.length > MAX_PNG_BYTES || size.height > MAX_PNG_HEIGHT) {
      bad(
        `[${shot.label}] 超上限`,
        `${(buf.length / 1048576).toFixed(2)}MB / ${size.width}×${size.height}px` +
          `（上限 ${MAX_PNG_BYTES / 1048576}MB / 高 ${MAX_PNG_HEIGHT}px）`,
      )
      throw new Error(`[${shot.label}] 图片超上限`)
    }
    ok(
      `[${shot.label}] 已拍`,
      `${shot.file} · ${(buf.length / 1024).toFixed(0)}KB · ${size.width}×${size.height}px · ` +
        `${tall ? '整页' : '裁到内容'} · ${waitDetail} · ${gate.frames} frame · 掩码 ${hits || '无'}`,
    )
  }

  if (pageErrors.length) warn('页面 JS 报错', pageErrors.slice(0, 3).join(' | '))

  /* 8. 第九张：扩展选项页（另起一个装了未打包扩展的临时 profile；见 captureExtensionShot） */
  let extShot = null
  try {
    extShot = await captureExtensionShot({ outDir: outTmp, masks, deny, cacheMs })
  } catch (e) {
    bad('[扩展选项页] 掩码/门禁/截图', String((e && e.message) || e))
    throw new Error(`扩展选项页未通过，未写任何 PNG：${String((e && e.message) || e)}`)
  }
  if (extShot.pageErrors.length) {
    warn('扩展选项页 JS 报错', extShot.pageErrors.slice(0, 3).join(' | '))
  }
  ok(
    '[扩展选项页] 已拍',
    `${extShot.file} · ${(extShot.bytes / 1024).toFixed(0)}KB · ` +
      `${extShot.size.width}×${extShot.size.height}px · 整页 · ${extShot.detail} · ` +
      `${extShot.frames} frame · 掩码 ${extShot.hits || '无'}`,
  )

  /* 9. 原子发布：九张全过才进仓库 */
  const allShots = [...shotLog, extShot]
  fs.mkdirSync(OUT_DIR, { recursive: true })
  for (const s of allShots) {
    fs.copyFileSync(s.target, path.join(OUT_DIR, s.file))
  }
  ok('已写入 docs/images/', allShots.map((s) => s.file).join(' '))
  const keep = new Set(allShots.map((s) => s.file))
  const stale = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.png') && !keep.has(f))
  if (stale.length) {
    warn(
      'docs/images/ 里有本脚本不再产出的图',
      `${stale.join(' ')} —— 若 README 也不再引用，请删掉（docs-images 测试会判孤儿）`,
    )
  }

  /* 10. 生产零改动 */
  const prodAfter = prodSnapshot()
  ok('生产本机文件未被改写', prodAfter === prodBefore, prodAfter === prodBefore ? '' : prodAfter)

  const totalKb = allShots.reduce((a, s) => a + s.bytes, 0) / 1024
  console.log(`\n合计 ${allShots.length} 张 / ${totalKb.toFixed(0)}KB`)
} catch (err) {
  bad('生成失败', String(err && err.message ? err.message : err))
} finally {
  if (browser) await browser.close().catch(() => {})
  if (bridge) {
    bridge.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
  }
  fs.rmSync(sandbox, { recursive: true, force: true })
}

const failed = notes.filter((n) => !n.ok)
console.log(`\n${notes.length - failed.length}/${notes.length} 通过`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  ✖ ${f.name} — ${f.detail}`)
}
process.exit(failed.length ? 1 : 0)
