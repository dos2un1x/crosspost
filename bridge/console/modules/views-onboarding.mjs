// 「接入与自检」视图（v2.03）——把"哪里没接好"变成界面上可照着做的步骤。
//
// 存在理由：改造前 Console 在零项目接入 / 扩展未连接时只有一行"未连接"，
// 用户无从判断该装扩展、该起桥、还是该登录平台。本视图把三种常见断点分开呈现，
// 并给出确切动作；平台口径一律取自引擎的平台能力矩阵（/proxy/platform-matrix），
// 不在前端手写任何平台数量或名单。
//
// v2.90：这里的四项检查**一直**在执行，但点「⟳ 重新检查」时页面上没有任何可见变化
// ——按钮不置灰、文案不改、重渲染结果又与上一次逐字节相同（Playwright 实测：
// 请求确实发了 4 个，doctor 耗时 287–650ms），使用者只能反馈"点击没有任何反应"。
// 现在每次检查都有忙碌态与回执行，顺带把此前被 `catch {}` 吞掉的失败露出来。
// 见文件末尾「v2.90 检查状态」一节。
import { $ } from './utils.mjs'
import { getJSON } from './api.mjs'
import { activeProject } from './project-switch.mjs'

const STEP_ICON = { ok: '✔', warn: '⚠', fail: '✖', unknown: '·' }
/** 四步状态 → 既有 badge 配色类（v2.88：状态用徽章表达，不再整块填充步骤卡） */
const STEP_BADGE = { ok: 'published', warn: 'partial', fail: 'failed', unknown: 'draft' }

/**
 * 极简元素构造器（本模块自用）。
 * utils.mjs 未提供 el 助手，且其它视图普遍用 innerHTML——新视图一律用 DOM API 构造，
 * 避免把平台名/错误文案拼进 HTML 造成注入面。
 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k.startsWith('on') && typeof v === 'function')
      node.addEventListener(k.slice(2).toLowerCase(), v)
    else node.setAttribute(k, String(v))
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return node
}

/** 从 /proxy/status 推导三类断点状态 */
function deriveSteps(status, registry) {
  const connected = !!(status && status.connected)
  const projects = (registry && registry.projects) || []
  const validCount = projects.filter((p) => p.valid && p.id).length
  const hasProjects = validCount > 0
  const activeId = activeProject()
  const platformsCount = (status && status.platforms && status.platforms.count) || 0

  return [
    {
      key: 'bridge',
      title: '1. 本地桥（bridge）',
      state: 'ok', // 能取到 status 即说明桥在跑
      status: '通过',
      detail: '桥已响应 —— Console 正是它托管的页面。',
    },
    {
      key: 'extension',
      title: '2. 浏览器代理扩展',
      state: connected ? 'ok' : 'fail',
      status: connected ? '已连接' : '未连接',
      detail: connected
        ? `已连接${status.ext && status.ext.client && status.ext.client.clientId ? '（客户端 ' + status.ext.client.clientId + '）' : ''}`
        : '未连接：平台请求必须由你的浏览器代为发出。',
      ...(connected
        ? {}
        : {
            action:
              'Chrome 打开 chrome://extensions → 开启右上角「开发者模式」→「加载已解压的扩展程序」→ 选择 bridge/chrome-proxy-extension',
            extra:
              status && status.ext && status.ext.seen
                ? '提示：扩展曾在 90 秒内出现过又断开，可能是浏览器休眠或该标签页被回收。'
                : '提示：请确认你在**同一个**浏览器里登录了各平台账号 —— 在 A 浏览器登录、扩展装在 B 浏览器是最常见的失败原因。',
          }),
    },
    {
      key: 'platforms',
      title: '3. 平台登录态',
      state: platformsCount > 0 ? 'ok' : connected ? 'warn' : 'unknown',
      status: platformsCount > 0 ? `已纳入 ${platformsCount}` : '待检查',
      detail:
        platformsCount > 0
          ? `已纳入检查 ${platformsCount} 个平台`
          : '尚无平台登录态 —— 平台检查需要扩展连接后才会进行。',
      ...(platformsCount > 0
        ? {}
        : { action: '先完成第 2 步并登录平台账号，然后点右上角「⟳ 刷新」。' }),
    },
    {
      key: 'project',
      title: '4. 接入项目（可选）',
      state: hasProjects ? 'ok' : 'unknown',
      status: hasProjects ? `已接入 ${validCount}` : '未接入',
      detail: hasProjects
        ? `已接入 ${validCount} 个项目${activeId ? `，当前选择：${activeId}` : '（未选择具体项目，使用默认路径）'}`
        : '本项目前尚未接入 Console 的工作台。引擎的平台域功能（登录态/发布/渲染/样式）无需接入即可使用；' +
          '文章、选题库、留存等视图需要接入一个写作项目。',
      ...(hasProjects
        ? {
            extra: activeId
              ? `v2.22 起内容域已接线：文章/留存/归档/选题/报表的请求都会带上当前项目，` +
                `草稿读自该项目的 dataDir，引擎簿记记录写在 <引擎 localRoot>/project-state/${activeId}/。` +
                `标注「数据源不可达」的项目其 dataDir 路径当前不存在。`
              : '在「项目」下拉框切换；标注「数据源不可达」的项目其 dataDir 路径当前不存在。' +
                '（未选择具体项目时，内容域沿用默认路径——单项目部署行为不变。）',
          }
        : {
            action:
              '接入方式见 docs/integration.md §1：项目侧放 .crosspost/project.json，无需改动引擎。',
          }),
    },
  ]
}

