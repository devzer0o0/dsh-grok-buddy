/**
 * dsh-grok-buddy —— 会话事件 → 事实折叠。
 *
 * 这里只回答一个问题：**发生了什么事实**。展示状态由 src/decision.js 统一算，
 * 这个模块永远不返回相位名。
 *
 * 三类「错误相关」事实必须分开（这是本次语义替换的核心）：
 *
 *   A. 诊断  facts.error   某次工具调用/请求/重试报了什么错。
 *                          只给人看，**不参与任何判定**。
 *   B. 自动恢复  facts.retry  当前轮是否仍有有效的重试调度/正在重试。
 *                          它让任务保持 thinking；它本身不产生停止事实。
 *   C. 任务级停止  facts.stop  哪一轮、因什么错、由哪个权威事实确认停下。
 *                          只有它能推出 blocked（见 decision.js 的 currentStop）。
 *
 * 身份规则（踩过坑，必须钉死）：
 *   · 每个会话的「当前轮」用 turnKey（sessionId + turn）标识；
 *   · 旧 turn 的任何事件都**不能**污染新 turn，也不能给当前轮续命；
 *   · 重复 turn/end 不生成新的完成周期（completionKey 相同即同一条记录）；
 *   · 新 turn 开始替代旧终态与旧停止事实，但**不删除**历史完成记录本身。
 *
 * @module dsh-grok-buddy/fold
 */

import {
  STOP_SOURCES,
  SYSTEM_CANCEL_CAUSES,
  completionKeyOf,
  emptyFacts,
  endingOf,
  isSuccessTerminal,
} from '../src/decision.js'

/** 交互类事件：审批、提问（含 plan-review）都走这两类真实宿主事件。 */
export const INTERACTION_KIND = Object.freeze({
  approval: 'approval',
  question: 'question',
  'plan-review': 'plan-review',
})

/**
 * 交互式工具：它们「在运行」的意思是**在等人**，不是在工作。
 * 两处真实来源之一（另一处是 userQuestions 投影，只覆盖带 timeout 的提问）。
 */
