/**
 * 扩展选项页的「平台三态」判据（v2.3.2）——「未登录 0」假象的回归
 *
 * ## 被修的缺陷（2026-09-25 实测）
 *
 * `/proxy/platforms` 只返回**本轮检查范围内**的平台（模型 A：勾选集 = 检查集）。
 * 选项页把"范围内 12 个都已登录"渲染成「未登录 0」，而同一时刻磁盘上全量查出来的结果是
 * **27 个里 14 个未登录**（简书/豆瓣/雪球/搜狐/什么值得买/微博/语雀/慕课/开源中国/
 * SegmentFault/博客园/东方财富/网易/搜狐焦点）。用户看到的是"一切正常"的假象。
 *
 * 判据因此拆成三态：已登录 / 未登录（查过） / **未检查（没查过）**，后者绝不能被算进未登录，
 * 也绝不能让它的存在被一个光秃秃的 `未登录 0` 掩盖。
 *
 * 本文件测**纯函数**（不碰 DOM）：把分组、tab 文案、范围说明三处口径钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  groupPlatforms,
  loggedTabParts,
  loggedTabText,
  notLoggedTabParts,
  notLoggedTabText,
  scopeNoteText,
  uncheckedGroupTitle,
} from '../../bridge/chrome-proxy-extension/platform-groups.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXT = path.resolve(__dirname, '..', '..', 'bridge', 'chrome-proxy-extension')

/** 把分段拼回一句（页面就是这么渲染的：段与段之间 ' · '） */
const joinParts = (parts) => parts.map((p) => p.text).join(' · ')

/** 线上真值形状（12 个勾选平台全已登录 + 15 个未勾选） */
const SCOPED = {
  platforms: [
    { id: 'zhihu', isAuthenticated: true },
    { id: 'csdn', isAuthenticated: true },
    { id: 'weixin', isAuthenticated: true },
  ],
  scope: {
    ids: ['zhihu', 'csdn', 'weixin'],
    excluded: ['bilibili', 'jianshu', 'douban', 'xueqiu', 'weibo'],
    all: 8,
    count: 3,
    mode: 'scoped',
  },
  lastMode: 'scope',
}

/** 手动全量查之后的形状：返回列表含全部 8 个，其中 5 个未登录 */
const FULL = {
  platforms: [
    ...SCOPED.platforms,
    { id: 'bilibili', isAuthenticated: true },
    { id: 'jianshu', isAuthenticated: false },
    { id: 'douban', isAuthenticated: false },
    { id: 'xueqiu', isAuthenticated: false },
    { id: 'weibo', isAuthenticated: false },
  ],
  scope: { ...SCOPED.scope },
  lastMode: 'all',
}

test('① 范围内全已登录时：未登录 0，但必须把"未检查 5 个"摆出来（本次修的正是这条）', () => {
  const g = groupPlatforms(SCOPED)
  assert.equal(g.ok.length, 3)
  assert.equal(g.no.length, 0)
  assert.deepEqual(g.uncheckedIds, ['bilibili', 'jianshu', 'douban', 'xueqiu', 'weibo'])
  assert.equal(g.coverage.checked, 3)
  assert.equal(g.coverage.all, 8)

  // tab 文案：绝不能只有一个光秃秃的「未登录 0」
  assert.equal(notLoggedTabText(g), '未登录 0 · 未检查 5')
  assert.equal(loggedTabText(g), '已登录 3')
  assert.match(scopeNoteText(g), /未检查 5 个/)
  assert.match(uncheckedGroupTitle(g), /5 个/)

  // v2.3.4 不变量：分段（给数字上三态色用）与文案必须是同一条判据的两种呈现
  assert.equal(joinParts(notLoggedTabParts(g)), notLoggedTabText(g))
  assert.deepEqual(
    notLoggedTabParts(g).map((p) => p.tone),
    ['no', 'unk'],
    '未登录/未检查两段各自带状态色（红 / 琥珀）',
  )
  assert.equal(joinParts(loggedTabParts(g)), loggedTabText(g))
  assert.equal(loggedTabParts(g)[0].tone, 'ok')
})

test('② 手动全量查之后：未检查归零，未登录数如实出现（"点刷新全量查"的意义）', () => {
  const g = groupPlatforms(FULL)
  assert.equal(g.ok.length, 4)
  assert.equal(g.no.length, 4)
  assert.deepEqual(g.uncheckedIds, [], '返回列表已覆盖 scope.excluded，未检查必须是空')
  // v2.3.4 起计数不再用括号（与状态卡的等宽数字一致）：未登录 (4) → 未登录 4
  assert.equal(notLoggedTabText(g), '未登录 4')
  assert.match(scopeNoteText(g), /全部 8 个平台都已检查/)
})

