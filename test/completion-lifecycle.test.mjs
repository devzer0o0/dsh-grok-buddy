/**
 * 完成生命周期与查看/消费语义（缺陷 A / C / D 的回归测试）。
 *
 * 已复现的三类失败：
 *   A  选中即消费 → 第二次同步就从 done 掉成 idle
 *   C  失活只改颜色 → phase 仍是 done、仍在 celebrate
 *   D  兜底完成身份不完整 → known idle + DOM done 无法消费；未知会话所有完成共用 dsh:<id>
 *
 * 这里跑的是**构建产物**，不是复制一份实现。
 *
 * @module test/completion-lifecycle.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { Doc, jsonResponse } from './dom-harness.mjs'

/** idle 的动作 id（内部动画资源名）。 */
const IDLE_MOTION = 'rest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'lib', 'widget.js'), 'utf8')

/** 起一个只跑 widget bundle 的最小环境。 */
async function boot(options) {
  const opts = options === undefined ? {} : options
  const doc = new Doc()
  const frames = []
  const timers = new Map()
  let timerSeq = 0
  let now = 1_700_000_000_000 // 真实量级的 epoch 毫秒
  const observers = []
  let stateBody = { ok: true, sessions: [] }

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
    // performance 与 Date.now 共用同一个可控时钟，避免两个时间基准混减
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
      timers.set(id, { at: now + (ms === undefined ? 0 : ms), fn, repeat: null })
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
      constructor(callback) {
        this.callback = callback
        observers.push(this)
      }
      observe() {}
      disconnect() {
        const i = observers.indexOf(this)
        if (i !== -1) observers.splice(i, 1)
      }
    },
    getComputedStyle: () => ({
      backgroundColor: 'rgb(20, 22, 26)',
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      colorScheme: 'dark',
    }),
    matchMedia: (q) => ({ matches: opts.reduced === true && q.indexOf('reduced-motion') !== -1 }),
    fetch: (url) => {
      if (String(url).indexOf('/colors.json') !== -1) {
        return Promise.resolve(jsonResponse({ ok: true, projects: {} }))
      }
      if (String(url).indexOf('probe') !== -1) {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) })
      }
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
    get now() {
      return now
    },
    get api() {
      return window.__dshGrokBuddy
    },
    setState(body) {
      stateBody = body
    },
    /** 推进时间并跑掉到期定时器（setInterval 会重新排期）。 */
    async advance(ms) {
      const target = now + ms
      // 逐段推进，保证 setInterval 的重复触发被正确模拟
      while (now < target) {
        let next = target
        for (const entry of timers.values()) {
          if (entry.at < next) next = entry.at
        }
        now = next
        for (const [id, entry] of [...timers]) {
          if (entry.at <= now) {
            if (entry.repeat === null || entry.repeat === undefined) {
              timers.delete(id)
            } else {
              entry.at = now + entry.repeat
            }
            entry.fn()
          }
        }
        await flush()
      }
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

function makeRow(doc, section, sessionId, selected, dshState) {
  const row = doc.createElement('div')
  row.setAttribute('data-row-key', 'session:' + sessionId)
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-selected', selected === true ? 'true' : 'false')
  const slot = doc.createElement('span')
  slot.className = 'JoiKIa_slot'
  const dot = doc.createElement('span')
  dot.setAttribute('data-state', dshState === undefined ? 'idle' : dshState)
  slot.appendChild(dot)
  row.appendChild(slot)
  const title = doc.createElement('span')
  title.className = 'JoiKIa_title'
  title.textContent = 'session'
  row.appendChild(title)
  const wrap = doc.createElement('span')
  wrap.className = 'hc-root'
  wrap.appendChild(row)
  const group = doc.createElement('div')
  group.setAttribute('role', 'group')
  group.appendChild(wrap)
  section.appendChild(group)
  return { row, slot, dot }
}

/** 取眼睛图层（按图层标记找，不依赖子节点序号）。 */
function eyeLayer(bot) {
  const group = bot.querySelector('[data-dsgb-layer="eyes"]')
  return group === null ? null : group.children[0]
}

function botOf(slot) {
  return slot.children.find((c) => String(c.getAttribute('class') || '').indexOf('dsgb-bot') !== -1)
}

function phaseOf(slot) {
  const bot = botOf(slot)
  return bot === undefined ? null : bot.getAttribute('data-dsgb-phase')
}

function motionOf(slot) {
  const bot = botOf(slot)
  return bot === undefined ? null : bot.getAttribute('data-dsgb-motion')
}

function toneOf(slot) {
  const bot = botOf(slot)
  return bot === undefined ? null : bot.getAttribute('data-dsgb-tone')
}

const DONE_ROW = (id, key, completedAt) => ({
  id,
  phase: 'done',
  reason: 'terminal-completed',
  detail: '',
  completionKey: key,
  completedAt,
})

test('A1 done 持续选中时，多次同步始终是 done/celebrate', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', true)
  const completedAt = h.now
  h.setState({ ok: true, sessions: [DONE_ROW('s1', 's1#1', completedAt)] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done', '第一次同步是 done')
  assert.equal(motionOf(made.slot), 'orbit')

  // 保持选中，连续多轮同步
  for (let i = 0; i < 6; i++) {
    await h.advance(600)
    assert.equal(phaseOf(made.slot), 'done', '第 ' + (i + 2) + ' 次同步仍是 done')
    assert.equal(motionOf(made.slot), 'orbit')
  }
})

test('A2 查看后切走才消费：切走后为 idle 且灰色', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', true)
  h.setState({ ok: true, sessions: [DONE_ROW('s1', 's1#1', h.now)] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done')

  made.row.setAttribute('aria-selected', 'false')
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'idle', '切走后退出完成展示')
  assert.equal(motionOf(made.slot), IDLE_MOTION, '不再是 celebrate')
  assert.equal(toneOf(made.slot), 'dormant', '未选中 → 灰色')
})

test('A3 已消费的完成不能因宿主继续返回 done 而复活', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', true)
  const completedAt = h.now
  h.setState({ ok: true, sessions: [DONE_ROW('s1', 's1#1', completedAt)] })
  await h.advance(600)
  made.row.setAttribute('aria-selected', 'false')
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'idle')

  for (let i = 0; i < 5; i++) {
    h.setState({ ok: true, sessions: [DONE_ROW('s1', 's1#1', completedAt)] })
    await h.advance(600)
    assert.equal(phaseOf(made.slot), 'idle', '已消费的完成不得复活')
  }
})

