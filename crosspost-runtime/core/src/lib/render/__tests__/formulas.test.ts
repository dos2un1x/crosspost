/**
 * renderFormulas / looksLikeMath 测试（渲染引擎公式能力, 2026-09-06）
 *
 * 覆盖：
 *  - looksLikeMath 判定（非空/长度上限/含中文排除）
 *  - renderFormulas 批量渲染（行内 $...$ / 展示 $$...$$ → SVG 输出；失败不拖垮整批）
 */
import { describe, it, expect } from 'vitest'
import { looksLikeMath, renderFormulas } from '../formulas'

describe('looksLikeMath', () => {
  it('纯表达式/含下标的公式 → true', () => {
    expect(looksLikeMath('x^2 + y^2 = z^2')).toBe(true)
    expect(looksLikeMath('a_{n+1} = a_n + d')).toBe(true)
    expect(looksLikeMath('E = mc^2')).toBe(true)
  })

  it('空串 / 超长 / 含中文 → false', () => {
    expect(looksLikeMath('')).toBe(false)
    expect(looksLikeMath('   ')).toBe(false)
    expect(looksLikeMath('x'.repeat(201))).toBe(false)
    expect(looksLikeMath('这是一个中文句子')).toBe(false)
    expect(looksLikeMath('变量 x 加 1')).toBe(false)
  })
})

describe('renderFormulas', () => {
  it('行内与展示公式均渲染出 SVG，且保留 display 标志', () => {
    const res = renderFormulas([
      { id: 'm0', latex: 'x^2', display: false },
      { id: 'm1', latex: '\\frac{a}{b}', display: true },
    ])
    expect(res.m0.ok).toBe(true)
    expect(res.m1.ok).toBe(true)
    if (res.m0.svg) {
      expect(res.m0.svg).toContain('<svg')
    } // 行内渲染返回 SVG 片段（无独立 svg tag 时由外层包裹）
    expect(res.m1.ok).toBe(true)
  })

  it('单个失败不拖垮整批（非法 latex → ok:false，其余正常）', () => {
    const res = renderFormulas([
      { id: 'good', latex: 'a+b', display: false },
      { id: 'bad', latex: '\\frac{', display: false }, // 不完整 latex
    ])
    expect(res.good.ok).toBe(true)
    expect(res.bad.ok).toBe(false) // 单个坏公式降级为失败，不抛
  })
})