function renderMatrix(matrix) {
  const wrap = $('#onboarding-matrix')
  if (!wrap) return
  wrap.innerHTML = ''
  if (!matrix || !matrix.platforms) {
    wrap.appendChild(el('div', { class: 'empty' }, '平台能力矩阵不可用'))
    return
  }
  const counts = matrix.counts || {}
  wrap.appendChild(
    el(
      'p',
      { class: 'ob-lede' },
      `${matrix.summary}。全部 ${counts.all} 个平台中：默认派发 ${counts.defaultDispatch}、仅检查 ${counts['check-only'] || 0}、beta ${counts.beta}。`,
    ),
  )
  // v2.88：27 片芯片一次铺开时读不出结构 —— 按 tier 分三节，每节自带计数。
  // 芯片本身仍是 .ob-chip（冒烟断言 "芯片数 = counts.all" 依赖它），
  // 只是多挂一个 tooltip（平台 id / 备注 / 是否默认派发），把此前被丢弃的
  // matrix 字段露出来，且不新增任何统计口径。
  const SECTIONS = [
    { tier: 'enabled', title: '默认派发', n: counts.enabled, hint: '进入默认派发清单的平台' },
    {
      tier: 'check-only',
      title: '仅检查',
      n: counts['check-only'] || 0,
      hint: '不派发，只做登录态检查',
    },
    { tier: 'beta', title: 'beta', n: counts.beta, hint: '需在 Console 显式勾选启用' },
  ]
  for (const sec of SECTIONS) {
    const list = matrix.platforms.filter((p) => p.tier === sec.tier)
    if (!list.length) continue
    const box = el('section', { class: 'ob-sec' })
    box.appendChild(
      el(
        'div',
        { class: 'ob-sec-head' },
        el('span', { class: 'ob-sec-title' }, sec.title),
        el('span', { class: 'ob-sec-n' }, `${sec.n}`),
        el('span', { class: 'ob-sec-hint' }, sec.hint),
      ),
    )
    const grid = el('div', { class: 'ob-grid' })
    for (const p of list) {
      const tip = `${p.name} · ${p.id}${p.note ? ' · ' + p.note : ''}${p.defaultDispatch ? ' · 默认派发' : ''}`
      grid.appendChild(
        el(
          'div',
          { class: `ob-chip tier-${p.tier}`, title: tip, 'data-id': p.id },
          el('span', { class: 'ob-chip-name' }, p.name),
          el(
            'span',
            { class: 'ob-chip-tier' },
            p.tier === 'check-only' ? '仅检查' : p.tier === 'beta' ? 'beta' : '默认派发',
          ),
        ),
      )
    }
    box.appendChild(grid)
    wrap.appendChild(box)
  }
}

