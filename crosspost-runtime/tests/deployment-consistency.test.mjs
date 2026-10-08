// 部署一致性测试（v2.18；2026-10-03 随 DSH 0.2.0 预设载体变更重写）
//
// 这组护栏盯着的是**同一个问题的两个时代**：
//
//   旧时代（≤0.1.x）：DSH 把 `preset/crosspost/` **拷一份**到 `~/.dsh/.agent-presets/crosspost/`。
//   于是仓库里的修复不会自动生效——实测发现安装副本仍硬编码 `/usr/local/bin/node`
//   并用顶层 `loadPaths()`，v2.02 的两处修复它一个都没有。当时靠逐字哈希比对兜住。
//
//   新时代（0.2.0-rc.2）：`~/.dsh/.agent-presets/<id>/` **已无任何读取方**
//   （`@deepseek-ai/dsh-agent-preset` 的 editing-cordis-compositions skill：
//   "Nothing reads that directory any more"），预设改为 bundle patch 里的
//   `@deepseek-ai/dsh-agent-preset` 声明行，bundle 经 profile 的 `dsh.profile.bundles` 装载。
//   本机用 **`link:` 安装**（pnpm 会给出一条直接指向仓库的软链）——仓库即源，改代码免重装，
//   "漂移"在这个形态下**不可能发生**。于是护栏的重点从"比对字节"换成"断言这个形态本身"：
//   谁把它换成副本安装，这里立刻红——那才是漂移重新变为可能的那一刻。
//
// 设计取舍：**安装路径不存在时跳过**（默认安装只在作者机器上存在），
// 因此它不会在别人的机器上误报；而在本机它是一道真实护栏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh')
// CrossPost · maintained by dos2un1x · https://github.com/dos2un1x/crosspost
const PROFILES = path.join(DSH_HOME, 'profiles')
const REPO_PRESET = path.join(REPO, 'preset', 'crosspost')
const LEGACY_PRESET = path.join(DSH_HOME, '.agent-presets', 'crosspost')

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

/** 仓库 bundle 的包名（安装条目名 = 包名） */
function bundleName() {
  const pj = JSON.parse(fs.readFileSync(path.join(REPO_PRESET, 'package.json'), 'utf8'))
  return pj.name
}

/** 本机已安装的 bundle 路径（profile 自己的 node_modules 与共享 node_modules 都查），没有返回 [] */
function installedBundles() {
  const name = bundleName()
  const out = []
  let profiles = []
  try {
    profiles = fs.readdirSync(PROFILES)
  } catch {
    return out
  }
  for (const p of profiles) {
    const cand = path.join(PROFILES, p, 'node_modules', name)
    if (fs.existsSync(cand)) out.push(cand)
  }
  const shared = path.join(PROFILES, 'node_modules', name)
  if (fs.existsSync(shared)) out.push(shared)
  return out
}

/**
 * 需要与仓库保持一致的已安装文件：**`plugins/` 下的全部插件**（动态列举，
 * 新增插件自动纳入，不会因为忘了改常量而漏掉一份）。
 *
 * 注意它们是**唯一还在两份布局间流动的源文件**（`link:` 安装下同一份；副本安装下两份）。
 *
 * **刻意不纳入**：
 *   · `cordis.patch.yml` —— 在软链安装下就是同一份；在副本安装下它由 bundle 机制装载，
 *     内容差异会先被 §3b「行名可达」与 profile 组合检查抓住。这里不再做逐字比对，
 *     避免把"声明行里的 name/description 与 package.json 重复登记"这类正常编辑判成漂移。
 *   · 已删除的 `preset.yml`：它的 name/description 已并入声明行（单一真源）。
 */
