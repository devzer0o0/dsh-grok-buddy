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
import { BOT_SIZE } from '../src/widget/styles.js'
import { defaultInk, storeKey } from '../src/palette.js'
import { createRegistry } from '../lib/derive.js'

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
  // 设置与工作区名册各自独立：默认「自动配色关、自动置顶开、基线已完成」，
  // 名册默认不可用（与真实宿主缺服务时一致），需要时由用例覆盖。
  let settingsBody = {
    ok: true,
    autoColorNewFolders: false,
    autoPromoteActiveWorkspace: true,
    baselineComplete: true,
    knownWorkspaces: [],
  }
  if (options.settings !== undefined) settingsBody = { ...settingsBody, ...options.settings }
  let workspacesBody = { ok: true }
  // 最近会话列表：默认「拿不到」（与真实宿主缺会话服务时一致），需要时由用例覆盖。
  let recentBody = { ok: true, available: false, sessions: [] }
  let fetchFails = false
  let holdNext = null
  let holdNextColorsPost = null

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
      fetchLog.push({
        url,
        method: (init !== undefined && init.method) || 'GET',
        at: now,
        body: init === undefined ? undefined : init.body,
      })
      if (fetchFails) return Promise.reject(new Error('network down'))
      if (typeof url === 'string' && url.indexOf('/colors.json') !== -1) {
        const isPost = init !== undefined && init.method === 'POST'
        if (isPost && holdNextColorsPost !== null) {
          const gate = holdNextColorsPost
          holdNextColorsPost = null
          return gate.then(() => jsonResponse(colorsBody))
        }
        return Promise.resolve(jsonResponse(colorsBody))
      }
      if (typeof url === 'string' && url.indexOf('/probe') !== -1) {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ ok: false }) })
      }
      if (typeof url === 'string' && url.indexOf('/settings.json') !== -1) {
        const isPost = init !== undefined && init.method === 'POST'
        if (isPost) {
          // 服务端语义：只认白名单字段，回写后返回完整设置。
          const patch = JSON.parse(init.body)
          settingsBody = { ...settingsBody, ...patch }
        }
        return Promise.resolve(jsonResponse(settingsBody))
      }
      if (typeof url === 'string' && url.indexOf('/workspaces.json') !== -1) {
        return Promise.resolve(jsonResponse(workspacesBody))
      }
      if (typeof url === 'string' && url.indexOf('/recent.json') !== -1) {
        return Promise.resolve(jsonResponse(recentBody))
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
  // 工作区标题栏模块默认不启动（桩 DOM 没有侧栏结构）；需要它的用例显式打开。
  if (options.chrome === true) window.__DSH_CHROME_TEST__ = true

  const context = vm.createContext(sandbox)
  vm.runInContext(SOURCE, context, { filename: 'widget.js' })
  if (options.chrome === true && window.__dsgbChromeTest !== undefined) window.__dsgbChromeTest.start()

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
    setSettings(body) {
      settingsBody = body
    },
    setWorkspaces(body) {
      workspacesBody = body
    },
    setRecent(body) {
      recentBody = body
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
    /** 把下一次 POST /colors.json 挂起（测连续改色的时序保护）。 */
    holdNextColorsPost() {
      let release
      holdNextColorsPost = new Promise((resolve) => {
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

/**
 * 一行宿主快照。
 *
 * blocked 必须带**任务级错误停止证据**（stopCertain + stopSource + 轮次身份）：
 * 新规则下没有证据的 blocked 会被页面降级为 idle，所以 fixture 不能只写一个
 * 相位名 —— 那正是旧语义「有 error 就是 blocked」剩下的写法。
 */
function phaseRow(id, phase, extra) {
  const base = { id, phase, reason: 'test', detail: '', ...(extra === undefined ? {} : extra) }
  if (phase === 'blocked' && base.stopCertain === undefined) {
    base.stopCertain = true
    base.stopCause = 'error'
    base.stopSource = 'turn/end:error'
    base.stopCode = 'QUOTA'
    base.turnKey = id + '#1'
    base.stopTurnKey = id + '#1'
    if (base.reason === 'test') base.reason = 'stop:QUOTA'
  }
  return base
}

test('构建产物能真的 boot 起来，并把头像挂进前导位', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'thinking')]))
  await h.tick(600)
  const bot = botOf(slot)
  assert.ok(bot !== undefined, '头像应该挂进前导位')
  // 尺寸取自 styles.js 的 BOT_SIZE：比原生 16px 状态点大，侧栏里才认得出。
  assert.equal(bot.getAttribute('width'), String(BOT_SIZE))
  assert.equal(bot.getAttribute('data-dsgb-phase'), 'thinking')
  assert.equal(slot.getAttribute('data-dsgb-slot'), '1')
  h.api.stop()
})

test('真实事件折叠 → 快照 → bundle：短命令在两次轮询间完成也能画出 working 尾迹', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'tools')
  const { slot } = makeRow(h.doc, section, 'short-tool', false)
  const registry = createRegistry({ now: () => h.sandbox.Date.now() })
  const event = (type, data) => registry.onEvent({ id: 'short-tool' }, { type, data: { turn: 1, ...data } })
  event('turn/start', {})
  event('tool/call', { callId: 'bash-1', name: 'bash' })
  await h.tick(20)
  event('tool/result', { message: { source: { callId: 'bash-1' } } })
  const body = registry.snapshot()
  assert.equal(body.sessions[0].phase, 'thinking', '不能谎报工具仍在执行')
  h.setState(body)
  await h.tick(500)
  const bot = botOf(slot)
  assert.equal(bot.getAttribute('data-dsgb-phase'), 'thinking')
  assert.equal(bot.getAttribute('data-dsgb-motion'), 'spin')
  assert.equal(bot.getAttribute('data-dsgb-cue'), 'recent-tool')
  await h.frame(16)
  const paths = ['trail-back', 'trail'].flatMap(layer => [...bot.querySelector('[data-dsgb-layer="' + layer + '"]').children])
  assert.ok([...paths].some(p => p.getAttribute('d')), '不到 300ms 已有实际彩带路径，不只是 motion 标签')
  h.api.sync()
  assert.equal(botOf(slot), bot, '重复同步不重建实例')
  h.failFetch(true)
  await h.tick(700)
  assert.equal(bot.getAttribute('data-dsgb-motion'), 'tri-dot', '网络失败也不延长 650ms 提示')
  h.failFetch(false)
  await h.tick(600)
  assert.equal(bot.getAttribute('data-dsgb-motion'), 'tri-dot', '同一调用不重播')
  h.api.stop()
  assert.equal(h.timers, 0)
})

for (const nextPhase of ['done', 'waiting', 'blocked', 'idle']) {
  test(`短调用提示不覆盖 ${nextPhase}，且失活后不重播`, async () => {
    const h = await boot()
    const { slot } = makeRow(h.doc, makeSection(h.doc, 'tools'), 's', false)
    const evidence = { turnKey: 's#1', toolActivityKey: 's:tool:1', toolActivityAt: h.sandbox.Date.now(), toolActivityTurnKey: 's#1' }
    h.setState(sessionsBody([phaseRow('s', 'thinking', evidence)]))
    await h.tick(500)
    assert.equal(botOf(slot).getAttribute('data-dsgb-motion'), 'spin')
    h.setState(sessionsBody([phaseRow('s', nextPhase, evidence)]))
    await h.tick(500)
    assert.equal(botOf(slot).getAttribute('data-dsgb-motion'), PHASE_TO_MOTION[nextPhase])
    h.api.stop()
  })
}

test('reduced-motion 不补播短工具，仍保留 thinking 静态三点', async () => {
  const h = await boot({ reduced: true })
  const { slot } = makeRow(h.doc, makeSection(h.doc, 'tools'), 's', false)
  h.setState(sessionsBody([phaseRow('s', 'thinking', { turnKey: 's#1', toolActivityKey: 's:tool:1', toolActivityAt: h.sandbox.Date.now(), toolActivityTurnKey: 's#1' })]))
  await h.tick(500)
  assert.equal(botOf(slot).getAttribute('data-dsgb-motion'), 'tri-dot')
  h.api.stop()
})

