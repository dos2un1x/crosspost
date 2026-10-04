/**
 * v2.03 前端冒烟：接入与自检视图 + 平台能力矩阵 + 项目切换器骨架。
 *
 * 运行（需沙箱桥在 19539/19540）：
 *   node crosspost-runtime/tests/console-onboarding-smoke.mjs
 *   CONSOLE_TEST_PORT=19540 node crosspost-runtime/tests/console-onboarding-smoke.mjs
 *
 * 断言：
 *   1) #/onboarding 视图可切换、无 JS 报错
 *   2) 四步排查项渲染出来（接线台结构 + 状态与 /proxy/status 一致）
 *   3) 平台能力矩阵从 /proxy/platform-matrix 渲染（芯片数 = counts.all）
 *   4) 项目切换器与注册表状态一致（零项目→禁用；有项目→可用且列出）
 *   5) 既有视图（#/articles）不因新代码报错（回归）
 *   6) v2.90：「⟳ 重新检查」有看得见的反馈（忙碌态 + 回执 + 单飞）
 */
// v2.3.1：playwright 由 crosspost-runtime 那棵树提供（core 不再单独装依赖树），走包名解析
import { chromium } from 'playwright'

const PORT = Number(process.env.CONSOLE_TEST_PORT || 19540)
const BASE = `http://127.0.0.1:${PORT}`
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
/** 旧桥没有 /proxy/doctor 时为 true（见 4c）：只在这种情况豁免该 404 */
let doctorRouteMissing = false
/** 2f 刻意 abort 掉四个 /proxy 请求（模拟桥挂掉）时，落在 [from,to) 的
 *  `net::ERR_FAILED` 记录是**预期内**的：Chrome 为它们记的文案通用、不含 URL，
 *  只能按"错误序号窗口"豁免。窗口外真出错仍会被判负。 */
let probeAbortWindow = { from: 0, to: 0 }
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text())
})

