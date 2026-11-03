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
 *   working     → spin          转身：持续转头，进入时有一道短暂彩色拖尾
 *   waiting     → half-lidded   等待：上下压扁的横线眼，低活动度
 *   blocked     → bang          阻止：头像收成感叹号（长条 + 圆点）
 *   thinking    → tri-dot       思考：三颗横点依次脉动（相位差 1/3 周期）
 *   done        → orbit         完成：头像旋转 + 多条彩色轨道前后穿插
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

  /** 转身：参考 5.0–9.5s（帧 246–470）。 */
  spin: Object.freeze({
    kind: 'avatar',
    /**
     * 稳态转头周期（量测）：参考里眼睛从左摆到右再摆回来约 2.2s，
     * 摆幅换算成经度约 -0.55..+0.30 rad（不是整圈自转）。
     */
    spinMs: 2600,
    /** 摆幅与偏置（量测：眼对中点水平位移 -26px..+15px ≈ -0.25D..+0.15D）。 */
    swayAmp: 0.66,
    swayBias: -0.14,
    /**
     * 进入时的「甩头」（估计）：参考帧 246–258 眼睛先压到几乎看不见再回来，
     * 对应转头短暂越过侧面。参考只录到一次，这里按一次动作处理，不循环。
     */
    whipMs: 760,
    whipAmp: -1.85,
    /** 拖尾爆发：参考帧 310–373 = 1.26s（量测）。 */
    trailFromMs: 300,
    trailGrowMs: 420,
    trailHoldMs: 380,
    trailFadeMs: 420,
    /** 拖尾弧长：参考里最长约 150°（量测，帧 330–340）。 */
    trailArc: 1.9,
    /**
     * 拖尾半径：参考彩色像素最远 446 px，中心 388.5 → 57.5 px = 0.56D（量测）。
     * 头像半径是 0.5D，所以拖尾紧贴身体边缘掠过，不是飘在远处。
     */
    trailRadius: 0.55,
    /** 拖尾整条彩带厚度：参考 7–9px = 0.075D（量测，横截面扫描）。 */
    trailWidth: 0.075,
    /** 单条色带的厚度（5 条并排塞进整条厚度里）。 */
    trailBandWidth: 0.03,
    /** 拖尾颜色带：参考里是 5 条并排的彩色带（量测）。 */
    trailColors: Object.freeze(['#7ad8a8', '#7ad87a', '#8a7ad8', '#d87ac0', '#d8b878']),
  }),

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

  /** 思考：参考 18.0–22.7s（帧 888–1121）。 */
  triDot: Object.freeze({
    kind: 'symbol',
    /** 三颗点：直径 0.165D，间距 0.272D，中心线 -0.034D（量测）。 */
    diamond: 0.165,
    gap: 0.272,
    lineY: -0.034,
    /** 脉动周期：参考帧峰值间隔 69–71 帧 = 1.40s（量测）。 */
    periodMs: 1400,
    /** 相位差：24 帧 = 0.47s ≈ 1/3 周期（量测）。 */
    stagger: 1 / 3,
    /** 亮度 141→255（量测）→ 透明度 0.55→1。 */
    alphaMin: 0.55,
    alphaMax: 1,
    /** 直径 17→22.5px（量测）→ 1.0→1.32。 */
    scaleMin: 1,
    scaleMax: 1.32,
    /** 位置：脉动时上下漂移 ±1.5px = ±0.015D（量测）。 */
    drift: 0.015,
    /** 进入时长（参考 884–900 感叹号摊成三点，量测 0.32s）。 */
    enterMs: 320,
  }),

  /** 完成：参考 22.7–26.9s（帧 1121–1330）。 */
  orbit: Object.freeze({
    kind: 'avatar',
    /** 进入：头像从三点长回来（参考 1116–1152，0.72s），轨道随后展开。 */
    enterMs: 420,
    /** 稳态已测：轨道持续转动；半径包络 0.704D（量测）。 */
    radius: 0.60,
    /** 轨道线宽：参考横截面扫描中位数 7px = 0.068D（量测）。 */
    width: 0.068,
    /** 头像自身缓慢旋转（参考里朝向一直在变，量测为连续转动）。 */
    spinMs: 3200,
    rings: Object.freeze([
      Object.freeze({ a: 0.66, b: 0.25, tilt: 0.35, yaw: 0.25, speed: 0.42, color: '#7ad97a', phase: 0.0 }),
      Object.freeze({ a: 0.64, b: 0.30, tilt: -0.55, yaw: 0.15, speed: -0.31, color: '#d9b878', phase: 1.1 }),
      Object.freeze({ a: 0.70, b: 0.20, tilt: 1.15, yaw: 0.05, speed: 0.55, color: '#7ad8b4', phase: 2.3 }),
      Object.freeze({ a: 0.60, b: 0.34, tilt: 0.1, yaw: 0.65, speed: -0.46, color: '#d97a7a', phase: 3.2 }),
      Object.freeze({ a: 0.68, b: 0.24, tilt: -0.95, yaw: -0.35, speed: 0.37, color: '#8a7ad9', phase: 4.4 }),
      Object.freeze({ a: 0.58, b: 0.28, tilt: 0.7, yaw: 0.45, speed: -0.62, color: '#d97ac0', phase: 5.1 }),
    ]),
  }),
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
    body: { visible: true, alpha: 1, sx: 1, sy: 1, turn: 0 },
    // blink 默认 1 = 完全睁开。静态帧就是靠这个默认值站住的 —— 之前写成 0，
    // 结果 reduced-motion 下六态全是「闭着眼」的薄片。
    eyes: { visible: true, alpha: 1, rings: null, turn: 0, gazeX: 0, gazeY: 0, blink: 1, scale: 1 },
    bang: { visible: false, alpha: 0, grow: 0 },
    dots: { visible: false, alpha: 0, items: [] },
    orbits: { visible: false, alpha: 0, scale: 1, rings: [] },
    trail: { visible: false, alpha: 0, radius: 0, width: 0, from: 0, to: 0, colors: [] },
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
 * @returns {object} 帧描述（纯数据，可直接断言）。
 */
