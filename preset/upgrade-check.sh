#!/bin/bash
# DSH 升级后自检（2026-09-12 建立）
#
# 背景：2026-09-10 的 DSH 升级连续打坏了三处依赖，每处都只有"用户反馈"才被发现：
#   ① 人设配置键改名（dsh-persona: text→prefix/suffix；dsh-system-prompt: persona→personaPrefix/personaSuffix）
#   ② 插件按仓库布局写死相对深度（../../../crosspost-runtime），从 ~/.dsh/.agent-presets 挂载时解析错
#   ③ 预设 package.json 有 name 无 version → dsh-plugin-package-inventory-deepseek 抛错 →
#      该预设下每个请求都失败：DeepSeek request extension preparation failed / REQUEST_EXTENSION
# 本脚本把这些检查固化成一条命令，升级后跑一次即可。
#
# 用法:
#   bash ~/.dsh/upgrade-check.sh
#   DSH_HOME=... REPO_PRESETS=... bash preset/upgrade-check.sh
# 退出码: 0 = 无失败项；1 = 有 ✖
#
# ⚠ 2026-09-19（v2.49）**本脚本不是"零写入"的检查**——跑之前请知道它的写入足迹：
#
#   第 5 节对每个 profile 跑 `dsh --profile <名> --dump-config`，而 **DSH 自己会重写**
#   各 profile 的 `cordis.yml` 样板文件（内容是固定的 3 行注释 + `[]`，逐字不变），
#   另外每次 dsh 调用都会更新 `~/.dsh/storages/workspace.json`。
#   实测跑一次的足迹：
#     ~/.dsh/profiles/<各 profile>/cordis.yml  ← 内容不变，mtime 变
#     ~/.dsh/storages/workspace.json                                    ← DSH 自己的登记表
#
#   为什么必须写在明处：不写清就会被它误导——检查完发现某个 profile 里的
#   `cordis.yml` 成了"今天刚改过"，一度以为有人动了那个 profile。
#   真正决定 profile 行为的是 `cordis.patch.yml` 与 `package.json`，那两个**不会被碰**；
#   launchd 的 6 个槽位 plist 也不会被碰。但"跑一次检查，几个 profile 文件 mtime 全变"
#   这件事若不说清，任何"文件有没有被改动"的核对都会误判。
#
# ⚠ 2026-10-03（DSH 0.2.0-rc.2）**预设的载体换了，本脚本跟着换**：
#
#   0.2.0 起 `$DSH_HOME/.agent-presets/<id>/`（`preset.yml` + `agent.cordis.yml`）
#   **不再被任何代码读取**（`@deepseek-ai/dsh-agent-preset` 的
#   `editing-cordis-compositions` skill: "Nothing reads that directory any more"）。
#   预设现在 = bundle patch 里的一条 `@deepseek-ai/dsh-agent-preset` 声明行，
#   `config.plugins` 才是条目列表；bundle 经 profile 的 `dsh.profile.bundles` 装载。
#
#   于是检查点整体改写：
#     · 不再扫 `.agent-presets/*/`，改扫各 profile patch + 已安装 bundle 的 patch；
#     · 新增「预设行名在当前部署中可达」——**本次 `dsh-workflow-worker-thread` 就是这样
#       被换名的**，旧脚本会漏掉它（那一行会静默消失，能力少一个而没人报错）；
#     · 相对行（`./plugins/*.js`）按 patch 文件所在目录解析，逐条断言文件存在；
#     · bundle 必须声明 `dsh.bundle.patch`，否则安装器判 `not-a-bundle`。
set -uo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_BIN="${DSH_BIN:-$HOME/.local/bin/dsh}"
REPO_PRESETS="${REPO_PRESETS:-$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)}"
UNZSTD="$(command -v unzstd || true)"
TMP="$(mktemp -d /tmp/dsh-upgrade-check.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# node 路径（2026-09-19 v2.38）：此前写死 /usr/local/bin/node，与本仓库
# bridge/install-launchd.sh 是同一处缺陷——Apple Silicon 的 Homebrew 在
# /opt/homebrew/bin，nvm/asdf/fnm 在用户目录下。第 3 节要 spawn node 做
# "fresh 进程导入 preset 插件"，路径错了会报成"插件导入失败"，误导排查方向。
# 现在：CROSSPOST_NODE > PATH 上的 node > 常见绝对路径兜底。
resolve_node() {
  if [ -n "${CROSSPOST_NODE:-}" ]; then
    printf '%s' "$CROSSPOST_NODE"
    return 0
  fi
  local found
  found="$(command -v node 2>/dev/null || true)"
  if [ -n "$found" ]; then
    printf '%s' "$found"
    return 0
  fi
  local p
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.local/bin/node"; do
    if [ -x "$p" ]; then
      printf '%s' "$p"
      return 0
    fi
  done
  printf ''
}
NODE="$(resolve_node)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  printf '\033[31m✖\033[0m 找不到可执行的 node（第 3 节需要它做 fresh 进程导入）\n' >&2
  printf '      用 CROSSPOST_NODE 显式指定：CROSSPOST_NODE=$(command -v node) bash %s\n' "$0" >&2
  exit 1
fi

# REPO_PRESETS 默认从**脚本自身的真实路径**推导（它常被软链到 ~/.dsh/upgrade-check.sh），
# 不再假设仓库一定在固定位置（例如 ~/crosspost）—— 软链会经 realpath 解析回仓库里的 preset/ 目录。
if [ ! -d "$REPO_PRESETS" ]; then
  printf '\033[33m⚠\033[0m REPO_PRESETS 不存在: %s（可用 REPO_PRESETS=... 覆盖）\n' "$REPO_PRESETS" >&2
fi

