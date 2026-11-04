/**
 * 「文件夹项前面不再显示颜色圆点」的回归测试。
 *
 * 背景（踩过两次）：
 *   1. 第一版用「绝对定位 + 把同格 svg 设成 opacity:0」腾地方，把 DSH 的文件夹
 *      图标一起隐形了 —— 侧栏只剩一个色点。
 *   2. 修好图标后，圆点本身还是用户不想要的东西（文件夹前面只该有图标）。
 *
 * 所以现在的约定是：**不再注入任何圆点**，文件夹那一格的布局保持 DSH 原样
 * （图标、尺寸、占位都不动）。新需求只允许改一件事：文件夹图标本身的颜色
 * 跟随项目身份色（与 Buddy 同源），且必须走 folderInkStyles 这条受限通道。
 *
 * 这里钉死：样式表里不能出现会渲染出来的圆点，必须有清理残留的兜底，
 * 且文件夹规则只许改 color。
 *
 * @module test/chip-styles.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { folderInkStyles, paletteStyles } from '../src/widget/styles.js'

const css = paletteStyles()

test('样式表里不再有「画一个可见圆点」的规则', () => {
  // 不许出现尺寸/形状类声明 —— 只允许 display:none 这种清理规则
  assert.doesNotMatch(css, /\.dsgb-chip\{[^}]*width:\s*6px/, '不该再画 6px 圆点')
  assert.doesNotMatch(css, /border-radius:\s*50%/, '不该再画圆形')
  // 只看圆点自己的规则，别误伤菜单按钮（那里本来就有 cursor:pointer）
  const chipRule = /\.dsgb-chip(?![\w-])[^{]*\{([^}]*)\}/g
  for (const match of css.matchAll(chipRule)) {
    assert.match(match[1], /display:none/, '圆点规则只允许是清理用的 display:none')
  }
  assert.doesNotMatch(css, /order:\s*-1/, '不该再往图标前面塞东西')
  assert.doesNotMatch(css, /position:\s*absolute/, '不该绝对定位盖在图标上')
})

test('老版本留下的圆点节点被强制隐藏（升级后不会残留）', () => {
  assert.match(css, /\.dsgb-chip[^{]*\{[^}]*display:none!important/, '残留节点必须藏掉')
})

test('不再对文件夹那一格写任何布局规则（交还给 DSH 自己管）', () => {
  assert.doesNotMatch(css, /\.dsgb-chip-slot\s*\{/, '不该再给这一格写样式')
  assert.doesNotMatch(css, /gap:\s*2px/, '不再需要圆点与图标之间的缝')
})

test('全局没有任何 opacity:0 / visibility:hidden，别再把图标藏掉', () => {
  assert.doesNotMatch(css, /opacity:\s*0\b/)
  assert.doesNotMatch(css, /visibility:\s*hidden/)
  assert.doesNotMatch(css, /dsgb-chip-slot\s*>\s*svg/)
})

// ── 文件夹项目色：只允许走 folderInkStyles 这条受限通道 ─────────────────────

const FOLDER_ATTR = 'data-dsgb-workspace-folder'
const FOLDER_INK_VAR = '--dsgb-workspace-ink'
const folderCss = folderInkStyles(FOLDER_ATTR, FOLDER_INK_VAR)

test('文件夹着色规则只声明 color，布局（尺寸/定位/显示）一概不碰', () => {
  const body = /\{([^}]*)\}/.exec(folderCss)
  assert.ok(body !== null, '规则要有声明块')
  const decls = body[1].split(';').map((part) => part.trim()).filter(Boolean)
  assert.deepEqual(decls, ['color:var(' + FOLDER_INK_VAR + ')'], '只许一条 color 声明')
})

test('文件夹着色选择器写在标记属性上（写两遍压过宿主单类规则），不碰整行', () => {
  const sel = /^([^\{]+)\{/.exec(folderCss)[1].trim()
  assert.equal(sel, '[' + FOLDER_ATTR + '][' + FOLDER_ATTR + ']', '双属性选择器，特异度 0,2,0')
  assert.doesNotMatch(folderCss, /!important/, '不用 !important')
  assert.doesNotMatch(folderCss, /projectRow|rowActions|title/, '不许把规则扩到行、按钮或标题')
  // 颜色来自插件变量，不写死某个色值
  assert.doesNotMatch(folderCss, /#[0-9a-f]{3,8}\b/i, '不许硬编码颜色')
})