function renderSteps(steps) {
  const wrap = $('#onboarding-steps')
  if (!wrap) return
  wrap.innerHTML = ''
  steps.forEach((s, i) => {
    const last = i === steps.length - 1 ? ' last' : ''
    const row = el('div', { class: `ob-step ob-${s.state}${last}` })
    // 竖向导轨 + 状态圆点（v2.88 起的视觉词汇；原与 Console 工作流页的 .pv-rail/.pv-dot
    // 同源，该页 2026-09-25 删除后这两个类是本页自己的 .ob-rail/.ob-dot，
    // 让"四步"读起来是一条线，而不是四个并列盒子）
    const rail = el('div', { class: 'ob-rail' })
    rail.appendChild(el('span', { class: 'ob-dot' }, STEP_ICON[s.state] || '·'))
    row.appendChild(rail)
    const body = el('div', { class: 'ob-body' })
    const titleLine = el('div', { class: 'ob-title-line' }, s.title)
    if (s.status)
      titleLine.appendChild(el('span', { class: 'ob-status ' + STEP_BADGE[s.state] }, s.status))
    body.appendChild(titleLine)
    body.appendChild(el('div', { class: 'ob-detail' }, s.detail))
    if (s.extra) body.appendChild(el('div', { class: 'ob-detail ob-hint' }, s.extra))
    if (s.action) body.appendChild(el('div', { class: 'ob-action' }, '↳ ' + s.action))
    row.appendChild(body)
    wrap.appendChild(row)
  })
  renderProgress(steps)
}

/** 四段进度读数（v2.88）：只写 data-state，文案仍由上面的 rail 行承担 */
function renderProgress(steps) {
  const box = $('#onboarding-progress')
  if (!box) return // 旧缓存页面没有该节点 → 静默跳过
  box.innerHTML = ''
  for (const s of steps) {
    box.appendChild(el('i', { class: 'ob-seg', 'data-state': s.state, title: `${s.status}` }))
  }
}

/**
 * 引擎自检（v2.50）：把 doctor 的结果显示在接入页上。
 *
 * 为什么需要：本页此前只从 `/proxy/status`、平台矩阵、项目注册表推导 4 步，
 * **完全看不到 doctor** —— 而 doctor 才是"哪些能力可用、哪些配置矛盾"的权威
 * （例如「一键生成」能力未提供、通知配置自相矛盾、MCP 握手失败）。这些以前只能
 * 在终端 `npm run doctor` 看，界面用户根本不知道。
 *
 * 降级策略：拿不到 doctor（旧桥没有该路由、或请求失败）就**整块隐藏**，
 * 保持与本页其它部分一致的"接口不可用即降级、不报错"风格。
 */
