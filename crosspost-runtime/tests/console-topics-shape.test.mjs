// Console 选题库：字段错位的记录不得把整页变成"无法连接 Bridge"（jsdom + 真模块）
//
// 背景（实测踩到）：写入侧把分数写进了 `title`（数字）、把落选原因写进了 `status`。
// 渲染那一行时 `(数字).slice()` 抛异常，而 `loadTopics` 的兜底把**任何**异常都写成
// 「无法连接 Bridge: (t.title || '').slice is not a function」——数据形状问题被报成连接问题。
//
// 这条测试跑的是**真视图模块**（不是静态扫描）：
//   ① 喂一条字段错位的记录 → 页面必须画出那一行，且提示里不许出现"无法连接 Bridge"；
//   ② 喂一条正常记录 → 正常渲染（对照组，防止把渲染整个改坏）；
//   ③ 取数真失败（fetch 抛错）→ 仍然要给"无法连接 Bridge"（把好文案也钉住）。
//
// 机制：jsdom 提供 DOM 全局；`api.mjs` 走全局 `fetch`，所以只要换掉 fetch 就能喂数据，
// 不需要模块 mock。console 模块在模块作用域不碰 DOM（只有 `$()` 里引用 document），
// 因此可以安全 import —— 与 console-utils.test.mjs 的既有做法一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const VIEW = path.join(REPO, 'bridge', 'console', 'modules', 'views-topics.mjs')

/** 视图会碰到的全部元素（视图里 `$()` 的并集），少一个就会在渲染时抛 null */
const HTML = `<!doctype html><html><body>
  <div id="topics-banner"></div>
  <select id="tf-slot"></select>
  <select id="tf-status"></select>
  <input id="tf-date">
  <input id="tf-q">
  <div id="topics-summary"></div>
  <div id="topics-empty" class="hidden"></div>
  <div id="topics-gen-pending"></div>
  <table><tbody id="topics-tbody"></tbody></table>
  <div id="topics-pager"></div>
</body></html>`

const json = (value) => ({ ok: true, status: 200, json: async () => value })

/**
 * 在 jsdom 里跑一次 loadTopics。
 * @param topics - `/proxy/topics` 返回的条目
 * @param opts.failFetch - true 时让取数真的失败（测"无法连接 Bridge"那条分支）
 */
async function renderTopics(topics, opts = {}) {
  const dom = new JSDOM(HTML)
  const prev = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch }
  globalThis.document = dom.window.document
  globalThis.window = dom.window
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith('/proxy/bootstrap')) return json({ token: 'test-token' })
    if (u.endsWith('/proxy/topics')) {
      if (opts.failFetch) throw new Error('ECONNREFUSED 127.0.0.1:9540')
      return json({ topics })
    }
    if (u.endsWith('/proxy/topics/generate/status')) return json({ provided: false })
    if (u.endsWith('/proxy/articles')) return json({ articles: [] })
    return json({})
  }
  try {
    // 带查询串 import：拿一份干净的模块实例（模块内有 store 单例）
    const mod = await import(
      new URL(`file://${VIEW}?case=${encodeURIComponent(opts.tag ?? 'x')}`).href
    )
    const errors = []
    try {
      await mod.loadTopics()
    } catch (error) {
      errors.push(error)
    }
    return {
      html: dom.window.document.body.innerHTML,
      tbody: dom.window.document.querySelector('#topics-tbody').innerHTML,
      errors,
    }
  } finally {
    globalThis.document = prev.document
    globalThis.window = prev.window
    globalThis.fetch = prev.fetch
  }
}

/** 字段错位的记录：title 装了分数（数字）、status 装了原因——正是当初炸页面的形状 */
const SHIFTED = {
  id: '2026-10-04-hotspot-02',
  date: '2026-10-04',
  slot: 'hotspot',
  keyword: 'Anthropic被曝密会宗教领袖讨论Claude意识问题',
  title: 92,
  topicScore: 'rejected',
  rank: 2,
  status: '传播性略低(意识/宗教议题偏思辨)',
  reason: '',
  articleId: null,
}

test('选题库渲染：字段错位的记录（title 是数字）不得炸整页、也不得报成连接失败', async () => {
  const { tbody, errors } = await renderTopics([SHIFTED], { tag: 'shifted' })

  assert.deepEqual(errors, [], '一条件字段错位的记录不该把整个取数流程抛出去')
  assert.match(tbody, /Anthropic被曝密会宗教领袖/, '那一行必须渲染出来（关键词在）')
  assert.doesNotMatch(
    tbody,
    /无法连接 Bridge/,
    '渲染问题不得被写成"无法连接 Bridge"——那会把排查方向带偏',
  )
  assert.doesNotMatch(tbody, /渲染失败/, '这条记录现在能正常渲染，不该走到渲染失败兜底')
})

test('选题库渲染：正常记录照常渲染（对照组）', async () => {
  const good = {
    ...SHIFTED,
    id: 'x',
    title: '',
    topicScore: 66,
    status: 'rejected',
    reason: '差异化低',
  }
  const { tbody } = await renderTopics([good], { tag: 'good' })
  assert.match(tbody, /Anthropic被曝密会宗教领袖/)
  assert.doesNotMatch(tbody, /渲染失败/)
})

test('选题库取数：fetch 真失败时仍然给"无法连接 Bridge"（好文案也钉住）', async () => {
  const { tbody } = await renderTopics([], { tag: 'nofetch', failFetch: true })
  assert.match(tbody, /无法连接 Bridge/)
})
