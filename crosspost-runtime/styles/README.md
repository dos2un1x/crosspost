# 起手样式包（55 个自定义样式）

这里放的是**当前模型**下的自定义样式文件（扁平 canonical 参数，一个样式一个 JSON，文件名即样式名）。
装进你自己的样式目录就能在 Console 的样式下拉里选到：

```bash
# 走 CLI（推荐：会逐个校验，坏文件只报错不写盘）
node crosspost-runtime/src/cli.mjs styles install

# 或者手动拷（等价，目录就是 ~/.config/crosspost/styles/）
cp crosspost-runtime/styles/*.json ~/.config/crosspost/styles/
```

装完不必重启：样式是运行时读盘的（目录 mtime 变了就重扫），刷新 Console 即可看到。

## 几个约定

- **文件名 = 样式名**，必须是 `custom-*.json`；内置的 10 个样式**不可覆盖**（`styles install` 会跳过）。
- 字段就是 [`docs/configuration.md`](../../docs/configuration.md) 里那套参数（`bg` / `accent` /
  `text` / `secondary` / `font` / `headingStructure` / `blockquoteStructure` / `lineHeight` …）；
  用 `crosspost-runtime/src/cli.mjs listStyles` 能看到每个样式的 `desc` 与启用状态。
- 想改：`styles new <名字> --from <模板> --set k=v`；想删：`styles delete <名字>`。
- 样式是否出现在下拉里还受配置里的 `styles.disabled` 影响（见 `docs/configuration.md`）。
- 从**旧样式目录**（别的工具留下的那份，路径按你自己的填）迁过来的样式，可以直接喂给同一条命令：
  `node crosspost-runtime/src/cli.mjs styles install <旧样式目录>`
  —— 旧拼写（`border_width` / `headingStyle` / `blockquote_bg` …）会被翻译，
  已废弃的 `cssTemplate` 会被忽略，颜色字段里的 `!important` 与渐变会被规整成 hex（命令会逐条报告）。

## 关于这些样式

它们是本机作者提取/调过的成稿样式，随仓库一起分发，供使用者起步。其中几个是按公开站点的
**版式观感**做的（文件名里带站点名的那种）；若你在自己的分发里介意这一点，删掉对应文件即可，
其余样式与引擎都不依赖它们。
