/**
 * 表面适配：侧栏全覆盖，搜索/悬停如实报告「无可靠身份」。
 *
 * 已核验的当前 DSH（0.2.1-rc.5）事实：
 *   · 侧栏会话行    div[data-row-key="session:<id>"]         ← 有稳定身份
 *   · 搜索结果行    div[role=treeitem]，**无 data-row-key**  ← 只有标题文本
 *   · 悬停卡片      HoverCard 用 createPortal 挂到 body，正文由
 *                   renderSlot("sidebar.session.row.hover", { sessionId }) 渲染
 *                   —— sessionId 是**React 参数**，不进 DOM
 *
 * 因此搜索与悬停都拿不到可读的稳定身份。本插件选择如实降级而不是猜：
 * 按标题、按顺序、按宽度都会把头像挂到同名会话上（张冠李戴），比不显示更糟。
 *
 * @module test/surface-adapters.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectSurfaces, leadingSlotOf, readSearchRow, readSidebarRow, sessionIdOfRowKey } from '../src/widget/dom.js'
import { Doc } from './dom-harness.mjs'

function makeDoc() {
  return new Doc()
}

/** 真实侧栏结构：groupSection > hc-root > projectRow，然后 group > hc-root > sessionRow。 */
function sidebarRow(doc, sessionId, workspaceId, options) {
  const opts = options === undefined ? {} : options
  const section = doc.createElement('div')
  section.className = 'JoiKIa_groupSection'
  const projectWrap = doc.createElement('span')
  projectWrap.className = 'hc-root'
  const projectRow = doc.createElement('div')
  projectRow.setAttribute('data-row-key', 'workspace:' + workspaceId)
  projectWrap.appendChild(projectRow)
  section.appendChild(projectWrap)

  const row = doc.createElement('div')
  row.setAttribute('data-row-key', 'session:' + sessionId)
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-selected', opts.selected === true ? 'true' : 'false')
  const slot = doc.createElement('span')
  slot.className = 'JoiKIa_slot'
  const dot = doc.createElement('span')
  dot.setAttribute('data-state', opts.dshState === undefined ? 'idle' : opts.dshState)
  slot.appendChild(dot)
  row.appendChild(slot)
  const title = doc.createElement('span')
  title.className = 'JoiKIa_title'
  title.textContent = opts.title === undefined ? 'session' : opts.title
  row.appendChild(title)

  const wrap = doc.createElement('span')
  wrap.className = 'hc-root'
  wrap.appendChild(row)
  const group = doc.createElement('div')
  group.setAttribute('role', 'group')
  group.appendChild(wrap)
  section.appendChild(group)
  doc.body.appendChild(section)
  return { section, row, slot, dot }
}

/** 真实搜索结果结构：没有 data-row-key，槽位嵌在 searchResultHeading 里。 */
function searchRow(doc, titleText, workspaceText) {
  const row = doc.createElement('div')
  row.className = 'JoiKIa_searchResultRow'
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-selected', 'false')
  const heading = doc.createElement('span')
  heading.className = 'JoiKIa_searchResultHeading'
  const slot = doc.createElement('span')
  slot.className = 'JoiKIa_slot'
  heading.appendChild(slot)
  const title = doc.createElement('span')
  title.className = 'JoiKIa_searchResultTitle'
  title.textContent = titleText
  heading.appendChild(title)
  row.appendChild(heading)
  const meta = doc.createElement('span')
  meta.className = 'JoiKIa_searchResultMeta'
  const ws = doc.createElement('span')
  ws.className = 'JoiKIa_searchResultWorkspace'
  ws.textContent = workspaceText === undefined ? 'proj' : workspaceText
  meta.appendChild(ws)
  row.appendChild(meta)
  doc.body.appendChild(row)
  return { row, slot, title }
}

test('S1 侧栏行有稳定身份，项目归属正确', () => {
  const doc = makeDoc()
  const made = sidebarRow(doc, 'sess-1', 'ws-a')
  const found = readSidebarRow(made.row)
  assert.ok(found !== null)
  assert.equal(found.sessionId, 'sess-1')
  assert.equal(found.workspaceId, 'ws-a')
  assert.equal(found.slot, made.slot)
  assert.equal(found.identityReliable, true)
})

test('S2 HoverCard 包装层与嵌套分区都能正确识别', () => {
  const doc = makeDoc()
  const outer = sidebarRow(doc, 's-outer', 'ws-outer')
  // 在 outer 分区里嵌一个内层分区
  const inner = doc.createElement('div')
  inner.className = 'JoiKIa_groupSection'
  const innerProjectWrap = doc.createElement('span')
  innerProjectWrap.className = 'hc-root'
  const innerProject = doc.createElement('div')
  innerProject.setAttribute('data-row-key', 'workspace:ws-inner')
  innerProjectWrap.appendChild(innerProject)
  inner.appendChild(innerProjectWrap)
  const innerRow = doc.createElement('div')
  innerRow.setAttribute('data-row-key', 'session:s-inner')
  inner.appendChild(innerRow)
  outer.section.appendChild(inner)

  assert.equal(readSidebarRow(innerRow).workspaceId, 'ws-inner', '内层会话归内层项目')
  assert.equal(readSidebarRow(outer.row).workspaceId, 'ws-outer', '外层会话不被内层影响')
})

