/**
 * 「这一行现在算不算活跃」的判定 —— 以及它该用项目色还是灰色。
 *
 * 颜色表示**项目身份**，不表示运行状态：六种状态同色。
 * 灰色是「失活展示」，选中行优先显示项目色。
 *
 * 三档：
 *   - **选中**：项目色（哪怕它是空闲）
 *   - **活跃**：项目色 —— 在跑、等你、已确认错误停止（还没被新一轮取代）、刚完成还没被看过
 *   - **不活跃**：灰色 —— idle，或完成展示已结束/已被消费
 *
 * @module dsh-grok-buddy/activity
 */

import { DONE_DISPLAY_TTL_MS } from '../decision.js'

/** 完成之后一直没人看，多久算「凉了」（完成展示失活阈值，集中来自 decision.js）。 */
export const COOLDOWN_MS = DONE_DISPLAY_TTL_MS

/** 不活跃时用的灰。 */
export const DORMANT_INK = Object.freeze({
  light: '#777777',
  dark: '#9a9a9a',
})

/** 这些状态都还值得看着（blocked = 已确认的错误停止，在恢复前一直是当前任务）。 */
const LIVE_PHASES = new Set(['thinking', 'working', 'waiting', 'blocked'])

/**
 * 这一行是不是活跃的。
 *
 * @param {object} row 一行的事实。
 * @param {string} row.phase 展示状态（六态之一）。
 * @param {boolean} [row.selected] 是否被选中（选中永远算活跃）。
 * @param {number} [row.completedAt] 完成时刻（epoch ms，只对 done 有意义）。
 * @param {number} [row.observedAt] 首次观测到该完成记录的时刻（completedAt 未知时的锚点）。
 * @param {number} [row.seenAt] 用户最后一次点开这一行的时刻（epoch ms）。
 * @param {boolean} [row.consumed] 这条完成记录是否已被消费。
 * @param {number} now 当前时刻。
 * @returns {boolean} 活跃为 true。
 */
export function isActive(row, now) {
  if (row === null || row === undefined) return false
  const phase = typeof row.phase === 'string' ? row.phase : 'idle'

  // 正在发生的事永远是活跃的；已阻止卡住了也需要人看
  if (LIVE_PHASES.has(phase)) return true

  // 选中就是「当前正在看这一行」：显示当前项目的颜色。
  // 这一条要盖在「看过就凉」上面 —— 点开一个已完成会话时它既是 selected 又是 seen，
  // 此刻仍给项目色；等你切走、选中解除，seen 才生效，它变灰。
  if (row.selected === true) return true

  if (phase === 'done') {
    const completedAt = typeof row.completedAt === 'number' ? row.completedAt : undefined
    const observedAt = typeof row.observedAt === 'number' ? row.observedAt : undefined
    const seenAt = typeof row.seenAt === 'number' ? row.seenAt : undefined
    // 这条完成记录被消费掉了 —— 凉
    if (row.consumed === true) return false
    // 被点开看过 —— 这一次完成已经被消费掉了，凉
    if (seenAt !== undefined) {
      const anchor = completedAt !== undefined ? completedAt : observedAt
      if (anchor === undefined || seenAt >= anchor) return false
    }
    // 完成展示失活，也凉
    const anchor = completedAt !== undefined ? completedAt : observedAt
    if (anchor !== undefined && now - anchor > COOLDOWN_MS) return false
    return true
  }

  // idle：安静就是凉
  return false
}

/**
 * 头像最终该用哪个墨色。
 *
 * @param {object} row 一行的事实（同 isActive）。
 * @param {number} now 当前时刻。
 * @param {string} projectInk 这个项目的颜色。
 * @param {boolean} dark 是否深色主题（只影响灰色的两档）。
 * @returns {string} 墨色。
 */
export function inkForRow(row, now, projectInk, dark) {
  if (isActive(row, now)) return projectInk
  return dark ? DORMANT_INK.dark : DORMANT_INK.light
}
