/**
 * blocked 的验收口径（本文件是用户验收定义的**可执行版本**）。
 *
 *   blocked = 当前会话对应的当前任务，已被确认因错误而停止执行，
 *             且该停止事实尚未被真实恢复执行或新任务替代。
 *
 * 因此这里必须同时钉死两件事：
 *   · 不能**误报**（证据不足 / 迟到事件 / 取消 / 拒绝 / 观察链路）
 *   · 不能**漏报**（真正的错误终止必须显示 blocked，直到被新一轮取代）
 *
 * @module test/blocked-acceptance.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../lib/derive.js'

function harness() {
  let clock = 9_000_000
  const reg = createRegistry({ now: () => clock, ttlMs: 60 * 60 * 1000 })
  return {
    reg,
    tick(ms) { clock += ms },
    row() { const r = reg.snapshot().sessions; return r.length === 0 ? undefined : r[0] },
    phase() { const r = this.row(); return r === undefined ? undefined : r.phase },
    facts() { return reg.peek('s1').facts },
    event(type, data, seq) { reg.onEvent(session, seq === undefined ? { type, data } : { type, data, seq }) },
    agent(kind, payload) { reg.onAgent('s1', kind, payload) },
  }
}

const session = { id: 's1' }
const FAIL = { kind: 'error', error: { code: 'TRANSPORT', message: 'synthetic acceptance only' } }

// ── 对照：真实宿主词汇下的正向行为（不能被误伤）────────────────────────────

test('对照：turn/end reason=error 是 blocked', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: FAIL }, 20)
  assert.equal(h.phase(), 'blocked')
  assert.equal(h.row().stopCertain, true)
  assert.equal(h.row().stopSource, 'turn/end:error')
})

test('对照：有效的自动重试保持 thinking，不产生停止事实', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('llm/retry', { turn: 1, step: 1, retryId: 'r1', retry: 1, delayMs: 8000, failure: { code: 'TRANSPORT' } }, 11)
  assert.equal(h.phase(), 'thinking')
  assert.equal(h.row().stopCertain, false)
})

test('对照：工具失败本身不是 blocked', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('tool/call', { turn: 1, step: 1, callId: 't1', name: 'bash' }, 11)
  h.event('tool/result', { turn: 1, step: 1, message: { source: { callId: 't1' }, isError: true }, error: { code: 'EXIT_1' } }, 12)
  h.event('step/start', { turn: 1, step: 2 }, 13)
  assert.notEqual(h.phase(), 'blocked')
})

test('对照：新一轮替代已停止的任务', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: FAIL }, 20)
  assert.equal(h.phase(), 'blocked')
  h.event('turn/start', { turn: 2 }, 30)
  assert.equal(h.phase(), 'thinking')
  assert.equal(h.row().stopCertain, false)
})

test('对照：用户取消不是 blocked，也不留下停止事实', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 20)
  assert.equal(h.phase(), 'idle')
  assert.equal(h.row().stopCertain, false)
})

// ── 误报一：迟到 / 乱序事件 ─────────────────────────────────────────────

test('迟到：旧 seq 的同轮 step/start 不能抹掉已确认停止', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: FAIL }, 20)
  h.event('step/start', { turn: 1, step: 1 }, 11)
  assert.equal(h.phase(), 'blocked', 'seq 门闸必须丢弃迟到的旧事件')
})

test('迟到：更旧的失败 turn/end 不能覆盖已成功的 done', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 30)
  h.event('turn/end', { turn: 1, reason: FAIL }, 20)
  assert.equal(h.phase(), 'done')
  assert.equal(h.row().stopCertain, false)
})

test('迟到：更旧的 turn/start 不能把任务退回上一轮', () => {
  const h = harness()
  h.event('turn/start', { turn: 2 }, 20)
  h.event('tool/call', { turn: 2, step: 1, callId: 'now', name: 'bash' }, 21)
  assert.equal(h.phase(), 'working')
  h.event('turn/start', { turn: 1 }, 10)
  assert.equal(h.facts().turnKey, 's1#2')
  assert.equal(h.phase(), 'working')
})

test('迟到：无 seq 的旧轮 turn/start 同样被 turn 单调守卫挡住', () => {
  const h = harness()
  h.event('turn/start', { turn: 2 })
  h.event('tool/call', { turn: 2, step: 1, callId: 'now', name: 'bash' })
  h.event('turn/start', { turn: 1 })
  assert.equal(h.facts().turnKey, 's1#2')
  assert.equal(h.facts().tools.length, 1)
})

test('封账：turn/end 之后同轮事件不复活任务', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: FAIL }, 20)
  // 真实宿主里 turn/end 写在 finally：之后同轮不可能再有执行证据。
  h.event('step/start', { turn: 1, step: 2 }, 21)
  h.event('tool/call', { turn: 1, step: 2, callId: 'ghost', name: 'bash' }, 22)
  assert.equal(h.phase(), 'blocked', '只有新一轮 turn/start 能取代停止')
  assert.equal(h.row().stopCertain, true)
})

// ── 误报二：证据不足的确认路径 ──────────────────────────────────────────

test('身份：没有 turn 的 agent/error 只作诊断，idle 不能确认停止', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.agent('error', { error: { code: 'E_OBSERVER' } })
  h.agent('status', { status: 'idle' })
  assert.notEqual(h.phase(), 'blocked')
  assert.equal(h.row().stopCertain, false)
  assert.equal(h.facts().error.code, 'E_OBSERVER', '诊断仍要保留')
})

test('状态：缺 status 字段 / 未知状态词都不确认停止', () => {
  for (const payload of [{}, { status: 'starting' }]) {
    const h = harness()
    h.event('turn/start', { turn: 1 }, 10)
    h.agent('error', { turn: 1, step: 1, error: { code: 'E_OBSERVER' } })
    h.agent('status', payload)
    assert.equal(h.row().stopCertain, false, JSON.stringify(payload))
    assert.notEqual(h.phase(), 'blocked')
  }
})

test('对照：带身份的 agent/error + 显式 idle 才确认停止', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.agent('error', { turn: 1, step: 1, error: { code: 'BOOT_FAIL' } })
  h.agent('status', { status: 'idle' })
  assert.equal(h.phase(), 'blocked')
  assert.equal(h.row().stopSource, 'agent/error+agent/status:idle')
})

test('取消：parent / hook 的中断不猜测因果', () => {
  for (const kind of ['parent', 'hook']) {
    const h = harness()
    h.event('turn/start', { turn: 1 }, 10)
    h.agent('error', { turn: 1, step: 1, error: { code: 'FLUSH' } })
    h.event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind } } }, 20)
    assert.equal(h.phase(), 'idle', kind)
    assert.equal(h.row().stopCertain, false, kind)
  }
})

test('拒绝：preStep 的 turn/end:blocked 不是错误停止', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: { kind: 'blocked' } }, 20)
  assert.equal(h.phase(), 'idle')
  assert.equal(h.row().stopCertain, false)
})

test('拒绝：宿主在 blocked 上附带 error 也不自封为权威错误终局', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: { kind: 'blocked', error: { code: 'E_POLICY' } } }, 20)
  // preStep 拒绝的终局种类是 'blocked'，不是 'error'。载荷里出现一个 error 对象
  // 不足以证明「任务因错误停止」—— 不猜测因果，显示 idle。
  assert.equal(h.phase(), 'idle')
  assert.equal(h.row().stopCertain, false)
})

// ── 漏报：真实恢复必须退出 blocked ──────────────────────────────────────

test('恢复：idle 路径的停止在开着的轮里被真实执行证据推翻', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.agent('error', { turn: 1, step: 1, error: { code: 'BOOT_FAIL' } })
  h.agent('status', { status: 'idle' })
  assert.equal(h.phase(), 'blocked')
  // 轮还开着（turn/end 没写成），同轮出现新的执行证据 = 真的又跑起来了。
  h.event('step/start', { turn: 1, step: 2 }, 11)
  h.event('tool/call', { turn: 1, step: 2, callId: 'again', name: 'bash' }, 12)
  assert.equal(h.phase(), 'working')
  assert.equal(h.row().stopCertain, false)
})

test('恢复：成功终态不会被迟到的错误停止覆盖', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.agent('error', { turn: 1, step: 1, error: { code: 'FLUSH' } })
  h.event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20)
  h.agent('status', { status: 'idle' })
  assert.equal(h.phase(), 'done')
  assert.equal(h.row().stopCertain, false)
})

// ── 重试与静默的先后 ───────────────────────────────────────────────────

test('重试：长期退避期间不因静默降到 idle', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('llm/retry', { turn: 1, step: 1, retryId: 'r1', retry: 1, delayMs: 240_000, failure: { code: 'TRANSPORT' } }, 11)
  h.tick(4 * 60 * 1000)
  assert.equal(h.phase(), 'thinking', '有效重试先于静默判定')
})

test('重试：陈旧调度超过有效期后落回 idle', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('llm/retry', { turn: 1, step: 1, retryId: 'r1', retry: 1, delayMs: 1000, failure: { code: 'TRANSPORT' } }, 11)
  h.tick(11 * 60 * 1000)
  assert.equal(h.phase(), 'idle')
})
// ── 误报三：终局账本必须覆盖**所有**结束类型，不是只封错误停止 ────────────

test('封账：completed 之后迟到的同轮 error 终局不能把 done 改成 blocked', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20)
  assert.equal(h.phase(), 'done')
  h.event('turn/end', { turn: 1, reason: FAIL }, 21)
  assert.equal(h.phase(), 'done', '这一轮已经有了成功终局')
  assert.equal(h.row().stopCertain, false)
})

test('封账：用户取消之后迟到的同轮 error 终局不能把 idle 改成 blocked', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 20)
  h.event('turn/end', { turn: 1, reason: FAIL }, 21)
  assert.equal(h.phase(), 'idle')
  assert.equal(h.row().stopCertain, false)
})

test('封账：取消之后迟到的 agent/error + idle 也不能确认停止', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 20)
  h.agent('error', { turn: 1, step: 1, error: { code: 'LATE' } })
  h.agent('status', { status: 'idle' })
  assert.equal(h.phase(), 'idle')
  assert.equal(h.row().stopCertain, false)
})

test('封账：preStep 拒绝之后迟到的 agent/error + idle 也不能确认停止', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: { kind: 'blocked' } }, 20)
  h.agent('error', { turn: 1, step: 1, error: { code: 'LATE' } })
  h.agent('status', { status: 'idle' })
  assert.equal(h.phase(), 'idle')
  assert.equal(h.row().stopCertain, false)
})

test('封账：completed 之后迟到的同轮流式分片与工具调用都不复活任务', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20)
  h.reg.onStream('s1', { turn: 1 })
  h.event('tool/call', { turn: 1, step: 2, callId: 'ghost', name: 'bash' }, 21)
  assert.equal(h.phase(), 'done')
  assert.equal(h.facts().tools.length, 0)
})

test('因果：无终局的 error+idle 停止被随后的权威取消终局清除', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.agent('error', { turn: 1, step: 1, error: { code: 'BOOT' } })
  h.agent('status', { status: 'idle' })
  assert.equal(h.phase(), 'blocked')
  h.event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 20)
  assert.equal(h.phase(), 'idle')
  assert.equal(h.row().stopCertain, false)
})

test('因果：兜底确认不接受已封账轮的 idle', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20)
  h.agent('error', { turn: 1, step: 1, error: { code: 'FLUSH' } })
  h.agent('status', { status: 'idle' })
  assert.equal(h.phase(), 'done')
})

// ── 误报四：身份与恢复证据必须先校验，再改执行事实 ──────────────────────

test('身份：缺 turn 的 turn/end 不能凭空绑定当前任务', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { reason: FAIL }, 20)
  assert.notEqual(h.phase(), 'blocked')
  assert.equal(h.row().stopCertain, false)
})

test('身份：旧轮错误不能给已静默的当前任务续命', () => {
  const h = harness()
  h.event('turn/start', { turn: 2 }, 20)
  h.tick(3 * 60 * 1000 + 1)
  assert.equal(h.phase(), 'idle')
  h.agent('error', { turn: 1, step: 1, error: { code: 'OLD' } })
  assert.equal(h.phase(), 'idle', '旧轮错误不是当前任务的执行证据')
})

test('身份：无 turn 的诊断错误不能给已静默的当前任务续命', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.tick(3 * 60 * 1000 + 1)
  assert.equal(h.phase(), 'idle')
  h.agent('error', { error: { code: 'DIAGNOSTIC' } })
  assert.equal(h.phase(), 'idle')
})

test('身份：没有调用标识的 tool/call 不构成真实恢复', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.agent('error', { turn: 1, step: 1, error: { code: 'BOOT' } })
  h.agent('status', { status: 'idle' })
  assert.equal(h.phase(), 'blocked')
  h.event('tool/call', { turn: 1, step: 2 }, 11)
  assert.equal(h.phase(), 'blocked', '缺 callId 的调用不是执行证据')
})

test('身份：没有 turn 的 step/start 不能替代已确认的停止', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.agent('error', { turn: 1, step: 1, error: { code: 'BOOT' } })
  h.agent('status', { status: 'idle' })
  assert.equal(h.phase(), 'blocked')
  h.event('step/start', { step: 2 }, 11)
  assert.equal(h.phase(), 'blocked', '无法证明属于当前轮的「新一步」不能复活任务')
})

test('状态：未知状态词必须完全忽略，不能改运行标志', () => {
  const h = harness()
  h.agent('status', { status: 'running' })
  assert.equal(h.facts().agentRunning, true)
  h.agent('status', { status: 'unknown' })
  assert.equal(h.facts().agentRunning, true)
})

// ── 误报五：停止事实不能随时间消失，元数据不能被困死 ────────────────────

test('寿命：已确认的错误停止不受普通缓存 TTL 回收', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: FAIL }, 20)
  assert.equal(h.phase(), 'blocked')
  h.tick(60 * 60 * 1000 + 1)
  assert.equal(h.phase(), 'blocked', '还没被恢复/替代的停止事实不能被忘掉')
  assert.equal(h.row().stopCertain, true)
})

test('元数据：任务收尾后标题与工作目录仍可更新', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('turn/end', { turn: 1, reason: FAIL }, 20)
  h.event('session/title', { title: 'renamed' }, 21)
  h.event('working-directory/change', { cwd: '/new/project' }, 22)
  assert.equal(h.reg.peek('s1').title, 'renamed')
  assert.equal(h.reg.peek('s1').cwd, '/new/project')
  assert.equal(h.phase(), 'blocked', '元数据变化不影响停止事实')
})

// ── 误报六：提问投影按任务隔离 ──────────────────────────────────────────

test('投影：被门闸拒绝的旧轮终局不能清掉当前任务的提问', () => {
  const h = harness()
  h.event('turn/start', { turn: 2 }, 30)
  h.reg.onPendingQuestion('s1', { callId: 'q-now' })
  assert.equal(h.phase(), 'waiting')
  h.event('turn/end', { turn: 1, reason: FAIL }, 20)
  assert.equal(h.phase(), 'waiting', '旧轮终局被丢弃，投影也要留着')
})

test('投影：真正开始新任务时旧提问投影必须失效', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.reg.onPendingQuestion('s1', { callId: 'q-old' })
  assert.equal(h.phase(), 'waiting')
  h.event('turn/start', { turn: 2 }, 30)
  assert.equal(h.phase(), 'thinking', '旧任务的提问不属于新任务')
})

test('投影：明确为空只清投影来源，事件来源照旧', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('approval/asked', { turn: 1, id: 'a1', toolName: 'write' }, 11)
  h.reg.onPendingQuestion('s1', { callId: 'q-1' })
  assert.equal(h.phase(), 'waiting')
  h.reg.onPendingQuestion('s1', null)
  assert.equal(h.phase(), 'waiting', '审批还在等，投影清空不能连带清掉它')
})

// ── 误报七：重试有效性与判定同源 ────────────────────────────────────────

test('重试：未到调度时刻的长退避仍然是 thinking', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('llm/retry', { turn: 1, step: 1, retryId: 'r1', retry: 1, delayMs: 20 * 60 * 1000, failure: { code: 'TRANSPORT' } }, 11)
  h.tick(11 * 60 * 1000)
  assert.equal(h.phase(), 'thinking', '宿主说要等 20 分钟，就不能在第 10 分钟宣布失效')
})

test('重试：快照的 retrying 与判定一致（不出现 idle + retrying）', () => {
  const h = harness()
  h.event('turn/start', { turn: 1 }, 10)
  h.event('llm/retry', { turn: 1, step: 1, retryId: 'r1', retry: 1, delayMs: 1000, failure: { code: 'TRANSPORT' } }, 11)
  h.tick(11 * 60 * 1000)
  const row = h.row()
  assert.equal(row.phase, 'idle')
  assert.equal(row.retrying, false, 'phase 与 retrying 不能说两套')
})

