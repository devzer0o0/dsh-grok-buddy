/**
 * 工作区标题栏增强（独立模块，构建时拼进 widget.js）。
 *
 * 两个功能：
 *   1. 标题栏「只显示活跃会话」开关：活跃语义仍复用 avatar 已经算好的
 *      isActive()（active / dormant），但判定来源不再只有「已渲染的会话行」：
 *      · 已渲染的行 → 读 avatar 的 data-dsgb-tone；
 *      · 折叠文件夹里的会话（宿主根本不渲染这些行）→ 查宿主全量成员表
 *        workspaces.json 的 members（workspace.sessionIds 是归属的权威来源），
 *        再让 widget 用同一套 displayOf + isActive 判定（不看 DOM）。
 *      筛选期间临时展开「有活跃会话却折叠着」的文件夹，关闭筛选时折回；
 *      用户亲手点过的文件夹不接管。
 *   2. 调色板里的「新建文件夹自动配色」开关：复用宿主颜色的公开端点，
 *      唯一色由服务端在 colors.json 现有的项目色集合上挑选，已有文件夹一律不动。
 *
 * 本文件没有 import，由 scripts/build.mjs 拼进 lib/widget.js；因此不额外新增
 * 页面脚本路由，也不改动 avatar 的既有生命周期。
 */
