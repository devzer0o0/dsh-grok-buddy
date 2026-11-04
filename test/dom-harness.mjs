/**
 * 一个**够用的最小 DOM**，专门用来把构建产物（lib/widget.js）真的跑起来。
 *
 * 为什么不用 jsdom：项目零依赖，加一个 DOM 库只为测试不划算；而这里要验证的
 * 恰恰是「真实入口 + 真实副作用」—— boot、fetch、sync、mount、observer、dispose。
 * 所以这个桩只实现插件真正用到的那一小块 API，并且**行为对齐浏览器**：
 *   · querySelectorAll 支持属性前缀选择（[data-row-key^="session:"]）与类名选择；
 *   · className 对 SVG 元素返回对象（真实行为，踩过坑）；
 *   · isConnected 随插入/移除变化。
 *
 * @module test/dom-harness
 */

/**
 * CSSStyleDeclaration 的最小桩：支持 CSS 变量（setProperty/removeProperty），
 * 普通属性赋值走 JS 字段（与浏览器不同但测试够用）。
 */
export class StyleStub {
  constructor() {
    this._props = new Map()
  }

  setProperty(name, value) {
    this._props.set(String(name), String(value))
  }

  removeProperty(name) {
    this._props.delete(String(name))
  }

  getPropertyValue(name) {
    const value = this._props.get(String(name))
    return value === undefined ? '' : value
  }
}

/** 一个元素。 */
export class El {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase()
    this.ownerDocument = doc
    this.children = []
    this.parentElement = null
    this.attributes = new Map()
    this.style = new StyleStub()
    this.dataset = {}
    this._text = ''
    this._listeners = new Map()
    this.classNameIsObject = false
  }

  get className() {
    const value = this.attributes.get('class') || ''
    return this.classNameIsObject ? { baseVal: value } : value
  }

  set className(value) {
    this.attributes.set('class', String(value))
  }

  get classList() {
    const self = this
    return {
      add(name) {
        const set = new Set(String(self.attributes.get('class') || '').split(/\s+/).filter(Boolean))
        set.add(name)
        self.attributes.set('class', [...set].join(' '))
      },
      remove(name) {
        const set = new Set(String(self.attributes.get('class') || '').split(/\s+/).filter(Boolean))
        set.delete(name)
        self.attributes.set('class', [...set].join(' '))
      },
      contains(name) {
        return String(self.attributes.get('class') || '').split(/\s+/).includes(name)
      },
    }
  }

  get firstChild() {
    return this.children.length === 0 ? null : this.children[0]
  }

  get isConnected() {
    let node = this
    while (node !== null && node !== undefined) {
      if (node === this.ownerDocument.body || node === this.ownerDocument.documentElement) return true
      node = node.parentElement
    }
    return false
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    const value = this.attributes.get(name)
    return value === undefined ? null : value
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  appendChild(child) {
    return this.insertBefore(child, null)
  }

  insertBefore(child, ref) {
    if (child.parentElement !== null) child.parentElement.removeChild(child)
    const index = ref === null || ref === undefined ? this.children.length : this.children.indexOf(ref)
    this.children.splice(index < 0 ? this.children.length : index, 0, child)
    child.parentElement = this
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index === -1) return child
    this.children.splice(index, 1)
    child.parentElement = null
    return child
  }

  remove() {
    if (this.parentElement !== null) this.parentElement.removeChild(this)
  }

  get textContent() {
    if (this.children.length === 0) return this._text
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this.children.length = 0
    this._text = String(value)
  }

  set innerHTML(value) {
    this.children.length = 0
    this._text = String(value)
    this._html = String(value)
  }

  get innerHTML() {
    return this._html === undefined ? this._text : this._html
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set())
    this._listeners.get(type).add(handler)
  }

  removeEventListener(type, handler) {
    if (this._listeners.has(type)) this._listeners.get(type).delete(handler)
  }

  /** 浏览器同义 API：触发该类型的监听（capture / bubble 不分）。 */
  dispatchEvent(event) {
    // 真实事件的 target 一定是节点；桩事件没给就补上自己。
    if (event !== null && event !== undefined && event.target === undefined) event.target = this
    this.fire(event.type, event)
    return true
  }

  /** 只用于测试：触发一次事件（事件对象补齐 stopPropagation/preventDefault）。 */
  fire(type, event) {
    if (!this._listeners.has(type)) return
    const base = event === undefined ? { target: this } : event
    if (typeof base.stopPropagation !== 'function') base.stopPropagation = () => {}
    if (typeof base.preventDefault !== 'function') base.preventDefault = () => {}
    for (const handler of [...this._listeners.get(type)]) handler(base)
  }

  listenerCount(type) {
    return this._listeners.has(type) ? this._listeners.get(type).size : 0
  }

  getBoundingClientRect() {
    return { width: 16, height: 16, top: 0, left: 0, right: 16, bottom: 16 }
  }

  closest(selector) {
    let node = this
    while (node !== null && node !== undefined) {
      if (matches(node, selector)) return node
      node = node.parentElement
    }
    return null
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }

  querySelectorAll(selector) {
    const out = []
    const groups = selector.split(',').map((part) => part.trim()).filter(Boolean)
    const walk = (node) => {
      for (const child of node.children) {
        for (const group of groups) {
          if (matchCompound(child, group)) {
            out.push(child)
            break
          }
        }
        walk(child)
      }
    }
    walk(this)
    return out
  }
}

