/**
 * dsh-grok-buddy —— 会话登记表：把宿主事实折起来，并按统一决策表算六态。
 *
 * 分工（只有一个语义来源）：
 *   lib/fold.js      事件 → 事实（不产出相位名）
 *   src/decision.js  事实 + 展示输入 → 六态（唯一决策表）
 *   本文件           编排：登记、采样、快照、回收
 *
 * 六态：idle / working / waiting / blocked / thinking / done。
 * 历史名（streaming / tool / retry / error / completed）只在输入边界归一。
 *
 * @module dsh-grok-buddy/derive
 */

import { RUNTIME_PHASES, decide, retryActive, stopProofOf } from '../src/decision.js'
import {
  applyAgentSignal,
  applySessionEvent,
  applyStreamChunk,
  createSessionState,
  detailOf,
  dirName,
  syncPendingSlot,
} from './fold.js'

/** 六态枚举（唯一对外状态集合）。 */
export const PHASES = RUNTIME_PHASES

/** 阈值与归一集中来自 decision.js（这里只做转出，避免两处各写一套）。 */
export {
  DONE_DISPLAY_TTL_MS,
  TURN_SILENCE_TTL_MS,
  isCompletionLive,
  normalizePhaseInput,
  retryActive,
} from '../src/decision.js'

/**
 * 建立登记表。
 * @param {{ now?: () => number, ttlMs?: number }} [options] 时钟与回收阈值。
 * @returns {object} 登记表。
 */
