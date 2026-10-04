/**
 * 原生文章提取：fetch URL → jsdom → Readability（通用）/ 公众号专用选择器
 * 输出：{ title, html, markdown, cover, source: {url, platform} }
 */
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { htmlToMarkdown } from '@crosspost/core'
import { fetchRetry } from './fetch-util.mjs'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

async function fetchHtml(url) {
  // 2026-08-28 A1：统一 fetchRetry（15s 超时 × 3 次退避；4xx 不重试，网络错误/5xx 重试）
  const res = await fetchRetry(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

function domFromHtml(html, url) {
  return new JSDOM(html, { url })
}

/** 公众号文章页专用提取 */
function extractWeixin(doc, url) {
  const titleEl = doc.querySelector('#activity-name')
  const contentEl = doc.querySelector('#js_content')
  if (!titleEl || !contentEl) return null
  const title = (titleEl.textContent || '').trim()
  const cover = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || undefined
  const summary =
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content') || undefined
  const html = contentEl.innerHTML
  return {
    title,
    html,
    markdown: htmlToMarkdown(html),
    summary,
    cover,
    source: { url, platform: 'weixin' },
  }
}

/** 通用提取（Readability） */
function extractGeneric(document, url) {
  const article = new Readability(document, { keepClasses: false }).parse()
  if (!article) return null
  const html = article.content || ''
  return {
    title: (article.title || document.title || '').trim(),
    html,
    markdown: htmlToMarkdown(html),
    excerpt: article.excerpt || undefined,
    cover: article.byline && article.byline.startsWith('http') ? article.byline : undefined,
    source: { url, platform: 'readability' },
  }
}

export async function extractArticleFromUrl(url) {
  const html = await fetchHtml(url)
  return extractFromHtml(html, url)
}

/**
 * 从已获取的 HTML 提取文章（URL 提取与活动标签页提取共用）
 * @param {string} html 页面 HTML
 * @param {string} url 页面 URL（用于相对链接解析与平台判断）
 */
export function extractFromHtml(html, url) {
  const dom = domFromHtml(html, url)
  const document = dom.window.document
  const host = new URL(url).hostname

  // 公众号
  if (host === 'mp.weixin.qq.com' || host.endsWith('.weixin.qq.com')) {
    const r = extractWeixin(document, url)
    if (r) return r
  }

  // 通用
  const g = extractGeneric(document, url)
  if (g && g.html && g.html.trim()) return g

  return null
}
