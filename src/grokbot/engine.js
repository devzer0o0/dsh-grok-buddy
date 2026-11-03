/**
 * GrokBot 头像渲染引擎（浏览器侧）—— **动作帧 → SVG** 的唯一实现。
 *
 * 分工：
 *   src/grokbot/motion.js   动作规格与采样（纯数据，可冻结、可步进、可断言）
 *   本文件                   把一帧画到真实 SVG 上（图层、裁剪、变换、遮挡）
 *
 * 为什么重写：参考录屏里的六态**不只是换眼型** —— blocked 是头像收成感叹号，
 * thinking 是头像消失后三颗点脉动，done 是头像 + 多条前后穿插的彩色轨道，
 * working 是转头时甩出的一道短拖尾。旧引擎只有「圆脸 + 两只眼睛」一种模型，
 * 无论怎么调表情池都表达不出来。这里补上了符号层、轨道层、拖尾层与进入/退出
 * 所需的缩放与透明度。
 *
 * 保留自 GrokBot 素材（BSD-3-Clause, (c) 2026 nasawz，经 dsh-thought-buddy 移植）
 * 的部分：25 种表情的眼环多边形、18 种体形的 CSS border-radius 几何，以及
 * 「眼睛贴在球面上、按经度透视压缩、转到背面消失」的投影模型 ——
 * idle / working / done 仍然用它们画眼睛。
 *
 * 图层顺序（从下到上）：后景轨道 → 身体 → 眼睛 → 前景轨道 → 拖尾 → 符号。
 * 轨道必须能同时出现在头像前后两层，否则「绕行、遮挡」就退化成贴在脸上的彩线。
 *
 * @module dsh-grok-buddy/grokbot
 */

import {
  BOT_CENTER,
  MOTION_SPEC,
  blendFrames,
  orbitPoints,
  sampleFrame,
  trailBands,
  transitionOf,
} from './motion.js'

const FACE_CENTER = BOT_CENTER
/** 组合画布 = 1.5× 身体直径：参考里轨道最远伸到约 0.69D，留一成安全边距。 */
const COMPOSE = 1.5
const VIEWBOX = 210 * COMPOSE
/** 坐标系内缩，让身体中心落在画布正中。 */
const INSET = VIEWBOX / 2 - FACE_CENTER

/**
 * 动作 → 素材眼环下标。
 *
 * 参考里 idle / working / done 都是**同一副竖眼**，差异全在转头、视线与轨道 ——
 * 所以这三个动作共用素材的第 0 号眼型，不做「换脸」。这正是旧实现的错误所在：
 * 它靠换素材眼型来表达状态，而参考里脸一直没换，变的是动作。
 * waiting / blocked / thinking 根本不用素材眼型（分别是横线眼、感叹号、三点）。
 * 素材只提供眼型的几何 —— 它**不是**六态动画的实现。
 */
const MATERIAL_EYES = Object.freeze({ rest: [0], spin: [0], orbit: [0] })

/**
 * 解析 CSS border-radius 语法（支持 1-4 值与椭圆斜杠写法），并做相邻角钳制。
 * @param {string} css border-radius 值。
 * @param {number} width 盒宽。
 * @param {number} height 盒高。
 * @returns {Array<{rx:number, ry:number}>} 四角半径。
 */
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
}let clipSeq = 0

/** 供构建期/预览使用的常量。 */
export const BOT_VIEWBOX = VIEWBOX
export const BOT_INSET = INSET
/** 身体在画布里的占比（16px 下头像本体约 10.8px，轨道仍在框内）。 */
export const BOT_BODY_RATIO = 210 / VIEWBOX

/** 一个 SVG 元素 + 属性设置的小工具。 */
function make(ns, tag, attrs) {
  const el = document.createElementNS(ns, tag)
  if (attrs !== undefined) {
    for (const key of Object.keys(attrs)) el.setAttribute(key, String(attrs[key]))
  }
  return el
}

