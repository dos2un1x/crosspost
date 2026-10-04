#!/usr/bin/env node
/**
 * 三库入口性能对照（原生 vs 容器，2026-09-25 加）
 *
 * 为什么需要：留存库 / 归档库 / 报表在**容器模式**下曾比原生慢 6–7×，根因是
 * Docker Desktop 的 bind mount 让每次小文件读从 ~0.07ms 变成 ~0.5ms，而这三个入口
 * 每次打开要读几百个记录文件。修法是记录层快照（见 `articles.mjs` 的快照缓存段）。
 *
 * 这个脚本就是那条结论的**可复跑证据**，宿主与容器里跑同一个文件：
 *
 *   node crosspost-runtime/tests/bench-views.mjs                 # 宿主
 *   node crosspost-runtime/tests/bench-views.mjs --project=<项目 id>
 *   docker compose exec crosspost node $CROSSPOST_REPO/crosspost-runtime/tests/bench-views.mjs
 *
 * 期望：两个形态都应在首次调用（建立快照）之后落到几十毫秒内，且"稳态记录读"为 0。
 * 若容器里稳态读又变成几百次，说明快照失效了（例如目录 mtime 判活被破坏）。
 */
import { withProject } from '../src/project-context.mjs'
import { soleProjectId } from '../src/resources.mjs'

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const art = await import('../src/articles.mjs')
const { listArchive, listRetained } = await import('../src/commands/publish.mjs')
const { allCostRecords } = await import('../src/commands/costs.mjs')

const RUNS = Number(arg('runs', '4'))
const project = arg('project', '') || soleProjectId() || ''

const cases = [
  ['listArticles', () => art.scanAndList()],
  ['listArchive', () => listArchive()],
  ['listRetained', () => listRetained().retained],
  ['allCostRecords', () => allCostRecords()],
]

await withProject(project, async () => {
  console.log(
    `形态: ${process.env.CROSSPOST_IN_CONTAINER ? '容器' : '原生/宿主'}  ·  项目: ${project || '(默认域)'}`,
  )
  console.log(`记录目录: ${art.getArticlesDir()}`)
  console.log('─'.repeat(72))
  for (const [name, fn] of cases) {
    const ts = []
    let n = 0
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now()
      n = fn().length
      ts.push(Math.round(performance.now() - t0))
    }
    // 稳态记录读次数：预热已由上面的循环完成
    art.resetRecordIoStats()
    fn()
    const st = art.recordIoStats()
    console.log(
      `${name.padEnd(15)} ${ts
        .map((t) => `${t}ms`)
        .join(' ')
        .padEnd(28)} ` +
        `n=${String(n).padEnd(5)} 稳态记录读=${st.reads} 次 / 全量重扫=${st.scans} 次`,
    )
  }
  console.log('─'.repeat(72))
  console.log('判据：首项之后应降到几十毫秒内，且稳态记录读 = 0（旧实现是每篇一次）。')
})
