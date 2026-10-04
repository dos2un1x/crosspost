// 产品文档卫生（2026-09-26）
//
// 背景（反复踩到）：仓库对外的 `README.md` 与 `docs/**` 只该讲**这套东西是什么、
// 怎么装、怎么用、怎么接、坏了怎么修**。但每次功能提交顺手改文档时，很容易把
// **改动本身**写进去：日期戳、"vX.Y 起…"的版本考古、"以前怎样 / 我们放弃了什么"
// 的决策叙事、内部测试文件名、只有维护者才需要的流程。
//
// 这类内容有三个具体害处，都不是审美问题：
//   ① 读者要的是"现在该怎么做"，却先读到一段历史，**关键信息被埋**；
//   ② 版本考古会**过期**——文档说"v2.3.1 起不再装独立树"，而读者根本不知道自己的
//      版本，也不知道该怎么核对；
//   ③ 内部文件名与维护者流程**对使用者没有可执行性**，却让文档显得需要"内部知识"。
//
// 所以本文件把这条纪律机械化。它不是"文风检查"：列出的五类都有明确的替代写法
// （历史进提交信息与 tag；维护者流程进 CONTRIBUTING.md）。
//
// 设计取舍：**扫描面小而准**——上面这六类文风规则只扫产品文档与贡献者文档，不扫
// `md-backup/**`（那是冻结归档，本来就该保留旧文本）、不扫代码注释（那里记"为什么这样改"
// 是合理的）。文件末尾另有两条**与文风无关**的"指路有效性"断言：文档引用的仓库路径、
// 以及任何文件（含代码注释）里引用的 `docs/*.md` —— 指向不存在的文件在哪都是缺陷。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')

/** 产品文档：面向使用者 / 接入方 */
const PRODUCT = ['README.md', 'SECURITY.md']
for (const f of fs.readdirSync(path.join(REPO, 'docs'))) {
  if (f.endsWith('.md')) PRODUCT.push(path.join('docs', f))
}
for (const d of fs.readdirSync(path.join(REPO, 'examples'))) {
  const f = path.join('examples', d, 'README.md')
  if (fs.existsSync(path.join(REPO, f))) PRODUCT.push(f)
}

/** 贡献者文档：可以出现内部测试名与归档流程，但同样不许写历史 */
const CONTRIBUTOR = ['CONTRIBUTING.md']

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')

/**
 * README 顶部那一行是**唯一允许**出现版本号的地方（它由 version-contract 盯着）。
 * 其余任何 `vX.Y` 都是版本考古。
 */
const ALLOWED_VERSION_LINE = /^\s*当前版本\s+\*\*v[0-9][0-9.]*\*\*。\s*$/

/** 五类违规 + 各自的替代写法 */
const RULES = [
  {
    id: '日期戳',
    re: /\b20[0-9]{2}-[0-9]{2}-[0-9]{2}\b/,
    why: '产品文档不需要日期。改动发生在哪天属于提交信息与 tag',
  },
  {
    id: '版本考古',
    re: /v[0-9]+\.[0-9]+(?:\.[0-9]+)?\s*(?:起|之后|之前|以[前后])/,
    why: '读者不知道也不必知道自己的版本；要写就写"现在的行为"，或"用 X 命令核对版本"',
  },
  {
    id: '决策叙事',
    re: /实测|踩到|教训|此前|原先是|我们放弃|回归/,
    why: '"以前怎样、为什么改成现在这样"是提交信息的职责；文档只写当前规则',
  },
  {
    id: '内部测试名',
    re: /[A-Za-z0-9_-]+\.test\.mjs/,
    why: '使用者无法执行它。要指路就指向 CONTRIBUTING.md 的验证入口',
    contributorOk: true,
  },
  {
    id: '作者家目录',
    // `/Users/me/…` 这类**占位符**是示例，允许；真实用户名则不允许。
    re: /\/Users\/(?!me\b|you\b|x\b|your\b|<)[A-Za-z0-9_.-]+\//,
    why: '示例一律用 /Users/me/… 这类占位符；写死真实家目录会让文档只对一台机器成立',
  },
  {
    id: '归档区外泄',
    re: /md-backup/,
    why: 'md-backup/ 是 gitignore 的本机归档，产品文档里出现它等于泄漏内部结构',
    contributorOk: true,
  },
]

/**
 * 逐行匹配，返回 `文件:行号 内容（规则）`。
 *
 * 逃生舱：行内含 `hygiene-allow` 时跳过该行 —— 唯一正当用途是**规则陈述本身**
 * （比如 CONTRIBUTING 里"不写『…』这类叙事"必须把被禁的说法引出来）。
 * 它按**行**豁免而不是按文件/规则豁免：把"这一条规矩不许生效"的范围压到最小。
 */
function violations(files, { contributor = false } = {}) {
  const out = []
  for (const rel of files) {
    const lines = read(rel).split('\n')
    for (const rule of RULES) {
      if (contributor && rule.contributorOk) continue
      lines.forEach((line, i) => {
        if (line.includes('hygiene-allow')) return
        if (rule.id === '版本考古' && ALLOWED_VERSION_LINE.test(line)) return
        if (rule.re.test(line)) out.push(`${rel}:${i + 1} ［${rule.id}］${line.trim()}`)
      })
    }
  }
  return out
}

test('文档卫生：产品文档不得写改动历史 / 内部接线', () => {
  const bad = violations(PRODUCT)
  assert.deepEqual(
    bad,
    [],
    `产品文档里出现了"改动本身"而不是"系统现状"：\n  ` +
      bad.join('\n  ') +
      `\n\n对照修法：\n` +
      RULES.map((r) => `  · ${r.id}：${r.why}`).join('\n') +
      `\n\n（历史留在提交信息与 tag 里；维护者流程留在 CONTRIBUTING.md。）`,
  )
})

