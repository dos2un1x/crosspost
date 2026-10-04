// 设置页视图（2026-08-24 app.js 拆分 Phase 1）
import { getJSON, postJSON } from './api.mjs'
import {
  PLATFORM_NAMES,
  PANEL_PLATFORMS,
  PF_LOCKED,
  PLATFORM_GROUPS,
  DEFAULT_PLATFORMS,
  SCORE_PASS,
} from './const.mjs'
import {
  store,
  getDefaultPlatforms,
  applyAuthPayload,
  applyStatusMeta,
  applyExtMeta,
  refreshPlatformAuth,
  onPlatformAuthChange,
} from './state.mjs'
import { $, escapeHtml, escapeAttr, todayStr } from './utils.mjs'
import { loadStyleLib, loadCoverTplSettings, initStyleSection } from './views-settings-styles.mjs'
import { applyBrand } from './brand.mjs'

export async function loadSettings() {
  try {
    const [sched, cfg, backup, plats] = await Promise.all([
      getJSON('/proxy/schedule'),
      getJSON('/proxy/config'),
      getJSON('/proxy/backup'),
      getJSON('/proxy/platforms', { timeoutMs: 120000 }).catch(() => ({ platforms: [] })),
    ])
    store.scheduleData = sched
    renderSchedule(sched.slots)
    // 2026-09-11：/proxy/platforms 变纯缓存直读；冷启动 init=true 表示"后台检查中"，
    // 徽标先显示未知/检查中，检查完成后由订阅回调重渲染
    applyAuthPayload(plats)
    // v2.77：显示设置的作用域——项目级项写进该项目的覆盖层，引擎级项始终写引擎 config
    {
      const scope = cfg._scope || {}
      const el = $('#cfg-scope')
      if (el) {
        const over = (scope.overridden || []).map((k) => escapeHtml(k)).join('、')
        el.innerHTML = scope.project
          ? `<b>正在编辑项目 ${escapeHtml(scope.project)} 的设置</b>：项目级项（调度/平台清单/通知/评分/品牌/封面/样式/自动推送）写入该项目的覆盖层，引擎级项（端口/超时/并发/注册表）仍写引擎配置。` +
            (over ? ` · 已被本项目覆盖：${over}` : '')
          : '<b>正在编辑默认域设置</b>：项目级项会作为所有项目的默认值（各项目可单独覆盖），引擎级项即引擎配置本身。'
      }
    }
    store.configuredDefaults = (cfg.platforms && cfg.platforms.default) || DEFAULT_PLATFORMS
    // v2.96.1：这里是**权威加载**（进设置页 / 切项目 / 点刷新）——只有这一处该用配置
    // 重置活选集。其余调用点（搜索框输入、平台登录态每 60s 刷新）必须保留用户未保存的勾选，
    // 否则"勾了简书 → 敲一个字 → 勾没了"（现场复现过）。
    pfSelection = new Set(getDefaultPlatforms() || [])
    renderPlatformGrid(getDefaultPlatforms())
    // 生成后自动推送（2026-09-09）：回显开关；微信子开关仅在总开关开启时可操作
    const ap = cfg.autoPush || {}
    const apEnabled = !!ap.enabled
    $('#ap-enabled').checked = apEnabled
    $('#ap-include-wechat').checked = !!ap.includeWechat
    $('#ap-include-wechat').disabled = !apEnabled
    $('#ap-wechat-row').classList.toggle('is-off', !apEnabled)
    // 2026-09-12 修复：change 监听改为 initSettingsView() 一次性绑定（此前写在 loadSettings() 里，
    // 每次进入设置页都会再挂一次 → 多次访问后一次切换发 N 个 /proxy/config POST）
    const n = cfg.notify || {}
    $('#n-enabled').checked = n.enabled !== false
    $('#n-channel').value = n.channel || 'lark'
    $('#n-lark-chat').value = n.larkChatId || ''
    $('#n-webhook').value = n.webhookUrl || ''
    $('#n-webhook-type').value = n.webhookType || 'raw'
    const t = n.template || {}
    $('#n-tpl-title').value = t.title || ''
    $('#n-tpl-summary').value = t.summary || ''
    $('#n-tpl-footer').value = t.footer || ''
    $('#s-threshold').value = (cfg.scoring && cfg.scoring.threshold) || SCORE_PASS
    const inv = (cfg.scoring && cfg.scoring.investment) || {}
    $('#inv-strong').value = (inv.strong || []).join(',')
    $('#inv-weak').value = (inv.weak || []).join(',')
    // v2.96：上面写的是"真值"（textarea / number），下面把两个显示器对齐
    syncThresholdDial('num')
    renderRiskChips('strong')
    renderRiskChips('weak')
    // 品牌图标（2026-09-02）：回显当前 icon 路径 + 预览
    const icon = (cfg.branding && cfg.branding.icon) || ''
    $('#brand-icon-url').value = icon
    $('#brand-icon-preview').src = icon || '/console/favicon.ico'
    $('#brand-msg').textContent = ''
    // 代理配置五项（2026-08-25 自 DSH 设置页合并；2026-09-11 增状态轮询间隔/检查并发度）
    $('#px-cache-min').value = Math.round((cfg.platformsCacheMs || 3600000) / 60000)
    $('#px-timeout-sec').value = Math.round((cfg.timeoutMs || 150000) / 1000)
    $('#px-concurrency').value = cfg.concurrency || 3
    $('#px-poll-sec').value = Math.round((cfg.platformsPollMs || 60000) / 1000)
    $('#px-check-conc').value = cfg.platformsCheckConcurrency || 6
    store.platformsPollMs = cfg.platformsPollMs || 60000
    syncNotifyRows()
    syncNotifyEnabledLook()
    $('#notify-msg').textContent = ''
    // 备份状态（v2.96：改成"读数 + 发丝线行"，此前是 5 个文件名各占一个边框盒子）
    renderBackup(backup || {})
    store.settingsLoaded = true
  } catch (e) {
    $('#schedule-list').innerHTML =
      `<div style="color:var(--fail)">加载失败: ${escapeHtml(e.message)}</div>`
  }
  // 状态卡与样式库独立加载（失败不阻塞设置页主流程）
  // 2026-09-11：状态卡改为定期自检（只读 /proxy/status），并订阅平台检查结果刷新徽标
  loadBridgeStatus().then((st) => {
    if (st && st.platforms && st.platforms.pollMs) store.platformsPollMs = st.platforms.pollMs
    if (isSettingsActive()) startSettingsPoll()
  })
  // 样式库与「封面 × 结束语模板」都是**项目级**设置（v2.77 起走项目覆盖层）：
  // 每次进设置页（含切换项目触发的重放）都要重新取，否则会停留在上一个项目的值（v2.81 修）
  loadStyleLib()
  loadCoverTplSettings()
}

/* ══ v2.96：设置页其余模块的渲染（读数 / 词卡 / 刻度盘 / 渠道分段器）══════════
   这一段的共同点：**显示层重做，真值不动**。
   · 平台网格  → 真值仍是 #pf-grid input:checked（.pf-item / button[data-check] 契约保留）
   · 备份列表  → 真值仍是 /proxy/backup 的 count/lastBackup/files
   · 风险词    → 真值仍是 #inv-strong / #inv-weak 两个 textarea（只是视觉隐藏）
   · 评分阈值  → 真值仍是 #s-threshold（新增 range 只是它的另一个手柄）
   · 通知渠道  → 真值仍是 #n-channel（分段器点选后写回它并派发 change）
   ══════════════════════════════════════════════════════════════════════════ */

/** 备份文件名 → 本地时间 ms（articles-2026-09-20-01-31-32.tar.gz）；认不出返回 null */
function backupStamp(name) {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(String(name || ''))
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime()
  return Number.isFinite(t) ? t : null
}

