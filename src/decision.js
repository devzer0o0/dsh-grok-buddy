/**
 * dsh-grok-buddy —— **唯一的六态决策表**。
 *
 * 宿主半侧（lib/derive.js）与页面半侧（src/widget/*）都用这一份，
 * 不允许任何模块另外写一套优先级 —— 那正是「同一行在不同地方显示不同状态」的来源。
 *
 * 六态（运行展示状态，runtimePhase / displayPhase）只有这六个：
 *
 *   idle      空闲       默认 / 不活跃 / 完成展示已结束或已被消费
 *   working   正在处理   活跃，且当前任务还有未结束的工具调用（**只有工具**）
 *   waiting   正在等待   活跃，且有未解决的审批、提问或计划评审
 *   blocked   已阻止     当前任务/需处理的交互仍活跃，且存在**有效**错误
 *   thinking  思考       活跃，处于模型请求/推理/生成阶段，且无更高优先级事实
 *   done      完成       当前轮有明确的成功终态，且完成展示仍活跃、未消费
 *
 * 明确**不是**状态的东西（分层见下）：
 *   motionPreset  底层动画资源（celebrate / bored / alerting …）
 *   expression    眼型等素材
 *   selected / seen / active / stale / consumed  事实与标志位
 *
 * @module dsh-grok-buddy/decision
 */

/** 六态。顺序即文档顺序，不含任何历史名字。 */
export const RUNTIME_PHASES = Object.freeze(['idle', 'working', 'waiting', 'blocked', 'thinking', 'done'])

/**
 * 历史输入名 → 六态。**只在输入边界用一次**，输出侧永不出现这些名字。
 *
 * streaming / tool 这类曾经是独立状态的输入，统一归到 thinking / working；
 * retry / error 归 blocked；completed 归 done。
 */
export const LEGACY_PHASE_INPUT = Object.freeze({
  streaming: 'thinking',
  tool: 'working',
  retry: 'blocked',
  error: 'blocked',
  completed: 'done',
})

/**
 * 把任意历史/外部输入名归一成六态之一。认不出来一律 idle。
 * @param {unknown} value 候选相位名。
 * @returns {string} 六态之一。
 */
export function normalizePhaseInput(value) {
  if (typeof value !== 'string' || value === '') return 'idle'
  const name = value.trim().toLowerCase()
  if (RUNTIME_PHASES.indexOf(name) !== -1) return name
  const legacy = LEGACY_PHASE_INPUT[name]
  return legacy === undefined ? 'idle' : legacy
}

/**
 * **活跃失效阈值**（实现参数，不是官网规定，也不是用户指定的时长）。
 *
 * 用途只有一个：一个 turn 开着、但既没有工具在跑、也没有挂起交互、也没有新事件，
 * 过了这么久就当「我们不知道它在干什么」→ 不再假装 thinking/working，退回 idle。
 *
 * 与「完成展示失活阈值」是两件事，**不能混用**：
 *   · 这里的静默只降级为 idle，**永远不会推出 done**（不拿沉默冒充成功）；
 *   · 长时间的工具调用与长时间的挂起审批不受它影响（见 decide 的判定顺序）。
 */
export const TURN_SILENCE_TTL_MS = 3 * 60 * 1000

/**
 * **完成展示失活阈值**（实现参数）。活跃的完成展示超过这么久仍未消费，就落成 idle。
 * 用户正在选中查看时按选中规则处理（见页面侧 activity.js），不在这里判。
 */
export const DONE_DISPLAY_TTL_MS = 5 * 60 * 1000

/** 结束这一轮、并算作「明确成功」的 turn/end reason。 */
const SUCCESS_ENDINGS = new Set(['completed'])

/** 结束这一轮、但**不是成功**的 reason（取消/中断/截断/未知）。 */
const NEUTRAL_ENDINGS = new Set(['aborted', 'cancelled', 'max-tokens', 'incomplete', 'unknown'])

/** 结束这一轮、并且算「已阻止」的 reason。 */
const FAILURE_ENDINGS = new Set(['error', 'blocked', 'failed'])

/**
 * 空事实。宿主与页面两侧都以它为起点，字段一致。
 * @param {string} sessionId 会话 id。
 * @returns {object} 事实对象。
 */
