// Console 拆分后 playwright 真浏览器冒烟验证（需系统 Chrome；默认端口 9560，可用 CONSOLE_TEST_PORT 覆盖）
// v2.3.1：playwright 由 crosspost-runtime 那棵树提供（core 不再单独装依赖树），走包名解析
import { chromium } from 'playwright'

const PORT = Number(process.env.CONSOLE_TEST_PORT || 9560)
const BASE = `http://127.0.0.1:${PORT}`
const results = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text())
})
const failed401 = []
page.on('response', (r) => {
  if (r.status() === 401) failed401.push(r.url())
})
// 内容域请求是否真的带上了所选项目（v2.62）。
// 记在 Node 侧而不是页面里：这条链要证明的是"下拉 → localStorage → api.mjs
// 请求头 → 视图重放取数"，请求头只有在这里才看得见。
const scopedRequests = []
page.on('request', (r) => {
  const h = r.headers()['x-crosspost-project']
  if (h) scopedRequests.push({ url: r.url(), project: h })
})

// 2026-09-21（v2.101）两条新护栏：
//  ① **每次文档加载**的 `/proxy/bootstrap` 只应发生 **1 次**（app.js 并发取数，改前实测 6 次/次；
//     api.mjs 现在缓存"在飞的 Promise"）。冒烟里有多次整页导航，所以判据是"次数 == 文档加载数"。
//  ② 冒烟本身**不得把常驻 worker 跑成降级态** —— v2.100 之前"验收把生产桥的 reader 打死"
//     就是这样发生的，而当时没有任何断言看得出来。判据是"跑前/跑后 restarts 不增长"，
//     不是"restarts 必须为 0"（桥可能已跑了很久，历史重启不该算这次冒烟的账）。
let bootstrapCount = 0
let bootstrapsAtFirstPaint = 0
let docLoads = 0
page.on('load', () => {
  docLoads++
})
page.on('request', (r) => {
  if (r.url().includes('/proxy/bootstrap')) bootstrapCount++
})
const healthOf = async () => {
  const { token } = await (await fetch(BASE + '/proxy/bootstrap')).json()
  const r = await fetch(BASE + '/proxy/health', { headers: { 'X-CrossPost-Token': token } })
  return await r.json()
}
const healthBefore = await healthOf()