/** 「09-20 01:31」式短时刻 */
function backupWhen(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 备份卡：读数条（共几份 / 最近一份多久前）+ 发丝线行列表。
 *  v2.96 改前：`共 30 份备份 | 最近：articles-…tar.gz` 一行 + 5 个文件名各占一个边框盒子。
 *  · 文件名里的 40 位时间戳对"多久之前"没有直觉 → 读数条改成**相对时间**
 *  · 5 个盒子换成 5 行发丝线（盒子×5 = 5 个同等重量的边框，把卡片切成 5 段）
 *  · 完整文件名降级到 title（要对账时悬停就有，不必常驻） */
function renderBackup(bs) {
  // 副标题的"保留最近 N 份"按接口给（`/proxy/backup` 的 `keep`）：份数是 `bridge/backup.mjs`
  // 的常量，前端写死就是第二份副本（2026-09-25）。接口没给（旧桥）→ 保留不含数字的兜底文案。
  const sub = $('#backup-sub')
  if (sub && Number(bs.keep) > 0)
    sub.textContent = `每日自动备份 articles/ 到 backups/（tar.gz，保留最近 ${Number(bs.keep)} 份）`
  const status = $('#backup-status')
  if (status) {
    const lastTs = backupStamp(bs.lastBackup)
    status.innerHTML = bs.count
      ? `<div class="bk-readout">
           <span class="bk-num">${Number(bs.count) || 0}</span>
           <span class="bk-cap">份备份</span>
           <span class="bk-note">最近一份 ${
             lastTs ? escapeHtml(fmtAgo(lastTs)) : escapeHtml(String(bs.lastBackup || '—'))
           }${bs.lastBackup ? ` · <span class="bfile">${escapeHtml(String(bs.lastBackup))}</span>` : ''}</span>
         </div>`
      : '<div class="b-empty">尚无备份 · 每日自动执行</div>'
  }
  const files = bs.files || []
  const list = $('#backup-files')
  if (!list) return
  list.innerHTML = files.length
    ? `<div class="bk-list-head"><span class="bk-list-title">最近备份</span><span class="bk-list-cap">${files.length} / ${Number(bs.count) || files.length}</span></div>
       <div class="bk-list">${files
         .map((f) => {
           const ts = backupStamp(f)
           return `<div class="bk-item" title="${escapeAttr(String(f))}">
             <span class="bk-when">${escapeHtml(backupWhen(ts))}</span>
             <span class="bk-ago">${ts ? escapeHtml(fmtAgo(ts)) : ''}</span>
           </div>`
         })
         .join('')}</div>`
    : ''
}

/** 风险词分词：与 saveScoring() 里的 parseWords 同一套分隔符（两处必须一致） */
function parseRiskWords(s) {
  return [
    ...new Set(
      String(s || '')
        .split(/[,，、|;\n]/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ]
}

const RISK_FIELDS = {
  strong: {
    ta: '#inv-strong',
    chips: '#inv-strong-chips',
    add: '#inv-strong-add',
    count: '#inv-strong-count',
  },
  weak: {
    ta: '#inv-weak',
    chips: '#inv-weak-chips',
    add: '#inv-weak-add',
    count: '#inv-weak-count',
  },
}

/** 词卡列表：一个词一张卡，卡上 × 删除。真值写回对应的隐藏 textarea。 */
function renderRiskChips(which) {
  const f = RISK_FIELDS[which]
  const ta = $(f.ta)
  const box = $(f.chips)
  if (!ta || !box) return
  const words = parseRiskWords(ta.value)
  box.innerHTML = words.length
    ? words
        .map(
          (w) =>
            `<span class="rw-chip"><span class="rw-word">${escapeHtml(w)}</span><button class="rw-del" type="button" data-word="${escapeAttr(w)}" title="删除「${escapeAttr(w)}」" aria-label="删除 ${escapeAttr(w)}">×</button></span>`,
        )
        .join('')
    : '<span class="rw-empty">还没有词</span>'
  const cap = $(f.count)
  if (cap) cap.textContent = words.length ? `${words.length} 个` : '0 个'
  box.querySelectorAll('button[data-word]').forEach((btn) =>
    btn.addEventListener('click', () => {
      ta.value = parseRiskWords(ta.value)
        .filter((w) => w !== btn.dataset.word)
        .join(',')
      renderRiskChips(which)
    }),
  )
}

/** 词卡编辑器：回车 / 逗号 / 顿号 / 失焦都落词；重复词自动去重（saveScoring 也会去重） */
function bindRiskChipAdd(which) {
  const f = RISK_FIELDS[which]
  const ta = $(f.ta)
  const input = $(f.add)
  if (!ta || !input) return
  const commit = () => {
    const add = parseRiskWords(input.value)
    if (!add.length) return
    ta.value = [...new Set([...parseRiskWords(ta.value), ...add])].join(',')
    input.value = ''
    renderRiskChips(which)
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
  })
  input.addEventListener('blur', commit)
  input.addEventListener('input', () => {
    if (/[,，、|;]/.test(input.value)) commit()
  })
}

/** 阈值刻度盘：range 与 number 双向同步，真值仍是 #s-threshold。
 *  只在**有效数字**上同步 —— number 框清空时不能把 range 拽到 0（那会让"清空重打"
 *  变成"先归零再跳到新值"，视觉上跳一下）。 */
function syncThresholdDial(from) {
  const range = $('#s-threshold-range')
  const num = $('#s-threshold')
  if (!range || !num) return
  const paint = () => {
    const v = Number(range.value)
    const pct = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0
    range.style.setProperty('--fill', pct + '%')
  }
  if (from === 'range') {
    num.value = range.value
    paint()
    return
  }
  const n = Number(num.value)
  if (Number.isFinite(n) && num.value !== '') range.value = String(Math.max(0, Math.min(100, n)))
  paint()
}

/** 通知渠道分段器：三个互斥选项各自可读（名字 + 一句注解）。
 *  真值仍是 #n-channel（select），点选 → 写回 + 派发 change → syncNotifyRows() 原样工作。 */
const NOTIFY_CHANNELS = [
  ['lark', 'lark-cli', '飞书 bot'],
  ['webhook', 'Webhook', '钉钉 / 企微 / 飞书群'],
  ['off', '关闭', '不发通知'],
]

function renderChannelSeg() {
  const seg = $('#n-channel-seg')
  const sel = $('#n-channel')
  if (!seg || !sel) return
  const cur = sel.value
  seg.innerHTML = NOTIFY_CHANNELS.map(
    ([v, label, note]) =>
      `<button type="button" class="chan-item${v === cur ? ' is-on' : ''}" data-channel="${v}" role="radio" aria-checked="${v === cur}">
         <span class="chan-label">${label}</span><span class="chan-note">${note}</span>
       </button>`,
  ).join('')
  seg.querySelectorAll('button[data-channel]').forEach((btn) =>
    btn.addEventListener('click', () => {
      sel.value = btn.dataset.channel
      sel.dispatchEvent(new Event('change'))
    }),
  )
}

/** 「启用通知」总闸关掉时，下面的渠道/字段整块退到后面（与调度卡 .sw-row.is-off 同一手法）。
 *  只改视觉，不改任何保存语义。 */
function syncNotifyEnabledLook() {
  const card = $('#card-notify')
  const on = !!($('#n-enabled') || {}).checked
  if (card) card.classList.toggle('notify-off', !on)
}

function syncNotifyRows() {
  const v = $('#n-channel').value
  $('#row-lark').style.display = v === 'lark' ? '' : 'none'
  $('#row-webhook').style.display = v === 'webhook' ? '' : 'none'
  $('#row-webhook-type').style.display = v === 'webhook' ? '' : 'none'
  renderChannelSeg()
}

/** 保存「生成后自动推送」开关（2026-09-09）：写 config.json.autoPush（深合并，保留另一个子字段） */
async function saveAutoPush() {
  const enabled = $('#ap-enabled').checked
  const includeWechat = $('#ap-include-wechat').checked
  const row = $('#ap-wechat-row')
  $('#ap-include-wechat').disabled = !enabled
  row.classList.toggle('is-off', !enabled)
  try {
    await postJSON('/proxy/config', { autoPush: { enabled, includeWechat } })
    const msg = $('#sched-msg')
    if (msg) {
      msg.className = 'repub-result ok'
      msg.textContent = `已保存：${enabled ? '生成后自动推送' : '仅生成草稿'}${enabled && includeWechat ? '（含微信）' : ''}`
    }
  } catch (e) {
    const msg = $('#sched-msg')
    if (msg) {
      msg.className = 'repub-result err'
      msg.textContent = '保存失败: ' + String(e.message || e)
    }
  }
}

/**
 * 槽位徽标（纯函数，便于测试）：由"命令能不能跑 + 用户意图 + 运行态"推四态。
 *
 * v2.3 起语义整段换过：以前三态围绕 **launchd 是否注册**（`plistExists` /
 * `launchctlLoaded`），而 `launchctl disable` 拦不住 XPC 日历活动，于是"已关闭·活动仍在"
 * 成了一个必须存在的形态。现在触发是引擎自己的定时器，那个形态**不可能出现**——
 * 取而代之要表达的变成了三件新事实：
 *   · 这个槽位有没有**命令声明**（v2.3 起命令只能来自项目 `.crosspost/schedule.json`）
 *   · 内置定时器**有没有在跑**（它住在宿主进程里：桥 / 独立 scheduler）
 *   · 今天是否已跑、上次是否**未收尾**（有头无尾 → 当天不自动重跑）
 *
 * 2026-09-25：引擎侧「日历提醒」退役后，**槽位全部来自项目**，原先的 `scope === 'engine'`
 * 分支（第五态"引擎任务"）随之删除——留着它就是一条永远为假的路。
 */
export function schedBadge(s, projectId) {
  if (!projectId)
    return {
      cls: 'noproj',
      text: '未选择项目',
      title: '槽位按项目解析（命令来自该项目的 .crosspost/schedule.json）；先在顶部选一个项目',
    }
  if (s.commandMissing)
    return {
      cls: 'noplist',
      text: '缺命令声明',
      title:
        s.commandReason ||
        '该项目还没有调度声明：在项目根放 .crosspost/schedule.json（可用 scheduler migrate 从旧任务生成）',
    }
  if (!s.enabled) return { cls: 'off', text: '已关闭', title: '已关闭：内置定时器不会触发' }
  if (s.unfinished)
    return {
      cls: 'warn',
      text: '上次未收尾',
      title: '今天已触发过一次但没写回结果；按策略当天不再自动重跑（要补跑点「立即运行」）',
    }
  if (s.running) return { cls: 'on', text: '运行中', title: '正在执行该槽位' }
  // 跑失败也要说话（2026-09-25）：`completedToday` 只表示"今天有 finished 记录"，
  // 与成败无关。实测踩到：18:10 那轮 exit=1、零产出，而界面写着"已启用·今日已跑"，
  // 人只能靠"怎么没文章"才发现（executor 是容器/远程时更容易这样）。
  // 判据：最近一班失败 **且**（是自动跑的那班 或 最近一班就在今天）——
  // 只看 lastExit 会把几天前的失败一直挂在行上。
  const ranToday = String(s.lastRunAt || '').slice(0, 10) === todayStr()
  if (typeof s.lastExit === 'number' && s.lastExit !== 0 && (s.completedToday || ranToday))
    return {
      cls: 'warn',
      text: `跑失败(exit=${s.lastExit})`,
      title: `最近一班跑完了但退出码是 ${s.lastExit}（${s.lastDurationMs ? Math.round(s.lastDurationMs / 1000) + 's' : '时长未知'}）：看该槽位的日志（run-<slot>-<日期>.log）与 scheduler-<slot>.out.log`,
    }
  if (s.armed)
    return {
      cls: 'on',
      text: s.completedToday ? '已启用·今日已跑' : '已启用',
      title: '到点由引擎内置定时器触发',
    }
  return { cls: 'warn', text: '已启用·未生效', title: armedTitle(s.armedReason) }
}

/** `armedReason` → 人话（Console 上要能直接照做） */
export function armedTitle(reason) {
  if (reason === 'no-lock') {
    return (
      '内置定时器没在跑：启动宿主进程——桥（node bridge/run-bridge.mjs 或 install-launchd.sh / install-systemd.sh）' +
      '，或只跑调度（node crosspost-runtime/src/commands/scheduler-cli.mjs run）'
    )
  }
  if (reason === 'disabled') return '已被关闭'
  if (reason === 'command-missing') return '缺命令声明'
  if (reason === 'executor-unavailable')
    return '项目声明的槽位执行器（http）不可用：检查 manifest 的 capabilities.schedule 与端点策略（引擎配置 slotExecutor.allowHosts）'
  return `原因：${reason || '未知'}`
}

/**
 * 槽位行（v2.84 起可编辑；**v2.93 起是一张时刻表**）。
 *
 * v2.93 之前：六个槽位 = 六个卡片盒子，每行 7 个控件（名称框 / 时间框 / id / 徽标 /
 * 保存 / 删除 / 开关）全部常驻且视觉等重 —— 12 个按钮 + 6 个裸输入框，读起来是
 * "六张表单"，而这一节真正要回答的是"一天里什么时候跑、跑不跑得起来"。现在改成：
 *   · 全局开关走发丝线行（与槽位行刻意**不同构**，一眼分得清总闸与单班次）
 *   · 顶部一条 24 小时**时刻线**（点色 = 启停，读数在右侧）
 *   · 槽位行 = 时间 | 栏目/id | 状态徽标 | 下次触发 | 操作，列与表头对齐
 *   · 名称/时间静止态是**文字**（无边框），hover/focus 才显编辑态；
 *     改了没保存 → 行标 `.is-dirty`（保存按钮提亮），Enter 直接保存
 *   · 保存/删除默认压到 32% 透明、hover 才提亮（低频操作不再抢视觉）
 *
 * 契约不变（冒烟按这些取样，一个都不能少）：`.sched-row`×N、`.sched-badge`
 * （cls + text + title）、`.sched-next`（开着含"下次"、关着含"已关闭"）、
 * `input[data-name]` / `input[data-time]`、`button[data-save]` / `button[data-del]`、
 * `#btn-sched-add` / `#sched-new-id` / `#sched-new-time`。
 */

/** 绝对下次触发时间 → "今天/明天/日期 + HH:MM"（纯读数，不改任何数据） */
export function humanNext(next) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(String(next || ''))
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((d - today) / 86400000)
  if (days === 0) return `今天 ${m[4]}`
  if (days === 1) return `明天 ${m[4]}`
  return `${m[2]}-${m[3]} ${m[4]}`
}

/** HH:MM → 一天中的位置（0–100%）；拿不到时间返回 null（该槽位不进时刻线） */
export function dayPos(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''))
  if (!m) return null
  return Math.max(0, Math.min(100, ((Number(m[1]) * 60 + Number(m[2])) / 1440) * 100))
}

