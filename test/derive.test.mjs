/**
 * 六态判定与事件身份测试（宿主侧）。
 *
 * 语义变化说明（相对旧的 8 态版本）：
 *   · streaming / tool / retry / error / completed 不再是状态，只在输入边界归一；
 *   · 「静默」只降级为 idle，**永不**推出 done（不拿超时/断线冒充成功）；
 *   · turn 身份参与判定：旧 turn 的迟到事件不能污染新 turn；
 *   · 完成展示按 completionKey 消费，不按会话 id 一刀切。
 *
 * @module test/derive.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PHASES, createRegistry } from '../lib/derive.js'
import { RUNTIME_PHASES } from '../src/decision.js'

function registry(startAt) {
  let clock = typeof startAt === 'number' ? startAt : 1_000_000
  const reg = createRegistry({ now: () => clock, ttlMs: 60 * 60 * 1000 })
  return {
    reg,
    tick(ms) { clock += ms },
    now() { return clock },
    snapshot() {
      const rows = reg.snapshot().sessions
      return rows.length === 0 ? undefined : rows[0]
    },
    phase() {
      const row = this.snapshot()
      return row === undefined ? undefined : row.phase
    },
  }
}

const session = { id: 's1', header: { cwd: '/tmp/proj' } }

test('状态集合严格是六种，一个不多一个不少', () => {
  assert.deepEqual([...PHASES].sort(), ['blocked', 'done', 'idle', 'thinking', 'waiting', 'working'])
  assert.deepEqual([...RUNTIME_PHASES].sort(), [...PHASES].sort())
})

test('历史输入名不再出现在输出里', () => {
  for (const legacy of ['streaming', 'tool', 'retry', 'error', 'completed']) {
    assert.equal(PHASES.indexOf(legacy), -1, legacy + ' 不该是输出状态')
  }
})

test('只有工具执行才是 working', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(h.phase(), 'thinking', '只有 turn/start 是思考，不是 working')
  h.reg.onEvent(session, { type: 'step/start', data: { turn: 1, step: 1 } })
  assert.equal(h.phase(), 'thinking', '只有 step 也不是 working')
  h.reg.onStream('s1')
  assert.equal(h.phase(), 'thinking', '模型在吐字仍是 thinking')
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'bash' } })
  assert.equal(h.phase(), 'working', '有未结束的工具调用才是 working')
  assert.equal(h.snapshot().detail, 'bash')
})

test('工具结果回来就离开 working', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'bash' } })
  h.reg.onEvent(session, { type: 'tool/result', data: { turn: 1, message: { source: { callId: 'c1' }, isError: false } } })
  assert.equal(h.phase(), 'thinking')
})

test('仅 agent running 不等于 working', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onAgent('s1', 'status', { status: 'running' })
  assert.equal(h.phase(), 'thinking', 'agent 在跑但没有工具 → thinking')
})

test('审批挂起是 waiting，决定后离开', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'approval/asked', data: { turn: 1, id: 'a1', toolName: 'write' } })
  assert.equal(h.phase(), 'waiting')
  assert.equal(h.snapshot().pendingKind, 'approval')
  h.reg.onEvent(session, { type: 'approval/decided', data: { turn: 1, id: 'a1', outcome: 'allowed-once' } })
  assert.notEqual(h.phase(), 'waiting')
})

test('挂起的提问也算 waiting（覆盖真实宿主的 userQuestions 投影）', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onPendingQuestion('s1', { kind: 'question', toolName: 'ask_user_question', callId: 'q1' })
  assert.equal(h.phase(), 'waiting')
  assert.equal(h.snapshot().pendingKind, 'question')
  h.reg.onPendingQuestion('s1', null)
  assert.notEqual(h.phase(), 'waiting', '提问被回答/取消后不再 waiting')
})

test('计划评审也归 waiting', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onPendingQuestion('s1', { kind: 'plan-review', toolName: 'ask_user_question', callId: 'p1' })
  assert.equal(h.phase(), 'waiting')
  assert.equal(h.snapshot().pendingKind, 'plan-review')
})

test('等待优先于工具执行', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'bash' } })
  h.reg.onEvent(session, { type: 'approval/asked', data: { turn: 1, id: 'a1', toolName: 'bash' } })
  assert.equal(h.phase(), 'waiting')
})

test('当前有效错误是 blocked，后续成功把它救回来', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'bash' } })
  h.reg.onEvent(session, {
    type: 'tool/result',
    data: { turn: 1, message: { source: { callId: 'c1' }, isError: true, error: { code: 'ENOENT' } } },
  })
  assert.equal(h.phase(), 'blocked')
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c2', name: 'bash' } })
  h.reg.onEvent(session, { type: 'tool/result', data: { turn: 1, message: { source: { callId: 'c2' }, isError: false } } })
  assert.equal(h.phase(), 'thinking', '历史错误不能永久霸占 blocked')
})

test('致命错误压过挂起交互：agent 崩了，等人也没意义', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'approval/asked', data: { turn: 1, id: 'a1', toolName: 'write' } })
  h.reg.onAgent('s1', 'error', { error: { code: 'BOOM' } })
  assert.equal(h.phase(), 'blocked')
})

test('重试归 blocked，重试真正开始后回到思考', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'llm/retry', data: { turn: 1, retry: 2, maxRetries: 5, failure: { code: 'RATE_LIMIT' } } })
  assert.equal(h.phase(), 'blocked')
  h.reg.onEvent(session, { type: 'llm/retry-started', data: { turn: 1, retry: 2 } })
  assert.equal(h.phase(), 'thinking')
})

test('正常终态是 done，错误终态是 blocked，取消终态是 idle', () => {
  const ok = registry()
  ok.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  ok.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(ok.phase(), 'done')

  const bad = registry()
  bad.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  bad.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA' } } } })
  assert.equal(bad.phase(), 'blocked')

  const cancelled = registry()
  cancelled.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  cancelled.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  assert.equal(cancelled.phase(), 'idle', '取消/中断不是成功，也不是已阻止')
})

test('中间接入只见 turn/end、随后收到 running：保留终态', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  assert.equal(h.phase(), 'done')
  h.reg.onAgent('s1', 'status', { status: 'running' })
  assert.equal(h.phase(), 'done', '迟到的 running 不能把 done 续成 working/thinking')
  h.reg.onAgent('s1', 'status', { status: 'idle' })
  assert.equal(h.phase(), 'done', 'status=idle 之后仍是 done')
})

test('过期 turn 收到 agent idle 不会被重新续成 working', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'bash' } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  h.tick(30_000)
  h.reg.onAgent('s1', 'status', { status: 'idle' })
  assert.equal(h.phase(), 'done')
})

test('无关事件不能延长任务生命，也不会推出成功', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'step/start', data: { turn: 1, step: 1 } })
  assert.equal(h.phase(), 'thinking')
  for (let i = 0; i < 5; i++) {
    h.tick(60_000)
    h.reg.onEvent(session, { type: 'session/title', data: { title: 'x' + i } })
  }
  assert.equal(h.phase(), 'idle', '单纯沉默只能降级为 idle，绝不伪造成 done')
})

test('旧 turn 的 step / tool 事件不污染新 turn', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 2 } })
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'old', name: 'bash' } })
  assert.equal(h.phase(), 'thinking', '旧 turn 的迟到工具调用不能把新一轮变成 working')
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 2, callId: 'new', name: 'bash' } })
  assert.equal(h.phase(), 'working')
})

test('重复 turn/end 不生成新的完成周期', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const first = h.snapshot().completionKey
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const second = h.snapshot().completionKey
  assert.equal(first, second, '同一条完成记录的身份必须稳定')
})

test('新 turn 开始后，旧 done 不再覆盖真实状态', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(h.phase(), 'done')
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 2 } })
  assert.equal(h.phase(), 'thinking', '新一轮开始，旧完成事实被替代')
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 2, callId: 'c1', name: 'bash' } })
  assert.equal(h.phase(), 'working')
})

test('新一轮完成建立新的完成展示周期', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const first = h.snapshot().completionKey
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 2 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  const second = h.snapshot().completionKey
  assert.notEqual(first, second, '新的一轮完成是新的完成身份')
})

test('done 带 completedAt 与稳定 completionKey', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const row = h.snapshot()
  assert.equal(row.phase, 'done')
  assert.equal(typeof row.completedAt, 'number')
  assert.equal(typeof row.completionKey, 'string')
  assert.notEqual(row.completionKey, '')
})

test('合法长工具与长等待审批不因静默被误判', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'long' } })
  h.tick(20 * 60 * 1000)
  assert.equal(h.phase(), 'working', '长工具不能被静默阈值打断')

  const w = registry()
  w.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  w.reg.onEvent(session, { type: 'approval/asked', data: { turn: 1, id: 'a1', toolName: 'write' } })
  w.tick(20 * 60 * 1000)
  assert.equal(w.phase(), 'waiting', '长时间等人不能被静默阈值打断')
})

test('标题与 cwd 会被记下来', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'session/title', data: { title: '修 bug' } })
  h.reg.onEvent(session, { type: 'working-directory/change', data: { cwd: '/a/b/c' } })
  const st = h.reg.peek('s1')
  assert.equal(st.title, '修 bug')
  assert.equal(st.dir, 'c')
})

test('agent 中途接入（没见过 turn/start）时 running 仍能兜底', () => {
  const h = registry()
  h.reg.onAgent('s1', 'status', { status: 'running' })
  assert.equal(h.phase(), 'thinking')
})

// ── 多个挂起交互：按身份管理，不用一个槽位丢掉其他 ──────────────────────────

test('两条提问：答掉第一条之后仍然是 waiting', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'question/asked', data: { turn: 1, id: 'q1', questions: [{ id: 'q1' }] } })
  h.reg.onEvent(session, { type: 'question/asked', data: { turn: 1, id: 'q2', questions: [{ id: 'q2' }] } })
  assert.equal(h.phase(), 'waiting')
  h.reg.onEvent(session, { type: 'question/answered', data: { turn: 1, id: 'q1' } })
  assert.equal(h.phase(), 'waiting', '还有 q2 在等，不能掉成 thinking')
  h.reg.onEvent(session, { type: 'question/answered', data: { turn: 1, id: 'q2' } })
  assert.equal(h.phase(), 'thinking', '两条都答完才离开 waiting')
})

test('审批 + 提问同时挂起：解决审批后提问仍让它 waiting', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'approval/asked', data: { turn: 1, id: 'a1', toolName: 'write' } })
  h.reg.onEvent(session, { type: 'question/asked', data: { turn: 1, id: 'q1', questions: [{ id: 'q1' }] } })
  assert.equal(h.phase(), 'waiting')
  h.reg.onEvent(session, { type: 'approval/decided', data: { turn: 1, id: 'a1' } })
  assert.equal(h.phase(), 'waiting', '提问还挂着，不能因为审批解决就离开')
  assert.equal(h.snapshot().detail.indexOf('question') !== -1, true, '细节要指向还挂着的那条')
  h.reg.onEvent(session, { type: 'question/answered', data: { turn: 1, id: 'q1' } })
  assert.equal(h.phase(), 'thinking')
})

test('阻塞式交互工具 + 事件审批：结果回来只解决它自己那一条', () => {
  const h = registry()
  h.reg.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.reg.onEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'ask_user_question' } })
  h.reg.onEvent(session, { type: 'approval/asked', data: { turn: 1, id: 'a1', toolName: 'write' } })
  assert.equal(h.phase(), 'waiting')
  h.reg.onEvent(session, { type: 'tool/result', data: { turn: 1, message: { source: { callId: 'c1' } } } })
  assert.equal(h.phase(), 'waiting', '审批还挂着')
  h.reg.onEvent(session, { type: 'approval/decided', data: { turn: 1, id: 'a1' } })
  assert.equal(h.phase(), 'thinking')
})