/**
 * 建一个 GrokBot 头像实例。
 *
 * @param {object} opts 选项。
 * @param {object} opts.shape 体形描述（TB_SHAPES 的一项）。
 * @param {string} opts.bodyFill 身体墨色（项目身份色）。
 * @param {string} opts.eyeFill 眼睛颜色（背景色，让眼睛「挖空」）。
 * @param {number} opts.size 像素尺寸。
 * @returns {object} 实例（含各图层句柄）。
 */
export function createBot(opts) {
  const ns = 'http://www.w3.org/2000/svg'
  const shape = opts.shape
  /** 素材眼环表。只服务 idle / working / done 的眼睛造型。 */
  const expressions = Array.isArray(opts.expressions) ? opts.expressions : null
  const size = opts.size || 16
  const clipId = 'dsgb' + ++clipSeq

  const svg = make(ns, 'svg', {
    viewBox: '0 0 ' + VIEWBOX + ' ' + VIEWBOX,
    width: size,
    height: size,
    'aria-hidden': 'true',
    class: 'dsgb',
  })

  const root = make(ns, 'g', { transform: 'translate(' + fmt(INSET) + ' ' + fmt(INSET) + ')' })

  const defs = make(ns, 'defs')
  const clip = make(ns, 'clipPath', { id: clipId })
  const clipBody = make(ns, 'path', { d: bodyPath(shape) })
  clip.appendChild(clipBody)
  defs.appendChild(clip)

  // 后景轨道（头像后面）
  const orbitsBack = make(ns, 'g', { class: 'dsgb-orbits-back', 'data-dsgb-layer': 'orbits-back' })
  // 头像本体
  const bodyGroup = make(ns, 'g', { class: 'dsgb-body', 'data-dsgb-layer': 'body' })
  const body = make(ns, 'path', { d: bodyPath(shape), fill: opts.bodyFill })
  bodyGroup.appendChild(body)
  // 眼睛（裁剪在身体里）
  const eyeGroup = make(ns, 'g', { class: 'dsgb-eyes', 'data-dsgb-layer': 'eyes', 'clip-path': 'url(#' + clipId + ')' })
  const eyeL = make(ns, 'polygon', { fill: opts.eyeFill })
  const eyeR = make(ns, 'polygon', { fill: opts.eyeFill })
  eyeGroup.appendChild(eyeL)
  eyeGroup.appendChild(eyeR)
  // 前景轨道（压在头像上）
  const orbitsFront = make(ns, 'g', { class: 'dsgb-orbits-front', 'data-dsgb-layer': 'orbits-front' })
  // 拖尾（工作态那一甩）
  const trailGroup = make(ns, 'g', { class: 'dsgb-trail', 'data-dsgb-layer': 'trail' })
  // 符号层：感叹号
  const bangGroup = make(ns, 'g', { class: 'dsgb-bang', 'data-dsgb-layer': 'bang' })
  const bangBar = make(ns, 'path', { fill: opts.bodyFill })
  const bangDot = make(ns, 'circle', { fill: opts.bodyFill })
  bangGroup.appendChild(bangBar)
  bangGroup.appendChild(bangDot)
  // 符号层：三颗思考点
  const dotsGroup = make(ns, 'g', { class: 'dsgb-dots', 'data-dsgb-layer': 'dots' })
  const dotEls = [0, 1, 2].map(() => {
    const c = make(ns, 'circle', { fill: opts.bodyFill })
    dotsGroup.appendChild(c)
    return c
  })

  root.appendChild(defs)
  root.appendChild(orbitsBack)
  root.appendChild(bodyGroup)
  root.appendChild(eyeGroup)
  root.appendChild(orbitsFront)
  root.appendChild(trailGroup)
  root.appendChild(bangGroup)
  root.appendChild(dotsGroup)
  svg.appendChild(root)

  const inst = {
    svg,
    root,
    body,
    bodyGroup,
    clipBody,
    eyeGroup,
    eyeL,
    eyeR,
    orbitsBack,
    orbitsFront,
    trailGroup,
    bangGroup,
    bangBar,
    bangDot,
    dotsGroup,
    dotEls,
    shape,
    expressions,
    /** 当前动作 id（内部动画资源名，不是业务状态）。 */
    state: 'rest',
    /** 动作每换一次 +1，动画循环据此重开时间轴。 */
    token: 0,
    /** 当前帧（诊断/测试可读）。 */
    frame: null,
    /** 是否正在推进帧。 */
    running: false,
    /** 是否处于静态模式（reduced-motion）。 */
    static: false,
    /** 最近一次绘制的动作。 */
    painted: '',
  }
  paintFrame(inst, sampleFrame('rest', 0, { static: true }))
  return inst
}