test('短调用提示不能继承前一段 working 的无彩带收尾帧', async () => {
  const h = await boot()
  const { slot } = makeRow(h.doc, makeSection(h.doc, 'tools'), 's', false)
  h.setState(sessionsBody([phaseRow('s', 'working')]))
  await h.tick(500)
  await h.frame(150)
  const bot = botOf(slot)
  const ribbons = () => ['trail-back','trail'].flatMap(layer => [...bot.querySelector('[data-dsgb-layer="'+layer+'"]').children])
  assert.ok(ribbons().every(p => !p.getAttribute('d')), '前提：旧动作正在安静收尾')
  h.setState(sessionsBody([phaseRow('s', 'thinking', { turnKey: 's#1', toolActivityKey: 's:tool:2', toolActivityAt: h.sandbox.Date.now(), toolActivityTurnKey: 's#1' })]))
  await h.tick(500)
  await h.frame(18)
  assert.ok(ribbons().some(p => p.getAttribute('d')), '新提示在 300ms 内可见，不能落在旧循环的静止部分')
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



// ── 项目行原生文件夹着色：与 Buddy 同一个身份色来源 ─────────────────────────
//
// 夹具照 dsh-client-ui-workspace 的 ProjectRowItem 抄：
//   div[data-row-key="workspace:…"]
//     > span.slot.folder > svg(path stroke="currentColor")   ← 被着色的对象
//     > span.slot.chevron > svg.arrow                        ← 不得被着色
//     > span.projectText > span.title                        ← 不得被着色
//     > span.rowActions                                      ← ⋯ 菜单 / 新建会话

const FOLDER_VAR = '--dsgb-workspace-ink'
const FOLDER_MARK = 'data-dsgb-workspace-folder'

/** 造一个带原生文件夹图标位的项目分区（可不含会话：折叠 / 空项目）。 */
function makeFolderSection(doc, workspaceId, options) {
  const opts = options === undefined ? {} : options
  const section = doc.createElement('div')
  section.className = 'JoiKIa_groupSection'
  const row = doc.createElement('div')
  row.setAttribute('data-row-key', 'workspace:' + workspaceId)
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-expanded', opts.collapsed === true ? 'false' : 'true')
  const folder = doc.createElement('span')
  folder.className = 'JoiKIa_slot JoiKIa_folder' + (opts.active === true ? ' JoiKIa_folderActive' : '')
  const folderSvg = doc.createElement('svg')
  folderSvg.setAttribute('width', '16')
  folderSvg.setAttribute('height', '16')
  folderSvg.setAttribute('fill', 'none')
  const folderPath = doc.createElement('path')
  folderPath.setAttribute('stroke', 'currentColor')
  folderSvg.appendChild(folderPath)
  folder.appendChild(folderSvg)
  const chevron = doc.createElement('span')
  chevron.className = 'JoiKIa_slot JoiKIa_chevron'
  const arrow = doc.createElement('svg')
  arrow.className = 'JoiKIa_arrow'
  chevron.appendChild(arrow)
  const text = doc.createElement('span')
  text.className = 'JoiKIa_projectText'
  const title = doc.createElement('span')
  title.className = 'JoiKIa_title'
  title.textContent = opts.title === undefined ? workspaceId : opts.title
  text.appendChild(title)
  const actions = doc.createElement('span')
  actions.className = 'JoiKIa_rowActions'
  row.appendChild(folder)
  row.appendChild(chevron)
  row.appendChild(text)
  row.appendChild(actions)
  const wrap = doc.createElement('span')
  wrap.className = 'hc-root'
  wrap.appendChild(row)
  section.appendChild(wrap)
  doc.body.appendChild(section)
  return { section, row, folder, title }
}

function folderInkOf(folder) {
  return folder.style.getPropertyValue(FOLDER_VAR)
}

/** 一个 hex 对应的预设色名（用来点对应色块）。 */
function nameOfInk(hex) {
  const names = { '#1084fe': '蓝', '#9159fe': '紫', '#ff9800': '橙', '#ff309b': '粉', '#ff6700': '橙红', '#97683d': '赭', '#00bca6': '青', '#ff263c': '红' }
  const found = names[hex.toLowerCase()]
  if (found === undefined) throw new Error('不是预设色: ' + hex)
  return found
}

/** 头像身体墨色（engine 把项目墨色写进 body path 的 fill）。 */
function botBodyFill(slot) {
  const bot = botOf(slot)
  if (bot === undefined) return null
  const body = bot.querySelector('[data-dsgb-layer="body"]')
  return body === null ? null : body.children[0].getAttribute('fill')
}

/** 打开宿主 ⋯ 菜单（decorateMenus 会往里补「颜色」项）。 */
function openHostMenu(h, workspaceId) {
  const row = h.doc.querySelector('[data-row-key="workspace:' + workspaceId + '"]')
  row.setAttribute('class', 'JoiKIa_projectRow JoiKIa_menuOpen')
  const menu = h.doc.createElement('div')
  menu.setAttribute('data-menu-material', '')
  // DSH 的 Menu 把 menuitem 包在内层容器里；decorateMenus 把「颜色」追加在
  // 这个容器**之后**（wrap.parentElement.appendChild），照真实结构抄。
  const wrap = h.doc.createElement('div')
  for (const label of ['重命名', '删除工作区']) {
    const item = h.doc.createElement('button')
    item.setAttribute('role', 'menuitem')
    item.textContent = label
    wrap.appendChild(item)
  }
  menu.appendChild(wrap)
  h.doc.body.appendChild(menu)
  return menu
}

/** 点调色板里某个名字的色块 / 恢复默认。 */
function paletteButton(h, selector) {
  const box = h.doc.querySelector('.dsgb-palette')
  if (box === null) throw new Error('调色板没开')
  return box.querySelector(selector)
}

/** 点 ⋯ 菜单里的「颜色」项（桩 DOM 不支持后代选择器，分两步找）。 */
function clickColorEntry(h) {
  const holder = h.doc.querySelector('.dsgb-menu-item')
  if (holder === null) throw new Error('菜单里没有颜色项')
  holder.querySelector('button').fire('click')
}

test('项目文件夹默认保持 DSH 原生色：没有插件标记，也不写颜色变量', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  await h.tick(600)
  assert.equal(made.folder.getAttribute(FOLDER_MARK), null, '没有显式配置时不得打插件标记')
  assert.equal(folderInkOf(made.folder), '', '没有显式配置时不得写插件颜色变量')
  const chevron = made.row.children.find((child) => String(child.getAttribute('class') || '').indexOf('chevron') !== -1)
  assert.equal(chevron.getAttribute(FOLDER_MARK), null, '箭头那格不得被标记')
  assert.equal(made.title.getAttribute(FOLDER_MARK), null, '标题不得被标记')
  // 宿主自己的 class 一个都不能动：folderActive 等状态类是原生颜色的来源
  assert.match(String(made.folder.getAttribute('class')), /folderActive|JoiKIa_folder/)
  const report = h.api.folders()
  assert.equal(report.length, 1)
  assert.equal(report[0].marked, false)
  assert.equal(report[0].ink, null)
  assert.equal(report[0].chosen, null, '诊断里能看出「未设置」')
  h.api.stop()
})

test('折叠项目、空项目、未分组同样不被着色（不依赖会话记录）', async () => {
  const h = await boot()
  const collapsed = makeFolderSection(h.doc, 'proj-empty', { collapsed: true })
  const ungrouped = makeFolderSection(h.doc, '', { title: '未分组' })
  await h.tick(600)
  for (const made of [collapsed, ungrouped]) {
    assert.equal(made.folder.getAttribute(FOLDER_MARK), null)
    assert.equal(folderInkOf(made.folder), '')
  }
  // 显式配置后（未分组用保留键）才着色，且跟着轮询生效
  h.setColors({ ok: true, projects: { __ungrouped__: '#00bca6' } })
  await h.tick(2000)
  assert.equal(folderInkOf(ungrouped.folder), '#00bca6')
  assert.equal(folderInkOf(collapsed.folder), '', '没配置的项目仍保持原生')
  h.api.stop()
})

test('显式选色后各用各的色；同名标题也不会串色，改标题不变色', async () => {
  const h = await boot()
  const a = makeFolderSection(h.doc, 'proj-a', { title: '同名' })
  const b = makeFolderSection(h.doc, 'proj-b', { title: '同名' })
  h.setColors({ ok: true, projects: { 'proj-a': '#9159fe', 'proj-b': '#00bca6' } })
  await h.tick(2000)
  const inkA = folderInkOf(a.folder)
  const inkB = folderInkOf(b.folder)
  assert.equal(inkA, '#9159fe')
  assert.equal(inkB, '#00bca6')
  assert.notEqual(inkA, inkB, '身份由 key 决定，不由标题决定')
  // 重命名：标题文本变了，色不变
  a.title.textContent = '新名字'
  await h.tick(600)
  assert.equal(folderInkOf(a.folder), inkA)
  h.api.stop()
})

test('用户选的色恰好等于哈希默认色，仍算已设置：文件夹继续着色', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  const same = defaultInk('proj-a')
  await h.tick(600)
  assert.equal(folderInkOf(made.folder), '', '前提：未设置时是原生色')
  // 走真实交互选一个「恰好等于哈希默认色」的色
  openHostMenu(h, 'proj-a')
  await h.tick(600)
  clickColorEntry(h)
  const swatch = paletteButton(h, '[aria-label="' + nameOfInk(same) + '"]')
  swatch.fire('click')
  await h.settle()
  assert.equal(
    h.fetchLog.filter((entry) => entry.method === 'POST' && entry.url.indexOf('/colors.json') !== -1).length,
    1,
    '要真的写进配置',
  )
  assert.equal(folderInkOf(made.folder), same, '与哈希默认同值的显式选择仍要着色')
  assert.equal(made.folder.getAttribute(FOLDER_MARK), '1')
  // 轮询回来的配色表里确实有这一项
  h.setColors({ ok: true, projects: { 'proj-a': same } })
  await h.tick(2000)
  assert.equal(folderInkOf(made.folder), same, '轮询后依然是显式色，不回原生')
  h.api.stop()
})

test('轮询拿到新配色表：显式色 → 文件夹与彩色 Buddy 同步；别的窗口删掉配置 → 文件夹回原生、Buddy 回哈希默认', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, made.section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  await h.tick(600)
  assert.equal(folderInkOf(made.folder), '', '未配置时不写文件夹色')
  assert.equal(botBodyFill(slot), defaultInk('proj-a'), 'Buddy 仍按既有规则用哈希默认色')

  h.setColors({ ok: true, projects: { 'proj-a': '#9159fe' } })
  await h.tick(2000)
  assert.equal(folderInkOf(made.folder), '#9159fe', '文件夹跟新配色')
  assert.equal(botBodyFill(slot), '#9159fe', 'Buddy 同步跟新配色')

  // 别的窗口把自定义色删了：文件夹还给宿主，Buddy 回哈希默认
  h.setColors({ ok: true, projects: {} })
  await h.tick(2000)
  assert.equal(folderInkOf(made.folder), '', '文件夹恢复原生（插件变量撤掉）')
  assert.equal(made.folder.getAttribute(FOLDER_MARK), null, '插件标记也要撤掉')
  assert.equal(botBodyFill(slot), defaultInk('proj-a'), 'Buddy 保持既有默认规则')
  assert.equal(h.api.folders()[0].marked, false)
  h.api.stop()
})

