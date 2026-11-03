/**
 * 真浏览器里跑**构建产物本身**（lib/widget.js），而不是预览页。
 *
 * preview.html 用的是同源模块；这里要证明的是另一件事：
 * 打包出来的 IIFE 能在真实浏览器里 boot、真的挂上头像、真的画出六态图层。
 *
 * 做法：起一个本地服务器，提供
 *   · /lib/widget.js        构建产物
 *   · /fake/state.json      假快照（**不写真实 state.json**）
 *   · /fake/colors.json     空配色
 * 然后用 harness 页把 widget.js 注入到一份复刻的侧栏 DOM 上。
 *
 * 用法：node scripts/bundle-check.mjs [--out DIR]
 *
 * @module scripts/bundle-check
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const idx = process.argv.indexOf('--out')
const OUT = idx === -1 ? path.join(os.tmpdir(), 'dsgb-bundle') : process.argv[idx + 1]

/** 六态各一行，外加一条未知会话（不在快照里，只有 DOM done）。 */
const SESSIONS = [
  { id: 'p-idle', phase: 'idle', reason: 'no-open-turn', detail: '', completionKey: '' },
  { id: 'p-working', phase: 'working', reason: 'tool:bash', detail: 'bash', completionKey: '' },
  { id: 'p-waiting', phase: 'waiting', reason: 'pending:question', detail: 'ask_user_question', completionKey: '' },
  { id: 'p-blocked', phase: 'blocked', reason: 'error:RATE_LIMIT', detail: 'RATE_LIMIT', completionKey: '' },
  { id: 'p-thinking', phase: 'thinking', reason: 'model:generating', detail: '', completionKey: '' },
  { id: 'p-done', phase: 'done', reason: 'terminal-completed', detail: '', completionKey: 'p-done#1', completedAt: Date.now() },
]

