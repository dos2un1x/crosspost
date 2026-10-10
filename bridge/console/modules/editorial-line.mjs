// 编辑决策 / 独立审稿的展示层（2026-10-10）
//
// 记录里的这两个字段是**一行纯文本**（写作侧按 SKILL §2.5 / §5.6 写出来的原文），以前
// 抽屉里整行贴出来，于是人看到的是这样一坨：
//   决策=数学界这一轮争的不是AI算得对不对,而是谁来验…|理由=10-09知乎热榜第6+IT之家…|重复风险=medium,避免角度=…
//   审稿=90 自评=92 行动=publish issues=3(minor:事实-…;minor:表达-…;minor:配图-…)
// 字段名、分隔符、括号层级全挤在一行里，读的人得自己拆。
//
// 这个模块把它们拆回字段再排版（判定徽标 + 主线 + 逐条 issue），**解析不出来就原样显示**：
// 记录是历史数据，写法在演进（实测五种字段组合、四种 issues 写法，还有纯散文的老格式），
// 任何"格式变了就藏起来"的做法都会让复盘失去依据。
// 纯函数、无 DOM 依赖，可直接 node --test（见 tests/editorial-line.test.mjs）。
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
import { escapeHtml, stripSpecRefs } from './utils.mjs'

/** 决策字段的标签（键 → 人读名）；`主线` 是 `决策` 的同义写法 */
const DECISION_LABELS = {
  决策: '主线',
  主线: '主线',
  理由: '理由',
  重复风险: '重复风险',
  写作指令: '写作指令',
  标题避免: '标题避免',
}

/** 审稿里 issue 的分类（写作侧用 · / - / ： / 空格 连接分类与正文） */
const ISSUE_CATEGORIES = ['事实', '表达', '结构', '标题', '排版', '配图', '风险']
/** 严重度：blocker > major > minor（写作侧混写 `minor:` / `minor/` / `minor+` / `none major/blocker`） */
const SEVERITIES = ['blocker', 'major', 'minor']

/**
 * 把"避开角度"从重复风险里拆出来（两种写法都出现过）：
 *   · `medium，避开角度=不写成…`（逗号 + 键值）
 *   · `medium(避开角度:不写成…)`（括号内联）
 * 必须**先认括号写法**：先按"逗号 + 键值"匹配的话，`medium(避开角度:…)` 会把
 * `避开角度:` 一直吃到行尾，风险值里留下一个孤零零的 `medium(`。
 */
function splitRisk(text) {
  const t = String(text || '').trim()
  const paren = /[（(]\s*(?:避开角度|避免角度)\s*[=:：]\s*([\s\S]*?)\s*[）)]\s*$/.exec(t)
  if (paren) {
    return { risk: t.slice(0, paren.index).replace(/[，,;；\s（(]+$/, ''), avoid: paren[1].trim() }
  }
  const plain = /[，,;；]\s*(?:避开角度|避免角度)\s*[=:：]\s*([\s\S]+)$/.exec(t)
  if (plain) {
    return { risk: t.slice(0, plain.index).replace(/[，,;；\s]+$/, ''), avoid: plain[1].trim() }
  }
  // 更老的写法：`low，近3天无同类题材，避免写成AI绘画工具盘点` —— 严重度词后面全是说明
  const lvl = /^(low|medium|high)\s*[，,：:；;]\s*([\s\S]+)$/i.exec(t)
  if (lvl) return { risk: lvl[1].toLowerCase(), avoid: lvl[2].trim() }
  return { risk: t.replace(/[\s（(]+$/, ''), avoid: '' }
}

/** 数字或 `n/a` 之类的短值：抽得到就回数字，抽不到回原文 */
function numberOrText(v) {
  const t = String(v == null ? '' : v).trim()
  if (!t) return { n: null, text: '' }
  const m = /^(\d{1,3})(?:\s|$|[（(])/.exec(t)
  return m ? { n: Number(m[1]), text: t } : { n: null, text: t }
}

/** `1) … 2) … 3) …` / `①②③…` / `；`-分隔 → 条目数组 */
function splitInstructions(text) {
  const t = String(text || '').trim()
  if (!t) return []
  const byCircled = t.split(/\s*(?=[①②③④⑤⑥⑦⑧⑨⑩])/).filter(Boolean)
  if (byCircled.length > 1) return byCircled.map((s) => s.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '').trim())
  const byNum = t.split(/\s*(?=\d{1,2}\s*[)）]\s*)/).filter(Boolean)
  if (byNum.length > 1) return byNum.map((s) => s.replace(/^\d{1,2}\s*[)）]\s*/, '').trim())
  const bySemi = t
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return bySemi.length > 1 ? bySemi : [t]
}

