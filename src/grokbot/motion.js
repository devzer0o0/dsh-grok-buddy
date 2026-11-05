import { REFERENCE_MOTION, REFERENCE_SCALE, sampleReferenceMotion } from './reference-motion.js'

/**
 * GrokBot 六态动作规格与采样器 —— **唯一的动画来源**。
 *
 * 这一层回答一个问题：**给定动作 id 和已经跑了多久，这一帧该长什么样**。
 * 它不碰 DOM，不认识业务状态，不读时钟；同样输入永远得到同样的一帧，
 * 所以测试可以冻结、步进、在任意时刻采样，不同刷新率下速度一致。
 *
 * 规格来自用户提供的参考录屏（800×396 / 1397 帧 / 28.26s，SHA-256
 * 57a214b7…4eeb2a），逐帧量测后按「头像直径 D」归一。量测方法、关键帧区间、
 * 已测量与估计参数的区分见 docs/motion-spec.md。
 *
 * 六个动作 id 与六态一一对应，但**不是**同一层：
 *
 *   idle        → rest          安静：呼吸式视线漂移 + 眨眼 + 偶发转头
 *   working     → spin          转身：完整转身 + 单平面渐变开放尾迹
 *   waiting     → half-lidded   等待：上下压扁的横线眼，低活动度
 *   blocked     → bang          阻止：头像收成感叹号（长条 + 圆点）
 *   thinking    → tri-dot       思考：三颗横点依次脉动（相位差 1/3 周期）
 *   done        → orbit         完成：九圈自转/三圈翻滚 + 三平面渐变开放尾迹
 *
 * 坐标：与 src/grokbot/data.js 同一套「身体坐标系」，中心 BOT_CENTER、
 * 身体直径 BOT_D (210)。所有轨迹半径都按 0.001×D 记录，渲染端统一缩放。
 *
 * @module dsh-grok-buddy/motion
 */

/** 身体坐标系（与被移植的素材几何一致）。 */
export const BOT_CENTER = 114.2705
/** 身体直径（身体坐标单位）。 */
export const BOT_D = 210
/** 参考录屏里头像直径（px）—— 量测基准，不进渲染。 */
export const REF_D_PX = 103

/**
 * 参考 px → 身体坐标单位的换算（1 参考 px = 210/103 身体单位）。
 * 参考里量到的长度都先按它换算，再按 D 归一，避免把 800×396 画布当真坐标。
 * @param {number} px 参考录屏里的像素。
 * @returns {number} 身体坐标单位。
 */
export function refPx(px) {
  return (px * BOT_D) / REF_D_PX
}

/** 动作 id（内部动画资源标识，**不是**对外业务状态）。 */
export const MOTION_ID = Object.freeze({
  idle: 'rest',
  working: 'spin',
  waiting: 'half-lidded',
  blocked: 'bang',
  thinking: 'tri-dot',
  done: 'orbit',
})

/** 点径、间距等常用比例（相对 D）。 */
const D = BOT_D

/**
 * 六态动作的**量测参数表**。
 *
 * 每一条都标了来源：`measured` 是逐帧量到的，`estimated` 是参考里没有
 * 直接证据、按观感补齐的（并且写清补的理由）。渲染逻辑只读这张表。
 */
