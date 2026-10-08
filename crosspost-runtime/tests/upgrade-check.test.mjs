/**
 * DSH 升级自检脚本的契约测试（v2.38）
 *
 * 为什么值得测：`preset/upgrade-check.sh` 是**DSH 升级后唯一的安全网**——
 * 2026-09-10 那次升级连续打坏三处依赖，全靠"用户反馈"才发现；这个脚本把那些
 * 检查固化下来。它一旦给出**假失败**，使用者就会学会忽略它，而它恰恰是最该被相信的。
 *
 * 本轮实测撞到的正是这一点：
 *   ✖ profile <profile> bundle <本地 bundle> 在当前部署缺失
 * 而该 bundle 确实存在——它是 `file:` 装的**本地 bundle**，装在 profile 自己的
 * node_modules 里，本来就不该出现在 DSH 部署目录中。脚本只查了部署目录。
 * 假失败 + 没有任何 ↳ 提示 = 使用者只能靠猜。
 *
 * 另外同一文件里还有一处"写死 /usr/local/bin/node"（与 install-launchd.sh 同款缺陷），
 * 会让第 3 节报成"插件导入失败"，把排查方向带偏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
const REPO = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(REPO, 'preset', 'upgrade-check.sh')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-upgrade-check-'))

/**
 * 去掉 ANSI 颜色码：断言要匹配"✖ 后紧跟包名"这类相邻关系，颜色码会挡在中间。
 * 用 `new RegExp` 而不是 `\u001B` 字面量：后者会被 eslint 的 no-control-regex 拦下。
 */
const stripAnsi = (s) => s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

/**
 * `@deepseek-ai/dsh-tools` 是 **DSH 宿主提供的包**：只有装了 DSH 才可解析。
 * 与 deployment-consistency.test.mjs 同一实现与同一取舍（干净环境跳过，不判失败）。
 */
function canResolveDshTools() {
  try {
    createRequire(path.join(REPO, 'preset', 'crosspost', 'plugins', 'x.js')).resolve(
      '@deepseek-ai/dsh-tools',
    )
    return true
  } catch {
    return false
  }
}

/** 经由**软链**调用（模拟 ~/.dsh/upgrade-check.sh 的真实用法），DSH_HOME 指向空目录 */
function runViaSymlink(env = {}, prepare = null) {
  const linkDir = fs.mkdtempSync(path.join(tmp, 'link-'))
  const link = path.join(linkDir, 'upgrade-check.sh')
  fs.symlinkSync(SCRIPT, link)
  const dshHome = fs.mkdtempSync(path.join(tmp, 'dshhome-'))
  // prepare 拿到隔离出来的 DSH_HOME，可以在脚本跑之前铺好 fixture（profile / 软链）
  if (prepare) prepare(dshHome)
  const r = spawnSync('/bin/bash', [link], {
    encoding: 'utf8',
    env: {
      HOME: tmp,
      PATH: process.env.PATH || '/usr/bin:/bin',
      DSH_HOME: dshHome,
      DSH_BIN: path.join(tmp, 'no-such-dsh'), // 让第 0 节快速判负，不真的跑 dsh
      UNZSTD: '',
      ...env,
    },
  })
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status }
}

test('经软链调用时，REPO_PRESETS 从脚本真实路径推导（不再假设仓库在某个固定位置）', () => {
  const { stdout } = runViaSymlink()
  assert.match(
    stdout,
    /crosspost/,
    '应扫描到仓库内的 crosspost 预设（说明 REPO_PRESETS 解析到了仓库的 preset/ 目录）',
  )
})

test('node 解析不出来时明确失败，且给出 CROSSPOST_NODE 的修法', () => {
  const r = runViaSymlink({ CROSSPOST_NODE: '/nonexistent/node' })
  assert.notEqual(r.status, 0)
  assert.match(`${r.stderr}${r.stdout}`, /找不到.*node|CROSSPOST_NODE/)
})

test('CROSSPOST_NODE 生效（显式指定的 node 被采用，脚本继续往下跑）', () => {
  const r = runViaSymlink({ CROSSPOST_NODE: process.execPath })
  assert.match(r.stdout, /部署与启动链/, '给了可用 node 就应进入检查流程')
})

