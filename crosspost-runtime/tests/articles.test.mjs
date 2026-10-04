// articles.mjs 单元测试（node:test，零依赖）
// 运行: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 用临时目录隔离（不碰真实文章库/草稿目录）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-articles-test-'))
process.env.CROSSPOST_ARTICLES_DIR = path.join(TMP, 'articles')
process.env.CROSSPOST_DRAFTS_DIR = path.join(TMP, 'drafts')
// v2.40：引擎脚本一律隔离 historyDir —— deleteDraft / deleteTopic 会经
// pushHumanFeedback() 写 history/editorial-memory.json，漏隔离就会污染真实部署
// （实测发生过：真实人工反馈被测试假条目整段挤出 30 条上限）。
process.env.CROSSPOST_HISTORY_DIR = path.join(TMP, 'history')

const mod = await import(new URL('../src/articles.mjs', import.meta.url).href)
const {
  parseDraftFile,
  ensureDraftRecord,
  scanAndList,
  getRecord,
  upsertRecord,
  appendHistory,
  removeRecord,
  getDraftsDir,
} = mod
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url).href)
const cls = await import(new URL('../src/commands/classify.mjs', import.meta.url).href)
const {
  investmentRegex,
  investmentSignalConfig,
  DEFAULT_INVESTMENT_STRONG,
  DEFAULT_INVESTMENT_WEAK,
} = cls

function writeDraft(name, title) {
  const dir = getDraftsDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, `---\ntitle: ${title}\n---\n\n正文内容\n`)
  return file
}

test('parseDraftFile 解析文件名与 frontmatter', () => {
  const file = writeDraft('2026-08-19-hotspot-dsh-record.md', '1.5 小时 2.2 万星!')
  const p = parseDraftFile(file)
  assert.equal(p.id, '2026-08-19-hotspot-dsh-record')
  assert.equal(p.slot, 'hotspot')
  assert.equal(p.date, '2026-08-19')
  assert.equal(p.title, '1.5 小时 2.2 万星!')
  // 栏目 id 由项目声明：文件名里**任何合法栏目段**都保留，不再有内建白名单
  const f2 = writeDraft('2026-08-19-newsletter-weekly.md', '自定义栏目')
  assert.equal(parseDraftFile(f2).slot, 'newsletter')
  assert.equal(parseDraftFile(f2).topic, 'weekly')
  // 栏目段取**第一段**（非贪婪）：内建栏目后面带横线的主题不会被误当成栏目名
  const f3 = writeDraft('2026-08-19-hotspot-some-topic.md', '带横线的主题')
  assert.equal(parseDraftFile(f3).slot, 'hotspot')
  assert.equal(parseDraftFile(f3).topic, 'some-topic')
  // 不合形态的栏目段 → manual（大写与下划线都不行：写进文件名的名字必须能解析回来）
  assert.equal(parseDraftFile(writeDraft('2026-08-19-Weekly-x.md', '大写')).slot, 'manual')
  assert.equal(parseDraftFile(writeDraft('2026-08-19-my_slot-x.md', '下划线')).slot, 'manual')
})

test('ensureDraftRecord 登记新草稿为 draft', () => {
  const file = writeDraft('2026-08-19-noon-test.md', '深度测试')
  const rec = ensureDraftRecord(parseDraftFile(file))
  assert.equal(rec.status, 'draft')
  assert.equal(rec.wechat.status, 'none')
  assert.deepEqual(rec.platforms, {})
  // 幂等：再次调用返回同一条
  const rec2 = ensureDraftRecord(parseDraftFile(file))
  assert.equal(rec2.id, rec.id)
  assert.equal(getRecord(rec.id).id, rec.id)
})

test('scanAndList 扫描合并并倒序', () => {
  writeDraft('2026-08-18-morning-a.md', '早报')
  writeDraft('2026-08-20-evening-b.md', '晚间')
  const list = scanAndList()
  assert.ok(list.length >= 3)
  assert.equal(list[0].id, '2026-08-20-evening-b') // 倒序
  // 全部有 hasFile
  assert.ok(list.every((r) => r.hasFile === true))
})

