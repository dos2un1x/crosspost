// cli.mjs IPC handler 直接单测（node:test，零依赖）
// 运行: node --test tests/
// 说明：spawn cli.mjs --ipc 常驻进程，按 bridge cli-worker 协议发 {seq, method, arg1, arg2, args}。
// 2026-09-06：隔离化——原来依赖真实文章库(articles/)/草稿(drafts/)，剥离业务数据后 CI 干净环境
// 无这些文件会失败；现改为用临时目录 + 注入最小测试记录/草稿，自包含、可复现。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'cli.mjs')

// 隔离临时目录（不碰真实文章库/草稿目录）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-ipc-test-'))
process.env.CROSSPOST_ARTICLES_DIR = path.join(TMP, 'articles')
process.env.CROSSPOST_DRAFTS_DIR = path.join(TMP, 'drafts')
// v2.40：引擎脚本一律隔离 historyDir —— deleteDraft / deleteTopic 会经
// pushHumanFeedback() 写 history/editorial-memory.json，漏隔离就会污染真实部署
// （实测发生过：真实人工反馈被测试假条目整段挤出 30 条上限）。
process.env.CROSSPOST_HISTORY_DIR = path.join(TMP, 'history')

// 注入最小测试数据：一篇文章记录 + 一个草稿（供 getArticle/readDraft/setArticleRisk/listArticles/listCosts）
const TEST_ID = '2026-08-27-hotspot2-glm53-flash'
function seedTestData() {
  fs.mkdirSync(process.env.CROSSPOST_ARTICLES_DIR, { recursive: true })
  fs.mkdirSync(process.env.CROSSPOST_DRAFTS_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(process.env.CROSSPOST_ARTICLES_DIR, `${TEST_ID}.json`),
    JSON.stringify({
      id: TEST_ID,
      title: 'GLM-4.5 Flash 测试文章',
      slot: 'hotspot2',
      date: '2026-08-27',
      risk: 'unclassified',
      status: 'draft',
      wechat: { status: 'none' },
      platforms: {},
      notify: { status: 'none' },
      history: [{ action: 'draft', at: '2026-08-27T00:00:00.000Z' }],
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    }),
  )
  fs.writeFileSync(
    path.join(process.env.CROSSPOST_DRAFTS_DIR, `${TEST_ID}.md`),
    '---\ntitle: GLM-4.5 Flash 测试文章\nslot: hotspot2\ndate: 2026-08-27\n---\n\n# 测试正文\n\n这是一段测试 markdown。',
  )
}

let child = null
let buf = ''
let seq = 0
const pending = new Map()

function call(args) {
  return new Promise((resolve, reject) => {
    const s = ++seq
    const [method, ...rest] = args
    // 超时是**兜底**，必须在应答到达时清掉：否则每个用例都会留下一个 30s 定时器把事件循环
    // 多撑半分钟（实测本文件 31.5s → 1.8s，纯空等，见 2026-09-28 测试审计）。
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

before(async () => {
  seedTestData()
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
  // 就绪 ping
  await call(['listArchive'])
})

after(() => {
  try {
    child.stdin.write(JSON.stringify({ seq: ++seq, method: 'exit' }) + '\n')
  } catch {}
  setTimeout(() => {
    try {
      child.kill()
    } catch {}
  }, 200)
})

test('listArticles 返回文章数组', async () => {
  const r = await call(['listArticles'])
  assert.ok(Array.isArray(r.articles))
  assert.ok(r.articles.length > 0)
})

test('getArticle 返回单条记录', async () => {
  const r = await call(['getArticle', '2026-08-27-hotspot2-glm53-flash'])
  assert.ok(r.article)
  assert.ok(r.article.title.length > 0)
})

test('readDraft 返回正文 markdown', async () => {
  const r = await call(['readDraft', '2026-08-27-hotspot2-glm53-flash'])
  assert.ok(r.markdown && r.markdown.length > 0)
})

test('unknown method 返回明确错误', async () => {
  const r = await call(['noSuchMethod'])
  assert.match(r.error, /unknown method/)
})

test('styles 子命令经 args 传递可执行（非法样式返回样式不存在而非用法错误）', async () => {
  const r = await call(['styles', 'show', 'swiss'])
  // 子命令解析成功（showCustomStyle 自动补 custom- 前缀）
  assert.match(r.error, /样式不存在: custom-swiss/)
})

test('generateCover --out-dir flag 经 args 传递生效', async () => {
  const out = path.join(process.env.TMPDIR || '/tmp', `cp-ipc-cover-${Date.now()}`)
  const r = await call(['generateCover', 'IPC测试', 'cyber', `--out-dir=${out}`])
  assert.equal(r.ok, true)
  assert.ok(r.cover2_35_1 && r.cover2_35_1.includes(out))
})

test('setArticleRisk 非法值校验', async () => {
  const r = await call(['setArticleRisk', '2026-08-27-hotspot2-glm53-flash', 'bogus'])
  assert.match(r.error, /非法风险类型/)
})

test('deleteDraft 对非法 id（路径穿越）拒绝', async () => {
  const r = await call(['deleteDraft', '../../etc/passwd'])
  // 2026-09-28 测试审计：原断言 `r.error || r.ok === false` 近似恒真（出错时一定有 error）。
  // 现在钉住"是被 id 白名单拒的，不是别处崩的"——这才是有信息的判据。
  assert.match(r.error || '', /非法 articleId/, '应由 assertSafeId 拒绝，而不是别的错误')
})

test('listCosts 纳入留存/归档三库（报表费用口径对齐）', async () => {
  const [arts, rets, arcs, costs] = await Promise.all([
    call(['listArticles']),
    call(['listRetained']),
    call(['listArchive']),
    call(['listCosts']),
  ])
  const total =
    (arts.articles || []).length + (rets.retained || []).length + (arcs.archived || []).length
  assert.ok(Array.isArray(costs.costs))
  assert.ok(
    costs.costs.length >= total,
    `listCosts should cover three libs (costs.length=${costs.costs.length} >= ${total})`,
  )
})
