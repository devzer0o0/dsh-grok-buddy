/**
 * 页面与宿主共用的**颜色校验**。
 *
 * 两边都要判合法 hex（页面提交前判一次，宿主落盘前再判一次），所以这段放在一个
 * 不依赖 DOM 的模块里：页面由 build.mjs 内联，宿主直接 import。
 *
 * @module dsh-grok-buddy/colors-shared
 */

/**
 * 预设色名白名单。
 *
 * 前 8 个是官方身份色（x.ai 站点包里的 Bot ink 值，一字不改）；后 8 个是
 * 扩充的调色板色，命名与色值格式完全一致，但不参与默认色的哈希发牌。
 */
export const COLOR_NAMES = Object.freeze({
  // 官方 8 个身份色
  blue: '#1084fe',
  purple: '#9159fe',
  orange: '#ff9800',
  pink: '#ff309b',
  ember: '#ff6700',
  clay: '#97683d',
  teal: '#00bca6',
  red: '#ff263c',
  // 扩充色：只进调色板，给 8 个官方色不够用的项目多一种选择
  green: '#22b573',
  forest: '#0f7a4d',
  yellow: '#f2b51c',
  sky: '#00a9e0',
  indigo: '#5b5bd6',
  magenta: '#c026d3',
  olive: '#7a8f2a',
  slate: '#6f7787',
})

/**
 * 解析 #rgb / #rrggbb（可省略 #、大小写不限），统一成小写 #rrggbb。
 * @param {unknown} value 候选值。
 * @returns {string|null} 规范化 hex；不合法返回 null。
 */
export function parseHex(value) {
  if (typeof value !== 'string') return null
  let text = value.trim().toLowerCase()
  if (text.startsWith('#')) text = text.slice(1)
  if (/^[0-9a-f]{3}$/.test(text)) {
    return '#' + text[0] + text[0] + text[1] + text[1] + text[2] + text[2]
  }
  if (/^[0-9a-f]{6}$/.test(text)) return '#' + text
  return null
}

/**
 * 校验并规范化一个颜色：合法 hex 或预设色名，其它一律拒绝。
 * @param {unknown} value 候选值。
 * @returns {string|null} 规范化 hex；不合法返回 null。
 */
export function normalizeColor(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(COLOR_NAMES, text)) return COLOR_NAMES[text]
  return parseHex(text)
}
