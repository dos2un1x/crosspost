/**
 * 样式/封面/结束语/样式提取域（2026-09-01 从 cli.mjs 迁出）。
 *
 * 错误约定：参数/文件校验失败返回 { error }（无前缀）；渲染/生成抛错由 cli.mjs 的 wrap() 加前缀包装。
 * console.error 仍经 cli.mjs installCliLogger 捕获（同进程全局 console 覆盖）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig } from '../config-cache.mjs'
import { makeImageUploader } from './platforms.mjs'
import { syncArticle } from './publish.mjs'
import {
  renderMarkdown,
  renderMarkdownAsync,
  listStyleNames,
  BUILTIN_STYLES,
  loadCustomStyles,
  generateCoverSet,
  generateCoverGallery as genCoverGallery,
  generateEndingCard as genEndingCard,
  COVER_TEMPLATE_NAMES,
  analyzeStyleFromHtml,
  analyzeStyleFromUrl,
  generateCustomStyleName,
  createCustomStyle,
  renameCustomStyle,
  deleteCustomStyle,
  showCustomStyle,
  customStylesDir,
  STYLE_COLOR_FIELDS,
  STYLE_FIELD_ALIASES,
  BASE_STYLE_PARAMS,
  validateStyleParams,
} from '@crosspost/core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 随仓库分发的起手样式包：`crosspost-runtime/styles/*.json` */
const STYLES_PACK_DIR = path.resolve(__dirname, '..', '..', 'styles')

/** 任意抛出物 → 一行文案 */
const errText = (err) => String((err && err.message) || err)

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * 规整一份待导入的记录：① 旧拼写翻成 canonical（canonical 优先，`cssTemplate` 丢弃）；
 * ② 颜色字段去 ` !important`、渐变取串里第一个 hex。
 *
 * 旧样式文件（上游工具写的、以及早期手工改的）普遍这么写，直接喂模型会被判非法；
 * `styles install` 要能把它们**装进来**并逐条报告改了什么，而不是整批失败。
 */
function normalizeImportedRecord(record) {
  const translated = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === 'cssTemplate') continue
    const canonical = STYLE_FIELD_ALIASES[key] ?? key
    if (translated[canonical] === undefined) translated[canonical] = value
  }
  const out = {}
  const notes = []
  for (const [key, raw] of Object.entries(translated)) {
    let value = raw
    if (typeof value === 'string') {
      const stripped = value.replace(/\s*!important\s*$/i, '').trim()
      if (stripped !== value) {
        notes.push(`${key}: 去掉 !important`)
        value = stripped
      }
    }
    if (
      STYLE_COLOR_FIELDS.includes(key) &&
      typeof value === 'string' &&
      !HEX_RE.test(value.trim())
    ) {
      const hit = /#([0-9a-f]{6}|[0-9a-f]{3})/i.exec(value)
      const fixed = hit ? `#${hit[1]}` : '#ffffff'
      notes.push(`${key}: 取值规整 ${value.slice(0, 24)}… → ${fixed}`)
      value = fixed
    }
    out[key] = value
  }
  if ('cssTemplate' in record) notes.push('cssTemplate: 丢弃（模型已废弃该字段）')
  return { record: out, notes }
}

/**
 * `styles install [<dir>] [--force] [--dry]`：把一份样式包装进自有目录。
 *
 * 缺省装仓库自带的起手包（`crosspost-runtime/styles/`，55 个）；也可以指向**旧目录**
 * 做一次性迁移（旧拼写翻译、`cssTemplate` 忽略、颜色字段规整）。逐个校验：
 * 坏文件只报错、不写盘、不中断其余条目；`--dry` 走**同一套校验**，只差最后不落盘。
 */
