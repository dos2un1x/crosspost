/**
 * 平台 HTML 预处理（2026-08-27）
 *
 * 等效浏览器 content script 的 preprocessConfig 语义，Node 侧（jsdom）实现：
 *  - section → div（convertSectionToDiv）
 *  - 单子容器解包（unwrapSingleChildContainers：容器仅一个子元素 → 提升子元素）
 *  - 清空空容器（removeEmptyDivs / removeNestedEmptyContainers）
 *  - 压缩空白文本节点（removeEmptyLines）
 *
 * 解决知乎等平台把深层 `<section>` 嵌套解析为大量空 block（无用空行）的问题。
 */
import { JSDOM } from 'jsdom'

export function preprocessHtml(html: string): string {
  const dom = new JSDOM(html)
  const doc = dom.window.document
  const body = doc.body

  /** 递归：section→div + 单子容器解包（自底向上） */
  function unwrapSingleChild(el: Element): boolean {
    let changed = false
    for (const child of Array.from(el.children)) {
      if (unwrapSingleChild(child)) changed = true
    }
    if (el.tagName === 'SECTION' || el.tagName === 'DIV') {
      // section → div
      if (el.tagName === 'SECTION') {
        const d = doc.createElement('div')
        for (const attr of Array.from(el.attributes)) d.setAttribute(attr.name, attr.value)
        while (el.firstChild) d.appendChild(el.firstChild)
        el.replaceWith(d)
        el = d
        changed = true
      }
      // 单子容器解包：仅一个子元素（过滤纯空白文本）→ 提升子元素
      const kids = Array.from(el.childNodes).filter(
        (n) => !(n.nodeType === 3 && !(n.textContent || '').trim()),
      )
      if (kids.length === 1 && kids[0].nodeType === 1) {
        el.replaceWith(kids[0])
        changed = true
      }
    }
    return changed
  }
  unwrapSingleChild(body)

  // 移除空容器（无子元素且无有效文本）。单次自底向上遍历：querySelectorAll 返回静态文档序列表，
  // 子节点被移除后其父容器若变成空，会因位于列表更后面而在同一次遍历中被检查到——无需反复整树重扫。
  // 原实现每次移除后 querySelectorAll('div,section') 重查全树，嵌套空容器时 O(passes × DOM)。
  for (const el of Array.from(body.querySelectorAll('div,section') as NodeListOf<Element>)) {
    const hasContent = Array.from(el.childNodes).some(
      (n) => n.nodeType === 1 || (n.nodeType === 3 && (n.textContent || '').trim()),
    )
    if (!hasContent) el.remove()
  }

  // 压缩空白文本节点
  const walker = doc.createTreeWalker(body, dom.window.NodeFilter.SHOW_TEXT)
  const toRemove: Text[] = []
  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    if (!(node.textContent || '').trim()) toRemove.push(node)
  }
  for (const t of toRemove) t.remove()

  return dom.serialize()
}
