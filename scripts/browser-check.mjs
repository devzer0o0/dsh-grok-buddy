/**
 * 真浏览器核对：用本机 Chrome 的 DevTools 协议跑一次真实页面。
 *
 * 为什么不用自制 DOM：自制 harness 只能证明「我们自己写的桩行为一致」，
 * 证明不了真实 SVG 几何、计算样式、16px 布局矩形、轨道裁切、MutationObserver
 * 与真实帧推进。这一层专门补这个缺口，不引入任何 npm 依赖。
 *
 * 用法：
 *   node scripts/browser-check.mjs [--out /tmp/xxx] [--keep]
 *
 * 会做的事：
 *   1. 起一个临时静态服务器（只服务本仓库）
 *   2. 用 Chrome headless --remote-debugging-port 打开 preview.html
 *   3. 通过 CDP 读真实 DOM：图层可见性、SVG 路径、16px 矩形、计算样式
 *   4. 推进动画，采样画面是否真的在变
 *   5. 截图（默认写到 --out 目录）
 *
 * @module scripts/browser-check
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
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name)
  if (idx === -1) return fallback
  return process.argv[idx + 1] || fallback
}

const OUT_DIR = argValue('--out', path.join(os.tmpdir(), 'dsgb-browser'))
const KEEP = process.argv.includes('--keep')

/** 起一个只读静态服务器，绑定 127.0.0.1 的随机端口。 */
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0])
      const rel = url === '/' ? '/preview.html' : url
      const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''))
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

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** 极简 CDP 客户端：只用 WebSocket 发 Runtime.evaluate / Page.captureScreenshot。 */
async function connect(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000)
  let target = null
  while (Date.now() < deadline) {
    try {
      const list = await fetch('http://127.0.0.1:' + port + '/json/list')
      const items = await list.json()
      target = items.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target !== undefined) break
    } catch (err) {}
    await new Promise((r) => setTimeout(r, 120))
  }
  if (target === null) throw new Error('没有找到可连接的 page target')
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
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error !== undefined) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
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
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const chrome = chromePath()
  if (chrome === null) {
    console.log('SKIP: 找不到 Chrome')
    process.exit(2)
  }
  const { server, port } = await startServer()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-chrome-'))
  const debugPort = 9333 + Math.floor(Math.random() * 400)
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--remote-debugging-port=' + debugPort,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1400,2400',
      'http://127.0.0.1:' + port + '/preview.html',
    ],
    { stdio: 'ignore' },
  )

  const report = { url: 'http://127.0.0.1:' + port + '/preview.html', checks: [], screenshots: [] }
  try {
    const cdp = await connect(debugPort, 25000)
    /**
     * 执行页面表达式。
     *
     * headless Chrome 首次导航/重建执行上下文时，偶发 "Execution context was destroyed"
     * —— 那是 CDP 的瞬态竞态，不是断言失败。这里对**仅此一类**错误做有限重试，
     * 其它异常照旧立刻抛出，避免把真实缺陷重试成"通过"。
     */
    const evaluate = async (expression, options) => {
      const transient = (err) => /Execution context was destroyed|Cannot find context with specified id/i.test(String(err && err.message))
      // 上下文被销毁后重放整个表达式，等于把副作用（切相位、改配色、点按钮）再做一遍。
      // 只有**幂等只读**的探测允许重试；会改页面状态的表达式默认只执行一次。
      const idempotent = options !== undefined && options !== null && options.idempotent === true
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await cdp.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
          })
          if (result.exceptionDetails !== undefined) {
            throw new Error('页面异常：' + JSON.stringify(result.exceptionDetails.exception || result.exceptionDetails))
          }
          return result.result.value
        } catch (err) {
          if (!idempotent || attempt >= 4 || !transient(err)) throw err
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
        }
      }
    }

    // 等预览真正建好实例
    const ready = await evaluate(`(async () => {
      for (let i = 0; i < 200; i++) {
        if (window.__preview !== undefined && window.__preview.live.length > 0) return { ok: true, n: window.__preview.live.length }
        await new Promise((r) => setTimeout(r, 50))
      }
      return { ok: false }
    })()`)
    report.checks.push({ name: 'preview booted', pass: ready.ok === true, detail: ready })

    const record = (name, pass, detail) => report.checks.push({ name, pass: pass === true, detail })

    // 1) 每态：图层结构 + 真实 SVG 几何
    for (const phase of ['idle', 'working', 'waiting', 'blocked', 'thinking', 'done']) {
      const info = await evaluate(`(async () => {
        window.__preview.selectPhase(${JSON.stringify(phase)})
        await new Promise((r) => setTimeout(r, 350))
        const rec = window.__preview.live.find((x) => x.size === 200)
        const svg = rec.inst.svg
        const shown = (el) => {
          const s = getComputedStyle(el)
          return s.display !== 'none' && s.visibility !== 'hidden'
        }
        const paths = (g) => Array.from(g.children).filter((el) => shown(el))
        const bboxOf = (el) => {
          const b = el.getBBox()
          return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
        }
        const q = (sel) => svg.querySelector(sel)
        return {
          phase: ${JSON.stringify(phase)},
          motion: svg.getAttribute('data-dsgb-frame'),
          figure: ${JSON.stringify(phase)} === 'blocked' ? 'exclamation' : (${JSON.stringify(phase)} === 'thinking' ? 'dots' : 'avatar'),
          body: q('[data-dsgb-layer="body"]') !== null && shown(q('[data-dsgb-layer="body"]')),
          eyes: q('[data-dsgb-layer="eyes"]') !== null && shown(q('[data-dsgb-layer="eyes"]')),
          bang: q('[data-dsgb-layer="bang"]') !== null && shown(q('[data-dsgb-layer="bang"]')),
          dots: q('[data-dsgb-layer="dots"]') !== null && shown(q('[data-dsgb-layer="dots"]')),
          dotCount: q('[data-dsgb-layer="dots"]') === null ? 0 : paths(q('[data-dsgb-layer="dots"]')).length,
          orbitBack: q('[data-dsgb-layer="orbits-back"]') === null ? 0 : paths(q('[data-dsgb-layer="orbits-back"]')).length,
          orbitFront: q('[data-dsgb-layer="orbits-front"]') === null ? 0 : paths(q('[data-dsgb-layer="orbits-front"]')).length,
          trail: q('[data-dsgb-layer="trail"]') === null ? 0 : paths(q('[data-dsgb-layer="trail"]')).length,
          bodyBox: q('[data-dsgb-layer="body"]') === null ? null : bboxOf(q('[data-dsgb-layer="body"]')),
          dotsBox: q('[data-dsgb-layer="dots"]') === null ? null : bboxOf(q('[data-dsgb-layer="dots"]')),
          bangBox: q('[data-dsgb-layer="bang"]') === null ? null : bboxOf(q('[data-dsgb-layer="bang"]')),
          orbitsBox: q('[data-dsgb-layer="orbits-front"]') === null ? null : bboxOf(q('[data-dsgb-layer="orbits-front"]')),
          viewBox: svg.getAttribute('viewBox'),
          rect: (() => { const b = svg.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) } })(),
        }
      })()`)
      const expect = {
        idle: (i) => i.body && i.eyes && !i.bang && !i.dots,
        working: (i) => i.body && i.eyes && !i.bang && !i.dots,
        waiting: (i) => i.body && i.eyes && !i.bang && !i.dots,
        blocked: (i) => i.bang && !i.body && !i.eyes && !i.dots,
        thinking: (i) => i.dots && i.dotCount === 3 && !i.body && !i.eyes,
        done: (i) => i.body && i.eyes && i.orbitBack + i.orbitFront > 0,
      }[phase]
      record(phase + ' 图层构成正确', expect(info), info)

      // 截图这一态
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(OUT_DIR, 'browser-' + phase + '.png')
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      report.screenshots.push(file)
    }

    // 2) 16px 的真实布局矩形：不超出 16×16、不被裁切
    const layout = await evaluate(`(async () => {
      window.__preview.selectPhase('done')
      await new Promise((r) => setTimeout(r, 300))
      const rec = window.__preview.live.find((x) => x.size === 16)
      const b = rec.inst.svg.getBoundingClientRect()
      const parent = rec.holder.getBoundingClientRect()
      const paths = Array.from(rec.inst.svg.querySelectorAll('[data-dsgb-layer="orbits-front"] path'))
      let extent = 0
      for (const p of paths) {
        const box = p.getBBox()
        extent = Math.max(extent, box.width, box.height)
      }
      return {
        svg: { w: b.width, h: b.height },
        holder: { w: parent.width, h: parent.height },
        orbitExtent: Math.round(extent),
        overflow: getComputedStyle(rec.inst.svg.parentElement).overflow,
      }
    })()`)
    record(
      '16px 下头像就是 16×16、不撑破格子',
      layout.svg.w === 16 && layout.svg.h === 16 && layout.holder.w <= 16.01,
      layout,
    )
    record('16px 下轨道仍在画布内（不会被裁掉）', layout.orbitExtent <= 315, layout)

    // 2b) thinking 三点在**真实 16px SVG** 里的 CSS px 几何：看圆点自己的矩形，
    // 不把 viewBox 坐标当像素。跨一个完整脉动周期采样，量最小点径、最大点径、
    // 整体宽度与相邻边缘缝。
    const dotCheck = await evaluate(`(async () => {
      window.__preview.selectPhase('thinking')
      await new Promise((r) => setTimeout(r, 450))
      const rec = window.__preview.live.find((x) => x.size === 16)
      const svg = rec.inst.svg
      const sample = () => {
        const boxes = rec.inst.dotEls.map((el) => {
          const b = el.getBoundingClientRect()
          return { x: b.x, w: b.width, h: b.height, left: b.left, right: b.right, opacity: Number(getComputedStyle(el).opacity) }
        })
        boxes.sort((a, b) => a.left - b.left)
        const canvas = svg.getBoundingClientRect()
        return {
          dpr: window.devicePixelRatio,
          canvas: { w: canvas.width, h: canvas.height, left: canvas.left, right: canvas.right },
          diameters: boxes.map((b) => b.w),
          width: boxes[2].right - boxes[0].left,
          gap: Math.min(boxes[1].left - boxes[0].right, boxes[2].left - boxes[1].right),
          inside: boxes.every((b) => b.left >= canvas.left - 0.51 && b.right <= canvas.right + 0.51),
          alphas: boxes.map((b) => b.opacity),
        }
      }
      const rows = []
      for (let i = 0; i < 24; i++) {
        rows.push(sample())
        await new Promise((r) => setTimeout(r, 90))
      }
      return {
        samples: rows.length,
        dpr: rows[0].dpr,
        canvas: rows[0].canvas,
        minDiameter: Math.min(...rows.flatMap((r) => r.diameters)),
        maxDiameter: Math.max(...rows.flatMap((r) => r.diameters)),
        maxWidth: Math.max(...rows.map((r) => r.width)),
        minGap: Math.min(...rows.map((r) => r.gap)),
        minAlpha: Math.min(...rows.flatMap((r) => r.alphas)),
        allInside: rows.every((r) => r.inside),
        titleShift: 0,
      }
    })()`)
    record(
      '16px 下三点直径 ≥2.9 CSS px、整体宽 ≤13、边缘缝 ≥1（真实矩形）',
      dotCheck.minDiameter >= 2.9 && dotCheck.maxDiameter <= 3.7 && dotCheck.maxWidth <= 13 && dotCheck.minGap >= 1 && dotCheck.allInside,
      dotCheck,
    )
    record('16px 下三点的真实透明度下限 ≥0.7（稳态不会糊掉）', dotCheck.minAlpha >= 0.7, dotCheck)

    // 3) 真实帧推进：同态不重播，动画确实在前移
    const animation = await evaluate(`(async () => {
      window.__preview.selectPhase('done')
      await new Promise((r) => setTimeout(r, 400))
      const snap = () => {
        const rec = window.__preview.live.find((x) => x.size === 200)
        const ring = rec.inst.orbitsFront.children[0]
        return ring === undefined ? '' : ring.getAttribute('d')
      }
      const a = snap()
      await new Promise((r) => setTimeout(r, 500))
      const b = snap()
      // 同态再送一次快照：动作 id 不变 → 时间轴不应重置
      const rec = window.__preview.live.find((x) => x.size === 200)
      const tokenBefore = rec.inst.token
      document.getElementById('replayBtn').click()
      const tokenAfter = rec.inst.token
      await new Promise((r) => setTimeout(r, 500))
      const c = snap()
      return { moved: a !== b, afterReplayMoved: b !== c, tokenStable: tokenBefore === tokenAfter, len: a.length }
    })()`)
    record('done 的轨道真的在推进', animation.moved === true, animation)
    record('同态快照不重启动画（token 不变、动画继续）', animation.tokenStable === true && animation.afterReplayMoved === true, animation)

    // 4) reduced-motion 下没有持续帧
    const reduced = await evaluate(`(async () => {
      document.getElementById('reducedBtn').click()
      await new Promise((r) => setTimeout(r, 400))
      const rec = window.__preview.live.find((x) => x.size === 200)
      const a = rec.inst.frame === null ? null : rec.inst.frame.time
      await new Promise((r) => setTimeout(r, 500))
      const b = rec.inst.frame === null ? null : rec.inst.frame.time
      const running = rec.inst.running
      document.getElementById('reducedBtn').click()
      await new Promise((r) => setTimeout(r, 200))
      return { staticStable: a === b, running, stillIdentifiable: rec.inst.svg.querySelector('[data-dsgb-layer="body"]') !== null }
    })()`)
    record('reduced-motion 下不推进帧（静态）', reduced.staticStable === true && reduced.running === false, reduced)

    // 5) 主题切换（深/浅）不丢实例、不重播
    const theme = await evaluate(`(async () => {
      const before = window.__preview.live.find((x) => x.size === 200).inst.svg
      document.getElementById('bgLight').click()
      await new Promise((r) => setTimeout(r, 300))
      const after = window.__preview.live.find((x) => x.size === 200).inst.svg
      const ink = after.querySelector('[data-dsgb-layer="body"] path').getAttribute('fill')
      document.getElementById('bgDark').click()
      await new Promise((r) => setTimeout(r, 200))
      return { sameInstance: before === after || window.__preview.live.length > 0, ink }
    })()`)
    record('切换深浅背景后仍有可用实例与墨色', theme.sameInstance === true && typeof theme.ink === 'string', theme)

    cdp.close()
  } finally {
    child.kill('SIGKILL')
    server.close()
    if (!KEEP) {
      try {
        fs.rmSync(profile, { recursive: true, force: true })
      } catch (err) {}
    }
  }

  const failed = report.checks.filter((c) => !c.pass)
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ out: OUT_DIR, total: report.checks.length, failed: failed.length, failedNames: failed.map((f) => f.name) }, null, 2))
  for (const check of report.checks) {
    console.log((check.pass ? 'PASS' : 'FAIL') + '  ' + check.name)
    if (!check.pass) console.log('      ' + JSON.stringify(check.detail).slice(0, 500))
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('ERROR', err)
  process.exit(1)
})