test('③ 边界：返回列表里的平台不算未检查（重复计入是最容易写错的一处）', () => {
  // 单平台「🔍 查一下」会把范围外平台并进返回列表，此时它不该再出现在未检查里
  const g = groupPlatforms({
    platforms: [{ id: 'jianshu', isAuthenticated: false }],
    scope: { ids: ['zhihu'], excluded: ['jianshu'], all: 2, count: 1, mode: 'scoped' },
    lastMode: 'check',
  })
  assert.deepEqual(g.uncheckedIds, [])
  assert.equal(g.no.length, 1, '查过且未登录 → 未登录 1')
  assert.equal(notLoggedTabText(g), '未登录 1')
})

test('④ 边界：冷启动（platforms 为空）时未检查 = 全部范围外，且不把空列表说成"全部已登录"', () => {
  const g = groupPlatforms({
    platforms: [],
    scope: { ids: ['zhihu'], excluded: ['csdn'], all: 2, count: 1, mode: 'scoped' },
    lastMode: null,
  })
  assert.equal(g.ok.length, 0)
  assert.equal(g.no.length, 0)
  assert.deepEqual(g.uncheckedIds, ['csdn'])
  // v2.3.4 **加严**：一个平台都没核验过时，连「未登录 0」都不许出现 ——
  // "0" 是"查过之后的结果"，没查过就没有这个结果（与「已登录 0」同族的假象）。
  assert.equal(notLoggedTabText(g), '未检查 1')
  assert.equal(loggedTabText(g), '已登录 –')
  assert.equal(joinParts(notLoggedTabParts(g)), notLoggedTabText(g))
  assert.deepEqual(
    notLoggedTabParts(g),
    [{ tone: 'unk', text: '未检查 1' }],
    '没核验过 → 只有未检查那一段（不带未登录段）',
  )
  assert.deepEqual(loggedTabParts(g), [{ tone: 'none', text: '已登录 –' }], '未知不上色')
})

test('⑤ 边界：scope 缺失（老桥/无范围信息）时不崩、也不凭空造未检查', () => {
  const g = groupPlatforms({ platforms: [{ id: 'zhihu', isAuthenticated: true }] })
  assert.equal(g.ok.length, 1)
  assert.deepEqual(g.uncheckedIds, [])
  assert.equal(g.coverage.all, 1)
  assert.equal(notLoggedTabText(g), '未登录 0')
})

