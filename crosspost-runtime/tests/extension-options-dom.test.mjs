/**
 * 扩展选项页的 DOM 消费测试（v2.3.2）——用 jsdom 把**真实的 options.html + options.js** 跑起来
 *
 * ## 为什么用 jsdom 而不是浏览器
 *
 * 这条缺陷的形状是"**页面上少了一个数字**"：`/proxy/platforms` 只返回勾选范围内的 12 个平台，
 * 页面就把"12 个都已登录"渲染成「未登录 0」，而全量查出来 27 个里有 14 个未登录。
 * 纯函数单测（extension-platform-groups.test.mjs）钉住了分组口径，这里再钉**页面真的把它渲染出来**：
 *   · 范围内全已登录 → 「未登录 0 · 未检查 5」+ 未检查分组里有 5 个条目（旧代码这里是「未登录 (0)」）
 *   · 手动全量查之后 → 「未登录 4」、未检查分组消失、检查范围变 8/8
 *   · 点「刷新状态」→ 桥只触发不等待（refreshing=true），页面必须**轮询到检查结束**再渲染，
 *     否则用户看到的永远是点之前那份旧快照（"点刷新全量查"就成了空话）
 *
 * 走 jsdom（仓库已有依赖）而不是 Playwright：系统 Chrome 153 已忽略 `--load-extension`
 * （2026-09-25 实测：chrome-extension:// 页面 ERR_BLOCKED_BY_CLIENT），而这条断言不需要
 * 真浏览器——它考的是页面脚本的判据与渲染，不是 CSS 布局。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { JSDOM } from 'jsdom'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXT = path.resolve(__dirname, '..', '..', 'bridge', 'chrome-proxy-extension')
const HTML = fs.readFileSync(path.join(EXT, 'options.html'), 'utf8')

const MATRIX = {
  platforms: [
    { id: 'zhihu', name: '知乎' },
    { id: 'csdn', name: 'CSDN' },
    { id: 'weixin', name: '微信公众号' },
    { id: 'bilibili', name: '哔哩哔哩' },
    { id: 'jianshu', name: '简书' },
    { id: 'douban', name: '豆瓣' },
    { id: 'xueqiu', name: '雪球' },
    { id: 'weibo', name: '微博' },
  ],
}

/** 范围内 3 个全已登录；5 个未勾选没查过（线上是 12 全登录 / 15 未检查） */
const SCOPED = {
  platforms: [
    { id: 'zhihu', name: '知乎', isAuthenticated: true, username: 'u1' },
    { id: 'csdn', name: 'CSDN', isAuthenticated: true },
    { id: 'weixin', name: '微信公众号', isAuthenticated: true },
  ],
  checkedAt: Date.now() - 120000,
  refreshing: false,
  init: false,
  lastMode: 'scope',
  scope: {
    ids: ['zhihu', 'csdn', 'weixin'],
    excluded: ['bilibili', 'jianshu', 'douban', 'xueqiu', 'weibo'],
    all: 8,
    count: 3,
    mode: 'scoped',
  },
}

/** 手动全量查之后：8 个全查过，4 个未登录 */
const FULL = {
  ...SCOPED,
  platforms: [
    ...SCOPED.platforms,
    { id: 'bilibili', name: '哔哩哔哩', isAuthenticated: true },
    { id: 'jianshu', name: '简书', isAuthenticated: false },
    { id: 'douban', name: '豆瓣', isAuthenticated: false },
    { id: 'xueqiu', name: '雪球', isAuthenticated: false },
    { id: 'weibo', name: '微博', isAuthenticated: false },
  ],
  lastMode: 'all',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, { timeout = 12000, step = 100 } = {}) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时')
    await sleep(step)
  }
}

/**
 * 起一个"页面"：jsdom 解析真实 options.html，注入 chrome/fetch stub，
 * 再把真实 options.js 当 ES 模块 import 进来（页面脚本原样执行）。
 * @param {Array<object>} platformsQueue /proxy/platforms 依次返回的响应（最后一个会被重复用于轮询）
 */