/**
 * 顶部读数（v2.93）：h2 徽标给"几个槽位、开了几个"，时刻线右侧给"最近一班是哪班"。
 * 为什么加：此前"开了几个/下次跑什么"只能逐个读六行，扫不出总量。
 */
function renderScheduleReadout(slots, projectId) {
  const on = slots.filter((s) => s.enabled)
  const badge = $('#sched-summary')
  if (badge) {
    badge.textContent = `${slots.length} 槽位 · ${on.length} 开启`
    badge.className = 'badge ' + (on.length ? 'partial' : 'draft')
    badge.title = on.length
      ? `已开启：${on.map((s) => s.label || s.slot).join('、')}`
      : projectId
        ? '全部关闭：定时任务不会触发'
        : '默认域没有槽位：槽位按项目安装，先选一个项目'
  }
  const hint = $('#sched-day-hint')
  if (hint) {
    // 2026-09-25：引擎侧「日历提醒」退役后，默认域**真的**没有任何槽位（槽位按项目安装）。
    // 此前那句"默认域 · 只显示引擎任务"随之作废——再留着它就会指着一条不存在的路。
    if (!projectId && !slots.length)
      hint.textContent = '默认域没有槽位：槽位按项目安装，先选一个项目'
    else if (!on.length) hint.textContent = '全部关闭 · 定时任务不会触发'
    else {
      const soon = on
        .filter((s) => s.next)
        .sort((a, b) => String(a.next).localeCompare(String(b.next)))[0]
      hint.textContent = soon
        ? `最近一班 ${humanNext(soon.next)} ${soon.label || soon.slot}`
        : `已开启 ${on.length}/${slots.length}`
    }
  }
  const track = $('#sched-day')
  if (!track) return
  // 班次按时间排序后**分行使标签互不相交**。
  //
  // 为什么不能只错两行：时刻线上可能有多班，其中 12:00 / 12:30 / 13:10 这类会挤在半小时内
  // ——两行必然叠字（实测踩到）。
  // 现在按**估算宽度贪心分行**（最多 3 行）：同行的上一班右缘与这一班左缘留出间隙才放行，
  // 放不下就换下一行；3 行都放不下时选"右缘最靠左"的那行（至少叠得最少）。
  // 宽度只能估算（真实字体度量要等布局完成），所以刻意**高估**：宁可多换行，不要叠字。
  const ordered = [...slots].sort((a, b) => String(a.time).localeCompare(String(b.time)))
  const trackW = track.clientWidth || 680
  const estWidth = (s) => {
    const name = String(s.label || s.slot || '')
    let cjk = 0
    for (const ch of name) if (ch.codePointAt(0) > 0x2e80) cjk += 1
    const ascii = name.length - cjk
    return Math.max(40, cjk * 11.5 + ascii * 6.5 + 12)
  }
  const rowRight = [] // 每行已放标签的右缘（px）
  const ticks = ordered
    .map((s) => {
      const pos = dayPos(s.time)
      if (pos === null) return null
      const center = (pos / 100) * trackW
      const w = estWidth(s)
      const left = center - w / 2
      const right = left + w
      let row = rowRight.findIndex((r) => r + 6 <= left)
      if (row < 0) {
        if (rowRight.length < 3) row = rowRight.length
        else {
          let min = 0
          for (let i = 1; i < rowRight.length; i++) if (rowRight[i] < rowRight[min]) min = i
          row = min
        }
      }
      rowRight[row] = Math.max(rowRight[row] ?? -Infinity, right)
      return { s, pos, w, row }
    })
    .filter(Boolean)
  track.innerHTML = ticks
    .map(({ s, pos, w, row }, i) => {
      const edge = pos < 6 ? ' is-edge-l' : pos > 94 ? ' is-edge-r' : ''
      // 贴边时标签不再居中，估算宽度也随之减半——否则会把本该同行的班次挤到下一行
      const half = edge ? 0 : w / 2
      void half
      return (
        `<i class="sched-tick${edge}" data-row="${row}" data-state="${s.enabled ? 'on' : 'off'}"` +
        ` data-idx="${i}" style="left:${pos.toFixed(2)}%"` +
        ` title="${escapeAttr(s.time)} ${escapeAttr(s.label || s.slot)}${s.enabled ? '' : '（已关闭）'}"` +
        `><b class="sched-tick-dot"></b>` +
        `<span class="sched-tick-time">${escapeHtml(s.time)}</span>` +
        `<span class="sched-tick-name">${escapeHtml(s.label || s.slot)}</span></i>`
      )
    })
    .join('')
}

/**
 * 「连续多天没有产出」判据（2026-09-25 从 Console 工作流页的健康卡迁入）。
 *
 * 为什么单独抽出来：槽位行徽标与顶部提示区给的是**同一件事**，两处判据必须逐字一致，
 * 否则会出现"行上有警告、顶上没提示"这类自相矛盾的界面。
 *
 * 判据与原健康卡完全一致：启用 且 命令可解析 且 **有产出记录**且距今 > 2 天。
 * `daysSince === null` 表示从未运行 —— 不告警（否则新加的槽位第一天就误报）。
 */
