# CodeMirror 6 vendored bundle

`codemirror.mjs` 是 CodeMirror 6 Markdown 编辑器的**单文件 ESM 打包产物**（约 532 KB，minified），
供没有构建步骤的 Console（`bridge/console/`，纯静态 ES Module）直接 import：

```js
const { createEditor } = await import('../vendor/codemirror.mjs')
```

它导出的 `createEditor({ parent, value, onChange, onSelection, readonly })` 返回
`{ view, getValue, setValue, scrollToPos, getScrollTopPos, setScrollPos, getScrollRatio,
getCursorLine, getSelection, focus, destroy }`。Console 目前用到 `view` / `getValue` /
`setValue` / `scrollToPos` / `getScrollTopPos` / `getCursorLine`（见
`bridge/console/modules/views-editor.mjs` 与 `editor-sync.mjs`）。

## 为什么必须是 vendored

Console 由桥以 `/console/` 静态托管，**没有打包器**；且桥下发的 CSP 是
`script-src 'self'`（见 `bridge/run-bridge.mjs` 的 CSP 常量），**禁止 CDN 与 inline import-map**。
所以 CodeMirror 只能同源 vendored 到本目录，用相对路径 import。

## 许可与归属（MIT）

CodeMirror 6 由 **Marijn Haverbeke** 等人开发，以 **MIT License** 发布。
上游：<https://codemirror.net/> · <https://github.com/codemirror/view>

打包进本文件的是以下六个包（各自均为 MIT）：

`@codemirror/view` · `@codemirror/state` · `@codemirror/commands` ·
`@codemirror/lang-markdown` · `@codemirror/language` · `@codemirror/search`

```
MIT License

Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 如何重建

```bash
# 在任意临时目录装依赖（版本请按下面「版本」一节固定）
mkdir -p /tmp/cm-bundle && cd /tmp/cm-bundle
npm init -y
npm install @codemirror/view @codemirror/state @codemirror/commands \
  @codemirror/lang-markdown @codemirror/language @codemirror/search

# entry.js：导出 createEditor，与 views-editor.mjs 的用法一一对应
cat > entry.js <<'EOF'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, dropCursor, rectangularSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'

export function createEditor({ parent, value = '', onChange, onSelection, readonly = false }) {
  let onChangeCb = onChange
  let onSelectionCb = onSelection
  const view = new EditorView({
    parent, doc: value,
    extensions: [
      lineNumbers(), history(), drawSelection(), dropCursor(), rectangularSelection(),
      highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && onChangeCb) onChangeCb(u.state.doc.toString())
        if (u.selectionSet && onSelectionCb) onSelectionCb(u.state.selection.main)
      }),
      EditorState.readOnly.of(readonly),
      EditorView.lineWrapping,
    ],
  })
  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (v) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } }),
    scrollToPos: (pos, y = 'start') => { view.dispatch({ effects: EditorView.scrollIntoView(pos, { y }) }); return true },
    getScrollTopPos: () => { const b = view.elementAtHeight(view.scrollDOM.scrollTop); return b ? b.from : null },
    setScrollPos: (pos) => { const b = view.elementAtHeight(pos); if (b) view.scrollDOM.scrollTop = b.top; return true },
    getScrollRatio: () => { const el = view.scrollDOM; return el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0 },
    getCursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
    getSelection: () => view.state.selection.main,
    focus: () => view.focus(), destroy: () => view.destroy(),
  }
}
export { EditorView, EditorState }
EOF

# 打包（outfile 相对仓库根；本目录是唯一落点）
npx esbuild entry.js --bundle --format=esm --minify \
  --outfile=bridge/console/vendor/codemirror.mjs
```

重打完把**实际用到的版本**写进下面一节，并跑一次 Console 冒烟（`npm run test:console`）。

## 版本

**当前这份 bundle 的确切依赖版本没有记录下来** —— 产物是 minified 的，无法从文件反推。
所以升级/重打时请显式固定版本（`npm install @codemirror/view@6.x.y …`），并把这份清单补全，
否则"这份产物到底是哪几个版本"会一直是悬案。

参考：`@codemirror/view` 的 MIT 许可与版权行取自 npm registry 上该包的 `LICENSE`。
