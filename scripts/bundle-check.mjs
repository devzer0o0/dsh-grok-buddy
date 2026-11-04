/**
 * 真浏览器里跑**构建产物本身**（lib/widget.js），而不是预览页。
 *
 * preview.html 用的是同源模块；这里要证明的是另一件事：
 * 打包出来的 IIFE 能在真实浏览器里 boot、真的挂上头像、真的画出六态图层。
 *
 * 做法：起一个本地服务器，提供
 *   · /lib/widget.js        构建产物
 *   · /dsh-grok-buddy/state.json   假快照（**不写真实 state.json**）
 *   · /dsh-grok-buddy/colors.json  有状态假配色（POST 会真的记下来）
 * 然后用 harness 页把 widget.js 注入到一份**照宿主真实结构复刻**的侧栏 DOM 上：
 * 项目行带原生文件夹 SVG（d 取自 dsh-client-ui-workspace 实际用的
 * IconFolderOpenRegular / IconFolderCloseRegular，currentColor 描边/填充）、
 * 箭头格、标题与 rowActions，宿主的 slot/folderActive 颜色规则也照抄，
 * 以便验证文件夹着色压得过宿主规则、又不殃及标题/箭头/按钮。
 *
 * 用法：node scripts/bundle-check.mjs [--out DIR] [--shots DIR]
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
const shotIdx = process.argv.indexOf('--shots')
const SHOTS = shotIdx === -1 ? null : process.argv[shotIdx + 1]

/** '#rrggbb' → 'r, g, b'（与 getComputedStyle().color 的 rgb() 形式对齐用）。 */
function hexToRgbParts(hex) {
  const value = String(hex).replace('#', '')
  const n = Number.parseInt(value, 16)
  return ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255)
}

/** 六态各一行，外加一条未知会话（不在快照里，只有 DOM done）。 */
const SESSIONS = [
  { id: 'p-idle', phase: 'idle', reason: 'no-open-turn', detail: '', completionKey: '' },
  { id: 'p-working', phase: 'working', reason: 'tool:bash', detail: 'bash', completionKey: '' },
  { id: 'p-waiting', phase: 'waiting', reason: 'pending:question', detail: 'ask_user_question', completionKey: '' },
  // blocked 的 fixture 必须表达「任务已因错误停止」：只写 reason=error:RATE_LIMIT 只能
  // 证明「见过一个错误码」，证明不了任务停止 —— 新规则下会被页面降级成 idle。
  {
    id: 'p-blocked',
    phase: 'blocked',
    reason: 'stop:RATE_LIMIT',
    detail: 'RATE_LIMIT',
    completionKey: '',
    stopCertain: true,
    // 证据必须齐：确证来源 + 明确错误原因 + 当前轮身份（三缺一都会被降级）。
    stopCause: 'error',
    stopSource: 'turn/end:error',
    stopCode: 'RATE_LIMIT',
    turnKey: 'p-blocked#7',
    stopTurnKey: 'p-blocked#7',
  },
  { id: 'p-thinking', phase: 'thinking', reason: 'model:generating', detail: '', completionKey: '' },
  { id: 'p-done', phase: 'done', reason: 'terminal-completed', detail: '', completionKey: 'p-done#1', completedAt: Date.now() },
]

/**
 * 项目分区表。proj-a 与 proj-b **同名**（钉死「身份只认 data-row-key，标题不参与」）；
 * proj-b 折叠且没有会话（钉死「不依赖会话记录」）；空 key 是未分组桶。
 * proj-a 的文件夹带 folderActive（宿主「含当前会话」时给的类）—— 用来验证
 * 插件的项目色压得过宿主的固定蓝。
 */
const PROJECTS = [
  { key: 'proj-a', title: 'dsh-grok-buddy', expanded: true, active: true, sessions: SESSIONS.map((s) => s.id) },
  { key: 'proj-b', title: 'dsh-grok-buddy', expanded: false, active: false, sessions: [] },
  { key: '', title: '未分组', expanded: true, active: false, sessions: ['p-ghost'] },
]

/**
 * 原生文件夹图标（d 值取自 dsh-web-frontend 里 IconFolderCloseRegular /
 * IconFolderOpenRegular 的真实 SVG；两者全走 currentColor —— close 是描边、
 * open 是带 16% 透明度衬底的填充）。
 */
const FOLDER_SVGS = {
  close:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true">' +
    '<path d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z" stroke="currentColor"/>' +
    '<path d="M3.63501 7.66614H12.3647" stroke="currentColor"/></svg>',
  open:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true">' +
    '<path d="M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z" fill="currentColor" opacity="0.16"/>' +
    '<path d="M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z" fill="currentColor"/>' +
    '<path d="M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z" fill="currentColor"/></svg>',
}

