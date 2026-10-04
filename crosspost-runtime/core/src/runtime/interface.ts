/**
 * 引擎侧的运行时抽象。
 *
 * 适配器、CLI 与渲染层**不直接接触浏览器 API**，只经这一个接口拿「网络 / 凭据 / 存储 /
 * 浏览器页面」四类能力。它有两个提供方：
 *
 * · 扩展侧（浏览器内）：直接封装 `chrome.*`，并充当本地桥的 RPC 服务端；
 * · 引擎侧（Node，`type === 'node'`）：几乎不自己实现浏览器语义，而是把每个能力折算成
 *   一条 RPC 交给本地桥，再转给浏览器里的迷你扩展执行。
 *
 * ## 阅读约定
 *
 * · 标 `?` 的成员是**可选能力**：调用方必须先判存在，缺失时按「该能力不可用」处理，
 *   不得当成「调用失败」。
 * · 未标 `?` 的成员是必填的，两个提供方都必须给出实现 —— 但**给出实现不等于有效果**：
 *   引擎侧有四个能力是刻意留空的降级实现（`cookies.get` / `cookies.set` / `cookies.remove` /
 *   `downloads`），下面逐条标注。调用方若把「没抛错」当成「已生效」，就会拿到假象。
 *
 * ## 全接口共通的约定
 *
 * · 请求一律用浏览器本体的身份与凭据发出，cookie **不经过引擎进程**：引擎侧不做 cookie
 *   快照、不拼 `Cookie` 头（这也是纯代理模式成立的前提）。
 * · 请求头规则必须**成对释放**（`add` → `remove`），异常路径也不能漏：泄漏的
 *   `Origin`/`Referer` 注入会污染后续所有请求。
 * · 不做隐式重试、不做隐式节流：重试与节流属调用方，避免放大平台风控。
 */

import type { Cookie, HeaderRule } from '../types'

/** 运行时提供方：浏览器扩展，或 Node 引擎侧（经桥转发） */
export type RuntimeType = 'extension' | 'node'

/**
 * 按域读取 / 写入 / 删除 cookie。
 *
 * 三个方法的第一参数都是**域**（形如 `.bilibili.com`），不是 URL：实现会去掉域名的前导
 * `.`，再拼成 `https://<域>/` 作为查询 URL。传 URL、传带路径的东西、省略域都会失败。
 */
export interface CookieJar {
  /** 按域列出 cookie；每项至少含 `name`/`value`/`domain`/`path`/`httpOnly` */
  get(domain: string): Promise<Cookie[]>
  /**
   * 写入一条 cookie；实现负责由「域 + 路径（缺省 `/`）」补出 URL，
   * 并透传 `secure` / `httpOnly` / `expirationDate`。
   */
  set(cookie: Cookie): Promise<void>
  /**
   * 删除一条 cookie。参数次序是 **(名称, 域)**，且删除 URL 只由域构成、不带路径。
   *
   * 引擎侧：空实现，**无效果**。
   */
  remove(name: string, domain: string): Promise<void>
}

/**
 * 跨进程重启仍然保留的键值存储。
 *
 * 值可以是任意可结构化克隆 / 可 JSON 化的数据，实现**不得**把值强制转成字符串。
 * `get` 在键不存在时返回 `null`（不是 `undefined`，也不抛错）。
 * `set` 必须落盘后才 resolve；`remove` 之后同一个键的 `get` 必须是 `null`。
 */
