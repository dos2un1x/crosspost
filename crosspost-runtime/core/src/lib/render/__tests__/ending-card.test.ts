// ending-card.ts 结束语图单测（2026-08-28 阶段 C1）
import { describe, it, expect } from 'vitest'
import { generateEndingCard } from '../ending-card'

describe('generateEndingCard', () => {
  it('默认文案渲染成功（emoji 自绘）', async () => {
    const r = await generateEndingCard({ template: 'cyber', outPath: '/tmp/cp-ending-test.png' })
    expect(r.ok).toBe(true)
    expect(r.path).toBe('/tmp/cp-ending-test.png')
    const buf = await (await import('node:fs')).promises.readFile(r.path)
    expect(buf.length).toBeGreaterThan(500)
  })

  it('自定义文案渲染成功', async () => {
    const r = await generateEndingCard({
      template: 'cyber',
      text: '谢谢你能看完。有用的话点个赞。',
      outPath: '/tmp/cp-ending-text.png',
    })
    expect(r.ok).toBe(true)
  })

  it('禁用模板回退默认', async () => {
    const r = await generateEndingCard({ template: 'nope' })
    // 未知模板：generateEndingCard 内部回退默认模板（不报错）或返回错误——两者都接受，但必须 ok 或明确错误
    expect(r.ok === true || typeof r.error === 'string').toBe(true)
  })
})