const STALE_DAYS = 2
function isStaleSlot(s) {
  return !!(s && s.enabled && !s.commandMissing && s.daysSince !== null && s.daysSince > STALE_DAYS)
}
function staleSlots(list = []) {
  return (list || []).filter(isStaleSlot)
}

/**
 * 调度提示区（v2.3）：把"为什么定时不会跑"直接摆在调度区顶部。
 *
 * 四条都属于**到点才发现**的失败，因此必须在打开页面时就说出来：
 *   · 还留着旧的 launchd/systemd 任务 → 会与内置定时器**双发**（给迁移命令）
 *   · 内置定时器没有宿主进程 → 到点不会触发（给启动命令）
 *   · 哪些槽位缺命令声明（命令来自项目 `.crosspost/schedule.json`）
 *   · 哪些槽位连续多天没有产出（2026-09-25 从工作流页迁入；原来只在工作流页的健康卡里）
 *
 * **这里只放"会妨碍定时运行、且有动作可做"的事**（2026-09-25 二次收敛）。
 * 反面例子：曾把"常驻服务（无到点触发的执行器 plist）"也摆进来 —— 它既不是失败、
 * 也没有动作可做，只要项目用 http 执行器就**永远**在，只会把上面几行真话稀释掉
 * （后来的误报正是这么被漏看的）。那类信息属于**按需诊断**：
 * `npm run doctor`（`scheduler-services` 一项）与 `scheduler-cli.mjs tasks`。
 */
function renderScheduleNotices(status) {
  const box = $('#sched-notices')
  if (!box) return
  const notes = []
  for (const legacy of status.legacyTasks || [])
    notes.push({
      kind: 'legacy',
      text: `旧的系统调度任务仍在：${legacy.unit || legacy.label || ''}（会与内置定时器双发）`,
    })
  if (status.lockHeldByUs === false)
    notes.push({
      kind: 'host',
      text: '内置定时器当前不由本进程持有：启动桥（node bridge/run-bridge.mjs）或独立调度（node crosspost-runtime/src/commands/scheduler-cli.mjs run）后才会触发。',
    })
  const stale = staleSlots(status.slots)
  if (stale.length)
    notes.push({
      kind: 'stale',
      text: `这些槽位连续 ${STALE_DAYS} 天以上没有产出：${stale
        .map((s) => `${s.label || s.slot}（${s.daysSince} 天）`)
        .join('、')}。点该行「立即运行」跑一次，再看该项目的 logs/。`,
    })
  for (const w of status.warnings || []) notes.push({ kind: 'warn', text: w })
  if (!notes.length) {
    box.innerHTML = ''
    box.hidden = true
    return
  }
  box.hidden = false
  box.innerHTML =
    notes
      .map(
        (n) =>
          `<div class="sched-notice is-${escapeAttr(n.kind)}">${escapeHtml(n.text)}` +
          (n.kind === 'legacy'
            ? ' <code>node crosspost-runtime/src/commands/scheduler-cli.mjs migrate</code>'
            : '') +
          `</div>`,
      )
      .join('') +
    `<div class="sched-notice-meta">后端 ${escapeHtml(status.backend || '?')} · 时区 ${escapeHtml(status.tz || '?')} · 补跑窗口 ${escapeHtml(String(status.catchUpMaxMinutes ?? '?'))} 分钟 · 数据 ${escapeHtml(status.schedulerDir || '?')}</div>`
}

function renderSchedule(slots) {
  const list = $('#schedule-list')
  // 项目来自最后一次取到的响应（每个调用点都会先写 store.scheduleData）：
  // 空 = 默认域（未选项目），此时"没有槽位"是正常的，不是没装调度器。
  const projectId = (store.scheduleData && store.scheduleData.project) || null
  renderScheduleReadout(slots, projectId)
  list.innerHTML = slots
    .map((s) => {
      const b = schedBadge(s, projectId)
      // v2.3：命令由项目声明，所以"能不能改"不再等于"有没有 plist"，
      // 而是"这个槽位的定义在哪儿"：声明过的 → 可改名称/时间。
      // 2026-09-25：引擎侧任务退役后不再有"只可开关"的那一类。
      const editable = !!s.editable
      const disabledAttr = editable ? '' : 'disabled'
      const stale = isStaleSlot(s)
      const state =
        (s.unfinished
          ? `<span class="sched-drift" title="今天触发过一次但没写回结果">未收尾</span>`
          : s.completedToday
            ? `<span class="sched-drift is-ok" title="今天已经跑过一次">今日已跑</span>`
            : '') +
        (stale
          ? `<span class="sched-drift is-stale" title="连续 ${s.daysSince} 天没有产出：点右侧「立即运行」跑一次，再看该项目的 logs/">⚠ ${s.daysSince} 天未产出</span>`
          : '')
      const nextText = s.commandMissing
        ? '缺命令声明'
        : !s.enabled
          ? '已关闭，不会触发'
          : `下次 ${escapeHtml(humanNext(s.next) || '—')}`
      const runBtn = s.commandMissing
        ? ''
        : `<button class="btn btn-mini" data-run="${escapeAttr(s.slot)}"
                 title="立即运行一次（不受「每天最多一次」限制）">立即运行</button>`
      const delBtn = s.removable
        ? `<button class="btn btn-mini danger" data-del="${escapeAttr(s.slot)}"
                 title="删除该槽位的引擎侧记录（命令声明在项目里，需自行删除）">删除</button>`
        : `<button class="btn btn-mini danger" data-del="${escapeAttr(s.slot)}" disabled
                 title="命令声明在项目的 .crosspost/schedule.json 里：请从该文件删除这一条">删除</button>`
      return `
    <div class="sched-row" data-slot="${escapeAttr(s.slot)}" data-state="${b.cls}">
      <input class="sched-time-in" type="time" data-time="${escapeAttr(s.slot)}" value="${escapeAttr(s.time)}"
             ${disabledAttr} aria-label="触发时间" title="${escapeAttr(editable ? '触发时间（保存后写进项目设置；命令与工作目录仍由项目的 .crosspost/schedule.json 决定）' : '时间由项目声明，这里不可改')}" />
      <div class="sched-id-col">
        <input class="sched-name" data-name="${escapeAttr(s.slot)}" value="${escapeAttr(s.label)}"
               ${disabledAttr} aria-label="显示名称" title="${escapeAttr(editable ? '显示名称（只影响 Console 显示；不影响流水线行为）' : '该槽位不可改名')}" />
        <span class="sched-slot">${escapeHtml(s.slot)}${s.source === 'config' ? ' · 未声明' : ''}<span class="sched-exec" title="${escapeAttr(
          s.executor && s.executor.kind === 'http'
            ? `基座不跑项目脚本：到点由引擎 POST ${s.executor.url}，执行在项目自己的环境里${s.executor.gateway ? `（容器模式：实际拨号 ${s.executor.gateway.to}）` : ''}`
            : '本地命令执行器：到点时基座在本进程/容器里 spawn 该项目声明的命令',
        )}"> · ${s.executor && s.executor.kind === 'http' ? (s.executor.unavailable ? '执行器:http（不可用）' : '执行器:http') : '执行器:本地'}</span>${state}</span>
      </div>
      <span class="sched-badge ${b.cls}" title="${escapeAttr(b.title)}">${escapeHtml(b.text)}</span>
      <div class="sched-next" title="${escapeAttr(s.commandMissing ? s.commandReason || '' : '引擎内置定时器的下一次触发')}">${nextText}</div>
      <div class="sched-ops">
        <button class="btn btn-mini" data-save="${escapeAttr(s.slot)}" ${editable ? '' : 'disabled'}
                title="${escapeAttr(editable ? '保存名称/时间（写进当前项目的设置）' : '该槽位不可编辑')}">保存</button>
        ${runBtn}
        ${delBtn}
        <label class="switch">
          <input type="checkbox" data-slot="${escapeAttr(s.slot)}" ${s.enabled ? 'checked' : ''} ${s.commandMissing ? 'disabled' : ''}
                 aria-label="${escapeAttr((s.label || s.slot) + ' 定时任务')}" />
          <span class="slider"></span>
        </label>
      </div>
    </div>`
    })
    .join('')

  renderScheduleNotices(store.scheduleData || {})

  // 改动未保存 → 行标 `.is-dirty`（保存按钮由 32% 提到实心）；Enter 直接保存。
  // 为什么加：此前把名称/时间改了一半没点保存，界面与"已保存"长得一模一样。
  list.querySelectorAll('.sched-row').forEach((row) => {
    row.querySelectorAll('input[data-name], input[data-time]').forEach((inp) => {
      inp.addEventListener('input', () => row.classList.add('is-dirty'))
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        const btn = row.querySelector('button[data-save]')
        if (btn) btn.click()
      })
    })
  })

  // 保存（名称 + 时间）→ /proxy/schedule/upsert
  list.querySelectorAll('button[data-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slot = btn.dataset.save
      const name = (list.querySelector(`input[data-name="${slot}"]`) || {}).value || slot
      const time = (list.querySelector(`input[data-time="${slot}"]`) || {}).value || ''
      const msg = $('#sched-msg')
      msg.className = 'repub-result'
      msg.textContent = '正在保存…'
      try {
        const r = await postJSON('/proxy/schedule/upsert', { id: slot, name, time })
        if (r.error) throw new Error(r.message || r.error)
        store.scheduleData = await getJSON('/proxy/schedule')
        renderSchedule(store.scheduleData.slots)
        msg.className = 'repub-result ok'
        msg.textContent = `已保存 ${slot}：${name} @ ${time}${r.action === 'created' ? '（新建）' : ''}`
      } catch (e) {
        msg.className = 'repub-result err'
        msg.textContent = '保存失败: ' + String(e.message || e)
      }
    })
  })

  // 删除 → /proxy/schedule/remove（只删引擎侧记录；命令声明的删除在项目里）
  list.querySelectorAll('button[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slot = btn.dataset.del
      if (
        !window.confirm(
          `删除槽位 ${slot} 的引擎侧记录？（命令声明在项目的 .crosspost/schedule.json 里，需要你自己删）`,
        )
      )
        return
      const msg = $('#sched-msg')
      try {
        const r = await postJSON('/proxy/schedule/remove', { slot })
        if (r.error) throw new Error(r.message || r.error)
        store.scheduleData = await getJSON('/proxy/schedule')
        renderSchedule(store.scheduleData.slots)
        msg.className = 'repub-result ok'
        msg.textContent = `已删除 ${slot}`
      } catch (e) {
        msg.className = 'repub-result err'
        msg.textContent = '删除失败: ' + String(e.message || e)
      }
    })
  })
  list.querySelectorAll('input[data-slot]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const slot = inp.dataset.slot
      const msg = $('#sched-msg')
      msg.className = 'repub-result'
      msg.innerHTML =
        '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>正在切换…'
      try {
        const r = await postJSON('/proxy/schedule', { slot, enabled: inp.checked })
        if (r.error) throw new Error(r.error)
        store.scheduleData = r
        renderSchedule(r.slots)
        msg.className = 'repub-result ok'
        msg.textContent = `${slot} ${inp.checked ? '已开启' : '已关闭'}${
          inp.checked && r.armed === false ? '（注意：当前未生效，见上方提示）' : ''
        }`
      } catch (e) {
        inp.checked = !inp.checked
        msg.className = 'repub-result err'
        msg.textContent = String(e.message || e)
      }
    })
  })

  // 立即运行（v2.3）：不受"每天最多一次"限制；沿用删除类操作的授权约定。
  list.querySelectorAll('button[data-run]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slot = btn.dataset.run
      const msg = $('#sched-msg')
      msg.className = 'repub-result'
      msg.textContent = `正在启动 ${slot}…`
      try {
        const r = await postJSON('/proxy/schedule/run', { slot, authorized: true })
        if (!r.ok) throw new Error(r.error || '未触发')
        msg.className = 'repub-result ok'
        msg.textContent = `${slot} 已启动（pid=${r.pid}）；日志在该项目的 logs/scheduler-${slot}.out.log`
        store.scheduleData = await getJSON('/proxy/schedule')
        renderSchedule(store.scheduleData.slots)
      } catch (e) {
        msg.className = 'repub-result err'
        msg.textContent = '触发失败: ' + String(e.message || e)
      }
    })
  })
}

