// 项目注册表契约测试（P1）
//
// 锁死「接入契约」的机器可校验部分（docs/integration.md §2）：
//   · manifest 校验规则（必填字段、能力白名单、版本策略、drafts→dataDir 依赖）
//   · 无效 manifest 必须被**报出**而不是被静默忽略
//   · 提供者的可达性判定
//   · **向后兼容铁律**：不指定 project 时行为必须与 P0 一致（mode=default）
//
// 最后一条尤其重要：引入多项目能力时，最容易的破坏方式就是让既有单项目部署
// 因为"现在需要显式指定项目"而失效。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MANIFEST_VERSION,
  KNOWN_CAPABILITIES,
  validateManifest,
  listProjects,
  resolveProject,
  resolveProjectDataDir,
  registrySummary,
} from '../src/projects.mjs'
import { getDraftsDir } from '../src/articles.mjs'

/** 在临时目录里布置一组项目，返回 { root, cleanup } */
function fixture(projects) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-projects-'))
  for (const [dirName, spec] of Object.entries(projects)) {
    const dir = path.join(root, dirName)
    fs.mkdirSync(path.join(dir, '.crosspost'), { recursive: true })
    if (spec.raw !== undefined) {
      fs.writeFileSync(path.join(dir, '.crosspost', 'project.json'), spec.raw)
    } else {
      fs.writeFileSync(
        path.join(dir, '.crosspost', 'project.json'),
        JSON.stringify(spec.manifest, null, 2),
      )
    }
    if (spec.dataDir) fs.mkdirSync(path.join(dir, spec.dataDir), { recursive: true })
  }
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

/**
 * 在指定扫描根下运行断言（用 env 覆盖，不触碰真实配置）。
 *
 * 必须**同时**隔离三个来源（缺一个就会漏）：否则引擎默认扫描目录
 * （<repo>/.local/projects）会被一并枚举，测试结果取决于本机是否恰好放着
 * 示例项目——这是典型的"测试间相互污染"，实测已踩到（本机 .local/projects
 * 下的示例项目让断言 1 !== 2 失败）。
 */
function withRoot(root, fn) {
  const prevDirs = process.env.CROSSPOST_PROJECTS_DIRS
  const prevDir = process.env.CROSSPOST_PROJECTS_DIR
  const prevCfg = process.env.CROSSPOST_CONFIG
  process.env.CROSSPOST_PROJECTS_DIRS = root
  process.env.CROSSPOST_PROJECTS_DIR = path.join(root, '__no_default_root__')
  // ③ CROSSPOST_CONFIG —— 否则会读到本机 config.json 的 projectsDirs。
  // v2.54 实测踩到：真实写作项目接进注册表后本文件一次挂 8 例（本机配置多出
  // 一个项目 → listProjects() 不再是 fixture 里那一个）。"测试读了生产配置"
  // 是同类问题第二次出现（第一次见 v2.47 沙箱脑裂），这次换个通道漏进来。
  process.env.CROSSPOST_CONFIG = path.join(root, '__no_machine_config__.json')
  try {
    return fn()
  } finally {
    if (prevDirs === undefined) delete process.env.CROSSPOST_PROJECTS_DIRS
    else process.env.CROSSPOST_PROJECTS_DIRS = prevDirs
    if (prevDir === undefined) delete process.env.CROSSPOST_PROJECTS_DIR
    else process.env.CROSSPOST_PROJECTS_DIR = prevDir
    if (prevCfg === undefined) delete process.env.CROSSPOST_CONFIG
    else process.env.CROSSPOST_CONFIG = prevCfg
  }
}

test('注册表①：合法 manifest 被识别，并提供可达的 paths 提供者', () => {
  const { root, cleanup } = fixture({
    alpha: {
      manifest: {
        id: 'alpha',
        name: '项目 Alpha',
        manifestVersion: 1,
        capabilities: { drafts: true },
        dataDir: 'drafts',
      },
      dataDir: 'drafts',
    },
  })
  try {
    withRoot(root, () => {
      const list = listProjects()
      assert.equal(list.length, 1)
      const p = list[0]
      assert.equal(p.id, 'alpha')
      assert.equal(p.valid, true, p.errors.join('; '))
      assert.equal(p.provider.kind, 'paths')
      assert.equal(p.provider.reachable, true)
      assert.ok(fs.existsSync(p.provider.dataDir))
    })
  } finally {
    cleanup()
  }
})

