# MCP 工具参考

服务端 `crosspost-runtime/mcp-server/index.mjs` 经 stdio 暴露 24 个工具，在会话里全名为 `mcp__crosspost__<name>`（前缀取自 profile 的 `serverName`）。

本文件的清单由服务端 `tools/list` 生成，与运行时一致；JSON 版本见 [`mcp-tools.json`](mcp-tools.json)。

## 总览

| 分组         | 工具                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 状态与自检   | `status` `projects` `list_platforms` `check_auth` `proxy_test`                                                                  |
| 内容输入     | `extract_article`                                                                                                               |
| 图床         | `upload_image_file`                                                                                                             |
| 发布与留存   | `sync_article` `publish_styled` `publish_article` `retain_article`                                                              |
| 微信官方通道 | `wechat_draft` `wechat_draft_delete`                                                                                            |
| 样式         | `list_styles` `render_preview` `generate_cover` `analyze_style` `create_style` `install_styles` `styles_delete` `styles_rename` |
| 写作流水线   | `record_writing` `topic_pool_upsert` `ai_detect`                                                                                |

## 逐工具参数

### 状态与自检

#### `status`

全名 `mcp__crosspost__status`。多平台发布助手状态（经浏览器代理通道）：proxyMode、扩展连接、Bridge 状态。

无参数。

#### `projects`

全名 `mcp__crosspost__projects`。列出经 .crosspost/project.json 接入引擎的写作项目：id / 名称 / 声明的能力 / 数据源可达性。未接入任何项目时返回空列表（引擎仍可用，平台域功能不依赖项目）。

| 参数        | 类型   | 必填 | 说明                  |
| ----------- | ------ | ---- | --------------------- |
| `projectId` | string | 否   | 可选：只查某个项目 id |

#### `list_platforms`

全名 `mcp__crosspost__list_platforms`。列出27 个已知平台（默认派发 10 个）的登录状态（经浏览器代理）：isAuthenticated / username / error。

无参数。

#### `check_auth`

全名 `mcp__crosspost__check_auth`。检查指定平台登录状态（经浏览器代理）。

| 参数       | 类型   | 必填 | 说明                          |
| ---------- | ------ | ---- | ----------------------------- |
| `platform` | string | 是   | 平台 ID，如 zhihu/csdn/juejin |

#### `proxy_test`

全名 `mcp__crosspost__proxy_test`。验收工具：经浏览器代理通道请求 httpbin 系服务，返回实际请求头，验证来源检测一致性（浏览器原生 UA/Sec-Fetch）。

无参数。

### 内容输入

#### `extract_article`

全名 `mcp__crosspost__extract_article`。从 URL 或已打开的浏览器标签页提取文章（标题/正文 Markdown/HTML/封面）。activeTab 为 true 时读活动标签页（url 可选，用于匹配指定标签页）。

| 参数        | 类型    | 必填 | 说明                                                                 |
| ----------- | ------- | ---- | -------------------------------------------------------------------- |
| `url`       | string  | 否   | 文章 URL；activeTab 模式下用它匹配已打开的标签页，否则直接抓取该 URL |
| `activeTab` | boolean | 否   | 为 true 时从浏览器已打开的标签页提取                                 |

### 图床

#### `upload_image_file`

全名 `mcp__crosspost__upload_image_file`。把本地图片上传到指定平台图床（默认 zhihu）。返回图片 URL，可作正文插图/封面。

| 参数       | 类型   | 必填 | 说明                 |
| ---------- | ------ | ---- | -------------------- |
| `filePath` | string | 是   | 本地图片绝对路径     |
| `platform` | string | 否   | 图床平台，默认 zhihu |

### 发布与留存

#### `sync_article`

全名 `mcp__crosspost__sync_article`。把文章发布到目标平台（恒为草稿，不直接发布，防封禁；经浏览器代理）。目标平台限27 个已知平台（默认派发 10 个）。并发发布，结果按请求顺序返回。

