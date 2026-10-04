#!/bin/bash
# 本流水线的「写作」这一步——**模板版是离线的占位实现**。
#
# 你要换掉的只有一件事：把中间这段"渲染占位正文"换成你自己的写作流程
# （调你的 agent / LLM，按 SKILL.md 的 SOP 产出正文与评分），再把结果写回同一个文件。
#
# 用法: generate.sh <slot> <keyword>
#   slot     栏目 id（见 .crosspost/schedule.json）
#   keyword  这条流水线的选题关键词
#
# 环境变量:
#   PIPELINE_DATA_DIR  草稿目录（缺省 = 仓库的 drafts/，应与 .crosspost/project.json 的 dataDir 一致）
set -euo pipefail

SLOT="${1:?用法: generate.sh <slot> <keyword>}"
KEYWORD="${2:?用法: generate.sh <slot> <keyword>}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${PIPELINE_DATA_DIR:-$ROOT/drafts}"

DATE="$(date +%Y-%m-%d)"
# 文件名必须是 <日期>-<栏目>-<主题> 形态，且各段为 ASCII：引擎按它解析 id / 日期 / 栏目。
SLUG="$(printf '%s' "$KEYWORD" | tr -cd 'a-zA-Z0-9' | tr '[:upper:]' '[:lower:]' | cut -c1-24)"
[ -n "$SLUG" ] || SLUG="draft"
ID="$DATE-$SLOT-$SLUG"

mkdir -p "$DATA_DIR"
TARGET="$DATA_DIR/$ID.md"

cat > "$TARGET" <<EOF
---
title: $KEYWORD
---

（占位正文：这条流水线的模板生成的。）

把 scripts/generate.sh 里生成正文的那一段，换成你自己的写作流程：
按 SKILL.md 的 SOP 产出正文，再把 score / risk 一并写进 frontmatter。
EOF

# 把落盘路径打到 stdout：包一层 provider 时正好用它写日志。
echo "$TARGET"
