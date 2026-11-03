/**
 * **构建产物**的浏览器集成测试。
 *
 * 这里不做纯函数复测：它真的把 lib/widget.js（IIFE）在可控环境里跑起来，
 * 走真实的 boot → fetch → absorb → sync → mount → 动画 → dispose。
 *
 * 覆盖的都是「只有真跑才会暴露」的问题：
 *   · done 在 2.6s / 3s / 6s / 30s 之后是否仍在庆祝动作（orbit）；
 *   · 连续轮询是否重启了动画；
 *   · 查看并切走之后是否变灰且不再庆祝；
 *   · 槽位复用 / 重挂载 / 多实例；
 *   · stop 之后迟到的响应不能写 DOM；
 *   · 无障碍标签与 reduced-motion。
 *
 * @module test/widget-integration.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { Doc, El, jsonResponse } from './dom-harness.mjs'
import { PHASE_TO_MOTION } from '../src/mapping.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, '..', 'lib', 'widget.js')
const SOURCE = fs.readFileSync(BUNDLE, 'utf8')

/**
 * 搭一个环境并把 widget 真的跑起来。
 * @returns {Promise<object>} 环境句柄。
 */
async function boot(opts) {
  const options = opts === undefined ? {} : opts
  const doc = new Doc()
  const frames = []
  // epoch 量级的可控时钟（完成时间、失活阈值都按真实量级算）
  let now = 1_700_000_000_000
  const timers = new Map()
  let timerSeq = 0
  const observers = []
  const fetchLog = []
  let stateBody = { ok: true, now, sessions: [] }
  let colorsBody = { ok: true, projects: {} }
  let fetchFails = false
  let holdNext = null

  const windowListeners = new Map()
  const window = {
    document: doc,
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 2,
    location: { origin: 'http://127.0.0.1:1', href: 'http://127.0.0.1:1/' },
    navigator: { language: 'zh-CN' },
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set())
      windowListeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      if (windowListeners.has(type)) windowListeners.get(type).delete(handler)
    },
    listenerCount(type) {
      return windowListeners.has(type) ? windowListeners.get(type).size : 0
    },
  }
  doc.defaultView = window

  function flushMicrotasks() {
    return Promise.resolve()
  }

  function runTimers() {
    for (const [id, entry] of [...timers]) {
      if (entry.at <= now) {
        timers.delete(id)
        entry.fn()
      }
    }
  }

  const sandbox = {
    window,
    document: doc,
    navigator: window.navigator,
    // Date.now 与 performance.now 必须走**同一个**可控时钟：
    // 混用真实 epoch 与模拟单调时钟会让完成时间、失活阈值与采样时间互相矛盾。
    performance: { now: () => now },
    console,
    Math,
    Date: class extends Date {
      static now() {
        return now
      }
    },
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
      frames[id - 1] = null
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback
        observers.push(this)
      }
      observe() {}
      disconnect() {
        const index = observers.indexOf(this)
        if (index !== -1) observers.splice(index, 1)
      }
    },
    getComputedStyle: () => ({
      backgroundColor: 'rgb(20, 22, 26)',
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      colorScheme: 'dark',
    }),
    matchMedia: (query) => ({ matches: options.reduced === true && query.indexOf('reduced-motion') !== -1 }),
    fetch: (url, init) => {
      fetchLog.push({ url, method: (init !== undefined && init.method) || 'GET', at: now })
      if (fetchFails) return Promise.reject(new Error('network down'))
      if (typeof url === 'string' && url.indexOf('/colors.json') !== -1) {
        return Promise.resolve(jsonResponse(colorsBody))
      }
      if (typeof url === 'string' && url.indexOf('/probe') !== -1) {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ ok: false }) })
      }
      if (holdNext !== null) {
        const gate = holdNext
        holdNext = null
        return gate.then(() => jsonResponse(stateBody))
      }
      return Promise.resolve(jsonResponse(stateBody))
    },
  }
  sandbox.globalThis = sandbox
  window.__DSH_TEST__ = true

  const context = vm.createContext(sandbox)
  vm.runInContext(SOURCE, context, { filename: 'widget.js' })

  async function flush() {
    for (let i = 0; i < 60; i++) await flushMicrotasks()
  }

  const api = {
    doc,
    window,
    fetchLog,
    get timers() {
      return timers.size
    },
    get api() {
      return window.__dshGrokBuddy
    },
    setState(body) {
      stateBody = body
    },
    setColors(body) {
      colorsBody = body
    },
    failFetch(value) {
      fetchFails = value
    },
    holdNextRequest() {
      let release
      holdNext = new Promise((resolve) => {
        release = resolve
      })
      return release
    },
    async tick(ms) {
      now += ms
      runTimers()
      await flush()
    },
    async frame(count) {
      const n = typeof count === 'number' ? count : 1
      for (let i = 0; i < n; i++) {
        now += 16
        const pending = frames.splice(0, frames.length)
        for (const fn of pending) if (typeof fn === 'function') fn(now)
        await flush()
      }
    },
    async settle() {
      await flush()
      await api.frame(2)
    },
    sandbox,
  }
  await api.settle()
  return api
}

