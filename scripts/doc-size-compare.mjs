/**
 * 从**生产实现**的文档页截出说明图（docs/size-compare.png）。
 *
 * 为什么单独一张：README 要回答「为什么继续适度放大」。这张图必须把
 * 20px 与 24px 放在同一行、同一身份色下比，且截图是真实设备像素（DPR 3），
 * 不是把预览放大冒充「看得清」。
 *
 * 用法：node scripts/doc-size-compare.mjs
 *
 * 依赖：本机 Chrome + 零 npm 依赖（CDP over WebSocket）。
 *
 * @module scripts/doc-size-compare
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'docs', 'size-compare.png')

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif' }

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
  for (let i = 0; i < 200 && target === null; i++) {
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
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
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

async function main() {
  const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    .find((p) => fs.existsSync(p))
  if (chrome === undefined) {
    console.log('SKIP: no Chrome')
    process.exit(2)
  }
  const { server, port } = await startServer()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-size-'))
  const debugPort = 9800 + Math.floor(Math.random() * 200)
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1100,760',
    'http://127.0.0.1:' + port + '/docs/size-compare.html',
  ], { stdio: 'ignore' })
  try {
    const cdp = await connect(debugPort)
    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result.value
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 560, deviceScaleFactor: 2, mobile: false })
    await evaluate(`(async () => { for (let i = 0; i < 120; i++) { if (document.querySelectorAll('svg.dsgb').length >= 12) return true; await new Promise(r => setTimeout(r, 50)) } return false })()`)
    const box = await evaluate(`(() => {
      const b = document.body.getBoundingClientRect()
      return { x: 0, y: 0, width: Math.ceil(b.width), height: Math.ceil(b.height) }
    })()`)
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...box, scale: 3 },
      captureBeyondViewport: true,
    })
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
    cdp.close()
  } finally {
    child.kill('SIGKILL')
    server.close()
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch (err) {}
  }
  console.log(JSON.stringify({ file: path.relative(ROOT, OUT), bytes: fs.statSync(OUT).size }, null, 2))
}

main().catch((err) => {
  console.error('ERROR', err)
  process.exit(1)
})
