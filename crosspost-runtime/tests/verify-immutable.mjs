#!/usr/bin/env node
/**
 * 不可变性校验（v2.05）
 *
 * 用途：证明 P0 重构全程**没有修改、删除、移动**任何受保护的 markdown。
 *
 * 受保护集合（两份都没有 git 兜底，误操作无法回滚）：
 *   A. 仓库内 `md-backup/**\/*.md`（原始 29 个）
 *   B. 仓库外的接入项目草稿目录 `<项目>/drafts/**\/*.md`（283 个）
 *
 * 判定规则：
 *   · **修改**（同路径 sha256 变化）→ 违规
 *   · **删除**（基线有、现在无）→ 违规
 *   · **新增** → 允许，但必须落在白名单前缀内（目前仅备份目录），
 *     否则报告为"未声明的新增"需人工确认
 *   · **移动**（v2.91）→ 允许，但必须**内容 + 记录双证**：
 *     ① 目标位置在 `drafts/<archive|rejected|risk|calendar>/` 且内容与基线 sha256 **逐字节相同**；
 *     ② 该 id 的文章记录（`.local/project-state/<proj>/articles/<id>.json`）
 *        写着 `dir` ∈ 上述四个子目录，或 `status` = retained / archived。
 *     缺任一条 → 仍按"删除"计。为什么加这条：归档/留存是引擎自己的**产品动作**
 *     （Console 的归档、留存按钮），此前每做一次分诊，验收就红一项，
 *     而使用者看到的"删除"其实是内容完好地换了个目录。
 *   · **归档/留存子目录里的新增**（v2.91）→ 只要 ② 成立即算"已留存/归档的新增"，
 *     单独列出可见。为什么需要：基线冻结在 v2.00，**基线之后**产生的草稿被归档时
 *     旧位置根本不在基线里，于是它只能以"新增"的形式出现，永远凑不齐 ①。
 *
 * ⚠️ **修订快照不在受保护树内 —— 这是刻意的，别为它再加规则**（v2.92）
 *
 * 写作侧规范（`SKILL.md` §5.5/§5.7 + `dsh-profile/cordis.patch.yml`）要求"修订/重写前
 * 先把旧版本存一份"（铁律：命中即留存、零删除）。2026-09-20 之前这条被实现成
 * `cp` 到 `drafts/rejected/<id>.rev1.md` 之类 —— 于是有三重坏后果：① 快照落进本脚本
 * 的受保护树，每次修订都必然产生一条"未声明新增"，验收天天红；② 快照在 Console
 * 留存库里与基稿**同名**、没有 `retain` 记录（`retainedAt=null`），人工分不清；
 * ③ 误点「恢复」会把快照 `rename` 回 `drafts/` 顶层，`scanAndList` 会把它当文章，
 * 而写作侧"积压重推"的 `ls drafts/ | grep <slot>` 也会命中它 —— 修订前的旧版本
 * 可能被定时任务当成待发草稿推出去。
 *
 * v2.92 的修法是**在源头改**：快照一律写 `<historyDir>/snapshots/<id>.pre-revise.md`
 * （或 `.pre-rewrite.md`），同名加 `-2`/`-3` 不覆盖。该目录在 `CROSSPOST_IMMUTABLE_DRAFTS`
 * 之外，本脚本的 `walk()` 根本扫不到，留存库也不列它。
 *
 * **所以这里不需要（也不应该）加一条"认修订快照"的放宽规则**：那只会把本该在写作侧
 * 解决的问题，变成门禁上又一个可以被人钻的口子。若哪天又在 `drafts/` 里看到快照，
 * 说明写作侧规范被改回去了 —— 让它继续红，正是本脚本该做的事。
 *
 * 为什么允许备份目录的新增：备份规程要求把改动前的原文件副本留在
 * `md-backup/backups/<date>-pre-<step>/files/<原路径>`，这是刻意的留痕行为，
 * 不是文档修改。
 *
 * 注意（重要）：扫描根默认是**本脚本所在的那棵树**（`crosspost-runtime/tests/` 往上两级），
 * **不是**脚本自己所在目录 —— 两者在主工作区里恰好相同，但重构若在隔离 worktree 进行，
 * worktree 里根本没有 `md-backup/`（被 gitignore），扫它会得到 29 个"假删除"。
 * 那种情况下用 `CROSSPOST_IMMUTABLE_ROOT` 指向主工作区。
 *
 * 用法：
 *   node crosspost-runtime/tests/verify-immutable.mjs
 *   CROSSPOST_IMMUTABLE_ROOT=/path/to/main/workspace node ...   # 覆盖扫描根
 *   CROSSPOST_IMMUTABLE_BASELINE=/path/to/baseline.txt node ... # 覆盖基线
 *   CROSSPOST_IMMUTABLE_DRAFTS=/path/to/drafts node ...         # 覆盖仓库外草稿目录（v2.26）
 *
 * 退出码：0 = 0 修改 / 0 删除 / 新增均已声明；1 = 有违规
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * 扫描根与基线所在的工作区：默认是**本脚本所在的那棵树**（`crosspost-runtime/tests/` 往上两级）。
 *
 * v2.109 之前这里写死作者本机的绝对路径（形如 `/Users/<用户名>/<仓库目录>`）。两个后果都很难看：换台机器 `git clone` 下来，
 * 这条"本项目最硬的约束"会去扫一个**不存在的目录** —— 29 个基线条目被判成"被删除"，
 * 或者（基线也缺时）直接变成一个与使用者无关的报错。现在默认跟着仓库走，env 仍可覆盖。
 *
 * 注意（历史原因，保留）：本脚本刻意扫**工作区**而不是它自己所在目录。在隔离 worktree 里
 * 跑时，worktree 的 `md-backup/` 是被 gitignore 的（照抄会得到 29 个"假删除"），
 * 那种情况下用 `CROSSPOST_IMMUTABLE_ROOT` 指向主工作区。
 */