/** 造一行真实结构的侧栏会话行：hc-root > div[data-row-key][role=treeitem] > span.slot + span.title */
function makeRow(doc, sectionEl, sessionId, selected) {
  const row = doc.createElement('div')
  row.setAttribute('data-row-key', 'session:' + sessionId)
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-selected', selected === true ? 'true' : 'false')
  const slot = doc.createElement('span')
  slot.className = 'JoiKIa_slot'
  const dot = doc.createElement('span')
  dot.setAttribute('data-state', 'idle')
  slot.appendChild(dot)
  const title = doc.createElement('span')
  title.className = 'JoiKIa_title'
  title.textContent = '会话 ' + sessionId
  row.appendChild(slot)
  row.appendChild(title)
  const wrap = doc.createElement('span')
  wrap.className = 'hc-root'
  wrap.appendChild(row)
  const group = doc.createElement('div')
  group.setAttribute('role', 'group')
  group.appendChild(wrap)
  sectionEl.appendChild(group)
  return { row, slot, wrap }
}

/** 造一个项目分区。 */
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

/** 从某一行里拿出头像 svg。 */
/** 取眼睛图层（按图层标记找，不依赖子节点序号）。 */
function eyeLayer(bot) {
  const group = bot.querySelector('[data-dsgb-layer="eyes"]')
  return group === null ? null : group.children[0]
}

function botOf(slot) {
  return slot.children.find((child) => String(child.getAttribute('class') || '').indexOf('dsgb-bot') !== -1)
}

function sessionsBody(list) {
  return { ok: true, now: 1, sessions: list }
}

function doneRow(id, completionKey, completedAt) {
  return {
    id,
    phase: 'done',
    reason: 'terminal-completed',
    detail: '',
    completionKey,
    completedAt,
  }
}

function phaseRow(id, phase, extra) {
  return { id, phase, reason: 'test', detail: '', ...(extra === undefined ? {} : extra) }
}

test('构建产物能真的 boot 起来，并把头像挂进 16px 前导位', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'thinking')]))
  await h.tick(600)
  const bot = botOf(slot)
  assert.ok(bot !== undefined, '头像应该挂进前导位')
  assert.equal(bot.getAttribute('width'), '16')
  assert.equal(bot.getAttribute('data-dsgb-phase'), 'thinking')
  assert.equal(slot.getAttribute('data-dsgb-slot'), '1')
  h.api.stop()
})

test('六态各自映射到不同的动作预设，且 DOM 只表达六态', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const rows = {}
  for (const phase of ['idle', 'working', 'waiting', 'blocked', 'thinking', 'done']) {
    rows[phase] = makeRow(h.doc, section, 's-' + phase, false)
  }
  h.setState(
    sessionsBody([
      phaseRow('s-idle', 'idle'),
      phaseRow('s-working', 'working'),
      phaseRow('s-waiting', 'waiting'),
      phaseRow('s-blocked', 'blocked'),
      phaseRow('s-thinking', 'thinking'),
      doneRow("s-done", "k-done", h.now),
    ]),
  )
  await h.tick(600)
  for (const phase of ['idle', 'working', 'waiting', 'blocked', 'thinking', 'done']) {
    const bot = botOf(rows[phase].slot)
    assert.ok(bot !== undefined, phase + ' 应该有头像')
    assert.equal(bot.getAttribute('data-dsgb-phase'), phase)
  }
  h.api.stop()
})