test('点预设色：文件夹立刻更新，不等下一次轮询；文件夹色 = Buddy 身体色', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, made.section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  const menu = openHostMenu(h, 'proj-a')
  await h.tick(600)
  const entry = menu.querySelector('.dsgb-menu-item')
  assert.ok(entry !== null, '⋯ 菜单里应该有颜色入口')
  entry.querySelector('button').fire('click')
  const red = paletteButton(h, '[aria-label="红"]')
  red.fire('click')
  await h.settle()
  assert.equal(folderInkOf(made.folder), '#ff263c', '预设色 #ff263c 立刻落到文件夹')
  assert.equal(botBodyFill(slot), '#ff263c', '同一时刻 Buddy 身体同色')
  const posts = h.fetchLog.filter((entry2) => entry2.method === 'POST' && entry2.url.indexOf('/colors.json') !== -1)
  assert.equal(posts.length, 1, '走同一条提交链路')
  h.api.stop()
})

test('扩充色块同样走预设色提交链路：文件夹与 Buddy 一起换色', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  openHostMenu(h, 'proj-a')
  await h.tick(600)
  clickColorEntry(h)
  const green = paletteButton(h, '[aria-label="绿"]')
  assert.notEqual(green, null, '调色板里应该有扩充的「绿」色块')
  green.fire('click')
  await h.settle()
  assert.equal(folderInkOf(made.folder), '#22b573', '扩充色同样立刻落到文件夹')
  const posts = h.fetchLog.filter((entry) => entry.method === 'POST' && entry.url.indexOf('/colors.json') !== -1)
  assert.equal(posts.length, 1, '走同一条提交链路')
  h.api.stop()
})

test('自定义 hex 与恢复默认都生效：恢复默认后文件夹回到 DSH 原生（不留任何插件痕迹）', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  openHostMenu(h, 'proj-a')
  await h.tick(600)
  clickColorEntry(h)
  const input = paletteButton(h, '.dsgb-hex')
  input.value = '#00BCA6'
  paletteButton(h, '.dsgb-palette-apply').fire('click')
  await h.settle()
  assert.equal(folderInkOf(made.folder), '#00bca6')
  assert.equal(made.folder.getAttribute(FOLDER_MARK), '1')

  // 恢复默认：删除覆盖 → 标记与变量一起撤掉，让宿主 CSS 重新生效
  clickColorEntry(h)
  paletteButton(h, '.dsgb-palette-reset').fire('click')
  await h.settle()
  assert.equal(folderInkOf(made.folder), '', '恢复默认不得写回哈希色或任何固定色')
  assert.equal(made.folder.getAttribute(FOLDER_MARK), null)
  assert.equal(Object.keys(h.api.colors()).length, 0, '配置里也不能留哈希默认色')
  // Buddy 按既有默认规则显示（哈希默认色）
  const { slot } = makeRow(h.doc, made.section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  await h.tick(600)
  assert.equal(botBodyFill(slot), defaultInk('proj-a'), 'Buddy 恢复既有默认规则')
  h.api.stop()
})

test('调色板里有「最近活动的项目自动置顶」开关：默认勾选，点一下写设置并取消勾选', async () => {
  const h = await boot({ chrome: true })
  makeFolderSection(h.doc, 'proj-a')
  openHostMenu(h, 'proj-a')
  await h.tick(600)
  clickColorEntry(h)
  // 开关由 tick 补进调色板（桩 DOM 的 MutationObserver 是空实现，只能手动推进）。
  h.window.__dsgbChromeTest.tick()
  await h.settle()

  const box = h.doc.querySelector('.dsgb-promote')
  assert.notEqual(box, null, '调色板里要有自动置顶开关')
  const input = box.querySelector('input[type="checkbox"]')
  assert.notEqual(input, null, '开关是 checkbox')
  assert.equal(input.checked, true, '默认开启（设置里缺字段也按开启算）')
  assert.equal(input.disabled, false, '设置读到之后可以改')
  assert.match(box.textContent, /最近活动的项目自动置顶/, '有可读的开关名')
  assert.match(box.textContent, /同一会话继续执行不会重复移动/, '说明触发边界：只有新会话才移动')

  // 关掉：写设置 + 本地取消勾选
  input.checked = false
  input.fire('change')
  await h.settle()
  const posts = h.fetchLog.filter((entry) => entry.method === 'POST' && entry.url.indexOf('/settings.json') !== -1)
  assert.equal(posts.length, 1, '只写一次设置')
  assert.equal(input.checked, false, '关掉后保持未勾选')
  h.api.stop()
})

test('自动置顶开关：设置里已关闭时打开调色板就是未勾选', async () => {
  const h = await boot({ chrome: true, settings: { autoPromoteActiveWorkspace: false } })
  makeFolderSection(h.doc, 'proj-a')
  openHostMenu(h, 'proj-a')
  await h.tick(600)
  clickColorEntry(h)
  h.window.__dsgbChromeTest.tick()
  await h.settle()
  const input = h.doc.querySelector('.dsgb-promote input[type="checkbox"]')
  assert.notEqual(input, null)
  assert.equal(input.checked, false, '设置里关着就不能显示成开启')
  h.api.stop()
})

test('未设置颜色时：色块都不标已选、自定义框不预填哈希默认色、打开调色板不写配置', async () => {
  const h = await boot()
  makeFolderSection(h.doc, 'proj-a')
  openHostMenu(h, 'proj-a')
  await h.tick(600)
  clickColorEntry(h)
  const box = h.doc.querySelector('.dsgb-palette')
  const on = box.querySelectorAll('.dsgb-swatch.is-on')
  assert.equal(on.length, 0, '未设置时不得把哈希默认色对应的色块标成已选')
  assert.equal(paletteButton(h, '.dsgb-hex').value, '', '未设置时输入框不预填')
  assert.equal(paletteButton(h, '.dsgb-palette-reset').textContent, '恢复默认', '按钮文案不再带色值')
  assert.match(box.textContent, /文件夹跟随 DSH/, '有简短说明表达默认行为')
  await h.settle()
  assert.equal(
    h.fetchLog.filter((entry) => entry.method === 'POST' && entry.url.indexOf('/colors.json') !== -1).length,
    0,
    '仅打开调色板不能产生配置写入',
  )
  h.api.stop()
})

test('已设置颜色时：对应色块标已选、自定义框显示当前值', async () => {
  const h = await boot()
  makeFolderSection(h.doc, 'proj-a')
  h.setColors({ ok: true, projects: { 'proj-a': '#9159fe' } })
  openHostMenu(h, 'proj-a')
  await h.tick(2000)
  clickColorEntry(h)
  const box = h.doc.querySelector('.dsgb-palette')
  const on = box.querySelectorAll('.dsgb-swatch.is-on')
  assert.equal(on.length, 1)
  assert.equal(on[0].getAttribute('aria-label'), '紫')
  assert.equal(paletteButton(h, '.dsgb-hex').value, '#9159fe')
  h.api.stop()
})

test('提交失败（原生 → 选色）：乐观着色撤销，文件夹回到 DSH 原生，Buddy 回默认规则', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, made.section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  await h.tick(600)
  assert.equal(folderInkOf(made.folder), '', '前提：原生状态')

  openHostMenu(h, 'proj-a')
  await h.tick(600)
  h.failFetch(true)
  clickColorEntry(h)
  paletteButton(h, '[aria-label="青"]').fire('click')
  await h.settle()
  assert.equal(folderInkOf(made.folder), '', '保存失败要撤销乐观着色，回到原生')
  assert.equal(made.folder.getAttribute(FOLDER_MARK), null, '插件标记也要撤掉')
  assert.equal(botBodyFill(slot), defaultInk('proj-a'), 'Buddy 回既有默认规则')
  assert.ok(h.doc.querySelector('.dsgb-color-error') !== null, '要有可观察的错误提示')
  h.api.stop()
})

test('提交失败（自定义色 → 恢复默认）：恢复此前的自定义色，并沿用错误提示', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  h.setColors({ ok: true, projects: { 'proj-a': '#9159fe' } })
  openHostMenu(h, 'proj-a')
  await h.tick(2000)
  assert.equal(folderInkOf(made.folder), '#9159fe')

  h.failFetch(true)
  clickColorEntry(h)
  paletteButton(h, '.dsgb-palette-reset').fire('click')
  await h.settle()
  assert.equal(folderInkOf(made.folder), '#9159fe', '失败后回到此前的自定义色')
  assert.equal(made.folder.getAttribute(FOLDER_MARK), '1', '标记也要回来')
  assert.ok(h.doc.querySelector('.dsgb-color-error') !== null, '沿用已有错误提示')
  h.api.stop()
})

test('恢复默认成功后，迟到的旧轮询响应不能把已删除的覆盖挂回来', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  h.setColors({ ok: true, projects: { 'proj-a': '#9159fe' } })
  await h.tick(2000)
  assert.equal(folderInkOf(made.folder), '#9159fe')

  // 把"恢复默认"的那次 POST 挂起，同时让配色表 GET 仍返回旧值（模拟旧响应）
  openHostMenu(h, 'proj-a')
  await h.tick(600)
  const release = h.holdNextColorsPost()
  clickColorEntry(h)
  paletteButton(h, '.dsgb-palette-reset').fire('click')
  await h.settle()
  assert.equal(folderInkOf(made.folder), '', '乐观撤销先落')

  // 旧配色表（还带着 proj-a）在轮询里回来：colorSeq 保护应当丢弃它
  await h.tick(1600)
  assert.equal(folderInkOf(made.folder), '', '旧轮询响应不得把覆盖挂回来')
  release()
  await h.settle()
  h.setColors({ ok: true, projects: {} })
  await h.tick(2000)
  assert.equal(folderInkOf(made.folder), '')
  h.api.stop()
})

