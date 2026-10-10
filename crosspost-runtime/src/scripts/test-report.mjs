#!/usr/bin/env node
/**
 * 全量测试**耗时报表**（v2.7.4）
 *
 * ## 干什么
 *
 * 跑一遍 runtime 单测套件（或读一份已有的 JUnit XML 重出报表），把耗时摊开成一份可看的
 * HTML + 三份机器可读数据：哪个文件、哪条用例在吃掉时间，以及本轮相对**上一次**的涨跌。
 *
 * 为什么要有它：套件的墙钟是"进程启动 + 用例时间 + 争用"三者之和，靠眼睛看 `npm test`
 * 的汇总只能得到一个总数 —— 想优化时不知道从哪下手（实测里前 10 个文件占掉用例时间合计的
 * 四成，而 74% 的用例不到 100ms）。有了这份报表，"该动哪一条"是可查的。
 *
 * ## 口径（报表里也写着，别改口径不写）
 *
 *   · **墙钟**：整轮真实耗时（`/usr/bin/time` 的 `real`，取不到时用本进程计时）
 *   · **CPU**：`user + sys`（`/usr/bin/time` 读；缺失时报表显示 `—`，不猜）
 *   · **文件耗时**：该文件内各用例 `time` 之和。并行运行时**不含**进程启动，且跨文件不可
 *     直接相加去比墙钟（并行会重叠）—— 它的用途是"找热点"，不是"算总账"
 *   · **平均占用核数**：CPU ÷ 墙钟 ÷ 核数。它离 100% 越远，说明墙钟里"启动 + 争用"占比越大
 *
 * ## 用法
 *
 *   npm run test:report                        # 跑 runtime 全量 + 出报表
 *   npm run test:report -- --from=<junit.xml>  # 用已有 JUnit 重出报表（不重跑，秒级）
 *   npm run test:report -- --out=<dir>         # 指定输出目录
 *   npm run test:report -- --label=<名字>       # 报表标题（默认取当前 tag/分支）
 *   npm run test:report -- --open              # 出完打开 HTML（macOS/Linux）
 *   npm run test:report -- --top=30            # 表格里列前 N 条（默认 20）
 *
 * 产物（默认 `.local/reports/test-timing/<时间戳>/`，该目录在 .gitignore 里）：
 *   `report.html` · `report.md` · `per-file.csv` · `slowest-cases.csv` · `summary.json` · `junit.xml`
 * 另有 `.local/reports/test-timing/latest.json` 指向最近一次，供"对比上次"用（无则不显示对比）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..', '..')
const REPO = path.resolve(RUNTIME, '..')
const BASE_OUT = path.join(REPO, '.local', 'reports', 'test-timing')
const TIME_BIN = '/usr/bin/time'
const TIME_FMT = /^\s*(real|user|sys)\s+([\d.]+)\s*$/gm

/* ────────────────────────────── 解析 ────────────────────────────── */

/**
 * 把 JUnit 里的 `file` 归一成**相对仓库根**的路径。
 *
 * 为什么两段式：`file` 是**跑测试那台机器**的绝对路径。本机跑时按仓库前缀剥离；但这份 XML
 * 也可能来自 CI 产物或别人机器（`--from` 正是为这种场景留的）——那时前缀不同、尾巴稳定，
 * 所以回退到 `crosspost-runtime/` 之后的部分（仓库结构就是锚点）。
 */
const rel = (p) => {
  const s = String(p || '').replace(/\\/g, '/')
  const root = `${REPO.replace(/\\/g, '/')}/`
  if (s.startsWith(root)) return s.slice(root.length)
  const i = s.indexOf('/crosspost-runtime/')
  if (i >= 0) return s.slice(i + 1)
  return s.replace(/^\/+/, '')
}

/**
 * 解析 `node --test --test-reporter=junit` 的输出（扁平 `<testcase file=… time=…>`）。
 * 返回的 `file` 一律**相对仓库根**，便于报表阅读与跨机器对比。
 *
 * 为什么手写引号感知的扫描而不是一条正则：**属性值里可以出现裸 `>`**
 * （XML 只要求转义 `<` 与 `&`）。实测就有一堆用例名带 `显式 > config 默认 > 兜底`／
 * `escapeHtml 转义 & < > "` —— 用 `[^>]*` 抓属性的正则会从第一个 `>` 处断掉，
 * 那些用例被**静默漏掉**（805 条只解析出 789 条，报表数字随之偏小）。所以按引号状态找标签结束。
 */
