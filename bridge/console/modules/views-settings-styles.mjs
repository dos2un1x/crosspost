// 设置页 · 样式库 + 封面×结束语模板（2026-09-01 从 views-settings.mjs 拆分）
import { getJSON, postJSON } from './api.mjs'
import { $, escapeHtml, escapeAttr, styleDisplayName, groupStyles } from './utils.mjs'

let selectedStyle = null

let styleQuery = ''

/** 「显示/收起已禁用」按钮统一文案（hidden=是否折叠；count 为禁用样式数，0 时不带数字） */
function updateDisabledToggleBtn(hidden, count) {
  const btn = $('#btn-style-show-disabled')
  if (!btn) return
  const suffix = count ? `（${count}）` : ''
  btn.textContent = hidden ? `▸ 显示已禁用${suffix}` : `▾ 收起已禁用${suffix}`
}

function styleSwatch(s) {
  if (!s.bg && !s.accent) return ''
  const bg = s.bg || '#ffffff'
  const accent = s.accent || '#888888'
  return `<span class="style-swatch" style="background:${escapeHtml(bg)}"><i style="background:${escapeHtml(accent)}"></i></span>`
}

function renderStyleStats(list) {
  const enabled = list.filter((s) => s.enabled !== false).length
  const disabled = list.length - enabled
  // v2.96（下）：读数拆成"大号数字 + 注解"（与「默认推送平台」同款读数条）。
  // 改前 `启用 16 · 禁用 49` 是一行 12px 灰字，而下面每张卡再挂一个「启用中」——
  // 同一句话在一张卡里印 17 遍。现在总数只出现一次，卡上只留一个状态点。
  const num = $('#style-stat-num')
  if (num) num.textContent = String(enabled)
  const stat = $('#style-stat')
  if (stat) stat.textContent = `共 ${list.length} 个 · 禁用 ${disabled} 个`
  // 按钮文案统一走 updateDisabledToggleBtn（按当前折叠态 + 禁用数）
  const wrap = $('#style-disabled-wrap')
  updateDisabledToggleBtn(!wrap || wrap.classList.contains('hidden'), disabled)
}

/** 渲染一组样式卡片（启用/禁用共用；2026-08-29 美化：默认只显启用，禁用折叠）
 *  2026-09-07：卡片内嵌启停按钮（对齐封面×结束语模板的 style-toggle 方案），点按钮直接启停
 *  v2.96（下）：启停按钮从「一个写着"启用中"的胶囊」改成**状态点 + 悬停才出的动作词**。
 *    为什么：启用区里 16 张卡每张都写着"启用中"、禁用区每张都写着"已禁用"——
 *    而"在哪一区"本身已经说明了状态，这 16 遍是纯重复。现在静止态只有一颗点
 *    （绿=启用 / 灰=禁用，与平台行的状态色同一套语义），悬停时点左侧浮出动作词
 *    "禁用 / 启用"，点击行为与 classList('off') 判定一字未改。 */
function styleToggleHTML(name, off) {
  return `<button class="style-toggle ${off ? 'off' : ''}" data-name="${escapeAttr(name)}" aria-label="${off ? '启用' : '禁用'} ${escapeAttr(name)}"><span class="st-mark" aria-hidden="true"></span><span class="st-act">${off ? '启用' : '禁用'}</span></button>`
}

function renderStyleGroupHTML(g) {
  const cards = g.items
    .map((s) => {
      const name = styleDisplayName(s.name)
      const off = s.enabled === false
      return `<span class="style-card${off ? ' disabled' : ''}" data-name="${escapeAttr(s.name)}" title="${escapeAttr(String(s.desc ?? '').slice(0, 120))}">
      ${styleSwatch(s)}
      <span class="style-name">${escapeHtml(name)}</span>
      ${styleToggleHTML(s.name, off)}
    </span>`
    })
    .join('')
  return `<div class="pf-group">
    <div class="pf-group-head">
      <span class="pf-group-title">${escapeHtml(g.title)}</span>
      <span class="pf-group-count">${g.items.length}</span>
    </div>
    <div class="style-grid">${cards}</div>
  </div>`
}

/** 绑定样式卡片选中事件 */
function bindStyleCards(container) {
  container.querySelectorAll('.style-card').forEach((item) => {
    item.addEventListener('click', () => {
      container
        .querySelectorAll('.style-card')
        .forEach((i) => i.classList.toggle('selected', i === item))
      selectedStyle = item.dataset.name
      $('#style-msg').textContent = ''
    })
  })
}

