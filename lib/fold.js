/**
 * dsh-grok-buddy —— 会话事件 → 事实折叠。
 *
 * 这里只回答一个问题：**发生了什么事实**。展示状态由 src/decision.js 统一算，
 * 这个模块永远不返回相位名。
 *
 * 身份规则（踩过坑，必须钉死）：
 *   · 每个会话的「当前轮」用 turnKey（sessionId + turn）标识；
 *   · 旧 turn 的 step/stream/tool/result 迟到时**不能**污染新 turn；
 *   · 重复 turn/end 不生成新的完成周期（completionKey 相同即同一条记录）；
 *   · 新 turn 开始会替代旧终态事实，但**不删除**历史完成记录本身（页面侧另有消费表）。
 *
 * @module dsh-grok-buddy/fold
 */

import { completionKeyOf, emptyFacts, endingOf } from '../src/decision.js'

/** 交互类事件：审批、提问（含 plan-review）都走这两类真实宿主事件。 */
export const INTERACTION_KIND = Object.freeze({
  approval: 'approval',
  question: 'question',
  'plan-review': 'plan-review',
})

/** 只有这些事件算「执行类证据」，会推进 lastActivityAt。 */
const ACTIVITY_EVENTS = new Set([
  'turn/start',
  'step/start',
  'step/end',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'approval/asked',
  'approval/decided',
  'llm/retry',
  'llm/retry-started',
  'turn/end',
])

/**
 * 新建一个会话的折叠状态。
 * @param {string} id 会话 id。
 * @param {number} now 当前时间戳。
 * @returns {object} 可折叠状态（含事实与元信息）。
 */
