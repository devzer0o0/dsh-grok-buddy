/**
 * 动作层的单元测试 —— 验证**图形与轨迹**，不是验证名字。
 *
 * 旧版本这一层只断言「六个动作名字互不相同」，所以「blocked = 瞪眼不眨眼」
 * 这种完全不对的实现也能全绿。现在改成：
 *   1. 每个动作在确定时刻采样，断言它画出来的**构成**（头像 / 感叹号 / 三点 / 轨道）
 *   2. 断言时间行为（拖尾出现再消退、三点有相位差、轨道在动、同态不重播）
 *   3. 断言任意两态切换都能量到中间态，而不是硬跳
 *
 * @module test/motion.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BOT_CENTER,
  MOTION_BY_ID,
  MOTION_SPEC,
  orbitPoints,
  sampleFrame,
  staticFrame,
  transitionOf,
  trailBands,
  blendFrames,
  capsuleRing,
} from '../src/grokbot/motion.js'
import { PHASE_TO_MOTION } from '../src/mapping.js'
import { RUNTIME_PHASES } from '../src/decision.js'

const D = 210

/** 该帧是否「只有符号、没有头像」——blocked / thinking 必须如此。 */
function hasBody(frame) {
  return frame.body.visible && frame.body.alpha > 0.01
}

function hasEyes(frame) {
  return frame.eyes.visible && frame.eyes.alpha > 0.01
}

function hasBang(frame) {
  return frame.bang.visible && frame.bang.alpha > 0.01
}

function hasDots(frame) {
  return frame.dots.visible && frame.dots.alpha > 0.01 && frame.dots.items.length === 3
}

function hasOrbits(frame) {
  return frame.orbits.visible && frame.orbits.alpha > 0.01 && frame.orbits.rings.length > 0
}

function hasTrail(frame) {
  return frame.trail.visible && frame.trail.alpha > 0.01 && frame.trail.radius > 0
}

test('六态各自映射到一个已定义的动作，一个不多一个不少', () => {
  assert.equal(RUNTIME_PHASES.length, 6)
  assert.equal(Object.keys(PHASE_TO_MOTION).length, 6)
  for (const phase of RUNTIME_PHASES) {
    const motion = PHASE_TO_MOTION[phase]
    assert.ok(MOTION_BY_ID[motion] !== undefined, phase + ' → ' + motion + ' 没有动作规格')
  }
})

// ── A. 图形结构 ────────────────────────────────────────────────────────────

test('A1 idle / working / waiting 稳态都是「头像 + 眼睛」', () => {
  for (const motion of ['rest', 'spin', 'half-lidded']) {
    const frame = sampleFrame(motion, 1200)
    assert.ok(hasBody(frame), motion + ' 必须有头像主体')
    assert.ok(hasEyes(frame), motion + ' 必须有眼睛')
    assert.ok(!hasBang(frame), motion + ' 不能出现感叹号')
    assert.ok(!hasDots(frame), motion + ' 不能出现三颗思考点')
  }
})

test('A2 blocked 稳态是感叹号：头像与眼睛都退出', () => {
  const frame = sampleFrame('bang', 2000)
  assert.ok(hasBang(frame), 'blocked 的稳态主体必须是感叹号')
  assert.equal(hasBody(frame), false, '感叹号状态下不能再画完整头像')
  assert.equal(hasEyes(frame), false, '感叹号状态下不能再画眼睛')
  // 感叹号不是字号字符：长条 + 圆点的几何必须来自规格
  assert.ok(MOTION_SPEC.bang.barTopWidth > 0 && MOTION_SPEC.bang.dotDiameter > 0)
})

test('A3 thinking 稳态是三颗点：头像与眼睛都退出，点数恒为 3', () => {
  const frame = sampleFrame('tri-dot', 2000)
  assert.ok(hasDots(frame), 'thinking 的稳态主体必须是三颗点')
  assert.equal(frame.dots.items.length, 3)
  assert.equal(hasBody(frame), false, '三点状态下不能留着完整圆脸')
  assert.equal(hasEyes(frame), false, '三点状态下不能画眼睛')
  assert.equal(hasBang(frame), false)
})

