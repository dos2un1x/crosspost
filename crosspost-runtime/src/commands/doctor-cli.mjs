#!/usr/bin/env node
/**
 * 环境自检命令入口：
 *   node crosspost-runtime/src/commands/doctor-cli.mjs [--json]
 *   （等价于 npm run doctor）
 *
 * 退出码：0 = 无失败项；1 = 存在 ✖
 */
import { runDoctor, formatReport } from '../doctor.mjs'
import { SEVERITY } from '../preflight.mjs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const wsArg = argv.find((a) => a.startsWith('--ws-port='))
const httpArg = argv.find((a) => a.startsWith('--http-port='))

const report = await runDoctor({
  ...(wsArg ? { wsPort: Number(wsArg.split('=')[1]) } : {}),
  ...(httpArg ? { httpPort: Number(httpArg.split('=')[1]) } : {}),
})

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  process.stdout.write(formatReport(report))
}

process.exit(report.checks.some((c) => c.severity === SEVERITY.FAIL) ? 1 : 0)
