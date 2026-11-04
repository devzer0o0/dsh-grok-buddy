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
import { createColorStore, colorsFile } from './colors-store.js'
import { createProbeStore } from './probe.js'
import { normalizeColor } from '../src/colors-shared.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIDGET_FILE = path.join(HERE, 'widget.js')

/** 路由命名空间。exact 路由重复注册会抛错，所以整棵树只用这几个路径。 */
const BASE = '/dsh-grok-buddy'
const SCRIPT_PATH = BASE + '/widget.js'
const STATE_PATH = BASE + '/state.json'
const COLORS_PATH = BASE + '/colors.json'
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

  // 2) 流式分片：只用来判断模型是否已经开始吐字
  ctx.on(
    'agent/assistant-stream',
    (payload) => {
      try {
        const frame = payload !== undefined && payload !== null ? payload.frame : undefined
        if (frame === null || typeof frame !== 'object') return
        if (frame.type !== 'chunk' && frame.type !== 'start') return
        const id = sessionIdOfAgent(payload.agent)
        if (typeof id !== 'string') return
        registry.onStream(id)
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
    if (projections === undefined || projections === null || typeof projections.stateOf !== 'function') return

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
        state = projections.stateOf(session, 'userQuestions')
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
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (err) {}
    }
  })
}
