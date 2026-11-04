/**
 * 从 DSH 的 DOM 里认出「这是一行会话 / 一条搜索结果 / 一个悬停卡片」。
 *
 * 这里取代了「所有会话表面都是 [data-row-key^="session:"]」的假设。真实 DSH
 * （dsh-client-ui-workspace/lib/client.js）里三种表面的结构是**不同的**：
 *
 *   侧栏会话行    div[data-row-key="session:<id>"][role=treeitem][aria-selected]
 *                   > span.<module>_slot            ← 16px 前导位
 *                   > span.<module>_title
 *   搜索结果行    div[role=treeitem][aria-selected]    ← **没有 data-row-key**
 *                   > span.searchResultHeading
 *                       > span.slot > (状态点 | 空)
 *                       > span.searchResultTitle
 *                   > span.searchResultMeta > span.searchResultWorkspace + snippet
 *   悬停卡片      由 HoverCard 渲染，正文里带 renderSlot("sidebar.session.row.hover", {sessionId})
 *
 * 搜索结果行**没有**稳定身份属性 —— 它只有标题文本和工作区名字。用标题或顺序
 * 猜身份是明确禁止的（会张冠李戴到同名会话上）。所以这里如实回报
 * 「认不出身份」，由上层决定怎么处理，绝不猜。
 *
 * @module dsh-grok-buddy/dom
 */

/** 往上爬的最大层数：会话行 → role=group → hc 包装 → 分区，真实结构不超过这个数。 */
const MAX_WALK = 12

/** 表面类型。 */
export const SURFACE_KIND = Object.freeze({
  sidebarRow: 'sidebar-row',
  searchRow: 'search-row',
  hoverCard: 'hover-card',
})

/** 取一个元素的类名字符串（SVG 元素的 className 是对象，统一成串）。 */
export function classOf(node) {
  if (node === null || node === undefined) return ''
  const cls = node.className
  if (typeof cls === 'string') return cls
  if (cls !== null && typeof cls === 'object' && typeof cls.baseVal === 'string') return cls.baseVal
  return ''
}

/** 类名里是否含某个模块化片段（DSH 的 CSS Modules 类名形如 JoiKIa_slot）。 */
export function hasClassPart(node, part) {
  const cls = classOf(node)
  if (cls === '') return false
  return new RegExp('(^|\\s)[A-Za-z0-9_-]*' + part + '(?![A-Za-z0-9_-])').test(cls)
}

/** 取一个元素最近的 .groupSection 祖先（不含自己）。 */
export function closestSection(node) {
  let cursor = node
  for (let depth = 0; cursor !== null && cursor !== undefined && depth < MAX_WALK; depth++) {
    cursor = cursor.parentElement
    if (cursor === null || cursor === undefined) return null
    if (isSection(cursor)) return cursor
  }
  return null
}

/** 这个元素是不是一个项目分区。 */
export function isSection(node) {
  if (node === null || node === undefined) return false
  return /groupSection/.test(classOf(node))
}

/**
 * 分区自己的项目行。跳过嵌套分区里的那些。
 * @param {Element} section 分区元素。
 * @returns {Element|null} 项目行。
 */
export function workspaceRowOf(section) {
  if (section === null || section === undefined) return null
  const rows = section.querySelectorAll('[data-row-key^="workspace:"]')
  for (const candidate of rows) {
    if (closestSection(candidate) === section) return candidate
  }
  return null
}

/** 项目行 data-row-key 的前缀。 */
const WORKSPACE_KEY_PREFIX = 'workspace:'

/**
 * 从**项目行自身**读 workspaceId（data-row-key="workspace:<id>"）。
 *
 * 这是项目身份的正面入口；projectIdOf() 解决的是另一件事 ——「一条**会话**行
 * 属于哪个项目」。两者不要混用：projectIdOf 对项目行自己会给出错误的归属。
 *
 * @param {Element} row 候选行。
 * @returns {string|null} workspaceId（未分组是空串）；不是项目行返回 null。
 */
export function workspaceIdOfRow(row) {
  if (row === null || row === undefined || typeof row.getAttribute !== 'function') return null
  const key = row.getAttribute('data-row-key')
  if (typeof key !== 'string' || key.startsWith(WORKSPACE_KEY_PREFIX) !== true) return null
  return key.slice(WORKSPACE_KEY_PREFIX.length)
}

/**
 * 项目行前导的**原生文件夹**图标位。
 *
 * DSH 的项目行结构（dsh-client-ui-workspace/lib/client.js 的 ProjectRowItem）：
 *
 *   div[data-row-key="workspace:…"][role=treeitem]
 *     > span.slot.folder[.folderActive]   ← 原生文件夹图标（open/close 两种 SVG）
 *     > span.slot.chevron > svg.arrow     ← 展开箭头（hover 时顶替文件夹）
 *     > span.projectText > span.title     ← 标题
 *     > span.rowActions                   ← ⋯ 菜单 + 新建会话按钮
 *
 * 所以只认「直接子节点里 class 同时含 slot 与 folder 片段」的那一个 span：
 * 箭头（slot+chevron）、菜单与新建按钮（rowActions）、标题（projectText）都不会命中。
 * 认不出（结构变了 / 没渲染文件夹）就返回 null，绝不按「第一个 SVG」猜。
 *
 * @param {Element} row 项目行。
 * @returns {Element|null} 文件夹图标位。
 */
