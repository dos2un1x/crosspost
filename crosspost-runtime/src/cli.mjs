#!/usr/bin/env node
/**
 * CrossPost 原生运行时 CLI（JSON 出入口）——IPC 调度入口
 *
 * 2026-08-24 按域拆分：业务实现移至 src/commands/（platforms/publish/wechat/risk-rules），
 * 本文件只保留 main() 的 method 分发 + IPC 常驻循环。
 * 2026-08-28 重构：巨型 switch + 模块级全局（method/arg1/arg2/argTail）→ HANDLERS 方法注册表，
 * 每个方法一个 async (args) => Promise<out> 处理器（args 即 method 后全部参数），无全局可变状态；
 * 统一 wrap() 错误包装，错误文案逐字保持。
 *
 * 用法：
 *   node cli.mjs listPlatforms [forceRefresh]
 *   node cli.mjs publishArticle <request.json>
 *   node cli.mjs --ipc   （bridge 常驻 worker，逐行 JSON 请求）
 *
 * 所有输出为 stdout 单行 JSON。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  scanAndList,
  getRecord,
  parseDraftFile,
  getDraftsDir,
  upsertRecord,
  removeRecord,
  ensureDraftRecord,
  recordHealth,
  DRAFT_SLOT_SEGMENT_RE,
} from './articles.mjs'
import { bjDate } from './tz.mjs'

import { parseFlags } from './argv.mjs'
import {
  articleCost,
  listCosts,
  prewarmSessions,
  sessionFormatDiagnostics,
  PRICING,
} from './token-cost.mjs'
import { sendNotify, notifyTest } from './notify.mjs'
import { runDoctor, formatReport } from './doctor.mjs'
import { runSetup, buildCore } from './commands/setup.mjs'
import { installDeps, manualInstallCommands } from './deps.mjs'
import { registrySummary, getProject, resolveProject } from './projects.mjs'
import {
  extractProjectFlag,
  withProject,
  currentProject,
  draftScopeOverride,
} from './project-context.mjs'
import { soleProjectId } from './resources.mjs'
import { readConfig } from './config-cache.mjs'
import { versionInfo } from './version.mjs'
import { getAdapter, listPlatforms, checkConcurrency } from './commands/platforms.mjs'
import {
  runTopicPoolUpsert,
  runTopicPoolValidate,
  runTopicPoolShow,
} from './commands/topic-pool-cli.mjs'
import { pushHumanFeedback } from './editorial-memory.mjs'
import { runAiDetect } from './commands/ai-detect-cli.mjs'
import { wechatDraft, wechatDrafts, wechatDraftDelete } from './commands/wechat.mjs'
import {
  syncArticle,
  splitFrontmatter,
  findDraftFile,
  runPublishArticle,
  runArchiveArticle,
  runRetainArticle,
  listArchive,
  listRetained,
  runBackfill,
  runMarkPublished,
  runMarkAllPublished,
  runPublishDouyin,
  findRetainedFile,
  stripFrontmatterRisk,
} from './commands/publish.mjs'
import { classifyArticles } from './commands/classify.mjs'
import { runRecordWriting } from './commands/record-writing.mjs'
import { reconcileRecords } from './record-repair.mjs'
import { aiGateStats, allCostRecords } from './commands/costs.mjs'
import {
  listStyles,
  listCoverTemplates,
  renderPreview,
  syncStyledArticle,
  generateCover,
  generateCoverGallery,
  generateEndingCard,
  analyzeStyle,
  styles,
} from './commands/cover-styles.mjs'

/** 统一错误包装器：prefix 为错误文案前缀（如 'publishArticle failed: '），fn 抛错时返回 { error }
 *
 *  2026-10-08：抛出的错误可带 `fields`（机器可读上下文，如留存失败时的
 *  `{ok:false, fileMoved:true, file, dir, recordError}`），随错误信封一起下发。
 *  为什么需要：失败时**状态是"文件已就位、记录没写"**，只给一句错误文案的话，
 *  调用方（写作侧/Console）分不清"什么都没发生"与"做了一半"，也就给不出下一步动作。 */
const wrap = (prefix, fn) =>
  Promise.resolve(fn()).then(
    (out) => out,
    (e) => ({ error: `${prefix}${(e && e.message) || e}`, ...((e && e.fields) || {}) }),
  )

/**
 * extract.mjs（jsdom + Readability）**只被两个 handler 用到**（extractArticle / extractActiveTab）。
 * 2026-09-21（v2.100）由顶层 import 改为懒加载。
 *
 * **实测纠正（重要，勿沿用旧结论）**：改动本身在本版**没有可测量的提速** —— 全新进程里
 * `await import('./extract.mjs')` 单独计时 1175ms，但把 cli.mjs 其余 eager 模块全部导入
 * （不含 extract）已经是 1219ms；也就是说 extract 的**边际成本 ≈ 0**：它依赖的重活
 * （`@crosspost/core` = 809ms、jsdom = 437ms）已被 `commands/*` 里的 eager import 拉起来了。
 * 冷启动 1200ms 的真正构成：node 空启动 77ms + `@crosspost/core` ~809ms（由 platforms/
 * cover-styles/publish/costs/classify/wechat 六个模块在顶层拉入）+ 其余 ~300ms。
 * 只把"轻"的 13 个模块拉起来实测 **126ms** —— 即"六个命令模块也懒加载"能把冷启动压到 ~150ms，
 * 但那要改几十处 handler 调用点，属独立版本，不在本版范围。
 * 保留懒加载的理由：不真正做提取时**不**再依赖 jsdom 这一层（注释见 git v2.100 tag）。
 */