| 参数          | 类型          | 必填 | 说明                                           |
| ------------- | ------------- | ---- | ---------------------------------------------- |
| `platforms`   | array<string> | 是   | 目标平台 ID 列表，如 ["zhihu","csdn","juejin"] |
| `title`       | string        | 是   | 文章标题（纯文本）                             |
| `markdown`    | string        | 否   | Markdown 正文（不含标题行）                    |
| `content`     | string        | 否   | HTML 正文（可选，与 markdown 二选一）          |
| `cover`       | string        | 否   | 封面图 URL（可选）                             |
| `concurrency` | number        | 否   | 并发发布数（默认取配置，1-10）                 |

#### `publish_styled`

全名 `mcp__crosspost__publish_styled`。用样式引擎渲染 Markdown（内置 10 样式 + 公式 + 脚注 + 引用 + ASCII 表格）后同步到目标平台（恒为草稿，经浏览器代理）。图片经 zhihu 图床（本地/外链自动上传）。

| 参数          | 类型          | 必填 | 说明                                           |
| ------------- | ------------- | ---- | ---------------------------------------------- |
| `platforms`   | array<string> | 是   | 目标平台 ID 列表，如 ["zhihu","csdn","weixin"] |
| `title`       | string        | 是   | 文章标题                                       |
| `markdown`    | string        | 是   | Markdown 正文                                  |
| `style`       | string        | 否   | 样式名（默认 swiss）                           |
| `cover`       | string        | 否   | 封面图 URL（可选）                             |
| `concurrency` | number        | 否   | 并发发布数（默认取配置，1-10）                 |

#### `publish_article`

全名 `mcp__crosspost__publish_article`。读草稿文件 → 校验 → 样式渲染 → 微信官方通道存草稿 → 多平台存草稿（失败自动重试 1 次）→ 写文章库记录 → 按配置发通知。恒为草稿，绝不自动发表。平台列表缺省取 config.json platforms.default（面板设置页可配置）；未登录平台发布器自动跳过（skip，通知注明），不报失败。**是否真的派发受 config.json.autoPush「生成后自动推送」开关门控：定时链路（WECHAT_AUTO_SCHEDULED=1）永不豁免——开关关闭时只落草稿并返回 dispatch:"skipped" 与 skipReason；交互式会话/CLI/Console 属人工触发，不受开关限制，但也不得改调 sync_article/publish_styled/wechat_draft 绕过**。AI 只需调用这一次即可完成全部发布流程，返回结构化结果（微信 mediaId、各平台 postUrl、未登录跳过列表）。