export const MOTION_SPEC = Object.freeze({
  /** 安静：参考 0–5.0s（帧 0–246）。 */
  rest: Object.freeze({
    kind: 'avatar',
    /**
     * 视线/转头周期（量测）：
     *   0.0–2.9s 停在右侧（角 -50°）→ 3.0–4.0s 慢转到左侧（角 -179°）→ 4.0–6.4s 保持，
     *   然后回到右侧。所以是「看一眼、停住、再回来看」，不是正弦摆动。
     */
    lookCycleMs: 6400,
    /**
     * 转头端点（由量测反解）：素材眼环本身在 turn=0 时就落在参考的右侧位置
     * （+0.105D / +0.338D vs 参考 +0.09D / +0.30D），所以右侧端点就是 0；
     * 看左时两只眼要落到参考的 -0.27D / -0.02D，反解得 turn = -0.79。
     */
    turnRight: 0,
    turnLeft: -0.79,
    /** 眨眼：参考帧 0–10 与 240 附近各一次 → 约 4.8s 一次。 */
    blinkPeriodMs: 4800,
    blinkOffsetMs: 200,
    blinkMs: 320,
    /** 微幅呼吸（估计：参考里姿态几乎不动，只留可感知的活气）。 */
    breathTurn: 0.035,
    breathMs: 7300,
    gazeY: 0.8,
  }),

  /** 官方 working：完整转身及单平面渐变尾迹；按完整表演循环，不画常亮光环。 */
  spin: Object.freeze({ kind: 'avatar', ...REFERENCE_MOTION.spin }),

  /** 等待：参考 9.5–13.8s（帧 470–682）。 */
  halfLidded: Object.freeze({
    kind: 'avatar',
    /** 眼睛长宽：参考 18×6.7 px = 0.175D × 0.065D（量测）。 */
    eyeLen: 0.175,
    eyeWidth: 0.065,
    /** 倾角：左眼 +12°、右眼 +14°（量测）。 */
    eyeAngle: 12,
    /** 位置：左 (-0.071D, +0.026D)、右 (+0.235D, +0.087D)（量测）。 */
    left: Object.freeze({ x: -0.071, y: 0.026, angle: 12 }),
    right: Object.freeze({ x: 0.235, y: 0.087, angle: 14 }),
    /** 呼吸：参考 540–660 之间眼位漂移约 1.5px = 0.015D（量测），周期按估计 4.2s。 */
    breathTurn: 0.05,
    breathMs: 4200,
  }),

  /** 阻止：参考 13.8–18.0s（帧 682–888）。 */
  bang: Object.freeze({
    kind: 'symbol',
    /** 形变时长：参考 676–700 = 0.48s（量测）。 */
    enterMs: 480,
    /** 长条：y -0.325D..+0.092D，顶宽 0.146D，底宽 0.05D（量测）。 */
    barTop: -0.325,
    barBottom: 0.092,
    barTopWidth: 0.146,
    barBottomWidth: 0.05,
    /** 圆点：直径 0.121D，中心 +0.253D（量测）。 */
    dotDiameter: 0.121,
    dotY: 0.253,
    /** 稳态：参考 700–880 逐帧完全一致 → 不做任何抖动（量测）。 */
    breathing: 0,
  }),

  /**
   * 思考：参考 18.0–22.7s（帧 888–1121）。
   *
   * ⚠️ 点径、间距、放大倍率与透明度下限是**针对侧栏 16px 的视觉调整**，
   * 不是参考录屏的量测值。量测值（0.165D / 0.272D / 1.0→1.32 / 0.55→1）在
   * 800×396 的参考画布里成立，换算到 16px 图标后单点只有 1.76–2.32 CSS px，
   * 侧栏里几乎看不出三颗点。这里按「小尺寸可读性」放大，量测数据保留在
   * docs/motion-spec.md。周期、相位差、中心线、漂移、进入时长仍是量测值。
   */
  triDot: Object.freeze({
    kind: 'symbol',
    /**
     * 三颗点：直径 0.28D，间距 0.44D（调整值；量测为 0.165D / 0.272D）。
     * 16px 下：点径 3.0–3.6 CSS px，三点整体宽 12.6 px，相邻边缘缝 ≈1.2 px。
     */
    diamond: 0.28,
    gap: 0.44,
    /** 中心线 -0.034D（量测，未调整）。 */
    lineY: -0.034,
    /** 脉动周期：参考帧峰值间隔 69–71 帧 = 1.40s（量测）。 */
    periodMs: 1400,
    /** 相位差：24 帧 = 0.47s ≈ 1/3 周期（量测）。 */
    stagger: 1 / 3,
    /**
     * 亮度 141→255（量测）→ 原样是 0.55→1。下限抬到 0.72（调整值）：
     * 小尺寸下细点的低透明度会直接糊掉，「依次脉动」的节奏还在，但不再消失。
     */
    alphaMin: 0.72,
    alphaMax: 1,
    /** 直径 17→22.5px（量测 1.0→1.32）；调整到 1.0→1.20，避免放大后边界来回跳。 */
    scaleMin: 1,
    scaleMax: 1.2,
    /** 位置：脉动时上下漂移 ±1.5px = ±0.015D（量测，未调整）。 */
    drift: 0.015,
    /** 进入时长（参考 884–900 感叹号摊成三点，量测 0.32s）。 */
    enterMs: 320,
  }),

  /** 官方 celebrate：九圈转头 + 三圈翻滚 + 三平面开放尾迹 + 减速回正。 */
  orbit: Object.freeze({ kind: 'avatar', ...REFERENCE_MOTION.orbit }),
})

