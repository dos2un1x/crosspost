/**
 * 发布域（从 cli.mjs 拆分，2026-08-24）：
 * 文章同步/发布一体化/回填/补记/核对/抖音手动/归档/留存
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtime, getAdapter, prefilterAuthed } from './platforms.mjs'
import { CHECK_ONLY_PLATFORMS } from '../platform-ids.mjs'
import { makeWechatOfficialAdapter } from './wechat.mjs'
import {
  scanAndList,
  getRecord,
  listRecords,
  parseDraftFile,
  getDraftsDir,
  ensureArticlesDir,
  upsertRecord,
  ensureDraftRecord,
  assertSafeId,
  lastHistoryAt,
} from '../articles.mjs'
import { readConfig } from '../config-cache.mjs'
import { collectRunLogRows, parseRunLogLine } from '../adapters/backfill-run-logs.mjs'
import { sendNotify, platformName, readNotifyConfig, renderTemplate } from '../notify.mjs'
// 发布来源与派发判定（2026-09-12）：定时链路永不豁免「生成后自动推送」开关
import { resolveDispatch } from '../publish-origin.mjs'
import { readAiDetectConfig } from '../ai-detect.mjs'
import {
  renderMarkdownAsync,
  generateCover,
  generateEndingCard,
  markdownToHtml,
  preprocessHtml,
  listStyleNames,
  normalizeBoldFlanking,
} from '@crosspost/core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 默认推送平台（2026-09-01：与 bridge/console/modules/const.mjs 的 DEFAULT_PLATFORMS 保持一致；真实默认以 config.json platforms.default 为准）
export const DEFAULT_PLATFORMS = [
  'toutiao',
  'baijiahao',
  'xiaohongshu',
  'zhihu',
  'yidian',
  'dayu',
  'csdn',
  'jianshu',
  'smzdm',
  'juejin',
  'cto51',
]
// 栏目 → 样式映射（2026-08-25：接入 md2we 主题库；可在 Console 重推时按篇覆盖）
// 2026-08-29：全部改为 config 启用列表内的可用样式（旧值 custom-minimal-gold 等已被禁用）
export const SLOT_STYLE_MAP = {
  morning: 'custom-mianpro', // 早报速览：AI 日报风（替代已禁用的 custom-minimal-gold）
  noon: 'custom-longform', // 深度分析①：杂志长文风（替代已禁用的 custom-elegant-navy）
  evening: 'custom-longform', // 深度分析②：与 noon 同栏目，取同一风格
  tips: 'custom-default', // 热点解读③：微信绿正式（同列热点解读的第 3 班，用通用资讯风）
  hotspot: 'cyber', // 热点解读①：赛博朋克（替代已禁用的 custom-focus-red）
  hotspot2: 'custom-tech', // 热点解读②：工程技术风（替代已禁用的 custom-cyber）
}
const WECHAT_DRAFT_LIST_URL =
  'https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&t=media/appmsg_list&action=list_card&type=77'

/** 脱敏：去掉错误信息里回显的 access_token / token / appsecret（2026-08-31 防敏感信息入记录/通知/UI）。
 *  2026-09-01 收敛：前端 utils.mjs 曾重复实现，现后端为唯一脱敏点——
 *  覆盖微信通道错误 + 多平台（syncArticle）错误，前端二次脱敏已移除。 */
function redactSecrets(s) {
  return String(s == null ? '' : s)
    .replace(/access_token=[A-Za-z0-9_-]+/g, 'access_token=***')
    .replace(/[?&](token|appsecret|secret)=[A-Za-z0-9_-]+/g, '$1=***')
    .replace(/(access_token|token|appsecret)([=：:])\s*[A-Za-z0-9_-]+/g, '$1$2***')
}

export async function syncArticle(req) {
  const platforms = req.platforms || []
  const article = req.article || {}
  // 2026-09-05：markdown 输出型平台（csdn/juejin/cto51/douyin/xiaohongshu 等）直接消费原始 markdown
  // 并用自己的渲染器再解析 —— 必须在此处归一化加粗 flanking（`**` 紧跟标点），否则 `**"..."**`
  // 这类写法被这些平台还原成字面 `**`（CommonMark left-flanking 规则）。HTML 型平台走 markdownToHtml
  // 内部已归一，幂等；此处归一化同时覆盖两类平台。
  const rawMarkdown = article.markdown || ''
  const markdown = normalizeBoldFlanking(rawMarkdown)
  const html = article.html || (markdown ? markdownToHtml(markdown) : '')
  const normalized = {
    title: article.title,
    markdown,
    html,
    cover: article.cover,
    source: article.source,
  }
  // 并发数：req.concurrency > config.json > 默认 3
  let concurrency = 3
  const cfgConcurrency = readConfig().concurrency // 2026-08-28：缓存读取
  if (cfgConcurrency) concurrency = Number(cfgConcurrency) || 3
  if (req.concurrency) concurrency = Number(req.concurrency) || concurrency
  concurrency = Math.max(1, Math.min(concurrency, 10))

  // 并发发布（默认 3，防风控；结果按请求顺序返回）
  const results = new Array(platforms.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const idx = cursor
      cursor += 1
      if (idx >= platforms.length) return
      const id = platforms[idx]
      try {
        const adapter = await getAdapter(id)
        if (!adapter) {
          results[idx] = { platform: id, success: false, error: 'unsupported platform' }
          continue
        }
        // 2026-08-27：HTML 输出平台统一预处理（section 解包/空容器清理/空白压缩，防空行；幂等）
        const useHtml = !!(
          adapter.preprocessConfig && adapter.preprocessConfig.outputFormat === 'html'
        )
        const payload =
          useHtml && normalized.html
            ? { ...normalized, html: preprocessHtml(normalized.html) }
            : normalized
        const r = await adapter.publish(payload, { draftOnly: true })
        results[idx] = {
          platform: id,
          success: !!r.success,
          postId: r.postId || null,
          postUrl: r.postUrl || null,
          draftOnly: true,
          error: r.error || null,
          message: r.message || null,
        }
      } catch (e) {
        results[idx] = {
          platform: id,
          success: false,
          error: redactSecrets(String((e && e.message) || e)),
        }
      }
    }
  }
  const workers = []
  for (let i = 0; i < Math.min(concurrency, platforms.length); i++) workers.push(worker())
  await Promise.all(workers)
  return results
}

/** 去掉 YAML frontmatter，返回正文 */
export function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  return m ? m[2] : text
}

/** 移动草稿到留存目录（rejected=低分 / risk=高风险），自动建目录，返回目标路径 */
export function moveToRetained(file, sub) {
  const dir = path.join(getDraftsDir(), sub)
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, path.basename(file))
  fs.renameSync(file, dest)
  return dest
}

/** 在留存目录中查找文件（rejected/ + risk/） */
export function findRetainedFile(id) {
  assertSafeId(id) // 2026-08-28：路径穿越防护（留存操作 unlink/rename 必经）
  for (const sub of ['rejected', 'risk']) {
    const p = path.join(getDraftsDir(), sub, `${id}.md`)
    if (fs.existsSync(p)) return { file: p, dir: sub }
  }
  return null
}

