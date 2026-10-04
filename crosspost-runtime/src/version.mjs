/**
 * 引擎与契约版本（P1：契约版本化对外暴露）
 *
 * 为什么需要单独暴露版本：
 *   · **接入方**（写作项目、MCP 客户端）需要一个稳定的信号来判断
 *     "我该怎么跟这个引擎说话"，而不是靠猜或靠 try/catch 探路。
 *   · manifest 契约会演进（例如 P2 引入 http 提供者），
 *     接入方必须能在运行时读到当前契约版本，才能优雅降级而不是报错。
 *
 * 两个版本刻意分开：
 *   · `engine`   —— 引擎自身发布版本（**真值是 git tag**，见下）
 *   · `contract` —— **接入契约**版本（仅当 manifest 结构或语义变化时递增）
 * 接入方应依据 `contract` 做兼容判断；`engine` 只用于排障与对账。
 *
 * 引擎版本的真值（v2.108 更正）：
 *   此前 `engine` 直接读 `crosspost-runtime/package.json` 的 version，而那句注释写着
 *   "每个 tag 递增"——**实际没有任何步骤去改它**，于是它长期停在 `0.1.0`，而仓库已经
 *   发到 v2.107。对一个"接入方可依赖、用于对账"的字段来说，这不是小瑕疵：
 *   它永远说 0.1.0，等于没用。
 *   现在真值是 **`git describe --tags --always --dirty`**（去掉前导 `v`），
 *   形如 `2.107`（正好在 tag 上）或 `2.107-3-g5258228`（tag 之后还有 3 个提交）、
 *   带 `-dirty` 表示工作区有未提交改动。package.json 只作为**无 git 环境的回退**
 *   （tarball 部署）。验收会断言二者一致，所以它不会再悄悄漂。
 *
 * 契约版本历史：
 *   1 — manifest v1：id/name/manifestVersion/capabilities/dataDir，
 *       能力白名单 {drafts,topics,calendar,retention,reports,generate}（v1 时的历史值；
 *       `calendar` 已于 2026-09-25 随日历模块删除，这行保留为契约沿革记录），
 *       提供者 v1 仅实现 paths。
 *   2 — manifest v2（2026-09-19，P2）：`capabilities.generate` 可用**对象形态**
 *       `{kind:"http", url, statusUrl?, timeoutMs?, pollIntervalMs?, overallTimeoutMs?,
 *         tokenEnv?, description?}` 声明一个跨进程 HTTP 生成端点；引擎据此调用端点
 *       （同步或异步轮询），并默认只允许环回地址（远程需配置 generate.allowHosts）。
 *       **v1 的布尔形态与所有既有字段语义不变**——只是判据从"进程内有没有注册钩子"
 *       扩成"进程内钩子 / 项目 manifest / 引擎默认配置"三层。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME_ROOT = path.resolve(__dirname, '..')
/** 仓库根：`crosspost-runtime/..`（git describe 的工作目录） */
const REPO_ROOT = path.resolve(RUNTIME_ROOT, '..')

/** 接入契约版本（结构或语义变化时 +1；见文件头历史） */
export const CONTRACT_VERSION = 2

/** 进程内缓存（`versionInfo()` 在 /proxy/status 上被频繁调用；git 只 spawn 一次） */
let cachedEngine = null
let cachedSource = null

/** `git describe --tags --always --dirty`；无 git / 非仓库 / 超时 → ''（回退 package.json） */
function readGitDescribe() {
  try {
    const out = execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      encoding: 'utf8',
    })
    const s = String(out).trim()
    // 去掉前导 `v`，保持"以数字开头"的形态（版本契约测试锁定）
    return s ? s.replace(/^v/, '') : ''
  } catch {
    return ''
  }
}

/** `crosspost-runtime/package.json` 的 version（无 git 环境的回退值） */
function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(RUNTIME_ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : ''
  } catch {
    return ''
  }
}

/**
 * 引擎版本：**git tag 优先**，读不到才用 package.json，两者都没有 → 'unknown'。
 * 读不到不是可用性障碍，所以任何失败都只降级、不抛错。
 */
export function engineVersion() {
  if (cachedEngine !== null) return cachedEngine
  const described = readGitDescribe()
  if (described) {
    cachedEngine = described
    cachedSource = 'git'
  } else {
    const pkg = readPackageVersion()
    cachedEngine = pkg || 'unknown'
    cachedSource = pkg ? 'package.json' : 'unknown'
  }
  return cachedEngine
}

/** 版本取自哪里：`git` / `package.json` / `unknown`（排障与验收报告用） */
export function engineVersionSource() {
  engineVersion()
  return cachedSource
}

/** 供 MCP/HTTP/CLI 嵌入的版本块（结构稳定，接入方可依赖字段名） */
export function versionInfo() {
  return {
    engine: engineVersion(),
    contract: CONTRACT_VERSION,
    node: process.versions.node,
  }
}