test('⑥ 接线：选项页必须以 module 加载、走同一份纯函数、并轮询到检查结束', () => {
  const html = fs.readFileSync(path.join(EXT, 'options.html'), 'utf8')
  const js = fs.readFileSync(path.join(EXT, 'options.js'), 'utf8')

  assert.match(
    html,
    /<script type="module" src="options\.js"><\/script>/,
    'options.js 要 import 纯函数模块，必须以 module 加载',
  )
  assert.match(
    js,
    /from '\.\/platform-groups\.mjs'/,
    '分组判据只能来自 platform-groups.mjs（勿在页面里重写一份）',
  )
  assert.match(js, /groupPlatforms\(/, '页面必须用 groupPlatforms 分组')
  // v2.3.4：tab 文案改由 region-state.mjs 的 regionLabels() 统一给出（内部即
  // notLoggedTabText/loggedTabText —— 分段与文案的等价性由 ①/④ 的不变量钉住）。
  // 这里改成**更强的**两条：入口必须是 regionLabels，且页面不得自己拼 tab 文案。
  assert.match(js, /regionLabels\(/, 'tab 文案必须走 regionLabels（含未检查数与可信度）')
  assert.match(js, /renderTabs\(labels\)/, 'tab 文案只能经 renderTabs(regionLabels(...)) 落地')
  assert.equal(
    (js.match(/\.innerHTML\s*=\s*tabMainHtml\(/g) || []).length,
    2,
    'tab 主标签只能经 tabMainHtml() 落地（且只有 renderTabs 里那两行）',
  )
  assert.match(js, /renderNotLoggedPane\(/, '未检查的平台要有单独一栏，不能被吞掉')
  assert.match(js, /\/proxy\/platform-matrix/, '未检查平台的名字来自 platform-matrix')
  assert.match(js, /CHECK_POLL_MS/, '刷新后要轮询到检查结束（否则只看到旧快照）')
  assert.match(js, /scopeNoteText\(/, '范围说明必须走 scopeNoteText')
})

/**
 * ⑦ DOM/样式契约（v2.3.3 视觉改造）——「彻底美化」最容易顺手砸掉的东西。
 *
 * 背景：v2.3.3 把内联 `<style>` 抽成 `options.css`、重排了报头/底栏、给行首加了字母牌。
 * 这类改动的失败方式很安静：少一个被断言的 id、样式表 404 导致页面裸奔、
 * 或者为了"好看"又写回内联 `onerror=`（v2.3.2 真浏览器实测过：MV3 CSP `script-src 'self'`
 * 会直接拦掉内联事件处理器，页面看起来正常但控制台报违规、兜底失效）。
 * 本用例把这些一次性钉住 —— 断言的都是**标识与存在性**，不是像素，所以样式还能继续改。
 */
test('⑦ DOM/样式契约：被断言的 id 一个不少、样式表/主题脚本真的接上、不引入 CSP 与远端资源风险', () => {
  const html = fs.readFileSync(path.join(EXT, 'options.html'), 'utf8')
  const cssPath = path.join(EXT, 'options.css')
  const css = fs.readFileSync(cssPath, 'utf8')

  // ① 被 JS 与其它测试依赖的 id（少一个就是"某个数字/按钮凭空消失"）
  for (const id of [
    'dot',
    'conn',
    'connLabel',
    'connPort',
    'themeToggle',
    'summary',
    'sumOk',
    'sumNo',
    'sumScope',
    'sumMeta',
    'sumTime',
    'sumNote',
    'covBar',
    'cfgBox',
    'cfgHost',
    'cfgWsPort',
    'saveCfg',
    'cfgHint',
    'cfgCur',
    'tabs',
    'tabOk',
    'tabOkSub',
    'tabNo',
    'tabNoSub',
    'panes',
    'paneOk',
    'paneNo',
    'openLogged',
    'openCount',
    'refresh',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `选项页缺 id="${id}"`)
  }

  // ② 结构：恰两个 pane、每个 pane 一个 .pane-body（滑动容器与三态分组都建在它上面）
  assert.equal((html.match(/class="pane"/g) || []).length, 2, '应当恰有两个 pane')
  assert.equal((html.match(/class="pane-body"/g) || []).length, 2, '每个 pane 一个 pane-body')

  // ③ 外置资源必须真的被引用（v2.3.3 的新失败模式：样式表 404 → 页面裸奔）
  assert.match(html, /<link rel="stylesheet" href="options\.css" \/>/, '必须引用 options.css')
  assert.match(html, /<script src="theme\.js"><\/script>/, '必须引用 theme.js（防闪白）')
  assert.ok(fs.existsSync(cssPath), 'options.css 必须存在')
  assert.ok(fs.existsSync(path.join(EXT, 'theme.js')), 'theme.js 必须存在')
  assert.match(css, /--paper:/, 'options.css 必须定义设计变量（纸底）')
  assert.match(css, /html\[data-theme='dark'\]/, 'options.css 必须有深色变量')
  // v2.3.4：tab 区数字的三态三色必须有专门 token，且**激活态单独一组**
  // （激活 tab 是墨底/米白底，直接用同一组颜色会糊掉）
  for (const v of [
    '--seg-ok',
    '--seg-no',
    '--seg-unk',
    '--seg-ok-on',
    '--seg-no-on',
    '--seg-unk-on',
  ]) {
    assert.match(css, new RegExp(v + ':'), `options.css 缺 ${v}（tab 数字的三态色）`)
  }
  // 每个 tab 两行：主标签（计数）+ 副标签（可信度）
  assert.equal((html.match(/class="tab-main"/g) || []).length, 2, '两个 tab 各有主标签')
  assert.equal((html.match(/class="tab-sub"/g) || []).length, 2, '两个 tab 各有可信度副标签')

  // ④ CSP：不得出现内联事件处理器与内联 <script>（v2.3.2 的教训）
  //    先剥掉注释：注释里写 `<script>` 字样（就是在解释本条规则）不算违规。
  const markup = html.replace(/<!--[\s\S]*?-->/g, '')
  assert.doesNotMatch(markup, /\son[a-z]+\s*=/i, 'HTML 不得出现内联事件处理器（MV3 CSP 会拦）')
  assert.doesNotMatch(
    markup,
    /<script(?![^>]*\bsrc=)[^>]*>/i,
    '不得出现内联 <script>（MV3 CSP script-src self）',
  )

  // ⑤ 离线可用：页面与样式都不得引用远端资源（选项页可能在没外网时打开）
  assert.doesNotMatch(css, /url\(\s*['"]?https?:/i, 'CSS 不得引用远端资源')
  assert.doesNotMatch(css, /@import/i, 'CSS 不得 @import')
  assert.doesNotMatch(html, /(href|src)="https?:/i, 'HTML 不得引用远端资源')
})
