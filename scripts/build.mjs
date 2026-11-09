/**
 * 把 src/ 下的 ES 模块打成一个 IIFE 单文件，供宿主以 /dsh-grok-buddy/widget.js 提供。
 *
 * 为什么要自己打：DSH 的注入脚本是普通 <script> 追加到 head 的，
 * 不是 ES module；而 GrokBot 的数据与引擎又需要分层维护。
 * 这里做一次极简的「按 import 顺序拼接 + 改名」，不引入任何构建依赖。
 *
 * @module scripts/build
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(ROOT, 'src')
const OUT = path.join(ROOT, 'lib', 'widget.js')

/**
 * 读出模块源码，剥掉 export 关键字并收集导出名。
 * @param {string} file 源文件路径。
 * @returns {{code: string, exports: string[]}} 处理后的代码与导出名。
 */
function load(file) {
  let code = fs.readFileSync(file, 'utf8')
  const exports = []
  // export const/let/function/class X
  code = code.replace(/^export\s+(const|let|function|class)\s+([A-Za-z0-9_$]+)/gm, (m, kind, name) => {
    exports.push(name)
    return kind + ' ' + name
  })
  // export { a, b }
  code = code.replace(/^export\s+\{([^}]*)\}/gm, (m, names) => {
    for (const raw of names.split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()
      if (name) exports.push(name)
    }
    return ''
  })
  // 去掉残留的 import（模块已按顺序内联）。
  // 必须支持多行写法 —— 单行正则漏掉 `{\n  A,\n}` 就会把半截 import 打进产物，
  // 整个 IIFE 直接语法错误（真踩过）。
  code = code.replace(/^import\s+[\s\S]*?from\s*['"][^'"]*['"];?\s*$/gm, '')
  code = code.replace(/^import\s*['"][^'"]*['"];?\s*$/gm, '')
  return { code, exports }
}

const modules = [
  path.join(SRC, 'decision.js'),
  path.join(SRC, 'grokbot', 'data.js'),
  path.join(SRC, 'grokbot', 'reference-geometry.js'),
  path.join(SRC, 'grokbot', 'reference-motion.js'),
  path.join(SRC, 'grokbot', 'motion.js'),
  path.join(SRC, 'grokbot', 'engine.js'),
  path.join(SRC, 'colors-shared.js'),
  path.join(SRC, 'palette.js'),
  path.join(SRC, 'mapping.js'),
  path.join(SRC, 'widget', 'dom.js'),
  path.join(SRC, 'widget', 'dsh-state.js'),
  path.join(SRC, 'widget', 'activity.js'),
  path.join(SRC, 'widget', 'celebrate.js'),
  path.join(SRC, 'widget', 'tool-cue.js'),
  path.join(SRC, 'widget', 'styles.js'),
  path.join(SRC, 'widget', 'index.js'),
  path.join(SRC, 'widget', 'workspace-chrome.js'),
]

let body = ''
// 横幅里的路径一律用正斜杠：path.relative 在 Windows 上给反斜杠，
// 那会让同一份源码在三个平台构建出不同的字节，CI 的「产物已同步」检查就红。
const relPosix = (file) => path.relative(ROOT, file).split(path.sep).join('/')

for (const file of modules) {
  const { code } = load(file)
  body += '\n/* ── ' + relPosix(file) + ' ───────────────────────────── */\n'
  body += code.trim() + '\n'
}

const banner = [
  '/*!',
  ' * dsh-grok-buddy —— 侧栏会话状态头像（GrokBot）。',
  ' *',
  ' * 头像几何、表情、体形、节奏表移植自 GrokBot',
  ' *   https://github.com/nasawz/GrokBot  (BSD-3-Clause, (c) 2026 nasawz)',
  ' * 经 dsh-thought-buddy (BSD-3-Clause) 的 TypeScript 移植版转写。',
  ' *',
  ' * 本文件由 scripts/build.mjs 生成，请改 src/ 下的源文件后重新构建。',
  ' */',
  '(function () {',
  "'use strict';",
].join('\n')

const footer = '\n})();\n'

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, banner + body + footer)
console.log('built', path.relative(ROOT, OUT), fs.statSync(OUT).size, 'bytes')
