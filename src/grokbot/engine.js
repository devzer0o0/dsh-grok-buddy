/**
 * GrokBot 头像渲染引擎（浏览器侧）。
 *
 * 几何与表情数据移植自 nasawz/GrokBot（BSD-3-Clause, (c) 2026 nasawz），
 * 经 dsh-thought-buddy 的 TypeScript 移植版转写：25 种表情的眼环多边形、
 * 18 种体形（CSS border-radius 语法）、39 个状态的节奏表。
 *
 * 与原版一致的行为：
 *   - 眼睛是「贴在球面上的多边形」，按球面经度做透视压缩，所以转头时眼睛会跟着
 *     变形、转到背面会消失 —— 这就是 GrokBot 看起来像活的那一半原因
 *   - 表情切换用弹簧（spring）做形变，不是线性淡入淡出
 *   - 眨眼 320ms，两侧眼睛同时压扁
 *   - 身体只有 bean / tablet 这类「会挤」的体形才做 squash
 *
 * 这里额外做的一件事：把状态从「写死 thinking」变成可切换，并支持三种可选的
 * 体形与配色，供侧栏按会话区分。
 *
 * @module dsh-grok-buddy/grokbot
 */

const FACE_CENTER = 114.2705
const VIEWBOX = 259
const INSET = 15
const VIEW_SIZE = VIEWBOX - INSET * 2

/**
 * 解析 CSS border-radius 语法（支持 1-4 值与椭圆斜杠写法），并做相邻角钳制。
 * @param {string} css border-radius 值。
 * @param {number} width 盒宽。
 * @param {number} height 盒高。
 * @returns {Array<{rx:number, ry:number}>} 四角半径。
 */
function parseRadii(css, width, height) {
  const expand = (values) => {
    if (values.length === 0) return ['0', '0', '0', '0']
    if (values.length === 1) return [values[0], values[0], values[0], values[0]]
    if (values.length === 2) return [values[0], values[1], values[0], values[1]]
    if (values.length === 3) return [values[0], values[1], values[2], values[1]]
    return values.slice(0, 4)
  }
  const toPx = (token, axis) => {
    const text = String(token).trim()
    const n = Number.parseFloat(text)
    if (!Number.isFinite(n)) return 0
    return text.endsWith('%') ? (n / 100) * axis : n
  }
  const parts = String(css).split('/')
  const horizontal = expand(parts[0].trim().split(/\s+/).filter(Boolean))
  const vertical = expand((parts.length > 1 ? parts[1] : parts[0]).trim().split(/\s+/).filter(Boolean))
  const radii = [0, 1, 2, 3].map((i) => ({
    rx: toPx(horizontal[i], width),
    ry: toPx(vertical[i], height),
  }))
  // 相邻角半径之和不得超过边长，否则浏览器与 SVG 的退化方式不一致
  const clampPair = (a, b, size, horizontalAxis) => {
    const first = horizontalAxis ? radii[a].rx : radii[a].ry
    const second = horizontalAxis ? radii[b].rx : radii[b].ry
    const sum = first + second
    if (sum > size) {
      const factor = size / sum
      if (horizontalAxis) {
        radii[a].rx = first * factor
        radii[b].rx = second * factor
      } else {
        radii[a].ry = first * factor
        radii[b].ry = second * factor
      }
    }
  }
  clampPair(0, 1, width, true)
  clampPair(3, 2, width, true)
  clampPair(0, 3, height, false)
  clampPair(1, 2, height, false)
  return radii
}

/** 按 2 位小数格式化，避免 -0。 */
function fmt(n) {
  const r = Math.round(n * 100) / 100
  return Object.is(r, -0) ? '0' : String(r)
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1))
}

/** 把体形描述转成 SVG path（圆角矩形 + 各角椭圆弧）。 */
function bodyPath(shape) {
  const width = 210 * shape.aspectX
  const height = 210 * shape.aspectY
  const left = FACE_CENTER - width / 2
  const top = FACE_CENTER - height / 2
  const [tl, tr, br, bl] = parseRadii(shape.radius, width, height)
  const arc = (r, x2, y2) =>
    r.rx <= 0 || r.ry <= 0 ? ' L ' + fmt(x2) + ' ' + fmt(y2) : ' A ' + fmt(r.rx) + ' ' + fmt(r.ry) + ' 0 0 1 ' + fmt(x2) + ' ' + fmt(y2)
  let d = 'M ' + fmt(left + tl.rx) + ' ' + fmt(top)
  d += ' L ' + fmt(left + width - tr.rx) + ' ' + fmt(top)
  d += arc(tr, left + width, top + tr.ry)
  d += ' L ' + fmt(left + width) + ' ' + fmt(top + height - br.ry)
  d += arc(br, left + width - br.rx, top + height)
  d += ' L ' + fmt(left + bl.rx) + ' ' + fmt(top + height)
  d += arc(bl, left, top + height - bl.ry)
  d += ' L ' + fmt(left) + ' ' + fmt(top + tl.ry)
  d += arc(tl, left + tl.rx, top)
  return d + ' Z'
}

