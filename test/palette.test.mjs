/**
 * palette.js 的单元测试：颜色是**身份**，不是状态。
 *
 * 这张表决定了「侧栏里两个项目看起来是不是两家人」。它必须满足：
 *   · 同一个 workspaceId 永远同一个默认色（跨次、跨机器）
 *   · 不同项目的默认色要散得开
 *   · 用户设过的色原样生效，但只动明度、不动色相
 *
 * @module test/palette.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IDENTITY_INKS,
  MIN_CONTRAST,
  adjustForSurface,
  contrast,
  defaultInk,
  hash32,
  inkOfProject,
  projectDomain,
  luminance,
} from '../src/palette.js'
import { normalizeColor, parseHex } from '../src/colors-shared.js'

const PHASES = ['idle', 'thinking', 'streaming', 'tool', 'waiting', 'retry', 'error', 'completed']
const OFFICIAL = IDENTITY_INKS.map((item) => item.ink)

test('默认色只会是官方 8 色之一', () => {
  for (const id of ['a', 'b', 'proj-1', '', 'workspace:中文', 'x'.repeat(60)]) {
    assert.ok(OFFICIAL.includes(defaultInk(id)), id + ' 取到了非官方色 ' + defaultInk(id))
  }
})

test('同一个 workspaceId 多次计算稳定（不随机、不按顺序）', () => {
  for (const id of ['alpha', 'beta', '', 'ws-42']) {
    const first = defaultInk(id)
    for (let i = 0; i < 50; i++) assert.equal(defaultInk(id), first)
  }
  // 哈希本身也是纯函数
  assert.equal(hash32('deepseek'), hash32('deepseek'))
})

test('不同项目的默认色能区分开（8 个常见项目至少三种颜色）', () => {
  const ids = ['acme', 'grokbot', 'design', 'infra', 'notes', 'dsh', 'web', 'cli']
  const set = new Set(ids.map((id) => defaultInk(id)))
  assert.ok(set.size >= 3, '8 个项目只取到 ' + set.size + ' 种颜色，太挤了')
})

test('未分组走独立哈希域，不总是撞上同一个真实项目', () => {
  assert.notEqual(projectDomain(''), projectDomain('ungrouped'))
  assert.equal(projectDomain(''), 'ungrouped:')
  assert.equal(projectDomain('abc'), 'ws:abc')
  // 未分组色依旧是官方 8 色之一
  assert.ok(OFFICIAL.includes(defaultInk('')))
})

test('用户设过的颜色原样生效，且不随相位/主题变', () => {
  const overrides = { 'proj-x': '#9159fe' }
  for (const phase of PHASES) {
    assert.equal(inkOfProject('proj-x', true, overrides), '#9159fe', phase)
    assert.equal(inkOfProject('proj-x', false, overrides), '#9159fe', phase)
  }
})

test('没设过的项目仍走哈希默认色（改成别的项目不影响它）', () => {
  const overrides = { 'proj-x': '#9159fe' }
  assert.equal(inkOfProject('proj-y', true, overrides), defaultInk('proj-y'))
})

test('非法/损坏的持久化值被忽略，退回默认色而不是崩', () => {
  const bad = { 'proj-x': 'not-a-color', 'proj-y': 42, 'proj-z': null }
  assert.equal(inkOfProject('proj-x', true, bad), defaultInk('proj-x'))
  assert.equal(inkOfProject('proj-y', true, bad), defaultInk('proj-y'))
  assert.equal(inkOfProject('proj-z', true, bad), defaultInk('proj-z'))
  // 传 null / undefined 也不炸
  assert.equal(inkOfProject('proj-x', true, null), defaultInk('proj-x'))
  assert.equal(inkOfProject(undefined, true, undefined), defaultInk(''))
})

test('颜色校验：只收合法 hex 与预设名白名单', () => {
  assert.equal(normalizeColor('#9159FE'), '#9159fe')
  assert.equal(normalizeColor('9159fe'), '#9159fe')
  assert.equal(normalizeColor('#abc'), '#aabbcc')
  assert.equal(normalizeColor('purple'), '#9159fe')
  assert.equal(normalizeColor('蓝'), null) // 中文名不是白名单键
  assert.equal(normalizeColor('rgb(1,2,3)'), null)
  assert.equal(normalizeColor('javascript:alert(1)'), null)
  assert.equal(normalizeColor('#12345'), null)
  assert.equal(normalizeColor(''), null)
  assert.equal(normalizeColor(null), null)
  assert.equal(normalizeColor({}), null)
  assert.equal(parseHex('  #FFF  '), '#ffffff')
})

test('对比度足够时官方色一个字节都不动', () => {
  // 亮色侧栏上，官方蓝本来就很清楚
  assert.equal(adjustForSurface('#1084fe', '#ffffff'), '#1084fe')
  // 暗色侧栏上的亮青也够
  assert.equal(adjustForSurface('#00bca6', '#14161a'), '#00bca6')
})

test('对比度不足时只调明度：仍是同一个色相，不变成另一个色', () => {
  // 官方橙在亮色侧栏上对比度不够（1.9），必须压暗才看得清
  const surface = '#ffffff'
  const raw = '#ff9800'
  assert.ok(contrast(raw, surface) < MIN_CONTRAST, '这个用例要的是「不够」的前提')
  const fixed = adjustForSurface(raw, surface)
  assert.notEqual(fixed, raw)
  assert.ok(contrast(fixed, surface) >= MIN_CONTRAST, '调整后仍不够清楚')
  // 色相没换：仍然是橙色（r 最高，其次是 g，b 最低）
  const r = Number.parseInt(fixed.slice(1, 3), 16)
  const g = Number.parseInt(fixed.slice(3, 5), 16)
  const b = Number.parseInt(fixed.slice(5, 7), 16)
  assert.ok(r > g && g > b, '调完不再是橙色了: ' + fixed)
  assert.ok(r - b > 120, '饱和度不该被抹平: ' + fixed)
})

test('亮背景上往暗里调，暗背景上往亮里调', () => {
  // 两头的极端色：在纯黑上要提亮，在纯白上要压暗
  const onBlack = adjustForSurface('#30150a', '#000000')
  const onWhite = adjustForSurface('#ffe0b0', '#ffffff')
  assert.ok(luminance(onBlack) > luminance('#30150a'), '纯黑背景上应该提亮: ' + onBlack)
  assert.ok(luminance(onWhite) < luminance('#ffe0b0'), '纯白背景上应该压暗: ' + onWhite)
})

test('给了背景色就按背景微调，没给就原样返回', () => {
  assert.equal(inkOfProject('proj-x', true, { 'proj-x': '#9159fe' }, undefined), '#9159fe')
  const onWhite = inkOfProject('proj-x', true, { 'proj-x': '#9159fe' }, '#ffffff')
  assert.equal(onWhite, '#9159fe') // 紫在白底上够清楚，不动
})