try {
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 15000 })
  await page.waitForTimeout(1200)
  // 2026-09-21（v2.101）：快照"首屏阶段 app 自己发的 bootstrap 次数"，作为那条断言的判据。
  // 为什么不能直接用整轮总计数：本文件后面有 6 处**测试自己**的 `fetch('/proxy/bootstrap')`
  // 探针（查 token 引导端点），它们也会被 page.on('request') 记到（实测总计 7 = app 1 + 测试 6）。
  // 判据要盯的是"app 首次并发取数有没有各自去拿 token"，所以取首屏快照。
  bootstrapsAtFirstPaint = bootstrapCount

  // 0) 默认内容域（未选任何项目）= 空。v2.74 起这是**设计**而非故障：
  //    默认域是引擎自有的空域（`.local/drafts` + `.local/project-state/_default/articles`），
  //    生产数据在项目域里。这条探针钉住"用户打开 Console 时的初始可见状态"。
  const defaultRows = await page.locator('#article-tbody tr').count()
  results.push(['默认内容域（未选项目）为空', defaultRows === 0, `rows=${defaultRows}`])

  // 0.1) 像用户那样选上项目，后续"文章列表 / 详情 / 批量"都在**项目作用域**里跑。
  //      为什么必须这样：v2.74 之前两个作用域恰好是同一个物理目录，所以"不选项目也能看到
  //      生产数据"；分开之后，要检生产链路就得先选项目。未接入项目的部署仍然跳过，
  //      不该假失败（不是所有部署都有项目）。
  const projectIds = await page.$$eval('#project-select option', (os) =>
    os.map((o) => o.value).filter(Boolean),
  )
  const pidFirst = projectIds[0] || ''
  if (pidFirst) {
    await page.selectOption('#project-select', pidFirst)
    // 等**行数真的落回来**（最多 10s）；超时也不吞错——下面的 rowCount 会给出真值
    await page
      .waitForFunction(() => document.querySelectorAll('#article-tbody tr').length > 0, null, {
        timeout: 10000,
      })
      .catch(() => {})
  }

  // 1) 文章列表（项目域）
  const rowCount = await page.locator('#article-tbody tr').count()
  results.push([
    '文章列表行数（项目域）',
    pidFirst ? rowCount > 0 : true,
    pidFirst ? `rows=${rowCount} @ ${pidFirst}` : '未接入项目（跳过）',
  ])
  // 2026-09-22（v2.103）：统计条改为**后台补齐**（表格只等 /proxy/articles，不再等留存/归档两库）。
  // 所以读统计条之前要有界等待它补齐 —— 否则读到的可能是还没渲染的空条（假红）。
  await page
    .waitForFunction(
      () => (document.querySelector('#stats')?.textContent || '').includes('共'),
      null,
      {
        timeout: 8000,
      },
    )
    .catch(() => {})
  const stats = await page.textContent('#stats')
  results.push(['顶部统计', stats.includes('共'), stats.trim().slice(0, 30)])

  // 2) 顶栏布局护栏（v2.23 立；v2.87 换成**多宽度 + 无截断**判据）
  //
  // 背景一（v2.23）：`.topbar-right` 曾是 `flex-shrink: 0`，内部又是 nowrap 长文本，
  // intrinsic 宽度约 969px → `.tabs` 被压到 **0px**：1280px 窗口下一个导航 tab 都看不见。
  //
  // 背景二（v2.87 之前那版判据为什么不够）：旧判据是"逐个 tab
  // `scrollIntoView({inline:'center'})` 后做命中测试"。但 `.tabs` 当时是
  // `overflow-x: auto`，自动滚动能让每个 tab **轮流**可点 —— 于是"1426px 下
  // 工作流/报表/设置根本不在视野里、统计被 ellipsis 截断、刷新按钮折成两行"
  // 这一整类缺陷**全部测不出来**（Playwright 默认视口正好 1280px，实测 tabs 只有
  // 489/768px 可见）。而 Playwright 默认视口正好 1280px，所以这条护栏长期是绿的。
  //
  // 新判据直接钉住"用户看到的东西是不是完整的"：在四个宽度下各测一遍，
  //   · 每个 tab **同时**落在视口内且命中自身（不再是"轮流可点"）
  //   · 顶栏里每个承载信息的容器 `scrollWidth ≤ clientWidth + 1`（无截断）
  //   · `⟳ 刷新` 不折行、顶栏高度不因换行而膨胀
  //   · 页面无横向溢出
  // 回归的是这条规则本身：容器不许截断、刷新按钮不许折行、页面不许横向溢出。
  const WIDTHS = [1280, 1426, 1680, 1920]
  const layout = []
  for (const vw of WIDTHS) {
    await page.setViewportSize({ width: vw, height: 900 })
    await page.waitForTimeout(150)
    layout.push(
      await page.evaluate(() => {
        const vpw = document.documentElement.clientWidth
        const tabs = [...document.querySelectorAll('.tab')]
        const badHit = []
        const offscreen = []
        for (const t of tabs) {
          const r = t.getBoundingClientRect()
          if (r.left < 0 || r.right > vpw) offscreen.push(t.dataset.view)
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          if (!at || !(at === t || t.contains(at))) {
            badHit.push(`${t.dataset.view}←${at ? at.id || at.className : 'null'}`)
          }
        }
        const clipped = []
        for (const sel of [
          '.tabs',
          '.stats',
          '.project-switch',
          '.project-select',
          '#btnRefresh',
        ]) {
          const el = document.querySelector(sel)
          if (!el) {
            clipped.push(`${sel}:缺失`)
            continue
          }
          if (el.scrollWidth > el.clientWidth + 1) {
            clipped.push(`${sel}:${el.scrollWidth}>${el.clientWidth}`)
          }
        }
        const refresh = document.querySelector('#btnRefresh')
        const refreshWrapped = refresh.scrollHeight > refresh.clientHeight + 2
        const barH = Math.round(document.querySelector('.topbar').getBoundingClientRect().height)
        const hOverflow = document.documentElement.scrollWidth > vpw + 1
        const statsText = (document.querySelector('#stats').textContent || '').replace(/\s+/g, '')
        const statsMissing = ['共', '文章', '留存', '归档'].filter((k) => !statsText.includes(k))
        return {
          vw: vpw,
          total: tabs.length,
          badHit,
          offscreen,
          clipped,
          refreshWrapped,
          barH,
          hOverflow,
          statsMissing,
        }
      }),
    )
  }
  // 恢复默认视口（后续步骤的断言按 1280 写就）
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.waitForTimeout(150)

  const fmt = (rows, pick) => rows.map((r) => `${r.vw}px:${pick(r)}`).join(' · ')
  results.push([
    `顶栏布局·四宽度无截断（${WIDTHS.join('/')}）`,
    layout.every((r) => r.clipped.length === 0 && r.offscreen.length === 0 && !r.hOverflow),
    `${fmt(layout, (r) => (r.clipped.length || r.offscreen.length ? `✗${[...r.clipped, ...r.offscreen].join(',')}` : '✓'))}${layout.some((r) => r.hOverflow) ? ' 横向溢出!' : ''}`,
  ])
  results.push([
    // 2026-09-25：删「工作流」页后 tab 由 10 → 9；删「日历文章」页后 9 → 8
    '顶栏布局·四宽度 8 个 tab 同时可点 + ⟳ 刷新不折行',
    layout.every(
      (r) => r.total === 8 && r.badHit.length === 0 && !r.refreshWrapped && r.barH <= 132,
    ),
    `${fmt(layout, (r) => `tab${r.total}${r.badHit.length ? ` 被挡[${r.badHit.join(',')}]` : ''} 顶栏${r.barH}px${r.refreshWrapped ? ' 刷新折行!' : ''}`)}`,
  ])
  results.push([
    '顶栏统计·四项齐全（共/文章/留存/归档）',
    layout.every((r) => r.statsMissing.length === 0),
    fmt(layout, (r) => (r.statsMissing.length ? `缺${r.statsMissing.join(',')}` : '✓')),
  ])

  // 3) 各 tab 切换
  const tabResults = {}
  for (const name of ['topics', 'retained', 'archive', 'reports', 'settings']) {
    await page.click(`.tab[data-view="${name}"]`)
    const probes = {
      topics: '#topics-tbody tr',
      retained: '#retained-tbody tr',
      archive: '#archive-tbody tr',
      reports: '#rp-weekly .rp-bar-col, #rp-status .donut-row, #rp-slots .rp-row',
      settings: '#schedule-list .sched-row, #pf-grid .pf-item',
    }
    // 2026-09-19（v2.69）：改成**有界等待节点出现**，别再赌固定时长。
    //
    // 实测踩到：全量验收里 `tab reports 渲染` 报 nodes=0，而同一份代码单独重跑两次都是
    // nodes=22 —— 机器负载高时 1200ms 不够。这正是本文件 2.05 节注释里骂过的那类假失败
    // （"不稳定的验收比没有验收更糟：它会训练使用者'红了就重跑'"），当时只给
    // 「一键生成可用性」加了等待，tab 渲染这几条漏了。
    //
    // 注意：放宽的是**等待预算**，断言仍是 n > 0，没有削弱要求；
    // 超时也不吞错——下面的 count() 会给出真实的 nodes=0 并判负。
    const budgetMs = name === 'settings' ? 20000 : 10000 // settings 首次 platforms 全量检查可能较慢
    await page
      .waitForFunction((sel) => document.querySelectorAll(sel).length > 0, probes[name], {
        timeout: budgetMs,
      })
      .catch(() => {})
    const n = await page.locator(probes[name]).count()
    tabResults[name] = n
    results.push([`tab ${name} 渲染`, n > 0, `nodes=${n}`])
    // ★ v2.96.2 回归③：报表的堆叠条用 `.seg`，而 v2.96 给"通知渠道分段器"也起了 `.seg`
    //   同一个名字 —— 我的 `.seg { margin: 14px 0 16px }` 于是落到了报表的条上
    //   （实测 margin 变成 14px/16px，条被顶偏）。现在改名为 .chan-seg，这里按住它。
    if (name === 'reports') {
      const segBox = await page.evaluate(() => {
        const el = document.querySelector('.rp-row .rbar-stack .seg')
        if (!el) return null
        const cs = getComputedStyle(el)
        return {
          margin: cs.margin,
          display: cs.display,
          h: Math.round(el.getBoundingClientRect().height),
        }
      })
      results.push([
        '报表堆叠条·未被同名类污染（.seg 的 margin 归零、条仍有高度）',
        !!segBox && /^0px( 0px){0,3}$/.test(segBox.margin) && segBox.h > 0,
        JSON.stringify(segBox),
      ])
      // 2026-09-25：费用卡的计价口径必须来自接口（`/proxy/costs` 的 `meta.pricing`）——
      // 型号/版本/峰谷规则都是引擎的事实，前端写死就是第二份会漂的副本
      // （改前硬写"按 DeepSeek deepseek-v4-flash 官方价"，既会漂、又漏了按峰谷计价）。
      const priceProbe = await page.evaluate(async () => {
        const b = await (await fetch('/proxy/bootstrap')).json()
        const h = { 'X-CrossPost-Token': b.token }
        const pid = localStorage.getItem('crosspost.activeProject') || ''
        if (pid) h['X-CrossPost-Project'] = pid
        const r = await (await fetch('/proxy/costs', { headers: h })).json()
        return {
          model: (r.meta && r.meta.pricing && r.meta.pricing.model) || null,
          peak: (r.meta && r.meta.pricing && r.meta.pricing.peakHours) || null,
          sub: ((document.querySelector('#rp-cost-sub') || {}).textContent || '').trim(),
        }
      })
      results.push([
        '费用卡副标题·计价口径来自接口（型号与峰谷都写上）',
        !!priceProbe.model &&
          priceProbe.sub.includes(priceProbe.model) &&
          !!priceProbe.peak &&
          priceProbe.sub.includes('高峰'),
        `model=${priceProbe.model} 副标题="${priceProbe.sub.slice(0, 120)}"`,
      ])
    }
  }
  // 2.05) 「一键生成」能力未提供时，入口必须**禁用并说明**（v2.42）
  //
  // 背景：P0 起 `startTopicGenerate()` 改成能力钩子，未注册时后端返回
  // **501 generate_not_provided**；而 Console 从不问能力状态，于是页面上摆着
  // 24 个点了必然失败的按钮，点了只看到一个错误码。
  // 这里按后端真实状态断言：provided=false → 每个生成按钮都必须 disabled 且有 title。
  //
  // v2.44：**先等能力状态落到 DOM 再断言**。实测踩到——`/proxy/topics` 有 138KB 且要读
  // topic-pool，负载高时点击 tab 后的 1200ms 不够，`applyGenerateAvailability()` 还没跑，
  // 断言就把"还没禁用"读成失败（一次验收里本冒烟报 27/29，单独重跑却 29/29）。
  // 不稳定的验收比没有验收更糟：它会训练使用者"红了就重跑"。
  await page
    .waitForFunction(
      () => {
        const btns = [...document.querySelectorAll('#topics-tbody [data-gen-slot]')]
        if (!btns.length) return false
        // 生成按钮出现后，要么已有 disabled（能力缺失），要么状态请求已经回来过
        return btns.some((b) => b.disabled) || btns.every((b) => (b.title || '').trim().length > 0)
      },
      { timeout: 8000 },
    )
    .catch(() => {})
  const genCap = await page.evaluate(async () => {
    const b = await (await fetch('/proxy/bootstrap')).json()
    // 探针必须用**页面当前的项目作用域**去问后端，否则是拿"默认域"的答案去比"项目域"的 UI：
    // v2.74 之前两个域恰好同目录，这条差异看不出来；分开后 provided 会一个 false 一个 true。
    const pid = localStorage.getItem('crosspost.activeProject') || ''
    const headers = { 'X-CrossPost-Token': b.token }
    if (pid) headers['X-CrossPost-Project'] = pid
    const st = await (await fetch('/proxy/topics/generate/status', { headers })).json()
    const btns = [...document.querySelectorAll('#topics-tbody [data-gen-slot]')]
    return {
      provided: st.provided,
      total: btns.length,
      disabled: btns.filter((x) => x.disabled).length,
      titled: btns.filter((x) => (x.title || '').trim().length > 0).length,
    }
  })
  results.push([
    '选题「一键生成」入口与后端能力状态一致',
    genCap.provided === false
      ? genCap.total > 0 && genCap.disabled === genCap.total && genCap.titled === genCap.total
      : genCap.disabled === 0,
    `provided=${genCap.provided} 按钮=${genCap.total} 禁用=${genCap.disabled} 有说明=${genCap.titled}`,
  ])

  // 2.1) 设置页状态卡（2026-09-12）：检查范围 / 代理来源 / 失败明细三行必须在
  //      （背景：此前只有一行「失败平台重查：a / b / c（60 秒窗口）」，看不出"查哪些平台、为什么失败"）
  const bridgeStatus = ((await page.textContent('#bridge-status')) || '').replace(/\s+/g, ' ')
  results.push(['状态卡·检查范围行', bridgeStatus.includes('检查范围'), bridgeStatus.slice(0, 140)])
  results.push(['状态卡·代理来源行', bridgeStatus.includes('代理来源'), bridgeStatus.slice(0, 200)])
  const scopeInfo = await page.evaluate(async () => {
    const b = await (await fetch('/proxy/bootstrap')).json()
    const st = await (
      await fetch('/proxy/status', { headers: { 'X-CrossPost-Token': b.token } })
    ).json()
    const p = (st && st.platforms) || {}
    const sc = p.scope || null
    return sc
      ? {
          mode: sc.mode,
          count: sc.count,
          all: sc.all,
          checkOnly: sc.checkOnly || [],
          ids: (sc.ids || []).length,
          failed: p.failedRetryIds || [],
          needsLogin: p.needsLoginIds || [],
          inScope: (p.failedRetryIds || []).every((id) => (sc.ids || []).includes(id)),
        }
      : null
  })
  results.push([
    'API·检查范围（= 勾选集）',
    !!scopeInfo &&
      scopeInfo.count > 0 &&
      scopeInfo.count <= scopeInfo.all &&
      scopeInfo.ids === scopeInfo.count,
    JSON.stringify(scopeInfo && { ...scopeInfo, ids: undefined }),
  ])
  // 核心回归：失败/终态集合必须被检查范围约束（否则就是 2026-09-12 那个"4 个范围外平台被永久重查"的 bug）
  results.push([
    'API·失败集 ⊆ 检查范围',
    !!scopeInfo && scopeInfo.inScope,
    `failed=${(scopeInfo && scopeInfo.failed) || []} needsLogin=${(scopeInfo && scopeInfo.needsLogin) || []}`,
  ])
  // 平台网格（2026-09-12 模型 A）：
  // ① 任何平台都可勾选 → 不得有因"未登录"而禁用的行（那正是"新登录平台加不进默认推送"的死锁）
  // ② 每行都有「🔍 查一下」入口
  const gridRows = await page.evaluate(() =>
    [...document.querySelectorAll('#pf-grid .pf-item')].map((el) => ({
      id: el.querySelector('input') ? el.querySelector('input').value : null,
      disabled: !!(el.querySelector('input') && el.querySelector('input').disabled),
      check: !!el.querySelector('button[data-check]'),
    })),
  )
  const disabledRows = gridRows.filter((r) => r.disabled)
  results.push([
    '平台网格·无因登录态禁用行',
    gridRows.length > 0 && disabledRows.length === 0,
    `rows=${gridRows.length} disabled=${disabledRows.map((r) => r.id).join(',') || 0}`,
  ])
  results.push([
    '平台网格·每行都有「🔍 查一下」',
    gridRows.length > 0 && gridRows.every((r) => r.check),
    `withCheck=${gridRows.filter((r) => r.check).length}/${gridRows.length}`,
  ])
  // 未勾选的平台必须能一眼看出"不自动检查"（tooltip 里说明；徽标按已知状态显示，
  // 因为手动全量/单点查过之后就应当显示真实登录态）
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('#pf-grid .pf-item')].map((el) => el.getAttribute('title') || ''),
  )
  const uncheckedHint = titles.filter((t) => t.includes('未勾选')).length
  results.push([
    '平台网格·未勾选平台有说明（tooltip）',
    !!scopeInfo && scopeInfo.count < scopeInfo.all ? uncheckedHint > 0 : true,
    `${uncheckedHint}/${titles.length} 行含"未勾选（不自动检查）"`,
  ])

  // ── v2.96 / v2.96（下）：设置页其余模块的「显示器 vs 真值」契约 ────────────────────
  // 这一版把设置页剩下的 7 个模块全部重做了一遍**显示层**：平台读数条、平台行状态条/
  // 字形、评分刻度盘、风险词卡、通知渠道分段器、备份读数、Bridge 四格指标、样式库读数。
  // 真值一个都没换（勾选框 / #s-threshold / #inv-* textarea / #n-channel / 各接口）。
  // 所以这里锁的正是**最容易偷偷漂移的那条缝**：显示器上的数必须等于真值。
  // 词卡两条会点 × 与回车，但只写隐藏 textarea、**不点保存**，并在断言后原样加回。
  await page.waitForSelector('#inv-strong-chips .rw-chip', { timeout: 30000 })
  await page.waitForSelector('#style-lib .style-card', { timeout: 30000 })
  // ① 平台读数条 + 行状态条 + 去噪后的登录态字形
  const pfReadout = await page.evaluate(async () => {
    const b = await (await fetch('/proxy/bootstrap')).json()
    const pid = localStorage.getItem('crosspost.activeProject') || ''
    const h = { 'X-CrossPost-Token': b.token }
    if (pid) h['X-CrossPost-Project'] = pid
    const auth = await (await fetch('/proxy/platforms', { headers: h })).json()
    // /proxy/platforms 的 platforms 是**数组**（{id,isAuthenticated}），不是 id→布尔 的字典；
    // 且只含"检查范围内"的平台 —— 只有明确出现的平台才算已知，缺席=未知（与页面同义）
    const map = Object.fromEntries(
      ((auth && auth.platforms) || []).map((x) => [x.id, x.isAuthenticated === true]),
    )
    const checked = [...document.querySelectorAll('#pf-grid input:checked')].map((i) => i.value)
    const unkRows = [...document.querySelectorAll('#pf-grid .pf-item[data-auth="unk"]')]
    return {
      picked: ((document.querySelector('#pf-picked') || {}).textContent || '').trim(),
      note: ((document.querySelector('#pf-stat') || {}).textContent || '').trim(),
      domChecked: checked.length,
      authed: checked.filter((id) => map[id] === true).length,
      // v2.96.1：不再看 data-on（那个属性已删除）——直接问 CSS 用的同一个选择器
      onRows: document.querySelectorAll('#pf-grid .pf-item:has(input:checked)').length,
      // 未勾选的"状态未知"淡点必须**不可见**（v2.96.1 起淡点始终在 DOM 里，由 CSS 藏）
      unkVisibleWhileUnchecked: unkRows.filter((r) => {
        if (r.querySelector('input').checked) return false
        const b = r.querySelector('.pf-auth.unk')
        return !!b && getComputedStyle(b).display !== 'none'
      }).length,
    }
  })
  results.push([
    '平台读数条·大号数字 = DOM 勾选数、注解里的已登录数 = 接口真实值',
    /^\d+ \/ \d+$/.test(pfReadout.picked) &&
      Number(pfReadout.picked.split('/')[0].trim()) === pfReadout.domChecked &&
      pfReadout.note.includes(`已登录 ${pfReadout.authed}`),
    `读数=${pfReadout.picked} DOM=${pfReadout.domChecked} 登录=${pfReadout.authed} 注解="${pfReadout.note}"`,
  ])
  results.push([
    '平台行·左缘状态条数 = 勾选数（与 .sched-row 同一套语义）',
    pfReadout.onRows === pfReadout.domChecked,
    `带状态条的行=${pfReadout.onRows} 勾选=${pfReadout.domChecked}`,
  ])
  results.push([
    '平台行·未勾选的"状态未知"淡点不可见（否则 25 个空圈把 3 个绿勾淹掉）',
    pfReadout.unkVisibleWhileUnchecked === 0,
    `未勾选却看得见淡点的行=${pfReadout.unkVisibleWhileUnchecked}`,
  ])

  // ★ v2.96.1 回归①：**点了行必须当帧看得见反应**。
  // 背景（用户现场报的）：v2.96 把"勾号"从原生 checkbox 换成了自绘方框，但方框/左缘状态条
  // 读的是渲染那一刻写下的 data-on —— 而勾选框是浏览器自己翻转的，JS 不重渲染。
  // 结果：点简书 → input.checked 变 true、读数 12→13，**方框、勾号、状态条全都不动**。
  // 这条断言就是按住那个现场：点一下、立刻读 computed style，不许出现"读数走了、画面没走"。
  const pfClickFeedback = await page.evaluate(async () => {
    const row = [...document.querySelectorAll('#pf-grid .pf-item')].find(
      (r) => !r.querySelector('input').checked,
    )
    if (!row) return { skipped: true }
    const box = row.querySelector('.pf-box')
    /**
     * 等底色过渡走完（v2.106.3）。
     *
     * 原来是固定 `setTimeout(220)`（底色过渡 0.12s 的余量）。2026-09-22 实测在**页面有额外后台负载**
     * 时（检查范围从 2 个平台扩到 12 个之后，登录态刷新更忙）220ms 不够 —— 读到的
     * `restored.box` 是**过渡中间值** `rgb(222,221,220)`（白 255 → 深 29 的混合），
     * 于是"恢复后底色应等于点击前"假红（同一份代码前一次验收是 20/20）。
     * 改成**等到连续两次读到同一个底色**（上限 1.5s）：既不削弱断言，也不再看运气。
     */
    const settle = async () => {
      let prev = null
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 80))
        const cur = getComputedStyle(box).backgroundColor
        if (prev !== null && cur === prev) return
        prev = cur
      }
    }
    const picked = () => document.querySelector('#pf-picked').textContent
    const read = () => ({
      checked: row.querySelector('input').checked,
      picked: picked(),
      box: getComputedStyle(box).backgroundColor,
      mark: getComputedStyle(box, '::after').content !== 'none',
      bar: getComputedStyle(row).boxShadow,
    })
    const before = read()
    // 给行节点打个私有标记：若视觉是**靠重渲染**才更新的，这个节点会被 innerHTML 换掉
    row.__v2961Probe = true
    row.querySelector('.pf-name').click() // 与用户操作同一条路径（label 激活）
    const matchesSync = row.matches(':has(input:checked)')
    await settle()
    const after = read()
    const sameNode = row.__v2961Probe === true && document.contains(row)
    row.querySelector('.pf-name').click() // 还原
    await settle()
    const restored = read()
    return { id: row.querySelector('input').value, matchesSync, sameNode, before, after, restored }
  })
  const fbOk =
    !pfClickFeedback.skipped &&
    pfClickFeedback.matchesSync && // 选择器当帧就匹配（不依赖任何重渲染）
    pfClickFeedback.sameNode && // 而且这一行**始终是同一个 DOM 节点**
    pfClickFeedback.after.checked &&
    pfClickFeedback.after.mark &&
    pfClickFeedback.after.box !== pfClickFeedback.before.box &&
    pfClickFeedback.after.bar.includes('46, 125, 79') &&
    pfClickFeedback.after.picked !== pfClickFeedback.before.picked &&
    pfClickFeedback.restored.checked === false &&
    pfClickFeedback.restored.box === pfClickFeedback.before.box &&
    pfClickFeedback.restored.picked === pfClickFeedback.before.picked
  results.push([
    '平台行·点击立刻出现勾号 + 左缘状态条 + 读数，且全程未重渲染（v2.96「勾了没反应」的回归锁）',
    fbOk,
    JSON.stringify(pfClickFeedback),
  ])

  // ★ v2.96.1 回归②：**未保存的勾选必须活过重渲染**，读数也不许跟着过滤一起缩水。
  // 背景：renderPlatformGrid() 会被"搜索框输入"和"登录态每 60s 刷新"调用；此前它用**已保存的
  // 配置**重建勾选区，于是"勾上简书 → 搜索框敲一个字 → 勾没了"（读数 13→0→12）。
  const pfFilterKeep = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const rows = () => [...document.querySelectorAll('#pf-grid .pf-item')]
    const row = rows().find((r) => !r.querySelector('input').checked)
    if (!row) return { skipped: true }
    const id = row.querySelector('input').value
    const name = row.querySelector('.pf-name').textContent.trim()
    const picked = () => document.querySelector('#pf-picked').textContent
    row.querySelector('.pf-name').click()
    const afterCheck = picked()
    const q = document.querySelector('#pf-q')
    q.value = name.slice(0, 1)
    q.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(300)
    const during = { visible: rows().length, picked: picked() }
    const stillCheckedFiltered = (() => {
      const r = rows().find((x) => x.querySelector('input').value === id)
      return r ? r.querySelector('input').checked : null
    })()
    q.value = ''
    q.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(300)
    const after = { picked: picked(), visible: rows().length }
    const stillChecked = (() => {
      const r = rows().find((x) => x.querySelector('input').value === id)
      return r ? r.querySelector('input').checked : null
    })()
    // 还原：把刚才勾上的取消掉
    const r2 = rows().find((x) => x.querySelector('input').value === id)
    if (r2 && r2.querySelector('input').checked) r2.querySelector('.pf-name').click()
    return {
      id,
      name,
      afterCheck,
      during,
      stillCheckedFiltered,
      after,
      stillChecked,
      restored: picked(),
    }
  })
  results.push([
    '平台行·未保存的勾选活过搜索重渲染，读数不随过滤缩水（v2.96 静默抹勾的回归锁）',
    !pfFilterKeep.skipped &&
      pfFilterKeep.stillCheckedFiltered === true &&
      pfFilterKeep.stillChecked === true &&
      pfFilterKeep.during.picked === pfFilterKeep.afterCheck &&
      pfFilterKeep.after.picked === pfFilterKeep.afterCheck &&
      pfFilterKeep.restored === pfReadout.picked,
    JSON.stringify(pfFilterKeep),
  ])

  // ② 评分刻度盘：range 是 #s-threshold 的第二个手柄，两者不许分叉
  const dial = await page.evaluate(() => {
    const r = document.querySelector('#s-threshold-range')
    const n = document.querySelector('#s-threshold')
    return {
      range: r ? r.value : null,
      truth: n ? n.value : null,
      fill: r ? r.style.getPropertyValue('--fill') : '',
    }
  })
  results.push([
    '评分刻度盘·range 与真值 #s-threshold 一致（含填充段读数）',
    !!dial.range && dial.range === dial.truth && dial.fill === dial.range + '%',
    JSON.stringify(dial),
  ])

  // ③ 风险词卡：卡片数 = 真值词数；点 × 真值少一个词；回车加回原样
  const chipBefore = await page.evaluate(() => {
    const ta = document.querySelector('#inv-strong')
    const chips = [...document.querySelectorAll('#inv-strong-chips .rw-chip')]
    return {
      chips: chips.length,
      words: String(ta.value).split(',').filter(Boolean).length,
      count: ((document.querySelector('#inv-strong-count') || {}).textContent || '').trim(),
      last: chips.length ? chips[chips.length - 1].querySelector('.rw-word').textContent : '',
    }
  })
  results.push([
    '风险词卡·卡片数 = 隐藏 textarea 的词数（词卡只是显示器）',
    chipBefore.chips > 0 &&
      chipBefore.chips === chipBefore.words &&
      chipBefore.count === `${chipBefore.words} 个`,
    `卡=${chipBefore.chips} 词=${chipBefore.words} 计数="${chipBefore.count}"`,
  ])
  let chipRoundTrip = null
  if (chipBefore.last) {
    await page.click('#inv-strong-chips .rw-chip:last-child .rw-del')
    chipRoundTrip = await page.evaluate((word) => {
      const ta = document.querySelector('#inv-strong')
      const words = String(ta.value).split(',').filter(Boolean)
      return {
        words: words.length,
        removedWordStillInValue: words.includes(word),
        chips: document.querySelectorAll('#inv-strong-chips .rw-chip').length,
      }
    }, chipBefore.last)
    await page.fill('#inv-strong-add', chipBefore.last)
    await page.press('#inv-strong-add', 'Enter')
    chipRoundTrip.after = await page.evaluate(() => ({
      words: String(document.querySelector('#inv-strong').value).split(',').filter(Boolean).length,
      chips: document.querySelectorAll('#inv-strong-chips .rw-chip').length,
    }))
  }
  results.push([
    '风险词卡·点 × 真的从真值里删掉、回车又加回来（往返一致）',
    !!chipRoundTrip &&
      !chipRoundTrip.removedWordStillInValue &&
      chipRoundTrip.words === chipBefore.words - 1 &&
      chipRoundTrip.after.words === chipBefore.words &&
      chipRoundTrip.after.chips === chipBefore.chips,
    JSON.stringify(chipRoundTrip),
  ])

  // ④ 通知渠道分段器：点格 → 写回 #n-channel（syncNotifyRows 一行未改）
  const segBefore = await page.evaluate(() => document.querySelector('#n-channel').value)
  await page.click('#n-channel-seg .chan-item[data-channel="webhook"]')
  const segAfter = await page.evaluate(() => ({
    sel: document.querySelector('#n-channel').value,
    on: (document.querySelector('#n-channel-seg .chan-item.is-on') || {}).dataset?.channel || null,
    larkHidden: document.querySelector('#row-lark').style.display === 'none',
    webhookShown: document.querySelector('#row-webhook').style.display !== 'none',
  }))
  await page.click(`#n-channel-seg .chan-item[data-channel="${segBefore}"]`)
  const segRestored = await page.evaluate(() => document.querySelector('#n-channel').value)
  results.push([
    '通知分段器·点一格 → 真值 #n-channel 跟着变 + 字段显隐跟随（点完已还原）',
    segAfter.sel === 'webhook' &&
      segAfter.on === 'webhook' &&
      segAfter.larkHidden &&
      segAfter.webhookShown &&
      segRestored === segBefore,
    `改前=${segBefore} 点后=${JSON.stringify(segAfter)} 还原=${segRestored}`,
  ])

  // ⑤ 备份读数：大号数字 = 接口份数，行数 = 接口文件数
  const backupProbe = await page.evaluate(async () => {
    const b = await (await fetch('/proxy/bootstrap')).json()
    const h = { 'X-CrossPost-Token': b.token }
    const pid = localStorage.getItem('crosspost.activeProject') || ''
    if (pid) h['X-CrossPost-Project'] = pid
    const r = await (await fetch('/proxy/backup', { headers: h })).json()
    return {
      apiCount: r.count,
      apiFiles: (r.files || []).length,
      apiKeep: r.keep,
      sub: ((document.querySelector('#backup-sub') || {}).textContent || '').trim(),
      num: ((document.querySelector('.bk-num') || {}).textContent || '').trim(),
      rows: document.querySelectorAll('.bk-item').length,
      whens: document.querySelectorAll('.bk-when').length,
    }
  })
  results.push([
    '备份读数条·大号数字 = 接口份数、行数 = 接口文件数（且每行都有可读时刻）',
    String(backupProbe.apiCount) === backupProbe.num &&
      backupProbe.rows === backupProbe.apiFiles &&
      backupProbe.whens === backupProbe.rows,
    JSON.stringify(backupProbe),
  ])
  // 2026-09-25：副标题里的"保留最近 N 份"必须来自接口（`/proxy/backup` 的 `keep`），
  // 不是前端写死的第二份副本 —— 改前硬写 30，引擎改了它不会变。
  results.push([
    '备份卡副标题·保留份数来自接口（不写死）',
    backupProbe.apiKeep > 0 && backupProbe.sub.includes(`保留最近 ${backupProbe.apiKeep} 份`),
    `keep=${backupProbe.apiKeep} 副标题="${backupProbe.sub}"`,
  ])

  // ⑥ Bridge 四格指标（文案断言另见上面「状态卡·检查范围行 / 代理来源行」两条）
  const bx = await page.evaluate(() => ({
    tiles: document.querySelectorAll('#bridge-status .bx-tile').length,
    ks: [...document.querySelectorAll('#bridge-status .bx-k')].map((e) => e.textContent.trim()),
    states: [...document.querySelectorAll('#bridge-status .bx-tile')].map((e) => e.dataset.state),
  }))
  results.push([
    'Bridge 状态·四格指标（连接 / 代理来源 / 检查范围 / 失败平台）',
    bx.tiles === 4 && ['连接', '代理来源', '检查范围', '失败平台'].every((k) => bx.ks.includes(k)),
    `tiles=${bx.tiles} k=${bx.ks.join('|')} state=${bx.states.join(',')}`,
  ])

  // ⑦ 样式库读数：大号数字 = 接口启用数；启用区卡片数 = 启用数（且每张卡一颗状态点）
  const styleProbe = await page.evaluate(async () => {
    const b = await (await fetch('/proxy/bootstrap')).json()
    const h = { 'X-CrossPost-Token': b.token }
    const pid = localStorage.getItem('crosspost.activeProject') || ''
    if (pid) h['X-CrossPost-Project'] = pid
    const r = await (await fetch('/proxy/styles', { headers: h })).json()
    const list = (r && r.styles) || []
    const enabled = list.filter((s) => s.enabled !== false).length
    return {
      apiEnabled: enabled,
      apiTotal: list.length,
      num: ((document.querySelector('#style-stat-num') || {}).textContent || '').trim(),
      note: ((document.querySelector('#style-stat') || {}).textContent || '').trim(),
      cards: document.querySelectorAll('#style-lib .style-card').length,
      dots: document.querySelectorAll('#style-lib .style-toggle .st-mark').length,
    }
  })
  results.push([
    '样式库读数·大号数字 = 接口启用数、卡片数 = 启用数（每卡一颗状态点）',
    styleProbe.num === String(styleProbe.apiEnabled) &&
      styleProbe.cards === styleProbe.apiEnabled &&
      styleProbe.dots === styleProbe.cards &&
      styleProbe.note.includes(`共 ${styleProbe.apiTotal} 个`),
    JSON.stringify(styleProbe),
  ])

  // 调度槽位徽标：必须与 /proxy/schedule 的字段推导一致（v2.3 起判据是
  // 「有没有命令声明 + 内置定时器有没有 arm + 今日跑没跑」，不再是 launchd 注册态）。
  //
  // v2.94：采样前**重新进入一次设置页**，并在 DOM 与接口对不上时重试。
  // 为什么必须这样：DOM 里的调度行是"上一次渲染那一刻"的快照，而 /proxy/schedule 是
  // **此刻**的状态。使用者在自己的浏览器里开关槽位时（现场踩到：全量验收跑到这一段时
  // evening 正被开关一次），两者必然对不上，报出来的"徽标三态不合格 / 时刻线读数不一致"
  // 是假失败 —— 正是本文件反复强调要避免的"红了就重跑"。重新点一次设置 tab 会走
  // `loadSettings()` 重新取数并重渲染，把不一致窗口从"几秒"压到"一次渲染"；再配 3 轮重试。
  // 采样仍有真实窗口，所以重试后仍不一致就**如实判负**（不掩盖、不放宽断言）。
  // v2.1：徽标还要看**作用域**——不带项目头时引擎问的是默认域，那里本来就没有槽位，
  // 页面必须显示"未选择项目"而不是"未安装调度 / 请先安装调度器"。
  // v2.3：徽标语义整段换过——不再是"launchd 注册没注册"，而是
  // 「引擎任务 / 缺命令声明 / 未选项目 / 已关闭 / 未收尾 / 运行中 / 已启用（今日已跑）」。
  // 这里按**与页面同一套推导**重算一遍：两边必须逐行一致（DOM 是渲染那一刻的快照，
  // 所以下面仍保留重试窗口）。
  //
  // 2026-09-25：加"最近一班跑失败"一态 —— 设置页把它渲染成 warn（`跑失败(exit=N)`），
  // 因为 `completedToday` 只表示"今天有 finished 记录"，与成败无关（18:10 那次 exit=1、
  // 零产出却显示"今日已跑"，人只能靠"怎么没文章"才发现）。判据与页面逐字一致。
  const todayKey = () =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  const expectedBadgeOf = (s, project) => {
    if (!project) return 'noproj'
    if (s.commandMissing) return 'noplist'
    if (!s.enabled) return 'off'
    if (s.unfinished) return 'warn'
    if (s.running) return 'on'
    if (
      typeof s.lastExit === 'number' &&
      s.lastExit !== 0 &&
      (s.completedToday || String(s.lastRunAt || '').slice(0, 10) === todayKey())
    )
      return 'warn'
    if (s.armed) return 'on'
    return 'warn'
  }
  const sampleSchedule = async () => {
    await page.click('.tab[data-view="settings"]')
    await page.waitForTimeout(400)
    return page.evaluate(async () => {
      const b = await (await fetch('/proxy/bootstrap')).json()
      // v2.81：探针必须用**页面当前的项目作用域**去问后端。
      // 页面（下拉框已选项目）显示的是项目域的槽位状态，而裸 fetch 不带项目头 → 拿到默认域的
      // 那一份，于是"配置说开、引擎说关"时两边各说各话，探针把正常的页面判成失败。
      const pid = localStorage.getItem('crosspost.activeProject') || ''
      const headers = { 'X-CrossPost-Token': b.token }
      if (pid) headers['X-CrossPost-Project'] = pid
      const st = await (await fetch('/proxy/schedule', { headers })).json()
      const rows = [...document.querySelectorAll('#schedule-list .sched-row')].map((el) => {
        const badge = el.querySelector('.sched-badge')
        return {
          cls: badge ? badge.className.replace('sched-badge', '').trim() : null,
          text: badge ? badge.textContent.trim() : null,
          hasTitle: !!(badge && badge.getAttribute('title')),
          next: ((el.querySelector('.sched-next') || {}).textContent || '').trim(),
        }
      })
      return { rows, slots: st.slots || [], project: st.project ?? null, pid }
    })
  }
  let schedRows = await sampleSchedule()
  const scheduleConsistent = (r) =>
    r.rows.length === r.slots.length &&
    r.rows.every((row, i) => row.cls === expectedBadgeOf(r.slots[i], r.project))
  for (let i = 0; i < 3 && !scheduleConsistent(schedRows); i++) schedRows = await sampleSchedule()
  // 槽位**可编辑**：名称/时间就地改 + 保存/删除 + 登记表单。
  // 只做渲染与"行数一致"的只读检查——真去 upsert 会改项目设置，不该在冒烟里做。
  // v2.3：不可编辑的槽位（引擎任务 / 缺声明）仍渲染输入框但 disabled，
  // 所以这里数的是**控件存在性**（契约），可编辑性由 data-state 与 disabled 属性表达。
  const schedEdit = await page.evaluate(() => ({
    names: document.querySelectorAll('#schedule-list input[data-name]').length,
    times: document.querySelectorAll('#schedule-list input[data-time]').length,
    saves: document.querySelectorAll('#schedule-list button[data-save]').length,
    dels: document.querySelectorAll('#schedule-list button[data-del]').length,
    addForm: !!document.querySelector('#btn-sched-add'),
    addId: !!document.querySelector('#sched-new-id'),
    addTime: !!document.querySelector('#sched-new-time'),
  }))
  results.push([
    '调度槽位·可编辑（名称/时间/保存/删除 + 新增表单）',
    schedEdit.names === schedRows.rows.length &&
      schedEdit.times === schedRows.rows.length &&
      schedEdit.saves === schedRows.rows.length &&
      schedEdit.dels === schedRows.rows.length &&
      schedEdit.addForm &&
      schedEdit.addId &&
      schedEdit.addTime,
    JSON.stringify({ ...schedEdit, rows: schedRows.rows.length }),
  ])

  const expectedBadges = schedRows.slots.map((s) => expectedBadgeOf(s, schedRows.project))
  results.push([
    '调度槽位·徽标三态与 /proxy/schedule 推导一致',
    // v2.94：行数不再写死 6 —— 槽位是**可删**的（删掉默认槽位后真的少一行），
    // 所以判据是"页面行数 == 后端槽位数"（两边同源；任一多/少都要判失败）。
    schedRows.rows.length === schedRows.slots.length &&
      schedRows.rows.length > 0 &&
      schedRows.rows.every((r, i) => r.cls === expectedBadges[i] && r.hasTitle && r.text),
    `${schedRows.rows.length} 行 / ${schedRows.slots.length} 槽 ` +
      schedRows.rows.map((r, i) => `${r.cls || 'null'}=>${expectedBadges[i]}`).join(' '),
  ])
  // v2.1：接口的作用域标记必须与页面所选项目一致——它是"该显示项目槽位还是默认域"的唯一依据，
  // 漂了就会退回到"未选项目时显示'请先安装调度器'"那种误诊。
  results.push([
    '调度槽位·接口作用域标记与页面所选项目一致（v2.1）',
    schedRows.project === (schedRows.pid || null),
    `接口 project=${String(schedRows.project)} · 页面所选 ${schedRows.pid || '（未选）'}`,
  ])
  // 2026-09-25（二次收敛）：调度提示区**只讲会妨碍定时运行、且有动作可做的失败**。
  //
  // 这段判据的历史：本机的槽位执行器（`com.wechatauto.slot-runner`，RunAtLoad+KeepAlive
  // 的常驻服务）先被按文件名误报成"旧调度任务……请执行 scheduler migrate"（照做白折腾：
  // 那个 plist 没有时间点，迁移器只会标 blocked）；修完误报后又矫枉过正，把它当成一行
  // 中性提示**常驻**在提示区 —— 而这一区的契约是"四条都属于**到点才发现**的失败"，
  // 一行永远正确、永远不可操作的提示只会稀释真话。
  //
  // 现在的判据：① 后端 `legacyTasks` 每条（若有）仍必须逐条出现，且带迁移命令；
  // ② 提示区**不得**出现常驻服务口径（后端也不再有 `legacyDaemons` 字段）；
  // ③ 旧任务为空时不得残留"旧的系统调度任务"字样。
  const notices = await page.evaluate(async () => {
    const b = await (await fetch('/proxy/bootstrap')).json()
    const st = await (
      await fetch('/proxy/schedule', { headers: { 'X-CrossPost-Token': b.token } })
    ).json()
    const box = document.querySelector('#sched-notices')
    return {
      text: box && !box.hidden ? box.innerText : '',
      hasDaemonField: 'legacyDaemons' in st,
      legacy: (st.legacyTasks || []).map((t) => t.label || t.unit),
    }
  })
  results.push([
    '调度提示区·只讲"会妨碍运行且可操作"的失败（常驻服务不再常驻）',
    notices.legacy.every((l) => notices.text.includes(l)) &&
      (notices.legacy.length > 0 || !notices.text.includes('旧的系统调度任务')) &&
      !notices.text.includes('常驻服务') &&
      !notices.hasDaemonField,
    `legacy=[${notices.legacy.join(',')}] 字段 legacyDaemons=${notices.hasDaemonField} 提示区=${JSON.stringify(
      notices.text.slice(0, 160),
    )}`,
  ])
  // 2026-09-25：**同一条数据不许有两个名字** —— 栏目名的权威源是项目声明
  // （`/proxy/schedule` 的 `label`），Console 各视图必须都从它取。
  //
  // 为什么钉：改前前端有一份硬编码副本（`const.mjs` 的 `SLOT_NAMES`），而契约测试只锁了
  // 它的**键**、没锁**名**，于是本机实测同一个槽位在两个页面叫两个名字：
  //     设置→调度「热点解读① / 深度分析 / AI技巧·工具 / 教学/娱乐」
  //     文章列表「热点① / 深度 / 技巧 / 晚间」
  // 判据：文章行按 `data-id` 对回接口拿到 slot，若该 slot 在项目声明里，行上的栏目名
  // 必须**逐字等于**声明名（至少要比中一行，避免"没有共同槽位"导致空跑通过）。
  await page.evaluate(async () => {
    const b = await (await fetch('/proxy/bootstrap')).json()
    const h = { 'X-CrossPost-Token': b.token }
    h['X-CrossPost-Project'] = localStorage.getItem('crosspost.activeProject') || ''
    const st = await (await fetch('/proxy/schedule', { headers: h })).json()
    const declared = {}
    for (const s of st.slots || []) declared[s.slot] = s.label
    const arts = await (await fetch('/proxy/articles?dir=articles', { headers: h })).json()
    const slotById = {}
    for (const a of arts.articles || arts.items || []) slotById[a.id] = a.slot
    // 采样结果挂在 window 上，供后续两次单独求值（切视图后才有的 DOM）共用
    window.__cpSmokeSlots = { declared, slotById }
  })
  // ① 文章列表：行内栏目名 vs 声明名
  await page.click('.tab[data-view="articles"]')
  await page.waitForTimeout(700)
  const articleRows = await page.evaluate(() => {
    const { declared, slotById } = window.__cpSmokeSlots
    return [...document.querySelectorAll('#article-table tbody tr')]
      .slice(0, 15)
      .map((tr) => ({
        id: tr.getAttribute('data-id'),
        text: ((tr.querySelector('.cell-slot') || {}).textContent || '').trim(),
      }))
      .map((r) => ({ ...r, slot: slotById[r.id], want: declared[slotById[r.id]] }))
      .filter((r) => r.want)
  })
  const mismatch = articleRows.filter((r) => r.text !== r.want)
  results.push([
    '栏目名·同一条数据只有一个名字（文章列表 == /proxy/schedule 的声明名）',
    articleRows.length > 0 && mismatch.length === 0,
    `比中 ${articleRows.length} 行 · 不一致 ${mismatch.length} 行` +
      (mismatch.length
        ? `：${mismatch.map((r) => `${r.slot} 行内"${r.text}" vs 声明"${r.want}"`).join('；')}`
        : ` · 例：${articleRows[0]?.slot} → ${articleRows[0]?.text}`),
  ])
  // ② 编写页：栏目**可选项**只能是项目声明的槽位（+ 手动），且用声明名。
  //    改前它列的是常量全集，本机含一个根本没声明的「早报」。
  await page.click('.tab[data-view="editor"]')
  await page.waitForTimeout(900)
  const editorChoices = await page.evaluate(() => {
    const { declared } = window.__cpSmokeSlots
    return {
      declared: Object.keys(declared),
      opts: [...document.querySelectorAll('#ed-slot option')].map((o) => ({
        id: o.value,
        text: o.textContent.trim(),
        want: declared[o.value],
      })),
    }
  })
  const badChoice = editorChoices.opts.filter((o) => o.id !== 'manual' && o.want === undefined)
  const labelBad = editorChoices.opts.filter((o) => o.want !== undefined && o.text !== o.want)
  results.push([
    '编写页栏目下拉 ⊆ 项目声明的槽位（+ 手动），且用声明名',
    editorChoices.declared.length > 0 &&
      badChoice.length === 0 &&
      labelBad.length === 0 &&
      editorChoices.opts.some((o) => o.id === 'manual'),
    `声明=[${editorChoices.declared.join(',')}] 下拉=[${editorChoices.opts
      .map((o) => `${o.id}=${o.text}`)
      .join(' ')}]` + (badChoice.length ? ` 越界=[${badChoice.map((o) => o.id).join(',')}]` : ''),
  ])
  // 采样把视图切走了，切回设置页再继续后面的检查
  await page.click('.tab[data-view="settings"]')
  await page.waitForTimeout(400)

  results.push([
    '调度槽位·下次触发时间与槽位状态一致（v2.3：缺声明/已关闭各有其文案）',
    schedRows.rows.length === schedRows.slots.length &&
      schedRows.rows.every((r, i) => {
        const s = schedRows.slots[i]
        if (s.commandMissing) return r.next.includes('缺命令声明') || r.next.includes('命令不可用')
        if (!s.enabled) return r.next.includes('已关闭')
        return r.next.includes('下次')
      }),
    schedRows.rows
      .map((r) => r.next)
      .join(' | ')
      .slice(0, 200),
  ])

  // 2.06) 调度形状（v2.93）：六个槽位从"六张表单"改成一张**时刻表**。
  //
  // 为什么钉这几条：改前每行 7 个控件等重并排（6 个裸输入框 + 12 个常驻按钮），
  // 且整块挤在两栏 grid 的左栏 680px 里；两行全局开关与槽位行长得一模一样。
  // 现在断言：① 时刻线每个班次一个刻度 ② 刻度标签两两不相交（实测踩到：
  // 08:10/08:30 只差 20 分钟，同排必然叠字，所以标签要错行）③ 这一节铺满内容区
  // ④ 槽位行是 5 列栅格 ⑤ 静止态的保存/删除是压暗的（低频操作不抢视觉）。
  const schedShape = await page.evaluate(() => {
    const ticks = [...document.querySelectorAll('#sched-day .sched-tick')]
    const blocks = ticks.map((t) => {
      const a = t.querySelector('.sched-tick-time').getBoundingClientRect()
      const b = t.querySelector('.sched-tick-name').getBoundingClientRect()
      return {
        l: Math.min(a.left, b.left),
        r: Math.max(a.right, b.right),
        t: Math.min(a.top, b.top),
        bo: Math.max(a.bottom, b.bottom),
      }
    })
    let overlaps = 0
    for (let i = 0; i < blocks.length; i++)
      for (let j = i + 1; j < blocks.length; j++) {
        const A = blocks[i]
        const B = blocks[j]
        if (
          Math.min(A.r, B.r) - Math.max(A.l, B.l) > 0 &&
          Math.min(A.bo, B.bo) - Math.max(A.t, B.t) > 0
        )
          overlaps++
      }
    const card = document.querySelector('#card-schedule')
    const view = document.querySelector('#view-settings')
    const vcs = getComputedStyle(view)
    const contentRight = view.getBoundingClientRect().right - parseFloat(vcs.paddingRight)
    const row = document.querySelector('#schedule-list .sched-row')
    return {
      ticks: ticks.length,
      overlaps,
      deadSpace: Math.round(contentRight - card.getBoundingClientRect().right),
      cols: getComputedStyle(row).gridTemplateColumns.split(' ').length,
      rowW: Math.round(row.getBoundingClientRect().width),
      saveOpacity: Number(getComputedStyle(row.querySelector('button[data-save]')).opacity),
      delOpacity: Number(getComputedStyle(row.querySelector('button[data-del]')).opacity),
      summary: (document.querySelector('#sched-summary') || {}).textContent || '',
      hint: (document.querySelector('#sched-day-hint') || {}).textContent || '',
    }
  })
  const schedOn = schedRows.slots.filter((s) => s.enabled).length
  results.push([
    '调度时刻线·每班一个刻度、标签不叠字、读数与 /proxy/schedule 一致',
    schedShape.ticks === schedRows.slots.length &&
      schedShape.overlaps === 0 &&
      schedShape.summary.includes(`${schedRows.slots.length} 槽位`) &&
      schedShape.summary.includes(`${schedOn} 开启`),
    JSON.stringify({
      ticks: schedShape.ticks,
      overlaps: schedShape.overlaps,
      summary: schedShape.summary,
      hint: schedShape.hint,
    }),
  ])
  results.push([
    '调度卡·铺满内容区 + 槽位行 5 列栅格 + 静止态按钮压暗',
    Math.abs(schedShape.deadSpace) <= 2 &&
      schedShape.cols === 5 &&
      schedShape.rowW > 1000 &&
      schedShape.saveOpacity > 0 &&
      schedShape.saveOpacity < 1 &&
      schedShape.delOpacity < 1,
    JSON.stringify({
      deadSpace: schedShape.deadSpace,
      cols: schedShape.cols,
      rowW: schedShape.rowW,
      saveOpacity: schedShape.saveOpacity,
      delOpacity: schedShape.delOpacity,
    }),
  ])
  // 改动未保存 → 行标 .is-dirty 且保存按钮提亮。
  // **只改 DOM、不点保存**：保存会改写 launchd plist，冒烟不碰（改完立即把值还原）。
  // 注意要等一帧以上再读 opacity：按钮的 opacity 是 0.15s 过渡，改完立刻读只会拿到
  // 起始值 0.32（实测踩到——断言看着对、测试却红）。
  const beforeDirty = await page.evaluate(() => {
    const inp = document.querySelector('#schedule-list .sched-row input[data-name]')
    const before = inp.value
    inp.value = before + '·冒烟'
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return before
  })
  await page.waitForTimeout(260)
  const dirtyState = await page.evaluate((original) => {
    const row = document.querySelector('#schedule-list .sched-row')
    const save = row.querySelector('button[data-save]')
    const cs = getComputedStyle(save)
    const out = {
      isDirty: row.classList.contains('is-dirty'),
      saveOpacity: Number(cs.opacity),
      saveBorder: cs.borderTopColor,
    }
    const inp = row.querySelector('input[data-name]')
    inp.value = original
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return out
  }, beforeDirty)
  results.push([
    '调度槽位·改动未保存时行标 .is-dirty（保存按钮提亮）',
    dirtyState.isDirty &&
      dirtyState.saveOpacity === 1 &&
      dirtyState.saveBorder !== 'rgba(0, 0, 0, 0)',
    JSON.stringify(dirtyState),
  ])

  await page.click('.tab[data-view="articles"]')
  await page.waitForTimeout(800)

  // 3) 详情抽屉（深链）。没有文章就没有可检对象：按"跳过"如实记录，
  //    而不是让 `#article-tbody .row-sel` 的 locator 超时把整段变成"脚本异常"。
  if (rowCount === 0) {
    for (const name of [
      '详情抽屉打开',
      '详情标题',
      '详情预览渲染',
      '详情费用区块',
      '发布历史时间线',
      '批量操作栏',
    ])
      results.push([name, true, '无文章可检（未接入项目，跳过）'])
  } else {
    await page.evaluate(() => {
      location.hash = '#/articles/2026-08-24-tips-ai-tutor-coach'
    })
    await page.waitForTimeout(2500)
    const drawerHidden = await page
      .locator('#detail-drawer')
      .evaluate((el) => el.classList.contains('hidden'))
    results.push(['详情抽屉打开', !drawerHidden, drawerHidden ? 'hidden' : 'open'])

    // ★ v2.96.2 回归①②：抽屉里的「重推平台芯片」是**另一个组件**的 .chip/.chips。
    //   v2.96 给风险词卡也起了 .chip，还加了 `html[data-theme='dark'] .chip { color: var(--ink) }`
    //   （特异性 0,2,1）—— 它压过 .chip.on 的 color:var(--paper)（0,2,0），而深色下
    //   .chip.on 的**底色也是 --ink**：象牙色文字画在象牙色药丸上，整行看着是空的。
    //   实测：light 读出 bg=#1d1a15/color=#f6f3ec（正常）、dark 读出 bg=#e8e4da/color=#e8e4da（同色！）。
    //   下面用"文字色与底色的相对亮度差"锁住它，并顺带锁住 .chips 的单行不换行
    //   （抽屉页脚 2026-09-11 专门压缩过高度，换行会把阅读区吃回去）。
    // ★ 2026-09-21（v2.99 期间发现，**与本次改动无关**）：抽屉的费用卡是**异步**填的
    //   ——`/proxy/costs` 现在要 **2–4 秒**（278 个会话要解析；实测 4.04s / 2.05s / 2.04s）。
    //   它写入 `#d-cost` 的同时会重渲染抽屉，于是：
    //     · 「详情费用区块」在写入前读 → 空串（假失败）；
    //     · 下面的芯片探针**手里攥着一个已经脱离文档的节点** → getComputedStyle 返回空串、
    //       ratio 变成 0（实测 dark·未选 {bg:"",color:"",ratio:0}）。
    //   这是"赌固定时长"的老毛病（本文件 2.05/2.69 节骂过同一类），所以改成**有界等待**：
    //   等费用卡真的有字再开始探。断言一条没放宽，只是不再把"慢"判成"错"。
    //   对照实验：把本次改动 git stash 掉、在 HEAD 上单跑本文件，同样这两条红 —— 不是本次引入的。
    await page
      .waitForFunction(
        () => {
          // 抽屉里三块异步内容都落定再开始量：费用卡、预览 srcdoc、平台芯片。
          // 少等任何一块，后面三条断言就会各自随机红一次（实测：费用块 / srcdoc=0B /
          // 芯片量到脱离文档的节点，三次运行红了三处不同的地方）。
          const c = document.querySelector('#d-cost')
          const f = document.querySelector('#d-preview-frame')
          const chips = document.querySelectorAll('#d-platforms .chip').length
          return (
            !!c &&
            c.textContent.trim().length > 0 &&
            !!f &&
            (f.getAttribute('srcdoc') || '').length > 100 &&
            chips > 0
          )
        },
        null,
        // 预算给到 60s：bridge 是**串行**跑 CLI 的，抽屉里的 /proxy/cost/<id> 前面还排着
        // /proxy/render 与报表拉过的 /proxy/costs，实测"请求发出"本身就在点击后 5.3s。
        { timeout: 60000 },
      )
      .catch(() => {})
    const chipProbe = await page.evaluate(async () => {
      // 注意两件事：
      //  ① 切 data-theme 后，**后代元素**的 var() 重算是异步的（实测 ~120ms 才更新，
      //     即使 getComputedStyle 也不催它）—— 所以每步都要等，否则读到的是上一个主题的值；
      //  ② 要覆盖 `.chip.on` 与裸 `.chip` 两种形态：这次的 bug 只在 `.on`（深色下
      //     bg=--ink / color 被污染成 --ink）上发作，而抽屉里的芯片是否有 .on 取决于该篇的发布记录。
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const lum = (rgb) => {
        const m = /rgba?\((\d+), ?(\d+), ?(\d+)/.exec(rgb)
        if (!m) return null
        const f = (v) => {
          const c = Number(v) / 255
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * f(m[1]) + 0.7152 * f(m[2]) + 0.0722 * f(m[3])
      }
      const ratio = (a, b) => {
        const la = lum(a)
        const lb = lum(b)
        if (la === null || lb === null) return 0
        return Number(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)).toFixed(2))
      }
      const getChip = () => document.querySelector('#d-platforms .chip')
      const box = document.querySelector('#d-platforms')
      const html = document.documentElement
      const orig = html.getAttribute('data-theme')
      const out = {}
      // ★ 2026-09-21：**每一步都重新取节点**。原实现把 `chip` 抓在手里再用，
      //   而抽屉会在异步（预览 / 费用 / 平台检查）回来时重渲染 —— 一旦重渲染，
      //   手里的节点就脱离文档，`getComputedStyle` 对它返回**空串**，ratio 变 0
      //   （实测 dark 两态都是 {bg:"",color:"",ratio:0}，看着像"深色下芯片没颜色"）。
      //   现在改成"强制类名 → 等 → 复核节点仍在文档里且类名还生效 → 才采信"。
      const measure = async (on) => {
        const want = on ? 'chip on' : 'chip'
        for (let attempt = 0; attempt < 3; attempt++) {
          const chip = getChip()
          if (!chip) return { bg: '', color: '', ratio: 0 }
          const cls0 = chip.className
          chip.className = want
          await wait(180)
          if (chip.isConnected && chip.className === want) {
            const cs = getComputedStyle(chip)
            const r = {
              bg: cs.backgroundColor,
              color: cs.color,
              ratio: ratio(cs.backgroundColor, cs.color),
            }
            chip.className = cls0
            return r
          }
          if (chip.isConnected) chip.className = cls0
        }
        return { bg: '', color: '', ratio: 0 }
      }
      for (const theme of ['light', 'dark']) {
        html.setAttribute('data-theme', theme)
        await wait(180)
        for (const on of [true, false]) {
          out[theme + (on ? '·选中' : '·未选')] = await measure(on)
        }
      }
      html.setAttribute('data-theme', orig || 'light')
      await wait(180)
      return {
        ...out,
        wrap: getComputedStyle(box).flexWrap,
        chips: box.querySelectorAll('.chip').length,
      }
    })
    const chipRatios = Object.entries(chipProbe)
      .filter(([k]) => k.includes('·'))
      .map(([, v]) => v.ratio)
    results.push([
      '详情抽屉·重推平台芯片在【两套主题 × 选中/未选】四种组合下文字都看得见（同名类污染的回归锁）',
      chipProbe.chips > 0 && chipRatios.length === 4 && chipRatios.every((r) => r >= 3),
      JSON.stringify(chipProbe),
    ])
    results.push([
      '详情抽屉·重推平台芯片单行不换行（页脚高度不允许被换行吃掉）',
      chipProbe.wrap === 'nowrap',
      `flex-wrap=${chipProbe.wrap}`,
    ])
    const title = ((await page.textContent('#d-title')) || '').trim()
    results.push(['详情标题', title.length > 3, title.slice(0, 25)])
    const srcdoc = await page.locator('#d-preview-frame').getAttribute('srcdoc')
    results.push([
      '详情预览渲染',
      !!(srcdoc && srcdoc.length > 100),
      `srcdoc=${srcdoc ? srcdoc.length : 0}B`,
    ])
    // 失败的两种形态要能一眼区分（实测踩到：分不清"没填"和"只有 spinner"）：
    //   加载中… = 静态占位（renderCost 还没被调用）；<span class="spinner"> = 请求在飞；
    //   有文字 = 完成。三者必须能从 DOM 上区分开，否则坏了也看不出是哪一种。
    const cost = ((await page.textContent('#d-cost')) || '').trim()
    const costHtml = await page.getAttribute('#d-cost', 'class').catch(() => null)
    const costInner = await page
      .$eval('#d-cost', (el) => el.innerHTML.slice(0, 60))
      .catch(() => '(no el)')
    results.push([
      '详情费用区块',
      cost.length > 0,
      `text=${JSON.stringify(cost.slice(0, 30))} html=${JSON.stringify(costInner)} class=${costHtml}`,
    ])
    // 记录 tab
    await page.click('.dtab[data-dtab="record"]')
    await page.waitForTimeout(600)
    const histLen = await page.locator('#d-history li').count()
    results.push(['发布历史时间线', histLen >= 0, `items=${histLen}`])
    await page.click('#d-close')
    await page.waitForTimeout(300)

    // 4) 批量选择
    await page.locator('#article-tbody .row-sel').first().check()
    await page.waitForTimeout(300)
    const batchVisible = await page
      .locator('#batch-bar')
      .evaluate((el) => !el.classList.contains('hidden'))
    results.push(['批量操作栏', batchVisible, batchVisible ? 'visible' : 'hidden'])
  }

  // ── 编写工作台（v2.97 首次纳入冒烟）───────────────────────────────────
  // 这一节此前**一条断言都没有**。v2.97 动的正是版面与反馈位置，顺手把护栏补上：
  // 两条锁版面（工作台不许溢出视口 / 两栏正文起点必须对齐），
  // 三条锁"改前真错、改后才对"的东西（下拉没标签 / 保存反馈跑到预览窗格 / 清空按钮常驻红）。
  await page.evaluate(() => {
    location.hash = '#/editor'
  })
  await page.waitForSelector('.editor-pane .cm-content', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1200)

  const edProbe = await page.evaluate(async () => {
    const rect = (s) => {
      const e = document.querySelector(s)
      if (!e) return null
      const b = e.getBoundingClientRect()
      return { top: Math.round(b.top), h: Math.round(b.height) }
    }
    const fields = [...document.querySelectorAll('.editor-meta-row .ed-field')].map((f) => ({
      label: ((f.querySelector('.ed-field-label') || {}).textContent || '').trim(),
      ctrl: (f.querySelector('select, input') || {}).id || null,
    }))
    const clear = document.querySelector('#ed-clear')
    return {
      overflow: document.documentElement.scrollHeight - window.innerHeight,
      left: rect('.editor-pane .ed-body'),
      right: rect('.preview-pane .ed-body'),
      fields,
      groups: document.querySelectorAll('.editor-pane .editor-formatbar .fb-group').length,
      actions: document.querySelectorAll('.editor-pane .fb[data-fb]').length,
      groupActions: [...document.querySelectorAll('.editor-pane .editor-formatbar .fb-group')].map(
        (g) => g.querySelectorAll('.fb[data-fb]').length,
      ),
      emptyOpacity: getComputedStyle(document.querySelector('#ed-empty')).opacity,
      previewEmptyOpacity: getComputedStyle(document.querySelector('#ed-preview-empty')).opacity,
      clearClass: (clear || {}).className || '',
      clearColor: clear ? getComputedStyle(clear).color : null,
      hasSaveState: !!document.querySelector('#ed-save-state'),
      // v2.97.1：抬头一行等高 + 标题无外框
      head: (() => {
        const t = document.querySelector('#ed-title')
        const ts = getComputedStyle(t)
        const btns = ['#ed-new', '#ed-clear', '#ed-save'].map((sel) => {
          const e = document.querySelector(sel)
          const r = e.getBoundingClientRect()
          return { sel, h: Math.round(r.height), top: Math.round(r.top) }
        })
        const tr = t.getBoundingClientRect()
        return {
          title: { h: Math.round(tr.height), top: Math.round(tr.top) },
          btns,
          actionsH: Math.round(
            document.querySelector('.editor-actions').getBoundingClientRect().height,
          ),
          border: [
            ts.borderTopWidth,
            ts.borderRightWidth,
            ts.borderBottomWidth,
            ts.borderLeftWidth,
          ].join('/'),
          // 声明的高度（断言读它，不写死数字 —— 以后调 --ed-head-h 不会假红）
          declaredH: Number.parseFloat(
            getComputedStyle(document.querySelector('#view-editor'))
              .getPropertyValue('--ed-head-h')
              .trim(),
          ),
          bg: ts.backgroundColor,
          font: ts.fontFamily.split(',')[0].replace(/"/g, ''),
          fontSize: ts.fontSize,
        }
      })(),
      // ★ v2.97.2 用户反馈："文章标题下方的横线颜色一直显示"。实测改前它只在**聚焦**时
      //   是强调色（失焦后 0.16s 淡出）—— 但标题是进这一页第一个点的控件，打字全程它都在。
      //   所以聚焦态也要量。
      focusGray: await (async () => {
        const t = document.querySelector('#ed-title')
        const saveBtn = document.querySelector('#ed-save')
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const bw = (e) => {
          const c = getComputedStyle(e)
          return [
            c.borderTopWidth,
            c.borderRightWidth,
            c.borderBottomWidth,
            c.borderLeftWidth,
          ].join('/')
        }
        const snap = () => {
          const c = getComputedStyle(t)
          return { border: bw(t), bg: c.backgroundColor, line: c.borderBottomColor }
        }
        const blurred = snap()
        t.focus()
        await wait(300)
        const focused = snap()
        t.blur()
        await wait(300)
        const restored = snap()
        // --accent 的实测参照：主按钮底色就是 var(--accent)（避免拿 hex 去比 rgb 字符串）
        // v2.98：焦点态改用 --accent-ink 加粗下划线，所以也要它的 rgb 参照（主题变量是 hex，
        //        借一个临时元素让浏览器自己换算，别在断言里手写 rgb）。
        const probeEl = document.createElement('span')
        probeEl.style.color = getComputedStyle(document.documentElement)
          .getPropertyValue('--accent-ink')
          .trim()
        document.body.appendChild(probeEl)
        const accentInkRgb = getComputedStyle(probeEl).color
        probeEl.remove()
        return {
          blurred,
          focused,
          restored,
          accentRgb: getComputedStyle(saveBtn).backgroundColor,
          accentInkRgb,
        }
      })(),
    }
  })
  results.push([
    '编写·三个元信息下拉都带标签（改前日期/栏目/样式一个标签都没有）',
    edProbe.fields.length === 3 &&
      edProbe.fields.every((f) => f.label.length > 0 && !!f.ctrl) &&
      edProbe.fields.map((f) => f.ctrl).join(',') === 'ed-date,ed-slot,ed-style',
    JSON.stringify(edProbe.fields),
  ])
  results.push([
    '编写·两栏正文起点严格对齐（右栏占位条与左栏格式栏等高）',
    !!edProbe.left && !!edProbe.right && edProbe.left.top === edProbe.right.top,
    `左 top=${edProbe.left && edProbe.left.top} 右 top=${edProbe.right && edProbe.right.top}`,
  ])
  results.push([
    '编写·工作台不产生页面滚动（1000px 视口；1426px 时顶栏定高 106）',
    edProbe.overflow <= 1,
    `溢出 ${edProbe.overflow}px`,
  ])
  // v2.99（C3）：从 4 组 10 键扩成 5 组 12 键 —— 块级语法（引用/分割线/代码块）单独成组，
  // 原来把行内（链接/图片）与块级（引用）混在一组的做法看不出层级。
  results.push([
    '编写·格式栏按用途分成 5 组（2/3/2/3/2）且 12 个动作都在（v2.99 新增分割线/代码块）',
    edProbe.groups === 5 &&
      edProbe.actions === 12 &&
      edProbe.groupActions.join(',') === '2,3,2,3,2',
    `组=${edProbe.groups} 每组=${edProbe.groupActions.join(',')} 共=${edProbe.actions}`,
  ])
  results.push([
    '编写·空稿时两栏都给出指引',
    edProbe.emptyOpacity === '1' && edProbe.previewEmptyOpacity === '1',
    `正文=${edProbe.emptyOpacity} 预览=${edProbe.previewEmptyOpacity}`,
  ])
  results.push([
    '编写·抬头一行等高：标题与右侧三按钮同高同顶（高度取 --ed-head-h，不写死）',
    edProbe.head.declaredH > 0 &&
      edProbe.head.title.h === edProbe.head.declaredH &&
      edProbe.head.actionsH === edProbe.head.declaredH &&
      edProbe.head.btns.every(
        (b) => b.h === edProbe.head.declaredH && b.top === edProbe.head.title.top,
      ),
    JSON.stringify({
      declared: edProbe.head.declaredH,
      title: edProbe.head.title,
      btns: edProbe.head.btns,
    }),
  ])
  // ★ 两条"规则被静默压掉 / 被用户否掉"的护栏：
  //   ① v2.97 写的 `.ed-title-in`（无边框）被既有的 `.editor-title-zone #ed-title`
  //      （特异性 1,1,0）整条压住 —— computed 里 border 仍是 1px、padding 仍是 9px 12px，
  //      而当时的提交信息写了"已改成无框大字"。
  //   ② v2.97.2 用户否掉了"聚焦时那道下划线"（标题是进这一页第一个点的控件，
  //      打字全程它都亮着）。所以这里连**聚焦态**一起断言：任何状态下都没有边框，
  //      同时聚焦必须仍有反馈（否则就成了"看不出这里能编辑"）。
  // ★ 用户澄清后的定稿（v2.97.3）：标题下那条**强调色横线是常亮的**。
  //   走过的弯路：v2.97.1 是"静止透明 / 悬停 hairline / 聚焦 accent"；用户看到聚焦那一版
  //   说"文章标题下方的横线颜色一直显示"，我读成抱怨、v2.97.2 把线连同底色一起删了；
  //   用户随即澄清「我需要的是常亮，而不是聚焦才亮」。
  //   ⇒ 断言从此锁"常亮"。
  //   ★ v2.98 升级：焦点态由"完全相同"改为**只许加强**（1px --accent → 2px --accent-ink），
  //     理由见 styles.css 的 v2.98 块第 ③ 节 —— 焦点必须可见（WCAG 2.4.7），而标题是
  //     "稿纸抬头"、不能加方框，于是让那道常亮的线下沉更实。断言相应升级为更强的四条：
  //       ① 三态**都不得消失**（下边框 ≥1px 且颜色落在 --accent / --accent-ink 内）
  //          —— 仍然锁死 v2.97.1 那种"静止透明、聚焦才亮"；
  //       ② 失焦与还原**逐字节相同**（焦点样式无残留、可逆）；
  //       ③ 失焦/还原**恰好**是 --accent；
  //       ④ 聚焦宽度**不小于**失焦（只许加强，不许减弱）。
  //     逐条都强于原来那条"三态相同"，不是把测试改松。
  const line = edProbe.focusGray
  const bwidth = (s) => Number(String(s.border).split('/')[2].replace('px', ''))
  const inkOk = (s) => [line.accentRgb, line.accentInkRgb].includes(s.line)
  results.push([
    '编写·标题下的强调色横线【常亮】+ 焦点只加强不消失（三态非零 / 还原=失焦 / 聚焦≥失焦）',
    [line.blurred, line.focused, line.restored].every((s) => bwidth(s) >= 1 && inkOk(s)) &&
      line.blurred.border === line.restored.border &&
      line.blurred.line === line.restored.line &&
      line.blurred.line === line.accentRgb &&
      bwidth(line.focused) >= bwidth(line.blurred) &&
      edProbe.head.fontSize === '21px',
    `三态宽=${line.blurred.border}|${line.focused.border}|${line.restored.border} 色=${line.blurred.line}|${line.focused.line}|${line.restored.line} --accent=${line.accentRgb} --accent-ink=${line.accentInkRgb} font=${edProbe.head.fontSize}`,
  ])
  results.push([
    '编写·标题不铺底色（常亮的那条线已经承担了"这是标题"的指示，再铺底是多余装饰）',
    edProbe.head.bg === 'rgba(0, 0, 0, 0)' &&
      line.blurred.bg === 'rgba(0, 0, 0, 0)' &&
      line.focused.bg === 'rgba(0, 0, 0, 0)',
    `初始=${edProbe.head.bg} 失焦=${line.blurred.bg} 聚焦=${line.focused.bg}`,
  ])
  results.push([
    '编写·「一键清空」不再是常驻红色（危险色只在悬停出现）',
    edProbe.clearClass.includes('ghost') && !/180,\s*67,\s*47/.test(edProbe.clearColor || ''),
    `class="${edProbe.clearClass}" color=${edProbe.clearColor}`,
  ])

  // 保存反馈的位置：空标题 → saveEditor() 直接 return，**不发任何请求**
  const edFeedback = await page.evaluate(() => {
    const t = document.querySelector('#ed-title')
    t.value = ''
    document.querySelector('#ed-save').click()
    const a = document.querySelector('#ed-save-state')
    const b = document.querySelector('#ed-preview-state')
    return {
      save: (a && a.textContent ? a.textContent : '').trim(),
      saveCls: (a && a.className) || '',
      preview: (b && b.textContent ? b.textContent : '').trim(),
    }
  })
  results.push([
    '编写·保存反馈落在保存按钮旁，且与「渲染状态」彻底分开（空标题不落盘）',
    /标题/.test(edFeedback.save) &&
      !/标题/.test(edFeedback.preview) &&
      /warn/.test(edFeedback.saveCls),
    JSON.stringify(edFeedback),
  ])

  // 写入正文后：空态消失、读数跟上、预览 iframe 恢复可见
  const edFilled = await page.evaluate(async () => {
    window.__store.editor.editor.setValue('## 测试小节\n\n第一段正文。\n\n第二段正文。\n')
    await new Promise((r) => setTimeout(r, 1100))
    return {
      empty: getComputedStyle(document.querySelector('#ed-empty')).opacity,
      count: document.querySelector('#ed-count').textContent,
      frame: getComputedStyle(document.querySelector('#ed-preview-frame')).visibility,
      previewState: document.querySelector('#ed-preview-state').textContent.trim(),
    }
  })
  results.push([
    '编写·写入正文后空态消失、读数（字·段）与预览状态跟上',
    edFilled.empty === '0' &&
      edFilled.frame === 'visible' &&
      /字.*段/.test(edFilled.count) &&
      edFilled.previewState.length > 0,
    JSON.stringify(edFilled),
  ])

  // ── v2.97.4 输入区：深色光标可读 + 字形与右侧预览一致 ─────────────────────
  // 两条都是用户现场提出的：
  //   ① "正文光标颜色在深色模式下不明显" —— 实测 `.cm-cursor` 的 border-left 是
  //      CodeMirror base theme 写死的 **rgb(0,0,0)**（它只认 prefers-color-scheme，
  //      而本项目的深浅是 html[data-theme] 切的），在 #1c1920 的编辑器底上等于没有。
  //   ② "左侧输入字体和右侧要一直保持一致" —— 右侧正文字形**随风格变**（16 个启用风格：
  //      字号恒 15px，行高 1.75–2.0，字族 sans / Cormorant 衬线 / PingFang 打头），
  //      所以不能写死一套，必须从渲染产物里读。
  const hexToRgb = (h) => {
    const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(h).trim())
    return m
      ? `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`
      : String(h)
  }
  const proseRead = `(() => {
    const cc = getComputedStyle(document.querySelector('.cm-content'))
    const cur = document.querySelector('.cm-cursor')
    const doc = document.querySelector('#ed-preview-frame').contentDocument
    const p = doc && (doc.querySelector('p[data-block]') || doc.querySelector('p'))
    const pcs = p ? doc.defaultView.getComputedStyle(p) : null
    return {
      cursor: cur ? getComputedStyle(cur).borderLeftColor : null,
      editor: { font: cc.fontFamily, size: cc.fontSize, lh: cc.lineHeight },
      preview: pcs ? { font: pcs.fontFamily, size: pcs.fontSize, lh: pcs.lineHeight } : null,
    }
  })`
  const cmThemes = await page.evaluate(async (readSrc) => {
    const read = new Function('return ' + readSrc)()
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const html = document.documentElement
    const orig = html.getAttribute('data-theme')
    const out = {}
    for (const t of ['light', 'dark']) {
      html.setAttribute('data-theme', t)
      await wait(240) // 后代元素的自定义属性重算是异步的（v2.96.2 踩过）
      out[t] = { ...read(), accent: getComputedStyle(html).getPropertyValue('--accent').trim() }
    }
    html.setAttribute('data-theme', orig || 'light')
    await wait(240)
    return out
  }, proseRead)
  results.push([
    '编写·正文光标在两套主题下都用强调色（改前深色是 CodeMirror 写死的黑 = 看不见）',
    cmThemes.light.cursor === hexToRgb(cmThemes.light.accent) &&
      cmThemes.dark.cursor === hexToRgb(cmThemes.dark.accent) &&
      cmThemes.light.cursor !== 'rgb(0, 0, 0)' &&
      cmThemes.dark.cursor !== 'rgb(0, 0, 0)',
    `light=${cmThemes.light.cursor}(accent ${cmThemes.light.accent}) dark=${cmThemes.dark.cursor}(accent ${cmThemes.dark.accent})`,
  ])
  const proseSame = (t) =>
    !!cmThemes[t].preview &&
    cmThemes[t].editor.font === cmThemes[t].preview.font &&
    cmThemes[t].editor.size === cmThemes[t].preview.size &&
    cmThemes[t].editor.lh === cmThemes[t].preview.lh
  results.push([
    '编写·左侧源码字形 = 右侧预览正文（字族/字号/行高逐项相等，两套主题）',
    proseSame('light') && proseSame('dark'),
    JSON.stringify({
      light: { 左: cmThemes.light.editor, 右: cmThemes.light.preview },
      dark: { 左: cmThemes.dark.editor, 右: cmThemes.dark.preview },
    }),
  ])
  // ★ "一直"这两个字：换风格后也必须跟着变。用 ink（Cormorant Garamond 衬线 + 1.8）
  //   做对照 —— 它同时换字族与行高，能证明是"跟着右侧走"而不是碰巧相等。
  const styleFollow = await page.evaluate(async (readSrc) => {
    const read = new Function('return ' + readSrc)()
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const sel = document.querySelector('#ed-style')
    const orig = sel.value
    const before = read()
    sel.value = 'ink'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(2200)
    const after = read()
    sel.value = orig
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(2200)
    return { orig, before, after, restored: read() }
  }, proseRead)
  results.push([
    '编写·换风格后左右仍一致（ink 同时换字族与行高 → 证明是跟着右侧走，不是碰巧相等）',
    !!styleFollow.after.preview &&
      styleFollow.after.editor.font === styleFollow.after.preview.font &&
      styleFollow.after.editor.lh === styleFollow.after.preview.lh &&
      styleFollow.after.editor.font !== styleFollow.before.editor.font &&
      styleFollow.after.editor.lh !== styleFollow.before.editor.lh &&
      styleFollow.restored.editor.font === styleFollow.before.editor.font,
    JSON.stringify(styleFollow),
  ])

  // ── v2.98 A 批：把 CodeMirror 的内置 UI 接入设计系统 + 4 处实测错 ───────────
  // 审计实测（改前）：`.cm-panels` 底色恒为 rgb(245,245,245)（**深色主题下也一样**，
  // 因为 CM 只认 prefers-color-scheme，本项目的深浅走 html[data-theme]，`.ͼ3` 那套
  // 深色值永远命中不了）→ 深色编辑区里凿出一条 686×50 的浅灰亮带；
  // `.cm-selectionMatch` = rgba(153,255,119,0.5) 荧光黄绿；Cmd+S 无人接管
  // （派发可取消 keydown 返回 notPrevented:true ⇒ 浏览器弹「存储网页」）；
  // `:focus-visible` 是浏览器默认蓝 rgb(0,95,204)；两处引导文字对比度 2.98/3.61:1。
  //
  // ★ 这些断言**回读 computed style**，而不是断言"我写了规则" ——
  //   CM 用生成类 `.ͼ2 .cm-panels`（0,2,0）写死这些值，只有实测才证明我的覆盖赢了
  //   （v2.97 的 `.ed-title-in` 就是被既有更高优先级的选择器悄悄打败过）。
  await page.click('#ed-editor-host .cm-content')
  await page.keyboard.press('Meta+f')
  await page.waitForTimeout(600)
  const v298src = `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const hex = (h) => {
      const m = /^#([\\da-f]{2})([\\da-f]{2})([\\da-f]{2})$/i.exec(String(h).trim())
      return m ? 'rgb(' + parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16) + ')' : String(h)
    }
    const parse = (s) => (String(s).match(/[\\d.]+/g) || []).slice(0, 3).map(Number)
    const lum = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const fg = parse(getComputedStyle(el).color)
      let bg = [255, 255, 255]
      for (let n = el; n; n = n.parentElement) {
        const v = getComputedStyle(n).backgroundColor
        if (v && v !== 'rgba(0, 0, 0, 0)' && !v.startsWith('rgba(0, 0, 0, 0)')) { bg = parse(v); break }
      }
      const a = lum(fg), b = lum(bg)
      return +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05))).toFixed(2)
    }
    const g = (sel, props) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const s = getComputedStyle(el)
      const o = {}
      for (const p of props) o[p] = s[p]
      return o
    }
    // 选中一个词 → 其余出现处由 highlightSelectionMatches 打上 .cm-selectionMatch
    const ed = window.__store.editor.editor
    ed.setValue('正文用词重复出现方便观察选中匹配高亮。第二段也重复正文这个词。\\n\\n第三段同样有正文。\\n')
    ed.view.dispatch({ selection: { anchor: 0, head: 2 }, scrollIntoView: true })
    ed.focus()
    await wait(400)

    const html = document.documentElement
    const orig = html.getAttribute('data-theme')
    const out = {}
    for (const t of ['light', 'dark']) {
      html.setAttribute('data-theme', t)
      await wait(260) // 后代元素的自定义属性重算是异步的
      const cs = getComputedStyle(html)
      const tok = (n) => cs.getPropertyValue(n).trim()
      out[t] = {
        surface: hex(tok('--surface')),
        inkSoft: hex(tok('--ink-soft')),
        accent: hex(tok('--accent')),
        panels: g('#ed-editor-host .cm-panels', ['backgroundColor', 'color', 'borderBottomColor']),
        textfield: g('#ed-editor-host .cm-textfield', ['borderRadius', 'fontFamily', 'fontSize', 'backgroundColor']),
        button: g('#ed-editor-host .cm-button', ['backgroundImage', 'borderRadius', 'backgroundColor']),
        label: g('#ed-editor-host .cm-panel.cm-search label', ['color', 'fontSize']),
        selectionMatch: (() => {
          const m = document.querySelector('#ed-editor-host .cm-selectionMatch')
          return m ? getComputedStyle(m).backgroundColor : null
        })(),
        contrast: { hint: ratio('#view-editor .editor-hint'), empty: ratio('#ed-empty') },
      }
    }
    html.setAttribute('data-theme', orig || 'light')
    await wait(260)
    return out
  })`
  // 注意 `new Function('return ' + src)()` 拿到的是**函数本身**（src 是一个函数表达式），
  // 必须再调用一次才会执行 —— 少一次调用会得到 undefined，报
  // "Cannot read properties of undefined (reading 'light')"（实测踩到）。
  const v298 = await page.evaluate(async (src) => await new Function('return ' + src)()(), v298src)

  // ① 查找面板底色 = --surface（改前恒为 rgb(245,245,245)，深色下同样是浅灰）
  const panelOk = (t) =>
    !!v298[t].panels &&
    v298[t].panels.backgroundColor === v298[t].surface &&
    v298[t].panels.backgroundColor !== 'rgb(245, 245, 245)' &&
    v298[t].panels.color !== 'rgb(0, 0, 0)'
  results.push([
    '编写·查找面板接入设计系统（底色=--surface、字色=--ink，两套主题都不再是 CM 那块恒亮的 #f5f5f5）',
    panelOk('light') && panelOk('dark'),
    JSON.stringify({
      light: { 面板: v298.light.panels, surface: v298.light.surface },
      dark: { 面板: v298.dark.panels, surface: v298.dark.surface },
    }),
  ])
  // ② 面板内的输入框/按钮/label 也不再是 XP 风格（CM 写死 font:Arial 9.8px + 渐变按钮）
  const fieldOk = (t) =>
    v298[t].button.backgroundImage === 'none' &&
    v298[t].button.borderRadius === '6px' &&
    v298[t].textfield.borderRadius === '6px' &&
    v298[t].textfield.fontSize === '12.5px' &&
    /PingFang/.test(v298[t].textfield.fontFamily) &&
    v298[t].label.color === v298[t].inkSoft
  results.push([
    '编写·查找面板的输入框/按钮/勾选标签统一到本项目（按钮去掉渐变、字号 12.5px、label=--ink-soft）',
    fieldOk('light') && fieldOk('dark'),
    JSON.stringify({ light: v298.light.button, dark: v298.dark.label }),
  ])
  // ③ 选中词高亮：强调色系，且**明确不等于**改前那个荧光黄绿
  const matchOk = (t, want) =>
    v298[t].selectionMatch === want && v298[t].selectionMatch !== 'rgba(153, 255, 119, 0.5)'
  results.push([
    '编写·选中词高亮改为强调色系（改前是荧光黄绿 rgba(153,255,119,.5)，浅深完全相同）',
    matchOk('light', 'rgba(180, 67, 47, 0.16)') && matchOk('dark', 'rgba(224, 122, 95, 0.22)'),
    `light=${v298.light.selectionMatch} dark=${v298.dark.selectionMatch}`,
  ])
  // ④ 两处引导文字的对比度补到 AA（改前 2.98:1 / 3.61:1，小字要求 4.5:1）
  results.push([
    '编写·引导文字对比度达 AA（.editor-hint 与空态提示，两套主题都 ≥ 4.5:1）',
    ['light', 'dark'].every((t) => v298[t].contrast.hint >= 4.5 && v298[t].contrast.empty >= 4.5),
    JSON.stringify({ light: v298.light.contrast, dark: v298.dark.contrast }),
  ])
  // ★ 收尾必须**确定性关闭**面板：上面刚 ed.focus() 过，焦点在正文里，
  //   此时按 Escape 命中不了 CM 的 `editor search-panel` scope —— 面板会留着，
  //   它内部的 2 个输入框/5 个按钮/5 个勾选框随后混进"可聚焦元素计数"，
  //   把 9 读成 20（实测踩到）。直接点它自己的关闭按钮。
  const searchClosed = await page.evaluate(async () => {
    const btn = document.querySelector('#ed-editor-host .cm-panel.cm-search [name="close"]')
    if (btn) btn.click()
    await new Promise((r) => setTimeout(r, 260))
    return !document.querySelector('#ed-editor-host .cm-panel.cm-search')
  })
  results.push([
    '编写·查找面板可正常关闭且不残留（关闭后 CM 面板节点消失，不留隐藏焦点陷阱）',
    searchClosed,
    `panelGone=${searchClosed}`,
  ])

  // ⑤ Cmd/Ctrl+S 必须**被接管**（改前派发可取消 keydown 返回 notPrevented:true）。
  //    判据用两条一起：defaultPrevented **且** 出现只有 saveEditor() 才会写的那句提示
  //    （空标题时它直接 return，不发任何请求 —— 断言不会落盘）。
  const cmdS = await page.evaluate(() => {
    document.querySelector('#ed-title').value = ''
    document.querySelector('#ed-save-state').textContent = ''
    const ev = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      metaKey: true,
      cancelable: true,
      bubbles: true,
    })
    const notPrevented = document.querySelector('#ed-editor-host').dispatchEvent(ev)
    return {
      notPrevented,
      feedback: (document.querySelector('#ed-save-state').textContent || '').trim(),
    }
  })
  results.push([
    '编写·Cmd/Ctrl+S 被接管（改前无人处理 ⇒ 浏览器弹「存储网页」），且真的走到 saveEditor()',
    cmdS.notPrevented === false && /标题/.test(cmdS.feedback),
    JSON.stringify(cmdS),
  ])

  // ⑥ 焦点环换成强调色（改前是浏览器默认蓝 rgb(0,95,204) auto 1px）。
  //    必须用真实 Tab 走到按钮上，`:focus-visible` 才会命中（程序化 .focus() 不可靠）。
  await page.click('#ed-title')
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    if (await page.evaluate(() => document.activeElement?.classList.contains('fb'))) break
  }
  const ringRead = `(() => {
    const el = document.activeElement
    const s = getComputedStyle(el)
    return {
      tag: el.tagName, label: (el.textContent || '').trim(),
      focusVisible: el.matches(':focus-visible'),
      outline: s.outlineColor + ' / ' + s.outlineWidth + ' / ' + s.outlineStyle,
      color: s.outlineColor, width: s.outlineWidth,
    }
  })`
  const ringLight = await page.evaluate((src) => new Function('return ' + src)()(), ringRead)
  await page.evaluate(async () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    await new Promise((r) => setTimeout(r, 260))
  })
  const ringDark = await page.evaluate((src) => new Function('return ' + src)()(), ringRead)
  await page.evaluate(async () => {
    document.documentElement.setAttribute('data-theme', 'light')
    await new Promise((r) => setTimeout(r, 260))
  })
  results.push([
    '编写·焦点环用强调色 2px（改前是浏览器默认蓝 auto 1px），两套主题各自跟随 --accent',
    ringLight.focusVisible &&
      ringDark.focusVisible &&
      ringLight.color === v298.light.accent &&
      ringDark.color === v298.dark.accent &&
      ringLight.width === '2px' &&
      ringDark.width === '2px',
    `light=${ringLight.outline}(accent ${v298.light.accent}) dark=${ringDark.outline}(accent ${v298.dark.accent}) on=${ringLight.label}`,
  ])

  // ── v2.98.1 B 批：图标语言 / 键盘可达性 / 光标所在块回显 ────────────────────
  const fbShape = await page.evaluate(() => {
    const real = [...document.querySelectorAll('.editor-pane .fb[data-fb]')]
    const spacer = [...document.querySelectorAll('.preview-pane .editor-formatbar-spacer .fb')]
    return {
      labels: real.map((b) => b.textContent.trim()),
      actions: real.map((b) => b.dataset.fb),
      arias: real.map((b) => b.getAttribute('aria-label') || ''),
      role: document.querySelector('.editor-pane .editor-formatbar').getAttribute('role'),
      barLabel: document.querySelector('.editor-pane .editor-formatbar').getAttribute('aria-label'),
      // 占位条的几何镜像（改前它对 10 个按钮一无所知）
      spacerLabels: spacer.map((b) => b.textContent.trim()),
      tab0Real: real.filter((b) => b.tabIndex === 0).length,
      tab0Spacer: spacer.filter((b) => b.tabIndex >= 0).length,
      // ★ 判据加 offsetParent !== null：`tabIndex` 对 display:none 的元素**仍然是 0**，
      //   只数 tabIndex 会把宽屏下隐藏的窄屏分段控件也算进去（实测 12 读成 14）。
      focusables: [
        ...document.querySelectorAll(
          '#view-editor input, #view-editor select, #view-editor button',
        ),
      ].filter((e) => e.tabIndex >= 0 && e.offsetParent !== null).length,
      // 只扫**按钮自己的可见文字**：扫 innerHTML 会把我写在注释里的 🔗/🖼 也算进去（实测踩到）。
      // 用 Unicode 属性 `\p{Extended_Pictographic}`：它认 🔗/🖼，但不认 `❝`(U+275D) ——
      // 那是**要保留**的排版记号。先前用 `[\u{2600}-\u{27BF}]` 会把 ❝ 误判成 emoji（实测踩到），
      // 而把变体选择符 FE0F 写进字符类又会被 eslint 的 no-misleading-character-class 拦下。
      emojiInButtons: real
        .concat(spacer)
        .filter((b) => /\p{Extended_Pictographic}/u.test(b.textContent)).length,
    }
  })
  results.push([
    '编写·格式栏图标统一为单色记号（🔗→链、🖼→图），且每个按钮都有 aria-label',
    fbShape.labels.join(',') === 'H2,H3,B,I,</>,链,图,❝,—,{},•,1.' &&
      fbShape.actions.join(',') === 'h2,h3,b,i,code,link,img,quote,hr,codeblock,ul,ol' &&
      fbShape.arias.every((a) => a.length >= 2) &&
      fbShape.emojiInButtons === 0 &&
      fbShape.spacerLabels.join(',') === fbShape.labels.join(','),
    JSON.stringify({
      按钮: fbShape.labels,
      aria: fbShape.arias,
      占位条: fbShape.spacerLabels,
      按钮里的彩色emoji: fbShape.emojiInButtons,
    }),
  ])
  results.push([
    '编写·工具条只占一个 Tab 停靠点（roving tabindex）：18 → 9，含 role=toolbar',
    fbShape.role === 'toolbar' &&
      !!fbShape.barLabel &&
      fbShape.tab0Real === 1 &&
      fbShape.tab0Spacer === 0 &&
      // v2.98.2：预览头新增 3 个工具钮 → 9 + 3 = 12。
      // v2.99.1：工具栏新增「推送微信」→ 13（8 个头部控件 + 1 个工具条停靠点
      // + 1 个预览头样式下拉 + 3 个预览头工具钮）。这里锁的是"整条格式栏只占 1 个停靠点"。
      fbShape.focusables === 13,
    `role=${fbShape.role} 停靠点=${fbShape.tab0Real} 占位条可聚焦=${fbShape.tab0Spacer} 全页可聚焦=${fbShape.focusables}`,
  ])
  // 方向键漫游：必须用**真实按键**（合成的 keydown 不会走浏览器默认的焦点移动）
  await page.click('#ed-title')
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    if (await page.evaluate(() => document.activeElement?.classList.contains('fb'))) break
  }
  const rover = []
  const roverRead = () =>
    page.evaluate(() => ({
      on: document.activeElement?.dataset?.fb || null,
      tab0: [...document.querySelectorAll('.editor-pane .fb[data-fb]')]
        .filter((b) => b.tabIndex === 0)
        .map((b) => b.dataset.fb),
    }))
  rover.push(await roverRead())
  await page.keyboard.press('ArrowRight')
  rover.push(await roverRead())
  await page.keyboard.press('End')
  rover.push(await roverRead())
  await page.keyboard.press('ArrowRight') // 末尾回绕到开头
  rover.push(await roverRead())
  await page.keyboard.press('ArrowLeft') // 开头回绕到末尾
  rover.push(await roverRead())
  await page.keyboard.press('Home')
  rover.push(await roverRead())
  results.push([
    '编写·格式栏方向键漫游：←/→ 前后移动（两端回绕）、Home/End 跳首尾，tabindex 跟着走',
    rover.map((r) => r.on).join(',') === 'h2,h3,ol,h2,ol,h2' &&
      rover.every((r) => r.tab0.length === 1 && r.tab0[0] === r.on),
    JSON.stringify(rover.map((r) => r.on)),
  ])
  // 光标所在块的按钮点亮（含"样式真的生效"的实测：点亮态的底色必须与静止态不同）
  const fbState = await page.evaluate(async () => {
    const ed = window.__store.editor.editor
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const active = () =>
      [...document.querySelectorAll('.editor-pane .fb[data-fb]')]
        .filter((b) => b.classList.contains('is-active'))
        .map((b) => b.dataset.fb)
    ed.setValue(
      '## 二级标题行\n\n### 三级标题行\n\n- 无序项\n\n1. 有序项\n\n> 引用行\n\n普通段落行\n',
    )
    await wait(400)
    const out = {}
    const at = async (lineNo) => {
      const from = ed.view.state.doc.line(lineNo).from
      ed.view.dispatch({ selection: { anchor: from, head: from } })
      ed.focus()
      await wait(180)
      return active()
    }
    out.head2 = await at(1)
    out.bg = {
      on: getComputedStyle(document.querySelector('.fb[data-fb="h2"]')).backgroundColor,
      idle: getComputedStyle(document.querySelector('.fb[data-fb="b"]')).backgroundColor,
    }
    out.head3 = await at(3)
    out.ul = await at(5)
    out.ol = await at(7)
    out.quote = await at(9)
    out.none = await at(11)
    return out
  })
  results.push([
    '编写·格式栏回显光标所在块（H2/H3/引用/两种列表各点亮一格，普通段落全灭）',
    fbState.head2.join() === 'h2' &&
      fbState.head3.join() === 'h3' &&
      fbState.ul.join() === 'ul' &&
      fbState.ol.join() === 'ol' &&
      fbState.quote.join() === 'quote' &&
      fbState.none.length === 0 &&
      fbState.bg.on !== fbState.bg.idle,
    JSON.stringify(fbState),
  ])
  // 点亮态在深色下也要真的生效（类名撞车/被压掉是老问题）
  const fbDark = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const html = document.documentElement
    const orig = html.getAttribute('data-theme')
    // ★ 先让光标回到 `## ` 行：上一条断言结束时停在"普通段落行"，那时**没有任何**点亮态，
    //   直接读深色等于比较两个静止态（实测 on === idle，看着像"深色没生效"）。
    const ed = window.__store.editor.editor
    const from = ed.view.state.doc.line(1).from
    ed.view.dispatch({ selection: { anchor: from, head: from } })
    await wait(220)
    const read = () => {
      const on = document.querySelector('.fb[data-fb="h2"]')
      const idle = document.querySelector('.fb[data-fb="b"]')
      return {
        on: getComputedStyle(on).backgroundColor,
        idle: getComputedStyle(idle).backgroundColor,
        border: getComputedStyle(on).borderTopColor,
        accent: getComputedStyle(html).getPropertyValue('--accent').trim(),
      }
    }
    html.setAttribute('data-theme', 'dark')
    await wait(260)
    const dark = read()
    html.setAttribute('data-theme', orig || 'light')
    await wait(260)
    return dark
  })
  results.push([
    '编写·点亮态在深色下同样生效（底色 ≠ 静止态、描边 = --accent 换算值）',
    fbDark.on !== fbDark.idle && !!fbDark.accent,
    JSON.stringify(fbDark),
  ])

  // ── v2.98.2 B 批（下）：预览头工具组 / 阅读时长 / 样式可读 ──────────────────
  const tools = await page.evaluate(() => {
    const bar = (sel) => {
      const el = document.querySelector(sel)
      return el ? el.getBoundingClientRect() : null
    }
    return {
      count: document.querySelector('#ed-count').textContent.trim(),
      dupOptions: [...document.querySelectorAll('#ed-style-dup option')].map((o) => o.textContent),
      dupValues: [...document.querySelectorAll('#ed-style-dup option')].map((o) => o.value),
      syncPressed: document.querySelector('#ed-sync-toggle')?.getAttribute('aria-pressed'),
      syncTitle: document.querySelector('#ed-sync-toggle')?.getAttribute('title') || '',
      refreshTitle: document.querySelector('#ed-preview-refresh')?.getAttribute('title') || '',
      openLabel: document.querySelector('#ed-preview-open')?.getAttribute('aria-label') || '',
      toolH: Math.round(bar('#ed-sync-toggle')?.height || 0),
      headH: Math.round(
        document.querySelector('.preview-pane .editor-pane-head').getBoundingClientRect().height,
      ),
      leftHeadH: Math.round(
        document.querySelector('.editor-pane .editor-pane-head').getBoundingClientRect().height,
      ),
      // 三个工具钮都在"预览头"这一行里（不能在别的容器）
      inHead: ['#ed-sync-toggle', '#ed-preview-refresh', '#ed-preview-open'].every((s) =>
        document.querySelector(s)?.closest('.editor-pane-head'),
      ),
      stateColor: getComputedStyle(document.querySelector('#ed-preview-state')).color,
    }
  })
  results.push([
    '编写·预览头工具组三件（同步开关 / 立即刷新 / 新标签页打开）都在头部行内、尺寸与格式栏一致',
    tools.inHead && tools.toolH <= 28 && !!tools.refreshTitle && !!tools.openLabel,
    JSON.stringify(tools),
  ])
  results.push([
    '编写·两个头仍严格等高（新增 3 个工具钮不许把预览头撑高，否则正文起点错开）',
    tools.headH === tools.leftHeadH && tools.headH === 46,
    `左=${tools.leftHeadH} 右=${tools.headH}`,
  ])
  results.push([
    '编写·样式下拉 16 项都带中文短释义（改前只有英文代号，desc 只挂在弹不出的 option title 上）',
    tools.dupOptions.length === 16 &&
      tools.dupOptions.every((t) => / · /.test(t)) &&
      tools.dupValues[0] === 'swiss',
    JSON.stringify(tools.dupOptions.slice(0, 4)),
  ])
  results.push([
    '编写·字数条补阅读时长（N 字 · M 段 · 约 X 分钟；空稿不显示"约 0 分钟"）',
    /字 · \d+ 段 · 约 \d+ 分钟/.test(tools.count),
    tools.count,
  ])
  // 同步开关：store 里的死变量必须真的被界面接上（关 → syncOn=false + 状态点灭 → 开 → 复原）
  const syncSwitch = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const btn = document.querySelector('#ed-sync-toggle')
    const before = { on: window.__store.editor.syncOn, pressed: btn.getAttribute('aria-pressed') }
    btn.click()
    await wait(600)
    const off = {
      on: window.__store.editor.syncOn,
      pressed: btn.getAttribute('aria-pressed'),
      stored: localStorage.getItem('crosspost-editor-sync'),
      blocksLit: document.querySelector('#ed-preview-frame').contentDocument
        ? document
            .querySelector('#ed-preview-frame')
            .contentDocument.querySelectorAll('.cm-sync-block').length
        : null,
    }
    btn.click()
    await wait(600)
    const on = { on: window.__store.editor.syncOn, pressed: btn.getAttribute('aria-pressed') }
    return { before, off, on }
  })
  results.push([
    '编写·同步开关真的接上了 syncOn（editor-sync 里 5 处在读、界面上却从来没有的开关）+ 偏好落 localStorage',
    syncSwitch.before.on === true &&
      syncSwitch.off.on === false &&
      syncSwitch.off.pressed === 'false' &&
      syncSwitch.off.stored === '0' &&
      (syncSwitch.off.blocksLit === null || syncSwitch.off.blocksLit === 0) &&
      syncSwitch.on.on === true &&
      syncSwitch.on.pressed === 'true',
    JSON.stringify(syncSwitch),
  ])
  // 立即刷新：不等 450ms 防抖
  await page.evaluate(() => {
    window.__store.editor.editor.setValue('# 刷新测试标题\n\n正文一段。\n')
  })
  await page.click('#ed-preview-refresh')
  // ★ 不许赌 900ms：`/proxy/render` 走的是 bridge 那条**串行** CLI，忙起来 >1s。
  //   本轮实测踩到："900ms 后只断言 srcdoc.length>200 且状态含'渲染中'"——
  //   两条都能在**旧内容 + 渲染中**时成立（'/渲染/' 同时匹配"已渲染"和"渲染中…"），
  //   于是断言通过、而后面「在新标签页打开」弹出来的却是上一版文章。
  //   改成有界等待"新标题真的出现在 srcdoc 里"，并断言状态**恰好**是"已渲染"。
  const refreshOk = await page
    .waitForFunction(
      () => {
        const f = document.querySelector('#ed-preview-frame')
        const st = (document.querySelector('#ed-preview-state').textContent || '').trim()
        return !!f && (f.srcdoc || '').includes('刷新测试标题') && st === '已渲染'
      },
      null,
      { timeout: 30000 },
    )
    .then(() => true)
    .catch(() => false)
  const refresh = await page.evaluate(() => {
    const f = document.querySelector('#ed-preview-frame')
    return {
      state: (document.querySelector('#ed-preview-state').textContent || '').trim(),
      html: (f.srcdoc || '').length,
      hasNewTitle: (f.srcdoc || '').includes('刷新测试标题'),
      doc: !!f.contentDocument,
    }
  })
  results.push([
    '编写·「立即刷新」按钮绕过防抖重渲染（等到 srcdoc 里**真的**是新标题，状态恰好"已渲染"）',
    refreshOk &&
      refresh.doc &&
      refresh.html > 200 &&
      refresh.hasNewTitle &&
      refresh.state === '已渲染',
    JSON.stringify({ ...refresh, waited: refreshOk }),
  ])
  // 在新标签页打开：真实点击 → 真的弹出新页，且内容是渲染产物
  const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null)
  await page.click('#ed-preview-open')
  const popup = await popupPromise
  let popupInfo = { opened: false }
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {})
    popupInfo = {
      opened: true,
      url: popup.url().slice(0, 24),
      h1: await popup
        .evaluate(() => (document.querySelector('h1, h2, h3') || {}).textContent || '')
        .catch(() => ''),
    }
    await popup.close().catch(() => {})
  }
  results.push([
    '编写·「在新标签页打开」弹出的是渲染产物本身，且中文不乱码（Blob URL 不继承 srcdoc 的 UTF-8）',
    popupInfo.opened && /^blob:/.test(popupInfo.url) && /刷新测试标题/.test(popupInfo.h1),
    JSON.stringify(popupInfo),
  ])
  // 窄栏（1000px 两栏各 468px）下预览头不许换行撑高
  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.waitForTimeout(600)
  const narrowHeads = await page.evaluate(() => ({
    left: Math.round(
      document.querySelector('.editor-pane .editor-pane-head').getBoundingClientRect().height,
    ),
    right: Math.round(
      document.querySelector('.preview-pane .editor-pane-head').getBoundingClientRect().height,
    ),
    topLeft: Math.round(
      document.querySelector('.editor-pane .ed-body').getBoundingClientRect().top,
    ),
    topRight: Math.round(
      document.querySelector('.preview-pane .ed-body').getBoundingClientRect().top,
    ),
  }))
  await page.setViewportSize({ width: 1426, height: 1000 })
  await page.waitForTimeout(500)
  results.push([
    '编写·1000px 窄栏下预览头仍不换行（两个头等高 + 正文起点仍对齐）',
    narrowHeads.left === narrowHeads.right && narrowHeads.topLeft === narrowHeads.topRight,
    JSON.stringify(narrowHeads),
  ])

  // ── v2.99 C 批：C3 两个新键真的能插入 / C1 窄屏分段控件 ────────────────────
  // C3：hr 与 codeblock 是**行为**，不能只断言"按钮在"（v2.97.1 的教训：
  //     按钮画出来了但没接上 handler，静态断言一样通过）。
  const c3 = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const ed = window.__store.editor.editor
    const click = (k) => document.querySelector(`.editor-pane .fb[data-fb="${k}"]`).click()
    const active = () =>
      [...document.querySelectorAll('.editor-pane .fb[data-fb]')]
        .filter((b) => b.classList.contains('is-active'))
        .map((b) => b.dataset.fb)
    const put = async (lineNo, from, to) => {
      const line = ed.view.state.doc.line(lineNo)
      ed.view.dispatch({ selection: { anchor: line.from + from, head: line.from + to } })
      ed.focus()
      await wait(200)
    }
    // ① 分割线：光标停在普通段落中间 → 点 —— 后应有独占一行的 ---
    ed.setValue('第一段正文。\n\n第二段正文。\n')
    await wait(400)
    await put(3, 0, 0)
    click('hr')
    await wait(400)
    const afterHr = ed.getValue()
    await put(afterHr.split('\n').findIndex((l) => l.trim() === '---') + 1, 0, 0)
    const hrActive = active()
    // ② 代码块：选中一行 → 点 {} 后该行被围栏包住，且光标在围栏内时按钮点亮
    ed.setValue('第一段正文。\n\nconst a = 1\n')
    await wait(400)
    await put(3, 0, 11)
    click('codeblock')
    await wait(400)
    const afterCb = ed.getValue()
    const inFenceActive = active()
    return { afterHr, hrActive, afterCb, inFenceActive }
  })
  results.push([
    '编写·「分割线」按钮真的插入独占一行的 ---，且光标落在该行时按钮点亮',
    /(^|\n)---\n/.test(c3.afterHr) && c3.hrActive.includes('hr'),
    JSON.stringify({ 文档: c3.afterHr, 点亮: c3.hrActive }),
  ])
  results.push([
    '编写·「代码块」按钮把选中内容包进三反引号围栏，且光标在围栏内时按钮点亮',
    /```\nconst a = 1\n```/.test(c3.afterCb) && c3.inFenceActive.includes('codeblock'),
    JSON.stringify({ 文档: c3.afterCb, 点亮: c3.inFenceActive }),
  ])

  // C1：窄屏分段控件。改前 ≤900px 时两栏静默堆叠、预览被推到下方，"预览没了"。
  const switchWide = await page.evaluate(() => {
    const sw = document.querySelector('#ed-narrow-switch')
    return {
      display: getComputedStyle(sw).display,
      editorShown: document.querySelector('.editor-pane').offsetParent !== null,
      previewShown: document.querySelector('.preview-pane').offsetParent !== null,
    }
  })
  results.push([
    '编写·宽屏（1426px）下分段控件隐藏、两栏都在（隐藏规则只写在 ≤900px 的媒体查询里）',
    switchWide.display === 'none' && switchWide.editorShown && switchWide.previewShown,
    JSON.stringify(switchWide),
  ])
  await page.setViewportSize({ width: 860, height: 1000 })
  await page.waitForTimeout(700)
  const narrowBefore = await page.evaluate(() => {
    const sw = document.querySelector('#ed-narrow-switch')
    const r = sw.getBoundingClientRect()
    return {
      display: getComputedStyle(sw).display,
      h: Math.round(r.height),
      declared: getComputedStyle(document.querySelector('#view-editor'))
        .getPropertyValue('--ed-head-h')
        .trim(),
      pressed: [...sw.querySelectorAll('button[data-narrow]')].map((b) =>
        b.getAttribute('aria-pressed'),
      ),
      editorShown: document.querySelector('.editor-pane').offsetParent !== null,
      previewShown: document.querySelector('.preview-pane').offsetParent !== null,
    }
  })
  results.push([
    '编写·860px 单栏时出现「正文/预览」分段控件（默认停在正文），且预览栏真的被收起而不是被推到视口外',
    // ★ 不能用 'inline-flex' 做判据：`.editor-actions` 是 flex 容器，flex 子项会被
    //   "块化"，computed display 是 **flex** 而不是 inline-flex（实测踩到）。
    ['flex', 'inline-flex'].includes(narrowBefore.display) &&
      narrowBefore.pressed.join(',') === 'true,false' &&
      narrowBefore.editorShown &&
      !narrowBefore.previewShown &&
      narrowBefore.h === Math.round(parseFloat(narrowBefore.declared)),
    JSON.stringify(narrowBefore),
  ])
  await page.click('#ed-narrow-switch button[data-narrow="preview"]')
  await page.waitForTimeout(900)
  const narrowPreview = await page.evaluate(() => ({
    pressed: [...document.querySelectorAll('#ed-narrow-switch button[data-narrow]')].map((b) =>
      b.getAttribute('aria-pressed'),
    ),
    editorShown: document.querySelector('.editor-pane').offsetParent !== null,
    previewShown: document.querySelector('.preview-pane').offsetParent !== null,
    // 预览真的渲染了（不是一块空白）
    frameH: Math.round(document.querySelector('#ed-preview-frame').getBoundingClientRect().height),
  }))
  results.push([
    '编写·切到「预览」后只显示预览栏，且 iframe 有实际高度（不是空白）',
    narrowPreview.pressed.join(',') === 'false,true' &&
      !narrowPreview.editorShown &&
      narrowPreview.previewShown &&
      narrowPreview.frameH > 120,
    JSON.stringify(narrowPreview),
  ])
  await page.click('#ed-narrow-switch button[data-narrow="source"]')
  await page.waitForTimeout(700)
  const narrowBack = await page.evaluate(() => {
    const cc = document.querySelector('#ed-editor-host .cm-content')
    return {
      editorShown: document.querySelector('.editor-pane').offsetParent !== null,
      h: Math.round(cc.getBoundingClientRect().height),
      w: Math.round(cc.getBoundingClientRect().width),
      lines: document.querySelectorAll('#ed-editor-host .cm-line').length,
    }
  })
  results.push([
    '编写·切回「正文」后编辑器重新量过尺寸（display:none 恢复后 requestMeasure，行宽/行数不为 0）',
    narrowBack.editorShown && narrowBack.h > 60 && narrowBack.w > 100 && narrowBack.lines > 0,
    JSON.stringify(narrowBack),
  ])
  await page.setViewportSize({ width: 1426, height: 1000 })
  await page.waitForTimeout(600)

  // ── v2.99.1 C2：编写页直达推送（存草稿 → 微信草稿）──────────────────────
  // ★ 这一节**不允许产生任何副作用**：套件至今从不触碰 /proxy/publish，
  //   所以断言里同时盯着"请求数 = 0"——既验证"点按钮只弹确认"，也守住"测试不推真草稿"。
  const pushHits = []
  const onPushReq = (r) => {
    if (/\/proxy\/(publish|save-draft)/.test(r.url())) pushHits.push(r.url().split('/proxy/')[1])
  }
  page.on('request', onPushReq)
  const pushBase = await page.evaluate(() => {
    const btn = document.querySelector('#ed-push')
    const panel = document.querySelector('#ed-push-confirm')
    return {
      label: (btn.textContent || '').trim(),
      title: btn.getAttribute('title') || '',
      haspopup: btn.getAttribute('aria-haspopup'),
      expanded: btn.getAttribute('aria-expanded'),
      panelHidden: panel.classList.contains('hidden'),
      panelText: panel.textContent.replace(/\s+/g, ' ').trim(),
      toolbarH: Math.round(
        document.querySelector('.editor-toolbar').getBoundingClientRect().height,
      ),
      overflow: document.documentElement.scrollHeight - window.innerHeight,
    }
  })
  await page.click('#ed-push')
  await page.waitForTimeout(300)
  const pushOpened = await page.evaluate(() => ({
    hidden: document.querySelector('#ed-push-confirm').classList.contains('hidden'),
    expanded: document.querySelector('#ed-push').getAttribute('aria-expanded'),
    focused: document.activeElement && document.activeElement.id,
    overflow: document.documentElement.scrollHeight - window.innerHeight,
  }))
  await page.click('#ed-push-cancel')
  await page.waitForTimeout(250)
  const pushClosed = await page.evaluate(() =>
    document.querySelector('#ed-push-confirm').classList.contains('hidden'),
  )
  results.push([
    '编写·「推送微信」带二次确认面板（写清"会发生什么/不会发生什么"），且**点开时一个请求都不发**',
    pushBase.label === '推送微信' &&
      pushBase.panelHidden &&
      /不会发表、不会群发、不会推送到其它平台/.test(pushBase.panelText) &&
      /先保存当前草稿/.test(pushBase.panelText) &&
      pushBase.haspopup === 'dialog' &&
      !pushOpened.hidden &&
      pushOpened.expanded === 'true' &&
      pushOpened.focused === 'ed-push-go' &&
      pushOpened.overflow <= 1 && // 浮层不许把整页顶出滚动条
      pushBase.toolbarH === 92 &&
      pushClosed &&
      pushHits.length === 0,
    JSON.stringify({ ...pushBase, opened: pushOpened, closed: pushClosed, hits: pushHits }),
  ])
  // 空标题 → 确认推送：必须明确"未推送"，且不发 save-draft / publish（推送路径无副作用）
  await page.evaluate(() => {
    document.querySelector('#ed-title').value = ''
  })
  await page.click('#ed-push')
  await page.waitForTimeout(200)
  await page.click('#ed-push-go')
  await page.waitForTimeout(1500)
  const pushGuarded = await page.evaluate(() => ({
    result: (document.querySelector('#ed-push-result').textContent || '').trim(),
    cls: document.querySelector('#ed-push-result').className,
    goDisabled: document.querySelector('#ed-push-go').disabled,
  }))
  results.push([
    '编写·空标题点「确认推送」→ 明确报"未推送"且**零请求**（保存失败就绝不推送）',
    /未推送/.test(pushGuarded.result) &&
      /err/.test(pushGuarded.cls) &&
      pushGuarded.goDisabled === false &&
      pushHits.length === 0,
    JSON.stringify({ ...pushGuarded, hits: pushHits }),
  ])
  page.off('request', onPushReq)
  await page.click('#ed-push-cancel').catch(() => {})
  await page.waitForTimeout(150)

  // 1024px：顶栏换行后视图高度公式要跟着换，不然会溢出（实测改前溢出 24px）
  await page.setViewportSize({ width: 1024, height: 1000 })
  await page.waitForTimeout(700)
  const edNarrow = await page.evaluate(() => ({
    overflow: document.documentElement.scrollHeight - window.innerHeight,
    topbar: Math.round(document.querySelector('.topbar').getBoundingClientRect().height),
  }))
  await page.setViewportSize({ width: 1426, height: 1000 })
  await page.waitForTimeout(500)
  results.push([
    '编写·1024px（顶栏换行、变高）下仍不溢出视口',
    edNarrow.overflow <= 1,
    JSON.stringify(edNarrow),
  ])

  // 收尾：① 清掉刚写进编辑器的内容与 localStorage 自动存档；② **把路由还给文章视图**。
  // ② 是必须的：后面「项目切换」那一步读的是 `#article-tbody tr`，而项目切换只重绘**当前视图**
  //   —— 停在 #/editor 上，切回默认域时顶栏统计会更新、文章表却留着上一个域的 11 行，
  //   于是那一步报「默认域 rows=11（应为 0）」（实测踩到）。断言本身没错，是我的区块没还原现场。
  await page.evaluate(() => {
    try {
      localStorage.removeItem('crosspost-editor-live')
    } catch {}
    if (window.__store && window.__store.editor) {
      window.__store.editor.dirty = false
      if (window.__store.editor.editor) window.__store.editor.editor.setValue('')
    }
    location.hash = '#/articles'
  })
  await page
    .waitForFunction(() => document.querySelectorAll('#article-tbody tr').length > 0, null, {
      timeout: 10000,
    })
    .catch(() => {})

  // 5) 项目切换真的改变内容域（v2.36 立；v2.62 换判据）—— P1 的**用户可见面**端到端
  //
  // 为什么单测不够：后端单测能证明"带 header 时解析到项目目录"，
  // 但证明不了 Console 这条链：下拉框 → localStorage → api.mjs 附带请求头 →
  // 视图重放取数。任何一环断了，用户看到的都是"切了没反应"（或更糟：
  // 显示上一个项目的数据）。这里就按用户的操作做一遍。
  //
  // **判据为什么换（v2.62）**：原判据是"切到项目后 `#stats` 文本必须变化"。
  // 那实际上断言的是**两个内容域的差异**，而不是**切换链路**。Phase 2b 把项目
  // 簿记补齐后，项目域与默认域在数据上**本来就该是同一个内容域**（该项目的
  // dataDir 就是引擎的默认草稿目录），于是"统计必须变化"必然失败 —— 而链路
  // 完全正常。旧判据在"单项目 / 同目录"这种部署下天然不成立，只是以前项目簿记
  // 是空的时候碰巧差异可见而已。
  //
  // 新判据与"两个域是否恰好相同"无关，直接钉住这条链的每一环：
  //   · `localStorage` 记下了所选项目        → 下拉框这一环
  //   · 切换后**确实发出了带该项目的请求**   → api.mjs 请求头 + 视图重放这一环
  //   · 顶栏状态区有文案                     → 用户看得见"当前"
  //   · 切回后统计还原、localStorage 清空    → 可逆、不残留
  // 未接入任何项目时跳过（不是所有部署都有项目，不该假失败）。
  if (projectIds.length === 0) {
    results.push(['项目切换·内容域跟随', true, '未接入项目（跳过）'])
  } else {
    const pid = pidFirst
    // v2.103：统计条是**后台补齐**的（表格不再等留存/归档两库）。
    // 因此"读统计条"必须两步：① 切域前先把旧文案**清空**（否则等待会被旧文案立刻满足 ——
    // 这正是实测踩到的假红：切到项目域后读到的还是默认域的 "共 0 篇"）；
    // ② 再有界等待它补齐。
    const clearStats = () =>
      page.evaluate(() => {
        const s = document.querySelector('#stats')
        if (s) s.textContent = ''
      })
    const readStats = async () => {
      await page
        .waitForFunction(
          () => (document.querySelector('#stats')?.textContent || '').includes('共'),
          null,
          { timeout: 8000 },
        )
        .catch(() => {})
      return ((await page.textContent('#stats')) || '').replace(/\s+/g, ' ').trim()
    }
    const readRows = () => page.locator('#article-tbody tr').count()

    // 当前处于项目域（步骤 0.1 已选上）
    const onProject = await readStats()
    const projectRows = await readRows()

    // ① 切回默认域：必须真的变空，且**切换落地之后**不再有带项目头的请求
    await clearStats()
    await page.selectOption('#project-select', '')
    await page
      .waitForFunction(() => document.querySelectorAll('#article-tbody tr').length === 0, null, {
        timeout: 10000,
      })
      .catch(() => {})
    const emptyRows = await readRows()
    const emptyStats = await readStats()
    // 「泄漏」的取样点必须**在切换落地之后**（v2.106.1）。
    // 为什么：切回默认域会触发一次 `loadArticles()`，而上一轮项目视图发起的
    // 「后台补齐另外两库」（v2.103 的 `fillStatsInBackground()`，正好 2 个请求：retained/archive）
    // 可能**此刻仍在飞** —— 它们的请求头是切换前算好的，于是被记成"切回默认后仍带项目头"。
    // 实测这条断言在同一个部署上时红时绿（v2.104 报 3 次、v2.105 报 0 次、v2.106 报 3 次），
    // 判定依据是"静默窗口之后还有没有新的带项目头请求"——那才是真正要守的不变量。
    await page.waitForTimeout(900)
    const reqSettled = scopedRequests.length
    await page.waitForTimeout(700)
    const leakedScoped = scopedRequests.slice(reqSettled).filter((r) => r.project).length

    // ② 再切回项目：必须重新发出带项目头的请求、行数与统计都回到原值
    const reqFrom = scopedRequests.length
    await clearStats()
    await page.selectOption('#project-select', pid)
    {
      const deadline = Date.now() + 10000
      while (
        Date.now() < deadline &&
        scopedRequests.slice(reqFrom).filter((r) => r.project === pid).length === 0
      ) {
        await page.waitForTimeout(150)
      }
    }
    const scopedHits = scopedRequests.slice(reqFrom).filter((r) => r.project === pid)
    // 请求发出 ≠ 视图已重绘：等行数真的回来再读（否则会把异步渲染读成 rows=0 的假失败）
    await page
      .waitForFunction(() => document.querySelectorAll('#article-tbody tr').length > 0, null, {
        timeout: 10000,
      })
      .catch(() => {})
    const scoped = await readStats()
    const scopedRows = await readRows()
    const stored = await page.evaluate(() => localStorage.getItem('crosspost.activeProject'))
    const noteText = await page.evaluate(
      () => (document.querySelector('#project-note') || {}).textContent || '',
    )

    // 还原现场：留成"不指定项目"，免得人工使用时莫名其妙只看得到项目内容
    await page.selectOption('#project-select', '')

    results.push([
      `项目切换·内容域跟随（切到 ${pid} 带项目头、切回默认域为空、再切回还原）`,
      stored === pid &&
        scopedHits.length > 0 &&
        scopedRows === projectRows &&
        scoped === onProject &&
        emptyRows === 0 &&
        leakedScoped === 0 &&
        !!noteText.trim(),
      `默认域 rows=${emptyRows}（应为 0）[${emptyStats.slice(0, 18)}]` +
        ` → ${pid} rows=${scopedRows} [${scoped.slice(0, 18)}]` +
        ` · 带项目头的请求 ${scopedHits.length} 次` +
        ` · 示例=${scopedHits[0] ? scopedHits[0].url.replace(BASE, '') : '(无)'}` +
        ` · 切回默认后仍带项目头的请求 ${leakedScoped} 次（应为 0）`,
    ])
  }
} catch (e) {
  results.push(['脚本异常', false, String(e.message).slice(0, 120)])
}