function squashTransform(scale) {
  if (scale === 1) return null
  return (
    'translate(' + FACE_CENTER + ' ' + FACE_CENTER + ') ' +
    'scale(' + fmt(scale) + ' 1) ' +
    'translate(' + -FACE_CENTER + ' ' + -FACE_CENTER + ')'
  )
}

function centroid(ring) {
  let x = 0
  let y = 0
  for (const p of ring) {
    x += p[0]
    y += p[1]
  }
  return { x: x / ring.length, y: y / ring.length }
}

function lerpRings(current, target, amount) {
  return [0, 1].map((eye) =>
    current[eye].map((p, i) => [
      p[0] + (target[eye][i][0] - p[0]) * amount,
      p[1] + (target[eye][i][1] - p[1]) * amount,
    ]),
  )
}

let clipSeq = 0

/** 供构建期/预览使用的常量。 */
export const BOT_VIEWBOX = VIEWBOX
export const BOT_INSET = INSET

/**
 * 建一个 GrokBot 头像实例。
 * @param {object} opts 选项。
 * @param {Array} opts.expressions 表情表。
 * @param {object} opts.shape 体形描述。
 * @param {string} opts.bodyFill 身体颜色。
 * @param {string} opts.eyeFill 眼睛颜色（默认取背景色，形成「挖空」效果）。
 * @param {number} opts.size 像素尺寸。
 * @returns {object} 实例。
 */
export function createBot(opts) {
  const ns = 'http://www.w3.org/2000/svg'
  const shape = opts.shape
  const size = opts.size || 18
  const clipId = 'dsgb' + ++clipSeq

  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 ' + VIEWBOX + ' ' + VIEWBOX)
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'dsgb')

  const root = document.createElementNS(ns, 'g')
  root.setAttribute('transform', 'translate(' + INSET + ' ' + INSET + ')')

  const body = document.createElementNS(ns, 'path')
  body.setAttribute('d', bodyPath(shape))
  body.setAttribute('fill', opts.bodyFill)

  const clip = document.createElementNS(ns, 'clipPath')
  clip.setAttribute('id', clipId)
  const clipBody = document.createElementNS(ns, 'path')
  clipBody.setAttribute('d', bodyPath(shape))
  clip.appendChild(clipBody)

  const eyes = document.createElementNS(ns, 'g')
  eyes.setAttribute('clip-path', 'url(#' + clipId + ')')
  const eyeL = document.createElementNS(ns, 'polygon')
  const eyeR = document.createElementNS(ns, 'polygon')
  eyeL.setAttribute('fill', opts.eyeFill)
  eyeR.setAttribute('fill', opts.eyeFill)
  eyes.appendChild(eyeL)
  eyes.appendChild(eyeR)

  root.appendChild(body)
  root.appendChild(clip)
  root.appendChild(eyes)
  svg.appendChild(root)

  const inst = {
    svg,
    body,
    clipBody,
    eyeL,
    eyeR,
    shape,
    /** 当前状态名。 */
    state: 'idle',
    /** 状态切换时数值变化，让动画循环重置节奏。 */
    token: 0,
    /** 外部设置的表情池覆盖（可选）。 */
    pool: null,
  }
  return inst
}

/**
 * 启动动画循环。
 * @param {object} inst createBot 的产物。
 * @param {object} deps 依赖：{ expressions, states, reduced }。
 * @returns {function} 停止函数。
 */
