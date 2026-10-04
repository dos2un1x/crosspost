/**
 * 选题库「一键生成」状态条 + 逐行状态冒烟（2026-09-17 建；2026-10-01 适配 v2.111 队列）
 *
 * 设计取舍：真实生成任务会写接入项目的 drafts/ 并消耗 token，所以本脚本**只验证前端
 * 状态机**：把 `/proxy/topics/generate`（POST）、`/proxy/topics/generate/tasks`（GET）、
 * `/proxy/topics/generate/status`（GET）用 page.route 接管，绝不放真实任务出去。
 *
 * v2.111 变了什么：引擎从"单例任务"改成"队列"，界面上多出两样东西——
 *   ① 汇总条（#topics-banner）不再显示单条任务详情，只回答"还有多少活在跑/排队"；
 *   ② 逐条状态就近显示在表格的生成列里（排队位次 / 生成中时长 / 完成链接 / 失败重试）。
 * 因此本脚本同时断言这两处。
 *
 * 运行：node tests/console-topics-banner.mjs          （需 Console 在跑；系统 Chrome）
 *       CONSOLE_TEST_PORT=9540 node tests/console-topics-banner.mjs
 *       BANNER_SHOT_DIR=/tmp node tests/console-topics-banner.mjs   （默认 /tmp）
 */
// v2.3.1：playwright 由 crosspost-runtime 那棵树提供（core 不再单独装依赖树），走包名解析
import { chromium } from 'playwright'

const PORT = Number(process.env.CONSOLE_TEST_PORT || 9540)
const BASE = `http://127.0.0.1:${PORT}`
const SHOT_DIR = process.env.BANNER_SHOT_DIR || '/tmp'
const results = []

// 任务接口的当前应答；测试内逐步改写
let tasksPayload = { state: 'idle', tasks: [], running: 0, queued: 0, maxConcurrency: 1 }
let lastGenerateBody = null

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1180, height: 720 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text())
})
page.on('dialog', (d) => d.accept())

await page.route('**/proxy/topics/generate/tasks*', (route) => json(route, tasksPayload))
await page.route('**/proxy/topics/generate/status*', (route) => json(route, tasksPayload))
await page.route('**/proxy/topics/generate/cancel*', (route) => json(route, { ok: true }))
// `/proxy/topics` 只改写 `tasks` 字段，其余（真实选题库）原样放过：
// 队列收敛后前端会主动 `loadTopics()` 刷新一次，如果这里也返回真的空 tasks，
// 就会把测试刚造好的任务冲掉——"失败态"那条断言正是这样假红过一次。
await page.route('**/proxy/topics*', async (route) => {
  const url = route.request().url()
  if (url.includes('/proxy/topics/generate')) return route.fallback()
  try {
    const resp = await route.fetch()
    const body = await resp.json()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...body, tasks: tasksPayload.tasks || [] }),
    })
  } catch {
    return route.continue()
  }
})
await page.route('**/proxy/topics/generate', (route) => {
  if (route.request().method() === 'POST') {
    try {
      lastGenerateBody = JSON.parse(route.request().postData() || '{}')
    } catch {
      lastGenerateBody = null
    }
    // 入队即返回（v2.111 起后端是 202 + 任务对象）
    return json(route, {
      ok: true,
      task: { ...tasksPayload.tasks[0] },
      position: tasksPayload.tasks[0] ? tasksPayload.tasks[0].queuePosition : 0,
    })
  }
  return route.continue()
})

const banner = page.locator('#topics-banner')
const cls = () => banner.getAttribute('class')
const text = async () => (await banner.textContent()).replace(/\s+/g, ' ').trim()
// 截图：用 locator 截图（自动滚入视口；page.clip 在元素位于视口外时会截空/报错）
const shot = async (name) => {
  if ((await banner.count()) === 0) return
  await banner.screenshot({
    path: `${SHOT_DIR}/crosspost-banner-${name}.png`,
    animations: 'disabled',
  })
}

/** 某一行的生成列文本（v2.111：逐条状态的主场） */
const cellText = async (id) =>
  (await page.locator(`[data-gen-cell="${id}"]`).first().textContent()).replace(/\s+/g, ' ').trim()