const INTERACTION_TOOLS = Object.freeze({
  ask_user_question: 'question',
  exit_plan_mode: 'plan-review',
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
 * 能推翻**已确认**停止事实的证据：只有「又开始执行了」这一类。
 *
 * 审批、错误、标题、状态位都不在此列 —— 它们不证明执行恢复；
 * tool/result 与流式分片也不在列：执行器停下来之后，旧尝试的迟到结果
 * 与迟到分片都会继续送达，它们不代表任务重新开始。
 */
const RESUME_EVENTS = new Set([
  'step/start',
  'assistant/attempt',
  'tool/call',
  'llm/retry',
  'llm/retry-started',
])

/**
 * 能推翻**暂定**停止（只收到 agent/error、尚未确认）的证据。
 * 比 RESUME_EVENTS 宽：任何新的执行痕迹都说明「还没停下」。
 */
const PROGRESS_EVENTS = new Set([
  ...RESUME_EVENTS,
  'assistant/message',
  'tool/result',
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
    /** 已应用事件的最大 seq（-1 = 还没应用过）。seq 门闸的唯一依据。 */
    lastSeq: -1,
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

/**
 * 事件的执行身份。
 *
 * 优先用宿主给的 seq（会话事件是**持久有序**的，见 SessionEvent.seq），
 * 没有 seq 时才退到折叠序号。这样「迟到的旧事件」「重复的同一事件」
 * 都能靠身份区分，而不是靠我们本地收到的时刻。
 *
 * @param {object} state 会话状态。
 * @param {object} event 会话事件。
 * @returns {string} 证据身份。
 */
function evidenceIdOf(state, event) {
  if (event !== null && typeof event === 'object' && typeof event.seq === 'number' && Number.isFinite(event.seq)) {
    return state.id + '#' + String(event.seq)
  }
  state.evidenceSeq = (typeof state.evidenceSeq === 'number' ? state.evidenceSeq : 0) + 1
  return state.id + '~' + String(state.evidenceSeq)
}

/** 事件携带的错误是哪一类：'user' | 'system' | 'none'。 */
function cancelCauseOf(reason) {
  if (reason === null || typeof reason !== 'object') return 'none'
  const cause = reason.reason
  if (cause === null || typeof cause !== 'object') return 'none'
  if (cause.kind === 'user') return 'user'
  if (typeof cause.kind !== 'string') return 'none'
  // legacy（原因不明）不补成系统原因 —— 不猜测。
  if (cause.kind === 'legacy') return 'none'
  return SYSTEM_CANCEL_CAUSES.indexOf(cause.kind) === -1 ? 'none' : 'system'
}

/**
 * 把「交互集合」投影成单个槽位（兼容既有读法）。
 *
 * pendingInteractions 是事实，pendingInteraction 是它的第一个 —— 任何写集合的
 * 地方都必须调用这里，避免两个字段各说各话。
 *
 * @param {object} f 事实。
 * @returns {object} 同一个 facts。
 */
export function syncPendingSlot(f) {
  const list = Array.isArray(f.pendingInteractions) ? f.pendingInteractions : []
  f.pendingInteractions = list
  f.pendingInteraction = list.length > 0 ? list[0] : undefined
  return f
}

/** 往集合里加一条交互（按 key 去重；没有 key 时按 kind+toolName 去重）。 */
function addPending(f, entry) {
  if (!Array.isArray(f.pendingInteractions)) f.pendingInteractions = []
  const key = typeof entry.key === 'string' ? entry.key : ''
  const exists = f.pendingInteractions.some((item) =>
    key !== '' ? item.key === key : item.kind === entry.kind && item.toolName === entry.toolName,
  )
  if (!exists) f.pendingInteractions.push(entry)
  return syncPendingSlot(f)
}

/**
 * 从集合里移除一条交互。
 *
 * 有身份时只删匹配的那条；没有身份（宿主没给 id）时才按轮次清掉同轮的。
 *
 * @param {object} f 事实。
 * @param {object} filter { key, kind, turnKey }。
 * @returns {number} 删掉的条数。
 */
function removePending(f, filter) {
  const list = Array.isArray(f.pendingInteractions) ? f.pendingInteractions : []
  const key = typeof filter.key === 'string' ? filter.key : ''
  const kind = typeof filter.kind === 'string' ? filter.kind : ''
  const before = list.length
  f.pendingInteractions = list.filter((item) => {
    if (key !== '') return item.key !== key
    if (kind !== '') return item.kind !== kind
    return false
  })
  syncPendingSlot(f)
  return before - f.pendingInteractions.length
}

/**
 * 解决事件 → 它结束的是哪一类交互。
 * @param {string} type 事件类型。
 * @returns {string} 'approval' | 'question' | ''。
 */
function interactionKindOf(type) {
  if (type === 'approval/decided') return 'approval'
  if (type === 'question/answered' || type === 'question/cancelled') return 'question'
  return ''
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
 * 写一条**已确认**的任务级错误停止（幂等）。
 *
 * @param {object} f 事实。
 * @param {object} entry { turnKey, source, code, evidenceId, stoppedAt, cancelCause? }。
 * @returns {boolean} 是否真的写了新事实（重复事件返回 false）。
 */
function confirmStop(f, entry) {
  const current = f.stop
  if (
    current !== undefined &&
    current !== null &&
    current.certain === true &&
    current.turnKey === entry.turnKey &&
    typeof current.evidenceId === 'string' &&
    current.evidenceId !== '' &&
    current.evidenceId === entry.evidenceId
  ) {
    // 同一个证据重复送达：**不刷新** stoppedAt、也不生成新事实。
    // （暂定的那条要允许被同一个证据升级成确认，所以这里只对 certain 幂等。）
    return false
  }
  f.stop = {
    turnKey: entry.turnKey,
    source: entry.source,
    cause: 'error',
    code: typeof entry.code === 'string' && entry.code !== '' ? entry.code : 'ERROR',
    evidenceId: typeof entry.evidenceId === 'string' ? entry.evidenceId : '',
    certain: true,
    stoppedAt: entry.stoppedAt,
    cancelCause: typeof entry.cancelCause === 'string' ? entry.cancelCause : '',
  }
  // 已确认的停止说明这一轮**不再有**自动恢复流程（重试会先回到 step 才继续）。
  f.retry = undefined
  f.modelPhase = 'none'
  return true
}

/** 写一条**暂定**停止（只收到 agent/error，生命周期尚未确认）。 */
function tentativeStop(f, entry) {
  const current = f.stop
  if (current !== undefined && current !== null && current.certain === true && current.turnKey === f.turnKey) {
    // 已经有确认过的停止：迟到的暂定事实不能把它降级或改写原因。
    return false
  }
  f.stop = {
    turnKey: entry.turnKey,
    source: STOP_SOURCES.AGENT_ERROR,
    cause: 'error',
    code: typeof entry.code === 'string' && entry.code !== '' ? entry.code : 'ERROR',
    evidenceId: typeof entry.evidenceId === 'string' ? entry.evidenceId : '',
    certain: false,
    stoppedAt: entry.stoppedAt,
    cancelCause: '',
  }
  return true
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

  // ── ① seq 门闸（折叠器唯一的时序权威）──────────────────────────────────
  // 会话事件由宿主持久有序地追加（SessionEvent.seq 单调）。同一条事件的重复送达、
  // 迟到的旧事件、乱序送达，都必然满足 seq <= 已应用最大值 —— 整条忽略，不落任何事实。
  // 没有 seq 的事件（旧宿主 / 测试夹具）退化为原有的语义守卫，行为不变。
  const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : undefined
  if (seq !== undefined) {
    if (seq <= state.lastSeq) return state
    state.lastSeq = seq
  }

  // 「收到事件」的诊断时间与「当前轮有执行活动」是两件事，必须在身份校验之后才落后者。
  state.lastAt = now
  state.lastEventType = typeof type === 'string' ? type : ''
  f.sampledAt = now

  // 事件携带的 turn 号：用于判断这条事件属于哪一轮。
  const eventTurn = typeof data.turn === 'number' && Number.isFinite(data.turn) ? data.turn : undefined
  const eventTurnKey = eventTurn === undefined ? '' : state.id + '#' + String(eventTurn)
  const staleTurn = eventTurnKey !== '' && f.turnKey !== '' && eventTurnKey !== f.turnKey

  // ── ② 封账（turn/end 落定后，这一轮不再接受任何同轮事件）────────────────
  // 真实宿主里 turn/end 写在 turn() 的 finally：本轮之后不可能再有 step/start、
  // tool/call、retry 之类的执行证据。执行器停下后还会继续送达的，只有旧尝试的
  // 迟到结果与迟到分片 —— 它们不代表任务重新开始，绝不能复活任务或抹掉已确认的停止。
  // 「真实恢复」只有一种形态：下一轮 turn/start（走 turn/start 的新一轮分支）。
  const sameTurn = eventTurnKey !== '' && eventTurnKey === f.turnKey
  const closedLedger = f.stop !== undefined && f.stop !== null && f.stop.certain === true && f.turnOpen !== true
  if (closedLedger && (eventTurnKey === '' || sameTurn)) return state

  // 只有**属于当前轮**的执行类证据才推进活跃时间。
  if (ACTIVITY_EVENTS.has(type) && !staleTurn) f.lastActivityAt = now

  // 「真实执行恢复」：同轮出现反向执行证据时，旧停止事实失效。
  // ⚠️ 已确认的停止只在**这一轮还开着**时接受恢复证据（启动阶段致命失败、
  // turn/end 未能写入的那条 idle 路径）；turn 已经收尾的停止不接受任何同轮证据。
  // 暂定的停止只要还有任何执行痕迹就作废。status / approval / title 之类的**不能**复活任务。
  if (!staleTurn && f.stop !== undefined && f.stop !== null && f.stop.turnKey === f.turnKey) {
    const certain = f.stop.certain === true
    if (certain ? f.turnOpen === true && RESUME_EVENTS.has(type) : PROGRESS_EVENTS.has(type)) {
      f.stop = undefined
      // 恢复执行后，旧的错误/中断终态不再是当前事实；成功终态永不在此清除。
      if (f.terminal !== undefined && f.terminal !== null && f.terminal.kind !== 'completed') f.terminal = undefined
    }
  }

  switch (type) {
    case 'turn/start': {
      const turn = eventTurn === undefined ? f.turn + 1 : eventTurn
      const key = state.id + '#' + String(turn)
      // 重复 start 必须**幂等**：同一轮开着时再来一次 turn/start 什么都不能清
      // （在途工具、挂起审批、有效停止事实、终态都不能被它抹掉）。
      if (f.turnOpen === true && f.turnKey === key) {
        f.modelPhase = f.tools.length > 0 ? f.modelPhase : 'requested'
        break
      }
      // 已结束轮的重复 start：不能把旧轮重新打开
      if (f.turnOpen !== true && f.turnKey === key && (f.terminal !== undefined || f.stop !== undefined)) break
      // 非单调 start：turn 号只增不减。旧轮的迟到 start（含无 seq 的）不能把当前轮
      // 退回旧身份，也不能用「重新开始」抹掉当前轮的在途事实。
      if (eventTurn !== undefined && typeof f.turn === 'number' && eventTurn < f.turn) break
      // 真正的新一轮：替代旧终态与旧停止事实，并清掉属于旧轮的在途事实
      f.turn = turn
      f.turnKey = key
      f.turnOpen = true
      f.terminal = undefined
      f.error = undefined
      f.retry = undefined
      f.stop = undefined
      f.pendingInteractions = []
      syncPendingSlot(f)
      f.tools = []
      f.modelPhase = 'requested'
      f.lastActivityAt = now
      state.turnsSeen += 1
      state.startedAt = now
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
      const name = typeof data.name === 'string' ? data.name : ''
      const step = typeof data.step === 'number' && Number.isFinite(data.step) ? data.step : undefined
      f.tools.push({ callId, name, at: now, step })
      // 阻塞式交互工具：调用已发起、结果未回，就等于「在等人」。
      const interactionKind = INTERACTION_TOOLS[name]
      if (interactionKind !== undefined) {
        addPending(f, {
          kind: interactionKind,
          toolName: name,
          key: callId,
          at: now,
          turnKey: f.turnKey,
          source: 'tool-call',
        })
      }
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
      // 交互工具的结果回来了 = **这一条**已经答过（或取消了），只解决它自己，
      // 同轮其它还没答的提问必须继续算 waiting。
      if (Array.isArray(f.pendingInteractions)) {
        f.pendingInteractions = f.pendingInteractions.filter(
          (item) => !(item.source === 'tool-call' && (callId === '' || item.key === callId)),
        )
        syncPendingSlot(f)
      }
      if (callId !== '') f.tools = f.tools.filter((tool) => tool.callId !== callId)
      // 工具失败只是**诊断**：记下来给人看，但绝不因此判定任务停止。
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
        // 成功的工具结果把**同轮**的旧诊断清掉（不给它永久霸占 tooltip）。
        if (f.error !== undefined && f.error !== null && f.error.turnKey === f.turnKey) f.error = undefined
      }
      // 工具结果**不能**清除已确认的任务级停止：
      // 执行器停下来之后，迟到的旧工具结果不代表任务又能继续。
      // 工具返回后模型要接着推理
      f.modelPhase = 'requested'
      break
    }
    case 'approval/asked':
    case 'question/asked': {
      if (staleTurn) break
      const interaction = interactionOf(type, data)
      if (interaction === undefined) break
      addPending(f, {
        kind: interaction.kind,
        toolName: interaction.toolName,
        key: interaction.key,
        at: now,
        turnKey: f.turnKey,
        source: 'event',
      })
      break
    }
    case 'approval/decided':
    case 'question/answered':
    case 'question/cancelled': {
      // 解决事件必须**匹配当前有效交互**才清空，不能只按事件类型一刀切。
      if (staleTurn) break
      const list = Array.isArray(f.pendingInteractions) ? f.pendingInteractions : []
      if (list.length === 0) break
      const resolvedKey =
        typeof data.id === 'string' && data.id !== ''
          ? data.id
          : typeof data.callId === 'string' && data.callId !== ''
            ? data.callId
            : ''
      removePending(f, { key: resolvedKey, kind: interactionKindOf(type) })
      f.modelPhase = 'requested'
      break
    }
    case 'llm/retry': {
      if (staleTurn) break
      // 自动重试**不是停止**：记录一条有效的恢复事实，任务保持 thinking。
      const retryId = typeof data.retryId === 'string' ? data.retryId : ''
      const delayMs = typeof data.delayMs === 'number' && Number.isFinite(data.delayMs) ? data.delayMs : undefined
      f.retry = {
        turnKey: f.turnKey,
        retryId,
        retry: typeof data.retry === 'number' ? data.retry : 0,
        scheduledAt: now,
        nextAttemptAt: delayMs === undefined ? undefined : now + delayMs,
        inFlight: false,
      }
      // 诊断：这一次为什么重试（给人看，不参与判定）
      f.error = {
        kind: 'retry',
        code: shortCode(data.failure) || 'RETRY',
        message: '',
        toolName: '',
        at: now,
        turnKey: f.turnKey,
        retrying: true,
      }
      f.modelPhase = 'requested'
      break
    }
    case 'llm/retry-started': {
      if (staleTurn) break
      // 重试真正开跑：调度变成「在飞」，任务仍在 thinking
      if (f.retry !== undefined && f.retry !== null && f.retry.turnKey === f.turnKey) {
        if (typeof data.retryId !== 'string' || data.retryId === '' || f.retry.retryId === data.retryId) {
          f.retry = { ...f.retry, inFlight: true, nextAttemptAt: undefined }
        }
      }
      f.modelPhase = 'requested'
      break
    }
    case 'turn/end': {
      const reason = data.reason !== null && typeof data.reason === 'object' ? data.reason : {}
      const ending = endingOf(reason.kind)
      // 迟到的旧轮 end：不能覆盖当前轮的终态/停止事实
      if (eventTurnKey !== '' && f.turnKey !== '' && eventTurnKey !== f.turnKey) break
      if (eventTurn !== undefined) {
        f.turn = eventTurn
        f.turnKey = state.id + '#' + String(eventTurn)
      }
      // 重复 turn/end：同一条完成记录必须保留原始身份与完成时间，不能被重放刷新。
      const sameCompleted =
        ending === 'success' &&
        f.terminal !== undefined &&
        f.terminal !== null &&
        f.terminal.kind === 'completed' &&
        f.terminal.turnKey === f.turnKey
      if (sameCompleted) {
        f.turnOpen = false
        break
      }
      f.turnOpen = false
      f.tools = []
      f.pendingInteractions = []
      syncPendingSlot(f)
      f.modelPhase = 'none'
      // 这一轮已经收尾，重试调度随之作废（重试只发生在开着的轮里）
      f.retry = undefined
      if (ending === 'success') {
        const terminal = {
          kind: 'completed',
          turnKey: f.turnKey,
          at: now,
          // completedAt 只写一次（折叠这条 turn/end 的这一刻），之后永不重算。
          completedAt: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : now,
          observedAt: now,
        }
        terminal.completionKey = completionKeyOf(state.id, terminal)
        // 重复 turn/end：同一 completionKey 不生成新的完成周期
        maybeRecordCompletion(state, terminal, now)
        f.terminal = terminal
        f.error = undefined
        // 成功终态压过任何错误停止：成功之后的迟到错误不能把完成改成 blocked
        f.stop = undefined
      } else if (ending === 'failure' || (reason.kind === 'blocked' && reason.error !== null && typeof reason.error === 'object')) {
        // ✅ 唯一的错误停止终局：宿主用 reason.kind='error' 带上 error 终结这一轮。
        // （防御：若某版本在 'blocked' 上附带 error 载荷，同样按错误处理。）
        const errorBody = reason.error !== null && typeof reason.error === 'object' ? reason.error : {}
        const code = shortCode(errorBody) || 'ERROR'
        f.terminal = { kind: 'error', turnKey: f.turnKey, at: now, code }
        f.error = {
          kind: 'turn',
          code,
          message: typeof errorBody.message === 'string' ? errorBody.message : '',
          toolName: '',
          at: now,
          turnKey: f.turnKey,
        }
        confirmStop(f, {
          turnKey: f.turnKey,
          source: STOP_SOURCES.TURN_ERROR,
          code,
          evidenceId: evidenceIdOf(state, event),
          stoppedAt: now,
          cancelCause: '',
        })
      } else {
        // 取消 / preStep 拒绝 / 截断 / 未知：**都不是错误停止**。
        //
        // · reason.kind='blocked' 是 preStep 决策拒绝（宿主不附 error），这一轮
        //   没有继续，但它停的原因不是错误 —— 与非错误结束同等对待。
        // · aborted（user / parent / hook / disposed / legacy）是取消。即使之前收到
        //   过 agent/error，也**不猜测因果**：取消终局权威，显示 idle。
        const cause = cancelCauseOf(reason)
        const code = typeof reason.kind === 'string' ? reason.kind : 'unknown'
        f.terminal = {
          kind: 'interrupted',
          turnKey: f.turnKey,
          at: now,
          code,
          ...(cause === 'none' ? {} : { cancelCause: cause }),
        }
        f.error = undefined
        // 明确的非错误结束：旧的暂定停止不成立（它没有被生命周期事实确认）。
        if (f.stop !== undefined && f.stop !== null && f.stop.certain !== true) f.stop = undefined
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
  // 流式输出能推翻**暂定**停止（模型还在吐字 = 明显没停），
  // 但推翻不了**已确认**的停止：恢复之后迟到的旧分片不能把任务拉回来。
  if (f.stop !== undefined && f.stop !== null && f.stop.certain !== true) f.stop = undefined
  return state
}

/**
 * 折叠 agent 级信号。
 *
 * ⚠️ **agent status 不能清 completedAt / stop**：DSH 里 agent 收尾通常比 turn/end 晚一拍，
 * 清掉完成标记会让 done 根本显示不出来；而「agent 又在跑」也不证明任务真的恢复执行
 * （真正的恢复证据是同轮新的执行事件）。
 *
 * agent/error 也只写**暂定**停止：其它插件同样会用这个事件汇报非致命问题。
 * 只有宿主生命周期事实（turn/end 的 error/系统原因中断、或错误后的 status=idle）
 * 才能把它升级成 blocked。
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
    // 状态词表只有一个来源（宿主 agent/status 的 running / idle）。
    // 缺字段或未知词不参与任何判定 —— 不能把「没给状态」当成「已经停下」。
    const statusValue = typeof payload?.status === 'string' ? payload.status : ''
    if (statusValue === '') return state
    const running = statusValue === 'running'
    f.agentRunning = running
    // 错误之后执行器停稳，且这一轮没有留下 turn/end：这是「启动阶段致命失败」
    // 唯一可靠的口子（真实的失败链：turn/start → throwError(agent/error) →
    // finally 里 turn/end 写入失败 → 才走到这里）。
    // 只有**显式 idle** 才算停稳；'starting' 之类的未知词不确认任何停止。
    if (
      statusValue === 'idle' &&
      f.stop !== undefined &&
      f.stop !== null &&
      f.stop.certain !== true &&
      f.stop.turnKey === f.turnKey &&
      !isSuccessTerminal(f.terminal)
    ) {
      confirmStop(f, {
        turnKey: f.turnKey,
        source: STOP_SOURCES.AGENT_ERROR_IDLE,
        code: f.stop.code,
        evidenceId: f.stop.evidenceId,
        stoppedAt: typeof f.stop.stoppedAt === 'number' ? f.stop.stoppedAt : now,
        cancelCause: '',
      })
    }
    return state
  }
  if (kind === 'error') {
    const error = payload !== undefined && payload !== null ? payload.error : undefined
    const code = shortCode(error) || 'ERROR'
    // A. 诊断：保留完整错误信息
    f.error = {
      kind: 'agent',
      code,
      message: error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : '',
      toolName: '',
      at: now,
      turnKey: f.turnKey,
    }
    f.lastActivityAt = now
    // 执行身份：宿主给的是 { agent, turn, step, error }（throwError 永远带 turn）。
    // **没有 turn 的错误不可能是本轮执行失败** —— 它只能当诊断，绝不能绑定到当前任务，
    // 更不能等着 idle 把它升级成本轮的 blocked。
    const errorTurn = typeof payload?.turn === 'number' && Number.isFinite(payload.turn) ? payload.turn : undefined
    if (errorTurn === undefined) {
      f.error = { ...f.error, turnKey: '' }
      return state
    }
    const errorTurnKey = state.id + '#' + String(errorTurn)
    if (f.turnKey !== '' && errorTurnKey !== f.turnKey) {
      // 明确的旧轮/非当前轮错误：只留诊断痕迹，不写停止事实。
      f.error = undefined
      return state
    }
    f.error = { ...f.error, turnKey: errorTurnKey }
    // 取消不是错误：AbortError 形状的错误来自 abort 信号，不建立暂定停止
    // （否则 turn/end 写入失败时会被 idle 误升级成 blocked）。
    const errorName = error !== null && typeof error === 'object' ? error.name : undefined
    if (errorName === 'AbortError') return state
    // C. 任务级停止：只写暂定，等生命周期确认 —— 单独一条 agent/error 不算停止。
    state.evidenceSeq = (typeof state.evidenceSeq === 'number' ? state.evidenceSeq : 0) + 1
    const evidenceId = state.id + '#agent-error:' + String(errorTurn) + ':' + String(state.evidenceSeq)
    tentativeStop(f, {
      turnKey: errorTurnKey,
      code,
      evidenceId,
      stoppedAt: now,
    })
    return state
  }
  return state
}

/** 当前效果是否「任务已确认因错误停止」（供快照输出最小证据，不参与判定）。 */
export function isStoppedByError(facts) {
  const f = facts !== undefined && facts !== null ? facts : emptyFacts('')
  const stop = f.stop
  if (stop === undefined || stop === null) return false
  if (stop.certain !== true) return false
  if (typeof stop.turnKey === 'string' && stop.turnKey !== '' && stop.turnKey !== f.turnKey) return false
  return !isSuccessTerminal(f.terminal)
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
      const list = Array.isArray(f.pendingInteractions) && f.pendingInteractions.length > 0
        ? f.pendingInteractions
        : f.pendingInteraction !== undefined && f.pendingInteraction !== null
          ? [f.pendingInteraction]
          : []
      if (list.length === 0) return ''
      const pending = list[0]
      const base =
        pending.toolName !== ''
          ? pending.toolName
          : pending.kind === 'plan-review' ? 'plan review' : pending.kind === 'question' ? 'question' : 'approval'
      // 多条挂起时如实说明还有几条在等，别让人以为只有一个
      return list.length > 1 ? base + ' +' + (list.length - 1) : base
    }
    case 'blocked': {
      // 只有**已确认的任务级停止**才有细节；诊断错误（facts.error）不在这里出现。
      const stop = f.stop
      if (stop === undefined || stop === null || stop.certain !== true) return ''
      if (typeof stop.turnKey === 'string' && stop.turnKey !== '' && stop.turnKey !== f.turnKey) return ''
      const code = typeof stop.code === 'string' ? stop.code : ''
      return code === '' ? '' : code
    }
    default:
      return ''
  }
}