const HARNESS = `<!doctype html><html lang="zh-CN" data-ds-theme="light"><head><meta charset="utf-8">
<style>
  /* 宿主样式的忠实子集：项目行 34px、slot 16×20、folderActive 固定蓝、
     hover 时箭头顶替文件夹。明暗由 html[data-ds-theme] 切换。 */
  html{--row-fg:#1f2328;--row-bg:#ffffff;--slot-fg:#8a8f98}
  html[data-ds-theme="dark"]{--row-fg:#dfe2e8;--row-bg:#14161a}
  body{margin:0;background:var(--row-bg);color:var(--row-fg);font:13px -apple-system,"PingFang SC",sans-serif}
  .groupSection{padding:6px;width:280px}
  .JoiKIa_projectRow,.JoiKIa_sessionRow{border-radius:8px;padding:0 8px;cursor:pointer;user-select:none;color:var(--row-fg);align-items:center;gap:6px;display:flex}
  .JoiKIa_projectRow{box-sizing:border-box;height:34px}
  .JoiKIa_sessionRow{gap:0;height:32px}
  .JoiKIa_slot{width:16px;height:20px;color:var(--slot-fg);flex:none;justify-content:center;align-items:center;display:inline-flex}
  .JoiKIa_folderActive{color:#1084fe}
  .JoiKIa_chevron{display:none}
  .JoiKIa_projectRow:hover .JoiKIa_chevron{display:inline-flex}
  .JoiKIa_projectRow:hover .JoiKIa_folder{display:none}
  .JoiKIa_arrow{transition:transform .15s}
  .JoiKIa_arrowOpen{transform:rotate(90deg)}
  .JoiKIa_title{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:14px;line-height:20px;overflow:hidden}
  .JoiKIa_rowActions{flex:none;align-items:center;gap:15px;display:none}
  .JoiKIa_projectRow:hover .JoiKIa_rowActions{display:inline-flex}
  .JoiKIa_iconButton{border-radius:4px;cursor:pointer;width:16px;height:16px;color:var(--slot-fg);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}
</style></head><body>
<div id="sidebar"></div>
<script>
  const FOLDER_SVGS = __FOLDERS__
  const PROJECTS = __PROJECTS__
  const ROWS = __ROWS__
  const sidebar = document.getElementById('sidebar')
  const sessionRow = (row) => {
    const el = document.createElement('div')
    el.setAttribute('data-row-key', 'session:' + row.id)
    el.setAttribute('role', 'treeitem')
    el.setAttribute('aria-selected', row.selected ? 'true' : 'false')
    const slot = document.createElement('span')
    slot.className = 'Kx9_slot'
    const dot = document.createElement('span')
    dot.setAttribute('data-state', row.dshState)
    slot.appendChild(dot)
    el.appendChild(slot)
    const title = document.createElement('span')
    title.className = 'Kx9_title'
    title.style.margin = '0 6px 0 4px'
    title.textContent = row.id
    el.appendChild(title)
    return el
  }
  for (const project of PROJECTS) {
    const section = document.createElement('div')
    section.className = 'JoiKIa_groupSection'
    const row = document.createElement('div')
    row.className = 'JoiKIa_projectRow'
    row.setAttribute('data-row-key', 'workspace:' + project.key)
    row.setAttribute('role', 'treeitem')
    row.setAttribute('aria-expanded', project.expanded ? 'true' : 'false')
    const folder = document.createElement('span')
    folder.className = 'JoiKIa_slot JoiKIa_folder' + (project.active ? ' JoiKIa_folderActive' : '')
    folder.innerHTML = project.expanded ? FOLDER_SVGS.open : FOLDER_SVGS.close
    row.appendChild(folder)
    const chevron = document.createElement('span')
    chevron.className = 'JoiKIa_slot JoiKIa_chevron'
    chevron.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M5 3 L11 8 L5 13 Z" fill="currentColor"/></svg>'
    row.appendChild(chevron)
    const text = document.createElement('span')
    text.className = 'JoiKIa_projectText'
    const title = document.createElement('span')
    title.className = 'JoiKIa_title'
    title.textContent = project.title
    text.appendChild(title)
    row.appendChild(text)
    const actions = document.createElement('span')
    actions.className = 'JoiKIa_rowActions'
    for (const label of ['工作区操作', '新建会话']) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'JoiKIa_iconButton'
      button.setAttribute('aria-label', label)
      button.textContent = label === '工作区操作' ? '⋯' : '+'
      actions.appendChild(button)
    }
    row.appendChild(actions)
    const hcRoot = document.createElement('span')
    hcRoot.className = 'hc-root'
    hcRoot.appendChild(row)
    section.appendChild(hcRoot)
    if (project.expanded) {
      const group = document.createElement('div')
      group.setAttribute('role', 'group')
      for (const id of project.sessions) {
        const row2 = ROWS.find((r) => r.id === id)
        if (row2 !== undefined) group.appendChild(sessionRow(row2))
      }
      section.appendChild(group)
    }
    sidebar.appendChild(section)
  }
</script>
<script src="/lib/widget.js"></script>
</body></html>`

