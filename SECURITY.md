# 安全策略

## 安全模型

CrossPost 是**本地运行、复用你自己浏览器登录态**的多平台草稿同步工具。它的安全边界：

- **数据不离开你的设备**：平台请求由本机浏览器扩展在你已登录的页面里发出，没有中转服务器、没有数据上传。
- **不模拟登录、不绕过风控**：使用你在浏览器里正常登录后的既有凭据，调用各平台 Web 编辑器的公开接口。
- **恒草稿**：所有通道只创建草稿，绝不替你按下发布。
- **凭证不硬编码**：个人密钥（如微信 AppSecret）一律走环境变量或本机运行态文件，不进仓库。
- **本机鉴权**：桥的 HTTP 接口要求 `X-CrossPost-Token`（启动时生成，Console 的「接入与自检」页可见）。

## 合规与使用边界

> ⚠️ 本工具用于**技术学习与自用研究**。使用它需要遵守各平台的**服务条款**；
> 因使用本工具导致的账号封禁或法律风险由使用者自行承担，作者不负责。

**请勿用于**：批量灌稿、突破平台频控、绕过平台反自动化机制、发布违法违规内容。

各平台名称、商标、Logo 归其各自所有方所有；本项目与各平台无隶属或授权关系。

## 凭证与敏感信息

仓库内**不含任何个人账号凭证**。以下运行时文件由 `.gitignore` 覆盖，不随仓库分发：

- `crosspost-runtime/config.json`、`paths.json`、`storage.json`、`ever-authed.json`、`platforms-state.json`
- `crosspost-runtime/token.*.json`、`crosspost-runtime/.env`、`crosspost-runtime/downloads/`、`crosspost-runtime/backups/`
- `bridge/token.local`、`bridge/brand/`
- `.local/`（引擎本地数据区：草稿、记录、日志、调度状态）

平台登录态（Cookie）只存在于你自己的浏览器里，本仓库不复制、不落盘。

## 报告安全漏洞

请通过仓库的 **GitHub Security Advisories**（私有报告通道）提交，避免公开细节导致被利用：
<https://github.com/dos2un1x/crosspost/security/advisories/new>。
请附上复现步骤与受影响版本（`npm run doctor` 会打印引擎版本）。

本仓库为**公开仓库**，任何人都可以阅读代码、提交 Issue 与 PR。因此安全漏洞**务必**走上面的私有报告通道，不要在公开 Issue 或 PR 中披露复现细节。

## 数据落点

各目录的用途与数据边界见 [`docs/security.md`](docs/security.md)。