let _extractMod = null
async function loadExtract() {
  if (!_extractMod) _extractMod = await import('./extract.mjs')
  return _extractMod
}

/**
 * 方法注册表：每个方法一个 async (args) => Promise<out> 处理器。
 * args 即 method 之后全部命令行参数（styles 子命令 / --flag 全量传入）。
 * 返回结构与原 switch case 逐字一致。
 */
const HANDLERS = {
  // doctor：环境自检（结构化结果；人类可读输出在 commands/doctor-cli.mjs）
  doctor: (args) =>
    wrap('doctor failed: ', async () => {
      const wsArg = args.find((a) => String(a).startsWith('--ws-port='))
      return await runDoctor(wsArg ? { wsPort: Number(String(wsArg).split('=')[1]) } : {})
    }),
  // doctorText：自检 + 人类可读报告（供 Console/终端复用同一份实现）
  doctorText: (_args) =>
    wrap('doctorText failed: ', async () => {
      const r = await runDoctor()
      return { ...r, text: formatReport(r) }
    }),
  // projects [id]：项目注册表查询（P1 接入契约）
  //   无参 → 全部已注册项目摘要（含无效项及其错误）
  //   带 id → 单个项目（含提供者可达性）
  projects: (args) => {
    const id = (args[0] || '').trim()
    if (!id) return registrySummary()
    const p = getProject(id)
    if (!p) return { error: `未注册的项目: ${id}`, registry: registrySummary() }
    return { project: p }
  },
  // resolveProject [id]：起效项目解析（供桥决定走默认路径还是项目数据源）
  resolveProject: (args) => resolveProject((args[0] || '').trim() || undefined),

  // setup：一键初始化（幂等；不覆盖已存在的 paths.json / config.json）
  //
  // v2.104：默认**只出计划**（配置 + 目录），不在 IPC 进程里跑 npm 与构建；
  // 需要真装依赖 / 真构建时显式给 `--install` / `--build`。
  // 完整的一键入口是 `npm run setup`（commands/setup-cli.mjs）。
  setup: (args) =>
    wrap('setup failed: ', async () => {
      const runInstall = args.includes('--install')
      const runBuild = args.includes('--build') && !args.includes('--no-build')
      let result = await runSetup({ runInstall, runBuild })
      if (runInstall) {
        const step = result.steps.find((s) => s.id === 'deps-install')
        if (step && step.status === 'pending') {
          const inst = await installDeps(result.repoRoot, step.packages || [])
          const idx = result.steps.findIndex((s) => s.id === 'deps-install')
          result.steps[idx] = inst.ok
            ? {
                id: 'deps-install',
                status: 'created',
                detail: `已安装：${step.packages.join(' → ')}`,
              }
            : {
                id: 'deps-install',
                status: 'fail',
                detail: String(
                  (inst.results[inst.results.length - 1] || {}).error || '安装失败',
                ).slice(0, 200),
                hint: `手工安装：${manualInstallCommands().join('；')}`,
              }
          if (!inst.ok) result = { ...result, ok: false, stoppedAt: 'deps-install' }
        }
      }
      if (runBuild) {
        const dist = path.join(result.repoRoot, 'crosspost-runtime', 'core', 'dist')
        if (!fs.existsSync(dist)) {
          const b = await buildCore(result.repoRoot)
          const idx = result.steps.findIndex((s) => s.id === 'core-build')
          if (idx >= 0)
            result.steps[idx] = {
              id: 'core-build',
              status: b.ok ? 'created' : 'fail',
              detail: b.ok ? '构建完成' : b.error,
            }
          if (!b.ok) result = { ...result, ok: false, stoppedAt: 'core-build' }
        }
      }
      return result
    }),

  // listArticles：扫描草稿 + 合并文章库记录（面板列表）
  listArticles: (_args) => ({ articles: scanAndList() }),

  // backfill [--force]：按接入方运行日志回填历史文章记录。
  // 2026-09-18（v2.01）：改为可选适配器，默认关闭——该能力解析的是特定接入项目的
  // 日志格式（adapters/backfill-run-logs.mjs），需在 config.adapters 显式启用。
  // 未启用时返回 { error: 'capability_disabled' } 而非静默跳过。
  backfill: (args) =>
    wrap('backfill failed: ', async () => {
      const force = (args[0] || '').trim() === '--force'
      return await runBackfill(force)
    }),

  // markAllPublished：全部（非归档）记录状态置为 published（用户手动维护过各平台）
  markAllPublished: (_args) =>
    wrap('markAllPublished failed: ', async () => await runMarkAllPublished()),

  // publishDouyin <req.json>：抖音手动推送（单槽覆盖式，仅手动）
  publishDouyin: (args) =>
    wrap('publishDouyin failed: ', async () => {
      const req = JSON.parse(fs.readFileSync(args[0], 'utf8'))
      return await runPublishDouyin(req)
    }),

  // markPublished <req.json>：手动补记推送状态
  markPublished: (args) =>
    wrap('markPublished failed: ', async () => {
      const req = JSON.parse(fs.readFileSync(args[0], 'utf8'))
      return await runMarkPublished(req)
    }),

  // notify <req.json>：按配置发送一条通知（bridge 掉线告警等复用）
  notify: (args) =>
    wrap('notify failed: ', async () => {
      const req = JSON.parse(fs.readFileSync(args[0], 'utf8'))
      return await sendNotify(req)
    }),

  // notifyTest：通知通道自检（Console「发送测试通知」按钮；用当前配置发一条测试消息）
  notifyTest: () => wrap('notifyTest failed: ', async () => await notifyTest()),

  // getArticle <id>：文章库单条记录
  // 2026-10-08：附派生字段 `recordHealth`（'ok'|'empty'，见 articles.mjs 的 recordHealth()）。
  // 详情抽屉与列表必须用**同一个**判据判断"这条记录是空骨架"，否则会出现"列表有警告、详情没有"。
  getArticle: (args) => {
    const rec = getRecord(args[0])
    if (!rec) return { article: null }
    return { article: { ...rec, recordHealth: recordHealth(rec).health } }
  },

  // articleCost <id>：单篇文章生成 token 消耗与费用（2026-08-28 精确计费：过程窗口）
  articleCost: (args) => {
    const rec = getRecord(args[0])
    const file = rec && rec.file ? rec.file : null
    const publishedAt = rec && rec.history && rec.history[0] ? rec.history[0].at : null
    return {
      cost: articleCost({
        id: args[0],
        date: rec && rec.date,
        slot: rec && rec.slot,
        title: rec && rec.title,
        file,
        createdAt: rec && rec.createdAt,
        publishedAt,
      }),
    }
  },

  // listCosts [date]：批量文章 token 消耗与费用（可过滤日期；2026-08-31 并入留存/归档三库）
  // meta（2026-09-11）：会话格式自检——扫到的会话按代际计数 + 一条 usage 都没解析出来的文件，
  // 供报表在"有文章却 0 篇匹配"时提示"可能是 DSH 会话格式又变了"，不再静默归零。
  // meta.pricing（2026-09-25）：把**计价口径**一并给出（型号 / 价格表版本 / 峰谷与周末规则）。
  // 报表卡片原先自己硬写着"按 DeepSeek deepseek-v4-flash 官方价" —— 那是 `PRICING` 的第二份
  // 副本：换型号或调价它都不会跟着变，而且那句话还漏了"按峰谷计价"。现在卡片按这些字段渲染。
  listCosts: (args) => {
    const date = (args[0] || '').trim()
    let list = allCostRecords()
    if (date) list = list.filter((a) => a.date === date)
    return {
      costs: listCosts(list),
      meta: {
        ...sessionFormatDiagnostics(),
        // AI 门禁汇总（2026-10-10）：报表按记录里的快照统计"这周达标几篇、平均特征占比多少"。
        // 记录本就为费用全量加载过（allCostRecords → listRecords），这里零额外读盘。
        aiGate: { all: aiGateStats(), recent: aiGateStats({ sinceDays: 7 }) },
        pricing: {
          model: PRICING.model,
          version: PRICING.version,
          peakHours: PRICING.peakHours,
          weekendIdleFrom: PRICING.weekendIdleFrom,
        },
      },
    }
  },

  // prewarmCosts [offset] [limit]：预热会话解析缓存。
  // 2026-09-22（v2.102.1）支持分块：桥按块循环调用，避免整块 6.5s 占满 costs 车道
  // （实测那会让用户开机后第一次看报表等 7.46s）。不带参数 = 一次预热全部（兼容旧调用）。
  prewarmCosts: (args) =>
    prewarmSessions({ offset: Number(args[0]) || 0, limit: Number(args[1]) || 0 }),

  // readDraft <id>：读取草稿文件正文（面板详情预览用；支持留存/归档子目录）
  readDraft: (args) => {
    const found = findDraftFile(args[0])
    if (!found) return { error: `草稿不存在: ${args[0]}` }
    const parsed = parseDraftFile(found.file)
    return {
      id: parsed.id,
      title: parsed.title,
      slot: parsed.slot,
      date: parsed.date,
      file: found.file,
      markdown: splitFrontmatter(fs.readFileSync(found.file, 'utf8')),
    }
  },

  // publishArticle <req.json>：发布一体化
  publishArticle: (args) =>
    wrap('publishArticle failed: ', async () => {
      const req = JSON.parse(fs.readFileSync(args[0], 'utf8'))
      return await runPublishArticle(req)
    }),

  // updateDraft <req.json>：编辑草稿 title/正文（写回文件 + 更新记录；支持留存/归档子目录）
  updateDraft: (args) =>
    wrap('updateDraft failed: ', async () => {
      const req = JSON.parse(fs.readFileSync(args[0], 'utf8'))
      const found = findDraftFile(req.id)
      if (!found) return { error: `草稿不存在: ${req.id}` }
      const file = found.file
      const text = fs.readFileSync(file, 'utf8')
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
      let newText
      if (m) {
        let fm = m[1]
        if (req.title !== undefined) {
          if (/^\s*title\s*:/m.test(fm)) fm = fm.replace(/^\s*title\s*:.*$/m, `title: ${req.title}`)
          else fm += `\ntitle: ${req.title}`
        }
        newText = `---\n${fm}\n---\n${req.markdown !== undefined ? req.markdown : m[2]}`
      } else {
        newText = req.markdown !== undefined ? req.markdown : text
        if (req.title !== undefined) newText = `---\ntitle: ${req.title}\n---\n\n${newText}`
      }
      fs.writeFileSync(file, newText, 'utf8')
      const rec = getRecord(req.id)
      if (rec && req.title !== undefined) {
        rec.title = req.title
        upsertRecord(rec)
      }
      return {
        ok: true,
        id: req.id,
        title: req.title !== undefined ? req.title : (rec && rec.title) || req.id,
      }
    }),

  // createDraft <req.json>：新建草稿文件（编写工作台用，2026-09-05）
  // 入参：{ title, markdown?, slot?, date?, topic? } → 文件名 YYYY-MM-DD-<slot>-<topic>.md，
  // 与 parseDraftFile 约定一致；写文件 + ensureDraftRecord 登记 → 返回 {id, file}
  createDraft: (args) =>
    wrap('createDraft failed: ', async () => {
      const req = JSON.parse(fs.readFileSync(args[0], 'utf8'))
      const title = (req.title || '').trim()
      if (!title) return { error: '缺少 title' }
      const date = (req.date || bjDate()).replace(/[^\d-]/g, '').slice(0, 10)
      // 栏目 id 由项目声明，引擎只校验它能否安全地进文件名——与 parseDraftFile 同一条规则，
      // 保证"写进去的名字一定解析得回来"。不合形态 → manual。
      const slot = DRAFT_SLOT_SEGMENT_RE.test(String(req.slot || '')) ? req.slot : 'manual'
      const rawTopic = (req.topic || title).trim().replace(/\s+/g, '-')
      // 文件名/记录 id 全程 ASCII（[\w.-]+）：中文等非 ASCII 一律剥掉，避免破坏 assertSafeId/parseDraftFile。
      // 空则回退 draft；前端通常显式传 ASCII slug（如标题的拼音/拼音缩写）。
      const topic = (rawTopic || 'draft').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'draft'
      const base = `${date}-${slot}-${topic}`
      const id = /^[\w.-]+$/.test(base) ? base : base.replace(/[^\w.-]/g, '-')
      const file = path.join(getDraftsDir(), `${id}.md`)
      if (fs.existsSync(file)) return { error: `草稿已存在: ${id}`, id, file }
      const markdown = req.markdown !== undefined ? req.markdown : ''
      const fm = [`title: ${title.replace(/\n/g, ' ')}`]
      // 可选 frontmatter 透传（style/risk/score 等由调用方内聚，这里仅保留常用）
      if (req.style) fm.push(`style: ${req.style}`)
      if (req.risk) fm.push(`risk: ${req.risk}`)
      const newText = `---\n${fm.join('\n')}\n---\n\n${markdown}`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, newText, 'utf8')
      const parsed = parseDraftFile(file)
      const rec = ensureDraftRecord(parsed)
      return { ok: true, id, file, title: rec.title }
    }),

  // deleteDraft <id>：删除草稿文件（顶层或 archive/）+ 文章库记录（authorized 校验在 bridge 层）
  deleteDraft: (args) => {
    const found = findDraftFile(args[0])
    // 编辑记忆：先取文章标题（removeRecord 后取不到），人工删除 = 负反馈（2026-08-25 B-1）
    let deletedTitle = ''
    try {
      deletedTitle = getRecord(args[0])?.title || ''
    } catch {
      /* 记录缺失不阻塞 */
    }
    let fileDeleted = false
    if (found) {
      try {
        fs.unlinkSync(found.file)
        fileDeleted = true
      } catch {
        /* 已删除 */
      }
    }
    removeRecord(args[0])
    pushHumanFeedback('article-delete', { id: args[0], title: deletedTitle })
    return {
      ok: fileDeleted,
      id: args[0],
      note: fileDeleted ? '已删除文件与记录' : '文件不存在,已删除记录',
    }
  },

  // archiveArticle <req.json>：归档/取消归档 req: { id, restore? }
  archiveArticle: (args) =>
    wrap('archiveArticle failed: ', async () => {
      return await runArchiveArticle(dispositionRequest(args))
    }),

  // retainArticle <req.json> | --id=<id> --dir=rejected|risk [--reason=…]
  //
  // 一行式是给**接入方脚本**用的（写作侧"放弃低分稿"时要顺手落记录）：
  // 裸 mv 不会写记录 → Console 留存库里看不到它，`verify:immutable` 也会把它
  // 判成"未声明的新增"（正是这条链此前缺的一环）。
  retainArticle: (args) =>
    wrap('retainArticle failed: ', async () => await runRetainArticle(dispositionRequest(args))),

  // recordWriting --id=<草稿id> [--decision=…] [--review=…] [--note=…]：把编辑决策/独立审稿写进记录
  //
  // 为什么要有（2026-10-10）：这两个字段的写入者本来只有发布器，而 draft-only 链路从不发布 ——
  // §2.5 的决策行、§5.6 的审稿行产出了却没落点，Console 那两张卡永远是空的。
  recordWriting: (args) => wrap('recordWriting failed: ', async () => await runRecordWriting(args)),

  // listArchive：列出归档库（drafts/archive/），供面板归档库视图
  listArchive: (_args) => ({ archived: listArchive() }),

  // repairRecords [--apply] [--id=<a,b>]：对账补齐"文件已留在留存库、记录却没写"的缺口
  //
  // 为什么要有（2026-10-09）：写作 agent 在 workspace-write 沙箱里执行 retainArticle 时，
  // 文件能移进 drafts/rejected/，但写引擎簿记报 EPERM —— 文件走了、记录没写，于是 Console
  // 显示「⚠ 无记录」、verify:immutable 把这次移动判成删除。对账以**文件系统事实**为准，
  // 任何写入方（含裸 mv、claude 回退链路、中断）丢的记录都能补回来。
  // **默认 dry-run**：只打印计划，加 `--apply` 才写（写前把记录原件备份到 <localRoot>/repairs/）。
  repairRecords: (args) => {
    const list = Array.isArray(args) ? args : []
    const apply = list.includes('--apply')
    const idFlag = list.find((a) => String(a).startsWith('--id='))
    const draftIds = idFlag
      ? String(idFlag.slice('--id='.length))
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null
    return wrap('repairRecords failed: ', async () => reconcileRecords({ apply, draftIds }))
  },

  // setArticleStatus <req.json>：更新记录状态 req: { id, status }
  setArticleStatus: (args) =>
    wrap('setArticleStatus failed: ', async () => {
      const req = JSON.parse(fs.readFileSync(args[0], 'utf8'))
      const rec = getRecord(req.id)
      if (!rec) return { error: `无记录: ${req.id}` }
      rec.status = req.status
      rec.history = rec.history || []
      rec.history.push({ action: 'status', at: new Date().toISOString(), to: req.status })
      upsertRecord(rec)
      return { ok: true, id: req.id, status: rec.status }
    }),

  // listPlatforms [forceRefresh] [--concurrency=N]：全部平台的登录状态（网络）
  // 并发度优先级：--concurrency=N > 第 2 个纯数字参数 > config.platformsCheckConcurrency > 6
  listPlatforms: async (args) => {
    const flag = args.find((a) => typeof a === 'string' && a.startsWith('--concurrency='))
    const numArg = args[1] && /^\d+$/.test(String(args[1])) ? Number(args[1]) : null
    const c = flag ? Number(flag.slice('--concurrency='.length)) : (numArg ?? checkConcurrency())
    return { platforms: await listPlatforms(args[0], c) }
  },

  // listRetained：列出留存目录（rejected=低分 / risk=高风险）文章
  // 2026-09-25：实现搬到 commands/publish.mjs 的 listRetained()（纯搬迁），
  // 与归档库共用"一次 listRecords 建 Map"的读法（容器 bind mount 上每篇省一次 stat）。
  listRetained: (_args) => listRetained(),

  // retainedAction <req.json>：留存库人工操作 req: { id, action: restore|delete }（2026-08-21 起移除 publish）
  retainedAction: (args) =>
    wrap('retainedAction failed: ', async () => {
      const req = JSON.parse(fs.readFileSync(args[0], 'utf8'))
      const found = findRetainedFile(req.id)
      if (!found) return { error: `留存目录无此文件: ${req.id}` }
      if (req.action === 'delete') {
        fs.unlinkSync(found.file)
        return { ok: true, id: req.id, action: 'delete', file: found.file }
      }
      if (req.action === 'restore') {
        stripFrontmatterRisk(found.file)
        const dest = path.join(getDraftsDir(), path.basename(found.file))
        fs.renameSync(found.file, dest)
        const rec = getRecord(req.id)
        if (rec && rec.status === 'retained') {
          rec.status = 'draft'
          rec.dir = null // 2026-08-30 脏数据修复：恢复后清 dir（rejected/risk → 顶层）
          delete rec.retainedDir
          delete rec.retainedReason
          rec.file = dest
          rec.history = rec.history || []
          rec.history.push({ action: 'restore', from: 'retained', at: new Date().toISOString() })
          upsertRecord(rec)
        }
        return { ok: true, id: req.id, action: 'restore', file: dest }
      }
      return { error: `未知操作: ${req.action}` }
    }),

  // classifyArticles：历史文章规则初筛风险分类（零 token；实现见 commands/classify.mjs）
  classifyArticles: (_args) => classifyArticles(),

  // setArticleRisk <id> <risk>：面板人工改分类
  setArticleRisk: (args) => {
    const id = args[0]
    const risk = String(args[1] || '')
      .trim()
      .toLowerCase()
    const VALID = ['ad', 'investment', 'pr', 'person', 'none', 'unclassified']
    if (!VALID.includes(risk)) return { error: `非法风险类型: ${risk}（可选 ${VALID.join('/')}）` }
    const rec = getRecord(id)
    if (!rec) return { error: `无记录: ${id}` }
    rec.risk = risk
    rec.riskSource = 'manual'
    upsertRecord(rec)
    return { ok: true, id, risk, riskSource: 'manual' }
  },

  // checkAuth <platform>：平台登录态校验
  checkAuth: async (args) => {
    const adapter = await getAdapter(args[0])
    if (!adapter) return { error: `unknown platform: ${args[0]}` }
    const auth = await adapter.checkAuth()
    return { platform: args[0], result: auth }
  },

  // syncArticle <req.json>：多平台存草稿
  syncArticle: async (args) => {
    const req = JSON.parse(fs.readFileSync(args[0], 'utf8'))
    return { results: await syncArticle(req) }
  },

  // syncStyledArticle <req.json>：req.article 带 style 字段（实现见 commands/cover-styles.mjs）
  syncStyledArticle: (args) =>
    wrap('render failed: ', async () => {
      const req = JSON.parse(fs.readFileSync(args[0], 'utf8'))
      return await syncStyledArticle(req)
    }),

  // extractArticle <url>：URL 提取文章（jsdom 懒加载，见 loadExtract）
  extractArticle: async (args) => {
    const { extractArticleFromUrl } = await loadExtract()
    return { article: await extractArticleFromUrl(args[0]) }
  },

  // extractActiveTab [selector]：读标签页 DOM（经扩展 page op readActiveTab，分块返回拼回 HTML）
  extractActiveTab: async (args) => {
    const { runtime } = await import('./commands/platforms.mjs')
    const r = await runtime.pageOp(null, 'readActiveTab', args[0] ? [args[0]] : [])
    if (!r || r.success === false) {
      return { article: null, error: (r && r.error) || '读取标签页失败' }
    }
    const html = (r.htmlChunks || []).join('')
    const { extractFromHtml } = await loadExtract()
    const article = extractFromHtml(html, r.url || 'about:blank')
    return { article, source: { tabTitle: r.title, selector: r.selector, len: r.len } }
  },

  // slotEnabled <slot>：定时门禁（接入方的定时脚本每次到点都会问一句）
  //
  // 为什么要有这条命令（v2.81）：槽位开关从 v2.77 起是**项目级**设置
  // （`<localRoot>/project-state/<id>/config.json` 的 `schedule`）。而 run_once.sh 此前
  // 直接读引擎 config.json 判 `schedule[slot] === false` —— 于是"Console 里看着是开的，
  // 到点却被 [SKIP]"（或反之）。两者必须同源，所以门禁改问引擎。
  //
  // 语义与旧门禁**逐字一致**：只有显式 `false` 才算关闭；未设 → 跑（fail-open）。
  // 目标项目：`--project=` / 请求上下文 > 本机唯一合法项目（launchd 侧没有上下文）。
  slotEnabled: (args) => {
    const slot = String(args[0] || '').trim()
    // v2.84：槽位可以是**动态**的（配置 slots 里自定义），所以只校验 id 形状，不再限定那 6 个。
    // 语义仍是"只有显式 false 才停"：没记录（含刚新增、还没进 schedule 的）→ 放行。
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(slot))
      return { error: `非法槽位 id: ${slot}（小写字母/数字/横线，字母开头）` }
    const already = currentProject()
    const project = already || soleProjectId()
    const compute = () => {
      const sched = (readConfig().schedule || {})[slot]
      return {
        slot,
        project: project || null,
        value: sched === undefined ? null : sched,
        // 只有显式 false 才停；未设照样跑（与 run_once.sh 的 fail-open 一致）
        run: sched !== false,
      }
    }
    return project && !already ? withProject(project, compute) : compute()
  },

  // proxyStatus：代理通道状态
  // P1：附加引擎与**接入契约**版本。接入方据此做兼容判断，而不是靠试错。
  // 桥未启动时 runtime 返回降级对象，此处的 version 仍可用（版本信息不该依赖桥）。
  proxyStatus: async (_args) => {
    const { runtime } = await import('./commands/platforms.mjs')
    const st = await runtime.proxyStatus()
    return { ...st, version: versionInfo() }
  },

  // proxyTest：验收：经代理通道请求 httpbin.org/headers，返回实际请求头
  proxyTest: async (_args) => {
    const { runtime } = await import('./commands/platforms.mjs')
    const resp = await runtime.fetch('https://httpbin.org/headers', {
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    })
    const text = await resp.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text.slice(0, 300) }
    }
    const h = parsed.headers || {}
    return {
      status: resp.status,
      url: resp.url,
      headers: h,
      looksBrowserLike: {
        hasChromeUA: /Chrome\//.test(h['User-Agent'] || ''),
        hasSecFetch: /^fetch$/.test(h['Sec-Fetch-Mode'] || '') || !!h['Sec-Fetch-Mode'],
        userAgent: h['User-Agent'],
        acceptLanguage: h['Accept-Language'],
      },
    }
  },

  // uploadImageFile <file> [platform]：本地图片上传到平台图床
  uploadImageFile: async (args) => {
    const file = args[0]
    const platform = args[1] || 'zhihu'
    if (!file || !fs.existsSync(file)) return { error: `file not found: ${file}` }
    const adapter = await getAdapter(platform)
    if (!adapter) return { error: `unknown platform: ${platform}` }
    if (typeof adapter.uploadImage !== 'function')
      return { error: `platform ${platform} does not support image upload` }
    const buf = fs.readFileSync(file)
    const blob = new Blob([buf], { type: 'image/png' })
    const url = await adapter.uploadImage(blob)
    return { url, platform }
  },

  // listStyles：列出可用样式（内置 + custom；实现见 commands/cover-styles.mjs）
  listStyles: () => listStyles(),

  // renderPreview <mdPath> <style> [--out-html <path>]（纯本地；实现见 commands/cover-styles.mjs）
  renderPreview: (args) => wrap('', () => renderPreview(args)),

  // listCoverTemplates → 封面/结束语模板名（实现见 commands/cover-styles.mjs）
  listCoverTemplates: () => listCoverTemplates(),

  // generateCover <title> <template> [--out-dir] [--subtitle] [--tag] → 双尺寸封面 PNG（实现见 cover-styles.mjs）
  generateCover: (args) => wrap('generateCover failed: ', () => generateCover(args)),

  // generateCoverGallery <title> [--out-dir] [--subtitle] [--tag] → 模板画廊拼图
  generateCoverGallery: (args) =>
    wrap('generateCoverGallery failed: ', () => generateCoverGallery(args)),

  // generateEndingCard [--template <t>] [--out <path>] → 结尾结束语图片 PNG
  generateEndingCard: (args) => wrap('generateEndingCard failed: ', () => generateEndingCard(args)),

  // wechatDraft <req.json>：官方 API 通道建微信草稿（恒草稿；实现见 commands/wechat.mjs）
  wechatDraft: (args) => {
    const req = JSON.parse(fs.readFileSync(args[0], 'utf8'))
    return wrap('wechatDraft failed: ', async () => await wechatDraft(req))
  },

  // wechatDrafts：官方 API 通道草稿列表
  wechatDrafts: (_args) => wrap('wechatDrafts failed: ', async () => await wechatDrafts()),

  // wechatDraftDelete <mediaId>：删除官方通道草稿
  wechatDraftDelete: (args) =>
    wrap('wechatDraftDelete failed: ', async () => await wechatDraftDelete(args[0])),

  // analyzeStyle <url|htmlPath> [--name custom-xxx]：提取样式（实现见 commands/cover-styles.mjs）
  analyzeStyle: (args) => wrap('analyzeStyle failed: ', () => analyzeStyle(args)),

  // styles <sub> ... 子命令（实现见 commands/cover-styles.mjs）
  styles: (args) => styles(args),

  // ── 选题库（topic-pool.json）：**唯一写入实现**，供项目侧写入器转发 ──
  //
  // 为什么放在引擎侧（2026-10-04 的决定）：同一份选题库有两个写入者（引擎回填 + 项目侧
  // 候选入库），而行形状/合并规则/锁此前只写在项目侧脚本的注释与 SOP 里。结果项目侧少给
  // 一个字段（4 元组）就把分数写进 `title`、把原因写进 `status`，静默写坏 4 条，下游
  // （Console 渲染、引擎统计）跟着错。现在契约与实现都在 `topic-pool.mjs`，项目侧只做转发。
  //
  // 三个方法都**故意走内部面**（登记在 surface-contract 的 INTERNAL_ONLY 里）：
  // 它们是接入方脚本的写入通道，不是给 AI 会话用的工具面。
  //
  // 失败一律 **throw** 而不是返回 `{error}`：这样 CLI 以退出码 1 结束，项目侧脚本可以
  // 直接把退出码透传给流水线——"写坏数据"必须是一次响亮失败。
  topicPoolUpsert: (args) => runTopicPoolUpsert(args),
  topicPoolValidate: (args) => runTopicPoolValidate(args),
  topicPoolShow: (args) => runTopicPoolShow(args),

  // ── AI 检测（朱雀 @makers/zhuque-text，2026-10-05）──
  //
  // 为什么放引擎侧：检测能力是**通用的**（任何接入方项目都想知道"这篇像不像 AI 写的"），
  // 而凭证解析（env / .env，绝不落 config.json）、用量台账（.local/ai-detect-usage.json）、
  // markdown 剥离与偏移映射都是引擎的运行态关注点。项目侧只负责"什么时候检测、不达标怎么办"
  // 这套写作政策（见 ai2writing SKILL §5.55）。
  //
  // 暴露为 MCP 工具 `ai_detect`（AI 会话侧），同时项目脚本/基线回测可走 CLI（同一个实现）。
  aiDetect: (args) => runAiDetect(args),
}