test('注册表②：声明 drafts 但缺 dataDir → 无效且报明确原因', () => {
  const { root, cleanup } = fixture({
    bad: {
      manifest: {
        id: 'bad',
        name: '缺 dataDir',
        manifestVersion: 1,
        capabilities: { drafts: true },
      },
    },
  })
  try {
    withRoot(root, () => {
      const p = listProjects()[0]
      assert.equal(p.valid, false)
      assert.ok(
        p.errors.some((e) => /dataDir/.test(e)),
        `错误信息应指明 dataDir：${p.errors.join('; ')}`,
      )
    })
  } finally {
    cleanup()
  }
})

test('注册表③：dataDir 不存在 → 有效但提供者不可达（区分"配置错"与"路径暂时不可用"）', () => {
  const { root, cleanup } = fixture({
    gone: {
      manifest: {
        id: 'gone',
        name: '路径不存在',
        manifestVersion: 1,
        capabilities: { drafts: true },
        dataDir: 'not-created',
      },
    },
  })
  try {
    withRoot(root, () => {
      const p = listProjects()[0]
      assert.equal(p.valid, true, '配置本身合法，只是路径不可达')
      assert.equal(p.provider.reachable, false)
      assert.match(p.provider.reason, /不存在/)
    })
  } finally {
    cleanup()
  }
})

test('注册表④：未知能力被拒绝（防止 manifest 悄悄引入引擎不认识的概念）', () => {
  const { root, cleanup } = fixture({
    weird: {
      manifest: {
        id: 'weird',
        name: '未知能力',
        manifestVersion: 1,
        capabilities: { teleport: true },
      },
    },
  })
  try {
    withRoot(root, () => {
      const p = listProjects()[0]
      assert.equal(p.valid, false)
      assert.ok(p.errors.some((e) => /teleport/.test(e)))
    })
  } finally {
    cleanup()
  }
})

test('注册表⑤：manifestVersion 高于引擎 → 无效（要求升级引擎，而非静默降级）', () => {
  const { root, cleanup } = fixture({
    future: {
      manifest: {
        id: 'future',
        name: '未来版本',
        manifestVersion: MANIFEST_VERSION + 1,
        capabilities: {},
      },
    },
  })
  try {
    withRoot(root, () => {
      const p = listProjects()[0]
      assert.equal(p.valid, false)
      assert.ok(p.errors.some((e) => /高于引擎支持/.test(e)))
    })
  } finally {
    cleanup()
  }
})

test('注册表⑥：manifestVersion 低于引擎 → 仍有效，但带升级告警（告警不拒绝）', () => {
  // v2.51：引擎契约版本升到 2 后，本用例改为**跟随 MANIFEST_VERSION** 取
  // "比当前低一版"，否则每次升版都要手改这个数字（而写死 1 就变成"断言无告警"，
  // 一旦升版必然假失败——正是这条用例在这次升级里暴露出来的问题）。
  const older = MANIFEST_VERSION - 1
  const { root, cleanup } = fixture({
    old: {
      manifest: { id: 'old', name: '旧版本', manifestVersion: older, capabilities: {} },
    },
  })
  try {
    withRoot(root, () => {
      const p = listProjects()[0]
      assert.equal(p.valid, true, '低版本 manifest 必须仍被接受（只告警不拒绝）')
      assert.ok(
        p.warnings.some((w) => /低于当前/.test(w)),
        `低版本应带升级告警，实际 warnings=${JSON.stringify(p.warnings)}`,
      )
    })
  } finally {
    cleanup()
  }
})

test('注册表⑦：JSON 语法错误被报出（含文件路径），不得静默忽略', () => {
  const { root, cleanup } = fixture({
    broken: { raw: '{ "id": "broken", ' },
  })
  try {
    withRoot(root, () => {
      const list = listProjects()
      assert.equal(list.length, 1, '解析失败的项目也必须出现在列表里（否则用户无从发现）')
      assert.equal(list[0].valid, false)
      assert.match(list[0].errors.join(' '), /JSON 解析失败/)
      assert.ok(list[0].sourcePath.endsWith('project.json'))
    })
  } finally {
    cleanup()
  }
})