test('静态护栏：不得把绝对路径当作 node 的默认值，且必须用 command -v node', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const hardDefault = src
    .split('\n')
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => !line.trim().startsWith('#'))
    .filter(({ line }) => /:-["']?\/[^"'}]*\/node/.test(line))
  assert.deepEqual(
    hardDefault.map(({ line, i }) => `${i}: ${line.trim()}`),
    [],
    'node 默认值不得写死绝对路径',
  )
  assert.ok(/command -v node/.test(src), '必须优先用 `command -v node` 解析')
})

test('静态护栏：bundle 解析必须覆盖 profile 自己的 node_modules（本地 bundle 在那里）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  // 旧实现只有 `-d "$DEPLOY/node_modules/$b"`，任何自带本地 bundle 的 profile 都会假失败
  assert.ok(
    /"\$pdir\/node_modules\/\$b"/.test(src),
    '必须先查 profile 自己的 node_modules（file: 装的本地 bundle 只在那里）',
  )
  assert.ok(
    /"\$DSH_HOME\/profiles\/node_modules\/\$b"/.test(src),
    '应查共享的 profiles/node_modules',
  )
  assert.ok(/"\$DEPLOY\/node_modules\/\$b"/.test(src), '最后才查 DSH 部署目录')
})

test('静态护栏：会话文件排序不得经 `xargs ls`（GNU 空输入会列当前目录）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const offenders = src
    .split('\n')
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => !line.trim().startsWith('#'))
    .filter(({ line }) => /xargs[^\n|]*\bls\b/.test(line))
  // 现场（2026-10-04 CI）：`find … -print0 | xargs -0 ls -t` 在会话目录为空时，
  // GNU xargs 仍执行一次 `ls -t` → 列出**当前目录** → "最新会话"成了 config.json，
  // 第 8 节假红。BSD xargs 不执行，所以本机（macOS）永远测不出来——只能静态盯住。
  assert.deepEqual(
    offenders.map(({ line, i }) => `${i}: ${line.trim()}`),
    [],
    '会话排序请用 session_files_by_mtime()（或任何不经 xargs ls 的等价实现）',
  )
})

/**
 * 软链分类契约（2026-09-25，仓库目录改名后实测踩到）。
 *
 * 背景：第 1 节原先只把断链分两类 ——「部署内有同名包」= 失败，其余一律
 * **"旧版本残留（无害，Node 解析会跳过）"**。可是 DSH 是按**包名**解析 profile 的插件行的，
 * 包名由 `~/.dsh/profiles/node_modules/<包名>` 这条软链落到仓库路径上：
 * 仓库目录一改名，软链目标就指向不存在的旧路径，
 * 而它与 `$DEPLOY` 毫无关系 —— 于是被归进"无害，可清理"，脚本还主动建议把它删掉。
 * 真实后果是那一行插件静默消失（改名后 `crosspost-client` 正是如此）。
 *
 * 为什么用 fixture 而不看本机：本机那条链已经修好，而这条分类逻辑必须**永远**有效 ——
 * 它守的是"下一次改名/下一次挪仓库"。fixture 在任何机器上都跑。
 */
test('软链分类：被插件行引用的断链必须报失败，不得判成"无害旧残留"', () => {
  const r = runViaSymlink({ CROSSPOST_NODE: process.execPath }, (dshHome) => {
    const profile = path.join(dshHome, 'profiles', 'web')
    const shared = path.join(dshHome, 'profiles', 'node_modules')
    fs.mkdirSync(profile, { recursive: true })
    fs.mkdirSync(shared, { recursive: true })
    fs.writeFileSync(
      path.join(profile, 'cordis.patch.yml'),
      ['- insert:', '    - id: ghost', "      name: 'ghost-plugin'", ''].join('\n'),
    )
    // 断链的典型形态：目标写着一个**已不存在的旧仓库路径**
    fs.symlinkSync(
      '/nonexistent/old-repo/preset/crosspost/plugins/ghost-plugin',
      path.join(shared, 'ghost-plugin'),
    )
  })

  assert.notEqual(r.status, 0, '被插件行引用的断链会让那一行插件消失，脚本必须判负')

  const lines = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.includes('ghost-plugin'))
  assert.ok(lines.length > 0, '脚本应至少提到这条断链（否则它根本不在检查范围内）')
  // 误判的痕迹是那句「旧版本残留（…无害，可清理）」—— 被归进残留时，脚本会主动
  // 建议把它删掉。注意不能只匹配"无害"二字：正确提示里也有"不是无害残留"这样的解释。
  assert.ok(
    lines.every((l) => !l.includes('旧版本残留')),
    `被插件行引用的断链被判成"旧版本残留（无害，可清理）"——这是改名后最危险的一次误判，` +
      `提示还会引导使用者把它删掉：\n${lines.join('\n')}`,
  )
  assert.ok(
    lines.some((l) => l.includes('插件行引用')),
    `提示必须点明"被插件行引用"（否则使用者只会看到一条软链名，不知道它是一条接线）：\n${lines.join('\n')}`,
  )
})

