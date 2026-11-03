/**
 * 动作层的单元测试：颜色不表达状态之后，**动作**必须一个人扛起来。
 *
 * 六个相位各自一个动作，这里钉死三件事：
 *   1. 每个相位都对得上一个真实存在的 GrokBot 状态
 *   2. 六个动作的表情池/节奏**两两不同**（16px 下也得分得开）
 *   3. 最容易混的三只（blocked / waiting / done）动作不能互相代替
 *
 * @module test/motion.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { TB_STATES } from '../src/grokbot/data.js'
import { PHASE_TO_STATE } from '../src/mapping.js'

const PHASES = ['idle', 'thinking', 'working', 'waiting', 'blocked', 'done']

/** 状态的动作签名：表情池 + 换脸节奏 + 眨眼节奏。 */
function signature(stateName) {
  const state = TB_STATES[stateName]
  assert.ok(state !== undefined, '找不到状态 ' + stateName)
  return JSON.stringify({
    expressions: state.expressions,
    expressionMin: state.expressionMin,
    expressionMax: state.expressionMax,
    blinkMin: state.blinkMin,
    blinkMax: state.blinkMax,
  })
}

test('六个相位都对得上一个真实存在的 GrokBot 状态', () => {
  for (const phase of PHASES) {
    const stateName = PHASE_TO_STATE[phase]
    assert.ok(TB_STATES[stateName] !== undefined, phase + ' → ' + stateName + ' 不在状态表里')
  }
})

test('六个相位的动作两两不同 —— 颜色不承担状态之后，动作必须分得开', () => {
  const seen = new Map()
  for (const phase of PHASES) {
    const sig = signature(PHASE_TO_STATE[phase])
    const previous = seen.get(sig)
    assert.equal(previous, undefined, phase + ' 与 ' + previous + ' 的动作完全一样')
    seen.set(sig, phase)
  }
})

test('blocked / waiting / done 三者的动作互不相同（最容易混的三只）', () => {
  const trio = ['blocked', 'waiting', 'done'].map((phase) => signature(PHASE_TO_STATE[phase]))
  assert.equal(new Set(trio).size, 3)
})

test('done 是 celebrate：节奏明显比 idle 快', () => {
  const celebrate = TB_STATES[PHASE_TO_STATE.done]
  const idle = TB_STATES[PHASE_TO_STATE.idle]
  assert.equal(PHASE_TO_STATE.done, 'celebrate')
  assert.ok(celebrate.expressionMin < idle.expressionMin)
  assert.ok(celebrate.expressionMax < idle.expressionMax)
})

test('waiting 是 bored：换脸比 working 慢，看得出「在等」', () => {
  const bored = TB_STATES[PHASE_TO_STATE.waiting]
  const working = TB_STATES[PHASE_TO_STATE.working]
  assert.equal(PHASE_TO_STATE.waiting, 'bored')
  assert.ok(bored.expressionMin > working.expressionMin)
})

test('blocked 是 alerting：不眨眼，表情池小，看得出「卡住了」', () => {
  const alerting = TB_STATES[PHASE_TO_STATE.blocked]
  assert.equal(PHASE_TO_STATE.blocked, 'alerting')
  assert.equal(alerting.blinkMin, null, 'alerting 不眨眼')
  assert.ok(alerting.expressions.length <= 3)
})

test('working 是换脸最快的那一档（在干活）', () => {
  const working = TB_STATES[PHASE_TO_STATE.working]
  const thinking = TB_STATES[PHASE_TO_STATE.thinking]
  assert.equal(PHASE_TO_STATE.working, 'working')
  assert.ok(working.expressionMin <= thinking.expressionMin)
})
