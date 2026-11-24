import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspacePromoter } from '../lib/promote.js'

/** 造一个假 registry：list() 按给定顺序返回，insertBefore 记录调用并真的重排。 */
function makeRegistry(initial) {
  const order = initial.map((entry) => ({ id: entry.id, sessionIds: entry.sessionIds.slice() }))
  const calls = []
  return {
    calls,
    order,
    list() {
      return order.map((entry) => ({ id: entry.id, sessionIds: entry.sessionIds.slice() }))
    },
    async insertBefore(id, beforeId) {
      calls.push([id, beforeId])
      const from = order.findIndex((entry) => entry.id === id)
      if (from === -1) throw new Error('WorkspaceOrderInvalidError: ' + id)
      const [moved] = order.splice(from, 1)
      if (beforeId === undefined) {
        order.push(moved)
      } else {
        const to = order.findIndex((entry) => entry.id === beforeId)
        if (to === -1) throw new Error('WorkspaceOrderInvalidError: ' + beforeId)
        order.splice(to, 0, moved)
      }
      return order.map((entry) => entry.id)
    },
  }
}

function makePromoter(registry, extra) {
  const warnings = []
  const promoter = createWorkspacePromoter({
    resolveService: () => registry,
    warn: (what, err) => warnings.push([what, err]),
    sleep: () => Promise.resolve(),
    ...(extra || {}),
  })
  return { promoter, warnings }
}

function turnStart(sessionId, header) {
  return {
    session: { id: sessionId, header: header || { id: sessionId } },
    event: { type: 'turn/start', seq: 1, data: { turn: 1 } },
  }
}

test('新会话第一次 turn/start 把所属文件夹移到第一位', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: ['s2'] },
  ])
  const { promoter } = makePromoter(registry)
  const { session, event } = turnStart('s2')
  promoter.onSessionEvent(session, event)
  await promoter.pending()
  assert.deepEqual(registry.calls, [['ws-b', 'ws-a']])
  assert.deepEqual(registry.order.map((entry) => entry.id), ['ws-b', 'ws-a'])
})

test('同一会话的后续轮次不再移动', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: ['s2'] },
  ])
  const { promoter } = makePromoter(registry)
  const first = turnStart('s2')
  promoter.onSessionEvent(first.session, first.event)
  await promoter.pending()
  const second = turnStart('s2')
  second.event = { type: 'turn/start', seq: 9, data: { turn: 2 } }
  promoter.onSessionEvent(second.session, second.event)
  await promoter.pending()
  assert.equal(registry.calls.length, 1)
})

test('另一个文件夹的新会话会把它顶到当前第一位之前', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: ['s2'] },
    { id: 'ws-c', sessionIds: ['s3'] },
  ])
  const { promoter } = makePromoter(registry)
  const b = turnStart('s2')
  promoter.onSessionEvent(b.session, b.event)
  await promoter.pending()
  const c = turnStart('s3')
  promoter.onSessionEvent(c.session, c.event)
  await promoter.pending()
  assert.deepEqual(registry.calls, [
    ['ws-b', 'ws-a'],
    ['ws-c', 'ws-b'],
  ])
  assert.deepEqual(registry.order.map((entry) => entry.id), ['ws-c', 'ws-b', 'ws-a'])
})

test('已经在第一位时不调用 insertBefore', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: ['s2'] },
  ])
  const { promoter } = makePromoter(registry)
  const { session, event } = turnStart('s1')
  promoter.onSessionEvent(session, event)
  await promoter.pending()
  assert.deepEqual(registry.calls, [])
})

test('子会话（origin=subagent）不参与置顶', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: ['s2'] },
  ])
  const { promoter } = makePromoter(registry)
  const { session, event } = turnStart('s2', { id: 's2', origin: 'subagent' })
  promoter.onSessionEvent(session, event)
  await promoter.pending()
  assert.deepEqual(registry.calls, [])
})