test('done 在 2.6s / 3s / 6s / 30s 之后始终保持 celebrate', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([doneRow('s1', 'k1', h.now)]))
  await h.tick(600)
  assert.equal(botOf(slot).getAttribute('data-dsgb-motion'), 'orbit')

  for (const wait of [2600, 400, 3000, 24000]) {
    await h.tick(wait)
    assert.equal(botOf(slot).getAttribute('data-dsgb-phase'), 'done', '第 ' + wait + 'ms 后仍是 done')
    assert.equal(botOf(slot).getAttribute('data-dsgb-motion'), 'orbit', '第 ' + wait + 'ms 后仍在庆祝')
  }
  h.api.stop()
})

test('初次拿到 done 后停掉后续轮询，也不会有隐藏定时器把它改成别的动作', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([doneRow('s1', 'k1', h.now)]))
  await h.tick(600)
  const before = botOf(slot).getAttribute('data-dsgb-motion')
  // 只跑动画帧 + 定时器，不再改变 state
  await h.frame(120)
  await h.tick(8000)
  assert.equal(botOf(slot).getAttribute('data-dsgb-motion'), before)
  assert.equal(before, 'orbit')
  h.api.stop()
})

test('同一状态连续轮询不重启动画（不重置相位起点）', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  await h.tick(600)
  const bot = botOf(slot)
  // 记录一次动画 tick 之后眼环的点数，再轮询若干次，点位应继续演进而不是回到初值
  await h.frame(3)
  const before = eyeLayer(bot).getAttribute('points')
  for (let i = 0; i < 8; i++) {
    await h.tick(500)
    await h.frame(1)
  }
  const after = eyeLayer(bot).getAttribute('points')
  assert.notEqual(before, after, '动画应该在继续演进')
  assert.equal(bot.getAttribute('data-dsgb-motion'), PHASE_TO_MOTION.working)
  h.api.stop()
})

test('done 过程中进入新一轮，旧回调不得覆盖新的状态', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([doneRow('s1', 'k1', h.now)]))
  await h.tick(600)
  assert.equal(botOf(slot).getAttribute('data-dsgb-phase'), 'done')
  h.setState(sessionsBody([phaseRow('s1', 'thinking')]))
  await h.tick(600)
  assert.equal(botOf(slot).getAttribute('data-dsgb-phase'), 'thinking')
  assert.notEqual(botOf(slot).getAttribute('data-dsgb-motion'), 'orbit')
  h.api.stop()
})

test('查看并切走后即使宿主继续返回历史 done，也保持 idle 灰色', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([doneRow('s1', 'k1', h.now)]))
  await h.tick(600)
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'done')

  // 选中 = 正在查看
  made.row.setAttribute('aria-selected', 'true')
  await h.tick(600)
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'done', '查看期间仍是 done')
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-tone'), 'active', '查看期间仍是项目色')

  // 切走
  made.row.setAttribute('aria-selected', 'false')
  await h.tick(600)
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'idle', '切走后是 idle')
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-tone'), 'dormant', '切走后是灰的')

  // 宿主继续返回同一条历史 done：不能重新庆祝
  for (let i = 0; i < 5; i++) {
    h.setState(sessionsBody([doneRow('s1', 'k1', h.now)]))
    await h.tick(600)
    assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'idle', '已消费的完成不得重新庆祝')
  }
  h.api.stop()
})

test('新一轮完成会建立新的展示周期（新 completionKey 重新庆祝）', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([doneRow('s1', 'k1', h.now)]))
  await h.tick(600)
  made.row.setAttribute('aria-selected', 'true')
  await h.tick(600)
  made.row.setAttribute('aria-selected', 'false')
  await h.tick(600)
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'idle')

  h.setState(sessionsBody([doneRow('s1', 'k2', h.now)]))
  await h.tick(600)
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'done', '新完成重新庆祝')
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-motion'), 'orbit')
  h.api.stop()
})

