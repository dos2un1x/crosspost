/**
 * 命令行参数解析（`--key=value` / `--key value` / `--flag`）。
 *
 * 为什么单独一个模块：CLI 的 flag 语义只有一份，业务模块不该各解析一遍——
 * 早先它长在 `topic-pool.mjs` 里（那里先需要），但 `cli.mjs` 的其它方法
 * （如 `retainArticle`）同样要用。位置从"谁先用到"改成"它是谁"。
 *
 * `opts.booleans` 里的键是**开关**，不会吃掉后面那个 token —— 否则
 * `--manual 某候选` 会把 `manual` 解成字符串（看着像开了、其实没开），
 * 是最难查的一类静默错。
 *
 * @param {string[]} args
 * @param {{booleans?: string[]}} [opts]
 * @returns {{_: string[], [k: string]: string|boolean|string[]}}
 */
export function parseFlags(args, opts = {}) {
  const booleans = new Set(opts.booleans || [])
  const out = { _: [] }
  const list = Array.isArray(args) ? args : []
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i])
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq !== -1) {
      const k = a.slice(2, eq)
      out[k] = booleans.has(k) ? a.slice(eq + 1) !== 'false' : a.slice(eq + 1)
      continue
    }
    const key = a.slice(2)
    if (booleans.has(key)) {
      out[key] = true
      continue
    }
    const next = list[i + 1]
    if (next !== undefined && !String(next).startsWith('--')) {
      out[key] = String(next)
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}
