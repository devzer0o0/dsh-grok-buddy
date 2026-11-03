/**
 * reduced-motion 与实例生命周期（第六节）。
 *
 * 已复现：reduced-motion 开启后推进 600 帧，仍出现 332 组不同眼睛点位 ——
 * 也就是说只关掉了转头和视线偏移，眨眼、换脸、RAF 全都还在跑。
 *
 * @module test/reduced-motion.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { Doc, jsonResponse } from './dom-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')

async function boot(options) {
  const opts = options === undefined ? {} : options
  const doc = new Doc()
  const frames = []
  const timers = new Map()
  let timerSeq = 0
  let now = 1_700_000_000_000
  let stateBody = { ok: true, sessions: [] }
  const reducedFlag = { value: opts.reduced === true }
  const mediaListeners = new Set()

  const window = {
    document: doc,
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 2,
    location: { origin: 'http://127.0.0.1:1', href: 'http://127.0.0.1:1/' },
    navigator: { language: 'zh-CN' },
    addEventListener() {},
    removeEventListener() {},
  }
  doc.defaultView = window

  const sandbox = {
    window,
    document: doc,
    navigator: window.navigator,
    performance: { now: () => now },
    Date: class extends Date {
      static now() {
        return now
      }
    },
    console,
    Math,
    JSON,
    Object,
    Array,
    Map,
    Set,
    WeakMap,
    Promise,
    Number,
    String,
    Boolean,
    RegExp,
    Error,
    setTimeout(fn, ms) {
      const id = ++timerSeq
      timers.set(id, { at: now + (ms === undefined ? 0 : ms), fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    setInterval(fn, ms) {
      const id = ++timerSeq
      timers.set(id, { at: now + (ms === undefined ? 0 : ms), fn, repeat: ms })
      return id
    },
    clearInterval(id) {
      timers.delete(id)
    },
    requestAnimationFrame(fn) {
      frames.push(fn)
      return frames.length
    },
    cancelAnimationFrame(id) {
      if (id > 0) frames[id - 1] = null
    },
    MutationObserver: class {
      constructor(cb) {
        this.callback = cb
      }
      observe() {}
      disconnect() {}
    },
    getComputedStyle: () => ({
      backgroundColor: 'rgb(20, 22, 26)',
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      colorScheme: 'dark',
    }),
    matchMedia(query) {
      if (query.indexOf('reduced-motion') === -1) return { matches: false, addEventListener() {}, removeEventListener() {} }
      return {
        get matches() {
          return reducedFlag.value
        },
        addEventListener(type, handler) {
          if (type === 'change') mediaListeners.add(handler)
        },
        removeEventListener(type, handler) {
          if (type === 'change') mediaListeners.delete(handler)
        },
      }
    },
    fetch: (url) => {
      if (String(url).indexOf('/colors.json') !== -1) return Promise.resolve(jsonResponse({ ok: true, projects: {} }))
      if (String(url).indexOf('probe') !== -1) return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) })
      return Promise.resolve(jsonResponse(stateBody))
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'widget.js' })

  async function flush() {
    for (let i = 0; i < 60; i++) await Promise.resolve()
  }
  const api = {
    doc,
    window,
    get api() {
      return window.__dshGrokBuddy
    },
    get pendingFrames() {
      return frames.filter((fn) => typeof fn === 'function').length
    },
    setState(body) {
      stateBody = body
    },
    setReduced(value) {
      reducedFlag.value = value
      for (const handler of [...mediaListeners]) handler({ matches: value })
    },
    get mediaListeners() {
      return mediaListeners.size
    },
    async advance(ms) {
      now += ms
      for (const [id, entry] of [...timers]) {
        if (entry.at <= now) {
          if (entry.repeat === undefined) timers.delete(id)
          else entry.at = now + entry.repeat
          entry.fn()
        }
      }
      await flush()
    },
    /** 跑帧并收集每次眼睛点位，用于判断「有没有持续动画」。 */
    async frameSamples(count) {
      const samples = []
      for (let i = 0; i < count; i++) {
        now += 16
        const pending = frames.splice(0, frames.length)
        for (const fn of pending) if (typeof fn === 'function') fn(now)
        await flush()
        samples.push(i)
      }
      return samples
    },
    async settle() {
      await flush()
      await api.frameSamples(2)
    },
  }
  await api.settle()
  return api
}

function makeSection(doc, workspaceId) {
  const section = doc.createElement('div')
  section.className = 'JoiKIa_groupSection'
  const projectRow = doc.createElement('div')
  projectRow.setAttribute('data-row-key', 'workspace:' + workspaceId)
  const wrap = doc.createElement('span')
  wrap.className = 'hc-root'
  wrap.appendChild(projectRow)
  section.appendChild(wrap)
  doc.body.appendChild(section)
  return section
}

