/**
 * 最近活动项目自动置顶（宿主半侧）。
 *
 * 规则：某个工作区（侧栏文件夹）里**新会话开始活动**时，把它移到第一位；
 * 同一会话后续的轮次不再移动。所以 a1 新会话开始 → a1 置顶；a2 新会话开始
 * → a2 置顶（a1 退第二）；a1 那个会话继续跑 → 不动；a1 又开新会话 → a1 再置顶。
 *
 * 判据是「本插件第一次见到这个 sessionId 的 turn/start」，**不是** turn === 1：
 * 宿主恢复会话时 turn 号从历史继续递增（dsh-agent-loop/src/agent.ts:340-342），
 * 用 turn 号会把「恢复后继续对话」误判成新会话。
 *
 * 排序只走宿主 workspaceRegistry.insertBefore(id, firstId)：宿主 WorkspaceFeed
 * 监听 domain/changed，workspaceIds 一变就 publish({type:'order'})，侧栏自己重排。
 * 插件前端不碰 DOM 顺序。
 *
 * 所有失败都只 warn —— 这个模块挂在 session/event 上，绝不能把异常带进会话提交路径。
 *
 * @module dsh-grok-buddy/promote
 */

/** 默认重试参数：会话 create 与 attachSession 之间有竞态，需要等一拍。 */
const DEFAULT_RETRY_ATTEMPTS = 4
const DEFAULT_RETRY_DELAY_MS = 400

/** seen 集合的防御上限：只用来判「第一次见」，不需要无限增长。 */
const DEFAULT_SEEN_LIMIT = 2000

/**
 * 从宿主 registry 读工作区列表。
 *
 * 权威形状是 workspaceRegistry.list()：按 workspaceIds 顺序返回实体，实体字段为
 * id / sessionIds。另兼容若干常见的 list()/snapshot()/items 形状；认不出来返回 null。
 *
 * @param {object} service 宿主工作区服务。
 * @returns {unknown} 原始列表值，或 null。
 */
function readList(service) {
  if (service === null || service === undefined) return null
  try {
    if (typeof service.list === 'function') return service.list()
    if (typeof service.snapshot === 'function') return service.snapshot()
    if (typeof service.getSnapshot === 'function') return service.getSnapshot()
    if (service.list !== null && typeof service.list === 'object' && typeof service.list.getSnapshot === 'function') {
      return service.list.getSnapshot()
    }
    if (Array.isArray(service.items)) return service.items
    if (Array.isArray(service.workspaces)) return service.workspaces
  } catch (err) {
    return null
  }
  return null
}

/**
 * 把列表值归一成 [{ id, sessionIds }]，保持宿主给的顺序。
 *
 * @param {unknown} value readList 的返回值。
 * @returns {Array<{id: string, sessionIds: string[]}>|null} 归一结果；认不出来返回 null。
 */
function entriesOf(value) {
  if (value === null || value === undefined) return null
  if (value !== null && typeof value === 'object' && value.pending === true) return null
  const items = Array.isArray(value) ? value : Array.isArray(value.items) ? value.items : Array.isArray(value.workspaces) ? value.workspaces : null
  if (items === null) return null
  const entries = []
  for (const item of items) {
    if (typeof item === 'string') {
      if (item !== '') entries.push({ id: item, sessionIds: [] })
      continue
    }
    if (item === null || typeof item !== 'object') continue
    const id = typeof item.workspaceId === 'string' && item.workspaceId !== '' ? item.workspaceId : typeof item.id === 'string' ? item.id : ''
    if (id === '') continue
    const sessionIds = Array.isArray(item.sessionIds) ? item.sessionIds.filter((sid) => typeof sid === 'string' && sid !== '') : []
    entries.push({ id, sessionIds })
  }
  return entries
}

/**
 * 建一个置顶器。
 *
 * @param {object} options
 * @param {() => object|null} options.resolveService 取宿主工作区服务（每次现取，服务可能晚到）。
 * @param {() => boolean} [options.isEnabled] 开关；返回 false 时完全不动作。
 * @param {(what: string, err?: unknown) => void} [options.warn] 日志。
 * @param {number} [options.retryAttempts] 找不到归属时的重试次数。
 * @param {number} [options.retryDelayMs] 重试间隔。
 * @param {number} [options.seenLimit] seen 集合上限。
 * @param {(ms: number) => Promise<void>} [options.sleep] 测试可替换的等待。
 * @returns {{onSessionEvent: Function, pending: Function, dispose: Function}} 置顶器。
 */
