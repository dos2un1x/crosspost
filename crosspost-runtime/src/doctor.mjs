/**
 * 环境自检（doctor）——把"哪里没接好"变成一条命令。
 *
 * 用法：
 *   crosspost doctor            # 结构化结果 + 人类可读输出，有 fail 则退出码 1
 *   crosspost doctor --json     # 仅 JSON（供桥/Console/CI 消费）
 *
 * 与 preflight 的分工：preflight 是**纯函数与单条检查**；doctor 负责**编排**——
 * 采集真实环境（端口、扩展连接、配置解析、依赖存在性），汇总为统一报告。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  SEVERITY,
  checkNodeVersion,
  checkNodePathConsistency,
  checkPortFree,
  checkLocalDataRoot,
  checkLocalRootIgnored,
  checkExecutable,
  checkWritableDir,
  inContainer,
  resolveOnPath,
  MIN_NODE_MAJOR,
} from './preflight.mjs'
import { loadPaths } from './paths.mjs'
import { readConfig } from './config-cache.mjs'
import { registrySummary, resolveProject, resolveProjectStoreDir } from './projects.mjs'
import { resolveResources } from './resources.mjs'
import { currentProject } from './project-context.mjs'
import { projectOverriddenKeys } from './config-layers.mjs'
import {
  dialNote,
  dialUrl,
  isLoopbackUrl,
  probeEndpoint,
  resolveGenerateProvider,
} from './generate.mjs'
import { checkExtensionCompatibility } from './extension-compat.mjs'
import {
  SUBPACKAGES,
  missingDeps,
  missingDepsSummary,
  manualInstallCommands,
  LEGACY_CORE_TREE,
  legacyCoreTreeExists,
  coreBuilt,
  coreDistFreshness,
  CORE_DIST_ENTRIES,
} from './deps.mjs'
import { defaultDomainOrphanIds } from './domain-orphans.mjs'
import { collectSpecs } from './scheduler/index.mjs'
import { legacyDaemons, legacyTasks } from './scheduler/legacy.mjs'
import { budgetState, readAiDetectConfig, resolveDetectCredentials } from './ai-detect.mjs'

// CrossPost · maintained by dos2un1x · https://github.com/dos2un1x/crosspost
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

/**
 * 仓库里那份扩展的版本号（读 `bridge/chrome-proxy-extension/manifest.json`）。
 *
 * 为什么要它：`checkExtensionCompatibility` 只回答"够不够新"（对比 MIN_EXTENSION_VERSION），
 * 回答不了"浏览器里加载的是不是磁盘上这份"。2026-09-29 事故里两处版本号**相同**（都是 0.2.4）、
 * 跑的却是改写前的 `sw.js` —— 用户改了扩展但没重新加载时，只有把"已连接版本"与"仓库版本"
 * 摆在一起才看得出来。读不到返回 null，调用方据此跳过（不把读不到当成不一致）。
 */
function repoExtensionVersion() {
  try {
    const p = path.join(REPO_ROOT, 'bridge', 'chrome-proxy-extension', 'manifest.json')
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

/** 结果汇总：有任一 fail → ok=false */
export function summarize(checks) {
  const fail = checks.filter((c) => c.severity === SEVERITY.FAIL).length
  const warn = checks.filter((c) => c.severity === SEVERITY.WARN).length
  const ok = fail === 0
  return { ok, fail, warn, pass: checks.length - fail - warn, total: checks.length }
}

/** 人类可读输出（带 ✓ / ⚠ / ✖ 与修复提示） */
export function formatReport(report) {
  const icon = { ok: '✔', warn: '⚠', fail: '✖' }
  const lines = []
  lines.push('')
  lines.push(`CrossPost 环境自检（doctor）  Node ${process.versions.node}  ${process.execPath}`)
  lines.push('─'.repeat(64))
  for (const c of report.checks) {
    lines.push(`${icon[c.severity] || '·'} ${c.title}`)
    lines.push(`    ${c.detail}`)
    if (Array.isArray(c.detailExtra)) for (const d of c.detailExtra) lines.push(`    ${d}`)
    if (c.hint && c.severity !== SEVERITY.OK) lines.push(`    ↳ ${c.hint}`)
  }
  lines.push('─'.repeat(64))
  lines.push(
    `  ✔ ${report.summary.pass} 通过   ⚠ ${report.summary.warn} 提醒   ✖ ${report.summary.fail} 失败` +
      (report.summary.total ? `   （共 ${report.summary.total} 项）` : ''),
  )
  const fails = report.checks.filter((c) => c.severity === SEVERITY.FAIL)
  if (fails.length) {
    lines.push('')
    lines.push('存在失败项：按上面的 ↳ 提示修复后重跑 `npm run doctor`。')
  } else {
    lines.push('')
    lines.push('可以正常使用。若平台登录态为空，请先在浏览器登录各平台并确认扩展已连接。')
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 从桥的 /proxy/health 读取运行态。
 *
 * 注意：`/proxy/health` **需要 API token**（桥只对静态页面与 /proxy/bootstrap 免鉴权）。
 * 因此先向 /proxy/bootstrap 取 token 再查询——否则桥明明在运行也会得到 401，
 * 被误判为"未运行"（这是本函数初版的实际缺陷）。
 * 未运行时返回 null，不视为失败。
 */
async function probeBridge(httpPort) {
  const base = `http://127.0.0.1:${httpPort}`
  const withTimeout = async (url, opts = {}) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2500)
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal })
    } finally {
      clearTimeout(t)
    }
  }
  try {
    const boot = await withTimeout(`${base}/proxy/bootstrap`)
    if (!boot.ok) return null
    const { token } = await boot.json()
    const resp = await withTimeout(`${base}/proxy/health`, {
      headers: token ? { 'X-CrossPost-Token': token } : {},
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

/**
 * 查询「一键生成」能力是否已由接入项目提供（v2.42；v2.51 增加来源与端点）。
 *
 * 背景：P0 起 `startTopicGenerate()` 从"spawn 接入方的生成脚本"改成**能力钩子**
 * （`bridge/topics.mjs` 的 `registerGenerateProvider()`），未注册时返回结构化
 * `generate_not_provided`。这让引擎不再内嵌某个接入方——但也意味着**Console
 * 选题中心的「一键生成」按钮默认是坏的**（点下去只得到一个错误码）。
 *
 * doctor 把这件事显式报出来，而不是等使用者点了才发现功能没了。
 *
 * v2.51：P2 让能力可以**按项目 manifest 声明 HTTP 端点**，于是"有没有"之外
 * 还要回答"谁提供、端点在哪、那个端点到底有没有人在听"——声明了端点却没进程
 * 监听，是比"没声明"更糟的一种状态（看起来配好了，点了才失败）。
 */
async function probeGenerateCapability(httpPort) {
  const base = `http://127.0.0.1:${httpPort}`
  const withTimeout = async (url, opts = {}) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2500)
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal })
    } finally {
      clearTimeout(t)
    }
  }
  try {
    const boot = await withTimeout(`${base}/proxy/bootstrap`)
    if (!boot.ok) return null
    const { token } = await boot.json()
    const resp = await withTimeout(`${base}/proxy/topics/generate/status`, {
      headers: token ? { 'X-CrossPost-Token': token } : {},
    })
    if (!resp.ok) return null
    const j = await resp.json()
    return {
      provided: !!j.provided,
      state: j.state || null,
      provider: j.provider || null,
      unavailable: j.unavailable || null,
    }
  } catch {
    return null
  }
}

