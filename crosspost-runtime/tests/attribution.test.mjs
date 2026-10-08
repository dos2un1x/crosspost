// 署名注释护栏（2026-10-08）
//
// 目的：自研代码文件里都带一行署名注释（作者 dos2un1x + 仓库地址），这条规则由本测试钉住 ——
// 否则新增文件不会带、老文件也可能被顺手清掉，署名就慢慢没了。
//
// 范围与"能不能放注释"绑定（同名的落点脚本用的是同一份清单）：
//   · JS 家族（.mjs/.js/.cjs/.mts/.ts/.tsx/.jsx）、CSS、HTML、shell、Python、YAML、TOML、
//     Dockerfile、.env.example —— 都有注释语法，可以带；
//   · **JSON 不在范围内**（没有注释语法）：这类文件的署名走 package.json 的 `author` 字段。
// 第三方与生成物一律排除（node_modules / vendor / dist / .local / md-backup），
// 它们不是"自研代码"，也不该被改。
//
// 判据取"最弱但足够"的一条：文件里出现仓库地址**且**出现作者名（不限定措辞与位置）。
// 这样落点脚本可以按文件随机挑位置、换措辞，而护栏只保证"署名还在"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')

const REPO_URL = 'https://github.com/dos2un1x/crosspost'
const AUTHOR = 'dos2un1x'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  'dist',
  'md-backup',
  '.local',
  'coverage',
  '.cache',
])

/** 能安全放注释的自研代码文件（JSON 不在内：无注释语法） */
const EXTS = [
  '.mjs',
  '.js',
  '.cjs',
  '.mts',
  '.ts',
  '.tsx',
  '.jsx',
  '.css',
  '.scss',
  '.html',
  '.htm',
  '.sh',
  '.bash',
  '.py',
  '.yml',
  '.yaml',
  '.toml',
  '.example',
]
const NAMES = ['Dockerfile']

const isTarget = (name) =>
  (EXTS.some((e) => name.endsWith(e)) && !name.includes('.min.')) || NAMES.includes(name)

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), acc)
    } else if (isTarget(e.name)) {
      acc.push(path.join(dir, e.name))
    }
  }
  return acc
}

test('署名：自研代码文件都带作者与仓库地址（package.json 走 author 字段）', () => {
  const files = walk(ROOT)
  assert.ok(files.length > 100, `应扫到足量自研代码文件，实际 ${files.length}`)
  const missing = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    if (!src.includes(REPO_URL) || !src.includes(AUTHOR)) missing.push(path.relative(ROOT, f))
  }
  assert.deepEqual(
    missing,
    [],
    `以下文件缺署名注释（作者 ${AUTHOR} + ${REPO_URL}）：\n` + missing.slice(0, 20).join('\n'),
  )
})

test('署名：package.json 的 author 字段（JSON 放不下注释，署名只在这里）', () => {
  for (const rel of [
    'package.json',
    'crosspost-runtime/package.json',
    'bridge/package.json',
    'crosspost-runtime/core/package.json',
  ]) {
    const p = path.join(ROOT, rel)
    if (!fs.existsSync(p)) continue
    const d = JSON.parse(fs.readFileSync(p, 'utf8'))
    const name = typeof d.author === 'string' ? d.author : (d.author && d.author.name) || ''
    assert.ok(
      String(name).includes(AUTHOR),
      `${rel} 的 author 必须含 ${AUTHOR}，实际：${JSON.stringify(d.author)}`,
    )
  }
})
