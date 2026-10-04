#!/usr/bin/env node
/**
 * CrossPost 通知模块：发布器直发（不经 LLM），渠道可配置。
 *
 * config.json.notify:
 *   {
 *     "enabled": true,             // false = 不发送
 *     "channel": "webhook",        // webhook | lark | off（默认 webhook，通用无外部依赖）
 *     "webhookUrl": "",            // webhook 通道：钉钉/企微/飞书群机器人
 *     "webhookType": "raw",        // raw | dingtalk | wecom
 *     "larkChatId": "oc_...",      // lark 通道：飞书群 ID（可选依赖 lark-cli）
 *     "larkBin": "lark-cli",       // 可执行路径
 *     "idempotencyPrefix": "crosspost"
 *   }
 *
 * 2026-09-18（v2.01，引擎自治）两项调整：
 *  · `channel` 默认由 `lark` 改为 `webhook`：webhook 是纯 HTTP、无外部 CLI 依赖，
 *    适合作为引擎默认；飞书 CLI 为**可选依赖**（见 docs/dependencies.md）。
 *  · 通知内容不再声称对齐某个接入项目的模板文档（模板可经 notify.template 覆写，
 *    或由接入方自定义），结构固定为：标题行 + 汇总 + 📎 链接清单 + 失败原因。
 *
 * 幂等规则：前缀-hash-时间戳计数字尾（飞书按 idempotency-key 去重，key ≤50 字符）。
 */
import { execFile } from 'node:child_process'
import { fetchRetry } from './fetch-util.mjs'
import { readConfig } from './config-cache.mjs'

// 平台显示名：唯一来源为 src/platform-matrix.mjs（v2.03 起）。
// 原先此处与 console/modules/const.mjs 各存一份，必然漂移。
import { platformName as matrixPlatformName, PLATFORM_NAMES } from './platform-matrix.mjs'

export { PLATFORM_NAMES }

export function platformName(id) {
  return matrixPlatformName(id)
}

export function readNotifyConfig() {
  const cfg = readConfig() // 2026-09-01：统一走 config-cache（mtime 缓存，失败返回空对象）
  const n = cfg.notify || {}
  return {
    enabled: n.enabled !== false,
    channel: n.channel || 'webhook', // v2.01：默认改 webhook（无外部 CLI 依赖）
    larkChatId: n.larkChatId || '',
    larkBin: n.larkBin || 'lark-cli',
    webhookUrl: n.webhookUrl || '',
    webhookType: n.webhookType || 'raw', // raw | dingtalk | wecom
    idempotencyPrefix: n.idempotencyPrefix || 'crosspost',
    template: n.template || {},
  }
}

/** 模板渲染：{var} 占位替换，缺省返回原值 */
export function renderTemplate(tpl, vars) {
  if (tpl == null || typeof tpl !== 'string') return tpl
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m))
}

/** 构造飞书 post 富文本 JSON（标题行 + 汇总 + 链接清单 + 页脚） */
export function buildPostJson({ title, summary, links, footer }) {
  const content = []
  content.push([{ tag: 'text', text: `crosspost · ${title}` }])
  if (summary) content.push([{ tag: 'text', text: summary }])
  if (links && links.length) {
    content.push([{ tag: 'text', text: '📎 链接清单' }])
    for (const l of links) {
      const row = [{ tag: 'text', text: `- ${l.label} ` }]
      if (l.href) row.push({ tag: 'a', text: l.text || '草稿', href: l.href })
      else row.push({ tag: 'text', text: l.text || '(无链接)' })
      content.push(row)
    }
  }
  if (footer) content.push([{ tag: 'text', text: footer }])
  return { zh_cn: { content } }
}

/* ── 幂等键构造（2026-09-11 修复）────────────────────────────────────────
 * 背景：飞书按 `--idempotency-key` 去重（实测：同 key 的第二次发送 ok=true 但**复用旧 message_id、
 * 不产生新消息**），而 lark-cli 限制 key ≤ 50 字符。旧写法
 * `crosspost-${id}-${epochSec}`.slice(0,50) 对长 id 会把时间戳整段截掉：
 *   crosspost-2026-09-11-hotspot-anthropic-escape-1789140115  (56 字符)
 *   → slice(0,50) = crosspost-2026-09-11-hotspot-anthropic-escape-1789
 * 于是"同一篇文章每次推送的 key 完全相同" → 第 2 次起被飞书静默去重，用户收不到通知，
 * 而脚本只看 CLI 退出码 → 记录 status:'ok'、前端显示"已发送"。本函数保证 key 短且唯一。 */
const LARK_KEY_MAX = 50
let notifyKeyCounter = 0
/** 同一进程内 key → 最近一次返回的 messageId，用于探测"被飞书去重" */
const lastMessageIdByKey = new Map()

function compactHash(s) {
  let h = 0
  const str = String(s || '')
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return (h >>> 0).toString(36).padStart(6, '0')
}

/** 生成合法且唯一的幂等键：`<prefix>-<hash>-<base36 时间戳><计数字尾>`，并保证 ≤50 */
export function buildIdempotencyKey(base, now = Date.now()) {
  const prefix = String(base || 'crosspost').replace(/[^A-Za-z0-9_.-]/g, '-')
  const head = prefix.slice(0, 18)
  const hash = compactHash(prefix)
  notifyKeyCounter = (notifyKeyCounter + 1) % 46656 // 36^3
  const tail = (now % 0x100000000).toString(36) + notifyKeyCounter.toString(36).padStart(3, '0')
  const key = `${head}-${hash}-${tail}`
  if (key.length <= LARK_KEY_MAX) return key
  // 极端情况兜底：只保留 hash + 时间戳（绝不再截断成"丢唯一性"的 key）
  const fallback = `cp-${hash}-${tail}`
  console.error(`[notify] 幂等键超长已兜底: ${key.length} → ${fallback.length} 字符`)
  return fallback.slice(0, LARK_KEY_MAX)
}

