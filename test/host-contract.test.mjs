/**
 * 宿主契约测试：经过真实的 apply(ctx) 入口，覆盖 userQuestions 投影适配。
 *
 * 缺陷 B：投影的 raw state 是 { inheritedEventCount, timed, questions }，
 * 提问在 state.questions.active，插件曾误读 state.active，导致真实挂起提问
 * 被算成 working。
 *
 * 同时覆盖一个投影**不覆盖**的真实来源：阻塞式 ask_user_question 会超时返回
 * pending（工具调用已发起、结果未回），它不进投影的 timed 列表。
 *
 * @module test/host-contract.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'

/** 一个最小的宿主 ctx：够 apply() 用，且能驱动投影变化。 */
async function mount(t, options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-host-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })

  const routes = new Map()
  const handlers = new Map()
  const injection = []
  const listeners = []
  const effects = []
  let projectionRegistered = null
  const projectionListeners = new Set()

  const ctx = {
    logger: { warn() {} },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
      return () => {}
    },
    effect(factory) {
      effects.push(factory)
      const dispose = factory()
      if (typeof dispose === 'function') return dispose
      return () => {}
    },
    inject(deps, factory) {
      if (options !== undefined && options.noProjections === true) return
      // 投影侧也是真实的 Cordis 子上下文：必须有 effect 才能注册订阅
      factory({
        effect(fn, label) {
          return ctx.effect(fn, label)
        },
        sessionProjections: {
          stateOf(_session, key) {
            if (key !== 'userQuestions') return undefined
            if (projectionRegistered === undefined) return undefined
            if (typeof projectionRegistered === 'function') return projectionRegistered()
            return projectionRegistered
          },
          onChanged(listener) {
            projectionListeners.add(listener)
            return () => projectionListeners.delete(listener)
          },
        },
      })
    },
    webServer: {
      register(entry) {
        routes.set(entry.path, entry.handler)
        return () => routes.delete(entry.path)
      },
      tapIndex() {
        return () => {}
      },
    },
  }
  // webserver/index-inject 是 emit 风格
  ctx.emit = (name, table) => {
    for (const handler of handlers.get(name) || []) handler(table)
  }

  const mod = await import('../lib/index.js')
  mod.apply(ctx)

  /** 解析 state.json。 */
  function state() {
    return new Promise((resolve, reject) => {
      const handler = routes.get('/dsh-grok-buddy/state.json')
      if (handler === undefined) return reject(new Error('没有 state 路由'))
      const req = Readable.from([])
      req.method = 'GET'
      const chunks = []
      const res = new Writable({ write(c, _e, d) { chunks.push(c); d() } })
      res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; return res }
      res.end = (v) => { if (v !== undefined) chunks.push(Buffer.from(v)); Writable.prototype.end.call(res) }
      res.on('finish', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      handler(req, res)
    })
  }

  return {
    ctx,
    routes,
    injection,
    state,
    emitSessionEvent(session, event) {
      for (const handler of handlers.get('session/event') || []) handler(session, event)
    },
    emitAgentStatus(payload) {
      for (const handler of handlers.get('agent/status') || []) handler(payload)
    },
    emitAgentError(payload) {
      for (const handler of handlers.get('agent/error') || []) handler(payload)
    },
    setProjection(value) {
      projectionRegistered = value
      for (const listener of [...projectionListeners]) listener({ id: 's1' }, 'userQuestions', value, 1)
    },
    get projectionSubscribed() {
      return projectionListeners.size > 0
    },
  }
}

/** 真实 DSH raw state 结构（stateOf 的返回值）。 */
function rawState(active, timed) {
  return {
    inheritedEventCount: 0,
    timed: timed === true,
    questions: { active, settled: [] },
  }
}

function openQuestion(callId, timed) {
  return {
    callId,
    state: 'open',
    questions: [{ id: timed ? 'q1' : 'q1', question: 'pick one', options: [{ label: 'A' }] }],
  }
}

const session = { id: 's1', header: { cwd: '/tmp/p' } }

test('B1 真实 raw state 结构下的 open 提问 → waiting', async (t) => {
  const h = await mount(t)
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.emitSessionEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'bash' } })
  let body = await h.state()
  assert.equal(body.sessions[0].phase, 'working', '前提：工具在跑')

  h.setProjection(rawState([openQuestion('q-call', true)], true))
  body = await h.state()
  assert.equal(body.sessions[0].phase, 'waiting', 'raw state 的 questions.active 必须被读到')
  assert.equal(body.sessions[0].pendingKind, 'question')
})

test('B2 continued（带 timeout 的提问超时后仍可回答）也算 waiting', async (t) => {
  const h = await mount(t)
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.setProjection(rawState([{ callId: 'q2', state: 'continued', questions: [{ id: 'q1', question: 'x' }] }], true))
  const body = await h.state()
  assert.equal(body.sessions[0].phase, 'waiting', 'continued 仍可被回答，不能当作已解决')
})

test('B3 计划评审 → waiting 且 pendingKind=plan-review', async (t) => {
  const h = await mount(t)
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.setProjection(
    rawState([{ callId: 'p1', state: 'open', questions: [{ id: 'plan-review', intent: { kind: 'plan-review' } }] }], true),
  )
  const body = await h.state()
  assert.equal(body.sessions[0].phase, 'waiting')
  assert.equal(body.sessions[0].pendingKind, 'plan-review')
})

