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

import { RUNTIME_PHASES, decide } from '../src/decision.js'
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
    // 一轮收尾后宿主的提问投影也会清；跟着清掉，别让不可能被回答的提问占住 waiting。
    if (event !== null && typeof event === 'object' && event.type === 'turn/end') pendingQuestions.delete(id)
  }

  /** 折入 agent 级信号。 */
  function onAgent(sessionId, kind, payload) {
    const state = ensure(sessionId)
    if (state === undefined) return
    applyAgentSignal(state, kind, payload, now())
  }

  /** 折入一条流式分片。 */
  function onStream(sessionId) {
    const state = ensure(sessionId)
    if (state === undefined) return
    applyStreamChunk(state, now())
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
    pendingQuestions.set(sessionId, {
      kind: pending.kind === 'plan-review' ? 'plan-review' : 'question',
      toolName: typeof pending.toolName === 'string' ? pending.toolName : 'ask_user_question',
      key: typeof pending.callId === 'string' ? pending.callId : '',
      at: now(),
    })
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
      const projection = pendingQuestions.get(id)
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
      if (at - state.lastAt > ttlMs && f.turnOpen !== true) {
        pendingRows.push(id)
        continue
      }
      const verdict = decide(f, { now: at })
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
        pendingKind:
          f.pendingInteraction === undefined || f.pendingInteraction === null ? '' : f.pendingInteraction.kind,
        errorCode: f.error === undefined || f.error === null ? '' : String(f.error.code || ''),
        terminalKind: f.terminal === undefined || f.terminal === null ? '' : String(f.terminal.kind),
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