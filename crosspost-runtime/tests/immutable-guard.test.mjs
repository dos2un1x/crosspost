/**
 * 不可变性判定器的回归（v2.91）：把「移动」与「未声明新增」的判据钉死。
 *
 * 为什么需要这个文件：`verify-immutable.mjs` 是本项目**最硬的门禁**（受保护 md 不许
 * 被改/被删），而 v2.91 给它加了"认移动"的能力 —— 放宽门禁的改动必须自带反例，
 * 否则下一次有人顺手把条件写松（比如去掉记录佐证、或只比对文件名），没人会发现。
 *
 * 这组用例全部在 `mkdtemp` 出来的沙箱里跑：脚本扫的是 `CROSSPOST_IMMUTABLE_ROOT`，
 * 基线走 `CROSSPOST_IMMUTABLE_BASELINE`，草稿目录走 `CROSSPOST_IMMUTABLE_DRAFTS`，
 * 不碰真实工作区里的任何文件。
 *
 * 判据（与脚本头部注释同源）：
 *   · 移动 = ① 目标在 drafts/<archive|rejected|risk|calendar>/ 且与基线 sha256 逐字节相同
 *           ② 该 id 的文章记录 dir ∈ 那四个 / status ∈ retained|archived
 *     缺 ① 或 ② 都仍然算"被删除"。
 *   · 归档/留存子目录里的**新增**：只要 ② 成立即放行（基线冻结在 v2.00，
 *     基线之后产生的草稿被归档时旧位置压根不在基线里）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'verify-immutable.mjs')
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

/** 造一个最小工作区：md-backup / 仓库外 drafts / 基线 / 项目态记录库 */
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-immutable-'))
  const drafts = path.join(root, 'outside-drafts') // 模拟"仓库外"的草稿目录
  fs.mkdirSync(path.join(root, 'md-backup'), { recursive: true })
  fs.mkdirSync(drafts, { recursive: true })
  fs.mkdirSync(path.join(root, '.local', 'baseline'), { recursive: true })
  fs.mkdirSync(path.join(root, '.local', 'project-state', 'proj', 'articles'), { recursive: true })
  return { root, drafts }
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

/** 文章记录：dir/status 就是"引擎做过归档/留存"的佐证 */
function record(root, id, rec) {
  write(
    path.join(root, '.local', 'project-state', 'proj', 'articles', `${id}.json`),
    JSON.stringify(rec),
  )
}

/** 基线只写 SECTION_2（草稿段）；SECTION_1 留空 */
function baseline(root, entries) {
  const lines = ['## SECTION_1', '## SECTION_2']
  for (const [abs, body] of entries) lines.push(`${sha(body)} | ${body.length} | 0 | ${abs}`)
  const f = path.join(root, '.local', 'baseline', 'b.txt')
  fs.writeFileSync(f, lines.join('\n') + '\n')
  return f
}

function run(root, drafts, base) {
  const env = {
    ...process.env,
    CROSSPOST_IMMUTABLE_ROOT: root,
    CROSSPOST_IMMUTABLE_BASELINE: base,
    CROSSPOST_IMMUTABLE_DRAFTS: drafts,
  }
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' }) }
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

test('移动：同 sha256 落到 rejected/ 且记录 retained → 认移动、不算删除', () => {
  const { root, drafts } = workspace()
  const body = '# a\n正文\n'
  write(path.join(drafts, 'a.md'), body)
  const base = baseline(root, [[path.join(drafts, 'a.md'), body]])
  fs.rmSync(path.join(drafts, 'a.md'))
  write(path.join(drafts, 'rejected', 'a.md'), body)
  record(root, 'a', { status: 'retained', dir: 'rejected' })

  const r = run(root, drafts, base)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /被删除：0/)
  assert.match(r.out, /已移动[^：]*：1/)
})

test('移动：同内容但没有记录佐证 → 仍判删除（并给出线索）', () => {
  const { root, drafts } = workspace()
  const body = '# a\n'
  write(path.join(drafts, 'a.md'), body)
  const base = baseline(root, [[path.join(drafts, 'a.md'), body]])
  fs.rmSync(path.join(drafts, 'a.md'))
  write(path.join(drafts, 'archive', 'a.md'), body) // 无记录

  const r = run(root, drafts, base)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /被删除：1/)
  assert.match(r.out, /疑似移动但记录未佐证/) // 人能看到"内容其实在哪"
})