/**
 * 发送通知。返回 { status, messageId?, key?, deduped?, error? }
 * - key：本次实际使用的幂等键（便于事后核对）
 * - deduped：为 true 表示**同一个 key 返回了与上次相同的 messageId**，
 *   即飞书把这次发送去重了、不会产生新消息（此前这种"假成功"无法观测）
 * 兼容：仍接受旧的 `idempotencyKey` 参数；推荐改用 `idempotencyKeyBase`（唯一后缀由本函数追加）。
 */
export async function sendNotify({
  idempotencyKey,
  idempotencyKeyBase,
  title,
  summary,
  links,
  footer,
}) {
  const cfg = readNotifyConfig()
  if (!cfg.enabled) return { status: 'disabled' }
  if (cfg.channel === 'off') return { status: 'off' }
  const payload = buildPostJson({ title, summary, links, footer })
  const key = idempotencyKeyBase
    ? buildIdempotencyKey(idempotencyKeyBase)
    : idempotencyKey
      ? String(idempotencyKey).slice(0, LARK_KEY_MAX)
      : buildIdempotencyKey(cfg.idempotencyPrefix)

  if (cfg.channel === 'lark') {
    if (!cfg.larkChatId) return { status: 'fail', error: 'lark 通道未配置 larkChatId', key }
    return new Promise((resolve) => {
      execFile(
        cfg.larkBin,
        [
          'im',
          '+messages-send',
          '--as',
          'bot',
          '--chat-id',
          cfg.larkChatId,
          '--content',
          JSON.stringify(payload),
          '--msg-type',
          'post',
          '--idempotency-key',
          key,
        ],
        { timeout: 30000 },
        (err, stdout, stderr) => {
          if (err)
            resolve({ status: 'fail', error: String(stderr || err.message).slice(0, 300), key })
          else {
            let messageId = null
            try {
              messageId =
                JSON.parse(stdout).message_id || JSON.parse(stdout).data?.message_id || null
            } catch {
              /* 非 JSON 输出 */
            }
            // 去重探测：同一 key 若拿回与上次相同的 messageId，说明飞书没有产生新消息
            const prev = lastMessageIdByKey.get(key)
            const deduped = !!messageId && !!prev && prev === messageId
            if (messageId) lastMessageIdByKey.set(key, messageId)
            if (deduped) {
              console.error(
                `[notify] 疑似被飞书去重（key=${key} id=${messageId}）——本次不会产生新消息`,
              )
            }
            resolve({ status: 'ok', messageId, key, ...(deduped ? { deduped: true } : {}) })
          }
        },
      )
    })
  }

  if (cfg.channel === 'webhook') {
    if (!cfg.webhookUrl) return { status: 'fail', error: 'webhook 通道未配置 webhookUrl' }
    try {
      // 渠道格式适配：raw=post JSON（默认）；dingtalk/wecom=markdown
      const mdText = [
        `**crosspost · ${title}**`,
        summary,
        ...(links || []).map((l) => `- [${l.label} ${l.text || '草稿'}](${l.href || ''})`),
        footer,
      ]
        .filter((s) => s != null && s !== '')
        .join('\n')
      let body
      if (cfg.webhookType === 'dingtalk')
        body = { msgtype: 'markdown', markdown: { title: `crosspost · ${title}`, text: mdText } }
      else if (cfg.webhookType === 'wecom')
        body = { msgtype: 'markdown', markdown: { content: mdText } }
      else body = payload
      const resp = await fetchRetry(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return resp.ok ? { status: 'ok', key } : { status: 'fail', error: `HTTP ${resp.status}`, key }
    } catch (e) {
      return { status: 'fail', error: String((e && e.message) || e), key }
    }
  }

  return { status: 'off', key }
}

/**
 * 通知通道自检（2026-09-11）：用当前配置发一条测试通知，供 Console「发送测试通知」按钮使用。
 * 返回 { status, messageId?, channel, chatId?, error? }。
 * 注意：status==='ok' 只代表**渠道 API 已接收**（飞书会返回 message_id），
 * 不等于"人在客户端一定看到"——文案里要把这两件事分开说，避免再次误判。
 */
export async function notifyTest() {
  const cfg = readNotifyConfig()
  const at = new Date()
  const stamp = at.toLocaleString('zh-CN', { hour12: false })
  const hint = cfg.channel === 'lark' ? '（飞书返回 message_id）' : ''
  const r = await sendNotify({
    idempotencyKeyBase: `${cfg.idempotencyPrefix}-selftest`,
    title: '通知通道自检',
    summary: `📌 crosspost 通知自检\n时间=${stamp}\n如果你在目标会话里看到这条消息，说明通知通道可用。`,
    links: [],
    footer:
      `本消息由 Console「发送测试通知」按钮触发。\n` +
      `状态 ok = 渠道 API 已接收${hint}；若你没看到，请确认自己在目标会话里、且该会话未设免打扰。`,
  })
  return {
    status: r.status,
    messageId: r.messageId || null,
    key: r.key || null,
    ...(r.deduped ? { deduped: true } : {}),
    channel: cfg.channel,
    chatId: cfg.channel === 'lark' ? cfg.larkChatId || null : cfg.webhookUrl ? '(webhook)' : null,
    ...(r.error ? { error: r.error } : {}),
  }
}
