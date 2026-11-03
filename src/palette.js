/**
 * dsh-grok-buddy 的**配色**层：颜色是身份，不是状态。
 *
 * 官方 Grok Bot 的设计文章（https://x.ai/news/designing-grok-bot）里，
 * 头像承担两件事，但用两种手段表达：
 *
 *   - 「你是谁」→ 形状 + **墨色**（每只 Bot 一个身份色，终身不变）
 *   - 「你在干嘛」→ 动作（表情池、节奏、转头、眨眼）
 *
 * 官方 lifecycle 演示里 Idle / Working / Waiting / Blocked / Thinking / Done
 * 六个标签共用同一个 `--gb-ink`，切状态时颜色一个像素都不变。
 *
 * 所以这里不再有「相位 → 颜色」。颜色只由**项目**（DSH Workspace）决定：
 *
 *   - 没设过颜色 → workspaceId 哈希到官方 8 色之一（稳定、跨机器一致）
 *   - 用户在 ⋯ 菜单里改过 → 用存下来的那个色
 *   - 深浅主题只做**同色相的明度微调**（对比度不够时），绝不换色
 *
 * @module dsh-grok-buddy/palette
 */

import { COLOR_NAMES, normalizeColor, parseHex } from './colors-shared.js'

/**
 * 官方 8 个身份墨色，取自 x.ai 站点包里 Grok Bot 头像的 ink 值，一字不改。
 * 顺序固定：哈希取模依赖这个顺序，改了就等于给所有项目重新发牌。
 * @type {ReadonlyArray<{id: string, name: string, ink: string}>}
 */
export const IDENTITY_INKS = Object.freeze([
  { id: 'blue', name: '蓝', ink: COLOR_NAMES.blue },
  { id: 'purple', name: '紫', ink: COLOR_NAMES.purple },
  { id: 'orange', name: '橙', ink: COLOR_NAMES.orange },
  { id: 'pink', name: '粉', ink: COLOR_NAMES.pink },
  { id: 'ember', name: '橙红', ink: COLOR_NAMES.ember },
  { id: 'clay', name: '赭', ink: COLOR_NAMES.clay },
  { id: 'teal', name: '青', ink: COLOR_NAMES.teal },
  { id: 'red', name: '红', ink: COLOR_NAMES.red },
])

/** 未分组会话的哈希域。它不是一个真实 Workspace，单独给一个域避免总撞同一个色。 */
export const UNGROUPED_KEY = 'ungrouped:'

/**
 * 未分组在**配色表**里的键。
 *
 * DSH 的未分组桶有项目行（`data-row-key="workspace:"`），所以用户也能给它改色，
 * 但它的 workspaceId 是空串 —— 空串当 JSON 键既难认也容易被写坏，所以换成一个
 * 保留键。真实 workspaceId 不会长这样。
 */
export const UNGROUPED_STORE_KEY = '__ungrouped__'

/**
 * workspaceId → 配色表里的键。未分组换成保留键。
 * @param {string} workspaceId Workspace 的 key（未分组传空串）。
 * @returns {string} 配色表键。
 */
export function storeKey(workspaceId) {
  const id = typeof workspaceId === 'string' ? workspaceId : ''
  return id === '' ? UNGROUPED_STORE_KEY : id
}

/** 头像在背景上至少要有的对比度（WCAG 对图形对象的门槛是 3，这里留一点余量）。 */
export const MIN_CONTRAST = 2.8

/** 8 个官方色的 hex 列表（顺序同上）。 */
export const IDENTITY_HEXES = Object.freeze(IDENTITY_INKS.map((item) => item.ink))

/**
 * FNV-1a 32 位哈希。选它是因为短、无依赖、跨机器结果一致 ——
 * 同一 workspaceId 在任何机器上都必须落到同一个默认色。
 * @param {string} text 输入。
 * @returns {number} 无符号 32 位整数。
 */
