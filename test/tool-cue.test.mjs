import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceToolCue, toolCueActive, TOOL_CUE_MS } from '../src/widget/tool-cue.js'
import { createRegistry } from '../lib/derive.js'
import { decide, emptyFacts } from '../src/decision.js'

const now = 100000
const entry = { phase: 'thinking', turnKey: 's#1', toolActivityKey: 's:tool:1', toolActivityAt: now - 20, toolActivityTurnKey: 's#1' }

test('短工具调用补一段 650ms 动效；同一调用不因轮询续期', () => {
  const cue = advanceToolCue(undefined, entry, now)
  assert.equal(cue.until, now + TOOL_CUE_MS)
  assert.equal(toolCueActive(cue, 'thinking', now), true)
  assert.deepEqual(advanceToolCue(cue, entry, now + 500), cue)
  assert.equal(toolCueActive(cue, 'thinking', cue.until), false)
  assert.equal(advanceToolCue(cue, entry, now + 1000).until, cue.until)
})

test('不覆盖完成、等待、停止、空闲；相同调用之后不重播', () => {
  for (const phase of ['done', 'waiting', 'blocked', 'idle']) {
    const cue = advanceToolCue(advanceToolCue(undefined, entry, now), { ...entry, phase }, now + 1)
    assert.equal(cue.until, 0)
    assert.equal(advanceToolCue(cue, entry, now + 10).until, 0)
    assert.equal(toolCueActive({ until: now + 100 }, phase, now), false)
  }
})

test('隐藏、减少动态、陈旧、未来、缺失及跨轮证据都不补播', () => {
  for (const e of [
    { ...entry, toolActivityAt: now - 1501 }, { ...entry, toolActivityAt: now + 1 },
    { ...entry, toolActivityAt: undefined }, { ...entry, toolActivityKey: '' },
    { ...entry, toolActivityTurnKey: 's#0' }, { ...entry, turnKey: '' },
  ]) assert.equal(advanceToolCue(undefined, e, now).until, 0)
  const hidden = advanceToolCue(undefined, entry, now, false)
  assert.equal(hidden.until, 0)
  assert.equal(advanceToolCue(hidden, entry, now + 1, true).until, 0)
})

test('在途工具自身就是执行证据，不依赖见过 turn/start 或 agent/status', () => {
  const f = emptyFacts('s')
  f.tools = [{ callId: 'a', name: 'bash' }]
  assert.equal(decide(f, { now }).phase, 'working')
})

for (const name of ['bash', 'exec_command', 'shell', 'read_file', 'mcp__test__fetch', 'arbitrary_extension_tool']) {
  test(`${name}：中途接入 → working，流式输出不抢占，并发工具全部结束后才 thinking`, () => {
    let at = now
    const reg = createRegistry({ now: () => at })
    const event = (type, data) => reg.onEvent({ id: 's' }, { type, data: { turn: 3, ...data } })
    const row = () => reg.snapshot().sessions[0]
    event('tool/call', { callId: 'a', name })
    assert.equal(row().phase, 'working')
    assert.equal(row().turnKey, 's#3')
    const cue = row().toolActivityKey
    event('tool/call', { callId: 'a', name })
    assert.equal(row().toolActivityKey, cue, '重复 call 不重新触发')
    event('tool/call', { callId: 'b', name })
    reg.onStream('s', { turn: 3 })
    assert.equal(row().phase, 'working')
    at += 20
    event('tool/result', { message: { source: { callId: 'a' } } })
    assert.equal(row().phase, 'working')
    event('tool/result', { message: { source: { callId: 'b' } } })
    assert.equal(row().phase, 'thinking')
    assert.ok(row().toolActivityKey, '轮询漏过的短调用仍有动效证据')
    event('turn/end', { reason: { kind: 'completed' } })
    assert.equal(row().phase, 'done')
    assert.equal(row().toolActivityKey, '')
    event('tool/call', { callId: 'late', name })
    assert.equal(row().phase, 'done')
    assert.equal(row().toolActivityKey, '', '封账后迟到调用不能触发动效')
  })
}

test('审批/提问不伪装成 working，新轮不继承旧轮动效', () => {
  const reg = createRegistry({ now: () => now })
  const event = (type, data) => reg.onEvent({ id: 's' }, { type, data })
  event('tool/call', { turn: 1, callId: 'ask', name: 'ask_user_question' })
  let row = reg.snapshot().sessions[0]
  assert.equal(row.phase, 'waiting'); assert.equal(row.toolActivityKey, '')
  event('turn/start', { turn: 2 })
  event('tool/call', { turn: 2, callId: 'bash', name: 'bash' })
  assert.ok(reg.snapshot().sessions[0].toolActivityKey)
  event('turn/start', { turn: 3 })
  event('tool/call', { turn: 2, callId: 'old', name: 'bash' })
  row = reg.snapshot().sessions[0]
  assert.equal(row.phase, 'thinking'); assert.equal(row.toolActivityKey, '')
})
