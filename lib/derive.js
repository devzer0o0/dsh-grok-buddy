/**
 * dsh-grok-buddy —— 会话状态到表情相位的纯逻辑内核。
 *
 * 输入是宿主 firehose 上的两类事实：
 *   1. session/event：turn、step 边界，工具调用与结果，审批询问，重试，报错
 *   2. agent/status 与 agent/error：agent 是否在跑、崩没崩
 *
 * 输出是每个会话一个相位（phase），也就是侧栏那张脸：
 *
 *   idle       安静（没有活动）
 *   thinking   思考中（已发请求，等首 token 或正在推演）
 *   streaming  说话中（模型正在吐字）
 *   tool       干活中（工具在跑）
 *   waiting    等你（审批挂起，轮到人）
 *   retry      重试中（LLM 请求失败后正在退避重试）
 *   error      失败（本轮以错误收场）
 *   completed  完成（刚做完，还没被看过）
 *
 * 这里不碰 DOM、不碰网络，纯折叠，方便单测。
 *
 * @module dsh-grok-buddy/derive
 */

/** 相位枚举。 */
export const PHASES = Object.freeze([
  'idle',
  'thinking',
  'streaming',
  'tool',
  'waiting',
  'retry',
  'error',
  'completed',
])

/** 一轮没有新事件超过这么久，即使 turn 没收尾也视为结束（毫秒）。 */
export const STALE_TURN_MS = 15 * 60 * 1000

/**
 * 新建一个会话状态。
 * @param {string} id 会话 id。
 * @param {number} now 当前时间戳。
 * @returns {object} 可折叠的状态对象。
 */
export function createSessionState(id, now) {
  return {
    id,
    title: '',
    cwd: '',
    dir: '',
    turn: 0,
    step: 0,
    /** 是否有一轮正在进行（turn/start 已发生、turn/end 未发生）。 */
    turnOpen: false,
    /** agent 是否在跑（agent/status 是权威信号）。 */
    agentRunning: false,
    /** 本步是否已收到流式输出。 */
    streaming: false,
    /** 尚未返回结果的工具：callId 到 { name, at }。 */
    tools: new Map(),
    /** 挂着的审批询问。 */
    pending: undefined,
    /** 最近一次 LLM 重试。 */
    retry: undefined,
    /** 本轮的致命错误。 */
    error: undefined,
    /** 本轮正常收尾的时间。 */
    completedAt: undefined,
    /** 本轮工具失败次数。 */
    failures: 0,
    lastToolError: undefined,
    events: 0,
    startedAt: now,
    lastAt: now,
    phase: 'idle',
    phaseSince: now,
  }
}

/** 取 cwd 的末级目录名。 */
export function dirName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const parts = cwd.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts.length === 0 ? cwd : parts[parts.length - 1]
}

/** 从错误对象或错误链里尽量取出一个短代号。 */
export function shortCode(error) {
  if (error === null || typeof error !== 'object') return ''
  if (typeof error.code === 'string' && error.code !== '') return error.code
  const nested = error.error !== undefined ? error.error : error.cause
  if (nested !== undefined && nested !== error) return shortCode(nested)
  return ''
}

/**
 * 把一条会话事件折进状态（就地修改）。
 * @param {object} state createSessionState 的产物。
 * @param {object} event 形如 { type, data, time, seq } 的会话事件。
 * @param {number} now 当前时间戳。
 * @returns {object} 同一个 state。
 */
