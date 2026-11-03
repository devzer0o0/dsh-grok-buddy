/**
 * mapping.js 的单元测试：锁住「相位 → 生命周期 → 动作」这张表。
 *
 * 只有六个相位，和官方 lifecycle 一一对应。颜色不参与状态（见 palette.test）。
 *
 * @module test/mapping.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  INK,
  LIFECYCLE,
  PHASE_TO_LIFECYCLE,
  PHASE_TO_STATE,
  PHASE_TEXT,
  SURFACE,
  surfaceOf,
  themeOf,
} from '../src/mapping.js'
import { IDENTITY_INKS, inkOfProject } from '../src/palette.js'

const PHASES = ['idle', 'thinking', 'working', 'waiting', 'blocked', 'done']

test('只有六个相位，和官方 lifecycle 一一对应', () => {
  assert.deepEqual(
    LIFECYCLE.map((item) => item.id),
    ['idle', 'working', 'waiting', 'blocked', 'thinking', 'done'],
  )
  assert.deepEqual(
    LIFECYCLE.map((item) => item.label),
    ['Idle', 'Working', 'Waiting', 'Blocked', 'Thinking', 'Done'],
  )
  for (const phase of PHASES) {
    assert.ok(PHASE_TO_LIFECYCLE[phase] !== undefined, phase + ' 没有生命周期')
  }
  assert.equal(Object.keys(PHASE_TO_LIFECYCLE).length, 6, '不能多出别的相位')
})

test('每个相位都有 GrokBot 动作名，且两两不同', () => {
  const seen = new Set()
  for (const phase of PHASES) {
    const state = PHASE_TO_STATE[phase]
    assert.equal(typeof state, 'string', phase + ' 没有状态名')
    assert.ok(state.length > 0)
    assert.equal(seen.has(state), false, phase + ' 与别人共用了动作 ' + state)
    seen.add(state)
  }
  assert.equal(Object.keys(PHASE_TO_STATE).length, 6)
})

test('墨色**不随相位变化** —— 同一个项目六个相位取到同一个颜色', () => {
  const workspaceId = 'ws-hash-stability'
  const inks = new Set(PHASES.map(() => inkOfProject(workspaceId, true, {})))
  assert.equal(inks.size, 1, '相位不该影响颜色')
  const inksLight = new Set(PHASES.map(() => inkOfProject(workspaceId, false, {})))
  assert.equal(inksLight.size, 1)
  assert.deepEqual([...inks], [...inksLight])
})

test('官方 ink 值本身没被改字', () => {
  assert.equal(INK.blue, '#1084fe')
  assert.equal(INK.purple, '#9159fe')
  assert.equal(INK.orange, '#ff9800')
  assert.equal(INK.pink, '#ff309b')
  assert.equal(INK.ember, '#ff6700')
  assert.equal(INK.clay, '#97683d')
  assert.equal(INK.teal, '#00bca6')
  assert.equal(INK.red, '#ff263c')
})

test('身份墨色表就是官方那 8 个，没有状态色混进来', () => {
  assert.equal(IDENTITY_INKS.length, 8)
  const values = IDENTITY_INKS.map((item) => item.ink)
  for (const value of Object.values(INK)) assert.ok(values.includes(value))
  assert.equal(values.includes('#00c972'), false, '完成绿不是身份色')
})

test('眼睛填背景色，身体用传进来的项目墨色', () => {
  assert.equal(themeOf('#9159fe', true).eye, SURFACE.dark)
  assert.equal(themeOf('#9159fe', false).eye, SURFACE.light)
  assert.equal(themeOf('#9159fe', true, '#202020').eye, '#202020')
  assert.equal(themeOf('#9159fe', true, '#202020').body, '#9159fe')
})

test('surfaceOf 拿不到 DOM 时退回兜底底色', () => {
  assert.equal(surfaceOf(null, true), SURFACE.dark)
  assert.equal(surfaceOf(undefined, false), SURFACE.light)
})

test('相位文案覆盖六个相位，中英都不缺', () => {
  assert.equal(PHASE_TEXT.zh.idle, '空闲')
  assert.equal(PHASE_TEXT.zh.thinking, '思考')
  assert.equal(PHASE_TEXT.zh.working, '正在处理')
  assert.equal(PHASE_TEXT.zh.waiting, '正在等待')
  assert.equal(PHASE_TEXT.zh.blocked, '已阻止')
  assert.equal(PHASE_TEXT.zh.done, '完成')
  for (const phase of PHASES) {
    assert.equal(typeof PHASE_TEXT.en[phase], 'string')
    assert.ok(PHASE_TEXT.en[phase].length > 0)
  }
})