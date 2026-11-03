/**
 * 诊断采样：默认关闭，只接受**一次性采样**与**明确时限的短窗口**。
 *
 * 为什么不默认常开：这是给「一个会话状态不对」取证用的，不是后台监控。
 * 常开的采样会一直把会话标题之类的页面数据往宿主搬，既没必要也不该默认。
 *
 * 契约：
 *   arm(ms)  打开一个窗口，最长 MAX_WINDOW_MS；窗口结束自动关闭（惰性判定，无定时器）；
 *   disarm() 立即关闭并清掉样本；
 *   accept() 只在窗口打开时收样本，超时/未授权的样本直接丢弃并如实回报；
 *   read()   返回最近一份样本 + 它是否已经过期 + 采样窗口状态。
 *
 * 隐私：页面侧只上报结构性事实（相位、理由、DOM 尺寸、是否可见），
 * 不上传会话标题、正文、工具参数、路径或凭据。这里再兜一层：把误传的敏感字段剔掉。
 *
 * @module dsh-grok-buddy/probe
 */

/** 单次窗口上限：1 分钟。够抓一次轮询，不会变成后台常驻。 */
export const MAX_WINDOW_MS = 60 * 1000

/** 样本超过这么久没更新就算过期（不把旧窗口的最后一次上报当当前页面）。 */
export const STALE_SAMPLE_MS = 10 * 1000

/** 允许出现在样本里的顶层字段（白名单；其余一律丢弃）。 */
const ALLOWED_SAMPLE_FIELDS = new Set([
  'build',
  'pageId',
  'at',
  'sampledAt',
  'receivedAt',
  'dark',
  'reduced',
  'visible',
  'documentVisible',
  'stateRows',
  'colorsKnown',
  'rowCount',
  'mounted',
  'rows',
  'notes',
])

/** 允许出现在行样本里的字段。 */
const ALLOWED_ROW_FIELDS = new Set([
  'sessionId',
  'project',
  'selected',
  'surface',
  'known',
  'rawPhase',
  'phaseOurs',
  'dshState',
  'phase',
  'reason',
  'renderedPhase',
  'renderedState',
  'tone',
  'motion',
  'completionKey',
  'consumed',
  'observedAt',
  'completedAt',
  'seen',
  'active',
  'stale',
  'slotFound',
  'slotWidth',
  'slotHeight',
  'rect',
  'display',
  'visibility',
  'opacity',
  'animating',
  'ariaLabel',
  'why',
])

/** 只留白名单字段，其余丢弃（深拷贝，避免把宿主对象带出去）。 */
function pick(source, allowed) {
  const out = {}
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return out
  for (const key of Object.keys(source)) {
    if (allowed.has(key)) out[key] = source[key]
  }
  return out
}

/** 行样本清洗。 */
function cleanRow(row) {
  const out = pick(row, ALLOWED_ROW_FIELDS)
  if (out.rect !== null && typeof out.rect === 'object' && !Array.isArray(out.rect)) {
    out.rect = pick(out.rect, new Set(['width', 'height', 'top', 'left']))
  }
  return out
}

/**
 * 建立诊断采样器。
 * @param {{ now?: () => number }} [options] 时钟。
 * @returns {object} 采样器。
 */
export function createProbeStore(options) {
  const settings = options !== undefined && options !== null ? options : {}
  const now = typeof settings.now === 'function' ? settings.now : () => Date.now()

  /** 采样窗口的关闭时刻；0 表示关闭。 */
  let windowEndsAt = 0
  /** 最近一份被接受的样本。 */
  let last = null
  /** 最近一次被拒绝的原因（可观察，不静默）。 */
  let lastRejection = ''

  /** 窗口是否开着（惰性判定：过期即关）。 */
  function open(at) {
    if (windowEndsAt === 0) return false
    if (at >= windowEndsAt) {
      windowEndsAt = 0
      last = null
      return false
    }
    return true
  }

  /** 打开 / 关闭采样窗口。 */
  function control(payload) {
    const action = payload !== null && typeof payload === 'object' ? payload.action : undefined
    const at = now()
    if (action === 'disarm') {
      windowEndsAt = 0
      last = null
      lastRejection = ''
      return { ok: true }
    }
    if (action !== 'arm') return { ok: false, error: '未知 action（只接受 arm / disarm）' }
    // ms 只接受数字：字符串、NaN、Infinity、负数、0 一律拒绝（不做隐式类型转换）
    if (payload.ms !== undefined && (typeof payload.ms !== 'number' || !Number.isFinite(payload.ms) || payload.ms <= 0)) {
      return { ok: false, error: 'ms 必须是正数' }
    }
    const requested = payload.ms === undefined ? MAX_WINDOW_MS : payload.ms
    windowEndsAt = at + Math.min(requested, MAX_WINDOW_MS)
    return { ok: true }
  }

  /**
   * 收一份样本。
   * @param {object} sample 页面自检结果。
   * @returns {{ok: boolean, status?: number, error?: string, accepted?: boolean, windowEndsAt?: number}} 结果。
   */
  function accept(sample) {
    const at = now()
    if (!open(at)) {
      lastRejection = 'sampling-window-closed'
      return { ok: false, status: 409, error: '诊断采样窗口未打开（先 POST probe-control.json {action:"arm"}）' }
    }
    const clean = pick(sample, ALLOWED_SAMPLE_FIELDS)
    const rows = Array.isArray(sample.rows) ? sample.rows.slice(0, 200).map(cleanRow) : []
    clean.rows = rows
    clean.sampledAt = typeof sample.at === 'number' ? sample.at : at
    clean.receivedAt = at
    last = clean
    lastRejection = ''
    return { ok: true, accepted: true, windowEndsAt }
  }

  /** 读最近一份样本与窗口状态。 */
  function read() {
    const at = now()
    const isOpen = open(at)
    const present = last !== null
    const age = present ? at - last.receivedAt : null
    return {
      windowOpen: isOpen,
      windowEndsAt: windowEndsAt === 0 ? null : windowEndsAt,
      stale: present ? age > STALE_SAMPLE_MS : false,
      ageMs: age,
      lastRejection: lastRejection === '' ? null : lastRejection,
      probe: present ? last : null,
    }
  }

  return { accept, read, control }
}
