/**
 * @crosspost/core/md2we 纯渲染引擎入口
 *
 * 只导出「Markdown → 微信兼容 HTML」渲染核心，**不含**：
 *  - analyze（样式采样，依赖 playwright）
 *  - cover / ending-card（图片生成，依赖 sharp）
 *  - adapters（平台适配器）
 *  - 其他运行时/工具
 *
 * 供需要纯渲染、不想引入浏览器/平台层的下游使用，体积最小、依赖最轻。
 */
export {
  renderMarkdown,
  renderMarkdownAsync,
  parseFrontmatter,
  postProcessHtml,
  listStyleNames,
  resolveStyle,
  loadCustomStyles,
  createCustomStyle,
  type RenderOptions,
  type RenderResult,
  type RenderAsyncResult,
} from './lib/render/index'

// 样式定义（内置 + 类型）
export {
  BUILTIN_STYLES,
  isDarkColor,
  type StyleDefinition,
  type StyleCategory,
  type HeadingStyle,
  type BlockquoteStyle,
} from './lib/render/styles'

// 渲染器/样式工具
export { createRenderer, elStyle, escapeHtml } from './lib/render/engine'
export { renderHeading } from './lib/render/headings'
export { wrapCodeLines, detectAsciiTable } from './lib/render/code'
export { renderCalloutIfMatch } from './lib/render/callouts'
export { renderFormulas, looksLikeMath } from './lib/render/formulas'

// 加粗 flanking 修复 + 块映射（编辑器/预览联动用）
export { normalizeBoldFlanking } from './lib/render/markdown-flanking'
export {
  markdownBlockRanges,
  annotateBlocks,
  type BlockRange,
} from './lib/render/markdown-blockmap'
