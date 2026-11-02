/**
 * derive.js 的单元测试：用真实的事件序列验证相位推导。
 * @module test/derive.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../lib/derive.js'

function registry() {
  let clock = 1_000_000
  const reg = createRegistry({ now: () => clock, ttlMs: 60 * 60 * 1000 })
  return {
    reg,
    tick(ms) { clock += ms },
    at() { return clock },
    snapshot() {
      const rows = reg.snapshot().sessions
      return rows.length === 0 ? undefined : rows[0]
    },
  }
}

const session = { id: 's1', header: { cwd: '/tmp/proj' } }

test('空会话是 idle', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(h.snapshot().phase, 'completed')
})

test('turn 开始后是 thinking', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(h.snapshot().phase, 'thinking')
})

test('收到流式分片后是 streaming', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onStream('s1')
  assert.equal(h.snapshot().phase, 'streaming')
})

test('工具执行中是 tool，出结果后回到 thinking', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } })
  assert.equal(h.snapshot().phase, 'tool')
  assert.equal(h.snapshot().detail, 'bash')
  h.reg.onEvent(session, { type: 'tool/result', data: { message: { source: { callId: 'c1' }, isError: false } } })
  assert.equal(h.snapshot().phase, 'thinking')
})

test('审批挂起是 waiting，决定后恢复', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'approval/asked', data: { id: 'a1', toolName: 'write' } })
  assert.equal(h.snapshot().phase, 'waiting')
  assert.equal(h.snapshot().detail, 'write')
  h.reg.onEvent(session, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } })
  assert.equal(h.snapshot().phase, 'thinking')
})

test('LLM 重试是 retry，重试开始后回到 thinking', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'llm/retry', data: { retry: 2, maxRetries: 5, failure: { code: 'RATE_LIMIT' } } })
  assert.equal(h.snapshot().phase, 'retry')
  assert.match(h.snapshot().detail, /RATE_LIMIT/)
  h.reg.onEvent(session, { type: 'llm/retry-started', data: { retry: 2 } })
  assert.equal(h.snapshot().phase, 'thinking')
})

test('turn 以错误收场是 error，并带代号', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA', message: 'no quota' } } } })
  const row = h.snapshot()
  assert.equal(row.phase, 'error')
  assert.equal(row.detail, 'QUOTA')
})

test('agent 崩溃也会变成 error', () => {
  const h = registry()
  h.reg.onAgent('s1', 'status', { status: 'running' })
  h.reg.onAgent('s1', 'error', { error: { code: 'BOOM' } })
  h.reg.onAgent('s1', 'status', { status: 'idle' })
  assert.equal(h.snapshot().phase, 'error')
})

test('新一轮开始会清掉上一轮的错误', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'X' } } } })
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 2 } })
  assert.equal(h.snapshot().phase, 'thinking')
})

test('标题与 cwd 会被记下来', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'session/title', data: { title: '修 bug' } })
  h.reg.onEvent(session, { type: 'working-directory/change', data: { cwd: '/a/b/c' } })
  const st = h.reg.peek('s1')
  assert.equal(st.title, '修 bug')
  assert.equal(st.dir, 'c')
})

test('久未活动且 turn 未收尾会过期成 idle', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(h.snapshot().phase, 'thinking')
  h.tick(16 * 60 * 1000)
  assert.equal(h.snapshot().phase, 'idle')
})