const ROOT = process.env.CROSSPOST_IMMUTABLE_ROOT || path.resolve(__dirname, '..', '..')
const BASELINE =
  process.env.CROSSPOST_IMMUTABLE_BASELINE ||
  path.join(ROOT, '.local', 'baseline', 'immutable-md-v2.00.txt')

/**
 * 仓库外的第二份受保护集合（v2.26 加 env 覆盖）。
 *
 * v2.109 之前默认写死某个外部写作项目的绝对路径：换台机器跑必然把
 * 基线段 B 的 283 个条目判成"被删除"。现在默认值**从基线自己推**（`draftsRootFromBaseline`），
 * 仍然可用 `CROSSPOST_IMMUTABLE_DRAFTS` 覆盖（同其它 smoke 脚本的 `CROSSPOST_SMOKE_*` 约定）。
 *
 * **刻意不因目录缺失而放宽判定**：目录整个消失正是最该报警的情形，
 * 所以下面只在"目录不存在"时给出更明确的提示，仍然走"删除"路径。
 */
const DRAFTS_DIR = process.env.CROSSPOST_IMMUTABLE_DRAFTS || draftsRootFromBaseline(BASELINE)
const MDBACKUP_DIR = path.join(ROOT, 'md-backup')

/** 目录存在吗（推导默认值时用；判定路径不依赖它） */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 从基线 SECTION_2（仓库外草稿）的条目推**草稿根**：取所有条目的公共目录前缀。
 *
 * 为什么这样推：基线条目本身就是绝对路径（那是"记录"，不改），而它们的公共目录前缀
 * 就是当时的草稿根 —— 于是"默认值"不再写死任何人的家目录，换机器/换接入项目都能自解。
 * 推不出来（无基线 / SECTION_2 为空 / 推出来的目录不存在）→ `''`，
 * 于是走上面"缺失即报警"的路径，不静默通过。
 */
function draftsRootFromBaseline(file) {
  try {
    const paths = []
    let inSection2 = false
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.startsWith('## SECTION_')) inSection2 = line.includes('SECTION_2')
      else if (inSection2 && /^[0-9a-f]{64}\s/.test(line)) {
        const p = line.split('|').pop().trim()
        if (p) paths.push(p)
      }
    }
    if (!paths.length) return ''
    const parts = paths.map((p) => p.split(path.sep))
    const common = []
    for (let i = 0; ; i++) {
      const seg = parts[0][i]
      if (seg === undefined || !parts.every((x) => x[i] === seg)) break
      common.push(seg)
    }
    let root = common.join(path.sep) || path.sep
    // 公共前缀可能停在某个**文件名**上（SECTION_2 只有一条时）→ 回退到存在的目录
    while (root && root !== path.sep && !isDir(root)) root = path.dirname(root)
    return isDir(root) ? root : ''
  } catch {
    return ''
  }
}

