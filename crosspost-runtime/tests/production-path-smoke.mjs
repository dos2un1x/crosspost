/**
 * 生产链路只读冒烟（v2.12）
 *
 * 目的：在**不修改任何草稿**的前提下，验证定时链路实际依赖的代码路径完好。
 *
 * 为什么需要它：定时链路（08:10 morning / 08:30 hotspot）是"新代码有没有搞坏生产"
 * 的唯一证据，但它每天只跑一次，且我**不能**主动触发它——那会写 drafts/。
 * 本脚本把该链路里**可只读验证**的部分固化下来，让"明天能不能跑"在今晚就能有答案。
 *
 * 只读性保证（本脚本的核心约束）：
 *   · 只调用读方法：listStyles / readDraft / renderPreview
 *   · publishArticle 仅以 dryRun + platforms:[] + wechat:false + notify:false 调用，
 *     且**只挑 frontmatter risk 为空**的草稿（risk 非空时留存逻辑会移动文件，
 *     而那条路径在 dryRun 下也会执行——见下文注释）
 *   · 前后比对草稿数量与 sha256，任何变化即判失败
 *
 * 用法：
 *   node crosspost-runtime/tests/production-path-smoke.mjs
 *   CROSSPOST_SMOKE_ALLOW_PUBLISH=0 node ...   # 只跑读方法，跳过 dryRun 渲染
 *
 * 退出码：0 全通过；1 有失败（或检测到草稿被改动）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { getArticlesDir } from '../src/articles.mjs'
import { listProjects, resolveProjectStoreDir } from '../src/projects.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
const REPO = path.resolve(RUNTIME, '..')
const NODE = process.execPath

/**
 * 草稿目录：env 覆盖 > **项目注册表里第一个有效项目**的 dataDir。
 *
 * v2.109 之前默认写死本机绝对路径（`/Users/me/my-writing-project/drafts`）：
 * 别人 clone 下来，"生产链路只读冒烟"要么指着一个不存在的目录，要么报出与使用者无关的失败
 * —— 而它恰恰是"今天能不能发布"的那条证据。
 * 注册表本来就是"项目数据在哪"的权威来源（P1），默认值取自它即可与机器解耦。
 * 注意：本冒烟刻意**不用**项目上下文（见下文 `CROSSPOST_DRAFTS_DIR` 的注释），
 * 这里只是借用注册表定位目录。
 */