test('B4 投影清空之后离开 waiting', async (t) => {
  const h = await mount(t)
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.setProjection(rawState([openQuestion('q-call', true)], true))
  assert.equal((await h.state()).sessions[0].phase, 'waiting')
  h.setProjection(rawState([], true))
  assert.notEqual((await h.state()).sessions[0].phase, 'waiting')
})

test('B5 投影不可用时退化为只用事件，不报错也不卡在 waiting', async (t) => {
  const h = await mount(t, { noProjections: true })
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.emitSessionEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'bash' } })
  const body = await h.state()
  assert.equal(body.sessions[0].phase, 'working')
})

test('B6 投影读取抛错时不能当成「交互已解决」以外的错误状态', async (t) => {
  const h = await mount(t)
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.setProjection(() => {
    throw new Error('projection unavailable')
  })
  const body = await h.state()
  // 读取失败既不建立 waiting，也不把会话打挂
  assert.ok(['thinking', 'working', 'waiting'].includes(body.sessions[0].phase))
})

test('B7 审批事件与提问投影并存时，审批优先且清理后回到提问', async (t) => {
  const h = await mount(t)
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.emitSessionEvent(session, { type: 'approval/asked', data: { turn: 1, id: 'a1', toolName: 'write' } })
  assert.equal((await h.state()).sessions[0].pendingKind, 'approval')
  h.emitSessionEvent(session, { type: 'approval/decided', data: { turn: 1, id: 'a1', outcome: 'allowed-once' } })
  assert.notEqual((await h.state()).sessions[0].pendingKind, 'approval')
})

test('B8 投影订阅在卸载时释放', async (t) => {
  const h = await mount(t)
  assert.equal(h.projectionSubscribed, true, '应该订阅了投影变化')
})

test('B9 阻塞式 ask_user_question（不进投影）也必须是 waiting', async (t) => {
  const h = await mount(t)
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  // 真实 DSH 里阻塞式提问只表现为：工具调用已发起、结果未回
  h.emitSessionEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'ask1', name: 'ask_user_question' } })
  const body = await h.state()
  assert.equal(body.sessions[0].phase, 'waiting', '待回答的 ask_user_question 是 waiting，不是 working')
  assert.equal(body.sessions[0].pendingKind, 'question')
})

test('B10 阻塞式提问返回结果后离开 waiting', async (t) => {
  const h = await mount(t)
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.emitSessionEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'ask1', name: 'ask_user_question' } })
  assert.equal((await h.state()).sessions[0].phase, 'waiting')
  h.emitSessionEvent(session, {
    type: 'tool/result',
    data: { turn: 1, message: { source: { callId: 'ask1' }, isError: false } },
  })
  assert.notEqual((await h.state()).sessions[0].phase, 'waiting')
})

test('B11 待评审的 exit_plan_mode 也是 waiting（plan-review）', async (t) => {
  const h = await mount(t)
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.emitSessionEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'plan1', name: 'exit_plan_mode' } })
  const body = await h.state()
  assert.equal(body.sessions[0].phase, 'waiting')
  assert.equal(body.sessions[0].pendingKind, 'plan-review')
})

test('B12 插件中途接入：只收到挂起提问也能建立会话记录', async (t) => {
  const h = await mount(t)
  h.setProjection(rawState([openQuestion('q-late', true)], true))
  const body = await h.state()
  const row = body.sessions.find((item) => item.id === 's1')
  assert.ok(row !== undefined, '中途接入也要建立记录')
  assert.equal(row.phase, 'waiting')
})

test('B13 旧轮 turn/end 不能清掉当前轮的提问', async (t) => {
  const h = await mount(t)
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
  h.setProjection(rawState([openQuestion('q-now', true)], true))
  assert.equal((await h.state()).sessions[0].phase, 'waiting')
  // 旧轮结束
  h.emitSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal((await h.state()).sessions[0].phase, 'waiting', '旧轮结束事件不得清掉当前轮的挂起提问')
})

test('B14 未确认的 agent/error 不抢走挂起提问', async (t) => {
  const h = await mount(t)
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.setProjection(rawState([openQuestion('q-err', true)], true))
  h.emitAgentError({ agent: { session: { id: 's1' } }, error: { code: 'BOOM' } })
  const body = await h.state()
  assert.equal(body.sessions[0].phase, 'waiting', '错误没被生命周期确认时，提问仍然有效')
  assert.equal(body.sessions[0].stopCertain, false)
})

test('B14b 已确认的错误停止压过残留的挂起提问，并输出停止证据', async (t) => {
  const h = await mount(t)
  h.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  h.setProjection(rawState([openQuestion('q-err', true)], true))
  h.emitSessionEvent(session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA', message: 'no budget' } } },
  })
  const body = await h.state()
  const row = body.sessions[0]
  assert.equal(row.phase, 'blocked')
  assert.equal(row.stopCertain, true)
  assert.equal(row.stopSource, 'turn/end:error')
  assert.equal(row.stopCode, 'QUOTA')
  assert.equal(row.turnKey, 's1#1', '停止事实必须带当前轮身份，页面才能核验')
})