/**
 * 允许新增的**前缀**路径。
 *
 * · `md-backup/backups/` —— 备份规程要求把改前原文件副本留在这里（刻意留痕）。
 * · `md-backup/maintaining/` —— v2.1 起：维护者文档（发布/回滚、只读树、验证规程）
 *   住在这里。为什么放 `md-backup/` 而不是 `docs/`：产品文档只讲"是什么/怎么用"，
 *   开发与运维知识不该出现在对外文档树里；而 `md-backup/` 本身不入库，
 *   所以这些文档天然不进产品文档。
 *
 * **必须是精确前缀**（不是 `md-backup/` 整棵）——放宽到整棵会让受保护树形同虚设。
 *
 * 另一类允许的新增（`drafts/` **顶层**的新草稿）不在此列，因为它需要
 * "恰好顶层"的判定而非前缀判定，见 `isDeclaredAddition()` 的说明。
 */
const ALLOWED_ADDITION_PREFIXES = [
  path.join(MDBACKUP_DIR, 'backups') + path.sep,
  path.join(MDBACKUP_DIR, 'maintaining') + path.sep,
]

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p)
  }
  return out
}

/** 数一段基线里有多少条目（用于"目录缺失"这类前置判断，不建全量 map） */
function countBaselineSection(file, marker) {
  let n = 0
  let inSection = false
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.startsWith('## SECTION_')) {
        inSection = line.startsWith(marker)
        continue
      }
      if (!inSection) continue
      const parts = line.split('|').map((s) => s.trim())
      if (parts.length === 4 && /^[0-9a-f]{64}$/.test(parts[0])) n++
    }
  } catch {
    return 0
  }
  return n
}

/** 解析基线文件（sha256 | size | mtime | path，两段式） */
function loadBaseline(file) {
  const map = new Map()
  let section = null
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('## SECTION_1')) {
      section = 'repo'
      continue
    }
    if (line.startsWith('## SECTION_2')) {
      section = 'drafts'
      continue
    }
    const parts = line.split('|').map((s) => s.trim())
    if (parts.length !== 4 || !/^[0-9a-f]{64}$/.test(parts[0])) continue
    // 基线内仓库条目记的是相对路径（相对主工作区根），统一归一为绝对路径再比对，
    // 否则会与 walk() 产出的绝对路径全然不匹配，表现为"29 个假删除 + 13 个假新增"。
    const raw = parts[3]
    const abs = path.isAbsolute(raw) ? raw : path.join(ROOT, raw)
    map.set(path.normalize(abs), { sha256: parts[0], section })
  }
  return map
}

if (!fs.existsSync(BASELINE)) {
  console.error(`✖ 找不到基线文件：${BASELINE}`)
  console.error('  基线由 v2.00 步骤生成；可用 CROSSPOST_IMMUTABLE_BASELINE 指定。')
  process.exit(1)
}
if (!fs.existsSync(MDBACKUP_DIR)) {
  console.error(`✖ 扫描根不含 md-backup/：${MDBACKUP_DIR}`)
  console.error('  请把 CROSSPOST_IMMUTABLE_ROOT 指向主工作区（含 md-backup/ 的那棵目录树）。')
  process.exit(1)
}
// 目录缺失时**不放宽**判定（目录消失本身就是最该报警的情形），但把提示写清楚，
// 免得在本机没有该数据源的环境里对着一屏"被删除"猜原因。
if (!fs.existsSync(DRAFTS_DIR) && countBaselineSection(BASELINE, '## SECTION_2') > 0) {
  console.error(`✖ 找不到受保护的草稿目录：${DRAFTS_DIR}`)
  console.error(
    '  基线里有该目录下的条目，缺失会被判为"被删除"。默认值是从基线 SECTION_2 的公共目录前缀推的，' +
      '推不出来（或本机确实没有该数据源）时用 CROSSPOST_IMMUTABLE_DRAFTS 指向它' +
      '（或改用不含该段的基线）。',
  )
  process.exit(1)
}

const baseline = loadBaseline(BASELINE)
const current = new Map()
for (const f of walk(MDBACKUP_DIR)) current.set(f, { section: 'repo' })
for (const f of walk(DRAFTS_DIR)) current.set(f, { section: 'drafts' })

const modified = []
const deleted = []
const moved = []
const susMove = []
const engineRetains = []
const undeclaredAdds = []
const declaredAdds = []

/**
 * 归档 / 留存子目录（v2.91）。引擎的归档与留存都是 `renameSync` 到这四个之一。
 */
const MOVE_DIRS = ['archive', 'rejected', 'risk', 'calendar']

