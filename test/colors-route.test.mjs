/**
 * 宿主路由的集成测试：GET/POST /dsh-grok-buddy/colors.json。
 *
 * 前面 colors-store.test 测的是「表」本身；这里测的是**真正挂上去的那条路由** ——
 * 校验、状态码、落盘路径，以及最要紧的一条：重启之后颜色还在。
 *
 * @module test/colors-route.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'

/** 把插件的 apply() 挂到一个假 ctx 上，拿到它注册的路由。 */
async function mount(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-route-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })

  const routes = new Map()
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
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

  /** 发一次请求，收响应。 */
  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const handler = routes.get(urlPath)
      if (handler === undefined) {
        reject(new Error('没有这条路由: ' + urlPath))
        return
      }
      const payload = body === undefined ? '' : JSON.stringify(body)
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
          json = undefined
        }
        resolve({ status: res.statusCode, headers: res.headers, json })
      })
      handler(req, res)
    })
  }

  return { request, home, warnings, colorsPath: '/dsh-grok-buddy/colors.json', file: path.join(home, 'dsh-grok-buddy', 'colors.json') }
}

test('GET 空表也不报错，顺手带上文件路径', async (t) => {
  const { request, colorsPath, file } = await mount(t)
  const res = await request('GET', colorsPath)
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.deepEqual(res.json.projects, {})
  assert.equal(res.json.file, file)
})

test('POST 写入后，GET 立刻读得到，并且真的落到了 DSH_HOME 下', async (t) => {
  const { request, colorsPath, file } = await mount(t)
  const post = await request('POST', colorsPath, { workspaceId: 'proj-a', color: '#9159FE' })
  assert.equal(post.status, 200)
  assert.equal(post.json.projects['proj-a'], '#9159fe')

  const get = await request('GET', colorsPath)
  assert.equal(get.json.projects['proj-a'], '#9159fe')

  const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(disk.version, 1)
  assert.equal(disk.projects['proj-a'], '#9159fe')
})

test('重启（重新 apply 一次）之后颜色还在', async (t) => {
  const { request, colorsPath } = await mount(t)
  await request('POST', colorsPath, { workspaceId: 'proj-a', color: '#00bca6' })

  // 同一个 DSH_HOME 上再挂一次，模拟重启
  const routes = new Map()
  const ctx = {
    logger: { warn() {} },
    on() {},
    effect() {},
    webServer: {
      register(entry) {
        routes.set(entry.path, entry.handler)
        return () => {}
      },
      tapIndex() {
        return () => {}
      },
    },
  }
  const mod = await import('../lib/index.js')
  mod.apply(ctx)
  const handler = routes.get(colorsPath)
  const chunks = []
  await new Promise((resolve) => {
    const req = Readable.from([])
    req.method = 'GET'
    const res = new Writable({
      write(chunk, _e, done) {
        chunks.push(chunk)
        done()
      },
    })
    res.writeHead = () => res
    res.end = (value) => {
      if (value !== undefined) chunks.push(Buffer.from(value))
      Writable.prototype.end.call(res)
      resolve()
    }
    handler(req, res)
  })
  assert.equal(JSON.parse(Buffer.concat(chunks).toString('utf8')).projects['proj-a'], '#00bca6')
})

test('写盘失败时 POST 回 500：页面能据此回滚，不会假装成功', async (t) => {
  const { request, colorsPath, file } = await mount(t)
  // 先落一个能用的旧色
  await request('POST', colorsPath, { workspaceId: 'proj-a', color: '#9159fe' })
  // 把配色文件路径占成一个目录 → rename 失败
  fs.rmSync(file)
  fs.mkdirSync(file)
  const res = await request('POST', colorsPath, { workspaceId: 'proj-a', color: '#ff263c' })
  assert.equal(res.status, 500)
  assert.equal(res.json.ok, false)
  assert.match(res.json.error, /写不进去/)
  // 内存表也回到旧值：后续 GET 与重启读到的都是旧色
  const get = await request('GET', colorsPath)
  assert.equal(get.json.projects['proj-a'], '#9159fe')
})

test('POST 非法颜色被拒（400），已有表不受影响', async (t) => {
  const { request, colorsPath } = await mount(t)
  await request('POST', colorsPath, { workspaceId: 'proj-a', color: '#1084fe' })
  for (const bad of ['rgb(1,2,3)', 'javascript:alert(1)', 'reddish', '#12345']) {
    const res = await request('POST', colorsPath, { workspaceId: 'proj-b', color: bad })
    assert.equal(res.status, 400, bad + ' 应该被拒')
    assert.equal(res.json.ok, false)
  }
  const get = await request('GET', colorsPath)
  assert.deepEqual(get.json.projects, { 'proj-a': '#1084fe' })
})

test('POST 缺 workspaceId 被拒（400）', async (t) => {
  const { request, colorsPath } = await mount(t)
  const noId = await request('POST', colorsPath, { color: '#1084fe' })
  assert.equal(noId.status, 400)
  assert.equal(noId.json.ok, false)
  const get = await request('GET', colorsPath)
  assert.deepEqual(get.json.projects, {})
})

test('恢复默认：POST color=null 删掉这一项', async (t) => {
  const { request, colorsPath } = await mount(t)
  await request('POST', colorsPath, { workspaceId: 'proj-a', color: '#1084fe' })
  const res = await request('POST', colorsPath, { workspaceId: 'proj-a', color: null })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.projects, {})
})

test('配色文件损坏时 GET 退回空表而不是 500', async (t) => {
  const { request, colorsPath, file, warnings } = await mount(t)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ broken json')
  const res = await request('GET', colorsPath)
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.projects, {})
  assert.ok(warnings.some((m) => /配色/.test(m)), '应该有 warn: ' + warnings.join(' | '))
})
