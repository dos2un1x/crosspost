#!/usr/bin/env bash
# node 解析与守护进程 PATH 渲染 —— launchd（macOS）与 systemd（Linux）两个安装器**共用这一份**。
#
# 为什么抽出来（v2.110）：这两件事都踩过坑，而且都是"只在别人机器上才暴露"的：
#   ① node 路径：`install-launchd.sh` 曾写死 `/usr/local/bin/node`。Apple Silicon 的 Homebrew 在
#      /opt/homebrew/bin，nvm/asdf/fnm 装在用户目录下 —— 写死等于"照着 README 做，第二步直接
#      报『找不到 node』退出"（v2.37 修）。
#   ② 守护进程 PATH：launchd 默认只有 /usr/bin:/bin:/usr/sbin:/sbin，systemd 用户单元的 PATH
#      同样不含用户自己装的 CLI；引擎要调 `lark-cli` / `unzstd` 等**可选** CLI，缺 PATH 时
#      它们静默变成"不可用"（doctor 只记 WARN，更难发现）。
#
# 两个安装器各写一份实现，就等于留了一个"只修了一边"的未来。所以只有这一份。
#
# 用法（安装器里）：
#   source "$PROJECT_DIR/bridge/scripts/resolve-node.sh"
#   NODE_BIN="$(resolve_node)"
#   need_node                     # 解析不到就报错退出（附修法）
#   PATH_FOR_DAEMON="$(render_path)"

# 解析 node：CROSSPOST_NODE > PATH 上的 node > 常见绝对路径（最后才兜底返回空）
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

# 解析不到就退出（错误信息里给"怎么修"，而不是让用户去猜）
need_node() {
  if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN" ]; then
    echo "错误: 找不到可执行的 node（试过 PATH 与常见位置）" >&2
    echo "  用 CROSSPOST_NODE 显式指定，例如：CROSSPOST_NODE=\$(command -v node) $0 install" >&2
    exit 1
  fi
}

# 守护进程的 PATH：node 所在目录优先，再补常见位置，最后带上安装时的 PATH
# （用户机器上的 CLI——如 lark-cli——往往只在安装时的 PATH 里可见）。
# 去重后写盘：单元文件/plist 是给人看与排查的，重复项只会造成困惑。
render_path() {
  local node_bin="${1:-${NODE_BIN:-}}"
  local node_dir
  node_dir="$(dirname "$node_bin")"
  local raw="$node_dir:/usr/local/bin:/opt/homebrew/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  local out="" part
  local IFS=':'
  for part in $raw; do
    [ -n "$part" ] || continue
    case ":$out:" in
      *":$part:"*) continue ;;
    esac
    out="${out:+$out:}$part"
  done
  printf '%s' "$out"
}
