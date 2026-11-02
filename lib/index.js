/**
 * dsh-grok-buddy —— 侧栏会话（任务）状态表情，宿主半侧。
 *
 * 做三件事，都不写会话、不改模型请求：
 *
 *   1. 订阅事实来源：session/event、agent/assistant-stream、agent/status、agent/error
 *   2. 用 lib/derive.js 把它们折成每个会话一个相位，暴露成 GET /dsh-grok-buddy/state.json
 *   3. 把页面脚本 /dsh-grok-buddy/widget.js 注入到 Web GUI 的 head
 *
 * 注入走两条路径（与 dsh-tps 同构，桌面版与 dsh web 各一条）：
 *   - webserver/index-inject 结构化注入行：桌面版外壳唯一受支持的注入方式
 *   - webServer.tapIndex：Host 自己渲染 index.html 时直接改 HTML，作为兜底
 *
 * 为什么要内联 loader 而不是 script-src：head 里的外部脚本在 body 之前同步执行，
 * 那时页面 DOM 还没建好；内联脚本自己 async 挂 <script src>，最坏情况只是不出现。
 *
 * @module dsh-grok-buddy
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRegistry } from './derive.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIDGET_FILE = path.join(HERE, 'widget.js')

/** 路由命名空间。exact 路由重复注册会抛错，所以整棵树只用这三个路径。 */
const BASE = '/dsh-grok-buddy'
const SCRIPT_PATH = BASE + '/widget.js'
const STATE_PATH = BASE + '/state.json'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}
const JS_HEADERS = {
  'Content-Type': 'application/javascript; charset=utf-8',
  'Cache-Control': 'no-store',
}

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
        const agent = payload.agent
        const session = agent !== undefined && agent !== null ? agent.session : undefined
        const id = session !== undefined && session !== null ? session.id : undefined
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
      const agent = payload !== undefined && payload !== null ? payload.agent : undefined
      const id = agent !== undefined && agent !== null ? agent.id : undefined
      if (typeof id !== 'string') return
      registry.onAgent(id, 'status', { status: payload.status })
    } catch (err) {
      warn('agent/status 处理失败', err)
    }
  })

  ctx.on('agent/error', (payload) => {
    try {
      const agent = payload !== undefined && payload !== null ? payload.agent : undefined
      const id = agent !== undefined && agent !== null ? agent.id : undefined
      if (typeof id !== 'string') return
      registry.onAgent(id, 'error', { error: payload.error })
    } catch (err) {
      warn('agent/error 处理失败', err)
    }
  })

  const disposers = []

  // 4) 页面轮询的状态端点
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (req, res) => {
        let body = { ok: true, now: Date.now(), sessions: [] }
        try {
          body = { ok: true, ...registry.snapshot() }
        } catch (err) {
          body = { ok: false, now: Date.now(), sessions: [], error: String((err && err.message) || err) }
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(body))
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
