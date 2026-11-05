/**
 * Working / completion choreography reconstructed from the official motion system.
 * No React, wall clock, network or business-state handling lives here.
 *
 * Native coordinates and timing are deliberately retained until the final projection:
 * a critically damped working turn; the nine-turn / three-roll celebration; velocity-
 * emitted, growing/retiring, variable-width gradient ribbons on one / three planes.
 * See docs/motion-spec.md for provenance, oracle comparisons and loop adaptation.
 */
import { TB_EXPRESSIONS } from './data.js'
import { REFERENCE_BLOB } from './reference-geometry.js'

const RC = 114.2705
const RQ = 105 / RC
const RTAU = Math.PI * 2
const RSTEP = 1000 / 60
const rClamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const rSmooth = (v) => { const t = rClamp(v); return t * t * (3 - 2 * t) }
const rSpring = (x) => ({ x, v: 0, t: x })
const rAdvance = (s, frequency, damping, dt) => {
  s.v += (-2 * damping * frequency * s.v - frequency * frequency * (s.x - s.t)) * dt
  s.x += s.v * dt
}
const rRound = (v, digits = 2) => Number(v.toFixed(digits))
const rCenter = (ring) => ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0])
const rAngle = (a) => { while (a > Math.PI / 2) a -= Math.PI; while (a < -Math.PI / 2) a += Math.PI; return a }

function rAxes(ring) {
  const [cx, cy] = rCenter(ring)
  let xx = 0, yy = 0, xy = 0
  for (const [x, y] of ring) { xx += (x - cx) ** 2; yy += (y - cy) ** 2; xy += (x - cx) * (y - cy) }
  xx /= ring.length; yy /= ring.length; xy /= ring.length
  const lambda = (xx + yy + Math.hypot(xx - yy, 2 * xy)) / 2
  let ux = lambda - yy, uy = xy
  if (Math.abs(xy) < 1e-9 && Math.abs(xx - yy) < 1e-9) { ux = 1; uy = 0 }
  const len = Math.hypot(ux, uy) || 1
  ux /= len; uy /= len
  if (uy < 0 || (uy === 0 && ux < 0)) { ux = -ux; uy = -uy }
  let halfLen = 0, halfW = 0
  for (const [x, y] of ring) {
    halfLen = Math.max(halfLen, Math.abs((x - cx) * ux + (y - cy) * uy))
    halfW = Math.max(halfW, Math.abs(-(x - cx) * uy + (y - cy) * ux))
  }
  return { cx, cy, ux, uy, halfLen, halfW }
}

function rCapsule({ cx, cy, ux, uy, halfLen, halfW }, count = 48) {
  const stem = Math.max(0, halfLen - halfW)
  return Array.from({ length: count }, (_, index) => {
    const angle = index / count * RTAU
    const cos = Math.cos(angle), sin = Math.sin(angle)
    const along = cos * ux + sin * uy, across = -cos * uy + sin * ux
    let distance = halfW / Math.max(Math.abs(across), 1e-6)
    if (distance * Math.abs(along) > stem + 1e-6 || !Number.isFinite(distance)) {
      const b = Math.sign(along || 1) * stem * along
      distance = b + Math.sqrt(Math.max(0, b * b - stem * stem + halfW * halfW))
    }
    return [cx + distance * cos, cy + distance * sin]
  })
}

function rMorph(a, b, t) {
  t = rClamp(t)
  if (t <= 0) return a
  if (t >= 1) return b
  const u = rAxes(a), v = rAxes(b)
  const angle = Math.atan2(u.uy, u.ux) + rAngle(Math.atan2(v.uy, v.ux) - Math.atan2(u.uy, u.ux)) * t
  const halfW = Math.max(0.35, u.halfW + (v.halfW - u.halfW) * t)
  return rCapsule({
    cx: u.cx + (v.cx - u.cx) * t, cy: u.cy + (v.cy - u.cy) * t,
    ux: Math.cos(angle), uy: Math.sin(angle), halfW,
    halfLen: Math.max(0, u.halfLen - u.halfW) * (1 - t) + Math.max(0, v.halfLen - v.halfW) * t + halfW,
  }, a.length)
}