/**
 * 解析编辑决策（SKILL §2.5 那一行）。返回 `{ok, main, reason, risk, avoid, instructions, notes, raw}`。
 * `ok=false` 表示没解析出结构（老格式是纯散文），调用方应原样显示 `raw`。
 */
export function parseDecision(text) {
  const raw = String(text == null ? '' : text).trim()
  const out = {
    ok: false,
    raw,
    main: '',
    reason: '',
    risk: '',
    avoid: '',
    instructions: [],
    notes: [],
  }
  if (!raw) return out
  // `|`（含全角 ｜）分段；每段可能是 `键=值`，也可能是散文（老格式整行就是散文）
  const parts = raw
    .split(/[|｜]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const prose = []
  for (const part of parts) {
    const m = /^([\u4e00-\u9fa5]{2,6})\s*[=:：]\s*([\s\S]*)$/.exec(part)
    const key = m && DECISION_LABELS[m[1]] ? DECISION_LABELS[m[1]] : null
    if (!key) {
      prose.push(part)
      continue
    }
    const val = m[2].trim().replace(/^主线\s*[=:：]\s*/, '')
    if (key === '主线') out.main = val
    else if (key === '理由') out.reason = val
    else if (key === '重复风险') {
      const { risk, avoid } = splitRisk(val)
      out.risk = risk
      out.avoid = avoid
    } else if (key === '写作指令') out.instructions = splitInstructions(val)
    else if (key === '标题避免') out.notes.push({ k: '标题避免', v: val })
  }
  // `决策=…` 只有一条时，正文里可能还带 `；重复风险=medium，避开…` 这样的尾巴
  if (out.main && !out.risk) {
    const m = /[;；]\s*(?:重复风险|避免角度)\s*[=:：]?\s*(.+)$/.exec(out.main)
    if (m) {
      const { risk, avoid } = splitRisk(m[1])
      out.main = out.main.slice(0, m.index).trim()
      out.risk = risk
      out.avoid = avoid
    }
  }
  // 纯散文老格式：`|` 分段本身就是信息（主线 | 理由 | 重复风险 | 指令）
  if (!out.main && !out.reason && !out.risk && prose.length) {
    out.main = prose[0]
    if (prose[1]) out.reason = prose[1]
    if (prose[2]) {
      const { risk, avoid } = splitRisk(prose[2])
      out.risk = risk
      out.avoid = avoid
    }
    for (const p of prose.slice(3)) out.instructions.push(...splitInstructions(p))
  }
  out.ok = !!(out.main || out.reason || out.risk || out.instructions.length)
  return out
}

/** 严重度：只在词边界上认，避免把 `minor:事实-…` 里的字读成分类 */
function readSeverity(item) {
  const m = new RegExp(`\\b(${SEVERITIES.join('|')})\\b`, 'i').exec(item)
  return m ? m[1].toLowerCase() : ''
}

/** 分类：`minor:事实-…` / `minor/表达 …` / `minor+事实:…` / `minor 事实 "…"` 四种连接都认 */
function readCategory(item) {
  const head = item.slice(0, 24)
  for (const c of ISSUE_CATEGORIES) {
    // 注意别用 `\b`：JS 的 \w 只含 ASCII，`事实-` / `表达 ` 这类中文后面根本不存在词边界
    if (new RegExp(`[：:、/+\\-\\s]\\s*${c}(?![\\u4e00-\\u9fa5])|^${c}[：:]`).test(head)) return c
  }
  return ''
}

/** 把 issues 正文切成条目（`;`/`；`/`。`/`|` 都当过分隔符，`①②③` 也算分条） */
function splitIssues(text) {
  return String(text || '')
    .split(/[;；|]|\s*(?=[①②③④⑤⑥⑦⑧⑨⑩])/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      s
        .replace(
          /^[（(]?\s*(?:none\s+major\s*\/\s*blocker|无\s*major\s*\/\s*blocker)[）)]?\s*[：:]?\s*/i,
          '',
        )
        // `（均 minor，无 major/blocker）：①…` —— 前置的"汇总说明"括号不是 issue 本体
        .replace(/^[（(][^）)]*?(?:无|none)[^）)]*?(?:major|blocker)[^）)]*?[）)]\s*[：:]?\s*/i, '')
        .replace(/^(?:issues\s*=\s*)?\d{1,2}\s*条?\s*[：:]\s*/i, '')
        // 库里还有 `issues=2条: 1)minor+事实:…; 2)minor+表达:…` 这种带编号的写法
        .replace(/^条\s*[：:]?\s*/, '')
        .replace(/^\d{1,2}\s*[)）.、]\s*(?=(?:blocker|major|minor)(?![a-z]))/i, '')
        .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '')
        .trim(),
    )
    .filter(Boolean)
}