test('A4 再次选中已消费完成：显示项目色但不重新庆祝', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', true)
  const completedAt = h.now
  h.setState({ ok: true, sessions: [DONE_ROW('s1', 's1#1', completedAt)] })
  await h.advance(600)
  made.row.setAttribute('aria-selected', 'false')
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'idle')

  made.row.setAttribute('aria-selected', 'true')
  h.setState({ ok: true, sessions: [DONE_ROW('s1', 's1#1', completedAt)] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'idle', '已消费完成再次选中不得重新庆祝')
  assert.equal(toneOf(made.slot), 'active', '但选中允许项目色')
})

test('C1 未选中 done 超过失活阈值 → idle（不只是变灰）', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false)
  const completedAt = h.now
  h.setState({ ok: true, sessions: [DONE_ROW('s1', 's1#1', completedAt)] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done')

  // 越过 5 分钟完成展示阈值（宿主侧已判 completion-expired → idle）
  h.setState({
    ok: true,
    sessions: [{ id: 's1', phase: 'idle', reason: 'completion-expired', detail: '', completionKey: '', completedAt: undefined }],
  })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'idle', '失活后相位必须是 idle')
  assert.equal(motionOf(made.slot), IDLE_MOTION, '失活后不能继续 celebrate')
})

test('C2 宿主已失活但 DOM 仍画 done：不能灰色庆祝', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false, 'done')
  // 宿主记录存在且明确 idle（已失活），原生 DOM 仍是 done
  h.setState({
    ok: true,
    sessions: [{ id: 's1', phase: 'idle', reason: 'completion-expired', detail: '', completionKey: '' }],
  })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'idle', 'DOM done 不得覆盖���失活结论')
  assert.equal(motionOf(made.slot), IDLE_MOTION)
})

