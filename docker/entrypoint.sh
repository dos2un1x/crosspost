#!/usr/bin/env bash
# CrossPost 容器入口（v2.3）
#
# 它只做四件事，且都可以重复执行（幂等）：
#   ① 校验 CROSSPOST_REPO（必须是仓库的**绝对路径**，且与宿主机上的路径逐字相同）
#   ② 需要时按 CROSSPOST_UID/GID 降权（Linux 宿主上避免把 root 属主文件写进挂载目录）
#   ③ 缺依赖时跑一次 `setup`（装进容器私有卷 + 构建 core/dist）
#   ④ core 产物**比源码旧**时就地重建（容器私有卷不会随 restart 更新，见下面 ④ 的注释）
#   ⑤ 按第一个参数分派：bridge（缺省）/ doctor / cli … / scheduler / setup / sh
#
# 为什么宿主与容器路径必须一致：`paths.json`、`config.json`、项目 manifest 里存的
# 都是**绝对路径**；路径一变，所有指向都会失效（容器里看不到宿主那些目录）。
# 所以 docker-compose.yml 用 `${HOME}:${HOME}` 这种同路径挂载。
# © dos2un1x · https://github.com/dos2un1x/crosspost
set -euo pipefail

REPO="${CROSSPOST_REPO:-}"
if [ -z "$REPO" ]; then
  echo "错误：未设置 CROSSPOST_REPO（应为仓库的绝对路径，且与宿主路径一致）" >&2
  echo "  例：export CROSSPOST_REPO=\"\$PWD\" && docker compose up -d" >&2
  exit 1
fi
if [ ! -d "$REPO" ]; then
  echo "错误：CROSSPOST_REPO 不是目录：${REPO}（是不是忘了把仓库挂进来？）" >&2
  exit 1
fi
if [ ! -f "$REPO/crosspost-runtime/package.json" ]; then
  echo "错误：${REPO} 看起来不是 CrossPost 仓库（缺 crosspost-runtime/package.json）" >&2
  exit 1
fi

cd "$REPO"

# ── ② 降权（可选但推荐：Linux 宿主上设 CROSSPOST_UID/GID 为本机 uid/gid）──
if [ -n "${CROSSPOST_UID:-}" ] && [ "${CROSSPOST_UID}" != "0" ]; then
  GID="${CROSSPOST_GID:-$CROSSPOST_UID}"
  # 只 chown 容器私有卷与调度数据目录：挂载进来的仓库/hone 由宿主决定属主，
  # 不在这里大范围改写（那会很慢，而且容易把宿主的权限改乱）。
  for d in \
    "$REPO/crosspost-runtime/core/dist" \
    "$REPO/crosspost-runtime/node_modules" \
    "$REPO/bridge/node_modules" \
    "${CROSSPOST_LOCAL_ROOT:-$REPO/.local}/scheduler"; do
    [ -e "$d" ] && chown -R "$CROSSPOST_UID:$GID" "$d" 2>/dev/null || true
  done
  exec gosu "$CROSSPOST_UID:$GID" "$0" --no-drop "$@"
fi

# 参数解析：`--no-drop` 是降权后重入本脚本时用的内部参数，不对使用者暴露
if [ "${1:-}" = "--no-drop" ]; then shift; fi
CMD="${1:-bridge}"
shift || true

# ── ③ 依赖（缺才装；装进容器私有卷，绝不碰宿主的 node_modules）──
#
# 判据**不在这里另写一份**：调用 src/deps.mjs（子包依赖判据的唯一事实来源），
# 与 setup / setup-cli / doctor 共用同一套探针。历史上这里手抄过一份探针列表，
# 而"core 是否构建好"那一条抄成了"目录在不在"——Docker 模式下 core/dist 是**空卷**，
# 目录判据恒为真 → 容器里 core 永远缺 → CLI worker 全部 ERR_MODULE_NOT_FOUND，
# 而容器还是 healthy（2026-09-25 实测）。共用一份就不会再飘。
need_setup=0
node -e '
const repo = process.cwd()
import("file://" + repo + "/crosspost-runtime/src/deps.mjs")
  .then((d) => process.exit(d.missingDeps(repo).length || !d.coreBuilt(repo) ? 1 : 0))
  .catch((e) => {
    console.error("[entrypoint] 依赖探针加载失败：" + String((e && e.message) || e))
    process.exit(1)
  })
