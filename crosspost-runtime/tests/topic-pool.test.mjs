// 选题库（topic-pool.json）唯一写入实现的契约测试
//
// 这个模块存在的理由就是"写入规则只能有一份"，所以这里把规则逐条钉住：
//   ① 行形状校验：少字段（整体左移）/ 类型错 / 取值域错 一律**拒绝整次写入**；
//   ② 合并规则：按 (date,slot,keyword) upsert、同日同 slot 其它条目一个不少、
//      generated 不降级、articleId 只增不清、reason 追加而非覆盖；
//   ③ 写锁：拿不到锁按既有取舍降级（但如实回报），陈旧锁能被强拆；
//   ④ 原子写：保留原有顶层键、写完回读、失败不落盘。
//
// 为什么这么在意：项目侧曾因为"少给一个字段"把分数写进 title、原因写进 status，
// 静默写坏 4 条（下游 Console 渲染与引擎统计一起错）。契约在这里，就该在这里守。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  POOL_STATUSES,
  lockDirFor,
  parseFlags,
  planUpsert,
  readPoolFile,
  resolvePoolTarget,
  upsertRows,
  validateRows,
} from '../src/topic-pool.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.resolve(__dirname, '..')
const REPO = path.resolve(RUNTIME, '..')
const CLI = path.join(RUNTIME, 'src', 'cli.mjs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crosspost-topic-pool-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

let seq = 0
/** 造一个独立的选题库文件（每个用例互不干扰） */
function makePool(rows = [], extra = { _note: '引擎文案' }) {
  const file = path.join(tmp, `pool-${++seq}.json`)
  fs.writeFileSync(file, JSON.stringify({ ...extra, topics: rows }, null, 2))
  return file
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const row = (over = {}) => ({
  id: '2026-10-04-hotspot-01',
  date: '2026-10-04',
  slot: 'hotspot',
  keyword: '旧关键词',
  title: '',
  topicScore: 70,
  rank: 1,
  status: 'adopted',
  reason: '',
  articleId: null,
  createdAt: '2026-10-04T00:00:00.000Z',
  ...over,
})

// ─────────────────────────── ① 行形状校验 ───────────────────────────

test('校验：字段少给（整体左移）必须被拒——这是当初写坏数据的形状', () => {
  const problems = validateRows([['某关键词', 92, 'rejected', '传播性略低']])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /有 4 个字段/)
  assert.match(problems[0], /少给 title 会让后面所有字段左移/)
})

test('校验：类型与取值域逐条判死', () => {
  const cases = [
    [[['kw', 92, 'rejected', 'x', '']], /title 必须是字符串/],
    [[['kw', '', '92', 'rejected', '']], /score 必须是 0-100 的数字/],
    [[['kw', '', 101, 'rejected', '']], /score 必须是 0-100 的数字/],
    [[['kw', '', 92, 'dropped', '']], /status 必须是 adopted\/generated\/rejected/],
    [[['', '', 92, 'rejected', '']], /keyword 必须是非空字符串/],
    [[['kw', '', 92, 'rejected', 5]], /reason 必须是字符串/],
    [[['kw', '', 92, 'rejected', '', 7]], /articleId 必须是字符串或省略/],
    [[['a', '', 1, 'adopted', '', 'id', 'x']], /有 7 个字段/],
    [[['a', '', 1, 'adopted', '', 'id', null, 'x']], /有 8 个字段/],
    [[['kw', '', 92, 'rejected', '']], null],
    [[['kw', null, null, 'rejected', '']], null],
    [[['kw', '标题', 0, 'adopted', '', 'a.md']], null],
  ]
  for (const [rows, expect] of cases) {
    const problems = validateRows(rows)
    if (expect === null) assert.deepEqual(problems, [], `应通过：${JSON.stringify(rows)}`)
    else assert.match(problems.join('\n'), expect, `应被拒：${JSON.stringify(rows)}`)
  }
  assert.deepEqual(validateRows([]), ['候选数组不能为空'])
  assert.match(validateRows('nope').join(''), /候选必须是数组/)
  assert.deepEqual(POOL_STATUSES, ['adopted', 'generated', 'rejected'])
})

test('校验：对象行（按字段名）与数组行等价，且字段名写错会被判死', () => {
  const asArray = ['某候选', '标题', 88, 'rejected', '时效陈旧']
  const asObject = {
    keyword: '某候选',
    title: '标题',
    score: 88,
    status: 'rejected',
    reason: '时效陈旧',
  }
  assert.deepEqual(validateRows([asArray]), [])
  assert.deepEqual(validateRows([asObject]), [])

  // 对象行：title 同样**不能省**（省了就是"我忘了给"，不是"没有标题"）
  const missing = validateRows([{ keyword: 'k', score: 88, status: 'rejected', reason: 'r' }])
  assert.equal(missing.length, 1)
  assert.match(missing[0], /缺 title/)

  // 字段名写错：对象行不会"整体左移"，但会被静默忽略成默认值——所以必须判死
  const typo = validateRows([
    { keyword: 'k', title: '', score: 88, status: 'rejected', reason: 'r', score2: 50 },
  ])
  assert.equal(typo.length, 1)
  assert.match(typo[0], /未知字段 "score2"/)

  // 既有行原样传回来也要能用：topicScore 是 score 的别名，其余既有键允许
  assert.deepEqual(
    validateRows([
      {
        id: 'x',
        date: '2026-10-04',
        slot: 'hotspot',
        rank: 1,
        createdAt: '2026-10-04T00:00:00.000Z',
        keyword: 'k',
        title: '',
        topicScore: 70,
        status: 'adopted',
        reason: '',
        articleId: null,
      },
    ]),
    [],
  )
})

test('合并：对象行与数组行写出的结果完全一致', () => {
  const planArray = planUpsert({
    date: '2026-10-04',
    slot: 'hotspot',
    topics: [],
    rows: [['同一候选', '', 88, 'rejected', '时效陈旧']],
  })
  const planObject = planUpsert({
    date: '2026-10-04',
    slot: 'hotspot',
    topics: [],
    rows: [{ keyword: '同一候选', title: '', score: 88, status: 'rejected', reason: '时效陈旧' }],
  })
  assert.deepEqual(planObject.topics, planArray.topics, '两种行形态必须归一到同一结果')
  assert.equal(planObject.added.length, 1)
})

// ─────────────────────────── ② 合并规则 ───────────────────────────

test('合并：新增按入参顺序定 rank/id，更新就地改而不动别的条目', () => {
  const existing = row({ id: '2026-10-04-hotspot-01', keyword: '老候选', topicScore: 50 })
  const plan = planUpsert({
    date: '2026-10-04',
    slot: 'hotspot',
    topics: [existing],
    rows: [
      ['老候选', '补上的标题', 80, 'rejected', '时效陈旧'],
      ['新候选', '标题二', 95, 'adopted', ''],
    ],
  })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.added, ['新候选'])
  assert.deepEqual(plan.updated, ['老候选'])
  assert.equal(plan.before, 1)
  assert.equal(plan.after, 2, '同日同 slot 只增不减')
  assert.equal(existing.topicScore, 80, '命中的条目就地更新分数')
  assert.equal(existing.rank, 1)
  const fresh = plan.topics.find((t) => t.keyword === '新候选')
  assert.equal(fresh.id, '2026-10-04-hotspot-02', 'id 按传入顺序编号')
  assert.equal(fresh.status, 'adopted')
  assert.equal(fresh.createdAt, '2026-10-04T00:00:00.000Z')
})

