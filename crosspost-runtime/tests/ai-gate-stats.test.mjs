// parseGateSnapshot / aiGateStats 单测（2026-10-10）
//
// 背景：报表要按"记录里的门禁快照"统计这周达标几篇、平均特征占比多少。
// 记录里存的是**一行文本**（`formatSnapshot` 的输出），没有原始 JSON —— 所以格式的读与写
// 必须由同一个模块负责，且三种历史写法都要认（现行/旧版/跳过）。
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseGateSnapshot } from '../src/ai-detect.mjs'

test('parseGateSnapshot：现行格式（达标/超标/未检测）', () => {
  const pass = parseGateSnapshot(
    'AI检测=达标 · AI特征 27.4% < 30.0% · 片段 0人工/4疑似/2AI · 1496字 · 风格 正常',
  )
  assert.deepEqual(pass, { verdict: 'pass', value: 0.274, chars: 1496 })
  const fail = parseGateSnapshot(
    'AI检测=超标 · AI特征 32.9% ≥ 30.0% · 片段 1人工/3疑似/2AI · 1560字 · 风格 正常',
  )
  assert.equal(fail.verdict, 'fail')
  assert.equal(fail.value, 0.329)
  const skip = parseGateSnapshot('AI检测=未检测 · 额度已用尽（budget-exhausted）')
  assert.equal(skip.verdict, 'skip')
  assert.equal(skip.value, null)
})

test('parseGateSnapshot：旧版格式与早期"跳过"写法都要认', () => {
  const old = parseGateSnapshot(
    'AI检测=pass(口径=labels_ai 值=10.4% 阈值=30.0% AI特征占比=10.4% 段=1人工/1AI/8疑似 字符=2620 风格=ok)',
  )
  assert.deepEqual(old, { verdict: 'pass', value: 0.104, chars: 2620 })
  // `跳过` 与 `未检测` 同义：**没检测**，不是通过
  assert.equal(parseGateSnapshot('AI检测=跳过(sampled-out)').verdict, 'skip')
  assert.equal(parseGateSnapshot('AI检测=跳过(slot-not-enabled:tips)').verdict, 'skip')
})

test('parseGateSnapshot：认不出来就说 unknown（不猜，别混进达标率）', () => {
  assert.equal(parseGateSnapshot('').verdict, 'unknown')
  assert.equal(parseGateSnapshot('一段无关的说明').verdict, 'unknown')
  assert.equal(parseGateSnapshot(null).verdict, 'unknown')
})

test('aiGateStats：达标率的分母只放"真的检测过"的篇数，unknown 单独计数', () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-gate-stats-'))
  const env = {
    ...process.env,
    CROSSPOST_ARTICLES_DIR: path.join(TMP, 'articles'),
    CROSSPOST_DRAFTS_DIR: path.join(TMP, 'drafts'),
    CROSSPOST_HISTORY_DIR: path.join(TMP, 'history'),
    CROSSPOST_PROJECT: '',
  }
  fs.mkdirSync(env.CROSSPOST_ARTICLES_DIR, { recursive: true })
  fs.mkdirSync(env.CROSSPOST_DRAFTS_DIR, { recursive: true })
  const today = new Date().toISOString().slice(0, 10)
  const old = '2020-01-01'
  const rows = [
    ['a', today, 'AI检测=达标 · AI特征 10.0% < 30.0% · 片段 0人工/1疑似/0AI · 1000字'],
    ['b', today, 'AI检测=达标 · AI特征 20.0% < 30.0% · 片段 0人工/1疑似/0AI · 1000字'],
    ['c', today, 'AI检测=超标 · AI特征 40.0% ≥ 30.0% · 片段 1人工/0疑似/1AI · 1000字'],
    ['d', today, 'AI检测=跳过(sampled-out)'],
    ['e', today, '认不出来的东西'],
    ['f', old, 'AI检测=超标 · AI特征 90.0% ≥ 30.0% · 片段 1人工/0疑似/1AI · 1000字'],
  ]
  for (const [id, date, aiDetect] of rows) {
    fs.writeFileSync(
      path.join(env.CROSSPOST_ARTICLES_DIR, `${id}.json`),
      JSON.stringify({ id, date, slot: id === 'a' ? 'noon' : 'hotspot', aiDetect, history: [] }),
    )
  }
  const script = `import('./src/commands/costs.mjs').then((m) => {
    console.log(JSON.stringify({ all: m.aiGateStats(), recent: m.aiGateStats({ sinceDays: 7 }) }))
  })`
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  })
  assert.equal(out.status, 0, out.stderr)
  const r = JSON.parse(out.stdout)
  assert.equal(r.all.total, 6)
  assert.equal(r.all.pass, 2)
  assert.equal(r.all.fail, 2)
  assert.equal(r.all.skip, 1)
  assert.equal(r.all.unknown, 1)
  assert.equal(r.all.detected, 4, '达标率分母 = 达标 + 超标，未检测与 unknown 不进分母')
  assert.equal(r.all.passRate, 0.5)
  assert.equal(r.all.avgValue, 0.4, '(0.1 + 0.2 + 0.4 + 0.9) / 4')
  assert.equal(r.recent.total, 5, 'sinceDays 把 2020 那条排除在外')
  assert.equal(r.all.slots.noon.pass, 1)
  // 按栏目也给均值与计数：报表要按栏目回答"哪个栏目最难达标"（`a` 单篇 10%）
  assert.equal(r.all.slots.noon.avgValue, 0.1)
  assert.equal(r.all.slots.noon.valueN, 1)
  // hotspot：b 20% + c 40% + f 90%（skip 与 unknown 不进均值）
  assert.equal(r.all.slots.hotspot.valueN, 3)
  assert.equal(r.all.slots.hotspot.avgValue, 0.5)
})
