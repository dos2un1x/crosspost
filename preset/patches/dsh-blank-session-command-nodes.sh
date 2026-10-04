#!/bin/bash
# 本地补丁：让「只有斜杠指令的空会话」也能看到指令结果（CrossPost 侧维护，非 DSH 上游）
#
# 为什么需要它（2026-10-04，逐行定位到客户端）：
#
#   `/crosspost-*` 这类指令的执行结果被渲染成**流程节点**，而聊天流程视图自己只在
#   「存在非 command 节点」时才算活跃：
#
#       // @deepseek-ai/dsh-client-ui-chat → chatViewDefinition
#       isActive: (snapshot) => snapshot.order.some((key) => snapshot.nodes.get(key)?.kind !== "command")
#
#   于是**全新空会话**里敲一条指令时：
#     · activeTargets 为空（唯一节点是 command）
#     · session.blank 为真、又不在 running → 阶段判定落到 "blank"
#     · 客户端在 blank 阶段渲染的是**欢迎页（hero）**，指令卡片被盖住
#   结果就是：指令其实执行了（服务端 `command/run` / `command/done` 都有日志、内容也对），
#   但界面上什么都没有。空会话里跑 `/compact`、`/goal` 同样看不到——不是本预设特有的问题。
#
# 补丁 = 在上面的判断后补一句「只要有节点就算活跃」（`|| snapshot.order.length > 0`）：
#   · 空会话里执行指令 → 阶段变 active → 指令卡片正常显示；
#   · 真正一条消息都没有的空会话（order 为空）→ 仍然判 inactive → 欢迎页照旧。
#
# ⚠ 代价与寿命：补丁改的是 **DSH 安装目录里的构建产物**
#   （`<部署>/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js`），
#   **npx 重新安装或升级 DSH 会把它冲掉**。冲掉后重放本脚本即可（幂等）。
#   `preset/upgrade-check.sh` 第 0 节会在"曾经打过补丁但补丁已不在"时提醒。
#
# 用法：
#   bash preset/patches/dsh-blank-session-command-nodes.sh            # 打补丁（幂等）
#   bash preset/patches/dsh-blank-session-command-nodes.sh --status   # 只看状态，不写盘
#   bash preset/patches/dsh-blank-session-command-nodes.sh --revert    # 还原（优先用备份）
# 环境变量：
#   DSH_BIN       dsh 启动器路径（默认 `command -v dsh`，再退回 ~/.local/bin/dsh）
#   DSH_DEPLOY    DSH 部署目录（默认从启动器 realpath 推导）
#   DSH_CLIENT    client.js 路径（默认 <部署>/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js）
# 退出码：0 = 目标状态已达成（打好 / 已还原 / 本来就是）；1 = 失败（找不到文件、版本漂移）
set -uo pipefail

MODE="patch"
case "${1:-}" in
  --status) MODE="status" ;;
  --revert) MODE="revert" ;;
  "" ) ;;
  *) printf '未知参数: %s（可用 --status / --revert）\n' "$1" >&2; exit 1 ;;
esac

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  printf '\033[31m✖\033[0m 找不到 node（语法校验需要它）\n' >&2
  exit 1
fi

DSH_BIN="${DSH_BIN:-$(command -v dsh 2>/dev/null || true)}"
[ -n "$DSH_BIN" ] || DSH_BIN="$HOME/.local/bin/dsh"

DEPLOY="${DSH_DEPLOY:-}"
if [ -z "$DEPLOY" ]; then
  live="$("$NODE_BIN" -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$DSH_BIN" 2>/dev/null || true)"
  case "$live" in
    */node_modules/@deepseek-ai/dsh/lib/bin.js) DEPLOY="${live%/node_modules/@deepseek-ai/dsh/lib/bin.js}" ;;
  esac
fi
if [ -z "$DEPLOY" ] || [ ! -d "$DEPLOY" ]; then
  printf '\033[31m✖\033[0m 无法确定 DSH 部署目录（用 DSH_DEPLOY=<目录> 显式指定）\n' >&2
  printf '      dsh 启动器: %s\n' "${DSH_BIN:-（未找到）}" >&2
  exit 1
fi