test('提交失败：文件夹和 Buddy 一起回滚到已确认颜色，并给出可观察提示', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, made.section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'working')]))
  h.setColors({ ok: true, projects: { 'proj-a': '#9159fe' } })
  await h.tick(2000)
  assert.equal(folderInkOf(made.folder), '#9159fe')

  openHostMenu(h, 'proj-a')
  await h.tick(600)
  h.failFetch(true)
  clickColorEntry(h)
  paletteButton(h, '[aria-label="红"]').fire('click')
  await h.settle()
  assert.equal(folderInkOf(made.folder), '#9159fe', '失败后文件夹回旧色')
  assert.equal(botBodyFill(slot), '#9159fe', '失败后 Buddy 也回旧色（不分裂）')
  const toast = h.doc.querySelector('.dsgb-color-error')
  assert.ok(toast !== null, '要有可观察的错误提示')
  h.api.stop()
})

test('连续改色与旧响应交错：最后点击的颜色获胜', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  openHostMenu(h, 'proj-a')
  await h.tick(600)

  // 第一次点「红」，把它的 POST 挂起
  const release = h.holdNextColorsPost()
  clickColorEntry(h)
  paletteButton(h, '[aria-label="红"]').fire('click')
  await h.settle()
  assert.equal(folderInkOf(made.folder), '#ff263c', '乐观更新先落')

  // 第二次点「青」，它的 POST 立刻成功
  clickColorEntry(h)
  paletteButton(h, '[aria-label="青"]').fire('click')
  await h.settle()
  assert.equal(folderInkOf(made.folder), '#00bca6')

  // 现在放行第一次的旧响应：不得把颜色改回去
  release()
  await h.settle()
  assert.equal(folderInkOf(made.folder), '#00bca6', '旧响应不能覆盖最新选择')
  h.api.stop()
})

test('宿主把项目 A 的行节点复用为 B：有自定义色的 A → 未设置的 B，插件痕迹当场撤掉', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  h.setColors({ ok: true, projects: { 'proj-a': '#9159fe' } })
  await h.tick(2000)
  assert.equal(folderInkOf(made.folder), '#9159fe')
  assert.equal(made.folder.getAttribute(FOLDER_MARK), '1')
  // B 没有显式配置 → 节点必须回到原生：不得残留 A 的变量与标记
  made.row.setAttribute('data-row-key', 'workspace:proj-b')
  h.api.sync()
  await h.settle()
  assert.equal(folderInkOf(made.folder), '', '复用节点不得残留 A 的颜色')
  assert.equal(made.folder.getAttribute(FOLDER_MARK), null, '也不得残留 A 的标记')
  // 再复用回有显式色的 C：又要着色（记录能重建）
  h.setColors({ ok: true, projects: { 'proj-a': '#9159fe', 'proj-c': '#00bca6' } })
  made.row.setAttribute('data-row-key', 'workspace:proj-c')
  await h.tick(2000)
  assert.equal(folderInkOf(made.folder), '#00bca6', '复用为有配置的项目时重新着色')
  h.api.stop()
})

test('节点卸载后重新挂载：未配置的保持原生，已配置的重新着色', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  h.setColors({ ok: true, projects: { 'proj-a': '#9159fe' } })
  await h.tick(2000)
  assert.equal(folderInkOf(made.folder), '#9159fe')
  // 整个分区摘掉再挂回来
  made.section.remove()
  h.api.sync()
  await h.settle()
  h.doc.body.appendChild(made.section)
  h.api.sync()
  await h.settle()
  assert.equal(folderInkOf(made.folder), '#9159fe', '重新挂载后仍按显式色着色')
  assert.equal(made.folder.getAttribute(FOLDER_MARK), '1')

  // 未配置的项目卸载重挂：始终不带插件痕迹
  const plain = makeFolderSection(h.doc, 'proj-plain')
  await h.tick(600)
  plain.section.remove()
  h.api.sync()
  await h.settle()
  h.doc.body.appendChild(plain.section)
  h.api.sync()
  await h.settle()
  assert.equal(folderInkOf(plain.folder), '')
  assert.equal(plain.folder.getAttribute(FOLDER_MARK), null)
  h.api.stop()
})

test('宿主替换文件夹 SVG（展开/收起换图标）：新图标仍在同一格、色不丢', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  h.setColors({ ok: true, projects: { 'proj-a': '#9159fe' } })
  await h.tick(2000)
  const firstInk = folderInkOf(made.folder)
  // 换掉格子里的 SVG（宿主 open/close 切换就是这么干的）
  const svg = made.folder.children[0]
  svg.remove()
  const fresh = h.doc.createElement('svg')
  const freshPath = h.doc.createElement('path')
  freshPath.setAttribute('stroke', 'currentColor')
  fresh.appendChild(freshPath)
  made.folder.appendChild(fresh)
  h.api.sync()
  await h.settle()
  assert.equal(made.folder.getAttribute(FOLDER_MARK), '1', '标记还在格子上')
  assert.equal(folderInkOf(made.folder), firstInk, '色不丢')
  // 整个格子被换掉：新格子也要被重新着色
  const replacement = h.doc.createElement('span')
  replacement.className = 'JoiKIa_slot JoiKIa_folder'
  replacement.appendChild(h.doc.createElement('svg'))
  made.folder.remove()
  made.row.insertBefore(replacement, made.row.children[0])
  h.api.sync()
  await h.settle()
  assert.equal(replacement.getAttribute(FOLDER_MARK), '1', '新格子被标记')
  assert.equal(replacement.style.getPropertyValue(FOLDER_VAR), firstInk, '新格子用项目色')
  const report = h.api.folders()
  assert.equal(report.length, 1, '旧记录已释放，不重复')
  h.api.stop()
})

test('stop() 把文件夹外观还给宿主：标记与变量都摘掉', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  h.setColors({ ok: true, projects: { 'proj-a': '#9159fe' } })
  await h.tick(2000)
  assert.equal(made.folder.getAttribute(FOLDER_MARK), '1')
  h.api.stop()
  assert.equal(made.folder.getAttribute(FOLDER_MARK), null, '标记要摘掉')
  assert.equal(folderInkOf(made.folder), '', 'CSS 变量要摘掉')
  assert.equal(h.api, undefined, '对外 API 也一并撤下')
})

test('重启（stop 后重新 boot）不重复注入、不残留旧色；未配置的项目重启后仍是原生', async () => {
  const h = await boot()
  const made = makeFolderSection(h.doc, 'proj-a')
  h.setColors({ ok: true, projects: { 'proj-a': '#9159fe' } })
  await h.tick(2000)
  h.api.stop()
  // 重新 boot：同页再来一次（widget 的 boot 幂等守卫靠全局对象，这里手动再跑一次产物）
  const boot2 = await boot()
  const made2 = makeFolderSection(boot2.doc, 'proj-a')
  const plain2 = makeFolderSection(boot2.doc, 'proj-plain')
  await boot2.tick(600)
  assert.equal(made2.folder.getAttribute(FOLDER_MARK), null, '新页面没有配色表时保持原生')
  assert.equal(folderInkOf(made2.folder), '')
  assert.equal(plain2.folder.getAttribute(FOLDER_MARK), null)
  const marks = boot2.doc.querySelectorAll('[' + FOLDER_MARK + '="1"]')
  assert.equal(marks.length, 0, '没有任何插件标记')
  boot2.api.stop()
})

test('storeKey 保留键：未分组的自定义色存 __ungrouped__，取色时对得上', async () => {
  assert.equal(storeKey(''), '__ungrouped__')
  assert.equal(storeKey('proj-a'), 'proj-a')
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
// ── blocked 的新语义：只有「任务级错误停止」才显示感叹号 ──────────────────

/** 读一帧的图层可见性（看真实图层，不看动作名）。 */
function figuresOf(slot) {
  const svg = botOf(slot)
  if (svg === undefined || svg === null) return null
  const shown = (name) => {
    const el = svg.querySelector('[data-dsgb-layer="' + name + '"]')
    if (el === null) return false
    // 两个真实来源：内联 style.display（引擎用）与 display 属性。
    if (el.style !== undefined && el.style.display === 'none') return false
    if (typeof el.getAttribute === 'function' && el.getAttribute('display') === 'none') return false
    return true
  }
  return {
    phase: svg.getAttribute('data-dsgb-phase'),
    motion: svg.getAttribute('data-dsgb-motion'),
    bang: shown('bang'),
    body: shown('body'),
    dots: shown('dots'),
  }
}

/** 逐帧采样：每一步都检查，绝不只看最终结论。 */
async function sampleSteps(h, slot, steps) {
  const out = []
  for (const step of steps) {
    h.setState(step.body)
    await h.tick(step.ms === undefined ? 550 : step.ms)
    // 图层由动画帧推进：必须真的走几帧，才看得到这一态的实际绘制
    await h.frame(6)
    out.push({ label: step.label, figure: figuresOf(slot) })
  }
  return out
}

test('可恢复错误全过程：诊断错误 + 自动重试 + 恢复，从不出现 blocked 感叹号', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, section, 's1', false)
  const seq = await sampleSteps(h, slot, [
    { label: '开始', body: sessionsBody([phaseRow('s1', 'thinking', { reason: 'model:requested' })]) },
    {
      label: '工具失败（局部）',
      body: sessionsBody([phaseRow('s1', 'thinking', { reason: 'model:requested', errorCode: 'ENOENT' })]),
    },
    {
      label: '另一工具仍在跑',
      body: sessionsBody([phaseRow('s1', 'working', { reason: 'tool:bash', detail: 'bash', errorCode: 'ENOENT' })]),
    },
    {
      label: '进入重试退避',
      body: sessionsBody([
        phaseRow('s1', 'thinking', { reason: 'model:requested:retry', retrying: true, errorCode: 'RATE_LIMIT' }),
      ]),
    },
    {
      label: '重试开跑',
      body: sessionsBody([phaseRow('s1', 'thinking', { reason: 'model:requested:retry', retrying: true })]),
    },
    { label: '恢复生成', body: sessionsBody([phaseRow('s1', 'thinking', { reason: 'model:generating' })]) },
    { label: '成功完成', body: sessionsBody([doneRow('s1', 's1#1', h.now)]) },
  ])
  for (const step of seq) {
    assert.notEqual(step.figure.phase, 'blocked', step.label + '：不该出现 blocked')
    assert.equal(step.figure.bang, false, step.label + '：感叹号图层不得可见')
  }
  assert.equal(seq[seq.length - 1].figure.phase, 'done', '最后按真实事实进入完成')
  h.api.stop()
})