function startServer() {
  /** 有状态假配色表：POST 真的记下来（key 已是 widget 发来的 storeKey）。 */
  const colorProjects = {}
  let failNextColorsPost = false
  const readBody = (req, done) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => done(raw))
    req.on('error', () => done(raw))
  }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0])
      if (url === '/harness.html') {
        const rows = SESSIONS.map((s) => ({
          id: s.id,
          dshState: s.phase === 'done' ? 'done' : s.phase === 'idle' ? 'idle' : 'ongoing',
        })).concat([{ id: 'p-ghost', dshState: 'done' }])
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          HARNESS.replace('__FOLDERS__', JSON.stringify(FOLDER_SVGS))
            .replace('__PROJECTS__', JSON.stringify(PROJECTS))
            .replace('__ROWS__', JSON.stringify(rows)),
        )
        return
      }
      if (url === '/dsh-grok-buddy/state.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, now: Date.now(), sessions: SESSIONS }))
        return
      }
      if (url === '/dsh-grok-buddy/colors.json' && req.method === 'POST') {
        if (failNextColorsPost) {
          failNextColorsPost = false
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: '写不进去（测试注入的失败）' }))
          return
        }
        return readBody(req, (raw) => {
          let payload
          try {
            payload = JSON.parse(raw)
          } catch (err) {
            payload = {}
          }
          const key = typeof payload.workspaceId === 'string' ? payload.workspaceId : ''
          if (payload.color === null || payload.color === undefined || payload.color === '') delete colorProjects[key]
          else if (/^#[0-9a-f]{6}$/.test(String(payload.color))) colorProjects[key] = String(payload.color)
          else {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: '颜色必须是 #rrggbb' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, projects: colorProjects }))
        })
      }
      if (url === '/dsh-grok-buddy/colors.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, projects: colorProjects }))
        return
      }
      if (url === '/__test/control' && req.method === 'POST') {
        return readBody(req, (raw) => {
          try {
            const control = JSON.parse(raw)
            if (control.action === 'fail-next-colors') failNextColorsPost = true
            // 直接改写假配色表（测试里模拟「别的窗口改了 / 删了配置」）
            if (control.action === 'set-colors' && control.projects !== null && typeof control.projects === 'object') {
              for (const key of Object.keys(colorProjects)) delete colorProjects[key]
              for (const [key, value] of Object.entries(control.projects)) {
                if (/^#[0-9a-f]{6}$/.test(String(value))) colorProjects[key] = String(value)
              }
            }
          } catch (err) {}
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true }))
        })
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

    // ── 项目文件夹着色（只有显式选过颜色的项目才着色）──────────────────────
    // 默认（未设置）：文件夹保持 DSH 原生色 —— 普通态是宿主灰、folderActive
    // 是宿主蓝，且随主题变化。插件标记与颜色变量一个都不许有。
    // 对照组：同一主题同一状态下、没有插件覆盖的宿主节点（用「停掉插件后的
    // 值」与「兄弟行的宿主灰」交叉核对）。
    const folderDefault = await evaluate(`(async () => {
      const inkOf = (el) => getComputedStyle(el).color
      const folderOf = (key) => document.querySelector('[data-row-key="workspace:' + key + '"] > .JoiKIa_slot.JoiKIa_folder')
      const folders = window.__dshGrokBuddy.folders()
      const a = folderOf('proj-a'), b = folderOf('proj-b'), u = folderOf('')
      const titleA = document.querySelector('[data-row-key="workspace:proj-a"] .JoiKIa_title')
      const chevronA = document.querySelector('[data-row-key="workspace:proj-a"] .JoiKIa_chevron')
      const btnA = document.querySelector('[data-row-key="workspace:proj-a"] .JoiKIa_iconButton')
      const svgA = a.querySelector('svg')
      const r = a.getBoundingClientRect()
      const hostA = inkOf(a)
      const hostB = inkOf(b)
      const hostU = inkOf(u)
      return {
        api: folders,
        inkA: hostA, inkB: hostB, inkU: hostU,
        varA: a.style.getPropertyValue('--dsgb-workspace-ink'),
        markedA: a.getAttribute('data-dsgb-workspace-folder'),
        // 宿主自己的 class 必须原样保留（folderActive 是选中色的来源）
        classA: a.getAttribute('class'),
        titleColor: getComputedStyle(titleA).color,
        chevronColor: chevronA === null ? null : getComputedStyle(chevronA).color,
        btnColor: getComputedStyle(btnA).color,
        svgSize: { w: svgA.getBoundingClientRect().width, h: svgA.getBoundingClientRect().height },
        slotSize: { w: r.width, h: r.height },
        strokeWidth: getComputedStyle(svgA.querySelector('path')).strokeWidth,
      }
    })()`)
    const sameInk = (a, b) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '')
    record(
      '默认（未设置）：三个文件夹都没有插件标记与颜色变量，诊断里 chosen=null',
      folderDefault.markedA === null &&
        folderDefault.varA === '' &&
        folderDefault.api.map((f) => f.workspaceId).join(',') === 'proj-a,proj-b,' &&
        folderDefault.api.every((f) => f.marked === false && f.ink === null && f.chosen === null),
      folderDefault,
    )
    record(
      '默认（未设置）：实际 computed color 就是宿主自己的颜色（普通灰 / folderActive 蓝）',
      sameInk(folderDefault.inkA, 'rgb(16, 132, 254)') &&
        sameInk(folderDefault.inkB, 'rgb(138, 143, 152)') &&
        sameInk(folderDefault.inkU, 'rgb(138, 143, 152)') &&
        /folderActive/.test(String(folderDefault.classA)),
      folderDefault,
    )
    record(
      '标题 / 箭头 / 按钮没有被一起染色（仍是宿主的灰）',
      sameInk(folderDefault.titleColor, 'rgb(31, 35, 40)') &&
        sameInk(folderDefault.chevronColor, 'rgb(138, 143, 152)') &&
        sameInk(folderDefault.btnColor, 'rgb(138, 143, 152)'),
      folderDefault,
    )
    record(
      '文件夹图标几何不变：svg 16×16、格子 16×20、描边 1px',
      Math.abs(folderDefault.svgSize.w - 16) < 0.5 &&
        Math.abs(folderDefault.svgSize.h - 16) < 0.5 &&
        Math.abs(folderDefault.slotSize.w - 16) < 0.5 &&
        Math.abs(folderDefault.slotSize.h - 20) < 0.5 &&
        Math.abs(Number.parseFloat(folderDefault.strokeWidth) - 1) < 0.01,
      folderDefault,
    )

    // 调色板真实交互：⋯ 菜单 → 颜色 → 预设红 → 文件夹与 Buddy 立即同色
    /** proj-a 的哈希默认墨色（Buddy 恢复默认后应显示它）。 */
    const windowDefaultInk = await evaluate(`window.__dshGrokBuddy.defaultInk('proj-a')`)
    const paletteFlow = await evaluate(`(async () => {
      const openPalette = async () => {
        const row = document.querySelector('[data-row-key="workspace:proj-a"]')
        row.classList.add('JoiKIa_menuOpen')
        document.querySelector('[data-menu-material]')?.remove()
        const menu = document.createElement('div')
        menu.setAttribute('data-menu-material', '')
        const wrap = document.createElement('div')
        for (const label of ['重命名', '删除工作区']) {
          const b = document.createElement('button')
          b.setAttribute('role', 'menuitem')
          b.textContent = label
          wrap.appendChild(b)
        }
        menu.appendChild(wrap)
        document.body.appendChild(menu)
        for (let i = 0; i < 60 && document.querySelector('.dsgb-menu-item') === null; i++) {
          await new Promise((r) => setTimeout(r, 100))
        }
        const entry = document.querySelector('.dsgb-menu-item button')
        if (entry === null) return null
        entry.click()
        for (let i = 0; i < 30 && document.querySelector('.dsgb-palette') === null; i++) {
          await new Promise((r) => setTimeout(r, 50))
        }
        return document.querySelector('.dsgb-palette')
      }
      const box = await openPalette()
      if (box === null) return { step: 'palette' }
      const folder = document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')
      const bot = document.querySelector('[data-row-key="session:p-working"] svg.dsgb')
      const body = bot.querySelector('[data-dsgb-layer="body"] > path')
      const before = getComputedStyle(folder).color
      const beforeBot = getComputedStyle(body).fill
      // 未设置时：不许把任何色块标成已选、自定义框不预填
      const presetOn = box.querySelectorAll('.dsgb-swatch.is-on').length
      const inputValue = box.querySelector('.dsgb-hex').value
      const resetText = box.querySelector('.dsgb-palette-reset').textContent
      const hint = (box.querySelector('.dsgb-palette-hint') || {}).textContent || null
      box.querySelector('.dsgb-swatch[aria-label="红"]').click()
      await new Promise((r) => setTimeout(r, 120))
      return {
        step: 'ok',
        before, beforeBot, presetOn, inputValue, resetText, hint,
        after: getComputedStyle(folder).color,
        afterBot: getComputedStyle(body).fill,
        afterVar: folder.style.getPropertyValue('--dsgb-workspace-ink'),
        marked: folder.getAttribute('data-dsgb-workspace-folder'),
        rowB: getComputedStyle(document.querySelector('[data-row-key="workspace:proj-b"] > .JoiKIa_slot.JoiKIa_folder')).color,
        ungroupedVar: document.querySelector('[data-row-key="workspace:"] > .JoiKIa_slot.JoiKIa_folder').style.getPropertyValue('--dsgb-workspace-ink'),
        api: window.__dshGrokBuddy.folders(),
      }
    })()`)
    record(
      '未设置时打开调色板：无声色块被标已选、输入框为空、按钮文案是「恢复默认」+ 说明',
      paletteFlow.step === 'ok' &&
        paletteFlow.presetOn === 0 &&
        paletteFlow.inputValue === '' &&
        paletteFlow.resetText === '恢复默认' &&
        /文件夹跟随 DSH/.test(paletteFlow.hint || '') &&
        sameInk(paletteFlow.before, 'rgb(16, 132, 254)'),
      paletteFlow,
    )
    record(
      '点预设红：proj-a 文件夹与 Buddy 立即同变 #ff263c，别的项目不受影响',
      paletteFlow.step === 'ok' &&
        sameInk(paletteFlow.after, 'rgb(255, 38, 60)') &&
        paletteFlow.afterVar === '#ff263c' &&
        paletteFlow.marked === '1' &&
        sameInk(paletteFlow.afterBot, paletteFlow.after) &&
        sameInk(paletteFlow.rowB, 'rgb(138, 143, 152)') &&
        paletteFlow.ungroupedVar === '' &&
        paletteFlow.api.every((f) => f.workspaceId === 'proj-a' || f.marked === false),
      paletteFlow,
    )

    // 恢复默认：撤销覆盖 → 文件夹回到 DSH 原生色，并继续响应宿主的选中状态
    const resetFlow = await evaluate(`(async () => {
      const openPalette = async () => {
        document.querySelector('[data-row-key="workspace:proj-a"]').classList.add('JoiKIa_menuOpen')
        document.querySelector('[data-menu-material]')?.remove()
        const m2 = document.createElement('div')
        m2.setAttribute('data-menu-material', '')
        const wrap = document.createElement('div')
        for (const label of ['重命名', '删除工作区']) {
          const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.textContent = label; wrap.appendChild(b)
        }
        m2.appendChild(wrap); document.body.appendChild(m2)
        for (let i = 0; i < 60 && document.querySelector('.dsgb-menu-item') === null; i++) await new Promise((r) => setTimeout(r, 100))
        document.querySelector('.dsgb-menu-item button').click()
        for (let i = 0; i < 30 && document.querySelector('.dsgb-palette') === null; i++) await new Promise((r) => setTimeout(r, 50))
        return document.querySelector('.dsgb-palette')
      }
      const box = await openPalette()
      if (box === null) return { step: 'palette' }
      const before = getComputedStyle(document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')).color
      box.querySelector('.dsgb-palette-reset').click()
      await new Promise((r) => setTimeout(r, 150))
      const folder = document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')
      const active = getComputedStyle(folder).color
      // 宿主的选中状态变化：拿掉 folderActive 应该立刻变回普通灰 ——
      // 证明颜色真的来自宿主规则，而不是插件写死的某个值。
      folder.classList.remove('JoiKIa_folderActive')
      const plain = getComputedStyle(folder).color
      folder.classList.add('JoiKIa_folderActive')
      const selectedAgain = getComputedStyle(folder).color
      const bot = document.querySelector('[data-row-key="session:p-working"] svg.dsgb [data-dsgb-layer="body"] > path')
      return {
        step: 'ok',
        before, active, plain, selectedAgain,
        var: folder.style.getPropertyValue('--dsgb-workspace-ink'),
        marked: folder.getAttribute('data-dsgb-workspace-folder'),
        buddy: getComputedStyle(bot).fill,
        api: window.__dshGrokBuddy.folders(),
        colors: window.__dshGrokBuddy.colors(),
      }
    })()`)
    record(
      '恢复默认：文件夹回到 DSH 原生色（folderActive 蓝），标记与变量都撤掉',
      resetFlow.step === 'ok' &&
        sameInk(resetFlow.before, 'rgb(255, 38, 60)') &&
        sameInk(resetFlow.active, 'rgb(16, 132, 254)') &&
        resetFlow.var === '' &&
        resetFlow.marked === null &&
        Object.keys(resetFlow.colors).length === 0 &&
        resetFlow.api.every((f) => f.chosen === null && f.marked === false),
      resetFlow,
    )
    record(
      '恢复默认后仍随宿主选中状态变化（不是把某个颜色写死回去）',
      resetFlow.step === 'ok' &&
        resetFlow.plain !== resetFlow.active &&
        sameInk(resetFlow.plain, 'rgb(138, 143, 152)') &&
        sameInk(resetFlow.selectedAgain, resetFlow.active),
      resetFlow,
    )
    record(
      '恢复默认后 Buddy 按其既有默认规则显示（哈希默认色）',
      resetFlow.step === 'ok' && sameInk(resetFlow.buddy, 'rgb(' + hexToRgbParts(windowDefaultInk) + ')'),
      resetFlow,
    )

    // 提交失败（自定义色 → 恢复默认）：回滚到此前的自定义色 + 可观察提示
    const failFlow = await evaluate(`(async () => {
      await fetch('/dsh-grok-buddy/colors.json', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'proj-a', color: '#9159fe' }),
      })
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100))
        const el = document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')
        if (el.style.getPropertyValue('--dsgb-workspace-ink') === '#9159fe') break
      }
      const before = getComputedStyle(document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')).color
      await fetch('/__test/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'fail-next-colors' }) })
      const row = document.querySelector('[data-row-key="workspace:proj-a"]')
      row.classList.add('JoiKIa_menuOpen')
      document.querySelector('[data-menu-material]')?.remove()
      const m = document.createElement('div'); m.setAttribute('data-menu-material', '')
      const wrap = document.createElement('div')
      for (const label of ['重命名', '删除工作区']) {
        const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.textContent = label; wrap.appendChild(b)
      }
      m.appendChild(wrap); document.body.appendChild(m)
      for (let i = 0; i < 60 && document.querySelector('.dsgb-menu-item') === null; i++) await new Promise((r) => setTimeout(r, 100))
      document.querySelector('.dsgb-menu-item button').click()
      for (let i = 0; i < 30 && document.querySelector('.dsgb-palette') === null; i++) await new Promise((r) => setTimeout(r, 50))
      const folder = document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')
      const body = document.querySelector('[data-row-key="session:p-working"] svg.dsgb [data-dsgb-layer="body"] > path')
      document.querySelector('.dsgb-palette .dsgb-palette-reset').click()
      await new Promise((r) => setTimeout(r, 150))
      return {
        before,
        folder: getComputedStyle(folder).color,
        var: folder.style.getPropertyValue('--dsgb-workspace-ink'),
        marked: folder.getAttribute('data-dsgb-workspace-folder'),
        buddy: getComputedStyle(body).fill,
        toast: (document.querySelector('.dsgb-color-error') || {}).textContent || null,
      }
    })()`)
    record(
      '提交失败（自定义色 → 恢复默认）：文件夹回此前的自定义色，Buddy 同回，并出现错误提示',
      sameInk(failFlow.before, 'rgb(145, 89, 254)') &&
        failFlow.var === '#9159fe' &&
        failFlow.marked === '1' &&
        sameInk(failFlow.folder, 'rgb(145, 89, 254)') &&
        sameInk(failFlow.buddy, failFlow.folder) &&
        /没保存成功/.test(failFlow.toast || ''),
      failFlow,
    )
    const resetAgain = await evaluate(`(async () => {
      document.querySelector('[data-row-key="workspace:proj-a"]').classList.add('JoiKIa_menuOpen')
      document.querySelector('[data-menu-material]')?.remove()
      const m = document.createElement('div'); m.setAttribute('data-menu-material', '')
      const wrap = document.createElement('div')
      for (const label of ['重命名', '删除工作区']) {
        const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.textContent = label; wrap.appendChild(b)
      }
      m.appendChild(wrap); document.body.appendChild(m)
      for (let i = 0; i < 60 && document.querySelector('.dsgb-menu-item') === null; i++) await new Promise((r) => setTimeout(r, 100))
      document.querySelector('.dsgb-menu-item button').click()
      for (let i = 0; i < 30 && document.querySelector('.dsgb-palette') === null; i++) await new Promise((r) => setTimeout(r, 50))
      document.querySelector('.dsgb-palette .dsgb-palette-reset').click()
      await new Promise((r) => setTimeout(r, 200))
      const folder = document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')
      const body = document.querySelector('[data-row-key="session:p-working"] svg.dsgb [data-dsgb-layer="body"] > path')
      return {
        folder: getComputedStyle(folder).color,
        var: folder.style.getPropertyValue('--dsgb-workspace-ink'),
        buddy: getComputedStyle(body).fill,
        expectBuddy: 'rgb(0, 188, 166)',
      }
    })()`)
    record(
      '重试「恢复默认」成功：文件夹回到宿主原生蓝，Buddy 回默认项目色',
      sameInk(resetAgain.folder, 'rgb(16, 132, 254)') &&
        resetAgain.var === '' &&
        sameInk(resetAgain.buddy, resetAgain.expectBuddy),
      resetAgain,
    )

    // 行节点复用：宿主把项目 A 的行节点改挂成另一个项目
    //   有显式色的 A → 未设置的 proj-c：插件痕迹必须当场撤掉，回到宿主原生色。
    const reuse = await evaluate(`(async () => {
      await fetch('/dsh-grok-buddy/colors.json', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'proj-b', color: '#9159fe' }),
      })
      const row = document.querySelector('[data-row-key="workspace:proj-b"]')
      const folder = row.querySelector(':scope > .JoiKIa_slot.JoiKIa_folder')
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100))
        if (folder.style.getPropertyValue('--dsgb-workspace-ink') === '#9159fe') break
      }
      const before = {
        var: folder.style.getPropertyValue('--dsgb-workspace-ink'),
        marked: folder.getAttribute('data-dsgb-workspace-folder'),
        color: getComputedStyle(folder).color,
      }
      row.setAttribute('data-row-key', 'workspace:proj-c')
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100))
        if (folder.style.getPropertyValue('--dsgb-workspace-ink') === '') break
      }
      return {
        before,
        afterVar: folder.style.getPropertyValue('--dsgb-workspace-ink'),
        afterMarked: folder.getAttribute('data-dsgb-workspace-folder'),
        afterColor: getComputedStyle(folder).color,
        api: window.__dshGrokBuddy.folders(),
      }
    })()`)
    record(
      '行节点复用：有自定义色的项目 → 未设置的项目，插件痕迹撤掉、回到宿主原生色',
      reuse.before.var === '#9159fe' &&
        reuse.before.marked === '1' &&
        reuse.afterVar === '' &&
        reuse.afterMarked === null &&
        sameInk(reuse.afterColor, 'rgb(138, 143, 152)') &&
        (reuse.api.find((f) => f.workspaceId === 'proj-c') || {}).marked === false,
      reuse,
    )

    // 文件夹 SVG 被宿主替换（展开/收起换图标）：格子还在，色不丢。
    // proj-a 刚才恢复成了原生色，这里先显式设回红色再验「色不丢」。
    const swap = await evaluate(`(async () => {
      await fetch('/dsh-grok-buddy/colors.json', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'proj-a', color: '#ff263c' }),
      })
      const folder = document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100))
        if (folder.style.getPropertyValue('--dsgb-workspace-ink') === '#ff263c') break
      }
      const wasOpen = folder.querySelector('path[opacity]') !== null
      const ink = folder.style.getPropertyValue('--dsgb-workspace-ink')
      folder.innerHTML = wasOpen
        ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.5 3.1h12.9v10.7H1.5z" stroke="currentColor"/><path d="M3.6 7.6h8.7" stroke="currentColor"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 7.9h11l-1.2 4.6H1.4z" fill="currentColor" opacity="0.16"/><path d="M13.6 6.7H3.5l-1.2 4.6h11.3z" fill="currentColor"/></svg>'
      await new Promise((r) => setTimeout(r, 250))
      const path = folder.querySelector('path')
      return {
        marked: folder.getAttribute('data-dsgb-workspace-folder'),
        inkVar: folder.style.getPropertyValue('--dsgb-workspace-ink'),
        strokeResolves: getComputedStyle(path).stroke,
        fillResolves: getComputedStyle(path).fill,
        wasOpen,
      }
    })()`)
    record(
      '文件夹 SVG 被替换后新图标仍解析到项目色（currentColor 生效）',
      swap.marked === '1' &&
        swap.inkVar === '#ff263c' &&
        (sameInk(swap.strokeResolves, 'rgb(255, 38, 60)') || sameInk(swap.fillResolves, 'rgb(255, 38, 60)')),
      swap,
    )

    // 主题切换：明暗两种主题下文件夹仍是项目色（截图另存）
    const shotsTaken = []
    if (SHOTS !== null) {
      fs.mkdirSync(SHOTS, { recursive: true })
      // 截图前摆好能看清「文件夹 ↔ Buddy」关系的三种状态：
      //   proj-a = 显式红（working Buddy 同红）
      //   未分组 = 显式青
      //   proj-b / proj-c = 未设置 → 保持 DSH 原生色（对照）
      // 截图前先清掉 proj-b 的显式色（前面的复用检查给它设过紫色）。
      await evaluate(`(async () => {
        await fetch('/dsh-grok-buddy/colors.json', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: 'proj-b', color: null }),
        })
      })()`)
      await evaluate(`(async () => {
        await fetch('/dsh-grok-buddy/colors.json', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: 'proj-a', color: '#ff263c' }),
        })
        await fetch('/dsh-grok-buddy/colors.json', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: '__ungrouped__', color: '#00bca6' }),
        })
        const a = document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')
        const u = document.querySelector('[data-row-key="workspace:"] > .JoiKIa_slot.JoiKIa_folder')
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 100))
          if (
            a.style.getPropertyValue('--dsgb-workspace-ink') === '#ff263c' &&
            u.style.getPropertyValue('--dsgb-workspace-ink') === '#00bca6'
          ) {
            break
          }
        }
        // 截区里只留侧栏本身：把前面交互留下的菜单节点收掉
        document.querySelectorAll('[data-menu-material]').forEach((el) => el.remove())
        document.querySelector('.dsgb-palette')?.remove()
        document.querySelector('.dsgb-color-error')?.remove()
        // 滚动到侧栏顶部，保证项目行都在画面里
        window.scrollTo(0, 0)
      })()`)
      // 深色
      await evaluate(`(async () => {
        document.documentElement.setAttribute('data-ds-theme', 'dark')
        await new Promise((r) => setTimeout(r, 300))
      })()`)
      const darkShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(SHOTS, 'folder-ink-dark.png'), Buffer.from(darkShot.data, 'base64'))
      shotsTaken.push('folder-ink-dark.png')
      // 注意：前面的复用检查把 proj-b 那一行的 data-row-key 改成了 proj-c，
      // 所以这里的「未设置」对照用 proj-c。
      const themeInk = () => evaluate(`(() => {
        const folder = (key) => document.querySelector('[data-row-key="workspace:' + key + '"] > .JoiKIa_slot.JoiKIa_folder')
        const body = document.querySelector('[data-row-key="session:p-working"] svg.dsgb [data-dsgb-layer="body"] > path')
        const a = folder('proj-a'), b = folder('proj-c')
        const expect = (window.__dshGrokBuddy.folders().find((f) => f.workspaceId === 'proj-a') || {}).ink
        return {
          folder: getComputedStyle(a).color,
          buddy: getComputedStyle(body).fill,
          bg: getComputedStyle(document.body).backgroundColor,
          expect,
          // 未设置的项目：computed color 必须仍是宿主自己的颜色
          nativeB: getComputedStyle(b).color,
          nativeBVar: b.style.getPropertyValue('--dsgb-workspace-ink'),
          nativeBMarked: b.getAttribute('data-dsgb-workspace-folder'),
          hostSlot: getComputedStyle(document.documentElement).getPropertyValue('--slot-fg').trim(),
        }
      })()`)
      const darkInk = await themeInk()
      record(
        '深色主题下显式色文件夹与 Buddy 仍同色（与当前项目墨色一致）',
        sameInk(darkInk.folder, darkInk.buddy) &&
          darkInk.expect !== undefined &&
          sameInk(darkInk.folder, 'rgb(' + hexToRgbParts(darkInk.expect) + ')'),
        darkInk,
      )
      record(
        '深色主题下未设置的项目文件夹仍是宿主原生灰（无变量、无标记）',
        sameInk(darkInk.nativeB, 'rgb(138, 143, 152)') && darkInk.nativeBVar === '' && darkInk.nativeBMarked === null,
        darkInk,
      )
      // 浅色
      await evaluate(`(async () => {
        document.documentElement.setAttribute('data-ds-theme', 'light')
        await new Promise((r) => setTimeout(r, 300))
      })()`)
      const lightShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(SHOTS, 'folder-ink-light.png'), Buffer.from(lightShot.data, 'base64'))
      shotsTaken.push('folder-ink-light.png')
      const lightInk = await themeInk()
      record(
        '浅色主题下未设置的项目文件夹仍是宿主原生灰；显式色的仍是项目色',
        sameInk(lightInk.nativeB, 'rgb(138, 143, 152)') &&
          lightInk.nativeBVar === '' &&
          lightInk.nativeBMarked === null &&
          sameInk(lightInk.folder, 'rgb(255, 38, 60)'),
        lightInk,
      )
    }

    // 悬停：宿主用箭头顶替文件夹（display 切换），插件规则不破坏这个交换。
    // 这里先把 proj-a 恢复到原生色，顺带核对「原生色下悬停/标题也不受影响」。
    await evaluate(`(async () => {
      document.querySelector('[data-row-key="workspace:proj-a"]').classList.add('JoiKIa_menuOpen')
      document.querySelector('[data-menu-material]')?.remove()
      const m = document.createElement('div'); m.setAttribute('data-menu-material', '')
      const wrap = document.createElement('div')
      for (const label of ['重命名', '删除工作区']) {
        const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.textContent = label; wrap.appendChild(b)
      }
      m.appendChild(wrap); document.body.appendChild(m)
      for (let i = 0; i < 60 && document.querySelector('.dsgb-menu-item') === null; i++) await new Promise((r) => setTimeout(r, 100))
      document.querySelector('.dsgb-menu-item button').click()
      for (let i = 0; i < 30 && document.querySelector('.dsgb-palette') === null; i++) await new Promise((r) => setTimeout(r, 50))
      document.querySelector('.dsgb-palette .dsgb-palette-reset').click()
      await new Promise((r) => setTimeout(r, 200))
    })()`)
    const hover = await (async () => {
      const row = await evaluate(`(() => {
        const row = document.querySelector('[data-row-key="workspace:proj-a"]')
        const r = row.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y, button: 'none', buttons: 0 })
      await new Promise((r2) => setTimeout(r2, 250))
      return evaluate(`(() => {
        const folder = document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')
        const chevron = document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_chevron')
        const title = document.querySelector('[data-row-key="workspace:proj-a"] .JoiKIa_title')
        return {
          folderDisplay: getComputedStyle(folder).display,
          chevronDisplay: getComputedStyle(chevron).display,
          titleColor: getComputedStyle(title).color,
        }
      })()`)
    })()
    // 注：chevron 写的是 display:inline-flex，但它是 flex 行的 item，
    // CSS 会把它块化成 flex —— 真实宿主里同样如此。只要不再是 none 即可。
    record(
      '悬停时宿主的「箭头顶替文件夹」交换照常，标题不变色',
      hover.folderDisplay === 'none' && hover.chevronDisplay === 'flex' && sameInk(hover.titleColor, 'rgb(31, 35, 40)'),
      hover,
    )

    // 页面重新加载：配色表重新读回 —— 显式色的项目仍是改过的颜色，
    // 没有配置条目的项目继续保持 DSH 原生色。
    await evaluate(`(async () => {
      await fetch('/__test/control', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-colors', projects: { 'proj-a': '#ff263c', __ungrouped__: '#00bca6' } }),
      })
    })()`)
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/harness.html' })
    await new Promise((r) => setTimeout(r, 1200))
    const reloaded = await evaluate(`(async () => {
      for (let i = 0; i < 40 && window.__dshGrokBuddy === undefined; i++) await new Promise((r) => setTimeout(r, 100))
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100))
        const a = document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')
        if (a !== null && a.style.getPropertyValue('--dsgb-workspace-ink') === '#ff263c') break
      }
      const a = document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')
      const u = document.querySelector('[data-row-key="workspace:"] > .JoiKIa_slot.JoiKIa_folder')
      const b = document.querySelector('[data-row-key="workspace:proj-b"] > .JoiKIa_slot.JoiKIa_folder')
      return {
        a: a === null ? null : { ink: getComputedStyle(a).color, var: a.style.getPropertyValue('--dsgb-workspace-ink') },
        u: u === null ? null : { ink: getComputedStyle(u).color, var: u.style.getPropertyValue('--dsgb-workspace-ink') },
        b: b === null ? null : { ink: getComputedStyle(b).color, var: b.style.getPropertyValue('--dsgb-workspace-ink'), marked: b.getAttribute('data-dsgb-workspace-folder') },
      }
    })()`)
    record(
      '页面重新加载后：proj-a=红、未分组=青 都从配色表恢复',
      reloaded.a !== null && reloaded.a.var === '#ff263c' && sameInk(reloaded.a.ink, 'rgb(255, 38, 60)') && reloaded.u !== null && reloaded.u.var === '#00bca6',
      reloaded,
    )
    record(
      '页面重新加载后：没有配置条目的 proj-b 仍是 DSH 原生色',
      reloaded.b !== null &&
        reloaded.b.marked === null &&
        reloaded.b.var === '' &&
        sameInk(reloaded.b.ink, 'rgb(138, 143, 152)'),
      reloaded,
    )

    // stop()：把文件夹外观还给宿主（proj-a 当时已被「恢复默认」→ 宿主蓝；
    // proj-b 无 folderActive → 宿主灰；两者都证明插件标记已撤下）
    const stopped = await evaluate(`(() => {
      const a = document.querySelector('[data-row-key="workspace:proj-a"] > .JoiKIa_slot.JoiKIa_folder')
      const b = document.querySelector('[data-row-key="workspace:proj-b"] > .JoiKIa_slot.JoiKIa_folder')
      window.__dshGrokBuddy.stop()
      return {
        markedA: a.getAttribute('data-dsgb-workspace-folder'),
        varA: a.style.getPropertyValue('--dsgb-workspace-ink'),
        colorA: getComputedStyle(a).color,
        markedB: b.getAttribute('data-dsgb-workspace-folder'),
        varB: b.style.getPropertyValue('--dsgb-workspace-ink'),
        colorB: getComputedStyle(b).color,
        api: typeof window.__dshGrokBuddy,
      }
    })()`)
    record(
      'stop() 后：标记与变量摘掉，颜色回到宿主自己的规则（folderActive 蓝 / 普通灰）',
      stopped.markedA === null &&
        stopped.varA === '' &&
        sameInk(stopped.colorA, 'rgb(16, 132, 254)') &&
        stopped.markedB === null &&
        stopped.varB === '' &&
        sameInk(stopped.colorB, 'rgb(138, 143, 152)') &&
        stopped.api === 'undefined',
      stopped,
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