PASS=0; FAIL=0; WARN=0
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✖\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; WARN=$((WARN+1)); }
sec()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
# © dos2un1x · https://github.com/dos2un1x/crosspost
hint() { printf '      ↳ %s\n' "$*"; }
# 会话文件按 mtime 倒序（最新在前）。
#
# 为什么不用 `find … | xargs -0 ls -t`：**GNU xargs 在空输入时仍会执行一次 `ls -t`**，
# 于是它列的是**当前目录**——干净环境（会话目录不存在/为空）下"最新会话"会变成
# ./config.json，第 8 节当场假红（2026-10-04 CI 实测）。BSD xargs 空输入不执行命令，
# 所以这个坑只在 Linux 上炸。自己按 mtime 排：空集合就是空输出，与平台无关。
# `stat` 两套写法互斥：GNU `-c %Y` / BSD `-f %m`，先 GNU 后 BSD。
session_files_by_mtime() {
  find "$DSH_HOME/sessions" -name 'session*.jsonl*' -type f 2>/dev/null | while IFS= read -r f; do
    mt="$(stat -c '%Y' "$f" 2>/dev/null || stat -f '%m' "$f" 2>/dev/null || echo 0)"
    printf '%s\t%s\n' "$mt" "$f"
  done | sort -rn | cut -f2-
}
realpath_py() { python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$1"; }

# ── 0. 部署与启动链 ──────────────────────────────────────────────────────
sec "0. 部署与启动链"
LIVE_BIN="$(realpath_py "$DSH_BIN" 2>/dev/null || echo '')"
DEPLOY=""
if [ -n "$LIVE_BIN" ] && [ -f "$LIVE_BIN" ]; then
  DEPLOY="$(printf '%s' "$LIVE_BIN" | sed 's|/node_modules/@deepseek-ai/dsh/lib/bin.js$||')"
  ok "dsh 启动器 → $LIVE_BIN"
  if [ -n "$DEPLOY" ] && [ -d "$DEPLOY" ]; then
    ok "当前部署目录 ${DEPLOY}（$("$DSH_BIN" --version 2>/dev/null | head -1)）"
  else
    bad "无法从启动器推断部署目录（预期 …/node_modules/@deepseek-ai/dsh/lib/bin.js）"
  fi
else
  bad "$DSH_BIN 无法解析（realpath 失败）"
fi
NPX_DIRS="$(ls -d "$HOME"/.npm/_npx/*/node_modules/@deepseek-ai/dsh 2>/dev/null | wc -l | tr -d ' ')"
if [ "${NPX_DIRS:-0}" -gt 1 ]; then
  warn "本机有 $NPX_DIRS 份 dsh 安装；启动器只指向其中一份，升级后确认软链是否需重指"
else
  ok "只有 1 份 dsh 安装（无多版本混用）"
fi

# 本地客户端补丁（opt-in）：让"只有斜杠指令的空会话"也能看到指令结果。
#
# 判据用**备份文件是否在**——它就是"打过补丁"的标记（补丁脚本自己写、自己删）。
# 没打过就一句话都不说（不制造噪音）；打过而补丁串没了 = npx 升级把它冲掉了 → 提醒重放。
# 背景与那一行判定见 preset/patches/dsh-blank-session-command-nodes.sh 的文件头。
if [ -n "$DEPLOY" ] && [ -d "$DEPLOY" ]; then
  CLIENT_JS="$DEPLOY/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js"
  CLIENT_BAK="$CLIENT_JS.orig-before-crosspost-patch"
  PATCH_TAG='snapshot.order.length > 0'
  if [ -f "$CLIENT_BAK" ]; then
    if grep -q "$PATCH_TAG" "$CLIENT_JS" 2>/dev/null; then
      ok "本地客户端补丁在位（空会话里的指令结果可见）"
    else
      warn "本地客户端补丁已被升级冲掉（空会话里指令结果会被欢迎页盖住）"
      hint "重放：bash $REPO_PRESETS/patches/dsh-blank-session-command-nodes.sh"
      hint "还原：同上 --revert（优先用备份 ${CLIENT_BAK}）"
    fi
  fi
fi

# ── 1. 指向部署的软链是否仍一致 ─────────────────────────────────────────
#
# 断链**不等于**无害，要分三类（2026-09-25 实测踩到）：
#   ① 部署内有同名包 → 链指错了，导入会失败；
#   ② 该包名被某个 profile/preset 的插件行 `name:` 引用 → DSH 按**包名**解析它，链一断
#      那一行插件**静默消失**（DSH 照常启动，只是少一个能力）。仓库目录改名后最常见：
#      软链的目标还写着**旧仓库路径**，而它与 $DEPLOY 毫无关系 —— 实测
#      `profiles/node_modules/crosspost-client` → `~/<旧目录>/preset/...` 正是如此，
#      历史上被归成 ③「无害，可清理」，于是这条提示本身成了误导；
#   ③ 其余 → 真是旧版本残留（npm 换了版本），Node 解析会跳过，可清理。
#
# 把 ② 单独判出来是这条护栏的关键：若一律报失败，本机上百条 npx 版本残留会让它天天红，
# 使用者就学会忽略它 —— 而它是升级后唯一的安全网。
# 数据源（2026-10-03 换）：预设条目现在活在两类 patch 里——
#   ① 各 profile 的 `cordis.patch.yml`（用户覆盖）；
#   ② 已安装 bundle 的 patch 文件（`profiles/*/node_modules/<bundle>/*.patch.yml`
#      与 `profiles/node_modules/<bundle>/*.patch.yml`）。
# 旧的 `.agent-presets/*/agent.cordis.yml` 已无读取方，留着会把"断链需修"判成噪声。
BUNDLE_PATCHES="$(
  find "$DSH_HOME"/profiles/*/node_modules "$DSH_HOME"/profiles/node_modules \
    -maxdepth 2 -name '*.patch.yml' -type f 2>/dev/null | sort -u || true
)"
ROW_NAMES="$(
  grep -h -E '^[[:space:]]*name:[[:space:]]' \
    "$DSH_HOME"/profiles/*/cordis.patch.yml \
    $BUNDLE_PATCHES 2>/dev/null \
    | sed -E 's/^[[:space:]]*name:[[:space:]]*//' \
    | tr -d "'\"" \
    | grep -vE '^\.|:' || true
)"
sec "1. 软链一致性（profiles/node_modules 与预设 node_modules）"
check_links() {
  local root="$1" total=0 stale=0 off=0 broken=0 leftover=0 t pkg
  if [ ! -d "$root" ]; then warn "$root 不存在（跳过）"; return; fi
  while IFS= read -r -d '' l; do
    total=$((total+1))
    t="$(readlink "$l")"
    case "$t" in /*) ;; *) t="$(cd "$(dirname "$l")" && pwd)/$t" ;; esac
    if [ -e "$l" ]; then
      if [ -n "$DEPLOY" ] && printf '%s' "$t" | grep -q '_npx/' && ! printf '%s' "$t" | grep -q "^$DEPLOY/"; then
        off=$((off+1)); if [ "$off" -le 3 ]; then hint "指向非当前部署: $l → $t"; fi
      fi
      continue
    fi
    # 断链：① 部署内有同名包 ② 被插件行 `name:` 引用 ③ 旧版本残留
    pkg="${l#"$root"/}"
    if [ -n "$DEPLOY" ] && [ -e "$DEPLOY/node_modules/$pkg" ]; then
      broken=$((broken+1)); if [ "$broken" -le 3 ]; then hint "断链且部署内有同名包（导入会失败）: $l"; fi
    elif [ -n "$ROW_NAMES" ] && printf '%s\n' "$ROW_NAMES" | grep -qxF "$pkg"; then
      broken=$((broken+1))
      if [ "$broken" -le 3 ]; then
        hint "断链且被插件行引用（那一行会静默消失，不是无害残留）: $l → $t"
        hint "  修法: ln -sfn <仓库>/preset/crosspost/plugins/$pkg $l"
      fi
    else
      leftover=$((leftover+1)); if [ "$leftover" -le 3 ]; then hint "旧版本残留（部署内已无此包，Node 解析会跳过）: $l"; fi
    fi
  done < <(find "$root" -type l -print0 2>/dev/null)
  if [ "$broken" -gt 0 ]; then
    bad "$root: 共 $total 条软链，$broken 条断链需修（部署内有同名包，或被插件行引用）"
  elif [ "$off" -gt 0 ]; then
    warn "$root: 共 $total 条软链，$off 条指向旧部署（升级后建议重指）"
  elif [ "$leftover" -gt 0 ]; then
    warn "$root: 共 $total 条软链，$leftover 条为旧版本残留断链（无害，可清理）"
    hint "清理（可逆：先移走再观察）: mkdir -p ~/.dsh/backups && find $root -type l ! -exec test -e {} \\; -print0 | xargs -0 -I{} sh -c 'mkdir -p ~/.dsh/backups/broken-symlinks && mv \"{}\" ~/.dsh/backups/broken-symlinks/'"
  else
    ok "$root: 共 $total 条软链，全部有效且指向当前部署"
  fi
}
check_links "$DSH_HOME/profiles/node_modules"

# ⚠ bash 3.2 + `set -u`：空数组的 `"${arr[@]}"` 会**直接终止脚本**，而"一个 preset 都没有"
# 是合法状态（干净部署）。故下面所有遍历一律写成 `${PRESET_DIRS[@]+"${PRESET_DIRS[@]}"}`
# ——空安全，且不需要在四处各套一层 if。
#
# 预设 = 一个 bundle（目录里有 package.json 的 `dsh.bundle.patch` + patch 文件）。
# 仓库侧的预设源在 $REPO_PRESETS/*；本机安装态的对照见下面 §2 的"安装链接"子检查。
#
# 只把"看起来是 bundle"的目录收进来（有 manifest 或 patch 文件）：`preset/` 下还住着
# 维护脚本目录（如 `patches/`），它们不是预设，报一句"无 package.json"纯属噪音。
PRESET_DIRS=()
for d in "$REPO_PRESETS"/*; do
  [ -d "$d" ] || continue
  [ -d "$d/node_modules" ] && check_links "$d/node_modules"
  if [ -f "$d/package.json" ] || compgen -G "$d/*.patch.yml" >/dev/null 2>&1; then
    PRESET_DIRS+=("$d")
  fi
done

# 目录式预设（≤0.1.x 的载体）在 0.2.0 起**没有读取方**：留在盘上只会让人以为它还生效。
# 这类"能力静默消失"是本脚本最该报出来的一类，所以存在即告警，并指出去哪看新的声明。
if compgen -G "$DSH_HOME/.agent-presets/*" >/dev/null 2>&1; then
  legacy_list="$(ls -d "$DSH_HOME"/.agent-presets/*/ 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ')"
  warn "存在目录式预设（DSH 0.2.0 起无人读取，等于失效）: ${legacy_list:-?}"
  hint "迁移：把 preset.yml 的 name/description 与 agent.cordis.yml 的条目列表搬进一个"
  hint "@deepseek-ai/dsh-agent-preset 声明行（bundle 的 patch 文件），安装后删掉旧目录"
  hint "本机迁移见 preset/crosspost/cordis.patch.yml 与 preset/crosspost/README.md"
fi

# ── 2. 预设 bundle manifest、安装链接与相对行名 ────────────────────────
sec "2. 预设 bundle manifest、安装链接与相对行名"
BUNDLE_NAMES=()
for d in ${PRESET_DIRS[@]+"${PRESET_DIRS[@]}"}; do
  name="$(basename "$d")"
  # 载体判定：新载体是 patch 文件（名字由 package.json 声明），旧载体是 agent.cordis.yml。
  if [ -f "$d/agent.cordis.yml" ]; then
    bad "$name: 仍是目录式预设载体 agent.cordis.yml（0.2.0 起无人读取）"
    hint "改法见 preset/crosspost/cordis.patch.yml（声明行 + config.plugins）"
    continue
  fi
  pj="$d/package.json"
  if [ ! -f "$pj" ]; then warn "$name: 无 package.json（跳过）"; continue; fi
  msg="$(python3 - "$pj" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1],encoding='utf-8'))
except Exception as e: print('PARSE:'+str(e)); raise SystemExit
n,v=d.get('name'),d.get('version')
if not (isinstance(n,str) and n) or not (isinstance(v,str) and v):
    print('MISSING:name=%r version=%r' % (n,v)); raise SystemExit
patch=((d.get('dsh') or {}).get('bundle') or {}).get('patch')
if not isinstance(patch,str) or not patch:
    print('NOBUNDLE:%s@%s' % (n,v)); raise SystemExit
print('OK:%s@%s|%s' % (n,v,patch))
PY
)"
  case "$msg" in
    OK:*)
      body="${msg#OK:}"
      BN="${body%%|*}"; BP="${body#*|}"
      BUNDLE_NAMES+=("${BN%%@*}")
      ok "$name manifest → ${BN}（bundle patch: ${BP}）"
      if [ -f "$d/${BP#./}" ]; then
        yml="$d/${BP#./}"
        ok "$name bundle patch 存在"
      else
        yml=""
        bad "$name bundle patch 指向的文件不存在: $BP"
        hint "路径: $d/${BP#./}（没有它安装器判 not-a-bundle）"
      fi
      ;;
    NOBUNDLE:*)
      bad "$name/package.json 缺少 dsh.bundle.patch（${msg#NOBUNDLE:}）"
      hint '修法：加 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }'
      hint "否则 plugin_manager 会把本目录判成 not-a-bundle，装不进任何 profile"
      yml="$d/cordis.patch.yml"; [ -f "$yml" ] || yml=""
      ;;
    MISSING:*)
      bad "$name/package.json 必须同时声明非空 name 与 version（${msg#MISSING:}）"
      hint "否则该预设下每个请求都会 REQUEST_EXTENSION 失败（dsh-plugin-package-inventory-deepseek）"
      hint '修法：加 "version": "1.0.0"'
      yml="$d/cordis.patch.yml"; [ -f "$yml" ] || yml=""
      ;;
    *) bad "$name/package.json 解析失败（${msg#PARSE:}）"; yml="" ;;
  esac
  if [ -n "$yml" ]; then
    # 相对行名在 0.2.0 的 bundle 里**几乎必然错**：`dsh-app-boot` 的 boot 契约写明
    # "Relative entry names resolve against the **config directory**"——解析基准是
    # profile 目录（`$DSH_HOME/profiles/<名>/`），**不是**本 patch 文件所在目录。
    # 因此这里不再"检查文件在 bundle 目录里存不存在"（那个判据会给出假绿：
    # 文件明明在 bundle 里，运行时却找不到），而是直接判错并给出正确写法。
    while read -r rel; do
      if [ -z "$rel" ]; then continue; fi
      bad "$name 行 $rel 是相对名（运行时按 config 目录解析，不是 bundle 目录）"
      hint "相对名会被解析成 \$DSH_HOME/profiles/<profile>/${rel#./} → 找不到文件 →"
      hint "  该行拿不到 fiber；声明挂载看似成功，而**新会话绑定失败**："
      hint "  agent-preset/invalid: <行 id> ($rel): never started"
      hint "修法：本地插件写成**包名 + 子路径**（如 ${name}/plugins/xxx.js，与 package.json 的 name 一致）——"
      hint "  bundle 是 profile 的依赖，从 config 目录一定解析得到"
    done < <(grep -oE "name: *'\.\.?/[^']+'" "$yml" 2>/dev/null | sed -E "s/name: *'//; s/'$//")
  fi