| 参数          | 类型                | 必填 | 说明                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | ------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`        | string              | 否   | 草稿文件绝对路径（与 id 二选一）                                                                                                                                                                                                                                                                                                                                                                         |
| `id`          | string              | 否   | 草稿 id（文件名去 .md，如 YYYY-MM-DD-hotspot-xxx）                                                                                                                                                                                                                                                                                                                                                       |
| `project`     | string              | 否   | 目标写作项目 id（可选；缺省取会话级 CROSSPOST_PROJECT，再缺省走默认草稿目录）。指定后会按 .crosspost/project.json 解析该项目的草稿目录再找 id，避免发错项目的同 id 草稿                                                                                                                                                                                                                                  |
| `style`       | string              | 否   | 样式名（默认按栏目映射：morning=swiss/noon=editorial/evening=ink/tips=ink/hotspot=editorial）                                                                                                                                                                                                                                                                                                            |
| `platforms`   | array<string>       | 否   | 平台 ID 列表（缺省取 config.json platforms.default，面板设置页可配置；未登录平台自动跳过；douyin 仅走手动通道）                                                                                                                                                                                                                                                                                          |
| `wechat`      | boolean             | 否   | 是否走微信官方通道（默认 true）                                                                                                                                                                                                                                                                                                                                                                          |
| `notify`      | boolean             | 否   | 发布后是否按配置发通知（默认 true，通知由发布器直发不经 AI）                                                                                                                                                                                                                                                                                                                                             |
| `concurrency` | number              | 否   | 多平台并发数（默认 5，1-10）                                                                                                                                                                                                                                                                                                                                                                             |
| `score`       | number              | 否   | 文章质量评分（0-100，§5.5 自评写 frontmatter 时可省略，发布器自动读取；显式传入时优先）                                                                                                                                                                                                                                                                                                                  |
| `scoreDims`   | object<string, any> | 否   | 评分维度明细（可选，随 score 入库）                                                                                                                                                                                                                                                                                                                                                                      |
| `rewrites`    | number              | 否   | 低分重写次数（可选，随 score 入库）                                                                                                                                                                                                                                                                                                                                                                      |
| `decision`    | string              | 否   | 编辑决策快照（可选，§4.0 决策行「决策=主线\|理由\|重复风险」原文，随记录/历史入库，可复盘）                                                                                                                                                                                                                                                                                                              |
| `review`      | string              | 否   | 独立审稿快照（可选，§5.6 审稿行「审稿=分 行动=publish\|revise\|block 修订=n」原文，随记录/历史入库，可复盘）                                                                                                                                                                                                                                                                                             |
| `aiDetect`    | string              | 否   | AI 检测快照（可选，§5.55 门禁行原文，直接传 `ai_detect` 返回里的 `snapshot` 字段，形如「AI检测=达标 · AI特征 10.4% < 30.0% · 片段 8人工/1疑似/1AI · 2620字 · 风格 正常」；随记录/历史入库，并出现在发布通知里。**检测被跳过时也要传**（原因会写进去），否则事后无法区分"通过"与"没检测"。注意：config.json → aiDetect.requireSnapshotOnPublish=true 时，不传这项会**不派发**（仍落草稿，回执里给原因）） |

#### `retain_article`

全名 `mcp__crosspost__retain_article`。把草稿移入 drafts/rejected（低分）或 drafts/risk（高风险）并写文章库记录（**恒不发布**）。写作侧在这些时刻调用：自评/审稿未过、命中风险、AI 检测轮数用尽仍不达标（§5.55）。`reason` 请带上可复盘的原文（如 AI 门禁行「AI检测=超标 · AI特征 47.2% ≥ 30.0% …」，直接传 `ai_detect` 返回的 `snapshot`），它会显示在 Console 留存库的「留存原因」列。记录由引擎写，不受调用方文件沙箱限制（这是它与 shell 调 CLI 的关键区别）。

| 参数      | 类型                           | 必填 | 说明                                                    |
| --------- | ------------------------------ | ---- | ------------------------------------------------------- |
| `id`      | string                         | 是   | 草稿文件名去 .md                                        |
| `dir`     | string · 枚举: rejected / risk | 否   | 留存目录：rejected=低分库（默认）/ risk=风险库          |
| `reason`  | string                         | 否   | 留存原因（显示在 Console 留存库；建议带 AI 门禁行原文） |
| `project` | string                         | 否   | 目标项目 id（可选；缺省取连接配置 CROSSPOST_PROJECT）   |

### 微信官方通道

#### `wechat_draft`

全名 `mcp__crosspost__wechat_draft`。用 AppID/AppSecret 直连微信官方 API 创建公众号草稿（恒草稿）：样式渲染 + 正文图官方 CDN 上传 + 封面自动生成上传。需在 crosspost-runtime/.env 或 config.json 配置 WECHAT_APP_ID/WECHAT_APP_SECRET。

| 参数        | 类型   | 必填 | 说明                                |
| ----------- | ------ | ---- | ----------------------------------- |
| `title`     | string | 是   | 文章标题                            |
| `markdown`  | string | 是   | Markdown 正文                       |
| `style`     | string | 否   | 样式名（默认 swiss）                |
| `thumb`     | string | 否   | 封面本地文件路径（缺省自动生成）    |
| `author`    | string | 否   | 作者（可选，空则不显示）            |
| `digest`    | string | 否   | 摘要（可选，空则不显示）            |
| `sourceUrl` | string | 否   | 原文链接 content_source_url（可选） |

#### `wechat_draft_delete`

全名 `mcp__crosspost__wechat_draft_delete`。按 mediaId 删除微信官方 API 通道创建的公众号草稿（不可恢复）。mediaId 取自 wechat_draft 返回的 mediaId，或经 CLI wechatDrafts 列表核对标题后使用。

| 参数      | 类型   | 必填 | 说明                                        |
| --------- | ------ | ---- | ------------------------------------------- |
| `mediaId` | string | 是   | 草稿 mediaId（wechat_draft 返回的 mediaId） |

### 样式

#### `list_styles`

全名 `mcp__crosspost__list_styles`。列出可用样式（内置 10 + custom）：name / category / desc。

无参数。

#### `render_preview`

全名 `mcp__crosspost__render_preview`。用指定样式渲染 Markdown 为微信兼容 styled HTML（纯本地零网络）。返回完整 HTML，供检查样式效果。

| 参数       | 类型   | 必填 | 说明                                     |
| ---------- | ------ | ---- | ---------------------------------------- |
| `markdown` | string | 是   | Markdown 正文                            |
| `style`    | string | 否   | 样式名（默认 swiss；内置 10 + custom-*） |

#### `generate_cover`

全名 `mcp__crosspost__generate_cover`。根据标题 + 封面模板生成双尺寸封面 PNG（2.35:1 主图 + 1:1 缩略，本地程序化渲染，免费无版权，中文正常）。模板：nebula 星云 / orb3d 3D球 / aurora 极光 / particles 粒子 / glasscard 玻璃卡 / spectrum 频谱 / bokeh 光斑 / cyber 霓虹 / skyline 天际线 / mountains 山峦 / bignum 大数字 / iridescent 虹彩 / minimal 极简留白。返回 PNG 文件路径。

| 参数       | 类型   | 必填 | 说明                                  |
| ---------- | ------ | ---- | ------------------------------------- |
| `title`    | string | 是   | 文章标题                              |
| `template` | string | 否   | 封面模板（默认 nebula；13 款可选）    |
| `subtitle` | string | 否   | 副标题（可选）                        |
| `tag`      | string | 否   | 栏目角标（可选）                      |
| `outDir`   | string | 否   | 输出目录（默认 /tmp/crosspost-cover） |

#### `analyze_style`

全名 `mcp__crosspost__analyze_style`。从 URL 或本地 HTML 分析文章视觉样式并保存为 custom 样式（Playwright 计算样式 + 标题/引用结构识别，channel:chrome 复用系统浏览器）。

| 参数       | 类型   | 必填 | 说明                                    |
| ---------- | ------ | ---- | --------------------------------------- |
| `url`      | string | 否   | 文章 URL（Playwright 打开页面分析）     |
| `htmlPath` | string | 否   | 本地 HTML 文件路径                      |
| `name`     | string | 否   | 样式名（缺省由文章标题生成 custom-xxx） |

#### `create_style`

全名 `mcp__crosspost__create_style`。克隆模板 + 参数定制创建新样式（如 name="品牌绿" from="swiss" params={accent:"#2f9e44"}）。创建后立即可用于 render_preview/publish_styled。

| 参数     | 类型                | 必填 | 说明                                                                                                                                        |
| -------- | ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`   | string              | 是   | 样式名（自动补 custom- 前缀）                                                                                                               |
| `from`   | string              | 否   | 模板样式（默认 swiss；内置或已存在 custom）                                                                                                 |
| `params` | object<string, any> | 否   | 覆盖字段：bg/accent/text/secondary/font/borderWidth/desc/headingProfile/headingStructure/blockquoteStructure 等（旧式下划线字段名仍被接受） |