function renderDoctor(doc) {
  const card = $('#onboarding-doctor-card')
  const box = $('#onboarding-doctor')
  const badge = $('#onboarding-doctor-badge')
  if (!card || !box) return
  if (!doc || !doc.summary) {
    card.hidden = true // 旧桥 / 接口不可用 → 不显示，也不报错
    return
  }
  const s = doc.summary
  card.hidden = false
  if (badge) {
    badge.textContent =
      s.fail > 0 ? `${s.fail} 项失败` : s.warn > 0 ? `${s.warn} 项提醒` : '全部通过'
    badge.className = 'badge ' + (s.fail > 0 ? 'failed' : s.warn > 0 ? 'partial' : 'published')
  }

  box.innerHTML = ''
  const notOk = (doc.checks || []).filter((c) => c.severity === 'fail' || c.severity === 'warn')
  // v2.88：读数区 = **原样的文案行**（一字不改：冒烟按 `.ob-doctor-summary` 取文本并匹配
  // /共 N 项/）+ 其下一条通过率细条。刻意不再重复三枚计数——同一组数字出现两次是坏设计。
  const sum = el('div', { class: 'ob-sum' })
  sum.appendChild(
    el(
      'div',
      { class: 'ob-doctor-summary' },
      `共 ${s.total} 项：${s.pass} 通过 · ${s.warn} 提醒 · ${s.fail} 失败`,
    ),
  )
  if (s.total > 0) {
    const meter = el('span', { class: 'ob-meter', title: `通过率 ${s.pass}/${s.total}` })
    for (const [cls, n] of [
      ['ok', s.pass],
      ['warn', s.warn],
      ['fail', s.fail],
    ]) {
      if (n > 0) meter.appendChild(el('i', { class: cls, style: `flex:${n}` }))
    }
    sum.appendChild(meter)
  }
  box.appendChild(sum)
  if (notOk.length === 0) {
    box.appendChild(el('div', { class: 'ob-doctor-ok' }, '引擎自检全部通过。'))
    return
  }
  const list = el('div', { class: 'ob-doctor-list' })
  for (const c of notOk) {
    // v2.88：把 severity 落到类名上，让左侧导轨按严重度着色（此前 ✖/⚠ 只藏在标题文字里）
    const row = el('div', {
      class: `ob-doctor-row ${c.severity === 'fail' ? 'is-fail' : 'is-warn'}`,
    })
    row.appendChild(
      el(
        'div',
        { class: 'ob-doctor-title' },
        `${c.severity === 'fail' ? '✖' : '⚠'} ${c.title || c.id}`,
      ),
    )
    if (c.detail) row.appendChild(el('div', { class: 'ob-doctor-detail' }, String(c.detail)))
    if (c.hint) row.appendChild(el('div', { class: 'ob-doctor-hint' }, String(c.hint)))
    list.appendChild(row)
  }
  box.appendChild(list)
}

/**
 * 「当前项目」卡（v2.83）：把**选中项目自己**的域摊开显示。
 *
 * 为什么需要：本页此前只有引擎级自检（Node/桥/MCP/扩展/默认域目录…），切到某个项目后
 * 页面上**看不出任何项目差异** —— 使用者反馈"接入与自检 也没有区分项目"。
 * doctor 在有项目上下文时会返回 `project` 段（草稿/记录/项目级资源/设置覆盖/一键生成），
 * 这里把它渲染出来；未选项目时整卡隐藏（此时"项目域"确实不存在）。
 */
function renderProjectScope(p) {
  const card = $('#onboarding-project-card')
  const box = $('#onboarding-project')
  const badge = $('#onboarding-project-badge')
  if (!card || !box) return
  if (!p || !p.id) {
    card.hidden = true
    return
  }
  card.hidden = false
  if (badge) {
    badge.textContent = p.valid === false ? 'manifest 无效' : '已接入'
    badge.className = 'badge ' + (p.valid === false ? 'failed' : 'published')
  }
  const rows = [
    ['项目', `${p.name || p.id}（${p.id}）`],
    ['草稿目录', p.draftsDir],
    ['引擎簿记（记录）', p.storeDir],
    ['项目级资源', `history ${p.historyDir} · logs ${p.logsDir}`],
    ['选题库 / 编辑记忆', `${p.topicPoolFile} · ${p.editorialMemoryFile}`],
    [
      '项目级设置',
      p.overridden && p.overridden.length
        ? `覆盖了 ${p.overridden.join('、')} · ${p.configFile}`
        : `未覆盖任何键（继承引擎配置）· ${p.configFile}`,
    ],
    [
      '「一键生成」',
      p.generate && p.generate.provided
        ? `已提供${p.generate.url ? `：${p.generate.url}` : ''}`
        : `未提供（${(p.generate && p.generate.reason) || '未声明'}）`,
    ],
  ]
  box.innerHTML = ''
  const list = el('div', { class: 'ob-doctor-list' })
  for (const [k, v] of rows) {
    const row = el('div', { class: 'ob-doctor-row' })
    row.appendChild(el('div', { class: 'ob-doctor-title' }, k))
    row.appendChild(el('div', { class: 'ob-doctor-detail' }, String(v == null ? '—' : v)))
    list.appendChild(row)
  }
  box.appendChild(list)
  box.appendChild(
    el(
      'div',
      { class: 'ob-doctor-hint' },
      '这些路径来自项目自己的 manifest 与工作区推导（v2.76 起周边资源按项目解析）；下面的引擎自检是机器级的，两者作用域不同。',
    ),
  )
}