/**
 * 把一帧画到实例上。纯函数式：同样的帧画出同样的 SVG。
 *
 * @param {object} inst 实例。
 * @param {object} frame sampleFrame / blendFrames 的产物。
 */
export function paintFrame(inst, frame) {
  inst.frame = frame
  const bodyTransform = frame.body.sx !== 1 || frame.body.sy !== 1
    ? 'translate(' + fmt(FACE_CENTER) + ' ' + fmt(FACE_CENTER) + ') scale(' +
      fmt(frame.body.sx) + ' ' + fmt(frame.body.sy) + ') translate(' + fmt(-FACE_CENTER) + ' ' + fmt(-FACE_CENTER) + ')'
    : null
  if (bodyTransform === null) inst.bodyGroup.removeAttribute('transform')
  else inst.bodyGroup.setAttribute('transform', bodyTransform)
  if (bodyTransform === null) inst.clipBody.removeAttribute('transform')
  else inst.clipBody.setAttribute('transform', bodyTransform)

  setVisible(inst.bodyGroup, frame.body.visible && frame.body.alpha > 0.01)
  setOpacity(inst.bodyGroup, frame.body.alpha)

  paintEyes(inst, frame)
  paintBang(inst, frame)
  paintDots(inst, frame)
  paintOrbits(inst, frame)
  paintTrail(inst, frame)

  inst.painted = frame.motion
  const svg = inst.svg
  if (svg.getAttribute('data-dsgb-frame') !== frame.motion) {
    svg.setAttribute('data-dsgb-frame', frame.motion || '')
  }
}

function paintEyes(inst, frame) {
  const eyes = frame.eyes
  const custom = Array.isArray(eyes.rings)
  const rings = custom ? eyes.rings : materialEyes(inst)
  const visible = eyes.visible && eyes.alpha > 0.01 && Array.isArray(rings)
  setVisible(inst.eyeGroup, visible)
  if (!visible) return
  setOpacity(inst.eyeGroup, eyes.alpha)
  // 转头只来自 eyes.turn：body.turn 是「身体姿态」，两者相加会把转头算两遍
  // （实测 idle 转左时眼睛被推到 cx=-0.49D，比参考的 -0.27D 远了一倍）。
  drawRings(inst, rings, eyes.turn, eyes.gazeX, eyes.gazeY, eyes.blink, custom ? 'body' : 'material')
}

/**
 * 取当前动作要用的素材眼环。
 *
 * 素材只负责 idle / working / done 的**眼型**；转头、视线、眨眼、轨道、拖尾全部
 * 来自动作采样器。所以换素材不会改变六态的动作语义 —— 素材不是六态动画的实现。
 *
 * @param {object} inst 实例。
 * @returns {Array|null} 双眼眼环。
 */
function materialEyes(inst) {
  const table = inst.expressions
  if (table === null) return null
  const pool = MATERIAL_EYES[inst.state] || MATERIAL_EYES.rest
  const rings = table[pool[0]] === undefined ? table[0] : table[pool[0]]
  return rings === undefined ? null : rings
}