/** 文章记录（项目态）。不解析 manifest：直接遍历 project-state/<proj>/articles。 */
function articleRecord(id) {
  const base = path.join(ROOT, '.local', 'project-state')
  let projects
  try {
    projects = fs.readdirSync(base)
  } catch {
    return null // 没有记录库 → 无佐证（严格方向：仍判删除）
  }
  for (const proj of projects) {
    const f = path.join(base, proj, 'articles', `${id}.json`)
    if (!fs.existsSync(f)) continue
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'))
    } catch {
      return null // 记录损坏同样按"无佐证"处理
    }
  }
  return null
}

/**
 * 记录是否佐证"引擎把它归档/留存了"。
 *
 * 判据取 `dir` / `status` 这种**当前态**，刻意不取 history 末条：
 * history 只能说明"历史上做过一次留存"，而文件此后可能已被恢复回顶层
 * （`restoreArticle` 会把 dir 清空），那时按 history 放行就会漏掉真删除。
 */
function recordShowsMove(rec) {
  if (!rec) return false
  if (MOVE_DIRS.includes(String(rec.dir || ''))) return true
  return rec.status === 'retained' || rec.status === 'archived'
}

/** 该路径是否落在归档/留存子目录里（父目录名恰好是那四个之一） */
const inMoveDir = (p) => MOVE_DIRS.includes(path.basename(path.dirname(p)))

/**
 * 新增文件按内容哈希登记（只对落在归档/留存子目录的**新增**算哈希，
 * 数量是个位数，不会因此把整个草稿树哈希一遍两次）。
 */
const addByHash = new Map()
for (const [p, c] of current) {
  if (baseline.has(p)) continue
  if (c.section !== 'drafts' || !inMoveDir(p)) continue
  const h = sha256(p)
  if (!addByHash.has(h)) addByHash.set(h, [])
  addByHash.get(h).push(p)
}
/** 已被判定为某次移动落点的文件：不得再被别的删除条目认领，也不再算新增 */
const claimedMoves = new Set()
/**
 * 基线段里被判"删除"的 id。用途见 `isEngineRetain()`：同一个 id 已经有一条删除
 * 记录时，归档目录里那个同名文件就是该异常的现场，不能再按"留存新增"二次放行。
 */
const deletedIds = new Set()

for (const [p, b] of baseline) {
  const c = current.get(p)
  if (!c) {
    // ① 同 sha256 的新文件躺在归档/留存子目录 ② 记录佐证是引擎动作
    // —— **两条都满足**才算移动；只满足 ① 时仍判删除，并把线索打出来，
    //    因为"内容换了目录"与"内容被人搬走藏起来"在只看 ① 时无法区分。
    const cand = (addByHash.get(b.sha256) || []).find((q) => !claimedMoves.has(q))
    if (cand && recordShowsMove(articleRecord(path.basename(p, '.md')))) {
      claimedMoves.add(cand)
      moved.push(`${path.basename(p, '.md')} → ${path.basename(path.dirname(cand))}/`)
      continue
    }
    if (cand) susMove.push(`${p}（同内容在 ${path.relative(ROOT, cand)}，但记录未佐证）`)
    deletedIds.add(path.basename(p, '.md'))
    deleted.push(p)
  } else if (sha256(p) !== b.sha256) modified.push(p)
}
/**
 * 该新增文件是否属于"已声明允许"的一类。
 *
 * 注意 drafts 的判定**必须是"恰好顶层"**（父目录就是 drafts），不能用
 * `startsWith(drafts + sep)`——那样会把 `drafts/rejected|risk|archive|calendar/`
 * 下的新增也一并放行，而那些是本工具/人工的留存归档痕迹，出现时应被看见。
 */
function isDeclaredAddition(p) {
  // ① md-backup/backups/ 与 md-backup/maintaining/ 下任意深度
  //    （前者=备份留痕；后者=维护者文档，v2.1 起）
  if (ALLOWED_ADDITION_PREFIXES.some((prefix) => p.startsWith(prefix))) return true
  // ② drafts 顶层的新草稿（父目录恰好是 drafts）——写作流水线的每日正常产出。
  //    2026-09-19 补：此前只放行 ①，于是当天早间流水线产出的新草稿被报成
  //    "未声明的新增 → 违规"，而它恰恰是流水线健康运行的证据。
  //    ③ 该判定必须"恰好顶层"，不能用前缀——否则会连带放行
  //    `drafts/rejected|risk|archive|calendar/` 下的留存/归档痕迹。
  return path.dirname(p) === DRAFTS_DIR
}