export function runBot(inst, deps) {
  const { expressions, states } = deps
  const reduced = deps.reduced === true
  const springFreq = 7

  let currentIdx = 0
  let current = expressions[currentIdx]
  let target = current
  let morph = 1
  let velocity = 0
  let blinkT = -1
  let stateDef = states[inst.state] || states.idle
  let pool = inst.pool !== null ? inst.pool : stateDef.expressions
  let currentStateToken = inst.token

  currentIdx = pool[0]
  current = expressions[currentIdx]
  target = current

  const scheduleBlink = (now) =>
    stateDef.blinkMin === null || stateDef.blinkMin === undefined
      ? Infinity
      : now + randInt(stateDef.blinkMin, stateDef.blinkMax)

  let now0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  let blinkAt = scheduleBlink(now0)
  let exprAt = now0 + randInt(stateDef.expressionMin, stateDef.expressionMax)

  const blinkScale = () => {
    if (blinkT < 0) return 1
    const p = blinkT / 0.32
    return Math.max(p < 0.42 ? 1 - p / 0.42 : (p - 0.42) / 0.58, 0.04)
  }

  const draw = (rings, turn, gazeX, gazeY) => {
    const bodyScale = inst.shape.squashOnTurn ? Math.max(Math.cos(turn), 0.55) : 1
    const squash = squashTransform(bodyScale)
    if (squash === null) {
      inst.body.removeAttribute('transform')
      inst.clipBody.removeAttribute('transform')
    } else {
      inst.body.setAttribute('transform', squash)
      inst.clipBody.setAttribute('transform', squash)
    }

    const originX = FACE_CENTER + inst.shape.faceX
    const originY = FACE_CENTER + inst.shape.faceY
    const radius = 105 * Math.min(inst.shape.faceScaleX, inst.shape.faceScaleY)
    const baseScale = inst.shape.eyeScale
    const polys = [inst.eyeL, inst.eyeR]

    for (let i = 0; i < 2; i++) {
      const corrected = rings[i].map((p) => [
        originX + (p[0] - FACE_CENTER) * inst.shape.faceScaleX,
        originY + (p[1] - FACE_CENTER) * inst.shape.faceScaleY,
      ])
      const center = centroid(corrected)
      const offset = center.x - originX
      const baseLongitude = Math.asin(clamp(offset / Math.max(radius, 1), -1, 1))
      const longitude = baseLongitude + turn
      const depth = Math.cos(longitude)
      const perspective = Math.max(depth, 0.02) / Math.max(Math.cos(baseLongitude), 0.02)
      const scaleX = clamp(perspective * baseScale, 0.02, 2.4)
      const scaleY = clamp(blinkScale() * baseScale, 0.02, 2.4)

      if (depth > 0.02) {
        const cx = originX + radius * Math.sin(longitude) + gazeX
        const cy = center.y + gazeY
        const pts = []
        for (const p of corrected) {
          pts.push(fmt(cx + (p[0] - center.x) * scaleX) + ',' + fmt(cy + (p[1] - center.y) * scaleY))
        }
        polys[i].setAttribute('points', pts.join(' '))
        polys[i].removeAttribute('style')
      } else {
        polys[i].style.display = 'none'
      }
    }
  }

  let raf = 0
  let t0 = 0
  let last = 0
  let alive = true

  const tick = (ts) => {
    if (!alive) return
    if (!inst.svg.isConnected) {
      stop()
      return
    }
    if (!t0) {
      t0 = ts
      last = ts
    }
    let dt = (ts - last) / 1000
    last = ts
    if (dt > 0.1) dt = 0.1
    if (dt < 0) dt = 0

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const t = (ts - t0) / 1000

    // 相位切换：换节奏与表情池，并立刻把形变重置到新池第一帧
    if (inst.token !== currentStateToken) {
      currentStateToken = inst.token
      stateDef = states[inst.state] || states.idle
      pool = inst.pool !== null ? inst.pool : stateDef.expressions
      current = lerpRings(current, target, clamp(morph, 0, 1))
      currentIdx = pool[0]
      target = expressions[currentIdx]
      morph = 0
      velocity = 0
      exprAt = now + randInt(stateDef.expressionMin, stateDef.expressionMax)
      blinkAt = scheduleBlink(now)
      blinkT = -1
    }

    if (Math.abs(morph - 1) >= 0.001 || Math.abs(velocity) >= 0.001) {
      let remaining = dt
      while (remaining > 0) {
        const step = Math.min(remaining, 1 / 120)
        velocity += (-2 * springFreq * velocity - springFreq * springFreq * (morph - 1)) * step
        morph += velocity * step
        remaining -= step
      }
      if (Math.abs(morph - 1) < 0.001 && Math.abs(velocity) < 0.001) {
        morph = 1
        velocity = 0
        current = target
      }
    }

    if (pool.length > 1 && now >= exprAt) {
      const alternatives = pool.filter((i) => i !== currentIdx)
      const next = alternatives[Math.floor(Math.random() * alternatives.length)]
      current = lerpRings(current, target, clamp(morph, 0, 1))
      target = expressions[next]
      currentIdx = next
      morph = 0
      velocity = 0
      exprAt = now + randInt(stateDef.expressionMin, stateDef.expressionMax)
    }

    if (blinkT >= 0) {
      blinkT += dt
      if (blinkT >= 0.32) {
        blinkT = -1
        blinkAt = scheduleBlink(now)
      }
    } else if (now >= blinkAt && stateDef.blinkMin !== null && stateDef.blinkMin !== undefined) {
      blinkT = 0
    }

    const turn = reduced ? 0 : 0.1 * Math.sin(t * 0.9)
    const gazeX = reduced ? 0 : 0.45 * Math.sin(t * 0.53)
    const gazeY = reduced ? 0 : 0.3 * Math.cos(t * 0.41)

    draw(lerpRings(current, target, clamp(morph, 0, 1)), turn, gazeX, gazeY)
    raf = requestAnimationFrame(tick)
  }

  const stop = () => {
    alive = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  raf = requestAnimationFrame(tick)
  return stop
}

/**
 * 切换状态。
 * @param {object} inst 实例。
 * @param {string} state 状态名（对应 states 表的键）。
 */
export function setBotState(inst, state) {
  if (inst.state === state) return
  inst.state = state
  inst.token += 1
  inst.pool = null
}