/**
 * 内容域**写**方法：它们的 `args[0]` 要么是草稿 id，要么是请求 JSON 文件（含 `id` / `file`）。
 *
 * 只有这些方法需要"按草稿归属纠正域"（见 `draftScopeOverride`）：读方法保持跟随上下文，
 * 视图语义不能因为"默认域里恰好有一篇项目草稿"就换域。
 */
const DRAFT_SCOPED_METHODS = new Set([
  'publishArticle',
  'updateDraft',
  'archiveArticle',
  'retainArticle',
  'retainedAction',
  'setArticleStatus',
  'markPublished',
  'deleteDraft',
  'setArticleRisk',
  'publishDouyin',
])

/** 从请求参数里取出"这条草稿是谁"：`{file}` 优先，其次 `{id}`（取不到 → null） */
function draftRefOf(method, args) {
  if (!DRAFT_SCOPED_METHODS.has(method)) return null
  const first = typeof args[0] === 'string' ? args[0].trim() : ''
  if (!first) return null
  if (first.endsWith('.json')) {
    try {
      const req = JSON.parse(fs.readFileSync(first, 'utf8'))
      if (typeof req.file === 'string' && req.file.trim()) return { file: req.file.trim() }
      if (typeof req.id === 'string' && req.id.trim()) return { id: req.id.trim() }
      return null
    } catch {
      return null // 读不动就交给 handler 自己报错，这里不越权
    }
  }
  // `deleteDraft <id>` / `setArticleRisk <id> <risk>`
  return { id: first }
}

