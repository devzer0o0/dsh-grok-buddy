/**
 * dsh-grok-buddy 的状态映射层。
 *
 * 官方 Grok Bot 把「Bot 在干什么」直接画在头像上。x.ai 设计文章
 * （https://x.ai/news/designing-grok-bot）与站点里跑的生命周期是六个：
 *
 *   Idle → Working → Waiting → Blocked → Thinking → Done
 *
 * 站点包里的原表（state 名来自 GrokBot 的状态表）：
 *
 *   idle → idle · working → working · waiting → bored
 *   blocked → alerting · thinking → thinking · done → celebrate
 *
 * DSH 的事件比这六个更细，所以这里先做 DSH 相位 → 官方生命周期 → GrokBot
 * 状态的两段映射：每个相位都能追到官方的一个生命周期，不会自创第七种状态。
 *
 * @module dsh-grok-buddy/mapping
 */

/**
 * 官方生命周期（x.ai「Designing Grok Bot」）。
 * @type {ReadonlyArray<{id: string, label: string, state: string}>}
 */
export const LIFECYCLE = Object.freeze([
  { id: 'idle', label: 'Idle', state: 'idle' },
  { id: 'working', label: 'Working', state: 'working' },
  { id: 'waiting', label: 'Waiting', state: 'bored' },
  { id: 'blocked', label: 'Blocked', state: 'alerting' },
  { id: 'thinking', label: 'Thinking', state: 'thinking' },
  { id: 'done', label: 'Done', state: 'celebrate' },
])

/** DSH 相位 → 官方生命周期的名字。 */
export const PHASE_TO_LIFECYCLE = Object.freeze({
  /** 安静：没有活动。官方 idle 就是「平静而略显好奇」。 */
  idle: 'idle',
  /** 思考：已发请求、等首 token。 */
  thinking: 'thinking',
  /** 模型正在吐字 —— 官方把「在干活」都算 Working。 */
  streaming: 'working',
  /** 工具在跑 —— 同样是 Working。 */
  tool: 'working',
  /** 等你确认（审批挂起）：官方 Waiting = bored，它确实在等你。 */
  waiting: 'waiting',
  /** 重试：DSH 的退避重试还没有结论，归到 Waiting（等下一次机会）。 */
  retry: 'waiting',
  /** 失败：官方 Blocked = alerting。 */
  error: 'blocked',
  /** 完成：官方 Done = celebrate。 */
  completed: 'done',
})

/**
 * DSH 相位 → GrokBot 状态名。
 *
 * 六个官方生命周期照官方的 state 走（idle / working / bored / alerting /
 * thinking / celebrate）。DSH 比官方细的两处，用官方状态库里更贴切的小动作
 * 来区分，**不动颜色** —— 颜色只表示生命周期，动作只表示这一刻在干嘛：
 *
 *   streaming（吐字）与 tool（跑工具）都是官方 Working，同色 #1084FE；
 *     前者用 working、后者用 searching（在找、在读、在敲），脸不一样。
 *   waiting（等你点确认）与 retry（等下一次重试）都是官方 Waiting，同色
 *     #FF9800；前者用 bored（等得有点无聊）、后者用 curious（歪头看着）。
 */
export const PHASE_TO_STATE = Object.freeze({
  idle: 'idle',
  thinking: 'thinking',
  streaming: 'working',
  tool: 'searching',
  waiting: 'bored',
  retry: 'curious',
  error: 'alerting',
  completed: 'celebrate',
})

/**
 * 官方墨色（ink）。取自 x.ai 站点包里 Grok Bot 头像的 `ink` 取值，一字不改：
 *
 *   blob #1084FE · hex #9159FE · cloud #FF9800 · wedge #FF309B
 *   pebble #FF6700 · teardrop #97683D · squircle #00BCA6 · tablet #FF263C
 *
 * 另外状态徽章的取色表（done/warn/error/neutral）用 #00C972 / #FF9800 /
 * #FF263C，灰色用 --fig-gray（亮色 #777、暗色 #9A9A9A）。
 *
 * 这些是「官方色」，不做深浅拆分 —— 同一只 Bot 换个主题不该换身份。
 */
export const INK = Object.freeze({
  blue: '#1084fe',
  purple: '#9159fe',
  orange: '#ff9800',
  pink: '#ff309b',
  ember: '#ff6700',
  clay: '#97683d',
  teal: '#00bca6',
  red: '#ff263c',
  green: '#00c972',
  grayLight: '#777777',
  grayDark: '#9a9a9a',
})