function syncedFiles() {
  try {
    return fs
      .readdirSync(path.join(REPO_PRESET, 'plugins'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => `plugins/${f}`)
      .sort()
  } catch {
    return []
  }
}

test('部署一致性：已安装 bundle 是软链（仓库即源）或与仓库逐字一致', (t) => {
  const installed = installedBundles()
  if (!installed.length) {
    t.skip(`${PROFILES} 下未安装 ${bundleName()}（非本机部署）`)
    return
  }

  for (const dir of installed) {
    if (fs.lstatSync(dir).isSymbolicLink()) {
      // 首选形态：直接指向仓库。改仓库代码即生效，不存在"改了没反应"。
      const real = fs.realpathSync(dir)
      assert.equal(
        real,
        fs.realpathSync(REPO_PRESET),
        `${dir} 是软链但指向 ${real}，不是本仓库的 preset/crosspost——多份安装副本是漂移的温床`,
      )
      continue
    }
    // 副本形态（pnpm `file:` 安装会物化成 .pnpm 下的副本树）：退化为逐字比对，
    // 并把"需要重装"这件事说清楚——否则"改完没生效"会重现旧时代那个坑。
    const mismatched = []
    const missing = []
    for (const rel of syncedFiles()) {
      const repo = path.join(REPO_PRESET, rel)
      if (!fs.existsSync(repo)) continue
      const target = path.join(dir, rel)
      if (!fs.existsSync(target)) {
        missing.push(rel)
        continue
      }
      if (sha256(target) !== sha256(repo)) mismatched.push(rel)
    }
    assert.deepEqual(missing, [], `已安装 bundle 缺少以下文件：${missing.join(', ')}`)
    assert.deepEqual(
      mismatched,
      [],
      `已安装 bundle 的以下文件与仓库不一致（副本安装：仓库的修改不会自动生效）：\n` +
        mismatched.map((m) => `  ${path.join(dir, m)}`).join('\n') +
        `\n修法：重装该 bundle（pnpm install / plugin_manager install_bundle），或改用 link: 安装`,
    )
  }
})

test('部署一致性：已安装插件不得残留硬编码 node 路径（注释除外）', (t) => {
  const installed = installedBundles()
  const target = installed.length
    ? path.join(installed[0], 'plugins', 'crosspost.js')
    : path.join(LEGACY_PRESET, 'plugins', 'crosspost.js')
  if (!fs.existsSync(target)) {
    t.skip('未安装 bundle')
    return
  }
  const src = fs.readFileSync(target, 'utf8')
  const offenders = src
    .split('\n')
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => /\/usr\/local\/bin\/node/.test(line))
    .filter(({ line }) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .map(({ line, i }) => `${i}: ${line.trim()}`)
  assert.deepEqual(
    offenders,
    [],
    `已安装插件仍硬编码 node 路径（在无 /usr/local/bin/node 的机器上会直接失败）：\n${offenders.join('\n')}`,
  )
})

test('部署一致性：仓库 preset 插件自身可被 fresh 进程导入（安装前的最后一道门）', async (t) => {
  const pluginFiles = syncedFiles().map((rel) => path.join(REPO_PRESET, rel))
  if (!pluginFiles.length) {
    t.skip('仓库无 preset 插件')
    return
  }
  // 这些插件可能 `import '@deepseek-ai/dsh-tools'`——那是 **DSH 宿主提供的包**，
  // 只有装了 DSH（或其 preset 目录里有 node_modules）才可解析。
  // 干净 clone 里没有它，此时**跳过而不是失败**：这测的是"部署前的最后一道门"，
  // 而"没装 DSH"的环境本来就不该跑这道门。
  // （实测踩到：在干净 clone 里本测试误报为失败，属测试自身的环境假设错误。）
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过导入检查')
    return
  }
  for (const file of pluginFiles) {
    try {
      const m = await import(new URL(`file://${file}`).href)
      assert.equal(typeof m.apply, 'function', `${path.basename(file)} 必须导出 apply 函数`)
      assert.equal(typeof m.name, 'string', `${path.basename(file)} 必须导出 name`)
    } catch (e) {
      assert.fail(
        `仓库 preset 插件导入失败（${path.basename(file)}）——` +
          `同步到已安装副本后会让该预设下所有 DSH 会话失败：${e.message}`,
      )
    }
  }
})

/**
 * 预设载体的形状契约（机器无关，纯仓库侧）。
 *
 * 为什么值得一条护栏：0.2.0 里**旧的载体不会报错，只会失效**——
 * `~/.dsh/.agent-presets/<id>/` 留在盘上不再被任何东西读取，DSH 照常启动，
 * 只是那 7 个 xp_* 工具消失了。所以"仓库里不许再出现旧载体文件"
 * 与"新载体必须同时具备三样东西（package.json 的 dsh.bundle.patch、
 * 该 patch 文件、里面的 dsh-agent-preset 声明行）"必须钉住。
 */