function rWorkingEyes(index) {
  let eyes = TB_EXPRESSIONS[index]
  const neutral = TB_EXPRESSIONS[0].map(rAxes)
  if (index === 7 || index === 16) {
    const axes = eyes.map(rAxes)
    const relative = axes.map((a, i) => rAngle(Math.atan2(a.uy, a.ux) - Math.atan2(neutral[i].uy, neutral[i].ux)))
    const mean = (relative[0] + relative[1]) / 2
    eyes = eyes.map((ring, i) => {
      const a = axes[i], angle = rAngle(Math.atan2(neutral[i].uy, neutral[i].ux) + mean - Math.atan2(a.uy, a.ux))
      return ring.map(([x, y]) => [a.cx + (x - a.cx) * Math.cos(angle) - (y - a.cy) * Math.sin(angle), a.cy + (x - a.cx) * Math.sin(angle) + (y - a.cy) * Math.cos(angle)])
    })
  }
  eyes = eyes.map((ring, i) => {
    const a = rAxes(ring), b = neutral[i]
    const k = Math.min(1, 1.05 / Math.max(a.halfLen / b.halfLen, a.halfW / b.halfW))
    return k >= 0.999 ? ring : ring.map(([x, y]) => [a.cx + (x - a.cx) * k, a.cy + (y - a.cy) * k])
  })
  const left = rAxes(eyes[0]), right = rAxes(eyes[1])
  return [eyes[0], rCapsule({ ...right, halfLen: left.halfLen, halfW: left.halfW }, eyes[1].length)]
}

function rSpan(y) {
  const { top, bottom, spans } = REFERENCE_BLOB
  const f = rClamp((y - top) / (bottom - top) * 160 - 0.5, 0, 159)
  const i = Math.floor(f), t = f - i, a = spans[i], b = spans[Math.min(i + 1, 159)]
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** The native ribbon centreline. Depth is signed, not inferred from screen y. */
function rPoint(orbit, longitude) {
  const x = orbit.rad * Math.sin(longitude)
  const y = -orbit.rad * Math.cos(longitude) * Math.sin(orbit.tilt)
  const c = Math.cos(orbit.roll), s = Math.sin(orbit.roll)
  return { x: RC + x * c - y * s, y: RC + x * s + y * c, l: longitude, z: Math.cos(longitude) * Math.cos(orbit.tilt) }
}

/** Filled open ribbons: half-width tail, round head, shared front/back crossings. */
export function ribbonOutline(points, width) {
  if (points.length < 2) return { front: '', back: '' }
  let length = 0
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  if (length < 2) return { front: '', back: '' }
  const w = Math.min(width, length * 0.34)
  const normal = points.map((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)]
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const half = w * (0.5 + i / (points.length - 1) * 0.5) / 2
    return [-(b.y - a.y) / d * half, (b.x - a.x) / d * half]
  })
  const f = (v) => Math.round(v * 10) / 10
  const cap = (i) => { const r = f(Math.max(Math.hypot(...normal[i]), 0.2)); return `A${r} ${r} 0 0 0 ` }
  const segment = (start, end) => {
    let d = ''
    for (let i = start; i <= end; i++) d += `${i === start ? 'M' : 'L'}${f(points[i].x + normal[i][0])} ${f(points[i].y + normal[i][1])}`
    d += end === points.length - 1 ? cap(end) : 'L'
    for (let i = end; i >= start; i--) d += `${i === end ? '' : 'L'}${f(points[i].x - normal[i][0])} ${f(points[i].y - normal[i][1])}`
    if (start === 0) d += `${cap(0)}${f(points[0].x + normal[0][0])} ${f(points[0].y + normal[0][1])}`
    return d + 'Z'
  }
  const result = { front: '', back: '' }
  for (let start = 0; start < points.length;) {
    const front = points[start].z >= 0
    let end = start
    while (end + 1 < points.length && (points[end + 1].z >= 0) === front) end++
    const lo = Math.max(start - 1, 0), hi = Math.min(end + 1, points.length - 1)
    if (hi > lo) result[front ? 'front' : 'back'] += segment(lo, hi)
    start = end + 1
  }
  return result
}

