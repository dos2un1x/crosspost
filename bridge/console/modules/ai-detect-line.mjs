// AI 检测门禁行的展示层（2026-10-08）
//
// 记录里 `aiDetect` / 历史里 `history[].aiDetect` 存的是一行**纯文本**（引擎 `formatSnapshot`
// 写的，§5.55 门禁行）；以前抽屉把它整行贴出来，于是面板上看到的是
// `AI检测=pass(口径=labels_ai 值=10.4% 阈值=30.0% AI特征占比=10.4% 段=1人工/1AI/8疑似 字符=2620 风格=ok)`
// ——同一个数印两遍、口径写成 `labels_ai`、判定写英文。这里把它拆回字段再排版。
//
// 必须兼容两类历史文本（旧记录不会被重写）：
//   新：AI检测=达标 · AI特征 10.4% < 30.0% · 片段 8人工/1疑似/1AI · 2620字 · 风格 正常
//   旧：AI检测=pass(口径=labels_ai 值=10.4% 阈值=30.0% AI特征占比=10.4% 段=1人工/1AI/8疑似 字符=2620 风格=ok)
// 解析不出来的（含 AI 自己追加的散文尾巴）一律退回原样显示：格式变化绝不能让内容消失。
// 纯函数、无 DOM 依赖，可直接在 node --test 里跑（见 tests/ai-detect-line.test.mjs）。
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
import { escapeHtml } from './utils.mjs'

/** 判定词 → 徽标（与引擎 formatSnapshot 的用词同源） */
const VERDICT_LABEL = { pass: '达标', fail: '超标', skip: '未检测' }
/** skip 原因代码 → 人话（引擎那边同表；这里只是兜底显示） */
const SKIP_REASON = {
  disabled: '检测未启用',
  'slot-not-enabled': '栏目不在白名单',
  'text-too-short': '正文过短',
  'sampled-out': '抽查未命中',
  'no-api-key': '未配置凭证',
  'budget-exhausted': '额度已用尽',
  timeout: '接口超时',
  'network-error': '网络异常',
  'api-error': '接口报错',
  'bad-json': '响应无法解析',
  'bad-response': '响应异常',
  'metric-unavailable': '指标缺失',
}
/** 失败项代码 → 人话 */
const FAIL_LABEL = {
  human: '人工不足',
  ai: 'AI特征超限',
  uncertain: '疑似超限',
  'human:below': '人工偏低',
  'human:above': '人工偏高',
  'ai:below': 'AI特征偏低',
  'ai:above': 'AI特征超限',
  'uncertain:below': '疑似偏低',
  'uncertain:above': '疑似超限',
}

/** 行首判定词：`跳过/未检测` 优先（它有可能是被追加说明里的"未检测"字样带出来的） */
function readVerdict(raw) {
  if (/跳过|未检测|skip/i.test(raw)) return 'skip'
  // `失败(?!项)`：老的区间/分布口径里恒有 `失败项=…` 这个字段，它不是判定词
  if (/超标|失败(?!项)|\bfail\b/i.test(raw)) return 'fail'
  if (/达标|pass/i.test(raw)) return 'pass'
  return null
}

/** 新格式（` · ` 分段）：逐段归类，认不出的段进 `note`（AI 追加的说明就落在那里） */
function readSegmented(raw, out) {
  const tokens = raw.split(' · ')
  for (const token of tokens.slice(1)) {
    const t = token.trim()
    if (!t) continue
    if (/^越界\s/.test(t)) {
      out.fails = t
        .replace(/^越界\s*/, '')
        .split('、')
        .map((s) => s.trim())
        .filter(Boolean)
      continue
    }
    const seg = /^片段\s*(\d+)人工\/(\d+)疑似\/(\d+)AI$/.exec(t)
    if (seg) {
      out.segments = { human: Number(seg[1]), uncertain: Number(seg[2]), ai: Number(seg[3]) }
      continue
    }
    if (/^\d+字$/.test(t)) {
      out.chars = Number(t.replace('字', ''))
      continue
    }
    if (/^风格\s/.test(t)) {
      const body = t.replace(/^风格\s*/, '')
      out.style = { ok: body.startsWith('正常'), text: body }
      continue
    }
    if (/^重写\s*\d+$/.test(t)) {
      out.rounds = Number(t.replace(/^重写\s*/, ''))
      continue
    }
    if (t === '已回退') {
      out.rolledBack = true
      continue
    }
    const ratio = /^(人工|AI特征|疑似)\s+([\d.]+%|n\/a)(?:（([^）]*)）)?$/.exec(t)
    if (ratio) {
      out.ratios.push({ label: ratio[1], value: ratio[2], bound: ratio[3] || '', fail: false })
      continue
    }
    const metric = /^(AI特征|AI浓度)\s+([\d.]+%|n\/a)\s*(<|≥|≤|>)\s*([\d.]+%|n\/a)$/.exec(t)
    if (metric) {
      out.metric = { label: metric[1], value: metric[2], op: metric[3], threshold: metric[4] }
      continue
    }
    out.note.push(t)
  }
}