#### `install_styles`

全名 `mcp__crosspost__install_styles`。把一份样式包装进自有样式目录（一个样式一个 JSON，装完即可在 list_styles 与 Console 下拉里选到）。缺省装仓库自带的起手包（crosspost-runtime/styles/，55 个）；也可以指向旧样式目录做一次性迁移（旧拼写会被翻译、已废弃的 cssTemplate 会被忽略、颜色字段里的 !important 与渐变会被规整成 hex）。逐个校验：坏文件只报错不写盘。

| 参数     | 类型    | 必填 | 说明                                         |
| -------- | ------- | ---- | -------------------------------------------- |
| `dir`    | string  | 否   | 样式包目录（缺省 = 仓库自带的起手包）        |
| `force`  | boolean | 否   | 已存在的同名样式是否覆盖（默认 false，跳过） |
| `dryRun` | boolean | 否   | 只报告不写盘（校验规则与真装一致）           |

#### `styles_delete`

全名 `mcp__crosspost__styles_delete`。删除一个 custom 样式（内置样式无法删除，会返回"样式不存在"）。删除后立即可用 list_styles 验证。

| 参数   | 类型   | 必填 | 说明                                                                      |
| ------ | ------ | ---- | ------------------------------------------------------------------------- |
| `name` | string | 是   | 样式名（自动补 custom- 前缀），如 custom-deepseek-harness手把手详细安装教 |