/** 清空草稿 frontmatter 的 risk 行（人工放行推送/恢复后，防自动链路再次拦截） */
export function stripFrontmatterRisk(file) {
  const text = fs.readFileSync(file, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m || !/^\s*risk\s*:/m.test(m[1])) return
  const fm = m[1]
    .replace(/^\s*risk\s*:.*$/m, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
  fs.writeFileSync(file, `---\n${fm}\n---\n${m[2]}`, 'utf8')
}

/** 查找草稿文件：记录 file > drafts/ 顶层 > 子目录(archive/rejected/risk) 兜底，返回 { file, dir } 或 null */
export function findDraftFile(id) {
  assertSafeId(id) // 2026-08-28：路径穿越防护（id → 文件路径）
  const rec = getRecord(id)
  if (rec && rec.file && fs.existsSync(rec.file))
    return { file: rec.file, dir: path.dirname(rec.file) }
  for (const sub of ['', 'archive', 'rejected', 'risk']) {
    const p = path.join(getDraftsDir(), sub, `${id}.md`)
    if (fs.existsSync(p)) return { file: p, dir: sub || getDraftsDir() }
  }
  return null
}

/** 归档（restore=false 移入 drafts/archive/）或取消归档（restore=true 移回 drafts/ 顶层） */
export async function runArchiveArticle(req) {
  const rec = getRecord(req.id)
  if (!rec && req.restore) return { error: `无记录: ${req.id}` }
  const found = findDraftFile(req.id)
  if (!found) {
    // 文件缺失：仅当执行归档（非恢复）时允许纯状态标记
    if (!req.restore && rec) {
      rec.status = 'archived'
      rec.dir = 'archive' // 2026-08-30 脏数据修复：归档记录须带 dir，供 scanAndList 顶层排除
      rec.history = rec.history || []
      rec.history.push({ action: 'archive', at: new Date().toISOString(), note: 'file-missing' })
      upsertRecord(rec)
      return { ok: true, id: req.id, status: rec.status, file: rec.file || null, fileMissing: true }
    }
    return { error: `草稿文件不存在: ${req.id}` }
  }
  const targetDir = req.restore ? getDraftsDir() : path.join(getDraftsDir(), 'archive')
  fs.mkdirSync(targetDir, { recursive: true })
  const dest = path.join(targetDir, path.basename(found.file))
  fs.renameSync(found.file, dest)
  const cur = getRecord(req.id) || {
    id: req.id,
    status: 'draft',
    wechat: { status: 'none' },
    platforms: {},
    notify: { status: 'none' },
    history: [],
    createdAt: new Date().toISOString(),
  }
  cur.status = req.restore ? 'draft' : 'archived'
  cur.dir = req.restore ? null : 'archive' // 2026-08-30 脏数据修复：归档/恢复时同步 dir
  cur.file = dest
  cur.history = cur.history || []
  cur.history.push({ action: req.restore ? 'restore' : 'archive', at: new Date().toISOString() })
  try {
    upsertRecord(cur)
  } catch (e) {
    // 与留存同一条纪律（见 runRetainArticle）：文件已移动，不回滚；把"记录没写成功"如实报出来，
    // 让调用方看到的是可执行的下一步（重跑本命令补录），而不是一句孤零零的 EPERM。
    const msg = String((e && e.message) || e)
    const err = new Error(`记录写入失败（文件已移动到 ${dest}，需重跑本命令补录）: ${msg}`)
    err.fields = {
      ok: false,
      id: req.id,
      status: cur.status,
      file: dest,
      fileMoved: true,
      recordError: msg,
    }
    throw err
  }
  return { ok: true, id: req.id, status: cur.status, file: dest }
}

/** 手动留存：文件移入 drafts/<dir>（rejected|risk）+ 记录 status=retained + history 标注 */
export async function runRetainArticle(req) {
  const dir = req.dir === 'risk' ? 'risk' : 'rejected'
  const found = findDraftFile(req.id)
  if (!found) return { error: `草稿文件不存在: ${req.id}` }
  const dest = moveToRetained(found.file, dir)
  // 没有记录时**先按草稿建记录**（解析 frontmatter 拿 title/slot/date/score），再写处置状态。
  // 为什么不能手搓一个最小记录：写作侧把落选稿直接 mv 进 rejected/ 时，引擎从没扫到过它
  // （scanAndList 只扫 drafts/ 顶层），于是"第一次登记"就发生在这里——不解析草稿就会得到
  // 一条 title/slot/date 全空的记录，Console 留存库里那一行是空白。
  const parsed = parseDraftFile(found.file)
  if (!parsed) return { error: `草稿解析失败: ${req.id}` }
  // 整段记录写入都在 try 里：失败点不止最后那次 upsert —— 无记录时 `ensureDraftRecord` 会先建记录，
  // 那一步同样会写盘（实测：把 state 目录做成不可写时，异常就是在 `ensureDraftRecord` 抛的）。
  try {
    const cur = ensureDraftRecord(parsed)
    cur.status = 'retained'
    cur.dir = dir // 2026-08-30 脏数据修复：留存记录须带 dir（rejected/risk），供 scanAndList 顶层排除
    cur.retainedDir = dir
    cur.retainedReason = req.reason || null
    cur.file = dest
    cur.history = cur.history || []
    cur.history.push({
      action: 'retain',
      dir,
      reason: req.reason || null,
      at: new Date().toISOString(),
    })
    upsertRecord(cur)
  } catch (e) {
    // 记录写不进去时**不回滚文件移动**：留存的目的是让它离开自动发布路径，回滚等于把它送回
    // `drafts/` 顶层（下一次生成可能又把它当成待发布稿）。但也不能像以前那样只把异常抛出去——
    // 调用方看到的是一句 EPERM，而**状态是"文件已留存、记录没写"**，面板上则表现为"这篇没发过"。
    // 这里把两件事一起说清：文件已在 `<dir>/`，重跑同一条命令即可补写记录（`findDraftFile`
    // 会到子目录里找到它，第二次只有"补记录"这一件事要做）。
    const msg = String((e && e.message) || e)
    const err = new Error(`记录写入失败（文件已移入 ${dir}/，需重跑本命令补录）: ${msg}`)
    err.fields = { ok: false, id: req.id, dir, file: dest, fileMoved: true, recordError: msg }
    throw err
  }
  return { ok: true, id: req.id, status: 'retained', dir, file: dest, reason: req.reason || null }
}

/** 列出归档库（drafts/archive/ 文件 + 记录已归档但文件缺失），合并记录推送状态
 *
 *  2026-09-25（2026-09-25 容器模式性能）：**一次 `listRecords()` 建 Map**，
 *  替代原先"每篇一次 `getRecord()`"（126 篇 = 126 次独立读盘/stat）。
 *  第二段"记录已归档但文件缺失"也复用同一份记录，不再第二次全量 `listRecords()`。
 *  口径与改动前逐字一致。 */
export function listArchive() {
  const out2 = []
  const dir = path.join(getDraftsDir(), 'archive')
  const seen = new Set()
  const records = listRecords()
  const byId = new Map(records.map((r) => [r.id, r]))
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const p = path.join(dir, f)
      const parsed = parseDraftFile(p)
      const rec = byId.get(parsed.id)
      seen.add(parsed.id)
      out2.push({
        id: f.replace(/\.md$/, ''),
        file: p,
        dir: 'archive',
        hasFile: true,
        title: parsed.title,
        date: parsed.date,
        slot: parsed.slot,
        topic: parsed.topic,
        score: (rec && rec.score && rec.score.total) ?? parsed.score,
        risk: (rec && rec.risk) || parsed.risk || null,
        // 2026-08-31：透传发布平台结果，供报表「平台成功率」纳入归档库已推送内容
        platforms: (rec && rec.platforms) || null,
        archivedAt: lastHistoryAt(rec, 'archive'),
        // 2026-08-30 脏数据修复：物理位于 drafts/archive/ 的文件即"已归档"。
        // 部分历史记录 status 滞留在 published/draft（文件被移入但记录未更新），
        // 归档库语义上恒为 archived，避免以非归档态出现在归档库。
        status: 'archived',
      })
    }
  }
  // 记录已归档但文件缺失（删除/迁移后）：仍显示在归档库，仅允许删除清理记录
  for (const rec of records) {
    if (rec.status !== 'archived' || seen.has(rec.id)) continue
    out2.push({
      id: rec.id,
      file: rec.file || null,
      dir: 'archive',
      hasFile: false,
      title: rec.title,
      date: rec.date,
      slot: rec.slot,
      topic: rec.topic,
      score: rec.score && rec.score.total,
      risk: rec.risk,
      platforms: rec.platforms || null,
      archivedAt: lastHistoryAt(rec, 'archive'),
      status: 'archived',
    })
  }
  out2.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.id.localeCompare(b.id))
  return out2
}