export function installStyles(args = []) {
  const force = args.includes('--force')
  const dry = args.includes('--dry')
  const dirArg = args.find((a) => !String(a).startsWith('--'))
  const dir = dirArg ? path.resolve(String(dirArg)) : STYLES_PACK_DIR
  if (!fs.existsSync(dir)) return { error: `样式目录不存在: ${dir}` }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  const own = customStylesDir()
  const installed = []
  const skipped = []
  const failed = []
  const normalized = []

  for (const file of files) {
    const name = path.basename(file, '.json')
    if (BUILTIN_STYLES[name]) {
      skipped.push({ name, why: '内置样式不可覆盖' })
      continue
    }
    let record
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    } catch (err) {
      failed.push({ name, error: `读取失败：${errText(err)}` })
      continue
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      failed.push({ name, error: '不是 JSON 对象' })
      continue
    }
    const cleaned = normalizeImportedRecord(record)
    if (cleaned.notes.length) normalized.push({ name, notes: cleaned.notes })

    // 先判能不能过模型：这样 `--dry` 的结论与真装一致，坏文件也不会等到写盘才发现
    const checked = validateStyleParams({
      ...BASE_STYLE_PARAMS,
      ...cleaned.record,
      category: 'custom',
    })
    if (!checked.ok || checked.warnings.length) {
      failed.push({ name, error: checked.error || checked.warnings.join('; ') })
      continue
    }

    const target = path.join(own, `${name}.json`)
    if (fs.existsSync(target) && !force) {
      skipped.push({ name, why: '已存在（--force 可覆盖）' })
      continue
    }
    if (dry) {
      installed.push({ name, dry: true })
      continue
    }
    if (force && fs.existsSync(target)) fs.rmSync(target)
    const r = createCustomStyle(name, undefined, cleaned.record)
    if (r.ok) installed.push({ name })
    else failed.push({ name, error: r.error })
  }

  return {
    dir,
    own,
    counts: {
      total: files.length,
      installed: installed.length,
      skipped: skipped.length,
      failed: failed.length,
    },
    installed,
    skipped,
    failed,
    normalized,
    ...(failed.length
      ? {
          hint:
            '失败的条目看 error：多为取值不在允许范围（颜色要 hex、长度要 px/em/rem/%）。' +
            '可用 `styles show <内置名>` 看一个合法样例。',
        }
      : {}),
  }
}

/** 读 config.json（样式/模板设置）——统一走 config-cache，失败返回空对象 */
function readCliConfig() {
  return readConfig()
}
/** 禁用样式集合 */
function disabledStyleSet() {
  const c = readCliConfig()
  return new Set((c.styles && c.styles.disabled) || [])
}
/** 封面/结束语模板设置 */
function templateSettings() {
  const c = readCliConfig()
  const cs = c.coverSettings || {}
  return {
    defaultTemplate: cs.defaultTemplate || 'nebula',
    endingTemplate: cs.endingTemplate || cs.defaultTemplate || 'nebula',
    disabled: new Set(cs.disabledTemplates || []),
  }
}
/** 样式禁用回退：命中返回默认样式并附带 warning */
function effectiveStyle(name) {
  const disabled = disabledStyleSet()
  if (disabled.has(name))
    return { style: 'swiss', warning: `样式已禁用: ${name}，已回退默认 swiss` }
  return { style: name || 'swiss', warning: null }
}
/** 安全读取 custom 样式表（失败返回空对象） */
function loadCustomStylesSafe() {
  try {
    return loadCustomStyles().styles
  } catch {
    return {}
  }
}

/** listStyles：列出可用样式（内置 + custom），附 enabled 清单与 counts */
export function listStyles() {
  const names = listStyleNames()
  const customs = loadCustomStylesSafe()
  const disabled = disabledStyleSet()
  const styles = names.map((name) => {
    const builtin = BUILTIN_STYLES[name]
    const enabled = !disabled.has(name)
    if (builtin)
      return {
        name,
        category: builtin.category,
        desc: builtin.desc,
        bg: builtin.bg,
        accent: builtin.accent,
        enabled,
      }
    const c = customs[name] || {}
    return {
      name,
      category: 'custom',
      desc: c.desc || '自定义样式',
      bg: c.bg,
      accent: c.accent,
      enabled,
    }
  })
  return {
    styles,
    available_styles: styles.filter((s) => s.enabled).map((s) => s.name),
    counts: {
      total: styles.length,
      enabled: styles.filter((s) => s.enabled).length,
      disabled: styles.filter((s) => !s.enabled).length,
    },
  }
}

/** listCoverTemplates → 封面/结束语模板名 */
export function listCoverTemplates() {
  return { templates: COVER_TEMPLATE_NAMES }
}