export function parseJUnit(xml) {
  const cases = []
  const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g
  const unesc = (s) =>
    String(s ?? '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')

  const tagRe = /<testcase\b/g
  let m
  while ((m = tagRe.exec(xml))) {
    // 从标签名之后扫到标签结束：引号内的 `>` 不算结束
    let i = m.index + m[0].length
    let inQuote = false
    let end = -1
    for (; i < xml.length; i++) {
      const ch = xml[i]
      if (ch === '"') inQuote = !inQuote
      else if (ch === '>' && !inQuote) {
        end = i
        break
      }
    }
    if (end < 0) break

    const attrsRaw = xml.slice(m.index + m[0].length, end)
    let body = ''
    if (!attrsRaw.trimEnd().endsWith('/')) {
      const close = xml.indexOf('</testcase>', end)
      body = close > 0 ? xml.slice(end + 1, close) : ''
      if (close > 0) tagRe.lastIndex = close
    }

    const attrs = {}
    ATTR.lastIndex = 0
    let a
    while ((a = ATTR.exec(attrsRaw))) attrs[a[1]] = a[2]

    cases.push({
      name: unesc(attrs.name),
      file: rel(unesc(attrs.file)),
      time: Number(attrs.time) || 0,
      failed: /<failure\b/.test(body),
      skipped: /<skipped\b/.test(body),
    })
  }
  return cases
}

/* ────────────────────────────── 统计 ────────────────────────────── */

export const BUCKETS = [
  ['<1ms', 0, 0.001],
  ['1–10ms', 0.001, 0.01],
  ['10–100ms', 0.01, 0.1],
  ['0.1–1s', 0.1, 1],
  ['1–3s', 1, 3],
  ['>3s', 3, Infinity],
]

export function bucketOf(t) {
  const i = BUCKETS.findIndex(([, lo, hi]) => t >= lo && t < hi)
  return i < 0 ? BUCKETS.length - 1 : i
}

/**
 * 把用例列表折成报表结构（纯函数，测试直接喂假数据）。
 * `meta` 里的 wall/cpu 允许为 null（`--from` 重出报表时拿不到），报表显示 `—` 而不是 0。
 */
export function buildReport(cases, meta = {}) {
  const byFile = new Map()
  for (const c of cases) {
    if (!byFile.has(c.file)) byFile.set(c.file, [])
    byFile.get(c.file).push(c)
  }
  const files = [...byFile.entries()]
    .map(([file, cs]) => {
      const times = cs.map((c) => c.time)
      const slowest = cs.reduce((a, b) => (b.time > a.time ? b : a))
      return {
        file,
        cases: cs.length,
        total: times.reduce((a, b) => a + b, 0),
        max: slowest.time,
        slowestCase: slowest.name,
      }
    })
    .sort((a, b) => b.total - a.total)

  const slowest = [...cases].sort((a, b) => b.time - a.time)
  const totalCaseTime = cases.reduce((a, c) => a + c.time, 0)
  const buckets = BUCKETS.map(([label], i) => ({
    label,
    count: cases.filter((c) => bucketOf(c.time) === i).length,
  }))

  return {
    meta,
    counts: {
      cases: cases.length,
      files: files.length,
      failed: cases.filter((c) => c.failed).length,
      skipped: cases.filter((c) => c.skipped).length,
    },
    totals: {
      wall: meta.wall ?? null,
      cpu: meta.cpu ?? null,
      caseTime: totalCaseTime,
      avgCores: meta.wall && meta.cpu ? meta.cpu / meta.wall : null,
    },
    buckets,
    files,
    slowest,
  }
}

/** 与上一次对比（`prev` 可为 null；只比能比的三项） */
export function compareReports(prev, cur) {
  if (!prev) return null
  const pick = (r) => ({
    wall: r?.totals?.wall ?? r?.wall ?? null,
    cpu: r?.totals?.cpu ?? r?.cpu ?? null,
    cases: r?.counts?.cases ?? r?.cases ?? null,
  })
  const a = pick(prev)
  const b = pick(cur)
  const d = {}
  for (const k of ['wall', 'cpu', 'cases']) {
    d[k] = a[k] != null && b[k] != null && a[k] !== 0 ? b[k] - a[k] : null
  }
  return { prev: a, cur: b, delta: d }
}

