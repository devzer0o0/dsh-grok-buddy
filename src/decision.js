/**
 * dsh-grok-buddy —— **唯一的六态决策表**。
 *
 * 宿主半侧（lib/derive.js）与页面半侧（src/widget/*）都用这一份，
 * 不允许任何模块另外写一套优先级 —— 那正是「同一行在不同地方显示不同状态」的来源。
 *
 * 六态（运行展示状态，runtimePhase / displayPhase）只有这六个：
 *
 *   idle      空闲       默认 / 不活跃 / 明确的非错误结束（取消、截断、未知）
 *   working   正在处理   当前任务仍在执行，且存在未结束的工具调用
 *   waiting   正在等待   当前任务仍可继续，且有未解决的审批、提问或计划评审
 *   blocked   已阻止     **当前任务已被确认因错误而停止，且该停止尚未被恢复或新一轮取代**
 *   thinking  思考       当前任务处于模型请求/推理/生成，或仍有效的自动重试流程
 *   done      完成       当前轮有明确的成功终态，且完成展示仍活跃、未消费
 *
 * ⚠️ blocked 的定义（本文件是唯一实现处）：
 *   「任务级错误停止」= 属于当前轮、由权威生命周期事实确认、且当前没有仍有效的
 *   自动恢复流程、也没有被更新的成功/恢复证据取代。
 *
 *   它**不**表示：出现过错误、有一条 error 记录、某个工具失败、模型正在自动重试、
 *   暂时没有输出、网络看起来异常、用户主动取消、观察链路（state.json）出错。
 *
 * 因此这里绝不出现 `if (facts.error) return 'blocked'` 这种分支：
 *   · facts.error           只是**诊断**（工具/请求/重试报了什么错），不参与判定；
 *   · facts.retry           只是**自动恢复事实**，它让任务保持 thinking，而不是 blocked；
 *   · facts.stop            才是**任务级错误停止**，必须带来源、身份与「是否已确认」。
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
 * 只有语义**没有歧义**的历史名才留在表里：
 *   streaming → thinking（模型在吐字）
 *   tool      → working（有工具在跑）
 *   completed → done（明确成功）
 *
 * retry / error 已被**移除**：它们本身不能证明「任务级错误停止」。
 * 「见过一次错误」「正在重试」都不是停止事实，把它们映射成 blocked
 * 会让局部失败与自动重试直接闪成感叹号。认不出来的历史名一律 idle。
 */
export const LEGACY_PHASE_INPUT = Object.freeze({
  streaming: 'thinking',
  tool: 'working',
  completed: 'done',
})

/**
 * 任务级错误停止的权威来源。**全部是真实宿主契约**，不是自造事件名：
 *
 *   turn/end reason.kind === 'error'    LlmFailure 终结这一轮（类型：
 *                                       TurnEndReasonMap.error = { kind:'error'; error: LlmFailure }）
 *   agent/error + agent/status=idle     执行器在错误后停稳，且这一轮没有留下 turn/end
 *                                       （启动阶段的致命失败走这个口子）
 *
 * ⚠️ 单独一条 agent/error **不是**停止证据：其它插件也会用这个事件汇报
 * 非致命问题（例如持久化 flush 失败）。它只作为「暂定停止」，等宿主生命周期
 * 事实确认后才升级；确认不了就保持诊断，不显示 blocked。
 *
 * ⚠️ 明确**不算**错误停止的两种终局：
 *   · turn/end reason.kind === 'blocked' 是 preStep 拒绝（决策门拒绝进入这一步），
 *     宿主不附错误 —— 这是「明确的非错误结束」，显示 idle；
 *   · aborted（user / parent / hook / disposed / legacy）是取消，不是错误。即使
 *     之前有一条 agent/error，也不猜测因果 —— 取消终局权威，显示 idle。
 */
export const STOP_SOURCES = Object.freeze({
  TURN_ERROR: 'turn/end:error',
  AGENT_ERROR: 'agent/error',
  AGENT_ERROR_IDLE: 'agent/error+agent/status:idle',
})

/**
 * 取消原因里的「系统原因」。**只作诊断标注**：取消本身（无论谁发起）都不是
 * 错误停止，绝不与并行的 agent/error 拼成因果。
 */