CLIENT="${DSH_CLIENT:-$DEPLOY/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js}"
if [ ! -f "$CLIENT" ]; then
  printf '\033[31m✖\033[0m 找不到客户端产物: %s\n' "$CLIENT" >&2
  printf '      该部署可能没有 web 客户端（或 DSH 改了包布局）——本补丁只对装了 Web UI 的部署有意义\n' >&2
  exit 1
fi

VER="$("$DSH_BIN" --version 2>/dev/null | head -1)"

"$NODE_BIN" --input-type=module - "$CLIENT" "$MODE" <<'JS'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const [target, mode] = process.argv.slice(2)
const BACKUP = target + '.orig-before-crosspost-patch'

/** 上游原文：chatViewDefinition 的活跃判定（按**精确字符串**匹配，改不动就报版本漂移） */
const ORIG =
  'isActive: (snapshot) => snapshot.order.some((key) => snapshot.nodes.get(key)?.kind !== "command")'
/** 补丁后：只要有节点就算活跃（真正空会话 order 为空 → 仍 inactive → 欢迎页保留） */
const PATCHED = ORIG + ' || snapshot.order.length > 0'

const ok = (m) => console.log('  \x1b[32m✔\x1b[0m ' + m)
const warn = (m) => console.log('  \x1b[33m⚠\x1b[0m ' + m)
const bad = (m) => console.log('  \x1b[31m✖\x1b[0m ' + m)

const src = fs.readFileSync(target, 'utf8')
const hasOrig = src.includes(ORIG)
const hasPatched = src.includes(PATCHED)
const hasBackup = fs.existsSync(BACKUP)

console.log(`目标: ${target}`)
console.log(`备份: ${hasBackup ? BACKUP : '（无）'}`)

if (mode === 'status') {
  if (hasPatched) ok('补丁已应用（空会话里的指令结果可见）')
  else if (hasOrig) warn('未打补丁（空会话里只有指令节点时，结果会被欢迎页盖住）')
  else bad('既没有上游原文也没有补丁串——DSH 版本可能变了，需重新定位那段判定')
  process.exit(hasPatched || hasOrig ? 0 : 1)
}

if (mode === 'revert') {
  if (hasBackup) {
    fs.copyFileSync(BACKUP, target)
    fs.rmSync(BACKUP)
    ok('已从备份还原（备份已删除）')
    process.exit(0)
  }
  if (hasPatched) {
    fs.writeFileSync(target, src.replace(PATCHED, ORIG))
    ok('已反向替换回上游原文（没有备份文件）')
    process.exit(0)
  }
  warn('没有备份、也没有补丁串——无需还原')
  process.exit(0)
}

// patch
if (hasPatched) {
  ok('补丁已在位（幂等，未改动文件）')
  process.exit(0)
}
if (!hasOrig) {
  bad('未找到待替换的上游片段，版本可能已变——请重新定位 chatViewDefinition 的 isActive')
  console.log('      期望原文: ' + ORIG)
  process.exit(1)
}
if (!hasBackup) fs.copyFileSync(target, BACKUP)
const patched = src.replace(ORIG, PATCHED)
fs.writeFileSync(target, patched)

// 语法自检：写到临时 .mjs 再交给 node --check（client.js 是 ESM 构建产物，
// 直接 --check 会按 CJS 解析而误报）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-client-patch-'))
const tmp = path.join(tmpDir, 'check.mjs')
fs.writeFileSync(tmp, patched)
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
} catch (error) {
  // 语法坏了就立刻回滚，绝不留下一个打不开的客户端
  if (hasBackup) fs.copyFileSync(BACKUP, target)
  else fs.writeFileSync(target, src)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  bad('补丁后语法校验失败，已回滚：' + String(error.stderr || error.message).split('\n')[0])
  process.exit(1)
}
fs.rmSync(tmpDir, { recursive: true, force: true })
ok('补丁已应用，语法校验通过')
console.log('  下一步：刷新浏览器页面（客户端产物是浏览器去取的，刷新即重新加载）')
JS
RC=$?

if [ "$RC" -eq 0 ] && [ "$MODE" = "patch" ]; then
  printf '\n部署: %s（%s）\n' "$DEPLOY" "${VER:-版本未知}"
  printf '注意：npx 重新安装 / 升级 DSH 会覆盖该文件——升级后重放本脚本即可\n'
  printf '      （preset/upgrade-check.sh 第 0 节会在补丁被冲掉时提醒）\n'
fi
exit "$RC"