export function applySessionEvent(state, event, now) {
  if (event === null || typeof event !== 'object') return state
  const type = event.type
  const raw = event.data
  const data = raw !== null && typeof raw === 'object' ? raw : {}
  state.events += 1
  state.lastAt = now

  switch (type) {
    case 'turn/start': {
      state.turnOpen = true
      state.turn = typeof data.turn === 'number' ? data.turn : state.turn + 1
      state.step = 0
      state.streaming = false
      state.error = undefined
      state.retry = undefined
      state.completedAt = undefined
      state.failures = 0
      state.lastToolError = undefined
      state.tools.clear()
      state.pending = undefined
      state.startedAt = now
      break
    }
    case 'step/start': {
      state.turnOpen = true
      if (typeof data.turn === 'number') state.turn = data.turn
      if (typeof data.step === 'number') state.step = data.step
      state.streaming = false
      if (state.retry !== undefined) state.retry = undefined
      break
    }
    case 'assistant/message': {
      state.streaming = false
      break
    }
    case 'tool/call': {
      const callId = typeof data.callId === 'string' ? data.callId : ''
      if (callId !== '') {
        state.tools.set(callId, {
          name: typeof data.name === 'string' ? data.name : '',
          at: now,
        })
      }
      break
    }
    case 'tool/result': {
      const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
      const source = message.source !== null && typeof message.source === 'object' ? message.source : {}
      const callId = typeof source.callId === 'string' ? source.callId : ''
      const opened = callId === '' ? undefined : state.tools.get(callId)
      if (callId !== '') state.tools.delete(callId)
      if (message.isError === true || data.error !== undefined) {
        state.failures += 1
        state.lastToolError = {
          name: opened !== undefined ? opened.name : '',
          code: shortCode(data.error) || shortCode(message.error) || '',
          at: now,
        }
      }
      break
    }
    case 'approval/asked': {
      state.pending = {
        toolName: typeof data.toolName === 'string' ? data.toolName : '',
        at: now,
      }
      break
    }
    case 'approval/decided': {
      state.pending = undefined
      break
    }
    case 'llm/retry': {
      state.retry = {
        count: typeof data.retry === 'number' ? data.retry : 1,
        max: typeof data.maxRetries === 'number' ? data.maxRetries : 0,
        code: shortCode(data.failure),
        at: now,
        started: false,
      }
      break
    }
    case 'llm/retry-started': {
      if (state.retry !== undefined) state.retry.started = true
      break
    }
    case 'turn/end': {
      state.turnOpen = false
      state.streaming = false
      state.tools.clear()
      state.pending = undefined
      state.retry = undefined
      const reason = data.reason !== null && typeof data.reason === 'object' ? data.reason : {}
      if (reason.kind === 'error') {
        state.error = {
          code: shortCode(reason.error) || 'ERROR',
          message: typeof reason.error === 'object' && reason.error !== null && typeof reason.error.message === 'string'
            ? reason.error.message
            : '',
          at: now,
        }
        state.completedAt = undefined
      } else {
        state.error = undefined
        state.completedAt = now
      }
      break
    }
    case 'session/title': {
      if (typeof data.title === 'string' && data.title.trim() !== '') state.title = data.title.trim()
      break
    }
    case 'working-directory/change': {
      if (typeof data.cwd === 'string') {
        state.cwd = data.cwd
        state.dir = dirName(data.cwd)
      }
      break
    }
    default:
      break
  }
  return state
}

/**
 * 折叠一条流式分片：模型开始吐字了。
 * @param {object} state 会话状态。
 * @param {number} now 当前时间戳。
 * @returns {object} 同一个 state。
 */
export function applyStreamChunk(state, now) {
  state.streaming = true
  state.lastAt = now
  return state
}

/**
 * 折叠 agent 级信号（不是会话事件）。
 * @param {object} state 会话状态。
 * @param {string} kind status 或 error。
 * @param {object} payload 载荷。
 * @param {number} now 当前时间戳。
 * @returns {object} 同一个 state。
 */
export function applyAgentSignal(state, kind, payload, now) {
  state.lastAt = now
  if (kind === 'status') {
    const running = payload !== undefined && payload !== null && payload.status === 'running'
    state.agentRunning = running
    if (running) {
      state.error = undefined
      state.completedAt = undefined
    }
    return state
  }
  if (kind === 'error') {
    const error = payload !== undefined && payload !== null ? payload.error : undefined
    state.error = {
      code: shortCode(error) || 'ERROR',
      message: error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : '',
      at: now,
    }
    return state
  }
  return state
}

/**
 * 由状态推导当前相位。
 * @param {object} state 会话状态。
 * @param {number} now 当前时间戳。
 * @returns {string} 相位名。
 */
export function phaseOf(state, now) {
  const stale = now - state.lastAt > STALE_TURN_MS
  const active = !stale && (state.turnOpen || state.agentRunning)
  if (active && state.pending !== undefined) return 'waiting'
  if (active) {
    if (state.retry !== undefined && state.retry.started !== true) return 'retry'
    if (state.tools.size > 0) return 'tool'
    if (state.streaming) return 'streaming'
    return 'thinking'
  }
  if (state.error !== undefined) return 'error'
  if (state.completedAt !== undefined) return 'completed'
  return 'idle'
}