/* ────────────────────────────── 渲染 ────────────────────────────── */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const secs = (v) => (v == null ? '—' : `${v.toFixed(2)}s`)

function deltaBadge(cur, prev, unit = 's') {
  if (cur == null || prev == null || !prev) return ''
  const d = cur - prev
  const cls = d < 0 ? 'good' : 'bad'
  const sign = d < 0 ? '▼' : '▲'
  return `<span class="${cls}">${sign} ${Math.abs(d).toFixed(1)}${unit}（${((Math.abs(d) / prev) * 100).toFixed(0)}%）</span>`
}

function bar(v, vmax, color) {
  const pct = vmax ? Math.max(0, (v / vmax) * 100) : 0
  return `<span class="bar"><i style="width:${pct.toFixed(1)}%;background:${color}"></i></span>`
}

export function renderHtml(r, cmp) {
  const top = r.meta.top || 20
  const totalCaseTime = r.totals.caseTime || 1
  const bucketMax = Math.max(...r.buckets.map((b) => b.count), 1)
  const rowsBucket = r.buckets
    .map(
      (b) =>
        `<tr><td class="mono">${esc(b.label)}</td><td class="num">${b.count}</td>` +
        `<td class="num">${((b.count / (r.counts.cases || 1)) * 100).toFixed(0)}%</td>` +
        `<td>${bar(b.count, bucketMax, '#1971c2')}</td></tr>`,
    )
    .join('\n')

  const rowsCases = r.slowest
    .slice(0, top)
    .map(
      (c, i) =>
        `<tr><td class="num">${i + 1}</td><td>${esc(c.name.slice(0, 78))}</td>` +
        `<td class="mono">${esc(c.file.replace('crosspost-runtime/tests/', ''))}</td>` +
        `<td class="num"><b>${c.time.toFixed(2)}s</b></td>` +
        `<td>${bar(c.time, r.slowest[0]?.time || 1, '#e8590c')}</td></tr>`,
    )
    .join('\n')

  const rowsFiles = r.files
    .map(
      (f) =>
        `<tr><td class="mono">${esc(f.file)}</td><td class="num">${f.cases}</td>` +
        `<td class="num"><b>${f.total.toFixed(2)}s</b></td>` +
        `<td class="num">${((f.total / totalCaseTime) * 100).toFixed(1)}%</td>` +
        `<td>${bar(f.total, r.files[0]?.total || 1, '#2f9e44')}</td>` +
        `<td class="num">${f.max.toFixed(2)}s</td><td class="dim">${esc(f.slowestCase.slice(0, 46))}</td></tr>`,
    )
    .join('\n')

  const m = r.meta
  return `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>CrossPost 测试耗时报表 · ${esc(m.when)}</title>
<style>
:root{--fg:#1f2328;--dim:#6b7280;--line:#e5e7eb;--bg:#f6f7f9;--card:#fff}
*{box-sizing:border-box}
body{margin:0;padding:28px 32px 60px;background:var(--bg);color:var(--fg);
  font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif}
h1{font-size:21px;margin:0 0 4px}
h2{font-size:15px;margin:30px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.sub{color:var(--dim);font-size:12.5px;margin-bottom:18px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:10px;margin:16px 0 8px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kpi .k{font-size:11.5px;color:var(--dim)}
.kpi .v{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:2px}
.kpi .d{font-size:11.5px;color:var(--dim);margin-top:2px}
.good{color:#2f9e44}.bad{color:#e03131}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);
  border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
th{background:#fafbfc;font-size:11.5px;color:var(--dim);font-weight:600;position:sticky;top:0}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.mono,th.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
td.dim{color:var(--dim);font-size:12px}
.bar{display:inline-block;width:160px;height:8px;background:#eef0f2;border-radius:5px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:5px}
.wrap{max-height:560px;overflow:auto;border-radius:10px}
.note{color:var(--dim);font-size:12px;margin-top:10px}
code{background:#eef0f2;padding:1px 5px;border-radius:4px;font-size:12px}
</style>
<h1>CrossPost 测试耗时报表</h1>
<div class="sub">${esc(m.when)} · <code>${esc(m.commit)}</code> · ${esc(m.node)} · ${m.cores} 核 ·
  命令 <code>${esc(m.command)}</code>（${r.counts.cases} 例 / ${r.counts.files} 文件 ·
  ${r.counts.failed} 失败 · ${r.counts.skipped} 跳过）${m.label ? ` · ${esc(m.label)}` : ''}</div>

<div class="kpis">
  <div class="kpi"><div class="k">整轮墙钟</div><div class="v">${secs(r.totals.wall)}</div>
    <div class="d">${cmp ? deltaBadge(r.totals.wall, cmp.prev.wall) + ' vs 上次' : '首次记录'}</div></div>
  <div class="kpi"><div class="k">CPU 时间（user+sys）</div><div class="v">${r.totals.cpu == null ? '—' : `${r.totals.cpu.toFixed(0)}s`}</div>
    <div class="d">${cmp ? deltaBadge(r.totals.cpu, cmp.prev.cpu) + ' vs 上次' : '取不到 /usr/bin/time 时显示 —'}</div></div>
  <div class="kpi"><div class="k">平均占用核数</div>
    <div class="v">${r.totals.avgCores == null ? '—' : `${r.totals.avgCores.toFixed(1)} / ${m.cores}`}</div>
    <div class="d">CPU ÷ 墙钟；离满核越远，启动与争用占比越大</div></div>
  <div class="kpi"><div class="k">用例数 / 文件数</div><div class="v">${r.counts.cases} / ${r.counts.files}</div>
    <div class="d">${r.counts.failed} 失败 · ${r.counts.skipped} 跳过</div></div>
  <div class="kpi"><div class="k">用例时间合计</div><div class="v">${r.totals.caseTime.toFixed(0)}s</div>
    <div class="d">各用例之和（并行前；含等待）</div></div>
  <div class="kpi"><div class="k">最慢单条用例</div>
    <div class="v">${r.slowest[0] ? `${r.slowest[0].time.toFixed(2)}s` : '—'}</div>
    <div class="d">${r.slowest[0] ? esc(r.slowest[0].name.slice(0, 34)) : '无用例'}</div></div>
</div>

<h2>耗时分布（${r.counts.cases} 条用例）</h2>
<table><tr><th>区间</th><th class="num">条数</th><th class="num">占比</th><th>分布</th></tr>
${rowsBucket}</table>

<h2>最慢的 ${Math.min(top, r.slowest.length)} 条用例</h2>
<table><tr><th class="num">#</th><th>用例</th><th class="mono">文件</th><th class="num">耗时</th><th>相对</th></tr>
${rowsCases}</table>

<h2>各文件耗时（${r.counts.files} 个，按合计降序）</h2>
<div class="wrap"><table>
<tr><th class="mono">文件</th><th class="num">用例</th><th class="num">合计</th><th class="num">占比</th>
<th>相对</th><th class="num">最慢</th><th>最慢的那条</th></tr>
${rowsFiles}</table></div>
<div class="note">口径：<b>墙钟</b>=整轮真实耗时；<b>CPU</b>=<code>/usr/bin/time</code> 的 user+sys；
<b>文件合计</b>=该文件内各用例 <code>time</code> 之和（并行运行下<b>不含</b>进程启动，跨文件不可直接相加去比墙钟——
它的用途是找热点）。原始数据：同目录 <code>per-file.csv</code> / <code>slowest-cases.csv</code> / <code>summary.json</code> / <code>junit.xml</code>
</div>
</html>`
}