function defaultDraftsDir() {
  try {
    // `listProjects()` 返回**数组**（只有桥的 /proxy/projects 才包成 {projects:…}）；
    // 两种形状都容错，免得形状一变又把默认值悄悄变成空。
    const r = listProjects()
    const list = Array.isArray(r) ? r : (r && r.projects) || []
    const p = list.find((x) => x && x.valid && x.provider && x.provider.dataDir)
    return p ? p.provider.dataDir : ''
  } catch {
    return ''
  }
}
const DRAFTS_DIR = process.env.CROSSPOST_SMOKE_DRAFTS || defaultDraftsDir()

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`)
}
const skip = (name, why) => {
  results.push({ name, ok: true, skipped: true, detail: why })
  console.log(`－ ${name}（跳过：${why}）`)
}

/** 对目录下所有 .md 取 sha256 指纹（用于前后比对） */
function fingerprint(dir) {
  const out = new Map()
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith('.md'))
        out.set(p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))
    }
  }
  walk(dir)
  return out
}

/**
 * 引擎簿记（文章记录 + dryRun 的 HTML 归档）走**临时目录**（v2.41）。
 *
 * 为什么必须隔离：本冒烟会真的跑一次 `publishArticle --dryRun`，而 dryRun
 * **不写草稿但会写记录**——它给真实记录追加一条 `history` 条目
 * （"dryRun 渲染测试,未发布"）并把 `<id>.dry.html` 落到文章库目录。
 * 实测：使用者的
 * `crosspost-runtime/articles/2026-09-12-tips-ai-relay-station-check.json`
 * 被本冒烟追加了 **38 条 dryRun 历史**（它的真实发布历史只有 3 条），
 * Console 详情页的「发布历史时间线」里全是测试噪音。
 *
 * `findDraftFile()` 在没有记录时会回退到扫描草稿目录，所以**空的临时文章库
 * 完全够用**：草稿照旧从真实 drafts 目录读，链路一步不少。
 *
 * 2026-09-22（v2.106）：**只隔离 `CROSSPOST_ARTICLES_DIR` 已经不够了**。
 * 那次修复让"簿记的域"跟着**草稿的归属项目**走：本冒烟挑的是接入项目的真实草稿，
 * 于是 dryRun 现在在项目上下文里执行，而**项目簿记目录优先于**
 * `CROSSPOST_ARTICLES_DIR`（`getArticlesDir()` 的口径：项目目录压过环境变量）——
 * 它于是写进了真实项目簿记，本冒烟的"真实内容域未被写入"当场变红（这正是它该做的）。
 * 正确隔离是把**引擎 localRoot** 指到临时目录（项目簿记 =
 * `<localRoot>/project-state/<id>/articles`），同时保留 `CROSSPOST_ARTICLES_DIR`
 * 兜住**默认域**那条分支。
 */
const TMP_LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-prod-smoke-local-'))
const TMP_ARTICLES = path.join(TMP_LOCAL, 'default-articles')

/** 真实文章库（记录 + HTML 归档）的指纹：文件 → mtime+size */
function articlesFingerprint(dir) {
  const out = new Map()
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isFile()) continue
    try {
      const st = fs.statSync(path.join(dir, e.name))
      out.set(e.name, `${st.mtimeMs}:${st.size}`)
    } catch {
      /* 忽略 */
    }
  }
  return out
}
/**
 * 本机所有**真实**内容域的记录目录（默认域 + 每个合法项目域）——dryRun 绝不许碰它们。
 *
 * v2.74 前这里写死 `crosspost-runtime/articles`：那是当时的默认域，也正是生产库。
 * v2.74 把默认域拆成空域后，写死那个路径会让这条断言**变成空转**（目录已不存在 →
 * 前后指纹都是空 Map → 永远"通过"）。改为经引擎解析，跟着部署走。
 */
function realArticlesDirs() {
  const out = [getArticlesDir()]
  try {
    for (const p of listProjects()) {
      if (!p || !p.valid || !p.id) continue
      const r = resolveProjectStoreDir(p.id)
      if (r && r.dir) out.push(r.dir)
    }
  } catch {
    /* 注册表读不到时，至少还比对默认域 */
  }
  return [...new Set(out.map((d) => path.resolve(d)))]
}
const REAL_ARTICLES_DIRS = realArticlesDirs()
const REAL_ARTICLES_BEFORE = new Map(REAL_ARTICLES_DIRS.map((d) => [d, articlesFingerprint(d)]))

const runCli = (args) =>
  new Promise((resolve) => {
    const child = spawn(NODE, [path.join(RUNTIME, 'src', 'cli.mjs'), ...args], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      // CROSSPOST_DRAFTS_DIR 必须一起钉住（v2.74）：本冒烟刻意**不用**项目上下文，
      // 好让 dryRun 的簿记只落进临时文章库；而 v2.74 之后"默认草稿目录"是引擎自有的
      // 空域（.local/drafts），不再等于生产项目的草稿目录。不钉它，readDraft 会去查那个
      // 空目录，返回 {error}，整条只读链路就断在第一步。
      env: {
        ...process.env,
        // v2.106：项目簿记（= 草稿归属项目的域）跟着 localRoot 走，必须一起隔离
        CROSSPOST_LOCAL_ROOT: TMP_LOCAL,
        CROSSPOST_LOGS_DIR: path.join(TMP_LOCAL, 'logs'),
        CROSSPOST_HISTORY_DIR: path.join(TMP_LOCAL, 'history'),
        CROSSPOST_ARTICLES_DIR: TMP_ARTICLES,
        CROSSPOST_DRAFTS_DIR: DRAFTS_DIR,
      },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => {
      let json = null
      try {
        json = JSON.parse(out.trim().split('\n').pop())
      } catch {
        /* 交由调用方判断 */
      }
      resolve({ code, json, out, err })
    })
  })

console.log(
  `\n生产链路只读冒烟  Node ${process.versions.node}\n草稿目录：${DRAFTS_DIR || '（未定）'}\n`,
)

// 没有草稿目录就没有可验证的生产链路：**显式判负**而不是空跑一遍看着"全绿"。
// （假通过比不检查更糟：这条冒烟的证据意义全在"真的读过那份草稿"。）
if (!DRAFTS_DIR || !fs.existsSync(DRAFTS_DIR)) {
  console.error(
    `✖ 找不到草稿目录：${DRAFTS_DIR || '（注册表里没有可用项目）'}\n` +
      '  接入一个项目（manifest 声明 dataDir）或设 CROSSPOST_SMOKE_DRAFTS 指向草稿目录。',
  )
  process.exit(1)
}

/** 读取 frontmatter 的 risk 值（无 frontmatter 视为无风险） */
function readRisk(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!m) return null
    const r = /^\s*risk\s*:\s*(.+)$/m.exec(m[1])
    if (!r) return null
    const v = r[1].trim().toLowerCase()
    return v === 'none' || v === '' ? null : v
  } catch {
    return null
  }
}

const before = fingerprint(DRAFTS_DIR)
console.log(`草稿基线：${before.size} 个 .md\n`)

// ── ① 环境就绪 ──
const status = await runCli(['proxyStatus'])
check(
  '引擎可响应 proxyStatus（桥可达）',
  !!(status.json && typeof status.json.connected === 'boolean'),
  status.json
    ? `connected=${status.json.connected} version=${JSON.stringify(status.json.version)}`
    : status.err.slice(0, 200),
)

// ── ② listStyles：定时链路第一步 ──
const styles = await runCli(['listStyles'])
const available = (styles.json && (styles.json.available_styles || styles.json.styles)) || []
check(
  'listStyles 返回可用样式（链路第一步）',
  Array.isArray(available) && available.length > 0,
  `可用 ${Array.isArray(available) ? available.length : 0} 个`,
)

// ── ③ 挑选一个可安全 dryRun 的草稿 ──
let target = null
if (fs.existsSync(DRAFTS_DIR)) {
  const top = fs
    .readdirSync(DRAFTS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.join(DRAFTS_DIR, e.name))
  // 只挑 risk 为空的顶层草稿：risk 非空时 publishArticle 的留存逻辑会**移动文件**，
  // 而该分支在 dryRun 下同样执行（这是代码既有行为，不是缺陷，但测试必须避开）
  target = top.find((f) => !readRisk(f)) || null
}

if (!target) {
  skip('readDraft（链路读取草稿）', '顶层无 risk 为空的草稿可安全取样')
} else {
  const id = path.basename(target, '.md')
  const rd = await runCli(['readDraft', id])
  check(
    'readDraft 可读真实草稿（链路读取路径）',
    !!(rd.json && rd.json.id === id && typeof rd.json.markdown === 'string'),
    // 断言失败时也要能安全地打印诊断：readDraft 未命中时返回的是 `{error}`，
    // 没有 markdown 字段——旧写法在 detail 里直接取 `.length`，会先抛 TypeError，
    // 把一次"红"变成一段堆栈，真正的原因反而看不见（v2.74 实测踩到）。
    rd.json
      ? rd.json.markdown
        ? `title="${String(rd.json.title || '').slice(0, 24)}…" 正文 ${rd.json.markdown.length} 字`
        : `readDraft 未返回正文：${JSON.stringify(rd.json).slice(0, 160)}`
      : String(rd.err || rd.out).slice(0, 200),
  )

  // renderPreview 的契约是 `renderPreview <mdPath> <style>`（**不是** JSON 入参）。
  // 初版按 JSON 传参 → 返回 `md file not found: {...}`，而我在断言里把
  // html 缺失误判成"渲染不出东西"。测试用了错的契约，会给出错误的结论。
  const mdTmp = path.join(os.tmpdir(), `cp-smoke-render-${Date.now()}.md`)
  fs.writeFileSync(mdTmp, rd.json?.markdown || '# t\n\nx')
  const render = await runCli(['renderPreview', mdTmp, 'swiss'])
  fs.rmSync(mdTmp, { force: true })
  const html = render.json && render.json.html
  check(
    'renderPreview 可渲染（链路渲染路径）',
    typeof html === 'string' && html.length > 0,
    render.json && !html
      ? `返回体异常：${JSON.stringify(render.json).slice(0, 160)}`
      : `style=${render.json?.style} html ${typeof html === 'string' ? html.length : 0} 字 blocks=${render.json?.blockCount}`,
  )

  // ── ④ publishArticle dryRun：链路末端（不派发、不通知、不写草稿）──
  const allowPublish = process.env.CROSSPOST_SMOKE_ALLOW_PUBLISH !== '0'
  if (!allowPublish) {
    skip('publishArticle dryRun', 'CROSSPOST_SMOKE_ALLOW_PUBLISH=0')
  } else {
    const reqFile = path.join(os.tmpdir(), `cp-smoke-req-${Date.now()}.json`)
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        file: target,
        dryRun: true,
        wechat: false,
        platforms: [],
        notify: false,
      }),
    )
    const pub = await runCli(['publishArticle', reqFile])
    fs.rmSync(reqFile, { force: true })
    check(
      'publishArticle dryRun 跑通（链路末端，不派发）',
      !!(pub.json && !pub.json.error),
      pub.json
        ? `id=${pub.json.id} style=${pub.json.style} targets=${JSON.stringify(pub.json.targetPlatforms)}`
        : pub.err.slice(0, 200),
    )
  }
}

// ── ⑤ 只读性断言：草稿一字未改 ──
const after = fingerprint(DRAFTS_DIR)
const added = [...after.keys()].filter((k) => !before.has(k))
const removed = [...before.keys()].filter((k) => !after.has(k))
const modified = [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k))

check('草稿数量未变', before.size === after.size, `${before.size} → ${after.size}`)
check('无草稿被新增', added.length === 0, added.slice(0, 3).join(', '))
check('无草稿被删除', removed.length === 0, removed.slice(0, 3).join(', '))
check('无草稿被修改', modified.length === 0, modified.slice(0, 3).join(', '))

// ── 只读性断言（v2.41）：真实文章库一字未动 ──
// 背景：本冒烟的 dryRun 会写记录（`history` 追加一条 + `<id>.dry.html`），
// 此前直接落在**真实** articles/ —— 实测把某条记录的发布历史从 3 条灌到 41 条
// （38 条 dryRun 噪音）。现已把 CROSSPOST_ARTICLES_DIR 指到临时目录，这里再加一道
// "真实文章库真的没被碰过"的断言，防止有人把隔离删掉却以为冒烟仍是只读的。
{
  const changed = []
  for (const dir of REAL_ARTICLES_DIRS) {
    const before = REAL_ARTICLES_BEFORE.get(dir) || new Map()
    const after = articlesFingerprint(dir)
    for (const k of new Set([...before.keys(), ...after.keys()]))
      if (before.get(k) !== after.get(k)) changed.push(`${k} @ ${dir}`)
  }
  check(
    '真实内容域未被写入（dryRun 的簿记落在临时目录）',
    changed.length === 0,
    changed.length
      ? `被改动 ${changed.length} 个文件：${changed.slice(0, 3).join(', ')}`
      : `已比对 ${REAL_ARTICLES_DIRS.length} 个内容域，无变化`,
  )
}

const failed = results.filter((r) => !r.ok)
const skipped = results.filter((r) => r.skipped)
console.log(
  `\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} 通过` +
    (skipped.length ? `，${skipped.length} 项跳过` : ''),
)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  ✖ ${f.name} — ${f.detail}`)
}

fs.rmSync(TMP_LOCAL, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