test('致命停止：宿主确认 stopped-by-error → 感叹号；恢复后退出', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([phaseRow('s1', 'working', { reason: 'tool:bash' })]))
  await h.tick(550)
  assert.equal(figuresOf(slot).phase, 'working')

  // 宿主用 turn/end reason=error 终结这一轮，并把证据放进快照
  h.setState(sessionsBody([phaseRow('s1', 'blocked')]))
  await h.tick(550)
  // 进入 blocked 是 480ms 的收缩形变：要推进足够帧，稳态才没有头像
  await h.frame(45)
  const dead = figuresOf(slot)
  assert.equal(dead.phase, 'blocked', '任务确实因错误停止')
  assert.equal(dead.bang, true, '实际感叹号图层必须可见')
  assert.equal(dead.body, false)

  // 真正恢复：新一轮开始
  h.setState(sessionsBody([phaseRow('s1', 'thinking', { reason: 'model:requested', turnKey: 's1#2' })]))
  await h.tick(550)
  // 退出也要走完过渡帧，才看得到真实的稳态图层
  await h.frame(45)
  const alive = figuresOf(slot)
  assert.equal(alive.phase, 'thinking')
  assert.equal(alive.bang, false, '恢复后要退出 blocked')
  h.api.stop()
})

test('停止身份缺字段/空串：不冒充已确认错误停止（旧宿主与旧缓存）', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, section, 's1', false)
  // stopCertain 在，但轮次身份是空串 —— 不能算「同一轮」，依旧降级。
  h.setState(sessionsBody([{ id: 's1', phase: 'blocked', reason: 'stop:QUOTA', detail: 'QUOTA', stopCertain: true, stopTurnKey: '', turnKey: '' }]))
  await h.tick(550)
  const figure = figuresOf(slot)
  assert.notEqual(figure.phase, 'blocked', '空串身份不能当成同一轮')
  assert.equal(figure.bang, false)
  h.api.stop()
})

test('旧宿主只给 blocked 名字、没有停止证据：不冒充已确认错误停止', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, section, 's1', false)
  // 刻意不带 stopCertain / stopSource：这就是旧快照
  h.setState(sessionsBody([{ id: 's1', phase: 'blocked', reason: 'error:RATE_LIMIT', detail: 'RATE_LIMIT' }]))
  await h.tick(550)
  const figure = figuresOf(slot)
  assert.notEqual(figure.phase, 'blocked', '没有语义保证的旧 blocked 不能直接显示')
  assert.equal(figure.bang, false, '也不能留下感叹号图层')
  h.api.stop()
})
test('停止证据不完整（缺错误原因 / 暂定来源）：不冒充已确认错误停止', async () => {
  const rows = [
    { id: 's1', phase: 'blocked', reason: 'stop:QUOTA', detail: 'QUOTA', stopCertain: true, stopSource: 'turn/end:error', stopTurnKey: 's1#1', turnKey: 's1#1' },
    { id: 's1', phase: 'blocked', reason: 'stop:QUOTA', detail: 'QUOTA', stopCertain: true, stopCause: 'error', stopSource: 'agent/error', stopTurnKey: 's1#1', turnKey: 's1#1' },
  ]
  for (const row of rows) {
    const h = await boot()
    const section = makeSection(h.doc, 'proj-a')
    const { slot } = makeRow(h.doc, section, 's1', false)
    h.setState(sessionsBody([row]))
    await h.tick(550)
    const figure = figuresOf(slot)
    assert.notEqual(figure.phase, 'blocked', JSON.stringify(row))
    assert.equal(figure.bang, false)
    h.api.stop()
  }
})


test('已确认停止不会被残留的原生 done/ongoing 覆盖', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const { row, slot } = makeRow(h.doc, section, 's1', false)
  const dot = row.children[0].children[0]
  h.setState(sessionsBody([phaseRow('s1', 'blocked')]))
  await h.tick(550)
  await h.frame(8)
  assert.equal(figuresOf(slot).phase, 'blocked')
  // DOM 上残留的宿主状态点说 ongoing：不能把已确认的停止冲掉
  dot.setAttribute('data-state', 'ongoing')
  await h.tick(550)
  await h.frame(8)
  assert.equal(figuresOf(slot).phase, 'blocked')
  assert.equal(figuresOf(slot).bang, true)
  h.api.stop()
})

test('blocked 不推进完成代数、不触发 celebrate', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const { slot } = makeRow(h.doc, section, 's1', false)
  h.setState(sessionsBody([doneRow('s1', 's1#1', h.now)]))
  await h.tick(550)
  assert.equal(figuresOf(slot).phase, 'done')
  // 完成之后收到错误停止：不能把 done 变成新执行/新完成
  h.setState(sessionsBody([phaseRow('s1', 'blocked')]))
  await h.tick(550)
  assert.equal(figuresOf(slot).phase, 'blocked')
  // 再回到真实新完成：仍是新的一轮，能重新庆祝
  h.setState(sessionsBody([doneRow('s1', 's1#2', h.now)]))
  await h.tick(550)
  assert.equal(figuresOf(slot).phase, 'done')
  h.api.stop()
})


// ── 工作区标题栏：右键菜单三模式 ────────────────────────────────────────────
//
// 夹具照宿主侧栏标题栏抄：
//   div[class*="sectionHeader"]
//     > span[class*="sectionLabel"]（文本「工作区」）
//     > span[class*="searchSlot"]        ← 插件按钮插在它前面

/** 造「工作区」标题栏。 */
function makeHeader(doc) {
  const header = doc.createElement('div')
  header.className = 'JoiKIa_sectionHeader'
  const label = doc.createElement('span')
  label.className = 'JoiKIa_sectionLabel'
  label.textContent = '工作区'
  const search = doc.createElement('span')
  search.className = 'JoiKIa_searchSlot'
  header.appendChild(label)
  header.appendChild(search)
  doc.body.appendChild(header)
  return { header, label, search }
}

/** 起一个带标题栏的环境，并把按钮补出来。 */
async function bootChrome(opts) {
  const h = await boot(opts)
  makeHeader(h.doc)
  h.window.__dsgbChromeTest.tick()
  await h.settle()
  return h
}

function headerButtonOf(h) {
  return h.doc.querySelector('.dsgb-active-toggle')
}

function modeMenuOf(h) {
  return h.doc.querySelector('.dsgb-mode-menu')
}

function settingsPosts(h) {
  return h.fetchLog.filter((entry) => entry.method === 'POST' && entry.url.indexOf('/settings.json') !== -1)
}

test('标题栏按钮：默认「显示进行中的项目与会话」，右键出三模式菜单', async () => {
  const h = await bootChrome({ chrome: true })
  const button = headerButtonOf(h)
  assert.notEqual(button, null, '标题栏里要有波形按钮')
  assert.equal(button.getAttribute('aria-pressed'), 'false', '默认没有开启过滤')
  assert.match(button.getAttribute('aria-label'), /显示进行中的项目与会话/, '默认模式写进无障碍标签')
  assert.match(button.title, /右键选择模式/, '提示右键可以选模式')

  button.fire('contextmenu')
  const menu = modeMenuOf(h)
  assert.notEqual(menu, null, '右键要出菜单')
  assert.equal(menu.getAttribute('role'), 'menu')
  assert.match(menu.textContent, /工作区显示方式/)

  const options = menu.querySelectorAll('[data-dsgb-mode-option]')
  assert.equal(options.length, 3, '三个模式')
  assert.deepEqual(
    options.map((item) => item.getAttribute('data-dsgb-mode-option')),
    ['active', 'recent-with-projects', 'recent-sessions'],
  )
  assert.equal(options[0].getAttribute('aria-checked'), 'true', '默认选中第一个')
  assert.equal(options[1].getAttribute('aria-checked'), 'false')
  assert.equal(options[2].getAttribute('aria-checked'), 'false')
  assert.match(menu.textContent, /显示最近活跃的项目与会话/, '第二个模式文案')
  assert.match(menu.textContent, /显示最近活跃的会话/, '第三个模式文案')
  assert.doesNotMatch(menu.textContent, /N/, '文案里不留占位符')
  assert.equal(menu.querySelector('.dsgb-mode-limit input').value, '5', 'N 输入框默认 5')
  h.api.stop()
})

test('选「显示最近活跃的项目与会话」：立刻生效、写设置、菜单关闭', async () => {
  const h = await bootChrome({ chrome: true })
  const button = headerButtonOf(h)
  button.fire('contextmenu')
  const menu = modeMenuOf(h)
  menu.querySelector('[data-dsgb-mode-option="recent-with-projects"] input').fire('change')
  await h.settle()

  assert.equal(modeMenuOf(h), null, '选完就关菜单')
  assert.equal(h.window.__dsgbChromeTest.mode(), 'recent-with-projects')
  assert.match(button.getAttribute('aria-label'), /显示最近活跃的项目与会话/, '按钮文案跟着模式走')
  const posts = settingsPosts(h)
  assert.equal(posts.length, 1, '只写一次设置')
  assert.deepEqual(JSON.parse(posts[0].body), { workspaceDisplayMode: 'recent-with-projects' })
  h.api.stop()
})