async function bootPage(platformsQueue, { tag = 'case' } = {}) {
  const dom = new JSDOM(HTML, { url: 'http://127.0.0.1/', pretendToBeVisual: true })
  const calls = []
  let idx = 0
  const json = (data) => ({ json: async () => data })
  const fetchStub = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/proxy/bootstrap')) return json({ token: 'test-token' })
    if (u.includes('/proxy/status')) return json({ connected: true })
    if (u.includes('/proxy/platform-matrix')) return json(MATRIX)
    if (u.includes('/proxy/platforms')) {
      const r = platformsQueue[Math.min(idx, platformsQueue.length - 1)]
      idx += 1
      return json(r)
    }
    throw new Error('未预期的请求：' + u)
  }

  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    tabs: { create: () => {} },
    runtime: { sendMessage: async () => ({ ok: true }) },
  }
  globalThis.fetch = fetchStub

  // 每个用例用不同的 query 串 import：ES 模块有缓存，不这样第二次不会重新执行页面脚本
  await import(pathToFileURL(path.join(EXT, 'options.js')).href + `?${tag}`)

  const doc = dom.window.document
  return {
    dom,
    calls,
    $: (id) => doc.getElementById(id),
    text: (id) => doc.getElementById(id)?.textContent,
    paneNoItems: () => doc.querySelectorAll('#paneNo .pane-body .item').length,
    paneNoUnk: () => doc.querySelectorAll('#paneNo .pane-body .status.unk').length,
    paneNoGroupTitle: () =>
      doc.querySelector('#paneNo .pane-body .group-title')?.textContent || null,
    clickRefresh: () => doc.getElementById('refresh').dispatchEvent(new dom.window.Event('click')),
  }
}

test('① 范围内全已登录：「未登录 0」旁边必须写明「未检查 5」并列出这 5 个（缺陷现场）', async () => {
  const page = await bootPage([SCOPED], { tag: 'scoped' })
  await waitFor(() => page.text('sumNo') === '0')

  assert.equal(page.text('sumOk'), '3')
  assert.equal(page.text('sumNo'), '0')
  // 检查范围显示的是**本轮实际查到的平台数**（3/8），而不是配置里勾了几个
  assert.equal(page.text('sumScope'), '3/8')
  assert.equal(page.text('tabNo'), '未登录 0 · 未检查 5')
  assert.match(page.text('sumNote'), /未检查 5 个/)
  assert.match(page.paneNoGroupTitle() || '', /5 个/)
  assert.equal(page.paneNoUnk(), 5, '未检查的平台要逐个列出来（带「未检查」标签）')
  page.dom.window.close()
})

test('② 全量查之后：未检查消失、未登录数如实出现、范围变 8/8', async () => {
  const page = await bootPage([FULL], { tag: 'full' })
  await waitFor(() => page.text('sumNo') === '4')

  assert.equal(page.text('sumOk'), '4')
  assert.equal(page.text('sumNo'), '4')
  assert.equal(page.text('sumScope'), '8/8')
  // v2.3.4：计数记法统一（未登录 (4) → 未登录 4），数字由 .seg 承担三态颜色
  assert.equal(page.text('tabNo'), '未登录 4')
  assert.equal(page.paneNoGroupTitle(), null, '全查过之后不该还有未检查分组')
  assert.equal(page.paneNoUnk(), 0)
  assert.equal(page.paneNoItems(), 4, '4 个未登录平台都在未登录栏里')
  page.dom.window.close()
})

test('③ 点刷新：桥只触发不等待 → 页面必须轮询到检查结束再渲染（否则只看到旧快照）', async () => {
  const stale = { ...SCOPED, refreshing: true }
  const page = await bootPage([SCOPED, stale, FULL], { tag: 'poll' })
  await waitFor(() => page.text('sumNo') === '0')

  const before = page.calls.filter((u) => u.includes('/proxy/platforms')).length
  page.clickRefresh()
  // 轮询间隔 1.5s：第一轮就应拿到 FULL（本用例把它排在最后一位，后续轮询重复取它）
  await waitFor(() => page.text('sumNo') === '4', { timeout: 15000 })

  assert.equal(page.text('tabNo'), '未登录 4')
  assert.equal(page.text('sumScope'), '8/8')
  const after = page.calls.filter((u) => u.includes('/proxy/platforms')).length
  assert.ok(after >= before + 2, `刷新必须再查至少两次（触发 + 轮询），实际 ${before} → ${after}`)
  page.dom.window.close()
})

test('④ 连接失败：数字清空为「–」，不能拿旧数据当现状', async () => {
  const dom = new JSDOM(HTML, { url: 'http://127.0.0.1/', pretendToBeVisual: true })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    tabs: { create: () => {} },
    runtime: { sendMessage: async () => ({ ok: true }) },
  }
  globalThis.fetch = async () => {
    throw new Error('bridge down')
  }
  await import(pathToFileURL(path.join(EXT, 'options.js')).href + '?fail')
  const doc = dom.window.document
  await waitFor(() => doc.getElementById('sumNo')?.textContent === '–')

  assert.equal(doc.getElementById('sumOk').textContent, '–')
  assert.equal(doc.getElementById('sumScope').textContent, '–')
  assert.match(doc.getElementById('sumTime').textContent, /连接失败/)
  // v2.3.4 补：**tab 区也必须清空**。此前只有状态卡清空，tab 还留着上一轮的「已登录 12」——
  // 页面一边说"连接失败"一边说"12 个已登录"，是最容易看错的组合。
  assert.equal(doc.getElementById('tabOk').textContent, '已登录 –')
  assert.equal(doc.getElementById('tabNo').textContent, '未登录 –')
  assert.equal(doc.getElementById('tabOkSub').textContent, '数据不可用')
  assert.equal(doc.getElementById('tabNoSub').textContent, '数据不可用')
  dom.window.close()
})

