/**
 * dsh-grok-buddy 的状态映射层。
 *
 * 官方 Grok Bot 把「Bot 在干什么」直接画在头像上，生命周期是：
 *   Idle → Working → Waiting → Blocked → Thinking → Done
 * 映射到 DSH 的会话事件后，我们用的是同一组生命周期状态名，并额外保留
 * GrokBot 库里更贴切的几个反应状态（sleeping / curious）。
 *
 * GrokBot 的 39 个状态每个都有自己的表情池与节奏，这里只挑需要的。
 *
 * @module dsh-grok-buddy/mapping
 */

/** DSH 相位 → GrokBot 状态名。 */
export const PHASE_TO_STATE = {
  /** 安静：刚开完一轮、没有活动。官方 idle 就是「平静而略显好奇」。 */
  idle: 'idle',
  /** 思考：已发请求、等首 token。 */
  thinking: 'thinking',
  /** 模型正在吐字。 */
  streaming: 'working',
  /** 工具在跑。 */
  tool: 'working',
  /** 等你确认（审批）：官方 Waiting 用的是 bored —— 它确实在等你。 */
  waiting: 'bored',
  /** 重试：GrokBot 没有专门的重试态，用 curious（歪头看着）最接近。 */
  retry: 'curious',
  /** 失败：官方 Blocked = alerting。 */
  error: 'alerting',
  /** 完成：官方 Done = celebrate。 */
  completed: 'celebrate',
}

/**
 * 相位配色。取自 Grok Bot 官方头像的墨色（青、橙、紫、红、蓝…）并做深浅适配：
 * 身体 = 实色，眼睛 = 背景色（形成官方那种「挖空」的白眼效果）。
 *
 * @param {string} phase 相位名。
 * @param {boolean} dark 是否深色主题。
 * @returns {{body: string, eye: string}} 配色。
 */
export function themeOf(phase, dark) {
  const palette = dark
    ? {
        idle: '#5c6370',
        thinking: '#9159fe',
        streaming: '#1084fe',
        tool: '#00bca6',
        waiting: '#ff6700',
        retry: '#ff9800',
        error: '#ff263c',
        completed: '#00bca6',
      }
    : {
        idle: '#7d8492',
        thinking: '#9159fe',
        streaming: '#1084fe',
        tool: '#00a894',
        waiting: '#e85d00',
        retry: '#ef8b00',
        error: '#e52234',
        completed: '#00a894',
      }
  const body = palette[phase] || palette.idle
  return { body, eye: dark ? '#14161a' : '#ffffff' }
}

/** 相位的文案（tooltip / aria）。 */
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
    streaming: 'Responding',
    tool: 'Running tools',
    waiting: 'Waiting for you',
    retry: 'Retrying',
    error: 'Failed',
    completed: 'Done',
    aria: 'Session status',
  },
}
