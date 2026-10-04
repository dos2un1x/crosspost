// 工作区改名一致性（v2.3.6）
//
// 背景（实测踩到）：仓库目录改过一次名。
// 改名本身在仓库里是"零改动"的（代码里几乎没有写死仓库绝对路径），但**仓库之外**
// 有几处配置把它写死了，而且每一处的失败方式都是"静默"的：
//
//   ① `~/.dsh/profiles/web/cordis.patch.yml` —— `mcp-crosspost` 行的 args 写死
//      `<repo>/crosspost-runtime/mcp-server/index.mjs`。路径失效后 DSH 照常启动，
//      只是 7 个 `mcp__crosspost__*` 工具**整体消失**（本次是靠"重启前拉起的进程
//      还攥着已删除的 inode"才侥幸没暴露）。
//   ② `~/.dsh/.agent-presets/crosspost/`（**安装副本**）—— 注释里的绝对路径陈旧，
//      且与仓库版逐字不一致（另有 deployment-consistency.test.mjs 管这一条）。
//   ③ `~/.claude.json` 的项目级 `mcpServers.crosspost` —— 同一个 server 的第二个
//      注册点，路径同样写死，失效后 Claude Code 侧静默失去这些工具。
//   ④ 容器侧：compose 的项目名默认取**目录名**，改名后卷前缀跟着变，旧卷成孤儿、
//      新卷是空的（"容器 healthy 但引擎缺依赖"，与代码无关）。
//   ⑤ `~/.dsh/profiles/node_modules/<包名>`（**软链**）—— DSH 按**包名**解析 profile 的
//      插件行，包名最终由这条软链落到仓库路径上。①②③ 查的都是**文本里写死的路径**，
//      而软链是"无扩展名的普通文件项"，测试②的 walk() 只看 `.m?js|ya?ml|json` 普通文件，
//      于是整类漏点落在盲区里。断链的后果与 ① 同族：DSH 照常启动，只是**那一行插件
//      静默消失**（改名后实测：`crosspost-client` 仍指向旧目录）。
//
// 这类缺陷的共同点是：**没有任何测试会因为"某处路径已不存在"而失败**，所以本文件
// 把"引用的路径必须真的存在"变成显式断言。设计取舍与本项目其它护栏一致：
// 目标文件不存在时 **skip**（别人的机器上没有这些部署），本机则是真护栏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh')
const HOME = process.env.HOME || ''

