/**
 * 一键初始化（setup）——把"能装、能连"变成一条命令。
 *
 * 设计原则：**幂等**。已存在的配置一律不覆盖（只报告"已存在，保留"），
 * 二次运行只补齐缺失项。这样它既能用于首次安装，也能用于修复半成品环境。
 *
 * 用法：
 *   npm run setup                 # 初始化（不启动桥，只打印启动方式）
 *   npm run setup -- --start      # 初始化后前台启动桥（阻塞）
 *   npm run setup -- --open       # 初始化后打开扩展安装页（macOS）
 *   npm run setup -- --no-install # 只做配置与目录（不装子包依赖）
 *   node crosspost-runtime/src/commands/setup.mjs --json
 *
 * 2026-09-22（v2.104）：**子包依赖也归 setup 管**。
 * 此前它只负责"建目录 + 生成配置 + 构建 core"，而 core 的构建依赖（`tsup`）与
 * 桥的运行时依赖（`ws`）分散在子包里、且都不入库 —— 干净 clone 上
 * `npm install && npm run setup` 必然失败（见 `src/deps.mjs` 的说明）。
 * 因为本模块只用 node 内置模块，它能在"依赖一个都没装"的时候先把依赖装上。
 *
 * 2026-09-25（v2.3.1）：子包从三个收敛为两个 —— core 的整棵依赖图由 `crosspost-runtime`
 * 那棵树承载（npm 把 `file:./core` 当工作区 hoist），所以这里装的是 `runtime → bridge`。
 * 判据与证据见 `src/deps.mjs` 文件头。
 *
 * 不做的事（避免越界）：不安装浏览器扩展（必须人工在 Chrome 加载）、
 * 不写任何接入项目的目录、不修改已存在的 config.json / paths.json。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { loadPaths, localRoot, pathsPath } from '../paths.mjs'
import { configPath } from '../config-path.mjs'
import { checkNodeVersion, SEVERITY, checkWritableDir } from '../preflight.mjs'
import { SUBPACKAGES, missingDeps, manualInstallCommands, coreBuilt } from '../deps.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

/** 幂等步骤结果 */
const step = (id, status, detail, extra = {}) => ({ id, status, detail, ...extra })

/** 生成 config.json 的默认内容（引擎默认；不含任何接入方专属字段） */
export function defaultConfig() {
  return {
    _note:
      'CrossPost 引擎配置（由 npm run setup 生成）。引擎默认值不含任何具体接入项目的信息；项目接入见 docs/integration.md。',
    proxyMode: true,
    proxyHost: '127.0.0.1',
    proxyHttpPort: 9540,
    timeoutMs: 150000,
    platformsCacheMs: 3600000,
    platformsCheckConcurrency: 6,
    concurrency: 3,
    schedule: {
      morning: false,
      hotspot: false,
      noon: false,
      hotspot2: false,
      tips: false,
      evening: false,
    },
    scheduler: { labelPrefix: 'com.crosspost' },
    autoPush: { enabled: false },
    scoring: { threshold: 68 },
    platforms: {
      default: [
        'zhihu',
        'csdn',
        'weixin',
        'baijiahao',
        'toutiao',
        'xiaohongshu',
        'yidian',
        'dayu',
        'smzdm',
        'juejin',
        'cto51',
        'douyin',
      ],
    },
    notify: { enabled: false, channel: 'webhook', webhookUrl: '', webhookType: 'raw' },
    styles: { disabled: [] },
    coverSettings: { defaultTemplate: 'cyber', coverEnabled: true },
    adapters: { backfillFromRunLogs: { enabled: false } },
  }
}

/** 生成 paths.json 的默认内容（落到引擎自有 .local/，可被 env 覆盖） */
export function defaultPaths(local, repoRoot) {
  return {
    _note:
      'CrossPost 路径配置（由 npm run setup 生成）。默认指向仓库内 .local/（已 gitignore）。' +
      '接入项目请通过项目 manifest 声明自己的数据位置，见 docs/integration.md。',
    localRoot: local,
    draftsDir: path.join(local, 'drafts'),
    logsDir: path.join(local, 'logs'),
    historyDir: path.join(local, 'history'),
    topicPoolFile: path.join(local, 'history', 'topic-pool.json'),
    sessionsDirs: ['~/.dsh/sessions'],
    bridgeScript: path.join(repoRoot, 'bridge', 'run-bridge.mjs'),
    workspace: path.join(repoRoot, 'bridge'),
    tokenFile: path.join(repoRoot, 'bridge', 'token.local'),
  }
}

/** 写文件但绝不覆盖已存在者 */
function writeIfAbsent(file, content) {
  if (fs.existsSync(file)) return { created: false, file }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n',
  )
  return { created: true, file }
}

/**
 * 执行初始化。
 *
 * @param {{
 *   runBuild?: boolean,       // 是否把 core 构建纳入计划（默认 true）
 *   runInstall?: boolean,     // 是否把子包依赖安装纳入计划（默认 true）
 *   start?: boolean,
 *   open?: boolean,
 *   repoRoot?: string,        // 供测试注入；默认本仓库
 * }} [opts]
 *
 * 注意：本函数只**产出计划**（steps 里 pending 的条目由调用方执行），
 * 因为它也被 IPC 侧的 `cli.mjs setup` 调用 —— 在那里跑 npm 是意外行为。
 */