class ReferenceChoreography {
  constructor(working) {
    this.working = working
    let seed = 1
    this.random = () => {
      let n = seed += 0x6d2b79f5
      n = Math.imul(n ^ (n >>> 15), n | 1)
      n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
      return ((n ^ (n >>> 14)) >>> 0) / 4294967296
    }
    this.range = (a, b) => a + this.random() * (b - a)
    this.interactionAt = this.range(2500, 5000)
    this.random() // initial particle longitude (upstream's seeded stream)
    this.random() // shape-change spin choice; retained for reference stream parity
    this.s = { morph: rSpring(1), roll: rSpring(0), x: rSpring(0), y: rSpring(0), sy: rSpring(1), lid: rSpring(1), eye: rSpring(1), gx: rSpring(0), gy: rSpring(0) }
    this.from = TB_EXPRESSIONS[0]; this.to = this.from; this.expression = 0; this.expressionIndex = 0
    this.blinks = []; this.particles = []; this.pending = []; this.planes = []
    this.previousSpin = 0; this.velocity = 0; this.spin = null; this.wild = null
    this.spinAngle = 0; this.nextId = 0; this.time = 0; this.morphSpeed = 7
  }

  changeEyes(index, speed) {
    if (index === this.expression && this.s.morph.t === 1) return
    this.from = this.from.map((ring, i) => rMorph(ring, this.to[i], this.s.morph.x))
    this.to = this.working ? rWorkingEyes(index) : TB_EXPRESSIONS[index]
    this.expression = index
    this.s.morph = rSpring(0); this.s.morph.t = 1; this.morphSpeed = speed
  }

  blink(t) {
    this.blinks.push([t, .05], [t + 70, .05], [t + 150, 1.08], [t + 300, 1])
    if (this.random() < .14) this.blinks.push([t + 370, .05], [t + 480, 1])
  }

