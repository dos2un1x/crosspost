#!/usr/bin/env node
/**
 * 按草稿写文章记录（2026-10-10）：把"解析草稿 → 建/取记录 → 打补丁 → 追加一条 history → 落盘"
 * 这套动作收成一处，供两条**非发布**的记账路径共用：
 *   · `aiDetect --record`（AI 检测门禁行）
 *   · `recordWriting`（编辑决策 / 独立审稿）
 *
 * 为什么非要共用：`aiDetect` 的唯一写入者本来是发布器（`publish_article` 的入参），
 * 而 draft-only 链路（一键生成、定时生成）从不调发布器 —— 判定、决策、审稿这三样都**产出了却没落点**，
 * Console 抽屉里那三张卡永远是空的。两条路径的纪律必须一致，否则又是一处"各写各的"：
 *   · **按草稿归属纠正域**：文件属于哪个项目就写哪个项目的簿记（`projectOwningDraftFile`），
 *     与派发口的 v2.106 修法一致；
 *   · **不因记账失败丢掉结果**：写盘出错只回 `recordError` + 修法提示（常见成因：调用方在文件沙箱里）；
 *   · **保留已有字段**：只打这次真要改的键，别把上一次的快照抹掉。
 * dos2un1x / CrossPost · https://github.com/dos2un1x/crosspost
 */
import { ensureDraftRecord, parseDraftFile, upsertRecord } from './articles.mjs'
import { currentProject, projectOwningDraftFile, withProject } from './project-context.mjs'

/** 记账失败时的统一提示（两条路径共用同一句，排查时不必猜是哪条路丢的） */
export const RECORD_WRITE_HINT =
  '判定/快照本身照常可用；记录没写进去（常见成因：调用方在文件沙箱里写不了引擎簿记）。' +
  '改用 MCP 工具（记录由引擎进程写），或事后跑 repairRecords --apply 对账。'

/**
 * 把一条补丁写进该草稿的文章记录。
 *
 * @param {{file:string, patch?:object, entry:object}} args
 *   `patch` 是主字段（如 `{aiDetect}` / `{decision, review}`），`entry` 是要追加的 history 条目
 *   （`action` 必填，`at` 缺省取现在）。
 * @returns {{recorded?:object, recordError?:string, recordHint?:string}}
 */
export function writeDraftRecord({ file, patch = {}, entry }) {
  if (!file) return { recordError: '缺少草稿文件', recordHint: RECORD_WRITE_HINT }
  const at = entry && entry.at ? entry.at : new Date().toISOString()
  const item = { ...entry, at }
  const write = () => {
    const parsed = parseDraftFile(file)
    if (!parsed) throw new Error(`草稿解析失败: ${file}`)
    const rec = ensureDraftRecord(parsed)
    // 只打这次真要改的键：别让"记 AI 检测"顺手清掉上一次的决策/审稿
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === '') continue
      rec[k] = v
    }
    rec.history = Array.isArray(rec.history) ? rec.history : []
    rec.history.push(item)
    upsertRecord(rec)
    return { id: parsed.id, file }
  }
  const owner = projectOwningDraftFile(file)
  const derived = owner && owner !== currentProject() ? owner : ''
  try {
    const written = derived ? withProject(derived, write) : write()
    return {
      recorded: { ...written, at, action: item.action, ...(derived ? { project: derived } : {}) },
    }
  } catch (e) {
    return { recordError: String((e && e.message) || e), recordHint: RECORD_WRITE_HINT }
  }
}
