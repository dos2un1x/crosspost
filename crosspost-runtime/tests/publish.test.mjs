// publish.mjs 核心链路单元测试（node:test，零依赖，dryRun 模式不触网）
// 运行: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 用临时目录隔离（不碰真实文章库/草稿目录）；env 必须在动态 import 前设置
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-publish-test-'))
process.env.CROSSPOST_ARTICLES_DIR = path.join(TMP, 'articles')
process.env.CROSSPOST_DRAFTS_DIR = path.join(TMP, 'drafts')

// 沙箱 config.json（2026-09-20）：样式启用/禁用、平台清单、autoPush 全部由本文件钉住。
// 此前这些用例读**真实 config.json**，于是"使用者在 Console 里改一次设置"就会让它们
// 变红或静默跳过——把环境差异伪装成代码回归，与本文件 v2.05 记的教训同源。
const SANDBOX_CONFIG = path.join(TMP, 'config.json')
fs.writeFileSync(
  SANDBOX_CONFIG,
  JSON.stringify({
    autoPush: { enabled: false, includeWechat: false },
    // 含 weixin/douyin：『勾选语义（模型 A）』用例的前置就是这两个在默认列表里
    platforms: { default: ['weixin', 'douyin', 'zhihu', 'csdn', 'juejin'] },
    styles: {
      disabled: ['custom-minimal-gold'],
      // 项目级「每个栏目自己的默认样式」。用 `weekly`（自定义栏目）与 `tips`（内建栏目、
      // 故意配一个不存在的样式）来验证解析链与回退，不干扰其它用例走过的栏目。
      perSlot: { weekly: 'custom-mianpro', tips: 'no-such-style' },
    },
    notify: { enabled: false, channel: 'off' },
    coverSettings: { defaultTemplate: 'nebula', coverEnabled: true },
  }),
)
process.env.CROSSPOST_CONFIG = SANDBOX_CONFIG

const { runPublishArticle, findDraftFile, buildPublishNotifyCopy } = await import(
  new URL('../src/commands/publish.mjs', import.meta.url).href
)
// 某些断言依赖本机 custom 样式目录 / config.json 禁选配置；CI 干净环境无这些则跳过
// （本地开发仍验证，避免跨机器误报）。listStyleNames 来自 core dist。
const { listStyleNames } = await import('@crosspost/core')
const availableStyles = listStyleNames()
// autoPush 状态来自上面的沙箱 config（恒为关闭）；仍保留守卫：万一有人把沙箱配置改了，用例要跳过而不是误判。
const { readConfig } = await import('../src/config-cache.mjs')
const AUTO_PUSH_ON = !!(readConfig().autoPush && readConfig().autoPush.enabled)
const hasMianPro = availableStyles.includes('custom-mianpro')
// 2026-09-18（v2.05）修复：下面「禁用样式回退」用例的正确前置是
// **custom-minimal-gold 处于禁选态**，而不是 hasMianPro（那只是"本机有自定义样式目录"）。
// 此前用 hasMianPro 作守卫，导致在干净 clone（无 config.json 禁选配置）上该用例
// 会执行并失败——把"环境差异"伪装成"代码回归"。这里按真实前置条件守卫。
const styleIsDisabled = (id) => {
  const disabled = (readConfig().styles && readConfig().styles.disabled) || []
  return Array.isArray(disabled) && disabled.includes(id)
}
const hasDisabledGold = styleIsDisabled('custom-minimal-gold')
// 2026-09-12（模型 A）：勾选 = 推送 + 检查，但 weixin/douyin 的勾选只表示"纳入登录检查"。
// 该断言取决于真实 config.json 是否已把这两个 id 勾进来（bridge 启动时会一次性补齐）。
const defaultHasCheckOnly = (() => {
  const def = (readConfig().platforms && readConfig().platforms.default) || []
  return def.includes('weixin') && def.includes('douyin')
})()