test('upsertRecord / appendHistory 原子写与历史追加', () => {
  const rec = {
    id: '2026-08-19-noon-test',
    title: '深度测试',
    file: path.join(getDraftsDir(), '2026-08-19-noon-test.md'),
    slot: 'noon',
    date: '2026-08-19',
    style: 'editorial',
    status: 'published',
    wechat: { status: 'ok', mediaId: 'M1' },
    platforms: { zhihu: { status: 'ok', postUrl: 'https://x' } },
    notify: { status: 'ok' },
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  upsertRecord(rec)
  const saved = appendHistory(
    '2026-08-19-noon-test',
    { action: 'republish', wechat: 'ok', platforms: '1/1', failed: [] },
    { status: 'published' },
  )
  assert.equal(saved.history.length, 1)
  assert.equal(saved.history[0].action, 'republish')
  assert.equal(saved.status, 'published')
  assert.equal(getRecord('2026-08-19-noon-test').wechat.mediaId, 'M1')
})

test('removeRecord 删除记录', () => {
  assert.equal(removeRecord('2026-08-19-noon-test'), true)
  assert.equal(getRecord('2026-08-19-noon-test'), null)
  assert.equal(removeRecord('no-such-id'), false)
})

test('getDraftsDir 优先取 env 配置', () => {
  assert.equal(getDraftsDir(), process.env.CROSSPOST_DRAFTS_DIR)
})

// ── 质量评分（2026-08-20） ──────────────────────────

test('parseDraftFile 提取 frontmatter score/score_dims', () => {
  const file = path.join(getDraftsDir(), '2026-08-20-tips-score.md')
  fs.mkdirSync(getDraftsDir(), { recursive: true })
  fs.writeFileSync(
    file,
    '---\ntitle: 评分测试\nscore: 82\nscore_dims: {"标题钩子":13,"开头":12}\n---\n正文\n',
  )
  const p = parseDraftFile(file)
  assert.equal(p.score, 82)
  assert.deepEqual(p.scoreDims, { 标题钩子: 13, 开头: 12 })
  // 无 score 的旧草稿 → null
  const old = path.join(getDraftsDir(), '2026-08-19-tips-old.md')
  fs.writeFileSync(old, '---\ntitle: 旧文章\n---\n正文\n')
  assert.equal(parseDraftFile(old).score, null)
})

test('scanAndList 跳过 rejected/ 子目录（低分放弃草稿不显示）', () => {
  const dir = getDraftsDir()
  fs.mkdirSync(path.join(dir, 'rejected'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'rejected', '2026-08-20-noon-low.md'),
    '---\ntitle: 低分放弃\nscore: 55\n---\n内容\n',
  )
  const list = scanAndList()
  assert.ok(!list.some((r) => r.id === '2026-08-20-noon-low'))
})

test('publishArticle 记录 frontmatter score；req.score 显式优先；无 score 不写字段', () => {
  const dir = path.join(TMP, 'cli-articles')
  fs.mkdirSync(dir, { recursive: true })
  const env = { ...process.env, CROSSPOST_ARTICLES_DIR: dir, CROSSPOST_DRAFTS_DIR: getDraftsDir() }
  const run = (req) => {
    const reqFile = path.join(TMP, 'req-' + Math.random() + '.json')
    fs.writeFileSync(reqFile, JSON.stringify(req))
    const r = spawnSync(process.execPath, [CLI, 'publishArticle', reqFile], {
      env,
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  }
  // 1) frontmatter score 自动提取
  const f1 = path.join(getDraftsDir(), '2026-08-20-tips-score.md') // 已有 score:82
  const out1 = run({ file: f1, dryRun: true, wechat: false, platforms: [], notify: false })
  assert.equal(out1.score, 82)
  let rec = JSON.parse(fs.readFileSync(path.join(dir, '2026-08-20-tips-score.json'), 'utf8'))
  assert.equal(rec.score.total, 82)
  assert.deepEqual(rec.score.dims, { 标题钩子: 13, 开头: 12 })
  assert.ok(rec.score.at)
  // 2) req.score 显式优先（覆盖 frontmatter）
  const out2 = run({
    file: f1,
    dryRun: true,
    wechat: false,
    platforms: [],
    notify: false,
    score: 75,
    rewrites: 1,
  })
  assert.equal(out2.score, 75)
  rec = JSON.parse(fs.readFileSync(path.join(dir, '2026-08-20-tips-score.json'), 'utf8'))
  assert.equal(rec.score.total, 75)
  assert.equal(rec.score.rewrites, 1)
  // 3) 无 score 的草稿不写 score 字段（兼容手动/历史）
  const f2 = path.join(getDraftsDir(), '2026-08-19-tips-old.md')
  const out3 = run({ file: f2, dryRun: true, wechat: false, platforms: [], notify: false })
  assert.equal(out3.score, null)
  rec = JSON.parse(fs.readFileSync(path.join(dir, '2026-08-19-tips-old.json'), 'utf8'))
  assert.equal(rec.score, undefined)
})

// ── 默认推送平台解析（2026-08-20） ────────────────────

test('publishArticle 平台解析：显式 > config 默认 > 兜底；空数组不推；douyin 剔除', () => {
  const dir = path.join(TMP, 'cli-articles2')
  fs.mkdirSync(dir, { recursive: true })
  // 平台清单来自**沙箱 config**（2026-09-20）：此前读真实 config.json，使用者一改默认平台
  // （例如只留 weixin/douyin），"默认派发列表非空"就会因为"这两个都不进通用派发"而失败
  // ——那是环境差异，不是代码回归。
  const cfg = path.join(TMP, 'config-platforms.json')
  fs.writeFileSync(
    cfg,
    JSON.stringify({ platforms: { default: ['zhihu', 'csdn', 'douyin', 'weixin'] } }),
  )
  const env = {
    ...process.env,
    CROSSPOST_CONFIG: cfg,
    CROSSPOST_ARTICLES_DIR: dir,
    CROSSPOST_DRAFTS_DIR: getDraftsDir(),
  }
  const run = (req) => {
    const reqFile = path.join(TMP, 'req-pf-' + Math.random() + '.json')
    fs.writeFileSync(reqFile, JSON.stringify(req))
    const r = spawnSync(process.execPath, [CLI, 'publishArticle', reqFile], {
      env,
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  }
  const f = path.join(getDraftsDir(), '2026-08-19-tips-old.md') // 无 score 草稿

  // 1) 不传 platforms → config.json platforms.default（= 上面那份沙箱配置）
  run({ file: f, dryRun: true, wechat: false, platforms: [], notify: false })
  // 显式传空数组 = 不推平台；不传字段 → 取配置
  const outDefault = run({ file: f, dryRun: true, wechat: false, notify: false })
  assert.deepEqual(
    outDefault.targetPlatforms,
    ['zhihu', 'csdn'],
    '默认派发 = 配置里的 zhihu/csdn（douyin 与 weixin 都不进通用派发）',
  )

  // 2) 显式 platforms 覆盖配置
  const out2 = run({
    file: f,
    dryRun: true,
    wechat: false,
    notify: false,
    platforms: ['zhihu', 'csdn'],
  })
  assert.deepEqual(out2.targetPlatforms, ['zhihu', 'csdn'])

  // 3) 显式空数组 = 不推平台（仅微信）
  const out3 = run({ file: f, dryRun: true, wechat: false, notify: false, platforms: [] })
  assert.deepEqual(out3.targetPlatforms, [])

  // 4) douyin 显式传入也被剔除（铁律：自动链路永不推 douyin）
  const out4 = run({
    file: f,
    dryRun: true,
    wechat: false,
    notify: false,
    platforms: ['zhihu', 'douyin'],
  })
  assert.deepEqual(out4.targetPlatforms, ['zhihu'])

  // 5) 去重
  const out5 = run({
    file: f,
    dryRun: true,
    wechat: false,
    notify: false,
    platforms: ['zhihu', 'zhihu', 'csdn'],
  })
  assert.deepEqual(out5.targetPlatforms, ['zhihu', 'csdn'])
})

// ── 风险属性过滤 + 留存库（2026-08-20） ────────────────

function runCliCmd(args, envExtra = {}) {
  const env = {
    ...process.env,
    CROSSPOST_ARTICLES_DIR: path.join(TMP, 'cli-risk'),
    CROSSPOST_DRAFTS_DIR: getDraftsDir(),
    ...envExtra,
  }
  fs.mkdirSync(path.join(TMP, 'cli-risk'), { recursive: true })
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('parseDraftFile 提取 frontmatter risk', () => {
  const dir = getDraftsDir()
  const w = (name, fm) => {
    fs.writeFileSync(path.join(dir, name), `---\n${fm}\n---\n正文\n`)
  }
  w('2026-08-20-noon-riskad.md', 'title: 广告测试\nrisk: ad')
  assert.equal(parseDraftFile(path.join(dir, '2026-08-20-noon-riskad.md')).risk, 'ad')
  w('2026-08-20-noon-riskboth.md', 'title: 组合\nrisk: ad,investment')
  assert.equal(parseDraftFile(path.join(dir, '2026-08-20-noon-riskboth.md')).risk, 'ad,investment')
  w('2026-08-20-noon-risknone.md', 'title: 正常\nrisk: none')
  assert.equal(parseDraftFile(path.join(dir, '2026-08-20-noon-risknone.md')).risk, null)
  w('2026-08-20-noon-risklack.md', 'title: 缺失')
  assert.equal(parseDraftFile(path.join(dir, '2026-08-20-noon-risklack.md')).risk, null)
})

test('publishArticle：risk 命中拒绝发布并自动留存 risk/；force 放行；record.risk 合并', () => {
  const dir = getDraftsDir()
  const env = { CROSSPOST_ARTICLES_DIR: path.join(TMP, 'cli-risk'), CROSSPOST_DRAFTS_DIR: dir }
  const run = (req) => {
    const reqFile = path.join(TMP, 'req-rk-' + Math.random() + '.json')
    fs.writeFileSync(reqFile, JSON.stringify(req))
    const r = spawnSync(process.execPath, [CLI, 'publishArticle', reqFile], {
      env,
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  }
  // 1) risk=ad 无 force → 拒绝 + 文件自动移入 risk/
  const f1 = path.join(dir, '2026-08-20-noon-riskad.md')
  const out1 = run({ file: f1, wechat: false, platforms: [], notify: false })
  assert.ok(out1.error && out1.error.includes('高风险类型'))
  assert.ok(!fs.existsSync(f1), '原文件已移走')
  assert.ok(fs.existsSync(path.join(dir, 'risk', '2026-08-20-noon-riskad.md')), '已留存至 risk/')
  // 2) force 放行（dryRun 不真推）→ 正常，record.risk 保留原值
  const f2 = path.join(dir, '2026-08-20-noon-riskboth.md')
  const out2 = run({
    file: f2,
    force: true,
    dryRun: true,
    wechat: false,
    platforms: [],
    notify: false,
  })
  assert.equal(out2.ok, true)
  assert.equal(out2.risk, 'ad,investment')
  let rec = JSON.parse(
    fs.readFileSync(path.join(env.CROSSPOST_ARTICLES_DIR, '2026-08-20-noon-riskboth.json'), 'utf8'),
  )
  assert.equal(rec.risk, 'ad,investment')
  // 3) 无 risk 草稿 → 正常，record.risk = unclassified（无 prev）
  const f3 = path.join(dir, '2026-08-20-noon-risklack.md')
  const out3 = run({ file: f3, dryRun: true, wechat: false, platforms: [], notify: false })
  assert.equal(out3.ok, true)
  rec = JSON.parse(
    fs.readFileSync(path.join(env.CROSSPOST_ARTICLES_DIR, '2026-08-20-noon-risklack.json'), 'utf8'),
  )
  assert.equal(rec.risk, 'unclassified')
  // 4) 合并：已有 prev.risk 的草稿再发布（无 risk）→ 保留 prev.risk
  run({ file: f3, dryRun: true, wechat: false, platforms: [], notify: false })
  rec = JSON.parse(
    fs.readFileSync(path.join(env.CROSSPOST_ARTICLES_DIR, '2026-08-20-noon-risklack.json'), 'utf8'),
  )
  assert.equal(rec.risk, 'unclassified')
})

test('scanAndList 跳过 risk/ 子目录（自动链路隔离）', () => {
  const dir = getDraftsDir()
  fs.mkdirSync(path.join(dir, 'risk'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'risk', '2026-08-20-noon-riskad.md'),
    '---\ntitle: 广告\nrisk: ad\n---\n内容',
  )
  const list = scanAndList()
  assert.ok(!list.some((r) => r.id === '2026-08-20-noon-riskad'))
})

test('listRetained 列出留存目录文章并解析 frontmatter', () => {
  const dir = getDraftsDir()
  fs.mkdirSync(path.join(dir, 'rejected'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'risk'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'rejected', '2026-08-20-noon-low.md'),
    '---\ntitle: 低分留存\nscore: 55\n---\n内容',
  )
  fs.writeFileSync(
    path.join(dir, 'risk', '2026-08-20-noon-riskad.md'),
    '---\ntitle: 广告留存\nrisk: ad\n---\n内容',
  )
  const out = runCliCmd(['listRetained'])
  const items = out.retained || []
  const low = items.find((r) => r.id === '2026-08-20-noon-low')
  const risk = items.find((r) => r.id === '2026-08-20-noon-riskad')
  assert.ok(low && low.dir === 'rejected' && low.score === 55)
  assert.ok(risk && risk.dir === 'risk' && risk.risk === 'ad')
})

test('retainedAction：restore 移回 drafts/、delete 删除、未知操作报错（2026-08-21 起移除 publish）', () => {
  const dir = getDraftsDir()
  const env = { CROSSPOST_ARTICLES_DIR: path.join(TMP, 'cli-risk'), CROSSPOST_DRAFTS_DIR: dir }
  // restore
  fs.writeFileSync(
    path.join(dir, 'risk', '2026-08-20-noon-riskad.md'),
    '---\ntitle: 广告留存\nrisk: ad\n---\n内容',
  )
  let out = runCliCmd(['retainedAction', path.join(TMP, 'ra-restore.json')], env)
  // 用文件方式传 req
  out = (() => {
    const reqFile = path.join(TMP, 'ra-restore.json')
    fs.writeFileSync(reqFile, JSON.stringify({ id: '2026-08-20-noon-riskad', action: 'restore' }))
    const r = spawnSync(process.execPath, [CLI, 'retainedAction', reqFile], {
      env,
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  })()
  assert.equal(out.ok, true)
  assert.ok(fs.existsSync(path.join(dir, '2026-08-20-noon-riskad.md')), '已移回 drafts/')
  assert.ok(!fs.existsSync(path.join(dir, 'risk', '2026-08-20-noon-riskad.md')))
  // 移回后 frontmatter risk 已被清除（防自动链路再次拦截）
  const text = fs.readFileSync(path.join(dir, '2026-08-20-noon-riskad.md'), 'utf8')
  assert.ok(!/^\s*risk\s*:/m.test(text), 'restore 后 risk 行已清除')
  // delete
  fs.writeFileSync(
    path.join(dir, 'risk', '2026-08-20-noon-riskdel.md'),
    '---\ntitle: 删除\nrisk: pr\n---\n内容',
  )
  const reqFile = path.join(TMP, 'ra-del.json')
  fs.writeFileSync(reqFile, JSON.stringify({ id: '2026-08-20-noon-riskdel', action: 'delete' }))
  const rd = spawnSync(process.execPath, [CLI, 'retainedAction', reqFile], {
    env,
    encoding: 'utf8',
  })
  const outDel = JSON.parse(rd.stdout)
  assert.equal(outDel.ok, true)
  assert.ok(!fs.existsSync(path.join(dir, 'risk', '2026-08-20-noon-riskdel.md')))
  // publish 已移除（2026-08-21）：返回未知操作错误，文件保留
  fs.writeFileSync(
    path.join(dir, 'risk', '2026-08-20-noon-riskpub.md'),
    '---\ntitle: 放行\nrisk: investment\n---\n内容',
  )
  const reqFile2 = path.join(TMP, 'ra-pub.json')
  fs.writeFileSync(
    reqFile2,
    JSON.stringify({
      id: '2026-08-20-noon-riskpub',
      action: 'publish',
      dryRun: true,
      wechat: false,
      platforms: [],
      notify: false,
    }),
  )
  const rp = spawnSync(process.execPath, [CLI, 'retainedAction', reqFile2], {
    env,
    encoding: 'utf8',
  })
  const outPub = JSON.parse(rp.stdout)
  assert.ok(outPub.error, '未知操作报错')
  assert.ok(outPub.error.includes('未知操作'))
  assert.ok(fs.existsSync(path.join(dir, 'risk', '2026-08-20-noon-riskpub.md')), '文件未被移动')
})

test('classifyArticles 规则初筛历史文章风险分类（零 token）', () => {
  const dir = getDraftsDir()
  fs.mkdirSync(dir, { recursive: true })
  // 历史草稿（标题命中关键词）
  fs.writeFileSync(
    path.join(dir, '2026-08-18-noon-inv.md'),
    '---\ntitle: 某公司股价暴涨,还能炒吗\n---\n内容',
  )
  fs.writeFileSync(
    path.join(dir, '2026-08-18-noon-invfact.md'),
    '---\ntitle: 某公司完成 10 亿融资\n---\n内容',
  )
  fs.writeFileSync(
    path.join(dir, '2026-08-18-tips-ad.md'),
    '---\ntitle: 实测推荐这款神器\n---\n内容',
  )
  fs.writeFileSync(
    path.join(dir, '2026-08-18-noon-normal.md'),
    '---\ntitle: 技术解析文章\n---\n内容',
  )
  const env = { CROSSPOST_ARTICLES_DIR: path.join(TMP, 'cli-risk'), CROSSPOST_DRAFTS_DIR: dir }
  const out = (() => {
    const r = spawnSync(process.execPath, [CLI, 'classifyArticles'], { env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  })()
  assert.equal(out.ok, true)
  const recInv = JSON.parse(
    fs.readFileSync(path.join(env.CROSSPOST_ARTICLES_DIR, '2026-08-18-noon-inv.json'), 'utf8'),
  )
  assert.equal(recInv.risk, 'investment')
  assert.equal(recInv.riskSource, 'rule')
  const recInvFact = JSON.parse(
    fs.readFileSync(path.join(env.CROSSPOST_ARTICLES_DIR, '2026-08-18-noon-invfact.json'), 'utf8'),
  )
  assert.equal(recInvFact.risk, 'none')
  const recAd = JSON.parse(
    fs.readFileSync(path.join(env.CROSSPOST_ARTICLES_DIR, '2026-08-18-tips-ad.json'), 'utf8'),
  )
  assert.equal(recAd.risk, 'ad')
  const recN = JSON.parse(
    fs.readFileSync(path.join(env.CROSSPOST_ARTICLES_DIR, '2026-08-18-noon-normal.json'), 'utf8'),
  )
  assert.equal(recN.risk, 'none')
})

test('investmentRegex/investmentSignalConfig 读 config 强弱词（可覆盖 + 默认兜底）', () => {
  // 自定义配置：强词命中、弱词不命中
  const re = investmentRegex({
    scoring: { investment: { strong: ['测试词', '妖股'], weak: ['弱词'] } },
  })
  assert.ok(re.test('含测试词'), '自定义强词应命中')
  assert.ok(re.test('妖股 涨停'), '自定义强词应命中')
  assert.ok(!re.test('含弱词'), '弱词不触发（仅语义）')
  // 默认兜底：无配置时匹配默认强词、不匹配弱词
  const reD = investmentRegex({})
  assert.ok(reD.test('行情 暴涨'), '默认强词应命中')
  assert.ok(!reD.test('估值 融资'), '默认弱词不触发')
  // 空强词数组 → 回退默认（避免正则永不命中）
  const reE = investmentRegex({ scoring: { investment: { strong: [], weak: [] } } })
  assert.ok(reE.test('荐股'), '空强词应回退默认')
  // 结构校验
  const sig = investmentSignalConfig({ scoring: { investment: { strong: ['a'], weak: ['b'] } } })
  assert.deepEqual(sig, { strong: ['a'], weak: ['b'] })
  assert.ok(Array.isArray(DEFAULT_INVESTMENT_STRONG) && DEFAULT_INVESTMENT_STRONG.includes('暴涨'))
  assert.ok(Array.isArray(DEFAULT_INVESTMENT_WEAK) && DEFAULT_INVESTMENT_WEAK.includes('估值'))
})

test('setArticleRisk 人工改分类', () => {
  const env = {
    CROSSPOST_ARTICLES_DIR: path.join(TMP, 'cli-risk'),
    CROSSPOST_DRAFTS_DIR: getDraftsDir(),
  }
  const out = (() => {
    const r = spawnSync(process.execPath, [CLI, 'setArticleRisk', '2026-08-18-noon-normal', 'pr'], {
      env,
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  })()
  assert.equal(out.ok, true)
  const rec = JSON.parse(
    fs.readFileSync(path.join(env.CROSSPOST_ARTICLES_DIR, '2026-08-18-noon-normal.json'), 'utf8'),
  )
  assert.equal(rec.risk, 'pr')
  assert.equal(rec.riskSource, 'manual')
})
