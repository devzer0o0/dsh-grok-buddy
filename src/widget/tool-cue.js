/**
 * Short tool calls can start AND finish between two state polls. Keep a single,
 * bounded visual acknowledgment, without inventing a runtime phase or lying about
 * tools still running. Terminal/interaction states always interrupt it.
 */
export const TOOL_CUE_MS = 650
export const TOOL_CUE_FRESH_MS = 1500

export function advanceToolCue(previous, entry, now, visible = true) {
  const key = typeof entry.toolActivityKey === 'string' ? entry.toolActivityKey : ''
  const turnKey = typeof entry.turnKey === 'string' ? entry.turnKey : ''
  const same = previous?.key === key && previous?.turnKey === turnKey
  const eligible = visible && (entry.phase === 'working' || entry.phase === 'thinking') &&
    key !== '' && turnKey !== '' && entry.toolActivityTurnKey === turnKey
  const age = now - entry.toolActivityAt
  const fresh = Number.isFinite(age) && age >= 0 && age <= TOOL_CUE_FRESH_MS
  return {
    key, turnKey,
    until: eligible && fresh ? (same ? previous.until : now + TOOL_CUE_MS) : 0,
  }
}

export function toolCueActive(cue, phase, now) {
  return phase === 'thinking' && cue !== undefined && now < cue.until
}