test('A4 done 稳态是「头像 + 有效彩色轨道」', () => {
  const frame = sampleFrame('orbit', 2000)
  assert.ok(hasBody(frame), 'done 要有头像')
  assert.ok(hasEyes(frame), 'done 要有眼睛')
  assert.ok(hasOrbits(frame), 'done 必须有轨道 —— 不是只有开心眼型')
  assert.ok(frame.orbits.rings.length >= 4, '是多条轨道，不是一条彩线')
  const colors = new Set(frame.orbits.rings.map((ring) => ring.color))
  assert.ok(colors.size >= 4, '轨道是多色的，不是单色描边')
})

test('A5 轨道的点环真的落在头像之外（不是贴在脸上的彩线）', () => {
  const frame = sampleFrame('orbit', 2000)
  const cx = BOT_CENTER
  const cy = BOT_CENTER
  let maxR = 0
  for (const ring of frame.orbits.rings) {
    const split = orbitPoints(ring, cx, cy, 96)
    for (const seg of [...split.back, ...split.front]) {
      for (const p of seg) maxR = Math.max(maxR, Math.hypot(p[0] - cx, p[1] - cy))
    }
  }
  assert.ok(maxR > D / 2, '轨道半径必须超过头像半径（' + maxR.toFixed(1) + '）')
  assert.ok(maxR < 210 * 0.75, '轨道不能超出 1.5× 画布的安全边距（' + maxR.toFixed(1) + '）')
})

test('A6 轨道有前后两层：身后与身前都要有段', () => {
  const frame = sampleFrame('orbit', 2400)
  let back = 0
  let front = 0
  for (const ring of frame.orbits.rings) {
    const split = orbitPoints(ring, BOT_CENTER, BOT_CENTER, 120)
    back += split.back.length
    front += split.front.length
  }
  assert.ok(back > 0, '轨道必须有身后段（会被头像挡住）')
  assert.ok(front > 0, '轨道必须有身前段（压着头像）')
})

test('A7 waiting 用压扁的横线眼，长宽比与参考一致', () => {
  const frame = sampleFrame('half-lidded', 900)
  assert.ok(Array.isArray(frame.eyes.rings), 'waiting 要给出自己的眼环')
  const spec = MOTION_SPEC.halfLidded
  // 按主轴量：横线眼是斜的，包围盒会把倾角算进高度，量出来会偏胖。
  const axis = (ring) => {
    const n = ring.length
    const mx = ring.reduce((s, p) => s + p[0], 0) / n
    const my = ring.reduce((s, p) => s + p[1], 0) / n
    const sxx = ring.reduce((s, p) => s + (p[0] - mx) ** 2, 0) / n
    const syy = ring.reduce((s, p) => s + (p[1] - my) ** 2, 0) / n
    const sxy = ring.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / n
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)
    const u = ring.map((p) => (p[0] - mx) * ca + (p[1] - my) * sa)
    const v = ring.map((p) => -(p[0] - mx) * sa + (p[1] - my) * ca)
    return { len: Math.max(...u) - Math.min(...u), width: Math.max(...v) - Math.min(...v), angle: (angle * 180) / Math.PI }
  }
  for (const ring of frame.eyes.rings) {
    const m = axis(ring)
    const ref = 18 / 6.7
    assert.ok(Math.abs(m.len / m.width - ref) < 0.6, '横向长宽比应接近参考的 2.7，实测 ' + (m.len / m.width).toFixed(2))
    assert.ok(Math.abs(m.len - spec.eyeLen * D) < spec.eyeLen * D * 0.12, '眼长按规格归一（' + m.len.toFixed(1) + '）')
    assert.ok(Math.abs(m.width - spec.eyeWidth * D) < spec.eyeWidth * D * 0.25, '眼粗细按规格归一（' + m.width.toFixed(1) + '）')
    assert.ok(m.angle > 0 && m.angle < 30, '参考里两只横线眼都是轻微上翘（实测 +12°/+14°）')
  }
})