function writeDraft(name, { title = '测试文章', risk, score, body = '正文内容\n\n第二段。' } = {}) {
  const dir = process.env.CROSSPOST_DRAFTS_DIR
  fs.mkdirSync(dir, { recursive: true })
  const fm = [
    'title: ' + title,
    ...(risk ? [`risk: ${risk}`] : []),
    ...(score !== undefined ? [`score: ${score}`] : []),
  ]
  const file = path.join(dir, name)
  fs.writeFileSync(file, `---\n${fm.join('\n')}\n---\n\n${body}`)
  return file
}

test('dryRun 发布返回完整结构且不触网', async () => {
  const file = writeDraft('2026-08-28-hotspot-dryrun-ok.md', { title: '干跑测试', score: 90 })
  const r = await runPublishArticle({
    file,
    dryRun: true,
    wechat: false,
    platforms: [],
    allowDouyin: true,
  })
  assert.equal(r.error, undefined, JSON.stringify(r.error))
  assert.equal(r.dryRun, true)
  assert.equal(r.id, '2026-08-28-hotspot-dryrun-ok')
  assert.equal(r.title, '干跑测试')
  assert.equal(r.slot, 'hotspot')
  assert.equal(r.wechat.status, 'skip') // dryRun 不发微信
  assert.deepEqual(r.platforms, {}) // dryRun 不执行平台分发
  assert.equal(r.record.wechat.status, 'skip') // 记录也落初始值（2026-08-28 修复）
})

test('正文含内部残留文字禁止发布', async () => {
  const file = writeDraft('2026-08-28-hotspot-dryrun-leak.md', {
    body: '正文\n\n备选标题：备用1\n',
  })
  const r = await runPublishArticle({ file, dryRun: true, wechat: false, platforms: [] })
  assert.match(r.error, /备选标题/)
})

test('frontmatter risk 命中一票否决（不发布并留存 risk 目录）', async () => {
  const file = writeDraft('2026-08-28-hotspot-dryrun-risk.md', { title: '广告风险', risk: 'ad' })
  const r = await runPublishArticle({ file, dryRun: true, wechat: false, platforms: [] })
  assert.equal(r.risk, 'ad')
  assert.match(r.error, /高风险/)
  assert.ok(r.retained) // 已移入留存
  assert.equal(fs.existsSync(file), false) // 原文件已移走
  const riskDir = path.join(process.env.CROSSPOST_DRAFTS_DIR, 'risk')
  assert.ok(fs.existsSync(path.join(riskDir, '2026-08-28-hotspot-dryrun-risk.md')))
})

test('douyin 铁律：自动链路永不推 douyin（allowDouyin=false 时从目标平台剔除）', async () => {
  const file = writeDraft('2026-08-28-hotspot-dryrun-dy.md', { title: '抖音测试', score: 85 })
  // dryRun 不执行平台分发，用 targetPlatforms（过滤后的目标列表）验证
  const r = await runPublishArticle({
    file,
    dryRun: true,
    wechat: false,
    platforms: ['douyin', 'zhihu'],
    allowDouyin: false,
  })
  assert.ok(!r.targetPlatforms.includes('douyin'))
  assert.ok(r.targetPlatforms.includes('zhihu'))
  // allowDouyin=true 时保留 douyin
  const r2 = await runPublishArticle({
    file,
    dryRun: true,
    wechat: false,
    platforms: ['douyin'],
    allowDouyin: true,
  })
  assert.ok(r2.targetPlatforms.includes('douyin'))
})

