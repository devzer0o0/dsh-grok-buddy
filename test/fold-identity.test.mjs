/**
 * 事件折叠的时序与幂等性（缺陷 E 的回归测试）。
 *
 * 三条已复现的失败：
 *   E1 旧轮 tool/result 在 staleTurn 检查之前刷新 lastActivityAt
 *   E2 旧轮 approval/decided 清掉当前轮的新审批
 *   E3 同轮重复 turn/start 清掉在途工具
 *
 * @module test/fold-identity.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../lib/derive.js'

function harness() {
  let clock = 5_000_000
  const reg = createRegistry({ now: () => clock, ttlMs: 60 * 60 * 1000 })
  return {
    reg,
    tick(ms) { clock += ms },
    now() { return clock },
    row() { const r = reg.snapshot().sessions; return r.length === 0 ? undefined : r[0] },
    phase() { const r = this.row(); return r === undefined ? undefined : r.phase },
  }
}

const session = { id: 's1' }

test('E1 旧轮 tool/result 不能给当前静默任务续命', () => {
  const h = harness()
  // 当前轮没有在途工具（只有模型阶段），静默后应当降级为 idle；
  // 长工具不适用这条（见 E10）。
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 3 } })
  h.reg.onEvent(session, { type: 'assistant/message', data: { turn: 3 } })
  h.tick(4 * 60 * 1000)
  assert.equal(h.phase(), 'idle', '前提：当前轮已静默')

  // 旧轮（turn 2）的迟到工具结果
  h.reg.onEvent(session, {
    type: 'tool/result',
    data: { turn: 2, message: { source: { callId: 'c2' }, isError: false } },
  })
  assert.equal(h.phase(), 'idle', '旧轮事件不得把静默任务从 idle 续回 thinking')
})

test('E2 旧轮 approval/decided 不能清掉当前轮的新审批', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 2 } })
  h.reg.onEvent(session, { type: 'approval/asked', data: { turn: 2, id: 'a2', toolName: 'write' } })
  assert.equal(h.phase(), 'waiting')

  // 旧轮（turn 1）的解决事件
  h.reg.onEvent(session, { type: 'approval/decided', data: { turn: 1, id: 'a1', outcome: 'allowed-once' } })
  assert.equal(h.phase(), 'waiting', '旧轮的解决事件不得清掉当前轮的审批')
})

test('E2b 审批解决必须匹配当前有效交互的身份', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'approval/asked', data: { turn: 1, id: 'a1', toolName: 'write' } })
  // 不同 id 的解决事件
  h.reg.onEvent(session, { type: 'approval/decided', data: { turn: 1, id: 'other', outcome: 'allowed-once' } })
  assert.equal(h.phase(), 'waiting', '不匹配的解决事件不得清空审批')
  h.reg.onEvent(session, { type: 'approval/decided', data: { turn: 1, id: 'a1', outcome: 'allowed-once' } })
  assert.notEqual(h.phase(), 'waiting', '匹配的解决事件才清空')
})

test('E3 同轮重复 turn/start 必须幂等，不能清掉在途工具', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'bash' } })
  assert.equal(h.phase(), 'working')

  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(h.phase(), 'working', '同轮重复 start 不得清掉正在运行的工具')
})

test('E3b 同轮重复 turn/start 不能清掉挂起的审批', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'approval/asked', data: { turn: 1, id: 'a1', toolName: 'write' } })
  assert.equal(h.phase(), 'waiting')
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(h.phase(), 'waiting', '同轮重复 start 不得清掉挂起审批')
})

test('E4 已结束轮的重复 start 不能重新打开旧轮', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const key = h.row().completionKey
  assert.equal(h.phase(), 'done')

  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(h.phase(), 'done', '已结束轮的重复 start 不得把它重新打开')
  assert.equal(h.row().completionKey, key, '完成身份不得因此改变')
})

test('E5 迟到 agent running 不清除已确认的成功终态', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  h.reg.onAgent('s1', 'status', { status: 'running' })
  assert.equal(h.phase(), 'done')
  assert.equal(h.row().terminalKind, 'completed')
})

test('E6 仅 agent running 不足以抹除已确认的错误停止', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onAgent('s1', 'error', { turn: 1, step: 1, error: { code: 'BOOM' } })
  // 只收到 agent/error 时还不是停止（生命周期未确认）
  assert.notEqual(h.phase(), 'blocked', '单独一条 agent/error 不是停止证据')
  h.reg.onAgent('s1', 'status', { status: 'idle' })
  assert.equal(h.phase(), 'blocked', '执行器停稳确认了停止')
  h.reg.onAgent('s1', 'status', { status: 'running' })
  assert.equal(h.phase(), 'blocked', '仅 agent running 不足以宣告错误已恢复')
})

test('E6b 确认停止后，同轮真实执行恢复才退出 blocked', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'NETWORK' } } } })
  assert.equal(h.phase(), 'blocked')
  // 真正的新一轮开始
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 2 } })
  assert.notEqual(h.phase(), 'blocked', '新一轮按新事实显示')
})

test('E6c 恢复之后迟到的旧错误不会再推回 blocked', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'NETWORK' } } } })
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 2 } })
  // turn/1 的迟到错误终止事件
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'NETWORK' } } } })
  assert.notEqual(h.phase(), 'blocked')
  assert.equal(h.row().stopCertain, false, '旧轮停止事实不得套用到当前轮')
})

test('E6d 迟到旧工具成功结果不能让已确认的停止虚假恢复', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'bash' } })
  h.reg.onAgent('s1', 'error', { turn: 1, step: 1, error: { code: 'BOOM' } })
  h.reg.onAgent('s1', 'status', { status: 'idle' })
  assert.equal(h.phase(), 'blocked')
  // 执行器停下后，同轮工具结果迟到送达
  h.reg.onEvent(session, { type: 'tool/result', data: { turn: 1, message: { source: { callId: 'c1' }, isError: false } } })
  assert.equal(h.phase(), 'blocked', '迟到的旧工具成功不能复活任务')
})

test('E6e 重复的失败终态是幂等的（不刷新成新任务）', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  const end = { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'E' } } }, seq: 10, time: 1 }
  h.reg.onEvent(session, end)
  const first = h.row()
  h.tick(5000)
  h.reg.onEvent(session, end)
  const second = h.row()
  assert.equal(second.reason, first.reason)
  assert.equal(second.stopCertain, true)
  assert.equal(second.phase, 'blocked')
})

test('E6f 没有身份的错误不误绑定到当前任务', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 5 } })
  // 旧轮（turn 2）的错误终止
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { code: 'OLD' } } } })
  assert.notEqual(h.phase(), 'blocked', '旧轮错误不能污染当前轮')
})

test('E6g 带 turn 身份的旧轮 agent/error 不污染当前轮', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 5 } })
  // 旧轮（turn 3）迟到的错误（宿主真实载荷带 turn/step）
  h.reg.onAgent('s1', 'error', { turn: 3, step: 1, error: { code: 'OLD' } })
  // 就算执行器随后停稳，也不能把旧轮错误升级成当前轮的停止
  h.reg.onAgent('s1', 'status', { status: 'idle' })
  assert.notEqual(h.phase(), 'blocked', '旧轮错误不得记到当前轮')
  assert.equal(h.row().stopCertain, false)
})

test('E7 session/title 等无关事件不刷新执行活跃时间', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  // 每 45 秒来一条无关事件，累计超过 3 分钟静默阈值
  for (let i = 0; i < 6; i++) {
    h.tick(45_000)
    h.reg.onEvent(session, { type: 'session/title', data: { title: 't' + i } })
  }
  assert.equal(h.phase(), 'idle', '无关事件不能让静默任务一直显示在跑')
})

test('E8 重复 turn/end 的完成时间与身份稳定', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const first = h.row()
  h.tick(10_000)
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const second = h.row()
  assert.equal(second.completionKey, first.completionKey, '完成身份必须稳定')
  assert.equal(second.completedAt, first.completedAt, '完成时间必须稳定，不能被重放刷新')
})

test('E9 无 turn 字段的工具结果按 callId 归属，不默认归当前轮', () => {
  const h = harness()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 2 } })
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 2, callId: 'current', name: 'bash' } })
  assert.equal(h.phase(), 'working')
  // 无 turn 字段、callId 也不属于当前轮的迟到结果
  h.reg.onEvent(session, { type: 'tool/result', data: { message: { source: { callId: 'ghost' }, isError: false } } })
  assert.equal(h.phase(), 'working', '陌生 callId 的结果不能影响当前轮')
})

test('E10 长工具与有效挂起交互不被静默阈值误杀', () => {
  const tool = harness()
  tool.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  tool.reg.onEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'long' } })
  tool.tick(30 * 60 * 1000)
  assert.equal(tool.phase(), 'working')

  const wait = harness()
  wait.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  wait.reg.onEvent(session, { type: 'approval/asked', data: { turn: 1, id: 'a1', toolName: 'write' } })
  wait.tick(30 * 60 * 1000)
  assert.equal(wait.phase(), 'waiting')
})