/**
 * 画一对眼环。
 *
 * 眼环是**贴在球面上**的多边形：按中心经度做透视压缩，转到背面就消失。
 * 这是 GrokBot 看起来像活的那一半原因，六态里的转头、视线、遮挡都靠它。
 *
 * @param {object} inst 实例。
 * @param {Array} rings 双眼眼环。
 * @param {number} turn 转头（弧度）。
 * @param {number} gazeX 视线水平偏移。
 * @param {number} gazeY 视线垂直偏移。
 * @param {number} blinkScale 眨眼纵向缩放（1 = 完全睁开）。
 * @param {string} [ringSpace] 'material'（素材坐标，按体形修正）或 'body'（已是身体坐标）。
 */
function drawRings(inst, rings, turn, gazeX, gazeY, blinkScale, ringSpace) {
  const absolute = ringSpace === 'body'
  const bodyScale = inst.shape.squashOnTurn ? Math.max(Math.cos(turn), 0.55) : 1
  const originX = FACE_CENTER + inst.shape.faceX
  const originY = FACE_CENTER + inst.shape.faceY
  const radius = 105 * Math.min(inst.shape.faceScaleX, inst.shape.faceScaleY)
  const baseScale = inst.shape.eyeScale
  const polys = [inst.eyeL, inst.eyeR]
  for (let i = 0; i < 2; i++) {
    const ring = rings[i]
    if (!Array.isArray(ring) || ring.length === 0) {
      polys[i].style.display = 'none'
      continue
    }
    const corrected = absolute
      ? ring
      : ring.map((p) => [
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
    const scaleY = clamp(blinkScale * baseScale, 0.02, 2.4)
    if (depth > 0.02) {
      const cx = originX + radius * Math.sin(longitude) + gazeX
      const cy = center.y + gazeY
      const pts = []
      for (const p of corrected) {
        pts.push(fmt(cx + (p[0] - center.x) * scaleX) + ',' + fmt(cy + (p[1] - center.y) * scaleY))
      }
      const existing = polys[i].style
      if (existing !== undefined && existing.display === 'none') polys[i].style.display = ''
      polys[i].setAttribute('points', pts.join(' '))
    } else {
      polys[i].style.display = 'none'
    }
    void bodyScale
  }
}

/**
 * 感叹号：上方长条（顶宽底窄、两端圆头）+ 下方圆点。
 *
 * 几何来自逐帧量测（归一化到身体直径 D）：
 *   长条 y -0.325D..+0.092D，顶宽 0.146D，底宽 0.078D；
 *   圆点直径 0.121D，中心 +0.253D。
 *
 * @param {object} inst 实例。
 * @param {object} frame 当前帧。
 */
function paintBang(inst, frame) {
  const spec = MOTION_SPEC.bang
  const bang = frame.bang
  const visible = bang.visible && bang.alpha > 0.01
  setVisible(inst.bangGroup, visible)
  if (!visible) return
  setOpacity(inst.bangGroup, bang.alpha)
  const grow = clamp(bang.grow, 0, 1)
  const D = 210
  const topY = FACE_CENTER + spec.barTop * D * grow
  const bottomY = FACE_CENTER + spec.barBottom * D * grow
  const halfTop = (spec.barTopWidth * D * grow) / 2
  const halfBottom = (spec.barBottomWidth * D * (0.5 + 0.5 * grow)) / 2
  const cx = FACE_CENTER
  // 顶圆头的半径就是半顶宽；底圆头略小，形成参考里的锥形收束。
  const rTop = halfTop
  const rBottom = halfBottom
  const d = [
    'M ' + fmt(cx - halfTop) + ' ' + fmt(topY + rTop),
    'A ' + fmt(rTop) + ' ' + fmt(rTop) + ' 0 0 1 ' + fmt(cx - halfTop + rTop * 2) + ' ' + fmt(topY + rTop),
    'L ' + fmt(cx + halfBottom) + ' ' + fmt(bottomY - rBottom),
    'A ' + fmt(rBottom) + ' ' + fmt(rBottom) + ' 0 0 1 ' + fmt(cx - halfBottom) + ' ' + fmt(bottomY - rBottom),
    'Z',
  ].join(' ')
  inst.bangBar.setAttribute('d', d)
  inst.bangDot.setAttribute('cx', fmt(cx))
  inst.bangDot.setAttribute('cy', fmt(FACE_CENTER + spec.dotY * D * grow))
  inst.bangDot.setAttribute('r', fmt((spec.dotDiameter * D * grow) / 2))
}

/**
 * 三颗横排思考点：位置、点径、透明度逐帧跟随采样结果。
 * @param {object} inst 实例。
 * @param {object} frame 当前帧。
 */
function paintDots(inst, frame) {
  const dots = frame.dots
  const visible = dots.visible && dots.alpha > 0.01 && Array.isArray(dots.items) && dots.items.length === 3
  setVisible(inst.dotsGroup, visible)
  if (!visible) return
  setOpacity(inst.dotsGroup, dots.alpha)
  for (let i = 0; i < 3; i++) {
    const item = dots.items[i]
    const el = inst.dotEls[i]
    if (item === undefined) {
      el.style.display = 'none'
      continue
    }
    el.style.display = ''
    el.setAttribute('cx', fmt(item.x))
    el.setAttribute('cy', fmt(item.y))
    el.setAttribute('r', fmt(Math.max(item.r, 0.2)))
    setOpacity(el, clamp(item.alpha, 0, 1))
  }
}

/**
 * 彩色轨道：按深度分成「身后」「身前」两段，前后穿插才有绕行感。
 * @param {object} inst 实例。
 * @param {object} frame 当前帧。
 */
function paintOrbits(inst, frame) {
  const orbits = frame.orbits
  const visible = orbits.visible && orbits.alpha > 0.01 && Array.isArray(orbits.rings) && orbits.rings.length > 0
  setVisible(inst.orbitsBack, visible)
  setVisible(inst.orbitsFront, visible)
  if (!visible) return
  setOpacity(inst.orbitsBack, orbits.alpha)
  setOpacity(inst.orbitsFront, orbits.alpha)
  const back = []
  const front = []
  for (const ring of orbits.rings) {
    const scaled = {
      a: ring.a * orbits.scale,
      b: ring.b * orbits.scale,
      tilt: ring.tilt,
      yaw: ring.yaw,
      spin: ring.spin,
    }
    const split = orbitPoints(scaled, FACE_CENTER, FACE_CENTER, 120)
    for (const seg of split.back) back.push({ color: ring.color, width: ring.width * orbits.scale, points: seg })
    for (const seg of split.front) front.push({ color: ring.color, width: ring.width * orbits.scale, points: seg })
  }
  paintPolylines(inst.orbitsBack, back)
  paintPolylines(inst.orbitsFront, front)
}

/**
 * 拖尾：参考里是一道短暂的多色弧，扫过头像侧面后就缩短、淡出。
 * @param {object} inst 实例。
 * @param {object} frame 当前帧。
 */
function paintTrail(inst, frame) {
  const trail = frame.trail
  const visible = trail.visible && trail.alpha > 0.01 && trail.radius > 0
  setVisible(inst.trailGroup, visible)
  if (!visible) return
  setOpacity(inst.trailGroup, trail.alpha)
  const bands = trailBands(trail, FACE_CENTER, FACE_CENTER, trail.colors.length || 5)
  const bandWidth = MOTION_SPEC.spin.trailBandWidth * 210
  const spread = Math.max((trail.width - bandWidth) / 2, 0)
  paintPolylines(
    inst.trailGroup,
    bands.map((band, i) => {
      // 五条色带沿半径方向错开排布，合起来就是参考里那道厚彩带
      const offset = bands.length === 1 ? 0 : -spread + (2 * spread * i) / (bands.length - 1)
      const points = band.points.map((pt) => {
        const dx = pt[0] - FACE_CENTER
        const dy = pt[1] - FACE_CENTER
        const len = Math.hypot(dx, dy) || 1
        return [pt[0] + (dx / len) * offset, pt[1] + (dy / len) * offset]
      })
      return { color: band.color, width: bandWidth, points }
    }),
  )
}

/** 用「一条路径一条线」画折线组；重画时复用已有节点，不无限增长。 */
function paintPolylines(group, items) {
  while (group.children.length > items.length) {
    const last = group.children[group.children.length - 1]
    group.removeChild(last)
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    let el = group.children[i]
    if (el === undefined) {
      el = make(group.namespaceURI || 'http://www.w3.org/2000/svg', 'path', {
        fill: 'none',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      })
      group.appendChild(el)
    }
    let d = ''
    for (let k = 0; k < item.points.length; k++) {
      const p = item.points[k]
      d += (k === 0 ? 'M ' : ' L ') + fmt(p[0]) + ' ' + fmt(p[1])
    }
    el.setAttribute('d', d)
    el.setAttribute('stroke', item.color)
    el.setAttribute('stroke-width', fmt(Math.max(item.width, 0.4)))
  }
}

function setVisible(el, visible) {
  if (visible) {
    if (el.style !== undefined && el.style.display === 'none') el.style.display = ''
    else if (el.getAttribute('display') === 'none') el.removeAttribute('display')
  } else {
    if (el.style !== undefined) el.style.display = 'none'
    else el.setAttribute('display', 'none')
  }
}

function setOpacity(el, alpha) {
  const value = Math.round(clamp(alpha, 0, 1) * 1000) / 1000
  if (value >= 1) {
    el.removeAttribute('opacity')
    return
  }
  el.setAttribute('opacity', String(value))
}

/**
 * 启动动画循环。
 *
 * 时间来源可注入（`now` / `raf` / `cancelRaf`），所以测试能把时钟冻结在任意时刻、
 * 逐帧步进、以不同步长采样，而动作速度只取决于经过的时间，与刷新率无关。
 *
 * 同一动作的快照刷新**不会**重开时间轴；只有动作 id 真的变了才建立新的进入段。
 *
 * @param {object} inst 实例。
 * @param {object} [deps] 依赖。
 * @param {boolean} [deps.reduced] 减少动效：不启动持续帧，只画代表性静态帧。
 * @param {function} [deps.now] 时钟。
 * @param {function} [deps.raf] 帧调度。
 * @param {function} [deps.cancelRaf] 取消帧。
 * @param {number} [deps.transitionMs] 覆盖过渡时长（预览用）。
 * @returns {{stop: function, pause: function, resume: function, step: function}} 控制柄。
 */
export function runBot(inst, deps) {
  const opts = deps !== undefined && deps !== null ? deps : {}
  const reduced = opts.reduced === true
  const now = typeof opts.now === 'function'
    ? opts.now
    : () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const raf = typeof opts.raf === 'function'
    ? opts.raf
    : (cb) => requestAnimationFrame(cb)
  const cancelRaf = typeof opts.cancelRaf === 'function'
    ? opts.cancelRaf
    : (id) => cancelAnimationFrame(id)

  let alive = true
  let paused = false
  let rafId = 0
  /** 当前动作开始时刻（毫秒）。 */
  let motionStart = now()
  /** 上一次动作切换时冻结的那一帧（过渡的起点）。 */
  let previousFrame = null
  let transitionFrom = 0
  let transitionMs = 0
  let currentToken = inst.token
  let hiddenAt = 0

  const paintStatic = () => {
    paintFrame(inst, sampleFrame(activeMotion(), 0, { static: true }))
  }

  const activeMotion = () => (typeof inst.state === 'string' && inst.state !== '' ? inst.state : 'rest')

  const render = (tNow) => {
    if (inst.token !== currentToken) {
      // 真的换动作了：冻结旧帧作为过渡起点，时间轴从这一刻重新算
      currentToken = inst.token
      previousFrame = inst.frame === null ? null : cloneFrame(inst.frame)
      transitionFrom = tNow
      transitionMs = typeof opts.transitionMs === 'number'
        ? opts.transitionMs
        : previousFrame === null
          ? 0
          : transitionOf(previousFrame.motion, activeMotion())
      motionStart = tNow
    }
    const elapsed = Math.max(tNow - motionStart, 0)
    const frame = sampleFrame(activeMotion(), elapsed)
    if (previousFrame !== null && transitionMs > 0) {
      const k = (tNow - transitionFrom) / transitionMs
      if (k < 1) {
        paintFrame(inst, blendFrames(previousFrame, frame, k))
        return
      }
      previousFrame = null
    }
    paintFrame(inst, frame)
  }

  if (reduced) {
    paintStatic()
    inst.running = false
    inst.static = true
    inst.repaintStatic = paintStatic
    return {
      stop() {
        alive = false
        inst.running = false
        inst.static = true
        inst.repaintStatic = null
      },
      pause() {},
      resume() {},
      step() {
        paintStatic()
      },
    }
  }

  const tick = (ts) => {
    if (!alive) return
    const stamp = typeof ts === 'number' && Number.isFinite(ts) ? ts : now()
    render(stamp)
    if (!alive || paused) return
    rafId = raf(tick)
  }

  inst.running = true
  inst.static = false
  inst.repaintStatic = null
  rafId = raf(tick)

  return {
    stop() {
      alive = false
      inst.running = false
      if (rafId) cancelRaf(rafId)
      rafId = 0
    },
    /** 暂停：停止排帧，但不动业务状态，也不消费完成。 */
    pause() {
      if (!alive || paused) return
      paused = true
      hiddenAt = now()
      if (rafId) cancelRaf(rafId)
      rafId = 0
      inst.running = false
    },
    /** 恢复：把时间轴整体后移，隐藏期间不算「动画走过的时间」。 */
    resume() {
      if (!alive || !paused) return
      const gap = Math.max(now() - hiddenAt, 0)
      motionStart += gap
      transitionFrom += gap
      paused = false
      inst.running = true
      rafId = raf(tick)
    },
    /** 手动推进到某一时刻（测试 / 逐帧预览用，不依赖 rAF）。 */
    step(tNow) {
      if (!alive) return
      render(typeof tNow === 'number' ? tNow : now())
    },
  }
}

/** 浅拷贝一帧（过渡起点要冻结，不能被后续绘制改写）。 */
function cloneFrame(frame) {
  return {
    motion: frame.motion,
    time: frame.time,
    body: { ...frame.body },
    eyes: { ...frame.eyes, rings: frame.eyes.rings === null ? null : frame.eyes.rings.map((r) => r.map((p) => [p[0], p[1]])) },
    bang: { ...frame.bang },
    dots: { ...frame.dots, items: frame.dots.items.map((item) => ({ ...item })) },
    orbits: { ...frame.orbits, rings: frame.orbits.rings.map((ring) => ({ ...ring })) },
    trail: { ...frame.trail, colors: Array.isArray(frame.trail.colors) ? [...frame.trail.colors] : [] },
  }
}

/**
 * 切换动作。真正的状态变化才走这里 —— 同态快照刷新不会调用它，所以不会重播进入动作。
 * @param {object} inst 实例。
 * @param {string} state 动作 id。
 */
export function setBotState(inst, state) {
  if (inst.state === state) return
  inst.state = state
  inst.token += 1
}

/**
 * 换配色（项目身份色 / 主题）；不重播动作，只改墨色。
 * @param {object} inst 实例。
 * @param {string} bodyFill 身体墨色。
 * @param {string} eyeFill 眼睛颜色。
 */
export function setBotInk(inst, bodyFill, eyeFill) {
  inst.body.setAttribute('fill', bodyFill)
  inst.bangBar.setAttribute('fill', bodyFill)
  inst.bangDot.setAttribute('fill', bodyFill)
  for (const dot of inst.dotEls) dot.setAttribute('fill', bodyFill)
  inst.eyeL.setAttribute('fill', eyeFill)
  inst.eyeR.setAttribute('fill', eyeFill)
}
