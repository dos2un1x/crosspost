// 文档图片卫生（README 的界面截图）
//
// README「界面」一节引用 `docs/images/*.png`（Console 八个模块 + 扩展选项页）。这批 PNG 是
// **唯一**还能绕过 `release-artifact.test.mjs` 发布物④（内容里不得出现真实家目录）的文件类型——
// 那条规则对 png/jpg 等二进制扩展名整类跳过。图片本身由
// `crosspost-runtime/tests/docs-screenshots.mjs` 在隔离沙箱里生成，并在落盘前
// 对整份 DOM 断言过"页面已无本机痕迹"；本文件守的是另一半：
//   ① 引用的图都在、且图片一律住在 docs/images/（不许散落）
//   ② docs/images/ 里没有孤儿图（换了图忘了删旧图 = 发布物里多一份没人看的二进制）
//   ③ 体积与像素尺寸在预期量级（防"误拍整页长图"与体积爬升）
//   ④ 字节里没有元数据级本机痕迹（这条能查到像素之外的字符串）
//   ⑤ 生成器还在、且 npm 脚本还指着它（否则没人能重新生成这些图）
//
// 边界（别误读这条防线）：**像素里渲染出来的文字它看不到** —— 那需要 OCR。
// 那部分由生成器的落盘前门禁负责（改 DOM → 断言 → 才截图）。本文件不替代它。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const IMAGES_DIR = path.join(REPO, 'docs', 'images')
const README = path.join(REPO, 'README.md')
const GENERATOR = path.join('crosspost-runtime', 'tests', 'docs-screenshots.mjs')

/** 上限：生成器按 1440 CSS 宽 × DPR 2（= 2880px）拍整页，最长的一张是「设置」（约 8000px）；
 *  扩展选项页那张按 860 × DPR 2（= 1720px）拍，尺寸更小 */
const MAX_BYTES = 4 * 1024 * 1024
const MAX_WIDTH = 3000
const MAX_HEIGHT = 9000
/** 全部文档图的体积上限：发布物总上限是 20MB，图不该吃掉大半 */
const MAX_TOTAL_BYTES = 10 * 1024 * 1024

/** 本机痕迹（字节级）。占位符 `/Users/me/…` 是**像素**，不会出现在 PNG 字节里，
 *  所以这里出现任何 `/Users/` 都说明有人往图里塞了文本块。 */
const FORBIDDEN_BYTES = ['/Users/', '/home/', '/var/folders/', '/private/var/', 'token.local']

/** PNG 尺寸：8 字节签名 + IHDR（长度4 / 类型4 / 宽4 / 高4） */
function pngSize(buf) {
  assert.ok(buf.length > 24, 'PNG 太短，不是有效文件')
  assert.equal(buf.readUInt32BE(12), 0x49484452, 'IHDR 不在预期位置')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** 逐个 chunk 类型（length 4 + type 4 + data + crc 4） */
function pngChunkTypes(buf) {
  const types = []
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    types.push(type)
    off += 12 + len
    if (type === 'IEND') break
  }
  return types
}

/** README 里引用的图片路径（保持出现顺序） */
function readmeImages() {
  const src = fs.readFileSync(README, 'utf8')
  return [...src.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1])
}

test('文档图片①：README 引用的图都在 docs/images/ 下且真的存在', () => {
  const refs = readmeImages()
  assert.ok(refs.length > 0, 'README 里一张图都没有——本文件的前提不成立，请更新本测试')
  const bad = refs.filter(
    (r) => !r.startsWith('docs/images/') || !fs.existsSync(path.join(REPO, r)),
  )
  assert.deepEqual(
    bad,
    [],
    `README 引用的图片缺失或没放在 docs/images/ 下：\n  ${bad.join('\n  ')}`,
  )
})

test('文档图片②：docs/images/ 里没有孤儿图', () => {
  if (!fs.existsSync(IMAGES_DIR)) return // ① 已经判负了
  const used = new Set(readmeImages().map((r) => path.basename(r)))
  const orphans = fs.readdirSync(IMAGES_DIR).filter((f) => f.endsWith('.png') && !used.has(f))
  assert.deepEqual(
    orphans,
    [],
    `这些图没有被 README 引用（换了图记得删旧图，否则发布物里多一份没人看的二进制）：\n  ${orphans.join('\n  ')}`,
  )
})

test('文档图片③：体积与像素尺寸在预期量级', () => {
  if (!fs.existsSync(IMAGES_DIR)) return
  const bad = []
  let total = 0
  for (const f of fs.readdirSync(IMAGES_DIR).sort()) {
    if (!f.endsWith('.png')) continue
    const p = path.join(IMAGES_DIR, f)
    const buf = fs.readFileSync(p)
    const { width, height } = pngSize(buf)
    total += buf.length
    if (buf.length > MAX_BYTES) bad.push(`${f}: ${(buf.length / 1048576).toFixed(2)}MB > 4MB`)
    if (width > MAX_WIDTH) bad.push(`${f}: 宽 ${width}px > ${MAX_WIDTH}px`)
    if (height > MAX_HEIGHT) bad.push(`${f}: 高 ${height}px > ${MAX_HEIGHT}px`)
  }
  if (total > MAX_TOTAL_BYTES)
    bad.push(`合计 ${(total / 1048576).toFixed(2)}MB > ${MAX_TOTAL_BYTES / 1048576}MB`)
  assert.deepEqual(bad, [], `文档图片尺寸/体积异常：\n  ${bad.join('\n  ')}`)
})

test('文档图片④：字节里没有本机痕迹与文本元数据块', () => {
  if (!fs.existsSync(IMAGES_DIR)) return
  // 允许的 chunk：图像数据与色彩信息。tEXt/zTXt/iTXt/eXIf 这类**文本元数据**一律不许，
  // 因为那正是"截图工具把本机路径写进 PNG"的入口。
  const ALLOWED = new Set([
    'IHDR',
    'IDAT',
    'IEND',
    'sRGB',
    'gAMA',
    'pHYs',
    'cHRM',
    'bKGD',
    'tRNS',
    'PLTE',
  ])
  const bad = []
  for (const f of fs.readdirSync(IMAGES_DIR).sort()) {
    if (!f.endsWith('.png')) continue
    const buf = fs.readFileSync(path.join(IMAGES_DIR, f))
    const meta = pngChunkTypes(buf).filter((t) => !ALLOWED.has(t))
    if (meta.length) bad.push(`${f}: 多了文本/元数据块 ${[...new Set(meta)].join(',')}`)
    const text = buf.toString('latin1')
    for (const needle of FORBIDDEN_BYTES) {
      if (text.includes(needle)) bad.push(`${f}: 字节里出现 "${needle}"`)
    }
  }
  assert.deepEqual(bad, [], `文档图片里带上了本机痕迹：\n  ${bad.join('\n  ')}`)
})

test('文档图片⑤：生成器还在，且 npm 脚本还指着它', () => {
  assert.ok(
    fs.existsSync(path.join(REPO, GENERATOR)),
    `${GENERATOR} 不存在——图片就成了没人能重新生成的产物`,
  )
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  assert.equal(
    pkg.scripts && pkg.scripts['docs:screenshots'],
    `node ${GENERATOR}`,
    'package.json 的 docs:screenshots 必须指向生成器（否则图与脚本会各自漂移）',
  )
})