export function createRegistry(options) {
  const settings = options !== undefined && options !== null ? options : {}
  const now = typeof settings.now === 'function' ? settings.now : () => Date.now()
  const ttlMs = typeof settings.ttlMs === 'number' ? settings.ttlMs : 6 * 60 * 60 * 1000
  const sessions = new Map()
  /** 宿主投影报告的挂起提问：sessionId → 挂起信息。 */
  const pendingQuestions = new Map()

  function ensure(id) {
    if (typeof id !== 'string' || id === '') return undefined
    let state = sessions.get(id)
    if (state === undefined) {
      state = createSessionState(id, now())
      sessions.set(id, state)
    }
    return state
  }

  /** 折入一条会话事件。 */
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
    // 投影只跟着**被接受的**生命周期事实走，不能凭事件类型一刀切：
    //   · 被 seq/封账/身份门闸拒绝的旧 turn/end 清掉投影 → 当前任务的 waiting 被误丢；
    //   · 真正开始新一轮后旧投影还挂着 → 新任务被旧的 waiting 污染。
    if (state.lastTaskReplaced === true) {
      state.lastTaskReplaced = false
      pendingQuestions.delete(id)
    }
    // 一轮**当前任务**的终局被接受后，宿主的提问投影也会清；跟着清掉。
    if (state.lastTerminalAccepted === true) pendingQuestions.delete(id)
  }

  /** 折入 agent 级信号。 */
  function onAgent(sessionId, kind, payload) {
    const state = ensure(sessionId)
    if (state === undefined) return
    applyAgentSignal(state, kind, payload, now())
  }

  /** 折入一条流式分片。 */
  function onStream(sessionId, frame) {
    const state = ensure(sessionId)
    if (state === undefined) return
    applyStreamChunk(state, now(), frame === undefined || frame === null ? undefined : frame.turn)
  }

  /**
   * 宿主投影报告的挂起提问（ask_user_question / plan-review）。
   * 来自 DSH 自己的 sessionProjections.userQuestions 契约，不是自造事件名。
   * @param {string} sessionId 会话 id。
   * @param {object|null} pending null 表示没有挂起提问。
   */
  function onPendingQuestion(sessionId, pending) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (pending === undefined) return
    if (pending === null) {
      // 只在已知会话上记录「明确没有」；未知会话不要凭这一条建空记录
      if (sessions.has(sessionId)) pendingQuestions.set(sessionId, null)
      return
    }
    // 插件中途接入：只收到挂起交互也要能建立记录，否则这条交互在快照里不可见
    ensure(sessionId)
    const state = ensure(sessionId)
    pendingQuestions.set(sessionId, {
      kind: pending.kind === 'plan-review' ? 'plan-review' : 'question',
      toolName: typeof pending.toolName === 'string' ? pending.toolName : 'ask_user_question',
      key: typeof pending.callId === 'string' ? pending.callId : '',
      // 记录这条投影属于哪一轮：异步到达的投影不能贴到别轮的任务上。
      turnKey: state === undefined || typeof state.facts.turnKey !== 'string' ? '' : state.facts.turnKey,
      at: now(),
    })
  }

  /**
   * 投影的任务世代校验。
   *
   * 投影是**异步**读来的（宿主自己的 userQuestions 投影），读回来的那一刻
   * 可能已经换轮了。上一版在 snapshot 里无条件把投影贴到 f.turnKey 上，
   * 于是旧轮的提问会污染新任务。这里把「记录时的任务身份」与当前任务比对：
   * 世代不同就不认这条投影。
   *
   * @param {string} id 会话 id。
   * @param {object} f 当前事实。
   * @returns {object|null|undefined} 有效投影 / 明确为空 / 不可用。
   */
  function projectionFor(id, f) {
    const record = pendingQuestions.get(id)
    if (record === undefined || record === null) return record
    const stamped = typeof record.turnKey === 'string' ? record.turnKey : ''
    // 记录时没有任务身份（插件中途接入）：绑定读取时的任务世代。
    // 会话自己也还没有任务身份时保持未绑定 —— 这条投影就是当前可见的挂起交互。
    if (stamped === '') {
      if (typeof f.turnKey !== 'string' || f.turnKey === '') return record
      record.turnKey = f.turnKey
      return record
    }
    if (typeof f.turnKey !== 'string' || f.turnKey === '' || stamped !== f.turnKey) return null
    return record
  }

  /** 读取当前快照：每行相位由统一决策表算出，并带上判定理由与事实。 */
  function snapshot() {
    const at = now()
    const rows = []
    const pendingRows = []
    for (const entry of sessions) {
      const id = entry[0]
      const state = entry[1]
      const f = state.facts
      // 三个来源合并，谁都不能无条件覆盖谁：
      //   · approval      —— approval/asked 事件维护，投影不涉及
      //   · question/plan —— userQuestions 投影（只覆盖带 timeout 的提问）
      //   · tool-call     —— 未结束的交互式工具调用（覆盖阻塞式提问 / 计划评审）
      // 投影**明确为 null** 才清掉投影来源；投影不可用（undefined）时保留现有事实。
      const projection = projectionFor(id, f)
      // 集合是事实源：投影与事件/工具调用并列，谁都不能一把清空别人。
      if (!Array.isArray(f.pendingInteractions)) {
        f.pendingInteractions = f.pendingInteraction === undefined || f.pendingInteraction === null
          ? []
          : [f.pendingInteraction]
      }
      const withoutProjection = f.pendingInteractions.filter((item) => item.source !== 'projection')
      if (projection === undefined) {
        // 投影不可用：保留现有事实（包括上一次的投影）
        f.pendingInteractions = f.pendingInteractions
      } else if (projection === null) {
        // 投影明确为空：只清投影来源，事件与工具调用不动
        f.pendingInteractions = withoutProjection
      } else {
        // 有投影：替换投影来源那一条，事件/工具调用照旧
        f.pendingInteractions = [...withoutProjection, { ...projection, turnKey: f.turnKey, source: 'projection' }]
      }
      syncPendingSlot(f)
      // 回收只针对**没有未替代停止事实**的陈旧会话：显示缓存可以过期，
      // 但「当前任务已因错误停止」是还没被恢复/替代的事实，不能随时间忘掉。
      // 上一版按普通 ttlMs 直接删行，blocked 会在 6 小时后凭空消失。
      const keepStop = stopProofOf(f) !== undefined
      if (!keepStop && at - state.lastAt > ttlMs && f.turnOpen !== true) {
        pendingRows.push(id)
        continue
      }
      const verdict = decide(f, { now: at })
      const stoppedStop = stopProofOf(f)
      if (state.phase !== verdict.phase || state.phaseSince === undefined) {
        state.phase = verdict.phase
        state.phaseSince = at
      }
      const row = {
        id,
        phase: verdict.phase,
        reason: verdict.reason,
        detail: detailOf(f, verdict.phase),
        since: state.phaseSince,
        updatedAt: state.lastAt,
        sampledAt: at,
        completionKey: verdict.completionKey,
        turnKey: f.turnKey,
        turnOpen: f.turnOpen === true,
        agentRunning: f.agentRunning === true,
        turnsSeen: state.turnsSeen,
        lastEvent: state.lastEventType,
        toolCount: Array.isArray(f.tools) ? f.tools.length : 0,
        // 快于页面轮询的调用也能被观察一次；只是动效证据，不延长 working 相位。
        toolActivityKey: f.toolActivity?.key || '',
        toolActivityAt: f.toolActivity?.at,
        toolActivityTurnKey: f.toolActivity?.turnKey || '',
        pendingKind:
          f.pendingInteraction === undefined || f.pendingInteraction === null ? '' : f.pendingInteraction.kind,
        // A. 诊断（给人看，不参与判定）
        errorCode: f.error === undefined || f.error === null ? '' : String(f.error.code || ''),
        terminalKind: f.terminal === undefined || f.terminal === null ? '' : String(f.terminal.kind),
        // B. 自动恢复：重试调度仍在当前轮有效 = 任务没停
        retryId: f.retry === undefined || f.retry === null ? '' : String(f.retry.retryId || ''),
        // 与 decide() 共用同一个判定：不能出现 phase=idle 却 retrying=true 的快照。
        retrying: retryActive(f, at),
        // C. 任务级错误停止：页面核验 blocked 只需要这几个字段。
        //    ⚠️ 这是**事实**，不是状态；六态仍由 decide() 算。
        stopCertain: stoppedStop === undefined ? false : true,
        stopCause: stoppedStop === undefined ? '' : String(stoppedStop.cause || ''),
        stopSource: stoppedStop === undefined ? '' : String(stoppedStop.source || ''),
        stopCode: stoppedStop === undefined ? '' : String(stoppedStop.code || ''),
        stopTurnKey: stoppedStop === undefined ? '' : String(stoppedStop.turnKey || ''),
      }
      if (f.terminal !== undefined && f.terminal !== null && typeof f.terminal.completedAt === 'number') {
        row.completedAt = f.terminal.completedAt
      }
      rows.push(row)
    }
    for (const id of pendingRows) {
      sessions.delete(id)
      pendingQuestions.delete(id)
    }
    rows.sort((left, right) => right.updatedAt - left.updatedAt)
    return { now: at, sessions: rows }
  }

  /** 调试用：拿到原始状态（只读用途）。 */
  function peek(id) {
    return sessions.get(id)
  }

  return { onEvent, onAgent, onStream, onPendingQuestion, snapshot, peek }
}
