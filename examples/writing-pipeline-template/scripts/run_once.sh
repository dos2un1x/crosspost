#!/bin/bash
# 本流水线的「槽位入口」——到点时跑什么。
#
# 两种接法都指向这里：
#   · `.crosspost/schedule.json` 的 command（引擎按 argv 直接派生，不经 shell）
#   · P3 的 HTTP 执行器：POST /slot/run 里映射到本脚本
#
# 用法: run_once.sh <slot>
set -euo pipefail

SLOT="${1:?用法: run_once.sh <slot>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${PIPELINE_LOG_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/run-$SLOT-$(date +%Y-%m-%d).log"

{
  echo "================================================"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [START] slot=$SLOT"
} >> "$LOG_FILE"

# 模板版：直接把"选题 → 写作"跑一遍，证明回路是通的。
# 换成你自己的流程时，这里通常是"选今天的题 → 生成 → 评分 → 调发布工具"。
DRAFT="$(bash "$SCRIPT_DIR/generate.sh" "$SLOT" "模板生成的选题" | tail -1)"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 产出草稿：$DRAFT" >> "$LOG_FILE"

{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [END] slot=$SLOT exit_code=0"
  echo "================================================"
} >> "$LOG_FILE"