/** renderPreview <mdPath> <style> [--out-html <path>]（纯本地零网络） */
export function renderPreview(args) {
  const mdPath = args[0]
  const rawStyle = args[1] || 'swiss'
  const eff = effectiveStyle(rawStyle)
  if (!mdPath || !fs.existsSync(mdPath)) return { error: `md file not found: ${mdPath}` }
  const md = fs.readFileSync(mdPath, 'utf8')
  // 2026-09-05 编写工作台同步：开启 blocks 选项 → 渲染产物打 data-block + 返回源码块范围
  // 2026-09-09 预览逐行对齐：breaks:true → 每个换行渲染为 <br>，左侧每行源码在右侧各占一行，左右更直观对齐
  const r = renderMarkdown(md, { style: eff.style, blocks: true, breaks: true })
  if (eff.warning) r.warnings = [...(r.warnings || []), eff.warning]
  const out = {
    style: r.styleName,
    warnings: r.warnings,
    html: r.html,
    blocks: r.blocks || [],
    blockCount: (r.blocks || []).length,
  }
  const tail = args[args.length - 1]
  if (tail && tail.startsWith('--out-html=')) {
    const dest = tail.slice('--out-html='.length)
    fs.writeFileSync(dest, r.html, 'utf8')
    out.outFile = dest
  }
  return out
}

/** syncStyledArticle：req.article 带 style 字段，渲染后同步 */
export async function syncStyledArticle(req) {
  const eff = effectiveStyle((req.article && req.article.style) || 'swiss')
  const md = (req.article && req.article.markdown) || ''
  const mdPath = (req.article && req.article.mdPath) || null
  const uploader = await makeImageUploader()
  const r = uploader
    ? await renderMarkdownAsync(md, { style: eff.style, mdPath, imageUploader: uploader })
    : renderMarkdown(md, { style: eff.style })
  if (eff.warning) r.warnings = [...(r.warnings || []), eff.warning]
  const styled = { ...(req.article || {}), html: r.html, markdown: md }
  return {
    style: r.styleName,
    warnings: r.warnings,
    images: (r.images && { handled: r.images.handled, failed: r.images.failed }) || null,
    results: await syncArticle({ ...req, article: styled }),
  }
}

/** generateCover <title> <template> [--out-dir] [--subtitle] [--tag] → 双尺寸封面 PNG */
export async function generateCover(args) {
  const title = args[0]
  const ts = templateSettings()
  let template = args[1] || ts.defaultTemplate
  if (ts.disabled.has(template)) {
    template = ts.defaultTemplate
    console.error(`模板已禁用，回退默认: ${template}`)
  }
  const tail = args.join(' ')
  let outDir = null,
    subtitle = '',
    tag = ''
  const mOut = /--out-dir=([^\s]+)/.exec(tail)
  const mSub = /--subtitle=(.+?)( --|$)/.exec(tail)
  const mTag = /--tag=(.+?)( --|$)/.exec(tail)
  if (mOut) outDir = mOut[1]
  if (mSub) subtitle = mSub[1]
  if (mTag) tag = mTag[1]
  if (!title) return { error: '缺少 title' }
  const r = await generateCoverSet({
    title,
    template,
    subtitle,
    tag,
    outDir: outDir || '/tmp/crosspost-cover',
  })
  return {
    ok: !!(r.cover2_35_1.ok && r.cover1_1.ok),
    template,
    cover2_35_1: r.cover2_35_1.path,
    cover1_1: r.cover1_1.path,
    error: r.cover2_35_1.error || r.cover1_1.error || null,
  }
}

/** generateCoverGallery <title> [--out-dir] [--subtitle] [--tag] → 模板画廊拼图 */
export async function generateCoverGallery(args) {
  const title = args[0]
  const tail = args.join(' ')
  const mOut = /--out-dir=([^\s]+)/.exec(tail)
  const mSub = /--subtitle=(.+?)( --|$)/.exec(tail)
  const mTag = /--tag=(.+?)( --|$)/.exec(tail)
  if (!title) return { error: '缺少 title' }
  const r = await genCoverGallery({
    title,
    subtitle: mSub ? mSub[1] : '',
    tag: mTag ? mTag[1] : '',
    outDir: mOut ? mOut[1] : '/tmp/crosspost-cover-gallery',
  })
  return r.ok ? { ok: true, path: r.path } : { ok: false, error: r.error }
}

