/**
 * 运行前置检查（preflight）——引擎自治与开箱即用的第一道门禁。
 *
 * 设计原则：
 *  · **纯函数 + 显式入参**：不读全局状态、不做副作用，便于单测与多项目复用。
 *  · **每条检查给出"怎么修"**：`hint` 必须是可以照着做的动作，而不是错误码复述。
 *  · **区分 fail 与 warn**：fail 阻止继续（如 Node 版本过低），warn 只提示。
 *
 * 与 `preset/upgrade-check.sh` 的分工（见 CONTRIBUTING.md「开发环境」）：
 *   preflight/doctor = 运行时全栈前置与日常自检（Node/端口/扩展/配置/schema）
 *   upgrade-check    = DSH 升级后的部署专项自检（软链/枚举/manifest）
 * 二者共享本模块的检查函数，不重复实现。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 最低 Node 版本（强制）。与 6 个 package.json 的 engines.node 保持一致。 */
export const MIN_NODE_MAJOR = 24

/** 结果分级 */
export const SEVERITY = { FAIL: 'fail', WARN: 'warn', OK: 'ok' }

/** 解析 Node 主版本 */
export function nodeMajor(version = process.versions.node) {
  return Number(String(version).split('.')[0])
}

/**
 * 检查 Node 版本 >= MIN_NODE_MAJOR。
 * 这是硬门禁：版本不足时引擎不应继续（避免"装上了但行为异常"的中间态）。
 */
export function checkNodeVersion(version = process.versions.node) {
  const major = nodeMajor(version)
  const ok = Number.isFinite(major) && major >= MIN_NODE_MAJOR
  return {
    id: 'node-version',
    severity: ok ? SEVERITY.OK : SEVERITY.FAIL,
    title: `Node 版本 ≥ ${MIN_NODE_MAJOR}`,
    detail: `当前 ${version}（${process.execPath}）`,
    value: version,
    ...(ok
      ? {}
      : {
          hint:
            `本项目要求 Node ≥ ${MIN_NODE_MAJOR}（6 个 package.json 均声明 engines.node）。\n` +
            '      升级方式任选：\n' +
            `        · nvm:  nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}（仓库含 .nvmrc）\n` +
            `        · fnm:  fnm install ${MIN_NODE_MAJOR} && fnm use\n` +
            `        · brew: brew install node@${MIN_NODE_MAJOR}\n` +
            '      升级后重跑：npm run doctor',
        }),
  }
}

/**
 * 校验各入口使用的 Node 可执行文件是否一致。
 *
 * 背景：历史上 mcp-server 与 preset 插件硬编码 `/usr/local/bin/node`，而 bridge
 * 用的是 `process.execPath`。在 Apple Silicon 无 Homebrew 的环境该路径不存在，
 * 表现为"桥正常但 MCP 工具全挂"，极难定位。此处把一致性显式化。
 *
 * @param {{ label: string, binPath: string, exists?: boolean }[]} entries
 */
export function checkNodePathConsistency(entries) {
  const list = Array.isArray(entries) ? entries : []
  const missing = list.filter((e) => e && e.exists === false)
  const distinct = [...new Set(list.map((e) => e && e.binPath).filter(Boolean))]
  const ok = missing.length === 0 && distinct.length <= 1
  return {
    id: 'node-path-consistency',
    severity: ok ? SEVERITY.OK : missing.length ? SEVERITY.FAIL : SEVERITY.WARN,
    title: 'Node 可执行文件一致且存在',
    detail: list.map((e) => `${e.label}=${e.binPath}${e.exists === false ? ' (不存在)' : ''}`),
    value: distinct,
    ...(ok
      ? {}
      : {
          hint:
            (missing.length
              ? `以下入口的 node 路径不存在：${missing.map((m) => `${m.label}(${m.binPath})`).join(', ')}\n       `
              : '') +
            (distinct.length > 1
              ? `检测到多个不同 node 路径：${distinct.join(', ')}\n       `
              : '') +
            '修法：统一使用 process.execPath（当前进程的 node），或用 CROSSPOST_NODE 显式覆盖。',
        }),
  }
}

/** 检查 TCP 端口是否空闲（不发起连接，只做 bind 探测） */
export async function checkPortFree(port, host = '127.0.0.1') {
  const net = await import('node:net')
  return await new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', (e) => {
      resolve({ free: false, error: String((e && e.code) || e) })
    })
    srv.once('listening', () => {
      srv.close(() => resolve({ free: true }))
    })
    try {
      srv.listen(port, host)
    } catch (e) {
      resolve({ free: false, error: String((e && e.message) || e) })
    }
  })
}

/**
 * 检查解析后的路径是否落在"引擎本地数据区"内。
 *
 * 目的：防止引擎把运行数据写到仓库外（历史上默认指向某个外部写作项目）。
 * 这不禁止接入方显式配置外部路径——那种情况应通过项目 manifest 声明，
 * 而不是引擎的内置默认。此处只对**默认值**做判定。
 *
 * @param {{ localRoot: string, resolved: Record<string, unknown> }} input
 */