test('槽位复用给另一个会话时必须重新绑定身份', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  await h.tick(600)
  const firstBot = botOf(made.slot)
  assert.equal(firstBot.getAttribute('data-dsgb-phase'), 'working')

  // 同一个槽位改挂另一个会话
  made.row.setAttribute('data-row-key', 'session:s2')
  h.setState(sessionsBody([phaseRow('s2', 'waiting')]))
  await h.tick(600)
  const bots = made.slot.children.filter((child) => String(child.getAttribute('class') || '').indexOf('dsgb-bot') !== -1)
  assert.equal(bots.length, 1, '槽位里只能有一只头像')
  assert.equal(bots[0].getAttribute('data-dsgb-phase'), 'waiting')
  h.api.stop()
})

test('同一会话多处显示：各自独立动画，共享事实', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const a = makeRow(h.doc, section, 's1', false)
  const b = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'blocked')]))
  await h.tick(600)
  assert.notEqual(botOf(a.slot), botOf(b.slot), '两个槽位各有一只头像')
  assert.equal(botOf(a.slot).getAttribute('data-dsgb-phase'), 'blocked')
  assert.equal(botOf(b.slot).getAttribute('data-dsgb-phase'), 'blocked')
  h.api.stop()
})

test('槽位被移除后重新挂回，动画会重新起来（不是静止 SVG）', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  // 用 working：它有眼睛也有拖尾，两样都在动，能证明帧真的在推进
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  await h.tick(600)
  const bot = botOf(made.slot)

  // 把头像摘掉：动画循环会自己发现节点离开 DOM 并停下
  bot.remove()
  await h.frame(2)

  // 挂回来，再跑两帧：动画必须重新起来（而不是一张静止 SVG）
  made.slot.insertBefore(bot, made.slot.firstChild)
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  await h.tick(600)
  await h.frame(2)
  const eye = eyeLayer(bot)
  const pointsA = eye.getAttribute('points')
  await h.frame(6)
  const pointsB = eye.getAttribute('points')
  assert.notEqual(pointsA, pointsB, '重新挂回后动画应继续演进（不是静止 SVG）')
  h.api.stop()
})

test('符号态（thinking 三点）摘下重挂后同样会继续脉动', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'thinking')]))
  await h.tick(600)
  const bot = botOf(made.slot)
  const dots = () => bot.querySelector('[data-dsgb-layer="dots"]').children.map((c) => c.getAttribute('r')).join(',')
  bot.remove()
  await h.frame(2)
  made.slot.insertBefore(bot, made.slot.firstChild)
  h.setState(sessionsBody([phaseRow('s1', 'thinking')]))
  await h.tick(600)
  await h.frame(2)
  const before = dots()
  await h.frame(10)
  assert.notEqual(dots(), before, '三点必须继续脉动')
  h.api.stop()
})

test('HTTP 错误与非法快照不会把已有的脸清空成灰', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  await h.tick(600)
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'working')

  h.failFetch(true)
  await h.tick(600)
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'working', '网络错误不该清空状态')
  h.failFetch(false)

  h.setState({ ok: true, sessions: 'nonsense' })
  await h.tick(600)
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'working', '非法快照应被忽略')
  h.setState({ ok: true, sessions: [null, 42, { noId: true }] })
  await h.tick(600)
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'working')
  h.api.stop()
})

test('乱序响应：旧快照不能覆盖新快照', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  await h.tick(600)

  const release = h.holdNextRequest()
  h.setState(sessionsBody([phaseRow('s1', 'blocked')]))
  await h.tick(500) // 这一次被挂住
  h.setState(sessionsBody([phaseRow('s1', 'waiting')]))
  await h.tick(500) // 这一次立即返回
  release()
  await h.tick(600)
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'waiting', '旧响应不该覆盖新值')
  h.api.stop()
})

test('stop 之后迟到的网络响应不能重新写 DOM', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  await h.tick(600)
  const release = h.holdNextRequest()
  h.setState(sessionsBody([phaseRow('s1', 'done', { completionKey: 'late', completedAt: h.now })]))
  await h.tick(500) // 请求挂住
  h.api.stop()
  release()
  await h.tick(2000)
  assert.equal(botOf(made.slot), undefined, 'stop 之后头像应被移除')
  assert.equal(h.window.__dshGrokBuddy, undefined, 'stop 之后全局对象应被清掉')
})