/**
 * 相位对应的短细节（给 tooltip 用）。
 * @param {object} state 会话状态。
 * @param {string} phase 当前相位。
 * @returns {string} 细节文本，可能为空串。
 */
export function detailOf(state, phase) {
  switch (phase) {
    case 'tool': {
      if (state.tools.size === 0) return ''
      const names = []
      for (const tool of state.tools.values()) {
        if (tool.name !== '' && names.indexOf(tool.name) === -1) names.push(tool.name)
      }
      if (names.length === 0) return state.tools.size > 1 ? String(state.tools.size) : ''
      return names.length > 1 ? names[0] + ' +' + (names.length - 1) : names[0]
    }
    case 'waiting':
      return state.pending !== undefined ? state.pending.toolName : ''
    case 'retry': {
      const retry = state.retry
      if (retry === undefined) return ''
      const count = retry.max > 0 ? retry.count + '/' + retry.max : String(retry.count)
      return retry.code === '' ? count : retry.code + ' / ' + count
    }
    case 'error':
      return state.error !== undefined ? state.error.code : ''
    case 'streaming':
    case 'thinking':
      return state.step > 0 ? 'step ' + state.step : ''
    case 'completed':
      return state.failures > 0 ? state.failures + ' tool errors' : ''
    default:
      return ''
  }
}

/**
 * 建立登记表：把会话事件折成可按需读取的快照。
 * @param {{ now?: () => number, ttlMs?: number }} [options] 时钟与回收阈值。
 * @returns {object} 登记表。
 */
export function createRegistry(options) {
  const settings = options !== undefined && options !== null ? options : {}
  const now = typeof settings.now === 'function' ? settings.now : () => Date.now()
  const ttlMs = typeof settings.ttlMs === 'number' ? settings.ttlMs : 6 * 60 * 60 * 1000
  const sessions = new Map()

  function ensure(id) {
    if (typeof id !== 'string' || id === '') return undefined
    let state = sessions.get(id)
    if (state === undefined) {
      state = createSessionState(id, now())
      sessions.set(id, state)
    }
    return state
  }

  /**
   * 折入一条会话事件。
   * @param {object} session 宿主 Session（只读 id 与 header.cwd）。
   * @param {object} event 会话事件。
   */
  function onEvent(session, event) {
    const id = session !== undefined && session !== null ? session.id : undefined
    const state = ensure(id)
    if (state === undefined) return
    const header = session !== undefined && session !== null ? session.header : undefined
    if (state.cwd === '' && header !== undefined && header !== null && typeof header.cwd === 'string') {
      state.cwd = header.cwd
      state.dir = dirName(state.cwd)
    }
    applySessionEvent(state, event, now())
  }

  /**
   * 折入 agent 级信号。
   * @param {string} sessionId 会话 id。
   * @param {string} kind status 或 error。
   * @param {object} payload 载荷。
   */
  function onAgent(sessionId, kind, payload) {
    const state = ensure(sessionId)
    if (state === undefined) return
    applyAgentSignal(state, kind, payload, now())
  }

  /** 读取当前快照：维护相位与相位起点，并回收久未活动的会话。 */
  function snapshot() {
    const at = now()
    const rows = []
    for (const entry of sessions) {
      const id = entry[0]
      const state = entry[1]
      if (at - state.lastAt > ttlMs && !state.turnOpen) {
        sessions.delete(id)
        continue
      }
      const phase = phaseOf(state, at)
      if (phase !== state.phase) {
        state.phase = phase
        state.phaseSince = at
      }
      const row = {
        id,
        phase,
        detail: detailOf(state, phase),
        since: state.phaseSince,
        updatedAt: state.lastAt,
        running: state.turnOpen || state.agentRunning,
      }
      if (phase === 'completed' && state.completedAt !== undefined) row.completedAt = state.completedAt
      rows.push(row)
    }
    rows.sort((left, right) => right.updatedAt - left.updatedAt)
    return { now: at, sessions: rows }
  }

  /**
   * 折入一条流式分片。
   * @param {string} sessionId 会话 id。
   */
  function onStream(sessionId) {
    const state = ensure(sessionId)
    if (state === undefined) return
    applyStreamChunk(state, now())
  }

  /** 调试用：拿到原始状态（只读用途）。 */
  function peek(id) {
    return sessions.get(id)
  }

  return { onEvent, onAgent, onStream, snapshot, peek }
}
