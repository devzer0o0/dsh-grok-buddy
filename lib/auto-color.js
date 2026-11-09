/**
 * 「新建文件夹自动配色」的唯一取色器（宿主半侧）。
 *
 * 规则：
 *   1. 先把调色板里**没有被任何项目显式使用**的颜色作为候选；
 *   2. 候选里随机挑一个；
 *   3. 16 个调色板色全被占用时，随机生成一个调色板风格的新 hex，
 *      仍然避开已用集合；生成不出来就返回 null，由路由拒绝，绝不改动别的项目。
 *
 * 这里只做「选颜色」，不写盘、不读设置。写盘由 colors-store 完成，
 * 这样唯一性判断和持久化失败可以分别处理。
 *
 * @module dsh-grok-buddy/auto-color
 */

import { PICKER_INKS } from '../src/palette.js'

/** 调色板用尽后，最多尝试多少个随机色。 */
export const FALLBACK_ATTEMPTS = 512

/**
 * 把一组颜色规范成小写 Set，忽略非字符串/非法值。
 * @param {Iterable<unknown>|undefined} used 已用颜色。
 * @returns {Set<string>} 小写 hex 集合。
 */
export function usedColorSet(used) {
  const set = new Set()
  const source = used === null || used === undefined ? [] : used
  for (const item of source) {
    if (typeof item !== 'string') continue
    const text = item.trim().toLowerCase()
    if (/^#[0-9a-f]{6}$/.test(text)) set.add(text)
  }
  return set
}

/** HSL → 小写 #rrggbb（h: 0-360, s/l: 0-1）。 */
export function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360
  const sat = Math.min(1, Math.max(0, s))
  const light = Math.min(1, Math.max(0, l))
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = light - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) {
    r = c; g = x; b = 0
  } else if (hue < 120) {
    r = x; g = c; b = 0
  } else if (hue < 180) {
    r = 0; g = c; b = x
  } else if (hue < 240) {
    r = 0; g = x; b = c
  } else if (hue < 300) {
    r = x; g = 0; b = c
  } else {
    r = c; g = 0; b = x
  }
  const to = (value) => {
    const n = Math.round((value + m) * 255)
    return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  }
  return '#' + to(r) + to(g) + to(b)
}

/**
 * 从调色板里随机挑一个未使用的颜色；调色板用尽时退回随机 hex。
 *
 * @param {Iterable<unknown>} used 其它项目已显式使用的颜色。
 * @param {() => number} [random] 0..1 随机源（可注入，便于确定性核对）。
 * @returns {string|null} 小写 #rrggbb；确实找不到时 null。
 */
export function pickUnusedColor(used, random) {
  const rand = typeof random === 'function' ? random : Math.random
  const usedSet = usedColorSet(used)
  const free = []
  for (const item of PICKER_INKS) {
    const ink = typeof item.ink === 'string' ? item.ink.toLowerCase() : ''
    if (/^#[0-9a-f]{6}$/.test(ink) && !usedSet.has(ink)) free.push(ink)
  }
  if (free.length > 0) {
    const index = Math.min(free.length - 1, Math.max(0, Math.floor(rand() * free.length)))
    return free[index]
  }
  for (let attempt = 0; attempt < FALLBACK_ATTEMPTS; attempt += 1) {
    const hue = rand() * 360
    // 与调色板同一档饱和度/明度：不会出现纯黑、纯白或灰到看不见的色。
    const sat = 0.62 + rand() * 0.2
    const light = 0.4 + rand() * 0.22
    const candidate = hslToHex(hue, sat, light)
    if (!usedSet.has(candidate)) return candidate
  }
  return null
}