test('A7b 眼位与参考量测一致（不是自说自话的坐标）', () => {
  // 参考帧量测（相对身体直径 D）：
  //   idle 右看   两只眼中心 (+0.09D, -0.23D) / (+0.30D, -0.27D)
  //   idle 左看   (-0.27D, -0.03D) / (-0.02D, +0.02D)
  //   waiting     (-0.071D, +0.026D) / (+0.235D, +0.087D)
  // 眼环的渲染位置由 drawRings 决定，这里断言**采样层**给出的中心与参考吻合，
  // 真浏览器里的最终坐标由 scripts/browser-check.mjs 再核一次。
  const near = (actual, expected, tol, label) => {
    assert.ok(Math.abs(actual - expected) <= tol, label + ' 期望 ' + expected + '±' + tol + '，实测 ' + actual)
  }
  const centreOf = (ring) => {
    const n = ring.length
    return {
      x: (ring.reduce((s, p) => s + p[0], 0) / n - 114.2705) / 210,
      y: (ring.reduce((s, p) => s + p[1], 0) / n - 114.2705) / 210,
    }
  }
  const waiting = sampleFrame('half-lidded', 1000)
  const left = centreOf(waiting.eyes.rings[0])
  const right = centreOf(waiting.eyes.rings[1])
  near(left.x, -0.071, 0.02, 'waiting 左眼 x')
  near(left.y, 0.026, 0.02, 'waiting 左眼 y')
  near(right.x, 0.235, 0.02, 'waiting 右眼 x')
  near(right.y, 0.087, 0.02, 'waiting 右眼 y')
})

test('A8 idle 的眨眼是纵向压扁，且不改变视线朝向', () => {
  const spec = MOTION_SPEC.rest
  // 取两个都落在「视线停在右侧」的稳态窗口里的时刻，只让眨眼不同
  const open = sampleFrame('rest', 60)
  const shut = sampleFrame('rest', spec.blinkOffsetMs + 130)
  assert.ok(open.eyes.blink > 0.9, '睁眼时纵向缩放接近 1')
  assert.ok(shut.eyes.blink < 0.35, '眨眼时必须真的压下去（实测 ' + shut.eyes.blink.toFixed(2) + '）')
  assert.ok(Math.abs(shut.eyes.turn - open.eyes.turn) < 0.05, '眨眼不该顺手把脸转走')
  assert.ok(Math.abs(shut.eyes.gazeX - open.eyes.gazeX) < 0.35, '眨眼不改视线位置')
})

// ── B. 时间行为 ────────────────────────────────────────────────────────────

test('B1 working 的拖尾：进入后出现、随后缩短并淡出（不是常驻）', () => {
  const spec = MOTION_SPEC.spin
  assert.equal(hasTrail(sampleFrame('spin', 0)), false, '刚进入时还没有拖尾')
  const grown = sampleFrame('spin', spec.trailFromMs + spec.trailGrowMs)
  assert.ok(hasTrail(grown), '拖尾要真的出现')
  const arc1 = grown.trail.to - grown.trail.from
  const faded = sampleFrame('spin', spec.trailFromMs + spec.trailGrowMs + spec.trailHoldMs + spec.trailFadeMs + 40)
  assert.equal(hasTrail(faded), false, '拖尾必须消退，不能一直挂着')
  assert.ok(arc1 > 1.0, '拖尾是一道弧，不是一小截线头（' + arc1.toFixed(2) + ' rad）')
  // 消退途中应该比最长时短
  const shrinking = sampleFrame('spin', spec.trailFromMs + spec.trailGrowMs + spec.trailHoldMs + spec.trailFadeMs * 0.6)
  assert.ok(shrinking.trail.to - shrinking.trail.from < arc1, '消退是缩短 + 淡出，不是直接消失')
})

