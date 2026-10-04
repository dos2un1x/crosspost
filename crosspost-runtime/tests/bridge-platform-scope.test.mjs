/**
 * 平台登录**检查范围**必须是"跨层并集"，且与请求上下文无关（v2.106.2）
 *
 * ## 这条测试守的事故
 *
 * 浏览器扩展面板显示"检查范围 2/27 · 未勾选 25 个"，而 Console（带项目头）与派发侧
 * 看到的是 12 个平台。原因：检查范围取 `readFullRuntimeConfig()` = 引擎 config +
 * **当前上下文**的项目覆盖层，而后台 tick（定时器）与扩展面板的查询**都没有项目上下文** →
 * 只剩引擎级那份（实测 = `['weixin','douyin']`，2026-09-12 那次迁移补进去的）。
 *
 * 判据（可证伪）：
 *   ① 范围 = 引擎级 ∪ 各项目覆盖层（去重、按矩阵顺序、过滤未知 id）
 *   ② 在 / 不在项目上下文里，结果**完全一致**（这是"面板说 2、Console 说 12"的病根）
 *   ③ `run-bridge.mjs` 的 `currentScope()` 确实接了这两条（接线护栏，防止再次脱钩）
 *
 * 假通过检查：换回改前 `run-bridge.mjs`，③ 必失败（它那时读的是 `readFullRuntimeConfig()`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { resolveScopeFromLayers } from '../../bridge/platforms-retry.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
const REPO = path.resolve(RUNTIME, '..')

const MODS = {
  worker: JSON.stringify(path.join(REPO, 'bridge', 'cli-worker.mjs')),
  retry: JSON.stringify(path.join(REPO, 'bridge', 'platforms-retry.mjs')),
  ctx: JSON.stringify(path.join(RUNTIME, 'src', 'project-context.mjs')),
}

/** 实验台：引擎 config（只勾 2 个）+ 两个项目覆盖层（分别勾 6 / 12 个）+ 注册表 */
function makeBox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-scope-'))
  const b = {
    root,
    local: path.join(root, 'local'),
    projects: path.join(root, 'projects'),
    config: path.join(root, 'config.json'),
  }
  fs.mkdirSync(b.projects, { recursive: true })
  fs.writeFileSync(
    b.config,
    JSON.stringify({ projectsDirs: [b.projects], platforms: { default: ['weixin', 'douyin'] } }),
  )
  const overlays = {
    pa: ['zhihu', 'csdn', 'juejin'],
    pb: ['toutiao', 'baijiahao', 'zhihu', 'weixin', 'douyin', 'zip-download'],
  }
  for (const [id, platforms] of Object.entries(overlays)) {
    const dir = path.join(b.projects, id)
    fs.mkdirSync(path.join(dir, '.crosspost'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'drafts'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.crosspost', 'project.json'),
      JSON.stringify({
        id,
        name: `检查范围项目 ${id}`,
        manifestVersion: 2,
        capabilities: { drafts: true },
        dataDir: 'drafts',
      }),
    )
    const cfgDir = path.join(b.local, 'project-state', id)
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ platforms: { default: platforms } }),
    )
  }
  b.overlays = overlays
  return b
}

const envFor = (b) => ({
  ...process.env,
  CROSSPOST_CONFIG: b.config,
  CROSSPOST_LOCAL_ROOT: b.local,
  CROSSPOST_PROJECTS_DIR: b.projects,
  CROSSPOST_PROJECTS_DIRS: b.projects,
})

function runInChild(b, script) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    encoding: 'utf8',
    env: envFor(b),
    timeout: 60000,
  })
  assert.equal(r.status, 0, `子进程失败：${r.stderr || r.stdout}`)
  return JSON.parse(r.stdout)
}

test('① 并集语义：引擎级 ∪ 各项目覆盖层，去重、过滤未知 id、按矩阵顺序', () => {
  const r = resolveScopeFromLayers({
    engineDefaults: ['weixin', 'douyin'],
    projectDefaults: ['zhihu', 'csdn', 'juejin', 'zhihu', 'zip-download'],
  })
  assert.equal(r.mode, 'scoped')
  assert.deepEqual(
    r.ids,
    ['zhihu', 'csdn', 'weixin', 'juejin', 'douyin'],
    '顺序按平台矩阵（矩阵里 weixin 在 juejin 之前），重复与新平台各处理一次',
  )
  assert.deepEqual(r.checkOnly, ['weixin', 'douyin'], '仅检查平台仍被标注')
  assert.ok(!r.ids.includes('zip-download'), '未知 id 必须被过滤')
})