/* ── 默认推送平台配置（2026-08-20 / 2026-08-25 分组美化） ────────── */
let pfQuery = ''

/** 当前勾选集（**活状态**：用户勾了但还没点保存的那些也算）。
 *
 *  为什么不能每次渲染都从配置重建（v2.96.1 修的 bug）：
 *  `renderPlatformGrid()` 会被三处调用 —— 进设置页 / 搜索框输入 / 平台登录态刷新
 *  （后者每 60s 一次）。前两处之外的调用如果拿"已保存的配置"当勾选集，
 *  用户**刚勾上但未保存**的选择会被静默抹掉。现场复现：
 *    勾上简书 → 读数 13 → 搜索框敲一个「简」→ 读数掉回 0 → 清空搜索 → 回到 12，
 *    简书的勾没了。用户以为"勾选不生效"。
 *  现在改为：DOM 里的勾选框是唯一真值，`pfSelection` 只是它的镜像；
 *  只有 `loadSettings()`（权威加载：进设置页 / 切项目 / 点刷新）才从配置重置它。 */
let pfSelection = null

/** 把 DOM 的勾选状态并进 pfSelection（并在任何批量改动后刷新读数）。
 *  **只更新当前渲染出来的那些行**，不是整体重建：搜索过滤时 DOM 只是一个子集，
 *  整体重建会把"被过滤掉但已勾选"的平台悄悄删掉（那正是上一版读数变小的同一个坑）。 */
function syncPfSelection() {
  const boxes = [...document.querySelectorAll('#pf-grid input[type="checkbox"]')]
  if (pfSelection instanceof Set) {
    for (const i of boxes) {
      if (i.checked) pfSelection.add(i.value)
      else pfSelection.delete(i.value)
    }
  } else {
    pfSelection = new Set(boxes.filter((i) => i.checked).map((i) => i.value))
  }
  renderPfStats()
}

/**
 * 全量设置勾选（「全选」/「清空」用）：作用于**整个平台集**，不是屏幕上的子集。
 * 过滤状态下点「清空」却只清掉看得见的几行，是比不做更坏的行为。
 * 用 PANEL_PLATFORMS 而不是"扫描 DOM 里没禁用的"：模型 A 下没有任何平台因登录态被禁用
 * （那正是"新登录平台加不进默认推送"的死锁），而扫描 DOM 在过滤时还会漏掉看不见的行。
 */
function setAllPfSelection(on) {
  pfSelection = on ? new Set(PANEL_PLATFORMS) : new Set()
  renderPlatformGrid(getDefaultPlatforms())
}

function pfStats() {
  const total = PANEL_PLATFORMS.length
  // v2.96.1：读数取**活选集**，不取屏幕上的勾选框。
  // 搜索过滤时 DOM 里只剩匹配的那几行，按 DOM 数会在搜索框里读成「已勾选 1 / 27」——
  // 而用户并没有取消任何勾选。读数必须与"实际会推送的平台"一致，与过滤无关。
  const ids =
    pfSelection instanceof Set
      ? [...pfSelection]
      : [...document.querySelectorAll('#pf-grid input:checked')].map((i) => i.value)
  const authed = ids.filter((id) => store.platformAuth[id] === true).length
  return { total, checked: ids.length, authed }
}

function renderPfStats() {
  const s = pfStats()
  // v2.96：勾选总数从工具栏右侧的一行 12px 灰字，提到读数位（大号等宽数字）。
  // 这一节有 27 行平台，读者需要一个"现在选了几个"的总量读数，而不是一句话里的数字。
  const picked = $('#pf-picked')
  if (picked) picked.textContent = `${s.checked} / ${s.total}`
  // 2026-09-12 模型 A：勾选 = 推送 + 自动检查；已登录数只对勾选内的平台有意义
  // （未勾选的平台不该被读成"未登录"，需要时点行内 🔍 单独查一次）
  const stat = $('#pf-stat')
  if (stat) {
    const pending = s.checked - s.authed
    stat.textContent = `其中已登录 ${s.authed}${pending > 0 ? ` · 未登录 ${pending} 个将跳过` : ''}`
  }
}

