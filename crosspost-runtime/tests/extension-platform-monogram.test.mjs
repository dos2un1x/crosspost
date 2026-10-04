/**
 * 平台字母牌判据（v2.3.3）——图标兜底的回归
 *
 * ## 为什么需要它
 *
 * 平台图标是**远端 favicon**（各家站点的 https 链接），失败率不低：实测
 * `https://blog.51cto.com/favicon.ico` 返回非标准 567，站点改域名/WAF 拦一下都会失败。
 * v2.3.2 的兜底是"把破图藏掉"——不再有破图占位，但**行首留一个空洞**：
 * 一册署名表里 12 行缺 3 行"头像"，看起来像页面坏了。
 * v2.3.3 改成用平台名自己画字母牌（知乎→「知」、CSDN→「CS」）。
 *
 * 本文件测**纯函数**（不碰 DOM），钉两件事：
 *   ① 字母牌的取字规则（CJK 取首字、拉丁取前两个字母数字、空值有占位）；
 *   ② 底色**稳定且对形近 id 有区分度** —— `sohu`/`sohufocus`、`douban`/`douyin`
 *      这两对形近 id 必须落在不同档；只按首字符取模的实现会当场红。
 *      档位只有 8 个、平台 28 个，碰撞是必然的（底色只是装饰，登录态由标签文字+颜色表达）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  monogramOf,
  toneOf,
  MONO_PLACEHOLDER,
  MONO_TONES,
} from '../../bridge/chrome-proxy-extension/platform-monogram.mjs'
import { TARGET_PLATFORMS } from '../src/platform-ids.mjs'

test('① 字母牌取字：CJK 取首字，拉丁取前两个字母数字，空值有占位', () => {
  assert.equal(monogramOf('知乎'), '知')
  assert.equal(monogramOf('微信公众号'), '微')
  assert.equal(monogramOf('CSDN'), 'CS')
  assert.equal(monogramOf('SegmentFault'), 'SE')
  assert.equal(monogramOf('51CTO'), '51')
  assert.equal(monogramOf('  简书 '), '简', '首尾空白不影响取字')
  // 空/缺失/null → 占位（不能返回空串：那一格必须被占住）
  assert.equal(monogramOf(''), MONO_PLACEHOLDER)
  assert.equal(monogramOf('   '), MONO_PLACEHOLDER)
  assert.equal(monogramOf(null), MONO_PLACEHOLDER)
  assert.equal(monogramOf(undefined), MONO_PLACEHOLDER)
  assert.equal(monogramOf('!!!'), '!', '全是标点时至少给回首字符，不能给空')
})

test('② 底色档位：落在 [0,8) 且同一 id 永远同档（稳定才可信）', () => {
  for (const id of TARGET_PLATFORMS) {
    const t = toneOf(id)
    assert.ok(Number.isInteger(t) && t >= 0 && t < MONO_TONES, `${id} → ${t} 越界`)
    assert.equal(toneOf(id), t, `${id} 两次结果不一致`)
  }
  assert.equal(toneOf('zhihu'), toneOf('zhihu'))
  assert.equal(toneOf(null), toneOf(''))
})

test('③ 形近 id 必须不同档（sohu/sohufocus、douban/douyin）——按首字符取模的实现会红', () => {
  // 这两对在平台清单里相邻，同色会让字母牌失去辨认作用
  assert.notEqual(toneOf('sohu'), toneOf('sohufocus'), '搜狐 / 搜狐焦点 同色')
  assert.notEqual(toneOf('douban'), toneOf('douyin'), '豆瓣 / 抖音 同色')
  // 反面对照：只看首字符的取模（历史实现候选）会让它们必然同色
  const naive = (s) => s.charCodeAt(0) % MONO_TONES
  assert.equal(naive('sohu'), naive('sohufocus'))
  assert.equal(naive('douban'), naive('douyin'))
})

test('④ 全部平台 id 至少铺满 6 个档位（哈希是为了分散，不是为了唯一）', () => {
  const used = new Set(TARGET_PLATFORMS.map((id) => toneOf(id)))
  assert.ok(used.size >= 6, `只用到 ${used.size} 个档位 —— 底色会显得重复，检查哈希是否退化`)
  assert.ok(used.size <= MONO_TONES)
})