done

# 安装链接（本机部署才有）：bundle 被哪个 profile 选了、链接指向哪里。
# `link:` 安装是**相对软链**（仓库即源，改代码免重装）；`file:` 安装是 pnpm 物化的副本树
# （改仓库要重装）。这里只报事实，不判正误——两种都合法，但混用时"改了没生效"极难查。
if [ "${#BUNDLE_NAMES[@]}" -gt 0 ]; then
  for bn in "${BUNDLE_NAMES[@]}"; do
    found=0
    for cand in "$DSH_HOME"/profiles/*/node_modules/"$bn" "$DSH_HOME/profiles/node_modules/$bn"; do
      [ -e "$cand" ] || continue
      found=1
      real="$(realpath_py "$cand" 2>/dev/null || echo '')"
      if [ -L "$cand" ]; then ok "已安装（软链）: $cand → $real"
      else warn "已安装（物化副本，非软链）: ${cand}（改仓库后需重装才生效）"; fi
      case "$real" in
        "$(realpath_py "$REPO_PRESETS" 2>/dev/null)"/*) ok "  链接指回仓库预设源" ;;
        *) warn "  链接不指向本仓库预设源（${real}）——确认是不是另一份安装副本" ;;
      esac
    done
    if [ "$found" -eq 0 ]; then
      warn "预设 bundle $bn 未被任何 profile 选中（未安装）"
      hint "装法（仓库即源、改代码免重装）: 在 profile 的 package.json 里加"
      hint "  \"$bn\": \"link:<仓库绝对路径>\"，并把它加进 dsh.profile.bundles，然后 pnpm install"
    fi
  done
fi

# ── 3. 预设本地插件：fresh 进程导入 + 请求扩展兼容性 ────────────────────
#
# 两种行名都要收（2026-10-03）——只收相对名会让本节点**静默变空**（那一版修好 specifier
# 之后就发生过：本地插件行改成了包名，这里却还在 grep `./`，于是印出"未发现预设本地插件"）：
#   · 相对名 `./plugins/x.js`  → 文件在 patch 文件旁边（旧写法，运行时其实解析不到）
#   · 包名 + 子路径 `<包名>/plugins/x.js` → 文件在本 bundle 目录里（**正确写法**）
sec "3. 预设本地插件（fresh-process 导入 + 请求扩展 manifest 解析）"
PLUGINS=()
for d in ${PRESET_DIRS[@]+"${PRESET_DIRS[@]}"}; do
  # 本 bundle 的包名（用来认"包名 + 子路径"形式）
  bname="$(python3 - "$d/package.json" <<'PY' 2>/dev/null || true
import json,sys
try:
    n=json.load(open(sys.argv[1],encoding='utf-8')).get('name')
    print(n if isinstance(n,str) else '')
except Exception:
    print('')
PY
)"
  for yml in "$d"/*.patch.yml; do
    [ -f "$yml" ] || continue
    while read -r spec; do
      if [ -z "$spec" ]; then continue; fi
      case "$spec" in
        ./*|../*) f="$(dirname "$yml")/${spec#./}" ;;
        *)
          # 包名 + 子路径：只认本 bundle 自己的包名前缀，其余是 host 包（由第 3b 节管）
          if [ -n "$bname" ]; then
            case "$spec" in
              "$bname"/*) f="$d/${spec#"$bname"/}" ;;
              *) continue ;;
            esac
          else
            continue
          fi
          ;;
      esac
      if [ -f "$f" ]; then PLUGINS+=("$f"); fi
    done < <(grep -oE "name: *'[^']+\.js'" "$yml" 2>/dev/null | sed -E "s/name: *'//; s/'$//")
  done
done
if [ "${#PLUGINS[@]}" -eq 0 ]; then
  warn "未发现预设本地插件（跳过）"
else
  for f in "${PLUGINS[@]}"; do
    if out="$("$NODE" --input-type=module -e "import(process.argv[1]).then(m=>console.log(m.name||'-')).catch(e=>{console.log('ERR '+e.message);process.exit(1)})" "$f" 2>&1)"; then
      ok "导入成功 $f → $out"
    else
      bad "导入失败 $f"; hint "$out"
      hint "常见原因：相对深度按仓库布局写死（应改为预设目录内 ../runtime/… 软链或绝对路径）"
    fi
  done
  if "$NODE" --input-type=module - "${PLUGINS[@]}" <<'JS'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
// 与 @deepseek-ai/dsh-plugin-package-inventory-deepseek 同逻辑：相对条目取最近 manifest，
// allowAnonymous 只容忍"完全无 name"；有 name 无 version 会抛错 → REQUEST_EXTENSION
function nearestManifest(modulePath) {
  let c = dirname(modulePath)
  const root = parse(c).root
  for (;;) {
    const m = join(c, 'package.json')
    if (existsSync(m)) return m
    if (c === root) return undefined
    c = dirname(c)
  }
}
function identity(path, allowAnonymous) {
  const man = JSON.parse(readFileSync(path, 'utf8'))
  if (allowAnonymous && man.name === undefined) return undefined
  if (typeof man.name !== 'string' || !man.name.length || typeof man.version !== 'string' || !man.version.length)
    throw new Error('must declare non-empty name and version (' + path + ')')
  return { name: man.name, version: man.version }
}
let fail = 0
// 同一个 bundle 下的多个插件共享一份 manifest —— 按 manifest 去重，避免印出多行一样的结论
const byManifest = new Map()
for (const p of process.argv.slice(2)) {
  const man = nearestManifest(p)
  if (man === undefined) { console.log('  \x1b[32m✔\x1b[0m 松模块（无最近 manifest） ' + p); continue }
  const list = byManifest.get(man) ?? []
  list.push(p)
  byManifest.set(man, list)
}
for (const [man, entries] of byManifest) {
  try {
    const id = identity(man, true)
    console.log('  \x1b[32m✔\x1b[0m 请求扩展兼容 ' + (id ? id.name + '@' + id.version : '(松模块)') + ' ← ' + man + `（${entries.length} 个条目）`)
  } catch (e) {
    console.log('  \x1b[31m✖\x1b[0m 请求扩展会抛错：' + e.message)
    for (const p of entries) console.log('      · ' + p)
    fail = 1
  }
}
process.exit(fail)
JS
  then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    hint '修法：给该 manifest 补 "version": "1.0.0"（否则该预设下所有 LLM 请求失败）'
  fi
fi

# ── 3b. 预设行名在当前部署中可达（包改名/删除/写错 specifier 的自动捕获器）──
#
# 为什么必须有这一节（2026-10-03 实测两次）：
#   ① DSH 0.2.0-rc.2 把 `@deepseek-ai/dsh-workflow-worker-thread` 整个删掉、换成
#      `dsh-workflow-ptc`。预设里那一行不会报错、也不会拦住启动——**它只是静默消失**。
#   ② 本地插件行写成相对名 `./plugins/crosspost.js` 时，按 boot 契约它解析的是
#      **config 目录**（profile 目录）而不是 bundle 目录，于是找不到文件、那一行拿不到
#      fiber；声明挂载看似成功，而**新会话一绑定就失败**：
#        agent-preset/invalid: crosspost-tools (./plugins/crosspost.js): never started
#   两者的共同点：错误都出现在"行名解析"这一步，而且都不拦住进程启动。
# 这里按 Node 的模块解析逐个断言（解析根 = 部署 + 各 profile），解析不到就是那一行不可用。
sec "3b. 预设行名可达性（按模块解析：包名 / 包名+子路径）"
# 用换行分隔的标量而不是数组：本机是 bash 3.2，`set -u` 下展开空数组会直接终止脚本。
REPO_PATCH_LIST=""
for d in ${PRESET_DIRS[@]+"${PRESET_DIRS[@]}"}; do
  for f in "$d"/*.patch.yml; do [ -f "$f" ] && REPO_PATCH_LIST="$REPO_PATCH_LIST$f
"; done
done
if [ -z "$DEPLOY" ] || [ ! -d "$DEPLOY/node_modules" ]; then
  warn "无法确定当前部署目录（DSH_BIN 解析失败），跳过行名可达性检查"
else
  # 收**所有**带引号的行名，相对名（./…）由第 2 节按 patch 目录检查存在性，
  # `cordis:*` 是内建组、绝对路径不是合法输入——都在 node 侧按前缀剔掉。
  SPECS="$(
    grep -hoE "name: *'[^']+'" \
      "$DSH_HOME"/profiles/*/cordis.patch.yml $BUNDLE_PATCHES $REPO_PATCH_LIST 2>/dev/null \
      | sed -E "s/name: *'//; s/'$//" | grep -vE '^\.|:|^/' | sort -u || true
  )"
  PROFILE_PJS="$(ls "$DSH_HOME"/profiles/*/package.json 2>/dev/null | tr '\n' ' ')"
  if [ -z "$SPECS" ]; then
    warn "未发现可解析的预设行名（跳过）"
  else
    spec_out="$("$NODE" --input-type=module - "$DEPLOY" "$PROFILE_PJS" $SPECS <<'JS' 2>&1
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
const deploy = process.argv[2]
const profilePjs = (process.argv[3] || '').split(' ').filter(Boolean)
const roots = [deploy + '/node_modules/@deepseek-ai/dsh/package.json', ...profilePjs]
  .filter((p) => existsSync(p))
