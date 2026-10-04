/**
 * config.json 的**路径规则**（唯一来源，v2.77）
 *
 * 为什么单独一个模块：v2.47 的脑裂事故就是"同一规则写了两份"——`bridge/cli-worker.mjs`
 * 认 `CROSSPOST_CONFIG`，而 `src/config-cache.mjs` 不认，于是同一个进程里桥读写沙箱配置、
 * 引擎读生产配置。现在两处（以及新的分层的 `config-layers.mjs`）都从这里取。
 *
 * 规则：`CROSSPOST_CONFIG` > `<runtime>/config.json`。生产不设该变量 → 行为逐字不变。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 默认配置路径（不随 env 变化）。仅供不需要"当前生效路径"的场景引用。 */
export const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'config.json')

/** 当前生效的 config.json 路径（每次调用都重新读 env） */
export function configPath() {
  return process.env.CROSSPOST_CONFIG || DEFAULT_CONFIG_PATH
}