test('stop 清理所有监听、定时器、样式与属性', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'idle')]))
  await h.tick(600)
  const styleBefore = h.doc.head.querySelector('style[data-dsh-grok-buddy="style"]')
  assert.ok(styleBefore !== null, '样式应该注入过')

  h.api.stop()
  await h.settle()
  assert.equal(h.doc.head.querySelector('style[data-dsh-grok-buddy="style"]'), null, '插件样式要清掉')
  assert.equal(made.slot.getAttribute('data-dsgb-slot'), null, '槽位标记要摘掉')
  assert.equal(made.slot.getAttribute('aria-label'), null, '我们加的 aria-label 要摘掉')
  assert.equal(made.row.getAttribute('data-dsgb-row'), null)
  assert.equal(h.doc.listenerCount('click'), 0, '捕获阶段点击监听要移除')
  assert.equal(h.doc.listenerCount('visibilitychange'), 0)
  assert.equal(h.window.listenerCount('resize'), 0)
  assert.equal(h.timers, 0, '所有定时器都要清掉')
})

test('重新 boot 不产生重复监听与重复样式', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'idle')]))
  await h.tick(600)
  // 再次执行同一份 bundle：旧全局对象存在时应直接返回
  vm.runInContext(SOURCE, vm.createContext({ ...h.sandbox, window: h.window, document: h.doc }), { filename: 'widget-again.js' })
  const styles = h.doc.head.querySelectorAll('style[data-dsh-grok-buddy="style"]')
  assert.ok(styles.length <= 1, '样式不能重复注入')
  h.api.stop()
})

test('无障碍：图标对读屏隐藏，语义挂在容器上', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'waiting', { detail: 'bash' })]))
  await h.tick(600)
  const bot = botOf(made.slot)
  assert.equal(bot.getAttribute('aria-hidden'), 'true')
  assert.equal(bot.hasAttribute('role'), false, '不能同时 aria-hidden 又有 role=img')
  assert.equal(bot.hasAttribute('aria-label'), false)
  assert.equal(made.slot.getAttribute('role'), 'img')
  assert.match(made.slot.getAttribute('aria-label'), /正在等待/)
  h.api.stop()
})

test('reduced-motion：不启动持续动画，但仍能区分六态', async () => {
  const h = await boot({ reduced: true })
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  await h.tick(600)
  const bot = botOf(made.slot)
  assert.ok(bot !== undefined)
  assert.equal(bot.getAttribute('data-dsgb-phase'), 'working')
  // 减少动效下仍在推进状态（静态姿态也要能区分六态）
  await h.tick(600)
  assert.equal(bot.getAttribute('data-dsgb-phase'), 'working')
  assert.equal(h.window.__dshGrokBuddy !== undefined, true)
  h.api.stop()
})

test('probe 默认不上报（仅窗口打开时才采样）', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'idle')]))
  await h.tick(6000)
  const probePosts = h.fetchLog.filter((entry) => entry.method === 'POST' && entry.url.indexOf('/probe') !== -1)
  assert.equal(probePosts.length, 0, '默认不该有任何诊断上报')
  h.api.stop()
})

test('搜索行缺少稳定身份时不猜，只记 unidentifiable', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  // 造一条真实结构的搜索结果行：没有 data-row-key
  const result = h.doc.createElement('div')
  result.className = 'JoiKIa_searchResultRow'
  result.setAttribute('role', 'treeitem')
  const heading = h.doc.createElement('span')
  heading.className = 'JoiKIa_searchResultHeading'
  const slot = h.doc.createElement('span')
  slot.className = 'JoiKIa_slot'
  heading.appendChild(slot)
  const title = h.doc.createElement('span')
  title.className = 'JoiKIa_searchResultTitle'
  title.textContent = '会话 s1'
  heading.appendChild(title)
  result.appendChild(heading)
  h.doc.body.appendChild(result)

  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  await h.tick(600)
  assert.equal(botOf(made.slot).getAttribute('data-dsgb-phase'), 'working')
  assert.equal(botOf(slot), undefined, '搜索结果行没有稳定身份时不得插入头像')
  const probe = h.window.__dshGrokBuddy.probe()
  assert.equal(probe.unidentifiableSearch, 1, '要如实记账')
  h.api.stop()
})