/**
 * 列出留存库（drafts/rejected 低分 / drafts/risk 高风险）。
 *
 * 2026-09-25：从 `cli.mjs` 的内联实现搬到这里（**纯搬迁**，语义逐字不变），
 * 让 CLI 与测试有同一个落点；同时把"每篇一次 `getRecord`"改成**一次 Map 查**。
 */
export function listRetained() {
  let out2 = []
  const records = listRecords()
  const byId = new Map(records.map((r) => [r.id, r]))
  for (const sub of ['rejected', 'risk']) {
    const dir = path.join(getDraftsDir(), sub)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const p = path.join(dir, f)
      const parsed = parseDraftFile(p)
      const rec = byId.get(parsed.id)
      out2.push({
        id: f.replace(/\.md$/, ''),
        file: p,
        dir: sub,
        title: parsed.title,
        date: parsed.date,
        slot: parsed.slot,
        topic: parsed.topic,
        score: parsed.score,
        risk: parsed.risk,
        recordRisk: rec && rec.risk,
        retainedReason: rec && rec.retainedReason,
        retainedAt: lastHistoryAt(rec, 'retain'),
      })
    }
  }
  // 2026-08-30 脏数据修复：同一 id 因历史原因同时躺在 rejected/ 与 risk/（物理重复文件）。
  // 去重只保留一份：优先保留与记录 retainedDir 一致的；无记录/无 retainedDir 时保留 dir 排前（rejected）那份。
  const dedup = new Map()
  for (const e of out2) {
    const rec = byId.get(e.id)
    const prefDir = rec && rec.retainedDir
    if (!dedup.has(e.id)) {
      dedup.set(e.id, e)
      continue
    }
    const cur = dedup.get(e.id)
    if (prefDir && e.dir === prefDir && cur.dir !== prefDir) dedup.set(e.id, e)
  }
  out2 = [...dedup.values()]
  out2.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.id.localeCompare(b.id))
  return { retained: out2 }
}

/** 发布配置解析（纯计算；2026-08-28 B1 拆分自 runPublishArticle）
 *  样式/封面/结束语/评分/平台解析，含禁用回退；无副作用。
 *  2026-08-29 修复：未知样式（不在样式清单）也回退 swiss + warning——
 *  AI 曾误传不存在的 `minimal`，旧逻辑穿透到渲染层才报"未知样式"致微信首推失败。 */
function resolvePublishConfig(req, parsed, cfgAll) {
  const disabledStyles = new Set((cfgAll.styles && cfgAll.styles.disabled) || [])
  const validStyles = new Set(listStyleNames()) // 内置 + custom 全部合法样式名
  // 项目级「每个栏目自己的默认样式」：`styles.perSlot = { <栏目 id>: <样式名> }`。
  // 它是**项目级键**（`config-layers.mjs` 的 PROJECT_KEYS），所以每条写作流水线可以给自己的
  // 栏目配自己的默认样式；不配就落到引擎内建的 `SLOT_STYLE_MAP`（内建 6 栏目），再不然 swiss。
  const perSlot = (cfgAll.styles && cfgAll.styles.perSlot) || {}
  const coverCfg = cfgAll.coverSettings || {}
  const disabledTemplates = new Set(coverCfg.disabledTemplates || [])
  // 样式优先级（2026-08-27）：req > frontmatter style（AI 按内容所选） > 栏目默认样式 > 栏目映射 > swiss
  const slotDefault = typeof perSlot[parsed.slot] === 'string' ? perSlot[parsed.slot].trim() : ''
  const styleRaw =
    req.style || parsed.style || slotDefault || SLOT_STYLE_MAP[parsed.slot] || 'swiss'
  // 2026-08-29：禁用 → 回退；未知（不存在）→ 回退（杜绝"未知样式"渲染期报错）
  let style = styleRaw
  let styleWarning = null
  if (disabledStyles.has(styleRaw)) {
    style = 'swiss'
    styleWarning = `样式已禁用: ${styleRaw}，已回退默认 swiss`
  } else if (!validStyles.has(styleRaw)) {
    style = 'swiss'
    styleWarning = `样式不存在: ${styleRaw}，已回退默认 swiss（可用样式以 list_styles 的 enabled 列表为准）`
  }
  // 封面模板（2026-08-27）：req > frontmatter > config.coverSettings.defaultTemplate > nebula；命中禁用回退默认
  const coverTemplateRaw =
    req.coverTemplate || parsed.coverTemplate || coverCfg.defaultTemplate || 'nebula'
  const coverTemplate = disabledTemplates.has(coverTemplateRaw)
    ? coverCfg.defaultTemplate || 'nebula'
    : coverTemplateRaw
  // 结束语模板：config.coverSettings.endingTemplate 优先，未设跟随封面
  const endingTemplateRaw = coverCfg.endingTemplate || coverTemplate
  const endingTemplate = disabledTemplates.has(endingTemplateRaw)
    ? coverCfg.defaultTemplate || 'nebula'
    : endingTemplateRaw
  // 结束语图片（2026-08-27）：req > frontmatter ending-card > config.endingCardEnabled > 默认 true；仅微信草稿
  const endingCardOn =
    req.endingCard !== false && parsed.endingCard !== false && coverCfg.endingCardEnabled !== false
  // 质量评分（§5.5 自评写 frontmatter score；req.score 显式传入时优先）
  const scoreRaw =
    req.score !== undefined && req.score !== null && req.score !== ''
      ? Number(req.score)
      : parsed.score
  const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, Math.round(scoreRaw))) : null
  const scoreDims =
    req.scoreDims && typeof req.scoreDims === 'object' ? req.scoreDims : parsed.scoreDims || null
  // 平台解析优先级（2026-08-20）：显式 platforms > config.platforms.default > DEFAULT_PLATFORMS
  let platforms = Array.isArray(req.platforms) ? [...new Set(req.platforms.filter(Boolean))] : null
  if (platforms === null) {
    const def = readConfig().platforms && readConfig().platforms.default // 2026-08-28：缓存读取
    platforms = Array.isArray(def) ? [...new Set(def.filter(Boolean))] : [...DEFAULT_PLATFORMS]
    // 2026-09-12（勾选语义）：设置页的勾选 = 「推送 + 检查」，但 CHECK_ONLY_PLATFORMS
    // （微信/抖音）的勾选**只表示纳入登录检查**——派发走各自专用通道
    // （微信=官方草稿通道/抽屉里的「微信草稿」；抖音=抽屉里的抖音推送按钮）。
    // 只过滤"配置默认"这条路径；显式传参（MCP/CLI 的 platforms）行为完全不变。
    platforms = platforms.filter((id) => !CHECK_ONLY_PLATFORMS.includes(id))
  }
  // 抖音铁律：自动链路永不推 douyin（仅手动 publishDouyin 入口传 allowDouyin=true 放行）
  if (!req.allowDouyin) platforms = platforms.filter((id) => id !== 'douyin')
  return {
    style,
    styleWarning,
    coverTemplate,
    endingTemplate,
    endingCardOn,
    coverEnabled: coverCfg.coverEnabled !== false,
    score,
    scoreDims,
    platforms,
    concurrency: req.concurrency || 5,
    dryRun: !!req.dryRun,
    now: new Date().toISOString(),
  }
}

/** 微信官方通道（恒草稿；2026-08-28 B1 拆分自 runPublishArticle）
 *  返回 { wechat, wechatHtml, error? }；失败不抛（错误进 wechat 字段 + error 供调用方记 errors）。
 *  2026-08-29 双保险：渲染若仍抛"未知样式"（配置阶段已拦截，此处兜底）→ 用 swiss 重试一次并记 warning。 */
