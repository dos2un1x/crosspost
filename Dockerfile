# CrossPost 容器镜像（只提供**运行时**）
#
# 设计取舍（见 docs/docker.md）：
#   · 镜像里**不装代码**：仓库以**同一个绝对路径**挂进来（宿主与容器路径一致），
#     于是 `paths.json` / `config.json` / 项目 manifest 里那些绝对路径**零改写**。
#   · 镜像里**不装依赖**：`entrypoint.sh` 首次启动时按仓库的 lockfile 装进
#     容器私有卷（`node_modules` / `core/dist`）。理由：本机依赖树与容器依赖树
#     不能共用（`sharp` 是按平台预编译的原生依赖），而把依赖烤进镜像又会与
#     "仓库即事实来源"漂移。
#   · 不装浏览器：样式采样（Playwright）在容器里自动降级为 fetch；
#     要保真就 `EXTRA_APT="chromium"` 重建镜像。
FROM node:24-bookworm-slim

# ── 许可（GPL-3.0-only）──
# 镜像里放着本仓库的代码（`docker/entrypoint.sh`），所以"分发镜像"就是分发这份代码，
# 许可证全文必须随镜像一起走。仓库根目录那一份**不会**自动进来：`.dockerignore` 是
# "先全排除、再逐个放行"的白名单，要在这里 COPY 就必须同时在那里放行 `!LICENSE`。
LABEL org.opencontainers.image.licenses="GPL-3.0-only"
COPY LICENSE /usr/local/share/doc/crosspost/LICENSE

# curl：桥的局域网数据源探测；git：版本真值（`git describe`，无 git 时回退 package.json）
# tzdata：调度按 config.scheduler.tz 解释墙钟时间，容器里必须有 tz 库
# gosu：entrypoint 按 CROSSPOST_UID/GID 降权（Linux 宿主上避免写出一堆 root 属主文件）
# zstd（含 unzstd）：DSH 会话文件是 zstd 压缩的，费用报表要解它（2026-09-25 加）。
#   与 CI 的做法一致（runner 上也单独装了 zstd）；不装的话"费用报表"在容器里必然降级。
#   注意 Debian 把它放 /usr/bin/unzstd，而代码曾经写死 /usr/local/bin/unzstd —— 两边
#   现在都按 PATH 解析（见 src/token-cost.mjs 的 resolveUnzstd）。
ARG EXTRA_APT=""
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tzdata gosu zstd \
  && if [ -n "$EXTRA_APT" ]; then apt-get install -y --no-install-recommends $EXTRA_APT; fi \
  && rm -rf /var/lib/apt/lists/*

# 飞书 CLI（可选依赖，2026-09-25 加；通知通道 channel=lark 时引擎会调它）
#
# 为什么必须装进镜像、不能挂宿主的：npm 包 `@larksuite/cli` 只是个包装，真身是
# 平台专属二进制（宿主上那份是 44MB 的 Mach-O，**Linux 容器里跑不了**）。
# 安装器会按 platform/arch 取对应构建（支持 linux/amd64），并有 npmmirror 回退。
#
# **始终装最新**（LARK_CLI_VERSION=latest，可传版本号钉住，例如 1.0.79）。
# 两个必须知道的副作用：
#   ① Docker 层缓存会把 `latest` 钉在构建那一刻的版本 → 升级要走
#      `docker compose build --build-arg LARK_CLI_REFRESH=$(date +%s)`
#      （LARK_CLI_REFRESH 只为让这一层失效，本身不参与安装）。
#   ② 容器内 CLI 的"自更新"是临时的（写在容器可写层，重建即回退）→ 升级的唯一正道是重建镜像。
# 不需要（webhook 通道）就 --build-arg LARK_CLI_VERSION= 跳过，镜像小约 50MB。
#
# `--allow-scripts=@larksuite/cli` 不能省（2026-09-25 实测踩到）：npm 11.19 起默认
# **不跑**依赖的 install 脚本（新安全策略），而 `@larksuite/cli` 的 postinstall
# （`node scripts/install.js`）正是去下载平台二进制的那个 —— 不放开的话 npm 会
# "装成功"、包在、`lark-cli` 命令也在，但 `bin/lark-cli` 根本不存在，
# 运行时报错。这类"装上了却不能用"的假通过，正是本项目最在意的一种。
# `lark-cli --version`（而不是 `version`）：后者在 1.0.96 上是未知命令。
ARG LARK_CLI_VERSION="latest"
ARG LARK_CLI_REFRESH=""
RUN if [ -n "$LARK_CLI_VERSION" ]; then \
      npm i -g --allow-scripts=@larksuite/cli "@larksuite/cli@${LARK_CLI_VERSION}" \
      && lark-cli --version \
      && test -x /usr/local/lib/node_modules/@larksuite/cli/bin/lark-cli; \
    else \
      echo "跳过 lark-cli（LARK_CLI_VERSION 为空）"; \
    fi

# playwright 在引擎里只有一处动态 import（样式采样），且失败会自动降级为 fetch；
# 装浏览器会让镜像多几百 MB，默认跳过。
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

COPY docker/entrypoint.sh /usr/local/bin/crosspost-entrypoint
# `crosspost` = 同一个入口脚本的短名。为什么需要它（v2.3.5 实测）：
# `docker compose exec` **不走 ENTRYPOINT**，所以文档里写的
# `docker compose exec crosspost doctor` 会 exit 127（容器里根本没有 doctor 这个可执行文件）。
# 有了这个短名，文档里那几条"对正在跑的容器做体检/看调度/调 CLI"就能照抄即用：
#   docker compose exec crosspost crosspost doctor
# （不装 bare name 的 doctor/cli/sh：那些名字太通用，会盖住系统命令。）
RUN chmod +x /usr/local/bin/crosspost-entrypoint \
  && ln -s /usr/local/bin/crosspost-entrypoint /usr/local/bin/crosspost \
  && chmod 0644 /usr/local/share/doc/crosspost/LICENSE

ENTRYPOINT ["/usr/local/bin/crosspost-entrypoint"]
CMD ["bridge"]