/* ── 常驻 worker 车道（2026-09-21 v2.101.1）─────────────────────────
 *
 * 为什么要有这一块：Console 的速度几乎完全由"车道是否热的"决定 ——
 *   · v2.100 事故：reader worker 被 execFile 的 maxBuffer 杀成**永久冷启动**，
 *     每个读请求 1.2s，整个页面"不再瞬开"；
 *   · v2.101 事故：费用解析和读共用一条串行队列，开报表时并发读 23ms → 2340ms。
 * 两次都**没有任何界面**看得出来，只能靠推理定位。这里把三条事实摆出来：
 * 车道是否存活、是否在冷却（= 正在付冷启动成本）、本次已推送多少字节（成本线索）。
 *
 * 判据说明：`coolingDown` 才是"降级"的准确含义（达退出上限、正在 60s 冷却期，
 * 期间走冷启动回退）。`restarts > 0` 只说明历史上重启过，不等于当前慢。
 */
function renderWorkerLanes(health) {
  const card = $('#onboarding-workers-card')
  const box = $('#onboarding-workers')
  const badge = $('#onboarding-workers-badge')
  if (!card || !box) return
  const lanes = (health && health.workers) || null
  if (!lanes || !Object.keys(lanes).length) {
    // 旧桥没有这个字段：整卡收成一行说明，而不是画一堆"未知"（对旧桥优雅降级）
    card.hidden = false
    if (badge) {
      badge.textContent = '当前桥不提供'
      badge.className = 'badge'
    }
    box.innerHTML = ''
    box.appendChild(
      el(
        'div',
        { class: 'ob-doctor-hint' },
        '当前桥未暴露 /proxy/health 的 workers 字段（v2.100 之前的版本）。升级桥之后这里会显示每条车道的状态。',
      ),
    )
    return
  }
  const roles = Object.keys(lanes)
  const degraded = roles.filter((r) => !lanes[r].alive || lanes[r].coolingDown)
  card.hidden = false
  if (badge) {
    badge.textContent = degraded.length ? `${degraded.length} 条降级` : `${roles.length} 条全部就绪`
    badge.className = 'badge ' + (degraded.length ? 'failed' : 'published')
  }
  const list = el('div', { class: 'ob-doctor-list' })
  for (const role of roles) {
    const w = lanes[role] || {}
    const up = w.uptimeMs ? `存活 ${Math.round(w.uptimeMs / 1000)}s` : '未运行'
    const meta = w.alive
      ? `pid ${w.pid} · ${up} · 已推送 ${(w.outputBytes / 1048576).toFixed(1)}MB · 重启 ${w.restarts} 次`
      : `未运行 · 重启 ${w.restarts} 次${w.coolingDown ? '（冷却中，正在付冷启动成本）' : ''}`
    const row = el('div', { class: 'ob-doctor-row' })
    row.appendChild(el('div', { class: 'ob-doctor-title' }, role))
    const detail = el('div', { class: 'ob-doctor-detail' }, meta)
    const tag = el(
      'span',
      { class: 'badge ' + (w.alive && !w.coolingDown ? 'published' : 'failed') },
      w.alive && !w.coolingDown ? '热' : w.coolingDown ? '冷却' : '未运行',
    )
    detail.appendChild(document.createTextNode(' '))
    detail.appendChild(tag)
    row.appendChild(detail)
    list.appendChild(row)
  }
  box.innerHTML = ''
  box.appendChild(list)
  box.appendChild(
    el(
      'div',
      { class: 'ob-doctor-hint' },
      '「冷」= 该车道的请求会退化成每次冷启动 cli.mjs（约 1.2s）。车道会在请求到达时自动重新拉起；' +
        '连续退出达上限则进入 60s 冷却，到期自动重试。',
    ),
  )
}

/* ── v2.90 检查状态：忙碌态 + 回执 + 单飞 ────────────────────────────
 *
 * 四项数据源（key → 读不到时给人看的名字）。回执里点名的就是这些名字。
 * 平台登录态只在 /proxy/status 里**取缓存**（桥侧默认每 1 小时自动重查）——
 * 本按钮刻意不强制重查平台（那是设置页「立即检查平台状态」的职责），
 * 所以回执必须如实标出"登录态取自 N 分钟前"，否则用户会以为重查过了。 */