/**
 * 预设行名可达性契约（2026-10-03，DSH 0.2.0 换预设载体时建立）。
 *
 * 背景：0.2.0-rc.2 把 `@deepseek-ai/dsh-workflow-worker-thread` 整个删掉、换成
 * `dsh-workflow-ptc`。预设里那一行**不会报错、也不会拦住启动**——它只是静默消失，
 * 能力少一个而没人知道；而旧脚本扫的是目录式预设（0.2.0 里已无读取方），连扫描对象都没了。
 * 第 3b 节按 Node 的模块解析逐条断言，这条测试守的是"它必须真的会红，并且指对方向"。
 *
 * 用**假部署**（一个只有 package.json + 空 bin 的目录）而不看本机：本机的名称当下都是通的，
 * 而这条检查守的是"下一次升级改名"——必须任何时候都有效，且 fixture 在哪台机器上都跑。
 * REPO_PRESETS 指向空目录，把仓库自带的 28 个真名排除在外，断言只针对 fixture 里那个死名。
 */
test('行名可达性：预设里引用了部署中不存在的包 → 判负并点明"改了名或删了"', () => {
  const fakeDsh = path.join(tmp, 'fake-deploy', 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(fakeDsh, 'lib'), { recursive: true })
  fs.writeFileSync(
    path.join(fakeDsh, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }) + '\n',
  )
  const bin = path.join(fakeDsh, 'lib', 'bin.js')
  fs.writeFileSync(bin, '#!/usr/bin/env node\nprocess.exit(0)\n')
  fs.chmodSync(bin, 0o755)
  const emptyPresets = path.join(tmp, 'empty-presets')
  fs.mkdirSync(emptyPresets, { recursive: true })

  const r = runViaSymlink(
    { CROSSPOST_NODE: process.execPath, DSH_BIN: bin, REPO_PRESETS: emptyPresets },
    (dshHome) => {
      const profile = path.join(dshHome, 'profiles', 'web')
      fs.mkdirSync(path.join(dshHome, 'profiles', 'node_modules'), { recursive: true })
      fs.mkdirSync(profile, { recursive: true })
      fs.writeFileSync(
        path.join(profile, 'package.json'),
        JSON.stringify({ name: 'dsh-profile-web', version: '1.0.0' }) + '\n',
      )
      fs.writeFileSync(
        path.join(profile, 'cordis.patch.yml'),
        [
          '- insert:',
          '    - id: ghost',
          "      name: '@deepseek-ai/dsh-totally-gone-package'",
          '',
        ].join('\n'),
      )
    },
  )

  const out = stripAnsi(`${r.stdout}${r.stderr}`)
  assert.match(out, /3b\./, '第 3b 节必须存在（否则改名这类问题不在检查范围内）')
  assert.match(
    out,
    /✖\s*@deepseek-ai\/dsh-totally-gone-package/,
    `解析不到的包名必须单独判 ✖（否则使用者只看到一条总结数字）：\n${out}`,
  )
  assert.notEqual(r.status, 0, '有解析不到的行名就必须判负——那一行会在会话里静默消失')
  assert.match(
    out,
    /改名|删除/,
    `提示必须点明"可能已改名或被删除"（这条检查的全部价值就在于指对方向）：\n${out}`,
  )
  assert.match(
    out,
    /workflow-worker-thread.*workflow-ptc/,
    `提示应给出本次实证的改名（让使用者知道去哪找新名）：\n${out}`,
  )
})

