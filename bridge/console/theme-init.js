/* 主题初始化（2026-08-29 深色模式）：CSS 加载前应用已存主题，防闪烁。
 * 独立外部文件：CSP script-src 'self' 禁止内联脚本，必须外置。
 * 逻辑与 modules/theme.mjs 的 currentTheme 保持一致（localStorage > 系统偏好）。 */
;(function () {
  try {
    var t = localStorage.getItem('console-theme')
    if (t !== 'light' && t !== 'dark') {
      t =
        window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
    }
    document.documentElement.setAttribute('data-theme', t)
  } catch {
    document.documentElement.setAttribute('data-theme', 'light')
  }
})()
