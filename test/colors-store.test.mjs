/**
 * colors-store.js 的单元测试：项目配色表的落盘、读回、损坏回退。
 *
 * 为什么值得单独钉：这张表是**重启后颜色还在**的唯一凭据。它崩一次，用户的
 * 配色就全丢了；它读崩一次，插件会把整个侧栏的取色路径带崩。
 *
 * @module test/colors-store.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COLORS_VERSION, colorsFile, createColorStore, pluginHome, sanitizeProjects } from '../lib/colors-store.js'
import { normalizeColor } from '../src/colors-shared.js'

/** 建一个落在临时目录里的配色表。 */
function store(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-colors-'))
  const file = path.join(dir, 'colors.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const warnings = []
  const made = createColorStore({
    normalize: normalizeColor,
    file,
    warn: (message) => warnings.push(message),
    ...options,
  })
  return { store: made, file, dir, warnings }
}

test('插件家目录跟着 DSH_HOME 走，没设就退回 ~/.dsh', () => {
  assert.equal(pluginHome({ DSH_HOME: '/tmp/dshhome' }), path.join('/tmp/dshhome', 'dsh-grok-buddy'))
  assert.equal(pluginHome({}), path.join(os.homedir(), '.dsh', 'dsh-grok-buddy'))
  assert.equal(colorsFile({ DSH_HOME: '/tmp/dshhome' }), path.join('/tmp/dshhome', 'dsh-grok-buddy', 'colors.json'))
})

test('文件不存在时是空表，且不报错（还没人改过颜色）', (t) => {
  const { store: made, warnings } = store(t)
  assert.deepEqual(made.snapshot().projects, {})
  assert.equal(warnings.length, 0)
})

test('写入 → 读回往返一致', (t) => {
  const { store: made, file } = store(t)
  const result = made.set('proj-a', '#9159fe')
  assert.deepEqual(result, { ok: true, color: '#9159fe' })
  assert.equal(made.get('proj-a'), '#9159fe')

  const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(disk.version, COLORS_VERSION)
  assert.equal(disk.projects['proj-a'], '#9159fe')

  // 新实例重新读盘：还是那个色
  const again = createColorStore({ normalize: normalizeColor, file })
  assert.equal(again.get('proj-a'), '#9159fe')
})

test('预设色名会被规范化成 hex 再落盘', (t) => {
  const { store: made, file } = store(t)
  made.set('proj-a', 'purple')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects['proj-a'], '#9159fe')
})

test('恢复默认：传 null 就把这项删掉，哈希默认色重新接管', (t) => {
  const { store: made, file } = store(t)
  made.set('proj-a', '#00bca6')
  assert.equal(made.get('proj-a'), '#00bca6')
  const result = made.set('proj-a', null)
  assert.equal(result.ok, true)
  assert.equal(made.get('proj-a'), undefined)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects['proj-a'], undefined)
})

test('拒绝非法颜色与非法 workspaceId，并且不改动已有表', (t) => {
  const { store: made } = store(t)
  made.set('proj-a', '#9159fe')
  for (const bad of ['rgb(1,2,3)', 'javascript:alert(1)', '#12345', 42, {}]) {
    const result = made.set('proj-b', bad)
    assert.equal(result.ok, false, String(bad) + ' 不该被接受')
  }
  assert.equal(made.set('', '#000000').ok, false)
  assert.equal(made.set(null, '#000000').ok, false)
  assert.equal(made.get('proj-b'), undefined)
  assert.equal(made.get('proj-a'), '#9159fe')
})

test('文件损坏（半截 JSON / 不是对象）不崩，退回空表并 warn', (t) => {
  const { store: made, file, warnings } = store(t)
  made.set('proj-a', '#9159fe')

  fs.writeFileSync(file, '{"version":1,"projects":{"proj-a":')
  const broken = createColorStore({ normalize: normalizeColor, file, warn: (m) => warnings.push(m) })
  assert.deepEqual(broken.snapshot().projects, {})
  assert.ok(warnings.some((m) => /JSON/.test(m)), '损坏文件应该有 warn')

  fs.writeFileSync(file, '[1,2,3]')
  const wrongShape = createColorStore({ normalize: normalizeColor, file, warn: (m) => warnings.push(m) })
  assert.deepEqual(wrongShape.snapshot().projects, {})
})

test('字段缺失 / 值不合法时逐条丢掉，合法的留下', (t) => {
  const { store: made, file } = store(t)
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      projects: { good: '#1084fe', bad: 'nope', alsoBad: 7, short: '#abc' },
    }),
  )
  const reloaded = createColorStore({ normalize: normalizeColor, file })
  assert.deepEqual(reloaded.snapshot().projects, { good: '#1084fe', short: '#aabbcc' })
  // 同一个实例 reload 之后也是这份（坏的被丢掉，好的留下）
  made.reload()
  assert.deepEqual(made.snapshot().projects, { good: '#1084fe', short: '#aabbcc' })
})

test('路径作为可读备份一起落盘，但不影响按 workspaceId 取色', (t) => {
  const { store: made, file } = store(t)
  made.set('proj-a', '#9159fe', '/Users/space/IdeaProjects/demo')
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(disk.paths['proj-a'], '/Users/space/IdeaProjects/demo')
  assert.equal(disk.projects['proj-a'], '#9159fe')
})

test('写盘是原子的：不会留下 tmp 文件', (t) => {
  const { store: made, dir } = store(t)
  made.set('proj-a', '#9159fe')
  made.set('proj-b', '#ff309b')
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('sanitizeProjects 只留字符串键 + 合法颜色', () => {
  const out = sanitizeProjects({ a: '#FFFFFF', b: 'purple', c: 'x', d: 1 }, normalizeColor)
  assert.deepEqual(out, { a: '#ffffff', b: '#9159fe' })
  assert.deepEqual(sanitizeProjects(null, normalizeColor), {})
  assert.deepEqual(sanitizeProjects([1, 2], normalizeColor), {})
})