async function runWechatChannel({
  adapter,
  bodyRender,
  style,
  coverTemplate,
  coverEnabled,
  title,
  file,
  now,
}) {
  try {
    await adapter.init(runtime)
    let r
    let styleRetried = false
    try {
      r = await renderMarkdownAsync(bodyRender, {
        style,
        mdPath: file,
        imageUploader: makeWechatUploader(adapter),
      })
    } catch (e) {
      if (/未知样式/.test(String((e && e.message) || e))) {
        styleRetried = true
        r = await renderMarkdownAsync(bodyRender, {
          style: 'swiss',
          mdPath: file,
          imageUploader: makeWechatUploader(adapter),
        })
      } else {
        throw e
      }
    }
    // 2026-08-31 封面图片开关：关闭时彻底不生成/上传封面（微信草稿无缩略图，若微信拒绝走 catch 记失败，不影响其它平台）
    let cover = null
    if (coverEnabled) {
      try {
        const cr = await generateCover({
          title,
          template: coverTemplate,
          outPath: '/tmp/crosspost-cover.png',
        })
        if (cr.ok) cover = cr.path
      } catch {
        /* 封面失败不阻塞 */
      }
    }
    const thumbMediaId = cover ? await adapter.uploadThumb(cover) : null
    if (coverEnabled && !thumbMediaId) throw new Error('封面缩略图上传失败')
    const result = await adapter.createDraft({ title, html: r.html, thumbMediaId })
    return {
      wechat: { status: 'ok', mediaId: result.media_id, at: now },
      wechatHtml: r.html,
      ...(styleRetried ? { styleRetried, styleRetriedFrom: style } : {}),
    }
  } catch (e) {
    const msg = redactSecrets(String((e && e.message) || e)) // 2026-08-31：脱敏，防 access_token 入记录/通知
    return { wechat: { status: 'fail', error: msg, at: now }, wechatHtml: null, error: msg }
  }
}