export function createWorkspacePromoter(options) {
  const opts = options !== undefined && options !== null ? options : {}
  const resolveService = typeof opts.resolveService === 'function' ? opts.resolveService : () => null
  const isEnabled = typeof opts.isEnabled === 'function' ? opts.isEnabled : () => true
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {}
  const retryAttempts = Number.isInteger(opts.retryAttempts) && opts.retryAttempts >= 0 ? opts.retryAttempts : DEFAULT_RETRY_ATTEMPTS
  const retryDelayMs = Number.isFinite(opts.retryDelayMs) && opts.retryDelayMs >= 0 ? opts.retryDelayMs : DEFAULT_RETRY_DELAY_MS
  const seenLimit = Number.isInteger(opts.seenLimit) && opts.seenLimit > 0 ? opts.seenLimit : DEFAULT_SEEN_LIMIT
  const sleep =
    typeof opts.sleep === 'function'
      ? opts.sleep
      : (ms) =>
          new Promise((resolve) => {
            const timer = setTimeout(resolve, ms)
            if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
          })

  /** 已经触发过置顶的会话：同一会话的后续轮次不再移动。 */
  const seen = new Set()
  const seenOrder = []
  let queue = Promise.resolve()
  let disposed = false

  function remember(sessionId) {
    seen.add(sessionId)
    seenOrder.push(sessionId)
    while (seenOrder.length > seenLimit) {
      const oldest = seenOrder.shift()
      if (typeof oldest === 'string') seen.delete(oldest)
    }
  }

  /** 读一次列表并找出会话所属的工作区 id。 */
  async function locate(service, sessionId, cwd) {
    const entries = entriesOf(readList(service))
    if (entries === null) return { entries: null, targetId: undefined }
    for (const entry of entries) {
      if (entry.sessionIds.indexOf(sessionId) !== -1) return { entries, targetId: entry.id }
    }
    // 会话可能还没 attach（create 与 attachSession 之间有竞态），用 cwd 兜底。
    if (typeof cwd === 'string' && cwd !== '' && typeof service.resolveByPath === 'function') {
      try {
        const workspace = await service.resolveByPath(cwd)
        if (workspace !== null && workspace !== undefined && typeof workspace.id === 'string' && workspace.id !== '') {
          return { entries, targetId: workspace.id }
        }
      } catch (err) {
        // 路径不存在 / 未拥有都会 reject，属于正常情况。
      }
    }
    return { entries, targetId: undefined }
  }

  /** 真正做一次置顶。内部全部吞异常。 */
  async function promote(sessionId, cwd) {
    if (disposed) return
    try {
      if (isEnabled() === false) return
      const service = resolveService()
      if (service === null || service === undefined) return
      if (typeof service.insertBefore !== 'function') return

      let located = await locate(service, sessionId, cwd)
      let attempt = 0
      while (located.targetId === undefined && attempt < retryAttempts) {
        attempt += 1
        await sleep(retryDelayMs)
        if (disposed) return
        located = await locate(service, sessionId, cwd)
      }
      const entries = located.entries
      if (entries === null || entries.length < 2) return
      const targetId = located.targetId
      if (targetId === undefined) {
        warn('置顶：找不到会话所属的工作区', sessionId)
        return
      }
      const firstId = entries[0].id
      if (targetId === firstId) return
      await service.insertBefore(targetId, firstId)
    } catch (err) {
      warn('置顶失败', err)
    }
  }

  /**
   * 观察一条会话事件。只认 turn/start，且每个会话只触发一次。
   *
   * @param {object} session 宿主 Session 实例。
   * @param {object} event 会话事件。
   */
  function onSessionEvent(session, event) {
    if (disposed) return
    if (event === null || event === undefined || event.type !== 'turn/start') return
    if (session === null || session === undefined) return
    const sessionId = typeof session.id === 'string' && session.id !== '' ? session.id : undefined
    if (sessionId === undefined) return
    const header = session.header
    // 子会话不参与：它们跟着父会话跑，置顶父项目就够了。
    if (header !== null && header !== undefined && header.origin === 'subagent') return
    if (seen.has(sessionId)) return
    remember(sessionId)
    const cwd = header !== null && header !== undefined && typeof header.cwd === 'string' ? header.cwd : undefined
    // 串行执行：并发触发时顺序确定，也不会同时写宿主 registry。
    queue = queue.then(() => promote(sessionId, cwd)).catch((err) => {
      warn('置顶队列失败', err)
    })
  }

  return {
    onSessionEvent,
    /** 等当前队列跑完（测试用）。 */
    pending() {
      return queue
    },
    /** 卸载：清空状态，避免热重载泄漏。 */
    dispose() {
      disposed = true
      seen.clear()
      seenOrder.length = 0
      queue = Promise.resolve()
    },
  }
}