test('改「最近 N 个」：夹到 1..50 并持久化', async () => {
  const h = await bootChrome({ chrome: true })
  const button = headerButtonOf(h)
  button.fire('contextmenu')
  const input = modeMenuOf(h).querySelector('.dsgb-mode-limit input')
  input.value = '8'
  input.fire('change')
  await h.settle()
  assert.equal(h.window.__dsgbChromeTest.limit(), 8)
  assert.equal(input.value, '8', '输入框回填夹过的值')
  let posts = settingsPosts(h)
  assert.equal(posts.length, 1)
  assert.deepEqual(JSON.parse(posts[0].body), { workspaceRecentLimit: 8 })

  // 越界值夹回边界，且不重复写盘
  h.window.__dsgbChromeTest.setLimit(0)
  await h.settle()
  assert.equal(h.window.__dsgbChromeTest.limit(), 1)
  h.window.__dsgbChromeTest.setLimit(99)
  await h.settle()
  assert.equal(h.window.__dsgbChromeTest.limit(), 50)
  posts = settingsPosts(h)
  assert.equal(posts.length, 3, '两次越界各写一次（1 与 50）')
  assert.deepEqual(JSON.parse(posts[1].body), { workspaceRecentLimit: 1 })
  assert.deepEqual(JSON.parse(posts[2].body), { workspaceRecentLimit: 50 })
  h.api.stop()
})

test('左键按所选模式生效：recent 模式只留最近 N 个会话与它们的项目', async () => {
  const h = await bootChrome({ chrome: true })
  const a = makeFolderSection(h.doc, 'proj-a')
  const rowA1 = makeRow(h.doc, a.section, 's1', false)
  const rowA2 = makeRow(h.doc, a.section, 's2', false)
  const b = makeFolderSection(h.doc, 'proj-b')
  const rowB1 = makeRow(h.doc, b.section, 's3', false)
  h.setWorkspaces({
    ok: true,
    available: true,
    workspaces: ['proj-a', 'proj-b'],
    members: [
      { workspaceId: 'proj-a', sessionIds: ['s1', 's2'], known: true },
      { workspaceId: 'proj-b', sessionIds: ['s3'], known: true },
    ],
    membersReady: true,
  })
  h.setRecent({ ok: true, available: true, sessions: [{ id: 's1' }, { id: 's3' }] })
  await h.tick(600)

  h.window.__dsgbChromeTest.setMode('recent-with-projects')
  await h.settle()
  headerButtonOf(h).fire('click')
  await h.settle()

  assert.equal(h.doc.documentElement.getAttribute('data-dsgb-mode'), 'recent-with-projects')
  assert.equal(rowA1.row.getAttribute('data-dsgb-recent'), 'true', 's1 在最近列表里')
  assert.equal(rowA2.row.getAttribute('data-dsgb-recent'), 'false', 's2 不在最近列表里')
  assert.equal(rowB1.row.getAttribute('data-dsgb-recent'), 'true', 's3 在最近列表里')
  assert.equal(a.section.getAttribute('data-dsgb-recent-empty'), null, 'proj-a 有最近会话，保留')
  assert.equal(b.section.getAttribute('data-dsgb-recent-empty'), null, 'proj-b 有最近会话，保留')
  h.api.stop()
})

test('recent 模式：没有最近会话的项目被标记为空，未分组归属未知时保持可见', async () => {
  const h = await bootChrome({ chrome: true })
  const a = makeFolderSection(h.doc, 'proj-a')
  makeRow(h.doc, a.section, 's1', false)
  const b = makeFolderSection(h.doc, 'proj-b')
  makeRow(h.doc, b.section, 's3', false)
  h.setWorkspaces({
    ok: true,
    available: true,
    workspaces: ['proj-a', 'proj-b'],
    members: [
      { workspaceId: 'proj-a', sessionIds: ['s1'], known: true },
      { workspaceId: 'proj-b', sessionIds: ['s3'], known: true },
    ],
    membersReady: true,
  })
  h.setRecent({ ok: true, available: true, sessions: [{ id: 's1' }] })
  await h.tick(600)

  h.window.__dsgbChromeTest.setMode('recent-with-projects')
  await h.settle()
  headerButtonOf(h).fire('click')
  await h.settle()

  assert.equal(a.section.getAttribute('data-dsgb-recent-empty'), null, 'proj-a 有最近会话')
  assert.equal(b.section.getAttribute('data-dsgb-recent-empty'), '1', 'proj-b 没有最近会话 → 隐藏')
  h.api.stop()
})

test('recent-with-projects：每个文件夹只留自己最近 1 条，未分组按最近 N 条显示', async () => {
  const h = await bootChrome({ chrome: true })
  const a = makeFolderSection(h.doc, 'proj-a')
  const a1 = makeRow(h.doc, a.section, 's1', false)
  const a2 = makeRow(h.doc, a.section, 's2', false)
  const b = makeFolderSection(h.doc, 'proj-b')
  const b1 = makeRow(h.doc, b.section, 's3', false)
  const b2 = makeRow(h.doc, b.section, 's4', false)
  const u = makeFolderSection(h.doc, '', { title: '未分组' })
  const u1 = makeRow(h.doc, u.section, 'u1', false)
  const u2 = makeRow(h.doc, u.section, 'u2', false)
  h.setState(sessionsBody(['s1', 's2', 's3', 's4', 'u1', 'u2'].map((id) => phaseRow(id, 'idle'))))
  h.setWorkspaces({
    ok: true,
    available: true,
    workspaces: ['proj-a', 'proj-b'],
    members: [
      { workspaceId: 'proj-a', sessionIds: ['s1', 's2'], known: true },
      { workspaceId: 'proj-b', sessionIds: ['s3', 's4'], known: true },
    ],
    membersReady: true,
  })
  // 全局最近 4 条里，proj-a 只命中 s2、proj-b 只命中 s4；u1/u2 是未分组。
  h.setRecent({
    ok: true,
    available: true,
    sessions: [{ id: 's2' }, { id: 's4' }, { id: 'u1' }, { id: 'u2' }],
    latest: { 'proj-a': 's2', 'proj-b': 's4' },
    ungrouped: ['u1', 'u2'],
  })
  await h.tick(1600)
  await h.tick(1600)

  h.window.__dsgbChromeTest.setMode('recent-with-projects')
  await h.settle()
  headerButtonOf(h).fire('click')
  await h.settle()

  assert.equal(a2.row.getAttribute('data-dsgb-recent'), 'true', 'proj-a 留它自己最近的那条')
  assert.equal(a1.row.getAttribute('data-dsgb-recent'), 'false', 'proj-a 更早的会话不显示')
  assert.equal(b2.row.getAttribute('data-dsgb-recent'), 'true', 'proj-b 留它自己最近的那条')
  assert.equal(b1.row.getAttribute('data-dsgb-recent'), 'false', 'proj-b 更早的会话不显示')
  assert.equal(u1.row.getAttribute('data-dsgb-recent'), 'true', '未分组会话照常显示')
  assert.equal(u2.row.getAttribute('data-dsgb-recent'), 'true', '未分组会话照常显示')
  assert.equal(a.section.getAttribute('data-dsgb-recent-empty'), null, 'proj-a 保留')
  assert.equal(b.section.getAttribute('data-dsgb-recent-empty'), null, 'proj-b 保留')
  assert.equal(u.section.getAttribute('data-dsgb-recent-empty'), null, '未分组分区保留')
  h.api.stop()
})

test('recent-with-projects：只留最近 N 个项目，超出 N 的项目整组隐藏', async () => {
  const h = await bootChrome({ chrome: true })
  const a = makeFolderSection(h.doc, 'proj-a')
  const a1 = makeRow(h.doc, a.section, 's1', false)
  const a2 = makeRow(h.doc, a.section, 's2', false)
  const b = makeFolderSection(h.doc, 'proj-b')
  const b1 = makeRow(h.doc, b.section, 's3', false)
  const c = makeFolderSection(h.doc, 'proj-c')
  const c1 = makeRow(h.doc, c.section, 's4', false)
  h.setState(sessionsBody(['s1', 's2', 's3', 's4'].map((id) => phaseRow(id, 'idle'))))
  h.setWorkspaces({
    ok: true,
    available: true,
    workspaces: ['proj-a', 'proj-b', 'proj-c'],
    members: [
      { workspaceId: 'proj-a', sessionIds: ['s1', 's2'], known: true },
      { workspaceId: 'proj-b', sessionIds: ['s3'], known: true },
      { workspaceId: 'proj-c', sessionIds: ['s4'], known: true },
    ],
    membersReady: true,
  })
  // latest 的 key 顺序 = 项目最近活跃时间降序：proj-a → proj-b → proj-c。
  // N = 2，所以只有前两个项目该留下，proj-c 整组隐藏。
  h.setRecent({
    ok: true,
    available: true,
    sessions: [{ id: 's2' }, { id: 's3' }, { id: 's4' }],
    latest: { 'proj-a': 's2', 'proj-b': 's3', 'proj-c': 's4' },
    ungrouped: [],
  })
  await h.tick(1600)
  await h.tick(1600)
  h.window.__dsgbChromeTest.setLimit(2)

  h.window.__dsgbChromeTest.setMode('recent-with-projects')
  await h.settle()
  headerButtonOf(h).fire('click')
  await h.settle()

  assert.equal(a2.row.getAttribute('data-dsgb-recent'), 'true', '前 N 个项目的最近会话保留')
  assert.equal(a1.row.getAttribute('data-dsgb-recent'), 'false', '同项目更早的会话不显示')
  assert.equal(b1.row.getAttribute('data-dsgb-recent'), 'true', '第二个项目保留')
  assert.equal(c1.row.getAttribute('data-dsgb-recent'), 'false', '第 N+1 个项目的会话不显示')
  assert.equal(a.section.getAttribute('data-dsgb-recent-empty'), null, 'proj-a 保留')
  assert.equal(b.section.getAttribute('data-dsgb-recent-empty'), null, 'proj-b 保留')
  assert.equal(c.section.getAttribute('data-dsgb-recent-empty'), '1', 'proj-c 超出 N → 整组隐藏')
  h.api.stop()
})

