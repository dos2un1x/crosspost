// 品牌图标（2026-09-02）：顶栏左上角品牌图标 + 浏览器标签 favicon，由 config.branding.icon 驱动
// 2026-09-03：默认与浏览器标签统一为 favicon.ico（不再用文本"CP"徽标）
import { getJSON } from './api.mjs'

const DEFAULT_BRAND = '/console/favicon.ico'

/** 应用品牌图标：config.branding.icon 为空 → 用默认 favicon.ico（与标签一致）；否则用自定义图 */
export function applyBrand(cfg) {
  const icon = (cfg && cfg.branding && cfg.branding.icon) || DEFAULT_BRAND
  const mark = document.getElementById('brand-mark')
  const fav = document.querySelector('link[rel="icon"]')
  if (mark) {
    let img = mark.querySelector('img')
    if (!img) {
      img = document.createElement('img')
      img.className = 'brand-mark-img'
      img.alt = '品牌图标'
      mark.appendChild(img)
    }
    img.src = icon
    mark.classList.add('cp-img')
  }
  if (fav)
    fav.href = icon.startsWith('data:')
      ? icon
      : icon.includes('?')
        ? icon
        : icon + '?v=' + Date.now()
}

/** 加载配置并按需应用品牌（仅当已配置；失败静默，不影响页面） */
export async function loadBrand(cfg) {
  try {
    applyBrand(cfg || (await getJSON('/proxy/config')))
  } catch {
    /* 忽略 */
  }
}
