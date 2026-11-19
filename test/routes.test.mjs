/**
 * HTTP 路由的集成测试（lib/index.js 的 apply()）。
 *
 * 用一个最小的假 ctx 把路由 handler 抓出来，再用假 req/res 打进去 ——
 * 不启真服务器，但走的是**真实**的 handler 代码与真实的 store 实现
 * （配色表 / 设置表落在临时目录，不碰 ~/.dsh）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../lib/index.js'

/** 造一个假 ctx：抓路由、抓事件、抓 effect。 */
function makeCtx() {
  const routes = new Map()
  const listeners = new Map()
  const effects = []
  const ctx = {
    logger: { warn: () => {} },
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
      tapIndex: (transform) => {
        effects.push(transform)
        return () => {}
      },
    },
    on: (event, handler) => {
      const list = listeners.get(event) || []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    effect: (factory) => {
      effects.push(factory())
      return () => {}
    },
    get: () => undefined,
  }
  return { ctx, routes, listeners, effects }
}

/** 造一个假请求：可选带 JSON 体。 */
function makeReq(method, body) {
  const req = new EventEmitter()
  req.method = method
  // 真实 IncomingMessage 有 destroy()：超限时 handler 会调它切断连接。
  req.destroy = () => {}
  if (body !== undefined) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body)
    // 下一拍再喂数据，让 handler 先挂上监听
    setImmediate(() => {
      req.emit('data', raw)
      req.emit('end')
    })
  } else {
    setImmediate(() => req.emit('end'))
  }
  return req
}

/** 造一个假响应，收集状态码与体。 */
function makeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers || {}
    },
    end(chunk) {
      if (typeof chunk === 'string') res.body += chunk
    },
  }
  return res
}

/** 打一次请求，等响应结束。 */
function call(handler, method, body) {
  return new Promise((resolve) => {
    const res = makeRes()
    const originalEnd = res.end.bind(res)
    res.end = (chunk) => {
      originalEnd(chunk)
      resolve({ status: res.status, headers: res.headers, body: res.body })
    }
    handler(makeReq(method, body), res)
  })
}

