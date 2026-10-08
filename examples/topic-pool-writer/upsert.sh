#!/bin/bash
# 候选池写入 —— 项目侧**只做转发**（通用实现在引擎里，见同目录 README）。
#
# 用法（与引擎命令同名同参）：
#   upsert.sh --date=2026-10-01 --slot=hotspot \
#     --json='[["<kw>","",87,"rejected","<原因>"]]' [--manual --article-id=<草稿名>]
#
# 找引擎：CROSSPOST_ENGINE_REPO（缺省见下）。**找不到就 exit 1**——不要退回"自己写一遍"。
# 作者：dos2un1x · 项目：https://github.com/dos2un1x/crosspost
set -uo pipefail

ENGINE_REPO="${CROSSPOST_ENGINE_REPO:-/Users/me/crosspost}"
CLI="$ENGINE_REPO/crosspost-runtime/src/cli.mjs"
NODE_BIN="${CROSSPOST_NODE:-$(command -v node || true)}"

if [ ! -f "$CLI" ]; then
  echo "找不到引擎 CLI：$CLI" >&2
  echo "把引擎放在别处就用 CROSSPOST_ENGINE_REPO 指过去（本项目不自己实现写入）" >&2
  exit 1
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "找不到 node（可用 CROSSPOST_NODE 指定）" >&2
  exit 1
fi

# 原样转发参数；退出码就是结论（0 写入成功 / 1 被拒）
exec "$NODE_BIN" "$CLI" topicPoolUpsert "$@"