function renderPlatformGrid(defaultList) {
  const grid = $('#pf-grid')
  // v2.96.1：勾选集**以活状态为准**（用户未保存的勾选必须活过重渲染）；
  // 只有 pfSelection 还没建立时（首次渲染）才退回传进来的配置列表。
  const sel = pfSelection instanceof Set ? pfSelection : new Set(defaultList || [])
  const q = pfQuery.trim().toLowerCase()
  // 2026-09-12 模型 A：一个勾选 = 「推它 + 自动查它」。
  //  · 勾上的平台进检查范围；没勾的不自动查，想看时点行内「🔍」（单平台立即查）或顶部全量按钮。
  //  · **任何平台都可勾**（不再因为"未登录"而灰掉——那正是"新登录平台加不进默认推送"的死锁）。
  //  · 微信/抖音可勾，但勾选只表示"纳入检查"（PF_LOCKED 文案已改成"仅检查·不派发"）。
  const scope = store.platformsScope
  const scopeIds = scope && Array.isArray(scope.ids) ? new Set(scope.ids) : null
  const groups = PLATFORM_GROUPS.map((g) => {
    const locked = g.key === 'locked'
    const vis = g.ids.filter((id) => {
      if (!q) return true
      return (PLATFORM_NAMES[id] || id).toLowerCase().includes(q)
    })
    if (!vis.length) return ''
    const items = vis
      .map((id) => {
        const name = PLATFORM_NAMES[id] || id
        const note = PF_LOCKED[id] // 仅检查平台的说明文案（不再是"不可选"理由）
        const authed = store.platformAuth[id]
        const checked = sel.has(id)
        const inScope = !scopeIds || scopeIds.has(id)
        const why = store.platformErrors && store.platformErrors[id]
        const tip = [
          note ? `${name}：${note}` : null,
          inScope
            ? authed === false
              ? `已勾选，当前未登录${why ? '（' + why + '）' : ''}；发布会自动跳过，登录后会自动恢复`
              : authed
                ? '已勾选，已登录'
                : store.platformsRefreshing || store.platformsInit
                  ? '已勾选，登录状态检查中…'
                  : '已勾选，登录状态未知'
            : '未勾选（不自动检查）；点右侧 🔍 可立即查一次登录状态',
        ]
          .filter(Boolean)
          .join(' · ')
        // v2.96：行内徽标从「✓ 已登录 / ⚠ 未登录 / · 未检查」三段**文字**压成一个字形。
        // 27 行里"· 未检查"要重复 25 遍——同一句话重复 25 遍就不再是信息，只是噪点；
        // 完整解释留在 title（原来就在），字形只负责"一眼扫出哪些是绿的"。
        // 未勾选的平台**不画任何字形**：它的登录态本来就不参与推送（勾选才自动检查），
        // 25 个"状态未知"的圈只是把 3 个真正要看的绿勾淹掉。
        // v2.96.1：这个淡点改成**始终渲染、由 CSS 在未勾选时隐藏**（`.pf-item:has(input:checked)`）。
        //   此前它在渲染期按 checked 决定画不画 → 用户现场勾上一个"状态未知"的平台时，
        //   勾号不会出现（见下一条注释），淡点也不会出现：整行毫无反应。
        const authBadge =
          authed === true
            ? '<span class="pf-auth ok" title="已勾选，已登录">✓</span>'
            : authed === false
              ? `<span class="pf-auth no" title="${escapeAttr(why || '未登录')}">!</span>`
              : '<span class="pf-auth unk" title="登录状态未知或检查中（未勾选时不显示）">·</span>'
        // v2.96.1：**去掉 data-on**。视觉不再依赖"渲染那一刻的快照"——
        //   原来 `data-on` 只在 renderPlatformGrid() 里写一次，而勾选框是浏览器自己翻转的，
        //   JS 不会重渲染 → 点了行、input.checked 变 true、读数从 12 变 13，
        //   但方框、勾号、左缘状态条全都不动（现场：勾简书毫无反应）。
        //   现在方框/状态条由 CSS `.pf-item:has(input:checked)` 直接读勾选框本身，
        //   与谁改了它、有没有重渲染都无关。
        return `<label class="pf-item" data-auth="${
          authed === true ? 'ok' : authed === false ? 'no' : 'unk'
        }" title="${escapeHtml(tip)}">
        <input type="checkbox" value="${id}" ${checked ? 'checked' : ''}>
        <span class="pf-box" aria-hidden="true"></span>
        <span class="pf-name">${escapeHtml(name)}</span>
        ${authBadge}
        ${note ? `<span class="pf-lock" title="${escapeAttr(note)}">仅检查</span>` : ''}
        <button class="pf-check-btn" type="button" data-check="${escapeAttr(id)}" title="立即查一次该平台登录状态（不影响勾选与范围）">🔍</button>
      </label>`
      })
      .join('')
    return `<div class="pf-group">
      <div class="pf-group-head">
        <span class="pf-group-title">${escapeHtml(g.title)}</span>
        <span class="pf-group-count">${vis.length}</span>
        ${!locked ? `<button class="btn mini pf-group-all" data-select="${escapeAttr(g.key)}" type="button">全选本组</button>` : ''}
      </div>
      <div class="pf-group-body">${items}</div>
    </div>`
  }).join('')
  grid.innerHTML = groups || (q ? '<span style="color:var(--ink-faint)">无匹配平台</span>' : '')
  // 组内全选：组内可见且未禁用项全选；若已全选则清空该组
  grid.querySelectorAll('button[data-select]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const box = btn.closest('.pf-group')
      const boxes = [...box.querySelectorAll('input:not(:disabled)')]
      const allOn = boxes.every((i) => i.checked)
      boxes.forEach((i) => {
        i.checked = !allOn
      })
      // v2.96.1：批量改勾选必须同步活选集（否则下次重渲染又按旧选集重建）
      syncPfSelection()
    })
  })
  // 勾选变化 → 同步活选集 + 刷新统计
  grid.querySelectorAll('input[type="checkbox"]').forEach((i) => {
    i.addEventListener('change', syncPfSelection)
  })
  // 行内「🔍 查一下」（2026-09-12 模型 A）：单平台立即检查，不改勾选、不订阅自动重查。
  // 按钮嵌在 <label> 里，必须 preventDefault，否则会顺带把该行勾选状态切反。
  grid.querySelectorAll('button[data-check]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (btn.disabled) return
      const id = btn.dataset.check
      btn.disabled = true
      btn.textContent = '…'
      try {
        const r = await getJSON(`/proxy/platforms?check=${encodeURIComponent(id)}&wait=1`)
        applyAuthPayload(r) // 触发订阅者重渲染 → 该行徽标立即变成真实状态
      } catch {
        /* 单点检查失败：保持旧徽标，等状态轮询兜底 */
      } finally {
        btn.disabled = false
        btn.textContent = '🔍'
      }
    })
  })
  renderPfStats()
}

async function savePlatforms() {
  const msg = $('#pf-msg')
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>保存中…'
  // v2.96.1：**必须用活选集，不能用屏幕上的勾选框**。
  // 此前在搜索框里筛出 3 个平台再点「保存平台配置」，写进去的就只有这 3 个 ——
  // 其余 9 个被静默删掉（保存是不可逆的，这个 bug 比"勾了没反应"更贵）。
  const list =
    pfSelection instanceof Set
      ? [...pfSelection]
      : [...document.querySelectorAll('#pf-grid input:checked')].map((i) => i.value)
  try {
    const r = await postJSON('/proxy/config', { platforms: { default: list } })
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = `已保存（${list.length} 个平台）✓`
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '保存失败: ' + String(e.message || e)
  }
}

async function setAllSchedule(enabled) {
  const msg = $('#sched-msg')
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>批量设置中…'
  const fail = []
  for (const s of (store.scheduleData && store.scheduleData.slots) || []) {
    // v2.3：能开关的条件是"命令声明可解析"（以前是"装了 plist"）。
    // 缺声明的槽位开了也不会跑，所以批量操作把它们单独报出来，而不是假装成功。
    if (s.commandMissing) {
      fail.push(`${s.slot}(缺命令声明)`)
      continue
    }
    try {
      const r = await postJSON('/proxy/schedule', { slot: s.slot, enabled })
      if (r.error) fail.push(s.slot)
    } catch {
      fail.push(s.slot)
    }
  }
  const fresh = await getJSON('/proxy/schedule')
  store.scheduleData = fresh
  renderSchedule(fresh.slots)
  // 配置写了但仍未生效的槽位要说出来（可能没拿到调度锁），别只报"已全部关闭"
  const notArmed = (fresh.slots || [])
    .filter((s) => s.enabled && s.armed === false)
    .map((s) => s.slot)
  msg.className = 'repub-result ' + (fail.length || notArmed.length ? '' : 'ok')
  msg.textContent = fail.length
    ? `部分失败: ${fail.join(',')}`
    : notArmed.length
      ? `已全部${enabled ? '开启' : '关闭'}，但未生效: ${notArmed.join(',')}（见上方提示）`
      : `已全部${enabled ? '开启' : '关闭'}`
}

async function saveNotify() {
  const msg = $('#notify-msg')
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>保存中…'
  const notify = {
    enabled: $('#n-enabled').checked,
    channel: $('#n-channel').value,
    larkChatId: $('#n-lark-chat').value.trim(),
    webhookUrl: $('#n-webhook').value.trim(),
    webhookType: $('#n-webhook-type').value,
    idempotencyPrefix: 'crosspost',
    template: {
      title: $('#n-tpl-title').value,
      summary: $('#n-tpl-summary').value,
      footer: $('#n-tpl-footer').value,
    },
  }
  try {
    const r = await postJSON('/proxy/config', { notify })
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = '已保存 ✓'
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '保存失败: ' + String(e.message || e)
  }
}

/** 通知通道自检（2026-09-11）：用当前配置真实发一条；把「API 已接收」与「你看到了」分开表述。 */
async function testNotify() {
  const msg = $('#notify-msg')
  const btn = $('#btn-test-notify')
  if (btn) btn.disabled = true
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>发送中…'
  try {
    const r = await postJSON('/proxy/notify-test', {})
    if (r && r.deduped) {
      msg.className = 'repub-result err'
      msg.textContent = `⚠ 飞书已去重，本次未产生新消息（幂等键重复：${String(r.key || '').slice(0, 24)}…）；请稍后重试`
    } else if (r && r.status === 'ok') {
      msg.className = 'repub-result ok'
      msg.textContent =
        `✓ 渠道 API 已接收${r.messageId ? '（messageId ' + String(r.messageId).slice(0, 18) + '…）' : ''}` +
        ` · 渠道 ${r.channel || '-'}${r.chatId ? ' · 目标 ' + r.chatId : ''} · 幂等键 ${String(r.key || '').slice(0, 20)}… —— 请到该会话确认是否收到；没收到通常是"不在该会话 / 会话免打扰"`
    } else {
      msg.className = 'repub-result err'
      msg.textContent =
        `✕ 未发送（${(r && r.status) || '未知'}）：` +
        ((r && r.error) || '检查"通知启用 / 渠道 / 会话 ID"设置后重试')
    }
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '测试通知失败: ' + String(e.message || e)
  } finally {
    if (btn) btn.disabled = false
  }
}