test(
  '勾选语义（模型 A）：config 默认列表里的 weixin/douyin 不进通用派发，显式传参不受影响',
  { skip: !defaultHasCheckOnly && 'config.platforms.default 尚未包含 weixin/douyin（未跑迁移）' },
  async () => {
    const file = writeDraft('2026-09-12-tips-checkonly.md', { title: '仅检查平台', score: 85 })
    // 不传 platforms → 走 config.platforms.default 分支
    const r = await runPublishArticle({ file, dryRun: true, wechat: false })
    assert.ok(!r.targetPlatforms.includes('weixin'), 'weixin 勾选只表示纳入检查，不进通用派发')
    assert.ok(!r.targetPlatforms.includes('douyin'), 'douyin 已有铁律，本就不进通用派发')
    assert.ok(r.targetPlatforms.length > 0, '其余勾选平台照常派发')
    // 显式传参（MCP/CLI 路径）→ 派发规则完全不动：weixin 不被"仅检查"过滤掉
    const r2 = await runPublishArticle({
      file,
      dryRun: true,
      wechat: false,
      platforms: ['weixin'],
    })
    assert.deepEqual(r2.targetPlatforms, ['weixin'], '显式指定 weixin 时仍按原规则派发')
  },
)

test(
  '真发布路径（非 dryRun）登录预检后 platforms 重新赋值不抛 Assignment（2026-08-28 回归）',
  async () => {
    // 覆盖 B1 拆分回归：platforms 误入 const 解构，prefilterAuthed 后赋值必抛
    // "Assignment to constant variable"（既有测试全 dryRun 走不到该行）。
    // 用假平台 id：预检网络失败兜底 → syncArticle 失败但绝不抛 Assignment 类错误。
    const file = writeDraft('2026-08-28-hotspot-realpath.md', { title: '真发布路径', score: 88 })
    const r = await runPublishArticle({
      file,
      dryRun: false,
      wechat: false,
      platforms: ['__nope__'],
      allowDouyin: true,
    })
    const serialized = JSON.stringify(r)
    assert.ok(
      !serialized.includes('Assignment to constant variable'),
      '不应抛 const 赋值错误: ' + serialized.slice(0, 200),
    )
    // 平台必然失败（假 id），但不允许出现 const 赋值错误
    assert.ok(r.error === undefined || typeof r.error === 'string')
  },
  { timeout: 60000 },
)

test('findDraftFile 命中子目录草稿（归档兜底定位）', () => {
  const dir = process.env.CROSSPOST_DRAFTS_DIR
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'archive', '2026-09-03-arc-find.md'),
    '---\ntitle: 查找测试\n---\n内容\n',
  )
  const found = findDraftFile('2026-09-03-arc-find')
  assert.ok(found, '归档子目录草稿可按 id 定位')
  assert.ok(found.file.endsWith(path.join('archive', '2026-09-03-arc-find.md')))
  // 顶层文件仍正常命中
  const top = writeDraft('2026-08-28-hotspot-findtop.md', { title: '顶层查找' })
  const f2 = findDraftFile('2026-08-28-hotspot-findtop')
  assert.equal(f2.file, top)
  // 非法 id 拒绝（路径穿越防护）
  assert.throws(() => findDraftFile('../evil'))
})

// ── 样式回退（2026-08-29：AI 选样式必须依据 enabled 列表，未知/禁用均回退 swiss） ──

test('未知样式回退：style=minimal（不存在）→ swiss + styleWarning', async () => {
  const file = writeDraft('2026-08-29-morning-style-unknown.md', { title: '未知样式测试' })
  const r = await runPublishArticle({
    file,
    style: 'minimal',
    dryRun: true,
    wechat: false,
    platforms: [],
  })
  assert.equal(r.error, undefined, JSON.stringify(r.error))
  assert.equal(r.style, 'swiss', '未知样式回退 swiss')
  assert.match(r.styleWarning || '', /样式不存在: minimal/, 'warning 说明原因')
})

test(
  '禁用样式回退：style=custom-minimal-gold（config 已禁用）→ swiss + styleWarning',
  {
    skip: !hasDisabledGold
      ? 'config.json 未把 custom-minimal-gold 列入 styles.disabled（干净环境）'
      : false,
  },
  async () => {
    const file = writeDraft('2026-08-29-morning-style-disabled.md', { title: '禁用样式测试' })
    const r = await runPublishArticle({
      file,
      style: 'custom-minimal-gold',
      dryRun: true,
      wechat: false,
      platforms: [],
    })
    assert.equal(r.error, undefined, JSON.stringify(r.error))
    assert.equal(r.style, 'swiss', '禁用样式回退 swiss')
    assert.match(r.styleWarning || '', /样式已禁用: custom-minimal-gold/, 'warning 说明原因')
  },
)