export function renderMarkdown(r, cmp) {
  const top = r.meta.top || 20
  const totalCaseTime = r.totals.caseTime || 1
  const lines = [
    '# CrossPost 测试耗时报表',
    '',
    `- 生成：${r.meta.when} · \`${r.meta.commit}\` · ${r.meta.node} · ${r.meta.cores} 核`,
    `- 命令：\`${r.meta.command}\`（${r.counts.cases} 例 / ${r.counts.files} 文件 · ${r.counts.failed} 失败 · ${r.counts.skipped} 跳过）`,
    `- 墙钟 **${secs(r.totals.wall)}**${cmp && cmp.delta.wall != null ? `（较上次 ${cmp.delta.wall > 0 ? '+' : ''}${cmp.delta.wall.toFixed(1)}s）` : ''} · ` +
      `CPU **${r.totals.cpu == null ? '—' : `${r.totals.cpu.toFixed(0)}s`}** · 平均占用 ${r.totals.avgCores == null ? '—' : r.totals.avgCores.toFixed(1)} / ${r.meta.cores} 核`,
    '',
    `## 最慢的 ${Math.min(top, r.files.length)} 个文件`,
    '',
    '| 文件 | 用例 | 合计 | 占比 | 最慢单条 |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...r.files
      .slice(0, top)
      .map(
        (f) =>
          `| \`${f.file.replace('crosspost-runtime/tests/', '')}\` | ${f.cases} | ${f.total.toFixed(2)}s | ${((f.total / totalCaseTime) * 100).toFixed(1)}% | ${f.max.toFixed(2)}s |`,
      ),
    '',
    `## 最慢的 ${Math.min(top, r.slowest.length)} 条用例`,
    '',
    '| 用例 | 文件 | 耗时 |',
    '| --- | --- | ---: |',
    ...r.slowest
      .slice(0, top)
      .map(
        (c) =>
          `| ${c.name.slice(0, 60)} | \`${c.file.replace('crosspost-runtime/tests/', '')}\` | ${c.time.toFixed(2)}s |`,
      ),
    '',
    '## 耗时分布',
    '',
    '| 区间 | 条数 | 占比 |',
    '| --- | ---: | ---: |',
    ...r.buckets.map(
      (b) =>
        `| ${b.label} | ${b.count} | ${((b.count / (r.counts.cases || 1)) * 100).toFixed(0)}% |`,
    ),
    '',
  ]
  return lines.join('\n')
}