/**
 * 空预设目录不得让脚本崩掉（2026-10-03，bash 3.2 + `set -u` 实测）。
 *
 * 背景：`PRESET_DIRS` 来自通配，干净部署里可以有 0 个预设。而此时
 * `for d in "${PRESET_DIRS[@]}"` 在 bash 3.2 + `set -u` 下报
 * `PRESET_DIRS[@]: unbound variable` **直接终止脚本**——升级自检会变成一句
 * 看不懂的报错，比不检查更糟。修法是 `${PRESET_DIRS[@]+"${PRESET_DIRS[@]}"}`。
 */
test('空预设目录：脚本继续跑完（bash 3.2 空数组展开不得终止）', () => {
  const emptyPresets = path.join(tmp, 'empty-presets-2')
  fs.mkdirSync(emptyPresets, { recursive: true })
  const r = runViaSymlink(
    { CROSSPOST_NODE: process.execPath, REPO_PRESETS: emptyPresets },
    (dshHome) => {
      fs.mkdirSync(path.join(dshHome, 'profiles', 'node_modules'), { recursive: true })
    },
  )
  assert.doesNotMatch(
    stripAnsi(`${r.stderr}${r.stdout}`),
    /unbound variable/,
    '空预设目录触发了 bash 3.2 的空数组展开错误——脚本会在此终止',
  )
  assert.match(r.stdout, /汇总/, '没有预设也应跑完并给出汇总')
})

/**
 * 相对行名契约（2026-10-03 实测踩到，症状极难定位）。
 *
 * 背景：本地插件行若写成 `./plugins/crosspost.js`，`dsh-app-boot` 的 boot 契约
 * （"Relative entry names resolve against the **config directory**"）会让它去
 * `~/.dsh/profiles/<profile>/plugins/crosspost.js` 找文件——**不是** bundle 目录。
 * 于是声明挂载看似成功，而**新会话一绑定就失败**：
 *   agent-preset/invalid: crosspost-tools (./plugins/crosspost.js): never started
 * 这条测试守的是"脚本必须把这种写法判错，并说清正确写法"——旧判据
 * （"文件在 bundle 目录里存不存在"）会给出**假绿**：文件明明在，运行时却找不到。
 */
test('相对行名：预设里的 ./plugins/… 必须判错并指明正确写法（不得只看 bundle 目录存在性）', () => {
  const presets = path.join(tmp, 'rel-row-presets')
  const bundle = path.join(presets, 'relbundle')
  fs.mkdirSync(path.join(bundle, 'plugins'), { recursive: true })
  // 文件**确实存在于 bundle 目录**——这正是旧判据会放过的情形
  fs.writeFileSync(path.join(bundle, 'plugins', 'thing.js'), 'export const name = "x"\n')
  fs.writeFileSync(
    path.join(bundle, 'package.json'),
    JSON.stringify({
      name: 'relbundle',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }) + '\n',
  )
  fs.writeFileSync(
    path.join(bundle, 'cordis.patch.yml'),
    [
      '- insert:',
      '    - id: preset-relbundle',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: relbundle',
      '        plugins:',
      '          - id: thing',
      "            name: './plugins/thing.js'",
      '',
    ].join('\n'),
  )

  const r = runViaSymlink(
    { CROSSPOST_NODE: process.execPath, REPO_PRESETS: presets },
    (dshHome) => {
      fs.mkdirSync(path.join(dshHome, 'profiles', 'node_modules'), { recursive: true })
    },
  )
  const out = stripAnsi(`${r.stdout}${r.stderr}`)

  assert.notEqual(r.status, 0, '相对行名必须判负——它在运行时解析不到，新会话绑定会失败')
  assert.match(out, /\.\/plugins\/thing\.js/, '报错要点出是哪一行')
  assert.match(out, /never started/, `要点明真实症状（否则排查方向会跑偏）：\n${out}`)
  assert.match(out, /config 目录/, '要解释解析基准是 config 目录（profile 目录）而不是 bundle 目录')
  assert.match(out, /包名/, '要给出正确写法：包名 + 子路径')
})

/**
 * 第 3 节的发现面不得静默变空（2026-10-03 实测踩到）。
 *
 * 背景：本地插件行从相对名改成**包名 + 子路径**之后，第 3 节还在 grep `./`，于是它印出
 * “未发现预设本地插件（跳过）”——**检查还在、覆盖却没了**，比不检查更危险（它给的是 ✔ 的错觉）。
 * 这条测试直接对着**真仓库**的 preset 跑：两个插件都必须被导入，且不许出现那句“未发现”。
 */