test('合法启用样式保留：style=custom-mianpro → 原样使用', { skip: !hasMianPro }, async () => {
  const file = writeDraft('2026-08-29-morning-style-valid.md', { title: '合法样式测试' })
  const r = await runPublishArticle({
    file,
    style: 'custom-mianpro',
    dryRun: true,
    wechat: false,
    platforms: [],
  })
  assert.equal(r.error, undefined, JSON.stringify(r.error))
  assert.equal(r.style, 'custom-mianpro', '启用样式原样保留')
  assert.equal(r.styleWarning, null, '无 warning')
})

// ── styles.perSlot（项目级「每栏默认样式」）：它是"不同写作流水线不同风格"的旋钮 ──
test(
  'styles.perSlot 生效：自定义栏目 weekly → 配的样式；未配的栏目仍走内建映射',
  { skip: !hasMianPro },
  async () => {
    // ① 自定义栏目（内建映射里没有它）——只有 perSlot 能给出默认样式
    const f1 = writeDraft('2026-08-29-weekly-per-slot.md', { title: '自定义栏目默认样式' })
    const r1 = await runPublishArticle({ file: f1, dryRun: true, wechat: false, platforms: [] })
    assert.equal(r1.error, undefined, JSON.stringify(r1.error))
    assert.equal(r1.style, 'custom-mianpro', 'perSlot 配的样式要用上（此前会落到 swiss）')
    assert.equal(r1.styleWarning, null, '合法样式不该产生 warning')

    // ② 没配 perSlot 的内建栏目 —— 内建映射照旧生效（这条守着"加了一层不影响老行为"）
    const f2 = writeDraft('2026-08-29-hotspot-builtin-map.md', { title: '内建栏目映射' })
    const r2 = await runPublishArticle({ file: f2, dryRun: true, wechat: false, platforms: [] })
    assert.equal(r2.style, 'cyber', 'hotspot 仍走内建的 SLOT_STYLE_MAP')

    // ③ perSlot 配了不存在的样式 —— 回退 swiss + warning（与 req/style 传错时同一条回退路径）
    const f3 = writeDraft('2026-08-29-tips-per-slot-missing.md', {
      title: 'perSlot 指向不存在的样式',
    })
    const r3 = await runPublishArticle({ file: f3, dryRun: true, wechat: false, platforms: [] })
    assert.equal(r3.style, 'swiss', '不存在的样式必须回退 swiss')
    assert.match(r3.styleWarning || '', /样式不存在: no-such-style/, 'warning 要指出是哪个样式')
  },
)

test(
  '未传 style 走栏目兜底：morning → custom-mianpro（已与启用列表对齐）',
  { skip: !hasMianPro },
  async () => {
    const file = writeDraft('2026-08-29-morning-style-default.md', { title: '栏目兜底测试' })
    const r = await runPublishArticle({ file, dryRun: true, wechat: false, platforms: [] })
    assert.equal(r.error, undefined, JSON.stringify(r.error))
    assert.equal(r.style, 'custom-mianpro', 'morning 兜底为启用样式')
  },
)