/** 动作 id → 规格。 */
export const MOTION_BY_ID = Object.freeze({
  rest: MOTION_SPEC.rest,
  spin: MOTION_SPEC.spin,
  'half-lidded': MOTION_SPEC.halfLidded,
  bang: MOTION_SPEC.bang,
  'tri-dot': MOTION_SPEC.triDot,
  orbit: MOTION_SPEC.orbit,
})

/**
 * 动作切换的过渡时长（毫秒）。
 *
 * 参考里每种进入都有自己的形变时长（量测见上）；这里只补「本来没有进入动作」
 * 的组合，让任意两态互切都不会硬跳。键是 `from>to`。
 */
export const TRANSITION_MS = Object.freeze({
  default: 240,
  'rest>spin': 200,
  'rest>half-lidded': 420,
  'spin>half-lidded': 420,
  'half-lidded>bang': 480,
  'half-lidded>rest': 380,
  'bang>tri-dot': 320,
  'tri-dot>orbit': 420,
  'bang>orbit': 420,
  'tri-dot>rest': 300,
  'orbit>rest': 360,
  'orbit>spin': 260,
  'orbit>half-lidded': 300,
  'orbit>tri-dot': 260,
})

/**
 * 取两个动作之间的过渡时长。
 * @param {string} from 旧动作 id。
 * @param {string} to 新动作 id。
 * @returns {number} 毫秒。
 */
