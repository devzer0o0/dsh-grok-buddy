/**
 * 从**生产实现**的文档页截出静态说明图。
 *
 * 为什么要有这个脚本：docs/states.png 曾经是把旧素材缩成一张图，看起来像
 * 「六态已完成」，实际 blocked 还是圆脸、thinking 还是斜眼。现在这张图必须
 * 从新的渲染器截，而且要截**稳态**（不是过渡开始那一刻的普通圆脸）。
 *
 * 用法：node scripts/doc-shots.mjs [--out docs]
 *
 * 依赖：本机 Chrome + 零 npm 依赖（CDP over WebSocket）。
 *
 * @module scripts/doc-shots
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.resolve(ROOT, process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'docs')

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
    if (pending.has(msg.id)) {
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
  fs.mkdirSync(OUT, { recursive: true })
  const { server, port } = await startServer()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-doc-'))
  const debugPort = 9600 + Math.floor(Math.random() * 200)
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1200,900',
    'http://127.0.0.1:' + port + '/docs/states.html',
  ], { stdio: 'ignore' })
  const shots = []
  try {
    const cdp = await connect(debugPort)
    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result.value
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 720, deviceScaleFactor: 2, mobile: false })
    // 等页面里的实例全部就位
    await evaluate(`(async () => { for (let i = 0; i < 100; i++) { if (document.querySelectorAll('svg.dsgb').length >= 12) return true; await new Promise(r => setTimeout(r, 50)) } return false })()`)

    const shoot = async (file, clip) => {
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...clip, scale: clip.scale || 2 },
        captureBeyondViewport: true,
      })
      const out = path.join(OUT, file)
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
      shots.push(out)
    }

    const box = async (selector) => evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`)

    const hull = await box('body > h1')
    const bodyBox = await box('body')
    // 整页：从标题到 note 结束
    await shoot('states.png', { x: 0, y: 0, width: 900, height: Math.ceil(bodyBox.height) })
    void hull

    // 64px 那一排
    const bigGrid = await evaluate(`(() => {
      const grids = document.querySelectorAll('.grid')
      const plane = grids[0].getBoundingClientRect()
      return { x: Math.max(0, plane.x - 4), y: Math.max(0, plane.y - 4), width: plane.width + 8, height: plane.height + 8 }
    })()`)
    await shoot('states-64.png', { ...bigGrid, scale: 3 })

    // 24px 那一排（BOT_SIZE，按 8 倍截，便于在文档里看清真实像素）
    const smallGrid = await evaluate(`(() => {
      const grids = document.querySelectorAll('.grid')
      const plane = grids[1].getBoundingClientRect()
      return { x: Math.max(0, plane.x - 4), y: Math.max(0, plane.y - 4), width: plane.width + 8, height: plane.height + 8 }
    })()`)
    await shoot('states-24.png', { ...smallGrid, scale: 8 })

    // faces 页
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/docs/faces.html' })
    await new Promise((r) => setTimeout(r, 900))
    await evaluate(`(async () => { for (let i = 0; i < 100; i++) { if (document.querySelectorAll('svg.dsgb').length > 5) return true; await new Promise(r => setTimeout(r, 50)) } return false })()`)
    const facesBox = await box('body')
    await shoot('faces.png', { x: 0, y: 0, width: 900, height: Math.ceil(facesBox.height) })

    cdp.close()
  } finally {
    child.kill('SIGKILL')
    server.close()
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch (err) {}
  }
  console.log(JSON.stringify(shots.map((p) => ({ file: path.relative(ROOT, p), bytes: fs.statSync(p).size })), null, 2))
}

main().catch((err) => {
  console.error('ERROR', err)
  process.exit(1)
})