test('合并：generated 不降级 / articleId 只增不清 / reason 追加不覆盖', () => {
  const existing = row({
    status: 'generated',
    articleId: '2026-10-04-hotspot-01',
    reason: '旧原因',
  })
  planUpsert({
    date: '2026-10-04',
    slot: 'hotspot',
    topics: [existing],
    rows: [['旧关键词', '', 66, 'rejected', '新原因']],
  })
  assert.equal(existing.status, 'generated', '已生成的条目不因后续轮次被降级')
  assert.equal(existing.articleId, '2026-10-04-hotspot-01', 'articleId 只增不清')
  assert.equal(existing.reason, '新原因；旧原因', 'reason 追加（同条覆盖、不同条拼接）')
  assert.equal(existing.topicScore, 66)
})

test('合并：manual 分支只写自己那一条（id=manual-NN、status=generated）', () => {
  const existing = [
    row({ id: '2026-10-04-hotspot-manual-01', keyword: '人工一', status: 'generated' }),
    row({ id: '2026-10-04-hotspot-02', keyword: '定时轮候选', status: 'rejected', reason: 'x' }),
  ]
  const plan = planUpsert({
    date: '2026-10-04',
    slot: 'hotspot',
    topics: existing,
    manual: true,
    articleId: '2026-10-04-hotspot-manual-02',
    rows: [['人工二', '标题', 70, 'generated', '人工指定采用']],
  })
  assert.equal(plan.before, 2)
  assert.equal(plan.after, 3, 'manual 也不许清掉同日同 slot 的其它条目')
  const fresh = plan.topics.find((t) => t.keyword === '人工二')
  assert.equal(fresh.id, '2026-10-04-hotspot-manual-02', '序号接着已有的 manual 条目往下排')
  assert.equal(fresh.status, 'generated')
  assert.equal(fresh.articleId, '2026-10-04-hotspot-manual-02')
})