// ── autoPush（生成后自动推送）守卫：关闭时仅落草稿，不派发平台/微信，但 targetPlatforms 仍上报 ──
// 2026-09-09 回归：pushEnabled 关闭曾清空 platforms，导致平台解析/抖音铁律测试误判。
// 此处锁定「关闭=仅落草稿」行为：status=draft、history=draft-only、不派发；平台纯逻辑仍上报。
test(
  'autoPush 关闭：非 dryRun 仅落草稿（draft-only），不派发平台/微信，targetPlatforms 仍上报',
  { skip: AUTO_PUSH_ON },
  async () => {
    const file = writeDraft('2026-08-29-hotspot-draftonly.md', { title: '关闭自动推送', score: 86 })
    const r = await runPublishArticle({
      file,
      dryRun: false,
      wechat: false,
      platforms: ['zhihu', 'csdn'],
      notify: false,
    })
    assert.equal(r.error, undefined, JSON.stringify(r.error))
    assert.equal(r.status, 'draft', '关闭自动推送 → status=draft')
    // 仍上报目标平台（解析+剔抖音后的纯逻辑），而非被清空
    assert.deepEqual(r.targetPlatforms, ['zhihu', 'csdn'])
    // 不派发任何平台
    assert.deepEqual(r.platforms, {})
    // 微信不发送（恒草稿，且被 autoPush 门控）
    assert.equal(r.wechat.status, 'skip')
    // history 记 draft-only
    const last = r.record.history[r.record.history.length - 1]
    assert.equal(last.action, 'draft-only')
    assert.match(last.note || '', /未开启自动推送/)
    assert.equal(r.record.status, 'draft')
    // 2026-09-12：派发回执 + 来源留痕（AI 用它如实汇报"本次没推"）
    assert.equal(r.dispatch, 'skipped')
    assert.equal(r.autoPushEnabled, false)
    assert.match(r.skipReason || '', /生成后自动推送已关闭/)
    assert.equal(r.origin, 'manual')
    assert.equal(last.origin, 'manual')
  },
)

// ── 2026-09-12 回归：定时链路（origin=scheduled）恒受开关门控 ──
// 09-11 的 MCP 层硬编码 manual:true 让定时链路（run_once.sh → dsh → MCP）绕过了开关，
// 09-12 08:10/08:30 两轮在开关关闭时真推了微信 + 8 平台。此用例锁定：即便上游误传 manual:true，
// scheduled 来源也必须被服务端冻结（status=draft、dispatch=skipped、无平台/微信派发）。
test(
  '定时链路（origin=scheduled）+ manual:true ⇒ 仍不派发（服务端冻结豁免）',
  { skip: AUTO_PUSH_ON },
  async () => {
    const file = writeDraft('2026-09-12-morning-scheduled-guard.md', {
      title: '定时链路守卫',
      score: 86,
    })
    const r = await runPublishArticle({
      file,
      dryRun: false,
      platforms: [],
      wechat: false,
      notify: false,
      origin: 'scheduled',
      manual: true,
    })
    assert.equal(r.error, undefined, JSON.stringify(r.error))
    assert.equal(r.origin, 'scheduled')
    assert.equal(r.status, 'draft')
    assert.equal(r.dispatch, 'skipped')
    assert.equal(r.autoPushEnabled, false)
    assert.match(r.skipReason || '', /定时链路/)
    assert.deepEqual(r.platforms, {})
    assert.equal(r.wechat.status, 'skip')
    const last = r.record.history[r.record.history.length - 1]
    assert.equal(last.action, 'draft-only')
    assert.equal(last.origin, 'scheduled')
    assert.match(last.note || '', /未开启自动推送/)
  },
)

// ── 2026-09-12：一键生成链路（origin=draft-only）禁止发布 ──
test('一键生成链路（origin=draft-only）⇒ 拒绝发布，不写任何派发历史', async () => {
  const file = writeDraft('2026-09-12-morning-draftonly-guard.md', {
    title: '一键生成拒绝发布',
    score: 86,
  })
  const r = await runPublishArticle({
    file,
    dryRun: false,
    platforms: ['zhihu'],
    wechat: true,
    notify: false,
    origin: 'draft-only',
  })
  assert.equal(r.draftOnly, true)
  assert.equal(r.origin, 'draft-only')
  assert.match(r.error || '', /一键生成/)
})