test('recent-with-projects：改「最近 N 个」后立即按新 N 重算项目数', async () => {
  const h = await bootChrome({ chrome: true })
  const a = makeFolderSection(h.doc, 'proj-a')
  const a1 = makeRow(h.doc, a.section, 's1', false)
  const b = makeFolderSection(h.doc, 'proj-b')
  const b1 = makeRow(h.doc, b.section, 's3', false)
  h.setState(sessionsBody(['s1', 's3'].map((id) => phaseRow(id, 'idle'))))
  h.setWorkspaces({
    ok: true,
    available: true,
    workspaces: ['proj-a', 'proj-b'],
    members: [
      { workspaceId: 'proj-a', sessionIds: ['s1'], known: true },
      { workspaceId: 'proj-b', sessionIds: ['s3'], known: true },
    ],
    membersReady: true,
  })
  h.setRecent({
    ok: true,
    available: true,
    sessions: [{ id: 's1' }, { id: 's3' }],
    latest: { 'proj-a': 's1', 'proj-b': 's3' },
    ungrouped: [],
  })
  await h.tick(1600)
  h.window.__dsgbChromeTest.setMode('recent-with-projects')
  await h.settle()
  headerButtonOf(h).fire('click')
  await h.settle()
  assert.equal(b.section.getAttribute('data-dsgb-recent-empty'), null, 'N=5 时两个项目都在')

  h.window.__dsgbChromeTest.setLimit(1)
  await h.settle()
  assert.equal(a1.row.getAttribute('data-dsgb-recent'), 'true', 'N=1 → 最近的这个项目保留')
  assert.equal(b1.row.getAttribute('data-dsgb-recent'), 'false', 'N=1 → 第二个项目不显示')
  assert.equal(b.section.getAttribute('data-dsgb-recent-empty'), '1', 'N=1 → 第二个项目整组隐藏')
  h.api.stop()
})

test('recent-with-projects：未分组会话同样只留最近 N 条', async () => {
  const h = await bootChrome({ chrome: true })
  const u = makeFolderSection(h.doc, '', { title: '未分组' })
  const u1 = makeRow(h.doc, u.section, 'u1', false)
  const u2 = makeRow(h.doc, u.section, 'u2', false)
  const u3 = makeRow(h.doc, u.section, 'u3', false)
  h.setState(sessionsBody(['u1', 'u2', 'u3'].map((id) => phaseRow(id, 'idle'))))
  h.setWorkspaces({
    ok: true,
    available: true,
    workspaces: [],
    members: [],
    membersReady: true,
  })
  h.setRecent({
    ok: true,
    available: true,
    sessions: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }],
    latest: {},
    ungrouped: ['u1', 'u2', 'u3'],
  })
  await h.tick(1600)
  h.window.__dsgbChromeTest.setMode('recent-with-projects')
  await h.settle()
  h.window.__dsgbChromeTest.setLimit(2)
  await h.settle()
  headerButtonOf(h).fire('click')
  await h.settle()

  assert.equal(u1.row.getAttribute('data-dsgb-recent'), 'true', '前 N 条未分组会话保留')
  assert.equal(u2.row.getAttribute('data-dsgb-recent'), 'true')
  assert.equal(u3.row.getAttribute('data-dsgb-recent'), 'false', '第 N+1 条未分组会话不显示')
  h.api.stop()
})

test('recent 模式：未分组会话被宿主折叠时自动点开「展开其余 N 个会话」', async () => {
  const h = await bootChrome({ chrome: true })
  const u = makeFolderSection(h.doc, '', { title: '未分组' })
  const u1 = makeRow(h.doc, u.section, 'u1', false)
  // 宿主按 watermark 把超出部分折进这个按钮；点一次切换展开状态。
  const overflow = h.doc.createElement('button')
  overflow.setAttribute('data-row-key', 'overflow:')
  overflow.setAttribute('aria-expanded', 'false')
  overflow.addEventListener('click', () => {
    overflow.setAttribute('aria-expanded', overflow.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')
  })
  u.section.appendChild(overflow)
  h.setState(sessionsBody([phaseRow('u1', 'idle')]))
  h.setWorkspaces({
    ok: true,
    available: true,
    workspaces: [],
    members: [],
    membersReady: true,
  })
  h.setRecent({ ok: true, available: true, sessions: [{ id: 'u1' }], latest: {}, ungrouped: ['u1'] })
  await h.tick(1600)

  h.window.__dsgbChromeTest.setMode('recent-with-projects')
  await h.settle()
  headerButtonOf(h).fire('click')
  await h.settle()

  assert.equal(overflow.getAttribute('aria-expanded'), 'true', '未分组有命中会话 → 自动点开折叠按钮')
  assert.equal(u1.row.getAttribute('data-dsgb-recent'), 'true', '未分组会话可见')

  // 关掉过滤：替用户点开的按钮要折回。
  headerButtonOf(h).fire('click')
  await h.settle()
  assert.equal(overflow.getAttribute('aria-expanded'), 'false', '关闭筛选后折回')
  h.api.stop()
})

test('recent 模式：数据源拿不到时退回「只显示进行中」，不把侧栏清空', async () => {
  const h = await bootChrome({ chrome: true })
  const a = makeFolderSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, a.section, 's1', false)
  h.setWorkspaces({
    ok: true,
    available: true,
    workspaces: ['proj-a'],
    members: [{ workspaceId: 'proj-a', sessionIds: ['s1'], known: true }],
    membersReady: true,
  })
  // 服务端明确说拿不到最近列表
  h.setRecent({ ok: true, available: false, sessions: [] })
  await h.tick(600)

  h.window.__dsgbChromeTest.setMode('recent-with-projects')
  await h.settle()
  headerButtonOf(h).fire('click')
  await h.settle()

  assert.equal(h.window.__dsgbChromeTest.mode(), 'recent-with-projects', '选择本身保留')
  assert.equal(h.window.__dsgbChromeTest.effectiveMode(), 'active', '实际生效退回 active')
  assert.equal(h.doc.documentElement.getAttribute('data-dsgb-mode'), 'active', 'CSS 分派也按 active')
  assert.equal(made.row.getAttribute('data-dsgb-active'), 'false', '按活跃语义标记，而不是按最近')
  assert.equal(made.row.getAttribute('data-dsgb-recent'), null, '不写 recent 标记')
  h.api.stop()
})

test('recent-sessions 模式：项目行整行隐藏（CSS 规则），会话仍按最近标记', async () => {
  const h = await bootChrome({ chrome: true })
  const a = makeFolderSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, a.section, 's1', false)
  h.setWorkspaces({
    ok: true,
    available: true,
    workspaces: ['proj-a'],
    members: [{ workspaceId: 'proj-a', sessionIds: ['s1'], known: true }],
    membersReady: true,
  })
  h.setRecent({ ok: true, available: true, sessions: [{ id: 's1' }] })
  await h.tick(600)

  h.window.__dsgbChromeTest.setMode('recent-sessions')
  await h.settle()
  headerButtonOf(h).fire('click')
  await h.settle()

  assert.equal(h.doc.documentElement.getAttribute('data-dsgb-mode'), 'recent-sessions')
  assert.equal(made.row.getAttribute('data-dsgb-recent'), 'true')
  const style = h.doc.querySelector('[data-dsgb-workspace-chrome="style"]')
  // 只藏真正的项目文件夹行：未分组分组的 key 就是 "workspace:"（空 id），
  // 它的子会话也要在 recent-sessions 里显示，不能连父容器一起藏掉。
  const workspaceRule = style.textContent.split('\n').find((line) =>
    line.indexOf('html[data-dsgb-mode="recent-sessions"] [data-row-key^="workspace:"]') === 0,
  )
  assert.ok(workspaceRule, 'recent-sessions 下有项目行隐藏规则')
  assert.ok(
    workspaceRule.indexOf(':not([data-row-key="workspace:"])') !== -1,
    '项目行在 recent-sessions 下整行隐藏，但未分组分组本身保留',
  )
  h.api.stop()
})

