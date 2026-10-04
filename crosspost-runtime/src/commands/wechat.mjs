/**
 * 微信官方通道域（从 cli.mjs 拆分，2026-08-24）
 * 凭证解析：env > crosspost-runtime/.env（两者均 gitignored）。
 * 2026-09-01 安全加固：移除 config.json.weixinOfficial 回退——config.json 被 git 跟踪，
 * 密钥落盘即泄露；凭证只允许走 env / .env。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WeixinOfficialAdapter } from '@crosspost/core/adapters'
import { renderMarkdownAsync, generateCover } from '@crosspost/core'
import { runtime } from './platforms.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')

export function resolveWechatCredentials() {
  let appId = process.env.WECHAT_APP_ID || ''
  let appSecret = process.env.WECHAT_APP_SECRET || ''
  const envFile = path.join(ROOT, '.env')
  if ((!appId || !appSecret) && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line)
      if (!m) continue
      if (m[1] === 'WECHAT_APP_ID' && !appId) appId = m[2]
      if (m[1] === 'WECHAT_APP_SECRET' && !appSecret) appSecret = m[2]
    }
  }
  return { appId, appSecret }
}

/** 创建 weixin-official 适配器（含 token 缓存路径） */
export function makeWechatOfficialAdapter() {
  const cred = resolveWechatCredentials()
  if (!cred.appId || !cred.appSecret) return null
  return new WeixinOfficialAdapter({
    appId: cred.appId,
    appSecret: cred.appSecret,
    tokenCachePath: path.join(ROOT, 'token.weixin-official.json'),
  })
}

/* ── 微信官方通道 API（2026-09-01 从 cli.mjs 迁出）：恒草稿 ──
 * 错误约定：凭证/参数缺失返回 { error }（无前缀）；渲染/上传/创建抛错由 cli.mjs wrap 前缀包装。 */

/** 官方 API 通道建微信草稿（恒草稿） */
export function wechatDraft(req) {
  const article = req.article || {}
  const style = article.style || 'swiss'
  const adapter = makeWechatOfficialAdapter()
  if (!adapter) {
    return {
      error:
        '缺少微信凭证：请配置 WECHAT_APP_ID / WECHAT_APP_SECRET（env 或 crosspost-runtime/.env，均不入库）',
    }
  }
  return (async () => {
    await adapter.init(runtime)
    const r = await renderMarkdownAsync(article.markdown || '', {
      style,
      mdPath: article.mdPath,
      imageUploader: async (src, kind) => {
        let buf
        if (kind === 'local') {
          buf = fs.readFileSync(src)
        } else {
          const resp = await fetch(src, { method: 'GET' })
          if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`)
          buf = Buffer.from(await resp.arrayBuffer())
        }
        return adapter.uploadImage(new Blob([buf]), 'img.png')
      },
    })
    let cover = article.thumb || null
    if (!cover) {
      const cr = await generateCover({
        title: article.title,
        style,
        outPath: '/tmp/crosspost-cover.png',
      })
      if (cr.ok) cover = cr.path
    }
    if (!cover) {
      return { error: '封面生成失败，且未提供 thumb' }
    }
    const thumbMediaId = await adapter.uploadThumb(cover)
    const result = await adapter.createDraft({
      title: article.title,
      html: r.html,
      thumbMediaId,
      author: article.author,
      digest: article.digest,
      contentSourceUrl: article.sourceUrl,
    })
    return {
      ok: true,
      style,
      mediaId: result.media_id,
      images: r.images ? { handled: r.images.handled, failed: r.images.failed } : null,
      draftUrl: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=10&appmsgid=${result.media_id}&token=&lang=zh_CN`,
    }
  })()
}

/** 官方 API 通道草稿列表 */
export function wechatDrafts() {
  const adapter = makeWechatOfficialAdapter()
  if (!adapter) return { error: '缺少微信凭证（见 wechatDraft）' }
  return (async () => {
    await adapter.init(runtime)
    return { drafts: await adapter.getDrafts() }
  })()
}

/** 官方 API 通道删除草稿（不可恢复） */
export function wechatDraftDelete(mediaId) {
  const adapter = makeWechatOfficialAdapter()
  if (!adapter) return { error: '缺少微信凭证（见 wechatDraft）' }
  if (!mediaId) return { error: '缺少 mediaId' }
  return (async () => {
    await adapter.init(runtime)
    await adapter.delete(mediaId)
    return { ok: true, mediaId }
  })()
}