test('预设本地插件发现面：仓库里的每个插件都要被第 3 节真的导入（不得静默跳过）', (t) => {
  const { stdout } = runViaSymlink({ CROSSPOST_NODE: process.execPath })
  const out = stripAnsi(stdout)

  assert.doesNotMatch(
    out,
    /未发现预设本地插件/,
    '第 3 节没发现任何插件——它的发现规则又和行名写法脱节了（检查会变成空转的 ✔）',
  )
  // `preset/crosspost/plugins/crosspost.js` 顶层 `import '@deepseek-ai/dsh-tools'`——
  // 那是 **DSH 宿主提供的包**，干净环境（CI / 干净 clone）没有它，裸 node 的 fresh import
  // 必失败（ERR_MODULE_NOT_FOUND），与"发现规则对不对"无关。此时**跳过而不是失败**：
  // 与 deployment-consistency.test.mjs 同一条取舍（那边已踩过同一个误报）。
  // 本测试要守的判据仍然成立：上面 `未发现预设本地插件` 那句一次都不许出现。
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过插件导入断言')
    return
  }
  for (const base of ['crosspost.js', 'commands.js']) {
    assert.match(
      out,
      new RegExp(`导入成功\\s+\\S*${base.replace('.', '\\.')}\\s+→\\s+\\S+`),
      `第 3 节应当 fresh-import 到 ${base}：\n${out}`,
    )
  }
})

/**
 * 第 8 节的假报警契约（2026-10-04 实测踩到）。
 *
 * 背景：只敲了斜杠指令的会话（`/crosspost-status` 之类）**没有任何 LLM 调用**，
 * 自然没有 `usage` 事件。旧实现只看"最新那个会话"，于是报
 * “解压可读但未发现 usage 事件：token-cost 的 usage 位置可能已变”——一条**恒报警**，
 * 而假报警会训练使用者忽略本脚本（它是 DSH 升级后唯一的安全网）。
 * 修法：往前找最近一个**真的有 assistant/message** 的会话再判。
 */
test('会话代际检查：最新的纯命令会话不得被当成"usage 位置已变"（假报警）', () => {
  const { stdout } = runViaSymlink({ CROSSPOST_NODE: process.execPath }, (dshHome) => {
    const sessions = path.join(dshHome, 'sessions', '--work--')
    // 旧的：一个真有 LLM 调用的会话（未压缩 .jsonl 即可，不依赖 zstd）
    const older = path.join(sessions, 'session-older')
    fs.mkdirSync(older, { recursive: true })
    fs.writeFileSync(
      path.join(older, 'session.v4.jsonl'),
      [
        JSON.stringify({
          type: 'assistant/message',
          data: {
            usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, reasoningTokens: 0 },
          },
        }),
        '',
      ].join('\n'),
    )
    // 新的：只有斜杠指令生命周期，没有 LLM 调用
    const newer = path.join(sessions, 'session-newer')
    fs.mkdirSync(newer, { recursive: true })
    fs.writeFileSync(
      path.join(newer, 'session.v4.jsonl'),
      [
        JSON.stringify({
          type: 'command/run',
          data: { commandId: 'c1', name: 'crosspost-help', args: '', source: { kind: 'user' } },
        }),
        JSON.stringify({
          type: 'command/done',
          data: { commandId: 'c1', kind: 'success', text: 'ok' },
        }),
        '',
      ].join('\n'),
    )
    const now = Date.now() / 1000
    fs.utimesSync(path.join(older, 'session.v4.jsonl'), now - 600, now - 600)
    fs.utimesSync(path.join(newer, 'session.v4.jsonl'), now, now)
  })

  const out = stripAnsi(stdout)
  assert.match(out, /解压可读：assistant\/message=1/, `应当取到真有 LLM 调用的那个会话：\n${out}`)
  assert.doesNotMatch(
    out,
    /usage 位置可能已变/,
    `纯命令会话被判成"usage 位置已变"——这是恒报警，会让人忽略整份自检：\n${out}`,
  )
  assert.match(out, /跳过.*无 LLM 调用/, '应当说明跳过了一个没有 LLM 调用的会话（取样可追溯）')
})