/**
 * 唯一分发口（CLI 与 IPC 共用）。
 *
 * v2.106：先按显式 `--project=` 建立上下文，再检查"这条草稿属于哪个项目"——
 * 若归属明确且与当前上下文不同，则**按归属执行**（并把 `projectDerived` 写进响应，
 * 让调用方看得见这次纠正）。事故背景与判据见 `project-context.mjs` 的
 * `projectOwningDraftFile`。
 */
/**
 * 处置类方法（留存/归档）的入参：既支持 `<req.json>` 文件，也支持一行式
 * `--id=/--dir=/--reason=/--restore`。两种形态落到同一个 req 对象。
 */
function dispositionRequest(args) {
  const first = Array.isArray(args) ? args[0] : undefined
  if (first && !String(first).startsWith('--')) {
    return JSON.parse(fs.readFileSync(first, 'utf8'))
  }
  const f = parseFlags(args, { booleans: ['restore'] })
  const req = { id: f.id }
  if (f.dir !== undefined) req.dir = f.dir
  if (f.reason !== undefined) req.reason = f.reason
  if (f.restore !== undefined) req.restore = f.restore === true
  return req
}

async function dispatch(method, rest, project) {
  const handler = HANDLERS[method]
  if (!handler) return { error: `unknown method: ${method}` }
  return await withProject(project, async () => {
    const override = draftScopeOverride(draftRefOf(method, rest))
    if (!override) return await handler(rest)
    console.error(
      `[content-domain] ${method}: 草稿归属项目 ${override}（当前上下文=${currentProject() || '默认域'}），按其归属执行`,
    )
    const out = await withProject(override, () => handler(rest))
    return out && typeof out === 'object' && !Array.isArray(out)
      ? { ...out, projectDerived: override }
      : out
  })
}

