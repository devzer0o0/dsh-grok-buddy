/** 把 video/cover.html 截成 B 站封面 1920x1080。 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(HERE, 'out', 'cover.png')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  const file = path.join(ROOT, url.replace(/^\/+/, ''))
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
  res.end(fs.readFileSync(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-cover-'))
const dbg = 9400 + Math.floor(Math.random() * 200)
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const child = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--remote-debugging-port=' + dbg, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
  '--window-size=1920,1080', 'http://127.0.0.1:' + port + '/video/cover.html'], { stdio: 'ignore' })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let target = null
for (let i = 0; i < 250 && !target; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + dbg + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null
  } catch (e) {}
  if (!target) await wait(100)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { const e = pending.get(m.id); pending.delete(m.id); m.error ? e.reject(new Error(JSON.stringify(m.error))) : e.resolve(m.result) }
})
const send = (method, params) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })

await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
await send('Runtime.evaluate', { expression: '(async()=>{for(let i=0;i<300;i++){if(window.__ready===true)return true;await new Promise(r=>setTimeout(r,50))}return false})()', awaitPromise: true, returnByValue: true })
await send('Runtime.evaluate', { expression: 'window.__render(1.7)', awaitPromise: true, returnByValue: true })
await wait(500)
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
ws.close(); child.kill('SIGKILL'); server.close()
try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {}
console.log(JSON.stringify({ cover: OUT, bytes: fs.statSync(OUT).size }))