#### `styles_rename`

全名 `mcp__crosspost__styles_rename`。重命名 custom 样式（自动补 custom- 前缀；内置样式无法重命名）。

| 参数      | 类型   | 必填 | 说明                           |
| --------- | ------ | ---- | ------------------------------ |
| `oldName` | string | 是   | 旧样式名，如 custom-xxx 或 xxx |
| `newName` | string | 是   | 新样式名                       |

### 写作流水线

#### `record_writing`

全名 `mcp__crosspost__record_writing`。把写作侧的 §2.5 决策行与 §5.6 审稿行写进**这篇文章的文章库记录**（Console 抽屉的「编辑决策」「独立审稿」两张卡与发布历史都读它）。**不发布也能记**——这是它与publish_article 入参的关键区别。原文照抄即可（面板会把它拆成字段排版：主线/理由/重复风险/写作指令，审稿的行动/分数/issues 逐条）。只给一个字段也行，另一个保持原值；三个都不给会被拒（别写空历史）。

| 参数       | 类型   | 必填 | 说明                                                                                      |
| ---------- | ------ | ---- | ----------------------------------------------------------------------------------------- |
| `id`       | string | 否   | 草稿文件名去 .md（与 file 二选一）                                                        |
| `file`     | string | 否   | 草稿文件绝对路径（与 id 二选一）                                                          |
| `decision` | string | 否   | §2.5 决策行原文，形如「决策=主线…\|理由=…\|重复风险=medium(避开角度:…)\|写作指令=…」      |
| `review`   | string | 否   | §5.6 审稿行原文，形如「审稿=90 自评=92 行动=publish issues=2(minor:事实-…;minor:表达-…)」 |
| `note`     | string | 否   | 随记录写进历史的一条短注（如「修订后复评」）                                              |
| `project`  | string | 否   | 目标项目 id（可选；缺省取连接配置 CROSSPOST_PROJECT）                                     |

#### `topic_pool_upsert`

全名 `mcp__crosspost__topic_pool_upsert`。把本轮候选（含落选）写入项目选题库，按 (date, slot, keyword) upsert：命中的条目就地更新、未命中的追加，绝不移除同日同 slot 的其它条目，已 generated 的条目不降级。任何一行不合格 → 整次写入被拒（一个字节都不落盘），返回里带逐条原因。目标项目由连接配置（CROSSPOST_PROJECT）决定，无需传项目。

| 参数        | 类型          | 必填 | 说明                                                     |
| ----------- | ------------- | ---- | -------------------------------------------------------- |
| `date`      | string        | 是   | 候选所属日期，YYYY-MM-DD                                 |
| `slot`      | string        | 是   | 槽位 id，例如 hotspot / hotspot2 / tips / noon / evening |
| `rows`      | array<object> | 是   | 本轮候选：3-5 条，采用项与落选都要写                     |
| `manual`    | boolean       | 否   | 一键生成分支：只写自己这一条（status=generated）         |
| `articleId` | string        | 否   | manual 分支的草稿文件名（去 .md）                        |

#### `ai_detect`

全名 `mcp__crosspost__ai_detect`。用腾讯朱雀（EdgeOne Makers 内置模型 @makers/zhuque-text）检测一篇文章的 AI 生成浓度，返回整体判定（pass/fail/skip）、AI 特征字符占比，以及**被判 AI 的片段**（含回映射到正文的字符区间与预览）。检测对象是剥离 markdown 标记后的纯文本（正文需 >350 字，过短直接 skip）。凭证走 crosspost-runtime/.env 的 ZHUQUE_API_KEY（追加额度可再用 ZHUQUE_API_KEYS 填多把，引擎在余量最多的 key 之间均衡消耗、某把被限流/额度用尽时自动换下一把）；无凭证或配额不足时返回 skip 而不是报错——调用方必须把 skip 记成「未检测」，不得当成通过。

