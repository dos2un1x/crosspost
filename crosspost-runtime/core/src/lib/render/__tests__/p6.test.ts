/**
 * P6：自定义样式管理 + 样式采样
 *
 * 覆盖行为契约（见渲染引擎行为说明书 §7-F）：
 *  F1 样式名归一化：自动补 `custom-` 前缀 / 非法字符拒绝 / 空名拒绝
 *  F2 由模板克隆 + 覆盖参数创建样式：文件落盘、覆盖值生效
 *  F3 非法颜色被拒，错误信息含字段名
 *  F4 重名创建被拒（含「已存在」）
 *  F5 模板不存在被拒（含「模板样式不存在」）
 *  F6 改名 / 删除只动文件，语义正确
 *  F7 查看返回样式内容，category 为 custom
 *  F8 短标识：保留 CJK、去标点、拉丁 token 以连字符连接、上限 24 字符
 *  F9 样式名生成：有标题 → `custom-<短标识>`；无标题 → `custom-<8 位日期>-<6 位十六进制>`
 *  F10 降级采样器（纯 DOM、只读行内 style）：取到背景/正文/强调色与字号，颜色为大写 hex
 *
 * 另加一条：自定义样式文件里的旧式「整元素样式串」字段必须被忽略并留下告警。
 *
 * 隔离：全部通过 `CROSSPOST_CUSTOM_STYLES_DIR` 指向每个用例自己的临时目录。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createCustomStyle,
  deleteCustomStyle,
  invalidateCustomStyleCache,
  loadCustomStyles,
  normalizeStyleName,
  renameCustomStyle,
  showCustomStyle,
} from '../custom'
import { analyzeStyleFromHtmlFallback, generateCustomStyleName, slugify } from '../analyze'

/** 各操作的成功/失败形态不统一（有的返回 ok 对象，有的直接给字符串），统一读取 */
interface OpResult {
  ok: boolean
  name?: string
  path?: string
  error?: string
  style?: Record<string, unknown>
  styles?: Record<string, unknown>
  warnings?: string[]
}

function op(value: unknown): OpResult {
  return value as OpResult
}

/** 参数对象按「新字段名优先、旧别名兜底」取值——采样器的字段名属于实现自由度 */
function readParam(params: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (params[key] !== undefined) return params[key]
  }
  return undefined
}

const HEX_UPPER = /^#[0-9A-F]{6}$/

let stylesDir = ''

beforeEach(() => {
  stylesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-p6-'))
  process.env.CROSSPOST_CUSTOM_STYLES_DIR = stylesDir
  invalidateCustomStyleCache()
})

afterEach(() => {
  fs.rmSync(stylesDir, { recursive: true, force: true })
  delete process.env.CROSSPOST_CUSTOM_STYLES_DIR
  invalidateCustomStyleCache()
})

describe('F1 样式名归一化', () => {
  it('用户只给中文名时自动补 custom- 前缀', () => {
    const r = op(normalizeStyleName('品牌绿'))
    expect(r.ok).toBe(true)
    expect(r.name).toBe('custom-品牌绿')
  })

  it('含空格/感叹号等非法字符时拒绝', () => {
    const r = op(normalizeStyleName('custom-x y!'))
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    expect(r.name).toBeUndefined()
  })

  it('空名拒绝', () => {
    const r = op(normalizeStyleName(''))
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })
})

describe('F2 从模板克隆创建样式', () => {
  it('文件落盘，且覆盖的 accent 生效', () => {
    const r = op(createCustomStyle('品牌绿', 'swiss', { accent: '#2f9e44' }))
    expect(r.ok).toBe(true)
    expect(r.name).toBe('custom-品牌绿')

    const file = path.join(stylesDir, 'custom-品牌绿.json')
    expect(fs.existsSync(file)).toBe(true)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(saved.accent).toBe('#2f9e44')
    // 模板里的其它参数被克隆下来（不是只写了覆盖字段）
    expect(typeof saved.bg).toBe('string')
  })
})