const read = (p) => fs.readFileSync(p, 'utf8')
const exists = (p) => {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

/** 某目录的**直接子目录**（软链不算目录，天然不进这一层）；目录不可读返回 [] */
const subdirs = (dir) => {
  if (!exists(dir)) return []
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

/** `exists()` 走 stat，对断链会说"不存在"；判"这里有个软链"必须用 lstat。 */
const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 一个绝对路径的"第一段"（`/Users/me/<旧目录名>/x` → 目录名）。
 * 只用来在对不上时给出人话提示，不参与判定本身。
 */
const topSegment = (p) => {
  const m = /^\/(?:Users|home)\/[^/]+\/([^/]+)/.exec(p)
  return m ? m[1] : ''
}

/**
 * ① 每个被引用的绝对路径都必须真的存在。
 *
 * 收集面刻意**小而准**：只收"运行时会去读它"的那些配置，不做全盘扫描
 * （全盘扫会把历史归档里的旧路径一起报出来，那种噪音会让人把这条护栏关掉）。
 */
test('改名一致性：配置里引用的绝对路径必须真实存在（不存在即静默失效）', (t) => {
  const targets = []

  // DSH profile 的 patch 层（MCP server 的 args 就写在这里）
  const patch = path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
  if (exists(patch)) {
    for (const line of read(patch).split('\n')) {
      const m = /^\s*args:\s*\[(.*)\]\s*$/.exec(line)
      if (!m) continue
      for (const raw of m[1].split(',')) {
        const p = raw.trim().replace(/^['"]|['"]$/g, '')
        if (p.startsWith('/')) targets.push({ file: patch, p })
      }
    }
  }

  // Claude Code 的项目级 MCP 注册（同一个 server 的第二个注册点）
  const claude = path.join(HOME, '.claude.json')
  if (exists(claude)) {
    try {
      const cfg = JSON.parse(read(claude))
      for (const proj of Object.values(cfg.projects || {})) {
        for (const server of Object.values((proj && proj.mcpServers) || {})) {
          for (const a of (server && server.args) || []) {
            if (typeof a === 'string' && a.startsWith('/')) targets.push({ file: claude, p: a })
          }
        }
      }
    } catch {
      // 解析不了就不在这里报（那是另一个问题，不该伪装成"路径失效"）
    }
  }

  // 仓库侧路径配置（运行时真的按它读写）
  for (const rel of ['crosspost-runtime/paths.json']) {
    const f = path.join(REPO, rel)
    if (!exists(f)) continue
    try {
      const cfg = JSON.parse(read(f))
      for (const [k, v] of Object.entries(cfg)) {
        if (k.startsWith('_') || typeof v !== 'string' || !v.startsWith('/')) continue
        targets.push({ file: f, p: v })
      }
    } catch {
      /* 同上 */
    }
  }

  if (targets.length === 0) {
    t.skip('没有可检查的配置（非本机部署）')
    return
  }

  const dead = targets.filter((x) => !exists(x.p))
  assert.deepEqual(
    dead.map((x) => `${x.p}\n    引用自 ${x.file}`),
    [],
    `以下绝对路径已不存在 —— DSH 不会因此启动失败，只会静默少掉能力：\n  ` +
      dead.map((x) => `${x.p}\n    引用自 ${x.file}`).join('\n  ') +
      `\n\n修法：把该路径改成当前仓库的真实位置（仓库根 = ${REPO}）。` +
      `\n     本次踩到的是仓库目录改名（${topSegment(REPO) ? `当前为 "${topSegment(REPO)}"` : '目录名'}），` +
      `\n     请连同 ~/.claude.json 等仓库外的注册点一起改（多处写死的绝对路径正是这类漏改的根源）。`,
  )
})

/**
 * ② 预设侧（仓库版 / 已安装 bundle）里不得残留"指向已不存在目录"的绝对路径。
 *
 * 与 deployment-consistency.test.mjs 的分工：那条钉的是"安装形态与仓库一致"
 * （软链安装=同一份；副本安装=逐字一致），这条钉的是"文件里的路径引用本身还成立"
 * —— 后者即使两份逐字一致也可能失效（两边同时写死旧路径时，前一条会绿）。
 *
 * 扫描面：仓库里的 preset 目录 + 本机已安装的 bundle（`link:` 安装下两者是同一份，
 * 去重后只扫一次）。`*.pre-*` 备份是允许保留旧文本的，它们按设计不被加载。
 */
test('改名一致性：预设里的 crosspost-runtime 引用不得指向已不存在的目录', (t) => {
  // 仓库版 + 已安装 bundle（安装条目名 = 仓库 manifest 的包名；软链会解析回仓库，靠 realpath 去重）
  const roots = [path.join(REPO, 'preset', 'crosspost')]
  let bundleName = ''
  try {
    bundleName = JSON.parse(read(path.join(REPO, 'preset', 'crosspost', 'package.json'))).name
  } catch {
    /* 没有 manifest：只扫仓库版 */
  }
  if (bundleName) {
    for (const p of subdirs(path.join(DSH_HOME, 'profiles'))) {
      const cand = path.join(p, 'node_modules', bundleName)
      if (exists(cand)) roots.push(cand)
    }
    const shared = path.join(DSH_HOME, 'profiles', 'node_modules', bundleName)
    if (exists(shared)) roots.push(shared)
  }

  /** 会被加载的文本（插件源码、组合定义、清单）；跳过备份与 node_modules */
  const collect = (root, files) => {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue
      const p = path.join(root, e.name)
      if (e.isDirectory()) collect(p, files)
      else if (
        /\.(m?js|ya?ml|json)$/.test(e.name) &&
        !/\.pre-[^/]*$/.test(e.name) &&
        !e.name.includes('.pre-resync')
      )
        files.push(p)
    }
  }

  const seen = new Set()
  const files = []
  for (const root of roots) {
    let real
    try {
      real = fs.realpathSync(root)
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    collect(root, files)
  }
  if (!files.length) {
    t.skip('没有可扫描的预设目录（非本机部署）')
    return
  }

  // "仓库绝对路径"= 指向 <某个目录>/crosspost-runtime 的那些
  // 必须排除 `/../../crosspost-runtime（相对）` 这类**相对**写法：注释里就写着它，
  // 而它正是本文件要证明"仍然成立"的那个相对软链（预设目录内 ../runtime）。
  const stale = []
  for (const f of files) {
    const src = read(f)
    for (const m of src.matchAll(/\/\/[A-Za-z0-9_./-]*crosspost-runtime\//g)) {
      const p = m[0].replace(/^\/+/, '/').replace(/\/+/g, '/')
      if (p.startsWith('/../') || p.includes('/../')) continue // 相对写法，不是绝对路径
      if (p.startsWith(REPO + '/')) continue // 指向当前仓库，正确
      stale.push(`${f}\n    ${p}`)
    }
  }

  assert.deepEqual(
    stale,
    [],
    `预设里引用了非当前仓库的 crosspost-runtime 路径（改前记得备份）：\n  ` +
      stale.join('\n  ') +
      `\n\n修法：把该路径改成相对写法（预设目录内 ../runtime 软链）或当前仓库位置（仓库根 = ${REPO}）。`,
  )
})

/**
 * ③ compose 项目名必须显式钉住。
 *
 * 不钉的后果不是"起不来"，而是**改名后悄悄换了一套卷**：旧卷成孤儿，
 * 新卷是空的 → 下一次 up 重新装依赖、重建 core。全程没有一条报错，
 * 只有"容器 healthy 但引擎缺依赖"这种反直觉症状。
 */
test('改名一致性：docker-compose.yml 显式钉住项目名（防改名换卷）', (t) => {
  const f = path.join(REPO, 'docker-compose.yml')
  if (!exists(f)) {
    t.skip('本仓库没有 docker-compose.yml')
    return
  }
  const src = read(f)
  const m = /^name:\s*(\S+)\s*$/m.exec(src)
  assert.ok(
    m,
    'docker-compose.yml 顶层缺少 `name:` —— compose 项目名将取目录名，' +
      '仓库目录一改名，卷名/容器名就跟着变：旧卷成孤儿、新卷是空的（无任何报错）。',
  )
  const slug = path
    .basename(REPO)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
  assert.ok(
    m[1] === slug || m[1].startsWith(slug),
    `docker-compose.yml 的项目名 "${m[1]}" 与仓库目录 "${path.basename(REPO)}" 不一致；` +
      `两者不一致意味着改名后容易忘记同步（当前是刻意的？请在该行上方写明理由）。`,
  )
})

/**
 * ④ profile 的插件软链必须都能解析。
 *
 * 为什么单独一条：①②③ 查的都是**文本里写死的绝对路径**，而这一条查的是**软链**。
 * 软链在 `readdirSync(withFileTypes)` 里既不是 `isDirectory()`（对软链为 false），
 * 名字又常常没有扩展名 —— 测试②的 `walk()` 因此会把它们整体跳过。
 *
 * 断链的后果是静默的：DSH 按**包名**解析 profile 里的插件行，包名最终由
 * `~/.dsh/profiles/node_modules/<包名>` 这条软链落到仓库路径上；链一断，
 * 那一行插件就不存在了 —— DSH 照常启动，只是少一个能力（与 ① 的 MCP 行失效同族）。
 *
 * 判据两条，**互不替代**：
 *   a. 被插件行 `name:` 引用的包名，若在共享 `node_modules` 里是软链，必须能解析；
 *      （改名后 `crosspost-client` 正是断在这里：目标还写着旧目录）
 *   b. 任何**目标落在仓库内**的软链必须能解析 —— `runtime`、`upgrade-check.sh` 这些
 *      今天是对的，但同属"下次挪仓库就会断"，一起盯住。
 *
 * 扫描面刻意只到"接线会经过的那两层"，不做全盘递归：会话目录里成千上万个文件与
 * 本判据无关，把它们扫进来只会让人关掉这条护栏。
 */
test('改名一致性：profile 的插件软链必须都能解析（断链 = 那一行插件静默消失）', (t) => {
  const profiles = path.join(DSH_HOME, 'profiles')
  const sharedModules = path.join(profiles, 'node_modules')
  const presetRoot = path.join(DSH_HOME, '.agent-presets')

  /** 某目录的**直接子项**里的软链（不递归：接线只经过这几层） */
  const topLevelLinks = (dir) => {
    if (!exists(dir)) return []
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (isLink(p)) out.push({ link: p, target: fs.readlinkSync(p) })
    }
    return out
  }

  // a) 插件行 `name:` 引用的包名 → 共享 node_modules 里的软链
  //
  // 行从这里来：① 各 profile 的 patch；② 预设 bundle 的 patch（预设的条目列表现在
  // 住在 `@deepseek-ai/dsh-agent-preset` 声明行的 `config.plugins` 里，不再是
  // `~/.dsh/.agent-presets/<id>/agent.cordis.yml`——那个目录已无读取方）。
  const rowFiles = []
  for (const d of subdirs(profiles)) {
    const f = path.join(d, 'cordis.patch.yml')
    if (exists(f)) rowFiles.push(f)
  }
  {
    const seen = new Set()
    const addPatch = (f) => {
      if (!exists(f)) return
      let real
      try {
        real = fs.realpathSync(f)
      } catch {
        return
      }
      if (seen.has(real)) return
      seen.add(real)
      rowFiles.push(f)
    }
    for (const d of subdirs(path.join(REPO, 'preset'))) {
      // 仓库里的 bundle patch（名字由 package.json 的 dsh.bundle.patch 声明，这里按后缀收）
      try {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isFile() && e.name.endsWith('.patch.yml')) addPatch(path.join(d, e.name))
        }
      } catch {
        /* 目录不可读 */
      }
      // 本机已安装的同一份（`link:` 安装下 realpath 相同，上面的去重会跳过；副本安装则多扫一份）
      const name = path.basename(d)
      for (const p of subdirs(profiles)) {
        try {
          for (const e of fs.readdirSync(path.join(p, 'node_modules', name), {
            withFileTypes: true,
          })) {
            if (e.isFile() && e.name.endsWith('.patch.yml'))
              addPatch(path.join(p, 'node_modules', name, e.name))
          }
        } catch {
          /* 没装这个 bundle */
        }
      }
    }
  }

  if (!exists(sharedModules) || rowFiles.length === 0) {
    t.skip('本机没有 DSH profile / 共享 node_modules（非本机部署）')
    return
  }

  // 自检：仓库里的 bundle patch 必须真的进了扫描面 —— 否则下次换载体时这条护栏会**静默变空**
  for (const d of subdirs(path.join(REPO, 'preset'))) {
    let names = []
    try {
      names = fs.readdirSync(d).filter((n) => n.endsWith('.patch.yml'))
    } catch {
      /* 不可读 */
    }
    for (const n of names) {
      const f = path.join(d, n)
      assert.ok(
        rowFiles.includes(f),
        `仓库里的预设 bundle patch ${f} 未进入插件行扫描面（换载体后这里会静默变空）`,
      )
    }
  }

  const dead = new Map() // link → 说明；两条判据可能命中同一条，去重
  for (const f of rowFiles) {
    for (const line of read(f).split('\n')) {
      const m = /^\s*name:\s*(\S.*?)\s*$/.exec(line)
      if (!m) continue
      const name = m[1].replace(/^['"]|['"]$/g, '')
      // 相对路径（./plugins/…）与组合语法（cordis:group）不是包名，各有各的护栏
      if (!name || name.startsWith('.') || name.includes(':')) continue
      const link = path.join(sharedModules, name)
      if (!isLink(link) || exists(link)) continue
      dead.set(link, `${link}\n    → ${fs.readlinkSync(link)}\n    被插件行引用：${f}`)
    }
  }

  // b) 目标落在仓库内的软链 —— DSH_HOME 顶层 + profiles/* 的直接子项 +
  //    仓库 preset 目录（`runtime → ../../crosspost-runtime` 正是这一层的接线，
  //    它一断，该预设下所有会话都会报 Cannot find module）
  const linkDirs = [
    DSH_HOME,
    ...subdirs(profiles), // 含 profiles/node_modules
    ...subdirs(presetRoot),
    ...subdirs(path.join(REPO, 'preset')),
  ]
  for (const dir of linkDirs) {
    for (const { link, target } of topLevelLinks(dir)) {
      const abs = path.isAbsolute(target) ? target : path.resolve(path.dirname(link), target)
      if (!abs.startsWith(REPO + path.sep)) continue
      if (!exists(link)) dead.set(link, `${link}\n    → ${abs}\n    目标应在本仓库内`)
    }
  }

  assert.deepEqual(
    [...dead.values()],
    [],
    `以下软链已断 —— DSH 不会因此启动失败，只会让那一行插件（或那条命令行入口）静默消失：\n  ` +
      [...dead.values()].join('\n  ') +
      `\n\n修法：把软链指回当前仓库（仓库根 = ${REPO}）：` +
      `\n     ln -sfn ${REPO}/preset/crosspost/plugins/<包名> ${sharedModules}/<包名>` +
      `\n     仓库内的 runtime 软链则是相对写法：ln -sfn ../../crosspost-runtime <预设目录>/runtime` +
      `\n\n为什么文本类护栏看不见它：软链不是 .m?js|ya?ml|json 文件，测试②的 walk() 会跳过。`,
  )
})