/**
 * 飞书通道的**真实可用性**（2026-09-25）：不只是"lark-cli 在 PATH 里"，而是
 * "它真的能以一个可用身份发消息"。
 *
 * 判据来自 CLI 自己：`lark-cli auth status --json` 的 `identities.bot.available`
 * （引擎发通知走的是 `im +messages-send --as bot`，所以看的是 bot，不是 user）。
 * 容器形态的反例：二进制在（✔）但应用密钥在宿主钥匙串里、容器取不到 → 发不出。
 *
 * 只读：auth status 不产生消息、不写业务数据；超时/解析失败都不判红（那是"测不出来"，
 * 不是"它坏了"），但会把原文写进 detail 便于排障。
 */
async function checkLarkIdentity() {
  const idle = (detail) => ({
    id: 'notify-lark-identity',
    severity: SEVERITY.OK,
    title: '飞书通道：无需 CLI 身份（通道不是 lark）',
    detail,
  })
  let n = {}
  try {
    n = (readConfig() || {}).notify || {}
  } catch {
    /* 配置读不出来时按"不需要"处理，别在这里再报一次错 */
  }
  const enabled = n.enabled === true
  const channel = n.channel || 'webhook'
  if (!enabled || channel !== 'lark') return idle(`notify.enabled=${enabled} channel=${channel}`)

  const bin = resolveOnPath(n.larkBin || 'lark-cli')
  if (!bin)
    return {
      id: 'notify-lark-identity',
      severity: SEVERITY.WARN,
      title: '飞书通道：lark-cli 不可用（通知发不出去）',
      detail: `channel=lark，但 ${n.larkBin || 'lark-cli'} 既不在 PATH 也不是可执行文件`,
      hint:
        '容器形态：镜像默认已装 linux 版（LARK_CLI_VERSION 留空会跳过安装）；\n' +
        '      本机形态：装 lark-cli，或把 notify.channel 改成 webhook。',
    }

  const r = await new Promise((resolve) => {
    const p = spawn(bin, ['auth', 'status', '--json'], { timeout: 8000 })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => resolve({ ok: false, reason: String(e.message || e) }))
    p.on('close', (code) => resolve({ ok: code === 0, out, err, code }))
  })

  let st = null
  try {
    st = JSON.parse(r.out || '{}')
  } catch {
    /* 非 JSON：按"读不出来"处理 */
  }
  const bot = st && st.identities && st.identities.bot
  if (bot && bot.available === true)
    return {
      id: 'notify-lark-identity',
      severity: SEVERITY.OK,
      title: '飞书通道：身份可用（bot ready）',
      detail: `${bin} · appId=${st.appId || '?'} · bot=${bot.status}`,
    }
  return {
    id: 'notify-lark-identity',
    severity: SEVERITY.WARN,
    title: '飞书通道：lark-cli 在，但身份不可用（通知会失败）',
    detail:
      `channel=lark 且会调 ${bin}，但 auth status 说：` +
      `${(bot && (bot.message || bot.status)) || r.reason || r.err || '读不出来'}`,
    hint:
      '引擎发通知用的是 **bot 身份**（`im +messages-send --as bot`），所以需要**应用凭据**，\n' +
      '      不是用户登录：`lark-cli config init --app-id <id> --app-secret-stdin`。\n' +
      '      容器形态注意：宿主 macOS 钥匙串里的密钥容器读不到，要么在容器里配一次，\n' +
      '      要么把 notify.channel 改成 webhook（纯 HTTP，无 CLI 依赖）。',
  }
}
/**
 * 生成端点"连不上"时的提示：原生形态与**容器形态**的修法不同，必须分开说。
 *
 * 2026-09-25 实测：宿主 8787 明明有服务在听，容器里 `127.0.0.1:8787` 却是
 * ECONNREFUSED（容器里的回环指容器自己），而同一时刻 `host.docker.internal:8787` 是通的。
 * 旧提示只说"启动生成服务/修正 url"，会让人去查一个根本没毛病的端口。
 */
function deadGenerateHint(provider) {
  const loop = !!(provider && provider.url && isLoopbackUrl(provider.url))
  if (loop && provider.gateway)
    return (
      `已按宿主网关重写拨号：${provider.url} → ${dialUrl(provider)}，仍然连不上。\n` +
      '      先确认宿主上那个端口真的有服务在听，再确认容器能到宿主\n' +
      '      （compose 的 extra_hosts host-gateway 是否生效）。'
    )
  if (loop && inContainer() && !process.env.CROSSPOST_HOST_GATEWAY)
    return (
      `当前进程在**容器**里，而 manifest 声明的端点是回环地址（${provider.url}）：\n` +
      '      容器里的 127.0.0.1 指向容器自己，不是宿主 —— 宿主那个端口可能明明有服务在听。\n' +
      '      两条修法（二选一）：\n' +
      '        ① 给容器设 CROSSPOST_HOST_GATEWAY=host.docker.internal（compose 默认已带上；\n' +
      '           引擎会把项目声明的回环主机名重写成它，manifest 不用改）；\n' +
      '        ② 把 manifest 的 url 改成 host.docker.internal:<端口> ——\n' +
      '           注意这会让**原生形态**（非容器）连不上，因为它解析不了这个名字。\n' +
      '      参考实现：examples/generate-provider-http/。'
    )
  return (
    '项目 manifest 声明了生成端点，但该端口没有服务在监听。\n' +
    '      启动项目侧的生成服务（参考实现：examples/generate-provider-http/），\n' +
    '      或修正 manifest 里的 url。'
  )
}

/**
 * 执行全部检查。
 * @param {{ wsPort?: number, httpPort?: number }} [opts]
 */
