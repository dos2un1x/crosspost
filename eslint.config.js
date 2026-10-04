// ESLint 9 flat config —— 全仓库统一 lint（TS + JS/MJS + 浏览器/Node 上下文分隔）
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'bridge/console/vendor/**',
      'md-backup/**',
      '**/*.min.js',
      'crosspost-runtime/core/coverage/**',
      // 本地草稿区（已被 .gitignore 排除）：一次性的核对/对比脚本放这里，不是产品代码，
      // 门的绿不应取决于这些临时文件。产品代码一律不在该目录下。
      '.local/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TS 自身负责未定义标识符（typescript-eslint 也建议关闭 no-undef，避免 .ts 上误报）
      'no-undef': 'off',
      // 关闭核心 no-unused-vars，统一用 @typescript-eslint 版（避免 .ts 上重复上报）；
      // legacy 代码大量 catch/事件参数 e 未使用 → 降为 warn（仍可见，不挡门）。
      'no-unused-vars': 'off',
      // 2026-09-10：噪音清零后提回 error（原为 warn）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 空 catch 常见，允许（cleanup/忽略错误）
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 2026-09-10：2 处 async Promise executor 已重构，提回 error
      'no-async-promise-executor': 'error',
    },
  },
  // JS/MJS 统一按 ESM 解析
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
  // Node 上下文：runtime / mcp-server / scripts / preset / bridge 主进程
  {
    files: [
      'crosspost-runtime/**',
      'preset/**',
      'bridge/run-bridge.mjs',
      'bridge/schedule.mjs',
      'bridge/topics.mjs',
      'bridge/backup.mjs',
      'bridge/cli-worker.mjs',
      'bridge/icon-detect.mjs',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  // 浏览器上下文：Console + Chrome 扩展
  {
    files: ['bridge/console/**', 'bridge/chrome-proxy-extension/**'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly', self: 'readonly' } },
  },
  eslintConfigPrettier,
)
