// shell 变量展开安全（v2.57）
//
// 起因（同一个坑踩了两次，第二次还让一个看护脚本当场死掉）：
//
//   echo "启动时已有条数：$COUNT（1 = 手工那轮）"
//                        ^^^^^^ bash 3.2 在这里会把 `（` 的字节**并进变量名**
//
// macOS 自带的是 bash 3.2，它按字节处理变量名边界，于是紧跟在 `$VAR` 后面的
// 多字节字符（全角括号、顿号、中文……）会被当成变量名的一部分 →
// `COUNT: unbound variable`，在 `set -u` 下**直接终止脚本**。
//
// 为什么值得一条常驻测试：
//   · 中文项目里这种写法**天然高频**——"…条数：$COUNT 条" 里如果没留空格就中招；
//   · 它**写的时候完全看不出来**（编辑器里一切正常），只在运行到那一行时炸；
//   · 实测它已经藏住了两条**错误提示路径**：
//       - `bridge/install-launchd.sh`：守护已安装但未运行时本该打印提示，
//         结果脚本自己先崩在 `$LABEL）` 上，用户看到的是一句 unbound variable；
//       - `preset/upgrade-check.sh`：缺失 bundle 的 hint 里 `$b、` 同理。
//     错误路径崩掉的代价比正常路径更大——那正是最需要它说话的时刻。
//
// 修法永远是 `${VAR}`（大括号划清边界），本测试就钉这一条。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')

/** `$VAR` 后面紧跟非 ASCII 字节——bash 3.2 会把那些字节并进变量名
 *
 * 用 `\p{ASCII}` 而不是 `[^\x00-\x7f]`：后者字面写着 \x00-\x1f 这些控制字符，
 * eslint 的 `no-control-regex` 会（正确地）报错，而这里要表达的是"非 ASCII"，
 * 不是"控制字符"。语义完全等价（JS 字符串里 ASCII 就是 U+0000–U+007F），
 * 但用 Unicode 属性转义说人话，也就不必为 lint 关规则。 */
const RISKY = /\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\p{ASCII}])/gu

const SKIP_DIRS = new Set(['node_modules', '.git', 'md-backup', '.local', 'dist', 'coverage'])

function shellFiles(dir, depth = 0, out = []) {
  if (depth > 6) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claude') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      shellFiles(p, depth + 1, out)
    } else if (e.name.endsWith('.sh')) {
      out.push(p)
    }
  }
  return out
}

test('shell：变量名不得紧贴非 ASCII 字节（bash 3.2 会把它们并进变量名）', () => {
  // 先证明探测器本身有效——否则这条测试可能是"永远通过"的空壳
  assert.equal('$A（'.match(RISKY)?.length, 1, '探测器应能识别 $A（')
  assert.equal('$A、'.match(RISKY)?.length, 1, '探测器应能识别 $A、')
  assert.equal('${A}（'.match(RISKY), null, '已加括号的写法不该被误报')
  assert.equal('$A ('.match(RISKY), null, '后面是 ASCII 空格时不该被误报')

  const offenders = []
  for (const f of shellFiles(REPO)) {
    let text
    try {
      text = fs.readFileSync(f, 'utf8')
    } catch {
      continue
    }
    text.split('\n').forEach((line, i) => {
      RISKY.lastIndex = 0
      let m
      while ((m = RISKY.exec(line)) !== null) {
        offenders.push(
          `${path.relative(REPO, f)}:${i + 1}  $${m[1]}` +
            `  →  写成 \${${m[1]}} 即可\n      ${line.trim().slice(0, 120)}`,
        )
      }
    })
  }

  assert.deepEqual(
    offenders,
    [],
    '以下位置会让脚本在运行到该行时报 "unbound variable"（`set -u` 下直接终止）：\n' +
      offenders.map((o) => '  · ' + o).join('\n') +
      '\n修法：把 $VAR 写成 ${VAR}，或在变量与中文标点之间留一个 ASCII 空格/引号。',
  )
})
