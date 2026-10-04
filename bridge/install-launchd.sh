#!/usr/bin/env bash
# CrossPost Bridge launchd 守护：登录自启 + 崩溃自动重启（macOS）
#
# 用法:
#   install-launchd.sh install [WS_PORT]   安装并启动守护（默认 9539，HTTP = WS+1）
#   install-launchd.sh print   [WS_PORT]   只打印将要写入的 plist（不写文件、不调 launchctl）
#   install-launchd.sh status              查看守护状态
#   install-launchd.sh uninstall           停止并卸载守护
#
# 环境变量:
#   CROSSPOST_NODE   覆盖 node 路径（默认从 PATH 解析 `node`，见 resolve_node）
#
# 2026-09-19（v2.37）修两个"开箱即用"缺陷：
#   ① node 路径曾**写死 /usr/local/bin/node**。Apple Silicon 的 Homebrew 在
#      /opt/homebrew/bin，nvm/asdf/fnm 在用户目录下，官方安装器在 /usr/local/bin——
#      写死会让 README 第 2 步推荐的"装守护"在别的机器上直接报"找不到 node"退出。
#      现在优先 `command -v node`。同款缺陷 v2.18 在 preset 插件上踩过一次
#      （那里至今有护栏测试），这里补上。
#   ② 生成的 plist **没有任何 PATH**。launchd 默认 PATH 只有
#      /usr/bin:/bin:/usr/sbin:/sbin，而引擎要调 lark-cli / unzstd 等可选 CLI
#      （doctor 会检查），缺 PATH 时它们静默变成"不可用"。现在写入一份包含
#      node 所在目录与常见安装位置的 PATH。
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_JS="$PROJECT_DIR/bridge/run-bridge.mjs"
LABEL="com.crosspost.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/CrossPost"

CMD="${1:-install}"
WS_PORT="${2:-9539}"

# 端口必须是数字：plist 里它是个字符串值，非数字会装出一个起不来的守护。
case "$WS_PORT" in
  '' | *[!0-9]*)
    echo "错误: 端口必须是数字：$WS_PORT" >&2
    exit 1
    ;;
esac

# 平台守卫（v2.110）：本脚本是 launchd（macOS）。在 Linux 上继续跑下去，会在
# `launchctl load` 处以一条 command-not-found 收场 —— 用户得自己猜；一句指路有用得多。
#
# 用 bash 内建的 $OSTYPE 而不是 `uname`：本脚本要能在**最小 PATH** 下也给出正确结论
# （既有测试就是那样跑它的：PATH=/nonexistent-bin，此时任何外部命令都调不到）。
case "${OSTYPE:-}" in
  linux* | *gnu* | *bsd*)
    echo "错误: install-launchd.sh 仅适用于 macOS（launchd）。当前平台：${OSTYPE}" >&2
    echo "  Linux 用 bridge/install-systemd.sh（systemd 用户单元），或前台跑 node bridge/run-bridge.mjs。" >&2
    exit 1
    ;;
esac

# node 解析与守护 PATH 渲染：与 systemd 安装器**共用**一份实现（v2.110 抽出）。
# 用 ${BASH_SOURCE[0]%/*} 而不是 PROJECT_DIR/dirname：同一个理由（最小 PATH 下也要能用）。
# shellcheck source=scripts/resolve-node.sh
source "${BASH_SOURCE[0]%/*}/scripts/resolve-node.sh"
NODE_BIN="$(resolve_node)"

# plist 是 XML：路径含 & < > 会写坏文件（罕见但会静默导致 launchctl 报语法错）
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

# 生成 plist 到 stdout（install 与 print 共用，避免两份实现漂移）
render_plist() {
  local node_x bridge_x project_x log_x port_x path_x
  node_x="$(xml_escape "$NODE_BIN")"
  bridge_x="$(xml_escape "$BRIDGE_JS")"
  project_x="$(xml_escape "$PROJECT_DIR")"
  log_x="$(xml_escape "$LOG_DIR")"
  port_x="$(xml_escape "$WS_PORT")"
  path_x="$(xml_escape "$(render_path)")"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_x</string>
    <string>$bridge_x</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SYNC_PROXY_WS_PORT</key><string>$port_x</string>
    <key>PATH</key><string>$path_x</string>
  </dict>
  <key>WorkingDirectory</key><string>$project_x</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log_x/bridge.out.log</string>
  <key>StandardErrorPath</key><string>$log_x/bridge.err.log</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF
}

case "$CMD" in
  install)
    need_node
    [ -f "$BRIDGE_JS" ] || { echo "错误: 找不到 $BRIDGE_JS" >&2; exit 1; }

    # 端口占用检查：若 WS 端口已被占用，run-bridge 会启动但通道不可用，必须阻止
    if lsof -nP -iTCP:"$WS_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "⚠ 端口 $WS_PORT 已被占用，请先停止现有 Bridge（手动进程或旧守护）再安装：" >&2
      lsof -nP -iTCP:"$WS_PORT" -sTCP:LISTEN >&2
      echo "  - 手动进程: kill <PID>" >&2
      echo "  - 旧守护:   bridge/install-launchd.sh uninstall" >&2
      exit 1
    fi

    mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
    render_plist > "$PLIST"
    launchctl load -w "$PLIST"
    echo "✅ 已安装并启动 $LABEL (WS=$WS_PORT, HTTP=$((WS_PORT + 1)))"
    echo "   node: $NODE_BIN"
    echo "   日志: $LOG_DIR/bridge.out.log / bridge.err.log"
    echo "   卸载: bridge/install-launchd.sh uninstall"
    ;;
  print | --print-plist)
    need_node
    render_plist
    ;;
  status)
    if [ ! -f "$PLIST" ]; then
      echo "❌ 未安装（$PLIST 不存在）"
      exit 1
    fi
    echo "plist: $PLIST"
    if launchctl list | grep -q "$LABEL"; then
      launchctl list | grep "$LABEL"
      echo "✅ 守护已加载并运行"
    else
      echo "⚠ 守护已安装但未运行（launchctl list 中无 ${LABEL}）"
    fi
    ;;
  uninstall)
    if [ -f "$PLIST" ]; then
      launchctl unload -w "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "✅ 已停止并卸载 $LABEL"
    else
      echo "未安装（$PLIST 不存在）"
    fi
    ;;
  *)
    echo "用法: install-launchd.sh {install [WS_PORT] | print [WS_PORT] | status | uninstall}" >&2
    exit 1
    ;;
esac