test('C3 未知会话的 DOM done 超时后必须退出 done', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false, 'done')
  h.setState({ ok: true, sessions: [] }) // 插件完全不知道这个会话
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done', '刚看到 DOM done 时进入完成展示')

  // 越过完成展示阈值
  await h.advance(5 * 60 * 1000 + 2000)
  assert.equal(phaseOf(made.slot), 'idle', '未知会话的兜底完成也必须失活')
  assert.equal(motionOf(made.slot), IDLE_MOTION, '不能继续庆祝')
})

test('D1 known idle 会话 + DOM done（无完成键）也能进入并退出完成周期', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', true, 'done')
  // 插件知道这个会话，但它是 idle、没有 completionKey
  h.setState({
    ok: true,
    sessions: [{ id: 's1', phase: 'idle', reason: 'no-open-turn', detail: '', completionKey: '' }],
  })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done', 'known idle + DOM done 也应显示完成')

  made.row.setAttribute('aria-selected', 'false')
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'idle', '查看后切走必须能消费掉')
})

test('D2 unknown done → 消费 → ongoing → done：第二次完成重新庆祝', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false, 'done')
  h.setState({ ok: true, sessions: [] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done')
  assert.equal(motionOf(made.slot), 'orbit')

  // 选中查看后切走 → 消费
  made.row.setAttribute('aria-selected', 'true')
  await h.advance(600)
  made.row.setAttribute('aria-selected', 'false')
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'idle')

  // 进入新的一轮（ongoing），再完成
  made.dot.setAttribute('data-state', 'ongoing')
  h.setState({ ok: true, sessions: [{ id: 's1', phase: 'working', reason: 'tool:bash', completionKey: '' }] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'working')

  made.dot.setAttribute('data-state', 'done')
  h.setState({ ok: true, sessions: [] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done', '新一轮完成必须建立新周期')
  assert.equal(motionOf(made.slot), 'orbit', '新周期要重新庆祝')
})

test('D3 DOM 摘除后重新挂载不制造新完成周期', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', true, 'done')
  h.setState({ ok: true, sessions: [] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done')

  const bot = botOf(made.slot)
  bot.remove()
  await h.frame(2)
  made.slot.insertBefore(bot, made.slot.firstChild)
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done')
  // 切走 → 消费；再次摘挂不能复活
  made.row.setAttribute('aria-selected', 'false')
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'idle')
  bot.remove()
  made.slot.insertBefore(bot, made.slot.firstChild)
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'idle', '重挂载不得复活已消费的完成')
})

test('完成周期的关键时间点：2.6s / 3s / 6s / 30s 都保持 celebrate', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', true)
  h.setState({ ok: true, sessions: [DONE_ROW('s1', 's1#9', h.now)] })
  await h.advance(600)
  for (const wait of [2600, 400, 3000, 24000]) {
    await h.advance(wait)
    assert.equal(phaseOf(made.slot), 'done', wait + 'ms 后仍是 done')
    assert.equal(motionOf(made.slot), 'orbit', wait + 'ms 后仍在庆祝')
  }
})

