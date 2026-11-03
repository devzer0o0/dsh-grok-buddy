/**
 * 「把 colors.json 删掉再重启，颜色退回各自的项目哈希默认色」——
 * 这是验收里最容易漏的一条：它是**回退路径**，改坏了平常完全看不出来。
 *
 * @module test/colors-reset.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { createColorStore, pluginHome } from '../lib/colors-store.js'
import { normalizeColor } from '../src/colors-shared.js'
import { UNGROUPED_STORE_KEY, defaultInk, inkOfProject, storeKey } from '../src/palette.js'

/** 挂一个落在临时 DSH_HOME 上的配色表。 */
function storeAt(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgb-reset-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const file = path.join(pluginHome({ DSH_HOME: home }), 'colors.json')
  return { home, file, make: () => createColorStore({ normalize: normalizeColor, file, warn: () => {} }) }
}

test('删掉 colors.json 后，每个项目回到它原来的哈希默认色', (t) => {
  const { file, make } = storeAt(t)
  const projects = ['proj-alpha', 'proj-beta', 'proj-gamma', '']

  // 1) 先给每个项目设一个和默认色**不同**的色（未分组用保留键）
  const first = make()
  for (const id of projects) {
    const custom = defaultInk(id) === '#ff263c' ? '#1084fe' : '#ff263c'
    first.set(storeKey(id), custom)
    assert.equal(first.get(storeKey(id)), custom)
  }
  assert.equal(storeKey(''), UNGROUPED_STORE_KEY)
  assert.ok(fs.existsSync(file))

  // 2) 删掉文件（模拟「用户手滑」或「换机器」），重启
  fs.rmSync(file)
  const restarted = make()
  assert.deepEqual(restarted.snapshot().projects, {}, '删掉后应该是空表')

  // 3) 每个项目回到它自己的哈希默认色，且和删之前算出来的一致
  for (const id of projects) {
    assert.equal(restarted.get(storeKey(id)), undefined, id + ' 不该还留着自定义色')
    assert.equal(inkOfProject(id, true, restarted.snapshot().projects), defaultInk(id), id + ' 没回到默认色')
  }

  // 4) 同一项目的默认色在删除前后是同一个（哈希是纯函数，不受文件影响）
  const before = defaultInk('proj-alpha')
  fs.rmSync(file, { force: true })
  assert.equal(defaultInk('proj-alpha'), before)
})

test('整个插件家目录被删掉也能重建（写盘时 mkdir -p）', (t) => {
  const { home, file, make } = storeAt(t)
  const first = make()
  first.set('proj-a', '#00bca6')
  fs.rmSync(path.join(home, 'dsh-grok-buddy'), { recursive: true, force: true })
  assert.equal(fs.existsSync(file), false)

  const second = make()
  assert.deepEqual(second.snapshot().projects, {})
  const result = second.set('proj-a', '#9159fe')
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(file), true)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects['proj-a'], '#9159fe')
})
