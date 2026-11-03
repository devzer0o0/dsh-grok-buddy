/**
 * 活跃与颜色的测试。
 *
 * 颜色表示**项目身份**，不表示状态：六态同色，灰色才是「失活展示」。
 * @module test/activity.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { COOLDOWN_MS, DORMANT_INK, inkForRow, isActive } from '../src/widget/activity.js'

const NOW = 10_000_000
const INK = '#9159fe'

test('正在发生的六态里，活跃的四种都是彩色', () => {
  for (const phase of ['thinking', 'working', 'waiting', 'blocked']) {
    assert.equal(isActive({ phase }, NOW), true, phase + ' 应该活跃')
  }
})

test('空闲是灰的', () => {
  assert.equal(isActive({ phase: 'idle' }, NOW), false)
  assert.equal(inkForRow({ phase: 'idle' }, NOW, INK, false), DORMANT_INK.light)
})

test('选中的空闲行 → 项目色（选中优先于失活）', () => {
  assert.equal(isActive({ phase: 'idle', selected: true }, NOW), true)
  assert.equal(inkForRow({ phase: 'idle', selected: true }, NOW, INK, false), INK)
})

test('选中不能让空闲会话被误判为正在工作', () => {
  const row = { phase: 'idle', selected: true }
  // 活跃（显示项目色）是真的，但**状态**仍是 idle —— 颜色不承担状态
  assert.equal(isActive(row, NOW), true)
  assert.equal(row.phase, 'idle')
})

test('活跃 done 是项目色', () => {
  assert.equal(isActive({ phase: 'done', completedAt: NOW - 1000 }, NOW), true)
  assert.equal(inkForRow({ phase: 'done', completedAt: NOW - 1000 }, NOW, INK, false), INK)
})

test('选中并查看期间仍是 done 与项目色', () => {
  const row = { phase: 'done', selected: true, completedAt: NOW - 1000, seenAt: NOW - 500 }
  assert.equal(isActive(row, NOW), true)
  assert.equal(inkForRow(row, NOW, INK, true), INK)
})

test('查看并切走后变灰 idle', () => {
  const row = { phase: 'idle', selected: false, completedAt: NOW - 1000, seenAt: NOW - 500, consumed: true }
  assert.equal(isActive(row, NOW), false)
  assert.equal(inkForRow(row, NOW, INK, true), DORMANT_INK.dark)
})

test('完成展示失活后变灰', () => {
  const row = { phase: 'done', completedAt: NOW - COOLDOWN_MS - 1 }
  assert.equal(isActive(row, NOW), false)
})

test('缺 completedAt 的完成仍可被消费（不会永远活跃）', () => {
  // observedAt 是首次观测时刻，合法的「什么时候看到它完成的」证据
  const row = { phase: 'done', observedAt: NOW - 1000, consumed: true }
  assert.equal(isActive(row, NOW), false, '没有 completedAt 也要能被标记已查看')
  const fresh = { phase: 'done', observedAt: NOW - 1000 }
  assert.equal(isActive(fresh, NOW), true, '刚观测到、没消费 → 仍活跃')
  const stale = { phase: 'done', observedAt: NOW - COOLDOWN_MS - 1 }
  assert.equal(isActive(stale, NOW), false, '观测锚点也能失活')
})

test('旧的一次查看（早于完成）不算看过', () => {
  const row = { phase: 'done', completedAt: NOW - 1000, seenAt: NOW - 5000 }
  assert.equal(isActive(row, NOW), true)
})

test('长时间没人看的完成也凉', () => {
  const row = { phase: 'done', completedAt: NOW - COOLDOWN_MS - 1 }
  assert.equal(isActive(row, NOW), false)
})

test('怪输入不炸，一律当不活跃', () => {
  for (const bad of [null, undefined, {}, { phase: 42 }]) {
    assert.equal(isActive(bad, NOW), false)
  }
})

test('灰的两档不一样，深色主题用亮一点的灰', () => {
  assert.notEqual(DORMANT_INK.light, DORMANT_INK.dark)
})