const SOURCES = {
  status: '/proxy/status',
  matrix: '平台矩阵',
  registry: '项目注册表',
  doctor: 'doctor',
  // 2026-09-21（v2.101.1）：常驻 worker 车道健康。放在这一页是因为"网页变慢"的第一现场
  // 就在这里能一眼看到 —— v2.100/v2.101 两次事故（worker 被杀成永久冷启动、费用解析堵住
  // 读队列）此前**没有任何界面**能看出来，全靠人肉推理。
  health: '/proxy/health',
}
const SOURCE_TITLE =
  '数据源：/proxy/status · /proxy/platform-matrix · /proxy/projects · /proxy/doctor · /proxy/health。' +
  '平台登录态取自桥侧缓存（默认每 1 小时自动重查），本按钮不强制重查平台。'

let inflight = null /* 在飞的那次检查（单飞：并发调用共享它，不叠加请求） */
let queued = false /* 检查期间又来了一次调用 → 收尾后补跑一次 */
let prevSnap = null /* 上一次"人看得懂的状态"快照，用来写"第 2 步 未连接 → 已连接" */
let lastOkAt = null /* 最近一次四项全部成功的时间：全失败时用它标注"下面是几点结果" */

const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8)

function humanAge(ms) {
  if (ms < 90_000) return `${Math.round(ms / 1000)} 秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`
  return `${(ms / 3_600_000).toFixed(1)} 小时`
}

/** 平台登录态的新鲜度说明（新鲜则返回空串，不占回执行） */
function freshNote(status) {
  const p = (status && status.platforms) || null
  if (!p) return ''
  if (p.init) return '登录态尚未检查（桥侧后台检查中）'
  const at = Number(p.checkedAt || p.at || 0)
  if (!at) return ''
  const age = Date.now() - at
  if (age < 90_000) return ''
  return `登录态取自 ${humanAge(age)}前`
}

/** 快照只取"人看得懂的状态"：四步状态与短词 + doctor 通过数 */
function snapshotOf(doctor, steps) {
  const s = (doctor && doctor.summary) || null
  return {
    at: Date.now(),
    states: steps.map((x) => x.state),
    words: steps.map((x) => x.status || '—'),
    doc: s ? `${s.pass}/${s.total}` : '',
  }
}

function changeNotes(before, now) {
  if (!before || !now) return []
  const notes = []
  const n = Math.min(before.words.length, now.words.length)
  for (let i = 0; i < n; i++) {
    if (before.states[i] !== now.states[i] || before.words[i] !== now.words[i])
      notes.push(`第 ${i + 1} 步 ${before.words[i]} → ${now.words[i]}`)
  }
  if (now.doc && before.doc !== now.doc) notes.push(`引擎自检 ${before.doc || '—'} → ${now.doc}`)
  return notes
}

function setFresh(text, kind = 'ok') {
  const n = $('#onboarding-checked')
  if (!n) return // 旧缓存页面没有回执行 → 静默跳过（与 renderProgress 同策略）
  n.textContent = text
  n.dataset.kind = kind
  n.title = SOURCE_TITLE
}

function setBusy(on) {
  const view = $('#view-onboarding')
  const btn = $('#btnOnboardingRefresh')
  const bar = $('#onboarding-loadbar')
  if (view) view.classList.toggle('is-checking', on)
  if (bar) bar.hidden = !on
  if (btn) {
    btn.disabled = on
    btn.classList.toggle('is-busy', on)
    if (on) btn.setAttribute('aria-busy', 'true')
    else btn.removeAttribute('aria-busy')
    const label = btn.querySelector('.ob-btn-label')
    if (label) label.textContent = on ? '检查中…' : '重新检查'
  }
}