test('⑤ 图标兜底：每行都有 .icon-wrap + 字母牌；无图标/未检查的行不留空洞', async () => {
  // 第 0 行给一个真图标（其余不给），覆盖"有图标 / 无图标 / 未勾选"三种行
  const withIcon = {
    ...SCOPED,
    platforms: [
      { ...SCOPED.platforms[0], icon: 'https://example.com/favicon.ico' },
      ...SCOPED.platforms.slice(1),
    ],
  }
  const page = await bootPage([withIcon], { tag: 'mono' })
  await waitFor(() => page.text('sumNo') === '0')
  const doc = page.dom.window.document

  const rows = [...doc.querySelectorAll('#paneOk .pane-body .item')]
  assert.equal(rows.length, 3)
  for (const r of rows) {
    assert.equal(r.querySelectorAll('.icon-wrap').length, 1, '行首必须有一个图标格')
    assert.equal(
      r.querySelectorAll('.icon-mono').length,
      1,
      '每行都要有字母牌兜底（失败/缺图时显形）',
    )
    assert.match(r.querySelector('.icon-mono').dataset.tone || '', /^[0-7]$/, '底色档位 0–7')
  }
  // 有图标的行：保留 img.icon（真浏览器测试数着它的显隐），wrap 不带 broken
  assert.equal(rows[0].querySelectorAll('img.icon').length, 1)
  assert.doesNotMatch(rows[0].querySelector('.icon-wrap').className, /broken/)
  // 无图标的行：没有 img，wrap 直接 broken → 字母牌显形（不再是灰方块占位）
  assert.equal(rows[1].querySelectorAll('img.icon').length, 0)
  assert.match(rows[1].querySelector('.icon-wrap').className, /broken/)
  assert.equal(rows[0].querySelector('.icon-mono').textContent, '知')
  assert.equal(rows[2].querySelector('.icon-mono').textContent, '微')

  // 未检查的 5 个：虚框字母牌 + 名字首字，登录态一格都不画
  const unk = [...doc.querySelectorAll('#paneNo .pane-body .item')]
  assert.equal(unk.length, 5)
  for (const r of unk) {
    assert.equal(r.querySelector('.icon-wrap').className, 'icon-wrap unknown')
    assert.equal(r.querySelectorAll('img.icon').length, 0)
    assert.equal(r.querySelectorAll('.icon-mono').length, 1)
    assert.equal(r.querySelectorAll('.status.unk').length, 1)
  }
  assert.equal(doc.querySelectorAll('#paneNo .pane-body .icon-mono').length, 5)
  page.dom.window.close()
})

test('⑥ 三态比例条：#covBar 的 data-* 就是三态真值（3/0/5 → 4/4/0）', async () => {
  // 为什么单独钉这条：v2.3.2 修的是"未检查"在**文案**里被 0 掩盖；
  // 比例条把它变成**看得见的一段**，所以它的分母/口径必须和三态分组同源。
  // 注意不能用 `all - checked` 反推未检查（用例③那种"查过但不属范围"会让两者不等），
  // 这里断言的就是"页面真的用了 g.uncheckedIds.length"。
  const page = await bootPage([SCOPED], { tag: 'cov' })
  await waitFor(() => page.text('sumNo') === '0')
  const bar = page.$('covBar')
  assert.equal(bar.dataset.ok, '3')
  assert.equal(bar.dataset.no, '0')
  assert.equal(bar.dataset.unk, '5')
  assert.equal(bar.hidden, false, '有范围数据时比例条必须显示')
  assert.equal(bar.querySelectorAll('.cov-seg').length, 3, '三段：已登录/未登录/未检查')
  page.dom.window.close()

  const page2 = await bootPage([FULL], { tag: 'cov-full' })
  await waitFor(() => page2.text('sumNo') === '4')
  const bar2 = page2.$('covBar')
  assert.equal(bar2.dataset.ok, '4')
  assert.equal(bar2.dataset.no, '4')
  assert.equal(bar2.dataset.unk, '0', '全量查过之后未检查必须归零（与分组同一口径）')
  page2.dom.window.close()
})

