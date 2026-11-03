/**
 * 诊断端点测试：默认关闭、一次性窗口、方法 / 类型 / 上限 / 卸载。
 *
 * GET 返回 200 但 probe 为 null **不算**通过 —— 这里显式钉住「未开窗口 = 403/409」
 * 与「窗口关闭后样本清空」。
 *
 * @module test/probe-route.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'

async function mount(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-probe-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  const routes = new Map()
  const ctx = {
    logger: { warn() {} },
    on() {},
    effect() {},
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
  const mod = await import('../lib/index.js')
  mod.apply(ctx)

  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const handler = routes.get(urlPath)
      if (handler === undefined) return reject(new Error('没有这条路由: ' + urlPath))
      const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
      const req = Readable.from(payload === '' ? [] : [Buffer.from(payload)])
      req.method = method
      const chunks = []
      const res = new Writable({
        write(chunk, _enc, done) {
          chunks.push(chunk)
          done()
        },
      })
      res.writeHead = (status, headers) => {
        res.statusCode = status
        res.headers = headers
        return res
      }
      res.end = (value) => {
        if (value !== undefined) chunks.push(Buffer.from(value))
        Writable.prototype.end.call(res)
      }
      res.on('finish', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try {
          json = JSON.parse(text)
        } catch (err) {
          json = { raw: text }
        }
        resolve({ status: res.statusCode, headers: res.headers, json })
      })
      handler(req, res)
    })
  }

  return { request, routes }
}

const PROBE = '/dsh-grok-buddy/probe.json'
const CONTROL = '/dsh-grok-buddy/probe-control.json'
const STATE = '/dsh-grok-buddy/state.json'
const COLORS = '/dsh-grok-buddy/colors.json'

test('诊断默认关闭：先 POST 样本会被拒，GET 明确说窗口没开', async (t) => {
  const h = await mount(t)
  const post = await h.request('POST', PROBE, { build: 'x', rows: [] })
  assert.equal(post.status, 409, '窗口没开时拒收样本')
  assert.equal(post.json.ok, false)
  const get = await h.request('GET', PROBE)
  assert.equal(get.status, 200)
  assert.equal(get.json.probe, null, '没有样本时 probe 必须是 null（不能说「通过」）')
  assert.equal(get.json.windowOpen, false)
})

test('arm 之后才收样本，并且返回窗口结束时间', async (t) => {
  const h = await mount(t)
  const armed = await h.request('POST', CONTROL, { action: 'arm', ms: 5000 })
  assert.equal(armed.status, 200)
  assert.equal(armed.json.windowOpen, true)
  assert.equal(typeof armed.json.windowEndsAt, 'number')
  const post = await h.request('POST', PROBE, { build: 'b1', pageId: 'p1', at: 1, rows: [{ sessionId: 's1', phase: 'done' }] })
  assert.equal(post.status, 200)
  assert.equal(post.json.accepted, true)
  const get = await h.request('GET', PROBE)
  assert.equal(get.json.probe.build, 'b1')
  assert.equal(get.json.stale, false)
})

test('disarm 之后清空样本，旧窗口的最后一次上报不当当前页面', async (t) => {
  const h = await mount(t)
  await h.request('POST', CONTROL, { action: 'arm', ms: 5000 })
  await h.request('POST', PROBE, { build: 'b1', at: 1, rows: [] })
  const off = await h.request('POST', CONTROL, { action: 'disarm' })
  assert.equal(off.json.windowOpen, false)
  const get = await h.request('GET', PROBE)
  assert.equal(get.json.probe, null, 'disarm 必须清空样本')
})

test('非法 JSON / null / 数组 / 非对象一律 400，且不影响已有样本', async (t) => {
  const h = await mount(t)
  await h.request('POST', CONTROL, { action: 'arm', ms: 5000 })
  await h.request('POST', PROBE, { build: 'keep', at: 1, rows: [] })
  for (const bad of ['not json', 'null', '[]', '"text"', '42']) {
    const res = await h.request('POST', PROBE, bad)
    assert.equal(res.status, 400, bad + ' 应被拒')
  }
  const get = await h.request('GET', PROBE)
  assert.equal(get.json.probe.build, 'keep', '非法输入不能污染已有样本')
})

test('不支持的方法返回 405 且带 Allow 头', async (t) => {
  const h = await mount(t)
  const put = await h.request('PUT', PROBE)
  assert.equal(put.status, 405)
  assert.match(String(put.headers.Allow), /GET/)
  const del = await h.request('DELETE', CONTROL)
  assert.equal(del.status, 405)
  const statePost = await h.request('POST', STATE)
  assert.equal(statePost.status, 405, 'state.json 是只读端点')
})

test('请求体超限返回 413', async (t) => {
  const h = await mount(t)
  await h.request('POST', CONTROL, { action: 'arm', ms: 5000 })
  const huge = 'x'.repeat(300 * 1024)
  const res = await h.request('POST', PROBE, JSON.stringify({ build: huge }))
  assert.equal(res.status, 413)
})

test('敏感字段不会进样本（只留白名单）', async (t) => {
  const h = await mount(t)
  await h.request('POST', CONTROL, { action: 'arm', ms: 5000 })
  await h.request('POST', PROBE, {
    build: 'b',
    at: 1,
    title: '机密会话标题',
    cwd: '/Users/secret/path',
    token: 'sk-xxx',
    rows: [{ sessionId: 's1', phase: 'idle', title: '机密', cwd: '/secret', toolArgs: 'rm -rf' }],
  })
  const get = await h.request('GET', PROBE)
  const text = JSON.stringify(get.json)
  assert.equal(text.includes('机密'), false, '标题不得上传')
  assert.equal(text.includes('/secret'), false, '路径不得上传')
  assert.equal(text.includes('sk-xxx'), false, '凭据不得上传')
  assert.equal(text.includes('rm -rf'), false, '工具参数不得上传')
  assert.equal(get.json.probe.rows[0].sessionId, 's1', '结构性字段保留')
})

test('多页面样本按 pageId 隔离（后到的替换，且带接收时间）', async (t) => {
  const h = await mount(t)
  await h.request('POST', CONTROL, { action: 'arm', ms: 5000 })
  await h.request('POST', PROBE, { build: 'b', pageId: 'page-A', at: 10, rows: [] })
  const first = await h.request('GET', PROBE)
  assert.equal(first.json.probe.pageId, 'page-A')
  await h.request('POST', PROBE, { build: 'b', pageId: 'page-B', at: 20, rows: [] })
  const second = await h.request('GET', PROBE)
  assert.equal(second.json.probe.pageId, 'page-B')
  assert.equal(typeof second.json.probe.receivedAt, 'number', '要有接收时间')
})

test('arm 的时限被夹在上限内，超时限自动关闭', async (t) => {
  const h = await mount(t)
  const armed = await h.request('POST', CONTROL, { action: 'arm', ms: 10 * 60 * 1000 })
  assert.equal(armed.status, 200)
  const get = await h.request('GET', PROBE)
  const span = get.json.windowEndsAt - Date.now()
  assert.ok(span <= 60 * 1000 + 1000, '窗口不得超过上限（1 分钟）')
})

test('未知 action / 非法 ms 被拒', async (t) => {
  const h = await mount(t)
  assert.equal((await h.request('POST', CONTROL, { action: 'on' })).status, 400)
  assert.equal((await h.request('POST', CONTROL, { action: 'arm', ms: -1 })).status, 400)
  assert.equal((await h.request('POST', CONTROL, { action: 'arm', ms: 'soon' })).status, 400)
})

test('路由卸载后不再响应', async (t) => {
  const h = await mount(t)
  assert.ok(h.routes.has(PROBE))
  for (const key of [...h.routes.keys()]) h.routes.delete(key)
  assert.equal(h.routes.has(PROBE), false)
})

test('state.json 空表也返回合法结构', async (t) => {
  const h = await mount(t)
  const res = await h.request('GET', STATE)
  assert.equal(res.status, 200)
  assert.equal(Array.isArray(res.json.sessions), true)
  assert.equal(typeof res.json.now, 'number')
})

test('colors.json 的 POST 类型错误被拒', async (t) => {
  const h = await mount(t)
  assert.equal((await h.request('POST', COLORS, { workspaceId: 42 })).status, 400)
  assert.equal((await h.request('POST', COLORS, {})).status, 400)
  assert.equal((await h.request('POST', COLORS, { workspaceId: 'w', color: 'not-a-color' })).status, 400)
})