  step(t) {
    const dt = (t - this.time) / 1000; this.time = t
    const seconds = t / 1000, s = this.s, w = this.working
    if (!this.initialized) {
      this.initialized = true
      this.expressionAt = t + this.range(...(w ? [1800, 3200] : [1400, 2600]))
      this.blinkAt = t + this.range(1500, 7000)
      this.spinAt = t + this.range(...(w ? [1200, 2400] : [6000, 10000]))
      this.range(500, 1200); this.range(1200, 2200)
      this.gazeAt = t + this.range(500, 1400); this.range(3000, 8000)
      this.wildAt = t + 140
      this.blink(t); this.changeEyes(w ? 7 : 2, 8)
    }
    if (!w && !this.wild && t >= this.wildAt) {
      this.wild = { start: t, direction: this.random() < .5 ? 1 : -1 }
      this.wildAt = t + 6200
    }
    if (t >= this.interactionAt) this.interactionAt = t + this.range(9000, 18000)
    let lid = 1, eye = w ? 1 : 1.1
    this.extra = { roll: 0, x: 0, y: 0, gx: 0, gy: 0 }
    if (w) {
      const pulse = Math.sin(seconds * Math.PI * 3.2)
      s.roll.t = 4 + 2.5 * pulse; s.x.t = 3; s.y.t = 1.5 + 3 * Math.max(0, pulse); s.sy.t = 1 - .02 * Math.max(0, pulse)
      if (t >= this.spinAt) { if (!this.spin) { this.spin = rSpring(0); this.spin.t = RTAU } this.spinAt = t + this.range(6000, 9000) }
    } else {
      s.roll.t = 0; s.x.t = 0; s.y.t = -2.5 * Math.abs(Math.sin(1.6 * seconds)); s.sy.t = 1; lid = 1.1
    }
    if (t >= this.gazeAt) {
      s.gx.t = 15 * this.range(-.4, .4)
      s.gy.t = 9 * this.range(...(w ? [.4, 1] : [-.3, .3]))
      this.gazeAt = t + this.range(...(w ? [1200, 2400] : [2500, 5000]))
    }
    let wildAngle = null
    if (this.wild) {
      const u = (t - this.wild.start) / 1000, direction = this.wild.direction
      if (u < 5.49) {
        const speed = (9 * RTAU + .5) / (0.15 + 2 + .3125)
        let angle
        if (u < .24) angle = -.25 * (1 - Math.cos(u / .24 * Math.PI))
        else if (u < .54) angle = -.5 + speed * (u - .24) ** 2 / .6
        else if (u < 2.54) angle = -.5 + speed * (.15 + u - .54)
        else if (u < 3.79) angle = -.5 + speed * 2.15 + 1.25 * speed * (1 - (1 - (u - 2.54) / 1.25) ** 4) / 4
        else angle = 9 * RTAU
        wildAngle = angle * direction
        let settle = 0
        if (u > 2.54) {
          const fraction = Math.min((u - 2.54) / 1.25, 1)
          settle = fraction < .4 ? 0 : ((fraction - .4) / .6) ** 2
          if (u >= 3.79) settle = Math.pow(1 - (u - 3.79) / 1.7, 1.6)
        }
        const tail = Math.max(u - 2.54, 0)
        this.extra = {
          roll: angle / (9 * RTAU) * 1080 * direction + 11 * Math.sin(9.2 * tail) * direction * settle,
          x: (Math.cos(9.2 * tail) - 1) * 6 * direction * settle,
          y: 2.6 * Math.sin(18.4 * tail) * settle,
          gx: 13 * Math.sin(11.5 * tail) * direction * settle,
          gy: (Math.cos(9 * tail) - 1) * 3.5 * settle,
        }
        lid = 1.14 - .44 * settle + .1 * Math.sin(16 * tail) * settle
        eye = 1.12 - .09 * settle
      } else this.wild = null
    }
    if (t >= this.expressionAt) {
      const pool = w ? [7, 16, 11, 10] : [2, 8, 17]
      this.expressionIndex = (this.expressionIndex + 1 + Math.floor(this.range(0, pool.length - 1))) % pool.length
      this.changeEyes(pool[this.expressionIndex], 6)
      this.expressionAt = t + this.range(...(w ? [1800, 3200] : [1400, 2600]))
    }
    if (t >= this.blinkAt) { this.blink(t); this.blinkAt = t + this.range(...(w ? [2800, 5500] : [2200, 4500])) }
    let blink = null
    while (this.blinks.length && t >= this.blinks[0][0]) blink = this.blinks.shift()[1]
    if (w) eye *= 1 + .14 * rSmooth((-s.gx.x - .5) / 4.5) * rSmooth((s.gy.x - 3) / 6)
    s.lid.t = blink ?? (this.blinks.length ? s.lid.t : lid); s.eye.t = eye
    const steps = Math.max(1, Math.ceil(dt / (1 / 120))), step = dt / steps
    for (let i = 0; i < steps; i++) {
      rAdvance(s.morph, this.morphSpeed, 1, step)
      if (this.spin) rAdvance(this.spin, 6.2, 1, step)
      rAdvance(s.roll, 5, .9, step); rAdvance(s.x, 3.5, 1, step); rAdvance(s.y, 4, 1, step)
      rAdvance(s.sy, 10, .8, step); rAdvance(s.lid, 26, 1, step); rAdvance(s.eye, 9, .85, step)
      rAdvance(s.gx, 13, 1, step); rAdvance(s.gy, 13, 1, step)
    }
    this.turn = this.spin?.x ?? wildAngle
    if (this.spin && Math.abs(this.spin.t - this.spin.x) < .004 && Math.abs(this.spin.v) < .015) { this.spin = null; this.turn = wildAngle }
    if (this.spin) this.spinAngle = this.spin.x
    else if (wildAngle !== null) this.spinAngle = wildAngle
    this.updateRibbons(t, dt, !!this.wild)
    return this.snapshot()
  }

