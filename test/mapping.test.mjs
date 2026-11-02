/**
 * mapping.js 的单元测试：锁住「官方生命周期 → 墨色」这张表。
 *
 * 这张表是照着 x.ai「Designing Grok Bot」和站点包里 Grok Bot 头像的 ink 值订的。
 * 它决定了侧栏那张脸是什么颜色，改错一次就会让人以为状态变了，所以逐条钉死。
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
  inkOf,
  themeOf,
} from '../src/mapping.js'

const PHASES = ['idle', 'thinking', 'streaming', 'tool', 'waiting', 'retry', 'error', 'completed']

test('官方生命周期就是那六个，顺序照官方页面', () => {
  assert.deepEqual(
    LIFECYCLE.map((item) => item.id),
    ['idle', 'working', 'waiting', 'blocked', 'thinking', 'done'],
  )
  assert.deepEqual(
    LIFECYCLE.map((item) => item.label),
    ['Idle', 'Working', 'Waiting', 'Blocked', 'Thinking', 'Done'],
  )
  // 官方站点的 state 映射：waiting → bored、blocked → alerting、done → celebrate
  assert.equal(LIFECYCLE.find((i) => i.id === 'waiting').state, 'bored')
  assert.equal(LIFECYCLE.find((i) => i.id === 'blocked').state, 'alerting')
  assert.equal(LIFECYCLE.find((i) => i.id === 'done').state, 'celebrate')
})

test('每个 DSH 相位都能追到官方的一个生命周期', () => {
  for (const phase of PHASES) {
    const lifecycle = PHASE_TO_LIFECYCLE[phase]
    assert.ok(lifecycle !== undefined, phase + ' 没有生命周期')
    assert.ok(
      LIFECYCLE.some((item) => item.id === lifecycle),
      phase + ' 的生命周期不在官方六个里：' + lifecycle,
    )
  }
})

test('同色的细分相位：吐字与工具都是 Working，等你与重试都是 Waiting', () => {
  assert.equal(PHASE_TO_LIFECYCLE.streaming, PHASE_TO_LIFECYCLE.tool)
  assert.equal(PHASE_TO_LIFECYCLE.waiting, PHASE_TO_LIFECYCLE.retry)
  assert.equal(inkOf('streaming', true), inkOf('tool', true))
  assert.equal(inkOf('waiting', true), inkOf('retry', true))
})

test('墨色逐条对照官方取值', () => {
  const expected = {
    idle: { dark: '#9a9a9a', light: '#777777' },
    thinking: { dark: INK.purple, light: INK.purple },
    streaming: { dark: INK.blue, light: INK.blue },
    tool: { dark: INK.blue, light: INK.blue },
    waiting: { dark: INK.orange, light: INK.orange },
    retry: { dark: INK.orange, light: INK.orange },
    error: { dark: INK.red, light: INK.red },
    completed: { dark: INK.green, light: INK.green },
  }
  for (const [phase, colors] of Object.entries(expected)) {
    assert.equal(inkOf(phase, true), colors.dark, phase + ' 暗色')
    assert.equal(inkOf(phase, false), colors.light, phase + ' 亮色')
  }
})

test('官方 ink 值本身没被改字（大小写不敏感地比对官方站点）', () => {
  assert.equal(INK.blue, '#1084fe') //   blob     主 Bot
  assert.equal(INK.purple, '#9159fe') // hex
  assert.equal(INK.orange, '#ff9800') // cloud / 徽章 warn
  assert.equal(INK.pink, '#ff309b') //   wedge
  assert.equal(INK.ember, '#ff6700') //  pebble
  assert.equal(INK.clay, '#97683d') //   teardrop
  assert.equal(INK.teal, '#00bca6') //   squircle
  assert.equal(INK.red, '#ff263c') //    tablet / 徽章 error
  assert.equal(INK.green, '#00c972') //  徽章 done
})

test('墨色只跟相位走，主题只影响 idle 的灰', () => {
  for (const phase of PHASES) {
    if (phase === 'idle') continue
    assert.equal(inkOf(phase, true), inkOf(phase, false), phase + ' 不该随主题变色')
  }
})

test('眼睛填背景色（官方 .eye{fill:var(--bg)}），不给就用兜底底色', () => {
  assert.equal(themeOf('thinking', true).eye, SURFACE.dark)
  assert.equal(themeOf('thinking', false).eye, SURFACE.light)
  assert.equal(themeOf('thinking', true, '#202020').eye, '#202020')
  // 身体永远是墨色
  assert.equal(themeOf('thinking', true, '#202020').body, INK.purple)
})

test('相位文案覆盖全部相位，中英都不缺', () => {
  for (const phase of PHASES) {
    assert.equal(typeof PHASE_TEXT.zh[phase], 'string')
    assert.equal(typeof PHASE_TEXT.en[phase], 'string')
    assert.ok(PHASE_TEXT.zh[phase].length > 0, phase + ' 中文文案为空')
    assert.ok(PHASE_TEXT.en[phase].length > 0, phase + ' 英文文案为空')
  }
})

test('每个相位都有 GrokBot 状态名', () => {
  for (const phase of PHASES) {
    assert.equal(typeof PHASE_TO_STATE[phase], 'string', phase + ' 没有状态名')
    assert.ok(PHASE_TO_STATE[phase].length > 0)
  }
})
