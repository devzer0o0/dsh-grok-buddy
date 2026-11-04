/**
 * 把六态动画录成一段 GIF（docs/effect.gif），给 README 当"这玩意儿会动"的证据。
 *
 * 为什么用真浏览器逐帧抓：这六态里有弹簧形变、相位差、轨道穿插，
 * 任何"用静态图合成"的做法都会失真。这里抓到的是产品渲染器真实的帧。
 *
 * 用法：node scripts/doc-motion-gif.mjs [--frames=36] [--interval=90] [--width=430]
 *
 * 依赖：本机 Chrome + ffmpeg。
 *
 * @module scripts/doc-motion-gif
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'docs', 'effect.gif')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit === undefined ? fallback : Number(hit.split('=')[1])
}
const FRAMES = flag('frames', 36)
const INTERVAL = flag('interval', 90)
const WIDTH = flag('width', 430)
const HEIGHT = flag('height', 260)
const SCALE = flag('scale', 2)

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

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(command + ' exited ' + code + ': ' + err.slice(-400)))))
  })
}

async function main() {
  const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    .find((p) => fs.existsSync(p))
  if (chrome === undefined) {
    console.log('SKIP: no Chrome')
    process.exit(2)
  }
  const { server, port } = await startServer()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-gif-'))
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-frames-'))
  const debugPort = 9500 + Math.floor(Math.random() * 200)
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=' + SCALE,
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=' + WIDTH + ',' + HEIGHT,
    'http://127.0.0.1:' + port + '/docs/motion-gif.html',
  ], { stdio: 'ignore' })
  let frames = 0
  try {
    const cdp = await connect(debugPort)
    const transient = (err) => /Execution context was destroyed|Cannot find context with specified id/i.test(String(err && err.message))
    const evaluate = async (expression) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
          if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails))
          return r.result.value
        } catch (err) {
          if (attempt >= 6 || !transient(err)) throw err
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
        }
      }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false })
    await evaluate("(async () => { for (let i = 0; i < 200; i++) { if (window.__ready === true) { await new Promise(r => setTimeout(r, 700)); return true } await new Promise(r => setTimeout(r, 50)) } return false })()")
    const box = await evaluate("(() => { const b = document.querySelector('.pane').getBoundingClientRect(); return { x: Math.floor(b.x) - 10, y: Math.floor(b.y) - 10, width: Math.ceil(b.width) + 20, height: Math.ceil(b.height) + 20 } })()")
    // 逐帧抓：每帧之间让页面真的跑一会儿动画（不是重复同一张）
    for (let i = 0; i < FRAMES; i++) {
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...box, scale: SCALE },
        captureBeyondViewport: true,
      })
      const file = path.join(framesDir, 'f' + String(i).padStart(3, '0') + '.png')
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      frames += 1
      await new Promise((r) => setTimeout(r, INTERVAL))
    }
    cdp.close()
  } finally {
    child.kill('SIGKILL')
    server.close()
  }

  // GIF 用调色板 + 抖动，一帧只保留 64 色就够（界面本来就是大面积纯色）
  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(Math.round(1000 / INTERVAL)),
    '-i', path.join(framesDir, 'f%03d.png'),
    '-vf', 'scale=' + Math.round(WIDTH * SCALE) + ':-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0',
    OUT,
  ])
  fs.rmSync(framesDir, { recursive: true, force: true })
  try {
    fs.rmSync(profile, { recursive: true, force: true })
  } catch (err) {}
  console.log(JSON.stringify({ file: path.relative(ROOT, OUT), bytes: fs.statSync(OUT).size, frames }, null, 2))
}

main().catch((err) => {
  console.error('ERROR', err)
  process.exit(1)
})
