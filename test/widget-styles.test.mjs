/**
 * widget 样式表的单元测试：锁住「前导位不再压住标题」这条布局约束。
 *
 * 出事的那一行同时有两只 16px 的标记：我们画的 GrokBot，和 DSH 定时任务的时钟
 * （`[data-session-schedule-mark]`）。原生实现只在该行 idle 时才画时钟，两者从不
 * 同框；我们顶掉状态点后两只就撞在一起，定宽 16px 的格子装不下，时钟溢出压到标题上。
 *
 * 所以这里钉死三件事：
 *   1. 格子按内容撑开（width:auto），不再是定宽 16px —— 溢出从这里来
 *   2. 头像尺寸取自 BOT_SIZE（20px：等于宿主前导位高度，侧栏里能认出感叹号/三点）
 *   3. 头像排最前（DOM 顺序 + order:-1 兜底），和原生状态点同位
 *
 * @module test/widget-styles.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BOT_SIZE, CELL_GAP, slotStyles } from '../src/widget/styles.js'

const BOT = 'dsgb-bot'
const ATTR = 'data-dsgb-slot'
// 生成样式时使用的尺寸就是插件真正挂出去的尺寸，测试必须跟它同源。
const SIZE = BOT_SIZE
const css = slotStyles(BOT, ATTR, SIZE)

/** 取某条规则（选择器 → 声明块）。 */
function ruleOf(selector) {
  const at = css.indexOf(selector + '{')
  assert.notEqual(at, -1, '缺少规则: ' + selector)
  const end = css.indexOf('}', at)
  return css.slice(at + selector.length + 1, end)
}

test('前导位按内容撑开，不再定宽 —— 多出的标记不会溢出压标题', () => {
  const cell = ruleOf('[' + ATTR + '][' + ATTR + ']')
  assert.match(cell, /width:auto/, '格子必须 width:auto，否则第二只标记溢出')
  assert.doesNotMatch(cell, /[^-]width:16px/, '不能再把格子钉回定宽')
  assert.match(cell, new RegExp('min-width:' + SIZE + 'px'), '只剩头像时要保持头像的宽度')
  assert.match(cell, /display:inline-flex/)
  assert.match(cell, /flex:none/, '格子本身不能被行里的 flex 拉伸')
})

test('格子里并排的标记之间留缝，谁都不贴谁', () => {
  assert.ok(CELL_GAP > 0, '缝必须为正')
  assert.match(ruleOf('[' + ATTR + '][' + ATTR + ']'), new RegExp('gap:' + CELL_GAP + 'px'))
})

test('头像尺寸取自 BOT_SIZE，且比原生 16px 状态点更大（可辨认）', () => {
  const bot = ruleOf('[' + ATTR + '][' + ATTR + '] > .' + BOT)
  assert.match(bot, new RegExp('width:' + SIZE + 'px'))
  assert.match(bot, new RegExp('height:' + SIZE + 'px'))
  assert.match(bot, /flex:none/)
  assert.ok(SIZE > 16, '16px 在侧栏里看不清，头像必须比原生状态点大')
  // 宿主前导位高度 20px、会话行高 32px：不超过这两者就不会撑破布局。
  assert.ok(SIZE <= 20, '不能超过宿主前导位高度（20px），否则行会被撑高')
})

test('头像永远排在前导位最前面，和原生状态点同位', () => {
  const bot = ruleOf('[' + ATTR + '][' + ATTR + '] > .' + BOT)
  assert.match(bot, /order:-1/, 'order:-1 是 DOM 顺序之外的兜底')
})

test('原生状态点与读屏标签都被藏掉，同一格只留头像和别的插件标记', () => {
  assert.match(ruleOf('[' + ATTR + '][' + ATTR + '] > [data-state]'), /display:none!important/)
  assert.match(
    ruleOf('[' + ATTR + '][' + ATTR + '] > [class*="visuallyHidden"]'),
    /display:none!important/,
  )
})

test('规则选择器写成双属性，压得过 DSH 模块类的 width:16px', () => {
  for (const line of css.split('\n')) {
    assert.match(line, new RegExp('^\\[' + ATTR + '\\]\\[' + ATTR + '\\]'), '同特异度必须靠双属性提升: ' + line)
  }
})