/**
 * 解析独立审稿（SKILL §5.6 那一行）。返回
 * `{ok, score, selfScore, action, actionLabel, revisions, issues:[{severity,category,text}], issueCount, tail, raw}`。
 * `行动` 缺失（如 `审稿=未审(三门槛未过…)`）时 `action=''`，调用方照原文显示。
 */
export function parseReview(text) {
  const raw = String(text == null ? '' : text).trim()
  const out = {
    ok: false,
    raw,
    score: null,
    selfScore: null,
    action: '',
    actionLabel: '',
    revisions: null,
    issues: [],
    issueCount: null,
    tail: '',
  }
  if (!raw) return out
  const scoreM = /审稿\s*[=:：]\s*(\d{1,3}|[\u4e00-\u9fa5A-Za-z/]+)/.exec(raw)
  const selfM = /自评\s*[=:：]\s*(\d{1,3})/.exec(raw)
  const actM = /行动\s*[=:：]\s*([A-Za-z\u4e00-\u9fa5]+)/.exec(raw)
  const revM = /修订\s*[=:：]\s*(\d{1,2})/.exec(raw)
  const cntM = /issues\s*[=:：]\s*(\d{1,2})/.exec(raw.exec ? raw : raw)
  const scoreVal = scoreM ? numberOrText(scoreM[1]) : { n: null, text: '' }
  out.score = scoreVal.n
  out.selfScore = selfM ? Number(selfM[1]) : null
  out.action = actM ? actM[1] : ''
  out.actionLabel = { publish: '发布', revise: '修订', block: '拦截' }[out.action] || out.action
  out.revisions = revM ? Number(revM[1]) : null
  out.issueCount = cntM ? Number(cntM[1]) : null
  // issues 正文 = `issues=` 之后到行尾（可能被 ` 修订=` 之类截断，这里保留全部，按分隔符切）
  const issueSeg = /issues\s*[=:：]\s*\d{0,2}\s*[（(]?\s*([\s\S]*)$/.exec(raw)
  const body = issueSeg ? issueSeg[1].replace(/[）)]\s*$/, '') : ''
  const items = splitIssues(body)
  for (const it of items) {
    const severity = readSeverity(it)
    const category = readCategory(it)
    const text = it
      .replace(/^(?:blocker|major|minor)\s*[：:/+、\-\s]*/i, '')
      .replace(/^(?:blocker|major|minor)\s+/i, '')
      .trim()
    const cleaned = text
      .replace(new RegExp(`^${category}\\s*[：:/+\\-、]?\\s*`), '')
      // 剥掉严重度与分类后，行首残留的连接符（`+`、`:`、`-`）也清掉
      .replace(/^[：:/+、\-\s]+/, '')
      .trim()
    if (!cleaned && !severity) continue
    out.issues.push({ severity, category, text: cleaned || text })
  }
  // `审稿=未审(三门槛未过…)` 这类：没有 行动 也没有 issues，把括号里的原因留成 tail
  if (!out.action && !out.issues.length) {
    const m = /审稿\s*[=:：]\s*[^（(]*[（(]([^）)]+)[）)]/.exec(raw)
    out.tail = m ? m[1].trim() : scoreVal.text && scoreVal.n === null ? scoreVal.text : ''
  }
  out.ok = !!(out.action || out.issues.length || out.score !== null || out.tail)
  return out
}

/** 决策徽标用色：重复风险 low/medium/high */
const RISK_CLASS = (risk) => {
  const t = String(risk || '').toLowerCase()
  if (/high|高/.test(t)) return 'high'
  if (/medium|中/.test(t)) return 'medium'
  if (/low|低/.test(t)) return 'low'
  return ''
}

/** 行动徽标用色 */
const ACTION_CLASS = (action) =>
  ({ publish: 'pass', revise: 'partial', block: 'fail' })[action] || 'skip'