const reqs = roots.map((p) => createRequire(p))
const n = reqs.length
let fail = 0
for (const spec of process.argv.slice(4)) {
  let found = false
  for (const r of reqs) {
    try { r.resolve(spec); found = true; break } catch {}
  }
  if (found) console.log('\x1b[32m✔\x1b[0m ' + spec)
  else { fail++; console.log('\x1b[31m✖\x1b[0m ' + spec + '  （' + n + ' 个解析根都找不到）') }
}
console.log('__FAILCOUNT__' + fail)
JS
)"
    printf '%s\n' "$(printf '%s' "$spec_out" | grep -v '^__FAILCOUNT__' | sed 's/^/  /')"
    n_fail="${spec_out##*__FAILCOUNT__}"
    n_ok=$(( $(printf '%s' "$SPECS" | grep -c . ) - n_fail ))
    PASS=$((PASS + n_ok))
    if [ "${n_fail:-0}" -gt 0 ]; then
      FAIL=$((FAIL + n_fail))
      hint "上列 ✖ 的行名在该部署里解析不到——**包已改名/被删除，或 specifier 写法不对**（那一行会静默消失，或新会话绑定失败）"
      hint "查新名：ls $DEPLOY/node_modules/@deepseek-ai | grep <关键字>"
      hint "本次实证：@deepseek-ai/dsh-workflow-worker-thread → @deepseek-ai/dsh-workflow-ptc"
      hint "本地插件行必须写成**包名 + 子路径**（如 preset-crosspost/plugins/crosspost.js）："
      hint "  相对名 ./plugins/… 按 config 目录（profile 目录）解析，找不到文件 → 新会话 never started"
    fi
  fi
