/**
 * dsh-grok-buddy 的状态映射层：**运行状态**与**动画资源**在这里彻底分层。
 *
 * 六态（运行展示状态，接口 / 文档 / 读屏 / 业务 DOM 属性只能用这六个）：
 *
 *   idle · working · waiting · blocked · thinking · done
 *
 * 动作预设（motionPreset，内部动画资源标识）是另一层：
 * 它是 GrokBot 素材库里的名字（idle / working / bored / alerting / thinking /
 * celebrate），可以在内部换、可以加，但**不是**插件对外暴露的状态数量。
 *
 * 表情素材（expression）是又一层：25 张眼型，按状态的动作池取用。
 * 所以「动作预设库有多少条」不等于「插件有多少种状态」，
 * 「表情图里有哪些名字」也不等于运行状态。
 *
 * @module dsh-grok-buddy/mapping
 */

import { RUNTIME_PHASES } from './decision.js'

/**
 * 官方生命周期（x.ai「Designing Grok Bot」的 Avatar motion system）。
 * @type {ReadonlyArray<{id: string, label: string, motion: string}>}
 */
export const LIFECYCLE = Object.freeze([
  { id: 'idle', label: 'Idle', motion: 'idle' },
  { id: 'working', label: 'Working', motion: 'working' },
  { id: 'waiting', label: 'Waiting', motion: 'bored' },
  { id: 'blocked', label: 'Blocked', motion: 'alerting' },
  { id: 'thinking', label: 'Thinking', motion: 'thinking' },
  { id: 'done', label: 'Done', motion: 'celebrate' },
])

/** 状态 → 官方生命周期（一一对应，不多不少）。 */
export const PHASE_TO_LIFECYCLE = Object.freeze({
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  waiting: 'waiting',
  blocked: 'blocked',
  done: 'done',
})

/**
 * 状态 → **动作预设名**（内部动画资源，不是公开状态）。
 *
 *   idle      平静地眨眼，节奏最慢
 *   thinking  眼珠游移、换脸较快（模型请求 / 推理 / 生成阶段）
 *   working   专注，节奏最快（**只有工具在执行**才用）
 *   waiting   等得有点无聊，慢吞吞（审批、提问、计划评审）
 *   blocked   定住不眨眼，一看就不对劲（有效错误）
 *   done      持续庆祝（活跃期内一直播，不做固定时长回落）
 *
 * 颜色不参与状态表达：一只 Bot 的颜色是它的**项目身份**，六态同色。
 */
export const PHASE_TO_MOTION = Object.freeze({
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  waiting: 'bored',
  blocked: 'alerting',
  done: 'celebrate',
})

/** 兼容导出：旧名字指向同一张表（对外仍只表达六态）。 */
export const PHASE_TO_STATE = PHASE_TO_MOTION

/** 六态名单（从 decision.js 转发，保证只有一份）。 */
export const PHASES = RUNTIME_PHASES

/**
 * 官方身份墨色表（8 个，名字与 x.ai 站点包里的 Bot 身份对应）：
 *
 *   blob #1084FE · hex #9159FE · cloud #FF9800 · wedge #FF309B
 *   pebble #FF6700 · teardrop #97683D · squircle #00BCA6 · tablet #FF263C
 *
 * 这 8 个是**身份**色，不是状态色。官方 lifecycle 演示里六个状态共用
 * 同一个 --gb-ink，切状态颜色不变；颜色只回答「这是哪只 Bot」。
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
})

/** 官方头像的兜底底色（眼睛填的就是它）。真实底色靠 surfaceOf 量。 */
export const SURFACE = Object.freeze({
  dark: '#14161a',
  light: '#ffffff',
})

/**
 * 取状态位背后的实际底色。
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
    const bg = style === null || style === undefined ? '' : style.backgroundColor
    const alpha = alphaOf(bg)
    if (alpha > 0.9) return bg
    node = node.parentElement
  }
  return fallback
}

/** 读一个 CSS 颜色的 alpha（透明 / 无效值按 0 处理）。 */
function alphaOf(color) {
  if (typeof color !== 'string' || color === '' || color === 'transparent') return 0
  const match = /rgba?(([^)]+))/.exec(color)
  if (match === null) return 1
  const parts = match[1].split(/[,/]/).map((part) => part.trim())
  if (parts.length < 4) return 1
  const alpha = Number.parseFloat(parts[3])
  return Number.isFinite(alpha) ? alpha : 1
}

/**
 * 头像配色：身体是**项目墨色**（与状态无关），眼睛填**背景色**。
 * @param {string} ink 项目墨色。
 * @param {boolean} dark 是否深色主题（只影响兜底底色）。
 * @param {string} [surface] 背景色。
 * @returns {{body: string, eye: string}} 配色。
 */
export function themeOf(ink, dark, surface) {
  return { body: ink, eye: surface || (dark ? SURFACE.dark : SURFACE.light) }
}

/** 六态文案（tooltip / aria）。文案描述「Bot 在干什么」。 */
export const PHASE_TEXT = {
  zh: {
    idle: '空闲',
    thinking: '思考',
    working: '正在处理',
    waiting: '正在等待',
    blocked: '已阻止',
    done: '完成',
    aria: '会话状态',
  },
  en: {
    idle: 'Idle',
    thinking: 'Thinking',
    working: 'Working',
    waiting: 'Waiting',
    blocked: 'Blocked',
    done: 'Done',
    aria: 'Session status',
  },
}
