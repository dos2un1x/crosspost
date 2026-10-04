// 主题切换（2026-08-29 深色模式）：浅色/深色 + localStorage 持久化 + 跟随系统偏好
// 防闪烁已在 index.html <head> 内联脚本处理（CSS 加载前设置 data-theme）；
// 本模块负责：按钮图标同步、点击切换、持久化。
'use strict'

const THEME_KEY = 'console-theme'

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

/** 应用主题到 <html data-theme> 并更新按钮图标 */
export function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', t)
  const btn = document.getElementById('btnTheme')
  if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙'
}

/** 切换（当前值取反），持久化到 localStorage */
export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark'
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    /* 隐私模式忽略 */
  }
  applyTheme(next)
}

/** 初始化：按存储值/系统偏好应用主题，绑定按钮事件（入口 load 调用一次） */
export function initTheme() {
  // 内联脚本已设 data-theme（localStorage > 系统偏好），这里只同步按钮图标
  applyTheme(currentTheme())
  const btn = document.getElementById('btnTheme')
  if (btn) btn.addEventListener('click', toggleTheme)
  // 系统主题变化时，仅当用户未手动设置过才跟随（尊重手动选择）
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      let stored = null
      try {
        stored = localStorage.getItem(THEME_KEY)
      } catch {
        /* ignore */
      }
      if (stored !== 'light' && stored !== 'dark') {
        applyTheme(e.matches ? 'dark' : 'light')
      }
    })
  }
}
