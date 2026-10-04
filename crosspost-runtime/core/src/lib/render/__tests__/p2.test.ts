import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateCover, generateCoverSet } from '../cover'
import { processImages } from '../images'
import { renderMarkdownAsync } from '../index'

describe('P2 cover generation', () => {
  it('generates 2.35:1 PNG with Chinese title (swiss)', async () => {
    const r = await generateCover({ title: '标题测试文章', style: 'swiss' })
    expect(r.ok).toBe(true)
    expect(r.png).toBeTruthy()
    expect(r.width).toBe(900)
    expect(r.height).toBe(383)
    expect(r.png!.length).toBeGreaterThan(1000)
    // PNG 魔数
    expect(r.png!.slice(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  })

  it('generates 1:1 square cover (ink)', async () => {
    const r = await generateCover({ title: '水墨风格', style: 'ink', ratio: '1_1' })
    expect(r.ok).toBe(true)
    expect(r.width).toBe(900)
    expect(r.height).toBe(900)
  })

  it('generates all 10 builtin styles', async () => {
    for (const style of [
      'swiss',
      'editorial',
      'ink',
      'notebook',
      'geometry',
      'botanical',
      'terminal',
      'bold',
      'cyber',
      'voltage',
    ]) {
      const r = await generateCover({ title: '样式封面测试', style })
      expect(r.ok, style).toBe(true)
      expect(r.png!.length).toBeGreaterThan(500)
    }
  })

  it('writes files for cover set', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cover-'))
    const r = await generateCoverSet({ title: '双尺寸封面', style: 'swiss', outDir })
    expect(r.cover2_35_1.ok).toBe(true)
    expect(r.cover1_1.ok).toBe(true)
    expect(fs.existsSync(path.join(outDir, 'cover_2_35_1.png'))).toBe(true)
    expect(fs.existsSync(path.join(outDir, 'cover_1_1.png'))).toBe(true)
    fs.rmSync(outDir, { recursive: true, force: true })
  })

  it('reports unknown template', async () => {
    const r = await generateCover({ title: 'x', template: 'nope' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未知封面模板')
  })
})

describe('P2 image pipeline', () => {
  it('dry-run without uploader keeps html unchanged', async () => {
    const html = '<img src="https://example.com/a.png">'
    const r = await processImages(html, {})
    expect(r.handled).toBe(0)
    expect(r.skipped).toBe(0)
    expect(r.html).toBe(html)
  })

  it('uploads remote images via uploader and sets data-src', async () => {
    const html = '<img src="https://example.com/a.png">'
    const r = await processImages(html, {
      uploader: async () => 'https://cdn.example.com/up.png',
    })
    expect(r.handled).toBe(1)
    expect(r.html).toContain('src="https://cdn.example.com/up.png"')
    expect(r.html).toContain('data-src="https://cdn.example.com/up.png"')
  })

  it('resolves local image relative to mdPath and uploads', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-img-'))
    const mdPath = path.join(tmp, 'article.md')
    fs.writeFileSync(path.join(tmp, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const r = await processImages('<img src="pic.png">', {
      mdPath,
      uploader: async (src, kind) => {
        expect(kind).toBe('local')
        expect(fs.existsSync(src)).toBe(true)
        return 'https://cdn.example.com/local.png'
      },
    })
    expect(r.handled).toBe(1)
    expect(r.html).toContain('https://cdn.example.com/local.png')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('reports missing local image as failed', async () => {
    const r = await processImages('<img src="nope.png">', {
      mdPath: '/tmp/x/article.md',
      uploader: async () => 'https://cdn.example.com/x.png',
    })
    expect(r.handled).toBe(0)
    expect(r.failed.length).toBe(1)
    expect(r.failed[0].error).toContain('未找到')
  })

  it('caches by src hash', async () => {
    let calls = 0
    const r1 = await processImages(
      '<img src="https://example.com/c.png"><img src="https://example.com/c.png">',
      {
        uploader: async () => {
          calls++
          return 'https://cdn.example.com/c.png'
        },
      },
    )
    expect(calls).toBe(1)
    expect(r1.handled).toBe(2)
  })
})

describe('P2 renderMarkdownAsync with uploader', () => {
  it('replaces image URLs when uploader provided', async () => {
    const r = await renderMarkdownAsync('![图](https://example.com/pic.png)', {
      style: 'swiss',
      imageUploader: async () => 'https://cdn.example.com/up.png',
    })
    expect(r.html).toContain('https://cdn.example.com/up.png')
    expect(r.images!.handled).toBe(1)
  })
})