  updateRibbons(t, dt, wide) {
    let delta = this.spinAngle - this.previousSpin
    if (!Number.isFinite(delta) || Math.abs(delta) > 1.2) delta = 0
    this.previousSpin = this.spinAngle
    const wasMoving = Math.abs(this.velocity) >= .9
    this.velocity = dt > 0 ? delta / dt : 0
    const moving = Math.abs(this.velocity) >= .9
    if (!wasMoving && moving) {
      const count = wide ? 3 : 1, roll = this.range(-.85, .85)
      this.planes = Array.from({ length: count }, (_, i) => ({ tilt: this.range(.16, .5), roll: roll + i * Math.PI / count + this.range(-.12, .12) }))
      this.count = count > 1 ? 3 * count : Math.round(this.range(3, 5))
      this.hue = this.range(0, 360); this.emitted = false
    }
    if (wasMoving && !moving) this.pending = []
    if (!this.emitted && Math.abs(this.velocity) >= 5) {
      this.emitted = true
      this.pending = Array.from({ length: this.count }, (_, i) => ({ at: t + i * this.range(55, 105), i }))
    }
    while (this.pending.length && t >= this.pending[0].at) {
      const { i } = this.pending.shift(), plane = this.planes[i % this.planes.length]
      const longitude = this.spinAngle - this.range(0, .18)
      const radius = this.count <= 3 ? this.range(8, 10.5) : this.count === 4 ? this.range(6.6, 8.6) : this.range(5.6, 7.4)
      this.range(0, 360); this.range(-240, 240); this.random() // particle rotation and fallback colour
      this.particles.push({
        id: this.nextId++, life: 0, retire: 0, radius,
        hue: this.hue + 360 * i / this.count + this.range(-14, 14),
        hueSpan: this.range(45, 95) * (this.random() < .5 ? 1 : -1),
        hueVelocity: this.range(18, 42) * (this.random() < .5 ? 1 : -1),
        orbit: {
          lam: longitude, lamVel: (Math.sign(this.velocity) || 1) * this.range(.5, 1.1),
          tilt: plane.tilt + this.range(-.04, .04), roll: plane.roll + this.range(-.05, .05),
          rad: 116 * (114.26 / RC) + Math.floor(i / this.planes.length) * (38 / Math.max(Math.ceil(this.count / this.planes.length) - 1, 1)) + this.range(-1.5, 1.5),
          radVel: this.range(0, 2.5), follow: this.range(.74, .94), carry: 0, arc: this.range(2.2, 3.4),
        }, history: [],
      })
    }
    for (const p of this.particles) {
      p.life += dt
      p.retire = rClamp(p.retire + ((!moving || p.life / 9 > .55) ? dt / .5 : -dt / .35))
      const o = p.orbit
      if (moving) { o.carry = this.velocity * o.follow; o.lam += delta * o.follow + o.lamVel * dt }
      else { o.lam += (o.carry + o.lamVel) * dt; o.carry *= Math.exp(-2.6 * dt); o.lamVel *= Math.exp(-2.6 * dt) }
      o.rad += o.radVel * dt
      const history = p.history, prev = history.length ? history[history.length - 1].l : o.lam
      const count = Math.min(Math.ceil(Math.abs(o.lam - prev) / .09), 24)
      for (let i = 1; i <= count; i++) history.push(rPoint(o, prev + (o.lam - prev) * i / count))
      if (!history.length) history.push(rPoint(o, o.lam))
      const arc = o.arc * (1 - rSmooth(p.retire))
      while (history.length > 2 && Math.abs(o.lam - history[0].l) > arc) history.shift()
      const excess = Math.abs(o.lam - history[0].l) - arc
      if (history.length >= 2 && excess > 0) history[0] = rPoint(o, history[0].l + Math.sign(o.lam - history[0].l) * excess)
      if (history.length > 48) history.splice(0, history.length - 48)
    }
    this.particles = this.particles.filter(p => p.retire < 1)
  }

