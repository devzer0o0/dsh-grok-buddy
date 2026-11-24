/**
 * dsh-grok-buddy —— 侧栏会话（任务）状态表情，宿主半侧。
 *
 * 做四件事，都不写会话、不改模型请求：
 *
 *   1. 订阅事实来源：session/event、agent/assistant-stream、agent/status、agent/error，
 *      以及 DSH 自己的 userQuestions 会话投影（挂起提问 / 计划评审的真实来源）
 *   2. 用 lib/fold.js + src/decision.js 折成每个会话一个六态相位，
 *      暴露成 GET /dsh-grok-buddy/state.json
 *   3. 把页面脚本 /dsh-grok-buddy/widget.js 注入到 Web GUI 的 head
 *   4. 提供默认关闭的一次性诊断采样端点
 *
 * 注入走两条路径（与 dsh-tps 同构，桌面版与 dsh web 各一条）：
 *   - webserver/index-inject 结构化注入行：桌面版外壳唯一受支持的注入方式
 *   - webServer.tapIndex：Host 自己渲染 index.html 时直接改 HTML，作为兜底
 *
 * @module dsh-grok-buddy
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRegistry } from './derive.js'
import { createStreamTurnTracker } from './stream-turn.js'
import { createColorStore, colorsFile } from './colors-store.js'
import { createSettingsStore, settingsFile } from './settings-store.js'
import { createProbeStore } from './probe.js'
import { createWorkspacePromoter } from './promote.js'
import { normalizeColor } from '../src/colors-shared.js'
import { storeKey } from '../src/palette.js'
import { pickUnusedColor } from './auto-color.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIDGET_FILE = path.join(HERE, 'widget.js')

/** 路由命名空间。exact 路由重复注册会抛错，所以整棵树只用这几个路径。 */
const BASE = '/dsh-grok-buddy'
const SCRIPT_PATH = BASE + '/widget.js'
const STATE_PATH = BASE + '/state.json'
const COLORS_PATH = BASE + '/colors.json'
const SETTINGS_PATH = BASE + '/settings.json'
const AUTO_COLOR_PATH = BASE + '/auto-color.json'
const WORKSPACES_PATH = BASE + '/workspaces.json'
const RECENT_PATH = BASE + '/recent.json'
const PROBE_PATH = BASE + '/probe.json'
const PROBE_CONTROL_PATH = BASE + '/probe-control.json'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}
const JS_HEADERS = {
  'Content-Type': 'application/javascript; charset=utf-8',
  'Cache-Control': 'no-store',
}

/** 允许的 HTTP 方法：其它方法一律 405（不是静默当成 GET）。 */
const ALLOWED_METHODS = 'GET, HEAD, POST'

/** Cordis 插件名（同时是 loader 条目 id 与 profile insert 行的 name）。 */
export const name = 'dsh-grok-buddy'

/** 需要能挂 HTTP 路由的 webServer。 */
export const inject = ['webServer']

/** 内联引导脚本：挂上表情脚本，加载失败只吞掉错误。只用 ES5 语法。 */
const LOADER = [
  '(function(){try{',
  'var s=document.createElement("script");',
  's.src=' + JSON.stringify(SCRIPT_PATH) + ';',
  's.async=true;',
  's.onerror=function(){};',
  'document.head.appendChild(s)',
  '}catch(e){}})()',
].join('')

/** 这个请求用的是哪个方法（缺省当 GET）。 */
function methodOf(req) {
  const method = req !== undefined && req !== null ? req.method : undefined
  return typeof method === 'string' ? method.toUpperCase() : 'GET'
}