test('注册表⑧：id 重复被报出', () => {
  const { root, cleanup } = fixture({
    one: { manifest: { id: 'dup', name: 'A', manifestVersion: 1, capabilities: {} } },
    two: { manifest: { id: 'dup', name: 'B', manifestVersion: 1, capabilities: {} } },
  })
  try {
    withRoot(root, () => {
      const list = listProjects()
      const invalid = list.filter((p) => !p.valid)
      assert.equal(invalid.length, 1, '重复 id 的第二个应被判无效')
      assert.match(invalid[0].errors.join(' '), /id 重复/)
    })
  } finally {
    cleanup()
  }
})

test('注册表⑨：id 含非法字符被拒绝（id 会用于数据隔离，必须安全）', () => {
  const r = validateManifest({ id: '../etc/passwd', name: 'x', manifestVersion: 1 }, '/tmp/x')
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /非法字符/.test(e)))
})

test('注册表⑩：向后兼容铁律 —— 不指定 project 时恒为 default 模式（P0 行为不变）', () => {
  assert.equal(resolveProject().mode, 'default')
  assert.equal(resolveProject('').mode, 'default')
  assert.equal(resolveProject(undefined).mode, 'default')
  // 未注册的项目也回退 default（而不是抛错把既有用法打断），但给出可读原因
  const r = resolveProject('definitely-not-registered-xyz')
  assert.equal(r.mode, 'default')
  assert.match(r.error, /未注册/)
})

test('注册表⑪：已知能力清单与集成文档一致（防止文档与代码漂移）', () => {
  const INTEGRATION = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    '..',
    'docs',
    'integration.md',
  )
  if (!fs.existsSync(INTEGRATION)) return // 文档缺失时跳过（不把测试绑死在文档上）
  const doc = fs.readFileSync(INTEGRATION, 'utf8')
  for (const cap of KNOWN_CAPABILITIES) {
    assert.ok(
      doc.includes(cap),
      `docs/integration.md 未提及能力 "${cap}"；能力清单变更时请同步文档`,
    )
  }
})

test('注册表⑫：registrySummary 结构稳定（Console/doctor 依赖它）', () => {
  const { root, cleanup } = fixture({
    s: { manifest: { id: 's', name: 'S', manifestVersion: 1, capabilities: {} } },
  })
  try {
    withRoot(root, () => {
      const s = registrySummary()
      for (const k of ['manifestVersion', 'roots', 'count', 'valid', 'invalid', 'projects']) {
        assert.ok(k in s, `registrySummary 缺少字段 ${k}`)
      }
      assert.equal(s.count, s.valid + s.invalid)
    })
  } finally {
    cleanup()
  }
})

test('注册表⑬：默认扫描目录可用 CROSSPOST_PROJECTS_DIR 覆盖（且不影响显式目录）', () => {
  const { root, cleanup } = fixture({
    p: { manifest: { id: 'p', name: 'P', manifestVersion: 1, capabilities: {} } },
  })
  const prevDir = process.env.CROSSPOST_PROJECTS_DIR
  const prevDirs = process.env.CROSSPOST_PROJECTS_DIRS
  const prevCfg = process.env.CROSSPOST_CONFIG
  try {
    delete process.env.CROSSPOST_PROJECTS_DIRS
    process.env.CROSSPOST_PROJECTS_DIR = root
    // 同 withRoot：不隔离 config 就会读到本机 projectsDirs（v2.54 实测）
    process.env.CROSSPOST_CONFIG = path.join(root, '__no_machine_config__.json')
    const list = listProjects()
    assert.equal(list.length, 1, '应只发现 CROSSPOST_PROJECTS_DIR 下的项目')
    assert.equal(list[0].id, 'p')
  } finally {
    if (prevDir === undefined) delete process.env.CROSSPOST_PROJECTS_DIR
    else process.env.CROSSPOST_PROJECTS_DIR = prevDir
    if (prevDirs === undefined) delete process.env.CROSSPOST_PROJECTS_DIRS
    else process.env.CROSSPOST_PROJECTS_DIRS = prevDirs
    if (prevCfg === undefined) delete process.env.CROSSPOST_CONFIG
    else process.env.CROSSPOST_CONFIG = prevCfg
    cleanup()
  }
})

