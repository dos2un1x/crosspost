/**
 * 自定义样式协议（M9）——加载 / 校验 / 增删改查 / 旧目录只读兜底
 *
 * 目录优先级
 *   1. `$CROSSPOST_CUSTOM_STYLES_DIR`        —— 环境变量覆盖（测试与部署隔离靠它）
 *   2. `~/.config/crosspost/styles/`         —— 自有目录，**唯一写入位置**
 *   3. `$CROSSPOST_LEGACY_STYLES_DIR`        —— 旧目录**只读兜底**；路径只能由环境变量注入，
 *                                               本文件不含任何默认字面量，未设置即完全不读
 *
 * 协议要点：
 *  - 只加载 `custom-*.json`；文件名即样式名；同名时自有目录优先，内置样式永不被覆盖。
 *  - 字段一律以参数的 canonical 拼写为准；旧拼写别名（`border_width` / `headingStyle` …）
 *    在输入侧翻译后接受。
 *  - 旧式"逐元素完整样式串"字段（`cssTemplate`）**不读不写**：出现即告警并忽略。
 *  - 读取结果按「目录 + 目录 mtime + JSON 文件数」缓存；写操作直接失效缓存。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BASE_STYLE_PARAMS,
  BUILTIN_STYLES,
  STYLE_PARAM_KEYS,
  builtinStyleParams,
  resolveStyleParams,
  validateStyleParams,
  type StyleDefinition,
  type StyleParams,
} from './styles'

const CUSTOM_PREFIX = 'custom-'
const MAX_NAME_LENGTH = 60
/** 样式名允许字符：中英文、数字、下划线、连字符 */
const NAME_BODY_RE = /^[\u3400-\u9fffA-Za-z0-9_-]+$/
/**
 * 旧拼写 → canonical 拼写（输入侧翻译，硬需求）。
 *
 * 导出给"导入既有样式"的调用方：它们要在**写盘前**先按 canonical 键名规整取值
 * （旧文件里 `blockquote_bg` 这类键夹着渐变/`!important`），见 CLI 的 `styles install`。
 */
export const STYLE_FIELD_ALIASES: Record<string, string> = {
  border_width: 'borderWidth',
  headingStyle: 'headingStructure',
  h3_style: 'h3Structure',
  blockquoteStyle: 'blockquoteStructure',
  heading_bg: 'headingBg',
  heading_border_color: 'headingBorderColor',
  heading_color: 'headingColor',
  blockquote_bg: 'blockquoteBg',
  blockquote_border_color: 'blockquoteBorderColor',
}
/** 内部沿用短名：导出名加 `STYLE_` 前缀是为了在 core 的导出面上不与被适配器的 alias 混同 */
const FIELD_ALIASES = STYLE_FIELD_ALIASES
/** 旧式整元素样式串字段：识别出来只为拒绝，不参与任何推导 */
const DEPRECATED_TEMPLATE_FIELD = 'cssTemplate'
/** 仅供翻译/镜像的键：不写进样式文件，也不出现在"允许字段"提示里 */
const NON_EXPORT_KEYS = new Set<string>([
  DEPRECATED_TEMPLATE_FIELD,
  'headingStyle',
  'h3_style',
  'heading_bg',
  'heading_border_color',
  'heading_color',
  'h3_border_color',
  'blockquoteStyle',
  'blockquote_bg',
  'blockquote_border_color',
  'border_width',
])

export interface CustomStylesLoadResult {
  styles: Record<string, StyleDefinition>
  warnings: string[]
}

export interface StyleManagementResult {
  ok: boolean
  name?: string
  style?: StyleDefinition
  error?: string
  warnings?: string[]
}

export interface StyleNameCheck {
  ok: boolean
  name?: string
  error?: string
}

interface CustomStyleEntry {
  style: StyleDefinition
  /** 文件里**声明**的参数（用于克隆，不含派生量） */
  seed: StyleParams
}

interface CustomStyleCache {
  key: string
  entries: Record<string, CustomStyleEntry>
  warnings: string[]
}

let cache: CustomStyleCache | null = null

/* ── 目录 ─────────────────────────────────────────────────────────────── */

/** 自有样式目录：环境变量优先，其次 `~/.config/crosspost/styles` */
export function customStylesDir(): string {
  const env = process.env.CROSSPOST_CUSTOM_STYLES_DIR
  if (env && env.trim()) return env.trim()
  return path.join(os.homedir(), '.config', 'crosspost', 'styles')
}

/**
 * 旧样式目录（只读兜底）：**只从环境变量取**，未注入时返回空数组 = 完全不读。
 * `CROSSPOST_LEGACY_STYLES=0` 可立即关闭兼容读取。
 */
