/**
 * 浏览器扩展 ↔ 桥 的协议兼容性（P1：扩展版本握手）
 *
 * 背景：扩展在 WS 首帧上报自己的版本（`chrome.runtime.getManifest().version`），
 * 桥把它记在 `proxyClient.version` 并在 `/proxy/status` 暴露。但**原先没有任何判定**——
 * 版本不匹配时既无提示也无拒绝，表现为"扩展显示已连接、发布却静默失败"，
 * 是最难排查的一类故障。
 *
 * 本模块只做**判定**，不做拦截：策略是「告警不拒绝」，保留一个版本周期，
 * 让用户有机会在不中断使用的情况下升级扩展。
 *
 * 判定规则（语义化版本的主次号）：
 *   · 无扩展连接              → status 'absent'（不算不兼容，只是没连）
 *   · 版本 < MIN             → status 'outdated'（不兼容：桥需要的新协议字段扩展没有）
 *   · 主号与桥期望的主号不同   → status 'major-mismatch'（不兼容）
 *   · 其余                    → status 'ok'
 *
 * 修改 MIN_EXTENSION_VERSION 的时机：当桥开始**依赖**扩展的某个新 WS 消息或
 * 新字段时。仅扩展内部修 bug 不需要动它。
 */

/**
 * 桥所需的最低扩展版本。
 *
 * 0.2.1 是当前在用的版本（点图标直接开 Console、选项页三段式状态卡）；
 * 0.2.2 修了选项页的「未登录 0」显示（未勾选平台被算成"没未登录"）——**只是页面改动**，
 * 不涉及桥依赖的 WS 消息或字段，所以这里的最低版本不动。
 * 0.2.3 把选项页换成 Console 的「编辑部」视觉语言（暖纸/墨/砖红、三态比例条、
 * 图标失败时用平台名字母牌兜底、深色跟随系统）——同样是**页面与静态资源改动**，
 * 新增的 options.css / theme.js / platform-monogram.mjs 都只被页面自己加载，
 * 桥侧一如既往只依赖下面这三类 WS 消息，所以最低版本仍不动。
 * 0.2.4 把选项页的 tab 区做成状态化的（数字带三态色 + 副标签说明"这批数字算不算数"）
 * 并修掉一处页面侧的误判：`/proxy/platforms` 的 `error` 字段是**上一次检查**的失败记录，
 * 页面不再把它当"取数失败"整页清空（改为按响应形状区分）。同属页面改动，最低版本不动。
 * 0.2.5 修了 `smzdmGetToken` 的字段层级：它把回包读成 `body.data.data.token`，而接口只回一层
 * `body.data.token` —— 于是这个 op 恒回空 token，什么值得买推送必挂。**op 名、参数、成功回包
 * 形状都没变**，只是"拿不到 token"从"成功 + null"改成"失败 + 回包摘要"（与 neteaseGetToken 一致），
 * 所以最低版本仍不动；它进版本号是为了让 `doctor` 能看出"浏览器里加载的是不是仓库这一版"。
 * 桥依赖的扩展能力：proxyFetch / getAllCookies / ping 三类 WS 消息，
 * 以及 `version` 字段本身（用于本判定）。
 */
export const MIN_EXTENSION_VERSION = '0.2.1'

/** 解析 "主.次.修订" → [主,次,修订]；非法返回 null */
export function parseVersion(v) {
  if (typeof v !== 'string') return null
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** a < b（按语义化版本逐段比较）；任一无法解析时返回 false */
export function versionLessThan(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true
    if (pa[i] > pb[i]) return false
  }
  return false
}

/**
 * 判定扩展版本与桥的兼容性。
 * @param {string|null|undefined} extVersion 扩展上报的版本（无扩展时传 null）
 * @returns {{status:'ok'|'absent'|'outdated'|'major-mismatch'|'unknown',
 *            compatible:boolean, extVersion:string|null, minVersion:string,
 *            message:string, action?:string}}
 */
export function checkExtensionCompatibility(extVersion) {
  const min = MIN_EXTENSION_VERSION
  if (!extVersion) {
    return {
      status: 'absent',
      compatible: true, // 没连不等于不兼容
      extVersion: null,
      minVersion: min,
      message: '尚无浏览器扩展连接',
      action:
        'Chrome 打开 chrome://extensions → 开启开发者模式 → 「加载已解压的扩展程序」→ 选择 bridge/chrome-proxy-extension',
    }
  }

  const pe = parseVersion(extVersion)
  const pm = parseVersion(min)
  if (!pe) {
    return {
      status: 'unknown',
      compatible: true, // 认不出就不阻断，只提示
      extVersion,
      minVersion: min,
      message: `无法解析扩展版本 "${extVersion}"`,
      action: '若功能异常，请在 chrome://extensions 重新加载扩展。',
    }
  }

  if (pm && pe[0] !== pm[0]) {
    return {
      status: 'major-mismatch',
      compatible: false,
      extVersion,
      minVersion: min,
      message: `扩展主版本 ${pe[0]}.x 与桥期望的 ${pm[0]}.x 不一致`,
      action: `在 chrome://extensions 移除并重新加载 bridge/chrome-proxy-extension（当前 ${extVersion}，需要 ≥ ${min}）`,
    }
  }

  if (versionLessThan(extVersion, min)) {
    return {
      status: 'outdated',
      compatible: false,
      extVersion,
      minVersion: min,
      message: `扩展 ${extVersion} 低于桥所需的最低版本 ${min}`,
      action: `在 chrome://extensions 点击「重新加载」以应用仓库中的最新扩展（当前 ${extVersion}，需要 ≥ ${min}）`,
    }
  }

  return {
    status: 'ok',
    compatible: true,
    extVersion,
    minVersion: min,
    message: `扩展 ${extVersion} 与桥兼容`,
  }
}