export async function runDoctor(opts = {}) {
  const wsPort = Number(opts.wsPort) || Number(process.env.SYNC_PROXY_WS_PORT) || 9539
  const httpPort = Number(opts.httpPort) || wsPort + 1
  const checks = []

  // ── 1. Node 版本（硬门禁） ──
  checks.push(checkNodeVersion())

  // ── 2. Node 路径一致性 ──
  checks.push(
    checkNodePathConsistency([
      {
        label: '当前进程',
        binPath: process.execPath,
        exists: fs.existsSync(process.execPath),
      },
    ]),
  )

  // ── 3. 本地数据根 ──
  let paths = {}
  try {
    paths = loadPaths()
    checks.push(checkLocalDataRoot(paths.localRoot, REPO_ROOT))
    checks.push(checkLocalRootIgnored(REPO_ROOT, paths.localRoot))
  } catch (e) {
    checks.push({
      id: 'paths',
      severity: SEVERITY.FAIL,
      title: '路径配置可解析',
      detail: String((e && e.message) || e),
      hint: '检查 crosspost-runtime/paths.json 是否为合法 JSON；或删除该文件让引擎使用默认值。',
    })
  }

  // ── 4. 配置可解析 ──
  try {
    const cfg = readConfig()
    const hasPlatforms = Array.isArray(cfg.platforms && cfg.platforms.default)
    checks.push({
      id: 'config',
      severity: SEVERITY.OK,
      title: 'config.json 可解析',
      detail: hasPlatforms
        ? `platforms.default = ${cfg.platforms.default.length} 个平台`
        : '未配置 platforms.default，将使用引擎默认',
    })
  } catch (e) {
    checks.push({
      id: 'config',
      severity: SEVERITY.FAIL,
      title: 'config.json 可解析',
      detail: String((e && e.message) || e),
      hint: 'config.json 不是合法 JSON。可从仓库根的 config.example.json 重新生成。',
    })
  }

  // ── 5. 关键目录可写 ──
  for (const [key, label] of [
    ['draftsDir', '草稿目录'],
    ['logsDir', '日志目录'],
    ['historyDir', '历史目录'],
  ]) {
    const dir = paths[key]
    if (!dir) continue
    const r = checkWritableDir(dir)
    checks.push({
      id: `writable:${key}`,
      severity: r.ok ? SEVERITY.OK : SEVERITY.FAIL,
      title: `${label}可写`,
      detail: dir + (r.ok ? '' : `（${r.error}）`),
      ...(r.ok ? {} : { hint: '检查目录权限，或通过 CROSSPOST_* 环境变量指向可写位置。' }),
    })
  }

  // ── 6. 端口 / 桥运行态 ──
  const health = await probeBridge(httpPort)
  if (health) {
    checks.push({
      id: 'bridge-running',
      severity: SEVERITY.OK,
      title: `桥正在运行（HTTP ${httpPort}）`,
      detail: `uptime=${Math.round((health.uptimeMs || 0) / 1000)}s  tokenConfigured=${!!health.tokenConfigured}`,
      detailExtra: health.client
        ? [
            `代理来源: ${health.client.ua ? health.client.ua.slice(0, 72) : '(未知 UA)'}  扩展版本=${health.client.version || '?'}`,
          ]
        : ['代理来源: 尚无扩展连接'],
    })
    if (!health.proxyWs) {
      checks.push({
        id: 'extension-connected',
        severity: SEVERITY.WARN,
        title: '浏览器扩展未连接',
        detail: '桥在运行，但没有扩展接入（proxyWs=false）',
        hint:
          '1) Chrome 打开 chrome://extensions → 开启"开发者模式" → "加载已解压的扩展程序" → 选 bridge/chrome-proxy-extension\n' +
          '      2) 确认扩展选项页的端口与桥一致（当前 ' +
          wsPort +
          '）\n' +
          '      3) 确认你在**同一个**浏览器里登录了各平台账号',
      })
    } else {
      checks.push({
        id: 'extension-connected',
        severity: SEVERITY.OK,
        title: '浏览器扩展已连接',
        detail: `客户端 ${health.client && health.client.clientId ? health.client.clientId : '?'}`,
      })
      // P1：扩展版本兼容性（告警不拒绝，但必须可见）
      const compat = checkExtensionCompatibility(health.client && health.client.version)
      // 2026-09-29 增补：再比一层「已连接 vs 仓库文件」。兼容性判据（MIN 0.2.1）问不出
      // "改了 sw.js 但没重新加载"——事故当天两处都是 0.2.4，浏览器里跑的还是旧代码。
      const repoVer = repoExtensionVersion()
      const loaded = compat.extVersion || ''
      const sameAsRepo = !repoVer || repoVer === loaded
      const ok = compat.compatible && sameAsRepo
      checks.push({
        id: 'extension-version',
        severity: ok ? SEVERITY.OK : SEVERITY.WARN,
        title: !compat.compatible
          ? `扩展版本不兼容：${compat.status}`
          : sameAsRepo
            ? `扩展版本兼容（${loaded || '未知'}）`
            : `扩展已连接但不是仓库里那一版（已连接 ${loaded || '未知'} · 仓库 ${repoVer}）`,
        detail: sameAsRepo
          ? compat.message
          : `${compat.message}；浏览器里加载的扩展是 ${loaded || '未知'}，` +
            `仓库 bridge/chrome-proxy-extension/manifest.json 是 ${repoVer}`,
        ...(ok
          ? {}
          : {
              hint: sameAsRepo
                ? compat.action
                : '在 chrome://extensions 里对 CrossPost Bridge 点「重新加载」——扩展脚本只在加载时读一次磁盘，' +
                  '改了代码不重新加载就等于没改。',
            }),
      })
    }
    checks.push({
      id: 'api-token',
      severity: health.tokenConfigured ? SEVERITY.OK : SEVERITY.FAIL,
      title: '本地 API token 已配置',
      detail: health.tokenConfigured ? '已配置（bridge/token.local）' : '未配置',
      ...(health.tokenConfigured
        ? {}
        : { hint: '删除 bridge/token.local 后重启桥，会自动重新生成。' }),
    })
  } else {
    const ws = await checkPortFree(wsPort)
    const http = await checkPortFree(httpPort)
    checks.push({
      id: 'bridge-running',
      severity: SEVERITY.WARN,
      title: `桥未运行（HTTP ${httpPort} 无响应）`,
      detail: `端口 ${wsPort}(WS) ${ws.free ? '空闲' : '被占用'} / ${httpPort}(HTTP) ${http.free ? '空闲' : '被占用'}`,
      hint:
        '启动方式任选：\n' +
        '        · 前台: node bridge/run-bridge.mjs\n' +
        '        · 守护(macOS): bridge/install-launchd.sh install\n' +
        '      若端口被占用，用 lsof -nP -iTCP:' +
        wsPort +
        ' -sTCP:LISTEN 查看占用进程。',
    })
  }

  // ── 6b. 项目注册表（P1 接入契约）──
  // 未接入项目不是错误：引擎的平台域功能不依赖任何项目（这是引擎自治的验收标准）。
  //
  // 2026-09-19（v2.24）：`dataDir` 不可达此前只在 detail 里标一个 ⚠，severity 仍是 OK
  // ——即"项目明明接不进来"却报告为通过。这不合理：接入后内容域按项目解析，
  // 数据源不可达的现象是"视图空白"而不是报错，恰恰最需要 doctor 说清楚。
  try {
    const reg = registrySummary()
    const unreachable = reg.projects.filter(
      (p) => p.valid && p.provider && p.provider.reachable === false,
    )
    checks.push({
      id: 'projects',
      severity: reg.invalid > 0 || unreachable.length > 0 ? SEVERITY.WARN : SEVERITY.OK,
      title: reg.count ? `已接入 ${reg.valid} 个写作项目` : '未接入写作项目（不影响平台域功能）',
      detail: reg.count
        ? reg.projects
            .map(
              (p) =>
                `${p.id || '(无法解析)'}${p.valid ? '' : ' ✖无效'}${p.provider && p.provider.reachable === false ? ' ⚠数据源不可达' : ''}`,
            )
            .join(', ')
        : `扫描根：${reg.roots.join(', ')}`,
      detailExtra: reg.count
        ? []
        : ['把 .crosspost/project.json 放进任一扫描根的子目录即可接入（见 docs/integration.md）'],
      ...(reg.invalid > 0 || unreachable.length > 0
        ? {
            hint:
              (unreachable.length > 0
                ? `数据源不可达：${unreachable
                    .map((p) => `${p.id} → ${p.provider.reason}`)
                    .join('；')}\n` +
                  '      该项目的草稿目录当前不存在，Console 选中它后内容视图会为空。\n'
                : '') +
              (reg.invalid > 0
                ? '有项目的 manifest 无效，Console 项目切换器会标出原因。\n' +
                  `      常见原因：缺少 dataDir、未知能力名、manifestVersion 高于引擎（当前 ${reg.manifestVersion}）。`
                : ''),
          }
        : {}),
    })
  } catch (e) {
    checks.push({
      id: 'projects',
      severity: SEVERITY.WARN,
      title: '项目注册表不可读',
      detail: String((e && e.message) || e),
    })
  }

  // ── 6c. 「一键生成」能力（Console 选题中心）──
  //
  // P0 起该能力改由接入项目**注册钩子**提供（引擎不再代跑接入方脚本）。
  // 未注册时按钮会返回 `generate_not_provided`——功能是"没有"，不是"坏了"，
  // 但使用者点下去只会看到一个错误码，所以必须在这里说清楚。
  {
    // v2.54：能力现在可以**按项目**声明，所以"默认上下文有没有"只回答了一半。
    // 必须先看注册表里哪些项目声明了 generate —— 否则会给出一个刺眼的假阴性：
    // 真实项目已经能用，doctor 却说"不可用"（只因为它自己没带项目上下文）。
    const declaring = []
    try {
      for (const p of registrySummary().projects) {
        const decl = (p.capabilities || {}).generate
        if (!p.valid || decl === undefined || decl === false || decl === true) continue
        const r = resolveGenerateProvider(p.id)
        declaring.push({
          projectId: p.id,
          provider: r.provided ? r : null,
          reason: r.reason || null,
        })
      }
    } catch {
      /* 注册表不可读时退回默认上下文检查 */
    }

    if (declaring.length > 0) {
      const results = []
      for (const d of declaring) {
        if (!d.provider) {
          results.push({ ...d, reachable: false, why: d.reason || '声明被拒绝' })
          continue
        }
        const probe = await probeEndpoint(d.provider)
        results.push({
          ...d,
          reachable: probe.reachable,
          why: probe.reachable
            ? `已连接 ${probe.host}:${probe.port}`
            : `连接失败（${probe.reason}）`,
        })
      }
      const dead = results.filter((r) => !r.reachable)
      const okOnes = results.filter((r) => r.reachable)
      checks.push({
        id: 'generate-capability',
        severity: dead.length === 0 ? SEVERITY.OK : SEVERITY.WARN,
        title:
          dead.length === 0
            ? `「一键生成」可用（${okOnes.length} 个项目提供，端点均已监听）`
            : `「一键生成」有 ${dead.length} 个项目的生成端点连不上`,
        detail: results
          .map(
            (r) =>
              `${r.projectId}: ${r.provider ? r.provider.url : '（声明无效）'}` +
              `${r.provider ? dialNote(r.provider) : ''} · ${r.why}`,
          )
          .join('\n      '),
        hint:
          dead.length === 0
            ? '在 Console 顶栏选中对应项目后，选题中心的「一键生成」按钮即可用' +
              '（未选中项目时按钮仍是禁用状态——那是正确行为）。\n' +
              '      注意：**定时链路不经过这条能力**，它只影响 Console 的手动生成。'
            : deadGenerateHint(dead[0].provider),
      })
    } else {
      const gen = await probeGenerateCapability(httpPort)
      if (!gen) {
        checks.push({
          id: 'generate-capability',
          severity: SEVERITY.OK,
          title: '「一键生成」能力：桥未运行（无法探测，跳过）',
          detail: `GET http://127.0.0.1:${httpPort}/proxy/topics/generate/status 不可达`,
        })
      } else if (gen.provided && gen.provider && gen.provider.url) {
        // 声明了 HTTP 端点：只做 TCP 连接探测（不发 HTTP，避免"探活"变成真实生成）
        const probe = await probeEndpoint(gen.provider)
        checks.push({
          id: 'generate-capability',
          severity: probe.reachable ? SEVERITY.OK : SEVERITY.WARN,
          title: probe.reachable
            ? '「一键生成」能力可用（跨进程 HTTP 提供者，端点已监听）'
            : '「一键生成」声明了端点，但没有进程在监听',
          detail:
            `来源：${gen.provider.source || gen.provider.kind} · 端点 ${gen.provider.url}${dialNote(gen.provider)} · ` +
            `TCP ${probe.reachable ? `已连接 ${probe.host}:${probe.port}` : `连接失败（${probe.reason}）`} · ` +
            `当前任务态：${gen.state || 'idle'}`,
          hint: probe.reachable ? undefined : deadGenerateHint(gen.provider),
        })
      } else if (gen.provided) {
        checks.push({
          id: 'generate-capability',
          severity: SEVERITY.OK,
          title: '「一键生成」能力已由接入项目提供',
          detail: `来源：${(gen.provider && gen.provider.source) || '引擎进程内注册的 provider'} · 当前任务态：${gen.state || 'idle'}`,
        })
      } else {
        checks.push({
          id: 'generate-capability',
          severity: SEVERITY.WARN,
          title: '「一键生成」不可用（当前接入项目未提供 generate 能力）',
          detail:
            `Console 选题中心的「一键生成」按钮会返回 generate_not_provided` +
            (gen.unavailable && gen.unavailable.reason ? ` · 原因：${gen.unavailable.reason}` : ''),
          hint:
            '这是 P0 的设计取舍：引擎**不再内嵌/代跑**某一个接入方的生成脚本。\n' +
            '      未提供时该按钮只是不可用，不影响定时链路与发布。要让按钮复活，二选一：\n' +
            '      ① 项目 manifest 声明 HTTP 端点（推荐，可跨进程/跨仓库）：\n' +
            '         "capabilities": { "generate": { "kind": "http", "url": "http://127.0.0.1:<port>/generate" } }\n' +
            '      ② 同进程内嵌时用 registerGenerateProvider() 注册钩子。\n' +
            '      详见 docs/integration.md。',
        })
      }
    }
  }

  // ── 6d. 通知配置自洽（v2.47）──
  //
  // 「谁告诉你流水线跑了」全靠通知。配错**不会让发布失败**，只会悄悄没有通知——
  // 失败信息只写在文章记录的 `notify.status` 里，得点开详情才看得到。
  // 定时链路无人值守，尤其不能在跑完之后才发现"结果送不出来"。
  // doctor 在跑之前就把配置矛盾指出来（只读，不发任何消息）。
  {
    const cfg = readConfig()
    const n = cfg.notify || {}
    const enabled = n.enabled === true
    const channel = n.channel || 'webhook'
    const problems = []
    if (enabled && channel === 'off')
      problems.push('enabled=true 却把 channel 设为 off（自相矛盾）')
    if (enabled && channel === 'lark' && !n.larkChatId)
      problems.push('channel=lark 但未配置 larkChatId')
    if (enabled && channel === 'webhook' && !n.webhookUrl)
      problems.push('channel=webhook 但未配置 webhookUrl')
    checks.push({
      id: 'notify-config',
      severity: enabled && problems.length > 0 ? SEVERITY.WARN : SEVERITY.OK,
      title: !enabled
        ? '通知未启用（流水线跑完不会推送结果）'
        : problems.length
          ? '通知配置不完整（会出现"发布成功但没有通知"）'
          : `通知已配置（${channel}）`,
      detail: !enabled
        ? 'config.json → notify.enabled=false'
        : problems.length
          ? problems.join('；')
          : channel === 'lark'
            ? `${n.larkBin || 'lark-cli'} → ${String(n.larkChatId).slice(0, 14)}…`
            : String(n.webhookType || 'raw'),
      ...(problems.length
        ? {
            hint:
              '修法：在 Console 设置页或 config.json 的 notify 段补齐；' +
              '确实不需要通知就把 enabled 设为 false（而不是留一个矛盾的配置）。',
          }
        : {}),
    })
  }

  // ── 6e. AI 检测（朱雀）就位状态（2026-10-05）──
  //
  // 为什么单列：检测的失败一律是"放行 + 显式标注"（`skip`），所以**凭证缺失、额度用尽
  // 都不会让任何一篇稿子变红**——流水线照常出稿，这一关却形同虚设。接入方明确把
  // "连续 skip/no-api-key"当故障，doctor 就该在跑之前把它指出来。
  // 只读：不调接口、不扣额度（`budgetState` 只读台账文件）。
  {
    const cfg = readAiDetectConfig()
    if (cfg.enabled === false) {
      checks.push({
        id: 'ai-detect',
        severity: SEVERITY.OK,
        title: 'AI 检测未启用（aiDetect.enabled=false）',
        detail: '流水线不会做朱雀检测，也不会消耗额度',
      })
    } else {
      const cred = resolveDetectCredentials()
      // 预算按池算（每把 key 一份额度）：不传 key 列表会只显示一份额度，自检就失去意义
      const b = budgetState(cfg, new Date(), cred.apiKeys)
      const mode = (cfg.gate && cfg.gate.mode) || 'bands'
      const enforce = (cfg.gate && cfg.gate.enforce) || 'observe'
      const slots =
        Array.isArray(cfg.slots) && cfg.slots.length ? cfg.slots.join(' / ') : '全部栏目'
      const rate = Number(cfg.sampleRate)
      const extras = [
        `抽样 ${!Number.isFinite(rate) || rate >= 1 ? '全检' : `1/${Math.max(1, Math.round(1 / rate))}`}`,
        `风格护栏 ${cfg.styleGuard && cfg.styleGuard.enabled ? '开' : '关'}`,
      ].join(' · ')
      const periods = `${b.periodStart} 起（锚点 ${b.periodAnchorDay} 日）`
      const problems = []
      if (!cred.apiKeys.length) {
        problems.push(
          '缺凭证：`crosspost-runtime/.env` 里没有 `ZHUQUE_API_KEY`（追加额度用 `ZHUQUE_API_KEYS`）',
        )
      }
      // 某把 key 被标记失效：不是全网故障，但会让池子悄悄缩水，必须显式说出来
      const dead = (b.keys || []).filter((k) => k.exhausted)
      if (dead.length) {
        problems.push(
          `${dead.length}/${b.keyCount} 把 key 本周期已标记失效（${dead
            .map((k) => `${k.id}${k.exhaustedAt ? `@${String(k.exhaustedAt).slice(0, 16)}` : ''}`)
            .join('、')}），检测自动改用其余 key；误判限流可跑 \`aiDetect --clear-exhausted\``,
        )
      }
      if (b.exhausted) {
        problems.push(`本周期额度已用尽（${b.tokens}/${b.budget}，会返回 skip/budget-exhausted）`)
      }
      const keyLine = cred.apiKeys.length
        ? `${cred.apiKeys.length} 把 key（${(b.keys || []).map((k) => k.id).join('、')}）`
        : '缺失'
      // 旧台账（单 key 时代）的遗留用量会挂在第一把 key 上：不说明的话，
      // 看到"第一把凭空多了十几万 token"会以为是漏账（`aiDetect --budget` 的 legacyTokens 同源）
      const legacy = (b.keys || []).reduce((n, k) => n + (k.legacyTokens || 0), 0)
      checks.push({
        id: 'ai-detect',
        severity: problems.length ? SEVERITY.WARN : SEVERITY.OK,
        title: !cred.apiKeys.length
          ? 'AI 检测已启用但没有凭证（每篇都会 skip/no-api-key）'
          : b.exhausted
            ? 'AI 检测本周期额度已用尽（检测会跳过）'
            : `AI 检测就位（${mode} · ${enforce} · 覆盖 ${slots}）`,
        detail:
          `本周期 ${periods}：${b.tokens}/${b.budget} token（每把 key ${b.perKeyBudget} × ${b.keyCount}），` +
          `${b.calls} 次调用；凭证${cred.apiKeys.length ? '已配置' : '缺失'} ${keyLine}（env 或 .env）` +
          `${legacy > 0 ? `；其中 ${legacy} token 是旧台账遗留用量（无 key 归属，记在第一把头上）` : ''}；${extras}`,
        ...(problems.length
          ? {
              hint:
                `修法：${problems.join('；')}。` +
                '额度口径以 EdgeOne 控制台「模型用量」为准；台账只统计经引擎发起的调用。',
            }
          : {}),
      })
    }
  }

  // ── 7. 可选外部依赖（缺失只告警，相关能力自动降级） ──
  checks.push(checkExecutable('lark-cli', '飞书 CLI'))
  checks.push(checkExecutable('unzstd', 'unzstd（费用报表解压）'))

  // ── 7b. 飞书通道"真的能发吗"（2026-09-25）──
  //
  // 为什么单列：`checkExecutable` 只看**文件在不在**。容器形态实测踩到过反例——
  // 镜像里 linux 版 lark-cli 装好了、PATH 也找得到（体检 ✔），但 `auth status` 说
  // `bot: not_configured`（应用密钥只存在宿主 macOS 钥匙串里，容器取不到），
  // 于是通知**发不出去**而体检一片绿。这正是本项目最在意的"检查与使用不是同一判据"。
  //
  // 只读、不发消息（auth status 不产生任何副作用）；channel≠lark 时直接跳过，
  // 不给 webhook 用户制造噪音。
  checks.push(await checkLarkIdentity())

  // ── 8. 引擎运行所需的关键文件 ──
  const presetPlugin = path.join(REPO_ROOT, 'preset/crosspost/plugins/crosspost.js')
  const mcpServer = path.join(REPO_ROOT, 'crosspost-runtime/mcp-server/index.mjs')

  // 子包依赖（v2.104）——**这条检查以前不存在，而缺陷真实存在**
  //
  // 根 `package.json` 没有 workspaces：`npm install` 只装根 devDeps，真实依赖在两个子包
  // （`crosspost-runtime` 的 jsdom/ws + core 的构建依赖 tsup、`bridge` 的 ws），
  // 且 `**/node_modules` 全在 .gitignore 里。于是干净 clone 上"照 README 装完"仍会
  // 在 core 构建与桥启动处失败 —— 而旧 doctor 会一路 ✔。
  // 为什么放在 core-dist 之前：它正是"core 构建失败"的上游原因，先看它再看结果。
  //
  // v2.3.1：core 不再单独装（它的整棵图由 runtime 树承载，见 deps.mjs 文件头），
  // 所以下面的冗余树检查只在本机还留着旧树时出现 —— 干净环境不多一条噪音。
  const missingPkgs = missingDeps(REPO_ROOT)
  checks.push({
    id: 'deps-installed',
    severity: missingPkgs.length ? SEVERITY.FAIL : SEVERITY.OK,
    title: missingPkgs.length
      ? `子包依赖缺失（${missingPkgs.map((m) => m.id).join('、')}）`
      : `子包依赖已就绪（${SUBPACKAGES.length} 个子包）`,
    detail: missingPkgs.length
      ? missingDepsSummary(missingPkgs)
      : SUBPACKAGES.map((p) => p.dir).join(' · '),
    ...(missingPkgs.length
      ? { hint: `运行 npm run setup（或手工：${manualInstallCommands().join('；')}）。` }
      : {}),
  })
  // 冗余依赖树（v2.3.1）：老机器上还留着 ≤ v2.3 单独装的 core 树 —— 纯重复，
  // 删掉即回收约 200MB。只提醒不判失败：它不影响任何功能。
  // 判据是 `legacyCoreTreeExists`（看"装过依赖"而不是"目录在"）：vitest 会在那个路径下
  // 建 `.vite` 缓存目录，只看目录会有假提醒。
  if (legacyCoreTreeExists(REPO_ROOT)) {
    checks.push({
      id: 'deps-redundant-core-tree',
      severity: SEVERITY.WARN,
      title: '存在 v2.3 遗留的 core 依赖树（可删，回收约 200MB）',
      detail: path.join(REPO_ROOT, LEGACY_CORE_TREE),
      hint: `v2.3.1 起 core 的依赖由 crosspost-runtime 那棵树承载，删掉它不影响构建与运行：rm -rf ${LEGACY_CORE_TREE}`,
    })
  }
  // 判据是**产物**而不是目录（2026-09-25，Docker 实测）：Docker 模式下 core/dist 是容器私有卷，
  // 首次挂载是个空目录——旧判据会让 doctor 说"core 已构建"而引擎其实 import 就炸。
  {
    const built = coreBuilt(REPO_ROOT)
    checks.push({
      id: 'core-dist',
      severity: built ? SEVERITY.OK : SEVERITY.FAIL,
      title: built ? 'core 已构建（四个入口产物齐全）' : 'core 未构建（入口产物缺失）',
      detail: path.join(REPO_ROOT, 'crosspost-runtime/core/dist'),
      ...(built
        ? {}
        : {
            hint:
              `运行 npm run setup，或手动执行 npm -C crosspost-runtime/core run build。` +
              `缺的判据：${CORE_DIST_ENTRIES.join('、')}`,
          }),
    })

    // 2026-09-29 增补：**产物比源码旧**也要报出来（WARN，不判负：源码改了还没构建是常见中间态）。
    // 事故当天 Docker 里 core/dist 是私有卷、停在 4 天前，`docker compose restart` 只重启进程、
    // 不重建产物 → 引擎跑的是改写前的适配器，报出来的错误文案与仓库代码对不上，排查被带去查 WAF。
    const fresh = built ? coreDistFreshness(REPO_ROOT) : null
    if (fresh && fresh.stale) {
      const behind = Math.round(fresh.behindMs / 60000)
      checks.push({
        id: 'core-dist-fresh',
        severity: SEVERITY.WARN,
        title: `core 产物比源码旧（落后约 ${behind >= 60 ? Math.round(behind / 60) + ' 小时' : behind + ' 分钟'}）`,
        detail:
          `dist/index.mjs ${new Date(fresh.distMs).toISOString()} · ` +
          `core/src 最新 .ts ${new Date(fresh.srcMs).toISOString()}`,
        hint:
          `原生：npm -C crosspost-runtime/core run build；` +
          `Docker：core/dist 是容器私有卷，restart **不会**重建它 —— ` +
          `docker compose exec crosspost npm -C crosspost-runtime/core run build，` +
          `或 docker compose down -v && docker compose up -d。`,
      })
    }
  }
  checks.push({
    id: 'extension-dir',
    severity: fs.existsSync(path.join(REPO_ROOT, 'bridge/chrome-proxy-extension/manifest.json'))
      ? SEVERITY.OK
      : SEVERITY.FAIL,
    title: '浏览器扩展目录存在',
    detail: path.join(REPO_ROOT, 'bridge/chrome-proxy-extension'),
    ...(fs.existsSync(path.join(REPO_ROOT, 'bridge/chrome-proxy-extension/manifest.json'))
      ? {}
      : { hint: '仓库不完整，请重新 clone / 拉取。' }),
  })
  // 默认域残留（v2.106）
  //
  // 为什么要有这条：v2.106 之前，"簿记写进哪个域"只看**请求上下文**，从不看草稿本身属于谁。
  // 一个没有项目上下文的会话（GUI 的 web 预设没有 `CROSSPOST_PROJECT`）用绝对路径发布了
  // 项目草稿，记录就落在默认域 —— 默认域显示"已发布"、项目域显示"草稿"，
  // Console 的默认视图还多了 3 行不属于它的文章（2026-09-22 21:45–21:53 的真实事故）。
  // 写入侧已修；这条检查保证**同一类脏数据下次能被看见**（提醒而非失败：它是数据状态）。
  const orphanIds = defaultDomainOrphanIds()
  checks.push({
    id: 'default-domain-orphans',
    severity: orphanIds.length ? SEVERITY.WARN : SEVERITY.OK,
    title: orphanIds.length
      ? `默认域残留 ${orphanIds.length} 条属于项目的记录`
      : '默认域没有属于项目的残留记录',
    detail: orphanIds.length
      ? orphanIds.slice(0, 5).join('、') +
        (orphanIds.length > 5 ? ` 等 ${orphanIds.length} 条` : '')
      : '默认域 = 空（v2.74 的设计：默认 ≠ 项目）',
    ...(orphanIds.length
      ? {
          hint:
            'npm run repair:domain-orphans（先看不带 --apply 的计划）把它们并回所属项目簿记。' +
            '原因与合并语义见 src/domain-orphans.mjs。',
        }
      : {}),
  })
  // DSH preset 接入（2026-10-03 重写：0.2.0 换载体后"文件在"不再等于"能力可用"）
  //
  // 为什么升级这条：0.2.0-rc.2 起预设的载体是 **bundle patch 里的一条
  // `@deepseek-ai/dsh-agent-preset` 声明行**，bundle 经 profile 的 `dsh.profile.bundles` 装载；
  // 旧的目录式 `~/.dsh/.agent-presets/<id>/`（`preset.yml` + `agent.cordis.yml`）
  // **不再被任何代码读取**。于是旧判据"plugins/crosspost.js 文件在不在"变成一条恒 ✔ 的假绿：
  // 文件一直在仓库里，而 DSH 会话里那 7 个 `xp_*` 工具可能整块消失，且 DSH 不报任何错。
  //
  // 现在分两问：① 仓库侧 bundle 三件套齐不齐（package.json 的 dsh.bundle.patch、
  // 该 patch 文件、声明行 + 本地插件）；② **本机 DSH 有没有把它装进某个 profile**。
  // ② 只在装了 DSH（存在 profiles 目录）时才有意义，免得没装 DSH 的机器被误报。
  const presetDir = path.join(REPO_ROOT, 'preset/crosspost')
  const presetManifest = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(presetDir, 'package.json'), 'utf8'))
    } catch {
      return null
    }
  })()
  const bundlePatchRel = presetManifest?.dsh?.bundle?.patch
  const presetPatchPath = bundlePatchRel ? path.join(presetDir, bundlePatchRel) : ''
  // 声明行里的**每个本地插件**（`<包名>/plugins/<文件>.js`）都要在仓库里存在——
  // 逐条列举而不是只看 crosspost.js：漏挂一个插件（或改了文件名）同样会静默少能力。
  const declaredPlugins = (() => {
    try {
      return [...fs.readFileSync(presetPatchPath, 'utf8').matchAll(/name:\s*'([^']*\.js)'/g)]
        .map((m) => m[1])
        .filter((spec) => !spec.startsWith('.'))
        .map((spec) => spec.split('/').slice(1).join('/'))
    } catch {
      return []
    }
  })()
  const missingPlugins = declaredPlugins.filter((rel) => !fs.existsSync(path.join(presetDir, rel)))
  const presetBundleOk =
    Boolean(bundlePatchRel) &&
    fs.existsSync(presetPatchPath) &&
    fs.existsSync(presetPlugin) &&
    declaredPlugins.length > 0 &&
    missingPlugins.length === 0 &&
    (() => {
      try {
        return /name:\s*'@deepseek-ai\/dsh-agent-preset'/.test(
          fs.readFileSync(presetPatchPath, 'utf8'),
        )
      } catch {
        return false
      }
    })()
  checks.push({
    id: 'preset-bundle',
    severity: presetBundleOk ? SEVERITY.OK : SEVERITY.WARN,
    title: presetBundleOk
      ? `DSH preset bundle 齐备（声明行 + ${declaredPlugins.length} 个本地插件）`
      : 'DSH preset bundle 不完整',
    detail: presetBundleOk
      ? `${presetPatchPath} · ${declaredPlugins.map((rel) => path.join(presetDir, rel)).join(' · ')}`
      : `${presetDir}（dsh.bundle.patch=${bundlePatchRel ?? '缺失'}${
          missingPlugins.length ? `；缺文件 ${missingPlugins.join(', ')}` : ''
        }）`,
    ...(presetBundleOk
      ? {}
      : {
          hint:
            'bundle 三件套 = package.json 的 dsh.bundle.patch + 该 patch 文件 + 里面的 ' +
            '@deepseek-ai/dsh-agent-preset 声明行（本地插件挂在它的 config.plugins 里）。' +
            '缺任一样，DSH 会话内工具面不可用。可跑 preset/upgrade-check.sh 看逐条结论。',
        }),
  })

  const dshHome = process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh')
  const profilesDir = path.join(dshHome, 'profiles')
  if (fs.existsSync(profilesDir)) {
    const bundleName = presetManifest?.name || 'preset-crosspost'
    const candidates = []
    try {
      for (const p of fs.readdirSync(profilesDir)) {
        const cand = path.join(profilesDir, p, 'node_modules', bundleName)
        if (fs.existsSync(cand)) candidates.push(cand)
      }
    } catch {
      /* 读不出来就当没装 */
    }
    const shared = path.join(profilesDir, 'node_modules', bundleName)
    if (fs.existsSync(shared)) candidates.push(shared)
    const legacy = path.join(dshHome, '.agent-presets', 'crosspost')

    if (candidates.length) {
      const linked = candidates.filter((c) => fs.lstatSync(c).isSymbolicLink())
      const toRepo = linked.filter((c) => {
        try {
          return fs.realpathSync(c) === fs.realpathSync(presetDir)
        } catch {
          return false
        }
      })
      checks.push({
        id: 'preset-installed',
        severity: toRepo.length ? SEVERITY.OK : SEVERITY.WARN,
        title: toRepo.length
          ? `DSH preset 已安装且软链指向本仓库（改代码免重装）`
          : `DSH preset 已安装（副本安装：改仓库后需重装）`,
        detail: candidates.join(' · '),
        ...(toRepo.length
          ? {}
          : {
              hint:
                '非软链安装（pnpm file: 会物化成副本树）时，仓库里的修改不会自动生效。' +
                `改成 link: 安装即可：profile 的 package.json 里写 "${bundleName}": "link:${presetDir}"，再 pnpm install。`,
            }),
      })
      if (fs.existsSync(legacy)) {
        checks.push({
          id: 'preset-legacy-dir',
          severity: SEVERITY.WARN,
          title: '仍有目录式预设残留（0.2.0 起无读取方，等于失效）',
          detail: legacy,
          hint: `迁移到 bundle 后即可移走（建议先备份）：mv ${legacy} ~/.dsh/backups/legacy-agent-presets-<date>/`,
        })
      }
    } else {
      checks.push({
        id: 'preset-installed',
        severity: SEVERITY.WARN,
        title: 'DSH preset 未安装到任何 profile（会话内 xp_* 工具面不可用）',
        detail: `查过 ${profilesDir}/*/node_modules/${bundleName}`,
        hint:
          `装法（仓库即源、改代码免重装）：在目标 profile 的 package.json 里加 ` +
          `"${bundleName}": "link:${presetDir}"，并把它加进 dsh.profile.bundles，然后在该 profile 目录 pnpm install。` +
          (fs.existsSync(legacy)
            ? ` 注意 ${legacy} 是 0.2.0 起失效的旧载体，装了 bundle 后可移走。`
            : ''),
      })
    }
  }

  // ── 6d. 调度（v2.3）：引擎自带定时器 ──
  //
  // 为什么单列一条：v2.3 起"到点会不会跑"完全取决于**宿主进程在不在**
  // （桥或独立 `scheduler`），以及槽位有没有**命令声明**。这两件事都不会自己暴露：
  // 桥停着的时候 Console 页面照样能打开，声明缺失则要等到点才发现"什么都没发生"。
  checks.push(...schedulerCheck({ bridgeUp: !!health }))

  // MCP server：**不只是"文件在"**（v2.29）
  //
  // 为什么升级这条：定时链路的发布接口就是 MCP——接入方的 DSH profile 里注册的
  // mcp-crosspost 拉起 `mcp-server/index.mjs`。文件存在但**握手失败**
  // （import 期报错、zod schema 写坏、Node 版本不兼容…）会让整条定时链路当天全灭，
  // 而旧检查会显示"✔ MCP server 存在"。这里实拉一次 stdio 握手 + tools/list。
  const mcpProbe = fs.existsSync(mcpServer)
    ? await probeMcpServer(mcpServer)
    : { ok: false, reason: '文件不存在' }
  checks.push({
    id: 'mcp-server',
    severity: !fs.existsSync(mcpServer) ? SEVERITY.WARN : mcpProbe.ok ? SEVERITY.OK : SEVERITY.FAIL,
    title: mcpProbe.ok ? `MCP server 可握手（${mcpProbe.tools} 个工具）` : 'MCP server 存在',
    detail: mcpServer + (mcpProbe.ok ? '' : ` ${mcpProbe.reason || ''}`.trimEnd()),
    ...(mcpProbe.ok
      ? {}
      : {
          hint: fs.existsSync(mcpServer)
            ? 'stdio 握手失败。定时链路（接入方 profile 里注册的 MCP）走的就是这个 MCP server，' +
              '握手失败会让整条定时链路当天无法发布。手工复现：' +
              `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node ${mcpServer}`
            : '缺少 MCP server；外部 MCP 客户端无法接入。',
        }),
  })

  // ── 6e. 选中项目的域（v2.83）──
  //
  // 为什么单列：Console「接入与自检」此前只显示**引擎级**事实（Node / 桥 / MCP / 扩展 /
  // 默认域目录…），于是切到某个项目后页面上**看不出任何项目差异**——草稿/日志/历史显示的是
  // 引擎自己的空域，`platforms.default` 显示的是引擎那一份，"一键生成可用"是注册表聚合。
  // 下面这些只在**有项目上下文**时出现（`npm run doctor` 仍只报引擎级，逐字不变）。
  const projectId = currentProject()
  let projectScope = null
  if (projectId) {
    const res = resolveResources(projectId) || {}
    const rp = resolveProject(projectId)
    const store = resolveProjectStoreDir(projectId)
    const overridden = projectOverriddenKeys(projectId)
    const cfg = readConfig()
    const writable = (dir) => {
      if (!dir) return { ok: false, error: '（未解析出路径）' }
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.accessSync(dir, fs.constants.W_OK)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }
    const dw = writable(res.draftsDir)
    const sw = writable(store && store.dir)
    const rw = writable(res.historyDir)
    const lw = writable(res.logsDir)
    let gen = { provided: false, reason: '未声明' }
    try {
      const g = resolveGenerateProvider(projectId)
      gen = {
        provided: !!g.provided,
        reason: g.reason || null,
        kind: g.kind || null,
        url: g.url || null,
        source: g.source || null,
      }
    } catch (e) {
      gen = { provided: false, reason: String((e && e.message) || e) }
    }
    const push = (id, severity, title, detail, hint) =>
      checks.push({ id, severity, title, detail, hint })

    push(
      'project:drafts',
      dw.ok ? SEVERITY.OK : SEVERITY.FAIL,
      `项目 ${projectId} · 草稿目录可写`,
      `${res.draftsDir || '?'}${dw.ok ? '' : `（${dw.error}）`}`,
      dw.ok ? '' : '检查 manifest 的 dataDir 是否指向一个存在且可写的目录。',
    )
    push(
      'project:store',
      sw.ok ? SEVERITY.OK : SEVERITY.FAIL,
      `项目 ${projectId} · 引擎簿记目录可写`,
      `${(store && store.dir) || '?'}${sw.ok ? '' : `（${sw.error}）`}`,
      sw.ok
        ? ''
        : `记录库由引擎维护（<localRoot>/project-state/${projectId}/articles），检查 localRoot 权限。`,
    )
    push(
      'project:resources',
      rw.ok && lw.ok ? SEVERITY.OK : SEVERITY.WARN,
      `项目 ${projectId} · 项目级资源目录可写`,
      `history ${res.historyDir || '?'} · logs ${res.logsDir || '?'}`,
      rw.ok && lw.ok ? '' : '选题库/编辑记忆/日志都在内容工作区下（v2.76 起按项目解析）。',
    )
    push(
      'project:config',
      SEVERITY.OK,
      `项目 ${projectId} · 项目级设置`,
      overridden.length
        ? `覆盖了：${overridden.join('、')} · 文件 ${res.configFile}`
        : `未覆盖任何键（继承引擎配置）· 文件 ${res.configFile}`,
      overridden.length ? '' : '在 Console 设置页（该项目作用域下）改过的项才会落到这里。',
    )
    push(
      'project:generate',
      gen.provided ? SEVERITY.OK : SEVERITY.WARN,
      `项目 ${projectId} · 「一键生成」能力`,
      gen.provided ? `已提供${gen.url ? `：${gen.url}` : ''}` : `未提供（${gen.reason}）`,
      gen.provided
        ? ''
        : '在 manifest 里声明 capabilities.generate（HTTP 端点）后，选题中心的按钮才可用。',
    )

    projectScope = {
      id: projectId,
      name: (rp && rp.project && rp.project.name) || projectId,
      valid: !!(rp && rp.project && rp.project.valid),
      draftsDir: res.draftsDir || null,
      storeDir: (store && store.dir) || null,
      historyDir: res.historyDir || null,
      logsDir: res.logsDir || null,
      topicPoolFile: res.topicPoolFile || null,
      editorialMemoryFile: res.editorialMemoryFile || null,
      configFile: res.configFile || null,
      overridden,
      generate: gen,
      effective: {
        platformsDefault: ((cfg.platforms || {}).default || []).length,
      },
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    node: process.versions.node,
    minNodeMajor: MIN_NODE_MAJOR,
    ports: { ws: wsPort, http: httpPort },
    summary: summarize(checks),
    checks,
    // v2.83：有项目上下文时给出**该项目自己**的域事实（Console 用它渲染"当前项目"卡）
    project: projectScope,
  }
}