| 参数           | 类型                                         | 必填 | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | -------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`         | string                                       | 否   | 草稿文件绝对路径（与 id / text 三选一）                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `id`           | string                                       | 否   | 草稿文件名去 .md（在当前项目草稿目录里找；与 file / text 三选一）                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `text`         | string                                       | 否   | 直接给正文（基线回测/排查用；与 file / id 三选一）                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `project`      | string                                       | 否   | 目标项目 id（可选；缺省取会话级 CROSSPOST_PROJECT）                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `mode`         | string · 枚举: bands / distribution / metric | 否   | 判定口径模式（缺省取 config.json → aiDetect.gate.mode）：bands=三段各给一个区间（humanMin~~humanMax / aiMin~~aiMax / uncertainMin~uncertainMax，三项之和为 1，故"每段都 ≥30%"实际等价于"每段都落在 30%-40%"）；distribution=三条硬线（人工≥humanMin、AI≤aiMax、疑似≤uncertainMax）；metric=旧的单指标口径                                                                                                                                                                                                           |
| `humanMin`     | number                                       | 否   | distribution 模式：人工特征占比下限 0-1（缺省 config → aiDetect.gate.humanMin）                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `aiMax`        | number                                       | 否   | distribution 模式：AI 特征占比上限 0-1（缺省 config → aiDetect.gate.aiMax）                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `uncertainMax` | number                                       | 否   | distribution 模式：疑似 AI 占比上限 0-1（缺省 config → aiDetect.gate.uncertainMax）                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `humanMax`     | number                                       | 否   | bands 模式：人工特征占比上界 0-1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `aiMin`        | number                                       | 否   | bands 模式：AI 特征占比下界 0-1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `uncertainMin` | number                                       | 否   | bands 模式：疑似 AI 占比下界 0-1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `sampleRate`   | number                                       | 否   | 抽样检测率 0-1（缺省 config → aiDetect.sampleRate，默认 1 全检）。按正文哈希确定性抽样，省配额                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `enforce`      | string · 枚举: observe / block               | 否   | 门禁强度（缺省 config → aiDetect.gate.enforce）：observe=只报不拦（**不进入重写循环**，省配额）；block=硬门禁（按 rewriteTargets 定向改写，仍不达标则留存）。返回里 `rewriteRequired` 才是"本次要不要改"的判据（`action` 只表强度：pass 的稿子在 block 下也是 "block"）；`rewriteNeed.mustRewrite` = 引擎算出的"本轮至少要清几段"（清单长度就是它，同类里按置信度升序递），`advise=retain` 表示一轮救不回来（需清段数超容量，或 `rewriteNeed.charGuard=false`）、直接留存；轮数照 `rewriteBudget.maxRounds`，别自定 |
| `metric`       | string · 枚举: confidence / labels_ai / both | 否   | 旧口径的单指标（仅 mode=metric 时生效，缺省取 config.json → aiDetect.gate.metric）：confidence=整体 AI 浓度（官网顶部那个数）/ labels_ai=AI 特征字符占比 / both=两者都低于阈值                                                                                                                                                                                                                                                                                                                                      |
| `threshold`    | number                                       | 否   | 旧口径的判定阈值 0-1（仅 mode=metric 时生效）                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `budget`       | boolean                                      | 否   | 只看当月用量与预算，不调用接口                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `record`       | boolean                                      | 否   | 把这一轮判定写进**这篇文章的文章库记录**。写的是与发布器**同一个字段** `aiDetect`（§5.55 门禁行原文），并追加一条 `ai-detect` 历史 —— 于是 Console 抽屉的「AI 检测」卡片与发布历史都能看到它，事后不必翻日志。**未发布的稿子（一键生成 / 定时生成）只有靠它才能留下判定**：那些链路从不调发布器。只对 file / id 有效（text 是裸文本，没有文章记录）；写盘失败只回 recordError，不影响判定结果。判定为 skip（未检测）时同样写入——"没检测"必须与"通过"一眼可分。                                                      |
| `note`         | string                                       | 否   | 随记录写进历史的一条短注（如「重写第 2 轮复检」）；仅 record=true 时有意义                                                                                                                                                                                                                                                                                                                                                                                                                                          |