test('同一完成周期只初始化一次：连续同步不重复初始化', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', true)
  h.setState({ ok: true, sessions: [DONE_ROW('s1', 's1#9', h.now)] })
  await h.advance(600)
  const bot = botOf(made.slot)
  await h.frame(3)
  const eye = eyeLayer(bot)
  const before = eye.getAttribute('points')
  // 多轮同步 + 多帧，动画应继续演进而不是回到初值
  for (let i = 0; i < 6; i++) {
    await h.advance(500)
    await h.frame(1)
  }
  const after = eye.getAttribute('points')
  assert.notEqual(before, after, '动画应继续演进（未被重启）')
  assert.equal(motionOf(made.slot), 'orbit')
})

// ── 完成身份衔接：兜底身份 ↔ 宿主 completionKey 不能算两次完成 ────────────────

test('E1 兜底身份 → 宿主 completionKey：同一次完成不重播入场', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 'unknown-1', false, 'done')
  // 第一份快照里根本没有这个会话：只有 DOM 的 done → 兜底身份
  h.setState({ ok: true, sessions: [] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done', '未知会话的 DOM done 也要庆祝')
  assert.equal(motionOf(made.slot), 'orbit')
  const before = h.api.completions()
  const keyBefore = before.length === 0 ? null : before[0].completionKey
  assert.ok(keyBefore !== null && keyBefore.indexOf('native:') === 0, '第一次用兜底身份：' + keyBefore)

  // 第二份快照宿主补上了 completionKey：同一次完成，不能重播
  h.setState({ ok: true, sessions: [DONE_ROW('unknown-1', 'unknown-1#3', h.now)] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done')
  const after = h.api.completions()
  assert.equal(after.length, 1, '不能变成两条完成记录：' + JSON.stringify(after.map((x) => x.completionKey)))
  assert.equal(after[0].completionKey, 'unknown-1#3', '身份归并到权威键上')
})

test('E2 宿主 completionKey → 快照暂时缺失：退回兜底身份也不重播', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', false, 'done')
  h.setState({ ok: true, sessions: [DONE_ROW('s1', 's1#4', h.now)] })
  await h.advance(600)
  assert.equal(motionOf(made.slot), 'orbit')
  // 快照里这一行暂时缺字段（宿主重启/网络抖动），只剩 DOM 的 done
  h.setState({ ok: true, sessions: [] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done', '同一次完成仍然有效')
  assert.equal(h.api.completions().length, 1, '不能因为换了身份就多出一条完成记录')
})

test('E3 真的换了 completionKey 才算新的完成周期', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  const made = makeRow(h.doc, section, 's1', true)
  h.setState({ ok: true, sessions: [DONE_ROW('s1', 's1#5', h.now)] })
  await h.advance(600)
  assert.equal(h.api.completions().length, 1)
  // 切走：消费掉这一次
  made.row.setAttribute('aria-selected', 'false')
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'idle', '切走后消费')
  // 新一轮完成：新的 completionKey
  h.setState({ ok: true, sessions: [DONE_ROW('s1', 's1#6', h.now)] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done', '新一轮完成要重新庆祝')
  assert.equal(motionOf(made.slot), 'orbit')
  assert.equal(h.api.completions().length, 2, '两次完成是两条记录')
})

test('E4 未知会话：原生 done → 查看切走 → ongoing → done：第二次完成重新庆祝', async () => {
  const h = await boot()
  const section = makeSection(h.doc, 'proj-a')
  // state.json **始终不包含**这个会话（未知会话的真实条件）
  const made = makeRow(h.doc, section, 'ghost', true, 'done')
  h.setState({ ok: true, sessions: [] })
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done', '第一次完成')
  // 查看并切走 → 消费
  made.row.setAttribute('aria-selected', 'false')
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'idle', '切走后退出完成展示')
  // 原生状态变成 ongoing（真实新一轮开始）
  made.dot.setAttribute('data-state', 'ongoing')
  await h.advance(600)
  // 再完成：必须是新的完成周期
  made.dot.setAttribute('data-state', 'done')
  await h.advance(600)
  assert.equal(phaseOf(made.slot), 'done', '第二次完成要重新庆祝')
  assert.equal(motionOf(made.slot), 'orbit')
})