test('S3 未分组会话：workspaceId 为空串', () => {
  const doc = makeDoc()
  const section = doc.createElement('div')
  section.className = 'JoiKIa_groupSection'
  const wrap = doc.createElement('span')
  wrap.className = 'hc-root'
  const projectRow = doc.createElement('div')
  projectRow.setAttribute('data-row-key', 'workspace:')
  wrap.appendChild(projectRow)
  section.appendChild(wrap)
  const row = doc.createElement('div')
  row.setAttribute('data-row-key', 'session:u1')
  const slot = doc.createElement('span')
  slot.className = 'JoiKIa_slot'
  row.appendChild(slot)
  section.appendChild(row)
  doc.body.appendChild(section)
  assert.equal(readSidebarRow(row).workspaceId, '')
})

test('S4 前导位只认带 slot 类名的直接子节点，不用宽度盲猜', () => {
  const doc = makeDoc()
  const row = doc.createElement('div')
  row.setAttribute('data-row-key', 'session:s1')
  const wide = doc.createElement('span')
  wide.className = 'JoiKIa_title'
  const slot = doc.createElement('span')
  slot.className = 'JoiKIa_slot'
  row.appendChild(wide)
  row.appendChild(slot)
  assert.equal(leadingSlotOf(row), slot, '标题比槽位宽也要选对')
})

test('S5 搜索结果行没有稳定身份：如实报告 identityReliable=false', () => {
  const doc = makeDoc()
  const made = searchRow(doc, '同名会话', 'proj-a')
  const found = readSearchRow(made.row)
  assert.ok(found !== null, '要能识别出这是搜索结果行')
  assert.equal(found.sessionId, null, '不得凭空造 sessionId')
  assert.equal(found.identityReliable, false)
  assert.equal(found.titleText, '同名会话')
  assert.equal(found.slot, made.slot, '槽位仍可识别（嵌套在 heading 里）')
})

test('S6 同名会话在搜索里不会被混淆成同一个身份', () => {
  const doc = makeDoc()
  const a = searchRow(doc, '同名会话', 'proj-a')
  const b = searchRow(doc, '同名会话', 'proj-b')
  assert.equal(readSearchRow(a.row).sessionId, null)
  assert.equal(readSearchRow(b.row).sessionId, null)
})

test('S7 collectSurfaces 把搜索行计入 unidentifiable，不混进侧栏', () => {
  const doc = makeDoc()
  sidebarRow(doc, 's1', 'ws-a')
  searchRow(doc, 'x', 'proj')
  searchRow(doc, 'y', 'proj')
  const result = collectSurfaces(doc)
  assert.equal(result.sidebar.length, 1)
  assert.equal(result.search.length, 0, '没有可靠身份就不进 search 列表')
  assert.equal(result.unidentifiable, 2, '要如实记账')
})

test('S8 搜索结果行若将来带 data-row-key，会被正确识别', () => {
  const doc = makeDoc()
  const made = searchRow(doc, 'x', 'proj')
  made.row.setAttribute('data-row-key', 'session:future-1')
  const found = readSearchRow(made.row)
  assert.equal(found.sessionId, 'future-1', '宿主补上稳定身份后应自动生效')
  const result = collectSurfaces(doc)
  assert.equal(result.search.length, 1)
})

test('S9 sessionIdOfRowKey 只认 session: 前缀', () => {
  const doc = makeDoc()
  const row = doc.createElement('div')
  row.setAttribute('data-row-key', 'workspace:w1')
  assert.equal(sessionIdOfRowKey(row), null, '项目行不是会话行')
  row.setAttribute('data-row-key', 'session:')
  assert.equal(sessionIdOfRowKey(row), null, '空 id 不算')
  row.setAttribute('data-row-key', 'session:ok')
  assert.equal(sessionIdOfRowKey(row), 'ok')
})

test('S10 虚拟列表复用：同一槽位换会话时身份随之改变', () => {
  const doc = makeDoc()
  const made = sidebarRow(doc, 'old-session', 'ws-a')
  assert.equal(readSidebarRow(made.row).sessionId, 'old-session')
  made.row.setAttribute('data-row-key', 'session:new-session')
  assert.equal(readSidebarRow(made.row).sessionId, 'new-session', '复用的槽位必须重新绑定身份')
})