// ── 2026-09-12：人工来源（交互式会话/CLI/Console）豁免语义保持（09-11 的修复不被回归） ──
test(
  '人工来源 + manual:true ⇒ 开关关闭仍派发（Console/交互式语义不变）',
  { skip: AUTO_PUSH_ON },
  async () => {
    const file = writeDraft('2026-09-12-hotspot-manual-exempt.md', {
      title: '人工豁免',
      score: 86,
    })
    const r = await runPublishArticle({
      file,
      dryRun: false,
      platforms: [],
      wechat: false,
      notify: false,
      origin: 'manual',
      manual: true,
    })
    assert.equal(r.error, undefined, JSON.stringify(r.error))
    assert.equal(r.dispatch, 'dispatched')
    assert.equal(r.autoPushEnabled, false)
    assert.equal(r.origin, 'manual')
    const last = r.record.history[r.record.history.length - 1]
    assert.equal(last.action, 'publish')
    assert.equal(last.origin, 'manual')
  },
)

// ── 2026-09-12：通知文案（纯函数，不真发通知）────────────────────────────
// 用户期望：开关关闭时收到的是「生成文章未推送」的通知，而不是「已推送 8 个平台」。
test('通知文案：定时链路未派发 ⇒ 明确「未推送 + 来源=定时」，绝不出现"已推送"', () => {
  const c = buildPublishNotifyCopy({
    title: '降价60%却更贵了',
    slot: 'hotspot',
    style: 'custom-modern',
    score: 90,
    wechatStatus: 'skip',
    okCount: 0,
    total: 0,
    dispatchEnabled: false,
    origin: 'scheduled',
    wechatSkippedByReq: false,
    file: '/tmp/drafts/2026-09-12-hotspot-x.md',
    template: {},
  })
  assert.match(c.summaryLine, /微信=未推送（未开启自动推送）/)
  assert.match(c.summaryLine, /来源=定时/)
  assert.match(c.footer, /未开启自动推送,已生成草稿待人工推送/)
  assert.match(c.footer, /可在 Console 手动挑选平台推送/)
  assert.doesNotMatch(c.footer, /已推送公众号草稿箱/)
  assert.doesNotMatch(c.footer, /个平台草稿箱/)
  assert.equal(c.vars.wechat, '未推送')
  assert.equal(c.vars.failReason, '未开启自动推送')
})

test('通知文案：人工派发成功 ⇒ 链接口径与"已推送"陈述保持', () => {
  const c = buildPublishNotifyCopy({
    title: 'T',
    slot: 'manual',
    style: 'swiss',
    score: null,
    wechatStatus: 'ok',
    okCount: 2,
    total: 3,
    failList: ['toutiao'],
    dispatchEnabled: true,
    origin: 'manual',
    wechatSkippedByReq: false,
    file: '/tmp/x.md',
    template: {},
  })
  assert.match(c.footer, /失败平台: toutiao/)
  assert.match(c.footer, /已推送公众号草稿箱 \+ 2 个平台草稿箱/)
  assert.equal(c.vars.score, '无')
  assert.equal(c.vars.origin, '人工')
})

test('通知文案：人工但未勾选微信 ⇒ 陈述事实，不谎称已推公众号', () => {
  const c = buildPublishNotifyCopy({
    title: 'T',
    slot: 'hotspot',
    style: 'swiss',
    score: 88,
    wechatStatus: 'skip',
    okCount: 1,
    total: 1,
    dispatchEnabled: true,
    origin: 'manual',
    wechatSkippedByReq: true,
    file: '/tmp/x.md',
    template: {},
  })
  assert.match(c.footer, /未勾选微信；已推送 1 个平台草稿箱/)
  assert.equal(c.vars.wechat, '未勾选')
})

test('通知文案：自定义模板优先（config.notify.template）', () => {
  const c = buildPublishNotifyCopy({
    title: 'T',
    slot: 'morning',
    style: 'swiss',
    score: 90,
    wechatStatus: 'skip',
    okCount: 0,
    total: 0,
    dispatchEnabled: false,
    origin: 'scheduled',
    wechatSkippedByReq: false,
    file: '/tmp/x.md',
    template: { summary: '自定义摘要 {origin}', footer: '自定义尾行' },
  })
  assert.equal(c.summaryLine, '自定义摘要 定时')
  assert.equal(c.footer, '自定义尾行')
})
