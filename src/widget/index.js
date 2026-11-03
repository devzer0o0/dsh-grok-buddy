/**
 * dsh-grok-buddy —— 把 GrokBot 头像挂到侧栏每个会话行上。
 *
 * 数据流：宿主半侧把每个会话折成**六态**之一，GET /dsh-grok-buddy/state.json 下发；
 * 项目配色走 GET/POST /dsh-grok-buddy/colors.json。本脚本轮询状态、在会话行
 * 左侧的 16px 前导位里画一只 GrokBot。
 *
 * 分层（照 https://x.ai/news/designing-grok-bot 的 Avatar motion system）：
 *   颜色        = 这是哪个项目（DSH Workspace），与状态无关
 *   运行状态    = 六态：idle / working / waiting / blocked / thinking / done
 *   动作预设    = 内部动画资源（celebrate / bored / alerting …），不是公开状态
 *   表情素材    = 眼型等，按动作池取用
 *
 * 完成展示的规则（用户确认）：
 *   活跃时持续庆祝；查看并切走或失活后变为灰色 idle。
 *   所以 done 路径上**没有**固定 2.6 秒回落，也没有重建动画的定时器。
 *
 * @module dsh-grok-buddy/widget
 */

import { TB_EXPRESSIONS, TB_SHAPES, TB_STATES } from './grokbot/data.js'
import { createBot, runBot } from './grokbot/engine.js'
import { LIFECYCLE, PHASE_TEXT, PHASE_TO_MOTION, SURFACE, surfaceOf, themeOf } from './mapping.js'
import { IDENTITY_INKS, UNGROUPED_KEY, defaultInk, inkOfProject, normalizeColor, storeKey } from './palette.js'
import { collectSurfaces } from './dom.js'
import { dshRawStateOf, fallbackPhase, mergePhase } from './dsh-state.js'
import { COOLDOWN_MS, isActive, inkForRow } from './activity.js'
import { freshMemory, resolveMotion } from './celebrate.js'
import { DONE_DISPLAY_TTL_MS, TURN_SILENCE_TTL_MS, normalizePhaseInput } from '../decision.js'
import { paletteStyles, slotStyles } from './styles.js'

/** 构建标识：版本标签之外的第二重核对（页面与源码必须对得上）。 */
const BUILD = '2026-11-04a'
const STATE_URL = '/dsh-grok-buddy/state.json'
const COLORS_URL = '/dsh-grok-buddy/colors.json'
const PROBE_URL = '/dsh-grok-buddy/probe.json'
const PROBE_CONTROL_URL = '/dsh-grok-buddy/probe-control.json'
const POLL_MS = 500
const POLL_HIDDEN_MS = 2000
/** 抽查一次眼睛底色的间隔（毫秒）。 */
const SURFACE_CHECK_MS = 1500
/** 配色文件的轮询间隔。 */
const COLORS_POLL_MS = 1500
const BOT_CLASS = 'dsgb-bot'
const SLOT_ATTR = 'data-dsgb-slot'
const ROW_ATTR = 'data-dsgb-row'
const PROJECT_ATTR = 'data-dsgb-project'
/** 项目行 ⋯ 菜单的容器（DSH 的 Menu 用 portal 挂到 body）。 */
const MENU_SURFACE = '[data-menu-material]'
/** 头像边长：与 DSH 原生 16px 前导位逐像素对齐。 */
const BOT_SIZE = 16
/** 单页面的实例标识（诊断里区分多窗口 / 多页面）。 */
const PAGE_ID = Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36)

/**
 * 引导：注入样式并挂到会话行上。
 */