test('active 模式：不显示「展开其余 N 个会话」行与「未分组」标题行', async () => {
  const h = await bootChrome({ chrome: true })
  const u = makeFolderSection(h.doc, '', { title: '未分组' })
  const u1 = makeRow(h.doc, u.section, 'u1', false)
  const a = makeFolderSection(h.doc, 'proj-a')
  const a1 = makeRow(h.doc, a.section, 's1', false)
  const b = makeFolderSection(h.doc, 'proj-b')
  const b1 = makeRow(h.doc, b.section, 's2', false)
  // 宿主按 watermark 折叠会话时渲染的按钮：点一次切换 aria-expanded。
  const overflows = new Map()
  for (const key of ['', 'proj-a', 'proj-b']) {
    const button = h.doc.createElement('button')
    button.setAttribute('data-row-key', 'overflow:' + key)
    button.setAttribute('aria-expanded', 'false')
    button.addEventListener('click', () => {
      button.setAttribute('aria-expanded', button.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')
    })
    const section = key === '' ? u.section : key === 'proj-a' ? a.section : b.section
    section.appendChild(button)
    overflows.set(key, button)
  }
  h.setState(sessionsBody([phaseRow('u1', 'working'), phaseRow('s1', 'idle'), phaseRow('s2', 'idle')]))
  h.setWorkspaces({
    ok: true,
    available: true,
    workspaces: ['proj-a', 'proj-b'],
    members: [
      { workspaceId: 'proj-a', sessionIds: ['s1'], known: true },
      { workspaceId: 'proj-b', sessionIds: ['s2'], known: true },
    ],
    membersReady: true,
  })
  h.setRecent({ ok: true, available: true, sessions: [], latest: {}, ungrouped: [] })
  await h.tick(1600)
  headerButtonOf(h).fire('click')
  await h.settle()

  const style = h.doc.querySelector('[data-dsgb-workspace-chrome="style"]')
  const lines = style.textContent.split('\n')
  const overflowRule = lines.find((line) => line.indexOf('html[data-dsgb-mode="active"] [data-row-key^="overflow:"]') === 0)
  assert.ok(overflowRule, 'active 模式下要有「展开其余 N 个会话」的隐藏规则')
  const ungroupedRule = lines.find((line) => line.indexOf('html[data-dsgb-mode="active"] [data-row-key="workspace:"]') === 0)
  assert.ok(ungroupedRule, 'active 模式下要有「未分组」标题行的隐藏规则')
  // 只藏标题行：规则不能落到 groupSection 上，否则未分组的会话会一起消失。
  assert.equal(ungroupedRule.indexOf('groupSection'), -1, '未分组只藏标题行，不藏整组')

  // 藏行 ≠ 不展开：未分组里有进行中会话，仍要先点开宿主折叠，否则会话不渲染。
  assert.equal(overflows.get('').getAttribute('aria-expanded'), 'true', '未分组有进行中会话 → 仍自动展开')
  assert.equal(overflows.get('proj-a').getAttribute('aria-expanded'), 'false', '只有空闲会话的项目不展开')
  assert.equal(overflows.get('proj-b').getAttribute('aria-expanded'), 'false')

  // 未分组整组仍在（标题行由 CSS 藏，容器保留）；无进行中会话的项目整组隐藏。
  assert.equal(u.section.getAttribute('data-dsgb-active-empty'), null, '未分组容器保留')
  assert.equal(a.section.getAttribute('data-dsgb-active-empty'), '1', '只有空闲会话的项目整组隐藏')
  assert.equal(u1.row.getAttribute('data-dsgb-active'), 'true')
  assert.equal(a1.row.getAttribute('data-dsgb-active'), 'false')
  assert.equal(b1.row.getAttribute('data-dsgb-active'), 'false')
  h.api.stop()
})

test('夜间模式：菜单底色用宿主真实存在的 token，并给深色主题单独兜底', async () => {
  const h = await bootChrome({ chrome: true })
  const style = h.doc.querySelector('[data-dsgb-workspace-chrome="style"]')
  const css = style.textContent
  assert.doesNotMatch(css, /--dsw-alias-bg-elevated/, '宿主没有这个 token，兜底值会让深色下变白底')
  assert.match(css, /\.dsgb-mode-menu\{[^}]*background:var\(--dsw-alias-bg-layer-2,#fff\)/, '浅色用 bg-layer-2')
  // 兜底值必须等于宿主深色 token 的真实取值：bg-layer-2 = bluish-850 = #2c2c2e，
  // label-primary = bluish-50 = #f9fafb。写错色号在 token 缺失时会露出浅色底。
  assert.match(
    css,
    /body\[data-ds-dark-theme\] \.dsgb-mode-menu\{[^}]*background:var\(--dsw-alias-bg-layer-2,#2c2c2e\)/,
    '深色主题下即使 token 缺失也要是深底',
  )
  assert.match(
    css,
    /body\[data-ds-dark-theme\] \.dsgb-mode-menu\{[^}]*color:var\(--dsw-alias-label-primary,#f9fafb\)/,
    '深色文字兜底与宿主 label-primary 一致',
  )
  assert.match(css, /body\[data-ds-dark-theme\] \.dsgb-mode-menu\{[^}]*color-scheme:dark/, '原生控件跟着切深色')
  h.api.stop()
})

const SETTINGS_POLL_MS_FOR_TEST = 5200

test('设置轮询：外部改了 settings.json（另一个窗口/手改），页面自己跟上而不必重载', async () => {
  const h = await bootChrome({
    chrome: true,
    settings: { workspaceDisplayMode: 'active', workspaceRecentLimit: 5 },
  })
  const button = headerButtonOf(h)
  assert.match(button.getAttribute('aria-label'), /显示进行中的项目与会话/, '启动时按旧设置')
  assert.equal(h.doc.documentElement.getAttribute('data-dsgb-mode'), null, '过滤没开时不写模式属性')

  // 另一个窗口（或直接改文件）把模式改成 recent-sessions。
  h.setSettings({ workspaceDisplayMode: 'recent-sessions', workspaceRecentLimit: 3 })
  // 推进过轮询间隔，再跑一次 tick；fetch 是异步的，settle 收尾。
  await h.tick(SETTINGS_POLL_MS_FOR_TEST)
  h.window.__dsgbChromeTest.tick()
  await h.settle()
  assert.equal(h.window.__dsgbChromeTest.mode(), 'recent-sessions', '轮询读回新模式')
  assert.equal(h.window.__dsgbChromeTest.limit(), 3, 'N 也跟着变')
  assert.match(button.getAttribute('aria-label'), /显示最近活跃的会话/, '按钮文案要跟着变')
  h.api.stop()
})

test('持久化：设置里已有模式与 N 时，启动即按它显示', async () => {
  const h = await bootChrome({
    chrome: true,
    settings: { workspaceDisplayMode: 'recent-sessions', workspaceRecentLimit: 3 },
  })
  assert.equal(h.window.__dsgbChromeTest.mode(), 'recent-sessions')
  assert.equal(h.window.__dsgbChromeTest.limit(), 3)
  const button = headerButtonOf(h)
  assert.match(button.getAttribute('aria-label'), /显示最近活跃的会话/)

  button.fire('contextmenu')
  const menu = modeMenuOf(h)
  const options = menu.querySelectorAll('[data-dsgb-mode-option]')
  assert.equal(options[2].getAttribute('aria-checked'), 'true', '菜单里选中第三项')
  assert.equal(options[0].getAttribute('aria-checked'), 'false')
  assert.equal(menu.querySelector('.dsgb-mode-limit input').value, '3')
  h.api.stop()
})

test('设置里是非法值时退回默认：模式退回 active，N 非数字退回 5、越界夹到边界', async () => {
  const bad = await bootChrome({
    chrome: true,
    settings: { workspaceDisplayMode: 'everything', workspaceRecentLimit: 'many' },
  })
  assert.equal(bad.window.__dsgbChromeTest.mode(), 'active')
  assert.equal(bad.window.__dsgbChromeTest.limit(), 5)
  bad.api.stop()

  const zero = await bootChrome({
    chrome: true,
    settings: { workspaceDisplayMode: 'recent-sessions', workspaceRecentLimit: 0 },
  })
  assert.equal(zero.window.__dsgbChromeTest.mode(), 'recent-sessions', '合法模式要保留')
  assert.equal(zero.window.__dsgbChromeTest.limit(), 1, '0 是数字，夹到下限 1')
  zero.api.stop()
})

test('保存失败：模式回滚到上一个，并给出可观察提示', async () => {
  const h = await bootChrome({ chrome: true })
  const button = headerButtonOf(h)
  h.failFetch(true)
  h.window.__dsgbChromeTest.setMode('recent-with-projects')
  await h.settle()
  assert.equal(h.window.__dsgbChromeTest.mode(), 'active', '写盘失败要回滚')
  assert.match(button.getAttribute('aria-label'), /显示进行中的项目与会话/)
  assert.notEqual(h.doc.querySelector('.dsgb-auto-error'), null, '要有可观察的错误提示')
  h.api.stop()
})

test('菜单：点外面 / Esc 关闭，点菜单内部不关', async () => {
  const h = await bootChrome({ chrome: true })
  const button = headerButtonOf(h)

  button.fire('contextmenu')
  assert.notEqual(modeMenuOf(h), null)
  h.doc.fire('click', { target: modeMenuOf(h).querySelector('.dsgb-mode-title') })
  assert.notEqual(modeMenuOf(h), null, '点菜单内部不关')

  h.doc.fire('click', { target: h.doc.body })
  assert.equal(modeMenuOf(h), null, '点外面关掉')

  button.fire('contextmenu')
  assert.notEqual(modeMenuOf(h), null)
  h.doc.fire('keydown', { key: 'Escape', target: h.doc.body, preventDefault() {}, stopPropagation() {} })
  assert.equal(modeMenuOf(h), null, 'Esc 关掉')
  h.api.stop()
})

test('再点一次按钮关闭过滤：摘掉模式属性与所有标记，菜单也收起', async () => {
  const h = await bootChrome({ chrome: true })
  const a = makeFolderSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, a.section, 's1', false)
  h.setWorkspaces({
    ok: true,
    available: true,
    workspaces: ['proj-a'],
    members: [{ workspaceId: 'proj-a', sessionIds: ['s1'], known: true }],
    membersReady: true,
  })
  h.setRecent({ ok: true, available: true, sessions: [{ id: 's1' }] })
  await h.tick(600)

  h.window.__dsgbChromeTest.setMode('recent-with-projects')
  await h.settle()
  const button = headerButtonOf(h)
  button.fire('click')
  await h.settle()
  assert.equal(button.getAttribute('aria-pressed'), 'true')
  assert.equal(h.doc.documentElement.getAttribute('data-dsgb-mode'), 'recent-with-projects')

  button.fire('contextmenu')
  assert.notEqual(modeMenuOf(h), null)
  button.fire('click')
  await h.settle()
  assert.equal(button.getAttribute('aria-pressed'), 'false')
  assert.equal(h.doc.documentElement.getAttribute('data-dsgb-mode'), null, '关闭后不留模式属性')
  assert.equal(made.row.getAttribute('data-dsgb-recent'), null, '关闭后不留 recent 标记')
  assert.equal(a.section.getAttribute('data-dsgb-recent-empty'), null)
  assert.equal(modeMenuOf(h), null, '左键同时收起菜单')
  h.api.stop()
})

test('卸载：摘掉模式属性、菜单与按钮，不留插件痕迹', async () => {
  const h = await bootChrome({ chrome: true })
  const button = headerButtonOf(h)
  button.fire('contextmenu')
  assert.notEqual(modeMenuOf(h), null)
  h.window.__dsgbChromeTest.stop()
  await h.settle()
  assert.equal(modeMenuOf(h), null, '菜单要收掉')
  assert.equal(headerButtonOf(h), null, '按钮要摘掉')
  assert.equal(h.doc.documentElement.getAttribute('data-dsgb-mode'), null)
  assert.equal(h.doc.querySelector('[data-dsgb-workspace-chrome="style"]'), null, '样式也要撤掉')
})

