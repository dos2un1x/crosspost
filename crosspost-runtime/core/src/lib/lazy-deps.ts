/**
 * 重依赖的**同步按需加载**（2026-10-10）
 *
 * ## 为什么需要
 *
 * `jsdom`（422ms）与 `juice`（119ms）合计约 **0.54s**，而它们是 CJS 包、
 * 只有**真正渲染/发布**时才用得到。写成顶层 `import` 时，这份加载成本会被**每一个**
 * import `@crosspost/core` 的进程付掉：
 *   · CLI 每次冷启动（`node cli.mjs <任意命令>`，实测 1.13s 里有 0.6s 是它们）；
 *   · 测试里每次 spawn 引擎的子进程（套件里还有几十处）；
 *   · 每个 import 到 core 的测试文件。
 * 于是一个 `aiDetect --budget` 这样的轻命令也要先把 jsdom 拖起来。
 *
 * ## 为什么不用 `await import()`
 *
 * 用到它们的地方有 4 个是**同步**函数（`preprocessHtml` / `annotateBlocks` /
 * `postProcessHtml` / `analyzeStyleFromHtmlFallback`），改成 async 会牵动调用方与它们的调用方。
 * 这三者都是 CJS 包，`createRequire` 可以**同步**取到：代价只在**首次真正用到**时付一次。
 *
 * ## 纪律
 *
 * 这里只允许放"体积大 + 只在少数路径用"的依赖。轻依赖（markdown-it / marked 这类 10~25ms）
 * 直接顶层 import 更简单，别搬进来 —— 多一层间接也是成本。
 * `sharp`（71ms）刻意**不**进来：它是 ESM 形状（可调用对象在 `.default`），为 71ms 写互操作
 * 分支不划算 —— 顶层 import 即可。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let _jsdom: typeof import('jsdom') | null = null
let _juice: typeof import('juice') | null = null

/** jsdom（首次调用付 ~420ms） */
export function getJSDOM(): typeof import('jsdom').JSDOM {
  if (!_jsdom) _jsdom = require('jsdom') as typeof import('jsdom')
  return _jsdom.JSDOM
}

/**
 * juice：内联 CSS（首次调用付 ~120ms）
 *
 * `juice` 与 `sharp` 都是 `export =` 的 CJS 包（可调用对象 + 命名空间），所以直接返回 require 的
 * 结果，**不要**取 `.default` —— 那是 ESM 互操作形状，运行时是 undefined。
 */
export function getJuice(): typeof import('juice') {
  if (!_juice) _juice = require('juice') as typeof import('juice')
  return _juice
}

// 源码：https://github.com/dos2un1x/crosspost（作者 dos2un1x）