/** generateEndingCard [--template <t>] [--out <path>] → 结尾结束语图片 PNG */
export async function generateEndingCard(args) {
  const tail = args.join(' ')
  const ts = templateSettings()
  const mTpl = /--template=([^\s]+)/.exec(tail)
  const mOut = /--out=([^\s]+)/.exec(tail)
  let tpl = mTpl ? mTpl[1] : ts.endingTemplate
  if (ts.disabled.has(tpl)) {
    tpl = ts.endingTemplate
    console.error(`模板已禁用，回退默认: ${tpl}`)
  }
  const r = await genEndingCard({
    template: tpl,
    outPath: mOut ? mOut[1] : '/tmp/crosspost-ending-card.png',
  })
  return r.ok ? { ok: true, path: r.path } : { ok: false, error: r.error }
}

/** analyzeStyle <url|htmlPath> [--name custom-xxx]：提取样式 */
export async function analyzeStyle(args) {
  const target = args[0]
  const tail = args[args.length - 1]
  let name = null
  if (tail && tail.startsWith('--name=')) name = tail.slice('--name='.length)
  if (!target) return { error: '需要 URL 或本地 HTML 路径' }
  let analyzed, method
  if (/^https?:\/\//.test(target)) {
    const r = await analyzeStyleFromUrl(target)
    analyzed = r.style
    method = r.method
    if (r.error) return { error: r.error }
  } else if (fs.existsSync(target)) {
    const r = await analyzeStyleFromHtml(fs.readFileSync(target, 'utf8'))
    analyzed = r.style
    method = r.method
  } else {
    return { error: `文件不存在: ${target}` }
  }
  if (!analyzed || !analyzed.bg) return { error: '样式提取失败（无有效背景色）' }
  const cleaned = {
    desc: `源自 ${analyzed.source_title || target}`,
    bg: analyzed.bg,
    accent: analyzed.accent,
    text: analyzed.text,
    secondary: analyzed.secondary,
    font: analyzed.font,
    border_width: analyzed.border_width,
  }
  if (analyzed.heading_style) cleaned.headingStyle = analyzed.heading_style
  if (analyzed.heading_bg) cleaned.heading_bg = analyzed.heading_bg
  if (analyzed.heading_border_color) cleaned.heading_border_color = analyzed.heading_border_color
  if (analyzed.heading_color) cleaned.heading_color = analyzed.heading_color
  if (analyzed.h3_style) cleaned.h3_style = analyzed.h3_style
  if (analyzed.h3_border_color) cleaned.h3_border_color = analyzed.h3_border_color
  if (analyzed.blockquote_style) cleaned.blockquoteStyle = analyzed.blockquote_style
  if (analyzed.blockquote_bg) cleaned.blockquote_bg = analyzed.blockquote_bg
  if (analyzed.blockquote_border_color)
    cleaned.blockquote_border_color = analyzed.blockquote_border_color
  const styleName = name || generateCustomStyleName(analyzed.source_title)
  const saved = createCustomStyle(styleName, undefined, cleaned)
  return {
    method,
    analyzed: {
      bg: analyzed.bg,
      text: analyzed.text,
      accent: analyzed.accent,
      font: analyzed.font,
      border_width: analyzed.border_width,
      heading_style: analyzed.heading_style,
      blockquote_style: analyzed.blockquote_style,
    },
    saved,
  }
}

/** styles <sub> ... 子命令 */
export function styles(args) {
  const rest = args
  const sub = rest[0]
  const subArgs = rest.slice(1)
  if (sub === 'new') {
    const name = subArgs[0]
    const fromIdx = subArgs.indexOf('--from')
    const from = fromIdx >= 0 ? subArgs[fromIdx + 1] : undefined
    const params = {}
    for (const a of subArgs) {
      if (a.startsWith('--set=')) {
        const kv = a.slice('--set='.length)
        const eq = kv.indexOf('=')
        if (eq > 0) params[kv.slice(0, eq)] = kv.slice(eq + 1)
      }
    }
    return createCustomStyle(name, from, params)
  } else if (sub === 'rename') {
    return renameCustomStyle(subArgs[0], subArgs[1])
  } else if (sub === 'delete') {
    return deleteCustomStyle(subArgs[0])
  } else if (sub === 'show') {
    return showCustomStyle(subArgs[0])
  } else if (sub === 'install') {
    return installStyles(subArgs)
  }
  return {
    error:
      'styles 子命令: new <name> [--from tpl] [--set k=v ...] | rename <old> <new> | delete <name> | ' +
      'show <name> | install [<dir>] [--force] [--dry]',
  }
}