test('⑦ HTML 解析契约：报头/底栏/主题键真的进了 DOM（注释写错收尾符会静默吞掉整段）', () => {
  // 2026-09-25 实测踩到的形态：报头那段注释按 CSS 习惯用「星号加斜杠」收尾，
  // 于是注释一直吞到下一个真正的收尾符 —— `<header>` 连同品牌、标题、主题键
  // **整段没有进 DOM**，而页面只是"看起来没有报头"：不报错、控制台干净、
  // 字符串级断言（只读 options.html 原文）也照样通过。
  // 所以这里必须**解析**（jsdom），并额外确认注释正文没有漏成页面文字。
  const dom = new JSDOM(HTML)
  const doc = dom.window.document
  for (const sel of [
    'header.header',
    '.brand-mark',
    '.brand-sub',
    '#themeToggle',
    '#conn',
    '#dot',
    '#connLabel',
    '#connPort',
    'main.shell',
    '#summary',
    '#covBar',
    '#cfgBox',
    '#tabs',
    '#panes',
    'footer.footer',
    '#openLogged',
    '#openCount',
    '#refresh',
  ]) {
    assert.ok(
      doc.querySelector(sel),
      `解析后 DOM 里没有 ${sel} —— 多半是某段注释没有按 HTML 的方式收尾，把后面的标签吞了`,
    )
  }
  // 断言 DOM 顺序：报头 → 主体 → 底栏（外置样式表之后的位置无所谓，顺序影响 sticky 行为）
  assert.deepEqual(
    [...doc.body.children].filter((e) => e.tagName !== 'SCRIPT').map((e) => e.tagName),
    ['HEADER', 'MAIN', 'FOOTER'],
  )
  // 注释正文漏成页面文字是"提前收尾"的另一种形态：正文里不该出现注释里的词
  assert.doesNotMatch(doc.body.textContent, /收尾符|注释|宽度预算/, '注释正文漏成了页面文字')
  dom.window.close()
})

test('⑧ 上一次检查失败（data.error）**不是**取数失败：数字照常 + 副标签写明', async () => {
  // `data.error` 是桥记的**上一次检查**失败（例如那一轮扩展掉线），缓存还在。
  // 旧代码把它当致命错误抛出 → 整页清空成"无法获取平台状态"，把本来可信的缓存也丢了
  // （用户看到的是"什么都没了"，而真相是"数字是三分钟前的"）。
  const withErr = { ...SCOPED, error: '扩展未连接' }
  const page = await bootPage([withErr], { tag: 'checkerr' })
  await waitFor(() => page.text('sumNo') === '0')
  const doc = page.dom.window.document
  assert.equal(page.text('tabNo'), '未登录 0 · 未检查 5', '计数不该被清空')
  assert.equal(doc.getElementById('tabOk').textContent, '已登录 3')
  assert.equal(doc.getElementById('tabOkSub').textContent, '上次核对失败')
  assert.equal(doc.getElementById('tabOkSub').className, 'tab-sub err')
  assert.equal(doc.getElementById('tabNoSub').textContent, '未核验 · 状态未知')
  page.dom.window.close()
})

test('⑨ 复核中：数字保留（旧账）而把"正在重算"写在副标签上', async () => {
  const page = await bootPage([{ ...SCOPED, refreshing: true }], { tag: 'checking' })
  await waitFor(() => page.text('sumNo') === '0')
  const doc = page.dom.window.document
  assert.equal(page.text('tabOk'), '已登录 3', '复核期间旧数字不消失（清空会让人以为数据没了）')
  assert.equal(doc.getElementById('tabOkSub').textContent, '复核中…')
  assert.equal(doc.getElementById('tabOkSub').className, 'tab-sub run')
  assert.equal(doc.getElementById('tabNoSub').textContent, '未核验 · 状态未知')
  page.dom.window.close()
})

test('⑩ tab 数字带三态色：未登录=红段、未检查=琥珀段、已登录=绿段（文字中性）', async () => {
  const page = await bootPage([SCOPED], { tag: 'segments' })
  await waitFor(() => page.text('sumNo') === '0')
  const doc = page.dom.window.document
  const segs = [...doc.querySelectorAll('#tabs .seg')].map((e) => e.className + '|' + e.textContent)
  assert.deepEqual(segs, ['seg ok|3', 'seg no|0', 'seg unk|5'], '只给数字上色，文字保持中性')
  // textContent 仍与纯函数一致（分段拼接 = 一句文案）
  assert.equal(doc.getElementById('tabNo').textContent, '未登录 0 · 未检查 5')
  assert.equal(doc.getElementById('tabOk').textContent, '已登录 3')
  // 两行视觉标签的可访问名要连起来
  assert.equal(
    doc.querySelector('[data-pane="1"]').getAttribute('aria-label'),
    '未登录 0 · 未检查 5 · 未核验 · 状态未知',
  )
  page.dom.window.close()
})

// ── v2.3.3（视觉改造）新增的两条：它们钉的是**改造引入的新契约**，
//    上面 ①②③④ 四条正文一行未改 —— 那正是"美化没碰行为"的证明。 ──────────────