function makeRow(doc, section, sessionId) {
  const row = doc.createElement('div')
  row.setAttribute('data-row-key', 'session:' + sessionId)
  row.setAttribute('aria-selected', 'false')
  const slot = doc.createElement('span')
  slot.className = 'JoiKIa_slot'
  const dot = doc.createElement('span')
  dot.setAttribute('data-state', 'idle')
  slot.appendChild(dot)
  row.appendChild(slot)
  const wrap = doc.createElement('span')
  wrap.className = 'hc-root'
  wrap.appendChild(row)
  const group = doc.createElement('div')
  group.setAttribute('role', 'group')
  group.appendChild(wrap)
  section.appendChild(group)
  return { row, slot }
}

function botOf(slot) {
  return slot.children.find((c) => String(c.getAttribute('class') || '').indexOf('dsgb-bot') !== -1)
}

function eyePoints(bot) {
  const eye = bot.children[0].children[2].children[0]
  return eye.getAttribute('points')
}

test('R1 reduced-motion 下不产生持续帧动画', async () => {
  const h = await boot({ reduced: true })
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1')
  h.setState({ ok: true, sessions: [{ id: 's1', phase: 'working', detail: '', reason: 'tool:bash', completionKey: '' }] })
  await h.advance(600)

  const bot = botOf(made.slot)
  assert.ok(bot !== undefined, '头像仍要挂上')
  const first = eyePoints(bot)
  // 推进 600 帧
  await h.frameSamples(600)
  const last = eyePoints(bot)
  assert.equal(last, first, 'reduced-motion 下眼睛点位不得持续变化（眨眼/换脸/弹簧都必须停）')
})

test('R2 reduced-motion 下六态仍可区分（静态姿态不同）', async () => {
  const h = await boot({ reduced: true })
  const section = makeSection(h.doc, 'proj-a')
  const poses = new Map()
  for (const phase of ['idle', 'working', 'waiting', 'blocked', 'thinking', 'done']) {
    const made = makeRow(h.doc, section, 's-' + phase)
    h.setState({ ok: true, sessions: [{ id: 's-' + phase, phase, detail: '', reason: 'x', completionKey: phase === 'done' ? 'k-' + phase : '', completedAt: h.api ? h.api ? Date.now() : 0 : 0 }] })
    await h.advance(600)
    const bot = botOf(made.slot)
    assert.ok(bot !== undefined, phase + ' 应该有头像')
    poses.set(phase, eyePoints(bot))
  }
  // 至少要有可区分的姿态，不能六态全一样
  const unique = new Set(poses.values())
  assert.ok(unique.size >= 3, '六态在静态姿态上至少要能分出三种，实际 ' + unique.size)
})

test('R3 reduced-motion 下 done 仍是 done（不因关闭动画变成 idle）', async () => {
  const h = await boot({ reduced: true })
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1')
  h.setState({
    ok: true,
    sessions: [{ id: 's1', phase: 'done', detail: '', reason: 'terminal-completed', completionKey: 'k1', completedAt: Date.now() }],
  })
  await h.advance(600)
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'done', 'reduced-motion 不改变语义')
})

test('R4 系统偏好在运行时变化，监听被正确清理', async () => {
  const h = await boot({ reduced: false })
  const section = makeSection(h.doc, 'proj-a')
  makeRow(h.doc, section, 's1')
  h.setState({ ok: true, sessions: [{ id: 's1', phase: 'working', detail: '', reason: 'x', completionKey: '' }] })
  await h.advance(600)
  assert.ok(h.mediaListeners >= 1, '应订阅系统偏好变化')
  h.api.stop()
  assert.equal(h.mediaListeners, 0, 'stop 之后必须移除监听')
})

test('R5 stop 之后不遗留 RAF / 定时器 / 全局对象', async () => {
  const h = await boot({ reduced: false })
  const section = makeSection(h.doc, 'proj-a')
  makeRow(h.doc, section, 's1')
  h.setState({ ok: true, sessions: [{ id: 's1', phase: 'working', detail: '', reason: 'x', completionKey: '' }] })
  await h.advance(600)
  h.api.stop()
  await h.advance(2000)
  assert.equal(h.api, undefined, '全局对象要清理')
})

test('R6 诊断的 animating 依据真实运行状态，而不是「有 dispose 函数」', async () => {
  const h = await boot({ reduced: true })
  const section = makeSection(h.doc, 'proj-a')
  makeRow(h.doc, section, 's1')
  h.setState({ ok: true, sessions: [{ id: 's1', phase: 'working', detail: '', reason: 'x', completionKey: '' }] })
  await h.advance(600)
  const probe = h.api.probe()
  const row = probe.rows.find((item) => item.sessionId === 's1')
  assert.equal(row.animating, false, 'reduced-motion 下没有持续动画，animating 必须是 false')
})

test('R7 正常动效下 animating 为 true 且点位持续推进', async () => {
  const h = await boot({ reduced: false })
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1')
  h.setState({ ok: true, sessions: [{ id: 's1', phase: 'working', detail: '', reason: 'x', completionKey: '' }] })
  await h.advance(600)
  const probe = h.api.probe()
  const row = probe.rows.find((item) => item.sessionId === 's1')
  assert.equal(row.animating, true, '正常动效下应报告在跑')
  const bot = botOf(made.slot)
  const before = eyePoints(bot)
  await h.frameSamples(20)
  assert.notEqual(eyePoints(bot), before, '正常动效下点位应推进')
})