export function checkLocalDataRoot(localRoot, repoRoot) {
  const abs = path.resolve(localRoot)
  const inRepo = repoRoot ? abs.startsWith(path.resolve(repoRoot) + path.sep) : null
  return {
    id: 'local-data-root',
    severity: inRepo === false ? SEVERITY.WARN : SEVERITY.OK,
    title: '引擎本地数据根',
    detail: abs + (inRepo === false ? '（位于仓库之外）' : ''),
    value: abs,
    ...(inRepo === false
      ? {
          hint:
            '引擎默认数据根应在仓库内（<repo>/.local，已 gitignore）。\n' +
            '      若这是有意的（接入方显式指定外部项目目录），可忽略；\n' +
            '      若否，请移除 CROSSPOST_LOCAL_ROOT 或 paths.json 中的相应覆盖。',
        }
      : {}),
  }
}

/**
 * 检查 `.local/` 是否已被 git 忽略。
 * 数据根若不 gitignore，运行数据会被误提交（含平台状态等本地信息）。
 */
export function checkLocalRootIgnored(repoRoot, localRoot) {
  const gitignore = path.join(repoRoot, '.gitignore')
  let ignored = false
  let detail = ''
  try {
    const text = fs.readFileSync(gitignore, 'utf8')
    const rel = path.relative(repoRoot, path.resolve(localRoot))
    const first = rel.split(path.sep)[0]
    ignored = new RegExp(
      `^\\s*(/)?${first.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/?\\s*$`,
      'm',
    ).test(text)
    detail = ignored ? `.gitignore 已包含 ${first}/` : `.gitignore 未包含 ${first}/`
  } catch {
    detail = '.gitignore 不存在或不可读'
  }
  return {
    id: 'local-root-gitignored',
    severity: ignored ? SEVERITY.OK : SEVERITY.WARN,
    title: '本地数据根已 gitignore',
    detail,
    value: ignored,
    ...(ignored ? {} : { hint: '请在 .gitignore 中加入 `.local/`，避免运行数据被提交。' }),
  }
}

/**
 * 在 PATH 中解析可执行文件（含 macOS 常见安装位置兜底）。
 * 返回绝对路径或 null。不 spawn 子进程（`which` 可能不存在）。
 */
export function resolveOnPath(bin) {
  if (!bin) return null
  if (bin.includes(path.sep)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK)
      return bin
    } catch {
      return null
    }
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  // macOS 上 GUI 进程的 PATH 常缺 /usr/local/bin 与 Homebrew 路径，补一份兜底
  for (const extra of [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(os.homedir(), '.local/bin'),
  ]) {
    if (!dirs.includes(extra)) dirs.push(extra)
  }
  for (const d of dirs) {
    const p = path.join(d, bin)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      if (fs.statSync(p).isFile()) return p
    } catch {
      /* 继续找 */
    }
  }
  return null
}

/**
 * 当前进程是不是跑在容器里（Docker 形态）。
 *
 * 为什么需要它：容器形态下"回环"换了意思（`127.0.0.1` 指容器自己），
 * 于是同一个症状在两种形态下的修法完全不同。doctor 拿它把提示写准，
 * 而不是让人对着"端口没有服务在监听"去查一个明明在监听的端口。
 *
 * 判据取 `/.dockerenv`（Docker 会在容器根放这个文件）—— 不追求覆盖所有
 * 容器运行时（podman/k8s 各有特征），够用且零副作用；判不出来就当原生形态。
 */
export function inContainer() {
  try {
    return fs.existsSync('/.dockerenv')
  } catch {
    return false
  }
}

/**
 * 检查可选外部依赖是否可用。
 * title 必须与 severity 一致（此前 title 恒为"可用"，在 warn 时自相矛盾）。
 */
export function checkExecutable(bin, label) {
  const found = resolveOnPath(bin)
  const ok = !!found
  return {
    id: `executable:${bin}`,
    severity: ok ? SEVERITY.OK : SEVERITY.WARN,
    title: `${label}${ok ? ' 可用' : ' 未找到（可选）'}`,
    detail: found || `未在 PATH 中找到 ${bin}`,
    value: found,
    optional: true,
    ...(ok
      ? {}
      : {
          hint:
            `${bin} 为可选依赖，缺失时相关能力自动降级（通知改用 webhook 通道即可）。\n` +
            '      安装后重跑 npm run doctor 复查。',
        }),
  }
}

/** 检查目录是否可写（不存在则视为"可创建"） */
export function checkWritableDir(dir) {
  try {
    if (fs.existsSync(dir)) fs.accessSync(dir, fs.constants.W_OK)
    else {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
    }
    return { ok: true, dir }
  } catch (e) {
    return { ok: false, dir, error: String((e && e.message) || e) }
  }
}

export function defaultRepoRoot(fromModuleUrl) {
  // src/ -> crosspost-runtime/ -> repo/
  return path.resolve(path.dirname(new URL(fromModuleUrl).pathname), '..', '..')
}

export function homeDir() {
  return os.homedir()
}