// ─────────────────────────── ③④ 落盘 + 锁 ───────────────────────────

test('落盘：形状不合格时一个字节都不写；合格时保留原有顶层键', () => {
  const file = makePool([row({ keyword: '既有' })], { _note: '引擎文案', custom: 'keep-me' })
  const before = sha(file)

  const bad = upsertRows({
    poolFile: file,
    date: '2026-10-04',
    slot: 'hotspot',
    rows: [['某关键词', 92, 'rejected', '传播性略低']],
  })
  assert.equal(bad.ok, false)
  assert.match(bad.problems.join(''), /有 4 个字段/)
  assert.equal(sha(file), before, '拒绝写入时文件必须逐字节不变')

  const good = upsertRows({
    poolFile: file,
    date: '2026-10-04',
    slot: 'hotspot',
    rows: [['新候选', '', 88, 'rejected', '时效陈旧']],
  })
  assert.equal(good.ok, true, JSON.stringify(good))
  assert.equal(good.before, 1)
  assert.equal(good.after, 2)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(after._note, '引擎文案', '原有 _note 保留')
  assert.equal(after.custom, 'keep-me', '其它顶层键保留')
  assert.equal(after.topics.length, 2)
  assert.equal(
    after.topics.find((t) => t.keyword === '既有').topicScore,
    70,
    '同一 slot 的既有条目没被动',
  )
})

test('落盘：文件缺失/损坏时不写坏东西', () => {
  const missing = path.join(tmp, `nope-${++seq}.json`)
  const r1 = upsertRows({
    poolFile: missing,
    date: 'd',
    slot: 's',
    rows: [['k', '', 1, 'adopted', '']],
  })
  assert.equal(r1.ok, true)
  assert.equal(JSON.parse(fs.readFileSync(missing, 'utf8')).topics.length, 1)

  const broken = path.join(tmp, `broken-${++seq}.json`)
  fs.writeFileSync(broken, '{ not json')
  const r2 = upsertRows({
    poolFile: broken,
    date: 'd',
    slot: 's',
    rows: [['k', '', 1, 'adopted', '']],
  })
  assert.equal(r2.ok, false)
  assert.match(r2.error, /已损坏/)
  assert.equal(fs.readFileSync(broken, 'utf8'), '{ not json', '损坏的文件不该被覆盖')
})

test('锁：拿不到锁按既有取舍降级，但如实回报 locked=false', () => {
  const file = makePool([])
  const dir = lockDirFor(file)
  assert.equal(
    dir,
    path.join(path.dirname(file), '.topic-pool.lock'),
    '锁与选题库同目录（与引擎既有约定一致）',
  )
  fs.mkdirSync(dir)
  try {
    const r = upsertRows({
      poolFile: file,
      date: 'd',
      slot: 's',
      rows: [['k', '', 1, 'adopted', '']],
      lockOpts: { timeoutMs: 30 },
    })
    assert.equal(r.ok, true, '降级仍要写（丢一次写入远好过卡死生成链路）')
    assert.equal(r.locked, false)
    assert.equal(r.degraded, true)
    assert.match(r.lockReason, /降级为无锁写入/)
  } finally {
    try {
      fs.rmdirSync(dir)
    } catch {
      /* 已被回收 */
    }
  }
})