try {
  await page.goto(`${BASE}/#/onboarding`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  // 1) 视图激活
  const active = await page.$eval('#view-onboarding', (n) => n.classList.contains('active'))
  check('onboarding 视图激活', active)

  // 1b) v2.101.1：常驻 worker 车道卡 —— 把"网页为什么变慢"摆到界面上。
  //     背景：v2.100（worker 被杀成永久冷启动）与 v2.101（费用解析堵住读队列 2340ms）
  //     两次事故，界面上**没有任何地方**看得出来，只能靠人肉推理。
  const lanes = await page.$$eval('#onboarding-workers .ob-doctor-row', (rows) =>
    rows.map((r) => ({
      role: (r.querySelector('.ob-doctor-title') || {}).textContent || '',
      detail: (r.querySelector('.ob-doctor-detail') || {}).textContent || '',
      hot: /热/.test((r.querySelector('.badge') || {}).textContent || ''),
    })),
  )
  const roleNames = lanes
    .map((l) => l.role)
    .sort()
    .join(',')
  check(
    'worker 车道·四条车道都渲染',
    roleNames === 'costs,heavy,reader,writer',
    `roles=${roleNames || '(空)'}`,
  )
  check(
    'worker 车道·每条都给出 pid/输出/重启数与状态徽标',
    lanes.length === 4 &&
      lanes.every((l) => /pid \d+/.test(l.detail) && /重启 \d+ 次/.test(l.detail)),
    lanes
      .map((l) => `${l.role}:${l.detail.slice(0, 40)}`)
      .join(' | ')
      .slice(0, 180),
  )
  let laneBadgeOk = false
  let laneBadgeDetail = ''
  try {
    // /proxy/health 要 token（与 Console 一样先走 /proxy/bootstrap 拿）
    const { token } = await (await fetch(`${BASE}/proxy/bootstrap`)).json()
    const h = await (
      await fetch(`${BASE}/proxy/health`, { headers: { 'X-CrossPost-Token': token } })
    ).json()
    const want = Object.keys(h.workers || {})
    const hotWant = want.filter((r) => h.workers[r].alive && !h.workers[r].coolingDown)
    laneBadgeOk =
      lanes.length === want.length && lanes.filter((l) => l.hot).length === hotWant.length
    laneBadgeDetail = `渲染 ${lanes.length} 行 / 热 ${lanes.filter((l) => l.hot).length} 条（health 报热 ${hotWant.length}）`
  } catch (e) {
    laneBadgeDetail = '读 /proxy/health 失败: ' + String(e && e.message)
  }
  check('worker 车道·徽标与 /proxy/health 的真实 aliveness 一致', laneBadgeOk, laneBadgeDetail)

  // 2) 四步排查项
  const steps = await page.$$eval('#onboarding-steps .ob-step', (ns) => ns.length)
  check('四步排查项渲染', steps === 4, `step count=${steps}`)

  // 2b) 接线台结构（v2.88）：四步 = rail 圆点 + 状态徽章，且顶部进度段与步骤状态一一对应。
  //
  // 为什么要钉住：v2.88 把"四个整块底色的盒子"改成"一条 rail + 徽章 + 读数条"，
  // 这里同时钉住**结构与状态一致性**——扩展开关时第 2 步必须是 fail，连接时必须是 ok；
  // 进度段的段序必须等于步骤状态序。否则"上面亮绿灯、下面写未连接"这类不一致没人发现。
  // 依赖扩展连接态的地方一律条件断言（连接态是现场可变的）。
  const liveStatus = await page.evaluate(async () => {
    const { token } = await (await fetch('/proxy/bootstrap')).json()
    const r = await fetch('/proxy/status', { headers: { 'X-CrossPost-Token': token } })
    return r.json()
  })
  const connected = !!(liveStatus && liveStatus.connected)
  const rail = await page.evaluate(() => {
    const steps = [...document.querySelectorAll('#onboarding-steps .ob-step')]
    const stateOf = (el) =>
      ['ok', 'warn', 'fail', 'unknown'].find((s) => el.classList.contains('ob-' + s)) || ''
    const segs = [...document.querySelectorAll('#onboarding-progress .ob-seg')]
    return {
      states: steps.map(stateOf),
      dots: steps.filter((s) => s.querySelector('.ob-dot')).length,
      badges: steps.map((s) => ((s.querySelector('.ob-status') || {}).textContent || '').trim()),
      segStates: segs.map((s) => s.dataset.state),
      segCount: segs.length,
    }
  })
  check(
    '接线台·四步 rail 圆点 + 状态徽章（第 2 步状态与 /proxy/status 一致）',
    rail.dots === 4 &&
      rail.badges.length === 4 &&
      rail.badges.every((b) => b) &&
      rail.states[1] === (connected ? 'ok' : 'fail'),
    `dots=${rail.dots} states=${rail.states.join(',')} badges=${rail.badges.join('|')} connected=${connected}`,
  )
  check(
    '接线台·顶部进度段序 = 四步状态序',
    rail.segCount === 4 && rail.segStates.join(',') === rail.states.join(','),
    `segs=${rail.segStates.join(',')} steps=${rail.states.join(',')}`,
  )

  // 2c) 版面（v2.88）：按钮不折行 + 报告宽度收口 + 无横向溢出。
  //     旧版「⟳ 重新检查」被 flex 挤压成 89×52 的两行按钮（与顶栏刷新同一类缺陷）。
  const layout = await page.evaluate(() => {
    const btn = document.querySelector('#btnOnboardingRefresh')
    const view = document.querySelector('#view-onboarding')
    const wrap = document.querySelector('.ob-wrap')
    const vcs = getComputedStyle(view)
    const contentRight = view.getBoundingClientRect().right - parseFloat(vcs.paddingRight)
    return {
      btnH: Math.round(btn.getBoundingClientRect().height),
      btnWrapped: btn.scrollHeight > btn.clientHeight + 2,
      wrapW: Math.round(wrap.getBoundingClientRect().width),
      deadSpace: Math.round(contentRight - wrap.getBoundingClientRect().right),
      cols: getComputedStyle(wrap).gridTemplateColumns.split(' ').length,
      hOver: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    }
  })
  // v2.89：判据由"宽度 ≤1120"改成"**铺满内容区**"。
  // 为什么翻过来：v2.88 的 1120 上限让 1426px 窗口右侧空 258px，使用者直接反馈
  // "宽度不够、没填满整个页面"——当时的断言恰恰把那个上限**钉死**了。
  // 现在断言"右边缘与内容区右边缘对齐（死白 ≤2px）"且 ≥1200px 时两栏生效。
  check(
    '接线台·铺满内容区（无右侧死白）+ 两栏生效 + 按钮不折行 + 无横向溢出',
    layout.btnH <= 40 &&
      !layout.btnWrapped &&
      Math.abs(layout.deadSpace) <= 2 &&
      layout.cols >= 2 &&
      !layout.hOver,
    JSON.stringify(layout),
  )

  // 2d) 「⟳ 重新检查」的反馈（v2.90）
  //
  // 背景（Playwright 实测）：点击**确实**在执行 —— 当场发出 4 个请求
  // （status 5ms / platform-matrix 2ms / projects 3ms / doctor **287–650ms**），
  // 但旧实现不置灰、不改文案、不加类，且重渲染结果与上一次逐字节相同 →
  // 使用者反馈"点击这个按钮没有任何反应"。
  // 这里把"看得见的执行"钉成三条：点击瞬间的忙碌态、完成后的回执（时间/耗时）、
  // 四项数据源确实被重新拉取。为了让忙碌态**可观测**，探针把 /proxy/doctor
  // 拖慢 900ms（真实响应照常透传，只加延迟）——否则 doctor 只要 3ms 时，
  // 忙碌窗口会短到采样不到，测试就变成"赌机器快慢"。
  {
    // v2.101.1：新增第 5 个数据源 /proxy/health（常驻 worker 车道），计数与断言一并跟上
    const SOURCES_RE = /^\/proxy\/(status|platform-matrix|projects|doctor|health)$/
    let reqs = 0
    const onReq = (r) => {
      try {
        if (SOURCES_RE.test(new URL(r.url()).pathname)) reqs++
      } catch {
        /* 非 http(s) 请求：忽略 */
      }
    }
    page.on('request', onReq)
    const slowDoctor = async (route) => {
      await new Promise((r) => setTimeout(r, 900))
      await route.continue()
    }
    const notBusy = () => {
      const f = document.querySelector('#onboarding-checked')
      return !!f && f.dataset.kind && f.dataset.kind !== 'busy'
    }
    await page.route('**/proxy/doctor', slowDoctor)

    const reqBefore = reqs
    await page.click('#btnOnboardingRefresh')
    await page.waitForTimeout(250)
    const busy = await page.evaluate(() => {
      const btn = document.querySelector('#btnOnboardingRefresh')
      const bar = document.querySelector('#onboarding-loadbar')
      const fresh = document.querySelector('#onboarding-checked')
      const glyph = btn.querySelector('.ob-glyph')
      return {
        disabled: btn.disabled,
        ariaBusy: btn.getAttribute('aria-busy'),
        label: (btn.querySelector('.ob-btn-label') || {}).textContent || '',
        spin: glyph ? getComputedStyle(glyph).animationName : '(无图标)',
        barVisible: !!bar && !bar.hidden && bar.getBoundingClientRect().height > 0,
        checking: document.querySelector('#view-onboarding').classList.contains('is-checking'),
        kind: fresh ? fresh.dataset.kind : '',
      }
    })
    check(
      '重新检查·点击即进入忙碌态（禁用 + ⟳ 自转 + 文案「检查中…」+ 走马灯 + 报告变浅）',
      busy.disabled &&
        busy.ariaBusy === 'true' &&
        busy.label === '检查中…' &&
        busy.spin === 'ob-spin' &&
        busy.barVisible &&
        busy.checking &&
        busy.kind === 'busy',
      JSON.stringify(busy),
    )

    await page.waitForFunction(notBusy, null, { timeout: 20000 })
    const done = await page.evaluate(() => {
      const btn = document.querySelector('#btnOnboardingRefresh')
      const bar = document.querySelector('#onboarding-loadbar')
      const fresh = document.querySelector('#onboarding-checked')
      return {
        text: (fresh.textContent || '').trim(),
        kind: fresh.dataset.kind,
        disabled: btn.disabled,
        ariaBusy: btn.getAttribute('aria-busy'),
        label: (btn.querySelector('.ob-btn-label') || {}).textContent || '',
        barHidden: !!bar && bar.hidden,
        checking: document.querySelector('#view-onboarding').classList.contains('is-checking'),
      }
    })
    const fired = reqs - reqBefore
    check(
      '重新检查·回执含时间/耗时，四项数据源均重新拉取，忙碌态已复原',
      fired === 5 &&
        /已(重新)?检查/.test(done.text) &&
        /\d{2}:\d{2}:\d{2}/.test(done.text) &&
        /用时 \d/.test(done.text) &&
        ['ok', 'changed', 'warn'].includes(done.kind) &&
        done.disabled === false &&
        done.ariaBusy === null &&
        done.label === '重新检查' &&
        done.barHidden === true &&
        !done.checking,
      JSON.stringify({ fired, ...done }),
    )

    // 2e) 单飞：忙碌期间的重复触发不叠加请求。
    //     为什么不靠"再点一次按钮"：忙碌时按钮是 disabled 的，DOM click 不会派发事件，
    //     那样测到的是"按钮禁用"而不是"单飞"。这里连点两次（第二次落在 disable 之后），
    //     再断言请求数仍恰好是 4 —— 若将来有人去掉 disabled 又没做单飞，这条会红。
    const reqBefore2 = reqs
    await page.evaluate(() => {
      const btn = document.querySelector('#btnOnboardingRefresh')
      btn.click()
      btn.click()
    })
    await page.waitForTimeout(250)
    const busy2 = await page.evaluate(() => ({
      disabled: document.querySelector('#btnOnboardingRefresh').disabled,
      label: (document.querySelector('#btnOnboardingRefresh .ob-btn-label') || {}).textContent,
    }))
    await page.waitForFunction(notBusy, null, { timeout: 20000 })
    const fired2 = reqs - reqBefore2
    check(
      '重新检查·单飞（连点两次只发一组请求，不叠加）',
      busy2.disabled === true && busy2.label === '检查中…' && fired2 === 5,
      JSON.stringify({ fired2, ...busy2 }),
    )

    // 2f) 桥整体不可达时：**不擦掉上次结果**，只把失败写进回执。
    //     旧实现把请求的错误各自吞掉后照常重绘，于是拿不到数据时页面被擦成
    //     "平台能力矩阵不可用 / 四步全红"——越点越空，且看起来像按钮把页面搞坏了。
    {
      const chipsBefore = await page.$$eval('#onboarding-matrix .ob-chip', (n) => n.length)
      probeAbortWindow = { from: errors.length, to: 0 }
      for (const p of ['status', 'platform-matrix', 'projects', 'doctor', 'health'])
        await page.route(`**/proxy/${p}`, (r) => r.abort())
      await page.click('#btnOnboardingRefresh')
      await page.waitForFunction(
        () => document.querySelector('#onboarding-checked')?.dataset.kind === 'fail',
        null,
        { timeout: 20000 },
      )
      // 2026-09-21（v2.101.1）：数据源从 4 增到 5 后，最后一条 `net::ERR_FAILED` 的 console
      // 记录可能晚于回执状态落地 —— 直接取 errors.length 当窗口右界会漏掉它（实测报"无 JS 运行错误"）。
      // 这里**先等这几条异步记录落账**再定右界，并顺手钉住"窗口内恰好 5 条 ERR_FAILED"，
      // 免得多等出来的时间把**别处**的真错误也圈进豁免区。
      await page.waitForTimeout(400)
      probeAbortWindow.to = errors.length
      const abortedInWindow = errors
        .slice(probeAbortWindow.from, probeAbortWindow.to)
        .filter((e) => /net::ERR_FAILED/.test(e)).length
      check(
        '桥不可达探针·预期内的 5 条 ERR_FAILED 全部落在豁免窗口内',
        abortedInWindow === 5,
        `窗口内 ERR_FAILED = ${abortedInWindow}（预期 5）`,
      )
      const failState = await page.evaluate(() => ({
        text: (document.querySelector('#onboarding-checked').textContent || '').trim(),
        kind: document.querySelector('#onboarding-checked').dataset.kind,
        chips: document.querySelectorAll('#onboarding-matrix .ob-chip').length,
        steps: document.querySelectorAll('#onboarding-steps .ob-step').length,
        disabled: document.querySelector('#btnOnboardingRefresh').disabled,
        label: (document.querySelector('#btnOnboardingRefresh .ob-btn-label') || {}).textContent,
      }))
      check(
        '重新检查·桥不可达时只写失败回执、不擦掉上次结果',
        failState.kind === 'fail' &&
          /失败：5 个数据源都读不到/.test(failState.text) &&
          failState.chips === chipsBefore &&
          chipsBefore > 0 &&
          failState.steps === 4 &&
          failState.disabled === false &&
          failState.label === '重新检查',
        JSON.stringify({ chipsBefore, ...failState }),
      )
      // 恢复：撤掉拦截后再点一次，回执必须回到成功态（失败态不会粘住）
      // v2.101.1：unroute 列表必须与上面 abort 列表**逐字一致** —— 漏掉 health 时
      // 它会被一直 abort，后续每次"重新检查"都多出意外的 ERR_FAILED（实测多出 5 条）。
      for (const p of ['status', 'platform-matrix', 'projects', 'doctor', 'health'])
        await page.unroute(`**/proxy/${p}`)
      await page.click('#btnOnboardingRefresh')
      await page.waitForFunction(notBusy, null, { timeout: 20000 })
      const recovered = await page.$eval('#onboarding-checked', (n) => n.dataset.kind)
      check(
        '重新检查·拦截撤销后回执恢复成功态（失败态不粘住）',
        ['ok', 'changed', 'warn'].includes(recovered),
        `kind=${recovered}`,
      )
    }

    await page.unroute('**/proxy/doctor', slowDoctor)
    page.off('request', onReq)
  }

  // 3) 平台矩阵（芯片数应与 counts.all 一致）
  const matrix = await page.evaluate(async () => {
    const r = await fetch('/proxy/bootstrap')
    const { token } = await r.json()
    const resp = await fetch('/proxy/platform-matrix', { headers: { 'X-CrossPost-Token': token } })
    return resp.json()
  })
  const chips = await page.$$eval('#onboarding-matrix .ob-chip', (ns) => ns.length)
  check(
    '平台矩阵芯片数 = counts.all',
    chips === matrix.counts.all,
    `chips=${chips} all=${matrix.counts.all}`,
  )

  // 3b) 矩阵分节（v2.88）：27 片芯片此前一次铺开，读不出"哪些是默认派发的"。
  //     现在按 tier 分三节，每节自带计数；断言"每节芯片数 = 对应 counts 且 = 节标题数字"，
  //     这样将来若有人手写数字（而不是用 counts）会立刻红。
  const grouped = await page.evaluate(() =>
    [...document.querySelectorAll('#onboarding-matrix .ob-sec')].map((s) => ({
      title: ((s.querySelector('.ob-sec-title') || {}).textContent || '').trim(),
      n: Number(((s.querySelector('.ob-sec-n') || {}).textContent || '').trim()),
      chips: s.querySelectorAll('.ob-chip').length,
    })),
  )
  const expectGroups = [matrix.counts.enabled, matrix.counts['check-only'] || 0, matrix.counts.beta]
  check(
    '矩阵分节·三节芯片数与 counts 一致（默认派发/仅检查/beta）',
    grouped.length === 3 && grouped.every((g, i) => g.chips === expectGroups[i] && g.n === g.chips),
    `sections=${grouped.map((g) => `${g.title}:${g.chips}/${g.n}`).join(' · ')} expect=${expectGroups.join('/')}`,
  )

  // 4) 项目切换器（v2.31：改成**条件断言**）
  //
  // 原断言写死"未接入项目 → 禁用"，只在**恰好零项目接入**时成立。
  // 而 P1 的目标恰恰是"接入项目"——任何真接了一个项目的部署（哪怕只是
  // .local/projects 下的示例项目）都会让这条假失败。
  // 契约本身是有条件的，断言就该有条件：
  //   注册表 0 个有效项目 → 禁用，且文案说明"未接入"
  //   注册表 ≥1 个有效项目 → 可用，且选项数 ≥ 1 + 有效项目数
  const registry = await page.evaluate(async () => {
    const r = await fetch('/proxy/bootstrap')
    const { token } = await r.json()
    const resp = await fetch('/proxy/projects', { headers: { 'X-CrossPost-Token': token } })
    return resp.json()
  })
  const validProjects = (registry.projects || []).filter((p) => p.valid && p.id).length
  const ps = await page.$eval('#project-select', (n) => ({
    disabled: n.disabled,
    optionCount: n.options.length,
    first: n.options[0]?.textContent?.trim(),
  }))
  if (validProjects === 0) {
    check(
      '项目切换器·零项目时为禁用态（平台域仍可用）',
      ps.disabled && /未接入项目/.test(ps.first),
      JSON.stringify(ps),
    )
  } else {
    check(
      `项目切换器·已接入 ${validProjects} 个项目时可用且列出全部`,
      !ps.disabled && ps.optionCount >= validProjects + 1,
      JSON.stringify(ps),
    )
  }

  // 4b) 第 4 步（接入项目）的文案必须与注册表状态一致（v2.31）
  //     背景：P1 接线后这步要能告诉用户"切了项目，内容域就跟着变"，
  //     而不是永远写"未选择具体项目"。
  const step4 = await page.$eval('#onboarding-steps', (n) => {
    const step = [...n.querySelectorAll('.ob-step')].find((s) =>
      /接入项目/.test(s.textContent || ''),
    )
    return step ? step.textContent.replace(/\s+/g, ' ').trim() : null
  })
  check(
    '接入页第 4 步文案与注册表状态一致',
    !!step4 &&
      (validProjects === 0
        ? /尚未接入|未接入/.test(step4)
        : new RegExp(`已接入 ${validProjects} 个`).test(step4)),
    (step4 || '(未找到第 4 步)').slice(0, 120),
  )

  // 4c) 引擎自检块（v2.50）
  //
  // 为什么测两种状态：本页新增的 doctor 块要能**对旧桥优雅降级**——
  // 桥还没重启（没有 /proxy/doctor 路由）时整块隐藏、不报错；
  // 桥重启后展示，且非通过项条数必须与 /proxy/doctor 返回的一致。
  // 探针走 Node 侧（不经浏览器），避免在 console 里多留一条 404 ——
  // 这样"旧桥下预期内的 404"恰好只有**页面自己那一条**，豁免范围最小。
  const bootToken = await page.evaluate(
    async () => (await (await fetch('/proxy/bootstrap')).json()).token,
  )
  const docResp = await fetch(`${BASE}/proxy/doctor`, {
    headers: { 'X-CrossPost-Token': bootToken },
  })
  const docProbe = { status: docResp.status, body: docResp.ok ? await docResp.json() : null }
  const docCard = await page.evaluate(() => {
    const c = document.querySelector('#onboarding-doctor-card')
    return {
      exists: !!c,
      hidden: c ? c.hidden : null,
      rows: document.querySelectorAll('#onboarding-doctor .ob-doctor-row').length,
      summary:
        (document.querySelector('#onboarding-doctor .ob-doctor-summary') || {}).textContent || '',
    }
  })
  if (docProbe.status !== 200) {
    // 旧桥没有该路由 → 页面那次 fetch 必然是一条 404 console.error。
    // 这是**预期内**的降级路径，不该被"无 JS 运行错误"判负；而路由存在时**不豁免**，
    // 否则会把重启后真正的 404 掩盖掉。
    doctorRouteMissing = true
    check(
      '引擎自检块·旧桥下整块隐藏（优雅降级，不报错）',
      docCard.exists && docCard.hidden === true,
      JSON.stringify(docCard),
    )
  } else {
    const notOk = (docProbe.body.checks || []).filter(
      (c) => c.severity === 'fail' || c.severity === 'warn',
    ).length
    check(
      `引擎自检块·与 /proxy/doctor 一致（非通过 ${notOk} 项）`,
      docCard.hidden === false && docCard.rows === notOk && /共 \d+ 项/.test(docCard.summary),
      JSON.stringify({ ...docCard, expectRows: notOk }),
    )
  }

  // 4d) 项目域卡片（v2.83）
  //
  // 使用者反馈："接入与自检 也没有区分项目"。根因是本页只显示**引擎级**自检，
  // 而草稿/记录/项目级资源/设置覆盖都是项目级的。现在 doctor 在项目上下文里会返回
  // `project` 段，页面渲染成"当前项目"卡 —— 这里钉住它：未选项目时隐藏、选中后显示
  // 该项目自己的路径，且引擎自检卡在**项目作用域**下也要与 API 一致（含项目级检查）。
  {
    const projectIds = await page.$$eval('#project-select option', (os) =>
      os.map((o) => o.value).filter(Boolean),
    )
    const projectCardState = () =>
      page.evaluate(() => {
        const c = document.querySelector('#onboarding-project-card')
        return {
          exists: !!c,
          hidden: c ? c.hidden : null,
          text: c ? c.textContent.replace(/\s+/g, ' ').trim() : '',
          rows: document.querySelectorAll('#onboarding-project .ob-doctor-row').length,
        }
      })
    const before = await projectCardState()
    if (projectIds.length === 0) {
      check(
        '当前项目卡·未接入项目时隐藏',
        before.exists && before.hidden === true,
        JSON.stringify(before),
      )
    } else {
      const pid = projectIds[0]
      await page.selectOption('#project-select', pid)
      await page
        .waitForFunction(
          () => {
            const c = document.querySelector('#onboarding-project-card')
            return c && c.hidden === false
          },
          null,
          { timeout: 10000 },
        )
        .catch(() => {})
      const after = await projectCardState()
      const reg = await fetch(`${BASE}/proxy/projects`, {
        headers: { 'X-CrossPost-Token': bootToken },
      }).then((r) => r.json())
      const proj = ((reg && reg.projects) || []).find((x) => x.id === pid) || {}
      const dataDir = (proj.provider && proj.provider.dataDir) || ''
      check(
        '当前项目卡·未选项目时隐藏、选中后显示该项目自己的域',
        before.hidden === true &&
          after.hidden === false &&
          after.rows >= 5 &&
          after.text.includes(pid) &&
          (!dataDir || after.text.includes(dataDir)),
        JSON.stringify({
          beforeHidden: before.hidden,
          afterRows: after.rows,
          hasPid: after.text.includes(pid),
          hasDataDir: !!dataDir && after.text.includes(dataDir),
        }),
      )

      // 4d-2) 定义列表布局（v2.88）：同一批 `.ob-doctor-row` 渲染成"标签列 + mono 路径"，
      //       不再套 7 个盒子。行的**数量**契约不变（上面那条仍按 .ob-doctor-row 计数）。
      const kv = await page.evaluate(() => {
        const row = document.querySelector('#onboarding-project .ob-doctor-row')
        if (!row) return { display: 'none', cols: '' }
        const cs = getComputedStyle(row)
        return { display: cs.display, cols: cs.gridTemplateColumns }
      })
      check(
        '当前项目卡·定义列表布局（两列：标签 + 等宽路径）',
        kv.display === 'grid' && kv.cols.split(' ').length === 2,
        JSON.stringify(kv),
      )

      // 项目作用域下的引擎自检卡（页面带项目头）必须与同作用域的 API 一致
      const docP = await fetch(`${BASE}/proxy/doctor`, {
        headers: { 'X-CrossPost-Token': bootToken, 'X-CrossPost-Project': pid },
      }).then((r) => r.json())
      const notOkP = (docP.checks || []).filter(
        (c) => c.severity === 'fail' || c.severity === 'warn',
      ).length
      const cardP = await page.evaluate(() => {
        const box = document.querySelector('#onboarding-doctor')
        return {
          rows: document.querySelectorAll('#onboarding-doctor .ob-doctor-row').length,
          summary: ((box || {}).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        }
      })
      check(
        `引擎自检卡·项目作用域一致（项目级检查 ${(docP.checks || []).filter((c) => String(c.id).startsWith('project:')).length} 项）`,
        !!docP.project &&
          docP.project.id === pid &&
          cardP.rows === notOkP &&
          /共 \d+ 项/.test(cardP.summary),
        JSON.stringify({
          apiProject: docP.project && docP.project.id,
          apiNotOk: notOkP,
          pageRows: cardP.rows,
          summary: cardP.summary,
        }),
      )

      // 还原现场：切回"不指定项目"
      await page.selectOption('#project-select', '')
      await page.waitForTimeout(500)
    }
  }

  // 5) 回归：切到 articles 视图不应报错
  await page.evaluate(() => {
    location.hash = '#/articles'
  })
  await page.waitForTimeout(1500)
  const articlesActive = await page.$eval('#view-articles', (n) => n.classList.contains('active'))
  check('articles 视图仍可切换（回归）', articlesActive)

  // 6) 深色主题（v2.88）：新样式若写死了浅色，这里会红。
  //
  // 判据两条，都是"能证伪"的：
  //   · 步骤行背景不得是浅色 tint（旧版整块 `--ok-bg` 是 #e2efe6 这种浅色，
  //     深色主题下若残留会非常刺眼）
  //   · 第 1 步圆点（永远是 ok 态）的前景色必须等于**深色** `--ok` = #6fbf8a，
  //     而不是浅色 `--ok` = #2e7d4f —— 直接钉住"用了主题变量而不是硬编码"
  {
    const dark = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await dark.addInitScript(() => {
      try {
        localStorage.setItem('console-theme', 'dark')
      } catch {
        /* 隐私模式：忽略 */
      }
    })
    await dark.goto(`${BASE}/#/onboarding`, { waitUntil: 'domcontentloaded' })
    await dark.waitForTimeout(2500)
    const d = await dark.evaluate(() => {
      const step = document.querySelector('#onboarding-steps .ob-step')
      const dot = step && step.querySelector('.ob-dot')
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        stepBg: step ? getComputedStyle(step).backgroundColor : '',
        dotColor: dot ? getComputedStyle(dot).color : '',
      }
    })
    const lightTint = /rgba?\((2[0-9]{2}), (2[0-9]{2}), (2[0-9]{2})/.test(d.stepBg)
    check(
      '深色主题·步骤行不残留浅色 tint、状态圆点用深色 --ok',
      d.theme === 'dark' && !lightTint && d.dotColor === 'rgb(111, 191, 138)',
      JSON.stringify(d),
    )
    await dark.close()
  }

  await page.screenshot({ path: '/tmp/console-onboarding.png', fullPage: false })
  console.log('截图: /tmp/console-onboarding.png')
} finally {
  await browser.close()
}

// 归因：ignore 掉与本次改动无关的既有接口报错（沙箱无扩展/无文章库）
const real = errors.filter(
  (e, i) =>
    !/proxy\/(platforms|articles|topics|retained|archive|status|costs)/.test(e) &&
    // 旧桥没有 /proxy/doctor 时，页面那次 fetch 必然产生一条 404 console.error，
    // 且 Chrome 的文案是通用的 "Failed to load resource: ... 404"，**不含 URL**
    // （所以无法按路径匹配）。此处仅在"路由确实缺失"时豁免这一条宽泛文案——
    // 路由存在时不豁免，重启后真的 404 仍会被判负。
    // 权衡：这段窗口内若有**别的**资源 404 会被一并放过，故探针已改走 Node 侧，
    // 保证豁免范围内的记录只可能来自这一次预期内的降级。
    // 注意别写成 `^Failed...`：本文件的 console 处理器会加 `console.error: ` 前缀，
    // 锚定行首会静默失配（过滤器看着对、测试仍红）。
    !(doctorRouteMissing && /Failed to load resource/.test(e)) &&
    // 2f 刻意 abort 了四个 /proxy 请求（模拟桥整体挂掉），Chrome 会为每个各记一条
    // `net::ERR_FAILED`（同样不含 URL）。只豁免**落在该窗口序号区间内**的记录：
    // 窗口由 errors.length 划定，别处真出现 ERR_FAILED 仍会被判负。
    !(i >= probeAbortWindow.from && i < probeAbortWindow.to && /net::ERR_FAILED/.test(e)),
)
check('无 JS 运行错误', real.length === 0, real.slice(0, 3).join(' | '))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