export function sampleFrame(motionId, tMs, options) {
  const spec = MOTION_BY_ID[motionId] || MOTION_SPEC.rest
  const t = typeof tMs === 'number' && tMs > 0 ? tMs : 0
  const opts = options !== undefined && options !== null ? options : {}
  const frame = emptyFrame(motionId)
  frame.time = t
  if (opts.static === true) return staticFrame(motionId)

  if (spec === MOTION_SPEC.rest) {
    const turn = idleTurn(t, spec) + spec.breathTurn * Math.sin((t / spec.breathMs) * Math.PI * 2)
    frame.body.turn = turn
    frame.eyes.turn = turn
    frame.eyes.blink = 1 - blinkAt(t, spec) * 0.96
    frame.eyes.gazeY = spec.gazeY * Math.sin((t / 5100) * Math.PI * 2)
    frame.eyes.gazeX = 0.6 * Math.sin((t / 4300) * Math.PI * 2)
    return frame
  }

  if (spec === MOTION_SPEC.spin) {
    // 进入加速：参考 246–320 从静止转到稳定转速
    // 进入时先甩一下头（眼睛压到侧面、短暂消失再回来），然后进入持续的左右张望。
    const whip = spec.whipAmp * Math.sin(Math.PI * clamp((t - 120) / spec.whipMs, 0, 1))
    const sway = spec.swayAmp * Math.sin((t / spec.spinMs) * Math.PI * 2) + spec.swayBias
    const turn = sway + whip
    frame.body.turn = turn * 0.35
    frame.eyes.turn = turn
    frame.eyes.gazeY = 0.4 * Math.sin((t / 1600) * Math.PI * 2)
    // 拖尾：进入后短暂出现，先长后短再消失（参考帧 310–373）
    const start = spec.trailFromMs
    if (t >= start) {
      const p = t - start
      const span = spec.trailGrowMs + spec.trailHoldMs + spec.trailFadeMs
      if (p < span) {
        let len
        let alpha
        if (p < spec.trailGrowMs) {
          len = spec.trailArc * easeOut(p / spec.trailGrowMs)
          alpha = clamp(p / 120, 0, 1)
        } else if (p < spec.trailGrowMs + spec.trailHoldMs) {
          len = spec.trailArc
          alpha = 1
        } else {
          const q = (p - spec.trailGrowMs - spec.trailHoldMs) / spec.trailFadeMs
          len = spec.trailArc * (1 - smoothstep(q))
          alpha = 1 - smoothstep(q)
        }
        frame.trail.visible = len > 0.01 && alpha > 0.01
        frame.trail.alpha = alpha
        frame.trail.radius = spec.trailRadius * D
        frame.trail.width = spec.trailWidth * D
        // 弧的头部跟随转头、尾部滞后 → 看起来是「甩出去的一道」
        const head = turn - 0.35
        frame.trail.from = head - len
        frame.trail.to = head
        frame.trail.colors = Array.from(spec.trailColors)
      }
    }
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
        r: (base / 2) * size * (0.35 + 0.65 * grow),
        alpha: bright * grow,
      })
    }
    frame.dots.visible = true
    frame.dots.alpha = grow
    frame.dots.items = items
    return frame
  }

  // orbit
  const k = clamp(t / spec.enterMs, 0, 1)
  const grow = easeOut(k)
  // 头像朝左右缓慢摇摆而不是整圈自转：参考里 done 的眼睛**一直看得见**，
  // 只是会在边缘被压扁/短暂消失；整圈自转会让眼睛长时间转到背面（实测错误）。
  const sway = 0.62 * Math.sin((t / spec.spinMs) * Math.PI * 2)
  frame.body.sx = 0.18 + 0.82 * grow
  frame.body.sy = 0.18 + 0.82 * grow
  frame.body.turn = sway * 0.4
  frame.eyes.turn = sway
  frame.eyes.alpha = clamp((k - 0.35) / 0.65, 0, 1)
  frame.eyes.visible = frame.eyes.alpha > 0.02
  frame.orbits.visible = k > 0.05
  frame.orbits.alpha = clamp((k - 0.05) / 0.7, 0, 1)
  frame.orbits.scale = 0.35 + 0.65 * grow
  frame.orbits.rings = spec.rings.map((ring) => ({
    a: ring.a * D,
    b: ring.b * D,
    tilt: ring.tilt,
    yaw: ring.yaw,
    spin: ring.phase * Math.PI + t * 0.001 * ring.speed * Math.PI * 2,
    color: ring.color,
    width: spec.width * D,
  }))
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
export function staticFrame(motionId) {
  const frame = emptyFrame(motionId)
  if (motionId === 'rest' || motionId === '') {
    frame.eyes.turn = 0.1
    return frame
  }
  if (motionId === 'spin') {
    // 代表帧：眼睛转到接近正中（参考帧 300 附近的样子），拖尾扫在左上侧
    frame.eyes.turn = -0.42
    frame.body.turn = -0.15
    frame.trail.visible = true
    frame.trail.alpha = 0.9
    frame.trail.radius = MOTION_SPEC.spin.trailRadius * D
    frame.trail.width = MOTION_SPEC.spin.trailWidth * D
    frame.trail.from = 2.35
    frame.trail.to = 4.25
    frame.trail.colors = Array.from(MOTION_SPEC.spin.trailColors)
    return frame
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
    const base = MOTION_SPEC.triDot.diamond * D
    const gap = MOTION_SPEC.triDot.gap * D
    const lineY = BOT_CENTER + MOTION_SPEC.triDot.lineY * D
    frame.dots.visible = true
    frame.dots.alpha = 1
    frame.dots.items = [0, 1, 2].map((i) => ({
      x: BOT_CENTER + (i - 1) * gap,
      y: lineY,
      r: (base / 2) * (i === 1 ? 1.25 : 1.05),
      alpha: i === 1 ? 1 : 0.72,
    }))
    return frame
  }
  // orbit：头像 + 轨道各就各位的一帧（眼睛仍在脸内，参考里 done 的眼睛从不整体转走）
  frame.eyes.turn = 0.28
  frame.body.turn = 0.12
  frame.orbits.visible = true
  frame.orbits.alpha = 1
  frame.orbits.scale = 1
  frame.orbits.rings = MOTION_SPEC.orbit.rings.map((ring) => ({
    a: ring.a * D,
    b: ring.b * D,
    tilt: ring.tilt,
    yaw: ring.yaw,
    spin: ring.phase * Math.PI + 0.8,
    color: ring.color,
    width: MOTION_SPEC.orbit.width * D,
  }))
  return frame
}

