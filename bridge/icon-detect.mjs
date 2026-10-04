// 品牌图标容器类型嗅探（2026-09-02）：不信任浏览器上报的 MIME（.ico 常报 image/vnd.microsoft.icon 等别名），
// 优先按字节魔数判定真实类型，兜底再按 MIME 别名。返回 ext（png|jpg|webp|gif|svg|ico）或 null。
const ICON_MIME_ALIASES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/ico': 'ico',
  'image/icon': 'ico',
  'application/octet-stream': 'ico', // 部分系统对 .ico 只给通用 MIME；由魔数/兜底判定为 ico
}

/** 从解码后的字节 + 上报 MIME 判定图标扩展名；无法识别返回 null */
export function detectIconExt(buf, reportedMime) {
  if (!buf || !buf.length) return null
  const b = buf
  // —— 魔数嗅探（优先，不依赖 MIME）——
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'GIF8') return 'gif'
  if (
    b.length >= 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'webp'
  if (
    b.length >= 4 &&
    b[0] === 0x00 &&
    b[1] === 0x00 &&
    (b[2] === 0x01 || b[2] === 0x02) &&
    b[3] === 0x00
  )
    return 'ico' // ICO/CUR
  const head = b
    .toString('utf8', 0, Math.min(b.length, 1024))
    .replace(/^\uFEFF/, '')
    .trimStart()
  if (/^(<svg|<\?xml)/i.test(head)) return 'svg'
  // —— 兜底：上报 MIME 别名 ——
  const mime = String(reportedMime || '').toLowerCase()
  return ICON_MIME_ALIASES[mime] || null
}