function boot() {
  if (window.__dshGrokBuddy !== undefined) return
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  let dark = detectDark()
  const text = /^zh/i.test(navigator.language || '') ? PHASE_TEXT.zh : PHASE_TEXT.en

  injectStyles()

  /** sessionId → 宿主下发的行（phase / reason / completionKey / …） */
  let byId = new Map()
  /** workspaceId → 用户存下来的颜色 */
  let colors = {}
  /** 槽位元素 → record（按 DOM 索引，同一会话出现在多处也各有一份，各自独立动画） */
  const mounted = new WeakMap()
  /** 已挂载记录表（要按项目批量重刷，WeakMap 遍历不了） */
  const records = new Set()
  /** completionKey → 用户查看它的时刻（完成消费按**完成身份**记，不按会话） */
  const seenCompletions = new Map()
  /** completionKey → 首次观测到它的时刻（completedAt 缺失时的稳定锚点） */
  const observedCompletions = new Map()
  /** completionKey → 是否已被消费（看过并切走） */
  const consumedCompletions = new Set()
  let stopped = false
  let timer = null
  let colorsTimer = null
  let palette = null
  let lastWorkspaceClick = null
  /** 诊断：默认关闭，只支持一次性采样与明确时限的短窗口。 */
  let probeWindowUntil = 0
  let probeSampleTimer = null
  let probePosted = 0
  /** 所有登记的清理函数 —— stop 时逐个调用，绝不漏。 */
  const disposers = []

  function onDispose(fn) {
    disposers.push(fn)
  }

  /**
   * 读 DSH 自己的深色开关。
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

  /** 项目墨色（身份色本身）。 */
  function inkFor(workspaceId, surface) {
    return inkOfProject(workspaceId, dark, colors, surface)
  }

  /** 一行最终该用的墨色：活跃 / 选中 → 项目色；否则灰。 */
  function inkForRecord(record, surface) {
    const projectInk = inkFor(record.project, surface)
    return inkForRow(
      {
        phase: record.phase,
        selected: record.selected,
        completedAt: record.completedAt,
        observedAt: record.observedAt,
        seenAt: record.seenAt,
        consumed: record.consumed,
      },
      Date.now(),
      projectInk,
      dark,
    )
  }

  /**
   * 把一只头像刷成当前项目的墨色 + 背景色。
   */
  function paint(record, phase) {
    const surface = surfaceOf(record.slot, dark)
    record.phase = phase
    const ink = inkForRecord(record, surface)
    const theme = themeOf(ink, dark, surface)
    record.dark = dark
    record.surface = surface
    record.ink = ink
    record.checkedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    record.inst.body.setAttribute('fill', theme.body)
    record.inst.eyeL.setAttribute('fill', theme.eye)
    record.inst.eyeR.setAttribute('fill', theme.eye)
  }

  /**
   * 六态 → 动作用哪个预设。
   *
   * 只有**展示状态**能驱动动作：displayPhase=done → 持续 celebrate；
   * displayPhase 一旦不是 done → 立刻离开完成动作。
   * 同一完成周期的重复轮询不会重置动画时钟（见 celebrate.js 的记忆位）。
   */
  function motionFor(record, phase, completionKey) {
    if (reduce) {
      // 减少动效：不播持续运动，只用可区分的静态姿态 + 可访问文案表达六态
      record.motion = freshMemory()
      return PHASE_TO_MOTION[phase] || 'idle'
    }
    const resolved = resolveMotion(phase, record.motion, PHASE_TO_MOTION, completionKey)
    record.motion = resolved.memory
    record.motionStarted = record.motionStarted === true || resolved.start === true
    return resolved.motion
  }

  /**
   * 把「这一刻用的是哪个动作」和「六态是什么」写到 DOM 上。
   *
   * ⚠️ 业务检查用的属性只表达六态：data-dsgb-phase / data-dsgb-tone。
   * 动作名走 data-dsgb-motion，明确标注它是内部动画资源。
   */
  function stamp(record) {
    const svg = record.inst.svg
    const phase = record.phase || 'idle'
    const motion = record.motionName || PHASE_TO_MOTION[phase] || 'idle'
    if (svg.getAttribute('data-dsgb-phase') !== phase) svg.setAttribute('data-dsgb-phase', phase)
    if (svg.getAttribute('data-dsgb-motion') !== motion) svg.setAttribute('data-dsgb-motion', motion)
    const tone = isActive(
      {
        phase: record.phase,
        selected: record.selected,
        completedAt: record.completedAt,
        observedAt: record.observedAt,
        seenAt: record.seenAt,
        consumed: record.consumed,
      },
      Date.now(),
    )
      ? 'active'
      : 'dormant'
    if (svg.getAttribute('data-dsgb-tone') !== tone) svg.setAttribute('data-dsgb-tone', tone)
    if (record.completionKey !== '' && svg.getAttribute('data-dsgb-completion') !== record.completionKey) {
      svg.setAttribute('data-dsgb-completion', record.completionKey)
    }
  }

  /**
   * 一条会话此刻的展示状态（六态）—— 页面侧的**唯一**入口。
   *
   * 顺序：
   *   1. 登记表里有没有这个会话：有 → 用宿主算好的六态；没有 → 退回 DSH 状态点
   *   2. 与 DSH 画在行里的状态点融合（按事实与消费状态，不是「有值就优先」）
   *   3. 完成记录的身份与消费状态（completionKey 粒度）
   *
   * @param {object} surface 表面识别结果。
   * @returns {{phase: string, reason: string, entry: object|null, completionKey: string, consumed: boolean, observedAt: number|undefined, dshState: string|null}}
   */
  function displayOf(surface) {
    const sessionId = surface.sessionId
    const entry = byId.get(sessionId)
    const known = entry !== undefined
    const rawOurs = known ? normalizePhaseInput(entry.phase) : 'idle'
    let completionKey = known && typeof entry.completionKey === 'string' ? entry.completionKey : ''
    let observedAt = completionKey === '' ? undefined : observedCompletions.get(completionKey)
    let consumed = completionKey !== '' && consumedCompletions.has(completionKey)

    // 没有宿主完成身份、但 DSH 说 done：用「会话 + 首次看到它的时刻」造一个稳定身份，
    // 这样「DSH 说完但插件没有完成记录」的会话也能被标记已查看、不会永远活跃。
    if (completionKey === '' && !known) {
      const dshPhase = fallbackPhase(surface.host)
      if (dshPhase === 'done') {
        completionKey = 'dsh:' + sessionId
        if (observedAt === undefined && observedCompletions.has(completionKey) === false) {
          observedCompletions.set(completionKey, Date.now())
          observedAt = observedCompletions.get(completionKey)
        } else if (observedAt === undefined) {
          observedAt = observedCompletions.get(completionKey)
        }
        consumed = consumedCompletions.has(completionKey)
      }
    } else if (completionKey !== '' && observedAt === undefined) {
      observedCompletions.set(completionKey, Date.now())
      observedAt = observedCompletions.get(completionKey)
    }

    const merged = mergePhase({
      phase: rawOurs,
      known,
      consumed,
      completionKey,
      row: surface.host,
    })
    let phase = merged.phase
    // 融合后仍是 done 时，才把消费状态真正落到展示上（已消费 → idle）
    if (phase === 'done' && consumed) phase = 'idle'
    return {
      phase,
      reason: known && typeof entry.reason === 'string' ? entry.reason : merged.source,
      entry: known ? entry : null,
      completionKey: phase === 'done' || consumed ? completionKey : '',
      consumed,
      observedAt,
      dshState: merged.dshState,
    }
  }

  /** 建/更新一只头像。 */
  function mountInto(surface, display) {
    const slot = surface.slot
    if (slot === null || slot === undefined) return undefined
    let record = mounted.get(slot)
    // 同一个 DOM 槽位被复用于另一个会话：必须重新绑定身份，不能沿用旧动画
    if (record !== undefined && record.sessionId !== surface.sessionId) {
      disposeRecord(record)
      mounted.delete(slot)
      record = undefined
    }
    if (record === undefined) {
      const surfaceColor = surfaceOf(slot, dark)
      const probe = {
        phase: display.phase,
        project: surface.workspaceId,
        selected: surface.selected,
        completedAt: display.entry !== null && typeof display.entry.completedAt === 'number' ? display.entry.completedAt : undefined,
        observedAt: display.observedAt,
        seenAt: undefined,
        consumed: display.consumed,
      }
      const ink = inkForRecord(probe, surfaceColor)
      const theme = themeOf(ink, dark, surfaceColor)
      const inst = createBot({
        shape: TB_SHAPES.blob,
        bodyFill: theme.body,
        eyeFill: theme.eye,
        size: BOT_SIZE,
      })
      inst.svg.classList.add(BOT_CLASS)
      record = {
        inst,
        sessionId: surface.sessionId,
        surface: surface.surface,
        phase: display.phase,
        project: surface.workspaceId,
        ink,
        dark,
        surfaceColor,
        slot,
        checkedAt: 0,
        motion: freshMemory(),
        motionStarted: false,
        motionName: '',
        selected: probe.selected,
        completedAt: probe.completedAt,
        observedAt: probe.observedAt,
        seenAt: undefined,
        consumed: probe.consumed,
        completionKey: display.completionKey,
        dispose: null,
      }
      record.motionName = motionFor(record, display.phase, display.completionKey)
      inst.state = record.motionName
      stamp(record)
      const stopBot = runBot(inst, { expressions: TB_EXPRESSIONS, states: TB_STATES, reduced: reduce })
      record.dispose = () => {
        if (typeof stopBot === 'function') stopBot()
      }
      mounted.set(slot, record)
      records.add(record)
      // 插到最前面：这一格里可能还有 DSH 自己的标记（定时任务的时钟），
      // 头像必须是最左的那一个，和原生状态点同位。
      slot.insertBefore(inst.svg, slot.firstChild)
      return record
    }

    // 已知槽位：更新事实，再决定要不要换动作
    record.project = surface.workspaceId
    record.selected = surface.selected === true
    record.completedAt =
      display.entry !== null && typeof display.entry.completedAt === 'number' ? display.entry.completedAt : undefined
    record.observedAt = display.observedAt
    record.consumed = display.consumed === true
    record.completionKey = display.completionKey
    const seen = display.completionKey === '' ? undefined : seenCompletions.get(display.completionKey)
    record.seenAt = seen

    const surfaceNow = surfaceOf(slot, dark)
    const inkNow = inkForRecord(record, surfaceNow)
    const nextMotion = motionFor(record, display.phase, display.completionKey)
    // 只有动作真的变了才重置实例状态 —— 同一状态的重复轮询不得重启动画
    if (record.inst.state !== nextMotion) {
      record.inst.state = nextMotion
      record.inst.token += 1
      record.inst.pool = null
    }
    record.motionName = nextMotion
    record.phase = display.phase
    stamp(record)
    if (record.dark !== dark || record.ink !== inkNow || record.surfaceColor !== surfaceNow) {
      paint(record, display.phase)
    } else {
      const at = typeof performance !== 'undefined' ? performance.now() : Date.now()
      if (at - record.checkedAt >= SURFACE_CHECK_MS) {
        record.checkedAt = at
        if (surfaceNow !== record.surfaceColor) paint(record, display.phase)
      }
    }
    // 节点被摘掉又挂回来：动画循环当时已经自己停了，这里重新起一个。
    // 判断依据是引擎自己的运行标志（节点离开 DOM 时它会置 false），
    // 不是「parentNode 是不是同一个」—— 摘下来再插回去时 parentNode 可能没变。
    if (record.inst.svg.parentNode !== slot) {
      slot.insertBefore(record.inst.svg, slot.firstChild)
    }
    if (record.inst.running !== true && !stopped) {
      restartBot(record)
    }
    return record
  }

  /** 重新起动画循环（节点重新挂载后用）。 */
  function restartBot(record) {
    const stopBot = runBot(record.inst, { expressions: TB_EXPRESSIONS, states: TB_STATES, reduced: reduce })
    const previous = record.dispose
    record.dispose = () => {
      if (typeof stopBot === 'function') stopBot()
      if (typeof previous === 'function') previous()
    }
  }

  /** 彻底拆掉一条记录：停动画、摘节点、清索引。 */
  function disposeRecord(record) {
    if (typeof record.dispose === 'function') record.dispose()
    record.dispose = null
    if (record.inst.svg.parentNode !== null) record.inst.svg.remove()
    records.delete(record)
  }

  /** 某个项目改色后，该项目下所有已挂载头像当场重刷。 */
  function repaintProject(workspaceId) {
    for (const record of [...records]) {
      if (!record.inst.svg.isConnected) {
        disposeRecord(record)
        continue
      }
      if (record.project !== workspaceId) continue
      paint(record, record.phase)
    }
  }

  /** 主题切换：重新判定深浅，并把所有已挂上的头像按新主题重刷。 */
  function onThemeChange() {
    dark = detectDark()
    for (const record of [...records]) {
      if (!record.inst.svg.isConnected) {
        disposeRecord(record)
        continue
      }
      const surface = surfaceOf(record.slot, dark)
      if (record.dark === dark && record.surfaceColor === surface) continue
      paint(record, record.phase)
    }
    syncRows()
  }

  function labelOf(phase, detail) {
    const base = text[phase] || text.idle
    return detail ? base + ' · ' + detail : base
  }

  /**
   * 主同步：枚举所有表面，逐条算六态并挂头像。
   *
   * 认不出身份的搜索结果不猜 —— 只记账（unidentifiable），由诊断如实报告。
   */
  function syncRows() {
    if (stopped) return
    const surfaces = collectSurfaces(document)
    for (const surface of surfaces.sidebar) {
      const slot = surface.slot
      if (slot === null || slot === undefined) continue
      const display = displayOf(surface)
      consumeIfViewed(surface, display)
      slot.setAttribute(SLOT_ATTR, '1')
      surface.host.setAttribute(ROW_ATTR, surface.sessionId)
      surface.host.setAttribute(PROJECT_ATTR, surface.workspaceId)
      const record = mountInto(surface, display)
      if (record === undefined) continue
      const label = labelOf(display.phase, display.entry !== null && typeof display.entry.detail === 'string' ? display.entry.detail : '')
      writeAccessibility(record, slot, display.phase, label)
    }
  }

  /**
   * 无障碍：图标本身对读屏隐藏，语义挂在容器上。
   *
   * 修复的是「aria-hidden 与 role=aria-label 互相矛盾」：
   * SVG 上不再同时出现 aria-hidden="true" 和 role="img"。
   */
  function writeAccessibility(record, slot, phase, label) {
    const svg = record.inst.svg
    // 图标是装饰：文字语义由容器的 role + aria-label 承担
    if (svg.getAttribute('aria-hidden') !== 'true') svg.setAttribute('aria-hidden', 'true')
    svg.removeAttribute('role')
    svg.removeAttribute('aria-label')
    if (svg.getAttribute('focusable') !== 'false') svg.setAttribute('focusable', 'false')
    if (slot.getAttribute('role') !== 'img') slot.setAttribute('role', 'img')
    if (slot.getAttribute('aria-label') !== label) slot.setAttribute('aria-label', label)
    if (svg.getAttribute('data-dsgb-phase') !== phase) svg.setAttribute('data-dsgb-phase', phase)
  }

  /** 选中 / 打开过 ⇒ 这条完成记录被消费。只对 done 有意义。 */
  function consumeIfViewed(surface, display) {
    if (display.phase !== 'done') return
    const key = display.completionKey
    if (key === '') return
    if (surface.selected !== true) return
    const previous = seenCompletions.get(key)
    if (previous !== undefined) return
    seenCompletions.set(key, Date.now())
    // 选中就是「正在看」：标记已看过；切走（选中解除）后即变灰
    consumedCompletions.add(key)
  }

  // ── 项目行 ⋯ 菜单里的「颜色」入口 ────────────────────────────────────────
  // 项目行**不放**颜色圆点：文件夹前面只留图标。

  function decorateMenus() {
    if (stopped) return
    const surfaces = document.querySelectorAll(MENU_SURFACE)
    for (const menu of surfaces) {
      if (!isMenuOpen(menu) && menu.querySelector('.dsgb-menu-item') !== null) {
        for (const stale of menu.querySelectorAll('.dsgb-menu-item')) stale.remove()
        continue
      }
      if (menu.querySelector('.dsgb-menu-item') !== null) continue
      if (menu.closest('.dsgb-palette') !== null) continue
      const items = [...menu.querySelectorAll('button[role="menuitem"]')]
      if (items.length === 0) continue
      const labels = items.map((item) => (item.textContent || '').trim())
      const isProject =
        labels.some((label) => /重命名|rename/i.test(label)) &&
        labels.some((label) => /删除工作区|delete workspace/i.test(label))
      if (!isProject) continue
      if (currentMenuWorkspace() === null) continue
      const wrap = items[items.length - 1].parentElement
      if (wrap === null || wrap.parentElement === null) continue
      const holder = document.createElement('div')
      holder.className = 'dsgb-menu-item'
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.className = 'dsgb-menu-button'
      button.innerHTML = swatchIconSvg() + '<span class="dsgb-menu-label">颜色</span>'
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        event.preventDefault()
        // 归属在**点的这一刻**重新算：DSH 的菜单容器会复用，缓存 workspaceId 会改错项目。
        const workspaceId = currentMenuWorkspace()
        if (workspaceId === null) return
        openPalette(workspaceId, button)
        closeMenus()
      })
      holder.appendChild(button)
      wrap.parentElement.appendChild(holder)
    }
  }

  /** 菜单容器现在是不是可见（DSH 可能只切 display/visibility 而复用同一个节点）。 */
  function isMenuOpen(menu) {
    if (typeof getComputedStyle !== 'function') return true
    const style = getComputedStyle(menu)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    return true
  }

  /**
   * 认出这个 ⋯ 菜单属于哪个项目行。
   *
   * 菜单 portal 到 body，DOM 上和项目行没有父子关系，所以只能从「刚点的是哪一行」
   * 倒推，兜底再看 menuOpen 类与 :hover。每次调用都重新算 —— 这是「先鼠标开 A、
   * 再键盘开 B 不能沿用 A 的缓存」的实现方式。
   */
  function currentMenuWorkspace() {
    const open = document.querySelector('[data-row-key^="workspace:"][class*="menuOpen"]')
    if (open !== null) return (open.getAttribute('data-row-key') || '').slice(10)
    if (lastWorkspaceClick !== null) {
      const still = document.querySelector('[data-row-key="workspace:' + lastWorkspaceClick + '"]')
      if (still !== null) return lastWorkspaceClick
    }
    const hovered = document.querySelector('[data-row-key^="workspace:"]:hover')
    if (hovered !== null) return (hovered.getAttribute('data-row-key') || '').slice(10)
    return lastWorkspaceClick
  }

  /** 关掉 DSH 自己的菜单（点完调色板入口就该收起）。 */
  function closeMenus() {
    const probe = document.createEvent('MouseEvents')
    probe.initMouseEvent('click', true, true, window, 0, 0, 0, 0, 0, false, false, false, false, 0, null)
    document.body.dispatchEvent(probe)
  }

  function swatchIconSvg() {
    return (
      '<span class="dsgb-menu-icon" aria-hidden="true">' +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' +
      '<path d="M8 1.8a6.2 6.2 0 0 0 0 12.4c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1-.3-.3-.4-.6-.4-1 0-.8.7-1.4 1.5-1.4h1.1c1.2 0 2.1-1 2.1-2.2C13.4 4.2 11 1.8 8 1.8Z" stroke="currentColor" stroke-width="1.2"/>' +
      '<circle cx="5.4" cy="6.2" r=".95" fill="currentColor"/>' +
      '<circle cx="8.2" cy="4.7" r=".95" fill="currentColor"/>' +
      '<circle cx="11" cy="6.2" r=".95" fill="currentColor"/>' +
      '</svg></span>'
    )
  }

  // ── 调色板 ────────────────────────────────────────────────────────────────

  function openPalette(workspaceId, anchor) {
    closePalette()
    const box = document.createElement('div')
    box.className = 'dsgb-palette'
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-label', '项目颜色')
    const current = inkOfProject(workspaceId, dark, colors)

    const head = document.createElement('div')
    head.className = 'dsgb-palette-head'
    head.textContent = '项目颜色'
    box.appendChild(head)

    const grid = document.createElement('div')
    grid.className = 'dsgb-palette-grid'
    for (const item of IDENTITY_INKS) {
      const swatch = document.createElement('button')
      swatch.type = 'button'
      swatch.className = 'dsgb-swatch'
      swatch.style.background = item.ink
      swatch.title = item.name
      swatch.setAttribute('aria-label', item.name)
      if (item.ink.toLowerCase() === current.toLowerCase()) swatch.classList.add('is-on')
      swatch.addEventListener('click', () => applyColor(workspaceId, item.ink))
      grid.appendChild(swatch)
    }
    box.appendChild(grid)

    const custom = document.createElement('div')
    custom.className = 'dsgb-palette-custom'
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = '#9159FE'
    input.className = 'dsgb-hex'
    input.value = current
    input.setAttribute('aria-label', '自定义颜色 hex')
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit()
    })
    custom.appendChild(input)
    const apply = document.createElement('button')
    apply.type = 'button'
    apply.className = 'dsgb-palette-apply'
    apply.textContent = '应用'
    apply.addEventListener('click', submit)
    custom.appendChild(apply)
    box.appendChild(custom)

    /** 失败反馈：可观察，不静默。 */
    const feedback = document.createElement('div')
    feedback.className = 'dsgb-palette-feedback'
    feedback.setAttribute('role', 'status')
    box.appendChild(feedback)

    function submit() {
      const value = normalizeColor(input.value)
      if (value === null) {
        input.classList.add('is-bad')
        feedback.textContent = '不是合法颜色（例：#9159FE）'
        return
      }
      input.classList.remove('is-bad')
      applyColor(workspaceId, value)
    }

    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'dsgb-palette-reset'
    reset.textContent = '恢复默认（' + defaultInk(workspaceId) + '）'
    reset.addEventListener('click', () => applyColor(workspaceId, null))
    box.appendChild(reset)

    if (dark) {
      box.style.background = '#22262c'
      box.style.color = '#e6e8ea'
      box.style.colorScheme = 'dark'
    } else {
      box.style.background = '#ffffff'
      box.style.color = '#1f2328'
      box.style.colorScheme = 'light'
    }

    box.addEventListener('click', (event) => event.stopPropagation())
    document.body.appendChild(box)
    placePalette(box, anchor)
    palette = { box, workspaceId, cleanup: null }

    // 捕获阶段的「点别处就收起」必须放过调色板内部 —— 否则色块还没收到 click
    const onDocClick = (event) => {
      const target = event.target
      if (target !== null && typeof target.closest === 'function' && target.closest('.dsgb-palette') !== null) {
        return
      }
      closePalette()
    }
    const onKey = (event) => {
      if (event.key === 'Escape') closePalette()
    }
    palette.cleanup = () => {
      document.removeEventListener('click', onDocClick, true)
      document.removeEventListener('keydown', onKey, true)
    }
    setTimeout(() => {
      if (palette === null) return
      document.addEventListener('click', onDocClick, true)
      document.addEventListener('keydown', onKey, true)
    }, 0)
  }

  function placePalette(box, anchor) {
    const rect = anchor.getBoundingClientRect()
    const width = box.offsetWidth || 236
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
    let top = rect.bottom + 6
    const height = box.offsetHeight
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6)
    box.style.left = left + 'px'
    box.style.top = top + 'px'
  }

  function closePalette() {
    if (palette === null) return
    if (typeof palette.cleanup === 'function') palette.cleanup()
    palette.box.remove()
    palette = null
  }

  /**
   * 改一个项目的颜色：乐观重刷 → 落盘 → 失败回滚。
   *
   * 用递增序号丢弃过期响应：轮询与连续写入不会出现「旧响应覆盖新选择」。
   */
  let colorSeq = 0
  const colorSeqOf = new Map()

  function applyColor(workspaceId, value) {
    const key = storeKey(workspaceId)
    const previous = colors[key]
    const seq = ++colorSeq
    colorSeqOf.set(key, seq)
    if (value === null) delete colors[key]
    else colors[key] = value
    repaintProject(workspaceId)
    closePalette()
    postColor(workspaceId, value)
      .then(() => {
        if (stopped) return
        // 只有最新一次写入的结果能生效
        if (colorSeqOf.get(key) !== seq) return
      })
      .catch(() => {
        if (stopped) return
        if (colorSeqOf.get(key) !== seq) return
        if (previous === undefined) delete colors[key]
        else colors[key] = previous
        repaintProject(workspaceId)
        notifyColorFailure()
      })
  }

  /** 配色写入失败的可观察反馈。 */
  function notifyColorFailure() {
    let toast = document.querySelector('.dsgb-color-error')
    if (toast === null) {
      toast = document.createElement('div')
      toast.className = 'dsgb-color-error'
      toast.setAttribute('role', 'status')
      document.body.appendChild(toast)
    }
    toast.textContent = '颜色没保存成功，已恢复原色'
    setTimeout(() => {
      if (toast !== null && toast.isConnected) toast.remove()
    }, 2600)
  }

  function postColor(workspaceId, value) {
    return fetch(COLORS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ workspaceId: storeKey(workspaceId), color: value }),
    }).then((response) => {
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    })
  }

  function loadColors() {
    if (stopped) return
    const started = colorSeq
    fetch(COLORS_URL, { cache: 'no-store', credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
      .then((body) => {
        if (stopped) return
        // 期间发生过写入：这一份响应已经过期，丢掉，避免旧值覆盖新选择
        if (colorSeq !== started) return
        const next =
          body !== null && typeof body === 'object' && body.projects !== null && typeof body.projects === 'object'
            ? body.projects
            : {}
        const changed = JSON.stringify(next) !== JSON.stringify(colors)
        colors = next
        if (changed) {
          for (const record of [...records]) {
            if (record.inst.svg.isConnected) paint(record, record.phase)
          }
        }
      })
      .catch(() => {})
      .then(() => {
        if (stopped) return
        if (colorsTimer !== null) clearTimeout(colorsTimer)
        colorsTimer = setTimeout(loadColors, COLORS_POLL_MS)
      })
  }

  /** 收一份宿主快照。非法结构一律忽略（保留上一份，不清空成灰）。 */
  function absorb(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
    const list = Array.isArray(body.sessions) ? body.sessions : null
    if (list === null) return false
    const next = new Map()
    let accepted = 0
    let rejected = 0
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      if (typeof item.id !== 'string' || item.id === '') {
        rejected += 1
        continue
      }
      accepted += 1
      next.set(item.id, {
        phase: normalizePhaseInput(item.phase),
        reason: typeof item.reason === 'string' ? item.reason : '',
        detail: typeof item.detail === 'string' ? item.detail : '',
        completedAt: typeof item.completedAt === 'number' ? item.completedAt : undefined,
        completionKey: typeof item.completionKey === 'string' ? item.completionKey : '',
      })
    }
    // 非空但一条都认不出：这份快照不可信，保留上一份（别把整排脸清成灰）
    if (accepted === 0 && rejected > 0) return false
    byId = next
    return true
  }

  /** 轮询；用序号防止乱序响应把新数据覆盖成旧的。 */
  let pollSeq = 0
  function poll() {
    if (stopped) return
    const seq = ++pollSeq
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
        if (stopped || seq !== pollSeq) return
        absorb(body)
        syncRows()
        decorateMenus()
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
      if (stopped) return
      syncRows()
      decorateMenus()
    })
  }

  function injectStyles() {
    const existing = document.querySelector('style[data-dsh-grok-buddy="style"]')
    if (existing !== null) existing.remove()
    const style = document.createElement('style')
    style.setAttribute('data-dsh-grok-buddy', 'style')
    style.textContent = slotStyles(BOT_CLASS, SLOT_ATTR, BOT_SIZE, { reduce }) + '\n' + paletteStyles()
    document.head.appendChild(style)
  }

  // ── 诊断 ────────────────────────────────────────────────────────────────
  /**
   * 采集一份结构化自检。
   *
   * 刻意**不**包含会话标题、正文、工具参数、路径或凭据 —— 只报结构性事实：
   * 身份、相位、判定理由、槽位矩形、可见性、动作是否在跑。
   */
  function collectProbe() {
    const surfaces = collectSurfaces(document)
    const rows = []
    for (const surface of surfaces.sidebar) {
      const display = displayOf(surface)
      const record = mounted.get(surface.slot)
      const rect = surface.slot !== null && typeof surface.slot.getBoundingClientRect === 'function'
        ? surface.slot.getBoundingClientRect()
        : null
      const style = surface.slot !== null && typeof getComputedStyle === 'function' ? getComputedStyle(surface.slot) : null
      rows.push({
        sessionId: surface.sessionId,
        project: surface.workspaceId,
        surface: surface.surface,
        selected: surface.selected === true,
        known: byId.has(surface.sessionId),
        rawPhase: byId.has(surface.sessionId) ? byId.get(surface.sessionId).phase : null,
        phaseOurs: byId.has(surface.sessionId) ? byId.get(surface.sessionId).phase : null,
        dshState: dshRawStateOf(surface.host),
        phase: display.phase,
        reason: display.reason,
        renderedPhase: record !== undefined && record.inst.svg !== null ? record.inst.svg.getAttribute('data-dsgb-phase') : null,
        motion: record !== undefined && record.inst.svg !== null ? record.inst.svg.getAttribute('data-dsgb-motion') : null,
        tone: record !== undefined && record.inst.svg !== null ? record.inst.svg.getAttribute('data-dsgb-tone') : null,
        completionKey: display.completionKey === '' ? null : display.completionKey,
        consumed: display.consumed === true,
        observedAt: typeof display.observedAt === 'number' ? display.observedAt : null,
        slotFound: surface.slot !== null && surface.slot !== undefined,
        slotWidth: rect === null ? null : Math.round(rect.width * 100) / 100,
        slotHeight: rect === null ? null : Math.round(rect.height * 100) / 100,
        rect: rect === null ? null : { width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top), left: Math.round(rect.left) },
        display: style === null ? null : style.display,
        visibility: style === null ? null : style.visibility,
        opacity: style === null ? null : style.opacity,
        animating: record !== undefined && typeof record.dispose === 'function',
        ariaLabel: surface.slot !== null ? surface.slot.getAttribute('aria-label') : null,
        why: display.reason,
      })
    }
    return {
      build: BUILD,
      pageId: PAGE_ID,
      at: Date.now(),
      dark,
      reduced: reduce,
      visible: document.visibilityState === 'visible',
      documentVisible: document.hidden !== true,
      stateRows: byId.size,
      colorsKnown: Object.keys(colors).length,
      rowCount: rows.length,
      mounted: records.size,
      unidentifiableSearch: surfaces.unidentifiable,
      rows,
    }
  }
  window.__dshGrokBuddyProbe = collectProbe

  /**
   * 采样上报：**只在宿主 fork 的一次性窗口里**发。
   *
   * 窗口要页面自己 POST probe-control.json {action:'arm', ms} 打开；
   * 窗口结束（或收到 409）立即停。默认没有任何定时上报。
   */
  async function armProbe(windowMs) {
    const startedAt = Date.now()
    probeWindowUntil = startedAt + windowMs
    try {
      const response = await fetch(PROBE_CONTROL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'arm', ms: windowMs }),
      })
      if (!response.ok) {
        probeWindowUntil = 0
        return false
      }
    } catch (err) {
      probeWindowUntil = 0
      return false
    }
    if (probeSampleTimer === null) {
      probeSampleTimer = setTimeout(postProbeSample, 300)
    }
    return true
  }

  /** 关掉采样窗口并清理定时器。 */
  function disarmProbe() {
    probeWindowUntil = 0
    if (probeSampleTimer !== null) {
      clearTimeout(probeSampleTimer)
      probeSampleTimer = null
    }
  }

  async function postProbeSample() {
    probeSampleTimer = null
    if (stopped) return
    if (probeWindowUntil === 0 || Date.now() > probeWindowUntil) {
      disarmProbe()
      return
    }
    let body
    try {
      body = JSON.stringify(collectProbe())
    } catch (err) {
      return
    }
    try {
      const response = await fetch(PROBE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body,
      })
      if (response.status === 409) {
        // 宿主窗口已关：立刻停，别再发
        disarmProbe()
        return
      }
      probePosted += 1
    } catch (err) {}
    if (stopped || probeWindowUntil === 0) return
    if (Date.now() > probeWindowUntil) {
      disarmProbe()
      return
    }
    probeSampleTimer = setTimeout(postProbeSample, 1000)
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  const observer = new MutationObserver(onChange)
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'class'],
  })
  onDispose(() => observer.disconnect())

  const themeObserver = new MutationObserver(onThemeChange)
  for (const el of [document.documentElement, document.body]) {
    themeObserver.observe(el, { attributes: true, attributeFilter: ['data-ds-theme', 'data-theme', 'class', 'style'] })
  }
  onDispose(() => themeObserver.disconnect())

  const onVisibility = () => {
    if (stopped) return
    if (!document.hidden) {
      onThemeChange()
      loadColors()
      poll()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)
  onDispose(() => document.removeEventListener('visibilitychange', onVisibility))

  const onResize = () => onChange()
  window.addEventListener('resize', onResize)
  onDispose(() => window.removeEventListener('resize', onResize))

  const onBodyClick = (event) => {
    if (stopped) return
    const target = event.target
    if (target !== null && typeof target.closest === 'function') {
      const row = target.closest('[data-row-key^="workspace:"]')
      if (row !== null) lastWorkspaceClick = (row.getAttribute('data-row-key') || '').slice(10)
      else if (target.closest(MENU_SURFACE) === null && target.closest('.dsgb-palette') === null) {
        lastWorkspaceClick = null
      }
    }
    setTimeout(decorateMenus, 0)
  }
  document.addEventListener('click', onBodyClick, true)
  onDispose(() => document.removeEventListener('click', onBodyClick, true))

  syncRows()
  loadColors()
  poll()

  window.__dshGrokBuddy = {
    version: BUILD,
    /** 六态（唯一对外状态集合）。 */
    phases: Object.keys(PHASE_TO_MOTION),
    /** 六态 → 内部动作预设（明确标注这是动画资源，不是状态数量）。 */
    motions: PHASE_TO_MOTION,
    lifecycle: LIFECYCLE,
    /** 阈值同为公开事实，方便核对（不是官网规定，是集中管理的实现参数）。 */
    thresholds: { doneDisplayMs: DONE_DISPLAY_TTL_MS, turnSilenceMs: TURN_SILENCE_TTL_MS, cooldownMs: COOLDOWN_MS },
    defaultInk(workspaceId) {
      return defaultInk(workspaceId === undefined ? '' : workspaceId)
    },
    ink(workspaceId) {
      return inkOfProject(workspaceId === undefined ? '' : workspaceId, dark, colors)
    },
    palette: { inks: IDENTITY_INKS, surface: SURFACE, ungrouped: UNGROUPED_KEY },
    colors() {
      return { ...colors }
    },
    /** 当前所有完成的消费状态（诊断用）。 */
    completions() {
      return [...observedCompletions.keys()].map((key) => ({
        completionKey: key,
        observedAt: observedCompletions.get(key),
        seenAt: seenCompletions.get(key),
        consumed: consumedCompletions.has(key),
      }))
    },
    sync() {
      syncRows()
      decorateMenus()
    },
    probe: collectProbe,
    /** 打开一次性采样窗口（毫秒，不超过 60s）。 */
    armProbe,
    disarmProbe,
    stop() {
      if (stopped) return
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (colorsTimer !== null) clearTimeout(colorsTimer)
      colorsTimer = null
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      disarmProbe()
      closePalette()
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (err) {}
      }
      disposers.length = 0
      for (const record of [...records]) disposeRecord(record)
      records.clear()
      // 插件自有样式、诊断全局对象、自建节点一律清掉
      const style = document.querySelector('style[data-dsh-grok-buddy="style"]')
      if (style !== null) style.remove()
      for (const el of document.querySelectorAll('.dsgb-color-error')) el.remove()
      // 恢复宿主原值：只摘我们自己加的属性，不粗暴清掉别人的 title
      for (const el of document.querySelectorAll('[' + SLOT_ATTR + ']')) {
        el.removeAttribute(SLOT_ATTR)
        if (el.getAttribute('role') === 'img') el.removeAttribute('role')
        el.removeAttribute('aria-label')
      }
      for (const el of document.querySelectorAll('[' + ROW_ATTR + ']')) {
        el.removeAttribute(ROW_ATTR)
        el.removeAttribute(PROJECT_ATTR)
      }
      delete window.__dshGrokBuddy
      delete window.__dshGrokBuddyProbe
    },
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.body !== null) boot()
  else document.addEventListener('DOMContentLoaded', boot, { once: true })
}
