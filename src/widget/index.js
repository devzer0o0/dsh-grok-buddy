/**
 * dsh-grok-buddy —— 把 GrokBot 头像挂到侧栏每个会话行上。
 *
 * 数据流：宿主半侧把每个会话折成一个相位，GET /dsh-grok-buddy/state.json 下发；
 * 本脚本轮询它，在每一行会话左侧的状态位里画一只 GrokBot。
 *
 * 头像本身就是 GrokBot：球面投影的眼睛会随转头变形、表情切换用弹簧、会眨眼。
 * 我们只做三件事：选状态、选墨色、放进 16px 的格子里。
 *
 * 设计依据（https://x.ai/news/designing-grok-bot）：官方把状态直接画在头像上，
 * 而不是另加一个指示器 —— 所以这里也是同一套生命周期（Idle / Working /
 * Waiting / Blocked / Thinking / Done），同一组官方墨色（见 mapping.js 的 INK）。
 *
 * @module dsh-grok-buddy/widget
 */

import { TB_EXPRESSIONS, TB_SHAPES, TB_STATES } from './grokbot/data.js'
import { createBot, runBot } from './grokbot/engine.js'
import { INK, LIFECYCLE, PHASE_TO_STATE, PHASE_TEXT, SURFACE, inkOf, surfaceOf, themeOf } from './mapping.js'

const BUILD = '2026-11-02c'
const STATE_URL = '/dsh-grok-buddy/state.json'
const POLL_MS = 500
const POLL_HIDDEN_MS = 2000
/** 抽查一次眼睛底色的间隔（毫秒）—— 底色在变，但不值得每帧都量。 */
const SURFACE_CHECK_MS = 1500
const BOT_CLASS = 'dsgb-bot'
const SLOT_ATTR = 'data-dsgb-slot'
const ROW_ATTR = 'data-dsgb-row'

/**
 * 引导：注入样式并挂到会话行上。
 */