export function createSessionState(id, now) {
  const facts = emptyFacts(id)
  facts.lastActivityAt = now
  facts.sampledAt = now
  return {
    id,
    facts,
    title: '',
    cwd: '',
    dir: '',
    /** 见过几次 turn/start —— 用来判断「插件是不是中途接入」。 */
    turnsSeen: 0,
    lastEventType: '',
    lastAt: now,
    startedAt: now,
    /** 历史完成记录的本地留档（不被新 turn 删除）。 */
    completions: [],
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

/** 组出当前轮的稳定身份。 */
function turnKeyOf(state, turn) {
  const value = typeof turn === 'number' && Number.isFinite(turn) ? turn : state.facts.turn
  return state.id + '#' + String(value === undefined ? 0 : value)
}

/** 交互事件的归一：把宿主的真实事件翻译成 { kind, toolName }。 */
function interactionOf(type, data) {
  if (type === 'approval/asked') {
    return {
      kind: 'approval',
      toolName: typeof data.toolName === 'string' ? data.toolName : '',
      key: typeof data.id === 'string' ? data.id : '',
    }
  }
  if (type === 'question/asked') {
    const questions = Array.isArray(data.questions) ? data.questions : []
    const first = questions.length > 0 && questions[0] !== null && typeof questions[0] === 'object' ? questions[0] : {}
    const intent = first.intent !== null && typeof first.intent === 'object' ? first.intent : {}
    const isPlanReview = intent.kind === 'plan-review' || first.id === 'plan-review'
    return {
      kind: isPlanReview ? 'plan-review' : 'question',
      toolName: typeof data.toolName === 'string' ? data.toolName : 'ask_user_question',
      key: typeof data.id === 'string' ? data.id : typeof data.callId === 'string' ? data.callId : '',
    }
  }
  return undefined
}

/**
 * 把一条会话事件折进状态（就地修改 facts）。
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
  const f = state.facts

  state.lastAt = now
  state.lastEventType = typeof type === 'string' ? type : ''
  f.sampledAt = now
  if (ACTIVITY_EVENTS.has(type)) f.lastActivityAt = now

  // 事件携带的 turn 号：用于判断这条事件属于哪一轮。
  const eventTurn = typeof data.turn === 'number' && Number.isFinite(data.turn) ? data.turn : undefined
  const eventTurnKey = eventTurn === undefined ? '' : state.id + '#' + String(eventTurn)
  const staleTurn = eventTurnKey !== '' && f.turnKey !== '' && eventTurnKey !== f.turnKey

  switch (type) {
    case 'turn/start': {
      const turn = eventTurn === undefined ? f.turn + 1 : eventTurn
      // 新的一轮：旧的终态/错误/交互/工具一律作废（同一轮的重复 start 是幂等的）
      const sameTurn = f.turnOpen === true && f.turnKey === state.id + '#' + String(turn)
      f.turn = turn
      f.turnKey = state.id + '#' + String(turn)
      f.turnOpen = true
      f.terminal = undefined
      f.error = undefined
      f.pendingInteraction = undefined
      f.tools = []
      f.modelPhase = 'requested'
      f.lastActivityAt = now
      if (!sameTurn) {
        state.turnsSeen += 1
        state.startedAt = now
      }
      break
    }
    case 'step/start': {
      if (staleTurn) break
      f.turnOpen = true
      if (eventTurn !== undefined) {
        f.turn = eventTurn
        f.turnKey = state.id + '#' + String(eventTurn)
      }
      f.modelPhase = 'requested'
      break
    }
    case 'step/end': {
      if (staleTurn) break
      break
    }
    case 'assistant/message': {
      if (staleTurn) break
      f.modelPhase = 'generating'
      break
    }
    case 'assistant/attempt': {
      if (staleTurn) break
      f.modelPhase = 'requested'
      break
    }
    case 'tool/call': {
      if (staleTurn) break
      const callId = typeof data.callId === 'string' ? data.callId : ''
      if (callId === '') break
      if (f.tools.some((tool) => tool.callId === callId)) break
      f.tools.push({
        callId,
        name: typeof data.name === 'string' ? data.name : '',
        at: now,
      })
      break
    }
    case 'tool/result': {
      if (staleTurn) break
      const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
      const source = message.source !== null && typeof message.source === 'object' ? message.source : {}
      const callId =
        typeof source.callId === 'string' && source.callId !== ''
          ? source.callId
          : typeof message.toolCallId === 'string'
            ? message.toolCallId
            : ''
      const opened = callId === '' ? undefined : f.tools.find((tool) => tool.callId === callId)
      if (callId !== '') f.tools = f.tools.filter((tool) => tool.callId !== callId)
      const failed = message.isError === true || data.error !== undefined
      if (failed) {
        f.error = {
          kind: 'tool',
          code: shortCode(data.error) || shortCode(message.error) || '',
          message: '',
          toolName: opened === undefined ? '' : opened.name,
          at: now,
          turnKey: f.turnKey,
        }
      } else {
        // 成功的结果把**同轮**的旧错误清掉：历史错误不能永久霸占 blocked。
        if (f.error !== undefined && f.error !== null && f.error.turnKey === f.turnKey) f.error = undefined
      }
      // 工具返回后模型要接着推理
      f.modelPhase = 'requested'
      break
    }
    case 'approval/asked':
    case 'question/asked': {
      if (staleTurn) break
      const interaction = interactionOf(type, data)
      if (interaction === undefined) break
      f.pendingInteraction = {
        kind: interaction.kind,
        toolName: interaction.toolName,
        key: interaction.key,
        at: now,
        turnKey: f.turnKey,
      }
      break
    }
    case 'approval/decided':
    case 'question/answered':
    case 'question/cancelled': {
      f.pendingInteraction = undefined
      f.modelPhase = 'requested'
      break
    }
    case 'llm/retry': {
      if (staleTurn) break
      f.error = {
        kind: 'retry',
        code: shortCode(data.failure) || 'RETRY',
        message: '',
        toolName: '',
        at: now,
        turnKey: f.turnKey,
        retrying: true,
      }
      break
    }
    case 'llm/retry-started': {
      if (staleTurn) break
      // 重试真正开跑：错误事实退场，回到模型阶段
      if (f.error !== undefined && f.error !== null && f.error.kind === 'retry') f.error = undefined
      f.modelPhase = 'requested'
      break
    }
    case 'turn/end': {
      const ending = endingOf(data.reason !== null && typeof data.reason === 'object' ? data.reason.kind : undefined)
      const reason = data.reason !== null && typeof data.reason === 'object' ? data.reason : {}
      // 迟到的旧轮 end：不能覆盖当前轮的终态
      if (eventTurnKey !== '' && f.turnKey !== '' && eventTurnKey !== f.turnKey) break
      if (eventTurn !== undefined) {
        f.turn = eventTurn
        f.turnKey = state.id + '#' + String(eventTurn)
      }
      f.turnOpen = false
      f.tools = []
      f.pendingInteraction = undefined
      f.modelPhase = 'none'
      if (ending === 'success') {
        const terminal = {
          kind: 'completed',
          turnKey: f.turnKey,
          at: now,
          // completedAt 只写一次（折叠这条 turn/end 的这一刻），之后永不重算 ——
          // 宿主给了事件时间就用它，没给就用这次折叠的时间。两者都是「真实完成时刻」，
          // 不是每轮轮询重新读的 Date.now()。
          completedAt: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : now,
          observedAt: now,
        }
        terminal.completionKey = completionKeyOf(state.id, terminal)
        // 重复 turn/end：同一 completionKey 不生成新的完成周期
        maybeRecordCompletion(state, terminal, now)
        f.terminal = terminal
        f.error = undefined
      } else if (ending === 'failure') {
        const errorBody = reason.error !== null && typeof reason.error === 'object' ? reason.error : {}
        f.terminal = { kind: 'error', turnKey: f.turnKey, at: now, code: shortCode(errorBody) || 'ERROR' }
        f.error = {
          kind: 'turn',
          code: shortCode(errorBody) || 'ERROR',
          message: typeof errorBody.message === 'string' ? errorBody.message : '',
          toolName: '',
          at: now,
          turnKey: f.turnKey,
        }
      } else {
        // 取消 / 截断 / 未知：既不是成功，也不是「已阻止」
        f.terminal = { kind: 'interrupted', turnKey: f.turnKey, at: now, code: typeof reason.kind === 'string' ? reason.kind : 'unknown' }
        f.error = undefined
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

/** 把一条完成事实记进历史留档；同一 completionKey 只记一次。 */
function maybeRecordCompletion(state, terminal, now) {
  const key = terminal.completionKey
  if (typeof key !== 'string' || key === '') return
  if (state.completions.some((item) => item.completionKey === key)) return
  state.completions.push({
    completionKey: key,
    turnKey: terminal.turnKey,
    completedAt: terminal.completedAt,
    observedAt: now,
  })
  if (state.completions.length > 20) state.completions.shift()
}

/**
 * 折叠一条流式分片：模型开始吐字 = 生成阶段。
 * @param {object} state 会话状态。
 * @param {number} now 当前时间戳。
 * @returns {object} 同一个 state。
 */
export function applyStreamChunk(state, now) {
  if (state === null || state === undefined) return state
  const f = state.facts
  state.lastAt = now
  f.sampledAt = now
  f.lastActivityAt = now
  f.modelPhase = 'generating'
  return state
}

/**
 * 折叠 agent 级信号。
 *
 * ⚠️ **agent status 不能清 completedAt**：DSH 里 agent 收尾通常比 turn/end 晚一拍，
 * 清掉完成标记会让 done 根本显示不出来。完成事实只由 turn/start（真开新一轮）清。
 *
 * @param {object} state 会话状态。
 * @param {string} kind status 或 error。
 * @param {object} payload 载荷。
 * @param {number} now 当前时间戳。
 * @returns {object} 同一个 state。
 */
export function applyAgentSignal(state, kind, payload, now) {
  if (state === null || state === undefined) return state
  const f = state.facts
  state.lastAt = now
  f.sampledAt = now
  if (kind === 'status') {
    const running = payload !== undefined && payload !== null && payload.status === 'running'
    f.agentRunning = running
    // agent 又跑起来：只清「同轮」的旧错误，不动完成事实
    if (running && f.error !== undefined && f.error !== null && f.error.turnKey === f.turnKey) f.error = undefined
    return state
  }
  if (kind === 'error') {
    const error = payload !== undefined && payload !== null ? payload.error : undefined
    f.error = {
      kind: 'agent',
      code: shortCode(error) || 'ERROR',
      message: error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : '',
      toolName: '',
      at: now,
      turnKey: f.turnKey,
    }
    f.lastActivityAt = now
    return state
  }
  return state
}

/**
 * 相位对应的短细节（tooltip 用）。细节描述事实，不是状态名。
 * @param {object} facts 事实。
 * @param {string} phase 已判定的相位。
 * @returns {string} 细节文本，可能为空串。
 */
export function detailOf(facts, phase) {
  const f = facts !== undefined && facts !== null ? facts : emptyFacts('')
  switch (phase) {
    case 'working': {
      const names = []
      const tools = Array.isArray(f.tools) ? f.tools : []
      for (const tool of tools) {
        if (tool.name !== '' && names.indexOf(tool.name) === -1) names.push(tool.name)
      }
      if (names.length === 0) return tools.length > 1 ? String(tools.length) : ''
      return names.length > 1 ? names[0] + ' +' + (names.length - 1) : names[0]
    }
    case 'waiting': {
      const pending = f.pendingInteraction
      if (pending === undefined || pending === null) return ''
      if (pending.toolName !== '') return pending.toolName
      return pending.kind === 'plan-review' ? 'plan review' : pending.kind === 'question' ? 'question' : 'approval'
    }
    case 'blocked': {
      const error = f.error
      if (error === undefined || error === null) return ''
      if (error.toolName !== '' && error.code !== '') return error.toolName + ' / ' + error.code
      if (error.code !== '') return error.code
      return error.toolName
    }
    default:
      return ''
  }
}