test('非 turn/start 事件被忽略', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: ['s2'] },
  ])
  const { promoter } = makePromoter(registry)
  promoter.onSessionEvent({ id: 's2', header: { id: 's2' } }, { type: 'turn/end', seq: 2, data: {} })
  await promoter.pending()
  assert.deepEqual(registry.calls, [])
})

test('找不到归属时重试后放弃，不抛错', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: [] },
  ])
  const { promoter, warnings } = makePromoter(registry, { retryAttempts: 2 })
  const { session, event } = turnStart('s-unknown')
  promoter.onSessionEvent(session, event)
  await promoter.pending()
  assert.deepEqual(registry.calls, [])
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][0]), /找不到会话所属的工作区/)
})

test('会话还没 attach 时用 cwd 兜底', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: [] },
  ])
  registry.resolveByPath = async (cwd) => (cwd === '/proj/b' ? { id: 'ws-b' } : undefined)
  const { promoter } = makePromoter(registry)
  const { session, event } = turnStart('s2', { id: 's2', cwd: '/proj/b' })
  promoter.onSessionEvent(session, event)
  await promoter.pending()
  assert.deepEqual(registry.calls, [['ws-b', 'ws-a']])
})

test('insertBefore 抛错被吞掉并 warn', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: ['s2'] },
  ])
  registry.insertBefore = async () => {
    throw new Error('WorkspaceOrderInvalidError: ws-b')
  }
  const { promoter, warnings } = makePromoter(registry)
  const { session, event } = turnStart('s2')
  promoter.onSessionEvent(session, event)
  await promoter.pending()
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][0]), /置顶失败/)
})

test('开关关闭时完全不动作', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: ['s2'] },
  ])
  const { promoter } = makePromoter(registry, { isEnabled: () => false })
  const { session, event } = turnStart('s2')
  promoter.onSessionEvent(session, event)
  await promoter.pending()
  assert.deepEqual(registry.calls, [])
})

test('宿主服务缺 insertBefore 时静默返回', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: ['s2'] },
  ])
  delete registry.insertBefore
  const { promoter, warnings } = makePromoter(registry)
  const { session, event } = turnStart('s2')
  promoter.onSessionEvent(session, event)
  await promoter.pending()
  assert.equal(warnings.length, 0)
})

test('宿主没有工作区服务时静默返回', async () => {
  const promoter = createWorkspacePromoter({
    resolveService: () => null,
    warn: () => {
      throw new Error('不该 warn')
    },
    sleep: () => Promise.resolve(),
  })
  const { session, event } = turnStart('s2')
  promoter.onSessionEvent(session, event)
  await promoter.pending()
})

test('并发触发串行执行，顺序确定', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: ['s2'] },
    { id: 'ws-c', sessionIds: ['s3'] },
  ])
  const { promoter } = makePromoter(registry)
  const b = turnStart('s2')
  const c = turnStart('s3')
  promoter.onSessionEvent(b.session, b.event)
  promoter.onSessionEvent(c.session, c.event)
  await promoter.pending()
  assert.deepEqual(registry.calls, [
    ['ws-b', 'ws-a'],
    ['ws-c', 'ws-b'],
  ])
})

test('dispose 之后不再动作', async () => {
  const registry = makeRegistry([
    { id: 'ws-a', sessionIds: ['s1'] },
    { id: 'ws-b', sessionIds: ['s2'] },
  ])
  const { promoter } = makePromoter(registry)
  promoter.dispose()
  const { session, event } = turnStart('s2')
  promoter.onSessionEvent(session, event)
  await promoter.pending()
  assert.deepEqual(registry.calls, [])
})

test('只有一个工作区时不调用 insertBefore', async () => {
  const registry = makeRegistry([{ id: 'ws-a', sessionIds: ['s1'] }])
  const { promoter } = makePromoter(registry)
  const { session, event } = turnStart('s1')
  promoter.onSessionEvent(session, event)
  await promoter.pending()
  assert.deepEqual(registry.calls, [])
})
