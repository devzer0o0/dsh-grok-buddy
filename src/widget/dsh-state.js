/**
 * 把「插件事件流推出的状态」与「DSH 自己画在行里的 data-state」融成一个六态。
 *
 * 为什么需要融合：本插件的状态来自宿主事件流，但下面两类会话永远不会有完整事件流：
 *   · 插件（重新）启动前就已经在跑的会话
 *   · 会话文件在磁盘上、但这一轮 host 还没对它发过事件
 *
 * 它们在登记表里查不到，只能靠 DSH 自己在行里画的状态点：
 *   <span data-state="idle|ongoing|warning|done">
 *
 * 融合规则（不是「有值就优先」，也不是「DSH 说 done 就永远覆盖」）：
 *
 *   1. 我们有**强证据**（working / waiting / thinking）→ 用我们的。
 *      DSH 那个点只有四档，分不出「在跑工具」和「在想」。
 *      ⚠️ blocked **不在**「无条件优先」之列：它必须带任务级停止证据
 *      （stopCertain）才可信，否则旧宿主/旧缓存的 blocked 会冒充已确认停止。
 *   2. DSH 说 done、我们也说 done → done（一致）。
 *   3. 我们说 idle 但 DSH 说 done：只有**该完成记录未被消费**时才采信 DSH。
 *      已消费的完成记录，DSH 遗留的 done 不能让它重新庆祝。
 *   4. DSH 说 ongoing / warning 而我们只有 idle（插件中途接入）→ 采信 DSH。
 *   5. 其余用我们的。
 *
 * 「DSH 因已读而移除完成点」不会擦除历史完成事实 —— 事实在宿主登记表里，
 * 这里只决定**这一刻画什么**。
 *
 * @module dsh-grok-buddy/dsh-state
 */

/** DSH 的状态点取值 → 本插件的状态。 */
const STATE_MAP = Object.freeze({
  done: 'done',
  ongoing: 'thinking',
  warning: 'waiting',
  idle: 'idle',
})

/** 我们自己能分辨得更细、需要压过 DSH 粗粒度信号的状态。 */
const OURS_WINS = new Set(['working', 'thinking', 'waiting'])

/**
 * 宿主判定理由里表示「有过完成、但展示周期已经结束」的那些。
 * 这些情况下，DOM 上遗留的 done 不能再把头像顶回完成态。
 */
const EXPIRED_REASONS = new Set(['completion-expired', 'completion-consumed'])

/**
 * 从一行会话里读出 DSH 自己的状态点。
 *
 * 我们自己的样式会把原生状态点藏掉（display:none），但节点与属性都还在，
 * 读属性不受影响。
 *
 * @param {Element} row 会话行。
 * @returns {string|null} 六态之一；读不到返回 null。
 */
export function dshStateOf(row) {
  if (row === null || row === undefined || typeof row.querySelector !== 'function') return null
  const dot = row.querySelector('[data-state]')
  if (dot === null) return null
  const value = dot.getAttribute('data-state')
  if (typeof value !== 'string') return null
  return STATE_MAP[value] || null
}

/** 读 DSH 状态点的原始取值（诊断用，保留原样）。 */
export function dshRawStateOf(row) {
  if (row === null || row === undefined || typeof row.querySelector !== 'function') return null
  const dot = row.querySelector('[data-state]')
  if (dot === null) return null
  return dot.getAttribute('data-state')
}

/**
 * 插件没有这个会话的事件时，直接用 DSH 的状态点。
 * @param {Element} row 会话行。
 * @returns {string} 六态之一。
 */
export function fallbackPhase(row) {
  const fromDsh = dshStateOf(row)
  return fromDsh === null ? 'idle' : fromDsh
}

/**
 * 融合「插件事件流状态」与「DSH 画在行里的状态点」。
 *
 * @param {object} input 融合输入。
 * @param {string} input.phase 我们的展示状态（六态）。
 * @param {boolean} [input.known] 登记表里有没有这个会话。
 * @param {boolean} [input.consumed] 这条完成记录是否已被消费。
 * @param {string} [input.completionKey] 当前完成身份。
 * @param {Element} input.row 会话行（读 DSH 状态点）。
 * @param {boolean} [input.stopCertain] 是否有可信的任务级错误停止证据
 *   （调用方按 decide 的同一套证明校验得出：确证来源 + 明确错误原因 + 当前轮身份）。
 * @returns {{phase: string, source: string, dshState: string|null}} 融合结果与来源。
 */
export function mergePhase(input) {
  const opts = input !== undefined && input !== null ? input : {}
  const ours = typeof opts.phase === 'string' && opts.phase !== '' ? opts.phase : 'idle'
  const dshState = dshStateOf(opts.row)
  const raw = dshRawStateOf(opts.row)
  const known = opts.known === true

  if (dshState === null) return { phase: ours, source: 'plugin', dshState: raw }

  // 1) 我们的强证据优先
  if (OURS_WINS.has(ours)) return { phase: ours, source: 'plugin', dshState: raw }
  // 1b) blocked 只在**有停止证据**时才压过 DSH 的粗粒度信号。
  //     没有证据的 blocked 交给调用方降级（这里不凭空造出别的状态）。
  if (ours === 'blocked') {
    return opts.stopCertain === true
      ? { phase: 'blocked', source: 'plugin', dshState: raw }
      : { phase: 'idle', source: 'blocked-without-evidence', dshState: raw }
  }

  // 2) 都说完成
  if (ours === 'done' && dshState === 'done') return { phase: 'done', source: 'agree', dshState: raw }

  if (dshState === 'done') {
    // 3) DSH 说完成：已被消费的完成记录不能因此重新庆祝
    if (opts.consumed === true) return { phase: 'idle', source: 'consumed', dshState: raw }
    // 宿主已经明确说过「这条完成展示已失活」时，遗留的 DOM done 不能把它顶回 done。
    // 这正是「灰色庆祝」那条：状态文字是 idle、实例却还在 celebrate。
    // 靠 reason 区分两种 idle：
    //   completion-expired / completion-consumed → 曾经完成、现在不该再展示
    //   no-open-turn / silent-turn               → 根本没有可展示的完成（DOM done 仍可兜底）
    if (ours === 'idle' && opts.known === true && EXPIRED_REASONS.has(String(opts.reason || ''))) {
      return { phase: 'idle', source: 'expired', dshState: raw }
    }
    return { phase: 'done', source: 'dsh', dshState: raw }
  }

  // DSH 说 idle：以我们的为准（我们可能刚收到更准的完成/空闲事实）
  if (dshState === 'idle') return { phase: ours, source: 'plugin', dshState: raw }

  // 4) DSH 说 ongoing / warning，而我们没有更强的事实（含插件中途接入）
  if (ours === 'idle' || known !== true) return { phase: dshState, source: 'dsh', dshState: raw }

  // 5) 其余用我们的
  return { phase: ours, source: 'plugin', dshState: raw }
}

/**
 * 兼容旧签名：mergePhase(ours, row)。
 * @param {string} ours 我们的状态。
 * @param {Element} row 会话行。
 * @returns {string} 融合后的状态。
 */
export function mergePhaseLegacy(ours, row) {
  return mergePhase({ phase: ours, known: true, row }).phase
}