/**
 * 主入口（非 IPC）：args = process.argv.slice(2)（[method, ...rest]），
 * rest 即 method 后全部参数，原样传给对应 handler。
 *
 * 2026-09-19（v2.22）：与 IPC 同样的 `--project=<id>` 收口——CLI 与 IPC 共用一套
 * 项目语义（`node cli.mjs listArticles --project=my-writing`）。
 */
async function main(args = process.argv.slice(2)) {
  const { project, args: stripped } = extractProjectFlag(args)
  const [method, ...rest] = stripped
  return await dispatch(method, rest, project)
}

// IPC 常驻模式（bridge 复用同一 Node 进程，消除每次冷启动）
// 源码：https://github.com/dos2un1x/crosspost（作者 dos2un1x）
async function ipcLoop() {
  const rl = process.stdin
  let buf = ''
  let queue = Promise.resolve()
  rl.setEncoding('utf8')
  rl.on('data', (chunk) => {
    buf += chunk
    // 2026-08-28 D3：单行超 1MB 视为异常输入，丢弃防内存膨胀
    if (buf.length > 1024 * 1024) {
      buf = ''
      process.stderr.write('[cli] IPC 输入超限(>1MB)，已丢弃\n')
      return
    }
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      // 串行处理：每个请求等上一个完成（handler 内可能有共享文件状态，如 douyinCurrent 互斥）
      queue = queue.then(() => handleIpcLine(line))
    }
  })
  rl.on('end', () => process.exit(0))
}