/** 绑定卡片内「启用/禁用」按钮（stopPropagation 避免触发选中；对齐封面模板 style-toggle 方案） */
function bindStyleToggles(container) {
  container.querySelectorAll('.style-toggle').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const name = btn.dataset.name
      const off = btn.classList.contains('off') // 当前已禁用 → 点它启用；启用中 → 点它禁用
      try {
        await postJSON('/proxy/styles-toggle', { name, enabled: off })
      } catch {
        /* 忽略 */
      }
      loadStyleLib()
    })
  })
}

export async function loadStyleLib() {
  const grid = $('#style-lib')
  try {
    const r = await getJSON('/proxy/styles')
    const list = (r && r.styles) || []
    renderStyleStats(list)
    const q = styleQuery.trim().toLowerCase()
    const match = (s) =>
      !q ||
      styleDisplayName(s.name).toLowerCase().includes(q) ||
      String(s.desc ?? '')
        .toLowerCase()
        .includes(q)
    const enabledList = list.filter((s) => s.enabled !== false && match(s))
    const disabledList = list.filter((s) => s.enabled === false && match(s))
    // 启用区：默认显示（分组渲染）
    const enabledGroups = groupStyles(enabledList)
    grid.innerHTML =
      [...enabledGroups.entries()].map(([, g]) => renderStyleGroupHTML(g)).join('') ||
      (q
        ? '<span style="color:var(--ink-faint)">无匹配启用样式</span>'
        : '<span style="color:var(--ink-faint)">无启用样式</span>')
    bindStyleCards(grid)
    bindStyleToggles(grid)
    // 禁用区：折叠，点击"显示已禁用"展开
    const wrap = $('#style-disabled-wrap')
    const dLib = $('#style-disabled-lib')
    const dCount = $('#style-disabled-count')
    if (dCount) dCount.textContent = `${disabledList.length} 个`
    if (wrap) wrap.classList.add('hidden') // 默认折叠，点击展开
    if (dLib) {
      const disabledGroups = groupStyles(disabledList)
      dLib.innerHTML =
        [...disabledGroups.entries()].map(([, g]) => renderStyleGroupHTML(g)).join('') ||
        (q ? '<span style="color:var(--ink-faint)">无匹配禁用样式</span>' : '')
      bindStyleCards(dLib)
      bindStyleToggles(dLib)
    }
    // 展开/收起切换：onclick 由 initStyleSection 提前绑定（避免依赖本次异步加载完成后才生效）。
    // 这里仅维护按钮文案 + 搜索命中禁用样式时自动展开。
    const showBtn = $('#btn-style-show-disabled')
    if (showBtn && q && disabledList.length) {
      wrap.classList.remove('hidden')
      updateDisabledToggleBtn(false, disabledList.length)
    }
  } catch (e) {
    grid.innerHTML = `<span style="color:var(--fail)">样式加载失败: ${escapeHtml(String(e.message || e))}</span>`
  }
}

async function renameStyle() {
  const msg = $('#style-msg')
  if (!selectedStyle) {
    msg.textContent = '请先点击选择要重命名的样式'
    return
  }
  const oldName = selectedStyle
  const newName = window.prompt('重命名 ' + oldName + ' 为：', oldName)
  if (!newName || !newName.trim() || newName.trim() === oldName) return
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>重命名中…'
  try {
    const r = await postJSON('/proxy/styles-rename', { oldName, newName: newName.trim() })
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = r.name ? `已重命名为 ${r.name} ✓` : '已重命名 ✓'
    selectedStyle = null
    loadStyleLib()
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '重命名失败: ' + String(e.message || e)
  }
}

async function deleteStyle() {
  const msg = $('#style-msg')
  if (!selectedStyle) {
    msg.textContent = '请先点击选择要删除的样式'
    return
  }
  if (!window.confirm('确定删除样式 ' + selectedStyle + ' ？（内置样式无法删除）')) return
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>删除中…'
  try {
    const r = await postJSON('/proxy/styles-delete', { name: selectedStyle })
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = '已删除 ✓'
    selectedStyle = null
    loadStyleLib()
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '删除失败: ' + String(e.message || e)
  }
}