test('预设载体形状：无旧载体文件，且 bundle 三件套齐备（0.2.0 声明行）', () => {
  for (const dead of ['agent.cordis.yml', 'preset.yml']) {
    assert.ok(
      !fs.existsSync(path.join(REPO_PRESET, dead)),
      `preset/crosspost/${dead} 是 ≤0.1.x 的目录式预设载体，0.2.0 起无读取方（留着只会让人以为它还生效）`,
    )
  }

  const pjPath = path.join(REPO_PRESET, 'package.json')
  assert.ok(fs.existsSync(pjPath), 'preset/crosspost/package.json 必须存在（bundle manifest）')
  const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
  assert.ok(pj.name && pj.version, 'bundle manifest 必须同时声明 name 与 version')
  const patch = pj.dsh?.bundle?.patch
  assert.ok(
    typeof patch === 'string' && patch,
    'package.json 必须声明 dsh.bundle.patch（缺了安装器判 not-a-bundle）',
  )

  const patchPath = path.join(REPO_PRESET, patch)
  assert.ok(fs.existsSync(patchPath), `dsh.bundle.patch 指向的文件不存在: ${patchPath}`)
  const yml = fs.readFileSync(patchPath, 'utf8')
  assert.match(
    yml,
    /name:\s*'@deepseek-ai\/dsh-agent-preset'/,
    'bundle patch 必须声明一条 @deepseek-ai/dsh-agent-preset 行——预设本体就是这条声明',
  )
  assert.match(yml, /^\s*plugins:\s*$/m, '声明行必须有 config.plugins（条目列表）')
  assert.match(
    yml,
    /id:\s*crosspost\b/,
    '声明行的 config.id 必须是 crosspost（与目录名/预设 id 一致，否则 GUI 里换了个身份）',
  )

  // 本地插件行必须是**包名 + 子路径**，且与 package.json 的 name 一致。
  //
  // 为什么钉死这一点：`./plugins/crosspost.js` 这种相对名在 0.2.0 里解析的是
  // **config 目录**（profile 目录），不是本 bundle 目录（`dsh-app-boot` 的 boot 契约：
  // "Relative entry names resolve against the config directory"）。实测症状是那一行
  // 拿不到 fiber、声明挂载看似成功，而**新会话一绑定就失败**：
  //   agent-preset/invalid: crosspost-tools (./plugins/crosspost.js): never started
  // 写成包名后由模块解析处理（bundle 是 profile 的依赖，从 config 目录一定解析得到），
  // 这正是上游那句 "Resolve assets from installed packages rather than a preset directory"。
  // 逐条断言**所有** `.js` 插件行（新增插件自动纳入，不靠人记得改测试）。
  const jsRows = [...yml.matchAll(/name:\s*'([^']*\.js)'/g)].map((m) => m[1])
  assert.ok(jsRows.length >= 2, `声明行里的本地插件行太少（${jsRows.length}），是不是漏挂了插件？`)
  for (const spec of jsRows) {
    assert.match(
      spec,
      /^[a-z0-9][a-z0-9-]*\/plugins\/[A-Za-z0-9._-]+\.js$/,
      `本地插件 specifier 必须是「包名/plugins/文件.js」：${spec}。` +
        `相对名（./plugins/…）按 config 目录解析会找不到文件 → 新会话绑定失败（never started）`,
    )
    const [scopeOrPkg, rel] = [spec.split('/')[0], spec.split('/').slice(1).join('/')]
    assert.equal(
      scopeOrPkg,
      pj.name,
      `插件 specifier 的包名前缀必须等于 package.json 的 name（${pj.name}）：${spec}`,
    )
    assert.ok(
      fs.existsSync(path.join(REPO_PRESET, rel)),
      `插件 specifier 指向的文件在仓库里不存在：${spec} → ${path.join(REPO_PRESET, rel)}`,
    )
  }
})

/**
 * 定时链路的写作规范本体（`cordis.patch.yml` 叠加层）**只有一份，且在引擎仓库之外**。
 *
 * 为什么值得一条护栏：这份叠加层实际住在**接入方仓库**那侧、`~/.dsh` 里只留软链，这带来两类静默失败——
 *   · 有人把它改回普通文件（拷一份回来）→ 在接入方那侧的修改**不再生效**，
 *     而运行照旧成功，只是用的还是旧规范（"改了没反应"最难查）；
 *   · 软链目标被删/改名 → profile 组合失败 → 定时任务整轮不产出。
 * 两者都不会在任何"跑一下看看"里暴露，所以钉在这里。
 *
 * 判据**不写死任何 profile 名或目录名**（那是某台机器的部署细节）：对每个带 `cordis.patch.yml`
 * 的 profile 断言"读出来的真身不在引擎仓库里"；其中是软链的那些额外断言目标可读、不是空壳。
 * 非本机部署（没有 profiles 目录）跳过。
 */
test('部署一致性：写作规范叠加层只有一份，且不在引擎仓库里', (t) => {
  let names = []
  try {
    names = fs
      .readdirSync(PROFILES)
      .filter((n) => fs.existsSync(path.join(PROFILES, n, 'cordis.patch.yml')))
  } catch {
    /* 没有 profiles 目录 */
  }
  if (!names.length) {
    t.skip(`${PROFILES} 下没有带 cordis.patch.yml 的 profile（非本机部署）`)
    return
  }

  const symlinked = []
  for (const name of names) {
    const link = path.join(PROFILES, name, 'cordis.patch.yml')
    const target = fs.realpathSync(link)
    assert.ok(
      !target.startsWith(REPO + path.sep),
      `${link} 的真身在引擎仓库里（${target}）——写作规范又回到引擎侧了`,
    )
    if (fs.lstatSync(link).isSymbolicLink()) symlinked.push(link)
  }

  // 软链那一份是定时链路真正用的：目标必须读得出来，不能是空壳/坏链
  for (const link of symlinked) {
    assert.ok(fs.statSync(link).size > 1000, `${link} 的目标读出来几乎为空，可能已损坏`)
  }
})

/** 能否解析 @deepseek-ai/dsh-tools（即本机是否装了 DSH） */
function canResolveDshTools() {
  try {
    createRequire(path.join(REPO_PRESET, 'plugins', 'x.js')).resolve('@deepseek-ai/dsh-tools')
    return true
  } catch {
    return false
  }
}