/** 老格式（`pass(口径=… 值=… 阈值=… 段=… 字符=…)`）：按字段名取值，剩下的当散文尾巴 */
function readLegacy(raw, out) {
  const metric = /口径=(labels_ai|confidence)/.exec(raw)
  const value = /值=([\d.]+%|n\/a)/.exec(raw)
  const threshold = /阈值=([\d.]+%|n\/a)/.exec(raw)
  if (metric || value) {
    out.metric = {
      label: metric && metric[1] === 'confidence' ? 'AI浓度' : 'AI特征',
      value: value ? value[1] : 'n/a',
      op: value && threshold && parseFloat(value[1]) < parseFloat(threshold[1]) ? '<' : '≥',
      threshold: threshold ? threshold[1] : '',
    }
  }
  // 三项占比：`人工=45.0%`；老区间口径还会紧跟 `[30.0%~50.0%]`
  const ratioRe = /(人工|AI特征|疑似)=([\d.]+%|n\/a)(?:\[([^\]]+)\])?/g
  let m
  while ((m = ratioRe.exec(raw))) {
    out.ratios.push({ label: m[1], value: m[2], bound: m[3] || '', fail: false })
  }
  const legacySeg = /段=(\d+)人工\/(\d+)AI\/(\d+)疑似/.exec(raw)
  if (legacySeg) {
    out.segments = {
      human: Number(legacySeg[1]),
      ai: Number(legacySeg[2]),
      uncertain: Number(legacySeg[3]),
    }
  } else {
    const aiOnly = /AI段=(\d+)/.exec(raw)
    if (aiOnly) out.segments = { human: null, ai: Number(aiOnly[1]), uncertain: null }
  }
  const chars = /字符=(\d+)/.exec(raw)
  if (chars) out.chars = Number(chars[1])
  const style = /风格=(正常|ok|碎句(?:\([^)]*\))?)/.exec(raw)
  if (style)
    out.style = {
      ok: style[1] === '正常' || style[1] === 'ok',
      text: style[1] === 'ok' ? '正常' : style[1],
    }
  const fails = /失败项=([^\s)）]+)/.exec(raw)
  if (fails && fails[1] !== '无') {
    out.fails = fails[1]
      .split('|')
      .map((f) => FAIL_LABEL[f] || f)
      .filter(Boolean)
  }
  const rounds = /重写=(\d+)/.exec(raw)
  if (rounds) out.rounds = Number(rounds[1])
  if (/回退=1/.test(raw)) out.rolledBack = true
  // 尾巴：去掉 `AI检测=xxx(...)` 这一段之后剩下的（如 `强度=observe 处置=…`）
  const rest = raw.replace(/^\s*AI检测\s*=\s*/, '').replace(/^[^（(]*[（(][^）)]*[）)]/, '')
  const explain = /说明=([^,，]+)/.exec(rest)
  const enforce = /强度=(observe|block)/.exec(rest)
  const other = rest
    .replace(/口径=\S+\s*/, '')
    .replace(/阈值=[\d.]+%?\s*/, '')
    .replace(/强度=\S+\s*/, '')
    .replace(/处置=\S+\s*/, '')
    .replace(/说明=[^,，]+[，,]?/, '')
    .trim()
  if (enforce) out.enforce = enforce[1]
  if (explain) out.note.push(explain[1].trim())
  if (other) out.note.push(other)
}

/** skip 的原因与代码（新老两种写法都认） */
function readSkip(raw, out) {
  const modern = /未检测\s*·\s*([^·（(]+)（([^）]+)）/.exec(raw)
  if (modern) {
    out.reason = modern[1].trim()
    out.reasonCode = modern[2].trim()
    return
  }
  const legacy = /跳过\(([^)]+)\)/.exec(raw)
  const code = legacy ? legacy[1].trim() : ''
  const codeOnly = code.split(':')[0].trim()
  out.reasonCode = code
  out.reason = SKIP_REASON[codeOnly] || ''
  // 老文本里 AI 自己追加的说明（`说明=按正文哈希抽样未命中,未检测(非达标)`）也要留着
  const explain = /说明=([^,，]+)/.exec(raw)
  if (explain) out.note.push(explain[1].trim())
  const enforce = /强度=(observe|block)/.exec(raw)
  if (enforce) out.enforce = enforce[1]
}