/**
 * 把一条轨道的三维姿态投到二维，并按深度切成「身后」「身前」两段。
 *
 * 参考里轨道会在头像后面消失、再从前面绕出来（前后穿插），所以不能整条平铺
 * 在同一层：必须按 z 的符号分段。
 *
 * @param {object} ring 轨道参数（a/b/tilt/yaw/spin）。
 * @param {number} cx 圆心 x。
 * @param {number} cy 圆心 y。
 * @param {number} [segments] 采样段数。
 * @returns {{back: Array<Array<[number, number]>>, front: Array<Array<[number, number]>>}} 两段折线集合。
 */
export function orbitPoints(ring, cx, cy, segments) {
  const n = typeof segments === 'number' && segments >= 24 ? segments : 96
  const back = []
  const front = []
  let currentBack = null
  let currentFront = null
  for (let i = 0; i <= n; i++) {
    const phi = (i / n) * Math.PI * 2
    const x0 = Math.cos(phi) * ring.a
    const y0 = Math.sin(phi) * ring.b
    const cs = Math.cos(ring.spin)
    const ss = Math.sin(ring.spin)
    const x1 = x0 * cs - y0 * ss
    const y1 = x0 * ss + y0 * cs
    const ct = Math.cos(ring.tilt)
    const st = Math.sin(ring.tilt)
    const y2 = y1 * ct
    const z2 = y1 * st
    const cyw = Math.cos(ring.yaw)
    const syw = Math.sin(ring.yaw)
    const x3 = x1 * cyw + z2 * syw
    const z3 = -x1 * syw + z2 * cyw
    // 轻微透视：前面的轨道看着大一点
    const persp = 1 + z3 / (Math.max(ring.a, ring.b) * 7)
    const point = [cx + x3 * persp, cy + y2 * persp]
    const isFront = z3 >= 0
    if (isFront) {
      if (currentFront === null) {
        currentFront = []
        front.push(currentFront)
      }
      currentFront.push(point)
      currentBack = null
    } else {
      if (currentBack === null) {
        currentBack = []
        back.push(currentBack)
      }
      currentBack.push(point)
      currentFront = null
    }
  }
  const clean = (list) => list.filter((seg) => seg.length >= 2)
  return { back: clean(back), front: clean(front) }
}