test('文档卫生：贡献者文档同样不写改动历史（内部测试名与归档流程除外）', () => {
  const bad = violations(CONTRIBUTOR, { contributor: true })
  assert.deepEqual(bad, [], `CONTRIBUTING.md 里出现了改动历史：\n  ` + bad.join('\n  '))
})

test('文档卫生：产品文档的相对链接必须有效', () => {
  const dead = []
  for (const rel of PRODUCT) {
    const dir = path.dirname(path.join(REPO, rel))
    const src = read(rel)
    for (const m of src.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1]
      if (/^(https?:|mailto:|#)/.test(href)) continue
      const target = href.split('#')[0]
      if (!target) continue
      if (!fs.existsSync(path.resolve(dir, target))) dead.push(`${rel} → ${href}`)
    }
  }
  assert.deepEqual(
    dead,
    [],
    `产品文档里有指向不存在文件的链接（读者点开就是 404）：\n  ` + dead.join('\n  '),
  )
})

test('文档卫生：文档地图必须覆盖 docs/ 下的每一份文档', () => {
  // 新增文档却忘了在 README 的文档表里挂上去 = 读者永远找不到它。
  const readme = read('README.md')
  const orphans = []
  for (const f of fs.readdirSync(path.join(REPO, 'docs'))) {
    if (!f.endsWith('.md')) continue
    if (!readme.includes(`docs/${f}`)) orphans.push(`docs/${f}`)
  }
  assert.deepEqual(
    orphans,
    [],
    `以下文档没有被 README 的文档表引用（新增后忘了挂上去？）：\n  ` + orphans.join('\n  '),
  )
})

/**
 * 干净的发布物文件集：`git ls-files --cached --others --exclude-standard`。
 *
 * 与 `fresh-clone-smoke.mjs` 造沙箱用的是**同一条命令** —— 它列出的正是"别人 clone
 * 下来会拿到的东西"，所以"文档指了一个只有本机才有的文件"这条能被它抓到。
 */
function releaseFileSet() {
  try {
    return new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: REPO,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')
        .filter(Boolean),
    )
  } catch {
    return null // 无 git / 非仓库：相关断言跳过
  }
}

/** tracked 里的源码文件（排除依赖、vendored 产物、冻结归档与覆盖率产物） */
const SOURCE_SKIP = /(?:^|\/)(?:node_modules|vendor|md-backup|coverage)\//
function trackedSource() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((f) => /\.(mjs|js|ts|tsx)$/.test(f) && !SOURCE_SKIP.test(f))
  } catch {
    return []
  }
}

/**
 * 按设计**不进发布物**的运行态文件：写进文档是对的，不该被判成"指向不存在的文件"。
 * 每项都要能回答"它为什么不在干净 clone 里"。
 */
const RUNTIME_PATHS = [
  'crosspost-runtime/config.json', // `npm run setup` 生成的本机配置
  'crosspost-runtime/paths.json', // `npm run setup` 生成的本机路径表
  'crosspost-runtime/storage.json', // 运行时状态
  'crosspost-runtime/ever-authed.json', // 运行时状态
  'crosspost-runtime/platforms-state.json', // 运行时状态
]

test('文档卫生：产品文档引用的仓库路径必须真的在发布物里', () => {
  const release = releaseFileSet()
  if (!release) return
  // 只认"以已知顶层目录开头 + 带扩展名 + 不含通配符/占位符"的路径；
  // 文档里的示例路径与占位符（`foo/bar.mjs`、`<仓库>/…`）不参与判定。
  const KNOWN = /^(?:crosspost-runtime|bridge|docs|examples|preset|docker|\.github)\//
  const EXT = /\.(?:mjs|js|ts|tsx|json|md|yml|yaml|sh|css|html)$/
  const bad = []
  for (const rel of PRODUCT) {
    for (const m of read(rel).matchAll(/`([^`\n]+)`/g)) {
      const target = m[1].trim()
      if (!KNOWN.test(target) || !EXT.test(target)) continue
      if (/[*<>]/.test(target)) continue
      if (RUNTIME_PATHS.includes(target)) continue
      if (!fs.existsSync(path.join(REPO, target)) || !release.has(target))
        bad.push(`${rel} → ${target}`)
    }
  }
  assert.deepEqual(
    bad,
    [],
    `产品文档指向了干净 clone 里没有的文件（读者照做必然失败）：\n  ` +
      bad.join('\n  ') +
      `\n\n若它按设计就是运行态/生成物，加进 RUNTIME_PATHS 并写明理由。`,
  )
})

test('文档卫生：任何文件（含代码注释）里引用的 docs/*.md 必须存在', () => {
  // 不是文风规则，而是"指路有效性"：注释把人指向一份不存在的文档，下一个人只会白找一趟。
  // 历史归档件在同行写明"已归档"即可（那种情况下路径本来就是历史值）。
  const DOC_REF = /(?:^|[\s`(（])((?:md-backup\/)?docs\/[A-Za-z0-9_.-]+\.md)/g
  const bad = []
  for (const rel of trackedSource()) {
    read(rel)
      .split('\n')
      .forEach((line, i) => {
        const t = line.trim()
        if (!/^(\/\/|\*|\/\*)/.test(t)) return
        if (line.includes('已归档')) return
        for (const m of line.matchAll(DOC_REF))
          if (!fs.existsSync(path.join(REPO, m[1]))) bad.push(`${rel}:${i + 1} → ${m[1]}`)
      })
  }
  assert.deepEqual(bad, [], `注释里指向了不存在的文档：\n  ${bad.join('\n  ')}`)
})