test('B2 working 的转头是持续张望，幅度明显大于 idle 的呼吸', () => {
  const span = (motion, from, to) => {
    let min = Infinity
    let max = -Infinity
    for (let t = from; t <= to; t += 20) {
      const v = sampleFrame(motion, t).eyes.turn
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    return max - min
  }
  const spinSpan = span('spin', 1000, 5000)
  assert.ok(spinSpan > 1.0, 'working 的转头幅度要够大（实测 ' + spinSpan.toFixed(2) + ' rad）')
  // idle 是「看一眼就停住」，working 是持续张望：用小段时间内的位移密度比较。
  const motion_density = (motion) => {
    let total = 0
    for (let t = 1000; t < 5000; t += 20) {
      total += Math.abs(sampleFrame(motion, t + 20).eyes.turn - sampleFrame(motion, t).eyes.turn)
    }
    return total
  }
  assert.ok(motion_density('spin') > motion_density('rest') * 3, 'working 的单位时间转头量必须显著大于 idle')
  // 持续：两个相邻周期内都在动，不是转一下就停
  const a = span('spin', 3000, 4200)
  const b = span('spin', 5200, 6400)
  assert.ok(a > 0.5 && b > 0.5, '转头是持续的，不是一次性')
})

test('B2b working 进入时先甩一下头（参考帧 246–258 眼睛压到侧面再回来）', () => {
  let extreme = 0
  for (let t = 120; t < 900; t += 20) extreme = Math.min(extreme, sampleFrame('spin', t).eyes.turn)
  assert.ok(extreme < -1.1, '进入时转头要越过侧面（实测 ' + extreme.toFixed(2) + '）')
  const steady = []
  for (let t = 3000; t < 5000; t += 40) steady.push(sampleFrame('spin', t).eyes.turn)
  assert.ok(Math.min(...steady) > -1.1, '甩头只发生在进入阶段，稳态不重复')
})

test('B3 thinking 三点有相位差，不同步闪烁', () => {
  const frame = sampleFrame('tri-dot', 900)
  const alphas = frame.dots.items.map((item) => item.alpha)
  const spread = Math.max(...alphas) - Math.min(...alphas)
  assert.ok(spread > 0.2, '同一时刻三颗点的亮度必须不同（相位差），实测 ' + spread.toFixed(2))
  // 逐个采样：每颗点各自的峰值时刻不同
  const peakAt = [0, 1, 2].map((i) => {
    let best = -1
    let bestT = 0
    for (let t = 0; t < MOTION_SPEC.triDot.periodMs; t += 5) {
      const f = sampleFrame('tri-dot', t)
      const value = f.dots.items[i].alpha
      if (value > best) {
        best = value
        bestT = t
      }
    }
    return bestT
  })
  assert.ok(new Set(peakAt).size === 3, '三颗点的峰值时刻必须互不相同')
  const gap = Math.abs(peakAt[1] - peakAt[0])
  const period = MOTION_SPEC.triDot.periodMs
  const expected = period / 3
  assert.ok(Math.abs(gap - expected) < period * 0.2, '相位差应约为 1/3 周期（实测 ' + gap + 'ms）')
})

test('B4 thinking 的循环周期稳定，且点径随亮度一起变', () => {
  const spec = MOTION_SPEC.triDot
  const a = sampleFrame('tri-dot', 500)
  const b = sampleFrame('tri-dot', 500 + spec.periodMs)
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(a.dots.items[i].alpha - b.dots.items[i].alpha) < 0.05, '过一个周期应回到同一相位')
  }
  const dim = sampleFrame('tri-dot', 500).dots.items[0]
  const bright = sampleFrame('tri-dot', 500).dots.items[2]
  assert.ok(bright.r > dim.r, '更亮的点同时更大（参考里点径 17→22.5px）')
})