/** 保存评分阈值 + 投资风险词（独立卡片；只发 scoring，不影响 notify） */
async function saveScoring() {
  const msg = $('#scoring-msg')
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>保存中…'
  const thr = Number($('#s-threshold').value)
  // v2.96：分词逻辑与词卡编辑器共用 parseRiskWords（此前这里内联一份、词卡再写一份，
  // 两处一旦漂移就会出现"删了卡还在"的现象）
  const parseWords = parseRiskWords
  const scoring = {
    threshold: Number.isFinite(thr) ? Math.max(0, Math.min(100, Math.round(thr))) : SCORE_PASS,
    investment: {
      strong: parseWords($('#inv-strong').value),
      weak: parseWords($('#inv-weak').value),
    },
  }
  try {
    const r = await postJSON('/proxy/config', { scoring })
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = '已保存 ✓'
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '保存失败: ' + String(e.message || e)
  }
}

async function backupNow() {
  const msg = $('#backup-msg')
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>备份中…'
  try {
    const r = await postJSON('/proxy/backup', {}, { timeoutMs: 180000 })
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = r.file ? '已备份 ✓' : r.note || '完成'
    loadSettings()
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '备份失败: ' + String(e.message || e)
  }
}

/** 视图初始化：绑定设置页事件 */
export function initSettingsView() {
  $('#btn-sched-all-on').addEventListener('click', () => setAllSchedule(true))
  $('#btn-sched-all-off').addEventListener('click', () => setAllSchedule(false))
  // 新增槽位（v2.84）：id 是技术键（= 流水线 模式=<id>），名称只影响显示
  const addBtn = $('#btn-sched-add')
  if (addBtn)
    addBtn.addEventListener('click', async () => {
      const msg = $('#sched-msg')
      const id = ($('#sched-new-id') || {}).value || ''
      const name = ($('#sched-new-name') || {}).value || ''
      const time = ($('#sched-new-time') || {}).value || ''
      const enabled = !!($('#sched-new-enabled') || {}).checked
      msg.className = 'repub-result'
      msg.textContent = '正在写入槽位定义…'
      try {
        const r = await postJSON('/proxy/schedule/upsert', { id, name, time, enabled })
        if (r.error) throw new Error(r.message || r.error)
        store.scheduleData = await getJSON('/proxy/schedule')
        renderSchedule(store.scheduleData.slots)
        msg.className = 'repub-result ok'
        msg.textContent = `已创建槽位 ${r.slot} @ ${r.time}${r.enabled ? '（已启用）' : '（默认关闭）'}`
      } catch (e) {
        msg.className = 'repub-result err'
        msg.textContent = '创建失败: ' + String(e.message || e)
      }
    })
  // 生成后自动推送开关（2026-09-12：从 loadSettings() 挪到这里，保证只绑定一次）
  $('#ap-enabled').addEventListener('change', () => saveAutoPush())
  $('#ap-include-wechat').addEventListener('change', () => saveAutoPush())
  $('#btn-save-notify').addEventListener('click', saveNotify)
  const testNotifyBtn = $('#btn-test-notify')
  if (testNotifyBtn) testNotifyBtn.addEventListener('click', testNotify)
  $('#btn-save-scoring').addEventListener('click', saveScoring)
  $('#btn-brand-apply').addEventListener('click', saveBrandIcon)
  $('#btn-brand-reset').addEventListener('click', resetBrandIcon)
  // v2.96.1：这两个按钮此前**只改勾选框、既不刷新读数、也不管过滤**——
  // 过滤状态下点「清空」只清掉看得见的几行，看不见的仍勾着，却读不出来。
  // 现在作用于整个平台集并整表重渲染（读数由 renderPfStats 跟着走）。
  $('#btn-pf-all').addEventListener('click', () => setAllPfSelection(true))
  $('#btn-pf-none').addEventListener('click', () => setAllPfSelection(false))
  $('#btn-save-platforms').addEventListener('click', savePlatforms)
  $('#n-channel').addEventListener('change', syncNotifyRows)
  // v2.96 新增交互（都是"显示器"，不碰保存语义）：
  //  · 阈值刻度盘：range ↔ number 双向同步（真值 #s-threshold）
  //  · 风险词卡：回车 / 逗号 / 顿号 / 失焦落词，写回隐藏 textarea
  //  · 「启用通知」总闸：只切视觉（.notify-off），不发请求 —— 保存仍由「保存设置」触发
  const thrRange = $('#s-threshold-range')
  if (thrRange) {
    thrRange.addEventListener('input', () => syncThresholdDial('range'))
    $('#s-threshold').addEventListener('input', () => syncThresholdDial('num'))
  }
  bindRiskChipAdd('strong')
  bindRiskChipAdd('weak')
  const nEnabled = $('#n-enabled')
  if (nEnabled) nEnabled.addEventListener('change', syncNotifyEnabledLook)
  $('#btn-backup-now').addEventListener('click', backupNow)
  // 代理配置 / 样式库（2026-08-25 自 DSH 设置页合并）
  $('#btn-save-proxy').addEventListener('click', saveProxyConfig)
  // 立即检查平台状态（2026-09-11：只触发 bridge 后台检查，不阻塞页面）
  const checkBtn = $('#btn-check-platforms')
  if (checkBtn) checkBtn.addEventListener('click', triggerPlatformCheck)
  // 平台检查完成后刷新平台网格徽标（仅设置视图可见时）
  onPlatformAuthChange(() => {
    if (isSettingsActive()) renderPlatformGrid(getDefaultPlatforms())
  })
  // 搜索过滤（2026-08-25 分组美化）
  $('#pf-q').addEventListener('input', (e) => {
    pfQuery = e.target.value
    renderPlatformGrid(getDefaultPlatforms())
  })
  initStyleSection()
}

/* ── Bridge 状态 / 代理配置 / 样式库（2026-08-25 自 DSH 设置页合并；
      2026-09-11：状态改为「定期自动检查的结果」展示 + 可配轮询间隔 ── */

/** 相对时间（秒/分/小时前） */
function fmtAgo(ts) {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return s + ' 秒前'
  if (s < 3600) return Math.round(s / 60) + ' 分钟前'
  return Math.round(s / 3600) + ' 小时前'
}

/** 相对未来时间（秒/分后） */
function fmtIn(ts) {
  if (!ts) return '—'
  const s = Math.round((ts - Date.now()) / 1000)
  if (s <= 0) return '即将'
  if (s < 60) return s + ' 秒后'
  if (s < 3600) return Math.round(s / 60) + ' 分钟后'
  return Math.round(s / 3600) + ' 小时后'
}

/** 渲染状态条（v2.96（下））：四格指标 —— 连接 / 代理来源 / 检查范围 / 失败平台。
 *
 *  2026-09-12 改造背景（保留）：此前只显示「失败平台重查：a / b / c（60 秒窗口）」，
 *  没说是"查哪些平台"、为什么失败、失败几次——排查"4 个平台永久失败"耗了 20 分钟，
 *  根因是「面板在 Google Chrome、代理扩展在 360Chrome」。
 *
 *  v2.96（下） 只改**读法**：这四件事此前挤在 4 个 `.b-head` 行里，其中一行是
 *  「21 分钟前 · 2 / 27 个平台（勾选即自动检查 · 含仅检查 2） · 下次 39 分钟后 · 检查并发 6」
 *  —— 一串 `·` 里塞了 6 个数字，读者得逐个定位。现在每格一句标签 + 一个主读数 + 一行
 *  注解：先读"是什么"，再读"多少"，细节退到第三行。
 *  内容一字未删；契约照旧：验收断言 `#bridge-status` 文本含「检查范围」「代理来源」。 */
