// Console 字段形状护栏（2026-10-04）
//
// 背景（实测踩到）：选题库里出现过**字段错位**的记录——`title` 里装的是分数（数字）、
// `status` 里装的是落选原因。Console 渲染那一行时执行 `(t.title || '').slice(0, 48)`，
// 对数字调 `.slice` 抛异常；而 `loadTopics` 的兜底把**任何**异常都写成
// 「无法连接 Bridge: …」→ 一个**数据形状**问题被报成**连接**问题，排查方向直接跑偏
// （当时的报错原文：`无法连接 Bridge: (t.title || '').slice is not a function`）。
//
// 两类东西必须钉住，否则下次换个字段还会重演：
//   ① 引擎渲染**不许**对"可能是数字/对象"的字段直接调字符串方法——必须先 `String(...)`；
//   ② 取数失败与渲染失败**不许共用**同一句"无法连接 Bridge"。
//
// 设计取舍：静态扫描而不是起浏览器。这条护栏要守的是"哪里写错了"，静态就够了，
// 而且不依赖 playwright、任何机器都能跑。
// © dos2un1x · https://github.com/dos2un1x/crosspost
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const MODULES = path.join(REPO, 'bridge', 'console', 'modules')

/** 对数据字段直接调字符串方法（未先 String(...)）——数字/对象字段会让它抛异常 */
const HAZARD = /\((?:[A-Za-z_$][\w$]*\.)?\w+ \|\| ''\)\.(slice|toLowerCase|trim|split)\b/

const moduleFiles = fs
  .readdirSync(MODULES)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => path.join(MODULES, f))

/** 注释行不算（规则陈述本身要能把被禁的写法引出来） */
const isComment = (line) => {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

test('Console 渲染：对数据字段不得直接调字符串方法（先 String(...)）', () => {
  const offenders = []
  for (const file of moduleFiles) {
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (isComment(line)) return
        if (!HAZARD.test(line)) return
        if (line.includes('String(')) return
        offenders.push(`${path.relative(REPO, file)}:${i + 1}  ${line.trim()}`)
      })
  }
  assert.deepEqual(
    offenders,
    [],
    '这些位置会把数字/对象字段当字符串用（`.slice` / `.toLowerCase` 会抛异常，且很容易被\n' +
      '取数兜底误报成"无法连接 Bridge"）：\n  ' +
      offenders.join('\n  ') +
      "\n\n修法：`String(x.title ?? '')`，或在渲染前把字段规整成字符串。",
  )
})

test('Console 取数：渲染失败不得写成"无法连接 Bridge"（两者必须分开兜底）', () => {
  const topics = fs.readFileSync(path.join(MODULES, 'views-topics.mjs'), 'utf8')
  assert.match(topics, /无法连接 Bridge/, '取数失败仍应给出连接类提示')
  assert.match(
    topics,
    /渲染失败/,
    '选题库渲染异常必须有**自己的**文案——与连接失败混用会把数据问题报成连接问题',
  )

  const articles = fs.readFileSync(path.join(MODULES, 'views-articles.mjs'), 'utf8')
  assert.match(
    articles,
    /渲染失败/,
    '文章列表的刷新兜底只能是渲染失败（loadArticles 自己吞掉取数失败）',
  )
})