/**
 * 实拉一次 MCP stdio 握手 + tools/list，返回 `{ ok, tools }` 或 `{ ok:false, reason }`。
 *
 * 刻意**不用** test-mcp.mjs（那个还要依次调用各工具、依赖外部网络与浏览器代理）；
 * doctor 只需要回答"这个 server 能不能起来并自报工具清单"。
 * 超时 10s：正常一次握手 <500ms，给足冷启动余量（首次数千个模块的 require）。
 *
/**
 * 导出仅为可测（tests/doctor-mcp.test.mjs 覆盖成功 / 语法错误 / 秒退三种情形）。
 */
export function probeMcpServer(serverPath) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, reason: String((e && e.message) || e) })
      return
    }
    let buf = ''
    let err = ''
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
      resolve(v)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: '握手超时(10s)' }), 10000)

    child.stdout.on('data', (d) => {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1) {
          // initialize 成功 → 追问工具清单
          try {
            child.stdin.write(
              JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
            )
          } catch {
            finish({ ok: false, reason: 'stdin 写入失败' })
          }
        } else if (msg.id === 2) {
          const tools = ((msg.result && msg.result.tools) || []).length
          finish(tools > 0 ? { ok: true, tools } : { ok: false, reason: 'tools/list 返回空清单' })
        }
      }
    })
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    child.on('error', (e) => finish({ ok: false, reason: String((e && e.message) || e) }))
    child.on('close', (code) =>
      finish({ ok: false, reason: `进程提前退出(code=${code}) ${err.slice(0, 160)}`.trim() }),
    )
    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'crosspost-doctor', version: '1' },
          },
        }) + '\n',
      )
    } catch (e) {
      finish({ ok: false, reason: 'stdin 写入失败: ' + String((e && e.message) || e) })
    }
  })
}