/**
 * 相位 → 官方墨色。
 *
 * 官方只发布了生命周期那三个状态 → 墨色的对应（done 绿、blocked 红、
 * waiting 橙），其余按官方页面的语义就近落位：
 *
 *   idle     官方 --fig-gray（亮 #777 / 暗 #9A9A9A），徽章的 neutral 也是它
 *   thinking 每个 Bot 身份里最「思考中」的那支紫 #9159FE（hex 那只 Bot 的墨色）
 *   working  官方主 Bot（blob）的墨色 #1084FE —— 蓝色就是「在干活」
 *   done     徽章表里的完成绿 #00C972（不是 teal，teal 是另一只 Bot 的身份）
 *   blocked  徽章表里的错误红 #FF263C
 *   waiting  徽章表里的 warn #FF9800
 *
 * @param {string} phase 相位名。
 * @param {boolean} dark 是否深色主题（只影响灰色的左右两种取值）。
 * @returns {string} 墨色。
 */
export function inkOf(phase, dark) {
  switch (PHASE_TO_LIFECYCLE[phase]) {
    case 'idle':
      return dark ? INK.grayDark : INK.grayLight
    case 'thinking':
      return INK.purple
    case 'working':
      return INK.blue
    case 'waiting':
      return INK.orange
    case 'blocked':
      return INK.red
    case 'done':
      return INK.green
    default:
      return dark ? INK.grayDark : INK.grayLight
  }
}

/**
 * 官方头像的底色（`--bg`）：眼睛填的就是它，所以眼睛永远和侧栏同色。
 *
 * 这边不能写死：侧栏底色由 DSH 的主题决定，写死一个值在另一个主题下就会
 * 露出一块对不上的色。所以眼睛用 **canvas 取色**（见 `surfaceOf`）——
 * 从状态位背后的实际底色里取，取不到再退回下面的兜底色。
 */
export const SURFACE = Object.freeze({
  dark: '#14161a',
  light: '#ffffff',
})

/**
 * 取状态位背后的实际底色。
 *
 * 官方 `.eye{fill:var(--bg)}` 的前提是「知道背景是什么」。插件拿不到 DSH 的
 * 主题变量，所以直接量：把状态位自己的 `background-color` 读出来；如果它是
 * 透明的（侧栏行通常透明，底色在更上层），就顺着祖先往上找第一个不透明的。
 *
 * @param {Element} el 状态位元素。
 * @param {boolean} dark 深浅主题（只用于兜底）。
 * @returns {string} 可用的底色。
 */
export function surfaceOf(el, dark) {
  const fallback = dark ? SURFACE.dark : SURFACE.light
  if (el === null || el === undefined || typeof getComputedStyle !== 'function') return fallback
  let node = el
  for (let depth = 0; node !== null && node !== undefined && depth < 12; depth++) {
    const style = getComputedStyle(node)
    const bg = style.backgroundColor
    const alpha = alphaOf(bg)
    if (alpha > 0.9) return bg
    node = node.parentElement
  }
  return fallback
}

/** 读一个 CSS 颜色的 alpha（透明/无效值按 0 处理）。 */
function alphaOf(color) {
  if (typeof color !== 'string' || color === '' || color === 'transparent') return 0
  const match = /rgba?\(([^)]+)\)/.exec(color)
  if (match === null) return 1
  const parts = match[1].split(/[,/]/).map((part) => part.trim())
  if (parts.length < 4) return 1
  const alpha = Number.parseFloat(parts[3])
  return Number.isFinite(alpha) ? alpha : 1
}

/**
 * 相位配色。和官方一致：整个头像只有一种墨色（身体实色），眼睛填**背景色**
 * （官方 `.head{fill:var(--fg)}` / `.eye{fill:var(--bg)}`）。
 *
 * @param {string} phase 相位名。
 * @param {boolean} dark 是否深色主题。
 * @param {string} [surface] 背景色；不给就用兜底值。
 * @returns {{body: string, eye: string}} 配色。
 */
export function themeOf(phase, dark, surface) {
  return { body: inkOf(phase, dark), eye: surface || (dark ? SURFACE.dark : SURFACE.light) }
}

/** 相位的文案（tooltip / aria）。文案描述「Bot 在干什么」，不描述颜色。 */
export const PHASE_TEXT = {
  zh: {
    idle: '安静',
    thinking: '思考中',
    streaming: '输出中',
    tool: '执行工具',
    waiting: '等你确认',
    retry: '重试中',
    error: '失败',
    completed: '刚完成',
    aria: '会话状态',
  },
  en: {
    idle: 'Idle',
    thinking: 'Thinking',
    streaming: 'Working',
    tool: 'Working',
    waiting: 'Waiting',
    retry: 'Retrying',
    error: 'Blocked',
    completed: 'Done',
    aria: 'Session status',
  },
}
