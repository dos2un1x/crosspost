// 起手样式包 + `styles install` 的契约（2026-09-29）
//
// 两件事必须一直被守住：
//   ① **包本身必须始终合法** —— 包是随仓库分发的数据，样式模型改了而包没跟上的话，
//      使用者装上就是一堆报错；这条判据让"模型漂了"在 CI 里就红，而不是等到使用者手上。
//   ② `styles install` 的语义 —— 幂等（第二次全跳过）、`--force` 才覆盖、坏文件只报错不中断、
//      旧格式（旧拼写 / cssTemplate / `!important` / 渐变）能被翻译与规整。
//
// 全程不碰真实样式目录：用 `CROSSPOST_CUSTOM_STYLES_DIR` 指到临时目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
const PACK_DIR = path.join(RUNTIME, 'styles')

const CORE = path.join(RUNTIME, 'core', 'dist', 'index.mjs')
const { BASE_STYLE_PARAMS, BUILTIN_STYLES, validateStyleParams } = await import(CORE)
const { installStyles } = await import('../src/commands/cover-styles.mjs')

/** 临时目录登记，进程退出统一清理 */
const tmpRoots = []
function tmpdir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cp-styles-${tag}-`))
  tmpRoots.push(d)
  return d
}
process.on('exit', () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true })
})

/** 在隔离的样式目录里跑一段逻辑（CROSSPOST_CUSTOM_STYLES_DIR 是运行时读的） */
function withStylesDir(dir, fn) {
  const prev = process.env.CROSSPOST_CUSTOM_STYLES_DIR
  process.env.CROSSPOST_CUSTOM_STYLES_DIR = dir
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.CROSSPOST_CUSTOM_STYLES_DIR
    else process.env.CROSSPOST_CUSTOM_STYLES_DIR = prev
  }
}

test('样式包：55 个文件，全部是当前模型的合法样式', () => {
  assert.ok(fs.existsSync(PACK_DIR), `起手包目录不存在：${PACK_DIR}`)
  const files = fs.readdirSync(PACK_DIR).filter((f) => f.endsWith('.json'))
  assert.ok(files.length >= 50, `起手包文件太少：${files.length}`)

  const bad = []
  for (const file of files) {
    const name = path.basename(file, '.json')
    if (!name.startsWith('custom-')) bad.push(`${name}: 名字必须是 custom-*`)
    if (BUILTIN_STYLES[name]) bad.push(`${name}: 与内置样式重名`)
    let record
    try {
      record = JSON.parse(fs.readFileSync(path.join(PACK_DIR, file), 'utf8'))
    } catch (err) {
      bad.push(`${name}: JSON 解析失败 ${String((err && err.message) || err)}`)
      continue
    }
    const checked = validateStyleParams({ ...BASE_STYLE_PARAMS, ...record, category: 'custom' })
    if (!checked.ok) bad.push(`${name}: ${checked.error}`)
    else if (checked.warnings.length) bad.push(`${name}: ${checked.warnings.join('; ')}`)
    else if (checked.unknownKeys.length)
      bad.push(`${name}: 含未知字段 ${checked.unknownKeys.join(', ')}`)
    if (!record.desc) bad.push(`${name}: 缺 desc（下拉里会显示成光秃秃的名字）`)
  }
  assert.deepEqual(
    bad,
    [],
    `起手包里有不合法的样式（模型改了要同步更新包）：\n  ${bad.join('\n  ')}`,
  )
})

test('styles install：装进隔离目录 → 幂等跳过 → --force 覆盖', () => {
  const own = tmpdir('own')

  const first = withStylesDir(own, () => installStyles([]))
  assert.equal(first.dir, PACK_DIR, '缺省装仓库自带的起手包')
  assert.equal(first.counts.failed, 0, `不该有失败：${JSON.stringify(first.failed)}`)
  assert.ok(first.counts.installed >= 50, `装进来的太少：${first.counts.installed}`)
  assert.equal(
    fs.readdirSync(own).filter((f) => f.endsWith('.json')).length,
    first.counts.installed,
    '报告数与落盘数必须一致',
  )

  // 幂等：第二次全部"已存在"跳过，不覆盖
  const second = withStylesDir(own, () => installStyles([]))
  assert.equal(second.counts.installed, 0)
  assert.equal(second.counts.skipped, second.counts.total)

  // --dry 与真装同一套校验，但不写盘
  const dryOwn = tmpdir('dry')
  const dry = withStylesDir(dryOwn, () => installStyles(['--dry']))
  assert.equal(dry.counts.failed, 0)
  assert.equal(dry.counts.installed, first.counts.installed)
  assert.deepEqual(fs.readdirSync(dryOwn), [], '--dry 不能落盘')

  // --force 才覆盖
  const forced = withStylesDir(own, () => installStyles(['--force']))
  assert.equal(forced.counts.installed, first.counts.installed)
  assert.equal(forced.counts.skipped, 0)
})

test('styles install：旧格式（旧拼写 / cssTemplate / !important / 渐变）能被翻译规整', () => {
  const src = tmpdir('legacy')
  const own = tmpdir('legacy-own')
  fs.writeFileSync(
    path.join(src, 'custom-legacy-one.json'),
    JSON.stringify({
      category: 'custom',
      desc: '旧格式样例',
      bg: '#ffffff',
      accent: '#2b6cb0',
      text: '#1f2328',
      secondary: '#5c5f66',
      font: 'PingFang SC, system-ui, sans-serif',
      border_width: '4px',
      headingStyle: 'underline',
      blockquoteStyle: 'full-box',
      blockquote_bg: 'linear-gradient(135deg, #fff4d6 0%, #fff8ea 100%) !important',
      cssTemplate: { h1: 'font-size: 30px;' },
    }),
  )
  // 坏文件：颜色不是 hex 且没法救
  fs.writeFileSync(
    path.join(src, 'custom-broken.json'),
    JSON.stringify({ desc: '坏', bg: 'not-a-color', accent: '#111', text: '#222' }),
  )

  const r = withStylesDir(own, () => installStyles([src]))
  assert.equal(r.counts.failed, 1, '坏文件必须只报错、不中断其余条目')
  assert.equal(r.failed[0].name, 'custom-broken')
  const notes = (r.normalized.find((x) => x.name === 'custom-legacy-one') || {}).notes || []
  assert.ok(
    notes.some((n) => /blockquoteBg.*#fff4d6/.test(n)),
    `渐变要取到 hex：${notes.join(' | ')}`,
  )
  assert.ok(
    notes.some((n) => /cssTemplate/.test(n)),
    'cssTemplate 要报告被丢弃',
  )

  const written = JSON.parse(fs.readFileSync(path.join(own, 'custom-legacy-one.json'), 'utf8'))
  assert.equal(written.borderWidth, '4px', '旧拼写要翻成 canonical')
  assert.equal(written.headingStructure, 'underline')
  assert.equal(written.blockquoteStructure, 'full-box')
  assert.equal(written.blockquoteBg, '#fff4d6')
  assert.ok(!('cssTemplate' in written), 'cssTemplate 不写进自有目录')
  assert.equal(written.category, 'custom')
})
