/**
 * 平台域：适配器注册表 + 登录检查 + 登录预检（从 cli.mjs 拆分，2026-08-24）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeRuntime } from '../runtime-node.mjs'
import { TARGET_PLATFORMS } from '../platform-ids.mjs'
import { readConfig } from '../config-cache.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')

export { TARGET_PLATFORMS }

const {
  ZhihuAdapter,
  CSDNAdapter,
  WeixinAdapter,
  BilibiliAdapter,
  BaijiahaoAdapter,
  ToutiaoAdapter,
  XiaohongshuAdapter,
  JianshuAdapter,
  YidianAdapter,
  DayuAdapter,
  SmzdmAdapter,
  DoubanAdapter,
  XueqiuAdapter,
  SohuAdapter,
  WoshipmAdapter,
  JuejinAdapter,
  WeiboAdapter,
  YuqueAdapter,
  Cto51Adapter,
  ImoocAdapter,
  OschinaAdapter,
  SegmentfaultAdapter,
  CnblogsAdapter,
  EastmoneyAdapter,
  DouyinAdapter,
  NeteaseAdapter,
  SohufocusAdapter,
} = await import('@crosspost/core/adapters')
export const ADAPTER_CLASSES = {
  zhihu: ZhihuAdapter,
  csdn: CSDNAdapter,
  weixin: WeixinAdapter,
  bilibili: BilibiliAdapter,
  baijiahao: BaijiahaoAdapter,
  toutiao: ToutiaoAdapter,
  xiaohongshu: XiaohongshuAdapter,
  jianshu: JianshuAdapter,
  yidian: YidianAdapter,
  dayu: DayuAdapter,
  smzdm: SmzdmAdapter,
  douban: DoubanAdapter,
  xueqiu: XueqiuAdapter,
  sohu: SohuAdapter,
  woshipm: WoshipmAdapter,
  juejin: JuejinAdapter,
  weibo: WeiboAdapter,
  yuque: YuqueAdapter,
  cto51: Cto51Adapter,
  imooc: ImoocAdapter,
  oschina: OschinaAdapter,
  segmentfault: SegmentfaultAdapter,
  cnblogs: CnblogsAdapter,
  eastmoney: EastmoneyAdapter,
  douyin: DouyinAdapter,
  netease: NeteaseAdapter,
  sohufocus: SohufocusAdapter,
}

const runtime = createNodeRuntime({
  storageFile: path.join(ROOT, 'storage.json'),
})
export { runtime }

export async function getAdapter(id) {
  const Cls = ADAPTER_CLASSES[id]
  if (!Cls) return null
  const adapter = new Cls()
  await adapter.init(runtime)
  return adapter
}

/**
 * 检查并发度（2026-09-11 可配置）：默认 6（历史硬编码值），钳制 1-10。
 * 配置项 config.json.platformsCheckConcurrency 由 Console 设置页写入；
 * 仅影响「平台登录状态检查」，发布前的 prefilterAuthed 预检不受影响。
 */
export const DEFAULT_CHECK_CONCURRENCY = 6
export function clampConcurrency(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 1) return DEFAULT_CHECK_CONCURRENCY
  return Math.min(10, Math.floor(v))
}
export function checkConcurrency() {
  try {
    return clampConcurrency(readConfig().platformsCheckConcurrency)
  } catch {
    return DEFAULT_CHECK_CONCURRENCY
  }
}

/**
 * listPlatforms 支持子集查询（bridge 用于失败平台独立重查）：
 *   node cli.mjs listPlatforms            → 全部已知平台
 *   node cli.mjs listPlatforms csdn,weibo → 仅查指定平台（逗号分隔）
 *   node cli.mjs listPlatforms [] --concurrency=3 → 自定义并发（1-10）
 * 第二个参数为并发度，缺省 6（保持历史行为）。
 */
export async function listPlatforms(idArg, concurrency = DEFAULT_CHECK_CONCURRENCY) {
  const ids =
    idArg && idArg !== 'true'
      ? idArg
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : TARGET_PLATFORMS
  const out = new Array(ids.length)
  // 并发 checkAuth（默认限 6，防平台 API 风控；并发度由 config.platformsCheckConcurrency 控制），结果按请求顺序返回
  const limit = Math.min(clampConcurrency(concurrency), ids.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const i = cursor
      cursor += 1
      if (i >= ids.length) return
      const id = ids[i]
      try {
        const adapter = await getAdapter(id)
        const auth = await adapter.checkAuth()
        out[i] = {
          id,
          name: adapter.meta.name,
          icon: adapter.meta.icon,
          capabilities: adapter.meta.capabilities,
          isAuthenticated: !!auth.isAuthenticated,
          username: auth.username || null,
          error: auth.error || null,
        }
      } catch (e) {
        out[i] = { id, name: id, isAuthenticated: false, error: String((e && e.message) || e) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker))
  return out
}

/**
 * 登录预检（2026-08-20）：目标平台推送前检查登录，未登录自动跳过（skip），不报失败。
 * 返回 { push: string[], skip: {id,error}[] }
 */
export async function prefilterAuthed(ids) {
  if (!ids.length) return { push: [], skip: [] }
  let authMap = new Map()
  try {
    const list = await listPlatforms(ids.join(','))
    authMap = new Map(list.map((p) => [p.id, p]))
  } catch {
    return { push: ids, skip: [] }
  }
  const push = []
  const skip = []
  for (const id of ids) {
    const p = authMap.get(id)
    if (!p || p.isAuthenticated) {
      push.push(id)
      continue
    }
    try {
      const r = await listPlatforms(id)
      if (r[0] && r[0].isAuthenticated) {
        push.push(id)
        continue
      }
    } catch {
      push.push(id)
      continue
    }
    skip.push({ id, error: p.error || '未登录' })
  }
  return { push, skip }
}

/** 图片上传器：本地读文件 / 外链经代理下载 → zhihu 图床；不可用时返回 null（dry-run） */
export async function makeImageUploader() {
  try {
    const adapter = await getAdapter('zhihu')
    if (!adapter || typeof adapter.uploadImage !== 'function') return null
    return async (src, kind) => {
      let buf
      if (kind === 'local') {
        buf = fs.readFileSync(src)
      } else {
        const resp = await runtime.fetch(src, { method: 'GET' })
        if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`)
        buf = Buffer.from(await resp.arrayBuffer())
      }
      const blob = new Blob([buf], { type: 'image/png' })
      const url = await adapter.uploadImage(blob)
      if (!url) throw new Error('图床上传返回空 URL')
      return url
    }
  } catch {
    return null
  }
}