/** 每个用例一个独立的临时家目录，避免污染真实 ~/.dsh。 */
function withTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-routes-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  return {
    dir,
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function boot() {
  const { ctx, routes, listeners } = makeCtx()
  apply(ctx)
  return { routes, listeners }
}

test('state.json：GET 返回快照，POST 405 且带 Allow 头', async () => {
  const home = withTempHome()
  try {
    const { routes } = boot()
    const handler = routes.get('/dsh-grok-buddy/state.json')
    assert.equal(typeof handler, 'function')

    const ok = await call(handler, 'GET')
    assert.equal(ok.status, 200)
    const body = JSON.parse(ok.body)
    assert.equal(body.ok, true)
    assert.ok(Array.isArray(body.sessions))
    assert.equal(typeof body.now, 'number')

    const bad = await call(handler, 'POST', {})
    assert.equal(bad.status, 405)
    assert.equal(bad.headers.Allow, 'GET, HEAD, POST')
  } finally {
    home.restore()
  }
})

test('state.json：折入事件后快照里能看到相位', async () => {
  const home = withTempHome()
  try {
    const { routes, listeners } = boot()
    const onEvent = listeners.get('session/event')[0]
    onEvent({ id: 's1', header: { cwd: '/tmp/proj' } }, { type: 'turn/start', seq: 1, data: { turn: 1 } })

    const res = await call(routes.get('/dsh-grok-buddy/state.json'), 'GET')
    const body = JSON.parse(res.body)
    assert.equal(body.sessions.length, 1)
    assert.equal(body.sessions[0].id, 's1')
    assert.equal(body.sessions[0].phase, 'thinking')
    assert.equal(body.sessions[0].turnKey, 's1#1')
  } finally {
    home.restore()
  }
})

test('probe-control.json：只接受 POST，arm/disarm 与非法 ms', async () => {
  const home = withTempHome()
  try {
    const { routes } = boot()
    const handler = routes.get('/dsh-grok-buddy/probe-control.json')

    const get = await call(handler, 'GET')
    assert.equal(get.status, 405)

    const arm = await call(handler, 'POST', { action: 'arm', ms: 5_000 })
    assert.equal(arm.status, 200)
    assert.equal(JSON.parse(arm.body).ok, true)

    const badMs = await call(handler, 'POST', { action: 'arm', ms: -1 })
    assert.equal(badMs.status, 400)
    assert.match(JSON.parse(badMs.body).error, /ms/)

    const badAction = await call(handler, 'POST', { action: 'nope' })
    assert.equal(badAction.status, 400)

    const disarm = await call(handler, 'POST', { action: 'disarm' })
    assert.equal(disarm.status, 200)
    assert.equal(JSON.parse(disarm.body).ok, true)
  } finally {
    home.restore()
  }
})

test('probe.json：窗口没开时 POST 采样被 409 拒绝，开了才收', async () => {
  const home = withTempHome()
  try {
    const { routes } = boot()
    const probe = routes.get('/dsh-grok-buddy/probe.json')
    const control = routes.get('/dsh-grok-buddy/probe-control.json')

    const closed = await call(probe, 'POST', { build: 'x', rows: [] })
    assert.equal(closed.status, 409)
    assert.match(JSON.parse(closed.body).error, /窗口未打开/)

    await call(control, 'POST', { action: 'arm', ms: 5_000 })
    const accepted = await call(probe, 'POST', { build: 'x', rows: [{ sessionId: 's1' }] })
    assert.equal(accepted.status, 200)
    assert.equal(JSON.parse(accepted.body).accepted, true)

    const read = await call(probe, 'GET')
    const body = JSON.parse(read.body)
    assert.equal(body.windowOpen, true)
    assert.equal(body.probe.build, 'x')
    assert.equal(body.probe.rows.length, 1)
  } finally {
    home.restore()
  }
})

test('probe.json：非法 JSON 与超大请求体分别 400 / 413', async () => {
  const home = withTempHome()
  try {
    const { routes } = boot()
    const probe = routes.get('/dsh-grok-buddy/probe.json')

    const bad = await call(probe, 'POST', 'not json')
    assert.equal(bad.status, 400)

    const huge = await call(probe, 'POST', 'x'.repeat(300 * 1024))
    assert.equal(huge.status, 413)
  } finally {
    home.restore()
  }
})

test('colors.json：GET 读表，POST 缺 workspaceId 400，写成功后可读回', async () => {
  const home = withTempHome()
  try {
    const { routes } = boot()
    const handler = routes.get('/dsh-grok-buddy/colors.json')

    const empty = await call(handler, 'GET')
    assert.equal(empty.status, 200)
    const emptyBody = JSON.parse(empty.body)
    assert.equal(emptyBody.ok, true)
    assert.deepEqual(emptyBody.projects, {})
    assert.match(emptyBody.file, /colors\.json$/)

    const missing = await call(handler, 'POST', { color: '#ff0000' })
    assert.equal(missing.status, 400)
    assert.match(JSON.parse(missing.body).error, /workspaceId/)

    const saved = await call(handler, 'POST', { workspaceId: 'ws-1', color: '#ff263c' })
    assert.equal(saved.status, 200)
    assert.equal(JSON.parse(saved.body).projects['ws-1'], '#ff263c')

    const reread = await call(handler, 'GET')
    assert.equal(JSON.parse(reread.body).projects['ws-1'], '#ff263c')
  } finally {
    home.restore()
  }
})

test('colors.json：非法颜色被拒，不写进表', async () => {
  const home = withTempHome()
  try {
    const { routes } = boot()
    const handler = routes.get('/dsh-grok-buddy/colors.json')
    const bad = await call(handler, 'POST', { workspaceId: 'ws-1', color: 'not-a-color' })
    assert.equal(bad.status, 400)
    const after = await call(handler, 'GET')
    assert.deepEqual(JSON.parse(after.body).projects, {})
  } finally {
    home.restore()
  }
})

test('settings.json：GET 默认值，POST 只认三个字段', async () => {
  const home = withTempHome()
  try {
    const { routes } = boot()
    const handler = routes.get('/dsh-grok-buddy/settings.json')

    const initial = await call(handler, 'GET')
    const initialBody = JSON.parse(initial.body)
    assert.equal(initialBody.ok, true)
    assert.equal(initialBody.autoColorNewFolders, false)
    assert.equal(initialBody.baselineComplete, false)
    assert.deepEqual(initialBody.knownWorkspaces, [])

    const patched = await call(handler, 'POST', {
      autoColorNewFolders: true,
      baselineComplete: true,
      knownWorkspaces: ['ws-1', 'ws-2'],
      // 不认识的字段必须被忽略，不能写进文件
      somethingElse: 'ignored',
    })
    assert.equal(patched.status, 200)
    const patchedBody = JSON.parse(patched.body)
    assert.equal(patchedBody.autoColorNewFolders, true)
    assert.equal(patchedBody.baselineComplete, true)
    assert.deepEqual(patchedBody.knownWorkspaces, ['ws-1', 'ws-2'])
    assert.equal(patchedBody.somethingElse, undefined)

    const badType = await call(handler, 'POST', { autoColorNewFolders: 'yes' })
    assert.equal(badType.status, 400)
    assert.match(JSON.parse(badType.body).error, /布尔/)
  } finally {
    home.restore()
  }
})

test('auto-color.json：只接受 POST，未开启 / 基线未建 / 已有色 / 正常分配', async () => {
  const home = withTempHome()
  try {
    const { routes } = boot()
    const auto = routes.get('/dsh-grok-buddy/auto-color.json')
    const settings = routes.get('/dsh-grok-buddy/settings.json')

    const get = await call(auto, 'GET')
    assert.equal(get.status, 405)

    const badId = await call(auto, 'POST', { workspaceId: '' })
    assert.equal(badId.status, 400)

    // 开关关着
    const off = await call(auto, 'POST', { workspaceId: 'ws-new' })
    assert.equal(off.status, 409)
    assert.match(JSON.parse(off.body).error, /未开启/)

    // 开关开着但基线没建
    await call(settings, 'POST', { autoColorNewFolders: true })
    const noBaseline = await call(auto, 'POST', { workspaceId: 'ws-new' })
    assert.equal(noBaseline.status, 409)
    assert.match(JSON.parse(noBaseline.body).error, /基线/)

    // 基线建好：正常分配一个颜色
    await call(settings, 'POST', { baselineComplete: true })
    const assigned = await call(auto, 'POST', { workspaceId: 'ws-new' })
    assert.equal(assigned.status, 200)
    const assignedBody = JSON.parse(assigned.body)
    assert.equal(assignedBody.ok, true)
    assert.match(assignedBody.color, /^#[0-9a-f]{6}$/)

    // 重复请求：返回原色，不覆盖
    const again = await call(auto, 'POST', { workspaceId: 'ws-new' })
    assert.equal(again.status, 200)
    const againBody = JSON.parse(again.body)
    assert.equal(againBody.existing, true)
    assert.equal(againBody.color, assignedBody.color)
  } finally {
    home.restore()
  }
})

test('workspaces.json：宿主没有 workspace 服务时 501', async () => {
  const home = withTempHome()
  try {
    const { routes } = boot()
    const handler = routes.get('/dsh-grok-buddy/workspaces.json')
    const res = await call(handler, 'GET')
    assert.equal(res.status, 501)
    assert.match(JSON.parse(res.body).error, /workspaceRegistry/)
  } finally {
    home.restore()
  }
})

test('workspaces.json：宿主提供 list() 时返回全量名册', async () => {
  const home = withTempHome()
  try {
    const { ctx, routes } = makeCtx()
    ctx.get = (serviceName) =>
      serviceName === 'workspaceRegistry'
        ? {
            list: () => [
              { id: 'ws-a', sessionIds: ['s1', 's2'] },
              { id: 'ws-b', sessionIds: [] },
            ],
          }
        : undefined
    apply(ctx)

    const res = await call(routes.get('/dsh-grok-buddy/workspaces.json'), 'GET')
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.available, true)
    assert.equal(body.source, 'host')
    assert.deepEqual(body.workspaces, ['ws-a', 'ws-b'])
    // members 是数组（每项 { workspaceId, sessionIds, known }），不是 map。
    assert.deepEqual(body.members, [
      { workspaceId: 'ws-a', sessionIds: ['s1', 's2'], known: true },
      { workspaceId: 'ws-b', sessionIds: [], known: true },
    ])
    assert.equal(body.membersReady, true)
  } finally {
    home.restore()
  }
})

test('widget.js：路由每次读盘，返回 JS 与 no-store', async () => {
  const home = withTempHome()
  try {
    const { routes } = boot()
    const res = await call(routes.get('/dsh-grok-buddy/widget.js'), 'GET')
    assert.equal(res.status, 200)
    assert.match(res.headers['Content-Type'], /javascript/)
    assert.equal(res.headers['Cache-Control'], 'no-store')
    assert.ok(res.body.length > 1000)
  } finally {
    home.restore()
  }
})

test('index-inject：推一条 head 里的 script 行', () => {
  const home = withTempHome()
  try {
    const { listeners } = boot()
    const table = []
    for (const handler of listeners.get('webserver/index-inject') || []) handler(table)
    assert.equal(table.length, 1)
    assert.equal(table[0].kind, 'script')
    assert.equal(table[0].placement, 'head')
    assert.match(table[0].text, /dsh-grok-buddy\/widget\.js/)
  } finally {
    home.restore()
  }
})