export function emptyFacts(sessionId) {
  return {
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    workspaceId: '',
    /** 当前轮的稳定身份（sessionId:turn）。 */
    turnKey: '',
    /** 当前轮序号（宿主给的 turn 号，可能是 0）。 */
    turn: 0,
    /** 是否有一轮正在进行。 */
    turnOpen: false,
    /** agent 是否在跑（只作兜底证据，从不单独构成 working）。 */
    agentRunning: false,
    /** 未结束的工具调用：[{ callId, name, at }]。 */
    tools: [],
    /** 未解决的交互：undefined 或 { kind: 'approval'|'question'|'plan-review', toolName, at, key }。 */
    pendingInteraction: undefined,
    /** 当前**有效**错误（新任务开始、或后续成功会清掉）：undefined 或 { kind, code, message, at, turnKey }。 */
    error: undefined,
    /** 明确的终态事实（与展示状态分开保存）：undefined 或 { kind, turnKey, completedAt, completionKey, at }。 */
    terminal: undefined,
    /** 模型阶段：'none' | 'requested' | 'generating'。 */
    modelPhase: 'none',
    /** 最后一次**执行类证据**的时刻（工具/step/审批/流式）。无关事件不推进它。 */
    lastActivityAt: 0,
    /** 采样时刻。 */
    sampledAt: 0,
  }
}

/** 终态是否算「明确成功」。 */
export function isSuccessTerminal(terminal) {
  return terminal !== undefined && terminal !== null && terminal.kind === 'completed'
}

/** 终态是否算「已阻止」。 */
export function isFailureTerminal(terminal) {
  return terminal !== undefined && terminal !== null && (terminal.kind === 'error' || terminal.kind === 'blocked')
}

/**
 * turn/end 的 reason.kind → 终态归属。
 * @param {unknown} kind reason.kind。
 * @returns {'success'|'failure'|'neutral'} 归属。
 */
export function endingOf(kind) {
  if (typeof kind === 'string') {
    if (SUCCESS_ENDINGS.has(kind)) return 'success'
    if (FAILURE_ENDINGS.has(kind)) return 'failure'
    if (NEUTRAL_ENDINGS.has(kind)) return 'neutral'
  }
  return 'neutral'
}

/**
 * 完成记录的身份。缺 completedAt 也必须稳定 —— 否则「无法标记已查看、永远活跃」。
 *
 * @param {string} sessionId 会话 id。
 * @param {object} terminal 终态事实。
 * @returns {string} 完成身份。
 */
export function completionKeyOf(sessionId, terminal) {
  if (terminal === undefined || terminal === null) return ''
  if (typeof terminal.completionKey === 'string' && terminal.completionKey !== '') return terminal.completionKey
  const turnKey = typeof terminal.turnKey === 'string' ? terminal.turnKey : ''
  const id = sessionId === undefined || sessionId === null ? '' : String(sessionId)
  // turnKey 已经是 sessionId#turn 形式；只有它缺失时才自己拼一个稳定身份。
  if (turnKey !== '') return turnKey
  return (id === '' ? 'unknown-session' : id) + '#unknown-turn'
}

/**
 * 这一条完成记录是否还在「完成展示」的活跃期。
 *
 * 三条出口（用户确认的规则）：
 *   1. 被消费（看过并切走）→ 不活跃；
 *   2. 完成展示失活（completedAt 已知且超过阈值）→ 不活跃；
 *   3. completedAt 未知时用页面侧首次观测时间（observedAt）算同样的阈值 ——
 *      这是明确的「观测时间」，不是伪造的 completedAt。
 *
 * @param {object} options 判定输入。
 * @param {object} options.terminal 终态事实。
 * @param {number} [options.completedAt] 真实完成时刻（未知则为 undefined）。
 * @param {number} [options.observedAt] 页面首次观测到该完成记录的时刻。
 * @param {boolean} [options.consumed] 该完成记录是否已被消费。
 * @param {number} options.now 当前时刻。
 * @param {number} [options.ttlMs] 失活阈值。
 * @returns {boolean} 仍应显示 done 为 true。
 */
export function isCompletionLive(options) {
  const opts = options !== undefined && options !== null ? options : {}
  if (!isSuccessTerminal(opts.terminal)) return false
  if (opts.consumed === true) return false
  const ttl = typeof opts.ttlMs === 'number' ? opts.ttlMs : DONE_DISPLAY_TTL_MS
  const now = typeof opts.now === 'number' ? opts.now : 0
  const anchor = typeof opts.completedAt === 'number'
    ? opts.completedAt
    : typeof opts.observedAt === 'number'
      ? opts.observedAt
      : undefined
  if (anchor === undefined) return true
  return now - anchor <= ttl
}

