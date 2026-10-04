// DSH 客户端本地补丁脚本的契约测试（2026-10-04）
//
// 这份补丁改的是 **DSH 安装目录里的构建产物**，所以它比普通的仓库内改动更危险：
//   · 改错位置 → 客户端照样加载，只是行为没变（最坏情况是整个界面打不开）；
//   · 被升级冲掉 → 静默回到"空会话里指令结果不可见"，没人会发现；
//   · 版本漂移 → 上游那行字符串变了，脚本必须**报错**而不是猜着改。
// 因此这里用**假部署**（临时目录里的同名包布局）把四条契约钉住：
// 幂等、可还原、语法坏就回滚（脚本内做）、匹配不到就失败且不动文件。
// 假部署让它在任何机器上都能跑，也不碰真 DSH 安装。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(REPO, 'preset', 'patches', 'dsh-blank-session-command-nodes.sh')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-dsh-patch-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

/** 上游那段判定的精确原文（与脚本内一致；漂移时这里也会红） */
const ORIG =
  'isActive: (snapshot) => snapshot.order.some((key) => snapshot.nodes.get(key)?.kind !== "command")'

const CLIENT_REL = 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'

/** 造一个假部署；`variant` = 'upstream'（可打）| 'drift'（上游已改，匹配不到）| 'missing'（无该文件） */
function makeFakeDeploy(name, variant = 'upstream') {
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-`))
  const file = path.join(dir, CLIENT_REL)
  if (variant === 'missing') return { dir, file }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body =
    variant === 'upstream'
      ? `const chatViewDefinition = {\n  target: "chat",\n  create: () => new ChatSnapshotBuilder(),\n  ${ORIG}\n};\nexport { chatViewDefinition };\n`
      : `const chatViewDefinition = {\n  target: "chat",\n  create: () => new ChatSnapshotBuilder(),\n  isActive: () => true\n};\nexport { chatViewDefinition };\n`
  fs.writeFileSync(file, body)
  return { dir, file }
}

const run = (deployDir, ...args) =>
  spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_DEPLOY: deployDir,
      DSH_BIN: process.execPath, // 脚本只拿它取 `--version` 做展示，node 足够
    },
  })

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

test('本地补丁：打 → 幂等 → 还原，且备份文件是"打过补丁"的标记', () => {
  const { dir, file } = makeFakeDeploy('patch-happy')
  const original = sha(file)

  const status0 = run(dir, '--status')
  assert.equal(status0.status, 0)
  assert.match(status0.stdout, /未打补丁/)

  const patch = run(dir)
  assert.equal(patch.status, 0, patch.stderr)
  assert.match(patch.stdout, /补丁已应用/)
  assert.match(fs.readFileSync(file, 'utf8'), /snapshot\.order\.length > 0/, '补丁串必须写进文件')
  assert.ok(fs.existsSync(`${file}.orig-before-crosspost-patch`), '必须留下备份（也是已完成标记）')

  const patched = sha(file)
  const again = run(dir)
  assert.equal(again.status, 0)
  assert.match(again.stdout, /已在位/)
  assert.equal(sha(file), patched, '幂等：第二次不得再改文件')

  const status1 = run(dir, '--status')
  assert.match(status1.stdout, /补丁已应用/)

  const revert = run(dir, '--revert')
  assert.equal(revert.status, 0)
  assert.match(revert.stdout, /已从备份还原/)
  assert.equal(sha(file), original, '还原必须逐字节回到原样')
  assert.ok(!fs.existsSync(`${file}.orig-before-crosspost-patch`), '还原后备份应删除')
})

test('本地补丁：上游改过（匹配不到）→ 明确失败且不动文件', () => {
  const { dir, file } = makeFakeDeploy('patch-drift', 'drift')
  const before = sha(file)
  const r = run(dir)
  assert.notEqual(r.status, 0, '匹配不到就不能"猜着改"——必须判负')
  assert.match(`${r.stdout}${r.stderr}`, /版本|漂移|未找到/)
  assert.equal(sha(file), before, '失败时不得改动文件')
  assert.ok(!fs.existsSync(`${file}.orig-before-crosspost-patch`), '失败时不得留下备份')
})

test('本地补丁：目标文件不存在（该部署没有 Web 客户端）→ 明确失败', () => {
  const { dir } = makeFakeDeploy('patch-missing', 'missing')
  const r = run(dir)
  assert.notEqual(r.status, 0)
  assert.match(`${r.stdout}${r.stderr}`, /找不到客户端产物/)
})

test('本地补丁：没有备份时也能反向还原（备份被清理掉的情形）', () => {
  const { dir, file } = makeFakeDeploy('patch-revert-nobak')
  assert.equal(run(dir).status, 0)
  fs.rmSync(`${file}.orig-before-crosspost-patch`)
  const r = run(dir, '--revert')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /反向替换/)
  assert.ok(!fs.readFileSync(file, 'utf8').includes('snapshot.order.length > 0'))
})