' || need_setup=1

if [ "$need_setup" = "1" ]; then
  echo "[entrypoint] 依赖或 core 产物缺失：先跑一次 setup（首次启动需要网络，几分钟）"
  node crosspost-runtime/src/commands/setup-cli.mjs
fi

# ── ④ core 产物过期（源码比 dist 新）就地重建 ──
#
# 为什么必须有这一步：`core/dist` 在容器里是**私有卷**，`docker compose restart` 只重启进程、
# 不重建产物。于是容器可能跑着好几周前编译出来的适配器/渲染器，而报错文案与仓库代码对不上
# （有过一次：追到 WAF 上去了）。
#
# 判据**不在这里另写一份**：调用 src/deps.mjs 的 `coreDistFreshness` —— 与 doctor、
# setup 共用同一套规则（这里当年手抄过一次"目录在不在"，后果见 ③ 的注释）。
# 只重建，不跑完整 setup：构建不需要网络，只要 tsup/dts 在依赖树里（③ 已保证）。
need_rebuild=0
node -e '
const repo = process.cwd()
import("file://" + repo + "/crosspost-runtime/src/deps.mjs")
  .then((d) => {
    const f = d.coreDistFreshness(repo)
    if (f && f.stale) {
      const behind =
        f.behindMs >= 3600000
          ? Math.round(f.behindMs / 3600000) + " 小时"
          : Math.round(f.behindMs / 60000) + " 分钟"
      console.error("[entrypoint] core 产物比源码旧（落后约 " + behind + "）：就地重建")
      process.exit(1)
    }
    process.exit(0)
  })
  .catch((e) => {
    // 探针本身跑不起来（依赖树还没就位等）：交给 ③ 的 setup 路径，不在这里硬判
    console.error("[entrypoint] 产物新鲜度探针跳过：" + String((e && e.message) || e))
    process.exit(0)
  })
' || need_rebuild=1

if [ "$need_rebuild" = "1" ]; then
  if npm -C crosspost-runtime/core run build; then
    echo "[entrypoint] core 产物已重建"
  else
    # 构建失败**不拒绝启动**：容器里还有上一份产物，能跑（doctor 会把不同步报成提醒）。
    # 反过来"构建失败就起不来"会让一次磁盘/依赖抖动变成整个服务不可用。
    echo "[entrypoint] 警告：core 产物重建失败，先用现有产物启动（doctor 会提示不同步）" >&2
  fi
fi

# ── ⑤ 分派 ──
case "$CMD" in
  bridge)
    exec node bridge/run-bridge.mjs "$@"
    ;;
  scheduler)
    # 只跑定时器（不启桥）：容器里没必要同时开两个进程时用它
    exec node crosspost-runtime/src/commands/scheduler-cli.mjs run "$@"
    ;;
  doctor)
    exec node crosspost-runtime/src/commands/doctor-cli.mjs "$@"
    ;;
  setup)
    exec node crosspost-runtime/src/commands/setup-cli.mjs "$@"
    ;;
  cli)
    exec node crosspost-runtime/src/cli.mjs "$@"
    ;;
  scheduler-cli)
    exec node crosspost-runtime/src/commands/scheduler-cli.mjs "$@"
    ;;
  sh|bash)
    # 必须把剩下的参数**透传**（2026-09-25 修）：原来写的是 `exec /bin/bash`，
    # 于是 `docker compose run --rm crosspost sh -c '…'` 会**静默什么都不做**
    # （-c 与命令一起被丢掉，退出码还是 0）——正是最难排查的那类"假通过"。
    exec /bin/bash "$@"
    ;;
  *)
    echo "未知命令：$CMD" >&2
    echo "可用：bridge（缺省）/ scheduler / doctor / setup / cli / scheduler-cli / sh" >&2
    exit 1
    ;;
esac
