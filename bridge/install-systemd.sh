#!/usr/bin/env bash
# CrossPost Bridge systemd 用户单元（Linux）：登录自启 + 崩溃自动重启。
#
# 用法:
#   install-systemd.sh install [WS_PORT]   安装并启动（默认 9539，HTTP = WS+1）
#   install-systemd.sh print   [WS_PORT]   只打印将要写入的单元（不写文件、不调 systemctl）
#   install-systemd.sh status              查看单元状态
#   install-systemd.sh uninstall           停止并卸载
#
# 环境变量:
#   CROSSPOST_NODE   覆盖 node 路径（默认从 PATH 解析，见 bridge/scripts/resolve-node.sh）
#
# 与 macOS 的对应关系（`bridge/install-launchd.sh`）：
#   launchd  label  com.crosspost.bridge  ←→  systemd 单元 crosspost-bridge.service
#   两者共用 node 解析与 PATH 渲染（bridge/scripts/resolve-node.sh），避免只修了一边。
#
# 为什么 `print` 不要求 Linux：CI（ubuntu）与开发机（macOS）都要能**生成并校验**这份单元，
# 而只有 install/status/uninstall 才真的需要 systemctl。
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_JS="$PROJECT_DIR/bridge/run-bridge.mjs"
UNIT_NAME="crosspost-bridge"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$UNIT_NAME.service"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/crosspost"

CMD="${1:-install}"
WS_PORT="${2:-9539}"

# 端口必须是数字：`print` 会把它原样写进单元，非数字会得到一个 systemd 拒载的单元
# （而报错会出现在 `systemctl --user enable` 那一步，离真正的原因很远）。
case "$WS_PORT" in
  '' | *[!0-9]*)
    echo "错误: 端口必须是数字：$WS_PORT" >&2
    exit 1
    ;;
esac

# shellcheck source=scripts/resolve-node.sh
source "${BASH_SOURCE[0]%/*}/scripts/resolve-node.sh"
NODE_BIN="$(resolve_node)"

# 单元里的路径与值：理论上可以是任意字符串，但换行/制表符会写坏单元文件（systemd 会拒载），
# 所以先把这类字符挡掉，并给出可执行的报错。
check_value() {
  case "$2" in
    *$'\n'* | *$'\t'*)
      echo "错误: $1 含换行或制表符，无法写进 systemd 单元：$2" >&2
      exit 1
      ;;
  esac
}

# 生成单元到 stdout（install 与 print 共用，避免两份实现漂移）
render_unit() {
  local path_x
  path_x="$(render_path)"
  check_value node "$NODE_BIN"
  check_value bridge "$BRIDGE_JS"
  check_value project "$PROJECT_DIR"
  check_value PATH "$path_x"
  cat <<EOF
[Unit]
Description=CrossPost 发布引擎桥（本地草稿通道）
Documentation=file://$PROJECT_DIR/README.md
After=network-online.target

[Service]
Type=simple
ExecStart=$NODE_BIN $BRIDGE_JS
WorkingDirectory=$PROJECT_DIR
Environment=SYNC_PROXY_WS_PORT=$WS_PORT
Environment=PATH=$path_x
Restart=always
RestartSec=3
# 日志走 journal（不需要 systemd ≥240 的 StandardOutput=append:）：
#   journalctl --user -u $UNIT_NAME -f
# 想落文件就把下面两行的注释去掉（要求 systemd ≥240）：
# StandardOutput=append:$LOG_DIR/bridge.out.log
# StandardError=append:$LOG_DIR/bridge.err.log

[Install]
WantedBy=default.target
EOF
}

require_linux() {
  case "${OSTYPE:-}" in
    linux* | *gnu*) ;;
    *)
      echo "错误: systemd 用户单元只适用于 Linux。当前平台：${OSTYPE:-unknown}" >&2
      echo "  macOS 用 bridge/install-launchd.sh；其它环境请前台跑 node bridge/run-bridge.mjs。" >&2
      exit 1
      ;;
  esac
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "错误: 本机没有 systemctl（systemd 用户单元不可用）" >&2
    echo "  非 systemd 环境请前台运行：node bridge/run-bridge.mjs（或接入你自己的进程管理）。" >&2
    exit 1
  fi
}

# 端口占用检查：端口被占时桥会"启动成功但通道不可用"，必须先拦住。
# 用 bash 内建的 /dev/tcp，不依赖 lsof/ss/netstat 里的某一个。
port_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$WS_PORT") >/dev/null 2>&1
}

case "$CMD" in
  install)
    require_linux
    need_node
    [ -f "$BRIDGE_JS" ] || {
      echo "错误: 找不到 $BRIDGE_JS" >&2
      exit 1
    }
    if port_busy; then
      echo "⚠ 端口 $WS_PORT 已被占用，请先停止现有 Bridge（手动进程或旧守护）再安装：" >&2
      echo "  - 手动进程: kill <PID>（ps aux | grep run-bridge.mjs）" >&2
      echo "  - 旧单元:   systemctl --user disable --now $UNIT_NAME" >&2
      exit 1
    fi

    mkdir -p "$UNIT_DIR" "$LOG_DIR"
    render_unit >"$UNIT"
    systemctl --user daemon-reload

    err="$(mktemp)"
    if ! systemctl --user enable --now "$UNIT_NAME" 2>"$err"; then
      echo "✖ 启动失败：" >&2
      cat "$err" >&2
      rm -f "$err"
      echo "" >&2
      echo "常见原因与修法：" >&2
      echo "  · 没有用户会话总线（ssh / 容器里常见）：" >&2
      echo "      export XDG_RUNTIME_DIR=/run/user/\$(id -u)  &&  loginctl enable-linger \$USER" >&2
      echo "  · 端口被占：改一个端口 install-systemd.sh install <WS_PORT>" >&2
      exit 1
    fi
    rm -f "$err"

    echo "✅ 已安装并启动 $UNIT_NAME (WS=$WS_PORT, HTTP=$((WS_PORT + 1)))"
    echo "   node: $NODE_BIN"
    echo "   单元: $UNIT"
    echo "   日志: journalctl --user -u $UNIT_NAME -f"
    echo "   开机驻留（注销后仍运行）: loginctl enable-linger \$USER"
    echo "   卸载: bridge/install-systemd.sh uninstall"
    ;;
  print | --print-unit)
    need_node
    render_unit
    ;;
  status)
    require_linux
    if [ ! -f "$UNIT" ]; then
      echo "❌ 未安装（$UNIT 不存在）"
      exit 1
    fi
    echo "单元: $UNIT"
    echo "enabled: $(systemctl --user is-enabled "$UNIT_NAME" 2>/dev/null || echo unknown)"
    echo "active:  $(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || echo unknown)"
    systemctl --user status "$UNIT_NAME" --no-pager 2>&1 | head -8 || true
    ;;
  uninstall)
    require_linux
    if [ -f "$UNIT" ]; then
      systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
      rm -f "$UNIT"
      systemctl --user daemon-reload 2>/dev/null || true
      echo "✅ 已停止并卸载 $UNIT_NAME"
    else
      echo "未安装（$UNIT 不存在）"
    fi
    ;;
  *)
    echo "用法: install-systemd.sh {install [WS_PORT] | print [WS_PORT] | status | uninstall}" >&2
    exit 1
    ;;
esac