async function handleIpcLine(line) {
  let req
  try {
    req = JSON.parse(line)
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: 'ipc 请求解析失败: ' + e.message }) + '\n')
    return
  }
  if (req.method === 'exit') {
    process.exit(0)
  }
  try {
    const out = await runIpcMethod(req.method, req.args)
    process.stdout.write(JSON.stringify({ seq: req.seq, ...out }) + '\n')
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        seq: req.seq,
        error: String((e && e.message) || e),
        ...((e && e.fields) || {}),
        stack: ((e && e.stack) || '').split('\n').slice(0, 6),
      }) + '\n',
    )
  }
}

/**
 * IPC 单请求执行：method + 请求 args（args[0] 即 method，与 CLI 命令行一致）→ 直接调 handler，
 * handler 收到的 args 即 method 后全部参数（styles 子命令 / --flag 全量传入）。无任何全局可变状态。
 *
 * 2026-09-19（v2.22）：`--project=<id>` 在此**唯一收口**——先从 args 摘除（不干扰各
 * handler 的位置参数），再在项目上下文中执行 handler。此后整条调用链上的
 * `getDraftsDir()` / `getArticlesDir()` 自动落在该项目目录里。无该标志时行为不变。
 *
 * 2026-09-22（v2.106）：与 CLI 共用 `dispatch()` —— 于是"按草稿归属纠正域"对
 * 常驻 worker（Console 走的路）与一次性 CLI（MCP 走的路）**同时生效**。
 */