test('删除：内容被改过（sha 不同）+ 记录写着 retained → 仍判删除（不许被记录蒙混）', () => {
  const { root, drafts } = workspace()
  const body = '# a\n原文\n'
  write(path.join(drafts, 'a.md'), body)
  const base = baseline(root, [[path.join(drafts, 'a.md'), body]])
  fs.rmSync(path.join(drafts, 'a.md'))
  write(path.join(drafts, 'rejected', 'a.md'), '# a\n被改过的内容\n') // 同路径、内容不同
  record(root, 'a', { status: 'retained', dir: 'rejected' })

  const r = run(root, drafts, base)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /被删除：1/)
  assert.match(r.out, /未声明的新增：1/) // 那个"内容不同"的文件必须自己站不住脚
})

test('删除：整份消失（连副本都没有）→ 判删除，哪怕记录写着 retained', () => {
  const { root, drafts } = workspace()
  const body = '# b\n'
  write(path.join(drafts, 'b.md'), body)
  const base = baseline(root, [[path.join(drafts, 'b.md'), body]])
  fs.rmSync(path.join(drafts, 'b.md'))
  record(root, 'b', { status: 'retained', dir: 'rejected' })

  const r = run(root, drafts, base)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /被删除：1/)
  assert.doesNotMatch(r.out, /已移动[^：]*：1/)
})

test('修改：同路径内容变了 → 判修改', () => {
  const { root, drafts } = workspace()
  const body = '# c\n'
  write(path.join(drafts, 'c.md'), body)
  const base = baseline(root, [[path.join(drafts, 'c.md'), body]])
  write(path.join(drafts, 'c.md'), '# c 改过了\n')

  const r = run(root, drafts, base)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /内容被修改：1/)
})

test('新增：归档子目录里的新文件 + 记录佐证 → 放行（基线之后产生的草稿被归档）', () => {
  const { root, drafts } = workspace()
  write(path.join(drafts, 'keep.md'), '# keep\n')
  const base = baseline(root, [[path.join(drafts, 'keep.md'), '# keep\n']])
  write(path.join(drafts, 'archive', 'd.md'), '# d\n') // 从不曾进过基线
  record(root, 'd', { status: 'archived', dir: 'archive' })

  const r = run(root, drafts, base)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /已留存\/归档的新增[^：]*：1/)
})

test('新增：归档子目录里的新文件但**没有**记录 → 未声明新增（仍需人工确认）', () => {
  const { root, drafts } = workspace()
  write(path.join(drafts, 'keep.md'), '# keep\n')
  const base = baseline(root, [[path.join(drafts, 'keep.md'), '# keep\n']])
  write(path.join(drafts, 'rejected', 'x.rev1.md'), '# 无记录的产物\n')

  const r = run(root, drafts, base)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /未声明的新增：1/)
})

test('新增：drafts 顶层的新草稿 → 一直放行（流水线每日产出）', () => {
  const { root, drafts } = workspace()
  write(path.join(drafts, 'keep.md'), '# keep\n')
  const base = baseline(root, [[path.join(drafts, 'keep.md'), '# keep\n']])
  write(path.join(drafts, '2026-09-20-hotspot-new.md'), '# 新草稿\n')

  const r = run(root, drafts, base)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /已声明的新增[^：]*：1/)
})

// ── md-backup 的两个白名单前缀（v2.1）──
//
// 白名单是**精确前缀**，不是 `md-backup/` 整棵：放宽到整棵会让受保护树形同虚设。
// 这两例一起把边界钉死——`maintaining/` 放行，`md-backup/` 根仍必须报出来。
test('新增：md-backup/maintaining/ 下的维护者文档 → 放行（v2.1 起的白名单）', () => {
  const { root, drafts } = workspace()
  write(path.join(drafts, 'keep.md'), '# keep\n')
  const base = baseline(root, [[path.join(drafts, 'keep.md'), '# keep\n']])
  write(path.join(root, 'md-backup', 'maintaining', 'release.md'), '# 发布规程\n')

  const r = run(root, drafts, base)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /已声明的新增[^：]*：1/)
})

test('新增：md-backup 根（两个白名单前缀之外）→ 仍判未声明新增', () => {
  const { root, drafts } = workspace()
  write(path.join(drafts, 'keep.md'), '# keep\n')
  const base = baseline(root, [[path.join(drafts, 'keep.md'), '# keep\n']])
  write(path.join(root, 'md-backup', 'notes.md'), '# 白名单之外的产物\n')

  const r = run(root, drafts, base)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /未声明的新增：1/)
})
