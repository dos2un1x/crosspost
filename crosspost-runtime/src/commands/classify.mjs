/**
 * 风险分类域（2026-09-01 从 cli.mjs 迁出）：历史文章规则初筛风险分类（零 token）。
 * 复用 risk-rules.mjs 的人名规则 + 内联 ad/investment/pr 规则。
 * 2026-09-02 investment 强弱词表接入 config.json → scoring.investment（可热改，readConfig mtime 缓存）。
 */
import fs from 'node:fs'
import { scanAndList, upsertRecord } from '../articles.mjs'
import { splitFrontmatter } from './publish.mjs'
import { readConfig } from '../config-cache.mjs'
import { PERSON_NAME_RE, PERSON_REF, PERSON_CTX, PERSON_BAD_WORD } from './risk-rules.mjs'

/** 默认强投资煽动词（config 缺失/空数组时兜底） */
export const DEFAULT_INVESTMENT_STRONG = [
  '炒',
  '行情',
  '暴涨',
  '暴跌',
  '荐股',
  '抄底',
  '梭哈',
  '翻倍',
  '稳赚',
  '割韭菜',
  '财富密码',
  '涨停',
  '牛股',
  '看涨',
  '收益率',
]
/** 默认弱业务词（仅语义说明，不参与正则；config 缺失/空数组时兜底） */
export const DEFAULT_INVESTMENT_WEAK = [
  '估值',
  '融资',
  '股价',
  '上市',
  '并购',
  '收购',
  '市值',
  '资本',
  '财报',
  '业绩',
  '募资',
  '营收',
  '净利',
  'IPO',
  '卖身',
]

function escapeRe(w) {
  return String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 解析 investment 信号配置：config.scoring.investment.{strong,weak}，空/非法回退默认 */
export function investmentSignalConfig(cfg) {
  const inv = (cfg && cfg.scoring && cfg.scoring.investment) || {}
  return {
    strong:
      Array.isArray(inv.strong) && inv.strong.length
        ? inv.strong.map(String)
        : DEFAULT_INVESTMENT_STRONG,
    weak:
      Array.isArray(inv.weak) && inv.weak.length ? inv.weak.map(String) : DEFAULT_INVESTMENT_WEAK,
  }
}

/** 由强煽动词构建 investment 正则（逐词转义后 join '|'；weak 不参与） */
export function investmentRegex(cfg) {
  const { strong } = investmentSignalConfig(cfg)
  return new RegExp(strong.map(escapeRe).join('|'))
}

export function classifyArticles() {
  const RISK_RULES = [
    // investment 词表来自 config.json → scoring.investment（强煽动词命中；weak 不触发）
    { type: 'investment', re: investmentRegex(readConfig()) },
    { type: 'pr', re: /凭什么|输给了|赢?了.*对手|吊打|碾压.*友商|全球第[一二三]|称霸/ },
    { type: 'ad', re: /实测推荐|入手|值得买|闭眼入|无脑抄|保姆级|神器|一键搞定/ },
    { type: 'person', re: PERSON_NAME_RE },
  ]
  const byType = { investment: 0, pr: 0, ad: 0, person: 0, none: 0 }
  let classified = 0
  for (const rec of scanAndList()) {
    let text = rec.title || ''
    if (rec.hasFile && rec.file && fs.existsSync(rec.file)) {
      text += '\n' + splitFrontmatter(fs.readFileSync(rec.file, 'utf8')).slice(0, 2000)
    }
    let personHit = false
    let personHint = false
    {
      const re = PERSON_NAME_RE
      const refRe = new RegExp('(?:' + PERSON_REF + '|' + PERSON_CTX + ')$')
      let scan = text
      let pm
      while ((pm = re.exec(scan))) {
        if (pm[1]) {
          personHit = true
          break
        }
        const pName = pm[0].replace(refRe, '')
        if (!PERSON_BAD_WORD.test(pName)) personHint = true
        scan = scan.slice(pm.index + pm[0].length)
        re.lastIndex = 0
      }
    }
    if (personHit) {
      if (rec.risk !== 'person' || !rec.riskSource) {
        rec.risk = 'person'
        rec.riskSource = 'rule'
        classified += 1
      }
      byType.person += 1
      upsertRecord(rec)
      continue
    }
    if (personHint) {
      rec.risk = 'unclassified'
      rec.riskHint = 'person'
      rec.riskSource = 'rule-hint'
      byType.unclassified = (byType.unclassified || 0) + 1
      upsertRecord(rec)
      continue
    }
    if (rec.risk === 'person' && rec.riskSource === 'rule') {
      delete rec.risk
      delete rec.riskSource
    }
    if (rec.riskHint === 'person' && rec.riskSource === 'rule-hint') {
      delete rec.riskHint
      delete rec.riskSource
      delete rec.risk
    }
    const cur = rec.risk
    if (cur && cur !== 'unclassified' && cur !== 'none') continue
    if (cur === 'none' && rec.riskSource) continue
    let hit = null
    for (const rule of RISK_RULES) {
      if (rule.type !== 'person' && rule.re.test(text)) {
        hit = rule.type
        break
      }
    }
    rec.risk = hit || 'none'
    rec.riskSource = 'rule'
    byType[rec.risk] += 1
    classified += 1
    upsertRecord(rec)
  }
  return { ok: true, classified, byType }
}