async function runIpcMethod(method, args) {
  const { project, args: rest } = extractProjectFlag(Array.isArray(args) ? args.slice(1) : [])
  return await dispatch(method, rest, project)
}

// 适配器/核心库的 console 日志捕获（2026-08-24 logger 改造）：
// stdout 是唯一业务输出通道（JSON 行），核心库内部 console.* 会污染它。
// 覆盖 console 并收集到日志缓冲，进程退出时统一写 stderr。
// 说明：核心库为 dist 构建产物，无法注入 logger 实例，覆盖是唯一不改核心的隔离手段；
// 新业务代码应避免 console.* 而直接 throw / 返回 error 字段。
function installCliLogger() {
  const origLog = console.log
  const origWarn = console.warn
  const origError = console.error
  const logs = []
  // 2026-08-28：捕获同时直写 stderr（[cli] 前缀）——IPC 常驻 worker 永不执行 restore，
  // 仅缓冲会导致核心库日志永久丢失且内存泄漏；stderr 不影响 stdout 的 JSON 业务通道
  const emit = (a) => {
    const msg = a.map((x) => (typeof x === 'string' ? x : safeJson(x))).join(' ')
    logs.push(msg)
    try {
      process.stderr.write('[cli] ' + msg + '\n')
    } catch {
      /* stderr 关闭时忽略 */
    }
    return msg
  }
  console.log = (...a) => {
    emit(a)
  }
  console.warn = (...a) => {
    emit(a)
  }
  console.error = (...a) => {
    emit(a)
  }

  function safeJson(x) {
    try {
      return JSON.stringify(x)
    } catch {
      return String(x)
    }
  }

  return {
    restore: () => {
      console.log = origLog
      console.warn = origWarn
      console.error = origError
    },
    logs,
  }
}

{
  const logger = installCliLogger()
  const IPC_MODE = process.argv.includes('--ipc')
  if (IPC_MODE) {
    ipcLoop()
  } else {
    main()
      .then((out) => {
        process.stdout.write(JSON.stringify(out) + '\n')
      })
      .catch((e) => {
        process.stdout.write(
          JSON.stringify({
            error: String((e && e.message) || e),
            // 错误对象可带 `fields`（见 wrap 的说明）：机器可读上下文别在信封里丢掉
            ...((e && e.fields) || {}),
            stack: ((e && e.stack) || '').split('\n').slice(0, 6),
          }) + '\n',
        )
        process.exitCode = 1
      })
      .finally(() => {
        logger.restore()
        if (logger.logs.length)
          process.stderr.write('[native-cli] ' + logger.logs.join('\n') + '\n')
      })
  }
}