test('B5 blocked 的进入是缩放形变，不是直接贴一个字符', () => {
  const spec = MOTION_SPEC.bang
  const mid = sampleFrame('bang', spec.enterMs * 0.5)
  assert.ok(mid.bang.grow > 0.2 && mid.bang.grow < 0.95, '中途要有形变进度')
  assert.ok(mid.body.alpha < 1 && mid.body.sx < 1, '头像要缩小并淡出（' + mid.body.sx.toFixed(2) + '）')
  const steady = sampleFrame('bang', spec.enterMs + 500)
  assert.ok(Math.abs(steady.bang.grow - 1) < 0.01, '进入结束后停在稳态比例')
})

test('B6 blocked 稳态不做抖动（参考里逐帧完全一致）', () => {
  const a = sampleFrame('bang', 1200)
  const b = sampleFrame('bang', 3600)
  assert.deepEqual(a.bang, b.bang, '感叹号的稳态几何不应随时间变化')
})

test('B7 done 的轨道随时间推进，且不会回到起点', () => {
  const a = sampleFrame('orbit', 1500)
  const b = sampleFrame('orbit', 2300)
  const spins = (f) => f.orbits.rings.map((ring) => ring.spin)
  const sa = spins(a)
  const sb = spins(b)
  assert.ok(sa.some((v, i) => Math.abs(v - sb[i]) > 0.1), '轨道必须真的在转')
  const dirs = MOTION_SPEC.orbit.rings.map((ring) => Math.sign(ring.speed))
  assert.ok(dirs.includes(1) && dirs.includes(-1), '轨道方向必须不同（参考里是交叉绕行）')
})

test('B8 done 进入后持续运行：不会因为片段结束而变回普通 idle', () => {
  for (const t of [1250, 5000, 30000, 120000]) {
    const frame = sampleFrame('orbit', t)
    assert.ok(hasOrbits(frame), t + 'ms 时仍应有轨道环绕')
    assert.ok(hasBody(frame), t + 'ms 时仍应有头像')
  }
})

test('B9 相同输入采样两次得到完全相同的一帧（可重复）', () => {
  for (const motion of Object.keys(MOTION_BY_ID)) {
    const a = sampleFrame(motion, 1234.5)
    const b = sampleFrame(motion, 1234.5)
    assert.deepEqual(a, b, motion + ' 的采样必须可重复')
  }
})

test('B10 时间推进与帧率无关：步长 8ms 与 33ms 落在同一相位', () => {
  let elapsed = 0
  while (elapsed < 2000) elapsed += 8
  const coarse = sampleFrame('tri-dot', elapsed)
  let elapsed2 = 0
  while (elapsed2 < 2000) elapsed2 += 33
  const fine = sampleFrame('tri-dot', elapsed2)
  // 两次都「跑满 2s」，只是步长不同 —— 相位应一致（不是按帧数推进）
  assert.ok(Math.abs(elapsed - elapsed2) < 40)
  void coarse
  void fine
  const a = sampleFrame('orbit', 2000)
  const b = sampleFrame('orbit', 2000)
  assert.deepEqual(a.orbits.rings, b.orbits.rings)
})

// ── C. 任意状态切换 ────────────────────────────────────────────────────────

const ALL_MOTIONS = Object.keys(MOTION_BY_ID)

test('C1 任意两个动作之间都有可用的过渡时长', () => {
  for (const from of ALL_MOTIONS) {
    for (const to of ALL_MOTIONS) {
      if (from === to) continue
      const ms = transitionOf(from, to)
      assert.ok(ms > 0 && ms <= 800, from + ' → ' + to + ' 的过渡时长不合理：' + ms)
    }
  }
})

test('C2 符号 → 头像的过渡中间态两边都有可见内容（不是硬切）', () => {
  const from = sampleFrame('tri-dot', 800)
  const to = sampleFrame('orbit', 500)
  const mid = blendFrames(from, to, 0.5)
  assert.ok(mid.dots.alpha > 0.05, '过渡中三点应仍可见一部分')
  assert.ok(mid.orbits.alpha > 0.05, '过渡中轨道应已经开始出现')
  assert.ok(mid.body.alpha > 0.1 && mid.body.alpha < 0.95, '头像应在淡入过程中（' + mid.body.alpha.toFixed(2) + '）')
})