/**
 * 归档/留存子目录里的新增（v2.91）：记录佐证即放行，但仍**单列一行**可见。
 *
 * 为什么这条必须有：基线冻结在 v2.00，基线之后产生的草稿被归档时，它的旧位置
 * 从来就不在基线里 —— 只能以"新增"的形式出现，永远凑不齐"同 sha256 的删除条目"
 * 那一半证据。少了这条，9-19/9-20 那批留存/归档会一直卡住验收。
 * 反之，**没有记录佐证**的新增（例如没有对应记录的裸文件）仍走"未声明的新增"。
 */
function isEngineRetain(p) {
  if (path.dirname(path.dirname(p)) !== DRAFTS_DIR) return false // 必须恰好 drafts/<子目录>/x.md
  if (!inMoveDir(p)) return false
  const id = path.basename(p, '.md')
  // 该 id 在基线段里已经**被判删除**（内容对不上，或缺少佐证）→ 这个文件正是那条
  // 记录的现场。此时若还按"引擎留存新增"放行，同一次异常会被讲成
  // "删除 + 一次正常的留存"，等于把内容被改过这件事说轻了。
  if (deletedIds.has(id)) return false
  return recordShowsMove(articleRecord(id))
}

for (const [p, c] of current) {
  if (baseline.has(p)) continue
  if (claimedMoves.has(p)) continue
  if (isDeclaredAddition(p)) declaredAdds.push(p)
  else if (isEngineRetain(p)) engineRetains.push(p)
  else undeclaredAdds.push(`${c.section}: ${p}`)
}

const countBy = (m, s) => [...m.values()].filter((v) => v.section === s).length
const lines = []
lines.push('')
lines.push('不可变性校验')
lines.push('─'.repeat(64))
lines.push(`扫描根：${ROOT}`)
lines.push(`基线：  ${BASELINE}`)
lines.push(
  `受保护：md-backup ${countBy(baseline, 'repo')} + drafts ${countBy(baseline, 'drafts')} = ${baseline.size}`,
)
lines.push(
  `现有：  md-backup ${countBy(current, 'repo')} + drafts ${countBy(current, 'drafts')} = ${current.size}`,
)
lines.push('─'.repeat(64))
lines.push(`${modified.length === 0 ? '✔' : '✖'} 内容被修改：${modified.length}`)
for (const p of modified.slice(0, 10)) lines.push(`    ${p}`)
lines.push(`${deleted.length === 0 ? '✔' : '✖'} 被删除：${deleted.length}`)
for (const p of deleted.slice(0, 10)) lines.push(`    ${p}`)
// v2.91：移动与"归档/留存子目录里的新增"都单列出来。**不从计数里消失**——
// 内容换目录这件事仍然要看得见，只是不再计为违规。
lines.push(`✔ 已移动（内容逐字节在新位置 + 记录佐证）：${moved.length}`)
for (const p of moved.slice(0, 10)) lines.push(`    ${p}`)
if (susMove.length) {
  lines.push(`⚠ 疑似移动但记录未佐证：${susMove.length}（已按删除计）`)
  for (const p of susMove.slice(0, 10)) lines.push(`    ${p}`)
}
lines.push(`✔ 已留存/归档的新增（记录佐证）：${engineRetains.length}`)
for (const p of engineRetains.slice(0, 10)) lines.push(`    ${path.relative(ROOT, p)}`)
lines.push(`✔ 已声明的新增（备份留痕）：${declaredAdds.length}`)
for (const p of declaredAdds.slice(0, 10)) lines.push(`    ${path.relative(ROOT, p)}`)
if (undeclaredAdds.length) {
  lines.push(`⚠ 未声明的新增：${undeclaredAdds.length}（需人工确认）`)
  for (const p of undeclaredAdds.slice(0, 10)) lines.push(`    ${p}`)
}
lines.push('─'.repeat(64))

const ok = modified.length === 0 && deleted.length === 0 && undeclaredAdds.length === 0
lines.push(
  ok
    ? `✔ 通过：0 修改 / 0 删除 · ${moved.length} 项已移动 · ` +
        `${engineRetains.length + declaredAdds.length} 项已声明新增（备份留痕 / 归档留存）`
    : '✖ 存在违规：受保护 markdown 被修改或删除，或出现未声明的文件新增。',
)
lines.push('')
console.log(lines.join('\n'))
process.exit(ok ? 0 : 1)