export async function runSetup(opts = {}) {
  const steps = []
  const repoRoot = opts.repoRoot || REPO_ROOT
  const runtimeDir = path.join(repoRoot, 'crosspost-runtime')

  // ── 0. Node 版本硬门禁 ──
  const nodeCheck = checkNodeVersion()
  if (nodeCheck.severity === SEVERITY.FAIL) {
    steps.push(step('node', 'fail', `${process.versions.node} < 24`, { hint: nodeCheck.hint }))
    return { ok: false, steps, stoppedAt: 'node' }
  }
  steps.push(step('node', 'ok', `Node ${process.versions.node}`))

  // ── 0b. 子包依赖（v2.104） ──
  // 放在最前：干净 clone 上它是第一个缺的东西，而且 core 构建依赖它先到位。
  const missing = missingDeps(repoRoot)
  if (opts.runInstall === false) {
    steps.push(
      step(
        'deps-install',
        'skipped',
        missing.length ? `按参数跳过；仍缺 ${missing.map((m) => m.id).join('、')}` : '按参数跳过',
        missing.length ? { hint: `手工安装：${manualInstallCommands().join('；')}` } : {},
      ),
    )
  } else if (!missing.length) {
    steps.push(step('deps-install', 'kept', `${SUBPACKAGES.length} 个子包依赖已就绪`))
  } else {
    steps.push(
      step('deps-install', 'pending', `待安装：${missing.map((m) => m.id).join(' → ')}`, {
        packages: missing.map((m) => m.id),
        hint: `等价手工命令：${manualInstallCommands().join('；')}`,
      }),
    )
  }

  // ── 1. 本地数据目录 ──
  const local = localRoot()
  const dirs = ['drafts', 'logs', 'history', 'articles']
  const created = []
  for (const d of dirs) {
    const dir = path.join(local, d)
    const r = checkWritableDir(dir)
    if (!r.ok) {
      steps.push(step('local-dirs', 'fail', `${dir}: ${r.error}`))
      return { ok: false, steps, stoppedAt: 'local-dirs' }
    }
    if (!fs.existsSync(path.join(local, d, '.keep'))) {
      try {
        fs.writeFileSync(path.join(local, d, '.keep'), '')
        created.push(d)
      } catch {
        /* .keep 失败不影响使用 */
      }
    }
  }
  steps.push(
    step(
      'local-dirs',
      'ok',
      `${local}（${created.length ? '新建 ' + created.join('/') : '已存在'}）`,
    ),
  )

  // ── 2. paths.json（不覆盖） ──
  // 路径走 `pathsPath()` / `configPath()`，**不**自己拼 `<runtimeDir>/…`：
  // 有 `CROSSPOST_PATHS` / `CROSSPOST_CONFIG` 时（沙箱、容器、多实例）这两份必须落在
  // 被指定的位置，否则沙箱里两份都不会生成，引擎随后读到的是**空配置**——
  // 设置页显示成"什么都配了、其实都是兜底值"，而人看不出哪里不对。
  // 生产不设这两个变量 → 路径与改动前逐字相同。
  const pathsFile = pathsPath()
  const pathsRes = writeIfAbsent(pathsFile, defaultPaths(local, repoRoot))
  steps.push(
    step(
      'paths.json',
      pathsRes.created ? 'created' : 'kept',
      pathsRes.created ? pathsFile : `${pathsFile}（已存在，保留）`,
    ),
  )

  // ── 3. config.json（不覆盖） ──
  const configFile = configPath()
  const configRes = writeIfAbsent(configFile, defaultConfig())
  steps.push(
    step(
      'config.json',
      configRes.created ? 'created' : 'kept',
      configRes.created ? configFile : `${configFile}（已存在，保留）`,
    ),
  )

  // ── 4. 引擎运行时的解析结果（供随后的 doctor 与用户核对） ──
  const resolved = loadPaths()
  steps.push(
    step(
      'resolved-paths',
      'info',
      JSON.stringify({
        localRoot: resolved.localRoot,
        draftsDir: resolved.draftsDir,
        logsDir: resolved.logsDir,
      }),
    ),
  )

  // ── 5. core 构建 ──
  //
  // 判据是**产物**而不是目录（2026-09-25，Docker 实测）：compose 把 core/dist 挂成容器私有卷时，
  // 首次挂载的是个**空目录**——"目录存在"会让这一步（以及 setup-cli 的构建触发）
  // 双双跳过构建，容器里 core 永远缺；详见 deps.mjs 的 CORE_DIST_ENTRIES。
  const distDir = path.join(runtimeDir, 'core', 'dist')
  if (opts.runBuild === false) {
    steps.push(
      step('core-build', 'skipped', '按参数跳过', {
        hint: '手工构建：npm -C crosspost-runtime/core run build',
      }),
    )
  } else if (coreBuilt(repoRoot)) {
    steps.push(step('core-build', 'kept', `${distDir}（产物齐全，跳过构建）`))
  } else {
    steps.push(
      step('core-build', 'pending', '待构建 @crosspost/core …', {
        hint: '手工构建：npm -C crosspost-runtime/core run build',
      }),
    )
  }

  return {
    ok: true,
    repoRoot,
    localRoot: local,
    steps,
    ...(opts.start ? { start: true } : {}),
    ...(opts.open ? { open: true } : {}),
  }
}

/** 构建 core（供 setup 命令在需要时调用；纯执行，无输出格式） */
export function buildCore(repoRoot, onLog) {
  return new Promise((resolve) => {
    const coreDir = path.join(repoRoot, 'crosspost-runtime', 'core')
    const child = execFile(
      'npm',
      ['run', 'build'],
      { cwd: coreDir, timeout: 300000 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          ...(err ? { error: String(stderr || err.message || err).slice(0, 800) } : {}),
          tail: String(stdout || '')
            .split('\n')
            .slice(-4)
            .join('\n'),
        })
        if (onLog) onLog(err ? String(stderr || err.message) : String(stdout || ''))
      },
    )
    if (onLog && child.stdout) child.stdout.on('data', (d) => onLog(String(d)))
  })
}

export const SETUP_REPO_ROOT = REPO_ROOT
