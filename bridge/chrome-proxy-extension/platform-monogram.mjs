/**
 * 平台字母牌（纯函数）——选项页图标兜底与单测共用。
 *
 * ## 为什么需要它
 *
 * 平台图标是**远端 favicon**（`/proxy/platforms` 里的 `p.icon` 是各家站点的 https 链接）。
 * 实测 `https://blog.51cto.com/favicon.ico` 会返回一个非标准的 **567**，WAF 拦一下、
 * 站点改个域名都会让图标加载失败。此前的兜底是"把破图藏掉"（`bindIconFallbacks`）——
 * 不再有破图占位，但**行首留一个空洞**：一册署名表里 12 行有 3 行缺"头像"，
 * 看起来像页面坏了，而平台名本身才是真正的身份。
 *
 * 所以兜底升一级：**用平台名自己画一个字母牌**（知乎→「知」、CSDN→「CS」，
 * 底色由 id 哈希取 8 档纸系色）。信息量没变（不能凭空造 logo），但行首始终有东西，
 * 且同一平台每次都是同一张牌——稳定才可信。
 *
 * ## 与 `platform-groups.mjs` 同一分工
 *
 * 不碰 DOM、不碰网络，页面 `import` 它 + node 单测直接调它。图标元素的
 * `visibility:hidden` 判据不变（真浏览器测试数着 `img.icon` 的个数与显隐），
 * 本模块只负责"藏起来之后补什么"。
 */

/** 空/非法名字时的占位（不是空格：需要占住那一格） */
export const MONO_PLACEHOLDER = '?'

/** 字母牌底色档位数（与 options.css 的 `[data-tone="0..7"]` 一一对应） */
export const MONO_TONES = 8

/**
 * 平台名的字母牌：非 ASCII 取**首字**（CJK 单字最像徽记），ASCII 取**前两个字母数字**。
 * @param {string} name 平台显示名（知乎 / CSDN / 51CTO / …）
 * @returns {string} 1–2 个字符；拿不到时返回 {@link MONO_PLACEHOLDER}
 */
export function monogramOf(name) {
  const s = String(name == null ? '' : name).trim()
  if (!s) return MONO_PLACEHOLDER
  const first = s[0]
  // 非 ASCII（CJK/全角）→ 单字；ASCII → 前两个字母数字（跳过空格与标点）
  if (first.charCodeAt(0) > 0x7f) return first
  const alnum = s.replace(/[^0-9A-Za-z]/g, '')
  return alnum.slice(0, 2).toUpperCase() || first.toUpperCase()
}

/**
 * id → 底色档位（确定性哈希；同样的 id 永远同一张牌）。
 *
 * 为什么不能只看首字符（`id.charCodeAt(0) % 8`）：平台 id 有**形近对**——
 * `sohu`/`sohufocus`（搜狐/搜狐焦点）、`douban`/`douyin`（豆瓣/抖音）——
 * 首字符取模会让它们必然同色，而它们在列表里往往相邻。FNV-1a + 雪崩后取高位，
 * 实测这两对都落在不同档（单测钉住）。
 *
 * ⚠️ 档位只有 8 个、平台有 28 个，**碰撞是必然的**：底色只是装饰，用来让行首不空洞，
 * 登录态一律由标签的**文字 + 颜色**表达（`.status.ok/.no/.unk`），从不依赖底色。
 * @param {string} id 平台 id（zhihu / csdn / …）
 * @returns {number} 0 … {@link MONO_TONES}-1
 */
export function toneOf(id) {
  const s = String(id == null ? '' : id)
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  // 雪崩：FNV-1a 低位扩散不足，直接取模会让相似 id 挤到一起
  h ^= h >>> 15
  h = Math.imul(h, 2246822507)
  h ^= h >>> 13
  h = Math.imul(h, 3266489909)
  h ^= h >>> 16
  return (h >>> 7) % MONO_TONES
}