async function runCheck(trigger) {
  const t0 = Date.now()
  setBusy(true)
  setFresh(trigger === 'manual' ? '正在重新检查…' : '正在检查…', 'busy')
  // 四个请求各自独立失败：旧实现用一个 `catch {}` 吞掉全部，于是桥挂了
  // 也表现为"点击没反应"。现在失败被记下来写进回执，页面仍用旧内容兜底。
  const failed = []
  const grab = async (key, path) => {
    try {
      return await getJSON(path)
    } catch {
      failed.push(SOURCES[key] || path)
      return null
    }
  }
  const [status, matrix, registry, doctor, health] = await Promise.all([
    grab('status', '/proxy/status'),
    grab('matrix', '/proxy/platform-matrix'),
    grab('registry', '/proxy/projects'),
    grab('doctor', '/proxy/doctor'),
    grab('health', '/proxy/health'),
  ])

  const ms = Date.now() - t0
  const dur = `用时 ${(ms / 1000).toFixed(1)}s`
  // 四项全失败 = 桥没响应。此处**刻意不重绘**：一个数据源都拿不到时重绘，只会把
  // 上一次的良好结果擦成"平台能力矩阵不可用 / 四步全红"（旧实现正是如此，越点越空）。
  // 内容保持原样 + 回执说明，才是这个场景下信息量最大的呈现。
  if (failed.length === Object.keys(SOURCES).length) {
    setBusy(false)
    setFresh(
      `${trigger === 'manual' ? '重新检查' : '检查'}失败：${Object.keys(SOURCES).length} 个数据源都读不到（${dur}）` +
        (lastOkAt ? ` · 下面是 ${hhmmss(lastOkAt)} 的结果` : ''),
      'fail',
    )
    return
  }

  const steps = deriveSteps(status, registry)
  renderSteps(steps)
  renderMatrix(matrix)
  renderDoctor(doctor)
  renderProjectScope(doctor && doctor.project)
  renderWorkerLanes(health)
  const badge = $('#onboarding-conn')
  if (badge) {
    badge.textContent = status && status.connected ? '扩展已连接' : '扩展未连接'
    badge.className = 'badge ' + (status && status.connected ? 'published' : 'failed')
  }

  setBusy(false)
  const snap = snapshotOf(doctor, steps)
  const notes = changeNotes(prevSnap, snap)
  const parts = [`${trigger === 'manual' ? '已重新检查' : '已检查'} · ${hhmmss(snap.at)} · ${dur}`]
  if (failed.length) parts.push(`未能读取：${failed.join('、')}`)
  if (notes.length) parts.push(notes.join('、'))
  else if (prevSnap && !failed.length) parts.push('无状态变化')
  const age = freshNote(status)
  if (age) parts.push(age)
  prevSnap = snap
  if (!failed.length) lastOkAt = snap.at
  setFresh(parts.join(' · '), failed.length ? 'warn' : notes.length ? 'changed' : 'ok')
}

/**
 * 拉取四项数据源并重绘本页。
 * @param {{trigger?: 'auto'|'manual'}} [opts] manual = 用户点「⟳ 重新检查」
 */
export function loadOnboarding(opts = {}) {
  const trigger = opts && opts.trigger === 'manual' ? 'manual' : 'auto'
  if (inflight) {
    // 已在检查中：不叠加请求（单飞）。但记下"还要再跑一次"——调用方可能刚切了
    // 项目，收尾后必须用新上下文重算一遍，否则第 4 步显示的是切换前的项目状态。
    queued = true
    return inflight
  }
  inflight = runCheck(trigger).finally(() => {
    inflight = null
    if (queued) {
      queued = false
      loadOnboarding({ trigger: 'auto' })
    }
  })
  return inflight
}

export function initOnboardingView() {
  const btn = $('#btnOnboardingRefresh')
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1'
    btn.addEventListener('click', () => loadOnboarding({ trigger: 'manual' }))
  }
  // 项目切换后必须重算第 4 步：否则界面显示的是切换前的过期状态
  // （实测踩到：切了项目，第 4 步仍写"未选择具体项目"）
  if (!window.__cpOnboardingBound) {
    window.__cpOnboardingBound = true
    window.addEventListener('crosspost:project-changed', () => {
      if ($('#view-onboarding')?.classList.contains('active')) loadOnboarding()
    })
  }
}