export const SYSTEM_CANCEL_CAUSES = Object.freeze(['parent', 'hook', 'disposed'])

/** 结束这一轮、并算作「明确成功」的 turn/end reason。 */
const SUCCESS_ENDINGS = new Set(['completed'])

/** 结束这一轮、但**不是成功**的 reason（取消/中断/截断/未知）。 */
const NEUTRAL_ENDINGS = new Set(['aborted', 'interrupted', 'max-tokens', 'forked', 'unknown'])

/**
 * 结束这一轮、并且**已经确认任务因错误停止**的 reason（真实宿主词汇）。
 *
 * 只有 'error'：宿主在 preStep 拒绝时写 { kind: 'blocked' } 且不带 error
 * （见 dsh-agent-loop 的 turn()），那是决策门拒绝，不是错误停止。
 */
const FAILURE_ENDINGS = new Set(['error'])

/**
 * 空事实。宿主与页面两侧都以它为起点，字段一致。
 * @param {string} sessionId 会话 id。
 * @returns {object} 事实对象。
 */
export function emptyFacts(sessionId) {
  return {
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    workspaceId: '',
    /** 当前轮的稳定身份（sessionId#turn）。 */
    turnKey: '',
    /** 当前轮序号（宿主给的 turn 号，可能是 0）。 */
    turn: 0,
    /** 是否有一轮正在进行。 */
    turnOpen: false,
    /**
     * 已落定终局的轮次身份（**封账**）：非空时这一轮不再接受任何同轮事件。
     * 成功 / 错误 / 取消 / 拒绝都算终局 —— 封账条件是「有终局」，不是「有停止事实」。
     */
    closedTurnKey: '',
    /** agent 是否在跑（只作兜底证据，从不单独构成 working/blocked）。 */
    agentRunning: false,
    /** 未结束的工具调用：[{ callId, name, at }]。 */
    tools: [],
    /** 最近一次实际工具调用的动效提示证据；不参与六态判定。 */
    toolActivity: undefined,
    /** 未解决的交互：undefined 或 { kind, toolName, at, key }。 */
    pendingInteraction: undefined,
    /** **所有**未解决的交互：[{ kind, toolName, at, key, turnKey, source }]。 */
    pendingInteractions: [],
    /**
     * **诊断**：最近一次工具调用/请求/重试报了什么错。
     * 只用于日志与 tooltip —— **永远不参与六态判定**。
     */
    error: undefined,
    /**
     * **自动恢复事实**：当前轮是否有仍有效的重试调度。
     * { turnKey, retryId, retry, scheduledAt, nextAttemptAt, inFlight }。
     * 它让任务保持 thinking；重试本身不产生停止事实。
     */
    retry: undefined,
    /**
     * **任务级错误停止**：
     * { turnKey, source, cause: 'error', code, evidenceId, certain, stoppedAt, cancelCause }。
     *
     *   certain === true   权威生命周期已确认「这一轮因错误停下来了」→ blocked
     *   certain === false  暂定（只收到 agent/error），等生命周期事实确认；
     *                      确认不了就只保留诊断，不显示 blocked
     *
     * 失效规则（fold 负责执行，decide 只做身份校验）：
     *   · 新一轮 turn/start
     *   · 反向的执行证据（同轮 step/tool/assistant/stream/retry）
     *   · 同一个 evidenceId 的重复事件（幂等，不刷新 stoppedAt）
     */
    stop: undefined,
    /** 投影出来的终态：{ kind, turnKey, completedAt?, completionKey?, at }。 */
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

/**
 * 终态是否算「已确认的错误停止」。
 *
 * 只有 fold 在**权威事实证明停止**时才写这两个 kind，所以这里可以按 kind 判断；
 * 身份校验仍由 currentTerminal() 负责。
 */
export function isFailureTerminal(terminal) {
  return terminal !== undefined && terminal !== null && terminal.kind === 'error'
}

/**
 * 两条带身份的事实是否属于同一轮。
 *
 * 身份**必须双方都非空**：缺身份的事实不能套用到任何任务上（旧宿主、
 * 旧缓存、别的插件的历史快照都会缺字段）。空串曾经被当成「通配」，
 * 那是上一版把无身份错误当成当前任务停止的来源。
 */
export function sameTurnKey(left, right) {
  if (typeof left !== 'string' || left === '') return false
  if (typeof right !== 'string' || right === '') return false
  return left === right
}

/**
 * 当前**有效**的终态投影（旧轮的终态不能影响新一轮）。
 * @param {object} f 事实。
 * @returns {object|undefined} 终态。
 */
export function currentTerminal(f) {
  const terminal = f !== undefined && f !== null ? f.terminal : undefined
  if (terminal === undefined || terminal === null) return undefined
  if (!sameTurnKey(terminal.turnKey, f.turnKey)) return undefined
  return terminal
}

/**
 * 当前**有效**的任务级错误停止。三个条件缺一不可：
 *   1. 属于当前轮（身份匹配）；
 *   2. certain === true（权威生命周期确认过）；
 *   3. 没有被更新的成功终态取代（调用方先判终态，这里再兜一层）。
 *
 * @param {object} f 事实。
 * @returns {object|undefined} 停止事实。
 */
export function currentStop(f) {
  return stopProofOf(f) === undefined ? undefined : f.stop
}

/**
 * 停止证明的**唯一**校验（宿主快照、页面消费、detail 文本都用它）。
 *
 * blocked 是「任务级错误停止」，所以证据必须齐：
 *   1. certain === true       —— 有生命周期事实确认过；
 *   2. cause === 'error'      —— 明确是错误停止，不是取消/拒绝；
 *   3. source 属于确证来源白名单；
 *   4. 身份非空且与当前轮严格相等；
 *   5. 没有被成功终态或明确的非错误终态取代。
 *
 * 缺任何一条都返回 undefined：**证据不足就不是停止**，不能降级成「差不多算」。
 *
 * @param {object} f 事实。
 * @returns {object|undefined} 通过校验的停止事实。
 */
export function stopProofOf(f) {
  const stop = f !== undefined && f !== null ? f.stop : undefined
  if (stop === undefined || stop === null) return undefined
  if (stop.certain !== true) return undefined
  if (stop.cause !== 'error') return undefined
  if (typeof stop.source !== 'string' || CONFIRMED_STOP_SOURCES.indexOf(stop.source) === -1) return undefined
  if (!sameTurnKey(stop.turnKey, f.turnKey)) return undefined
  const terminal = currentTerminal(f)
  if (terminal !== undefined) {
    // 成功终态压过停止；明确的非错误终态同样说明「这一轮不是因错误停下」。
    if (isSuccessTerminal(terminal)) return undefined
    if (typeof terminal.kind === 'string' && terminal.kind === 'interrupted') return undefined
  }
  return stop
}

/** 能**确认**任务级错误停止的来源：暂定来源（agent/error）不在此列。 */
export const CONFIRMED_STOP_SOURCES = Object.freeze([
  STOP_SOURCES.TURN_ERROR,
  STOP_SOURCES.AGENT_ERROR_IDLE,
])

/**
 * 自动重试流程的**在飞**有效期：重试已经开跑（retry-started）后，
 * 超过这么久仍没有后续事件，就当它不再可信。
 */
export const RETRY_LIVE_TTL_MS = 10 * 60 * 1000

/**
 * 调度到期后的**宽限**：宿主告诉我们「几点会重试」，过了那个时刻还没动静，
 * 再给一分钟缓冲；超过就是陈旧调度，不能继续顶着 thinking。
 */
export const RETRY_DUE_GRACE_MS = 60 * 1000

/**
 * 当前轮是否还有**仍有效**的自动恢复流程（重试调度/正在重试）。
 * 只用于诊断与「重试不该被当成停止」的自检，不产生 blocked。
 *
 * @param {object} f 事实。
 * @param {number} [now] 当前时刻（用于有界有效期；缺省不看时限）。
 * @returns {boolean} 是否仍在自动恢复中。
 */
export function isRetryLive(f, now) {
  const retry = f !== undefined && f !== null ? f.retry : undefined
  if (retry === undefined || retry === null) return false
  // 身份必须非空且严格相等：旧轮、无身份的调度都不给当前轮续命。
  if (!sameTurnKey(retry.turnKey, f.turnKey)) return false
  if (typeof now !== 'number') return true
  const scheduledAt = typeof retry.scheduledAt === 'number' && Number.isFinite(retry.scheduledAt)
    ? retry.scheduledAt
    : undefined
  if (scheduledAt === undefined) return false
  if (retry.inFlight === true) {
    // 已开跑：从最后一次可信锚点起算在飞有效期。
    const anchor = typeof retry.startedAt === 'number' && Number.isFinite(retry.startedAt)
      ? retry.startedAt
      : scheduledAt
    return now - anchor <= RETRY_LIVE_TTL_MS
  }
  // 退避中：以**宿主给的调度时刻**为准，而不是固定 TTL。
  // 先接受 20 分钟退避、再在第 10 分钟宣告失效，是自相矛盾的。
  const dueAt = typeof retry.nextAttemptAt === 'number' && Number.isFinite(retry.nextAttemptAt)
    ? retry.nextAttemptAt
    : Math.max(scheduledAt + RETRY_LIVE_TTL_MS, scheduledAt)
  if (now <= dueAt) return true
  return now - dueAt <= RETRY_DUE_GRACE_MS
}

/**
 * 快照与判定**共用**的重试有效性：snapshot.retrying 必须调它，
 * 不能只检查「对象存在且身份相同」——那会产出 phase=idle 却 retrying=true 的自相矛盾快照。
 *
 * @param {object} f 事实。
 * @param {number} [now] 当前时刻。
 * @returns {boolean} 是否仍有有效的自动恢复流程。
 */
export function retryActive(f, now) {
  return isRetryLive(f, now)
}

/**
 * 把任意历史/外部输入名归一成六态之一。认不出来一律 idle。
 *
 * ⚠️ 这里**不做**语义校验：'blocked' 是合法六态名，但它是否可信
 * （有没有任务级错误停止证据）由调用方结合 stop 事实判断（见页面侧）。
 *
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
 *   · 也永远不推出 blocked —— 静默不是错误停止的证据；
 *   · 长时间的工具调用与长时间的挂起审批不受它影响（见 decide 的判定顺序）。
 */
export const TURN_SILENCE_TTL_MS = 3 * 60 * 1000

/**
 * **完成展示失活阈值**（实现参数）。活跃的完成展示超过这么久仍未消费，就落成 idle。
 * 用户正在选中查看时按选中规则处理（见页面侧 activity.js），不在这里判。
 */
export const DONE_DISPLAY_TTL_MS = 5 * 60 * 1000

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
 * 顺序（不可交换，来自当前有效事实）：
 *   1. 当前有效成功终态          → done（展示已消费/失活则 idle，**不删除完成事实**）
 *   2. 当前有效任务级错误停止    → blocked
 *   3. 当前有效非错误结束        → idle（取消 / 截断 / 未知，都不是成功也不是停止）
 *   4. 未终止 + 有挂起交互       → waiting
 *   5. 未终止 + 有未结束工具     → working
 *   6. 未终止 + 仍有有效的自动重试 → thinking（先于静默，退避可能长于静默阈值）
 *   7. 未终止 + 模型在跑         → thinking
 *   8. 其余（含静默）            → idle
 *
 * ⚠️ 第 2 步是**任务级错误停止**，不是「有任何 error」。诊断错误（facts.error）
 * 与重试事实（facts.retry）都不进这个分支 —— 工具失败后 Agent 继续分析、
 * 自动重试退避、审批中报错，都必须是 thinking/working/waiting。
 *
 * 为什么已确认的错误停止压过挂起交互：宿主已经终结这一轮时，挂起的审批/提问
 * 已经没有回答方（answerer 随执行流程消失），留成 waiting 会把「等人」误导成
 * 「还能答」。反过来，**未确认**的停止绝不会抢走 waiting。
 *
 * @param {object} facts 事实（见 emptyFacts）。
 * @param {object} [options] 展示侧输入：consumed / observedAt / now / doneTtlMs / silenceTtlMs。
 * @returns {{phase: string, reason: string, completionKey: string, done: boolean}} 判定结果。
 */
export function decide(facts, options) {
  const f = facts !== undefined && facts !== null ? facts : emptyFacts('')
  const opts = options !== undefined && options !== null ? options : {}
  const now = typeof opts.now === 'number' ? opts.now : typeof f.sampledAt === 'number' ? f.sampledAt : 0
  const terminal = currentTerminal(f)
  const completionKey = completionKeyOf(f.sessionId, terminal)

  // 1) 当前轮的明确成功终态（完成展示生命周期不变）
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

  // 2) 当前轮**已确认**的任务级错误停止
  const stop = currentStop(f)
  if (stop !== undefined) {
    const code = typeof stop.code === 'string' && stop.code !== '' ? stop.code : 'ERROR'
    return {
      phase: 'blocked',
      reason: 'stop:' + code,
      completionKey,
      done: false,
      stopSource: typeof stop.source === 'string' ? stop.source : '',
    }
  }

  // 3) 非错误的结束（取消 / 截断 / 未知）：明确不继续，但也没有错误停止
  if (terminal !== undefined) {
    return { phase: 'idle', reason: 'terminal-' + String(terminal.kind), completionKey, done: false }
  }

  // 交互是**集合**：任一未解决就算 waiting。单个槽位只是它的投影。
  const pendingList = Array.isArray(f.pendingInteractions) && f.pendingInteractions.length > 0
    ? f.pendingInteractions
    : f.pendingInteraction !== undefined && f.pendingInteraction !== null
      ? [f.pendingInteraction]
      : []
  const pending = pendingList.length > 0 ? pendingList[0] : undefined
  const tools = Array.isArray(f.tools) ? f.tools : []
  const silenceTtl = typeof opts.silenceTtlMs === 'number' ? opts.silenceTtlMs : TURN_SILENCE_TTL_MS
  const lastActivity = typeof f.lastActivityAt === 'number' ? f.lastActivityAt : 0
  const silent = lastActivity > 0 && now - lastActivity > silenceTtl

  // 「这一轮还在进行」的证据：
  //   · 宿主明确开着这一轮
  //   · agent 在跑（插件中途接入时的兜底）
  //   · 已接受的在途工具（插件中途接入、没见过 turn/start 时也有效）
  //   · 有一条未解决的交互 —— 它本身就是「有事等着人处理」的强证据，
  //     不存在于任何已结束或无活动任务上。所以插件中途接入、只收到挂起提问时，
  //     也能正确显示 waiting 而不是 idle。
  const hasPending = pending !== undefined && pending !== null
  const running = f.turnOpen === true || f.agentRunning === true || hasPending || tools.length > 0
  if (!running) {
    // 没有在途任务，也没有停止证据：这就是空闲。**不拿沉默或诊断错误冒充 blocked**。
    return { phase: 'idle', reason: f.turnOpen === true ? 'silent-turn' : 'no-open-turn', completionKey, done: false }
  }

  // 4) 未终止任务的高优先级事实。注意：在途工具与挂起交互**不受静默阈值影响**。
  if (hasPending) {
    const kind = String(pending.kind || 'interaction')
    const suffix = pendingList.length > 1 ? ' x' + pendingList.length : ''
    return { phase: 'waiting', reason: 'pending:' + kind + suffix, completionKey, done: false }
  }
  if (tools.length > 0) {
    return { phase: 'working', reason: 'tool:' + String(tools[0].name || ''), completionKey, done: false }
  }
  // 仍有效的自动重试**先于静默降级**：退避可能比静默阈值更长，那段时间仍是
  // 「正在自动恢复」，不是空闲。时限由 RETRY_LIVE_TTL_MS 兜底，避免陈旧调度钉死。
  if (isRetryLive(f, now)) {
    return { phase: 'thinking', reason: 'retry', completionKey, done: false }
  }
  if (silent) {
    return { phase: 'idle', reason: 'silent-turn', completionKey, done: false }
  }
  // 5) 模型执行中 —— 仍然是「思考」，不是停止
  if (f.modelPhase === 'requested' || f.modelPhase === 'generating') {
    return { phase: 'thinking', reason: 'model:' + f.modelPhase, completionKey, done: false }
  }
  // 轮开着、没有工具、没有交互、也没有模型阶段证据：刚起步，仍算 thinking。
  return { phase: 'thinking', reason: 'turn-open', completionKey, done: false }
}