/** 统一写一个 JSON 响应（405 带 Allow 头）。 */
function sendJson(res, status, body) {
  const headers = status === 405 ? { ...JSON_HEADERS, Allow: ALLOWED_METHODS } : JSON_HEADERS
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

/** 只回头不带体（HEAD）。 */
function sendHead(res, headers) {
  res.writeHead(200, headers)
  res.end()
}

/**
 * 宿主 Workspace 全量列表的最小适配器。
 *
 * 权威来源是 ctx.workspaceRegistry.list()：按 workspaceIds 顺序返回
 * WorkspaceEntity，实体字段为 id。另兼容若干常见的 list()/snapshot()/items
 * 形状；拿不到或形状不认识时返回 null，由路由回 501，页面拒绝自动配色。
 */
const WORKSPACE_SERVICE_NAMES = ['workspaceRegistry', 'workspaces', 'workspace', 'workspaceController', 'workspaceService']

function resolveWorkspaceService(ctx) {
  if (ctx === null || ctx === undefined) return null
  for (const name of WORKSPACE_SERVICE_NAMES) {
    try {
      if (typeof ctx.get === 'function') {
        const value = ctx.get(name)
        if (value !== null && value !== undefined) return value
      }
    } catch (err) {}
    try {
      const value = ctx[name]
      if (value !== null && value !== undefined) return value
    } catch (err) {}
  }
  return null
}

function readWorkspaceList(service) {
  if (service === null || service === undefined) return null
  if (typeof service.list === 'function') return service.list()
  if (typeof service.snapshot === 'function') return service.snapshot()
  if (typeof service.getSnapshot === 'function') return service.getSnapshot()
  if (service.list !== null && typeof service.list === 'object' && typeof service.list.getSnapshot === 'function') {
    return service.list.getSnapshot()
  }
  if (service.items !== undefined) return service.items
  if (service.workspaces !== undefined) return service.workspaces
  return null
}

/**
 * 全量名册：{ ids, members, membersReady } / { pending } / null。
 *
 * ids      —— 所有 Workspace id（自动配色基线用）；
 * members  —— workspaceId → sessionIds（宿主 registry 实体的 sessionIds 是
 *              「这个文件夹按住哪些会话」的**唯一权威来源**）。会话→文件夹
 *             归属因此不依赖侧栏行有没有渲染：折叠的文件夹同样有成员表；
 * membersReady —— 是否**每一个**条目都真的给出了 sessionIds 数组。
 *
 * 「读不到归属」和「确认没有成员」必须分开：前者只是未知，页面照旧显示分组；
 * 后者才是可隐藏的空文件夹。所以每个条目都带 known，unknown 的条目
 * sessionIds 为空数组但 known=false，绝不被当成权威的空成员表。
 */
function workspaceRosterOf(value) {
  if (value === null || value === undefined) return null
  let items
  if (Array.isArray(value)) {
    items = value
  } else if (typeof value === 'object') {
    const phase = typeof value.phase === 'string' ? value.phase : ''
    const state = typeof value.state === 'string' ? value.state : ''
    if ((phase !== '' && phase !== 'ready') || state === 'loading') return { pending: true }
    if (Array.isArray(value.items)) items = value.items
    else if (Array.isArray(value.workspaces)) items = value.workspaces
    else return null
  } else {
    return null
  }
  const ids = []
  const members = []
  const seen = new Set()
  for (const item of items) {
    const id = typeof item === 'string'
      ? item
      : item !== null && typeof item === 'object'
        ? (typeof item.workspaceId === 'string' ? item.workspaceId : (typeof item.id === 'string' ? item.id : ''))
        : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    // 形状不认识（没有 sessionIds 数组）时 known=false：页面据此把该文件夹当作
    // 「归属未知」保持可见，而不是「确认空」。字符串项（旧形状）同样 known=false。
    // 宿主契约已确认：WorkspaceEntity 的 sessionIds 是 z.array(z.string())，
    // registry.list() 返回的实体就是这个形状，所以只有缺字段/旧宿主才走到 unknown。
    const raw = typeof item === 'string' ? undefined : item.sessionIds
    const known = Array.isArray(raw)
    const list = known ? raw : []
    const sessionIds = []
    const seenSession = new Set()
    for (const sessionId of list) {
      if (typeof sessionId !== 'string' || sessionId === '' || seenSession.has(sessionId)) continue
      seenSession.add(sessionId)
      sessionIds.push(sessionId)
    }
    members.push({ workspaceId: id, sessionIds, known })
  }
  const membersReady = members.length > 0 && members.every((entry) => entry.known === true)
  return { ids, members, membersReady }
}

/**
 * 宿主会话列表的最小适配器。
 *
 * 权威来源按优先级：sessionController.list()（带 cwd / running / blank 的完整
 * 会话记录）→ sessionQuery.listSessions()（只有 header，用 createdAt 兜底排序）
 * → registry.snapshot().sessions（插件自己的派生表，只有 id 与 updatedAt）。
 * 三级都拿不到时返回 null，路由回 200 + available:false，页面安静降级。
 */
const SESSION_SERVICE_NAMES = ['sessionController', 'sessionQuery', 'sessions']

function resolveSessionService(ctx) {
  if (ctx === null || ctx === undefined) return null
  for (const name of SESSION_SERVICE_NAMES) {
    try {
      if (typeof ctx.get === 'function') {
        const value = ctx.get(name)
        if (value !== null && value !== undefined) return { name, service: value }
      }
    } catch (err) {}
    try {
      const value = ctx[name]
      if (value !== null && value !== undefined) return { name, service: value }
    } catch (err) {}
  }
  return null
}

function readSessionList(service) {
  if (service === null || service === undefined) return null
  if (typeof service.list === 'function') return service.list()
  if (typeof service.listSessions === 'function') return service.listSessions()
  if (typeof service.snapshot === 'function') return service.snapshot()
  return null
}

/** 从各种形状里取出会话数组；认不出来返回 null。 */
function sessionArrayOf(value) {
  if (Array.isArray(value)) return value
  if (value === null || typeof value !== 'object') return null
  if (Array.isArray(value.sessions)) return value.sessions
  if (Array.isArray(value.items)) return value.items
  return null
}

/**
 * 已归档的会话 id 集合；拿不到归档信息时返回 null（不做任何过滤）。
 *
 * 宿主侧栏的 sessionVisible() 在默认 archivedFilter 下会直接丢弃归档会话，
 * 既不渲染行、也不参与搜索。归档会话因此**不该占「最近 N」的名额**：
 * 不计入的话，最近 5 条里有 1 条已归档，用户就只看到 4 条。
 */
function archivedIdsOf(ctx) {
  const service = resolveWorkspaceService(ctx)
  if (service === null || service === undefined) return null
  let raw
  try {
    raw = service.archivedSessionIds
  } catch (err) {
    return null
  }
  if (typeof raw === 'function') {
    try {
      raw = raw.call(service)
    } catch (err) {
      return null
    }
  }
  if (!Array.isArray(raw)) return null
  const ids = new Set()
  for (const id of raw) {
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  return ids
}

/**
 * 归一化成 [{ id, updatedAt, running }]，按 updatedAt 降序。
 *
 * 剔除四类不该占「最近 N」名额的条目：subagent 会话、还没说过话的空白会话、
 * **冷会话**（没有 cwd 的历史残留）、以及**已归档会话**（宿主侧栏根本不会渲染，
 * 占掉名额就会让「最近 5 条」只显示 4 条）。cwd 过滤只在数据源确实给出 cwd 时
 * 生效，否则 registry 兜底源会被整批误杀；归档集合同理，拿不到（null）就不过滤。
 */
function recentRowsOf(value, archived = null) {
  const items = sessionArrayOf(value)
  if (items === null) return null
  const rows = []
  let sawCwd = false
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const session = item.session !== null && typeof item.session === 'object' ? item.session : item
    const header = item.header !== null && typeof item.header === 'object' ? item.header : null
    const id = typeof session.sessionId === 'string'
      ? session.sessionId
      : typeof session.id === 'string'
        ? session.id
        : typeof item.sessionId === 'string'
          ? item.sessionId
          : header !== null && typeof header.id === 'string'
            ? header.id
            : ''
    if (id === '') continue
    if (session.blank === true) continue
    if (session.origin === 'subagent') continue
    if (archived !== null && archived.has(id)) continue
    const cwd = typeof session.cwd === 'string' ? session.cwd : ''
    if (cwd !== '') sawCwd = true
    const rawUpdated = typeof session.updatedAt === 'number'
      ? session.updatedAt
      : typeof item.updatedAt === 'number'
        ? item.updatedAt
        : header !== null && typeof header.createdAt === 'number'
          ? header.createdAt
          : 0
    rows.push({ id, updatedAt: rawUpdated, running: session.running === true, cwd })
  }
  const kept = sawCwd ? rows.filter((row) => row.cwd !== '') : rows
  kept.sort((left, right) => right.updatedAt - left.updatedAt)
  return kept
}

/** 最近 N 个会话（对外形状）：全量行按 updatedAt 降序后截断。 */
function recentSessionsOf(value, limit) {
  const rows = recentRowsOf(value)
  if (rows === null) return null
  const capped = typeof limit === 'number' && limit > 0 ? rows.slice(0, limit) : rows
  return capped.map((row) => ({ id: row.id, updatedAt: row.updatedAt, running: row.running }))
}

/**
 * 「最近活跃的项目与会话」计划：每个文件夹只留它自己最近的那个会话。
 *
 * rows 必须已按 updatedAt 降序（recentRowsOf 的输出），这样每个文件夹
 * 第一次遇到的成员就是它最近的会话。members 只认 known=true 的条目 ——
 * 归属未知时不能把会话误判成「未分组」。
 *
 * 项目数同样受 N 约束：按「项目最近会话的时间」排序后只留前 N 个项目，
 * 与参考效果一致（最近活跃的 N 个项目，不是全部 20 多个文件夹）。
 *
 * 返回 { latest: { workspaceId: sessionId }, ungrouped: [sessionId] }；
 * 名册不可信时返回 null，页面据此退回「全局最近 N 个」。
 */
function recentPlanOf(rows, members, limit) {
  if (!Array.isArray(rows) || !Array.isArray(members)) return null
  const owner = new Map()
  for (const entry of members) {
    if (entry === null || typeof entry !== 'object' || entry.known !== true) continue
    const workspaceId = typeof entry.workspaceId === 'string' ? entry.workspaceId : ''
    if (workspaceId === '') continue
    const ids = Array.isArray(entry.sessionIds) ? entry.sessionIds : []
    for (const id of ids) {
      if (typeof id === 'string' && id !== '' && !owner.has(id)) owner.set(id, workspaceId)
    }
  }
  const latest = {}
  // 项目首次出现的顺序就是它最近会话的先后（rows 已按 updatedAt 降序）。
  const projectOrder = []
  const ungrouped = []
  for (const row of rows) {
    const workspaceId = owner.get(row.id)
    if (workspaceId === undefined) {
      ungrouped.push(row.id)
      continue
    }
    if (latest[workspaceId] === undefined) {
      latest[workspaceId] = row.id
      projectOrder.push(workspaceId)
    }
  }
  const capped = typeof limit === 'number' && limit > 0
  const keptProjects = capped && projectOrder.length > limit ? projectOrder.slice(0, limit) : projectOrder
  const plan = {}
  for (const workspaceId of keptProjects) plan[workspaceId] = latest[workspaceId]
  return { latest: plan, ungrouped: capped ? ungrouped.slice(0, limit) : ungrouped }
}

/** 安全解析 JSON：null / 数组 / 非对象一律当非法输入，绝不写进状态。 */
function parseJsonObject(raw) {
  let value
  try {
    value = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: '不是合法 JSON' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '请求体必须是 JSON 对象' }
  }
  return { ok: true, value }
}

