/**
 * dom.js 的单元测试：从侧栏 DOM 认出「这行会话属于哪个项目」。
 *
 * 这条判定踩过一次代价很高的坑：DSH 的 `HoverCard` 把**每一行**（项目行和会话行）
 * 都包进一层 `<span class="hc-root">`，所以项目行不是 `.groupSection` 的直接子节点。
 * 最早这里用 `:scope >` 取项目行，选择器返回 0 个，所有会话都被判成「未分组」，
 * 整个侧栏变成同一个颜色 —— 用户看到的却是「插件没生效」。
 *
 * 所以这里用最小 DOM 桩把真实层级钉死：hc 包装、role=group 中间层、嵌套分区。
 *
 * @module test/dom.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { closestSection, isSection, projectIdOf, workspaceRowOf } from '../src/widget/dom.js'

/** 一个够用的元素桩：只要能爬 parentElement 和按选择器找后代。 */
function el(className, attrs, children) {
  const node = {
    className: className === undefined ? '' : className,
    getAttribute(name) {
      return attrs !== undefined && attrs[name] !== undefined ? attrs[name] : null
    },
    parentElement: null,
    children: [],
    /** 按属性前缀找后代（等价于 querySelectorAll('[data-row-key^="workspace:"]')）。 */
    querySelectorAll(selector) {
      const match = /^\[data-row-key\^="([^"]+)"\]$/.exec(selector)
      const out = []
      const walk = (current) => {
        for (const child of current.children) {
          if (match !== null) {
            const value = child.getAttribute('data-row-key')
            if (typeof value === 'string' && value.startsWith(match[1])) out.push(child)
          }
          walk(child)
        }
      }
      walk(this)
      return out
    },
    append(...kids) {
      for (const kid of kids) {
        kid.parentElement = this
        this.children.push(kid)
      }
      return this
    },
  }
  if (children !== undefined) node.append(...children)
  return node
}

/**
 * 真实层级（照着 dsh-client-ui-workspace 的渲染抄的）：
 *
 *   div.groupSection
 *     span.hc-root > div[data-row-key="workspace:a"]      ← 项目行
 *     div[role=group]
 *       span.hc-root > div[data-row-key="session:a1"]      ← 会话行
 *       span.hc-root > div[data-row-key="session:a2"]
 */
function section(id, sessions) {
  const projectRow = el('projectRow', { 'data-row-key': 'workspace:' + id })
  const group = el('')
  for (const sid of sessions) {
    group.append(el('hc-root').append(el('sessionRow', { 'data-row-key': 'session:' + sid })))
  }
  return el('Kjh-qa_groupSection', {}, [el('hc-root').append(projectRow), group])
}

test('会话行被 HoverCard 的 span 包着也能认出项目', () => {
  const root = section('proj-a', ['s1', 's2'])
  const rows = root.querySelectorAll('[data-row-key^="session:"]')
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.parentElement.className, 'hc-root', '前提：会话行外面确实有一层 hc-root')
    assert.equal(projectIdOf(row), 'proj-a')
  }
})

test('项目行自己也被 hc-root 包着，但依然能被分区找到', () => {
  const root = section('proj-a', ['s1'])
  const projectRow = root.querySelectorAll('[data-row-key^="workspace:"]')[0]
  assert.equal(projectRow.parentElement.className, 'hc-root')
  assert.equal(workspaceRowOf(root), projectRow)
})

test('不同分区各认各的项目，不会串色', () => {
  const a = section('proj-a', ['s1'])
  const b = section('proj-b', ['s2'])
  assert.equal(projectIdOf(a.querySelectorAll('[data-row-key^="session:"]')[0]), 'proj-a')
  assert.equal(projectIdOf(b.querySelectorAll('[data-row-key^="session:"]')[0]), 'proj-b')
})

test('嵌套分区：内层会话算内层项目，外层会话算外层项目', () => {
  const inner = section('inner', ['i1'])
  const outer = section('outer', ['o1'])
  outer.append(inner) // 子项目直接嵌在父分区里

  const outerSession = outer.querySelectorAll('[data-row-key^="session:"]').find(
    (row) => row.getAttribute('data-row-key') === 'session:o1',
  )
  const innerSession = inner.querySelectorAll('[data-row-key^="session:"]')[0]
  assert.equal(projectIdOf(outerSession), 'outer')
  assert.equal(projectIdOf(innerSession), 'inner')
  // 外层分区认自己的项目行，不该认到内层去
  assert.equal(
    workspaceRowOf(outer).getAttribute('data-row-key'),
    'workspace:outer',
  )
})

test('未分组桶（项目行 key 为空串）算未分组', () => {
  const root = section('', ['u1'])
  const row = root.querySelectorAll('[data-row-key^="session:"]')[0]
  assert.equal(projectIdOf(row), '')
})

test('分区里一个项目行都没有时退回未分组，而不是抛错', () => {
  const bare = el('Kjh-qa_groupSection', {})
  bare.append(el('hc-root').append(el('sessionRow', { 'data-row-key': 'session:x1' })))
  assert.equal(workspaceRowOf(bare), null)
  assert.equal(projectIdOf(bare.querySelectorAll('[data-row-key^="session:"]')[0]), '')
})

test('压根不在分区里的行退回未分组', () => {
  const orphan = el('sessionRow', { 'data-row-key': 'session:z1' })
  assert.equal(closestSection(orphan), null)
  assert.equal(projectIdOf(orphan), '')
})

test('isSection 只认 groupSection 类名', () => {
  assert.equal(isSection(el('Kjh-qa_groupSection')), true)
  assert.equal(isSection(el('hc-root')), false)
  assert.equal(isSection(null), false)
  assert.equal(isSection(undefined), false)
})

test('projectIdOf 对 null / undefined 不炸', () => {
  assert.equal(projectIdOf(null), '')
  assert.equal(projectIdOf(undefined), '')
})