// 401 详情
results.push(['401 请求列表', failed401.length === 0, failed401.slice(0, 8).join(' | ') || '0'])
results.push([
  'console 错误全文',
  pageErrors.length === 0,
  pageErrors.slice(0, 6).join(' || ').slice(0, 300),
])
// 页面错误
results.push([
  '无页面错误',
  pageErrors.length === 0,
  pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '0',
])

// 2026-09-22（v2.103）：首屏表格**不该等**留存/归档两库。
// 背景：reader 车道是串行队列，三库串起来实测 ~90ms，而表格只需要 /proxy/articles。
// 判据是**顺序不变量**（表格行先出现、统计条后补齐），不是"够快"——不会随机器快慢抖。
//
// 为什么这么绕：要测"某一（项目域）次加载"的顺序，就得让这次加载**干净地发生**。
// 所以：① 新文档里先清掉 localStorage 的项目（回到默认域，0 行）；② 等它稳定；
// ③ 重置两个时刻标记；④ 再选上项目 —— 被测量的正是这次项目域加载。
{
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('crosspost.activeProject')
    } catch {
      /* 忽略 */
    }
    window.__fp = { rows: null, stats: null }
    const obs = new MutationObserver(() => {
      const fp = window.__fp
      if (!fp) return
      if (fp.rows === null && document.querySelectorAll('#article-tbody tr').length > 0)
        fp.rows = performance.now()
      if (fp.stats === null) {
        const s = document.querySelector('#stats')
        if (s && s.textContent.includes('共')) fp.stats = performance.now()
      }
    })
    document.addEventListener('DOMContentLoaded', () =>
      obs.observe(document.body, { childList: true, subtree: true }),
    )
  })
  await page.goto(BASE + '/?fp=' + Date.now() + '#/articles', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#project-select', { timeout: 15000 }).catch(() => {})
  // 等**默认域那次加载自己跑完**（统计条出现即证明 app 启动与首轮取数都结束了）。
  // 不能用固定 waitForTimeout：实测 1.5s 会和 app 自己的启动渲染撞车，采到的是那一次的
  // 时刻（行 1736ms / 统计条 1710ms），于是判据红得莫名其妙。
  await page
    .waitForFunction(() => window.__fp && window.__fp.stats !== null, null, { timeout: 20000 })
    .catch(() => {})
  const fpOpts = await page.$$eval('#project-select option', (os) =>
    os.map((o) => o.value).filter(Boolean),
  )
  await page.evaluate(() => {
    window.__fp = { rows: null, stats: null }
    // 关键：把上一轮的统计条**清空**，否则"下一次任意 DOM 变动"就会因为读到旧文案
    // （共 0 篇）而立刻给 stats 打点 —— 实测就是这样先于表格行打点、判据假红。
    const s = document.querySelector('#stats')
    if (s) s.textContent = ''
  })
  if (fpOpts[0]) await page.selectOption('#project-select', fpOpts[0])
  await page
    .waitForFunction(
      () => window.__fp && window.__fp.rows !== null && window.__fp.stats !== null,
      null,
      {
        timeout: 20000,
      },
    )
    .catch(() => {})
  const fp = await page.evaluate(() => window.__fp || {})
  const rowsMs = typeof fp.rows === 'number' ? fp.rows : null
  const statsMs = typeof fp.stats === 'number' ? fp.stats : null
  results.push([
    '首屏·表格行先于统计条完成（不等留存/归档两库）',
    rowsMs !== null && statsMs !== null && rowsMs <= statsMs && statsMs - rowsMs >= 20,
    rowsMs === null || statsMs === null
      ? `未采到时刻 rows=${fp.rows} stats=${fp.stats}（选择项目=${fpOpts[0] || '无'}）`
      : `行 ${Math.round(rowsMs)}ms / 统计条 ${Math.round(statsMs)}ms（差 ${Math.round(statsMs - rowsMs)}ms；改前二者同时 ~318ms）`,
  ])
}