export function hash32(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    // hash *= 16777619，用移位避免超过 32 位丢精度
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

/**
 * 把 workspaceId 折成哈希域里的 key。未分组会话走独立域。
 * @param {string} workspaceId Workspace 的 key（未分组传空串）。
 * @returns {string} 哈希域 key。
 */
export function projectDomain(workspaceId) {
  const id = typeof workspaceId === 'string' ? workspaceId : ''
  return id === '' ? UNGROUPED_KEY : 'ws:' + id
}

/**
 * 项目的**默认**墨色：workspaceId 哈希 → 官方 8 色之一。不用随机、不按出现顺序。
 * @param {string} workspaceId Workspace 的 key（未分组传空串）。
 * @returns {string} 小写 hex。
 */
export function defaultInk(workspaceId) {
  const index = hash32(projectDomain(workspaceId)) % IDENTITY_INKS.length
  return IDENTITY_INKS[index].ink
}

/** #rrggbb → {r,g,b}（0-255）。 */
function toRgb(hex) {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

function toHex(rgb) {
  const part = (v) => {
    const n = Math.max(0, Math.min(255, Math.round(v)))
    return n.toString(16).padStart(2, '0')
  }
  return '#' + part(rgb.r) + part(rgb.g) + part(rgb.b)
}

/** WCAG 相对亮度。 */
export function luminance(hex) {
  const parsed = parseHex(hex)
  if (parsed === null) return 0
  const { r, g, b } = toRgb(parsed)
  const channel = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * 两个颜色的对比度（WCAG 公式，1–21）。
 * @param {string} a hex。
 * @param {string} b hex。
 * @returns {number} 对比度。
 */
export function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** RGB → HSL（h 0-360，s/l 0-1）。 */
function toHsl(hex) {
  const { r, g, b } = toRgb(hex)
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return { h: h * 360, s, l }
}

/** HSL → RGB。 */
function fromHsl(hsl) {
  const h = ((((hsl.h % 360) + 360) % 360) / 360)
  const s = Math.max(0, Math.min(1, hsl.s))
  const l = Math.max(0, Math.min(1, hsl.l))
  if (s === 0) {
    const v = l * 255
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const toChannel = (t) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return { r: toChannel(h + 1 / 3) * 255, g: toChannel(h) * 255, b: toChannel(h - 1 / 3) * 255 }
}

/**
 * 让一个身份色在当前背景上看得清，**只动明度、不动色相与饱和度**。
 * 对比度本来就够就原样返回 —— 官方色不该被手痒地改掉。
 * @param {string} ink 身份色（#rrggbb）。
 * @param {string} surface 背景色（#rrggbb）。
 * @param {number} [min] 目标对比度。
 * @returns {string} 调整后的 hex。
 */
export function adjustForSurface(ink, surface, min) {
  const target = typeof min === 'number' ? min : MIN_CONTRAST
  const base = parseHex(ink)
  const bg = parseHex(surface)
  if (base === null || bg === null) return ink
  if (contrast(base, bg) >= target) return base
  const hsl = toHsl(base)
  const bgHsl = toHsl(bg)
  // 背景暗就往亮里调，背景亮就往暗里调 —— 方向由背景明度决定，色相不变。
  const lighten = bgHsl.l < 0.5
  let last = base
  for (let step = 1; step <= 40; step++) {
    const l = lighten ? Math.min(0.96, hsl.l + step * 0.015) : Math.max(0.06, hsl.l - step * 0.015)
    last = toHex(fromHsl({ h: hsl.h, s: hsl.s, l }))
    if (contrast(last, bg) >= target) return last
    if (lighten && l >= 0.96) break
    if (!lighten && l <= 0.06) break
  }
  // 明度推到边界仍不够：返回边界值，但仍然是同一个色相
  return last
}

/**
 * 取一个项目的墨色。这是整个插件**唯一**的取色入口 —— 相位不参与。
 *
 * @param {string} workspaceId Workspace 的 key（未分组传空串）。
 * @param {boolean} dark 是否深色主题（只参与对比度阈值，不改色相）。
 * @param {Record<string, string>} [overrides] 用户存下来的项目色（workspaceId → hex）。
 * @param {string} [surface] 背景色；给了就做对比度微调。
 * @returns {string} 最终墨色（#rrggbb）。
 */
export function inkOfProject(workspaceId, dark, overrides, surface) {
  const id = typeof workspaceId === 'string' ? workspaceId : ''
  const table = overrides !== undefined && overrides !== null ? overrides : {}
  // 未分组的自定义色存在保留键下；真实项目直接用自己的 id。
  const custom = normalizeColor(table[storeKey(id)])
  const ink = custom === null ? defaultInk(id) : custom
  const bg = parseHex(surface)
  if (bg === null) return ink
  return adjustForSurface(ink, bg, MIN_CONTRAST)
}
