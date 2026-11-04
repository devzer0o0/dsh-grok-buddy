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
import {
  closestSection,
  collectWorkspaceFolders,
  folderSlotOf,
  isSection,
  projectIdOf,
  workspaceIdOfRow,
  workspaceRowOf,
} from '../src/widget/dom.js'
import { Doc } from './dom-harness.mjs'

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

// ── 项目行身份与原生文件夹图标（workspaceIdOfRow / folderSlotOf / collectWorkspaceFolders）──

/**
 * 照 dsh-client-ui-workspace 的 ProjectRowItem 抄一份真实项目行：
 *   div[data-row-key="workspace:…"]
 *     > span.slot.folder(.folderActive) > svg   ← 原生文件夹
 *     > span.slot.chevron > svg.arrow           ← 展开箭头（hover 时顶替文件夹）
 *     > span.projectText > span.title           ← 标题
 *     > span.rowActions                         ← ⋯ 菜单 + 新建会话
 */
function projectRow(doc, workspaceId, options) {
  const opts = options === undefined ? {} : options
  const row = doc.createElement('div')
  row.setAttribute('data-row-key', 'workspace:' + workspaceId)
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-expanded', opts.expanded === false ? 'false' : 'true')
  const folder = doc.createElement('span')
  folder.className = 'JoiKIa_slot JoiKIa_folder' + (opts.active === true ? ' JoiKIa_folderActive' : '')
  const folderSvg = doc.createElement('svg')
  const folderPath = doc.createElement('path')
  folderPath.setAttribute('stroke', 'currentColor')
  folderSvg.appendChild(folderPath)
  folder.appendChild(folderSvg)
  const chevron = doc.createElement('span')
  chevron.className = 'JoiKIa_slot JoiKIa_chevron'
  const arrow = doc.createElement('svg')
  arrow.className = 'JoiKIa_arrow'
  chevron.appendChild(arrow)
  const text = doc.createElement('span')
  text.className = 'JoiKIa_projectText'
  const title = doc.createElement('span')
  title.className = 'JoiKIa_title'
  title.textContent = opts.title === undefined ? workspaceId : opts.title
  text.appendChild(title)
  const actions = doc.createElement('span')
  actions.className = 'JoiKIa_rowActions'
  const more = doc.createElement('button')
  more.setAttribute('aria-label', '⋯')
  actions.appendChild(more)
  row.appendChild(folder)
  row.appendChild(chevron)
  row.appendChild(text)
  row.appendChild(actions)
  return { row, folder, chevron, title }
}

test('workspaceIdOfRow：项目行身份只从 data-row-key 正面读', () => {
  const doc = new Doc()
  const made = projectRow(doc, 'proj-a')
  assert.equal(workspaceIdOfRow(made.row), 'proj-a')
  // 未分组桶：workspace: 后面是空串，也是合法身份
  const ungrouped = projectRow(doc, '')
  assert.equal(workspaceIdOfRow(ungrouped.row), '')
  // 会话行、别的行、空输入都不是项目行
  assert.equal(workspaceIdOfRow({ getAttribute: () => 'session:s1' }), null)
  assert.equal(workspaceIdOfRow({ getAttribute: () => null }), null)
  assert.equal(workspaceIdOfRow(null), null)
  assert.equal(workspaceIdOfRow(undefined), null)
})

test('folderSlotOf：只认前导的 slot+folder 那格，箭头/标题/菜单都不认', () => {
  const doc = new Doc()
  const made = projectRow(doc, 'proj-a')
  assert.equal(folderSlotOf(made.row), made.folder)
  assert.equal(folderSlotOf(made.row) === made.chevron, false, '不能认到箭头那格')
  // 宿主「含当前会话」时给文件夹格加 folderActive，身份不变
  const active = projectRow(doc, 'proj-b', { active: true })
  assert.equal(folderSlotOf(active.row), active.folder)
  // 没有文件夹位（结构变了 / 没渲染）：如实返回 null，不猜第一个 SVG
  const bare = doc.createElement('div')
  bare.setAttribute('data-row-key', 'workspace:proj-c')
  bare.appendChild(doc.createElement('span'))
  assert.equal(folderSlotOf(bare), null)
  assert.equal(folderSlotOf(null), null)
})

test('collectWorkspaceFolders：按行身份枚举，认不出的跳过，不依赖会话', () => {
  const doc = new Doc()
  const a = projectRow(doc, 'proj-a')
  const b = projectRow(doc, 'proj-b', { expanded: false })
  const ungrouped = projectRow(doc, '')
  const bare = doc.createElement('div')
  bare.setAttribute('data-row-key', 'workspace:proj-d') // 没渲染文件夹位 → 跳过
  const search = doc.createElement('div') // 搜索结果行没有 workspace 行身份
  search.setAttribute('class', 'searchResultRow')
  doc.body.appendChild(a.row)
  doc.body.appendChild(b.row)
  doc.body.appendChild(ungrouped.row)
  doc.body.appendChild(bare)
  doc.body.appendChild(search)
  const found = collectWorkspaceFolders(doc)
  assert.deepEqual(
    found.map((item) => item.workspaceId),
    ['proj-a', 'proj-b', ''],
    '折叠与否、有无会话都枚举到；认不出的行跳过',
  )
  assert.equal(found[0].folder, a.folder)
})
