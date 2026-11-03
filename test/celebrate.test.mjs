/**
 * 完成展示的测试：活跃时持续庆祝，查看/失活后离开。
 *
 * 语义变化（相对旧的「只播 2.6 秒」）：
 *   不再有固定时长，也不往 proud/idle 回落。保留的约束只有两条：
 *   · 同一完成周期只初始化一次；
 *   ・持续播放期间不重复重启。
 *
 * @module test/celebrate.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { CELEBRATE_MOTION, afterCelebration, freshMemory, resolveMotion } from '../src/widget/celebrate.js'
import { PHASE_TO_MOTION } from '../src/mapping.js'

const MOTIONS = PHASE_TO_MOTION
const KEY = 's1#7'

/** 模拟连续轮询：返回这段时间里实际用过的动作序列。 */
function simulate(keys, memory, completions) {
  let mem = memory
  const shown = []
  for (let i = 0; i < keys.length; i++) {
    const key = completions === undefined ? KEY : completions[i]
    const resolved = resolveMotion(keys[i], mem, MOTIONS, key)
    mem = resolved.memory
    shown.push({ phase: keys[i], motion: resolved.motion, start: resolved.start })
  }
  return { shown, memory: mem }
}

test('done 全程持续 celebrate，永不收敛成别的表情', () => {
  const phases = new Array(200).fill('done')
  const { shown } = simulate(phases, freshMemory())
  for (const round of shown) assert.equal(round.motion, 'celebrate')
})

test('同一完成周期只初始化一次', () => {
  const phases = new Array(50).fill('done')
  const { shown } = simulate(phases, freshMemory())
  assert.equal(shown[0].start, true, '第一次初始化')
  for (let i = 1; i < shown.length; i++) assert.equal(shown[i].start, false, '后续轮询不得重复初始化')
})

test('done 的动作和 idle 明显不同', () => {
  assert.equal(resolveMotion('done', freshMemory(), MOTIONS, KEY).motion, 'celebrate')
  assert.equal(resolveMotion('idle', freshMemory(), MOTIONS, KEY).motion, MOTIONS.idle)
  assert.notEqual(MOTIONS.done, MOTIONS.idle)
})

test('离开 done 之后记忆清零，下一次完成建立新周期', () => {
  let mem = freshMemory()
  let r = resolveMotion('done', mem, MOTIONS, KEY)
  mem = r.memory
  assert.equal(r.motion, 'celebrate')
  r = resolveMotion('thinking', mem, MOTIONS, KEY)
  mem = r.memory
  assert.equal(r.motion, MOTIONS.thinking)
  assert.deepEqual(mem, freshMemory(), '离开 done 要清零')
  r = resolveMotion('done', mem, MOTIONS, KEY)
  assert.equal(r.motion, 'celebrate')
  assert.equal(r.start, true, '新周期需要初始化')
})

test('不同的 completionKey 会建立新的完成周期', () => {
  let mem = freshMemory()
  let r = resolveMotion('done', mem, MOTIONS, 's1#1')
  assert.equal(r.start, true)
  mem = r.memory
  r = resolveMotion('done', mem, MOTIONS, 's1#1')
  assert.equal(r.start, false)
  mem = r.memory
  r = resolveMotion('done', mem, MOTIONS, 's1#2')
  assert.equal(r.start, true, '新的一轮完成是新的周期')
})

test('其它状态一律直通，不碰完成记忆', () => {
  for (const phase of ['idle', 'thinking', 'working', 'waiting', 'blocked']) {
    const r = resolveMotion(phase, freshMemory(), MOTIONS, KEY)
    assert.equal(r.motion, MOTIONS[phase], phase + ' 应该直通')
    assert.equal(r.start, false)
    assert.deepEqual(r.memory, freshMemory())
  }
})

test('afterCelebration 之后不再庆祝（周期结束）', () => {
  const mem = afterCelebration()
  assert.deepEqual(mem, freshMemory())
  const r = resolveMotion('idle', mem, MOTIONS, KEY)
  assert.equal(r.motion, MOTIONS.idle)
})

test('记忆缺失/损坏时按「没庆祝过」处理，不抛错', () => {
  for (const bad of [undefined, null, {}, { started: 'yes' }]) {
    const r = resolveMotion('done', bad, MOTIONS, KEY)
    assert.equal(r.motion, CELEBRATE_MOTION)
  }
})