export interface KeyValueStore {
  get<TValue = unknown>(key: string): Promise<TValue | null>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * 只活一次会话的键值存储：与 `KeyValueStore` 同形，但**没有 `remove`**，
 * 且生命周期短 —— 浏览器重启（扩展侧落 `chrome.storage.session`）或进程退出
 * （引擎侧是进程内 `Map`）之后必须为空。键不存在同样返回 `null`。
 *
 * 不要拿它当持久存储用：它存的是「这次会话里的临时句柄」。
 */
export interface EphemeralStore {
  get<TValue = unknown>(key: string): Promise<TValue | null>
  set(key: string, value: unknown): Promise<void>
}

/**
 * 临时给「本扩展自己发起的 XHR 类请求」注入受限请求头。
 *
 * 典型用途：把浏览器保护、页面脚本改不动的 `Origin` / `Referer` 设成平台期望的值，
 * 使平台的上传与接口校验通过。规则**只覆盖本扩展发起的 XHR 类请求**（扩展侧用
 * 「发起域 = 本扩展 id」限定），不要假设它能改页面自身发出的请求。
 */
export interface HeaderRuleInjector {
  /**
   * 注册一条规则，返回一个**不透明字符串句柄**。
   *
   * 这个句柄是之后 `remove` 的唯一入参，调用方**不得**解析、拼接或比较它的内容。
   * 注册失败必须抛出：调用方依赖「注册成功才发请求」。
   */
  add(rule: HeaderRule): Promise<string>
  /** 用 `add` 返回的句柄撤销一条规则 */
  remove(ruleId: string): Promise<void>
  /** 撤销**本运行时实例注册的全部**动态规则 */
  clear(): Promise<void>
}

/** 下载句柄：只是个「这次下载」的凭据，数字 id 或含 id/path 的对象都可以 */
export type DownloadHandle = number | { id?: number | string; path?: string }

/**
 * 触发浏览器下载。返回值只当「有个句柄」用，调用方不做数字运算。
 * 引擎侧未实现（`undefined`）：要用它的调用方必须先判存在。
 */
export interface DownloadSink {
  /** `saveAs` 缺省为 `true`（弹保存对话框） */
  download(blob: Blob, filename: string, saveAs?: boolean): Promise<DownloadHandle>
}

/** 标签页的最小描述：查询结果里没有 id 的项会被实现过滤掉 */
export interface TabHandle {
  id: number
  url?: string
}

/**
 * 标签页生命周期。
 *
 * 注意查询/写入两类操作的**失败语义刻意不对称**：`query` 失败退化成「没有已打开的
 * 标签页 → 去新开一个」，其余方法失败必须让调用方知道（抛错）。
 */
export interface TabDriver {
  /** 按 URL 模式查已打开的标签页；无匹配返回空数组（不是 `null`，也不抛错） */
  query(urlPattern: string): Promise<TabHandle[]>
  /** 新建标签页；`active` 缺省 `false`（后台打开，不抢焦点） */
  create(url: string, active?: boolean): Promise<TabHandle>
  /**
   * 等某个标签页加载完成。`timeout` 缺省 30000ms。
   *
   * 语义是「等加载完成 + 再等约 1000ms」（给页面脚本初始化的余量）。超时会 reject，
   * 且此时监听器与定时器都已清理。已知边界：如果目标标签页在挂监听器**之前**就已经
   * 加载完成，`onUpdated` 不会再触发，只能等到超时 —— 调用方必须按「可能 reject」处理。
   */
  waitForLoad(tabId: number, timeout?: number): Promise<void>
  /**
   * 关闭标签页。`tabId` 为假值时是 no-op。
   *
   * @deprecated 本仓不使用：页面注入一律走 {@link RuntimeInterface.pageOp}。
   * 保留声明只为兼容公开面与测试里的假运行时；引擎侧为 `undefined`。
   */
  executeScript?<T = unknown>(
    tabId: number,
    func: (...args: unknown[]) => unknown,
    args?: unknown[],
  ): Promise<T>
  /** 关闭标签页；调用方自行 catch（关闭失败不应影响业务结果） */
  close(tabId: number): Promise<void>
}

/**
 * 非浏览器宿主里的 DOM 能力。
 *
 * 契约上必填，但**当前仓内没有生产调用方** —— 它是为「扩展环境用 Offscreen Document
 * 实现」预留的公共面（引擎侧用 `jsdom`）。
 */
export interface DomFacade {
  /** 解析 HTML 字符串；允许片段（不要求完整文档、不要求 `<html>` 包裹） */
  parseHTML(html: string): Promise<Document>
  /** 未命中返回 `null` */
  querySelector(doc: Document, selector: string): Element | null
  /** 返回**数组**（不是 NodeList）；未命中返回空数组 */
  querySelectorAll(doc: Document, selector: string): Element[]
  /** `element` 为 `null` 时返回空串（兜底，不抛错） */
  getTextContent(element: Element | null): string
  /** `element` 为 `null` 时返回空串 */
  getInnerHTML(element: Element | null): string
}

/**
 * 引擎访问外部世界与浏览器状态的唯一入口。
 *
 * 下面按「用得多 → 用得少」排列；成员的可选性见各自的 `?`。
 */
export interface RuntimeInterface {
  /** 让上层判断「有没有浏览器」；仓内当前没有按它分支，但它是公开面的一部分 */
  readonly type: RuntimeType

  /**
   * 用浏览器本体的身份与凭据代发一次 HTTP 请求，并把响应还原成 Web 标准的 `Response`
   * 形状（`ok` / `status` / `statusText` / `headers` / `url` / `redirected` +
   * `text()` / `json()` / `arrayBuffer()` / `blob()` / `clone()`）。
   *
   * · 缺省：`options` 可省略，视为 `GET`、无头、无体；`method` 与 `headers` 原样透传；
   *   `body` 支持 `string` / `URLSearchParams` / `Blob` / `FormData` / 普通对象
   *   （后两者由实现负责序列化；`FormData` 会由实现手写 multipart 分段并自行补
   *   `content-type: multipart/form-data; boundary=…`）。
   * · 凭据：固定以「携带 cookie」的方式发出（`credentials: 'include'`、跟随重定向）。
   * · 受限头：`Origin` / `Referer` 无法在这里直接设置，需要它们请走
   *   {@link RuntimeInterface.headerRules}（并且规则要覆盖到平台的上传域名）。
   * · 超时：请求必须带超时并在超时后拒绝。
   * · 错误：桥不可达 / RPC 超时 / 桥返回错误 / 响应形状非法 → **抛 `Error`**
   *   （不返回 `ok:false` 的假响应）；HTTP 层的 4xx/5xx **不抛**，由 `Response.ok === false`
   *   表达。
   */
  fetch(url: string, options?: RequestInit): Promise<Response>

