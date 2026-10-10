/**
 * 「全量测试耗时报表」工具自身的测试
 *
 * 为什么工具也要测：报表的数字会被用来决定"下一步优化哪条用例" —— 统计算错就是
 * **指错方向**（把 0.4s 的用例排到第一、或者把分布区间算漏一档）。所以这里钉住四件事：
 *   ① JUnit 解析（含属性转义、缺失 file、`<failure>`/`<skipped>` 标记）
 *   ② 统计口径（文件聚合与排序、占比、区间分档边界、最慢排序）
 *   ③ 渲染（HTML 必须转义用例名里的尖括号；Markdown/CSV 的数字与列数）
 *   ④ 与上次对比（首次无对比、有对比时给出差值）
 * 另外跑一次 `--from` 端到端：给定一份 JUnit，必须真的落盘六个产物（不重跑套件）。
 */

// 作者：dos2un1x · 项目：https://github.com/dos2un1x/crosspost
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseJUnit,
  buildReport,
  bucketOf,
  compareReports,
  renderHtml,
  renderMarkdown,
  renderPerFileCsv,
  main,
} from '../src/scripts/test-report.mjs'

const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="甲：快的" time="0.002" classname="test" file="/Users/me/repo/crosspost-runtime/tests/a.test.mjs"/>
\t<testcase name="甲：慢的 &lt;带尖括号&gt;" time="1.5" classname="test" file="/Users/me/repo/crosspost-runtime/tests/a.test.mjs"/>
\t<testcase name="乙：中等的" time="0.2" classname="test" file="/Users/me/repo/crosspost-runtime/tests/b.test.mjs"><failure>炸了</failure></testcase>
\t<testcase name="乙：跳过的" time="0.0" classname="test" file="/Users/me/repo/crosspost-runtime/tests/b.test.mjs"><skipped/></testcase>
</testsuites>`

const relCases = parseJUnit(FIXTURE)

test('① 解析：属性转义、file 归一、failure/skipped 标记', () => {
  assert.equal(relCases.length, 4)
  const slow = relCases.find((c) => c.time === 1.5)
  assert.equal(slow.name, '甲：慢的 <带尖括号>', 'XML 实体必须还原（否则报表里是 &lt;）')
  assert.equal(slow.file, 'crosspost-runtime/tests/a.test.mjs', 'file 一律相对仓库根')
  assert.equal(slow.failed, false)
  assert.equal(relCases.find((c) => c.name === '乙：中等的').failed, true)
  assert.equal(relCases.find((c) => c.name === '乙：跳过的').skipped, true)
})

test('① 解析：属性值里的**裸 >** 不能让用例被静默漏掉（真实用例名就长这样）', () => {
  // 回归：XML 只要求转义 `<` 与 `&`，`>` 可裸写；旧实现用 `[^>]*` 抓属性，
  // 于是 `显式 > config 默认 > 兜底` 这类名字把标签截断 —— 805 条只解析出 789 条。
  // 下面两行**逐字**取自真实 JUnit（Node 只转义 `<` 与 `&`：`>` 裸写、
  // 名字里字面带 `&quot;` 时会被再转义成 `&amp;quot;`）。旧实现就是在这两行上翻车。
  const xml = [
    '<testsuites>',
    '\t<testcase name="publishArticle 平台解析：显式 > config 默认 > 兜底" time="4.19" classname="test" file="/x/crosspost-runtime/tests/a.test.mjs"/>',
    '\t<testcase name="escapeHtml 转义 &amp; &lt; > &amp;quot; \' " time="0.002" classname="test" file="/x/crosspost-runtime/tests/b.test.mjs"/>',
    '\t<testcase name="普通" time="0.001" classname="test" file="/x/crosspost-runtime/tests/c.test.mjs"/>',
    '</testsuites>',
  ].join('\n')
  const got = parseJUnit(xml)
  assert.equal(got.length, 3, '三条都要解析出来（裸 > 不能截断标签）')
  assert.equal(got[0].name, 'publishArticle 平台解析：显式 > config 默认 > 兜底')
  assert.equal(got[0].time, 4.19)
  assert.equal(got[0].file, 'crosspost-runtime/tests/a.test.mjs')
  assert.equal(
    got[1].name,
    "escapeHtml 转义 & < > &quot; ' ",
    '按 XML 规则还原（行尾那个引号是属性结束符，不属于名字）',
  )
})

test('② 统计：文件聚合排序 / 占比 / 计数', () => {
  const r = buildReport(relCases, { wall: 10, cpu: 40, cores: 8, top: 20 })
  assert.deepEqual(r.counts, { cases: 4, files: 2, failed: 1, skipped: 1 })
  assert.equal(r.files[0].file, 'crosspost-runtime/tests/a.test.mjs', '按合计降序')
  assert.equal(r.files[0].cases, 2)
  assert.ok(Math.abs(r.files[0].total - 1.502) < 1e-9, '文件合计 = 其用例之和')
  assert.equal(r.files[0].max, 1.5)
  assert.equal(r.files[0].slowestCase, '甲：慢的 <带尖括号>')
  assert.equal(r.slowest[0].time, 1.5, '最慢排序')
  assert.ok(Math.abs(r.totals.caseTime - 1.702) < 1e-9)
  assert.ok(Math.abs(r.totals.avgCores - 4) < 1e-9, 'CPU÷墙钟')
})

test('② 统计：区间分档的**边界**归到正确的一档', () => {
  assert.equal(bucketOf(0), 0)
  assert.equal(bucketOf(0.0009), 0)
  assert.equal(bucketOf(0.001), 1, '1ms 属于 1–10ms')
  assert.equal(bucketOf(0.0099), 1)
  assert.equal(bucketOf(0.01), 2)
  assert.equal(bucketOf(0.099), 2)
  assert.equal(bucketOf(0.1), 3)
  assert.equal(bucketOf(0.999), 3)
  assert.equal(bucketOf(1), 4)
  assert.equal(bucketOf(2.99), 4)
  assert.equal(bucketOf(3), 5)
  assert.equal(bucketOf(9999), 5, '再慢也落在最后一档')

  const r = buildReport(relCases, {})
  const by = Object.fromEntries(r.buckets.map((b) => [b.label, b.count]))
  // 夹具四条：0.0→<1ms · 0.002(2ms)→1–10ms · 0.2→0.1–1s · 1.5→1–3s
  assert.deepEqual(by, { '<1ms': 1, '1–10ms': 1, '10–100ms': 0, '0.1–1s': 1, '1–3s': 1, '>3s': 0 })
})

test('③ 渲染：HTML 转义、Markdown/CSV 结构', () => {
  const r = buildReport(relCases, {
    wall: 10.5,
    cpu: 40,
    cores: 8,
    when: 'T',
    commit: 'abc',
    node: 'v24',
    command: 'x',
    top: 20,
  })
  const html = renderHtml(r, null)
  assert.ok(html.includes('&lt;带尖括号&gt;'), '用例名里的尖括号必须转义（否则报表被注入/截断）')
  assert.ok(!html.includes('甲：慢的 <带尖括号>'), '不能出现未转义版本')
  assert.ok(html.includes('10.50s'), '墙钟带两位小数')

  // 负载高于核数时要明确警告："这次慢"可能是机器忙，而不是代码退化
  const busy = renderHtml(
    buildReport(relCases, {
      wall: 40,
      cpu: 100,
      cores: 8,
      load: 29.9,
      when: 'T',
      commit: 'a',
      node: 'v',
      command: 'x',
    }),
    null,
  )
  assert.ok(busy.includes('运行时机负载'), '满载运行时必须标注（否则"较上次"被误读成退化）')
  const idle = renderHtml(
    buildReport(relCases, {
      wall: 30,
      cpu: 100,
      cores: 8,
      load: 1.2,
      when: 'T',
      commit: 'a',
      node: 'v',
      command: 'x',
    }),
    null,
  )
  assert.ok(!idle.includes('运行时机负载'), '机器不忙时不打扰')

  const md = renderMarkdown(r, null)
  assert.ok(md.includes('# CrossPost 测试耗时报表'))
  assert.ok(md.includes('| `a.test.mjs` | 2 | 1.50s |'), '文件表含用例数与合计')

  const csv = renderPerFileCsv(r).split('\n')
  assert.equal(csv[0], 'file,cases,total_s,share_pct,max_s,slowest_case')
  assert.equal(csv.length, 3, '表头 + 两个文件')
  assert.ok(csv[1].includes('crosspost-runtime/tests/a.test.mjs'))
  assert.ok(
    csv[1].includes('"甲：慢的 <带尖括号>"'),
    '含逗号/引号的字段要加引号（最慢用例名带引号时会翻倍）',
  )

  const slowCsv = renderPerFileCsv({ ...r, files: [] })
  assert.equal(slowCsv.split('\n').length, 1, '空数据只留表头')
})

test('④ 对比：无上次不给对比；有上次给出差值（含变快/变慢的符号）', () => {
  const cur = buildReport(relCases, { wall: 10, cpu: 40 })
  assert.equal(compareReports(null, cur), null, '首次记录不显示对比')

  const prev = { totals: { wall: 12, cpu: 50 }, counts: { cases: 5 } }
  const cmp = compareReports(prev, cur)
  assert.equal(cmp.delta.wall, -2, '变快是负数')
  assert.equal(cmp.delta.cpu, -10)
  assert.equal(cmp.delta.cases, -1)

  // 缺字段（旧版 summary.json）不能让对比崩掉
  const cmp2 = compareReports({ wall: 12 }, cur)
  assert.equal(cmp2.delta.wall, -2, '旧格式（顶层 wall）也要认')
  assert.equal(cmp2.delta.cpu, null)
})

test('⑤ 端到端：--from 一份 JUnit → 落盘六个产物，且不重跑套件', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-report-'))
  const junit = path.join(tmp, 'in.xml')
  fs.writeFileSync(junit, FIXTURE)
  const out = path.join(tmp, 'out')
  try {
    const res = await main([`--from=${junit}`, `--out=${out}`, '--quiet'])
    for (const f of [
      'report.html',
      'report.md',
      'per-file.csv',
      'slowest-cases.csv',
      'summary.json',
      'junit.xml',
    ]) {
      assert.ok(fs.existsSync(path.join(out, f)), `缺少产物 ${f}`)
    }
    const sum = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'))
    assert.equal(sum.counts.cases, 4)
    assert.equal(sum.totals.wall, null, '--from 拿不到墙钟，如实为 null（报表显示 —）')
    assert.equal(sum.meta.command.startsWith('--from'), true)
    assert.equal(res.report.slowest[0].time, 1.5)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