/* ── 封面 × 结束语模板设置（2026-08-27，参考样式库；2026-08-30 折叠已禁用模板） ─────── */
/** 渲染一组封面模板卡（启用/禁用共用；allTpls 供启停后构造新禁用列表），绑定启停按钮 */
function renderCoverTplCards(list, container, allTpls) {
  container.innerHTML = list.length
    ? list
        .map((t) => {
          const cls = ['style-card', t.enabled ? '' : 'disabled'].filter(Boolean).join(' ')
          return `<span class="${cls}" data-name="${escapeAttr(t.name)}">
        <span class="style-name">${escapeHtml(t.name)}</span>
        ${styleToggleHTML(t.name, !t.enabled)}
      </span>`
        })
        .join('')
    : '<span style="color:var(--ink-faint)">无模板</span>'
  container.querySelectorAll('.style-toggle').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const name = btn.dataset.name
      const off = btn.classList.contains('off')
      // 构造新禁用列表：当前项取反，其余保持
      const newDisabled = allTpls
        .filter((t) => (t.name === name ? !off : !t.enabled))
        .map((t) => t.name)
      try {
        await postJSON('/proxy/cover-settings', { disabledTemplates: newDisabled })
      } catch (err) {
        $('#ctpl-msg').className = 'repub-result err'
        $('#ctpl-msg').textContent = '切换失败: ' + String(err.message || err)
      }
      loadCoverTplSettings()
    })
  })
}

/**
 * 加载「封面 × 结束语模板」区块（v2.81 导出）。
 *
 * 为什么必须由 `loadSettings()` 每次进设置页都调用：这块内容是**项目级**设置
 * （`config.coverSettings` 在 v2.77 起走项目覆盖层）。此前只在 `initStyleSection()`
 * 里调一次，于是**切换项目后这一块永远是第一个项目的值**——正是"封面×结束语模板
 * 没有区分项目"的直接原因。
 */
export async function loadCoverTplSettings() {
  const grid = $('#cover-tpl-lib')
  const dft = $('#ctpl-default')
  const end = $('#ctpl-ending')
  try {
    const r = await getJSON('/proxy/cover-settings')
    const cs = (r && r.coverSettings) || {}
    const tpls = (r && r.templates) || []
    // 默认封面/默认结束语下拉：只显示启用模板；若当前默认值本身被禁用，保留为「当前（已禁用）」避免保存时静默改变默认
    const optHtml = (cur) => {
      const enabledTpls = tpls.filter((t) => t.enabled)
      const curOff = cur && enabledTpls.every((t) => t.name !== cur)
      return (
        (curOff
          ? `<option value="${escapeAttr(cur)}" selected>${escapeHtml(cur)}（当前·已禁用）</option>`
          : '') +
        enabledTpls
          .map(
            (t) =>
              `<option value="${escapeAttr(t.name)}" ${t.name === cur ? 'selected' : ''}>${escapeHtml(t.name)}</option>`,
          )
          .join('')
      )
    }
    dft.innerHTML = optHtml(cs.defaultTemplate || 'nebula')
    end.innerHTML = `<option value="">跟随封面</option>` + optHtml(cs.endingTemplate || '')
    // 结束语图片开关与内容回填（2026-08-27 修复：此前缺失导致刷新永远打勾）
    const on = $('#ctpl-ending-on')
    if (on) on.checked = cs.endingCardEnabled !== false
    const cov = $('#ctpl-cover-on')
    if (cov) cov.checked = cs.coverEnabled !== false
    const txt = $('#ctpl-ending-text')
    if (txt) txt.value = cs.endingText || ''
    // 2026-08-30：参考样式库——默认只显启用，禁用折叠在「显示已禁用」后
    // v2.96（下）：读数同样拆成"大号数字 + 注解"
    const enabledList = tpls.filter((t) => t.enabled)
    const disabledList = tpls.filter((t) => !t.enabled)
    const statNum = $('#ctpl-stat-num')
    if (statNum) statNum.textContent = String(enabledList.length)
    const stat = $('#ctpl-stat')
    if (stat) stat.textContent = `共 ${tpls.length} 个 · 禁用 ${disabledList.length} 个`
    renderCoverTplCards(enabledList, grid, tpls)
    const wrap = $('#cover-tpl-disabled-wrap')
    const dLib = $('#cover-tpl-disabled-lib')
    const dCount = $('#cover-tpl-disabled-count')
    if (dCount) dCount.textContent = `${disabledList.length} 个`
    const showBtn = $('#btn-ctpl-show-disabled')
    if (showBtn)
      showBtn.textContent = disabledList.length
        ? `▸ 显示已禁用（${disabledList.length}）`
        : '▸ 显示已禁用'
    if (showBtn) showBtn.style.display = disabledList.length ? '' : 'none'
    if (wrap) wrap.classList.add('hidden') // 默认折叠，点击展开
    if (dLib) renderCoverTplCards(disabledList, dLib, tpls)
    if (showBtn) {
      showBtn.onclick = () => {
        const hidden = wrap.classList.contains('hidden')
        wrap.classList.toggle('hidden', !hidden)
        showBtn.textContent = hidden
          ? `▾ 收起已禁用（${disabledList.length}）`
          : `▸ 显示已禁用（${disabledList.length}）`
      }
    }
  } catch (e) {
    grid.innerHTML = `<span style="color:var(--fail)">模板加载失败: ${escapeHtml(String(e.message || e))}</span>`
  }
}