  snapshot() {
    const s = this.s, tune = this.working ? { size: 1, gap: 1, width: 1.2, height: 1.16 } : { size: .74, gap: 1.18, width: .84, height: .84 }
    const rings = this.from.map((ring, i) => rMorph(ring, this.to[i], s.morph.x))
    const centers = rings.map(rCenter)
    const halfWidths = rings.map((ring, i) => Math.max(...ring.map(p => Math.abs(p[0] - centers[i][0]))))
    const eyeLimit = halfWidths[0] + halfWidths[1] > .5 ? rClamp((Math.abs(centers[1][0] - centers[0][0]) * tune.gap - 5) / (halfWidths[0] + halfWidths[1]), .35, 4) : 4
    const pulse = 1 + .07 * Math.sin(rClamp(s.morph.x) * Math.PI)
    const eyeScale = Math.min(rClamp(s.eye.x, .2, 2) * tune.size, eyeLimit / pulse)
    const projected = rings.map((ring, i) => {
      const [cx, cy] = centers[i]
      let eye = ring
      const lid = Math.max(s.lid.x, .04)
      if (Math.abs(lid - 1) > .001) {
        let xx = 0, yy = 0, xy = 0
        for (const [x, y] of ring) { xx += (x - cx) ** 2; yy += (y - cy) ** 2; xy += (x - cx) * (y - cy) }
        const anisotropy = Math.hypot(xx - yy, 2 * xy) / Math.max(xx + yy, 1e-6)
        const axis = .5 * Math.atan2(2 * xy, xx - yy), blend = rSmooth((anisotropy - .12) / .18)
        let ux = Math.cos(axis), uy = Math.sin(axis)
        if (uy < 0) { ux = -ux; uy = -uy }
        ux *= blend; uy = uy * blend + 1 - blend
        const length = Math.hypot(ux, uy) || 1; ux /= length; uy /= length
        eye = ring.map(([x, y]) => { const d = ((x - cx) * ux + (y - cy) * uy) * (1 - lid); return [x - d * ux, y - d * uy] })
      }
      let offset = (cx - RC) * tune.gap, origin = RC, perspective = 1, visibility = 1
      const y = rClamp(cy, REFERENCE_BLOB.top + 2, REFERENCE_BLOB.bottom - 2)
      if (this.turn !== null) {
        const span = rSpan(y), radius = Math.max((span[1] - span[0]) / 2, 12)
        origin = (span[0] + span[1]) / 2
        const base = Math.asin(rClamp(offset / radius, -1, 1)), angle = base + this.turn, depth = Math.cos(angle)
        if (depth <= .02) return []
        perspective = Math.max(depth, .02) / Math.max(Math.cos(base), .02)
        offset = radius * Math.sin(angle); visibility = rSmooth(depth / .5)
      }
      const scaleX = rClamp(perspective * Math.min(eyeScale * tune.width, eyeLimit / pulse) * pulse, .02, 2.4)
      const scaleY = rClamp(eyeScale * tune.height * pulse, .02, 2.4)
      const gx = 1.4 * Math.sin(.00042 * this.time + i) + .5 * Math.sin(.001 * this.time + 2 * i) + s.gx.x + this.extra.gx
      const gy = .9 * Math.sin(.00058 * this.time + i) + s.gy.x + this.extra.gy
      const py = rClamp(y + gy, REFERENCE_BLOB.top + 21 * scaleY + 2, REFERENCE_BLOB.bottom - 21 * scaleY - 2)
      let lo = -Infinity, hi = Infinity
      for (let k = 0; k < eye.length; k += 2) {
        const [left, right] = rSpan(py + (eye[k][1] - cy) * scaleY), dx = (eye[k][0] - cx) * scaleX
        lo = Math.max(lo, left - dx); hi = Math.min(hi, right - dx)
      }
      const freeX = origin + offset + gx * tune.gap, boundX = lo <= hi ? rClamp(freeX, lo, hi) : (lo + hi) / 2
      const px = boundX + (freeX - boundX) * (1 - visibility)
      // Match the SVG rounding used by the reference, before composing the transform.
      return eye.map(([x, y]) => [rRound(px) + (rRound(x) - rRound(cx)) * rRound(scaleX, 4), rRound(py) + (rRound(y) - rRound(cy)) * rRound(scaleY, 4)])
    })
    return {
      turn: this.turn ?? 0,
      pose: { x: rRound(RC + s.x.x + this.extra.x) - RC, y: rRound(RC + s.y.x + this.extra.y) - RC, roll: rRound(s.roll.x + this.extra.roll), sy: rRound(s.sy.x, 4) },
      eyes: projected,
      ribbons: this.particles.map(p => ({
        id: p.id, points: p.history.map(x => ({ ...x })), life: p.life, retire: p.retire,
        width: p.radius * (.72 + .28 * rClamp(Math.cos(p.orbit.lam) * Math.cos(p.orbit.tilt))) * 1.7 * rSmooth(p.life / .34) * (1 - .72 * p.retire ** 2),
        alpha: Math.min(1, p.life / .26), hue: p.hue + p.hueVelocity * p.life, hueSpan: p.hueSpan,
      })),
    }
  }
}