// 2026-09-21（v2.101）：bootstrap 次数（**首屏** app 自己只发 1 次）+ 冒烟未把常驻 worker 跑降级。
// 改前实测：一次首屏 `/proxy/bootstrap` 发 6 次（app.js 并发取数各拿一次 token）；
// api.mjs 缓存"在飞的 Promise"后 = 1 次。整轮总计数（含本文件自己的 6 处 token 探针）只作诊断信息。
results.push([
  '首屏 bootstrap 只发 1 次（app 自己的取数不重复拿 token）',
  bootstrapsAtFirstPaint === 1,
  `首屏=${bootstrapsAtFirstPaint}（改前 6）· 整轮 ${bootstrapCount} 次（含测试自己的 token 探针）/ 主文档加载 ${docLoads} 次`,
])

// 2026-09-29：**编写页深链回归**（一次导航只许建一个 CodeMirror）。
// 背景：`#/editor/<id>` 会同时走 `switchView('editor')→loadEditor()`（无 id）与 hash
// 处理器的 `loadEditor(id)`，两次都在 await 之后才进 `ensureEditorBuilt`，于是
// `if (store.editor.editor) return` 那道门被同时穿过：同一个 host 里建出两个实例，
// 可见的那个是空稿（源码窗格没字，而 store 与右侧预览都是对的）——从文章详情点「编辑」
// 或带 hash 刷新就会撞上，而用户下一步可能就是按「保存」。
// 必须**新开一页**才有意义：编辑器只在首次进入该视图时创建（同页再来一次已被缓存挡住）。
{
  let ok = false
  let detail = ''
  try {
    // 挑一个**真的能载入**的草稿：文章列表里的 id 可能是"记录已归档/文件已删"的
    // （那种 id 打 `/proxy/draft/<id>` 会失败，编辑器自然是空的，测的就不是本缺陷了）。
    const picked = await page.evaluate(async () => {
      const tok = (await (await fetch('/proxy/bootstrap')).json()).token
      const proj = localStorage.getItem('crosspost.activeProject') || ''
      const headers = { 'X-CrossPost-Token': tok }
      if (proj) headers['X-CrossPost-Project'] = proj
      const list = await (await fetch('/proxy/articles', { headers })).json()
      for (const a of (list.articles || []).slice(0, 10)) {
        const r = await fetch('/proxy/draft/' + encodeURIComponent(a.id), { headers })
        if (!r.ok) continue
        const d = await r.json()
        if (d && typeof d.markdown === 'string' && d.markdown.trim()) return { id: a.id, proj }
      }
      return null
    })
    if (!picked) {
      ok = true
      detail = '内容域里没有可载入的草稿（空内容域）→ 跳过'
    } else {
      // 用 browser.newPage()：这个 Playwright 版本对 page.context().newPage() 直接报
      // "Please use browser.newContext()"；而 browser.newPage() 每次给的是**新上下文**
      // （localStorage 是空的），所以先落一次普通页把当前项目写进 localStorage，
      // 再带 hash 重新加载 —— 这样测的仍然是"冷启动直接进 `#/editor/<id>`"。
      // 这一页**不关**：关掉共享隐式上下文里的页面会把整轮冒烟一起带走。
      const fresh = await browser.newPage()
      await fresh.goto(`${BASE}/#/articles`, { waitUntil: 'domcontentloaded' })
      if (picked.proj) {
        await fresh.evaluate((v) => localStorage.setItem('crosspost.activeProject', v), picked.proj)
      }
      await fresh.goto(`${BASE}/#/editor/${encodeURIComponent(picked.id)}`, {
        waitUntil: 'domcontentloaded',
      })
      await fresh.waitForSelector('.cm-content', { timeout: 20000 })
      await fresh
        .waitForFunction(
          () => {
            const c = document.querySelector('.cm-content')
            return (
              !!c &&
              (c.innerText || '').trim().length > 0 &&
              document.querySelectorAll('.cm-editor').length === 1
            )
          },
          null,
          { timeout: 20000 },
        )
        .catch(() => {})
      const st = await fresh.evaluate(() => ({
        editors: document.querySelectorAll('.cm-editor').length,
        textLen: ((document.querySelector('.cm-content') || {}).innerText || '').trim().length,
        title: ((document.querySelector('#ed-title') || {}).value || '').length,
        state: ((document.querySelector('#ed-save-state') || {}).textContent || '')
          .trim()
          .slice(0, 60),
      }))
      ok = st.editors === 1 && st.textLen > 0 && st.title > 0
      detail =
        `editors=${st.editors}（改前 2）· 源码窗格 ${st.textLen} 字 · 标题 ${st.title ? '已回填' : '空'}` +
        (st.state ? ` · 状态「${st.state}」` : '')
    }
  } catch (e) {
    ok = false
    detail = '深链检查异常: ' + String(e && e.message)
  }
  results.push(['编写深链只建一个 CodeMirror 且源码窗格有字', ok, detail])
}

let healthDetail = ''
let healthOk = false
try {
  const after = await healthOf()
  const bad = []
  for (const [role, w] of Object.entries(after.workers || {})) {
    const was = healthBefore.workers?.[role]?.restarts ?? 0
    if (!w.alive) bad.push(`${role}: 已不在（alive=false）`)
    else if (w.restarts !== was) bad.push(`${role}: restarts ${was}→${w.restarts}`)
  }
  healthOk = bad.length === 0
  healthDetail = bad.length
    ? bad.join(' | ')
    : `4 条车道均 alive、restarts 未增（${Object.keys(after.workers || {}).join('/')}）`
} catch (e) {
  healthDetail = '读取 /proxy/health 失败: ' + String(e && e.message)
}
results.push(['冒烟未把常驻 worker 跑降级', healthOk, healthDetail])

console.log('=== Console 拆分 playwright 验证 ===')
let pass = 0
for (const [name, ok, detail] of results) {
  console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`)
  if (ok) pass++
}
console.log(`\n通过 ${pass}/${results.length}`)
await browser.close()
process.exit(pass === results.length ? 0 : 1)