export function renderPerFileCsv(r) {
  const totalCaseTime = r.totals.caseTime || 1
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`
  return [
    'file,cases,total_s,share_pct,max_s,slowest_case',
    ...r.files.map((f) =>
      [
        q(f.file),
        f.cases,
        f.total.toFixed(3),
        ((f.total / totalCaseTime) * 100).toFixed(2),
        f.max.toFixed(3),
        q(f.slowestCase),
      ].join(','),
    ),
  ].join('\n')
}

export function renderSlowestCsv(r) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`
  return [
    'case,file,time_s',
    ...r.slowest.map((c) => [q(c.name), q(c.file), c.time.toFixed(3)].join(',')),
  ].join('\n')
}

/* ────────────────────────────── 跑套件 ────────────────────────────── */

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function git(args) {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

/** 跑套件，边跑边把输出透传给用户；返回 { wall, cpu, junitPath } */
export function runSuite({ label, junitPath, quiet }) {
  const hasTime = fs.existsSync(TIME_BIN)
  const nodeArgs = [
    '--test',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=junit',
    `--test-reporter-destination=${junitPath}`,
    'tests/*.test.mjs',
  ]
  const cmd = hasTime ? TIME_BIN : process.execPath
  const args = hasTime ? ['-p', process.execPath, ...nodeArgs] : nodeArgs
  const t0 = process.hrtime.bigint()
  const child = spawn(cmd, args, { cwd: RUNTIME, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  child.stdout.on('data', (b) => {
    if (!quiet) process.stdout.write(b)
  })
  child.stderr.on('data', (b) => {
    err += b.toString()
    if (!quiet) process.stderr.write(b)
  })
  const done = new Promise((resolve) => child.on('close', resolve))
  return done.then(() => {
    const wall = Number(process.hrtime.bigint() - t0) / 1e9
    let cpu = null
    let m
    TIME_FMT.lastIndex = 0
    const stats = {}
    while ((m = TIME_FMT.exec(err))) stats[m[1]] = Number(m[2])
    if (hasTime && stats.user != null) cpu = stats.user + (stats.sys || 0)
    return { wall: stats.real ?? wall, cpu, label }
  })
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

export async function main(argv = []) {
  const flag = (n) => argv.includes(n)
  const opt = (n, d = null) => {
    const hit = argv.find((a) => a === n || a.startsWith(`${n}=`))
    if (!hit) return d
    return hit.includes('=') ? hit.split('=').slice(1).join('=') : true
  }
  const from = opt('--from')
  const outDir = opt('--out') || path.join(BASE_OUT, stamp())
  const top = Number(opt('--top', 20)) || 20
  const label = opt('--label') || (opt('--from') ? '' : 'tests/*.test.mjs')

  fs.mkdirSync(outDir, { recursive: true })
  const junitPath = path.join(outDir, 'junit.xml')

  let wall = null
  let cpu = null
  let command
  if (from && from !== true) {
    if (!fs.existsSync(from)) throw new Error(`--from 指向的文件不存在：${from}`)
    fs.copyFileSync(from, junitPath)
    command = `--from ${rel(from)}`
  } else {
    command = 'node --test "tests/*.test.mjs"'
    const r = await runSuite({ label, junitPath, quiet: flag('--quiet') })
    wall = r.wall
    cpu = r.cpu
  }

  const cases = parseJUnit(fs.readFileSync(junitPath, 'utf8'))
  const meta = {
    when: new Date().toLocaleString('zh-CN', { hour12: false }),
    commit: git(['rev-parse', '--short', 'HEAD']) || '(no git)',
    node: process.version,
    cores: os.cpus().length,
    command,
    label: typeof label === 'string' ? label : '',
    top,
  }
  const report = buildReport(cases, { ...meta, wall, cpu })

  // 与上次对比（latest.json 指向的那份 summary.json）
  let cmp = null
  const latestPath = path.join(BASE_OUT, 'latest.json')
  try {
    const prevDir = JSON.parse(fs.readFileSync(latestPath, 'utf8')).dir
    cmp = compareReports(
      JSON.parse(fs.readFileSync(path.join(prevDir, 'summary.json'), 'utf8')),
      report,
    )
  } catch {
    /* 首次跑或上次产物被删 → 不显示对比 */
  }

  fs.writeFileSync(path.join(outDir, 'report.html'), renderHtml(report, cmp))
  fs.writeFileSync(path.join(outDir, 'report.md'), renderMarkdown(report, cmp))
  fs.writeFileSync(path.join(outDir, 'per-file.csv'), renderPerFileCsv(report))
  fs.writeFileSync(path.join(outDir, 'slowest-cases.csv'), renderSlowestCsv(report))
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify(
      {
        meta,
        counts: report.counts,
        totals: report.totals,
        buckets: report.buckets,
        topFiles: report.files.slice(0, 10).map((f) => ({ file: f.file, total: f.total })),
        topCases: report.slowest
          .slice(0, 10)
          .map((c) => ({ name: c.name, file: c.file, time: c.time })),
      },
      null,
      2,
    ),
  )
  /* `latest.json` 是"**本仓**最近一次"的指针：只有产物落在 `.local/reports/test-timing/`
   * 之下才更新它。否则（例如测试用 `--out=<临时目录>`、或使用者指到别处）会把仓库里的指针
   * 写到临时目录上 —— 实测被测试用例污染过：之后"较上次"读到一个已被删掉的目录。 */
  if (outDir.startsWith(BASE_OUT)) {
    fs.mkdirSync(BASE_OUT, { recursive: true })
    fs.writeFileSync(latestPath, JSON.stringify({ dir: outDir, at: meta.when }, null, 2))
  }

  const html = path.join(outDir, 'report.html')
  console.log(`\n✔ 耗时报表：${rel(html)}`)
  console.log(
    `  ${report.counts.cases} 例 / ${report.counts.files} 文件 · 墙钟 ${secs(report.totals.wall)} · ` +
      `CPU ${report.totals.cpu == null ? '—' : `${report.totals.cpu.toFixed(0)}s`} · ` +
      `平均占用 ${report.totals.avgCores == null ? '—' : report.totals.avgCores.toFixed(1)}/${meta.cores} 核` +
      (cmp?.delta?.wall != null
        ? `（较上次 ${cmp.delta.wall > 0 ? '+' : ''}${cmp.delta.wall.toFixed(1)}s）`
        : ''),
  )
  if (report.files[0]) {
    console.log(
      `  最慢文件：${report.files[0].file} ${report.files[0].total.toFixed(2)}s · ` +
        `最慢用例：${report.slowest[0].time.toFixed(2)}s ${report.slowest[0].name.slice(0, 44)}`,
    )
  }
  console.log(`  同目录：report.md · per-file.csv · slowest-cases.csv · summary.json`)
  if (flag('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    spawn(opener, [html], { detached: true, stdio: 'ignore' }).unref()
  }
  return { outDir, html, report }
}

const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntry) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`✖ 生成耗时报表失败：${(e && e.message) || e}`)
    process.exit(1)
  })
}

// 作者：dos2un1x · 项目：https://github.com/dos2un1x/crosspost