(function () {
  'use strict'

  if (typeof window === 'undefined' || typeof document === 'undefined') return

  var SETTINGS_URL = '/dsh-grok-buddy/settings.json'
  var AUTO_COLOR_URL = '/dsh-grok-buddy/auto-color.json'
  var WORKSPACES_URL = '/dsh-grok-buddy/workspaces.json'
  var API_WAIT_MS = 100
  var API_WAIT_MAX_MS = 30000
  var TICK_MS = 500
  var WORKSPACES_POLL_MS = 1500
  var AUTO_RETRY_MS = 5000
  var AUTO_ERROR_THROTTLE_MS = 8000
  /** 展开失败后的退避与次数上限：宿主没响应时不能每 500ms 硬点。 */
  var EXPAND_RETRY_MS = 1200
  var EXPAND_MAX_ATTEMPTS = 4

  var startedAt = Date.now()
  var stopped = false
  var api = null
  var settings = { autoColorNewFolders: false, baselineComplete: false, knownWorkspaces: [] }
  var settingsLoaded = false
  var settingsSaving = false
  var baselinePending = false
  var known = new Set()
  var autoPending = new Set()
  var autoRetry = new Map()
  var workspaces = { loaded: false, available: false, ids: [], members: [], hasMembers: false, membersReady: false, error: '' }
  /** workspaceId → 该文件夹里有没有活跃会话（来自宿主全量成员表，与展开无关）。 */
  var memberActive = new Map()
  /** 归属可信的 workspaceId（未知归属不能当成空文件夹）。 */
  var memberKnown = new Set()
  /** 未分组（空 key）的归属是否可信 —— 成员表全部已知时才成立。 */
  var ungroupedKnown = false
  /** 我们替用户展开的文件夹（关筛选时折回）。 */
  var autoExpanded = new Set()
  /**
   * 用户在**本轮筛选启用期间**亲手收起/展开过的文件夹：插件不再接管。
   * 只在 activeOnly 期间记录，并在关闭筛选完成折回后整体清空 ——
   * 不把筛选关闭期间的折叠、或上一轮的记录带进下一轮。
   */
  var userToggled = new Set()
  /** workspaceId → { at, count }：展开退避（每轮重置）。 */
  var expandAttempts = new Map()
  var workspacesLoading = false
  var lastWorkspacesPoll = 0
  var autoStatusText = ''
  var settingsRetry = null
  var activeOnly = false
  var headerEl = null
  var headerButton = null
  var styleEl = null
  var observer = null
  var timer = null
  var startTimer = null
  var frame = 0
  var lastAutoErrorAt = 0


  // ── 样式 ────────────────────────────────────────────────────────────────

  function injectStyle() {
    if (styleEl !== null) return
    styleEl = document.createElement('style')
    styleEl.setAttribute('data-dsgb-workspace-chrome', 'style')
    styleEl.textContent = [
      '.dsgb-active-toggle{' +
        'box-sizing:border-box;width:28px;height:28px;flex:none;display:inline-flex;align-items:center;' +
        'justify-content:center;margin:0 0 0 auto;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);' +
        'background:transparent;color:var(--dsw-alias-label-secondary,#5f6368);cursor:pointer}' ,
      '.dsgb-active-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dsgb-active-toggle[aria-pressed="true"]{' +
        'color:var(--dsw-alias-state-business-primary,#1084fe);' +
        'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dsgb-active-toggle:focus-visible{' +
        'outline:var(--dsw-focus-ring-width,2px) solid ' +
        'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#1084fe));outline-offset:-2px}',
      '.dsgb-active-toggle svg{display:block;pointer-events:none}',
      // 按钮插在 searchSlot 之前；取消它的 auto margin，避免和按钮之间出现一段空白。
      '[data-dsgb-chrome-header] [class*="searchSlot"]{margin-left:0!important}',
      // 搜索展开时把整条标题栏交给宿主，别和输入框抢位置。
      '[data-dsgb-chrome-header]:has([class*="searchExpanded"]) .dsgb-active-toggle{display:none}',
      'html[data-dsgb-active-only="1"] [data-row-key^="session:"][data-dsgb-active="false"]{display:none!important}',
      'html[data-dsgb-active-only="1"] [class*="groupSection"][data-dsgb-active-empty="1"]{display:none!important}',
      '.dsgb-palette{max-height:calc(100vh - 16px);overflow-y:auto}',
      '.dsgb-auto-color{' +
        'margin-top:10px;padding-top:9px;border-top:1px solid rgba(127,127,127,.22);' +
        'font:12px/17px "PingFang SC",system-ui,sans-serif}',
      '.dsgb-auto-color label{display:flex;align-items:center;gap:7px;cursor:pointer}',
      '.dsgb-auto-color input{width:14px;height:14px;margin:0;flex:none;accent-color:var(--dsw-alias-state-business-primary,#1084fe)}',
      '.dsgb-auto-hint{font-size:11px;line-height:15px;opacity:.55;margin:3px 0 0 21px}',
      '.dsgb-auto-status{font-size:11px;line-height:15px;color:#ff263c;margin:2px 0 0 21px;min-height:0}',
      '.dsgb-auto-error{' +
        'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483001;' +
        'max-width:min(520px,calc(100vw - 32px));padding:8px 14px;border-radius:8px;' +
        'background:rgba(20,22,26,.92);color:#fff;font:13px/18px "PingFang SC",system-ui,sans-serif;' +
        'box-shadow:0 6px 20px rgba(0,0,0,.28)}',
      '@media (prefers-reduced-motion:reduce){.dsgb-active-toggle{transition:none}}',
    ].join('\n')
    document.head.appendChild(styleEl)
  }


  // ── 标题栏开关 ──────────────────────────────────────────────────────────

  function findHeader() {
    var labels = document.querySelectorAll('[class*="sectionLabel"]')
    var fallback = null
    for (var i = 0; i < labels.length; i += 1) {
      var label = labels[i]
      var header = label.closest('[class*="sectionHeader"]')
      if (header === null) continue
      if (fallback === null && header.querySelector('[class*="searchSlot"]') !== null) fallback = header
      var text = (label.textContent || '').replace(/\s+/g, ' ').trim()
      if (/工作区|^Workspaces?$/i.test(text)) return header
    }
    if (fallback !== null) return fallback
    var headers = document.querySelectorAll('[class*="sectionHeader"]')
    for (var j = 0; j < headers.length; j += 1) {
      if (headers[j].querySelector('[class*="searchSlot"]') !== null) return headers[j]
    }
    return null
  }

  function toggleIcon() {
    return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">' +
      '<path d="M1.5 8.2h3.1l1.9-4.4 3 8.4 1.8-4h3.2" fill="none" stroke="currentColor" ' +
      'stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  }

  function updateHeaderButton() {
    if (headerButton === null) return
    var pressed = activeOnly ? 'true' : 'false'
    if (headerButton.getAttribute('aria-pressed') !== pressed) headerButton.setAttribute('aria-pressed', pressed)
    var label = '只显示活跃会话'
    if (headerButton.getAttribute('aria-label') !== label) headerButton.setAttribute('aria-label', label)
    var title = activeOnly
      ? '只显示活跃会话（已开启，点击显示全部）'
      : '只显示活跃会话（点击隐藏非活跃会话）'
    if (headerButton.title !== title) headerButton.title = title
  }

  function toggleActiveOnly() {
    activeOnly = !activeOnly
    if (activeOnly) {
      // 新一轮筛选：上一轮的用户控制/重试记录全部作废，重新按当前事实接管。
      // 普通模式下的折叠/展开从不写这些记录，所以不会带进这一轮。
      userToggled.clear()
      autoExpanded.clear()
      expandAttempts.clear()
      pendingToggle.clear()
      if (document.documentElement.getAttribute('data-dsgb-active-only') !== '1') {
        document.documentElement.setAttribute('data-dsgb-active-only', '1')
      }
    } else {
      if (document.documentElement.hasAttribute('data-dsgb-active-only')) {
        document.documentElement.removeAttribute('data-dsgb-active-only')
      }
      // 关闭筛选：先撤掉过滤属性，再把插件临时展开的文件夹折回。
      // 展开状态是宿主的前端本地状态，插件不留任何持久改动。
      applyFilter()
      restoreExpansion()
      // 折回完成 → 这一轮周期结束，用户控制记录不带到下一轮。
      userToggled.clear()
    }
    updateHeaderButton()
    if (activeOnly) applyFilter()
  }

  function ensureHeaderButton() {
    if (stopped) return
    var header = findHeader()
    if (header === null) return
    if (header !== headerEl) {
      if (headerEl !== null && headerEl.hasAttribute('data-dsgb-chrome-header')) headerEl.removeAttribute('data-dsgb-chrome-header')
      headerEl = header
      if (!headerEl.hasAttribute('data-dsgb-chrome-header')) headerEl.setAttribute('data-dsgb-chrome-header', '1')
      headerButton = null
    }
    var button = header.querySelector('.dsgb-active-toggle')
    if (button === null) {
      button = document.createElement('button')
      button.type = 'button'
      button.className = 'dsgb-active-toggle'
      button.setAttribute('data-dsgb-active-toggle', '1')
      button.innerHTML = toggleIcon()
      button.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        toggleActiveOnly()
      })
      var search = header.querySelector('[class*="searchSlot"]')
      if (search !== null) header.insertBefore(button, search)
      else header.appendChild(button)
    }
    headerButton = button
    updateHeaderButton()
  }

  // ── 活跃过滤 ────────────────────────────────────────────────────────────

  /**
   * 已渲染行的活跃语义：widget 已经按 isActive() 把结果写在 avatar 的
   * data-dsgb-tone（active / dormant）上。这里只读，不重新判断。
   */
  function rowIsActive(row) {
    var bot = row.querySelector('.dsgb-bot')
    var tone = bot === null ? null : bot.getAttribute('data-dsgb-tone')
    if (tone === 'active') return true
    // tone 可能落后一个轮询；宿主的选中状态永远算活跃，避免把当前行藏掉。
    if (row.getAttribute('aria-selected') === 'true') return true
    return false
  }

  /** 取类名字符串（SVG 的 className 是对象）。 */
  function classOf(node) {
    if (node === null || node === undefined) return ''
    var cls = node.className
    if (typeof cls === 'string') return cls
    if (cls !== null && typeof cls === 'object' && typeof cls.baseVal === 'string') return cls.baseVal
    return ''
  }

  /** 项目行 data-row-key="workspace:<id>" → id；不是项目行返回 null。 */
  function workspaceIdOfRow(row) {
    if (row === null || row === undefined || typeof row.getAttribute !== 'function') return null
    var key = row.getAttribute('data-row-key')
    if (typeof key !== 'string' || key.indexOf('workspace:') !== 0) return null
    return key.slice('workspace:'.length)
  }

  /** 分区**自己的**项目行（跳过嵌套分区里的那些）。 */
  function sectionRowOf(section) {
    if (section === null || section === undefined) return null
    var rows = section.querySelectorAll('[data-row-key^="workspace:"]')
    for (var i = 0; i < rows.length; i += 1) {
      var cursor = rows[i].parentElement
      var owner = null
      for (var depth = 0; cursor !== null && cursor !== undefined && depth < 12; depth += 1) {
        if (/groupSection/.test(classOf(cursor))) {
          owner = cursor
          break
        }
        cursor = cursor.parentElement
      }
      if (owner === section) return rows[i]
    }
    return null
  }

  /** 按 workspaceId 找当前渲染出来的项目行。 */
  function findWorkspaceRow(workspaceId) {
    var rows = document.querySelectorAll('[data-row-key^="workspace:"]')
    for (var i = 0; i < rows.length; i += 1) {
      if (workspaceIdOfRow(rows[i]) === workspaceId) return rows[i]
    }
    return null
  }

  /**
   * 用宿主全量成员表重算「每个文件夹里有没有活跃会话」。
   *
   * 这一步**完全不看 DOM**：折叠的文件夹没有子行，但 workspace.sessionIds 里
   * 的会话仍然存在。判定交给 widget 的 api.activity()，它走的是与头像完全
   * 相同的 semanticOf → displayOf → isActive 链路，不新增状态规则。
   */
  function refreshMemberActivity() {
    if (stopped) return
    if (!workspaces.hasMembers || api === null || typeof api.activity !== 'function') {
      if (memberActive.size > 0) memberActive.clear()
      if (memberKnown.size > 0) memberKnown.clear()
      ungroupedKnown = false
      return
    }
    var all = []
    var assigned = new Set()
    // 只有**每一条**都真的给出 sessionIds，未分组集合才算确定；
    // 任何一条归属未知，就不能把「不在已知成员里」当成「未分组」。
    var allKnown = workspaces.members.length > 0
    for (var i = 0; i < workspaces.members.length; i += 1) {
      var memberEntry = workspaces.members[i]
      if (memberEntry.known !== true) {
        allKnown = false
        continue
      }
      var list = memberEntry.sessionIds
      for (var j = 0; j < list.length; j += 1) {
        all.push(list[j])
        assigned.add(list[j])
      }
    }
    // 未分组：宿主把「不属于任何 workspace」的会话放进 key 为空的分组。
    // 归属仍以成员表为准 —— 登记表里有、但不在任何 sessionIds 里的才候选。
    var unassigned = []
    var trackedOk = false
    if (typeof api.knownSessions === 'function') {
      var tracked = []
      try {
        tracked = api.knownSessions()
      } catch (err) {
        tracked = []
      }
      if (Array.isArray(tracked)) {
        trackedOk = true
        for (var t = 0; t < tracked.length; t += 1) {
          var id = tracked[t]
          if (typeof id === 'string' && id !== '' && !assigned.has(id)) unassigned.push(id)
        }
      }
    }
    var facts
    try {
      facts = api.activity(all.concat(unassigned))
    } catch (err) {
      return
    }
    if (facts === null || typeof facts !== 'object') return
    memberActive.clear()
    memberKnown.clear()
    for (var m = 0; m < workspaces.members.length; m += 1) {
      var member = workspaces.members[m]
      // 归属未知的条目**不写结论**：memberActive 里没有它，页面据此保持可见。
      if (member.known !== true) continue
      memberKnown.add(member.workspaceId)
      var active = false
      for (var n = 0; n < member.sessionIds.length; n += 1) {
        var fact = facts[member.sessionIds[n]]
        if (fact !== undefined && fact !== null && fact.active === true) {
          active = true
          break
        }
      }
      memberActive.set(member.workspaceId, active)
    }
    // 未分组（data-row-key="workspace:"，id 为空串）：只有成员表全部已知
    // 且登记表可读时，才能确定「谁不属于任何文件夹」—— 否则是未知，保持可见。
    ungroupedKnown = allKnown && trackedOk
    if (ungroupedKnown) {
      var ungroupedActive = false
      for (var u = 0; u < unassigned.length; u += 1) {
        var rowFact = facts[unassigned[u]]
        if (rowFact !== undefined && rowFact !== null && rowFact.active === true) {
          ungroupedActive = true
          break
        }
      }
      memberActive.set('', ungroupedActive)
    }
  }

  /** 程序化点击（展开/折回）期间不把这次点击记成「用户亲手切换」。 */
  var programmatic = false
  /**
   * 用户刚点过、还没判定完的行：workspaceId → 点击前的 aria-expanded。
   *
   * 宿主的展开状态由 React 在事件回调之后才渲染，点击那一刻读不到新值，
   * 所以这里先挂起，等下一帧再比对「到底变没变」。挂起期间不允许自动展开
   * 这一行，避免「用户折叠 → 我们立刻又展开」的闪烁。
   */
  var pendingToggle = new Map()

  function clickRow(row) {
    programmatic = true
    try {
      row.click()
    } catch (err) {}
    programmatic = false
  }

  /** 下一帧（渲染提交之后）执行；没有 rAF 时退回 setTimeout。 */
  function nextFrame(fn) {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn)
    else setTimeout(fn, 16)
  }

  /**
   * 把「有活跃会话却折叠着」的文件夹临时展开。
   *
   * 只点宿主自己的项目行（onToggle），不伪造展开状态。
   * 未分组分区（data-row-key="workspace:"，id 为空串）在宿主里同样是一个
   * 可折叠的 treeitem（UngroupedProjectRow 走同一个 ProjectRow，带
   * role=treeitem / aria-expanded / onClick:onToggle），所以这里**不排除空 key**：
   * 它一旦被检测到有活跃会话，也要临时展开，否则就是「检测到了却永远不展示」。
   *
   * 不接管的三种情况：本轮筛选里用户亲手切换过、刚点过还在等渲染结果
   * （pendingToggle）、以及重试次数用尽。
   */
  function expandForActive() {
    if (stopped || !activeOnly) return
    var rows = document.querySelectorAll('[data-row-key^="workspace:"]')
    var now = Date.now()
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i]
      var workspaceId = workspaceIdOfRow(row)
      // null = 不是项目行；空串是合法的「未分组」分组，不能跳过。
      if (workspaceId === null) continue
      if (row.getAttribute('aria-expanded') !== 'false') {
        // 已经展开（含我们自己展开成功）：把退避计数清掉，
        // 这样它以后再次被折叠时仍能被重新展开。
        if (autoExpanded.has(workspaceId)) expandAttempts.delete(workspaceId)
        continue
      }
      if (memberActive.get(workspaceId) !== true) continue
      if (userToggled.has(workspaceId)) continue
      // 用户刚点过这一行：等下一帧的 aria-expanded 比对结果，别抢在中间展开。
      if (pendingToggle.has(workspaceId)) continue
      var attempt = expandAttempts.get(workspaceId)
      if (attempt !== undefined) {
        if (attempt.count >= EXPAND_MAX_ATTEMPTS) continue
        if (now - attempt.at < EXPAND_RETRY_MS) continue
      }
      expandAttempts.set(workspaceId, { at: now, count: attempt === undefined ? 1 : attempt.count + 1 })
      autoExpanded.add(workspaceId)
      clickRow(row)
    }
  }

  /**
   * 关闭筛选时把我们替用户展开的文件夹折回。
   *
   * 只折回「仍然展开着、且不是用户在本轮里亲手切换过」的那些 —— 用户自己
   * 展开的、或用户在我们展开后又手动折叠的，都不动。未分组的空 key 同样处理。
   */
  function restoreExpansion() {
    if (autoExpanded.size === 0) {
      expandAttempts.clear()
      pendingToggle.clear()
      return
    }
    var ids = []
    autoExpanded.forEach(function (id) {
      ids.push(id)
    })
    autoExpanded.clear()
    expandAttempts.clear()
    pendingToggle.clear()
    for (var i = 0; i < ids.length; i += 1) {
      var workspaceId = ids[i]
      if (userToggled.has(workspaceId)) continue
      var row = findWorkspaceRow(workspaceId)
      if (row === null) continue
      if (row.getAttribute('aria-expanded') !== 'true') continue
      clickRow(row)
    }
  }

  /**
   * 用户动手点了项目行 —— 但**是不是真的切换了展开状态，要等渲染后才知道**。
   *
   * 宿主是 React：onClick 里只 setState，aria-expanded 要下一次提交才更新，
   * 点的那一瞬间读到的还是旧值。所以这里只把「点击前值」挂起，下一帧再比对：
   *   · 变了  → 这确实是用户亲手切换，本文件夹让出控制权；
   *   · 没变  → 只是点了 ⋯ 菜单 / 新建按钮之类的行内控件，不算切换。
   * 只在 activeOnly 期间记录 —— 普通模式下的折叠/展开不进入这一轮的控制记录。
   */
  function onDocumentClick(event) {
    if (stopped || programmatic || !activeOnly) return
    var target = event.target
    if (target === null || target === undefined || typeof target.closest !== 'function') return
    var row = target.closest('[data-row-key^="workspace:"]')
    if (row === null) return
    // 不按「点的是不是行内按钮」猜：⋯ 菜单、新建按钮是否也触发 onToggle
    // 由宿主决定，猜错就会漏记用户操作。这里只认**实际结果** ——
    // 事件前后 aria-expanded 真的变了才算用户切换。
    var workspaceId = workspaceIdOfRow(row)
    if (workspaceId === null) return
    pendingToggle.set(workspaceId, { row: row, before: row.getAttribute('aria-expanded') })
    // 宿主是 React：setState 之后要等提交才写 aria-expanded。等两帧仍没变，
    // 才认定这次点击没有改变展开状态（例如只是打开了 ⋯ 菜单）。
    // 读值一律按 workspaceId 找**当前**的行：React 可能已把节点换掉，
    // 盯着旧节点会永远读不到新值，从而漏记用户的切换。
    var settle = function (left) {
      var pending = pendingToggle.get(workspaceId)
      if (pending === undefined) return
      if (stopped || !activeOnly) {
        pendingToggle.delete(workspaceId)
        return
      }
      var live = findWorkspaceRow(workspaceId)
      var after = (live === null ? pending.row : live).getAttribute('aria-expanded')
      if (after === pending.before) {
        if (left > 0) {
          nextFrame(function () {
            settle(left - 1)
          })
          return
        }
        pendingToggle.delete(workspaceId)
        return
      }
      pendingToggle.delete(workspaceId)
      // 真的变了：本轮里这个文件夹的展开状态归用户。
      userToggled.add(workspaceId)
      autoExpanded.delete(workspaceId)
      expandAttempts.delete(workspaceId)
    }
    nextFrame(function () {
      settle(1)
    })
  }

  function applyFilter() {
    if (stopped) return
    if (!activeOnly) {
      var offRows = document.querySelectorAll('[data-row-key^="session:"]')
      for (var a = 0; a < offRows.length; a += 1) {
        if (offRows[a].hasAttribute('data-dsgb-active')) offRows[a].removeAttribute('data-dsgb-active')
      }
      var offGroups = document.querySelectorAll('[class*="groupSection"]')
      for (var b = 0; b < offGroups.length; b += 1) {
        if (offGroups[b].hasAttribute('data-dsgb-active-empty')) offGroups[b].removeAttribute('data-dsgb-active-empty')
      }
      return
    }
    refreshMemberActivity()
    var rows = document.querySelectorAll('[data-row-key^="session:"]')
    var sections = new Map()
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i]
      var active = rowIsActive(row)
      var next = active ? 'true' : 'false'
      if (row.getAttribute('data-dsgb-active') !== next) row.setAttribute('data-dsgb-active', next)
      var section = row.closest('[class*="groupSection"]')
      if (section !== null) {
        if (!sections.has(section)) sections.set(section, false)
        if (active) sections.set(section, true)
      }
    }
    var groups = document.querySelectorAll('[class*="groupSection"]')
    for (var j = 0; j < groups.length; j += 1) {
      var group = groups[j]
      var groupActive = sections.get(group) === true
      // 折叠分区没有子行，但成员表知道它按住哪些会话 —— 这里补上判定。
      // 未分组分区的 data-row-key 是 "workspace:"（id 为空串），同样要查成员表。
      var projectRow = sectionRowOf(group)
      var groupWorkspaceId = projectRow === null ? null : workspaceIdOfRow(projectRow)
      if (!groupActive && groupWorkspaceId !== null && memberActive.get(groupWorkspaceId) === true) {
        groupActive = true
      }
      if (!groupActive) {
        // 「归属未知」≠「确定为空」：读不到成员表、条目没给 sessionIds、
        // 或未分组集合无法确定时，一律保持可见 —— 宁可多显示，也不能因为
        // 读不到归属就把折叠文件夹全判成空。
        var ownershipKnown =
          groupWorkspaceId === null
            ? false
            : groupWorkspaceId === ''
              ? ungroupedKnown
              : memberKnown.has(groupWorkspaceId)
        if (!ownershipKnown && !sections.has(group)) {
          if (group.hasAttribute('data-dsgb-active-empty')) group.removeAttribute('data-dsgb-active-empty')
          continue
        }
        // 没有会话行的叶分组（空 Workspace）也属于「没有活跃会话」；
        // 但带嵌套 groupSection 的容器不能一起隐藏，否则会连带隐藏里面的活跃分组。
        if (group.querySelector('[class*="groupSection"]') !== null) {
          if (group.hasAttribute('data-dsgb-active-empty')) group.removeAttribute('data-dsgb-active-empty')
        } else if (group.getAttribute('data-dsgb-active-empty') !== '1') {
          group.setAttribute('data-dsgb-active-empty', '1')
        }
        continue
      }
      if (group.hasAttribute('data-dsgb-active-empty')) group.removeAttribute('data-dsgb-active-empty')
    }
    expandForActive()
  }


  // ── 设置与自动配色 ──────────────────────────────────────────────────────

  function applySettings(body) {
    if (body === null || typeof body !== 'object') return
    var data = body.settings !== null && typeof body.settings === 'object' ? body.settings : body
    settings.autoColorNewFolders = data.autoColorNewFolders === true
    settings.baselineComplete = data.baselineComplete === true
    var list = Array.isArray(data.knownWorkspaces) ? data.knownWorkspaces : []
    for (var i = 0; i < list.length; i += 1) {
      var id = list[i]
      if (typeof id === 'string' && id !== '') known.add(id)
    }
  }

  function postJson(url, payload, done) {
    fetch(url, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return {}
          })
          .then(function (body) {
            if (!response.ok) {
              var error = new Error(body !== null && typeof body === 'object' && typeof body.error === 'string'
                ? body.error
                : 'HTTP ' + response.status)
              error.status = response.status
              throw error
            }
            return body
          })
      })
      .then(function (body) {
        done(true, body)
      })
      .catch(function (error) {
        done(false, error)
      })
  }

  function loadSettings() {
    if (stopped) return
    if (settingsRetry !== null) {
      clearTimeout(settingsRetry)
      settingsRetry = null
    }
    fetch(SETTINGS_URL, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) {
        return response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))
      })
      .then(function (body) {
        if (stopped) return
        applySettings(body)
        settingsLoaded = true
        setAutoStatus('')
        updatePaletteToggle()
        maybeBaseline()
      })
      .catch(function () {
        if (stopped) return
        settingsRetry = setTimeout(loadSettings, 5000)
      })
  }

  /**
   * 唯一的新建/基线来源：宿主全量 Workspace 列表。页面不再从 DOM 推断新建，
   * 也不使用 600ms 稳定窗口；列表不可用时自动配色不执行。
   */
  function fetchWorkspaceIds() {
    return fetch(WORKSPACES_URL, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return {}
          })
          .then(function (body) {
            if (!response.ok) {
              var error = new Error(body !== null && typeof body === 'object' && typeof body.error === 'string'
                ? body.error
                : 'HTTP ' + response.status)
              error.status = response.status
              throw error
            }
            if (body === null || typeof body !== 'object' || body.available !== true || !Array.isArray(body.workspaces)) {
              throw new Error(body !== null && typeof body === 'object' && typeof body.error === 'string'
                ? body.error
                : '宿主未提供 Workspace 全量列表，自动配色不可用。')
            }
            var ids = []
            var seen = new Set()
            for (var i = 0; i < body.workspaces.length; i += 1) {
              var id = body.workspaces[i]
              if (typeof id !== 'string' || id === '' || seen.has(id)) continue
              seen.add(id)
              ids.push(id)
            }
            // members 是宿主 registry 的 workspace.sessionIds 投影 ——
            // 「哪个会话属于哪个文件夹」的权威来源，与侧栏有没有渲染子行无关。
            //
            // 每条都带 known：只有宿主真的给出 sessionIds 数组，才能说「这个文件夹
            // 按住这些会话」；known=false 表示归属未知。未知**不是**空文件夹 ——
            // 页面必须把它保持可见，绝不能因为读不到就判空隐藏。
            var members = []
            var hasMembers = Array.isArray(body.members)
            var allKnown = hasMembers && body.members.length > 0
            if (hasMembers) {
              for (var j = 0; j < body.members.length; j += 1) {
                var entry = body.members[j]
                if (entry === null || typeof entry !== 'object') continue
                if (typeof entry.workspaceId !== 'string' || entry.workspaceId === '') continue
                // 新宿主显式给 known；旧宿主没有该字段时，数组本身就是可信信号。
                var known = typeof entry.known === 'boolean' ? entry.known === true : Array.isArray(entry.sessionIds)
                if (!known) allKnown = false
                var list = known && Array.isArray(entry.sessionIds) ? entry.sessionIds : []
                var sessionIds = []
                for (var k = 0; k < list.length; k += 1) {
                  var sessionId = list[k]
                  if (typeof sessionId !== 'string' || sessionId === '') continue
                  sessionIds.push(sessionId)
                }
                members.push({ workspaceId: entry.workspaceId, sessionIds: sessionIds, known: known })
              }
            }
            var membersReady = typeof body.membersReady === 'boolean' ? body.membersReady === true : allKnown
            // 服务端说就绪、但条目自己不可信时以条目为准 —— 两个信号取更保守的那个。
            if (!allKnown) membersReady = false
            return { ids: ids, members: members, hasMembers: hasMembers, membersReady: membersReady }
          })
      })
  }

  function loadWorkspaces() {
    if (stopped || workspacesLoading) return
    workspacesLoading = true
    fetchWorkspaceIds()
      .then(function (roster) {
        workspacesLoading = false
        if (stopped) return
        workspaces.loaded = true
        workspaces.available = true
        workspaces.ids = roster.ids
        workspaces.members = roster.members
        workspaces.hasMembers = roster.hasMembers
        workspaces.error = ''
        updatePaletteToggle()
        maybeBaseline()
        reconcileFolders()
        refreshMemberActivity()
      })
      .catch(function (error) {
        workspacesLoading = false
        if (stopped) return
        workspaces.loaded = true
        workspaces.available = false
        workspaces.ids = []
        workspaces.members = []
        workspaces.hasMembers = false
        memberActive.clear()
        workspaces.error = '读取 Workspace 全量列表失败：' + (error !== null && error !== undefined && error.message !== undefined ? error.message : '请稍后重试')
        updatePaletteToggle()
      })
  }

  function maybeBaseline() {
    if (stopped || !settingsLoaded || !workspaces.loaded || baselinePending) return
    if (settings.autoColorNewFolders && settings.baselineComplete !== true) {
      if (workspaces.available) baselineCurrent()
      return
    }
  }

  /**
   * 把宿主全量列表里的当前 Workspace 全部记为基线；这一步只写 known，
   * 不改任何文件夹颜色。写盘失败时保持 baselinePending，绝不先落色。
   */
  function baselineCurrent() {
    if (stopped || baselinePending || !workspaces.available) return
    var ids = workspaces.ids.slice()
    baselinePending = true
    // 基线写盘成功之前，本地也必须视为「未建立」；否则失败后的 3s 重试窗口
    // 里 reconcile 会误以为基线已完成而开始落色。
    settings.baselineComplete = false
    postJson(SETTINGS_URL, { knownWorkspaces: ids, baselineComplete: true }, function (ok) {
      if (stopped) return
      if (ok) {
        baselinePending = false
        settings.baselineComplete = true
        for (var i = 0; i < ids.length; i += 1) known.add(ids[i])
        updatePaletteToggle()
        scheduleTick()
        return
      }
      // 基线没写进去之前绝不开始自动配色。
      settingsRetry = setTimeout(function () {
        baselinePending = false
        baselineCurrent()
      }, 3000)
    })
  }

  function statusText() {
    if (!settingsLoaded) return '正在读取设置…'
    if (!workspaces.loaded) return '正在读取 Workspace 全量列表…'
    if (!workspaces.available) return workspaces.error !== '' ? workspaces.error : '宿主未提供 Workspace 全量列表，自动配色不可用。'
    return autoStatusText
  }

  function renderAutoStatus() {
    var text = statusText()
    var nodes = document.querySelectorAll('.dsgb-auto-status')
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].textContent !== text) nodes[i].textContent = text
    }
  }

  function setAutoStatus(text) {
    autoStatusText = text
    renderAutoStatus()
  }

  function updatePaletteToggle() {
    var inputs = document.querySelectorAll('.dsgb-auto-color input[type="checkbox"]')
    var nextChecked = settings.autoColorNewFolders
    // 已开启时永远允许关闭；只有「从关到开」才要求全量列表已就绪。
    var canToggle = settings.autoColorNewFolders || (workspaces.loaded && workspaces.available)
    var nextDisabled = !settingsLoaded || settingsSaving || !canToggle
    for (var i = 0; i < inputs.length; i += 1) {
      // 保存中保留用户刚点的勾选状态；等请求回来再按真实设置校正。
      if (!settingsSaving && inputs[i].checked !== nextChecked) inputs[i].checked = nextChecked
      if (inputs[i].disabled !== nextDisabled) inputs[i].disabled = nextDisabled
    }
    renderAutoStatus()
  }

  function ensurePaletteToggle() {
    if (stopped) return
    var palette = document.querySelector('.dsgb-palette')
    if (palette === null) return
    if (palette.querySelector('.dsgb-auto-color') !== null) {
      updatePaletteToggle()
      return
    }
    var suffix = Math.random().toString(36).slice(2, 8)
    var hintId = 'dsgb-auto-hint-' + suffix
    var wrap = document.createElement('div')
    wrap.className = 'dsgb-auto-color'
    var label = document.createElement('label')
    var input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('aria-describedby', hintId)
    var text = document.createElement('span')
    text.textContent = '新建文件夹自动配色（全局）'
    label.appendChild(input)
    label.appendChild(text)
    var hint = document.createElement('div')
    hint.className = 'dsgb-auto-hint'
    hint.id = hintId
    hint.textContent = '开启后，只对宿主全量 Workspace 列表中基线上不存在的新文件夹随机分配未被占用的颜色；已有文件夹不变。关闭后恢复原来的新建行为。'
    var status = document.createElement('div')
    status.className = 'dsgb-auto-status'
    status.setAttribute('role', 'status')
    wrap.appendChild(label)
    wrap.appendChild(hint)
    wrap.appendChild(status)
    input.addEventListener('change', function () {
      setAutoColor(input.checked, input)
    })
    var reset = palette.querySelector('.dsgb-palette-reset')
    if (reset !== null && reset.parentNode === palette) palette.insertBefore(wrap, reset)
    else palette.appendChild(wrap)
    updatePaletteToggle()
  }

  function setAutoColor(enabled, input) {
    if (!settingsLoaded || settingsSaving) return

    function fail(message) {
      settingsSaving = false
      baselinePending = false
      if (input !== null && input !== undefined) input.checked = !enabled
      updatePaletteToggle()
      showAutoError(message)
    }

    if (!enabled) {
      settingsSaving = true
      updatePaletteToggle()
      postJson(SETTINGS_URL, { autoColorNewFolders: false }, function (ok, body) {
        if (stopped) return
        if (ok) {
          settingsSaving = false
          applySettings(body)
          setAutoStatus('')
          updatePaletteToggle()
          return
        }
        fail('自动配色设置保存失败：' + (body !== null && body !== undefined && body.message ? body.message : '请稍后重试'))
      })
      return
    }

    // 开启必须拿一次**当前**全量列表：缓存最多 1.5s，期间新建/删除的 Workspace
    // 不能靠旧快照当基线。
    settingsSaving = true
    updatePaletteToggle()
    fetchWorkspaceIds()
      .then(function (ids) {
        if (stopped) return
        workspaces.loaded = true
        workspaces.available = true
        workspaces.ids = ids
        workspaces.error = ''
        baselinePending = true
        postJson(SETTINGS_URL, { autoColorNewFolders: true, knownWorkspaces: ids, baselineComplete: true }, function (ok, body) {
          if (stopped) return
          settingsSaving = false
          if (ok) {
            applySettings(body)
            for (var i = 0; i < ids.length; i += 1) known.add(ids[i])
            settings.baselineComplete = true
            baselinePending = false
            setAutoStatus('')
            updatePaletteToggle()
            scheduleTick()
            return
          }
          fail('自动配色设置保存失败：' + (body !== null && body !== undefined && body.message ? body.message : '请稍后重试'))
        })
      })
      .catch(function (error) {
        if (stopped) return
        fail('无法读取 Workspace 全量列表，未开启自动配色：' + (error !== null && error !== undefined && error.message !== undefined ? error.message : '请稍后重试'))
      })
  }

  function showAutoError(message) {
    var now = Date.now()
    if (now - lastAutoErrorAt < AUTO_ERROR_THROTTLE_MS) return
    lastAutoErrorAt = now
    if (stopped) return
    setAutoStatus(message)
    if (document.querySelector('.dsgb-auto-status') !== null) return
    var toast = document.createElement('div')
    toast.className = 'dsgb-auto-error'
    toast.setAttribute('role', 'alert')
    toast.textContent = message
    document.body.appendChild(toast)
    setTimeout(function () {
      if (toast.parentNode !== null) toast.parentNode.removeChild(toast)
    }, 6000)
  }

  function assignAutoColor(workspaceId) {
    if (stopped || autoPending.has(workspaceId)) return
    autoPending.add(workspaceId)
    postJson(AUTO_COLOR_URL, { workspaceId: workspaceId }, function (ok, body) {
      if (stopped) return
      autoPending.delete(workspaceId)
      if (ok && body !== null && typeof body === 'object' && body.ok === true) {
        known.add(workspaceId)
        autoRetry.delete(workspaceId)
        // 只有真的新落色才补 sync；existing/skipped 不会再改文件夹外观。
        if (body.existing !== true && body.skipped !== true) {
          setTimeout(function () {
            if (stopped || api === null || typeof api.sync !== 'function') return
            try {
              api.sync()
            } catch (err) {}
          }, 1700)
        }
        return
      }
      var wait = body !== null && typeof body === 'object' && body.status === 409 ? 30000 : AUTO_RETRY_MS
      autoRetry.set(workspaceId, Date.now() + wait)
      // 服务端说基线未建立而本地以为是 true：说明两边写盘不一致，先重建基线。
      if (body !== null && typeof body === 'object' && body.status === 409 &&
        typeof body.message === 'string' && body.message.indexOf('基线') !== -1) {
        settings.baselineComplete = false
        maybeBaseline()
      }
      var reason = body !== null && typeof body === 'object'
        ? (typeof body.error === 'string' ? body.error : (typeof body.message === 'string' ? body.message : ''))
        : ''
      showAutoError('新建文件夹自动配色失败：' + (reason !== '' ? reason : '请稍后重试'))
    })
  }

  function reconcileFolders() {
    if (stopped || !settingsLoaded || !workspaces.loaded || !workspaces.available) return
    if (!settings.autoColorNewFolders || baselinePending || settings.baselineComplete !== true) return
    var ids = workspaces.ids
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i]
      if (typeof id !== 'string' || id === '' || known.has(id)) continue
      if (autoPending.has(id)) continue
      var retryAt = autoRetry.get(id)
      if (typeof retryAt === 'number' && retryAt > Date.now()) continue
      assignAutoColor(id)
    }
  }

  // ── 调度 ────────────────────────────────────────────────────────────────

  function tick() {
    if (stopped) return
    ensureHeaderButton()
    ensurePaletteToggle()
    applyFilter()
    if (Date.now() - lastWorkspacesPoll >= WORKSPACES_POLL_MS) {
      lastWorkspacesPoll = Date.now()
      loadWorkspaces()
    }
    reconcileFolders()
  }

  function scheduleTick() {
    if (stopped || frame !== 0) return
    frame = requestAnimationFrame(function () {
      frame = 0
      tick()
    })
  }

  /**
   * 只对宿主变化调度；插件自己的按钮、调色板开关与状态文本不触发自激。
   * class 已从 attributeFilter 移除，classList 写入不会再产生观察回调。
   */
  function onMutations(mutations) {
    if (stopped) return
    for (var i = 0; i < mutations.length; i += 1) {
      var mutation = mutations[i]
      var target = mutation.target
      if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('.dsgb-auto-color') !== null) {
        continue
      }
      if (mutation.type === 'childList') {
        var nodes = []
        var added = mutation.addedNodes
        var removed = mutation.removedNodes
        for (var a = 0; a < added.length; a += 1) nodes.push(added[a])
        for (var r = 0; r < removed.length; r += 1) nodes.push(removed[r])
        var own = nodes.length > 0
        for (var n = 0; n < nodes.length; n += 1) {
          var node = nodes[n]
          if (node === null || node.nodeType !== 1 || node.classList === undefined) {
            own = false
            break
          }
          if (
            !node.classList.contains('dsgb-auto-color') &&
            !node.classList.contains('dsgb-active-toggle') &&
            !node.classList.contains('dsgb-auto-error')
          ) {
            own = false
            break
          }
        }
        if (own) continue
      }
      scheduleTick()
      return
    }
  }

  function onVisibility() {
    if (stopped) return
    if (!document.hidden) {
      scheduleTick()
      if (!settingsLoaded) loadSettings()
      loadWorkspaces()
    }
  }

  function cleanup() {
    if (stopped) return
    // 先折回插件临时展开的文件夹，再摘属性 —— 卸载不留展开副作用。
    restoreExpansion()
    stopped = true
    if (timer !== null) clearInterval(timer)
    timer = null
    if (startTimer !== null) clearTimeout(startTimer)
    startTimer = null
    if (settingsRetry !== null) clearTimeout(settingsRetry)
    settingsRetry = null
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
    if (observer !== null) observer.disconnect()
    observer = null
    document.removeEventListener('visibilitychange', onVisibility)
    document.removeEventListener('click', onDocumentClick, true)
    document.documentElement.removeAttribute('data-dsgb-active-only')
    if (headerButton !== null && headerButton.parentNode !== null) headerButton.parentNode.removeChild(headerButton)
    headerButton = null
    if (headerEl !== null && headerEl.hasAttribute('data-dsgb-chrome-header')) headerEl.removeAttribute('data-dsgb-chrome-header')
    headerEl = null
    var rows = document.querySelectorAll('[data-row-key^="session:"]')
    for (var i = 0; i < rows.length; i += 1) rows[i].removeAttribute('data-dsgb-active')
    var groups = document.querySelectorAll('[class*="groupSection"]')
    for (var j = 0; j < groups.length; j += 1) groups[j].removeAttribute('data-dsgb-active-empty')
    var toggles = document.querySelectorAll('.dsgb-auto-color')
    for (var k = 0; k < toggles.length; k += 1) {
      if (toggles[k].parentNode !== null) toggles[k].parentNode.removeChild(toggles[k])
    }
    var errors = document.querySelectorAll('.dsgb-auto-error')
    for (var m = 0; m < errors.length; m += 1) {
      if (errors[m].parentNode !== null) errors[m].parentNode.removeChild(errors[m])
    }
    if (styleEl !== null) styleEl.remove()
    styleEl = null
  }

  function start() {
    if (stopped) return
    if (document.body === null) {
      document.addEventListener('DOMContentLoaded', start, { once: true })
      return
    }
    injectStyle()
    loadSettings()
    loadWorkspaces()
    ensureHeaderButton()
    ensurePaletteToggle()
    timer = setInterval(tick, TICK_MS)
    observer = new MutationObserver(onMutations)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-dsgb-tone', 'data-row-key', 'aria-selected'],
    })
    document.addEventListener('visibilitychange', onVisibility)
    // 用户亲手点过项目行 → 该文件夹的展开状态归用户，插件不再接管。
    document.addEventListener('click', onDocumentClick, true)
    tick()
  }

  function uiReady() {
    return document.body !== null && document.querySelector('[class*="sectionHeader"]') !== null
  }

  // 真实宿主先渲染出「工作区」标题栏再启动；单元测试桩没有侧栏结构，也不启动。
  function startWhenReady() {
    if (stopped || window.__DSH_TEST__ === true) return
    if (uiReady()) {
      startTimer = null
      start()
      return
    }
    if (Date.now() - startedAt > API_WAIT_MAX_MS) return
    startTimer = setTimeout(startWhenReady, 200)
  }

  function waitForApi() {
    if (stopped) return
    if (window.__DSH_TEST__ === true) return
    if (window.__dshGrokBuddy !== null && typeof window.__dshGrokBuddy === 'object') {
      api = window.__dshGrokBuddy
      var originalStop = api.stop
      if (typeof originalStop === 'function' && api.__dsgbChromeStopWrapped !== true) {
        api.stop = function () {
          cleanup()
          return originalStop.apply(this, arguments)
        }
        api.__dsgbChromeStopWrapped = true
      }
      startWhenReady()
      return
    }
    if (Date.now() - startedAt > API_WAIT_MAX_MS) return
    setTimeout(waitForApi, API_WAIT_MS)
  }

  waitForApi()
})();
