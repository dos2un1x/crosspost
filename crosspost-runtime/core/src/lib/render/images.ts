/**
 * 图片后处理管线（渲染片段 → 上传后的图床地址）
 *
 * 渲染阶段只写图片的**原始地址**（本地相对路径或远程 URL）；真正的搬运发生在
 * 调用方提供了 uploader 之后：本模块遍历片段里的每个 `<img>`，把原始地址交给
 * uploader，再用返回的新地址同时写回 `src` 与 `data-src`（公众号的懒加载机制
 * 只认 `data-src`，两个属性必须同值）。
 *
 * 三条硬边界：
 *  1. **只返回正文片段**。绝不把 DOM 库的整篇文档序列化结果（`<html><head><body>`）
 *     交出去——文档级标签进草稿会让编辑器解析异常。
 *  2. **失败只降级不中断**：单张图失败（本地文件缺失、上传抛错、回包无地址）时保留
 *     原属性、计入 `failed`，其余图片继续处理。
 *  3. **同一地址只上传一次**：以原始 `src` 的内容指纹为键做单次渲染内的去重，
 *     失败结果不写缓存（下次仍有重试机会）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

/** 图片来源类别：磁盘上的本地文件，或需要下载的远程地址 */
export type ImageSourceKind = 'local' | 'remote'

/** 上传实现：入参为绝对路径（本地）或原 URL（远程），返回可公网访问的新地址 */
export type ImageUploader = (source: string, kind: ImageSourceKind) => string | Promise<string>

/** 单张图片的失败记录 */
export interface ImageFailure {
  /** 渲染期的原始地址 */
  src: string
  /** 人类可读的失败原因 */
  error: string
}

export interface ImagePipelineResult {
  /** 替换后的正文片段 */
  html: string
  /** 成功替换（含命中缓存）的图片数 */
  handled: number
  /** 按设计跳过的图片数（空 src / data: 内联图） */
  skipped: number
  failed: ImageFailure[]
}

export interface ImagePipelineOptions {
  /** 缺省则整条管线 dry-run：HTML 原样返回，计数全 0 */
  uploader?: ImageUploader
  /** Markdown 文件路径；本地相对路径以它所在目录为基准（缺省用进程工作目录） */
  mdPath?: string
  /** 可注入的地址缓存（键为原始地址指纹）；缺省为本次调用的内存表 */
  cache?: Map<string, string>
}

const REMOTE_PATTERN = /^https?:\/\//i
const INLINE_PATTERN = /^data:/i

function classify(source: string): ImageSourceKind {
  return REMOTE_PATTERN.test(source) ? 'remote' : 'local'
}

/**
 * 原始地址的内容指纹（FNV-1a，非加密用途）。
 * 只用做「同一次渲染里同一地址不重复上传」的键，长度前缀避免不同串撞同一键。
 */
function fingerprint(source: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${source.length.toString(36)}:${hash.toString(36)}`
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 空片段或没有 uploader（dry-run）时不做任何解析，保证输入输出逐字节一致 */
function idleFragment(html: string): ImagePipelineResult {
  return { html, handled: 0, skipped: 0, failed: [] }
}

/**
 * 遍历片段中的图片并替换地址。
 * 返回的 `html` 始终是片段：只取解析后 `<body>` 的内部 HTML。
 */
export async function processImages(
  html: string,
  options: ImagePipelineOptions = {},
): Promise<ImagePipelineResult> {
  const uploader = options.uploader
  if (typeof uploader !== 'function' || !html) return idleFragment(html)

  const dom = new JSDOM(html)
  const document = dom.window.document
  const baseDir = options.mdPath ? path.dirname(path.resolve(options.mdPath)) : process.cwd()
  const memo = options.cache instanceof Map ? options.cache : new Map<string, string>()

  const result = idleFragment(html)
  for (const image of Array.from(document.querySelectorAll('img'))) {
    const original = image.getAttribute('src') ?? ''
    if (!original || INLINE_PATTERN.test(original)) {
      result.skipped += 1
      continue
    }

    const kind = classify(original)
    let target = original
    if (kind === 'local') {
      target = path.resolve(baseDir, original)
      if (!fs.existsSync(target)) {
        result.failed.push({ src: original, error: `本地图片未找到：${target}` })
        continue
      }
    }

    const key = fingerprint(original)
    let replacement = memo.get(key)
    if (replacement === undefined) {
      try {
        replacement = await uploader(target, kind)
      } catch (error) {
        result.failed.push({ src: original, error: reasonOf(error) })
        continue
      }
      if (!replacement) {
        result.failed.push({ src: original, error: `上传图片未返回可用地址：${original}` })
        continue
      }
      memo.set(key, replacement)
    }

    image.setAttribute('src', replacement)
    image.setAttribute('data-src', replacement)
    result.handled += 1
  }

  result.html = document.body.innerHTML
  return result
}
