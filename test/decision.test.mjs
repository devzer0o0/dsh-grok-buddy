/**
 * 统一决策表的测试：六态 + 展示输入（消费 / 失效）。
 *
 * 这是**唯一**的判定入口，宿主与页面都走它，所以这里把边界一条条钉死。
 *
 * @module test/decision.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DONE_DISPLAY_TTL_MS,
  LEGACY_PHASE_INPUT,
  RUNTIME_PHASES,
  TURN_SILENCE_TTL_MS,
  completionKeyOf,
  decide,
  emptyFacts,
  endingOf,
  isCompletionLive,
  normalizePhaseInput,
} from '../src/decision.js'

const NOW = 2_000_000

function facts(overrides) {
  const base = emptyFacts('s1')
  base.turnKey = 's1#1'
  base.sampledAt = NOW
  base.lastActivityAt = NOW
  return { ...base, ...(overrides === undefined ? {} : overrides) }
}

test('六态集合严格', () => {
  assert.deepEqual([...RUNTIME_PHASES].sort(), ['blocked', 'done', 'idle', 'thinking', 'waiting', 'working'])
})

test('历史输入名只在边界归一，不成为输出状态', () => {
  assert.equal(normalizePhaseInput('streaming'), 'thinking')
  assert.equal(normalizePhaseInput('tool'), 'working')
  assert.equal(normalizePhaseInput('retry'), 'blocked')
  assert.equal(normalizePhaseInput('error'), 'blocked')
  assert.equal(normalizePhaseInput('completed'), 'done')
  assert.equal(normalizePhaseInput('nonsense'), 'idle')
  assert.equal(normalizePhaseInput(undefined), 'idle')
  for (const legacy of Object.keys(LEGACY_PHASE_INPUT)) {
    assert.equal(RUNTIME_PHASES.includes(legacy), false)
  }
})

test('空会话是 idle', () => {
  assert.equal(decide(facts(), { now: NOW }).phase, 'idle')
})

test('工具执行才是 working', () => {
  const f = facts({ turnOpen: true, tools: [{ callId: 'c1', name: 'bash' }] })
  const v = decide(f, { now: NOW })
  assert.equal(v.phase, 'working')
  assert.match(v.reason, /tool:bash/)
})

test('无工具的模型生成归 thinking', () => {
  const f = facts({ turnOpen: true, modelPhase: 'generating', tools: [] })
  assert.equal(decide(f, { now: NOW }).phase, 'thinking')
})

test('仅 agent running 不等于 working', () => {
  const f = facts({ turnOpen: false, agentRunning: true, modelPhase: 'requested' })
  assert.equal(decide(f, { now: NOW }).phase, 'thinking')
})

test('审批、提问、计划评审都归 waiting', () => {
  for (const kind of ['approval', 'question', 'plan-review']) {
    const f = facts({ turnOpen: true, tools: [{ callId: 'c', name: 'bash' }], pendingInteraction: { kind } })
    const v = decide(f, { now: NOW })
    assert.equal(v.phase, 'waiting', kind + ' 应该是 waiting')
  }
})

test('有效错误是 blocked，且压过挂起交互', () => {
  const loud = facts({ turnOpen: true, error: { code: 'X' } })
  assert.equal(decide(loud, { now: NOW }).phase, 'blocked')
  const both = facts({ turnOpen: true, error: { code: 'X' }, pendingInteraction: { kind: 'approval' } })
  assert.equal(decide(both, { now: NOW }).phase, 'blocked', 'agent 崩了，等人也没意义')
})

test('成功终态是 done，错误终态是 blocked，取消终态是 idle', () => {
  assert.equal(decide(facts({ terminal: { kind: 'completed', turnKey: 's1#1', completedAt: NOW } }), { now: NOW }).phase, 'done')
  assert.equal(decide(facts({ terminal: { kind: 'error', turnKey: 's1#1' } }), { now: NOW }).phase, 'blocked')
  assert.equal(decide(facts({ terminal: { kind: 'interrupted', turnKey: 's1#1' } }), { now: NOW }).phase, 'idle')
})

test('活跃 done 保持 done（不因静默阈值降级）', () => {
  const f = facts({ terminal: { kind: 'completed', turnKey: 's1#1', completedAt: NOW - 1000 } })
  assert.equal(decide(f, { now: NOW }).phase, 'done')
})

test('查看并切走（consumed）→ idle', () => {
  const f = facts({ terminal: { kind: 'completed', turnKey: 's1#1', completedAt: NOW - 1000 } })
  const v = decide(f, { now: NOW, consumed: true })
  assert.equal(v.phase, 'idle')
  assert.equal(v.reason, 'completion-consumed')
  assert.equal(v.done, false)
})

test('完成展示失活 → idle，但完成事实仍在', () => {
  const terminal = { kind: 'completed', turnKey: 's1#1', completedAt: NOW - DONE_DISPLAY_TTL_MS - 1 }
  const f = facts({ terminal })
  const v = decide(f, { now: NOW })
  assert.equal(v.phase, 'idle')
  assert.equal(v.reason, 'completion-expired')
  assert.equal(f.terminal, terminal, '完成事实不得被删除')
})

test('缺 completedAt 的完成：用观测锚点也能消费与失活', () => {
  const terminal = { kind: 'completed', turnKey: 's1#1' }
  const key = completionKeyOf('s1', terminal)
  assert.equal(key, 's1#1')
  // 刚观测到 → 仍活跃
  assert.equal(decide(facts({ terminal }), { now: NOW, observedAt: NOW - 1000 }).phase, 'done')
  // 观测很久之前 → 失活
  assert.equal(
    decide(facts({ terminal }), { now: NOW, observedAt: NOW - DONE_DISPLAY_TTL_MS - 1 }).phase,
    'idle',
    '没有 completedAt 也不能永远活跃',
  )
  // 被消费 → idle
  assert.equal(decide(facts({ terminal }), { now: NOW, consumed: true }).phase, 'idle')
})

test('isCompletionLive 对非成功终态一律 false', () => {
  assert.equal(isCompletionLive({ terminal: { kind: 'error' }, now: NOW }), false)
  assert.equal(isCompletionLive({ terminal: undefined, now: NOW }), false)
})

test('沉默只降级为 idle，绝不推出 done', () => {
  const f = facts({ turnOpen: true, modelPhase: 'requested', lastActivityAt: NOW - TURN_SILENCE_TTL_MS - 1 })
  const v = decide(f, { now: NOW })
  assert.equal(v.phase, 'idle')
  assert.equal(v.reason, 'silent-turn')
})

test('长工具与长等待不受静默阈值影响', () => {
  const tool = facts({ turnOpen: true, tools: [{ callId: 'c', name: 'long' }], lastActivityAt: NOW - 10 * 60 * 1000 })
  assert.equal(decide(tool, { now: NOW }).phase, 'working')
  const wait = facts({ turnOpen: true, pendingInteraction: { kind: 'approval' }, lastActivityAt: NOW - 10 * 60 * 1000 })
  assert.equal(decide(wait, { now: NOW }).phase, 'waiting')
})

test('终态归属：completed / error / aborted 各归各位', () => {
  assert.equal(endingOf('completed'), 'success')
  assert.equal(endingOf('error'), 'failure')
  assert.equal(endingOf('blocked'), 'failure')
  assert.equal(endingOf('aborted'), 'neutral')
  assert.equal(endingOf('max-tokens'), 'neutral')
  assert.equal(endingOf('who-knows'), 'neutral')
  assert.equal(endingOf(undefined), 'neutral')
})

test('完成身份稳定：同一 turnKey 的 key 不变，缺 turnKey 也有稳定值', () => {
  assert.equal(completionKeyOf('s1', { turnKey: 's1#3' }), 's1#3')
  assert.equal(completionKeyOf('s1', { turnKey: 's1#3', completionKey: 'custom' }), 'custom')
  const noTurn = completionKeyOf('s1', { kind: 'completed' })
  assert.equal(noTurn, 's1#unknown-turn')
  assert.equal(completionKeyOf('s1', { kind: 'completed' }), noTurn, '多次调用必须一致')
})

test('空事实 / 怪输入不炸', () => {
  assert.equal(decide(undefined).phase, 'idle')
  assert.equal(decide(null, null).phase, 'idle')
  assert.equal(decide({}, {}).phase, 'idle')
  assert.equal(decide({ turnOpen: true }).phase, 'thinking')
})
