/**
 * 主题初始化 + 切换（扩展选项页）——**必须是外置脚本**，理由与 Console 的
 * `bridge/console/theme-init.js` 相同：MV3 扩展页的 CSP 是 `script-src 'self'`，
 * 内联 `<script>` 与内联事件处理器都会被直接拦掉（2026-09-25 实测）。
 *
 * 两个职责、一个文件：
 *   ① **防闪白**：本文件在 `<head>` 里**先于** `<link rel="stylesheet">` 同步执行，
 *      首帧之前就把 `html[data-theme]` 定下来。放到 `options.js`（module = defer）
 *      里做这件事的后果是：深色用户每次打开都先闪一下白纸。
 *   ② 报头那枚切换键（浅 → 深 → 跟系统）：DOMContentLoaded 后接管。
 *
 * 键名刻意与 Console 分开（`console-theme` vs `crosspost-theme`）：两者是**不同源**
 * （Console 在 http://127.0.0.1:9540，扩展在 chrome-extension://<id>），
 * localStorage 不共享，分键才能各自表达"跟系统"这一档。
 */
;(function () {
  var KEY = 'crosspost-theme'
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

  /** 读取偏好：'light' | 'dark' | 'system'（非法/读不到 → system） */
  function pref() {
    try {
      var v = localStorage.getItem(KEY)
      return v === 'light' || v === 'dark' ? v : 'system'
    } catch {
      return 'system'
    }
  }

  function systemDark() {
    return !!(mql && mql.matches)
  }

  /** 把偏好落到 `html[data-theme]`（CSS 的深色变量挂在它上面） */
  function apply(p) {
    var resolved = p === 'system' ? (systemDark() ? 'dark' : 'light') : p
    document.documentElement.setAttribute('data-theme', resolved)
    var btn = document.getElementById('themeToggle')
    if (!btn) return
    btn.textContent = p === 'system' ? '◐' : p === 'dark' ? '☾' : '☀'
    btn.setAttribute(
      'aria-label',
      '主题：' + (p === 'system' ? '跟随系统' : p === 'dark' ? '深色' : '浅色'),
    )
    btn.title =
      '主题：' + (p === 'system' ? '跟随系统' : p === 'dark' ? '深色' : '浅色') + '（点击切换）'
  }

  // ① 首帧之前定主题
  apply(pref())

  // ② 切换键 + 跟随系统时的实时响应
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('themeToggle')
    if (btn) {
      btn.addEventListener('click', function () {
        var next = pref() === 'light' ? 'dark' : pref() === 'dark' ? 'system' : 'light'
        try {
          localStorage.setItem(KEY, next)
        } catch {
          /* 隐私模式写不进去：仍按本次点击生效，只是不持久 */
        }
        apply(next)
      })
    }
    if (mql && mql.addEventListener) {
      mql.addEventListener('change', function () {
        if (pref() === 'system') apply('system')
      })
    }
    apply(pref()) // 按钮字形/aria 要在 DOM 就绪后再写一次
  })
})()