test('② 两层都空 → 回退全量（fallback-all），不能"什么都不查"', () => {
  const r = resolveScopeFromLayers({ engineDefaults: [], projectDefaults: [] })
  assert.equal(r.mode, 'fallback-all')
  assert.equal(r.ids.length, 27)
  assert.deepEqual(r.excluded, [])
})

test('③ 引擎级只有 2 个、项目覆盖层有更多 → 范围为并集（事故里就是这一条）', () => {
  const b = makeBox()
  const out = runInChild(
    b,
    `
    import { projectPlatformDefaults, readEngineConfigFile } from ${MODS.worker};
    import { resolveScopeFromLayers } from ${MODS.retry};
    const engineDefaults = (readEngineConfigFile().platforms || {}).default;
    const projectDefaults = projectPlatformDefaults();
    const scope = resolveScopeFromLayers({ engineDefaults, projectDefaults });
    console.log(JSON.stringify({
      engineDefaults, projectDefaults,
      ids: scope.ids, mode: scope.mode, excluded: scope.excluded.length,
    }));
    `,
  )
  assert.deepEqual(out.engineDefaults, ['weixin', 'douyin'])
  assert.deepEqual(
    out.projectDefaults,
    [
      'zhihu',
      'csdn',
      'juejin',
      'toutiao',
      'baijiahao',
      'zhihu',
      'weixin',
      'douyin',
      'zip-download',
    ],
    '这里是原样拼接（去重交给 normalizeIds）',
  )
  assert.equal(out.mode, 'scoped')
  assert.deepEqual(
    out.ids,
    ['zhihu', 'csdn', 'weixin', 'baijiahao', 'toutiao', 'juejin', 'douyin'],
    '并集：3 + 9 去重后 7 个有效平台',
  )
  assert.equal(out.excluded, 20)
})

test('④ 与请求上下文无关：在 / 不在项目上下文里，范围必须一致', () => {
  const b = makeBox()
  const out = runInChild(
    b,
    `
    import { projectPlatformDefaults, readEngineConfigFile } from ${MODS.worker};
    import { resolveScopeFromLayers } from ${MODS.retry};
    import { withProject } from ${MODS.ctx};
    const scope = () => resolveScopeFromLayers({
      engineDefaults: (readEngineConfigFile().platforms || {}).default,
      projectDefaults: projectPlatformDefaults(),
    }).ids;
    const outside = scope();
    const insideA = withProject('pa', scope);
    const insideB = withProject('pb', scope);
    console.log(JSON.stringify({ outside, insideA, insideB }));
    `,
  )
  assert.deepEqual(out.insideA, out.outside, '项目上下文里不该变小（这正是事故：tick 只有 2 个）')
  assert.deepEqual(out.insideB, out.outside)
  assert.ok(out.outside.length > 2, `范围必须覆盖项目覆盖层，实际 ${out.outside.join(',')}`)
})

test('⑤ 接线护栏：run-bridge 的 currentScope() 必须用并集（引擎级 + 项目覆盖层）', () => {
  const src = fs.readFileSync(path.join(REPO, 'bridge', 'run-bridge.mjs'), 'utf8')
  const at = src.indexOf('function currentScope()')
  assert.ok(at > 0, 'currentScope() 应存在')
  const body = src.slice(at, src.indexOf('\n}', at))
  assert.match(body, /resolveScopeFromLayers\(/, 'currentScope() 必须走跨层并集')
  assert.match(
    body,
    /readEngineConfigFile\(\)/,
    '引擎级那份要显式读（而不是"当前上下文生效的那份"）',
  )
  assert.match(body, /projectPlatformDefaults\(\)/, '项目覆盖层那份要一起并进来')
  assert.ok(
    !/readFullRuntimeConfig\(\)\s*\.platforms/.test(body),
    '不能再用 readFullRuntimeConfig().platforms —— 它会随请求上下文变化，正是本 bug 的来源',
  )
})