/** 微信图片上传器（提取复用：runWechatChannel 渲染重试共用） */
function makeWechatUploader(adapter) {
  return async (src, kind) => {
    let buf
    if (kind === 'local') buf = fs.readFileSync(src)
    else {
      const resp = await runtime.fetch(src, { method: 'GET' })
      if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`)
      buf = Buffer.from(await resp.arrayBuffer())
    }
    return adapter.uploadImage(new Blob([buf]), 'img.png')
  }
}

/**
 * 通知文案构造（2026-09-12 提取为纯函数）。
 * 目的：让「未开启自动推送」等分支可被单测覆盖，而不必在测试里真发一条飞书通知。
 *
 * @returns {{vars:object, notifyTitle:string, summaryLine:string, footer:string}}
 */
export function buildPublishNotifyCopy({
  title,
  slot,
  style,
  score,
  aiDetect,
  wechatStatus,
  wechatError,
  okCount = 0,
  total = 0,
  failList = [],
  skipList = [],
  dispatchEnabled,
  origin,
  wechatSkippedByReq,
  file,
  // 本次"没派发"的原因（如 AI 检测快照门禁）。缺省回落到"未开启自动推送"。
  skipReason,
  template = {},
}) {
  const skipText = skipList.length ? `未登录跳过: ${skipList.map((s) => s.id).join(',')}` : ''
  const failedText = [
    failList.length ? `失败平台: ${failList.join(',')}` : '',
    wechatStatus === 'fail' ? `微信: ${wechatError || '失败'}` : '',
    skipText,
  ]
    .filter(Boolean)
    .join(';')
  // 2026-09-12：来源如实入文案，便于一眼区分「定时链路未推送」与「手动未勾选微信」
  const originLabel =
    origin === 'scheduled' ? '定时' : origin === 'draft-only' ? '一键生成' : '人工'
  const wechatVars = !dispatchEnabled
    ? '未推送'
    : wechatStatus === 'ok'
      ? '成功'
      : wechatStatus === 'fail'
        ? `失败(${wechatError})`
        : wechatSkippedByReq
          ? '未勾选'
          : '未启用（自动推送开关关闭或未勾选含微信）'
  // 没派发时把**真实原因**写进文案：默认措辞是"未开启自动推送"，但快照门禁等原因也走同一条分支，
  // 不区分就会把"缺检测快照所以没推"说成"自动推送没开"，收通知的人照着排查会走错方向。
  const skipReasonText = skipReason || '未开启自动推送'
  const vars = {
    title,
    slot: slot || 'manual',
    style,
    score: score === null || score === undefined ? '无' : String(score),
    wechat: wechatVars,
    ok: String(okCount),
    total: String(total),
    failed: failList.length ? failList.join(',') : '无',
    failReason: dispatchEnabled ? failedText || '无' : skipReasonText,
    origin: originLabel,
    file,
    // AI 检测快照（2026-10-05）：跳过检测时也要如实入文案——"没检测"必须一眼可见，
    // 否则一条本该被 AI 率门禁挡下的稿子会看起来跟"检测通过"一样。
    aiDetect: aiDetect || '未执行',
  }
  const notifyTitle = renderTemplate(template.title, vars) || `${slot || 'manual'} · ${title}`
  const aiClause = aiDetect ? `\nAI检测=${aiDetect}` : ''
  const summaryLine =
    renderTemplate(template.summary, vars) ||
    (dispatchEnabled
      ? `📌 《${title}》\n模式=${slot} 样式=${style} 微信=${vars.wechat} 分发=${okCount}/${total} 成功${failList.length ? `,失败:${failList.join(',')}` : ''}${aiClause}`
      : `📌 《${title}》\n模式=${slot} 样式=${style} 微信=未推送（${skipReasonText}）\n已生成草稿（来源=${vars.origin}）${aiClause}`)
  // 尾行按事实陈述：只有微信真的 ok 才声称"已推送公众号草稿箱"
  const wechatClause =
    wechatStatus === 'ok'
      ? '已推送公众号草稿箱 + '
      : wechatStatus === 'fail'
        ? `微信未推送（${wechatError || '失败'}）；已推送 `
        : wechatSkippedByReq
          ? '未勾选微信；已推送 '
          : '未含微信（自动推送未启用或未勾含微信）；已推送 '
  const footer =
    renderTemplate(template.footer, vars) ||
    (dispatchEnabled
      ? failedText
        ? `${failedText}\n草稿保留: ${file}\n${wechatClause}${okCount} 个平台草稿箱,请查看筛选。`
        : `${wechatClause}${okCount} 个平台草稿箱,请查看筛选。`
      : `草稿保留: ${file}\n${skipReasonText},已生成草稿待人工推送（来源=${vars.origin}；可在 Console 手动挑选平台推送）。`)
  return { vars, notifyTitle, summaryLine, footer }
}

/** 发布一体化：读稿 → 校验 → 微信官方通道(恒草稿) → 多平台(恒草稿) → 记录 → 通知 */
export async function runPublishArticle(req) {
  let file = req.file
  if (!file && req.id) {
    // 2026-08-31：草稿可能在 archive/rejected/risk 子目录，
    // 顶层拼接会漏掉 → 用 findDraftFile 定位（记录 file → 各子目录）。
    const found = findDraftFile(req.id)
    if (found) file = found.file
  }
  if (!file || !fs.existsSync(file)) return { error: `草稿文件不存在: ${file || req.id}` }

  const parsed = parseDraftFile(file)
  const body = splitFrontmatter(fs.readFileSync(file, 'utf8'))
  for (const bad of ['备选标题', '未采用', '留作参考']) {
    if (body.includes(bad)) return { error: `草稿含内部内容"${bad}",禁止发布（${file}）` }
  }

  // ---- 发布来源（2026-09-12）----
  // 定时链路（run_once.sh → dsh → MCP）与一键生成由 shell 注入的 env 标记判定（见 publish-origin.mjs），
  // AI 无法自我声明豁免；Console / CLI / 交互式会话 = manual（人工触发）。
  const origin = req.origin || 'manual'
  if (origin === 'draft-only') {
    // 一键生成（generate_once.sh, WECHAT_AUTO_DRAFT_ONLY=1）恒草稿：persona 已禁止发布，这里再兜一层代码约束。
    return {
      error: '本轮为一键生成（draft-only）链路，禁止发布调用：草稿已落盘，请到 Console 手动推送',
      origin,
      draftOnly: true,
    }
  }

  // 封面/样式/结束语/评分/平台配置（2026-08-28 B1：提取为 resolvePublishConfig 纯函数）
  const cfgAll = readConfig() // 2026-08-28：缓存读取（失败返回空对象，与历史 try/catch 行为一致）
  // 生成后自动推送（2026-09-09）：默认关闭（仅落草稿）；开启才推送各平台/微信。
  // 注意：这只决定「推送动作」与「通知内容」，不决定是否发飞书——飞书实际发送由 notify 配置控制。
  const autoPush = {
    enabled: !!(cfgAll.autoPush && cfgAll.autoPush.enabled),
    includeWechat: !!(cfgAll.autoPush && cfgAll.autoPush.includeWechat),
  }
  const cfg = resolvePublishConfig(req, parsed, cfgAll)
  const {
    style,
    styleWarning,
    coverTemplate,
    endingTemplate,
    endingCardOn,
    coverEnabled,
    score,
    scoreDims,
    concurrency,
    dryRun,
    now,
  } = cfg
  // 2026-08-28 修复：platforms 必须 let——登录预检（prefilterAuthed）后会被重新赋值（B1 拆分误入 const 解构导致发布抛 "Assignment to constant variable"）
  let platforms = cfg.platforms
  let bodyRender = body
  if (endingCardOn && body.trim()) {
    try {
      const ec = await generateEndingCard({
        template: endingTemplate,
        text:
          req.endingText || (cfgAll.coverSettings && cfgAll.coverSettings.endingText) || undefined,
        outPath: path.join(os.tmpdir(), `crosspost-ending-${Date.now()}.png`),
      })
      if (ec.ok && ec.path) {
        bodyRender = body.replace(/\s*$/, '') + `\n\n![看完点个三连](${ec.path})\n`
      }
    } catch {
      /* 引导图失败不阻塞发布 */
    }
  }

  const title = parsed.title
  // 风险属性硬校验（2026-08-20）：frontmatter risk 命中（ad/investment/pr）且非人工放行 → 拒绝发布
  // force=true 仅由面板留存库人工通道传入（MCP/AI 无此参数，自动链路永不触碰留存文章）
  const risk = parsed.risk || null
  if (risk && !req.force) {
    const dest = moveToRetained(file, 'risk')
    return {
      error: `文章被判定为高风险类型(${risk}),已过滤并留存: ${dest}（人工可在 Console 留存库处理）`,
      risk,
      retained: dest,
    }
  }

  const summary = {
    id: parsed.id,
    file,
    title,
    slot: parsed.slot,
    date: parsed.date,
    style,
    styleWarning,
    dryRun,
    wechat: { status: 'skip' },
    platforms: {},
    notify: { status: 'none' },
  }
  const errors = []
  const okList = []
  const failList = []

  // ---- 派发判定（必须在微信通道之前）----
  // 2026-09-11 修复：**手动通道不受 autoPush 开关门控**。
  // 此前 `pushEnabled = autoPush.enabled` 同时门控了手动抖音推送（console「推送到抖音」，
  // 经 runPublishDouyin → allowDouyin=true），导致 autoPush 关闭时手动推送被静默跳过：
  // 返回 { platforms: {}, error: null, skip: [] }，前端只能显示"未知原因"。
  // 同类问题还波及「重推到所选平台」（/proxy/publish）——于是 autoPush 关闭时同样静默跳过全部平台
  // （UI 仍显示成功、记录写 draft-only）。手动请求（manual / allowDouyin / force）应恒派发。
  //
  // 2026-09-12 修复（回归）：09-11 那次给 MCP publish_article 也硬编码了 manual:true（“AI 显式调用=人工触发”），
  // 但**定时链路本身就是一个 AI 会话**（接入方的定时脚本 → 它的 DSH profile → MCP），
  // 于是「生成后自动推送」开关在定时链路上被恒真豁免，09-12 08:10/08:30 两轮在开关关闭时真推了微信+8 平台。
  // 现在：来源由 shell 注入的 env 标记判定（origin），**定时链路强制 manualPush=false（服务端冻结）**，
  // 即便上游误传 manual/allowDouyin/force 也不能豁免；人工来源（交互式会话/CLI/Console）语义不变。
  const dispatch = resolveDispatch({
    autoPushEnabled: autoPush.enabled,
    autoPushIncludeWechat: autoPush.includeWechat,
    origin,
    manual: req.manual,
    allowDouyin: req.allowDouyin,
    force: req.force,
    wechat: req.wechat,
  })
  // 2026-09-12：不再单独取出 dispatch.manualPush（临时变量已无消费方；派发判定统一看下面两个），
  // 需要排查时直接看 resolveDispatch 的返回值即可。
  const pushEnabled = dispatch.pushEnabled
  // dispatchEnabled = 本次是否真的派发平台/微信；后续「状态 / 历史 action / 通知文案」都必须按它分支，
  // 否则手动放行时会出现"平台推成功了、记录却写 draft-only、通知写未推送"的不一致。
  let dispatchEnabled = dispatch.dispatchEnabled
  let wantWechat = dispatch.wantWechat

  // ---- AI 检测快照门禁（默认关）----
  //
  // `aiDetect.requireSnapshotOnPublish=true` 时：没带 §5.55 快照就不派发（平台与微信都不发），
  // 但仍落草稿记录 + 历史 + 明确原因。取向与槽位门禁一致——**不静默**：宁可停在草稿态并说清
  // 为什么，也不让一篇"跳过检测"的稿子带着"未执行"出门（那等于把门禁当成摆设）。
  // 为什么不做成"抛错"：定时链路无人值守，一次异常会丢掉整轮结果；停在草稿态是可恢复的。
  const aiCfg = readAiDetectConfig()
  const snapshotMissing =
    aiCfg.requireSnapshotOnPublish === true && !String(req.aiDetect || '').trim()
  const snapshotSkipReason = snapshotMissing
    ? '缺少 AI 检测快照（aiDetect.requireSnapshotOnPublish=true）：补上 §5.55 快照后重试'
    : undefined
  if (snapshotMissing) {
    dispatchEnabled = false
    wantWechat = false
  }

  // ---- 微信官方通道（恒草稿）----
  // 2026-09-11：手动请求（manual / allowDouyin / force）勾选即执行——抽屉里的「微信草稿」复选框就是意图，
  // 不该再被「生成后自动推送」总开关吞掉（此前 autoPush 关闭时手动勾了微信仍记 skip）。
  // 自动链路：仍要求 autoPush.enabled 且 includeWechat 勾选（语义不变）。
  let wechatHtml = null
  if (!dryRun && wantWechat) {
    const adapter = makeWechatOfficialAdapter()
    if (!adapter) {
      summary.wechat = { status: 'fail', error: '缺少微信凭证' }
      errors.push({ what: 'wechat', error: '缺少微信凭证' })
    } else {
      // 2026-08-28 B1：提取为 runWechatChannel
      const w = await runWechatChannel({
        adapter,
        bodyRender,
        style,
        coverTemplate,
        coverEnabled,
        title,
        file,
        now,
      })
      summary.wechat = w.wechat
      wechatHtml = w.wechatHtml
      if (w.error) errors.push({ what: 'wechat', error: w.error })
    }
  }

  // ---- 登录预检（2026-08-20）：未登录平台自动跳过（skip），不报失败 ----
  let skipList = []
  // 生成后自动推送关闭：仅落草稿，不推任何平台（2026-09-09）。
  // 注意：不在此清空 platforms——targetPlatforms 应恒反映「解析+去重+剔抖音」后的目标列表（纯逻辑），
  // 派发动作由上方派发判定（manualPush / pushEnabled / dispatchEnabled，2026-09-11 统一）门控；
  // 否则平台解析/抖音铁律等纯逻辑测试会被连带清空。
  if (!dryRun && dispatchEnabled && platforms.length) {
    const pf = await prefilterAuthed(platforms)
    platforms = pf.push
    skipList = pf.skip
  }

  // ---- 多平台通道（恒草稿；失败平台单独重试 1 次）----
  if (!dryRun && dispatchEnabled && platforms.length) {
    // 多平台：用原始 body（不带结束语图；结束语图仅微信草稿，2026-08-27）
    const article = { title, markdown: body }
    const first = await syncArticle({ platforms, article, concurrency })
    const res = new Map((first || []).map((r) => [r.platform, r]))
    for (const r of first || []) {
      if (!r.success) {
        const retry = await syncArticle({ platforms: [r.platform], article, concurrency: 1 })
        const rr = (retry || [])[0]
        if (rr) res.set(r.platform, rr)
      }
    }
    for (const [id, r] of res.entries()) {
      summary.platforms[id] = {
        status: r.success ? 'ok' : 'fail',
        postUrl: r.postUrl || null,
        error: r.error || null,
        at: now,
      }
      if (r.success) okList.push(id)
      else {
        failList.push(id)
        errors.push({ what: `platform:${id}`, error: r.error || 'unknown' })
      }
    }
  }
  // 未登录跳过的平台补进 summary（不进 failList，通知注明）
  for (const s of skipList) {
    summary.platforms[s.id] = { status: 'skip', error: s.error || '未登录', at: now }
  }

  // ---- 通知（发布器直发，不经 LLM）----
  // 无论自动推送开/关，通知逻辑都执行（实际是否发送由 notify 配置控制）。内容随 dispatchEnabled 自适应。
  if (!dryRun && req.notify !== false) {
    const links = []
    if (dispatchEnabled) {
      if (summary.wechat.status === 'ok')
        links.push({ label: '微信', text: '草稿', href: WECHAT_DRAFT_LIST_URL })
      for (const id of okList) {
        const p = summary.platforms[id]
        if (p.postUrl) links.push({ label: platformName(id), text: '草稿', href: p.postUrl })
        else links.push({ label: platformName(id), text: '(无链接)', href: null })
      }
    }
    const nTotal = okList.length + failList.length
    const ncfg = readNotifyConfig()
    // 2026-09-11：微信状态如实表述——skip 要区分"未勾选"与"自动链路未启用/未勾含微信"。
    // 2026-09-12：文案构造提取为纯函数 buildPublishNotifyCopy（可单测，无需真发通知验证）。
    const wechatSkippedByReq = req.wechat === false
    const { notifyTitle, summaryLine, footer } = buildPublishNotifyCopy({
      title,
      slot: parsed.slot,
      style,
      score,
      aiDetect: req.aiDetect,
      wechatStatus: summary.wechat.status,
      wechatError: summary.wechat.error,
      okCount: okList.length,
      total: nTotal,
      failList,
      skipList,
      dispatchEnabled,
      origin,
      wechatSkippedByReq,
      file,
      skipReason: snapshotSkipReason,
      template: ncfg.template,
    })
    summary.notify = await sendNotify({
      // 2026-09-11 修复：旧写法 `crosspost-<id>-<epochSec>`.slice(0,50) 对长 id 会把时间戳截掉，
      // 导致同一篇文章每次推送用同一个幂等键 → 飞书静默去重（ok=true 但复用旧 message_id、不产生新消息）。
      // 现在只传"基名"，唯一后缀由 sendNotify 内部生成并保证 ≤50 字符。
      idempotencyKeyBase: `crosspost-${parsed.id}`,
      title: notifyTitle,
      summary: summaryLine,
      links,
      footer,
    })
    if (summary.notify.status === 'fail')
      errors.push({ what: 'notify', error: summary.notify.error })
    if (summary.notify.deduped) {
      // 飞书把这次发送去重了：不会产生新消息，必须留痕（此前这种情况前端仍显示"已发送"）
      errors.push({
        what: 'notify',
        error: `飞书去重：key ${summary.notify.key} 复用了 messageId ${summary.notify.messageId}，本次未产生新通知`,
      })
    }
  }

  // ---- 写文章库记录 ----
  // C-2（2026-08-26）：发布产物 HTML 归档 articles/<id>.html（供人工复盘/发布前检查）——
  // 优先复用微信通道已渲染 html（含图片 CDN 替换）；wechat:false 或渲染失败时独立渲染兜底
  let htmlFile = null
  if (!dryRun) {
    try {
      let html = wechatHtml
      if (!html) {
        const r = await renderMarkdownAsync(bodyRender, { style })
        html = r.html
      }
      const htmlPath = path.join(ensureArticlesDir(), `${parsed.id}.html`)
      fs.writeFileSync(htmlPath, html, 'utf8')
      htmlFile = path.basename(htmlPath)
    } catch (e) {
      errors.push({ what: 'htmlArchive', error: String((e && e.message) || e) })
    }
  }
  const prev = getRecord(parsed.id) || { createdAt: now }
  const wechatStatus = summary.wechat.status
  const platformOk = okList.length
  const platformTotal = platformOk + failList.length
  if (dryRun) {
    // dryRun（渲染测试）：不覆盖已有发布主字段,仅追加 history
    // C-2（2026-08-26）：dryRun 渲染 HTML 归档到文章库目录 <id>.dry.html，便于人工复盘/发布前检查
    let dryHtml = null
    try {
      const r = await renderMarkdownAsync(bodyRender, { style })
      const dryPath = path.join(ensureArticlesDir(), `${parsed.id}.dry.html`)
      fs.writeFileSync(dryPath, r.html, 'utf8')
      dryHtml = path.basename(dryPath)
    } catch (e) {
      errors.push({ what: 'dryHtml', error: String((e && e.message) || e) })
    }
    const saved = upsertRecord({
      ...prev,
      id: parsed.id,
      title,
      file,
      slot: parsed.slot,
      date: parsed.date,
      style: (prev && prev.style) || style,
      // 2026-08-28：dryRun 不覆盖已有发布主字段；新草稿则落初始值（此前缺失导致返回 wechat/platforms undefined）
      wechat: (prev && prev.wechat) || summary.wechat,
      platforms: (prev && prev.platforms) || summary.platforms,
      // C-3（2026-08-26）：编辑决策/独立审稿快照（AI 经 publish_article 传入，未传保持原记录）
      ...(req.decision !== undefined ? { decision: req.decision } : {}),
      ...(req.review !== undefined ? { review: req.review } : {}),
      ...(req.aiDetect !== undefined ? { aiDetect: req.aiDetect } : {}),
      risk: parsed.risk || (prev && prev.risk) || 'unclassified',
      score:
        score === null
          ? (prev && prev.score) || undefined
          : {
              total: score,
              ...(scoreDims ? { dims: scoreDims } : {}),
              ...(req.rewrites !== undefined && req.rewrites !== null
                ? { rewrites: Number(req.rewrites) }
                : {}),
              at: now,
            },
      history: [
        ...((prev && prev.history) || []),
        {
          action: 'dryRun',
          at: now,
          style,
          score: score === null ? undefined : score,
          wechat: prev.wechat?.status || 'none',
          note: '渲染测试,未发布',
          origin,
          ...(dryHtml ? { dryRunHtml: dryHtml } : {}),
          ...(req.decision !== undefined ? { decision: req.decision } : {}),
          ...(req.review !== undefined ? { review: req.review } : {}),
          ...(req.aiDetect !== undefined ? { aiDetect: req.aiDetect } : {}),
        },
      ],
      createdAt: prev.createdAt || now,
      updatedAt: now,
    })
    return {
      ok: true,
      id: parsed.id,
      title,
      slot: parsed.slot,
      date: parsed.date,
      style,
      styleWarning,
      dryRun,
      score,
      risk: parsed.risk || null,
      targetPlatforms: platforms,
      // 2026-09-12：派发回执——AI/日志一眼看出「本次没有推送」及原因（而非像 09-11 那样靠豁免开关来“提示”）
      origin,
      dispatch: dispatchEnabled ? 'dispatched' : 'skipped',
      autoPushEnabled: pushEnabled,
      skipReason: snapshotSkipReason || dispatch.skipReason,
      // 2026-08-28 修复：dryRun 用 summary（初始 skip/{}/none），勿用 saved.wechat（新草稿记录无 wechat 字段 → undefined）
      status: saved.status,
      wechat: summary.wechat,
      platforms: summary.platforms,
      notify: summary.notify,
      skip: skipList.map((s) => s.id),
      errors,
      record: saved,
      ...(dryHtml ? { htmlSaved: dryHtml } : {}),
    }
  }
  // 合并写入（2026-08-19 修复：整体覆盖会丢失历史平台明细）：
  const mergedPlatforms = { ...((prev && prev.platforms) || {}), ...summary.platforms }
  const mergedWechat =
    summary.wechat.status === 'skip' && prev && prev.wechat && prev.wechat.status !== 'none'
      ? prev.wechat
      : summary.wechat
  const pfAll = Object.values(mergedPlatforms)
  const pfOkAll = pfAll.filter((p) => p.status === 'ok').length
  const pfFailAll = pfAll.filter((p) => p.status === 'fail').length
  const mergedWechatOk = mergedWechat.status === 'ok'
  // 生成后自动推送关闭：仅落草稿（draft），不判 published/partial/failed（2026-09-09）
  const status = !dispatchEnabled
    ? 'draft'
    : (mergedWechatOk || pfOkAll > 0) && pfFailAll === 0
      ? 'published'
      : pfOkAll > 0 || mergedWechatOk
        ? 'partial'
        : 'failed'
  const record = {
    id: parsed.id,
    title,
    file,
    slot: parsed.slot,
    date: parsed.date,
    style,
    // C-3（2026-08-26）：编辑决策/独立审稿快照（AI 经 publish_article 传入，未传保持原记录）
    ...(req.decision !== undefined ? { decision: req.decision } : {}),
    ...(req.review !== undefined ? { review: req.review } : {}),
    ...(req.aiDetect !== undefined ? { aiDetect: req.aiDetect } : {}),
    risk: parsed.risk || (prev && prev.risk) || 'unclassified',
    score:
      score === null
        ? prev.score || undefined
        : {
            total: score,
            ...(scoreDims ? { dims: scoreDims } : {}),
            ...(req.rewrites !== undefined && req.rewrites !== null
              ? { rewrites: Number(req.rewrites) }
              : {}),
            at: now,
          },
    status,
    wechat: mergedWechat,
    platforms: mergedPlatforms,
    notify: summary.notify,
    history: [
      ...((prev && prev.history) || []),
      {
        action: dryRun ? 'dryRun' : dispatchEnabled ? 'publish' : 'draft-only',
        at: now,
        style,
        score: score === null ? undefined : score,
        wechat: wechatStatus,
        platforms: platformTotal ? `${platformOk}/${platformTotal}` : null,
        failed: failList,
        errors,
        note: dispatchEnabled ? undefined : '未开启自动推送,仅生成草稿',
        // 2026-09-12：来源留痕（定时/一键生成/人工），用于事后审计「这次是谁触发的、为什么没推」
        origin,
        ...(htmlFile ? { htmlFile } : {}),
        ...(req.decision !== undefined ? { decision: req.decision } : {}),
        ...(req.review !== undefined ? { review: req.review } : {}),
        ...(req.aiDetect !== undefined ? { aiDetect: req.aiDetect } : {}),
      },
    ],
    createdAt: prev.createdAt || now,
    updatedAt: now,
  }
  const saved = upsertRecord(record)

  return {
    ok: true,
    id: parsed.id,
    title,
    slot: parsed.slot,
    date: parsed.date,
    style,
    dryRun,
    score,
    risk: parsed.risk || null,
    targetPlatforms: platforms,
    // 2026-09-12：派发回执（见 dryRun 分支同名说明）
    origin,
    dispatch: dispatchEnabled ? 'dispatched' : 'skipped',
    autoPushEnabled: pushEnabled,
    skipReason: snapshotSkipReason || dispatch.skipReason,
    status,
    wechat: summary.wechat,
    platforms: summary.platforms,
    notify: summary.notify,
    skip: skipList.map((s) => s.id),
    errors,
    record: saved,
    ...(htmlFile ? { htmlFile } : {}),
  }
}

// 历史回填：解析器已抽到 adapters/backfill-run-logs.mjs（v2.01 引擎自治）。
// 此处再导出以保持既有 API 兼容（cli/tests 仍可从 publish.mjs 取用）。
export { parseRunLogLine }

export function normalizeTitle(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

export async function runBackfill(force) {
  // 2026-09-18（v2.01）：日志目录与解析器均改为可选适配器提供。
  // 默认关闭 → 返回结构化 capability_disabled，不再默认读取 drafts 同级 logs/。
  const collected = collectRunLogRows()
  if (collected.error) return collected
  const agg = collected.agg
  const records = scanAndList()
  let updated = 0
  let matched = 0
  let skipped = 0
  const details = []
  for (const rec of records) {
    if (!rec.date || !rec.slot || rec.slot === 'manual') {
      skipped++
      continue
    }
    const rows = agg.get(`${rec.date}|${rec.slot}`)
    if (!rows || !rows.length) {
      skipped++
      continue
    }
    const fileTitle =
      rec.file && fs.existsSync(rec.file) ? parseDraftFile(rec.file).title : rec.title
    let p = rows.find((r) => r.title && normalizeTitle(r.title) === normalizeTitle(fileTitle))
    if (!p) p = rows[rows.length - 1]
    matched++
    if (!force && (rec.backfill || (rec.status && rec.status !== 'draft'))) {
      skipped++
      continue
    }
    const now = new Date().toISOString()
    const wechat = p.wechatOk
      ? { status: 'ok', mediaId: p.mediaId || null, at: now, backfilled: true }
      : p.pub
        ? { status: 'fail', error: p.wechatFailReason || '历史失败', at: now, backfilled: true }
        : { status: 'none' }
    const platforms = {}
    if (p.failedPlatforms) {
      for (const id of p.failedPlatforms.split(/[、,，|]/)) {
        const t = id.trim()
        if (!t || t === '无' || t === '全部' || /[()（）]/.test(t) || t.length >= 30) continue
        platforms[t] = {
          status: 'fail',
          error: '历史回填（无 postUrl）',
          at: now,
          backfilled: true,
        }
      }
    }
    const status =
      wechat.status === 'fail' && p.okN === 0
        ? 'failed'
        : wechat.status === 'ok' && p.okN !== null && p.okN === p.totalN
          ? 'published'
          : 'partial'
    const saved = upsertRecord({
      ...rec,
      title: fileTitle,
      status,
      wechat,
      platforms,
      backfill: true,
      history: [
        ...(rec.history || []),
        {
          action: 'backfill',
          at: now,
          wechat: wechat.status,
          platforms: p.okN !== null ? `${p.okN}/${p.totalN}` : null,
          failed: p.failedPlatforms ? [p.failedPlatforms] : [],
          note: p.distNote || '历史日志回填（平台明细未记录）',
        },
      ],
      updatedAt: now,
    })
    updated++
    details.push({
      id: saved.id,
      date: rec.date,
      slot: rec.slot,
      status: saved.status,
      mediaId: !!saved.wechat.mediaId,
      note: p.distNote || '',
    })
  }
  return { ok: true, logs: files.length, matched, updated, skipped, details }
}

/** 手动补记（P5）：绕过 publishArticle 的历史/手动发布由用户标记状态 */
export async function runMarkPublished(req) {
  // 2026-08-31：草稿可能在子目录（archive/rejected/risk），用 findDraftFile 定位（顶层拼接会漏）
  const found = findDraftFile(req.id)
  let rec = getRecord(req.id)
  if (!rec) {
    if (!found) return { error: `草稿不存在: ${req.id}` }
    rec = ensureDraftRecord(parseDraftFile(found.file))
  }
  const now = new Date().toISOString()
  if (req.wechat && req.wechat !== 'none') {
    rec.wechat =
      req.wechat === 'skip'
        ? { status: 'skip', at: now }
        : {
            status: req.wechat,
            mediaId: req.mediaId || null,
            error: req.wechat === 'fail' ? req.note || '手动标记失败' : null,
            at: now,
          }
  }
  if (req.platforms && req.platforms.length) {
    for (const p of req.platforms) {
      rec.platforms[p.platform] = {
        platform: p.platform,
        status: p.status,
        postUrl: p.postUrl || null,
        error: p.error || null,
        at: now,
      }
    }
  }
  const wechatOk = rec.wechat && rec.wechat.status === 'ok'
  const pf = Object.values(rec.platforms || {})
  const okN = pf.filter((p) => p.status === 'ok').length
  const failN = pf.filter((p) => p.status === 'fail').length
  rec.status =
    (wechatOk || okN > 0) && failN === 0 ? 'published' : okN > 0 || wechatOk ? 'partial' : 'failed'
  rec.history = rec.history || []
  rec.history.push({
    action: 'mark',
    at: now,
    wechat: rec.wechat && rec.wechat.status,
    platforms: pf.length ? `${okN}/${pf.length}` : null,
    failed: pf.filter((p) => p.status === 'fail').map((p) => p.platform || p.id || 'unknown'),
    note: req.note || '手动补记',
  })
  const saved = upsertRecord(rec)
  return {
    ok: true,
    id: saved.id,
    status: saved.status,
    wechat: saved.wechat,
    platforms: saved.platforms,
    record: saved,
  }
}

/** 批量置为成功（2026-08-19 用户确认：历史草稿各平台已手动维护） */
export async function runMarkAllPublished() {
  const records = scanAndList()
  const now = new Date().toISOString()
  let updated = 0
  let archived = 0
  for (const rec of records) {
    if (rec.status === 'archived') {
      archived++
      continue
    }
    const next = { ...rec }
    let changed = false
    if (next.status !== 'published') {
      next.status = 'published'
      changed = true
    }
    if (next.wechat) {
      if (next.wechat.status === 'fail') {
        next.wechat = {
          status: 'ok',
          mediaId: next.wechat.mediaId || null,
          at: now,
          manualConfirmed: true,
        }
        changed = true
      } else if (next.wechat.status === 'none') {
        next.wechat = { status: 'ok', mediaId: null, at: now, manualConfirmed: true }
        changed = true
      }
    }
    if (next.platforms) {
      for (const [id, p] of Object.entries(next.platforms)) {
        if (p.status === 'fail') {
          next.platforms[id] = { ...p, status: 'ok', error: null, at: now, manualConfirmed: true }
          changed = true
        }
      }
    }
    if (!next.platforms || !Object.keys(next.platforms).length) {
      next.platforms = {}
      for (const pid of DEFAULT_PLATFORMS) {
        next.platforms[pid] = { status: 'ok', error: null, at: now, manualConfirmed: true }
      }
      changed = true
    }
    if (changed) {
      next.history = next.history || []
      next.history.push({
        action: 'mark',
        at: now,
        wechat: next.wechat && next.wechat.status,
        platforms: Object.keys(next.platforms || {}).length
          ? `${Object.values(next.platforms).filter((p) => p.status === 'ok').length}/${Object.keys(next.platforms).length}`
          : null,
        failed: [],
        note: '用户确认：历史草稿各平台已手动维护，状态统一置为成功',
      })
      next.updatedAt = now
      upsertRecord(next)
      updated++
    }
  }
  return { ok: true, updated, archived, total: records.length }
}

/**
 * 抖音"当前草稿箱"是**单槽**的：推新内容会覆盖旧的，所以每次成功推送后，要把
 * 其它记录上的 `douyinCurrent`/`douyinPushedAt` 清掉，只留刚推的那条。
 *
 * 2026-09-19（v2.68）修一处真缺陷：此循环原先遍历的是 `scanAndList()`，
 * 而它**顶层模式刻意排除** `archived`/`retained` 状态、以及
 * archive/rejected/risk 子目录里的记录 —— 于是那些记录上的指针**永远清不掉**。
 * 实测全库 26 条带 `douyinCurrent`，其中 **25 条是归档/留存记录**，
 * 而 Console 是用 `store.articles.find(a => a.douyinCurrent)` 找"当前草稿"的，
 * 在归档/详情视图里就可能把 📱 角标指到一篇老文章上。
 *
 * 改用 `listRecords()`：全量记录，不看状态、不看子目录 —— 这本来就是
 * "全局只有一个当前抖音草稿"这条不变量的正确取值域。
 *
 * 顺带去掉一个副作用：旧写法把扫描行的 `hasFile: true` 一起落盘了
 * （历史上有 104 条记录带这个展示用字段），现在写回的记录不含它。
 *
 * @param {string} exceptId 刚推送成功的那条（保留其指针）
 * @returns {string[]} 被清掉指针的记录 id
 */
export function clearOtherDouyinCurrent(exceptId) {
  const cleared = []
  for (const rec of listRecords()) {
    if (!rec || !rec.id || rec.id === exceptId || !rec.douyinCurrent) continue
    const next = { ...rec }
    delete next.douyinCurrent
    delete next.douyinPushedAt
    upsertRecord(next)
    cleared.push(rec.id)
  }
  return cleared
}

/** 抖音手动推送（2026-08-19 用户决策）：单槽草稿箱覆盖式，仅手动 */
export async function runPublishDouyin(req) {
  const rec = getRecord(req.id)
  let file = req.file
  if (!file && rec && rec.file && fs.existsSync(rec.file)) file = rec.file
  if (!file) {
    // 2026-08-31：草稿可能在子目录（archive/rejected/risk），用 findDraftFile 定位
    const found = findDraftFile(req.id)
    if (found) file = found.file
  }
  if (!file || !fs.existsSync(file)) return { error: `草稿不存在: ${req.id}` }
  const r = await runPublishArticle({
    file,
    style: req.style,
    platforms: ['douyin'],
    allowDouyin: true,
    // 2026-09-12：抖音仅手动通道（Console 按钮）→ 显式标人工来源，恒不受 autoPush 开关门控
    origin: req.origin || 'manual',
    wechat: false,
    notify: req.notify !== false,
    concurrency: 1,
  })
  if (r.error) return r
  const dy = r.platforms && r.platforms.douyin
  if (dy && dy.status === 'ok') {
    const now = new Date().toISOString()
    clearOtherDouyinCurrent(r.id)
    const rec = getRecord(r.id)
    if (rec) {
      rec.douyinCurrent = true
      rec.douyinPushedAt = now
      upsertRecord(rec)
    }
    r.douyinCurrent = { id: r.id, title: r.title, at: now }
  }
  return r
}