fi

# ── 4. persona 配置键 ───────────────────────────────────────────────────
sec "4. persona 配置键"
for d in ${PRESET_DIRS[@]+"${PRESET_DIRS[@]}"}; do
  yml="$d/cordis.patch.yml"
  if [ ! -f "$yml" ]; then continue; fi
  name="$(basename "$d")"
  if grep -q '@deepseek-ai/dsh-persona' "$yml"; then
    blk="$(awk '
      /@deepseek-ai\/dsh-persona/ { f=1; match($0, /^[[:space:]]*/); ind=RLENGTH; next }
      f {
        if ($0 ~ /^[[:space:]]*- id:/) { match($0, /^[[:space:]]*/); if (RLENGTH <= ind) exit }
        print; seen=1
      }
    ' "$yml")"
    if printf '%s' "$blk" | grep -qE '^[[:space:]]+prefix:'; then
      ok "$name: persona 行使用 prefix"
    else
      bad "$name: persona 行缺少 prefix（新版 dsh-persona 必填）"
      hint '旧键 text 已失效 → 报 invalid config: $.prefix missing required value'
    fi
    if printf '%s' "$blk" | grep -qE '^[[:space:]]+text:'; then
      bad "$name: persona 行仍残留旧键 text"
      hint '把 text 改成 prefix（“工作目录”那句可拆到 suffix）'
    fi
  fi
