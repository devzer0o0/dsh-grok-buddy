/**
 * 完成展示的记忆：**同一完成周期只初始化一次，然后一直庆祝到离开 done**。
 *
 * 用户确认的规则：
 *   「活跃时持续庆祝；查看并切走或失活后变为灰色 idle。」
 *
 * 所以这里没有固定时长，也不再往 proud/idle 回落：
 *   · displayPhase === done  → 始终 celebrate（不重启、不重置相位起点）；
 *   · 离开 done              → 立刻离开完成动作，并把记忆清空；
 *   · 同一 completionKey 的完成周期只初始化一次 —— 轮询再多次也不会重启动画。
 *
 * 历史「只播一次」不再解释为「只播放 2.6 秒」。保留的约束是：
 * 同一完成周期只初始化一次，持续播放期间不重复重启。
 *
 * @module dsh-grok-buddy/celebrate
 */

/** 稳定动作名（内部动画预设标识，**不是**运行状态）。 */
export const CELEBRATE_MOTION = 'celebrate'

/** 一张干净的记忆：没有正在进行的完成周期。 */
export function freshMemory() {
  return { completionKey: '', started: false, celebrating: false }
}

/**
 * 根据展示状态与记忆，算出这一刻该用哪个动作预设。
 *
 * @param {string} displayPhase 六态之一（页面侧算好的 displayPhase）。
 * @param {{completionKey?: string, started?: boolean, celebrating?: boolean}} memory 上一轮记忆。
 * @param {Record<string, string>} motions 六态 → 动作预设名。
 * @param {string} completionKey 当前完成身份（done 时用来区分是不是同一个完成周期）。
 * @returns {{motion: string, memory: object, start: boolean}} 动作与新的记忆。
 */
export function resolveMotion(displayPhase, memory, motions, completionKey) {
  const previous = memory !== undefined && memory !== null ? memory : freshMemory()
  const map = motions !== undefined && motions !== null ? motions : {}

  if (displayPhase !== 'done') {
    // 离开完成：记忆清零，下一次完成可以建立新的展示周期
    return { motion: map[displayPhase] || map.idle || 'idle', memory: freshMemory(), start: false }
  }

  const key = typeof completionKey === 'string' ? completionKey : ''
  const samePeriod = previous.started === true && previous.completionKey === key && key !== ''
  if (samePeriod) {
    // 同一个完成周期的后续轮询：仍是 celebrate，但不重启
    return {
      motion: map.done || CELEBRATE_MOTION,
      memory: { completionKey: key, started: true, celebrating: true },
      start: false,
    }
  }
  // 新的完成周期：初始化一次
  return {
    motion: map.done || CELEBRATE_MOTION,
    memory: { completionKey: key, started: true, celebrating: true },
    start: true,
  }
}

/** 完成展示周期结束后的记忆（诊断/文案用，不再驱动动画计时）。 */
export function afterCelebration() {
  return freshMemory()
}
