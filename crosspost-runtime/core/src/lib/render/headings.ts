/**
 * 标题的多结构渲染：`headingProfile` × `headingStructure`。
 *
 * 三族：
 *  - `document`  —— 长文友好：h1 下划线、h2 纯文本、h3 左竖线；
 *  - `slide`     —— 强装饰：短横线 + 大写 + 极重字重；
 *  - `structured`—— h2/h3 由参数显式指定（纯文本 / 左竖线 / 下划线 / 色块）。
 *
 * 约定：装饰放在**外层容器**上（外边距也只由容器承担），内层 `hN` 一律 `margin: 0`，
 * 避免容器与标题各带一份外边距形成双重间距。
 *
 * 渲染按「开标签 + 内联内容 + 闭标签」三段进行：标题文本由 Markdown 的行内规则渲染
 * 一次，因此行内标记（加粗/代码/链接）照常生效，且标题文本在输出里只出现一次。
 */

import { resolveParams, type RenderParams } from './engine'
import type { HeadingStyle } from './styles'

export type HeadingStructure = HeadingStyle

/** 标题字号刻度（h4 同时用于 h5/h6） */
function sizeFor(params: RenderParams, level: number): string {
  if (level <= 1) return params.headingSizes.h1
  if (level === 2) return params.headingSizes.h2
  if (level === 3) return params.headingSizes.h3
  return params.headingSizes.h4
}

const uppercase = (params: RenderParams): string =>
  params.headingUppercase ? ' text-transform: uppercase;' : ''

/** 内层标题元素的样式（字号/字重/字色/清零外边距） */
function innerStyle(params: RenderParams, level: number, color: string): string {
  return (
    `font-size: ${sizeFor(params, level)}; font-weight: bold; color: ${color};` +
    ` margin: 0; line-height: 1.3;`
  )
}

/** `structured` 的 h2/h3：四种装饰形态之一 */
function structuredOpen(level: number, structure: HeadingStructure, params: RenderParams): string {
  const tag = `h${level}`
  const inner = (color: string): string => `<${tag} style="${innerStyle(params, level, color)}">`

  switch (structure) {
    case 'left-border':
      return (
        `<section style="margin: ${params.blockGap} 0;` +
        ` border-left: ${params.headingBorderWidth} solid ${params.headingBorderColor};` +
        ` padding-left: 12px;">` +
        inner(params.text)
      )
    case 'underline':
      return (
        `<section style="margin: ${params.blockGap} 0; border-bottom: 2px solid ${params.accent};` +
        ` padding-bottom: 8px;">` +
        inner(params.text)
      )
    case 'bg-block':
      return (
        `<section style="margin: ${params.blockGap} 0; background-color: ${params.headingBg};` +
        ` padding: 8px 12px; border-radius: ${params.radius};">` +
        inner(params.headingColor)
      )
    default:
      return `<section style="margin: ${params.blockGap} 0;">` + inner(params.accent)
  }
}

/** 朴素标题（h4+）：无外层装饰容器 */
function plainOpen(level: number, params: RenderParams): string {
  return (
    `<h${level} style="margin: ${params.blockGap} 0; font-size: ${sizeFor(params, level)};` +
    ` font-weight: bold; color: ${params.text}; line-height: 1.3;">`
  )
}

/**
 * 标题开标签：返回「外层装饰容器（若有）+ 内层标题元素（含可能的 span）」。
 * 调用方必须用 `headingCloseHtml(level)` 收尾。
 */
export function headingOpenHtml(level: number, params: RenderParams, _styleName = 'swiss'): string {
  if (level >= 4) return plainOpen(level, params)

  if (params.headingProfile === 'slide') {
    if (level === 1) {
      return (
        `<section style="margin: 0 0 40px; border-bottom: ${params.borderWidth} solid` +
        ` ${params.contrastSafeText}; padding-bottom: 15px; max-width: ${params.headingRuleMaxWidth};">` +
        `<h1 style="font-size: 32px; font-weight: 900; color: ${params.text}; margin: 0;` +
        ` line-height: 1.1;${uppercase(params)}">`
      )
    }
    if (level === 2) {
      return (
        `<section style="margin: 36px 0 20px; border-top: 2px solid ${params.text};` +
        ` padding-top: 15px; max-width: ${params.headingRuleMaxWidth};">` +
        `<h2 style="margin: 0; line-height: 1.3;"><span style="color: ${params.accent};` +
        ` font-size: ${params.headingSizes.h2}; font-weight: 800; text-transform: uppercase;">`
      )
    }
    return (
      `<section style="margin: ${params.blockGap} 0;` +
      ` border-left: ${params.headingBorderWidth} solid ${params.accent}; padding-left: 12px;">` +
      `<h3 style="margin: 0; line-height: 1.3;"><span style="font-size: ${params.headingSizes.h3};` +
      ` font-weight: bold; color: ${params.text};">`
    )
  }

  if (params.headingProfile === 'structured') {
    if (level === 1) {
      return (
        `<section style="margin: 30px 0 20px; border-bottom: ${params.headingRuleWidth} solid` +
        ` ${params.accent}; padding-bottom: 10px;">` +
        `<h1 style="${innerStyle(params, 1, params.text)}">`
      )
    }
    return structuredOpen(level, level === 3 ? params.h3Structure : params.headingStructure, params)
  }

  // document
  if (level === 1) {
    return (
      `<section style="margin: 30px 0 20px; border-bottom: ${params.headingRuleWidth} solid` +
      ` ${params.accent}; padding-bottom: 10px;">` +
      `<h1 style="${innerStyle(params, 1, params.text)}">`
    )
  }
  if (level === 2) {
    return (
      `<section style="margin: ${params.blockGap} 0;">` +
      `<h2 style="${innerStyle(params, 2, params.text)}">`
    )
  }
  return (
    `<section style="margin: ${params.blockGap} 0;` +
    ` border-left: ${params.headingBorderWidth} solid ${params.accent}; padding-left: 12px;">` +
    `<h3 style="${innerStyle(params, 3, params.text)}">`
  )
}

/** 标题闭标签：与 `headingOpenHtml` 严格配对 */
export function headingCloseHtml(level: number): string {
  if (level >= 4) return `</h${level}>`
  if (level === 3) return '</h3></section>'
  return level === 2 ? '</h2></section>' : '</h1></section>'
}

/**
 * 一次性渲染整条标题（内联内容已渲染好时使用）。
 * `style` 既可以是样式定义对象，也可以是已派生的参数对象。
 */
export function renderHeading(
  level: number,
  innerHtml: string,
  style: unknown,
  styleName = 'swiss',
): string {
  const params = resolveParams(style, styleName)
  return headingOpenHtml(level, params, styleName) + innerHtml + headingCloseHtml(level)
}
