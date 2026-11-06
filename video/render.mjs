/**
 * 把 video/scene.html 逐帧抓成 mp4。
 * 依赖：本机 Chrome + ffmpeg。用法：node video/render.mjs [--fps=30] [--dur=47]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUTDIR = path.join(HERE, 'out')
const FRAMES = path.join(OUTDIR, 'frames')

const arg = (n, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + n + '='))
  return hit === undefined ? d : Number(hit.split('=')[1])
}
const FPS = arg('fps', 30)
const DUR = arg('dur', 47)
const AUDIO = process.argv.slice(2).find((a) => a === '--no-audio') ? null : path.join(OUTDIR, 'audio.m4a')

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.mjs': 'text/javascript; charset=utf-8' }

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0])
      const file = path.join(ROOT, url.replace(/^\/+/, ''))
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(fs.readFileSync(file))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function connect(port) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  return (async () => {
    let target = null
    for (let i = 0; i < 250 && target === null; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null
      } catch (e) {}
      if (target === null) await wait(100)
    }
    if (target === null) throw new Error('no page target')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
    let seq = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data) } catch (e) { return }
      if (m.id !== undefined && pending.has(m.id)) {
        const e = pending.get(m.id); pending.delete(m.id)
        if (m.error !== undefined) e.reject(new Error(JSON.stringify(m.error))); else e.resolve(m.result)
      }
    })
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
    return { send, close: () => ws.close() }
  })()
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  const c = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  c.stderr.on('data', (d) => { err += String(d) })
  c.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(cmd + ' ' + code + ': ' + err.slice(-600)))))
})

async function main() {
  const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    .find((p) => fs.existsSync(p))
  if (!chrome) throw new Error('no Chrome')
  fs.rmSync(FRAMES, { recursive: true, force: true })
  fs.mkdirSync(FRAMES, { recursive: true })

  const { server, port } = await serve()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-vid-'))
  const dbg = 9200 + Math.floor(Math.random() * 300)
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--remote-debugging-port=' + dbg, '--user-data-dir=' + profile, '--no-first-run',
    '--no-default-browser-check', '--window-size=1080,1920',
    'http://127.0.0.1:' + port + '/video/scene.html',
  ], { stdio: 'ignore' })

  const total = Math.round(DUR * FPS)
  try {
    const cdp = await connect(dbg)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false })
    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails))
      return r.result.value
    }
    const ok = await evaluate('(async()=>{for(let i=0;i<300;i++){if(window.__ready===true)return true;await new Promise(r=>setTimeout(r,50))}return false})()')
    if (!ok) throw new Error('scene not ready')
    await new Promise((r) => setTimeout(r, 400))

    const t0 = Date.now()
    for (let i = 0; i < total; i++) {
      const t = i / FPS
      await evaluate('window.__render(' + t + ')')
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.writeFileSync(path.join(FRAMES, 'f' + String(i).padStart(4, '0') + '.png'), Buffer.from(shot.data, 'base64'))
      if (i % 150 === 0) console.log('frame ' + i + '/' + total + '  ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')
    }
    cdp.close()
  } finally {
    child.kill('SIGKILL')
    server.close()
  }

  const mp4 = path.join(OUTDIR, 'dsh-grok-buddy-promo.mp4')
  const args = ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(FRAMES, 'f%04d.png')]
  if (AUDIO && fs.existsSync(AUDIO)) args.push('-i', AUDIO)
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS))
  if (AUDIO && fs.existsSync(AUDIO)) args.push('-c:a', 'aac', '-b:a', '160k', '-shortest')
  args.push('-movflags', '+faststart', mp4)
  await run('ffmpeg', args)

  const gif = path.join(OUTDIR, 'preview.gif')
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf',
    'fps=10,scale=360:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0', gif])

  try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {}
  console.log(JSON.stringify({ mp4, bytes: fs.statSync(mp4).size, gif, gifBytes: fs.statSync(gif).size, frames: total }, null, 2))
}

main().catch((e) => { console.error('ERROR', e); process.exit(1) })