/** Product repeats an entire authored performance, not a permanently lit ring. */
export const REFERENCE_MOTION = Object.freeze({
  spin: Object.freeze({ cycleMs: 4600, staticMs: 2350 }),
  orbit: Object.freeze({ cycleMs: 6200, staticMs: 1500 }),
})
const referenceTracks = new Map()

function rTrack(motion, index) {
  let track = referenceTracks.get(motion)
  if (!track) {
    const simulation = new ReferenceChoreography(motion === 'spin')
    // The first real frame is after one RAF; a zero-time snapshot is a neutral entry.
    simulation.extra = { x: 0, y: 0, roll: 0, gx: 0, gy: 0 }; simulation.turn = null
    track = { simulation, frames: [simulation.snapshot()] }
    referenceTracks.set(motion, track)
  }
  while (track.frames.length <= index) track.frames.push(track.simulation.step(track.frames.length * RSTEP))
  return track.frames[index]
}

/** Native output for independent reference-oracle tests (not a seventh state). */
export function sampleReferenceMotion(motion, timeMs, size = 128, loop = true) {
  const spec = REFERENCE_MOTION[motion] || REFERENCE_MOTION.spin
  const t = loop ? Math.max(0, timeMs) % spec.cycleMs : Math.max(0, Math.min(timeMs, spec.cycleMs))
  const index = Math.floor(t / RSTEP + 1e-7), fraction = rClamp(t / RSTEP - index)
  const a = rTrack(motion, index), b = rTrack(motion, Math.min(index + 1, Math.ceil(spec.cycleMs / RSTEP)))
  const lerp = (x, y) => x + (y - x) * fraction
  const pose = Object.fromEntries(Object.keys(a.pose).map(k => [k, lerp(a.pose[k], b.pose[k])]))
  const eyes = a.eyes.map((ring, i) => ring.length === b.eyes[i].length ? ring.map((p, j) => p.map((v, k) => lerp(v, b.eyes[i][j][k]))) : (fraction < .5 ? ring : b.eyes[i]).map(p => [...p]))
  // Source uses a shared 500ms small-size measurement; all visible mature ribbons
  // start after it. Preserve its cap rather than inventing an arbitrary stroke width.
  const boost = t < 500 ? 1 : rClamp((340 / size) ** .7, 1, 2.6)
  const ribbons = a.ribbons.map(r => ({ ...r, width: Math.max(r.width * boost, .5), points: r.points.map(p => ({ ...p })) }))
  // A short, effect-free end bridge closes the product loop. The source performance
  // itself (including the full spin and ribbon retirement) is not time-warped.
  const bridge = rSmooth((t - (spec.cycleMs - 200)) / 200)
  if (loop && bridge > 0) {
    const home = rTrack(motion, 0)
    for (const k of Object.keys(pose)) {
      const target = k === 'roll' ? Math.round(pose.roll / 360) * 360 : home.pose[k]
      pose[k] += (target - pose[k]) * bridge
    }
    for (let i = 0; i < eyes.length; i++) if (eyes[i].length === home.eyes[i].length) eyes[i] = eyes[i].map((p, j) => p.map((v, k) => v + (home.eyes[i][j][k] - v) * bridge))
  }
  return { time: t, pose, eyes, ribbons, turn: lerp(a.turn, b.turn) }
}

export const REFERENCE_SCALE = RQ
export const REFERENCE_BODY_PATH = REFERENCE_BLOB.path.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, n => String(rRound(RC + (Number(n) - RC) * RQ, 5)))
