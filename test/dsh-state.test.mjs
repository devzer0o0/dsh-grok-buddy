/**
 * 状态融合测试：插件事件流状态 × DSH 画在行里的状态点。
 *
 * 融合不是「有值就优先」，也不是「DSH 说 done 就永远覆盖」：
 * 已消费的完成记录，DSH 遗留的 done 不能让它重新庆祝。
 *
 * @module test/dsh-state.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { dshRawStateOf, dshStateOf, fallbackPhase, mergePhase } from '../src/widget/dsh-state.js'

/** 只带一个状态点的行桩。 */
function row(state) {
  const dot = { getAttribute: (name) => (name === 'data-state' ? state : null) }
  return { querySelector: (selector) => (selector === '[data-state]' ? dot : null) }
}

const EMPTY_ROW = { querySelector: () => null }

test('DSH 的 done 会被认成完成', () => {
  assert.equal(dshStateOf(row('done')), 'done')
})

test('ongoing / warning / idle 各自对上', () => {
  assert.equal(dshStateOf(row('ongoing')), 'thinking')
  assert.equal(dshStateOf(row('warning')), 'waiting')
  assert.equal(dshStateOf(row('idle')), 'idle')
})

test('原始取值可读（诊断用）', () => {
  assert.equal(dshRawStateOf(row('ongoing')), 'ongoing')
  assert.equal(dshRawStateOf(EMPTY_ROW), null)
})

test('我们的强证据压过 DSH 的粗粒度信号', () => {
  for (const ours of ['working', 'waiting', 'blocked', 'thinking']) {
    assert.equal(mergePhase({ phase: ours, known: true, row: row('ongoing') }).phase, ours)
  }
})

test('插件没有数据时用 DSH 的状态点兜底', () => {
  assert.equal(fallbackPhase(row('done')), 'done')
  assert.equal(fallbackPhase(row('ongoing')), 'thinking')
  assert.equal(fallbackPhase(row('warning')), 'waiting')
  assert.equal(fallbackPhase(EMPTY_ROW), 'idle')
})

test('DSH 说 done 而我们只有 idle：未消费时采信 DSH', () => {
  const merged = mergePhase({ phase: 'idle', known: true, consumed: false, row: row('done') })
  assert.equal(merged.phase, 'done')
  assert.equal(merged.source, 'dsh')
})

test('已消费的完成记录，DSH 遗留的 done 不能让它重新庆祝', () => {
  const merged = mergePhase({ phase: 'idle', known: true, consumed: true, row: row('done') })
  assert.equal(merged.phase, 'idle')
  assert.equal(merged.source, 'consumed')
})

test('DSH 说 idle 时以我们为准', () => {
  assert.equal(mergePhase({ phase: 'done', known: true, row: row('idle') }).phase, 'done')
})

test('没有状态点、或取值不认识时退回我们的', () => {
  assert.equal(mergePhase({ phase: 'working', known: true, row: EMPTY_ROW }).phase, 'working')
  assert.equal(mergePhase({ phase: 'idle', known: false, row: row('weird') }).phase, 'idle')
})

test('null / undefined 输入不炸', () => {
  assert.equal(dshStateOf(null), null)
  assert.equal(dshStateOf(undefined), null)
  assert.equal(fallbackPhase(null), 'idle')
  assert.equal(mergePhase({}).phase, 'idle')
  assert.equal(mergePhase(undefined).phase, 'idle')
})