export function folderSlotOf(row) {
  if (row === null || row === undefined || row.children === undefined) return null
  for (const child of row.children) {
    if (hasClassPart(child, 'slot') && hasClassPart(child, 'folder')) return child
  }
  return null
}

/**
 * 枚举当前页面上**可识别**的项目文件夹（项目行的原生文件夹位）。
 *
 * 只按项目行自身的 data-row-key 认身份：标题、顺序、第几个子节点、当前选中
 * 会话都不参与。认不出的行如实跳过（不猜、不扩大选择器）。这不依赖会话记录
 * 存在 —— 折叠项目、空项目一样会被枚举到。
 *
 * @param {Document} doc 文档。
 * @returns {{workspaceId: string, row: Element, folder: Element}[]} 文件夹目标。
 */
export function collectWorkspaceFolders(doc) {
  const out = []
  if (doc === null || doc === undefined || typeof doc.querySelectorAll !== 'function') return out
  const selector = '[data-row-key^="' + WORKSPACE_KEY_PREFIX + '"]'
  for (const row of doc.querySelectorAll(selector)) {
    const workspaceId = workspaceIdOfRow(row)
    if (workspaceId === null) continue
    const folder = folderSlotOf(row)
    if (folder === null) continue
    out.push({ workspaceId, row, folder })
  }
  return out
}

/**
 * 会话行属于哪个项目。
 * @param {Element} row 会话行。
 * @returns {string} workspaceId；未分组返回空串。
 */
export function projectIdOf(row) {
  if (row === null || row === undefined) return ''
  const section = closestSection(row)
  if (section === null) return ''
  const header = workspaceRowOf(section)
  if (header === null) return ''
  const key = header.getAttribute('data-row-key')
  return typeof key === 'string' ? key.slice('workspace:'.length) : ''
}

/**
 * 读一行里的 data-row-key，取出 session: 后面的 id。
 * @param {Element} row 候选行。
 * @returns {string|null} 会话 id；不是会话行时返回 null。
 */
export function sessionIdOfRowKey(row) {
  const key = row !== null && row !== undefined && typeof row.getAttribute === 'function'
    ? row.getAttribute('data-row-key')
    : null
  if (typeof key !== 'string' || key.startsWith('session:') !== true) return null
  const id = key.slice('session:'.length)
  return id === '' ? null : id
}

/**
 * 侧栏里的 16px 前导位。
 *
 * 只认「确实带 slot 类名的直接子节点」，不再用「首个窄于 20px 的子节点」盲猜 ——
 * 那个启发式在搜索结果和悬停卡片里会选错节点。
 *
 * @param {Element} row 会话行。
 * @returns {Element|null} 前导位。
 */
export function leadingSlotOf(row) {
  if (row === null || row === undefined || row.children === undefined) return null
  for (const child of row.children) {
    if (hasClassPart(child, 'slot')) return child
  }
  return null
}

/**
 * 认出一条**侧栏会话行**。
 * @param {Element} el 候选元素。
 * @returns {object|null} 识别结果。
 */
export function readSidebarRow(el) {
  const sessionId = sessionIdOfRowKey(el)
  if (sessionId === null) return null
  const row = el
  return {
    surface: SURFACE_KIND.sidebarRow,
    sessionId,
    workspaceId: projectIdOf(row),
    host: row,
    slot: leadingSlotOf(row),
    selected: row.getAttribute('aria-selected') === 'true',
    identityReliable: true,
  }
}

/**
 * 认出一条**搜索结果行**。
 *
 * 搜索结果行**没有**稳定身份属性（DSH 不写 data-row-key），所以这里只回报
 * 「这是一条搜索结果」，sessionId 为空、identityReliable 为 false。
 * 上层据此跳过（而不是按标题猜）。这是有意的降级，不是遗漏。
 *
 * @param {Element} el 候选元素。
 * @returns {object|null} 识别结果。
 */
export function readSearchRow(el) {
  if (el === null || el === undefined) return null
  const heading = typeof el.querySelector === 'function' ? el.querySelector('[class*="searchResultHeading"]') : null
  if (heading === null) return null
  const titleEl = el.querySelector('[class*="searchResultTitle"]')
  return {
    surface: SURFACE_KIND.searchRow,
    sessionId: sessionIdOfRowKey(el),
    workspaceId: '',
    host: el,
    slot: heading.querySelector('[class*="slot"]'),
    selected: el.getAttribute !== undefined && el.getAttribute('aria-selected') === 'true',
    identityReliable: false,
    titleText: titleEl !== null && typeof titleEl.textContent === 'string' ? titleEl.textContent : '',
  }
}

/**
 * 枚举当前页面上的所有会话表面。
 *
 * @param {Document} doc 文档。
 * @returns {{sidebar: object[], search: object[], unidentifiable: number}} 分类结果。
 */
export function collectSurfaces(doc) {
  const out = { sidebar: [], search: [], unidentifiable: 0 }
  if (doc === null || doc === undefined || typeof doc.querySelectorAll !== 'function') return out
  for (const el of doc.querySelectorAll('[data-row-key^="session:"]')) {
    const found = readSidebarRow(el)
    if (found !== null) out.sidebar.push(found)
  }
  for (const el of doc.querySelectorAll('[class*="searchResultRow"]')) {
    const found = readSearchRow(el)
    if (found === null) continue
    if (found.sessionId === null) {
      out.unidentifiable += 1
      continue
    }
    out.search.push(found)
  }
  return out
}