export function transitionOf(from, to) {
  const key = String(from) + '>' + String(to)
  const exact = TRANSITION_MS[key]
  if (typeof exact === 'number') return exact
  return TRANSITION_MS.default
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep(k) {
  const t = clamp(k, 0, 1)
  return t * t * (3 - 2 * t)
}

function easeOut(k) {
  return 1 - Math.pow(1 - clamp(k, 0, 1), 3)
}

/** 三角波：0→1→0。 */
function tri(k) {
  const t = k - Math.floor(k)
  return t < 0.5 ? t * 2 : 2 - t * 2
}

/**
 * idle 的转头曲线：右 → 慢转到左 → 停在左边 → 转回右。
 *
 * 参考帧 0–145 停在右侧（角 -50°），150–200 用约 1s 转到左侧（角 -179°），
 * 之后保持到这一段的末尾。所以不是正弦摆动，而是「看一眼再停住」。
 *
 * @param {number} tMs 本动作已经运行的时间。
 * @param {object} spec rest 规格。
 * @returns {number} 转头弧度。
 */
function idleTurn(tMs, spec) {
  const cycle = spec.lookCycleMs
  const k = (tMs % cycle) / cycle
  const right = spec.turnRight
  const left = spec.turnLeft
  if (k < 0.47) return right
  if (k < 0.63) return right + (left - right) * smoothstep((k - 0.47) / 0.16)
  if (k < 0.90) return left
  return left + (right - left) * smoothstep((k - 0.90) / 0.10)
}

/** 眨眼：0 = 睁眼，1 = 闭到底。 */
function blinkAt(tMs, spec) {
  const cycle = spec.blinkPeriodMs
  const k = ((tMs - spec.blinkOffsetMs) % cycle + cycle) % cycle
  if (k > spec.blinkMs) return 0
  const p = k / spec.blinkMs
  return p < 0.42 ? p / 0.42 : (1 - p) / 0.58
}

/** 空白帧（所有层都不可见）。 */
export function emptyFrame(motion) {
  return {
    motion: typeof motion === 'string' ? motion : '',
    time: 0,
    body: { visible: true, alpha: 1, sx: 1, sy: 1, turn: 0, x: 0, y: 0, roll: 0, reference: false },
    // blink 默认 1 = 完全睁开。静态帧就是靠这个默认值站住的 —— 之前写成 0，
    // 结果 reduced-motion 下六态全是「闭着眼」的薄片。
    eyes: { visible: true, alpha: 1, rings: null, projected: false, turn: 0, gazeX: 0, gazeY: 0, blink: 1, scale: 1 },
    bang: { visible: false, alpha: 0, grow: 0 },
    dots: { visible: false, alpha: 0, items: [] },
    orbits: { visible: false, alpha: 0, scale: 1, rings: [] },
    trail: { visible: false, alpha: 0, rings: [] },
  }
}

/**
 * 胶囊形眼环（等待态的横线眼）。
 *
 * 用多边形点环表示，是为了和素材眼型走**同一条**球面投影与裁剪路径 ——
 * 等待态不能变成另一种渲染通道。
 *
 * @param {number} cx 中心 x（身体坐标）。
 * @param {number} cy 中心 y（身体坐标）。
 * @param {number} len 长度。
 * @param {number} width 粗细。
 * @param {number} angleDeg 倾角（度）。
 * @param {number} [points] 采样点数。
 * @returns {Array<[number, number]>} 点环。
 */
export function capsuleRing(cx, cy, len, width, angleDeg, points) {
  const n = typeof points === 'number' && points >= 12 ? points : 32
  const half = Math.max(len / 2 - width / 2, 0.001)
  const r = width / 2
  const rad = (angleDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const ring = []
  const arcSteps = Math.max(6, Math.floor(n / 2) - 1)
  // 上沿：左端半圆 → 直边 → 右端半圆 → 下沿直边
  for (let i = 0; i <= arcSteps; i++) {
    const a = Math.PI / 2 + (i / arcSteps) * Math.PI
    const x = -half + Math.cos(a) * r
    const y = Math.sin(a) * r
    ring.push([cx + x * cos - y * sin, cy + x * sin + y * cos])
  }
  for (let i = 0; i <= arcSteps; i++) {
    const a = -Math.PI / 2 + (i / arcSteps) * Math.PI
    const x = half + Math.cos(a) * r
    const y = Math.sin(a) * r
    ring.push([cx + x * cos - y * sin, cy + x * sin + y * cos])
  }
  return ring
}

/**
 * 把「相对身体的偏移」换成身体坐标（眼位、符号都用它）。
 * @param {number} fx 相对 D 的 x。
 * @param {number} fy 相对 D 的 y。
 * @returns {{x: number, y: number}} 身体坐标。
 */
export function atOffset(fx, fy) {
  return { x: BOT_CENTER + fx * D, y: BOT_CENTER + fy * D }
}

/**
 * 采样某一动作在某一时刻的一帧。
 *
 * @param {string} motionId 动作 id（MOTION_BY_ID 的键）。
 * @param {number} tMs 该动作已运行的时间（毫秒）。
 * @param {object} [options] 采样选项。
 * @param {boolean} [options.static] 减少动效：返回该动作的代表性静态帧。
 * @param {boolean} [options.referenceTiming] 独立参考比较用原生时间轴；产品 working 默认提前 1500ms 入场。
 * @returns {object} 帧描述（纯数据，可直接断言）。
 */
export function sampleFrame(motionId, tMs, options) {
  const spec = MOTION_BY_ID[motionId] || MOTION_SPEC.rest
  const t = typeof tMs === 'number' && Number.isFinite(tMs) && tMs > 0 ? tMs : 0
  const opts = options !== undefined && options !== null ? options : {}
  const frame = emptyFrame(motionId)
  frame.time = t
  if (opts.static === true) return staticFrame(motionId, options)

  if (spec === MOTION_SPEC.rest) {
    const turn = idleTurn(t, spec) + spec.breathTurn * Math.sin((t / spec.breathMs) * Math.PI * 2)
    frame.body.turn = turn
    frame.eyes.turn = turn
    frame.eyes.blink = 1 - blinkAt(t, spec) * 0.96
    frame.eyes.gazeY = spec.gazeY * Math.sin((t / 5100) * Math.PI * 2)
    frame.eyes.gazeX = 0.6 * Math.sin((t / 4300) * Math.PI * 2)
    return frame
  }

  if (spec === MOTION_SPEC.spin || spec === MOTION_SPEC.orbit) {
    // Only rotate the working loop's entry phase: keep the authored speed/geometry,
    // but don't spend the first 1.5s resting while a short command is already running.
    // Native timing remains explicitly available to independent oracle comparisons.
    const offset = motionId === 'spin' && opts.referenceTiming !== true ? 1500 : 0
    const reference = sampleReferenceMotion(motionId, t + offset, opts.size || 128)
    frame.body.reference = true
    frame.body.x = reference.pose.x * REFERENCE_SCALE
    frame.body.y = reference.pose.y * REFERENCE_SCALE
    frame.body.roll = reference.pose.roll
    frame.body.sy = reference.pose.sy
    frame.eyes.projected = true
    frame.eyes.turn = reference.turn
    frame.eyes.rings = reference.eyes.map(ring => ring.map(([x, y]) => [
      BOT_CENTER + (x - BOT_CENTER) * REFERENCE_SCALE,
      BOT_CENTER + (y - BOT_CENTER) * REFERENCE_SCALE,
    ]))
    const layer = spec === MOTION_SPEC.spin ? frame.trail : frame.orbits
    layer.rings = reference.ribbons
    layer.visible = reference.ribbons.some(r => r.points.length > 1)
    layer.alpha = 1
    return frame
  }

  if (spec === MOTION_SPEC.halfLidded) {
    const turn = spec.breathTurn * Math.sin((t / spec.breathMs) * Math.PI * 2)
    const len = spec.eyeLen * D
    const width = spec.eyeWidth * D
    const left = atOffset(spec.left.x, spec.left.y)
    const right = atOffset(spec.right.x, spec.right.y)
    frame.body.turn = turn
    frame.eyes.turn = turn
    frame.eyes.rings = [
      capsuleRing(left.x, left.y, len, width, spec.left.angle),
      capsuleRing(right.x, right.y, len, width, spec.right.angle),
    ]
    frame.eyes.gazeY = 0.5 * Math.sin((t / spec.breathMs) * Math.PI * 2)
    // 半闭眼也会偶尔合一下（幅度很小，不破坏等待姿态）
    const b = blinkAt(t + 1500, MOTION_SPEC.rest)
    frame.eyes.blink = 1 - b * 0.25
    return frame
  }

  if (spec === MOTION_SPEC.bang) {
    const k = clamp(t / spec.enterMs, 0, 1)
    const grow = easeOut(k)
    frame.body.sx = 1 - 0.93 * grow
    frame.body.sy = 1 - 0.72 * grow
    frame.body.alpha = 1 - smoothstep(clamp(k / 0.72, 0, 1))
    frame.body.visible = frame.body.alpha > 0.01
    frame.eyes.alpha = frame.body.alpha
    frame.eyes.visible = frame.body.visible
    frame.eyes.turn = 0
    frame.eyes.blink = 1 - 0.9 * grow
    frame.bang.visible = k > 0.04
    frame.bang.grow = grow
    frame.bang.alpha = clamp(k / 0.55, 0, 1)
    return frame
  }

  if (spec === MOTION_SPEC.triDot) {
    const k = clamp(t / spec.enterMs, 0, 1)
    const grow = easeOut(k)
    frame.body.visible = false
    frame.body.alpha = 0
    frame.eyes.visible = false
    frame.eyes.alpha = 0
    frame.bang.visible = false
    frame.bang.alpha = 0
    const base = spec.diamond * D
    const gap = spec.gap * D
    const lineY = BOT_CENTER + spec.lineY * D
    /**
     * 进入时的「摊开」是**线性**的（0.35 → 1），不是缓出：
     * 缓出会让前 100ms 就长到 86%，看起来像硬切；线性摊开才像三点从感叹号里推开。
     * 进入结束后 pop ≡ 1，稳态几何只由规格决定。
     */
    const pop = 0.35 + 0.65 * k
    const items = []
    for (let i = 0; i < 3; i++) {
      const phase = (t / spec.periodMs - i * spec.stagger) % 1
      const wave = (Math.sin(((phase + 0.75) % 1) * Math.PI * 2 - Math.PI / 2) + 1) / 2
      const bright = spec.alphaMin + (spec.alphaMax - spec.alphaMin) * wave
      const size = spec.scaleMin + (spec.scaleMax - spec.scaleMin) * wave
      items.push({
        x: BOT_CENTER + (i - 1) * gap,
        // 参考里三颗点各有轻微上下漂移
        y: lineY + spec.drift * D * Math.sin((phase + i * 0.3) * Math.PI * 2),
        r: (base / 2) * size * pop,
        // 进入阶段的淡入只由 dots.alpha（组透明度）负责：这里再乘一次 grow
        // 会把亮度压成平方，进入途中三颗点比稳态暗一大截。
        alpha: bright,
      })
    }
    frame.dots.visible = true
    frame.dots.alpha = grow
    frame.dots.items = items
    return frame
  }

  return frame
}

/**
 * 减少动效 / 静态截图用的代表性姿态。
 *
 * 六态各自保留**能认出是哪一态**的静态构图：blocked 还是感叹号、thinking 还是
 * 三颗点、done 还是头像 + 轨道 —— 只是不再推进时间。
 *
 * @param {string} motionId 动作 id。
 * @returns {object} 帧描述。
 */
export function staticFrame(motionId, options) {
  const frame = emptyFrame(motionId)
  if (motionId === 'rest' || motionId === '') {
    frame.eyes.turn = 0.1
    return frame
  }
  if (motionId === 'spin' || motionId === 'orbit') {
    return sampleFrame(motionId, REFERENCE_MOTION[motionId].staticMs, { size: options?.size || 128, referenceTiming: true })
  }
  if (motionId === 'half-lidded') {
    const len = MOTION_SPEC.halfLidded.eyeLen * D
    const width = MOTION_SPEC.halfLidded.eyeWidth * D
    const left = atOffset(MOTION_SPEC.halfLidded.left.x, MOTION_SPEC.halfLidded.left.y)
    const right = atOffset(MOTION_SPEC.halfLidded.right.x, MOTION_SPEC.halfLidded.right.y)
    frame.eyes.rings = [
      capsuleRing(left.x, left.y, len, width, MOTION_SPEC.halfLidded.left.angle),
      capsuleRing(right.x, right.y, len, width, MOTION_SPEC.halfLidded.right.angle),
    ]
    return frame
  }
  if (motionId === 'bang') {
    frame.body.visible = false
    frame.body.alpha = 0
    frame.eyes.visible = false
    frame.eyes.alpha = 0
    frame.bang.visible = true
    frame.bang.grow = 1
    frame.bang.alpha = 1
    return frame
  }
  if (motionId === 'tri-dot') {
    frame.body.visible = false
    frame.body.alpha = 0
    frame.eyes.visible = false
    frame.eyes.alpha = 0
    const spec = MOTION_SPEC.triDot
    const base = spec.diamond * D
    const gap = spec.gap * D
    const lineY = BOT_CENTER + spec.lineY * D
    /**
     * 静态姿态是「脉动停在某一相位」的定格，不是另画一套几何：
     * 中间那颗取脉动峰值（scaleMax / alphaMax），两侧取同一周期的低谷
     * （scaleMin / alphaMin）。所以静态点径永远落在动态点的区间内，
     * 不会因为旧的 1.25 / 1.05 倍率在放大后顶出画布或糊成一团。
     */
    const rOf = (scale) => (base / 2) * scale
    frame.dots.visible = true
    frame.dots.alpha = 1
    frame.dots.items = [0, 1, 2].map((i) => ({
      x: BOT_CENTER + (i - 1) * gap,
      y: lineY,
      r: rOf(i === 1 ? spec.scaleMax : spec.scaleMin),
      alpha: i === 1 ? spec.alphaMax : spec.alphaMin,
    }))
    return frame
  }
  return frame
}

/**
 * 按进度把两帧插值 —— 状态切换的过渡就靠它。
 *
 * 图形层的插值规则：
 *   · 两边都是头像系（有眼环）→ 眼环逐点插值（保持形变连贯，不是硬切）
 *   · 只有一边有眼环 → 交叉淡出淡入
 *   · 符号层（感叹号 / 三点）→ 进度与透明度插值，进度为 0 就不可见
 *
 * @param {object} from 起始帧。
 * @param {object} to 目标帧。
 * @param {number} k 进度 0..1。
 * @returns {object} 插值后的帧。
 */
export function blendFrames(from, to, k) {
  const p = smoothstep(k)
  const a = from
  const b = to
  const frame = emptyFrame(b.motion)
  frame.time = b.time
  // 一边没有头像（符号态）时，缩放取有头像那一边的，否则「0.18 → 1」会被
  // 平均成 0.6，看起来像从头像中间长出来而不是淡入。
  const scaleFrom = a.body.visible ? a.body : b.body
  const scaleTo = b.body.visible ? b.body : a.body
  frame.body = {
    visible: p < 0.5 ? a.body.visible : b.body.visible,
    alpha: a.body.alpha + (b.body.alpha - a.body.alpha) * p,
    sx: scaleFrom.sx + (scaleTo.sx - scaleFrom.sx) * p,
    sy: scaleFrom.sy + (scaleTo.sy - scaleFrom.sy) * p,
    turn: a.body.turn + (b.body.turn - a.body.turn) * p,
    x: (a.body.x || 0) + ((b.body.x || 0) - (a.body.x || 0)) * p,
    y: (a.body.y || 0) + ((b.body.y || 0) - (a.body.y || 0)) * p,
    roll: (() => { const delta = ((b.body.roll - a.body.roll + 540) % 360 + 360) % 360 - 180; return a.body.roll + delta * p })(),
    reference: p < .5 ? a.body.reference : b.body.reference,
  }
  const bothRings = a.eyes.projected === b.eyes.projected && Array.isArray(a.eyes.rings) && Array.isArray(b.eyes.rings)
  frame.eyes = {
    visible: bothRings ? b.eyes.visible : p < 0.5 ? a.eyes.visible : b.eyes.visible,
    alpha: a.eyes.alpha + (b.eyes.alpha - a.eyes.alpha) * p,
    rings: null,
    projected: p < .5 ? a.eyes.projected : b.eyes.projected,
    turn: a.eyes.turn + (b.eyes.turn - a.eyes.turn) * p,
    gazeX: a.eyes.gazeX + (b.eyes.gazeX - a.eyes.gazeX) * p,
    gazeY: a.eyes.gazeY + (b.eyes.gazeY - a.eyes.gazeY) * p,
    blink: a.eyes.blink + (b.eyes.blink - a.eyes.blink) * p,
    scale: a.eyes.scale + (b.eyes.scale - a.eyes.scale) * p,
  }
  if (bothRings) {
    frame.eyes.rings = [0, 1].map((eye) => {
      const ra = a.eyes.rings[eye]
      const rb = b.eyes.rings[eye]
      if (!Array.isArray(ra) || !Array.isArray(rb) || ra.length !== rb.length) return rb
      return ra.map((pt, i) => [pt[0] + (rb[i][0] - pt[0]) * p, pt[1] + (rb[i][1] - pt[1]) * p])
    })
  } else if (p >= 0.5) {
    frame.eyes.rings = b.eyes.rings
  } else {
    frame.eyes.rings = a.eyes.rings
  }

  const bangAlpha = a.bang.alpha + (b.bang.alpha - a.bang.alpha) * p
  frame.bang = {
    visible: bangAlpha > 0.01,
    alpha: bangAlpha,
    grow: a.bang.grow + (b.bang.grow - a.bang.grow) * p,
  }

  const dotAlpha = a.dots.alpha + (b.dots.alpha - a.dots.alpha) * p
  frame.dots = {
    visible: dotAlpha > 0.01 && (p >= 0.5 ? b.dots.visible : a.dots.visible),
    alpha: dotAlpha,
    // 点自身的透明度已经是「脉动亮度」，进入/退出的淡入由 dots.alpha 负责。
    // 两边再乘一次会把过渡中的可见度压成平方，三点在小尺寸下更看不清。
    items: (p >= 0.5 ? b.dots.items : a.dots.items).map((item) => ({ ...item })),
  }

  const orbitAlpha = a.orbits.alpha + (b.orbits.alpha - a.orbits.alpha) * p
  frame.orbits = {
    visible: orbitAlpha > 0.01,
    alpha: orbitAlpha,
    scale: a.orbits.scale + (b.orbits.scale - a.orbits.scale) * p,
    rings: p >= 0.5 ? b.orbits.rings : a.orbits.rings,
  }

  const trailAlpha = a.trail.alpha + (b.trail.alpha - a.trail.alpha) * p
  const chooseLayer = (left, right) => {
    // Retain the outgoing paths while they fade out; do not drop them at k=.5.
    if (!right.rings.length) return left.rings
    if (!left.rings.length) return right.rings
    return p < .5 ? left.rings : right.rings
  }
  frame.orbits.rings = chooseLayer(a.orbits, b.orbits)
  frame.trail = {
    visible: trailAlpha > .01,
    alpha: trailAlpha,
    rings: chooseLayer(a.trail, b.trail),
  }
  return frame
}

/** 供诊断/测试读取：某一动作是否以头像为主体。 */
export function isAvatarMotion(motionId) {
  const spec = MOTION_BY_ID[motionId]
  return spec !== undefined && spec.kind === 'avatar'
}

export { D as MOTION_UNIT_D, tri as _tri }