/**
 * 解析门禁行。返回结构化字段（字段缺失就是 `null`，不编造）。
 * `ok=false` 表示"没解析出结构"，调用方应原样显示 `raw`。
 *
 * @param {string} text 记录里的 `aiDetect` 原文
 */
export function parseAiDetectLine(text) {
  const raw = String(text == null ? '' : text).trim()
  const out = {
    ok: false,
    raw,
    verdict: null,
    skipped: false,
    reason: '',
    reasonCode: '',
    metric: null,
    ratios: [],
    fails: [],
    segments: null,
    chars: null,
    style: null,
    rounds: null,
    rolledBack: false,
    enforce: '',
    note: [],
  }
  if (!raw) {
    out.verdict = 'skip'
    return out
  }
  out.verdict = readVerdict(raw)
  out.skipped = out.verdict === 'skip'
  if (out.skipped) {
    readSkip(raw, out)
    const rounds = /重写[= ](\d+)/.exec(raw)
    if (rounds) out.rounds = Number(rounds[1])
    out.ok = true
    return out
  }
  // 新格式一定带 ` · ` 分段；老格式是空格分隔的 `key=value`，两者不会混
  if (raw.includes(' · ')) readSegmented(raw, out)
  else readLegacy(raw, out)
  // 有"人工"这一项 ⇒ 分布/区间口径，主判据就是那三项，不再重复显示单指标那行；
  // 没有"人工"的占比项（单指标口径里不该出现）当噪声丢掉，避免和主判据重复。
  if (out.ratios.length) {
    if (out.ratios.some((r) => r.label === '人工')) out.metric = null
    else out.ratios = []
  }
  // 分布/区间口径：把没达标的项标出来（值与目标都在面板上了，红一下最省读者力气）
  if (out.ratios.length) {
    for (const r of out.ratios) {
      if (r.bound.includes('~')) {
        const [lo, hi] = r.bound.split('~').map((s) => parseFloat(s))
        const v = parseFloat(r.value)
        r.fail =
          Number.isFinite(v) && ((Number.isFinite(lo) && v < lo) || (Number.isFinite(hi) && v > hi))
      } else if (r.bound.startsWith('≥')) {
        r.fail = parseFloat(r.value) < parseFloat(r.bound.slice(1))
      } else if (r.bound.startsWith('≤')) {
        r.fail = parseFloat(r.value) > parseFloat(r.bound.slice(1))
      }
    }
  }
  out.ok =
    out.verdict !== null &&
    (!!out.metric || out.ratios.length > 0 || !!out.segments || out.chars !== null)
  return out
}

/** 判定徽标 */
function verdictBadge(p) {
  return `<span class="ai-verdict ${p.verdict}">${VERDICT_LABEL[p.verdict] || p.verdict}</span>`
}

/** 单指标口径的主判据：`AI特征 10.4% < 30.0%`（< 是"越低越好"的方向，≥ 就是它判失败的原因） */
function metricHtml(p) {
  const m = p.metric
  if (!m) return ''
  const tail = m.threshold
    ? ` <span class="ai-op">${escapeHtml(m.op)}</span> ${escapeHtml(m.threshold)}`
    : ''
  const bad = p.verdict === 'fail' ? ' class="ai-bad"' : ''
  return `<span class="ai-head">${escapeHtml(m.label)} <b${bad}>${escapeHtml(m.value)}</b>${tail}</span>`
}

/** 分布/区间口径：三项并排，各自带目标 */
function ratiosHtml(p) {
  if (!p.ratios.length) return ''
  const items = p.ratios
    .map(
      (r) =>
        `<span class="ai-ratio${r.fail ? ' fail' : ''}">${escapeHtml(r.label)} <b>${escapeHtml(r.value)}</b>${
          r.bound ? `<em>${escapeHtml(r.bound)}</em>` : ''
        }</span>`,
    )
    .join('')
  return `<div class="ai-ratios">${items}</div>`
}

