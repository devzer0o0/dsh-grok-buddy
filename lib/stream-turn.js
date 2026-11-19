/**
 * 流式分片的执行身份。
 *
 * 宿主（dsh-agent-loop 的 AssistantStreamAttempt）发三帧：
 *   start { type, attemptId, revision, turn, step }
 *   chunk { type, attemptId, revision, index, time, chunk }   ← **没有 turn/step**
 *   end   { type, attemptId, revision, index, outcome }
 *
 * 只有 start 帧带 turn。旧实现把 frame.turn 直接透传给折叠器，chunk 帧拿到的是
 * undefined，于是 lib/fold.js 的两道身份门闸（当前轮 / 已封账轮）全部跳过 ——
 * 任何迟到的旧分片都能给已结束的任务续命。
 *
 * 这里按 attemptId 记住 start 帧的 turn，chunk 帧据此还原身份。
 * attemptId 由宿主生成为 `${sessionId}:${attempt}`，跨帧稳定。
 *
 * @module dsh-grok-buddy/stream-turn
 */

/** 记住多少个 attemptId（防止长会话里无限增长）。 */
const DEFAULT_LIMIT = 256

/**
 * 建一个 attemptId → turn 的短期记忆。
 *
 * @param {{limit?: number}} [options] 选项。
 * @returns {{observe: (frame: object) => ({turn: number|undefined}|undefined), size: () => number, clear: () => void}}
 */
export function createStreamTurnTracker(options) {
  const opts = options !== undefined && options !== null ? options : {}
  const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT
  /** @type {Map<string, number>} */
  const turns = new Map()

  const attemptIdOf = (frame) => (typeof frame.attemptId === 'string' && frame.attemptId !== '' ? frame.attemptId : '')

  const remember = (attemptId, turn) => {
    if (attemptId === '') return
    if (typeof turn !== 'number' || !Number.isFinite(turn)) return
    // 重新插入到队尾：Map 保持插入序，超限时从最旧的开始丢
    turns.delete(attemptId)
    turns.set(attemptId, turn)
    while (turns.size > limit) {
      const oldest = turns.keys().next()
      if (oldest.done === true) break
      turns.delete(oldest.value)
    }
  }

  /**
   * 看一帧，返回这一帧所属的轮次。
   *
   * 返回 undefined 表示「这一帧不该被折叠」（未知类型），
   * 返回 { turn: undefined } 表示「是流帧，但身份未知」—— 调用方照旧折叠，
   * 只是折叠器拿不到身份门闸（与旧行为一致，不会更糟）。
   *
   * @param {object} frame 宿主发出的流帧。
   * @returns {{turn: number|undefined}|undefined}
   */
  function observe(frame) {
    if (frame === null || typeof frame !== 'object') return undefined
    const type = frame.type
    const attemptId = attemptIdOf(frame)
    if (type === 'start') {
      remember(attemptId, frame.turn)
      return { turn: typeof frame.turn === 'number' && Number.isFinite(frame.turn) ? frame.turn : undefined }
    }
    if (type === 'chunk') {
      return { turn: turns.get(attemptId) }
    }
    if (type === 'end') {
      const turn = turns.get(attemptId)
      turns.delete(attemptId)
      return { turn }
    }
    return undefined
  }

  return {
    observe,
    size: () => turns.size,
    clear: () => turns.clear(),
  }
}