/** 收集请求体，超过上限就切断并标记。 */
function readBody(req, limit, done) {
  let raw = ''
  let tooBig = false
  req.on('data', (chunk) => {
    raw += chunk
    if (raw.length > limit) {
      tooBig = true
      req.destroy()
    }
  })
  req.on('end', () => done(tooBig, raw))
  req.on('error', () => {})
}

/**
 * 挂载插件。
 * @param {object} ctx 宿主 Cordis 上下文。
 */
export function apply(ctx) {
  const registry = createRegistry()

  /** 观察者绝不能把失败带进会话提交路径（firehose 是 fire-and-forget）。 */
  const warn = (what, err) => {
    try {
      const message = err !== undefined && err !== null && err.message !== undefined ? err.message : err
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(name + ': ' + what + ': ' + String(message))
    } catch (ignored) {}
  }

  /**
   * agent 级信号里的会话身份。
   *
   * 注意：不要假设 agent.id === session.id —— 本地 fixture 里常常相同，线上不一定。
   * agent.session.id 是权威来源，agent.id 只作兜底。
   */
  const sessionIdOfAgent = (agent) => {
    if (agent === undefined || agent === null) return undefined
    const session = agent.session
    if (session !== undefined && session !== null && typeof session.id === 'string' && session.id !== '') {
      return session.id
    }
    return typeof agent.id === 'string' && agent.id !== '' ? agent.id : undefined
  }

  // 1) 富事件流：turn/step、工具、审批、重试、报错、标题
  ctx.on('session/event', (session, event) => {
    try {
      registry.onEvent(session, event)
    } catch (err) {
      warn('session/event 处理失败', err)
    }
  })

  // 1.1) 最近活动项目自动置顶：新会话第一次 turn/start 时把它所在的文件夹移到第一位。
  // 开关走设置表，所以 isEnabled 用闭包延迟读 —— settings 在下面才创建。
  const promoter = createWorkspacePromoter({
    resolveService: () => resolveWorkspaceService(ctx),
    isEnabled: () => settings.snapshot().autoPromoteActiveWorkspace !== false,
    warn: (what, err) => warn(what, err),
  })
  ctx.on('session/event', (session, event) => {
    try {
      promoter.onSessionEvent(session, event)
    } catch (err) {
      warn('置顶处理失败', err)
    }
  })

  // 2) 流式分片：只用来判断模型是否已经开始吐字
  //
  // ⚠️ 宿主的 chunk 帧**不带 turn/step**（只有 start 帧带），所以不能直接透传
  // frame.turn —— 那样折叠器拿到 undefined，两道身份门闸全跳过，迟到的旧分片
  // 就能给已结束的任务续命。这里按 attemptId 记住 start 帧的 turn 再还原。
  const streamTurns = createStreamTurnTracker()
  ctx.on(
    'agent/assistant-stream',
    (payload) => {
      try {
        const frame = payload !== undefined && payload !== null ? payload.frame : undefined
        if (frame === null || typeof frame !== 'object') return
        const seen = streamTurns.observe(frame)
        if (seen === undefined) return
        const id = sessionIdOfAgent(payload.agent)
        if (typeof id !== 'string') return
        registry.onStream(id, { turn: seen.turn })
      } catch (err) {
        warn('assistant-stream 处理失败', err)
      }
    },
    { global: true },
  )

  // 3) agent 级信号：跑没在跑、崩没崩
  ctx.on('agent/status', (payload) => {
    try {
      const id = sessionIdOfAgent(payload !== undefined && payload !== null ? payload.agent : undefined)
      if (typeof id !== 'string') return
      registry.onAgent(id, 'status', { status: payload.status })
    } catch (err) {
      warn('agent/status 处理失败', err)
    }
  })

  /**
   * agent/error 的真实载荷是 { agent, turn, step, error }（宿主在 throwError 里发出）。
   * turn/step 是**执行身份**：丢掉它们就只能把错误含糊地记到「当前轮」，
   * 无法区分旧轮迟到的错误。这里原样透传，由 fold 决定能不能归属。
   */
  ctx.on('agent/error', (payload) => {
    try {
      const id = sessionIdOfAgent(payload !== undefined && payload !== null ? payload.agent : undefined)
      if (typeof id !== 'string') return
      registry.onAgent(id, 'error', {
        error: payload.error,
        turn: payload.turn,
        step: payload.step,
      })
    } catch (err) {
      warn('agent/error 处理失败', err)
    }
  })

  /**
   * 3.1) 挂起的提问与计划评审。
   *
   * DSH 里 ask_user_question 与 exit_plan_mode 都走 userQuestions 服务，
   * 落成会话投影 userQuestions（key 见 dsh-user-questions/lib/types/projection.js）。
   * 这里读宿主自己的投影，不发明事件名：
   *   active[].state === 'open'  → 还在等人回答
   *   questions[0].intent.kind === 'plan-review' → 计划评审
   *
   * 投影不可用时（插件装得比宿主旧、或服务没装）静默退化为只用审批事件。
   */
  if (typeof ctx.inject === 'function') ctx.inject(['sessionProjections'], (projectionCtx) => {
    const projections = projectionCtx.sessionProjections
    if (projections === undefined || projections === null) return
    // 读法优先级：snapshot()（0.2.1 起就有，0.2.2 是推荐读法）→ stateOf()（0.2.2 已 deprecated）。
    // 两者都不可用时静默退化为只用审批事件。
    const canSnapshot = typeof projections.snapshot === 'function'
    const canStateOf = typeof projections.stateOf === 'function'
    if (!canSnapshot && !canStateOf) return

    /**
     * 读宿主投影里的挂起提问。
     *
     * ⚠️ `stateOf()` 返回的是**宿主内部 raw state**，不是 wire view：
     *   raw   = { inheritedEventCount, timed, questions: { active, settled } }
     *   wire  = { active, settled }                      ← 由 wire.view 投影出来
     * 提问在 **state.questions.active**，不是 state.active。混用会永远读不到，
     * 于是真实挂起的提问被算成 working。
     *
     * active 里两种状态都算「还要人回答」：
     *   open      —— 正在等
     *   continued —— 带 timeout 的提问超时返回了 pending，用户仍然可以回答
     *
     * 返回约定（三态必须分开，不能都当「已解决」）：
     *   { ... }  明确有挂起提问
     *   null     明确没有
     *   undefined 投影不可用 / 读取失败 → 由调用方决定保留还是清空
     */
    const readPending = (session) => {
      let state
      try {
        if (canSnapshot) {
          // snapshot() 返回 { asOfSeq, values }，values 里是**wire view**（{ active, settled }），
          // 不是 raw state。下面的 state.questions 防御对两种形状都成立。
          const snap = projections.snapshot(session, ['userQuestions'])
          state = snap !== null && typeof snap === 'object' && snap.values !== null && typeof snap.values === 'object'
            ? snap.values.userQuestions
            : undefined
        } else {
          state = projections.stateOf(session, 'userQuestions')
        }
      } catch (err) {
        return undefined
      }
      if (state === undefined || state === null) return undefined
      // raw state 优先；同时容忍有人直接把 wire view 递过来（防御，不改语义）
      const view = state.questions !== null && typeof state.questions === 'object' ? state.questions : state
      const active = Array.isArray(view.active) ? view.active : []
      for (const entry of active) {
        if (entry === null || typeof entry !== 'object') continue
        if (entry.state !== 'open' && entry.state !== 'continued') continue
        const questions = Array.isArray(entry.questions) ? entry.questions : []
        const first =
          questions.length > 0 && questions[0] !== null && typeof questions[0] === 'object' ? questions[0] : {}
        const intent = first.intent !== null && typeof first.intent === 'object' ? first.intent : {}
        return {
          kind: intent.kind === 'plan-review' || first.id === 'plan-review' ? 'plan-review' : 'question',
          toolName: 'ask_user_question',
          callId: typeof entry.callId === 'string' ? entry.callId : '',
        }
      }
      return null
    }

    const sync = (session) => {
      try {
        const id = session !== undefined && session !== null ? session.id : undefined
        if (typeof id !== 'string' || id === '') return
        registry.onPendingQuestion(id, readPending(session))
      } catch (err) {
        warn('userQuestions 投影读取失败', err)
      }
    }

    // 投影变化即同步（提问挂起 / 被回答 / 被取消）
    if (typeof projections.onChanged === 'function') {
      try {
        projectionCtx.effect(
          () =>
            projections.onChanged((session, key) => {
              if (key === 'userQuestions') sync(session)
            }),
          'dsh-grok-buddy: userQuestions projection feed',
        )
      } catch (err) {
        warn('userQuestions 投影订阅失败', err)
      }
    }
    // 会话事件后补一次：快照里的提问以这一刻为准（提问的挂起/消解也可能不经过投影变更）
    ctx.on('session/event', (session) => {
      try {
        const id = session !== undefined && session !== null ? session.id : undefined
        if (typeof id !== 'string' || id === '') return
        registry.onPendingQuestion(id, readPending(session))
      } catch (err) {
        // 读投影失败不影响事件折叠本身
      }
    })
  })

  // 项目配色表：落在插件家目录（~/.dsh/dsh-grok-buddy/colors.json）。
  // 不进 localStorage —— 桌面端与 dsh web 的来源会变，一次重启就清空。
  const colors = createColorStore({
    normalize: normalizeColor,
    warn: (message) => warn('配色表', message),
  })

  // 工作区外观设置：自动配色开关 + 开关打开时已经见过的 Workspace。
  const settings = createSettingsStore({
    warn: (message) => warn('设置表', message),
  })

  // 状态诊断：默认关闭，只支持一次性采样与明确时限的短窗口，不做无限期后台采样。
  const probe = createProbeStore({ now: () => Date.now() })

  const disposers = []

  // 3.4) 状态探针：页面 POST 自检数据到已授权的采样窗口，GET 取回最近一份
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: PROBE_PATH,
      handler: (req, res) => {
        const method = methodOf(req)
        if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: '方法不支持' })
        }
        if (method === 'POST') {
          return readBody(req, 256 * 1024, (tooBig, raw) => {
            if (tooBig) return sendJson(res, 413, { ok: false, error: '请求体过大' })
            const parsed = parseJsonObject(raw)
            if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error })
            const result = probe.accept(parsed.value)
            if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error })
            return sendJson(res, 200, { ok: true, accepted: result.accepted, windowEndsAt: result.windowEndsAt })
          })
        }
        if (method === 'HEAD') return sendHead(res, JSON_HEADERS)
        return sendJson(res, 200, { ok: true, ...probe.read() })
      },
    }),
  )

  // 3.45) 诊断开关：POST { action: 'arm' | 'disarm' } —— 人工、有限时限
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: PROBE_CONTROL_PATH,
      handler: (req, res) => {
        const method = methodOf(req)
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不支持' })
        return readBody(req, 4 * 1024, (tooBig, raw) => {
          if (tooBig) return sendJson(res, 413, { ok: false, error: '请求体过大' })
          const parsed = parseJsonObject(raw)
          if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error })
          const result = probe.control(parsed.value)
          if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error })
          return sendJson(res, 200, { ok: true, ...probe.read() })
        })
      },
    }),
  )

  // 3.5) 项目配色：GET 读整表，POST 改一个项目
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: COLORS_PATH,
      handler: (req, res) => {
        const method = methodOf(req)
        if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: '方法不支持' })
        }
        if (method === 'POST') {
          return readBody(req, 8 * 1024, (tooBig, raw) => {
            if (tooBig) return sendJson(res, 413, { ok: false, error: '请求体过大' })
            const parsed = parseJsonObject(raw)
            if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error })
            const payload = parsed.value
            const workspaceId = payload.workspaceId
            if (typeof workspaceId !== 'string') return sendJson(res, 400, { ok: false, error: '缺 workspaceId' })
            const color = payload.color === undefined ? null : payload.color
            const result = colors.set(workspaceId, color, typeof payload.cwd === 'string' ? payload.cwd : undefined)
            // 校验失败是 400；写盘失败带 status（500）—— 页面要靠非 2xx 回滚颜色。
            if (!result.ok) return sendJson(res, typeof result.status === 'number' ? result.status : 400, { ok: false, error: result.error })
            return sendJson(res, 200, { ok: true, ...colors.snapshot() })
          })
        }
        let body
        try {
          body = colors.snapshot()
        } catch (err) {
          warn('配色表读不出来', err)
          body = { version: 1, projects: {}, paths: {} }
        }
        if (method === 'HEAD') return sendHead(res, JSON_HEADERS)
        return sendJson(res, 200, { ok: true, file: colorsFile(), ...body })
      },
    }),
  )

  // 3.65) 宿主 Workspace 全量列表：自动配色的唯一基线 / 新文件夹来源。
  // 拿不到服务或服务形状不认识时明确回 501，由页面拒绝自动配色；绝不用 DOM 猜。
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: WORKSPACES_PATH,
      handler: (req, res) => {
        const method = methodOf(req)
        if (method !== 'GET' && method !== 'HEAD') {
          return sendJson(res, 405, { ok: false, error: '方法不支持' })
        }
        const service = resolveWorkspaceService(ctx)
        if (service === null) {
          return sendJson(res, 501, {
            ok: false,
            available: false,
            error: '宿主未提供 workspaceRegistry/workspaces/workspace 服务，无法取得 Workspace 全量列表',
          })
        }
        const finish = (value) => {
          const result = workspaceRosterOf(value)
          if (result === null) {
            return sendJson(res, 501, {
              ok: false,
              available: false,
              error: '宿主 Workspace 服务没有可读取的 list()/snapshot()/getSnapshot()/items',
            })
          }
          if (result.pending === true) {
            return sendJson(res, 503, {
              ok: false,
              available: false,
              pending: true,
              error: 'Workspace 列表尚未就绪',
            })
          }
          if (method === 'HEAD') return sendHead(res, JSON_HEADERS)
          return sendJson(res, 200, {
            ok: true,
            available: true,
            source: 'host',
            // workspaces: 只有 id（自动配色基线沿用这个形状）；
            // members: id + 该文件夹按住哪些会话 + 该条目的归属是否可信 ——
            // 折叠时也能据此判定活跃；unknown 条目不能被当作空文件夹。
            workspaces: result.ids,
            members: result.members,
            membersReady: result.membersReady,
          })
        }
        let value
        try {
          value = readWorkspaceList(service)
        } catch (err) {
          return sendJson(res, 501, {
            ok: false,
            available: false,
            error: '读取 Workspace 全量列表失败：' + String((err && err.message) || err),
          })
        }
        if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function') {
          value.then(finish).catch((err) => {
            sendJson(res, 501, {
              ok: false,
              available: false,
              error: '读取 Workspace 全量列表失败：' + String((err && err.message) || err),
            })
          })
          return
        }
        finish(value)
      },
    }),
  )

  // 3.6) 工作区设置：GET 读，POST 合并（自动配色开关 / 已见 Workspace）
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: SETTINGS_PATH,
      handler: (req, res) => {
        const method = methodOf(req)
        if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: '方法不支持' })
        }
        if (method === 'POST') {
          return readBody(req, 256 * 1024, (tooBig, raw) => {
            if (tooBig) return sendJson(res, 413, { ok: false, error: '请求体过大' })
            const parsed = parseJsonObject(raw)
            if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error })
            const payload = parsed.value
            const patch = {}
            if (Object.prototype.hasOwnProperty.call(payload, 'autoColorNewFolders')) {
              patch.autoColorNewFolders = payload.autoColorNewFolders
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'knownWorkspaces')) {
              patch.knownWorkspaces = payload.knownWorkspaces
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'baselineComplete')) {
              patch.baselineComplete = payload.baselineComplete
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'autoPromoteActiveWorkspace')) {
              patch.autoPromoteActiveWorkspace = payload.autoPromoteActiveWorkspace
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'workspaceDisplayMode')) {
              patch.workspaceDisplayMode = payload.workspaceDisplayMode
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'workspaceRecentLimit')) {
              patch.workspaceRecentLimit = payload.workspaceRecentLimit
            }
            const result = settings.update(patch)
            if (!result.ok) {
              return sendJson(res, typeof result.status === 'number' ? result.status : 400, {
                ok: false,
                error: result.error,
              })
            }
            return sendJson(res, 200, { ok: true, file: settingsFile(), ...settings.snapshot() })
          })
        }
        let body
        try {
          body = settings.snapshot()
        } catch (err) {
          warn('设置表读不出来', err)
          body = {
            version: 1,
            autoColorNewFolders: false,
            autoPromoteActiveWorkspace: true,
            baselineComplete: false,
            workspaceDisplayMode: 'active',
            workspaceRecentLimit: 5,
            knownWorkspaces: [],
            autoAssignedWorkspaces: [],
          }
        }
        if (method === 'HEAD') return sendHead(res, JSON_HEADERS)
        return sendJson(res, 200, { ok: true, file: settingsFile(), ...body })
      },
    }),
  )

  // 3.7) 新建文件夹自动配色：唯一色在服务端算，页面只报 workspaceId。
  // 取色、写盘、记已见 Workspace 都在同一个同步段里，多个新建请求不会撞色。
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: AUTO_COLOR_PATH,
      handler: (req, res) => {
        const method = methodOf(req)
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不支持' })
        return readBody(req, 8 * 1024, (tooBig, raw) => {
          if (tooBig) return sendJson(res, 413, { ok: false, error: '请求体过大' })
          const parsed = parseJsonObject(raw)
          if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error })
          const workspaceId = parsed.value.workspaceId
          if (typeof workspaceId !== 'string' || workspaceId === '' || workspaceId.length > 512) {
            return sendJson(res, 400, { ok: false, error: 'workspaceId 必须是非空字符串' })
          }
          let current
          try {
            current = settings.snapshot()
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: '设置读取失败' })
          }
          const key = storeKey(workspaceId)
          const existing = normalizeColor(colors.get(key))
          if (existing !== null) {
            // 已有颜色的重复请求：成功返回原色，绝不覆盖；若已知记录写不进去，
            // 返回 500 让页面重试，避免「颜色在、重置保护不在」的静默分裂。
            const rememberedExisting = settings.remember([workspaceId])
            if (rememberedExisting.ok !== true) {
              return sendJson(res, 500, {
                ok: false,
                status: 500,
                error: '颜色已存在但已知记录写入失败，请稍后重试',
                workspaceId,
                color: existing,
              })
            }
            return sendJson(res, 200, {
              ok: true,
              existing: true,
              workspaceId,
              color: existing,
              projects: colors.snapshot().projects,
            })
          }
          if (current.autoColorNewFolders !== true) {
            return sendJson(res, 409, { ok: false, status: 409, error: '新建文件夹自动配色未开启' })
          }
          if (current.baselineComplete !== true) {
            return sendJson(res, 409, { ok: false, status: 409, error: 'Workspace 基线未建立，拒绝自动配色' })
          }
          const known = Array.isArray(current.knownWorkspaces) && current.knownWorkspaces.includes(workspaceId)
          const assigned = Array.isArray(current.autoAssignedWorkspaces) && current.autoAssignedWorkspaces.includes(workspaceId)
          if (known || assigned) {
            // 已属基线或自动分配过、但当前没有显式颜色（例如用户重置成默认）：
            // 旧请求 / 重复请求只能成功跳过，不能再落色。
            return sendJson(res, 200, {
              ok: true,
              skipped: true,
              known: true,
              workspaceId,
            })
          }
          const projects = colors.snapshot().projects
          const color = pickUnusedColor(Object.values(projects))
          if (color === null) {
            return sendJson(res, 409, { ok: false, status: 409, error: '没有可用的不重复颜色' })
          }
          const result = colors.set(key, color)
          if (!result.ok) {
            return sendJson(res, typeof result.status === 'number' ? result.status : 400, {
              ok: false,
              error: result.error,
            })
          }
          const remembered = settings.rememberAutoAssigned([workspaceId])
          if (remembered.ok !== true) {
            // 颜色已经落盘，但分配记录没落盘：返回 500，页面重试后走 existing
            // 分支补写 known；不会出现「旧请求还能再落一次色」的静默窗口。
            return sendJson(res, 500, {
              ok: false,
              status: 500,
              error: '颜色已保存但自动分配记录写入失败，请稍后重试',
              workspaceId,
              color: result.color,
            })
          }
          return sendJson(res, 200, {
            ok: true,
            existing: false,
            workspaceId,
            color: result.color,
            projects: colors.snapshot().projects,
          })
        })
      },
    }),
  )

  // 3.8) 最近会话：给「最近 N 个」模式用。数据源三级降级，全不可用时
  // 回 200 + available:false（页面安静退回只显示进行中，不弹错）。
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: RECENT_PATH,
      handler: (req, res) => {
        const method = methodOf(req)
        if (method !== 'GET' && method !== 'HEAD') {
          return sendJson(res, 405, { ok: false, error: '方法不支持' })
        }
        let limit = 5
        try {
          limit = settings.snapshot().workspaceRecentLimit
        } catch (err) {}
        // 成员表（会话 → 文件夹归属）只用来算「每个文件夹最近的那个会话」；
        // 拿不到就退回「全局最近 N 个」，页面据此降级，不报错。
        const readMembers = (cb) => {
          const service = resolveWorkspaceService(ctx)
          if (service === null) return cb(null)
          const settle = (settled) => {
            let roster = null
            try {
              roster = workspaceRosterOf(settled)
            } catch (err) {
              roster = null
            }
            cb(roster === null || roster.pending === true ? null : roster.members)
          }
          let value
          try {
            value = readWorkspaceList(service)
          } catch (err) {
            return cb(null)
          }
          if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function') {
            value.then(settle).catch(() => cb(null))
            return
          }
          settle(value)
        }
        // 归档会话不该占名额：宿主侧栏默认把归档会话整条隐藏。
        let archived = null
        try {
          archived = archivedIdsOf(ctx)
        } catch (err) {}
        const finish = (source, rows) => {
          readMembers((members) => {
            if (method === 'HEAD') return sendHead(res, JSON_HEADERS)
            const capped = rows === null ? [] : typeof limit === 'number' && limit > 0 ? rows.slice(0, limit) : rows
            let plan = null
            try {
              plan = rows === null ? null : recentPlanOf(rows, members, limit)
            } catch (err) {
              plan = null
            }
            return sendJson(res, 200, {
              ok: true,
              available: rows !== null,
              source,
              limit,
              sessions: capped.map((row) => ({ id: row.id, updatedAt: row.updatedAt, running: row.running })),
              // latest: workspaceId → 该文件夹最近的那个会话（「最近活跃的项目与会话」用）；
              // ungrouped: 不属于任何文件夹的最近 N 个会话。
              latest: plan === null ? {} : plan.latest,
              ungrouped: plan === null ? [] : plan.ungrouped,
            })
          })
        }
        const resolved = resolveSessionService(ctx)
        if (resolved === null) {
          // 服务端拿不到会话服务时，退回插件自己的派生表（只有 id 与 updatedAt）。
          let fallback = null
          try {
            fallback = recentRowsOf(registry.snapshot(), archived)
          } catch (err) {}
          // 派生表只是兜底：它空着说明「没有可用的会话来源」，不是「确实没有会话」。
          if (fallback !== null && fallback.length === 0) fallback = null
          return finish('registry', fallback)
        }
        let value
        try {
          value = readSessionList(resolved.service)
        } catch (err) {
          return finish(resolved.name, null)
        }
        if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function') {
          value.then((settled) => {
            let rows = null
            try {
              rows = recentRowsOf(settled, archived)
            } catch (err) {}
            finish(resolved.name, rows)
          }).catch(() => {
            finish(resolved.name, null)
          })
          return
        }
        let rows = null
        try {
          rows = recentRowsOf(value, archived)
        } catch (err) {}
        return finish(resolved.name, rows)
      },
    }),
  )

  // 4) 页面轮询的状态端点（只读）
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (req, res) => {
        const method = methodOf(req)
        if (method !== 'GET' && method !== 'HEAD') {
          return sendJson(res, 405, { ok: false, error: '方法不支持' })
        }
        let body = { ok: true, now: Date.now(), sessions: [] }
        try {
          body = { ok: true, ...registry.snapshot() }
        } catch (err) {
          body = { ok: false, now: Date.now(), sessions: [], error: String((err && err.message) || err) }
        }
        if (method === 'HEAD') return sendHead(res, JSON_HEADERS)
        return sendJson(res, 200, body)
      },
    }),
  )

  // 5) 页面脚本本体（每次读磁盘：改完刷新页面即生效，不用重启）
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: SCRIPT_PATH,
      handler: (req, res) => {
        try {
          const source = fs.readFileSync(WIDGET_FILE, 'utf8')
          res.writeHead(200, JS_HEADERS)
          res.end(source)
        } catch (err) {
          res.writeHead(500, { ...JS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(name + ': widget.js 读不出来: ' + String((err && err.message) || err))
        }
      },
    }),
  )

  // 6) 结构化注入行：桌面版外壳唯一受支持的注入方式
  ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    table.push({ kind: 'script', placement: 'head', text: LOADER })
  })

  // 7) 兜底：Host 自己渲染 index.html 时直接改 HTML。只认 harness 自己的 index。
  disposers.push(
    ctx.webServer.tapIndex((html) => {
      if (typeof html !== 'string') return html
      if (html.indexOf('__DSH_BOOT__') === -1) return html
      if (html.indexOf(SCRIPT_PATH) !== -1) return html
      const tag = '<script defer src="' + SCRIPT_PATH + '"></script>'
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
      return html + tag
    }),
  )

  ctx.effect(() => () => {
    promoter.dispose()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (err) {}
    }
  })
}