/** 编辑决策：徽标 + 主线 + 理由 + 重复风险 + 写作指令（缺哪块少哪块） */
export function decisionDetailHtml(text) {
  const d = parseDecision(stripSpecRefs(text))
  if (!d.raw) return '<span class="ai-meta">未记录</span>'
  if (!d.ok) return `<span class="ai-detect-raw">${escapeHtml(d.raw)}</span>`
  const rows = []
  if (d.reason)
    rows.push(`<div class="ed-row"><span class="ed-k">理由</span>${escapeHtml(d.reason)}</div>`)
  if (d.risk || d.avoid)
    rows.push(
      `<div class="ed-row"><span class="ed-k">重复风险</span><span class="ed-v">${
        d.risk ? `<span class="ed-badge ${RISK_CLASS(d.risk)}">${escapeHtml(d.risk)}</span>` : ''
      }${d.avoid ? `<span class="ed-avoid">避开：${escapeHtml(d.avoid)}</span>` : ''}</span></div>`,
    )
  if (d.instructions.length)
    rows.push(
      `<div class="ed-row"><span class="ed-k">写作指令</span><ol class="ed-list">${d.instructions
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join('')}</ol></div>`,
    )
  for (const n of d.notes)
    rows.push(
      `<div class="ed-row"><span class="ed-k">${escapeHtml(n.k)}</span>${escapeHtml(n.v)}</div>`,
    )
  return (
    `<div class="ed-block">` +
    `<div class="ed-main">${escapeHtml(d.main || '（未写主线）')}</div>` +
    rows.join('') +
    `</div>`
  )
}

/** 独立审稿：行动徽标 + 分数 + 逐条 issue（严重度/分类各自成标签） */
export function reviewDetailHtml(text) {
  const r = parseReview(stripSpecRefs(text))
  if (!r.raw) return '<span class="ai-meta">未记录</span>'
  if (!r.ok) return `<span class="ai-detect-raw">${escapeHtml(r.raw)}</span>`
  const head = []
  if (r.action)
    head.push(
      `<span class="ai-verdict ${ACTION_CLASS(r.action)}">${escapeHtml(r.actionLabel)}</span>`,
    )
  if (r.score !== null) head.push(`<span class="ed-score">审稿 <b>${r.score}</b></span>`)
  if (r.selfScore !== null) head.push(`<span class="ed-score">自评 ${r.selfScore}</span>`)
  if (r.revisions !== null) head.push(`<span class="ed-score">修订 ${r.revisions} 次</span>`)
  if (!head.length) head.push(`<span class="ai-verdict skip">未审</span>`)
  const countTxt = r.issues.length
    ? `<div class="ed-issues-head">issues ${r.issueCount === null ? r.issues.length : r.issueCount}</div>`
    : ''
  const list = r.issues.length
    ? `<ul class="ed-issues">${r.issues
        .map(
          (i) =>
            `<li>${i.severity ? `<span class="ed-sev ${i.severity}">${i.severity}</span>` : ''}${
              i.category ? `<span class="ed-cat">${escapeHtml(i.category)}</span>` : ''
            }${escapeHtml(i.text)}</li>`,
        )
        .join('')}</ul>`
    : ''
  const tail = r.tail
    ? `<div class="ed-row"><span class="ed-k">说明</span>${escapeHtml(r.tail)}</div>`
    : ''
  return `<div class="ed-block"><div class="ed-line">${head.join('')}</div>${countTxt}${list}${tail}</div>`
}

/** 时间线里的一行（窄位置）：行动徽标 + 分数 + issues 条数；没走到审稿的给「未审 + 原因」 */
export function reviewInlineHtml(text) {
  const r = parseReview(stripSpecRefs(text))
  if (!r.raw) return ''
  if (!r.ok) return `<span class="ai-detect-raw">${escapeHtml(r.raw)}</span>`
  const parts = []
  if (r.action)
    parts.push(
      `<span class="ai-verdict sm ${ACTION_CLASS(r.action)}">${escapeHtml(r.actionLabel)}</span>`,
    )
  else if (r.tail) parts.push('<span class="ai-verdict sm skip">未审</span>')
  if (r.score !== null) parts.push(`<span class="ai-head">审稿 ${r.score}</span>`)
  if (r.issues.length) parts.push(`<span class="ai-meta-inline">issues ${r.issues.length}</span>`)
  // `审稿=未审(原因)` / `审稿=n/a(不进入:…)`：原因就是这一行唯一的信息，不能留空
  if (r.tail && !r.action && !r.issues.length)
    parts.push(`<span class="ai-meta-inline">${escapeHtml(r.tail)}</span>`)
  return parts.join('')
}

/** 时间线里的一行：决策只留主线（一行放不下理由与指令） */
export function decisionInlineHtml(text) {
  const d = parseDecision(stripSpecRefs(text))
  if (!d.raw) return ''
  if (!d.ok) return `<span class="ai-detect-raw">${escapeHtml(d.raw)}</span>`
  return `<span class="ed-inline">${escapeHtml(d.main || d.raw)}</span>`
}
