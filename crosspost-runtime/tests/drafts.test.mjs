// createDraft / updateDraft 单元测试（编写工作台，2026-09-05）
// 运行: node --test tests/
// 说明：spawn cli.mjs --ipc 常驻进程，按 bridge cli-worker 协议发 {seq, method, args}。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'cli.mjs')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-drafts-test-'))
process.env.CROSSPOST_ARTICLES_DIR = path.join(TMP, 'articles')
process.env.CROSSPOST_DRAFTS_DIR = path.join(TMP, 'drafts')
// v2.40：引擎脚本一律隔离 historyDir —— deleteDraft / deleteTopic 会经
// pushHumanFeedback() 写 history/editorial-memory.json，漏隔离就会污染真实部署
// （实测发生过：真实人工反馈被测试假条目整段挤出 30 条上限）。
process.env.CROSSPOST_HISTORY_DIR = path.join(TMP, 'history')

let child = null
let buf = ''
let seq = 0
const pending = new Map()

function call(args) {
  return new Promise((resolve, reject) => {
    const s = ++seq
    const [method, ...rest] = args
    // 超时是**兜底**，必须在应答到达时清掉：否则每个用例都会留下一个 30s 定时器把事件循环
    // 多撑半分钟（实测本文件 32.0s → 2.1s，纯空等，见 2026-09-28 测试审计）。
    const timer = setTimeout(() => {
      if (pending.has(s)) {
        pending.delete(s)
        reject(new Error('cli 超时: ' + method))
      }
    }, 30000)
    pending.set(s, (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    child.stdin.write(JSON.stringify({ seq: s, method, arg1: rest[0], arg2: rest[1], args }) + '\n')
  })
}

function reqFile(body) {
  const tmp = path.join(TMP, `req-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(tmp, JSON.stringify(body))
  return tmp
}

before(async () => {
  child = spawn(process.execPath, [CLI, '--ipc'], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const p = pending.get(msg.seq)
      if (p) {
        pending.delete(msg.seq)
        p(msg)
      }
    }
  })
  child.stderr.on('data', () => {})
  child.on('error', () => {})
})

after(() => {
  try {
    if (child) child.kill()
  } catch {}
})

test('createDraft 生成 ASCII 文件名 + frontmatter + 记录', async () => {
  const r = await call([
    'createDraft',
    reqFile({
      title: '测试文章',
      markdown: '# 你好\n\n这是**加粗**',
      slot: 'hotspot',
      date: '2026-09-05',
      topic: 'ceshi-wenzhang',
    }),
  ])
  assert.equal(r.error, undefined, JSON.stringify(r.error))
  assert.equal(r.id, '2026-09-05-hotspot-ceshi-wenzhang')
  assert.ok(fs.existsSync(r.file))
  const text = fs.readFileSync(r.file, 'utf8')
  assert.match(text, /^---\ntitle: 测试文章\n---/)
  assert.ok(text.includes('# 你好'))
})

test('createDraft 非 ASCII topic 剥掉（防中文文件名破坏 id 校验）', async () => {
  const r = await call([
    'createDraft',
    reqFile({ title: '中文标题', slot: 'noon', date: '2026-09-05', topic: '测试-主题' }),
  ])
  assert.equal(r.error, undefined, JSON.stringify(r.error))
  assert.match(r.id, /^2026-09-05-noon-(draft|-+)$/)
})

test('createDraft 缺 title 报错；已存在 id 报已存在', async () => {
  const noTitle = await call(['createDraft', reqFile({ title: '', slot: 'tips' })])
  assert.match(noTitle.error, /缺少 title/)
  const body = { title: '重复', slot: 'tips', date: '2026-09-05', topic: 'dup' }
  const first = await call(['createDraft', reqFile(body)])
  assert.equal(first.error, undefined, JSON.stringify(first.error))
  const second = await call(['createDraft', reqFile(body)])
  assert.match(second.error, /已存在/)
})

test('updateDraft 更新已存在草稿 title + 正文', async () => {
  const created = await call([
    'createDraft',
    reqFile({
      title: '原始',
      markdown: '原始正文',
      slot: 'evening',
      date: '2026-09-05',
      topic: 'upd',
    }),
  ])
  assert.equal(created.error, undefined, JSON.stringify(created.error))
  const upd = await call([
    'updateDraft',
    reqFile({ id: created.id, title: '改后标题', markdown: '改后正文' }),
  ])
  assert.equal(upd.error, undefined, JSON.stringify(upd.error))
  assert.equal(upd.title, '改后标题')
  const text = fs.readFileSync(created.file, 'utf8')
  assert.match(text, /title: 改后标题/)
  assert.ok(text.includes('改后正文'))
})