  /**
   * 在**已打开的平台页面**的 MAIN world 里执行一个**服务端预定义**的操作，返回该操作
   * 自己的结果对象。
   *
   * · `op` 是枚举**名字**，不是函数源码：MV3 的 Service Worker CSP 禁止 `eval` /
   *   `new Function`，无法把源码还原成函数；扩展侧维护「op 名 → 预定义函数」的白名单，
   *   未登记的名字直接抛错（新增 op 必须同时改扩展侧）。
   * · `args` 是传给该 op 的**位置参数数组**（顺序即协议），缺省空数组。
   * · 回包只有一条统一约定：对象至少含 `{ success: boolean; error?: string }`，
   *   其余字段由各 op 自定义；`success === false` 一律转成 reject。
   * · 可选能力：依赖它的适配器必须显式判存在。与 `tabs` 不同，它在引擎侧是可用的
   *   （走 RPC），但只在浏览器桥在线时可用。
   * · 并发：对**同一个标签页是串行语义**（注入脚本读写该页面的全局与 IndexedDB），
   *   并发调用同一 tab 的不同 op 结果不确定。
   */
  pageOp?<T = unknown>(tabId: number, op: string, args?: unknown[]): Promise<T>

  /**
   * 标签页生命周期。可选能力：依赖它的适配器必须先判存在。
   *
   * 引擎侧：`query` 异常时返回 `[]`，`create` / `waitForLoad` / `close` 异常时抛错。
   */
  tabs?: TabDriver

  /** 非浏览器宿主里的 DOM 能力（引擎侧 = `jsdom`） */
  dom: DomFacade

  /** 按域读 / 写 / 删 cookie；引擎侧 `get` 恒 `[]`、`set`/`remove` 空实现（见各方法） */
  cookies: CookieJar

  /**
   * 取单个 cookie 的**值**（可选能力）。
   *
   * 它是唯一能拿到 **HttpOnly** cookie 的通道（页面 JS 看不见），各平台的 CSRF 令牌
   * 靠它。`domain` 同样是**域**而不是 URL；cookie 不存在返回 `null`（不是 `''`，不抛错）。
   * 引擎侧把一切异常吞成 `null` —— 调用方据此判「没登录 / 没拿到令牌」，因此**不要**
   * 把 `null` 当成网络故障。
   *
   * 读取不做缓存：CSRF 令牌会随会话刷新，缓存会拿到过期令牌。
   */
  getCookie?(domain: string, name: string): Promise<string | null>

  /** 持久键值存储；引擎侧落一个 JSON 文件（每次写整文件落盘） */
  storage: KeyValueStore

  /** 会话级键值存储；重启后必须为空，与 `storage` 不可互换 */
  session: EphemeralStore

  /**
   * 请求头规则（可选能力）。
   *
   * 两侧的**生效窗口不同**：引擎侧把规则折算成「单次请求」的注入头；扩展侧则是
   * 「注册后持续有效直到 `remove` / `clear`」。因此配对释放的责任在调用方，
   * 且必须在 `finally` 语义下完成。
   *
   * 同一实例的规则注册可以并发追加：引擎侧允许多条规则同时存在、由 `urlFilter` 匹配；
   * 扩展侧是「注册 / 撤销」式的，撤销要与注册落在同一个临界区内。
   *
   * 适配器基类把它封成「无此能力时返回 `null` 并跳过」，所以纯代理模式下「注入
   * Origin」天然变成可选项。
   */
  headerRules?: HeaderRuleInjector

  /** 触发浏览器下载；引擎侧为 `undefined`（不可用） */
  downloads?: DownloadSink
}

/**
 * 运行时的构造参数。
 *
 * 仓内当前**没有生产消费方**：它是「配置 → 运行时」这条链的公开契约。
 */
export interface RuntimeConfig {
  /**
   * 预加载 cookie 的历史预留位，**当前实现不消费**。
   *
   * 它来自「`node` 侧要自己管理 cookie」的旧语义；纯代理模式已经推翻这条 —— cookie 由
   * 浏览器代管，引擎进程不碰。保留字段只为公开面不减，不要据此引入任何 cookie 快照逻辑。
   */
  cookies?: Record<string, Cookie[]>

  /**
   * 请求超时（毫秒）。
   *
   * 缺省值由实现决定、本配置层不写死：`fetch` 的实际超时来自实现 —— 引擎侧 RPC 层
   * 缺省 150000ms，扩展侧由调用参数决定。在出现真实消费方之前，不引入第二个超时来源。
   */
  timeout?: number

  /** 自定义 User-Agent（仓内自有扩展项） */
  userAgent?: string
}

/** 由配置产出运行时实例 */
export type RuntimeFactory = (config?: RuntimeConfig) => RuntimeInterface