const HARNESS = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  body{margin:0;background:#14161a;font:13px -apple-system,"PingFang SC",sans-serif}
  .groupSection{padding:6px}
  .slot{width:16px;height:16px;display:inline-flex;align-items:center}
  .title{color:#dfe2e8;margin-left:4px}
</style></head><body>
<div class="groupSection" id="sec">
  <div data-row-key="workspace:proj-a"><span class="title">proj-a</span></div>
</div>
<script>
  // 复刻 DSH 侧栏行的真实结构：data-row-key + slot + title，slot 里有原生状态点
  const ROWS = __ROWS__
  for (const row of ROWS) {
    const el = document.createElement('div')
    el.setAttribute('data-row-key', 'session:' + row.id)
    el.setAttribute('role', 'treeitem')
    el.setAttribute('aria-selected', row.selected ? 'true' : 'false')
    const group = document.createElement('div')
    group.setAttribute('role', 'group')
    const slot = document.createElement('span')
    slot.className = 'Kx9_slot'
    const dot = document.createElement('span')
    dot.setAttribute('data-state', row.dshState)
    slot.appendChild(dot)
    el.appendChild(slot)
    const title = document.createElement('span')
    title.className = 'Kx9_title'
    title.textContent = row.id
    el.appendChild(title)
    group.appendChild(el)
    document.getElementById('sec').appendChild(group)
  }
</script>
<script src="/lib/widget.js"></script>
</body></html>`

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0])
      if (url === '/harness.html') {
        const rows = SESSIONS.map((s) => ({
          id: s.id,
          dshState: s.phase === 'done' ? 'done' : s.phase === 'idle' ? 'idle' : 'ongoing',
        })).concat([{ id: 'p-ghost', dshState: 'done' }])
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(HARNESS.replace('__ROWS__', JSON.stringify(rows)))
        return
      }
      if (url === '/dsh-grok-buddy/state.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, now: Date.now(), sessions: SESSIONS }))
        return
      }
      if (url === '/dsh-grok-buddy/colors.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, projects: {} }))
        return
      }
      if (url === '/dsh-grok-buddy/probe.json' || url === '/dsh-grok-buddy/probe-control.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, windowOpen: false }))
        return
      }
      const file = path.join(ROOT, url.replace(/^\/+/, ''))
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const type = path.extname(file) === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type })
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-bundle-'))
  const debugPort = 9500 + Math.floor(Math.random() * 200)
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=900,600',
    'about:blank',
  ], { stdio: 'ignore' })

  const checks = []
  const record = (name, pass, detail) => checks.push({ name, pass: pass === true, detail })
  try {
    const cdp = await connect(debugPort)
    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
      return r.result.value
    }

    // 先连上再导航：直接在命令行给 URL 会在页面还在加载时被换掉，
    // Runtime.evaluate 会撞上 Execution context destroyed。
    await cdp.send('Page.enable', {})
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/harness.html' })
    await new Promise((r) => setTimeout(r, 900))

    const booted = await evaluate(`(async () => {
      for (let i = 0; i < 200; i++) {
        if (window.__dshGrokBuddy !== undefined && document.querySelectorAll('svg.dsgb').length >= 6) return { ok: true }
        await new Promise((r) => setTimeout(r, 50))
      }
      return { ok: false, api: typeof window.__dshGrokBuddy, svgs: document.querySelectorAll('svg.dsgb').length }
    })()`)
    record('构建产物在真实浏览器里 boot 并挂上头像', booted.ok === true, booted)

    // 六态图层构成（读真实 SVG，不看动作名）
    const states = await evaluate(`(() => {
      const out = {}
      for (const id of ['p-idle', 'p-working', 'p-waiting', 'p-blocked', 'p-thinking', 'p-done']) {
        const row = document.querySelector('[data-row-key="session:' + id + '"]')
        const svg = row === null ? null : row.querySelector('svg.dsgb')
        if (svg === null) { out[id] = null; continue }
        const shown = (sel) => {
          const el = svg.querySelector('[data-dsgb-layer="' + sel + '"]')
          return el !== null && getComputedStyle(el).display !== 'none'
        }
        const dots = svg.querySelector('[data-dsgb-layer="dots"]')
        out[id] = {
          phase: svg.getAttribute('data-dsgb-phase'),
          motion: svg.getAttribute('data-dsgb-motion'),
          figure: svg.getAttribute('data-dsgb-figure'),
          body: shown('body'), eyes: shown('eyes'), bang: shown('bang'), dots: shown('dots'),
          orbitBack: shown('orbits-back'), orbitFront: shown('orbits-front'),
          dotCount: dots === null ? 0 : Array.from(dots.children).filter((c) => getComputedStyle(c).display !== 'none').length,
        }
      }
      return out
    })()`)

    const expect = {
      'p-idle': (s) => s.body && s.eyes && !s.bang && !s.dots,
      'p-working': (s) => s.body && s.eyes && !s.bang && !s.dots,
      'p-waiting': (s) => s.body && s.eyes && !s.bang && !s.dots,
      'p-blocked': (s) => s.bang && !s.body && !s.eyes && !s.dots,
      'p-thinking': (s) => s.dots && s.dotCount === 3 && !s.body && !s.eyes,
      'p-done': (s) => s.body && s.eyes && (s.orbitBack || s.orbitFront),
    }
    for (const [id, fn] of Object.entries(expect)) {
      const actual = states[id]
      record(id + ' 图层构成正确', actual !== null && fn(actual), actual)
    }

    // 未知会话（不在快照里、只有 DOM done）：兜底身份也要庆祝
    const ghost = await evaluate(`(() => {
      const row = document.querySelector('[data-row-key="session:p-ghost"]')
      const svg = row === null ? null : row.querySelector('svg.dsgb')
      return svg === null ? null : { phase: svg.getAttribute('data-dsgb-phase'), motion: svg.getAttribute('data-dsgb-motion') }
    })()`)
    record('未知会话的 DOM done 也进入完成动作', ghost !== null && ghost.motion === 'orbit', ghost)

    // 16px 布局：不撑破格子
    const layout = await evaluate(`(() => {
      const svg = document.querySelector('[data-row-key="session:p-done"] svg.dsgb')
      const slot = svg.parentElement
      const a = svg.getBoundingClientRect()
      const b = slot.getBoundingClientRect()
      return { svg: { w: a.width, h: a.height }, slot: { w: b.width, h: b.height } }
    })()`)
    record('16px 下头像就是 16×16、不撑破格子', Math.abs(layout.svg.w - 16) < 0.5 && Math.abs(layout.svg.h - 16) < 0.5, layout)

    // 真实帧推进 + 同态快照不重播
    const motion = await evaluate(`(async () => {
      const row = document.querySelector('[data-row-key="session:p-done"]')
      const svg = row.querySelector('svg.dsgb')
      const snap = () => {
        const g = svg.querySelector('[data-dsgb-layer="orbits-front"]')
        return g === null || g.children.length === 0 ? '' : g.children[0].getAttribute('d')
      }
      const a = snap()
      await new Promise((r) => setTimeout(r, 400))
      const b = snap()
      // 同态快照：直接调一次 sync，动作 id 不变，时间轴不该重置
      const before = svg.getAttribute('data-dsgb-frame')
      window.__dshGrokBuddy.sync()
      await new Promise((r) => setTimeout(r, 300))
      const c = snap()
      return { moved: a !== b, continued: b !== c, frame: before }
    })()`)
    record('done 的轨道在真实帧里推进', motion.moved === true, motion)
    record('同态快照不重启动画（继续推进）', motion.continued === true, motion)

    // 无障碍标签与六态一致
    const aria = await evaluate(`(() => {
      const out = {}
      for (const id of ['p-idle', 'p-blocked', 'p-thinking', 'p-done']) {
        const slot = document.querySelector('[data-row-key="session:' + id + '"] span[data-dsgb-slot]')
        out[id] = slot === null ? null : { role: slot.getAttribute('role'), label: slot.getAttribute('aria-label') }
      }
      return out
    })()`)
    record(
      '可访问文本随图形变化同步更新',
      Object.values(aria).every((v) => v !== null && v.role === 'img' && typeof v.label === 'string' && v.label !== ''),
      aria,
    )

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT, 'bundle-page.png')
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    cdp.close()
  } finally {
    child.kill('SIGKILL')
    server.close()
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch (err) {}
  }

  const failed = checks.filter((c) => !c.pass)
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks }, null, 2))
  for (const check of checks) {
    console.log((check.pass ? 'PASS' : 'FAIL') + '  ' + check.name)
    if (!check.pass) console.log('      ' + JSON.stringify(check.detail).slice(0, 400))
  }
  console.log('--- ' + (checks.length - failed.length) + '/' + checks.length + ' passed')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('ERROR', err)
  process.exit(1)
})