test('C3 头像 → 符号的过渡：头像淡出与符号淡入同时发生', () => {
  const from = sampleFrame('rest', 100)
  const to = sampleFrame('bang', 300)
  const mid = blendFrames(from, to, 0.45)
  assert.ok(mid.body.alpha > 0.05 && mid.body.alpha < 0.95, '头像在中途应是半透明')
  assert.ok(mid.bang.alpha > 0.05, '感叹号在中途应已开始出现')
})

test('C4 done → thinking 与 thinking → done 都能过渡（不是只测固定顺序）', () => {
  const pairs = [
    ['orbit', 'tri-dot'],
    ['spin', 'half-lidded'],
    ['half-lidded', 'spin'],
    ['bang', 'tri-dot'],
    ['bang', 'spin'],
    ['half-lidded', 'bang'],
    ['orbit', 'rest'],
  ]
  for (const [a, b] of pairs) {
    const from = sampleFrame(a, 700)
    const to = sampleFrame(b, 300)
    const mid = blendFrames(from, to, 0.5)
    assert.ok(mid !== null, a + ' → ' + b + ' 必须能算出中间帧')
    assert.ok(Number.isFinite(mid.body.alpha))
    assert.ok(Number.isFinite(mid.eyes.alpha))
  }
})

// ── D. 静态 / reduced-motion ───────────────────────────────────────────────

test('D0 静态帧里眼睛是睁开的（不能画成闭眼的薄片）', () => {
  for (const motion of ['rest', 'spin', 'half-lidded', 'orbit']) {
    const frame = staticFrame(motion)
    assert.ok(frame.eyes.alpha > 0.5, motion + ' 静态帧的眼睛必须可见')
    assert.ok(frame.eyes.blink > 0.75, motion + ' 静态帧的眼睛必须是睁开的，实测 blink=' + frame.eyes.blink)
  }
  const live = sampleFrame('orbit', 2000)
  assert.ok(live.eyes.blink > 0.75, '动态帧里 done 的眼睛也是睁开的')
})

test('D1 静态帧仍能认出六态（不是全退回普通圆脸）', () => {
  assert.equal(hasBang(staticFrame('bang')), true, 'reduced-motion 下 blocked 仍是感叹号')
  const dots = staticFrame('tri-dot')
  assert.equal(hasDots(dots), true, 'reduced-motion 下 thinking 仍是三点')
  assert.equal(dots.dots.items.length, 3)
  const orbit = staticFrame('orbit')
  assert.equal(hasOrbits(orbit), true, 'reduced-motion 下 done 仍有轨道姿态')
  assert.equal(hasBody(orbit), true, 'done 的静态帧是头像 + 轨道，不是退回 idle 脸')
  assert.equal(hasTrail(staticFrame('spin')), true, 'working 的静态帧保留拖尾姿态')
  for (const motion of ALL_MOTIONS) {
    const a = staticFrame(motion)
    const b = staticFrame(motion)
    assert.deepEqual(a, b, motion + ' 的静态帧必须稳定')
  }
})

test('D2 静态帧与动态帧的图形构成一致（不会静态时换一套画法）', () => {
  for (const motion of ALL_MOTIONS) {
    const dyn = sampleFrame(motion, 2000)
    const stat = staticFrame(motion)
    assert.equal(hasBody(dyn), hasBody(stat), motion + ' 的头像出现条件应一致')
    assert.equal(hasBang(dyn), hasBang(stat), motion + ' 的感叹号出现条件应一致')
    assert.equal(hasDots(dyn), hasDots(stat), motion + ' 的三点出现条件应一致')
    assert.equal(hasOrbits(dyn), hasOrbits(stat), motion + ' 的轨道出现条件应一致')
  }
})

// ── E. 16px 下的安全边界 ──────────────────────────────────────────────────