describe('F3 非法颜色被拒', () => {
  it('错误信息里带字段名 accent', () => {
    const r = op(createCustomStyle('坏色', 'swiss', { accent: 'not-a-color' }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('accent')
  })
})

describe('F4 重名创建被拒', () => {
  it('第二次创建同名样式返回「已存在」', () => {
    expect(op(createCustomStyle('品牌绿', 'swiss', { accent: '#2f9e44' })).ok).toBe(true)
    const again = op(createCustomStyle('品牌绿', 'swiss', { accent: '#2f9e44' }))
    expect(again.ok).toBe(false)
    expect(again.error).toContain('已存在')
  })
})

describe('F5 模板不存在被拒', () => {
  it('提示模板样式不存在', () => {
    const r = op(createCustomStyle('野生样式', 'no-such-template', {}))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('模板样式不存在')
  })
})

describe('F6 改名与删除', () => {
  it('改名后旧文件消失、新文件出现', () => {
    expect(op(createCustomStyle('品牌绿', 'swiss', { accent: '#2f9e44' })).ok).toBe(true)
    const renamed = op(renameCustomStyle('custom-品牌绿', 'custom-品牌深绿'))
    expect(renamed.ok).toBe(true)
    expect(fs.existsSync(path.join(stylesDir, 'custom-品牌绿.json'))).toBe(false)
    expect(fs.existsSync(path.join(stylesDir, 'custom-品牌深绿.json'))).toBe(true)
  })

  it('删除后文件消失；内置样式不可删', () => {
    expect(op(createCustomStyle('品牌绿', 'swiss', { accent: '#2f9e44' })).ok).toBe(true)
    expect(op(deleteCustomStyle('custom-品牌绿')).ok).toBe(true)
    expect(fs.readdirSync(stylesDir)).toEqual([])

    const builtin = op(deleteCustomStyle('swiss'))
    expect(builtin.ok).toBe(false)
    expect(builtin.error).toBeTruthy()
  })
})

describe('F7 查看样式', () => {
  it('返回样式内容，category 为 custom，且自动补前缀', () => {
    expect(op(createCustomStyle('品牌绿', 'swiss', { accent: '#2f9e44' })).ok).toBe(true)
    const shown = op(showCustomStyle('品牌绿'))
    expect(shown.ok).toBe(true)
    expect(shown.name).toBe('custom-品牌绿')
    expect(shown.style?.category).toBe('custom')
    expect(shown.style?.accent).toBe('#2f9e44')
  })
})

describe('F8 短标识 slugify', () => {
  it('保留 CJK、去掉中英文标点', () => {
    const slug = String(slugify('从 0 到 1：AI 写作指南'))
    expect(slug).toContain('从')
    expect(slug).toContain('0')
    expect(slug).not.toMatch(/[，。！？：；、\s]/)
    expect(slug.startsWith('-')).toBe(false)
    expect(slug.endsWith('-')).toBe(false)
  })

  it('拉丁 token 用连字符连接，且长度不超过 24', () => {
    const slug = String(slugify('Hello, World! This Is A Very Long English Article Title'))
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(slug.split('-').length).toBeGreaterThanOrEqual(3)
    expect(slug.length).toBeLessThanOrEqual(24)
    expect(String(slugify('a'.repeat(80))).length).toBeLessThanOrEqual(24)
  })

  it('没有可用的标识字符时回落到 style', () => {
    expect(String(slugify(''))).toBe('style')
    expect(String(slugify('。。。！？'))).toBe('style')
  })
})

describe('F9 样式名生成', () => {
  it('有标题 → custom- 前缀', () => {
    const name = String(generateCustomStyleName('从 0 到 1：AI 写作指南'))
    expect(name.startsWith('custom-')).toBe(true)
    expect(name.length).toBeGreaterThan('custom-'.length)
  })

  it('无标题 → custom-<8 位日期>-<6 位十六进制>', () => {
    expect(String(generateCustomStyleName(''))).toMatch(/^custom-\d{8}-[0-9a-f]{6}$/)
  })
})

describe('F10 降级采样器（只读行内 style）', () => {
  const HTML = [
    '<div style="background-color: rgb(255, 255, 255); color: #333333; font-size: 16px; line-height: 28px">',
    '<h1 style="border-bottom: 2px solid #ff0000">标题</h1>',
    '<p>正文</p>',
    '<a style="color: #ff0000">链接</a>',
    '</div>',
  ].join('')

  it('取到背景色/正文色/强调色，颜色为大写 hex', () => {
    const params = analyzeStyleFromHtmlFallback(HTML) as unknown as Record<string, unknown>
    expect(params.bg).toBe('#FFFFFF')
    expect(params.text).toBe('#333333')
    expect(String(params.accent)).toMatch(HEX_UPPER)
    expect(String(params.bg)).toMatch(HEX_UPPER)
  })

  it('取到字号与行高', () => {
    const params = analyzeStyleFromHtmlFallback(HTML) as unknown as Record<string, unknown>
    const fontSize = readParam(params, ['font_size', 'baseFontSize', 'fontSize'])
    const lineHeight = readParam(params, ['line_height', 'lineHeight'])
    expect(String(fontSize)).toBe('16px')
    // 行高归一为「倍数」：28px / 16px = 1.75
    expect(Number(lineHeight)).toBeCloseTo(1.75, 2)
  })
})

describe('自定义样式加载：旧式整元素样式串被忽略', () => {
  it('含 cssTemplate 的样式仍可加载，并留下告警', () => {
    fs.writeFileSync(
      path.join(stylesDir, 'custom-legacy.json'),
      JSON.stringify({
        bg: '#ffffff',
        accent: '#123456',
        text: '#111111',
        cssTemplate: { h1: 'color: red' },
      }),
    )
    invalidateCustomStyleCache()
    const r = op(loadCustomStyles())
    expect(Object.keys(r.styles ?? {})).toContain('custom-legacy')
    expect((r.warnings ?? []).join('\n')).toContain('cssTemplate')
  })
})