/** 明细：片段结构 / 字数 / 风格 / 重写轮次（缺哪块少哪块） */
function metaHtml(p) {
  const bits = []
  if (p.segments) {
    const s = p.segments
    const parts = []
    if (s.human !== null && s.human !== undefined) parts.push(`${s.human} 人工`)
    if (s.uncertain !== null && s.uncertain !== undefined) parts.push(`${s.uncertain} 疑似`)
    if (s.ai !== null && s.ai !== undefined)
      parts.push(`<b${s.ai > 0 ? ' class="ai-bad"' : ''}>${s.ai} AI</b>`)
    if (parts.length)
      bits.push(
        `<span title="朱雀把正文切成若干片段逐段标注；单指标口径只看 AI 段占比，疑似段不参与判定">片段 ${parts.join(' · ')}</span>`,
      )
  }
  if (p.chars) bits.push(`${p.chars} 字`)
  if (p.style)
    bits.push(
      p.style.ok
        ? '风格 正常'
        : `<span class="ai-bad" title="碎句护栏：短句占比/连续短句越界（aiDetect.styleGuard）">风格 ${escapeHtml(p.style.text)}</span>`,
    )
  if (p.rounds) bits.push(`重写 ${p.rounds} 次`)
  if (p.rolledBack) bits.push('已回退')
  if (p.enforce) bits.push(p.enforce === 'block' ? '强度 硬拦截' : '强度 只报不拦')
  if (!bits.length) return ''
  return `<div class="ai-meta">${bits.join(' · ')}</div>`
}

/**
 * 文章抽屉「记录概览」里的 AI 检测块：徽标 + 主判据 + 三项占比 + 明细 + 说明。
 * 判定为 `skip` 时额外写清"未检测 ≠ 通过"——事后复盘最容易在这里读错。
 */
export function aiDetectDetailHtml(text) {
  const p = parseAiDetectLine(text)
  if (!p.raw) return '<span class="ai-meta">未执行</span>'
  if (!p.ok) return `<span class="ai-detect-raw">${escapeHtml(p.raw)}</span>`
  let head = ''
  if (p.skipped) {
    head = `<span class="ai-head">${escapeHtml(p.reason || '检测未完成')}</span>${
      p.reasonCode ? `<code class="ai-code">${escapeHtml(p.reasonCode)}</code>` : ''
    }`
  } else {
    head = metricHtml(p)
  }
  const note = p.note.length
    ? `<div class="ai-note">${p.note.map((n) => escapeHtml(n)).join(' · ')}</div>`
    : ''
  const hint = p.skipped ? '<div class="ai-hint">未检测（不等于通过）</div>' : ''
  const fails =
    !p.skipped && p.fails.length
      ? `<div class="ai-fails">越界：${p.fails.map((f) => escapeHtml(f)).join('、')}</div>`
      : ''
  return (
    `<div class="ai-detect">` +
    `<div class="ai-line">${verdictBadge(p)}${head}</div>` +
    ratiosHtml(p) +
    metaHtml(p) +
    fails +
    hint +
    note +
    `</div>`
  )
}

/**
 * 发布历史时间线里的一行（位置窄，只留判定 + 主判据；明细在"记录概览"那段）。
 */
export function aiDetectInlineHtml(text) {
  const p = parseAiDetectLine(text)
  if (!p.raw) return ''
  if (!p.ok) return `<span class="ai-detect-raw">${escapeHtml(p.raw)}</span>`
  if (p.skipped) {
    return (
      `<span class="ai-verdict skip">未检测</span>` +
      `<span class="ai-head">${escapeHtml(p.reason || '')}</span>` +
      (p.reasonCode ? `<code class="ai-code">${escapeHtml(p.reasonCode)}</code>` : '')
    )
  }
  const main = p.metric
    ? `${p.metric.label} ${p.metric.value}${p.metric.threshold ? ` ${p.metric.op} ${p.metric.threshold}` : ''}`
    : p.ratios.map((r) => `${r.label} ${r.value}${r.bound ? `（${r.bound}）` : ''}`).join(' · ')
  const extra = [p.chars ? `${p.chars} 字` : '', p.rounds ? `重写 ${p.rounds} 次` : '']
    .filter(Boolean)
    .join(' · ')
  return (
    `<span class="ai-verdict sm ${p.verdict}">${VERDICT_LABEL[p.verdict] || p.verdict}</span>` +
    `<span class="ai-head">${escapeHtml(main)}</span>` +
    (extra ? `<span class="ai-meta-inline">${escapeHtml(extra)}</span>` : '')
  )
}