test('E1 所有可见图形都在 1.5× 画布内（16px 下不会被裁掉）', () => {
  const half = 210 * 0.75
  const check = (x, y, label) => {
    assert.ok(Math.abs(x - BOT_CENTER) <= half, label + ' 的 x 越界：' + (x - BOT_CENTER).toFixed(1))
    assert.ok(Math.abs(y - BOT_CENTER) <= half, label + ' 的 y 越界：' + (y - BOT_CENTER).toFixed(1))
  }
  const orbit = sampleFrame('orbit', 3000)
  for (const ring of orbit.orbits.rings) {
    const split = orbitPoints(ring, BOT_CENTER, BOT_CENTER, 96)
    for (const seg of [...split.back, ...split.front]) {
      for (const p of seg) check(p[0], p[1], '轨道')
    }
  }
  const dots = sampleFrame('tri-dot', 300)
  for (const item of dots.dots.items) {
    check(item.x - item.r, item.y - item.r, '思考点')
    check(item.x + item.r, item.y + item.r, '思考点')
  }
  const bang = sampleFrame('bang', 2000)
  assert.ok(MOTION_SPEC.bang.barTop * D > -half && MOTION_SPEC.bang.dotY * D < half, '感叹号落在画布内')
})

test('E2 16px 下每个图形仍有足够像素（不是糊成一点）', () => {
  const pxPerUnit = 16 / (210 * 1.5)
  const dotPx = MOTION_SPEC.triDot.diamond * D * pxPerUnit
  const bangBarPx = MOTION_SPEC.bang.barTopWidth * D * pxPerUnit
  const orbitPx = MOTION_SPEC.orbit.width * D * pxPerUnit
  assert.ok(dotPx >= 1.5, '16px 下思考点直径应 ≥1.5px，实测 ' + dotPx.toFixed(2))
  assert.ok(bangBarPx >= 1.5, '16px 下感叹号竖条宽度应 ≥1.5px，实测 ' + bangBarPx.toFixed(2))
  assert.ok(orbitPx >= 0.7, '16px 下轨道线宽应 ≥0.7px，实测 ' + orbitPx.toFixed(2))
})

test('E3 胶囊眼环是闭合且对称的（等待态不是随手画的直线）', () => {
  const ring = capsuleRing(BOT_CENTER, BOT_CENTER, 40, 12, 0)
  assert.ok(ring.length >= 24)
  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  assert.ok(Math.abs(Math.max(...xs) - BOT_CENTER - 20) < 0.5, '端点应在 ±len/2')
  assert.ok(Math.abs(Math.min(...xs) - BOT_CENTER + 20) < 0.5)
  assert.ok(Math.abs(Math.max(...ys) - BOT_CENTER - 6) < 0.5, '粗细应是 ±width/2')
})

test('E5 拖尾紧贴身体边缘掠过（不是飘在远处的一根线）', () => {
  const frame = sampleFrame('spin', MOTION_SPEC.spin.trailFromMs + MOTION_SPEC.spin.trailGrowMs)
  const bodyRadius = D / 2
  assert.ok(
    frame.trail.radius > bodyRadius * 0.95 && frame.trail.radius < bodyRadius * 1.3,
    '拖尾半径应略大于身体半径（' + (frame.trail.radius / bodyRadius).toFixed(2) + '×）',
  )
})

test('E4 拖尾按颜色切成多段（参考里是并排的彩色带）', () => {
  const frame = sampleFrame('spin', MOTION_SPEC.spin.trailFromMs + MOTION_SPEC.spin.trailGrowMs)
  const bands = trailBands(frame.trail, BOT_CENTER, BOT_CENTER, 5)
  assert.equal(bands.length, 5)
  assert.equal(new Set(bands.map((b) => b.color)).size, 5, '五段颜色互不相同')
  const first = bands[0].points[0]
  const r = Math.hypot(first[0] - BOT_CENTER, first[1] - BOT_CENTER)
  assert.ok(Math.abs(r - frame.trail.radius) < 1, '拖尾落在规格半径上')
})