async function saveCoverTplSettings() {
  const msg = $('#ctpl-msg')
  msg.className = 'repub-result'
  msg.innerHTML =
    '<span class="spinner" style="border-color:rgba(180,67,47,.3);border-top-color:#b4432f"></span>保存中…'
  try {
    const r = await postJSON('/proxy/cover-settings', {
      defaultTemplate: $('#ctpl-default').value,
      endingTemplate: $('#ctpl-ending').value,
    })
    if (r.error) throw new Error(r.error)
    msg.className = 'repub-result ok'
    msg.textContent = '已保存 ✓'
    loadCoverTplSettings()
  } catch (e) {
    msg.className = 'repub-result err'
    msg.textContent = '保存失败: ' + String(e.message || e)
  }
}

/* ── 样式/封面事件绑定（2026-09-01 从 initSettingsView 抽出，供 initSettingsView 调用） ── */
export function initStyleSection() {
  $('#btn-style-rename').addEventListener('click', renameStyle)
  $('#btn-style-delete').addEventListener('click', deleteStyle)
  $('#style-q').addEventListener('input', (e) => {
    styleQuery = e.target.value
    loadStyleLib()
  })
  // 样式库「显示/收起已禁用」：在 init 立即绑定，避免直到异步 loadStyleLib 完成按钮才生效
  // （显著修复：首次进入/样式接口慢或失败时，按钮不再「点了没反应」）。
  const showBtn = $('#btn-style-show-disabled')
  if (showBtn) {
    showBtn.onclick = () => {
      const wrap = $('#style-disabled-wrap')
      if (!wrap) return
      const hidden = wrap.classList.contains('hidden')
      wrap.classList.toggle('hidden', !hidden)
      const countText = ($('#style-disabled-count') || {}).textContent || ''
      const count = Number(countText.replace(/[^0-9]/g, '')) || 0
      updateDisabledToggleBtn(!hidden, count)
    }
  }
  // 封面×结束语模板（2026-08-27，参考样式库）
  $('#ctpl-save').addEventListener('click', saveCoverTplSettings)
  // 封面图片开关：变更即自动保存（2026-08-31）
  $('#ctpl-cover-on').addEventListener('change', async (e) => {
    const msg = $('#ctpl-msg')
    try {
      const r = await postJSON('/proxy/cover-settings', { coverEnabled: e.target.checked })
      if (r.error) throw new Error(r.error)
      msg.className = 'repub-result ok'
      msg.textContent = e.target.checked ? '封面图片已开启 ✓' : '封面图片已关闭 ✓'
    } catch (err) {
      msg.className = 'repub-result err'
      msg.textContent = '保存失败: ' + String(err.message || err)
      e.target.checked = !e.target.checked // 回滚
    }
  })
  // 结束语图片开关：变更即自动保存（2026-08-27）
  $('#ctpl-ending-on').addEventListener('change', async (e) => {
    const msg = $('#ctpl-msg')
    try {
      // 携带当前输入框内容，避免切开关清掉未保存的结束语内容（2026-08-27）
      const r = await postJSON('/proxy/cover-settings', {
        endingCardEnabled: e.target.checked,
        endingText: $('#ctpl-ending-text') ? $('#ctpl-ending-text').value.trim() : '',
      })
      if (r.error) throw new Error(r.error)
      msg.className = 'repub-result ok'
      msg.textContent = e.target.checked ? '结束语图片已开启 ✓' : '结束语图片已关闭 ✓'
    } catch (err) {
      msg.className = 'repub-result err'
      msg.textContent = '保存失败: ' + String(err.message || err)
      e.target.checked = !e.target.checked // 回滚
    }
  })
  // 结束语内容：停止输入 800ms 自动保存（2026-08-27 修复刷新丢失）
  let endingTextTimer = null
  $('#ctpl-ending-text').addEventListener('input', (e) => {
    clearTimeout(endingTextTimer)
    endingTextTimer = setTimeout(async () => {
      const msg = $('#ctpl-msg')
      try {
        const r = await postJSON('/proxy/cover-settings', { endingText: e.target.value.trim() })
        if (r.error) throw new Error(r.error)
        msg.className = 'repub-result ok'
        msg.textContent = '结束语内容已保存 ✓'
      } catch (err) {
        msg.className = 'repub-result err'
        msg.textContent = '保存失败: ' + String(err.message || err)
      }
    }, 800)
  })
  // 不再在这里调 loadCoverTplSettings()：设置页每次进入都会经 loadSettings() 调它
  // （v2.81 修——原先只在 init 调一次，导致切换项目后这一块不跟着变）
}