export function legacyStylesDirs(): string[] {
  if (process.env.CROSSPOST_LEGACY_STYLES === '0') return []
  const env = process.env.CROSSPOST_LEGACY_STYLES_DIR
  if (!env) return []
  return env
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 写操作后立即失效缓存（不依赖 mtime 分辨率） */
export function invalidateCustomStyleCache(): void {
  cache = null
}

function isStyleFile(file: string): boolean {
  return /\.json$/i.test(file)
}

function dirFingerprint(dir: string): string {
  try {
    const st = fs.statSync(dir)
    if (!st.isDirectory()) return `${dir}:not-dir`
    const count = fs.readdirSync(dir).filter(isStyleFile).length
    return `${dir}:${st.mtimeMs}:${count}`
  } catch {
    return `${dir}:missing`
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ── 单个样式文件 → 参数 ─────────────────────────────────────────────── */

/** 把一份样式 JSON 翻译成 canonical 参数并校验；不可用时返回 null（调用方已收到 warning） */
function styleFromRecord(
  name: string,
  record: Record<string, unknown>,
  warnings: string[],
): CustomStyleEntry | null {
  if (DEPRECATED_TEMPLATE_FIELD in record) {
    warnings.push(
      `样式 ${name} 含已废弃字段 ${DEPRECATED_TEMPLATE_FIELD}（旧式整元素样式串），已忽略：视觉一律由参数推导`,
    )
  }
  const canonical: Record<string, unknown> = {}
  const keys = Object.keys(record)
  // 旧拼写先翻译，canonical 拼写后写入 —— 同时存在时以 canonical 为准
  for (const key of keys.filter((k) => k in FIELD_ALIASES)) {
    if (record[key] !== undefined) canonical[FIELD_ALIASES[key]] = record[key]
  }
  for (const key of keys.filter((k) => !(k in FIELD_ALIASES))) {
    if (key === DEPRECATED_TEMPLATE_FIELD) continue
    if (record[key] !== undefined) canonical[key] = record[key]
  }

  const checked = validateStyleParams(canonical)
  if (!checked.ok) {
    warnings.push(`样式 ${name} 校验失败（${checked.error}），已跳过`)
    return null
  }
  for (const w of checked.warnings) warnings.push(`样式 ${name}: ${w}`)
  if (checked.unknownKeys.length) {
    warnings.push(`样式 ${name} 含未知字段，已忽略: ${checked.unknownKeys.join(', ')}`)
  }

  const params: StyleParams = {
    ...BASE_STYLE_PARAMS,
    ...checked.params,
    category: 'custom',
    desc: checked.params.desc || '自定义样式',
  }
  return {
    style: resolveStyleParams(params),
    seed: { ...checked.params, category: 'custom' },
  }
}

function scanDir(
  dir: string,
  isLegacy: boolean,
  entries: Record<string, CustomStyleEntry>,
  taken: Set<string>,
  warnings: string[],
): void {
  if (!fs.existsSync(dir)) return // 首次使用是常态：不存在不报错、不告警
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch (err) {
    warnings.push(`自定义样式目录不可读（${dir}）: ${errText(err)}`)
    return
  }
  for (const file of [...files].sort()) {
    if (!isStyleFile(file)) {
      warnings.push(`跳过非 JSON 文件: ${file}`)
      continue
    }
    const name = file.replace(/\.json$/i, '')
    if (!name.startsWith(CUSTOM_PREFIX)) {
      warnings.push(`跳过未以 ${CUSTOM_PREFIX} 命名的样式文件: ${file}`)
      continue
    }
    if (taken.has(name)) continue // 自有目录优先，旧目录同名不再参与
    let text: string
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8')
    } catch (err) {
      warnings.push(`样式文件读取失败（${file}）: ${errText(err)}`)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      warnings.push(`样式文件 JSON 解析失败（${file}）: ${errText(err)}`)
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(`样式文件不是 JSON 对象（${file}），已跳过`)
      continue
    }
    const entry = styleFromRecord(name, parsed as Record<string, unknown>, warnings)
    if (!entry) continue
    entries[name] = entry
    taken.add(name)
    if (isLegacy) {
      // 旧目录是**只读兜底**（路径只从 CROSSPOST_LEGACY_STYLES_DIR 注入）：样式能读不能用不可写，
      // 所以要指名"迁到哪、怎么迁"。此前这里写"请运行样式迁移"——而仓库里并没有那个命令。
      warnings.push(
        `样式 ${name} 来自旧目录（只读兜底），请迁移到自有目录后使用：` +
          `把该样式的字段改写进 ${customStylesDir()}/${name}.json` +
          `（字段拼写见 allowedStyleFields()；旧拼写与 cssTemplate 会被忽略）`,
      )
    }
  }
}

function loadEntries(): { entries: Record<string, CustomStyleEntry>; warnings: string[] } {
  const writeDir = customStylesDir()
  const legacyDirs = legacyStylesDirs()
  const key = [dirFingerprint(writeDir), ...legacyDirs.map(dirFingerprint)].join('|')
  if (cache && cache.key === key) return { entries: cache.entries, warnings: [...cache.warnings] }

  const entries: Record<string, CustomStyleEntry> = {}
  const taken = new Set<string>()
  const warnings: string[] = []
  scanDir(writeDir, false, entries, taken, warnings)
  for (const dir of legacyDirs) scanDir(dir, true, entries, taken, warnings)
  cache = { key, entries, warnings }
  return { entries, warnings: [...warnings] }
}

/** 全部自定义样式（自有目录 + 旧目录只读兜底） */
export function loadCustomStyles(): CustomStylesLoadResult {
  const { entries, warnings } = loadEntries()
  const styles: Record<string, StyleDefinition> = {}
  for (const [name, entry] of Object.entries(entries)) styles[name] = entry.style
  return { styles, warnings }
}

/** 解析样式名 → 样式定义（内置优先；找不到时 style 为 undefined，由调用方决定如何报错） */
export function resolveStyle(name: string): { style?: StyleDefinition; warnings: string[] } {
  const raw = String(name ?? '').trim()
  if (BUILTIN_STYLES[raw]) return { style: BUILTIN_STYLES[raw], warnings: [] }
  const { styles, warnings } = loadCustomStyles()
  if (styles[raw]) return { style: styles[raw], warnings }
  const checked = normalizeStyleName(raw)
  if (checked.ok && checked.name && styles[checked.name]) {
    return { style: styles[checked.name], warnings }
  }
  return { warnings }
}

/* ── 命名规则 ─────────────────────────────────────────────────────────── */

/** 样式名归一：自动补 `custom-` 前缀并校验字符与长度 */
export function normalizeStyleName(name: string): StyleNameCheck {
  const raw = String(name ?? '').trim()
  if (!raw) return { ok: false, error: '样式名不能为空' }
  const body = raw.toLowerCase().startsWith(CUSTOM_PREFIX) ? raw.slice(CUSTOM_PREFIX.length) : raw
  if (!body) return { ok: false, error: '样式名不能为空' }
  if (!NAME_BODY_RE.test(body)) {
    return {
      ok: false,
      error: `样式名含非法字符（只允许中英文、数字、下划线、连字符）: ${raw}`,
    }
  }
  const full = `${CUSTOM_PREFIX}${body}`
  if (full.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `样式名过长（上限 ${MAX_NAME_LENGTH} 字符）: ${full}` }
  }
  return { ok: true, name: full }
}

/** 可覆盖的字段名（canonical，排除仅供翻译的旧拼写） */
export function allowedStyleFields(): string[] {
  return [...STYLE_PARAM_KEYS].filter((k) => !NON_EXPORT_KEYS.has(k)).sort()
}

/* ── 增删改查 ─────────────────────────────────────────────────────────── */

function translateOverrides(overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const keys = Object.keys(overrides)
  for (const key of keys.filter((k) => k in FIELD_ALIASES)) {
    if (overrides[key] !== undefined) out[FIELD_ALIASES[key]] = overrides[key]
  }
  for (const key of keys.filter((k) => !(k in FIELD_ALIASES))) {
    if (overrides[key] !== undefined) out[key] = overrides[key]
  }
  return out
}

/** 写入样式文件的内容：只导出声明过、且不属于旧拼写的参数 */
function serializeStyleFile(params: StyleParams): string {
  const record: Record<string, unknown> = {}
  for (const key of STYLE_PARAM_KEYS) {
    if (NON_EXPORT_KEYS.has(key)) continue
    const value = (params as unknown as Record<string, unknown>)[key]
    if (value === undefined || value === null) continue
    record[key] = value
  }
  record.category = 'custom'
  return `${JSON.stringify(record, null, 2)}\n`
}

function entrySeed(name: string): StyleParams | undefined {
  const builtin = builtinStyleParams(name)
  if (builtin) return builtin
  const checked = normalizeStyleName(name)
  const key = checked.ok && checked.name ? checked.name : name
  return loadEntries().entries[key]?.seed
}

/**
 * 新建：以模板样式（内置或已有自定义）的参数为基底，覆盖白名单字段后落盘。
 * 只写自有目录；旧目录永不写入。
 */
export function createCustomStyle(
  name: string,
  sourceName?: string,
  overrides: Record<string, unknown> = {},
): StyleManagementResult {
  const checked = normalizeStyleName(name)
  if (!checked.ok || !checked.name) return { ok: false, error: checked.error }
  const styleName = checked.name
  if (BUILTIN_STYLES[styleName]) return { ok: false, error: `内置样式不可改: ${styleName}` }

  const dir = customStylesDir()
  const target = path.join(dir, `${styleName}.json`)
  if (fs.existsSync(target)) return { ok: false, error: `样式已存在: ${styleName}` }

  let seed: StyleParams
  if (sourceName) {
    const fromTemplate = entrySeed(sourceName)
    if (!fromTemplate) return { ok: false, error: `模板样式不存在: ${sourceName}` }
    seed = { ...BASE_STYLE_PARAMS, ...fromTemplate }
  } else {
    seed = { ...BASE_STYLE_PARAMS }
  }

  const translated = translateOverrides(overrides ?? {})
  const merged: Record<string, unknown> = { ...seed, ...translated, category: 'custom' }
  const v = validateStyleParams(merged)
  if (v.unknownKeys.length) {
    return {
      ok: false,
      error: `不支持的样式字段: ${v.unknownKeys.join(', ')}；允许字段: ${allowedStyleFields().join('/')}`,
    }
  }
  if (!v.ok) return { ok: false, error: v.error }
  if (v.warnings.length) return { ok: false, error: `样式参数不合法: ${v.warnings.join('; ')}` }

  const params: StyleParams = {
    ...v.params,
    category: 'custom',
    desc: v.params.desc ?? seed.desc ?? '',
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(target, serializeStyleFile(params), 'utf8')
  } catch (err) {
    return { ok: false, error: `样式写入失败（${target}）: ${errText(err)}` }
  }
  invalidateCustomStyleCache()
  return { ok: true, name: styleName, style: resolveStyleParams(params) }
}

/** 改名：只改文件名（样式名 = 文件名） */
export function renameCustomStyle(oldName: string, newName: string): StyleManagementResult {
  const rawOld = String(oldName ?? '').trim()
  if (BUILTIN_STYLES[rawOld]) return { ok: false, error: `内置样式不可改: ${rawOld}` }
  const from = normalizeStyleName(oldName)
  if (!from.ok || !from.name) return { ok: false, error: from.error }
  const to = normalizeStyleName(newName)
  if (!to.ok || !to.name) return { ok: false, error: to.error }
  if (BUILTIN_STYLES[to.name]) return { ok: false, error: `内置样式不可改: ${to.name}` }
  if (from.name === to.name) return { ok: true, name: to.name }

  const dir = customStylesDir()
  const oldFile = path.join(dir, `${from.name}.json`)
  const newFile = path.join(dir, `${to.name}.json`)
  if (!fs.existsSync(oldFile)) return { ok: false, error: `样式不存在: ${from.name}` }
  if (fs.existsSync(newFile)) return { ok: false, error: `样式已存在: ${to.name}` }
  try {
    fs.renameSync(oldFile, newFile)
  } catch (err) {
    return { ok: false, error: `样式改名失败: ${errText(err)}` }
  }
  invalidateCustomStyleCache()
  const result = showCustomStyle(to.name)
  return { ...result, name: to.name }
}

/** 删除：只能删自有目录里的自定义样式 */
export function deleteCustomStyle(name: string): StyleManagementResult {
  const raw = String(name ?? '').trim()
  if (BUILTIN_STYLES[raw]) return { ok: false, error: `样式不存在: ${raw}` }
  const checked = normalizeStyleName(name)
  if (!checked.ok || !checked.name) return { ok: false, error: checked.error }
  const file = path.join(customStylesDir(), `${checked.name}.json`)
  if (!fs.existsSync(file)) return { ok: false, error: `样式不存在: ${checked.name}` }
  try {
    fs.rmSync(file)
  } catch (err) {
    return { ok: false, error: `样式删除失败: ${errText(err)}` }
  }
  invalidateCustomStyleCache()
  return { ok: true, name: checked.name }
}

/** 查看：内置直接返回内置参数，自定义返回文件参数 */
export function showCustomStyle(name: string): StyleManagementResult {
  const raw = String(name ?? '').trim()
  // 只查自定义样式：内置样式名会被归一成 `custom-<名>`，于是照常得到"样式不存在"而不是被当成内置。
  // （"让 `show` 也能查内置"是个合理的产品改进，但它属于**有意变更**，不在本次等价范围内。）
  const checked = normalizeStyleName(raw)
  if (!checked.ok || !checked.name) return { ok: false, error: checked.error }
  const entry = loadEntries().entries[checked.name]
  if (!entry) return { ok: false, error: `样式不存在: ${checked.name}` }
  return { ok: true, name: checked.name, style: entry.style }
}