/**
 * 六态决策表 —— **唯一**的判定入口。
 *
 * 顺序（不可交换）：
 *   1. 终态优先：当前轮已有明确终态时，先按终态归属判定。
 *        success  → done（若完成展示已消费/失活则 idle，**不删除完成事实**）
 *        failure  → blocked
 *        neutral  → idle（取消/截断/未知都不是成功）
 *   2. 未结束任务：有效错误 → blocked；挂起交互 → waiting；
 *      未结束工具 → working；模型阶段 → thinking；其余 → idle。
 *   3. 静默只降级为 idle，且只在「没有任何在途证据」时生效。
 *
 * 为什么致命错误压过挂起交互：DSH 里 agent/error 表示 agent 已经崩了，
 * 此时挂起的审批/提问已经没有回答方（answerer 随 agent 消失），
 * 留成 waiting 会把「等人」误导成「还能答」。所以 blocked 在前。
 *
 * @param {object} facts 事实（见 emptyFacts）。
 * @param {object} [options] 展示侧输入：consumed / observedAt / now / doneTtlMs / silenceTtlMs。
 * @returns {{phase: string, reason: string, completionKey: string, done: boolean}} 判定结果。
 */
export function decide(facts, options) {
  const f = facts !== undefined && facts !== null ? facts : emptyFacts('')
  const opts = options !== undefined && options !== null ? options : {}
  const now = typeof opts.now === 'number' ? opts.now : typeof f.sampledAt === 'number' ? f.sampledAt : 0
  const terminal = f.terminal
  const completionKey = completionKeyOf(f.sessionId, terminal)

  // 1) 当前轮的明确终态
  if (terminal !== undefined && terminal !== null) {
    if (isSuccessTerminal(terminal)) {
      const live = isCompletionLive({
        terminal,
        completedAt: typeof terminal.completedAt === 'number' ? terminal.completedAt : undefined,
        observedAt: typeof opts.observedAt === 'number' ? opts.observedAt : undefined,
        consumed: opts.consumed === true,
        now,
        ttlMs: opts.doneTtlMs,
      })
      return {
        phase: live ? 'done' : 'idle',
        reason: live ? 'terminal-completed' : opts.consumed === true ? 'completion-consumed' : 'completion-expired',
        completionKey,
        done: live,
      }
    }
    if (isFailureTerminal(terminal)) {
      return { phase: 'blocked', reason: 'terminal-' + terminal.kind, completionKey, done: false }
    }
    return { phase: 'idle', reason: 'terminal-' + String(terminal.kind), completionKey, done: false }
  }

  const pending = f.pendingInteraction
  const tools = Array.isArray(f.tools) ? f.tools : []
  const error = f.error
  const silenceTtl = typeof opts.silenceTtlMs === 'number' ? opts.silenceTtlMs : TURN_SILENCE_TTL_MS
  const lastActivity = typeof f.lastActivityAt === 'number' ? f.lastActivityAt : 0
  const silent = lastActivity > 0 && now - lastActivity > silenceTtl

  // 「这一轮还在进行」：宿主明确开着这一轮，或（插件中途接入时）agent 在跑。
  const running = f.turnOpen === true || (f.turnOpen !== true && f.agentRunning === true)
  if (!running) {
    // 没有在途任务，但也没拿到终态：这就是空闲。**不拿沉默冒充完成**。
    if (error !== undefined && error !== null && !silent) {
      return { phase: 'blocked', reason: 'error-without-turn', completionKey, done: false }
    }
    return { phase: 'idle', reason: f.turnOpen === true ? 'silent-turn' : 'no-open-turn', completionKey, done: false }
  }

  // 2) 未结束任务的高优先级事实。注意：在途工具与挂起交互**不受静默阈值影响**。
  if (error !== undefined && error !== null) {
    return { phase: 'blocked', reason: 'error:' + String(error.code || error.kind || ''), completionKey, done: false }
  }
  if (pending !== undefined && pending !== null) {
    return { phase: 'waiting', reason: 'pending:' + String(pending.kind || 'interaction'), completionKey, done: false }
  }
  if (tools.length > 0) {
    return { phase: 'working', reason: 'tool:' + String(tools[0].name || ''), completionKey, done: false }
  }
  if (silent) {
    return { phase: 'idle', reason: 'silent-turn', completionKey, done: false }
  }
  if (f.modelPhase === 'requested' || f.modelPhase === 'generating') {
    return { phase: 'thinking', reason: 'model:' + f.modelPhase, completionKey, done: false }
  }
  // 轮开着、没有工具、没有交互、也没有模型阶段证据：刚起步，仍算 thinking。
  return { phase: 'thinking', reason: 'turn-open', completionKey, done: false }
}