test('锁：陈旧锁（持有者被 kill）会被强拆，不留下永久卡死', () => {
  const file = makePool([])
  const dir = lockDirFor(file)
  fs.mkdirSync(dir)
  const old = new Date(Date.now() - 10 * 60 * 1000)
  fs.utimesSync(dir, old, old)
  const r = upsertRows({
    poolFile: file,
    date: 'd',
    slot: 's',
    rows: [['k', '', 1, 'adopted', '']],
    lockOpts: { timeoutMs: 500, staleMs: 1000 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.locked, true, '陈旧锁应被回收后拿到')
  assert.equal(fs.existsSync(dir), false, '写完必须释放锁')
})

// ─────────────────────────── 参数与目标解析 ───────────────────────────

test('parseFlags：--k=v / --k v 取值；声明的开关不吃后面的 token', () => {
  assert.deepEqual(parseFlags(['--date=2026-10-04', '--slot', 'hotspot']), {
    _: [],
    date: '2026-10-04',
    slot: 'hotspot',
  })
  // 开关必须声明：否则 `--manual 某候选` 会把 manual 解成字符串（看着像开了、其实没开）
  assert.deepEqual(parseFlags(['--manual', 'x'], { booleans: ['manual'] }), {
    _: ['x'],
    manual: true,
  })
  assert.equal(parseFlags(['--manual', 'x']).manual, 'x', '未声明就是普通取值参数')
  assert.equal(parseFlags(['--dry-run=false'], { booleans: ['dry-run'] })['dry-run'], false)
})

test('目标解析：--pool 明确给了就用它；说不清项目时拒绝而不是猜', () => {
  const file = makePool([])
  assert.deepEqual(resolvePoolTarget({ pool: file }), {
    poolFile: file,
    project: null,
    source: 'explicit',
  })

  // 无 --pool、无项目上下文、cwd 不在任何项目里、且沙箱里没有唯一项目 → 必须报错
  const box = fs.mkdtempSync(path.join(tmp, 'box-'))
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { resolvePoolTarget } from ${JSON.stringify(path.join(RUNTIME, 'src', 'topic-pool.mjs'))}
       process.stdout.write(JSON.stringify(resolvePoolTarget()))`,
    ],
    {
      cwd: box,
      encoding: 'utf8',
      env: {
        ...process.env,
        CROSSPOST_CONFIG: path.join(box, 'config.json'),
        CROSSPOST_PATHS: path.join(box, 'paths.json'),
        CROSSPOST_LOCAL_ROOT: path.join(box, 'local'),
        CROSSPOST_PROJECTS_DIRS: path.join(box, 'projects'),
        CROSSPOST_TOPIC_POOL: path.join(box, 'pool.json'),
      },
    },
  )
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.match(out.error, /无法确定要写哪个项目的选题库/)
  assert.match(out.error, /--project=<id>|--pool=<file>/)
})

// ─────────────────────────── CLI 面（项目侧就转发这里）───────────────────────────

function runCli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60000,
  })
}

test('CLI：validate 只校验不落盘；不合格退出码 1', () => {
  const okRun = runCli('topicPoolValidate', '--json=[["kw","",92,"rejected",""]]')
  assert.equal(okRun.status, 0, okRun.stderr)
  assert.equal(JSON.parse(okRun.stdout).ok, true)

  const badRun = runCli('topicPoolValidate', '--json=[["kw",92,"rejected","原因"]]')
  assert.equal(badRun.status, 1, '形状不合格必须是非零退出码（流水线据此停住）')
  const body = JSON.parse(badRun.stdout)
  assert.match(body.error, /拒绝写入/)
  assert.match(body.error, /少给 title 会让后面所有字段左移/)
})

test('CLI：upsert 落盘 / dry-run 不落盘 / show 只读', () => {
  const file = makePool([])
  const before = sha(file)

  const dry = runCli(
    'topicPoolUpsert',
    `--pool=${file}`,
    '--date=2026-10-04',
    '--slot=hotspot',
    '--json=[["dry 候选","",88,"rejected","原因"]]',
    '--dry-run',
  )
  assert.equal(dry.status, 0, dry.stderr)
  assert.equal(JSON.parse(dry.stdout).dryRun, true)
  assert.equal(sha(file), before, 'dry-run 不许落盘')

  const real = runCli(
    'topicPoolUpsert',
    `--pool=${file}`,
    '--date=2026-10-04',
    '--slot=hotspot',
    '--json=[["真候选","标题",93,"adopted",""]]',
  )
  assert.equal(real.status, 0, real.stderr)
  const body = JSON.parse(real.stdout)
  assert.equal(body.ok, true)
  assert.deepEqual(body.added, ['真候选'])
  assert.equal(body.after, 1)

  const show = runCli('topicPoolShow', `--pool=${file}`)
  assert.equal(show.status, 0, show.stderr)
  const info = JSON.parse(show.stdout)
  assert.equal(info.total, 1)
  assert.deepEqual(info.counts, { adopted: 1, generated: 0, rejected: 0, other: 0 })
  assert.equal(info.latestDate, '2026-10-04')
  assert.deepEqual(info.bySlot, { hotspot: 1 })
  assert.ok(readPoolFile(file).topics.length === 1)
})