/** 单个元素是否匹配一个选择器（支持后代与子代组合，够用即可）。 */
function matches(node, selector) {
  const parts = selector.trim().split(/\s+/)
  if (parts.length === 1) return matchCompound(node, parts[0])
  // 后代 / 子代：从最后一个开始往前找
  let index = parts.length - 1
  if (!matchCompound(node, parts[index])) return false
  index -= 1
  let cursor = node.parentElement
  while (index >= 0 && cursor !== null && cursor !== undefined) {
    if (matchCompound(cursor, parts[index])) index -= 1
    cursor = cursor.parentElement
  }
  return index < 0
}

/** 匹配「标签 / 类 / 属性 / :hover 等」组成的单个复合选择器。 */
function matchCompound(node, selector) {
  if (node === null || node === undefined) return false
  let rest = selector.trim()
  if (rest === '') return false
  if (rest === '*') return true

  // 标签
  const tagMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest)
  if (tagMatch !== null) {
    if (node.tagName !== tagMatch[0].toUpperCase()) return false
    rest = rest.slice(tagMatch[0].length)
  }

  while (rest.startsWith('.')) {
    const name = /^\.([A-Za-z0-9_-]+)/.exec(rest)[1]
    if (!String(node.attributes.get('class') || '').split(/\s+/).includes(name)) return false
    rest = rest.slice(1 + name.length)
  }

  while (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    const body = rest.slice(1, end)
    // CSS 属性选择器：name / name=value / name^=value / name*=value / name$=value
    const op = /^([A-Za-z0-9_-]+)(?:(\^=|\*=|\$=|=)\s*(?:"([^"]*)"|([^\]]*)))?$/.exec(body)
    if (op === null) return false
    const name = op[1]
    const operator = op[2]
    const value = op[3] !== undefined ? op[3] : op[4] === undefined ? '' : op[4]
    const actual = node.attributes.get(name)
    if (actual === undefined) return false
    if (operator === '^=' && !actual.startsWith(value)) return false
    if (operator === '*=' && !actual.includes(value)) return false
    if (operator === '$=' && !actual.endsWith(value)) return false
    if (operator === '=' && actual !== value) return false
    rest = rest.slice(end + 1)
  }

  while (rest.startsWith(':')) {
    const pseudo = /^:([a-z-]+)/.exec(rest)[1]
    if (pseudo === 'hover') node = node // 无 hover 状态：只要能到达这里就算匹配
    rest = rest.slice(1 + pseudo.length)
  }

  return rest === ''
}

