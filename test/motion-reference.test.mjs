import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { sampleReferenceMotion, ribbonOutline, REFERENCE_MOTION } from '../src/grokbot/reference-motion.js'

// Captured from the original renderer, NOT generated from the implementation under test.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/motion-reference.json', import.meta.url)))
const numbers = value => (value?.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number)
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`)
for (const clip of fixture.clips) {
  const motion = clip.state === 'working' ? 'spin' : 'orbit'
  for (const expected of clip.frames) test(`官方独立采样 ${clip.state} @ ${Math.round(expected.time)}ms：眼型/投影/姿态/尾迹/渐变`, () => {
    const actual = sampleReferenceMotion(motion, expected.time, 128, false)
    const p = numbers(expected.pose)
    ;[114.2705 + actual.pose.x, 114.2705 + actual.pose.y, actual.pose.roll, 1, actual.pose.sy].forEach((n, i) => near(n, p[i], .011, 'avatar pose'))
    expected.eyes.forEach((eye, i) => {
      if (!eye.visible) { assert.equal(actual.eyes[i].length, 0); return }
      const pts = numbers(eye.d), transform = numbers(eye.transform)
      assert.equal(actual.eyes[i].length * 2, pts.length)
      actual.eyes[i].forEach((point, j) => point.forEach((v, k) => near(v, transform[k] + (pts[j * 2 + k] + transform[4 + k]) * transform[2 + k], .0001, `eye ${i} point ${j}`)))
    })
    assert.equal(actual.ribbons.length, expected.ribbons.length)
    actual.ribbons.forEach((ribbon, i) => {
      const ref = expected.ribbons[i], paths = ribbonOutline(ribbon.points, ribbon.width)
      assert.equal(paths.back, ref.paths[0].d)
      assert.equal(paths.front, ref.paths[1].d)
      near(ribbon.alpha, Number(ref.paths[0].alpha), .00051, 'ribbon opacity')
      const first = ribbon.points[0], last = ribbon.points.at(-1)
      ;[first.x, first.y, last.x, last.y].forEach((v, j) => near(v, Number(ref[['x1','y1','x2','y2'][j]]), .051, 'gradient endpoint'))
      const colors = Array.from({length:5}, (_, j) => `hsl(${(((ribbon.hue + ribbon.hueSpan * j / 4) % 360 + 360) % 360).toFixed(0)} 56% ${(56 + 11 * j / 4).toFixed(0)}%)`)
      assert.deepEqual(colors, ref.colors)
    })
  })
}

test('样本不会因其他头像采样顺序变化、长任务或反向 seek 而漂移', () => {
  for (const motion of ['spin', 'orbit']) {
    const a = sampleReferenceMotion(motion, 2000)
    sampleReferenceMotion(motion, 60000); sampleReferenceMotion(motion, 100)
    assert.deepEqual(sampleReferenceMotion(motion, 2000), a)
    const b = sampleReferenceMotion(motion, 2000)
    b.eyes[0]?.[0]?.splice(0, 2, 999, 999); b.ribbons[0].points[0].x = 999
    assert.deepEqual(sampleReferenceMotion(motion, 2000), a)
    assert.deepEqual(sampleReferenceMotion(motion, 2000 + REFERENCE_MOTION[motion].cycleMs * 1000), a)
  }
})

test('填充尾迹保留圆头、变宽与前后分段，不是定宽闭合描边', () => {
  const ribbon = sampleReferenceMotion('orbit', 1500).ribbons.find(r => r.points.some(p=>p.z>=0) && r.points.some(p=>p.z<0))
  const paths = ribbonOutline(ribbon.points, ribbon.width)
  assert.ok(paths.front && paths.back)
  assert.ok((paths.front + paths.back).includes('A'))
  assert.ok(paths.front.endsWith('Z') && paths.back.endsWith('Z')) // ribbon outlines close; centrelines do NOT
  assert.ok(Math.abs(ribbon.points.at(-1).l - ribbon.points[0].l) < Math.PI * 2)
})