/**
 * 把拖尾弧切成若干彩色段。
 *
 * @param {object} trail 拖尾参数。
 * @param {number} cx 圆心 x。
 * @param {number} cy 圆心 y。
 * @param {number} [bands] 段数。
 * @returns {Array<{color: string, points: Array<[number, number]>}>} 每段的折线。
 */
export function trailBands(trail, cx, cy, bands) {
  const colors = Array.isArray(trail.colors) ? trail.colors : []
  const n = typeof bands === 'number' && bands > 0 ? bands : Math.max(colors.length, 1)
  const out = []
  if (trail.visible !== true || trail.radius <= 0) return out
  const total = trail.to - trail.from
  if (!(total > 0.001)) return out
  for (let i = 0; i < n; i++) {
    const a = trail.from + (total * i) / n
    const b = trail.from + (total * (i + 1)) / n
    const points = []
    const steps = 14
    for (let s = 0; s <= steps; s++) {
      const ang = a + ((b - a) * s) / steps
      points.push([cx + Math.cos(ang) * trail.radius, cy + Math.sin(ang) * trail.radius])
    }
    out.push({ color: colors.length === 0 ? '#7ad8a8' : colors[i % colors.length], points })
  }
  return out
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
  }
  const bothRings = Array.isArray(a.eyes.rings) && Array.isArray(b.eyes.rings)
  frame.eyes = {
    visible: bothRings ? b.eyes.visible : p < 0.5 ? a.eyes.visible : b.eyes.visible,
    alpha: a.eyes.alpha + (b.eyes.alpha - a.eyes.alpha) * p,
    rings: null,
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
    items: (p >= 0.5 ? b.dots.items : a.dots.items).map((item) => ({ ...item, alpha: item.alpha * dotAlpha })),
  }

  const orbitAlpha = a.orbits.alpha + (b.orbits.alpha - a.orbits.alpha) * p
  frame.orbits = {
    visible: orbitAlpha > 0.01,
    alpha: orbitAlpha,
    scale: a.orbits.scale + (b.orbits.scale - a.orbits.scale) * p,
    rings: p >= 0.5 ? b.orbits.rings : a.orbits.rings,
  }

  const trailAlpha = a.trail.alpha + (b.trail.alpha - a.trail.alpha) * p
  frame.trail = {
    visible: trailAlpha > 0.01 && (p >= 0.5 ? b.trail.visible : a.trail.visible),
    alpha: trailAlpha,
    radius: a.trail.radius + (b.trail.radius - a.trail.radius) * p,
    width: a.trail.width + (b.trail.width - a.trail.width) * p,
    from: a.trail.from + (b.trail.from - a.trail.from) * p,
    to: a.trail.to + (b.trail.to - a.trail.to) * p,
    colors: (p >= 0.5 ? b.trail.colors : a.trail.colors) || [],
  }
  return frame
}

/** 供诊断/测试读取：某一动作是否以头像为主体。 */
export function isAvatarMotion(motionId) {
  const spec = MOTION_BY_ID[motionId]
  return spec !== undefined && spec.kind === 'avatar'
}

export { D as MOTION_UNIT_D, tri as _tri }
