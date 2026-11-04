/**
 * 通用文档截图：把仓库当静态站起一个本地服务，用真 Chrome 打开某个 docs 页，
 * 按选择器裁图或用整页，存成 PNG。
 *
 * 为什么不用手点：README 里的每张图都要能从仓库里重跑出来，并且截的是
 * **产品同一个渲染器**（docs 页加载 lib/widget.js 或 src/grokbot/*），不是另画的示意图。
 *
 * 用法：
 *   node scripts/doc-shot.mjs <page> <out.png> [selector] [--width=1200] [--dpr=2] [--wait=dsgb]
 *
 *   node scripts/doc-shot.mjs docs/hero.html docs/hero.png
 *   node scripts/doc-shot.mjs docs/project-colors.html docs/project-colors-light.png "#grid-light"
 *
 * @module scripts/doc-shot
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0])
      const file = path.join(ROOT, url.replace(/^\/+/, ''))
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(fs.readFileSync(file))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function connect(port) {
  let target = null
  for (let i = 0; i < 250 && target === null; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null
    } catch (err) {}
    if (target === null) await new Promise((r) => setTimeout(r, 100))
  }
  if (target === null) throw new Error('no page target')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch (err) {
      return
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error !== undefined) entry.reject(new Error(JSON.stringify(msg.error)))
      else entry.resolve(msg.result)
    }
  })
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  return { send, close: () => ws.close() }
}

const argv = process.argv.slice(2)
const flags = new Map()
const positional = []
for (const arg of argv) {
  const m = /^--([a-zA-Z]+)=(.*)$/.exec(arg)
  if (m !== null) flags.set(m[1], m[2])
  else positional.push(arg)
}
const page = positional[0]
const out = positional[1]
const selector = positional[2]
if (page === undefined || out === undefined) {
  console.error('usage: node scripts/doc-shot.mjs <page.html> <out.png> [selector] [--width=1200] [--dpr=2] [--wait=dsgb]')
  process.exit(64)
}
const WIDTH = Number(flags.get('width') || 1200)
const HEIGHT = Number(flags.get('height') || 900)
const DPR = Number(flags.get('dpr') || 2)
const WAIT = flags.get('wait') || 'dsgb'
// 截图前的额外等待：有些页面要等一次交互（打开调色板、切换主题）才到目标画面。
const POST = Number(flags.get('post') || 0)
// 额外纳入裁剪范围的元素（例如 position:fixed 的调色板 —— 它不撑高 body，
// 只按 body 裁就会把它截掉一半）。逗号分隔。
const INCLUDE = (flags.get('include') || '').split(',').map((s) => s.trim()).filter((s) => s !== '')

async function main() {
  const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    .find((p) => fs.existsSync(p))
  if (chrome === undefined) {
    console.log('SKIP: no Chrome')
    process.exit(2)
  }
  const { server, port } = await startServer()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-shot-'))
  const debugPort = 9700 + Math.floor(Math.random() * 200)
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=' + WIDTH + ',' + HEIGHT,
    'http://127.0.0.1:' + port + '/' + page,
  ], { stdio: 'ignore' })
  try {
    const cdp = await connect(debugPort)
    /**
     * headless Chrome 首次导航时会偶发 "Execution context was destroyed" / "Cannot find
     * context" —— 那是 CDP 的瞬态竞态（页面还在换文档），不是断言失败。这里只对
     * **幂等只读**的探测重试，其它异常照旧立刻抛出。
     */
    const transient = (err) => /Execution context was destroyed|Cannot find context with specified id/i.test(String(err && err.message))
    const evaluate = async (expression, retries) => {
      const budget = typeof retries === 'number' ? retries : 6
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
          if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails))
          return r.result.value
        } catch (err) {
          if (attempt >= budget || !transient(err)) throw err
          await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
        }
      }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: DPR, mobile: false })
    // 等产品实例真的挂上去（不是等 DOMContentLoaded）
    const probe = WAIT === 'none'
      ? 'true'
      : WAIT === 'dsgb'
        ? "document.querySelectorAll('svg.dsgb-bot').length > 0"
        : "document.querySelectorAll('" + WAIT + "').length > 0"
    await evaluate(`(async () => {
      for (let i = 0; i < 200; i++) { if (${probe}) { await new Promise(r => setTimeout(r, 450)); return true } await new Promise(r => setTimeout(r, 50)) }
      return false
    })()`)
    if (POST > 0) await new Promise((resolve) => setTimeout(resolve, POST))
    const clip = await evaluate(`(() => {
      const sel = ${JSON.stringify(selector || null)}
      const el = sel === null ? document.body : document.querySelector(sel)
      if (el === null) return null
      const pad = sel === null ? 0 : 2
      const rects = [el.getBoundingClientRect()]
      for (const extra of ${JSON.stringify(INCLUDE)}) {
        for (const node of document.querySelectorAll(extra)) {
          // 只算真的画出来的：display:none 的浮层没有尺寸
          const r = node.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) rects.push(r)
        }
      }
      const left = Math.min(...rects.map((r) => r.x))
      const top = Math.min(...rects.map((r) => r.y))
      const right = Math.max(...rects.map((r) => r.x + r.width))
      const bottom = Math.max(...rects.map((r) => r.y + r.height))
      return {
        x: Math.max(0, Math.floor(left) - pad),
        y: Math.max(0, Math.floor(top) - pad),
        width: Math.ceil(right - left) + pad * 2,
        height: Math.ceil(bottom - top) + pad * 2,
      }
    })()`)
    if (clip === null) throw new Error('selector not found: ' + selector)
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...clip, scale: DPR },
      captureBeyondViewport: true,
    })
    const dest = path.join(ROOT, out)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, Buffer.from(shot.data, 'base64'))
    cdp.close()
  } finally {
    child.kill('SIGKILL')
    server.close()
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch (err) {}
  }
  const dest = path.join(ROOT, out)
  console.log(JSON.stringify({ file: out, bytes: fs.statSync(dest).size }, null, 2))
}

main().catch((err) => {
  console.error('ERROR', err)
  process.exit(1)
})