/** 一个文档。 */
export class Doc {
  constructor() {
    this.documentElement = new El('html', this)
    this.head = new El('head', this)
    this.body = new El('body', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.hidden = false
    this.visibilityState = 'visible'
    this._listeners = new Map()
    this.defaultView = null
  }

  createElement(tag) {
    return new El(tag, this)
  }

  createElementNS(ns, tag) {
    const el = new El(tag, this)
    el.namespaceURI = ns
    if (tag === 'svg') el.classNameIsObject = false
    return el
  }

  /** 旧式事件工厂（widget 的 closeMenus 用它合成一次外部点击）。 */
  createEvent() {
    return { type: 'click', initMouseEvent() {} }
  }

  querySelector(selector) {
    return this.body.querySelector(selector) || this.head.querySelector(selector)
  }

  querySelectorAll(selector) {
    return [...this.body.querySelectorAll(selector), ...this.head.querySelectorAll(selector)]
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set())
    this._listeners.get(type).add(handler)
  }

  removeEventListener(type, handler) {
    if (this._listeners.has(type)) this._listeners.get(type).delete(handler)
  }

  fire(type, event) {
    if (!this._listeners.has(type)) return
    for (const handler of [...this._listeners.get(type)]) handler(event === undefined ? { target: this } : event)
  }

  listenerCount(type) {
    return this._listeners.has(type) ? this._listeners.get(type).size : 0
  }
}

/**
 * 造一个可控的浏览器环境。
 * @returns {object} 环境（含 clock / raf / fetch 控制）。
 */
export function createEnv() {
  const doc = new Doc()
  const rafCallbacks = []
  let rafId = 1
  let now = 1_000_000
  const timers = new Map()
  let timerId = 1
  const observers = []
  const requests = []

  const window = {
    document: doc,
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 2,
    location: { origin: 'http://127.0.0.1:1', href: 'http://127.0.0.1:1/' },
    navigator: { language: 'zh-CN' },
    listeners: new Map(),
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      if (this.listeners.has(type)) this.listeners.get(type).delete(handler)
    },
    listenerCount(type) {
      return this.listeners.has(type) ? this.listeners.get(type).size : 0
    },
  }
  doc.defaultView = window

  const env = {
    window,
    document: doc,
    /** 推进时钟并跑掉到期的定时器（不含 rAF）。 */
    advance(ms) {
      now += ms
      for (const [id, entry] of [...timers]) {
        if (entry.at <= now) {
          timers.delete(id)
          entry.fn()
        }
      }
      return env.flush()
    },
    now() {
      return now
    },
    /** 跑一帧动画。 */
    frame(step) {
      const delta = typeof step === 'number' ? step : 16
      now += delta
      const pending = rafCallbacks.splice(0, rafCallbacks.length)
      for (const entry of pending) entry.fn(now)
      return env.flush()
    },
    get pendingFrames() {
      return rafCallbacks.length
    },
    get pendingTimers() {
      return timers.size
    },
    /** 跑掉所有已排队的 Promise。 */
    async flush() {
      for (let i = 0; i < 40; i++) await Promise.resolve()
    },
    /** 注册一份 fetch 响应。 */
    routeFetch(handler) {
      requests.push(handler)
    },
    get requestCount() {
      return requests.length === 0 ? 0 : fetchLog.length
    },
    fetchLog,
    observers,
    /** 触发所有 MutationObserver。 */
    mutate() {
      for (const observer of observers) observer.callback([])
    },
    /** 清掉所有监听器登记（用于核对 stop 之后没有残留）。 */
    listenerReport() {
      return {
        documentClickCapture: doc.listenerCount('click'),
        documentKeydown: doc.listenerCount('keydown'),
        documentVisibility: doc.listenerCount('visibilitychange'),
        windowResize: window.listenerCount('resize'),
        observers: observers.length,
      }
    },
  }

  const fetchLog = []
  function fetchImpl(url, init) {
    const entry = { url, init, at: now }
    fetchLog.push(entry)
    const route = requests.slice().reverse().find((candidate) => candidate.matches(url, init))
    if (route === undefined) return Promise.reject(new Error('no route for ' + url))
    return route.respond(url, init, entry)
  }

  return { env, doc, window, timers, rafCallbacks, observers, fetchImpl, fetchLog, setNow: (v) => { now = v } }
}

/** 一个简单的响应对象工厂。 */
export function jsonResponse(body, status) {
  return {
    ok: (status === undefined ? 200 : status) < 400,
    status: status === undefined ? 200 : status,
    json: () => Promise.resolve(body),
  }
}