/**
 * 调度自检（v2.3）：定时器住在哪个宿主、槽位有没有命令、有没有旧任务会双发。
 *
 * 三件事都不做"能跑就算过"：它们全都属于**到点才发现**的失败。
 * 返回数组（0–2 条）：核心一条永远给，检测到旧系统任务时再补一条。
 */
export function schedulerCheck({ bridgeUp = false, collected = null, legacy = null } = {}) {
  const out = []
  let c
  try {
    c = collected || collectSpecs({})
  } catch (e) {
    return [
      {
        id: 'scheduler',
        severity: SEVERITY.WARN,
        title: '调度子系统不可读',
        detail: String((e && e.message) || e),
        hint: '内置定时器（v2.3 起）负责到点触发；读不出来时定时不会发生。',
      },
    ]
  }
  const specs = c.specs || []
  const warnings = c.warnings || []
  const settings = c.settings || { tz: 'Asia/Shanghai', catchUpMaxMinutes: 120 }
  const enabled = specs.filter((s) => s.enabled)
  const missing = enabled.filter((s) => s.commandAvailable === false)
  const projectSlots = enabled.filter((s) => s.scope === 'project')
  const legacyList = legacy || legacyTasks()

  const detail =
    `${specs.length} 个槽位（启用 ${enabled.length}）· tz=${settings.tz}` +
    ` · 补跑窗口 ${settings.catchUpMaxMinutes} 分钟 · 宿主=${bridgeUp ? '桥' : '未在运行'}`
  const extra = []
  if (projectSlots.length)
    extra.push(`项目槽位：${projectSlots.map((s) => `${s.projectId}/${s.id}`).join('、')}`)
  for (const w of warnings.slice(0, 5)) extra.push(`⚠ ${w}`)

  const hints = []
  if (!bridgeUp)
    hints.push(
      '定时器住在宿主进程里：启动桥（node bridge/run-bridge.mjs，或 install-launchd.sh / install-systemd.sh 装守护），' +
        '或只跑调度（node crosspost-runtime/src/commands/scheduler-cli.mjs run）。' +
        '桥不在时到点不触发；当天错过的会在补跑窗口内于下次启动时补跑。',
    )
  if (missing.length)
    hints.push(
      `这些启用中的槽位还没有命令声明：${missing.map((s) => `${s.projectId || '默认域'}/${s.id}`).join('、')}。` +
        `在项目根的 .crosspost/schedule.json 里声明；旧的 launchd 槽位可用 ` +
        `node crosspost-runtime/src/commands/scheduler-cli.mjs migrate --dry-run 生成。`,
    )
  if (legacyList.length)
    hints.push(
      `检测到 ${legacyList.length} 个旧的系统调度任务（${legacyList.map((t) => t.label || t.unit).join('、')}）：` +
        '它们与内置定时器会**双发**，请执行 node crosspost-runtime/src/commands/scheduler-cli.mjs migrate（先 --dry-run 看计划）。',
    )
  out.push({
    id: 'scheduler',
    severity: !bridgeUp || missing.length ? SEVERITY.WARN : SEVERITY.OK,
    title: '定时调度（引擎自带定时器）',
    detail,
    detailExtra: extra,
    ...(hints.length ? { hint: hints.join('\n      ') } : {}),
  })
  if (legacyList.length)
    out.push({
      id: 'scheduler-legacy',
      severity: SEVERITY.WARN,
      title: `旧系统调度任务仍在（${legacyList.length} 个，会双发）`,
      detail: legacyList.map((t) => `${t.kind}:${t.label || t.unit}`).join('、'),
      hint: '执行 node crosspost-runtime/src/commands/scheduler-cli.mjs migrate（幂等；先 --dry-run）。',
    })
  // 名字像旧任务、其实**没有到点触发**的常驻服务（槽位执行器/生成提供者那类）。
  // 单独报一条 OK 项，是为了让"这个 plist 到底是什么"在体检报告里有答案 ——
  // 否则它要么被误报成待迁移的旧任务（2026-09-25 的误报），要么查无此物。
  //
  // 措辞只讲**可验证的事实**（无到点触发）：命名空间 + 无触发推不出"它一定是执行器"，
  // 用户自己放的常驻 plist 也会落进这一栏，不能替它下身份断言。
  // 这一项**只在这里和 `scheduler-cli.mjs tasks` 出现**，不上 Console 常驻提示区：
  // 它不是失败、没有动作可做，常驻只会稀释真正的告警。
  const daemonList = legacyDaemons()
  if (daemonList.length)
    out.push({
      id: 'scheduler-services',
      severity: SEVERITY.OK,
      title: `常驻服务 ${daemonList.length} 个（无到点触发，不用迁移）`,
      detail: daemonList.map((d) => `${d.kind}:${d.label || d.unit}`).join('、'),
      hint:
        '它们是 KeepAlive/RunAtLoad 型常驻进程（槽位执行器 / 生成提供者那类）：只在监听/待命，' +
        '自己不会到点跑，不与内置定时器双发。要停用请直接 launchctl bootout，' +
        '别用 scheduler migrate —— 它没有时间点，迁移器只会把它标成 blocked。',
    })
  return out
}