done
for pf in "$DSH_HOME"/profiles/*/cordis.patch.yml; do
  if [ ! -f "$pf" ]; then continue; fi
  name="$(basename "$(dirname "$pf")")"
  if grep -qE '^[[:space:]]+personaPrefix:' "$pf"; then
    ok "$name profile: system-prompt 使用 personaPrefix"
  elif grep -qE '^[[:space:]]+persona:' "$pf"; then
    bad "$name profile: 仍用旧键 persona（新版为 personaPrefix/personaSuffix，会被静默丢弃）"
    hint '注意 patch 是整体替换 config：改名时要一并补 personaSuffix，否则连 headless 的 cwd 后缀也丢'
  else
    ok "$name profile: 未覆盖 system-prompt（无需检查）"
  fi
done

# ── 5. profile 组合与 bundle 可用性 ────────────────────────────────────
sec "5. profile 组合（dsh --dump-config）与 bundle"
for prof in "$DSH_HOME"/profiles/*/; do
  name="$(basename "$prof")"
  if [ ! -f "$prof/package.json" ]; then continue; fi
  if "$DSH_BIN" --profile "$name" --dump-config >"$TMP/$name.out" 2>"$TMP/$name.err"; then
    ok "profile $name 组合成功"
  else
    bad "profile $name 组合失败"; hint "$(head -3 "$TMP/$name.err" | tr '\n' ' ')"
  fi
  if [ -n "$DEPLOY" ]; then
    while read -r b; do
      if [ -z "$b" ]; then continue; fi
      # bundle 按 Node 的解析顺序找（2026-09-19 v2.38 修正）：
      #   ① profile 自己的 node_modules —— **本地 bundle**（file: 装的 tgz、打过补丁的
      #      自研 bundle）就在这里，它们本来就不该出现在 DSH 部署目录里
      #   ② ~/.dsh/profiles/node_modules —— 共享依赖
      #   ③ DSH 部署目录
      # 旧版只查 ③，于是任何自带本地 bundle 的 profile 都会被判 ✖ 失败。
      # 只要某个 profile 的 bundle 是从本地 tgz 装的，就会中招 ——
      # 它明明在 ① 里，却报"在当前部署缺失"。**假失败比不检查更糟**——
      # 它会训练使用者忽略这个工具，而它恰恰是 DSH 升级后唯一的安全网。
      # $prof 来自 `*/` 通配，带尾斜杠——去掉，否则拼出 `<profile>//node_modules` 这种双斜杠
      pdir="${prof%/}"
      where=""
      for cand in "$pdir/node_modules/$b" "$DSH_HOME/profiles/node_modules/$b" "$DEPLOY/node_modules/$b"; do
        if [ -d "$cand" ]; then where="$cand"; break; fi
      done
      if [ -n "$where" ]; then
        case "$where" in
          "$DEPLOY"/*) ok "profile $name bundle $b 存在（部署）" ;;
          *) ok "profile $name bundle $b 存在（${where#"$DSH_HOME"/}，非部署内 bundle）" ;;
        esac
      else
        bad "profile $name bundle $b 找不到（profile 与部署里都没有）"
        hint "查过：$pdir/node_modules/${b}、$DSH_HOME/profiles/node_modules/${b}、$DEPLOY/node_modules/$b"
        hint "本地 bundle 需 npm install；发布的 bundle 需 DSH 升级后再看"
      fi
    done < <(python3 - "$prof/package.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
for b in ((d.get('dsh') or {}).get('profile') or {}).get('bundles') or []: print(b)
PY
)
  fi
done

# ── 6. MCP 行配置键白名单 ──────────────────────────────────────────────
#
# 白名单来源 = 该部署里 dsh-mcp-client 的**实时 Config schema**
# （`cordis_inspect_query` → Config.listConfigs entry=include:<该行 id>），
# 2026-10-03 对 0.2.0-rc.2 刷新：新增了 `maxInstructionBytes`。
# 白名单落后于 schema 就会**恒报警**，而恒报警会训练使用者忽略本脚本。
sec "6. profile 里 dsh-mcp-client 行的 config 键"
ALLOW=" serverName transport command args env cwd toolCallTimeoutMs failOnStartupError maxInstructionBytes reconnect url headers "
for pf in "$DSH_HOME"/profiles/*/cordis.patch.yml; do
  if [ ! -f "$pf" ]; then continue; fi
  name="$(basename "$(dirname "$pf")")"
  badkeys=""
  while read -r k; do
    if [ -z "$k" ]; then continue; fi
    case "$ALLOW" in *" $k "*) ;; *) badkeys="$badkeys $k" ;; esac
  done < <(awk '
    # 只取 config: 的直接子键（缩进 = config 缩进 + 2），避免把行级 name/disabled 与嵌套 env 子键算进来
    /@deepseek-ai\/dsh-mcp-client/ { inblk=1; incfg=0; cfgind=-1; next }
    inblk && /^- / { inblk=0; next }
    inblk && /^[[:space:]]*config:[[:space:]]*$/ {
      match($0, /^[[:space:]]*/); cfgind=RLENGTH; incfg=1; next
    }
    inblk && incfg {
      match($0, /^[[:space:]]*/); ind=RLENGTH
      if ($0 ~ /^[[:space:]]*[A-Za-z][A-Za-z0-9_]*:/ && ind == cfgind + 2) {
        line=$0; sub(/^[[:space:]]+/, "", line); sub(/:.*/, "", line); print line
      }
    }
  ' "$pf" | sort -u)
  if [ -z "$badkeys" ]; then ok "$name: MCP 行 config 键均在白名单内"
  else warn "$name: MCP 行 config 出现非白名单键:${badkeys}（可能已改名，未知键会被静默丢弃）"; fi
done

# ── 7. 设置（settings.yaml）迁移态 ─────────────────────────────────────
#
# DSH 0.2.0 起 `$DSH_HOME/settings.yaml` **不再是机制**：dsh-settings 在 Loader 稳定后
# 把它的每个 section 一次性写进同 id 的 profile 条目（`ui-onboarding` → `ui-settings-general`，
# `ui-developer-tools` → `ui-settings`，`shell` → 平台的 shell 执行器条目），
# 然后把文件改名成 `settings.yaml.imported`；running composition 拒收的 section 只留在改名后的文件里。
# 因此旧脚本"检查 settings.yaml 命名空间"在 0.2.0 上**恒报警**。现在只看迁移态。
sec "7. settings.yaml 迁移态（0.2.0 起设置改由 profile 条目的 volatile 字段承载）"
S="$DSH_HOME/settings.yaml"
S_IMPORTED="$DSH_HOME/settings.yaml.imported"
if [ -f "$S" ]; then
  warn "还有 settings.yaml 未迁移（DSH 会在下次启动时导入并改名为 .imported）"
  hint "导入方向：ui-onboarding→ui-settings-general、ui-developer-tools→ui-settings、shell→平台 shell 执行器"
  hint "导入后设置值住在 profile 的 cordis.patch.yml 里（面板写入的就是这些字段）"
elif [ -f "$S_IMPORTED" ]; then
  ok "settings.yaml 已导入并改名（${S_IMPORTED}）"
  if grep -q "^ui-onboarding:" "$S_IMPORTED" 2>/dev/null; then
    hint "注意：改名后的文件里仍有未迁移的 section——它们只在这里留着，不再生效"
  fi
else
  ok "无 settings.yaml（未用过旧式设置文件）"
fi

# ── 8. 会话日志格式（费用报表依赖）────────────────────────────────────
sec "8. 会话日志格式（费用报表依赖）"
# 排序不许经 `xargs -0 ls -t`（GNU 空输入会列当前目录 → 见 session_files_by_mtime 注释）
newest="$(session_files_by_mtime | head -1)"
if [ -z "$newest" ]; then
  warn "未找到会话日志（跳过）"
else
  base="$(basename "$newest")"
  if printf '%s' "$base" | grep -qE '^session(\.v[0-9]+)?\.jsonl(\.zstd)?$'; then
    gen="$(printf '%s' "$base" | sed -nE 's/^session\.v([0-9]+)\.jsonl.*/\1/p')"; gen="${gen:-0}"
    ok "最新会话文件命名合规: ${base}（代际 v${gen}）"
    # 上限 4（2026-10-03）：0.2.0-rc.2 已写 session.v4.jsonl[.zstd]，
    # token-cost 的 GENERATION_RE 接受 vN，且 usage 位置在 v4 上**实测未变**
    # （assistant/message → data.usage；v3 之后不再有 assistant/chunk）。
    # 更高代际出现时不能假设仍然如此——那正是费用报表静默归零的入口。
    if [ "$gen" -gt 4 ]; then
      warn "出现新代际 v${gen}：token-cost.mjs 已确认支持到 v4（v3+ = assistant/message.data.usage）"
      hint "复验 usage 承载位置：zstd -dc 该文件 | grep -c '\"usage\":'，再对照 src/token-cost.mjs 的分支"
    fi
  else
    bad "最新会话文件命名不符合规范: $base"
    hint "token-cost 的 GENERATION_RE 可能需适配"
  fi
  # usage 承载检查：找**最近一个真的有 LLM 调用**的会话再判。
  #
  # 为什么不能只看"最新那个会话"（2026-10-04 实测踩到）：只敲了斜杠指令的会话（例如
  # `/crosspost-help`）根本没有 LLM 调用，自然一条 usage 都没有——拿它来判
  # "usage 位置可能已变"会变成**恒报警**，而假报警正是本脚本最该避免的事
  # （它会训练使用者忽略唯一的安全网）。所以往前找最近一个有 assistant/message 的会话。
  probe=""; probe_scanned=0; probe_skipped=0
  # 不以"有没有 unzstd"为前提：未压缩的会话文件（session.vN.jsonl）同样可查；
  # 只有 .zstd 才需要它（循环内逐条跳过）。
  if [ -d "$DSH_HOME/sessions" ]; then
    while read -r cand; do
      [ -n "$cand" ] || continue
      [ "$probe_scanned" -lt 8 ] || break
      probe_scanned=$((probe_scanned + 1))
      case "$cand" in
        *.zstd)
          [ -n "$UNZSTD" ] || continue
          "$UNZSTD" -f "$cand" -o "$TMP/s.jsonl" -q 2>/dev/null || continue
          ;;
        *.jsonl) cp "$cand" "$TMP/s.jsonl" 2>/dev/null || continue ;;
        *) continue ;;
      esac
      m="$(grep -c '"assistant/message"' "$TMP/s.jsonl" 2>/dev/null || true)"; m="${m:-0}"
      if [ "$m" -gt 0 ]; then probe="$cand"; probe_msg="$m"; break; fi
      probe_skipped=$((probe_skipped + 1))
    done < <(session_files_by_mtime | head -8)
    if [ -n "$probe" ]; then
      n_use="$(grep -c '"usage":' "$TMP/s.jsonl" 2>/dev/null || true)"; n_use="${n_use:-0}"
      if [ "${n_use:-0}" -gt 0 ]; then
        ok "解压可读：assistant/message=${probe_msg}，含 usage 事件=${n_use}（token-cost 可解析）"
        [ "$probe_skipped" -gt 0 ] && hint "（跳过了 $probe_skipped 个无 LLM 调用的会话；取的是 $(basename "$probe")）"
      else
        warn "解压可读但未发现 usage 事件：token-cost 的 usage 位置可能已变"
        hint "取样：$(basename "$probe")（assistant/message=${probe_msg}）"
      fi
    else
      warn "最近 ${probe_scanned} 个会话都没有 LLM 调用（只有斜杠指令/空会话）——usage 承载无法判定"
      hint "跑一次普通对话后再跑本脚本即可验证（本条不判失败）"
    fi
  fi
fi

# ── 汇总 ────────────────────────────────────────────────────────────────
sec "汇总"
printf '  ✔ %d 项通过   ⚠ %d 项提醒   ✖ %d 项失败\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '\n\033[31m存在失败项：按上面 ↳ 提示修复后重跑。\033[0m\n'
  # REPO_PRESETS 可能是 preset/（默认）也可能是 preset/crosspost/（--repo 覆盖），两种都要能推出仓库根
  case "$(basename "$REPO_PRESETS")" in
    crosspost) REPO_ROOT="$(cd "$REPO_PRESETS/../.." 2>/dev/null && pwd || echo "$REPO_PRESETS/../..")" ;;
    *) REPO_ROOT="$(cd "$REPO_PRESETS/.." 2>/dev/null && pwd || echo "$REPO_PRESETS/..")" ;;
  esac
  printf '备份/回退约定见 %s/md-backup/backups/ 下最新目录的 README.md\n' "$REPO_ROOT"
  exit 1
fi
printf '\n\033[32m全部通过（⚠ 项建议人工确认）。\033[0m\n'
exit 0