function boot() {
  if (window.__dshGrokBuddy !== undefined) return
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  let dark = detectDark()
  const text = /^zh/i.test(navigator.language || '') ? PHASE_TEXT.zh : PHASE_TEXT.en
  /** 主题变了的回调集合（mount 时登记，切主题时统一重刷）。 */
  const repainters = new Set()

  injectStyles()

  /** 会话 id → { phase, detail } */
  let byId = new Map()
  /** 槽位元素 → { inst, phase }（按 DOM 索引，同一会话出现在多处也各有一份） */
  const mounted = new WeakMap()
  let stopped = false
  let timer = null

  /**
   * 读 DSH 自己的深色开关。侧栏主题一旦不是「跟随系统」，只用
   * `prefers-color-scheme` 会判错 —— 眼睛填的是背景色，判错就是一只对不上
   * 底色的脸。所以文档标记 > 计算样式 > 系统偏好，依次降级。
   */
  function detectDark() {
    const root = document.documentElement
    if (root.dataset.dsTheme === 'dark') return true
    if (root.dataset.dsTheme === 'light') return false
    if (root.dataset.theme === 'dark') return true
    if (root.dataset.theme === 'light') return false
    if (typeof getComputedStyle === 'function') {
      const scheme = getComputedStyle(root).colorScheme || ''
      if (scheme.indexOf('dark') !== -1) return true
      if (scheme.indexOf('light') !== -1) return false
    }
    if (typeof matchMedia === 'function') return matchMedia('(prefers-color-scheme: dark)').matches
    return true
  }

  /**
   * 把一只头像刷成当前相位 + 当前主题的墨色。
   * 眼睛和官方一样填**背景色**（`.eye{fill:var(--bg)}`），底色从状态位背后量出来。
   */
  function paint(record, phase) {
    const surface = surfaceOf(record.slot, dark)
    const theme = themeOf(phase, dark, surface)
    record.phase = phase
    record.dark = dark
    record.surface = surface
    record.checkedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    record.inst.body.setAttribute('fill', theme.body)
    record.inst.eyeL.setAttribute('fill', theme.eye)
    record.inst.eyeR.setAttribute('fill', theme.eye)
  }

  function mountInto(slot, phase) {
    let record = mounted.get(slot)
    if (record === undefined) {
      const surface = surfaceOf(slot, dark)
      const theme = themeOf(phase, dark, surface)
      const inst = createBot({
        shape: TB_SHAPES.blob,
        bodyFill: theme.body,
        eyeFill: theme.eye,
        size: 18,
      })
      inst.state = PHASE_TO_STATE[phase] || 'idle'
      inst.svg.classList.add(BOT_CLASS)
      runBot(inst, { expressions: TB_EXPRESSIONS, states: TB_STATES, reduced: reduce })
      record = { inst, phase, dark, surface, slot, checkedAt: 0 }
      mounted.set(slot, record)
      const row = { record, slot }
      repainters.add(row)
      slot.appendChild(inst.svg)
      return record
    }
    if (record.phase !== phase) {
      record.inst.state = PHASE_TO_STATE[phase] || 'idle'
      record.inst.token += 1
      record.inst.pool = null
      paint(record, phase)
    } else if (record.dark !== dark) {
      paint(record, phase)
    } else {
      // 底色会随主题/悬停变（眼睛填的就是它）。每帧都量一次 getComputedStyle
      // 太贵，所以隔一段时间抽查一次，变了才重刷。
      const at = typeof performance !== 'undefined' ? performance.now() : Date.now()
      if (at - record.checkedAt >= SURFACE_CHECK_MS) {
        record.checkedAt = at
        if (surfaceOf(slot, dark) !== record.surface) paint(record, phase)
      }
    }
    if (record.inst.svg.parentNode !== slot) slot.appendChild(record.inst.svg)
    return record
  }

  /**
   * 主题切换：重新判定深浅，并把所有已挂上的头像按新主题重刷一遍。
   * 深浅没变也要重刷 —— 同样是暗色，底色也可能被换掉（眼睛填的就是底色）。
   */
  function onThemeChange() {
    dark = detectDark()
    for (const row of repainters) {
      if (!row.record.inst.svg.isConnected) {
        repainters.delete(row)
        continue
      }
      // 只在真的变了的时候重画：这个回调会被文档上的 class/style 抖动触发
      const surface = surfaceOf(row.slot, dark)
      if (row.record.dark === dark && row.record.surface === surface) continue
      paint(row.record, row.record.phase)
    }
    syncRows()
  }

  function labelOf(phase, detail) {
    const base = text[phase] || text.idle
    return detail ? base + ' · ' + detail : base
  }

  function syncRows() {
    const rows = document.querySelectorAll('[data-row-key^="session:"]')
    for (const row of rows) {
      const key = row.getAttribute('data-row-key') || ''
      const sessionId = key.slice(8)
      if (sessionId === '') continue
      const slot = findSlot(row)
      if (slot === undefined) continue
      const entry = byId.get(sessionId)
      const phase = entry === undefined ? 'idle' : entry.phase
      const detail = entry === undefined ? '' : entry.detail
      slot.setAttribute(SLOT_ATTR, '1')
      row.setAttribute(ROW_ATTR, sessionId)
      const record = mountInto(slot, phase)
      const label = labelOf(phase, detail)
      if (record.inst.svg.getAttribute('aria-label') !== label) {
        record.inst.svg.setAttribute('aria-label', text[phase] || text.idle)
        record.inst.svg.setAttribute('data-detail', detail)
        record.inst.svg.setAttribute('role', 'img')
        slot.setAttribute('title', label)
      }
    }
  }

  function findSlot(row) {
    for (const child of row.children) {
      const cls = typeof child.className === 'string' ? child.className : ''
      if (child.classList.contains(BOT_CLASS) || child.classList.contains('dsgb-host')) continue
      if (/_slot\b/.test(cls) || /\bslot\b/.test(cls)) return child
    }
    // 没有 slot 类名时退回第一个空座位（16px 宽）
    for (const child of row.children) {
      if (child.classList.contains('dsgb-host')) return child
      if (child.getBoundingClientRect().width <= 20) return child
    }
    return undefined
  }

  function absorb(body) {
    const next = new Map()
    const list = body && Array.isArray(body.sessions) ? body.sessions : []
    for (const item of list) {
      if (!item || typeof item.id !== 'string') continue
      next.set(item.id, {
        phase: typeof item.phase === 'string' ? item.phase : 'idle',
        detail: typeof item.detail === 'string' ? item.detail : '',
      })
    }
    byId = next
  }

  function poll() {
    if (stopped) return
    let request
    try {
      request = fetch(STATE_URL, { cache: 'no-store', credentials: 'same-origin' })
    } catch (err) {
      schedule()
      return
    }
    request
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
      .then((body) => {
        if (stopped) return
        absorb(body)
        syncRows()
      })
      .catch(() => {})
      .then(schedule)
  }

  function schedule() {
    if (stopped) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(poll, document.hidden ? POLL_HIDDEN_MS : POLL_MS)
  }

  let frame = 0
  function onChange() {
    if (stopped || frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      syncRows()
    })
  }

  function injectStyles() {
    if (document.querySelector('style[data-dsh-grok-buddy="style"]') !== null) return
    const style = document.createElement('style')
    style.setAttribute('data-dsh-grok-buddy', 'style')
    style.textContent = [
      '[' + SLOT_ATTR + ']{position:relative}',
      '[' + SLOT_ATTR + '] > [data-state]{display:none!important}',
      '[' + SLOT_ATTR + '] > [class*="visuallyHidden"]{display:none!important}',
      '.' + BOT_CLASS + '{display:block;width:18px;height:18px;flex:none}',
    ].join('\n')
    document.head.appendChild(style)
  }

  const observer = new MutationObserver(onChange)
  observer.observe(document.body, { subtree: true, childList: true })
  // DSH 切主题时会改文档上的标记，跟着重刷墨色
  const themeObserver = new MutationObserver(onThemeChange)
  for (const el of [document.documentElement, document.body]) {
    themeObserver.observe(el, { attributes: true, attributeFilter: ['data-ds-theme', 'data-theme', 'class', 'style'] })
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      onThemeChange()
      poll()
    }
  })
  window.addEventListener('resize', onChange)

  syncRows()
  poll()

  window.__dshGrokBuddy = {
    version: BUILD,
    states: PHASE_TO_STATE,
    phases: Object.keys(PHASE_TO_STATE),
    lifecycle: LIFECYCLE,
    /** 读当前相位对应的官方墨色（调试/截图用）。 */
    ink(phase, isDark) {
      return inkOf(phase, isDark === undefined ? dark : isDark)
    },
    /** 官方墨色表与兜底底色，方便外部核对。 */
    palette: { ...INK, surface: SURFACE },
    sync: syncRows,
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      observer.disconnect()
      themeObserver.disconnect()
      repainters.clear()
      window.removeEventListener('resize', onChange)
      const svgs = document.querySelectorAll('.' + BOT_CLASS)
      for (const svg of svgs) svg.remove()
      document.querySelectorAll('[' + SLOT_ATTR + ']').forEach((el) => {
        el.removeAttribute(SLOT_ATTR)
        el.removeAttribute('title')
      })
      delete window.__dshGrokBuddy
    },
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.body !== null) boot()
  else document.addEventListener('DOMContentLoaded', boot, { once: true })
}