// ── 内容域 project 维度：解析器与向后兼容 ────────────────────────────────

test('注册表⑭：resolveProjectDataDir 区分四种情况（不注册/无效/不可达/可用）', () => {
  const { root, cleanup } = fixture({
    ok: {
      manifest: {
        id: 'ok',
        name: 'OK',
        manifestVersion: 1,
        capabilities: { drafts: true },
        dataDir: 'drafts',
      },
      dataDir: 'drafts',
    },
    unreachable: {
      manifest: {
        id: 'unreachable',
        name: 'U',
        manifestVersion: 1,
        capabilities: { drafts: true },
        dataDir: 'not-there',
      },
    },
    invalid: {
      manifest: { id: 'invalid', name: 'I', manifestVersion: 99, capabilities: {} },
    },
  })
  try {
    withRoot(root, () => {
      // 未指定
      assert.match(resolveProjectDataDir(undefined).error, /未指定/)
      assert.match(resolveProjectDataDir('').error, /未指定/)
      // 未注册
      assert.match(resolveProjectDataDir('ghost').error, /未注册/)
      // manifest 无效
      assert.match(resolveProjectDataDir('invalid').error, /无效/)
      // 可达
      const ok = resolveProjectDataDir('ok')
      assert.ok(ok.dir && fs.existsSync(ok.dir), `应返回可达目录：${JSON.stringify(ok)}`)
      // 不可达
      assert.match(resolveProjectDataDir('unreachable').error, /不可达/)
    })
  } finally {
    cleanup()
  }
})

test('注册表⑮：向后兼容铁律 —— getDraftsDir() 无参行为不受 project 维度影响', () => {
  // 这是引入内容域 project 维度时**最容易破坏**的东西：既有单项目部署
  // 会在不知不觉中读到别的目录。无参调用必须与改动前逐字一致。
  const plain = getDraftsDir()
  assert.equal(typeof plain, 'string')
  assert.ok(plain.length > 0)

  // 无论注册表里有什么，无参调用都不应改变
  const { root, cleanup } = fixture({
    x: {
      manifest: {
        id: 'x',
        name: 'X',
        manifestVersion: 1,
        capabilities: { drafts: true },
        dataDir: 'drafts',
      },
      dataDir: 'drafts',
    },
  })
  try {
    withRoot(root, () => {
      assert.equal(getDraftsDir(), plain, '注册表内容不得影响无参调用')
    })
  } finally {
    cleanup()
  }
})

test('注册表⑯：getDraftsDir(projectId) 走项目数据源；未注册/无效才回退默认（不抛错）', () => {
  const { root, cleanup } = fixture({
    p: {
      manifest: {
        id: 'p',
        name: 'P',
        manifestVersion: 1,
        capabilities: { drafts: true },
        dataDir: 'drafts',
      },
      dataDir: 'drafts',
    },
    // v2.33：manifest 有效但 dataDir 不存在 → **仍用声明路径**，不回退默认。
    // 回退的后果是"选中一个接不进来的项目，却看到默认项目的文章"。
    ghostDir: {
      manifest: {
        id: 'ghostDir',
        name: 'G',
        manifestVersion: 1,
        capabilities: { drafts: true },
        dataDir: 'nowhere',
      },
    },
  })
  try {
    withRoot(root, () => {
      const viaProject = getDraftsDir('p')
      assert.ok(viaProject.includes('drafts'), `应指向项目数据目录：${viaProject}`)
      assert.notEqual(viaProject, getDraftsDir(), '项目目录不应等于默认目录')

      // ① 有效但不可达 → 声明路径（空视图），**不是**默认目录
      const unreachable = getDraftsDir('ghostDir')
      assert.ok(
        unreachable.endsWith(path.join('ghostDir', 'nowhere')),
        `不可达项目应使用声明路径：${unreachable}`,
      )
      assert.notEqual(unreachable, getDraftsDir(), '不可达项目绝不能回退到默认草稿目录')

      // ② 未注册 / 空值 → 回退默认，绝不抛出（引入多项目不该把既有用法打断）
      assert.equal(getDraftsDir('definitely-not-registered'), getDraftsDir())
      assert.equal(getDraftsDir(''), getDraftsDir())
      assert.equal(getDraftsDir(undefined), getDraftsDir())
    })
  } finally {
    cleanup()
  }
})