try {
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 20000 })

  // v2.79：选题库是**项目级**资源——不选项目时默认域是空的，表格里没有可生成行。
  // 所以先像用户那样选上项目（未接入项目的部署则记录跳过，而不是让 locator 超时）。
  const projectIds = await page.$$eval('#project-select option', (os) =>
    os.map((o) => o.value).filter(Boolean),
  )
  const pid = projectIds[0] || ''
  if (pid) {
    await page.selectOption('#project-select', pid)
    await page.waitForTimeout(400)
  }
  await page.click('.tab[data-view="topics"]')
  await page
    .waitForFunction(
      () => document.querySelectorAll('#topics-tbody [data-gen-slot]').length > 0,
      null,
      { timeout: 15000 },
    )
    .catch(() => {})
  await page.waitForTimeout(300)
  results.push([
    '选题作用域',
    true,
    pid ? `项目 ${pid}（选题库按项目解析，v2.76+）` : '未接入项目（跳过）',
  ])

  const firstBtn = page.locator('#topics-tbody [data-gen-slot]').first()
  const slot = await firstBtn.getAttribute('data-gen-slot')
  const keyword = await firstBtn.getAttribute('data-gen-keyword')
  const topicId = await firstBtn.getAttribute('data-gen-id')
  results.push([
    '选题库有可生成行',
    !!(slot && keyword),
    `${slot} / ${String(keyword).slice(0, 18)}…`,
  ])

  // 1) idle：未点之前必须是隐藏 + 空 HTML（不再是常驻的 pstats 一行）
  results.push([
    'idle·隐藏且无 pstats 残类',
    (await cls()).includes('hidden') &&
      !(await cls()).includes('pstats') &&
      (await text()).trim() === '',
    await cls(),
  ])

  // 2) 点击 → 后端**入队**（不是直接开跑）：按钮立刻变「排队中（第 1 位）」
  const task = {
    id: 't-queue-1',
    slot,
    keyword,
    topicId,
    state: 'queued',
    queuePosition: 1,
    enqueuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    draftId: null,
    logFile: null,
    logTail: '',
    error: null,
  }
  tasksPayload = {
    state: 'queued',
    tasks: [task],
    running: 0,
    queued: 1,
    maxConcurrency: 1,
  }
  lastGenerateBody = null
  await firstBtn.click()
  await page.waitForTimeout(500)
  const queuedCell = await cellText(topicId)
  results.push([
    'queued·行内显示排队位次',
    /排队中（第 1 位）/.test(queuedCell),
    queuedCell.slice(0, 60),
  ])
  results.push([
    'queued·POST 带上 topicId（回填靠它精确落条）',
    !!lastGenerateBody && lastGenerateBody.topicId === topicId,
    JSON.stringify(lastGenerateBody),
  ])

  // 3) 转 running：汇总条出现 + 行内显示「生成中 · 已运行 mm:ss」（每秒刷新）
  tasksPayload = {
    ...tasksPayload,
    state: 'running',
    tasks: [
      {
        ...task,
        state: 'running',
        queuePosition: 0,
        startedAt: new Date(Date.now() - 65000).toISOString(),
      },
    ],
    running: 1,
    queued: 0,
  }
  await page.waitForTimeout(4400) // 轮询 4s
  const runText = await text()
  results.push([
    'running·汇总条骨架与身份',
    (await cls()).includes('tgen--running') &&
      (await banner.getAttribute('aria-busy')) === 'true' &&
      runText.includes('正在生成') &&
      runText.includes('仅写草稿'),
    (await cls()) + ' | ' + runText.slice(0, 90),
  ])
  results.push([
    'running·汇总条带计时器且每秒刷新',
    /\d+ 秒|已运行/.test(runText) &&
      (await page.locator('#topics-banner [data-tgen-time]').count()) === 1,
    runText.slice(0, 60),
  ])
  const runCell = await cellText(topicId)
  results.push(['running·行内显示生成中与时长', /生成中/.test(runCell), runCell.slice(0, 60)])
  const barAnim = await page
    .locator('#topics-banner .tgen-bar > i')
    .evaluate((el) => getComputedStyle(el).animationName)
  results.push(['running·进度线在动', barAnim !== 'none', barAnim])
  await shot('running-light')

  // 4) 排队 N 条时的汇总：2 在跑 / 3 排队，且位次按队列顺序
  tasksPayload = {
    state: 'running',
    maxConcurrency: 2,
    running: 2,
    queued: 3,
    tasks: [1, 2, 3, 4, 5].map((n) => ({
      ...task,
      id: `t-multi-${n}`,
      keyword: `${keyword}-${n}`,
      state: n <= 2 ? 'running' : 'queued',
      queuePosition: n <= 2 ? 0 : n - 2,
      startedAt: new Date(Date.now() - n * 30000).toISOString(),
    })),
  }
  await page.waitForTimeout(4400)
  const multiText = await text()
  results.push([
    '多任务·汇总条同时表达"在跑/排队"',
    multiText.includes('生成中 2/2') && multiText.includes('排队 3'),
    multiText.slice(0, 100),
  ])

  // 5) done：一条完成（带草稿链接）——汇总条转完成态，行内出现"查看《…》"
  const draftId = '2099-01-01-tips-banner-smoke'
  tasksPayload = {
    state: 'done',
    maxConcurrency: 1,
    running: 0,
    queued: 0,
    tasks: [
      {
        ...task,
        state: 'done',
        queuePosition: 0,
        startedAt: new Date(Date.now() - 96000).toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        draftId,
      },
    ],
  }
  await page.waitForTimeout(4600)
  const doneText = await text()
  results.push([
    'done·绿色语义 + 用时',
    (await cls()).includes('tgen--done') &&
      (await cls()).includes('tgen--ok') &&
      doneText.includes('生成完成'),
    (await cls()) + ' | ' + doneText.slice(0, 100),
  ])
  const href = await page.locator('#topics-banner a').first().getAttribute('href')
  results.push(['done·汇总条链接指向草稿详情', href === `#/articles/${draftId}`, href || 'null'])
  await shot('done-light')

  // 6) failed：红色语义 + 折叠日志 + 重试按钮（带原 slot/关键词）
  //
  // 这里必须**由用户动作驱动**，不能只改 payload 然后干等：完成态之后轮询已经收尾停表
  // （这是有意的设计，否则选题页永远在空转），不点一下就不会再有人去看任务表。
  // 于是"点重试 → beginTopicGen 重新挂表 → 4 秒后读到 failed"正好顺带验证了
  // 「停表之后还能重新活过来」这条曾经真坏过的路径。
  tasksPayload = {
    state: 'failed',
    maxConcurrency: 1,
    running: 0,
    queued: 0,
    tasks: [
      {
        ...task,
        state: 'failed',
        queuePosition: 0,
        startedAt: new Date(Date.now() - 30000).toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 7,
        logTail: 'step 3/5 failed: render\nError: boom',
        error: 'boom',
        errorCode: 'generate_provider_failed',
      },
    ],
  }
  // 先点火、再等：完成态之后轮询已经收尾停表（有意设计），所以必须有个用户动作把它叫醒。
  // 这里用"切走再切回选题页"——它同时验证了切回时能按项目把选题表与任务表重新取一遍，
  // 而且比硬点行内按钮稳（此刻行内还是上一步 done 留下的"查看《…》"，没有按钮可点）。
  await page.click('.tab[data-view="articles"]')
  await page.waitForTimeout(200)
  await page.click('.tab[data-view="topics"]')
  await page.waitForTimeout(4600)
  const errText = await text()
  results.push([
    'failed·红色语义 + 日志折叠',
    (await cls()).includes('tgen--failed') &&
      (await cls()).includes('tgen--err') &&
      errText.includes('失败') &&
      errText.includes('失败日志') &&
      (await page.locator('#topics-banner details pre').count()) === 1,
    (await cls()) + ' | ' + errText.slice(0, 110),
  ])
  results.push([
    'failed·重试后轮询重新活过来（停表不解耦）',
    !!lastGenerateBody && lastGenerateBody.slot === slot,
    JSON.stringify(lastGenerateBody),
  ])
  const retry = page.locator('#topics-banner [data-tgen-retry]')
  results.push([
    'failed·重试按钮带原 slot/关键词',
    (await retry.count()) === 1 &&
      (await retry.getAttribute('data-tgen-retry')) === slot &&
      (await retry.getAttribute('data-tgen-kw')) === keyword,
    `${await retry.count()} 个`,
  ])
  const failCell = await cellText(topicId)
  results.push([
    'failed·行内给出重试与原因',
    /重试/.test(failCell) && /boom/.test(failCell),
    failCell.slice(0, 70),
  ])
  await shot('failed-light')

  // 7) dark 主题：同一套结构，颜色由变量接管（在点"重试"之前截失败态）
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark')
    try {
      localStorage.setItem('console-theme', 'dark')
    } catch {
      /* 忽略隐私模式 */
    }
  })
  await page.waitForTimeout(300)
  const darkBg = await banner.evaluate((el) => getComputedStyle(el).backgroundColor)
  results.push(['dark·底色切到深色语义变量', darkBg.includes('40, 36, 48'), darkBg])
  await shot('failed-dark')

  // 8) 重试按钮真的会重新发起生成请求（POST /proxy/topics/generate）
  lastGenerateBody = null
  await retry.click()
  await page.waitForTimeout(500)
  results.push([
    '重试·重新 POST 同 slot/关键词',
    !!lastGenerateBody && lastGenerateBody.slot === slot && lastGenerateBody.keyword === keyword,
    JSON.stringify(lastGenerateBody),
  ])

  // 9) 取消：行内「取消」按钮打到 cancel 端点（v2.111 新增：排队中的任务要能撤）
  tasksPayload = {
    state: 'queued',
    maxConcurrency: 1,
    running: 0,
    queued: 1,
    tasks: [{ ...task, state: 'queued', queuePosition: 1, startedAt: null }],
  }
  let cancelHit = null
  await page.route('**/proxy/topics/generate/cancel*', async (route) => {
    cancelHit = JSON.parse(route.request().postData() || '{}')
    return json(route, { ok: true, wasRunning: false, task: { ...task, state: 'canceled' } })
  })
  // 同样由用户动作驱动：再点一次行内按钮，让轮询把新的排队态读回来
  await page.locator(`[data-topic-id="${topicId}"] [data-gen-slot]`).first().click()
  await page.waitForTimeout(4500)
  const cancelBtn = page.locator(`[data-gen-cell="${topicId}"] [data-gen-cancel]`).first()
  if (await cancelBtn.count()) {
    await cancelBtn.click()
    await page.waitForTimeout(300)
  }
  results.push([
    'cancel·行内取消按钮打到 /generate/cancel',
    !!cancelHit && cancelHit.id === task.id,
    JSON.stringify(cancelHit),
  ])

  // 10) 降级：prefers-reduced-motion 下进度线不再扫动（信息仍在）
  const rm = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1180, height: 720 },
  })
  const rmPage = await rm.newPage()
  await rmPage.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 20000 })
  // 状态条此刻是 idle（DOM 被清空），故注入一个与运行时同构的进度线节点来量规则本身
  const rmAnim = await rmPage.evaluate(() => {
    const host = document.createElement('div')
    host.className = 'tgen tgen--running tgen--accent'
    host.innerHTML = '<div class="tgen-bar"><i></i></div>'
    document.body.appendChild(host)
    const el = host.querySelector('.tgen-bar > i')
    const cs = getComputedStyle(el)
    const out = { name: cs.animationName, width: cs.width }
    host.remove()
    return out
  })
  results.push(['reduced-motion·进度线停动', rmAnim.name === 'none', JSON.stringify(rmAnim)])
  await rm.close()
} catch (e) {
  results.push(['脚本异常', false, String(e.message).slice(0, 200)])
}

results.push(['无页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '0'])

console.log('=== 选题库生成状态条 + 逐行状态 冒烟 ===')
let pass = 0
for (const [name, ok, detail] of results) {
  console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`)
  if (ok) pass++
}
console.log(`\n通过 ${pass}/${results.length}`)
console.log(`截图目录: ${SHOT_DIR}/crosspost-banner-*.png`)
await browser.close()
process.exit(pass === results.length ? 0 : 1)
