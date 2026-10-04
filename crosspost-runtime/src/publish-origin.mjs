/**
 * 发布来源判定（2026-09-12）
 *
 * 背景：09-11 修「手动推送被「生成后自动推送」开关静默吞掉」时，MCP 层给 publish_article
 * 硬编码了 `manual: true`（理由“AI 显式调用 = 人工触发”）。但**定时链路本身就是一个 AI 会话**：
 *   定时器（launchd / systemd）→ 接入方的脚本 → DSH profile → MCP publish_article
 * 于是「生成后自动推送」开关（config.json.autoPush.enabled）在定时链路上被恒真豁免，
 * 2026-09-12 08:10/08:30 两轮在开关关闭状态下真的推送了微信草稿 + 8 个平台。
 *
 * 修复思路：豁免与否不由 AI 自我声明，而由 shell 注入、AI 无法篡改的来源标记判定：
 *   WECHAT_AUTO_SCHEDULED=1    定时链路（run_once.sh 注入） → 严格受 autoPush 门控，永不豁免
 *   WECHAT_AUTO_DRAFT_ONLY=1   一键生成（generate_once.sh） → 禁止任何发布调用
 *   无标记                     交互式会话 / CLI / Console  → 视为人工触发（不受开关限制）
 *
 * 标记能到达 MCP 子进程：@deepseek-ai/dsh-mcp-client 以 scrubbedParentEnv() 传父进程环境
 * （仅剔除敏感名与 DSH_* 前缀），WECHAT_AUTO_* 原样继承——09-12 定时轮日志里 agent 自己就读到了它。
 *
 * 本模块为纯函数，无 IO/无依赖，便于单测覆盖派发真值表。
 */

/** 合法来源枚举 */
export const PUBLISH_ORIGINS = ['scheduled', 'draft-only', 'manual']

/**
 * 由环境变量判定本次发布来源。
 * @param {Record<string,string|undefined>} env 默认 process.env（测试可注入）
 * @returns {'scheduled'|'draft-only'|'manual'}
 */
export function resolvePublishOrigin(env = process.env) {
  const e = env || {}
  if (e.WECHAT_AUTO_DRAFT_ONLY === '1') return 'draft-only'
  if (e.WECHAT_AUTO_SCHEDULED === '1') return 'scheduled'
  return 'manual'
}

/** 是否为“人工触发”来源（交互式会话 / CLI / Console） */
export function originIsManual(origin) {
  return origin !== 'scheduled' && origin !== 'draft-only'
}

/** 底层发布工具（绕过总开关的旁路）：定时/仅草稿链路一律禁用 */
export const LOW_LEVEL_PUBLISH_TOOLS = ['sync_article', 'publish_styled', 'wechat_draft']

/** 该来源是否禁用底层发布工具 */
export function lowLevelPublishBlocked(origin) {
  return origin === 'scheduled' || origin === 'draft-only'
}

/** 底层发布工具被禁用时的说明文案（未禁用返回 null） */
export function lowLevelBlockReason(origin) {
  if (origin === 'scheduled')
    return '定时链路（WECHAT_AUTO_SCHEDULED=1）禁止直接调用底层发布工具：派发必须经 publish_article，并受「生成后自动推送」开关门控'
  if (origin === 'draft-only')
    return '一键生成链路（WECHAT_AUTO_DRAFT_ONLY=1）禁止任何发布调用：草稿已落盘，请到 Console 手动推送'
  return null
}

/**
 * 派发判定（单一事实源）。
 *
 * 语义（2026-09-12 用户决策，方案A）：
 * - 定时链路（origin=scheduled）**永不豁免**：即使请求里带了 manual/allowDouyin/force，也强制按开关门控
 *   （服务端冻结，防 AI 或上游误传）；
 * - 人工来源（origin=manual，含无标记的交互式会话、CLI、Console）勾选即执行，不受开关限制；
 * - 全链路都要 autoPush.enabled 才走“自动派发”。
 *
 * @returns {{origin:string, manualPush:boolean, pushEnabled:boolean, dispatchEnabled:boolean,
 *            wantWechat:boolean, skipReason:string|null}}
 */
export function resolveDispatch({
  autoPushEnabled,
  autoPushIncludeWechat,
  origin = 'manual',
  manual,
  allowDouyin,
  force,
  wechat,
} = {}) {
  const o = origin || 'manual'
  const declaredManual = manual === true || allowDouyin === true || force === true
  const manualPush = o === 'scheduled' ? false : declaredManual
  const pushEnabled = !!autoPushEnabled
  const dispatchEnabled = pushEnabled || manualPush
  const wantWechat = wechat !== false && (manualPush || (pushEnabled && !!autoPushIncludeWechat))
  const skipReason = dispatchEnabled
    ? null
    : o === 'scheduled'
      ? '生成后自动推送已关闭（定时链路不派发；可在 Console 手动挑选平台推送）'
      : '生成后自动推送已关闭'
  return { origin: o, manualPush, pushEnabled, dispatchEnabled, wantWechat, skipReason }
}
