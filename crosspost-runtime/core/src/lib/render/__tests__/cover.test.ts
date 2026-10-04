// cover.ts 封面生成单测（2026-08-28 阶段 C1）
import { describe, it, expect } from 'vitest'
import { generateCover, generateCoverSet, COVER_TEMPLATE_NAMES } from '../cover'

describe('generateCover', () => {
  it('13 款模板全部生成成功（png 非空）', async () => {
    for (const template of COVER_TEMPLATE_NAMES) {
      const r = await generateCover({ title: '测试封面', template, ratio: '2_35_1' })
      expect(r.ok, `模板 ${template} 应成功`).toBe(true)
      expect(r.png && r.png.length).toBeGreaterThan(500)
      expect(r.width).toBe(900)
    }
  })

  it('未知模板报错并给出可选列表', async () => {
    const r = await generateCover({ title: 'x', template: 'nope' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未知封面模板')
  })

  it('双尺寸封面集生成（minimal 无 1:1 变体）', async () => {
    const set = await generateCoverSet({
      title: '双尺寸',
      template: 'nebula',
      outDir: '/tmp/cp-cover-set-test',
    })
    expect(set.cover2_35_1.ok).toBe(true)
    expect(set.cover1_1.ok).toBe(true)
    const minimal = await generateCoverSet({
      title: '双尺寸',
      template: 'minimal',
      outDir: '/tmp/cp-cover-min-test',
    })
    expect(minimal.cover2_35_1.ok).toBe(true)
  })

  it('title 中的引号/尖括号不会破坏 SVG 输出', async () => {
    const r = await generateCover({ title: '标题"含引号"<尖括号>&符号', template: 'cyber' })
    expect(r.ok).toBe(true)
    expect(r.png && r.png.length).toBeGreaterThan(500)
  })
})
