#!/usr/bin/env node
/**
 * 扩展选项页真浏览器冒烟（v2.3.2）——「未登录 0」假象的端到端回归
 *
 * ## 为什么需要它（jsdom 测试盖不到的那一半）
 *
 * `extension-options-dom.test.mjs` 用 jsdom 直接 import `options.js`，跑得快、要得少，
 * 但它**绕过了 Chrome 自己的模块加载与 MV3 CSP**：选项页现在是
 * `<script type="module">` + `import './platform-groups.mjs'`，一旦 CSP 或路径不允许，
 * 页面会整块白掉——那种回归只有真浏览器能抓到。本脚本就干这一件事：
 * 把未打包扩展真的装进 Chromium，打开 `chrome-extension://<id>/options.html`，
 * 断言渲染结果 + **零页面错误**。
 *
 * ## 用哪个浏览器
 *
 * 系统 Chrome 稳定版 **153 起忽略 `--load-extension`**（2026-09-25 实测：
 * 带这个 flag 打开 chrome-extension:// 页面报 `ERR_BLOCKED_BY_CLIENT`），
 * 所以这里用 **Playwright 自带的 Chromium**（`npx playwright install chromium`）。
 * 没装就 skip 并写明理由（与 docker-contract 同一条取舍：缺工具不是代码红）。
 *
 * 运行：node crosspost-runtime/tests/extension-options-smoke.mjs
 *      KEEP=1 …   保留截图与临时 profile 供检查
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const EXT = path.join(REPO, 'bridge', 'chrome-proxy-extension')
const KEEP = !!process.env.KEEP
const SHOT_DIR = process.env.EXT_SHOT_DIR || os.tmpdir()

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`)
}

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch (e) {
  console.log(`－ 跳过：本机没有 playwright（${String(e.message).split('\n')[0]}）`)
  console.log('  装法与理由见文件头：npx playwright install chromium')
  process.exit(0)
}

const NAMES = {
  zhihu: '知乎',
  csdn: 'CSDN',
  weixin: '微信公众号',
  bilibili: '哔哩哔哩',
  jianshu: '简书',
  douban: '豆瓣',
  xueqiu: '雪球',
  weibo: '微博',
}
const MATRIX = { platforms: Object.entries(NAMES).map(([id, name]) => ({ id, name })) }
/** 范围内 3 个全已登录；5 个未勾选没查过（线上是 12 全登录 / 15 未检查） */
const SCOPED = {
  platforms: [
    { id: 'zhihu', name: '知乎', isAuthenticated: true, username: 'dos2unix' },
    { id: 'csdn', name: 'CSDN', isAuthenticated: true, username: '深频率' },
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
/** 手动全量查之后：8 个都查过，其中 4 个未登录 */
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
/**
 * 三态**同时存在**的一份数据（v2.3.3 的三色断言需要它）：
 * 已登录 3 + 未登录 1（简书，虽在 scope.excluded 里但本轮真的查过）+
 * 未检查 4（排除掉已查过的简书）。SCOPED/FULL 各自缺一态，所以另造一份。
 */
const MIXED = {
  ...SCOPED,
  platforms: [...SCOPED.platforms, { id: 'jianshu', name: '简书', isAuthenticated: false }],
}

/** 浅色纸底（与 options.css 的 --paper 同值）：用于"深色真的换底了"这条断言 */
const LIGHT_PAPER = 'rgb(246, 243, 236)'

/** 'rgb(r, g, b)' → [r, g, b]（拿不到就返回 null） */
const rgb = (s) => {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(String(s))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-ext-smoke-'))
let ctx = null

try {
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      // headless:false + --headless=new：扩展只在"新版无头"或 headed 下加载
      //（Playwright 的 headless:true 走的是 headless shell，不带扩展支持）
      headless: false,
      args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    })
  } catch (e) {
    const msg = String(e.message || e)
    if (/Executable doesn't exist|install/i.test(msg)) {
      console.log('－ 跳过：Playwright 的 Chromium 未安装（npx playwright install chromium）')
      process.exit(0)
    }
    throw e
  }

  let sw = ctx.serviceWorkers()[0]
  for (let i = 0; i < 60 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 250))
    sw = ctx.serviceWorkers()[0]
  }
  check('未打包扩展在 Chromium 里注册成功（拿到 service worker）', !!sw, sw ? sw.url() : '')
  if (!sw) throw new Error('扩展没加载起来，后续无法验证')

  const id = new URL(sw.url()).host
  const errors = []
  /** ③ 故意用坏图标触发兜底逻辑：那一页的资源加载错误是预期之内的（CSP 违规照收） */
  const allowResourceErrors = new WeakSet()

  /**
   * 只收集**我们自己的**错误。
   *
   * 远端平台图标是各家站点自己的 favicon（`p.icon` 是 https 链接），它们失败与否**不是我们的
   * 缺陷** —— 实测 `https://blog.51cto.com/favicon.ico` 会返回一个非标准的 **567**，
   * 页面已经用 `bindIconFallbacks` 把图藏掉。所以这里放过 `http(s)://` 的 `Failed to load
   * resource`，但**保留**：未捕获异常、CSP 违规（内联事件处理器就属于这一类）、
   * 以及扩展自身（`chrome-extension://`）资源的失败。
   */
  const collectError = (m, page) => {
    const text = m.text()
    const fromSelf = page ? (m.location()?.url || '').startsWith('chrome-extension://') : false
    if (allowResourceErrors.has(page) && /Failed to load resource/i.test(text)) return
    if (
      /Failed to load resource/i.test(text) &&
      !fromSelf &&
      !/Content Security Policy/i.test(text)
    )
      return
    errors.push('console: ' + text)
  }

  /** 起一个页面：全部 API 用 route 接管，绝不打真实桥（也不触发真实平台检查） */
  const openPage = async (
    platformsPayload,
    {
      allowResourceErrorsOnPage = false,
      viewport = null,
      dark = false,
      breakPlatforms = false,
    } = {},
  ) => {
    const page = await ctx.newPage()
    if (viewport) await page.setViewportSize(viewport)
    // 深色：在**首帧之前**预置偏好（theme.js 读 localStorage），验证"打开即深色、不闪白"
    if (dark) {
      await page.addInitScript(() => {
        try {
          localStorage.setItem('crosspost-theme', 'dark')
        } catch {
          /* 写不进去就退化成跟随系统（浅色），下面的断言会指出 */
        }
      })
    }
    if (allowResourceErrorsOnPage) allowResourceErrors.add(page)
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') collectError(m, page)
    })
    await page.route('**/proxy/bootstrap*', (r) => r.fulfill({ json: { token: 'smoke' } }))
    await page.route('**/proxy/status*', (r) => r.fulfill({ json: { connected: true } }))
    await page.route('**/proxy/platform-matrix*', (r) => r.fulfill({ json: MATRIX }))
    // breakPlatforms：模拟"桥取不到数"（桥没运行 / 端口错 / token 错）——
    // 这一条要断言 tab 区**也**清成 –（旧版本只有状态卡清空，tab 还留着"已登录 12"）
    await page.route('**/proxy/platforms*', (r) =>
      breakPlatforms ? r.abort('failed') : r.fulfill({ json: platformsPayload }),
    )
    await page.goto(`chrome-extension://${id}/options.html`)
    await page.waitForTimeout(800)
    return page
  }

  // ── ① 范围内全已登录：必须写明"未检查 5"，并把这 5 个列出来 ──
  {
    const page = await openPage(SCOPED)
    const seen = await page.evaluate(() => ({
      ok: document.getElementById('sumOk').textContent,
      no: document.getElementById('sumNo').textContent,
      scope: document.getElementById('sumScope').textContent,
      note: document.getElementById('sumNote').textContent,
      tabNo: document.getElementById('tabNo').textContent,
      unk: document.querySelectorAll('#paneNo .pane-body .status.unk').length,
      group: document.querySelector('#paneNo .pane-body .group-title')?.textContent || '',
    }))
    check(
      '已登录/未登录/范围三格读数正确（3 / 0 / 3比8）',
      seen.ok === '3' && seen.no === '0' && seen.scope === '3/8',
      JSON.stringify(seen),
    )
    check(
      '未登录 0 旁边写明「未检查 5」（缺陷现场）',
      seen.tabNo === '未登录 0 · 未检查 5' && /未检查 5 个/.test(seen.note),
      `${seen.tabNo} · ${seen.note}`,
    )
    check(
      '未检查的平台单列一组（5 个，带「未检查」标签）',
      seen.unk === 5 && /未检查平台（未勾选，5 个）/.test(seen.group),
      JSON.stringify({ unk: seen.unk, group: seen.group }),
    )
    await page.screenshot({ path: path.join(SHOT_DIR, 'ext-options-scoped.png'), fullPage: true })
    await page.close()
  }

  // ── ② 全量查之后：未检查归零、未登录数如实出现 ──
  {
    const page = await openPage(FULL)
    const seen = await page.evaluate(() => ({
      ok: document.getElementById('sumOk').textContent,
      no: document.getElementById('sumNo').textContent,
      scope: document.getElementById('sumScope').textContent,
      tabNo: document.getElementById('tabNo').textContent,
      unk: document.querySelectorAll('#paneNo .pane-body .status.unk').length,
      group: document.querySelector('#paneNo .pane-body .group-title')?.textContent || '',
      items: document.querySelectorAll('#paneNo .pane-body .item').length,
    }))
    check(
      '全量查之后：未登录 4、范围 8比8、未检查分组消失',
      seen.no === '4' && seen.scope === '8/8' && seen.unk === 0 && seen.group === '',
      JSON.stringify(seen),
    )
    check('未登录的 4 个平台都列在未登录栏', seen.items === 4, `items=${seen.items}`)
    await page.screenshot({ path: path.join(SHOT_DIR, 'ext-options-full.png'), fullPage: true })
    await page.close()
  }

  // ── ③ 图标加载失败：必须由 JS 兜底藏掉，且**不得**出现 CSP 违规 ──
  //
  // 这一条钉的是 2026-09-25 真浏览器实测到的另一个缺陷：`itemHtml` 曾用
  // `onerror="this.style.visibility='hidden'"` 内联属性，而 MV3 扩展页的 CSP 是
  // `script-src 'self'` —— 内联事件处理器会被直接拦掉（控制台报 CSP 违规），图也不藏。
  // 用"必然会失败的 icon"来触发，不依赖任何远端站点。
  {
    const broken = {
      ...SCOPED,
      platforms: SCOPED.platforms.map((p) => ({
        ...p,
        icon: 'chrome-extension://' + id + '/不存在.ico',
      })),
    }
    const page = await openPage(broken, { allowResourceErrorsOnPage: true })
    const seen = await page.evaluate(() => ({
      icons: [...document.querySelectorAll('img.icon')].map((i) => getComputedStyle(i).visibility),
      brokenWraps: [...document.querySelectorAll('.icon-wrap.broken')].length,
      monoShown: [...document.querySelectorAll('.icon-wrap.broken .icon-mono')].map(
        (m) => getComputedStyle(m).display,
      ),
      monoText: [...document.querySelectorAll('.icon-wrap.broken .icon-mono')].map(
        (m) => m.textContent,
      ),
    }))
    check(
      '图标加载失败时被 JS 兜底藏掉（不再留破图占位）',
      seen.icons.length === 3 && seen.icons.every((v) => v === 'hidden'),
      JSON.stringify(seen.icons),
    )
    // v2.3.3：藏掉之后行首不能再是空洞 —— 字母牌必须显形，且是平台名的首字
    check(
      '图标失败后由平台名字母牌补位（知乎→知，v2.3.3）',
      seen.brokenWraps === 3 &&
        seen.monoShown.length === 3 &&
        seen.monoShown.every((v) => v === 'flex') &&
        seen.monoText[0] === '知',
      JSON.stringify({ wraps: seen.brokenWraps, display: seen.monoShown, text: seen.monoText }),
    )
    await page.close()
  }

  // ── ④ 版面：320 不得横向溢出；760 外壳变宽、副标题/id 列/连接标签生效 ──
  //
  // 这一条钉的是改造前的实际观感缺陷（用户截图那一版）：`html{width:320px}` 让页面成为
  // 贴在左边的一条纸带，列表又被 `max-height:340px` 切在半行上。现在外壳 320↔760 自适应、
  // 列表走自然滚动。**横向绝不出现滚动条**是硬约束（`.panes` 里装着 2×外壳宽的内容，
  // 一旦 `contain: inline-size` 失效就会撑宽文档 —— 肉眼在宽屏上完全看不出来）。
  {
    const NARROW = { width: 320, height: 800 }
    const page = await openPage(SCOPED, { viewport: NARROW })
    await page.waitForTimeout(400) // 让比例条的宽度过渡（0.3s）落定
    const narrow = await page.evaluate(() => {
      const shell = document.querySelector('main.shell').getBoundingClientRect().width
      const bar = document.getElementById('covBar').getBoundingClientRect().width
      const seg = (cls) => document.querySelector('.cov-seg.' + cls).getBoundingClientRect().width
      const cs = (sel) => getComputedStyle(document.querySelector(sel))
      return {
        docW: document.documentElement.scrollWidth,
        viewW: document.documentElement.clientWidth,
        shellW: shell,
        paper: getComputedStyle(document.body).backgroundColor,
        connLabel: cs('#connLabel').display,
        connPort: document.getElementById('connPort').textContent,
        // 窄屏必须藏起来的三处（宽度预算）：副标题、平台 id 列、连接标签
        sub: cs('.brand-sub').display,
        platId: cs('.plat-id').display,
        header: !!document.querySelector('header.header'),
        themeToggle: !!document.getElementById('themeToggle'),
        barW: bar,
        okW: seg('ok'),
        noW: seg('no'),
        unkW: seg('unk'),
        cssLoaded: !!document.styleSheets.length,
      }
    })
    check(
      '320：不得横向溢出（.panes 的 2 倍内容不许撑宽文档）',
      narrow.docW <= narrow.viewW + 1,
      `docW=${narrow.docW} viewW=${narrow.viewW}`,
    )
    check(
      '320：外壳保持控制面板宽（≈300–320）',
      narrow.shellW > 296 && narrow.shellW <= 320,
      `shell=${narrow.shellW}`,
    )
    check(
      '320：样式表真的生效（纸底 + 恰一段比例条）',
      narrow.cssLoaded && narrow.paper === LIGHT_PAPER,
      JSON.stringify({ css: narrow.cssLoaded, paper: narrow.paper }),
    )
    check(
      '320：已连接时只显示端口（宽度预算），未连接才显示中文原因',
      narrow.connLabel === 'none' && narrow.connPort === ':9539',
      JSON.stringify({ label: narrow.connLabel, port: narrow.connPort }),
    )
    // 报头/主题键必须真的在 DOM 里（注释写错收尾符会把它们整段吞掉：不报错、控制台干净）
    check(
      '320：报头与主题键存在，三处宽屏信息（副标题/id 列/连接标签）都藏起来',
      narrow.header &&
        narrow.themeToggle &&
        narrow.sub === 'none' &&
        narrow.platId === 'none' &&
        narrow.connLabel === 'none',
      JSON.stringify({
        header: narrow.header,
        toggle: narrow.themeToggle,
        sub: narrow.sub,
        platId: narrow.platId,
      }),
    )
    // 三态比例条：3/8 绿、0 红、5/8 琥珀 —— 每段真的画出宽度（用 CSS 变量上色后的真实布局）
    // tab 区两行文案在 320 下**不得被截断**（scrollWidth > clientWidth 就是被省略号切了）
    const tabFit = await page.evaluate(() =>
      [...document.querySelectorAll('.tab-main, .tab-sub')].map((e) => ({
        text: e.textContent,
        cut: e.scrollWidth > e.clientWidth + 1,
      })),
    )
    check(
      '320：两个 tab 的主/副标签都不被截断（4 行文案全都放得下）',
      tabFit.length === 4 && tabFit.every((t) => !t.cut),
      JSON.stringify(tabFit),
    )
    check(
      '320：三态比例条按 3/0/5 分段画出（未检查是看得见的一段）',
      Math.abs(narrow.okW - narrow.barW * (3 / 8)) <= 2 &&
        narrow.noW <= 1 &&
        Math.abs(narrow.unkW - narrow.barW * (5 / 8)) <= 2,
      JSON.stringify({ bar: narrow.barW, ok: narrow.okW, no: narrow.noW, unk: narrow.unkW }),
    )
    await page.screenshot({
      path: path.join(SHOT_DIR, 'ext-options-narrow-light.png'),
      fullPage: true,
    })
    await page.close()

    const page2 = await openPage(SCOPED, { viewport: { width: 760, height: 800 } })
    const wide = await page2.evaluate(() => {
      // 空值安全：拿不到就回 null，让断言带着"缺哪个"的现场信息红，而不是抛 TypeError
      const cs = (sel) => {
        const el = document.querySelector(sel)
        return el ? getComputedStyle(el).display : null
      }
      return {
        docW: document.documentElement.scrollWidth,
        viewW: document.documentElement.clientWidth,
        shellW: document.querySelector('main.shell').getBoundingClientRect().width,
        sub: cs('.brand-sub'),
        platId: cs('.plat-id'),
        connLabel: cs('#connLabel'),
        rows: document.querySelectorAll('#paneOk .pane-body .item').length,
        ids: [...document.querySelectorAll('#paneOk .pane-body .plat-id')].map(
          (e) => e.textContent,
        ),
      }
    })
    check(
      '760：外壳变宽到署名表宽度且仍不横向溢出',
      wide.shellW >= 700 && wide.docW <= wide.viewW + 1,
      JSON.stringify(wide),
    )
    check(
      '760：副标题 / 平台 id 列 / 连接标签在宽屏显示（窄屏藏起来的三处）',
      // 注意不能用 `display === 'inline'/'inline-block'` 判定：它们是 flex 项，
      // Chrome 会把 flex 项的 display **块化**（computed 值报 block），这是规范行为
      wide.sub !== 'none' && wide.platId !== 'none' && wide.connLabel !== 'none',
      JSON.stringify(wide),
    )
    check('760：平台行数不变（3 个已登录）', wide.rows === 3, `rows=${wide.rows}`)
    await page2.screenshot({
      path: path.join(SHOT_DIR, 'ext-options-wide.png'),
      fullPage: true,
    })
    await page2.close()
  }

  // ── ⑤ 三态必须三种颜色（v2.3.2 的教训从"文案"升到"颜色"） ──
  //
  // 文案层面的回归已有 jsdom 测试守着；这一条守的是**看起来能不能分辨**：
  // 若有人把「未检查」改成灰、或把三态合成两种颜色，琥珀那段与灰标签会一起消失 ——
  // 而"未检查"正是 v2.3.2 那条 bug 的核心。用 MIXED（三态同时存在）才能一次比完。
  {
    const page = await openPage(MIXED, { viewport: { width: 320, height: 900 } })
    const got = await page.evaluate(() => {
      const c = (sel) => {
        const el = document.querySelector(sel)
        return el ? getComputedStyle(el).color : null
      }
      return {
        ok: c('#paneOk .status.ok'),
        no: c('#paneNo .status.no'),
        unk: c('#paneNo .status.unk'),
      }
    })
    const [okC, noC, unkC] = [rgb(got.ok), rgb(got.no), rgb(got.unk)]
    check(
      '三态三色：已登录绿 / 未登录红 / 未检查琥珀，两两不同',
      !!okC && !!noC && !!unkC && new Set([got.ok, got.no, got.unk]).size === 3,
      JSON.stringify(got),
    )
    check(
      '三态三色的色相方向正确（绿偏 g、红偏 r 且 g 很低、琥珀偏 r 但 g 明显）',
      !!okC &&
        !!noC &&
        !!unkC &&
        okC[1] > okC[0] &&
        noC[0] > noC[1] &&
        noC[1] < 90 &&
        unkC[0] > unkC[1] &&
        unkC[1] >= 100,
      JSON.stringify({ ok: okC, no: noC, unk: unkC }),
    )
    await page.close()
  }

  // ── ⑥ 交互：点第二个 tab 真的滚到第二栏（滚动目标是 index × clientWidth） ──
  //
  // 为什么需要真浏览器：jsdom 没有布局（clientWidth 恒 0），滚动目标算错它抓不到；
  // 而"点了 tab 没反应"正是这类改造最容易留下的缺陷。
  {
    const page = await openPage(SCOPED, { viewport: { width: 320, height: 900 } })
    await page.click('#tabs .tab[data-pane="1"]')
    await page.waitForTimeout(900) // 平滑滚动
    const st = await page.evaluate(() => ({
      left: Math.round(document.getElementById('panes').scrollLeft),
      w: Math.round(document.getElementById('panes').clientWidth),
      active: document.querySelectorAll('#tabs .tab.active').length,
      aria0: document.querySelector('[data-pane="0"]').getAttribute('aria-selected'),
      aria1: document.querySelector('[data-pane="1"]').getAttribute('aria-selected'),
    }))
    check(
      '点第二个 tab：面板滚动到第二栏（index × clientWidth）',
      st.w > 0 && st.left >= st.w - 2,
      JSON.stringify(st),
    )
    check(
      'tab 高亮与 aria-selected 同步（恰一个 active）',
      st.active === 1 && st.aria0 === 'false' && st.aria1 === 'true',
      JSON.stringify(st),
    )
    await page.close()
  }

  // ── ⑦ 深色：theme.js 在首帧前定色（预置 localStorage 后打开不闪白） ──
  {
    const page = await openPage(SCOPED, { viewport: { width: 380, height: 800 }, dark: true })
    const dark = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      paper: getComputedStyle(document.body).backgroundColor,
      toggle: document.getElementById('themeToggle').textContent.trim(),
      panel: getComputedStyle(document.querySelector('.pane-body')).backgroundColor,
    }))
    check(
      '深色：首帧即 data-theme=dark（不闪白），纸底换成深色值',
      dark.theme === 'dark' && dark.paper !== LIGHT_PAPER,
      JSON.stringify(dark),
    )
    check('深色：主题键字形为 ☾（浅 ☀ / 跟系统 ◐）', dark.toggle === '☾', dark.toggle)
    // 先截图再点切换：否则截到的是切回浅色之后的画面
    await page.screenshot({
      path: path.join(SHOT_DIR, 'ext-options-narrow-dark.png'),
      fullPage: true,
    })
    await page.click('#themeToggle') // 深 → 跟系统；Playwright 默认系统浅色
    // 等久一点（>400ms）：body 有 background .2s 过渡，读太早会拿到**插值中**的颜色，
    // 断言会随机器快慢偶发变红（实测踩到 rgb(245,242,235) 这种只差 1 的中间值）
    await page.waitForTimeout(500)
    const after = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      paper: getComputedStyle(document.body).backgroundColor,
      persisted: localStorage.getItem('crosspost-theme'),
    }))
    check(
      '深色：点主题键 → 跟系统（系统浅色 ⇒ 回浅色底）且偏好已持久化',
      after.theme === 'light' &&
        after.paper !== dark.paper &&
        after.paper === LIGHT_PAPER &&
        after.persisted === 'system',
      JSON.stringify({ after, darkPaper: dark.paper }),
    )
    await page.close()
  }

  // ── ⑧ tab 区状态化（v2.3.4）：数字三态色 / 复核中 / 桥取不到数 ──
  {
    // ⑧a 数字三态色：文字中性，只有数字带色；三色两两不同，且都不等于文字色
    const page = await openPage(MIXED, { viewport: { width: 320, height: 900 } })
    const seg = await page.evaluate(() => {
      const cs = (sel) => {
        const el = document.querySelector(sel)
        return el
          ? { color: getComputedStyle(el).color, fam: getComputedStyle(el).fontFamily }
          : null
      }
      return {
        ok: cs('#tabOk .seg'),
        no: cs('#tabNo .seg.no'),
        unk: cs('#tabNo .seg.unk'),
        tabText: getComputedStyle(document.querySelector('#tabNo')).color,
      }
    })
    check(
      '⑧a tab 数字三态三色（绿/红/琥珀），两两不同且都不等于文字色',
      !!seg.ok &&
        !!seg.no &&
        !!seg.unk &&
        new Set([seg.ok.color, seg.no.color, seg.unk.color]).size === 3 &&
        seg.no.color !== seg.tabText &&
        /Mono|monospace/i.test(seg.no.fam),
      JSON.stringify(seg),
    )
    await page.close()

    // ⑧b 复核中：数字保留（旧账），副标签写明"正在重算"
    const page2 = await openPage(
      { ...SCOPED, refreshing: true },
      { viewport: { width: 320, height: 900 } },
    )
    const checking = await page2.evaluate(() => ({
      ok: document.getElementById('tabOk').textContent,
      okSub: document.getElementById('tabOkSub').textContent,
      subCls: document.getElementById('tabOkSub').className,
      noSub: document.getElementById('tabNoSub').textContent,
    }))
    check(
      '⑧b 复核中：计数保留 + 副标签「复核中…」（不把旧账说成本轮结果）',
      checking.ok === '已登录 3' &&
        checking.okSub === '复核中…' &&
        /\brun\b/.test(checking.subCls) &&
        checking.noSub === '未核验 · 状态未知',
      JSON.stringify(checking),
    )
    await page2.close()

    // ⑧c 桥取不到数：tab 也必须清成 –
    const page3 = await openPage(SCOPED, {
      viewport: { width: 320, height: 900 },
      breakPlatforms: true,
    })
    const dead = await page3.evaluate(() => ({
      ok: document.getElementById('tabOk').textContent,
      no: document.getElementById('tabNo').textContent,
      okSub: document.getElementById('tabOkSub').textContent,
      err: !!document.querySelector('#paneOk .error'),
    }))
    check(
      '⑧c 桥取不到数：tab 一起清成「已登录 – / 未登录 –」并写明数据不可用',
      dead.ok === '已登录 –' && dead.no === '未登录 –' && dead.okSub === '数据不可用' && dead.err,
      JSON.stringify(dead),
    )
    await page3.close()
  }

  check(
    '整个过程中零页面错误（MV3 CSP / 模块加载 / 脚本异常；远端站点自身状态码不算）',
    errors.length === 0,
    errors.join(' | '),
  )
  console.log(
    `\n截图：${SHOT_DIR}/ext-options-scoped.png · ${SHOT_DIR}/ext-options-full.png · ` +
      `ext-options-narrow-light.png · ext-options-narrow-dark.png · ext-options-wide.png`,
  )
} finally {
  if (ctx) await ctx.close()
  if (KEEP) console.log(`\n临时 profile 保留：${profile}`)
  else fs.rmSync(profile, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