function renderBridgeStatus(st) {
  const el = $('#bridge-status')
  if (!el) return
  const p = (st && st.platforms) || {}
  const ok = !!(st && st.connected)
  const extSeen = !!(st && st.ext && st.ext.seen)
  // 连接状态补断开时间/最近心跳，区分"扩展没启动"与"刚掉线"
  const hbAgo = st && st.ext && st.ext.lastPushAt ? fmtAgo(st.ext.lastPushAt) : null

  // 代理来源身份（2026-09-12）：UA 只给个简短版本号，避免整行过长；clientId 用于区分浏览器
  const cl = (st && st.ext && st.ext.client) || null
  const uaTag =
    cl && cl.ua ? (String(cl.ua).match(/(Chrome|Firefox|Edg|Safari)\/[\d.]+/g) || []).join(' ') : ''

  // 检查范围 = 勾选的平台（模型 A）；未勾选的平台不自动检查，可点行内 🔍 单独查
  const sc = p.scope || null
  const scopeValue = sc
    ? sc.mode === 'fallback-all'
      ? `${sc.count} / ${sc.all} 个平台`
      : `${sc.count} / ${sc.all} 个平台`
    : '读取中…'
  const scopeWarn = sc && sc.mode === 'fallback-all'
  const scopeNote = sc
    ? sc.mode === 'fallback-all'
      ? '一个都没勾，已回退全量检查'
      : `勾选即自动检查${(sc.checkOnly || []).length ? ` · 含仅检查 ${(sc.checkOnly || []).length}` : ''}`
    : ''
  const whenNote = p.refreshing
    ? '<span class="spinner spin-ink"></span>检查中…'
    : p.init
      ? '尚未检查（等待后台自动检查）'
      : p.lastError
        ? `<span class="bx-bad">上次检查失败（${escapeHtml(String(p.lastError).slice(0, 40))}）· 数据 ${fmtAgo(p.checkedAt)}</span>`
        : `${fmtAgo(p.at || p.checkedAt)} · 下次 ${fmtIn(p.nextCheckAt)} · 检查并发 ${p.checkConcurrency || 6}`
  const excludedNote =
    sc && sc.mode !== 'fallback-all' && sc.excluded && sc.excluded.length
      ? `未勾选 ${sc.excluded.length} 个（不自动检查；需要时点行内 🔍 或「立即检查平台状态」）`
      : ''

  // 失败平台（检查范围内）——带次数、最后成功时间、退避/终态，而不是只说"未登录"
  const detail = p.failedDetail || []
  const retryIds = p.failedRetryIds || []
  const needIds = p.needsLoginIds || []
  const detailText = detail
    .map((d) => {
      const name = escapeHtml(PLATFORM_NAMES[d.id] || d.id)
      if (d.status === 'needs_login') return `${name}（已停止自动重查 · 需重新登录）`
      const parts = [`第 ${d.consecutiveFails} 次失败`]
      if (d.lastAuthAt) parts.push(`最后成功 ${fmtAgo(d.lastAuthAt)}`)
      else parts.push('从未登录成功')
      if (d.nextRetryAt) parts.push(`下次 ${fmtIn(d.nextRetryAt)}`)
      return `${name}（${parts.join(' · ')}）`
    })
    .join(' / ')
  const failedCount = detail.length || retryIds.length + needIds.length
  const retryValue = detail.length
    ? `${failedCount} 个`
    : retryIds.length || needIds.length
      ? `${failedCount} 个`
      : '无'
  const retryNote = detail.length
    ? detailText
    : retryIds.length || needIds.length
      ? [...retryIds, ...needIds].map((id) => escapeHtml(PLATFORM_NAMES[id] || id)).join(' / ')
      : '检查范围内没有失败平台'

  const tile = (state, k, v, note) =>
    `<div class="bx-tile" data-state="${state}">
       <span class="bx-k">${k}</span>
       <span class="bx-v">${v}</span>
       ${note ? `<span class="bx-n">${note}</span>` : ''}
     </div>`

  el.innerHTML = [
    tile(
      ok ? 'ok' : 'fail',
      '连接',
      ok ? '已连接' : extSeen ? '连接已断开' : '未连接',
      [
        `最近代理请求 ${st && st.lastProxyAt ? new Date(st.lastProxyAt).toLocaleTimeString() : '-'}`,
        extSeen && hbAgo ? `最近心跳 ${hbAgo}` : '',
        !ok && !extSeen ? '扩展未启动或代理通道异常' : '',
      ]
        .filter(Boolean)
        .join(' · '),
    ),
    tile(
      cl ? 'ok' : 'warn',
      '代理来源',
      cl ? (cl.clientId ? `客户端 ${escapeHtml(String(cl.clientId))}` : '未知客户端') : '未知',
      cl ? uaTag || '扩展未上报浏览器版本' : '扩展未上报身份，可能是旧版扩展',
    ),
    tile(
      scopeWarn ? 'warn' : 'ok',
      '检查范围',
      scopeValue,
      [scopeNote, scopeWarn ? '' : whenNote, excludedNote].filter(Boolean).join(' · '),
    ),
    tile(failedCount ? 'warn' : 'ok', '失败平台', retryValue, retryNote),
  ].join('')
}

async function loadBridgeStatus() {
  try {
    const st = await getJSON('/proxy/status')
    applyStatusMeta(st.platforms)
    applyExtMeta(st.ext)
    renderBridgeStatus(st)
    return st
  } catch (e) {
    const el = $('#bridge-status')
    if (el)
      el.innerHTML = `<div class="b-empty">状态读取失败: ${escapeHtml(String(e.message || e))}</div>`
    return null
  }
}

/** 设置页定期状态轮询（2026-09-11）：只读 /proxy/status（廉价），**不触发平台检查**；
 *  间隔取 config.platformsPollMs（默认 60s，设置页可配），下限 15s；离开设置视图即停。 */
function scheduleSettingsPoll(delayMs) {
  clearTimeout(store.settingsPoll)
  store.settingsPoll = setTimeout(
    async () => {
      const st = await loadBridgeStatus()
      const ms = Math.max(
        15000,
        (st && st.platforms && st.platforms.pollMs) || store.platformsPollMs || 60000,
      )
      if (!isSettingsActive()) return
      if (st && st.platforms && st.platforms.refreshing === false) refreshPlatformAuth()
      scheduleSettingsPoll(ms)
    },
    Math.max(15000, delayMs),
  )
}

export function startSettingsPoll() {
  const ms = Math.max(15000, store.platformsPollMs || 60000)
  scheduleSettingsPoll(ms)
}

export function stopSettingsPoll() {
  clearTimeout(store.settingsPoll)
  store.settingsPoll = null
}

function isSettingsActive() {
  const el = $('#view-settings')
  return !!el && el.classList.contains('active')
}

/* ── 样式库（2026-08-25 分组 + 色卡 + 搜索） ── */

async function saveProxyConfig() {
  const msg = $('#px-msg')
  const num = (v, min, max, dft) => {
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n >= min && n <= max ? n : dft
  }
  const body = {
    platformsCacheMs: num($('#px-cache-min').value, 1, 1440, 60) * 60000,
    timeoutMs: num($('#px-timeout-sec').value, 5, 600, 150) * 1000,
    concurrency: num($('#px-concurrency').value, 1, 10, 3),
    platformsPollMs: num($('#px-poll-sec').value, 15, 600, 60) * 1000,
    platformsCheckConcurrency: num($('#px-check-conc').value, 1, 10, 6),
  }
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>保存中…'
  try {
    const r = await postJSON('/proxy/config', body)
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = `已保存 ✓ 缓存 ${body.platformsCacheMs / 60000} 分 · 超时 ${body.timeoutMs / 1000} 秒 · 发布并发 ${body.concurrency} · 状态轮询 ${body.platformsPollMs / 1000} 秒 · 检查并发 ${body.platformsCheckConcurrency}`
    // 轮询间隔即时生效 + 回显实际生效值
    $('#px-poll-sec').value = body.platformsPollMs / 1000
    $('#px-check-conc').value = body.platformsCheckConcurrency
    store.platformsPollMs = body.platformsPollMs
    if (isSettingsActive()) startSettingsPoll()
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '保存失败: ' + String(e.message || e)
  }
}

/** 立即检查（2026-09-11）：立即返回缓存 + refreshing:true，检查在 bridge 后台进行；
 *  完成后由状态轮询/订阅刷新徽标 */
async function triggerPlatformCheck() {
  const btn = $('#btn-check-platforms')
  const msg = $('#bridge-check-msg')
  if (btn) btn.disabled = true
  if (msg) msg.textContent = '检查中…'
  try {
    const r = await getJSON('/proxy/platforms?refresh=1')
    applyAuthPayload(r)
    if (msg) msg.textContent = r && r.refreshing ? '检查已在后台进行…' : '已触发'
  } catch (e) {
    if (msg) msg.textContent = '触发失败: ' + String(e.message || e)
  } finally {
    if (btn) btn.disabled = false
  }
}

/** 应用品牌图标（2026-09-02）：有文件 → /proxy/icon 上传得路径；否则用 URL 值；写 config.branding.icon 并即时应用 */
async function saveBrandIcon() {
  const msg = $('#brand-msg')
  const setMsg = (cls, txt) => {
    msg.className = 'repub-result ' + cls
    msg.textContent = txt
  }
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>保存中…'
  try {
    const file = $('#brand-icon-file').files[0]
    const url = $('#brand-icon-url').value.trim()
    let icon = url
    if (file) {
      const data = await new Promise((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(r.result)
        r.onerror = () => rej(new Error('读取文件失败'))
        r.readAsDataURL(file)
      })
      const up = await postJSON('/proxy/icon', { data }, { timeoutMs: 60000 })
      if (up.error) throw new Error(up.error)
      icon = up.icon
    }
    if (!icon) {
      setMsg('err', '请先选择文件或填写图标 URL / 路径')
      return
    }
    const r = await postJSON('/proxy/config', { branding: { icon } })
    if (r.error) throw new Error(r.error)
    // 更新预览 + 即时应用品牌
    $('#brand-icon-url').value = icon
    $('#brand-icon-preview').src = icon
    applyBrand(r.config)
    setMsg('ok', '已应用 ✓')
  } catch (e) {
    setMsg('err', '保存失败: ' + String(e.message || e))
  }
}

/** 恢复默认品牌图标（CP 文本徽标 + favicon.ico） */
async function resetBrandIcon() {
  const msg = $('#brand-msg')
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>保存中…'
  try {
    const r = await postJSON('/proxy/config', { branding: { icon: '' } })
    if (r.error) throw new Error(r.error)
    $('#brand-icon-url').value = ''
    $('#brand-icon-preview').src = '/console/favicon.ico'
    applyBrand(r.config)
    msg.className = 'repub-result ok'
    msg.textContent = '已恢复默认 ✓'
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '保存失败: ' + String(e.message || e)
  }
}
