/**
 * 工作区标题栏增强（独立模块，构建时拼进 widget.js）。
 *
 * 三个功能：
 *   1. 标题栏「显示方式」按钮（左键开关过滤，右键选模式）：
 *      · active（默认）—— 只显示进行中的会话与项目；
 *      · recent-with-projects —— 最近 N 个会话 + 它们所属的项目文件夹；
 *      · recent-sessions —— 只显示最近 N 个会话，不显示项目文件夹。
 *      N 由右键菜单里的数字框调整（1..50，默认 5），模式与 N 都存进
 *      settings.json（workspaceDisplayMode / workspaceRecentLimit），重启与
 *      客户端升级都不丢。活跃语义仍复用 avatar 已经算好的
 *      isActive()（active / dormant），但判定来源不再只有「已渲染的会话行」：
 *      · 已渲染的行 → 读 avatar 的 data-dsgb-tone；
 *      · 折叠文件夹里的会话（宿主根本不渲染这些行）→ 查宿主全量成员表
 *        workspaces.json 的 members（workspace.sessionIds 是归属的权威来源），
 *        再让 widget 用同一套 displayOf + isActive 判定（不看 DOM）。
 *      筛选期间临时展开「有活跃会话却折叠着」的文件夹，关闭筛选时折回；
 *      用户亲手点过的文件夹不接管。
 *   2. 调色板里的「新建文件夹自动配色」开关：复用宿主颜色的公开端点，
 *      唯一色由服务端在 colors.json 现有的项目色集合上挑选，已有文件夹一律不动。
 *   3. 调色板里的「最近活动的项目自动置顶」开关：真正的排序在服务端做
 *      （lib/promote.js 调宿主 workspaceRegistry.insertBefore），侧栏由宿主
 *      WorkspaceFeed 推送新顺序后自己重排 —— 这里只负责开关与文案，不碰 DOM 顺序。
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
  var RECENT_URL = '/dsh-grok-buddy/recent.json'
  var API_WAIT_MS = 100
  var API_WAIT_MAX_MS = 30000
  var TICK_MS = 500
  var WORKSPACES_POLL_MS = 1500
  /**
   * 设置的轮询间隔。
   *
   * 设置只在一个页面的内存里加载一次是不够的：同一个宿主可能开多个窗口，
   * 也可能有人直接改了 settings.json，或者从别的窗口改了显示方式。
   * 以前只在启动时读一次，那些改动永远进不来（页面只能靠重载才对上），
   * 所以这里按 5s 轮询一次，和最近列表同一档节奏。
   */
  var SETTINGS_POLL_MS = 5000
  /** 最近会话列表的轮询间隔：比成员表慢一档，它只在 recent 模式下才用得上。 */
  var RECENT_POLL_MS = 5000
  var AUTO_RETRY_MS = 5000
  var AUTO_ERROR_THROTTLE_MS = 8000
  /** 展开失败后的退避与次数上限：宿主没响应时不能每 500ms 硬点。 */
  var EXPAND_RETRY_MS = 1200
  var EXPAND_MAX_ATTEMPTS = 4

  /** 三种显示模式（顺序即右键菜单顺序）。 */
  var MODE_ACTIVE = 'active'
  var MODE_RECENT_PROJECTS = 'recent-with-projects'
  var MODE_RECENT_SESSIONS = 'recent-sessions'
  var MODE_LABELS = [
    { mode: MODE_ACTIVE, text: '显示进行中的项目与会话' },
    { mode: MODE_RECENT_PROJECTS, text: '显示最近活跃的项目与会话' },
    { mode: MODE_RECENT_SESSIONS, text: '显示最近活跃的会话' },
  ]
  var DEFAULT_RECENT_LIMIT = 5
  var MIN_RECENT_LIMIT = 1
  var MAX_RECENT_LIMIT = 50

  var startedAt = Date.now()
  var stopped = false
  var api = null
  var settings = {
    autoColorNewFolders: false,
    autoPromoteActiveWorkspace: true,
    baselineComplete: false,
    workspaceDisplayMode: MODE_ACTIVE,
    workspaceRecentLimit: DEFAULT_RECENT_LIMIT,
    knownWorkspaces: [],
  }
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
  /** workspaceId → 该文件夹按住的会话 id（recent 模式判定用；空 key 是未分组）。 */
  var memberSessions = new Map()
  /** workspaceId → 该文件夹里有没有「最近 N 个」里的会话。 */
  var memberRecent = new Map()
  /** 最近会话：{ loaded, available, ids, at }。 */
  var recent = { loaded: false, available: false, ids: [], at: 0 }
  var recentSet = new Set()
  /**
   * workspaceId → 该文件夹**自己**最近的那个会话 id。
   *
   * 「显示最近活跃的项目与会话」要的是「每个文件夹各留一条」，不是全局最近
   * N 条 —— 全局最近 N 条会让大部分文件夹一条都不剩。服务端按成员表算好
   * 这份映射；拿不到时退回全局 recentSet 语义。
   */
  var recentLatest = new Map()
  /**
   * recentLatest 里各项目的排列顺序 = 各项目最近会话时间降序（服务端按这个
   * 顺序写入 latest）。「只显示最近 N 个项目」就靠这份顺序截前 N 个。
   */
  var recentProjectOrder = []
  /** 最近列表的版本号：每次 loadRecent 成功自增，用来让项目视图缓存失效。 */
  var recentRevision = 0
  /** 上一次算好的「最近 N 个项目 / 未分组 N 条」视图（{ revision, limit, projects, ungrouped }）。 */
  var recentViewCache = null
  /** 不属于任何文件夹的最近 N 个会话 id（未分组照常显示）。 */
  var recentUngrouped = new Set()
  /** 会话 id → 所属 workspaceId（'' 表示未分组），由成员表反查。 */
  var sessionOwner = new Map()
  var recentLoading = false
  var lastRecentPoll = 0
  var modeMenu = null
  var modeMenuAnchor = null
  var modeSaving = false
  var limitSaving = false
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
  /**
   * 我们替用户点开的「展开其余 N 个会话」按钮（按 groupKey 记）。
   *
   * 宿主把超出 watermark 的会话折进这个按钮里，未分组会话因此根本不在 DOM
   * 中 —— 不点开它，recent 模式就永远看不到未分组会话。
   */
  var autoExpandedOverflow = new Set()
  /** 用户亲手点过的 overflow 按钮（groupKey）：本轮不再接管。 */
  var userToggledOverflow = new Set()
  /** groupKey → { at, count }：overflow 展开退避。 */
  var overflowAttempts = new Map()
  var workspacesLoading = false
  var lastWorkspacesPoll = 0
  var autoStatusText = ''
  var settingsRetry = null
  var settingsLoading = false
  var lastSettingsPoll = 0
  var activeOnly = false
  var headerEl = null
  var headerButton = null
  var styleEl = null
  var observer = null
  var timer = null
  var startTimer = null
  var frame = 0
  var lastAutoErrorAt = 0
  var promoteSaving = false
  var lastPromoteErrorAt = 0


  // ── 样式 ────────────────────────────────────────────────────────────────

  function injectStyle() {
    if (styleEl !== null) return
    styleEl = document.createElement('style')
    styleEl.setAttribute('data-dsgb-workspace-chrome', 'style')
    styleEl.textContent = [
      '.dsgb-active-toggle{' +
        'box-sizing:border-box;width:28px;height:28px;flex:none;display:inline-flex;align-items:center;' +
        'justify-content:center;margin:0 0 0 auto;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);' +
        'background:transparent;color:var(--dsw-alias-label-secondary,#5f6368);cursor:pointer;' +
        'position:relative;touch-action:manipulation;-webkit-tap-highlight-color:transparent}' ,
      // 命中区：视觉尺寸不变，用伪元素向外扩。标题栏是 overflow:hidden 且只有 36px 高，
      // 所以纵向扩出的部分会被裁掉，实际命中高度≈标题栏高度；右侧只扩 2px，
      // 再往右就是宿主的搜索按钮，扩多了会抢走它的点击。
      '.dsgb-active-toggle::after{content:"";position:absolute;inset:-4px -2px -4px -4px;border-radius:inherit}',
      // hover 只在真有指针的设备上生效，触摸设备不会留下粘滞高亮。
      '@media (hover:hover){.dsgb-active-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}}',
      '.dsgb-active-toggle[aria-pressed="true"]{' +
        'color:var(--dsw-alias-state-business-primary,#1084fe);' +
        'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      // 触摸设备 / 窄视口（移动端抽屉）：按钮放大到标题栏满高，图标同步放大，
      // 按下即给反馈 —— 触摸没有 hover，不给 :active 就等于点了没反应。
      '@media (hover:none),(pointer:coarse),(width<=480px){' +
        '.dsgb-active-toggle{width:36px;height:36px;margin-right:2px}' +
        '.dsgb-active-toggle svg{width:18px;height:18px}' +
        '.dsgb-active-toggle:active{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.2))}}',
      '.dsgb-active-toggle:focus-visible{' +
        'outline:var(--dsw-focus-ring-width,2px) solid ' +
        'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#1084fe));outline-offset:-2px}',
      '.dsgb-active-toggle svg{display:block;pointer-events:none}',
      // 按钮插在 searchSlot 之前；取消它的 auto margin，避免和按钮之间出现一段空白。
      '[data-dsgb-chrome-header] [class*="searchSlot"]{margin-left:0!important}',
      // 搜索展开时把整条标题栏交给宿主，别和输入框抢位置。
      '[data-dsgb-chrome-header]:has([class*="searchExpanded"]) .dsgb-active-toggle{display:none}',
      // 三种模式共用一套「行/分组该不该显示」的属性，由 html[data-dsgb-mode] 分派。
      // active：只留进行中的会话与含进行中会话的项目；
      'html[data-dsgb-mode="active"] [data-row-key^="session:"][data-dsgb-active="false"]{display:none!important}',
      'html[data-dsgb-mode="active"] [class*="groupSection"][data-dsgb-active-empty="1"]{display:none!important}',
      // active 模式下宿主 watermark 的「展开其余 N 个会话」行同样不该出现：
      // 它只是一条「还有会话被折着」的提示，与「只看进行中」的语义无关。
      // 藏掉按钮不会吞掉会话 —— 里面有进行中会话的分组已由 expandOverflow()
      // 先点开（点开后会话已渲染，按钮本身按 hiddenCount 自会消失）。
      'html[data-dsgb-mode="active"] [data-row-key^="overflow:"]{display:none!important}',
      // 「未分组」标题行（data-row-key 恰为 "workspace:"，id 为空串）也一起藏。
      // 只藏这一行、**不藏它所在的 groupSection**：未分组的会话行挂在同一个
      // section 下，藏容器会连会话一起吞掉。section 本身的取舍仍由
      // data-dsgb-active-empty 决定（没有进行中会话才整组隐藏）。
      'html[data-dsgb-mode="active"] [data-row-key="workspace:"]{display:none!important}',
      // recent-with-projects：留最近 N 个会话 + 它们所属的项目文件夹；
      'html[data-dsgb-mode="recent-with-projects"] [data-row-key^="session:"][data-dsgb-recent="false"]{display:none!important}',
      'html[data-dsgb-mode="recent-with-projects"] [class*="groupSection"][data-dsgb-recent-empty="1"]{display:none!important}',
      // recent-sessions：只留最近 N 个会话，项目行本身也藏起来（文件夹仍展开，
      // 否则折叠文件夹里的会话根本不会被渲染）。
      'html[data-dsgb-mode="recent-sessions"] [data-row-key^="session:"][data-dsgb-recent="false"]{display:none!important}',
      'html[data-dsgb-mode="recent-sessions"] [class*="groupSection"][data-dsgb-recent-empty="1"]{display:none!important}',
      // recent-with-projects / recent-sessions：宿主 watermark 的「展开其余 N 个会话」
      // 行在最近模式下没有意义（每个项目只留 1 条，其余全被我们隐藏），
      // 参考效果里也不该出现这一行，直接藏掉。
      'html[data-dsgb-mode="recent-with-projects"] [data-row-key^="overflow:"]{display:none!important}',
      'html[data-dsgb-mode="recent-sessions"] [data-row-key^="overflow:"]{display:none!important}',
      // 只藏真正的项目文件夹行；未分组分组的 key 就是 "workspace:"（空 id），
      // 它是未分组会话的唯一父容器，藏掉它等于把那些会话一起吞了。
      'html[data-dsgb-mode="recent-sessions"] [data-row-key^="workspace:"]:not([data-row-key="workspace:"]){display:none!important}',
      // 右键菜单：贴着按钮下方右对齐，宽度按内容，超出视口时由 placeModeMenu 夹回来。
      // 浮层底色用宿主真实存在的 --dsw-alias-bg-layer-2（浅色 bluish-00 #fff / 深色 bluish-850 #2c2c2e）；
      // --dsw-alias-bg-elevated 在宿主里并不存在，兜底值会让深色主题下变成白底。
      '.dsgb-mode-menu{' +
        'position:fixed;z-index:2147483002;box-sizing:border-box;min-width:236px;max-width:min(320px,calc(100vw - 16px));' +
        'padding:6px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));box-shadow:0 8px 28px rgba(0,0,0,.22);' +
        'font:12px/17px "PingFang SC",system-ui,sans-serif;color:var(--dsw-alias-label-primary,#0f1115);color-scheme:light}',
      // 宿主把深色开关投影成 body[data-ds-dark-theme]；token 缺失时也要有正确的深色兜底，
      // 并让原生控件（数字框、单选）跟着切到深色。
      'body[data-ds-dark-theme] .dsgb-mode-menu{' +
        'background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-primary,#f9fafb);' +
        'border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.16));color-scheme:dark}',
      '.dsgb-mode-title{font-size:11px;line-height:15px;opacity:.55;padding:2px 8px 5px}',
      '.dsgb-mode-item{display:flex;align-items:flex-start;gap:7px;padding:5px 8px;border-radius:6px;cursor:pointer}',
      '@media (hover:hover){.dsgb-mode-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}}',
      '.dsgb-mode-item input{width:13px;height:13px;margin:2px 0 0;flex:none;accent-color:var(--dsw-alias-state-business-primary,#1084fe)}',
      '.dsgb-mode-item span{flex:1;min-width:0}',
      '.dsgb-mode-limit{' +
        'display:flex;align-items:center;gap:6px;margin-top:5px;padding:6px 8px 2px;' +
        'border-top:1px solid rgba(127,127,127,.22);font-size:11px;line-height:15px;opacity:.85}',
      '.dsgb-mode-limit input{' +
        'box-sizing:border-box;width:52px;padding:2px 5px;border-radius:5px;' +
        'border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;' +
        'font:11px/15px "PingFang SC",system-ui,sans-serif}',
      '.dsgb-mode-limit input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1084fe);outline-offset:-1px}',
      '.dsgb-palette{max-height:calc(100vh - 16px);overflow-y:auto}',
      '.dsgb-auto-color,.dsgb-promote{' +
        'margin-top:10px;padding-top:9px;border-top:1px solid rgba(127,127,127,.22);' +
        'font:12px/17px "PingFang SC",system-ui,sans-serif}',
      '.dsgb-auto-color label,.dsgb-promote label{display:flex;align-items:center;gap:7px;cursor:pointer}',
      '.dsgb-auto-color input,.dsgb-promote input{width:14px;height:14px;margin:0;flex:none;accent-color:var(--dsw-alias-state-business-primary,#1084fe)}',
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

  /** 当前显示模式（settings 里已归一，这里再兜一次底）。 */
  function modeOf() {
    var mode = settings.workspaceDisplayMode
    if (mode === MODE_RECENT_PROJECTS || mode === MODE_RECENT_SESSIONS) return mode
    return MODE_ACTIVE
  }

  /** 当前模式的「最近 N 个」N。 */
  function recentLimit() {
    var n = settings.workspaceRecentLimit
    if (typeof n !== 'number' || !isFinite(n)) return DEFAULT_RECENT_LIMIT
    var rounded = Math.round(n)
    if (rounded < MIN_RECENT_LIMIT) return MIN_RECENT_LIMIT
    if (rounded > MAX_RECENT_LIMIT) return MAX_RECENT_LIMIT
    return rounded
  }

  /** 当前模式的短文案（按钮 title / 菜单标题共用）。 */
  function modeText() {
    var mode = modeOf()
    for (var i = 0; i < MODE_LABELS.length; i += 1) {
      if (MODE_LABELS[i].mode === mode) {
        return MODE_LABELS[i].text.replace('N', String(recentLimit()))
      }
    }
    return MODE_LABELS[0].text
  }

  /**
   * 实际生效的模式。
   *
   * 选了 recent 模式但最近列表还没到、或服务端明确说拿不到（available:false）
   * 时，退回 active 语义 —— 宁可少藏，也不能因为数据源缺失把侧栏清空。
   */
  function effectiveMode() {
    var mode = modeOf()
    if (mode === MODE_ACTIVE) return MODE_ACTIVE
    if (!recent.loaded || !recent.available) return MODE_ACTIVE
    return mode
  }

  /** 把模式写到 documentElement 上，CSS 据此分派；关闭过滤时摘掉属性。 */
  function syncModeAttribute() {
    var root = document.documentElement
    if (!activeOnly) {
      if (root.hasAttribute('data-dsgb-mode')) root.removeAttribute('data-dsgb-mode')
      return
    }
    var mode = effectiveMode()
    if (root.getAttribute('data-dsgb-mode') !== mode) root.setAttribute('data-dsgb-mode', mode)
  }

  function updateHeaderButton() {
    if (headerButton === null) return
    var pressed = activeOnly ? 'true' : 'false'
    if (headerButton.getAttribute('aria-pressed') !== pressed) headerButton.setAttribute('aria-pressed', pressed)
    var label = '显示方式：' + modeText() + '（右键选择模式）'
    if (headerButton.getAttribute('aria-label') !== label) headerButton.setAttribute('aria-label', label)
    var title = activeOnly
      ? modeText() + '（已开启，点击显示全部；右键选择模式）'
      : modeText() + '（点击应用；右键选择模式）'
    if (headerButton.title !== title) headerButton.title = title
  }

  function toggleFilter() {
    activeOnly = !activeOnly
    if (activeOnly) {
      // 新一轮筛选：上一轮的用户控制/重试记录全部作废，重新按当前事实接管。
      // 普通模式下的折叠/展开从不写这些记录，所以不会带进这一轮。
      userToggled.clear()
      autoExpanded.clear()
      expandAttempts.clear()
      pendingToggle.clear()
      // overflow 那一套记录同样属于上一轮：不清的话，上一轮被自动点开过的
      // 分组会带着「已尝试/用户切换过」的痕迹，这一轮就不肯再展开了。
      autoExpandedOverflow.clear()
      userToggledOverflow.clear()
      overflowAttempts.clear()
      // recent 模式要现成的最近列表；没有就先拉一次，拉到后 applyFilter 会重跑。
      if (modeOf() !== MODE_ACTIVE && !recent.loaded) loadRecent()
    } else {
      // 关闭筛选：先撤掉过滤属性，再把插件临时展开的文件夹折回。
      // 展开状态是宿主的前端本地状态，插件不留任何持久改动。
      applyFilter()
      restoreExpansion()
      // 折回完成 → 这一轮周期结束，用户控制记录不带到下一轮。
      userToggled.clear()
    }
    syncModeAttribute()
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
        closeModeMenu()
        toggleFilter()
      })
      button.addEventListener('contextmenu', function (event) {
        event.preventDefault()
        event.stopPropagation()
        openModeMenu()
      })
      var search = header.querySelector('[class*="searchSlot"]')
      if (search !== null) header.insertBefore(button, search)
      else header.appendChild(button)
    }
    headerButton = button
    updateHeaderButton()
  }

  // ── 右键菜单：显示模式 ──────────────────────────────────────────────────

  /** 关掉菜单（幂等）。 */
  function closeModeMenu() {
    if (modeMenu !== null && modeMenu.parentElement !== null) modeMenu.parentElement.removeChild(modeMenu)
    modeMenu = null
    modeMenuAnchor = null
  }

  /** 把菜单夹进视口：默认贴按钮右下，越界就翻到左侧/上方。 */
  function placeModeMenu(menu, anchor) {
    var rect = anchor.getBoundingClientRect()
    var width = menu.offsetWidth || 236
    var height = menu.offsetHeight || 160
    var left = rect.right - width
    if (left < 8) left = 8
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width)
    var top = rect.bottom + 4
    if (top + height > window.innerHeight - 8) {
      var above = rect.top - 4 - height
      top = above >= 8 ? above : Math.max(8, window.innerHeight - 8 - height)
    }
    menu.style.left = Math.round(left) + 'px'
    menu.style.top = Math.round(top) + 'px'
  }

  /** 写一条设置（模式或 N），失败回滚界面并提示。 */
  function saveDisplaySetting(patch, done) {
    postJson(SETTINGS_URL, patch, function (ok, body) {
      if (stopped) return
      if (ok) {
        applySettings(body)
        done(true)
        return
      }
      showAutoError('显示方式没有保存：' + String((body && body.message) || body))
      done(false)
    })
  }

  /** 选一个模式：立刻生效（若过滤开着），并持久化。 */
  function setDisplayMode(mode) {
    if (modeSaving) return
    var next = mode === MODE_RECENT_PROJECTS || mode === MODE_RECENT_SESSIONS ? mode : MODE_ACTIVE
    var prev = settings.workspaceDisplayMode
    settings.workspaceDisplayMode = next
    if (next !== MODE_ACTIVE && !recent.loaded) loadRecent()
    syncModeAttribute()
    updateHeaderButton()
    if (activeOnly) applyFilter()
    if (prev === next) return
    modeSaving = true
    saveDisplaySetting({ workspaceDisplayMode: next }, function (ok) {
      modeSaving = false
      if (!ok) {
        settings.workspaceDisplayMode = prev
        syncModeAttribute()
        updateHeaderButton()
        if (activeOnly) applyFilter()
      }
    })
  }

  /** 改「最近 N 个」：夹到 1..50，立刻重算并持久化。 */
  function setRecentLimit(raw) {
    if (limitSaving) return
    var n = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
    if (typeof n !== 'number' || !isFinite(n)) return
    var rounded = Math.round(n)
    if (rounded < MIN_RECENT_LIMIT) rounded = MIN_RECENT_LIMIT
    if (rounded > MAX_RECENT_LIMIT) rounded = MAX_RECENT_LIMIT
    var prev = settings.workspaceRecentLimit
    settings.workspaceRecentLimit = rounded
    updateHeaderButton()
    if (activeOnly) applyFilter()
    if (prev === rounded) return
    limitSaving = true
    saveDisplaySetting({ workspaceRecentLimit: rounded }, function (ok) {
      limitSaving = false
      if (!ok) {
        settings.workspaceRecentLimit = prev
        updateHeaderButton()
        if (activeOnly) applyFilter()
      }
    })
  }

  /** 打开右键菜单：三模式单选 + 「最近 N 个」数字框。 */
  function openModeMenu() {
    if (stopped || headerButton === null) return
    closeModeMenu()
    var menu = document.createElement('div')
    menu.className = 'dsgb-mode-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-dsgb-mode-menu', '1')

    var title = document.createElement('div')
    title.className = 'dsgb-mode-title'
    title.textContent = '工作区显示方式'
    menu.appendChild(title)

    var current = modeOf()
    for (var i = 0; i < MODE_LABELS.length; i += 1) {
      var entry = MODE_LABELS[i]
      var item = document.createElement('label')
      item.className = 'dsgb-mode-item'
      item.setAttribute('role', 'menuitemradio')
      item.setAttribute('data-dsgb-mode-option', entry.mode)
      item.setAttribute('aria-checked', entry.mode === current ? 'true' : 'false')
      var radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'dsgb-mode'
      radio.value = entry.mode
      radio.checked = entry.mode === current
      radio.addEventListener('change', function (event) {
        var value = event.target !== null && event.target !== undefined ? event.target.value : ''
        setDisplayMode(value)
        closeModeMenu()
      })
      var text = document.createElement('span')
      text.textContent = entry.text.replace('N', String(recentLimit()))
      item.appendChild(radio)
      item.appendChild(text)
      menu.appendChild(item)
    }

    var limitRow = document.createElement('div')
    limitRow.className = 'dsgb-mode-limit'
    var limitLabel = document.createElement('label')
    limitLabel.textContent = '最近'
    var limitInput = document.createElement('input')
    limitInput.type = 'number'
    limitInput.min = String(MIN_RECENT_LIMIT)
    limitInput.max = String(MAX_RECENT_LIMIT)
    limitInput.step = '1'
    limitInput.value = String(recentLimit())
    limitInput.setAttribute('aria-label', '最近几个会话')
    limitInput.addEventListener('change', function (event) {
      var target = event.target
      setRecentLimit(target !== null && target !== undefined ? target.value : '')
      if (target !== null && target !== undefined) target.value = String(recentLimit())
    })
    var limitTail = document.createElement('span')
    limitTail.textContent = '个会话'
    limitRow.appendChild(limitLabel)
    limitRow.appendChild(limitInput)
    limitRow.appendChild(limitTail)
    menu.appendChild(limitRow)

    document.body.appendChild(menu)
    modeMenu = menu
    modeMenuAnchor = headerButton
    placeModeMenu(menu, headerButton)
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
      if (memberSessions.size > 0) memberSessions.clear()
      if (sessionOwner.size > 0) sessionOwner.clear()
      ungroupedKnown = false
      return
    }
    var all = []
    var assigned = new Set()
    // 只有**每一条**都真的给出 sessionIds，未分组集合才算确定；
    // 任何一条归属未知，就不能把「不在已知成员里」当成「未分组」。
    //
    // 空成员表恰恰是**确定**的：名册可用、只是还没有任何项目，此时全部会话
    // 都属于未分组。起点用 hasMembers（宿主真的给了 members 数组），不是
    // 「有没有条目」—— 否则没有项目时就永远判不出未分组。
    var allKnown = workspaces.hasMembers
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
    memberSessions.clear()
    sessionOwner.clear()
    for (var m = 0; m < workspaces.members.length; m += 1) {
      var member = workspaces.members[m]
      // 归属未知的条目**不写结论**：memberActive 里没有它，页面据此保持可见。
      if (member.known !== true) continue
      memberKnown.add(member.workspaceId)
      memberSessions.set(member.workspaceId, member.sessionIds)
      for (var s = 0; s < member.sessionIds.length; s += 1) {
        if (!sessionOwner.has(member.sessionIds[s])) sessionOwner.set(member.sessionIds[s], member.workspaceId)
      }
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
      memberSessions.set('', unassigned)
      for (var g = 0; g < unassigned.length; g += 1) {
        if (!sessionOwner.has(unassigned[g])) sessionOwner.set(unassigned[g], '')
      }
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

  /**
   * 「最近 N 个项目 + 未分组 N 条」的当前视图。
   *
   * 服务端 recentPlanOf 已经按「各项目最近会话时间降序」把 latest 写出来，
   * 但安装副本可能还是旧实现（一次性给全部项目），宿主模块又要重启才换得掉，
   * 所以这里按顺序自己再截一次前 N：顺序来自 Object key 顺序，与时间排序一致。
   *
   * 缓存按 (recentRevision, limit) 生效 —— recent 列表每刷新一次版本号自增，
   * 用户改数量时 limit 变化，两种变化都会让缓存失效。
   */
  function recentView() {
    var limit = recentLimit()
    if (
      recentViewCache !== null &&
      recentViewCache.revision === recentRevision &&
      recentViewCache.limit === limit
    ) {
      return recentViewCache
    }
    var order = recentProjectOrder.length > 0 ? recentProjectOrder : Array.from(recentLatest.keys())
    var projects = new Map()
    for (var i = 0; i < order.length && projects.size < limit; i += 1) {
      var workspaceId = order[i]
      var latest = recentLatest.get(workspaceId)
      if (latest === undefined) continue
      projects.set(workspaceId, latest)
    }
    var view = {
      revision: recentRevision,
      limit: limit,
      projects: projects,
      ungrouped: Array.from(recentUngrouped).slice(0, limit),
    }
    recentViewCache = view
    return view
  }

  /**
   * 用最近会话集合重算「每个文件夹里有没有最近会话」。
   *
   * 与 refreshMemberActivity 同源（memberSessions），只是判定换成「在不在
   * 最近 N 个里」。最近列表拿不到时 memberRecent 留空，页面据此保持可见。
   */
  function refreshMemberRecent() {
    memberRecent.clear()
    if (recentSet.size === 0) return
    var view = recentView()
    var perProject = effectiveMode() === MODE_RECENT_PROJECTS && recentLatest.size > 0
    memberSessions.forEach(function (sessionIds, workspaceId) {
      if (perProject && workspaceId !== '') {
        // 只留「最近活跃的 N 个项目」各自最近的那条：不在前 N 个项目里的
        // 文件夹一条不留（据此隐藏整个文件夹），命中的那个也不看全局集合。
        var latest = view.projects.get(workspaceId)
        memberRecent.set(workspaceId, latest !== undefined && sessionIds.indexOf(latest) !== -1)
        return
      }
      var hit = false
      for (var i = 0; i < sessionIds.length; i += 1) {
        if (recentHit(sessionIds[i])) {
          hit = true
          break
        }
      }
      memberRecent.set(workspaceId, hit)
    })
  }

  /**
   * 这个会话在当前 recent 模式下算不算「该显示」。
   *
   * 「显示最近活跃的项目与会话」= 每个文件夹各留它自己最近的那条 + 未分组
   * 会话照常显示（最近 N 个）。全局最近 N 条会让大部分文件夹一条不剩，
   * 与参考效果不符，所以这里按归属分流。
   *
   * 归属未知（成员表读不到）时一律返回 true —— 宁可多显示，也不能因为
   * 读不到归属就把会话藏掉。
   */
  function recentHit(sessionId) {
    if (sessionId === '') return false
    if (effectiveMode() === MODE_RECENT_SESSIONS) return recentSet.has(sessionId)
    if (recentLatest.size === 0 && recentUngrouped.size === 0) return recentSet.has(sessionId)
    var owner = sessionOwner.get(sessionId)
    if (owner === undefined) return true
    var view = recentView()
    if (owner === '') return view.ungrouped.indexOf(sessionId) !== -1
    return view.projects.get(owner) === sessionId
  }

  /** 拉最近会话列表（recent 模式的数据源）。失败安静降级，不弹错。 */
  function loadRecent() {
    if (stopped || recentLoading) return
    recentLoading = true
    lastRecentPoll = Date.now()
    var finish = function (ok, body) {
      recentLoading = false
      if (stopped) return
      if (!ok || body === null || typeof body !== 'object') {
        recent.loaded = true
        recent.available = false
        recent.ids = []
        recentSet = new Set()
        recentLatest = new Map()
        recentProjectOrder = []
        recentUngrouped = new Set()
        recentRevision += 1
        recentViewCache = null
        recent.at = Date.now()
        if (activeOnly) applyFilter()
        return
      }
      var ids = []
      var list = Array.isArray(body.sessions) ? body.sessions : []
      for (var i = 0; i < list.length; i += 1) {
        var entry = list[i]
        var id = entry !== null && typeof entry === 'object' && typeof entry.id === 'string' ? entry.id : ''
        if (id === '' || ids.indexOf(id) !== -1) continue
        ids.push(id)
      }
      // latest: workspaceId → 该文件夹最近的会话；ungrouped: 未分组的最近 N 个。
      // 服务端没给（旧版本 / 名册不可用）时留空，recentHit 退回全局集合语义。
      var latest = new Map()
      var rawLatest = body.latest
      if (rawLatest !== null && typeof rawLatest === 'object') {
        for (var key in rawLatest) {
          if (!Object.prototype.hasOwnProperty.call(rawLatest, key)) continue
          var value = rawLatest[key]
          if (typeof key === 'string' && key !== '' && typeof value === 'string' && value !== '') {
            latest.set(key, value)
          }
        }
      }
      var ungrouped = new Set()
      var rawUngrouped = Array.isArray(body.ungrouped) ? body.ungrouped : []
      for (var u = 0; u < rawUngrouped.length; u += 1) {
        if (typeof rawUngrouped[u] === 'string' && rawUngrouped[u] !== '') ungrouped.add(rawUngrouped[u])
      }
      recent.loaded = true
      recent.available = body.available === true
      recent.ids = ids
      recentSet = new Set(ids)
      recentLatest = latest
      // Object key 顺序 = 各项目最近会话时间降序，直接当项目排序用。
      recentProjectOrder = Array.from(latest.keys())
      recentUngrouped = ungrouped
      recentRevision += 1
      recentViewCache = null
      recent.at = Date.now()
      if (activeOnly) applyFilter()
    }
    try {
      fetch(RECENT_URL, { cache: 'no-store', credentials: 'same-origin' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        })
        .then(function (body) {
          finish(true, body)
        })
        .catch(function () {
          finish(false, null)
        })
    } catch (err) {
      finish(false, null)
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
  /** 这个文件夹在当前模式下该不该被临时展开（有命中会话却折叠着）。 */
  function shouldExpand(workspaceId) {
    if (effectiveMode() === MODE_ACTIVE) return memberActive.get(workspaceId) === true
    return memberRecent.get(workspaceId) === true
  }

  function expandForActive() {
    if (stopped || !activeOnly) return false
    var opened = false
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
      if (!shouldExpand(workspaceId)) continue
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
      opened = true
      clickRow(row)
    }
    return opened
  }

  /** overflow 按钮的 groupKey（data-row-key="overflow:<key>"）；不是则 null。 */
  function overflowKeyOf(button) {
    if (button === null || button === undefined || typeof button.getAttribute !== 'function') return null
    var key = button.getAttribute('data-row-key')
    if (typeof key !== 'string' || key.indexOf('overflow:') !== 0) return null
    return key.slice('overflow:'.length)
  }

  /**
   * 这个 overflow 按钮背后的分组，在当前模式下该不该被点开。
   *
   * 成员表能给出结论时按结论走。未分组（空 key）是特例：里面的会话被宿主
   * 折进去后根本没渲染，DOM 上看不到，只能按数据源判断 —— recent 模式下
   * 未分组会话几乎总有命中，不展开就永远看不到，与参考效果不符。
   * 归属未知（members 读不到）时一律展开，让 CSS 依据 recentHit 去筛。
   */
  function shouldExpandOverflow(groupKey) {
    // active 模式：这一行虽然被 CSS 藏了，但它后面折着会话 —— 有活跃会话的
    // 分组（含未分组）仍要先点开，否则那些会话根本不渲染，判定与展示都会落空。
    if (effectiveMode() === MODE_ACTIVE) {
      if (memberActive.get(groupKey) === true) return true
      // 归属未知（成员表读不到）时不能断言「没有活跃会话」：宁可点开让 CSS 去筛。
      if (groupKey === '') return !ungroupedKnown
      return !memberSessions.has(groupKey) && memberActive.size > 0
    }
    // 项目分组：只有「最近 N 个项目」里、且确实留了会话的才去点开。被隐藏的
    // 分组不点 —— 点了也看不见，还会把两百多个会话一起渲染出来。
    if (memberRecent.get(groupKey) === true) return true
    if (groupKey !== '') {
      // 分组 key 与名册里的 workspaceId 对不上（嵌套分组会拼路径键）时归属
      // 未知，不能据此断定「没有命中」：最近列表非空就展开，让 CSS 去筛。
      return !memberSessions.has(groupKey) && recentSet.size > 0
    }
    // 未分组：前 N 条里有命中就展开。
    if (recentView().ungrouped.length > 0) return true
    if (!ungroupedKnown && recentSet.size > 0) return true
    return false
  }

  /**
   * 点开宿主折叠会话的「展开其余 N 个会话」按钮。
   *
   * 宿主按 watermark（默认 5）把超出部分的会话折进这个按钮里，未分组会话
   * 几乎总是被折进去 —— 不点开它，recent 模式就永远看不到未分组会话，
   * 与参考效果不符。只展开「本模式下确实有命中会话」的分组，避免把两百多
   * 个会话一次性渲染出来。
   */
  function expandOverflow() {
    if (stopped || !activeOnly) return false
    var opened = false
    var buttons = document.querySelectorAll('[data-row-key^="overflow:"]')
    var now = Date.now()
    for (var i = 0; i < buttons.length; i += 1) {
      var button = buttons[i]
      var groupKey = overflowKeyOf(button)
      if (groupKey === null) continue
      if (button.getAttribute('aria-expanded') === 'true') {
        // 已经展开（含我们自己展开成功）：清掉退避，方便它以后再次被折叠时重开。
        if (autoExpandedOverflow.has(groupKey)) overflowAttempts.delete(groupKey)
        continue
      }
      if (!shouldExpandOverflow(groupKey)) continue
      if (userToggledOverflow.has(groupKey)) continue
      var attempt = overflowAttempts.get(groupKey)
      if (attempt !== undefined) {
        if (attempt.count >= EXPAND_MAX_ATTEMPTS) continue
        if (now - attempt.at < EXPAND_RETRY_MS) continue
      }
      overflowAttempts.set(groupKey, { at: now, count: attempt === undefined ? 1 : attempt.count + 1 })
      autoExpandedOverflow.add(groupKey)
      opened = true
      clickRow(button)
    }
    return opened
  }

  /**
   * 关闭筛选时把我们替用户展开的文件夹折回。
   *
   * 只折回「仍然展开着、且不是用户在本轮里亲手切换过」的那些 —— 用户自己
   * 展开的、或用户在我们展开后又手动折叠的，都不动。未分组的空 key 同样处理。
   */
  function restoreExpansion() {
    restoreOverflow()
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

  /** 把我们替用户点开的 overflow 按钮折回（用户亲手点过的不动）。 */
  function restoreOverflow() {
    if (autoExpandedOverflow.size === 0) {
      overflowAttempts.clear()
      return
    }
    var keys = []
    autoExpandedOverflow.forEach(function (key) {
      keys.push(key)
    })
    autoExpandedOverflow.clear()
    overflowAttempts.clear()
    for (var i = 0; i < keys.length; i += 1) {
      if (userToggledOverflow.has(keys[i])) continue
      var buttons = document.querySelectorAll('[data-row-key^="overflow:"]')
      for (var j = 0; j < buttons.length; j += 1) {
        if (overflowKeyOf(buttons[j]) !== keys[i]) continue
        if (buttons[j].getAttribute('aria-expanded') !== 'true') break
        clickRow(buttons[j])
        break
      }
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
    // 「展开其余 N 个会话」按钮：用户亲手点过就交还控制权，本轮不再自动点开。
    var overflow = target.closest('[data-row-key^="overflow:"]')
    if (overflow !== null) {
      var overflowKey = overflowKeyOf(overflow)
      if (overflowKey !== null) {
        userToggledOverflow.add(overflowKey)
        autoExpandedOverflow.delete(overflowKey)
        overflowAttempts.delete(overflowKey)
      }
      return
    }
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

  /** 摘掉所有过滤属性（关闭过滤 / 切模式前清场）。 */
  function clearFilterAttributes() {
    var rows = document.querySelectorAll('[data-row-key^="session:"]')
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].hasAttribute('data-dsgb-active')) rows[i].removeAttribute('data-dsgb-active')
      if (rows[i].hasAttribute('data-dsgb-recent')) rows[i].removeAttribute('data-dsgb-recent')
    }
    var groups = document.querySelectorAll('[class*="groupSection"]')
    for (var j = 0; j < groups.length; j += 1) {
      if (groups[j].hasAttribute('data-dsgb-active-empty')) groups[j].removeAttribute('data-dsgb-active-empty')
      if (groups[j].hasAttribute('data-dsgb-recent-empty')) groups[j].removeAttribute('data-dsgb-recent-empty')
    }
  }

  /**
   * recent 两种模式的过滤：会话行按「在不在最近 N 个里」标记，分组按
   * 「里面有没有最近会话」标记。归属未知的分组一律保持可见。
   */
  function applyRecentFilter() {
    refreshMemberRecent()
    var rows = document.querySelectorAll('[data-row-key^="session:"]')
    var sections = new Map()
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i]
      var key = row.getAttribute('data-row-key')
      var sessionId = typeof key === 'string' ? key.slice('session:'.length) : ''
      var hit = recentHit(sessionId)
      var next = hit ? 'true' : 'false'
      if (row.getAttribute('data-dsgb-recent') !== next) row.setAttribute('data-dsgb-recent', next)
      var section = row.closest('[class*="groupSection"]')
      if (section !== null) {
        if (!sections.has(section)) sections.set(section, false)
        if (hit) sections.set(section, true)
      }
    }
    var groups = document.querySelectorAll('[class*="groupSection"]')
    for (var j = 0; j < groups.length; j += 1) {
      var group = groups[j]
      var groupHit = sections.get(group) === true
      var projectRow = sectionRowOf(group)
      var groupWorkspaceId = projectRow === null ? null : workspaceIdOfRow(projectRow)
      if (!groupHit && groupWorkspaceId !== null && memberRecent.get(groupWorkspaceId) === true) {
        groupHit = true
      }
      if (!groupHit) {
        var ownershipKnown =
          groupWorkspaceId === null
            ? false
            : groupWorkspaceId === ''
              ? ungroupedKnown
              : memberKnown.has(groupWorkspaceId)
        if (!ownershipKnown && !sections.has(group)) {
          if (group.hasAttribute('data-dsgb-recent-empty')) group.removeAttribute('data-dsgb-recent-empty')
          continue
        }
        if (group.querySelector('[class*="groupSection"]') !== null) {
          if (group.hasAttribute('data-dsgb-recent-empty')) group.removeAttribute('data-dsgb-recent-empty')
        } else if (group.getAttribute('data-dsgb-recent-empty') !== '1') {
          group.setAttribute('data-dsgb-recent-empty', '1')
        }
        continue
      }
      if (group.hasAttribute('data-dsgb-recent-empty')) group.removeAttribute('data-dsgb-recent-empty')
    }
    var opened = expandOverflow()
    if (expandForActive()) opened = true
    // 点开折叠会触发宿主异步重渲染：新渲染出来的会话行还不带标记，
    // 这一帧打完标记才算数。不补这一轮，刚展开的分组会把全部会话都露出来。
    if (opened) scheduleReapply()
  }

  /** 展开动作之后的补跑（同一帧内多次触发只跑一次，避免自己把自己刷成死循环）。 */
  var reapplyScheduled = false
  function scheduleReapply() {
    if (reapplyScheduled || stopped || !activeOnly) return
    reapplyScheduled = true
    nextFrame(function () {
      reapplyScheduled = false
      if (stopped || !activeOnly) return
      applyFilter()
    })
  }

  function applyFilter() {
    if (stopped) return
    if (!activeOnly) {
      clearFilterAttributes()
      return
    }
    refreshMemberActivity()
    syncModeAttribute()
    if (effectiveMode() !== MODE_ACTIVE) {
      applyRecentFilter()
      return
    }
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
    var openedActive = expandOverflow()
    if (expandForActive()) openedActive = true
    if (openedActive) scheduleReapply()
  }


  // ── 设置与自动配色 ──────────────────────────────────────────────────────

  function applySettings(body) {
    if (body === null || typeof body !== 'object') return
    var data = body.settings !== null && typeof body.settings === 'object' ? body.settings : body
    settings.autoColorNewFolders = data.autoColorNewFolders === true
    // 缺字段时保持开启：这是默认行为，老设置文件不该把它关掉。
    settings.autoPromoteActiveWorkspace = data.autoPromoteActiveWorkspace !== false
    settings.baselineComplete = data.baselineComplete === true
    // 显示模式与 N：缺字段/非法值退回默认（active + 5），与宿主半侧同一套规则。
    var mode = data.workspaceDisplayMode
    settings.workspaceDisplayMode =
      mode === MODE_RECENT_PROJECTS || mode === MODE_RECENT_SESSIONS ? mode : MODE_ACTIVE
    var limit = data.workspaceRecentLimit
    settings.workspaceRecentLimit =
      typeof limit === 'number' && isFinite(limit) ? Math.min(MAX_RECENT_LIMIT, Math.max(MIN_RECENT_LIMIT, Math.round(limit))) : DEFAULT_RECENT_LIMIT
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
    if (stopped || settingsLoading) return
    if (settingsRetry !== null) {
      clearTimeout(settingsRetry)
      settingsRetry = null
    }
    settingsLoading = true
    lastSettingsPoll = Date.now()
    fetch(SETTINGS_URL, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) {
        return response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))
      })
      .then(function (body) {
        if (stopped) return
        settingsLoading = false
        var beforeMode = settings.workspaceDisplayMode
        var beforeLimit = settings.workspaceRecentLimit
        applySettings(body)
        settingsLoaded = true
        // 设置可能来自另一个窗口或直接改的 settings.json：这里读完要把它落到界面上，
        // 否则页面会一直停在启动时那次读到的东西（文案、隐藏规则都对不上）。
        if (
          settings.workspaceDisplayMode !== beforeMode ||
          settings.workspaceRecentLimit !== beforeLimit
        ) {
          if (settings.workspaceDisplayMode !== MODE_ACTIVE && !recent.loaded) loadRecent()
          syncModeAttribute()
          updateHeaderButton()
          if (activeOnly) applyFilter()
        }
        setAutoStatus('')
        updatePaletteToggle()
        maybeBaseline()
      })
      .catch(function () {
        if (stopped) return
        settingsLoading = false
        lastSettingsPoll = Date.now()
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
    // 属性也写一份：选择器 .dsgb-auto-color input[type="checkbox"] 依赖它。
    input.setAttribute('type', 'checkbox')
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

  function updatePromoteToggle() {
    var inputs = document.querySelectorAll('.dsgb-promote input[type="checkbox"]')
    var nextChecked = settings.autoPromoteActiveWorkspace !== false
    // 置顶不依赖全量列表（服务端自己读 registry），所以只要设置读到了就能改。
    var nextDisabled = !settingsLoaded || promoteSaving
    for (var i = 0; i < inputs.length; i += 1) {
      if (!promoteSaving && inputs[i].checked !== nextChecked) inputs[i].checked = nextChecked
      if (inputs[i].disabled !== nextDisabled) inputs[i].disabled = nextDisabled
    }
  }

  function ensurePromoteToggle() {
    if (stopped) return
    var palette = document.querySelector('.dsgb-palette')
    if (palette === null) return
    if (palette.querySelector('.dsgb-promote') !== null) {
      updatePromoteToggle()
      return
    }
    var suffix = Math.random().toString(36).slice(2, 8)
    var hintId = 'dsgb-promote-hint-' + suffix
    var wrap = document.createElement('div')
    wrap.className = 'dsgb-promote'
    var label = document.createElement('label')
    var input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('type', 'checkbox')
    input.setAttribute('aria-describedby', hintId)
    var text = document.createElement('span')
    text.textContent = '最近活动的项目自动置顶'
    label.appendChild(input)
    label.appendChild(text)
    var hint = document.createElement('div')
    hint.className = 'dsgb-auto-hint'
    hint.id = hintId
    hint.textContent = '新会话开始执行时，把它所在的文件夹移到第一位；同一会话继续执行不会重复移动。'
    wrap.appendChild(label)
    wrap.appendChild(hint)
    input.addEventListener('change', function () {
      setPromote(input.checked, input)
    })
    var reset = palette.querySelector('.dsgb-palette-reset')
    if (reset !== null && reset.parentNode === palette) palette.insertBefore(wrap, reset)
    else palette.appendChild(wrap)
    updatePromoteToggle()
  }

  function setPromote(enabled, input) {
    if (!settingsLoaded || promoteSaving) return
    promoteSaving = true
    updatePromoteToggle()
    postJson(SETTINGS_URL, { autoPromoteActiveWorkspace: enabled }, function (ok, body) {
      if (stopped) return
      promoteSaving = false
      if (ok) {
        applySettings(body)
        updatePromoteToggle()
        return
      }
      if (input !== null && input !== undefined) input.checked = !enabled
      updatePromoteToggle()
      showPromoteError('自动置顶设置保存失败：' + (body !== null && body !== undefined && body.message ? body.message : '请稍后重试'))
    })
  }

  function showPromoteError(message) {
    var now = Date.now()
    if (now - lastPromoteErrorAt < AUTO_ERROR_THROTTLE_MS) return
    lastPromoteErrorAt = now
    if (stopped) return
    var toast = document.createElement('div')
    toast.className = 'dsgb-auto-error'
    toast.setAttribute('role', 'alert')
    toast.textContent = message
    document.body.appendChild(toast)
    setTimeout(function () {
      if (toast.parentNode !== null) toast.parentNode.removeChild(toast)
    }, 6000)
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
    ensurePromoteToggle()
    applyFilter()
    if (Date.now() - lastWorkspacesPoll >= WORKSPACES_POLL_MS) {
      lastWorkspacesPoll = Date.now()
      loadWorkspaces()
    }
    // 最近列表只在过滤开着且模式需要它时轮询：关着的时候不白花请求。
    if (activeOnly && modeOf() !== MODE_ACTIVE && Date.now() - lastRecentPoll >= RECENT_POLL_MS) {
      loadRecent()
    }
    // 设置同样要周期性重读：多窗口、手改 settings.json 都得能同步过来。
    if (settingsRetry === null && Date.now() - lastSettingsPoll >= SETTINGS_POLL_MS) {
      loadSettings()
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
      if (
        target !== null &&
        target !== undefined &&
        typeof target.closest === 'function' &&
        target.closest('.dsgb-auto-color, .dsgb-promote') !== null
      ) {
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
            !node.classList.contains('dsgb-promote') &&
            !node.classList.contains('dsgb-active-toggle') &&
            !node.classList.contains('dsgb-mode-menu') &&
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

  /** 点菜单外面关掉菜单（菜单内部的点击不关，交给选项自己处理）。 */
  function onDocumentClickCapture(event) {
    if (modeMenu === null) return
    var target = event.target
    if (target !== null && target !== undefined && typeof target.closest === 'function') {
      if (target.closest('.dsgb-mode-menu') !== null) return
      if (modeMenuAnchor !== null && target.closest('.dsgb-active-toggle') !== null) return
    }
    closeModeMenu()
  }

  /** 别处右键：先关掉我们的菜单，避免两个菜单叠在一起。 */
  function onDocumentContextMenu(event) {
    if (modeMenu === null) return
    var target = event.target
    if (target !== null && target !== undefined && typeof target.closest === 'function') {
      if (target.closest('.dsgb-active-toggle') !== null) return
    }
    closeModeMenu()
  }

  /** Esc 关菜单；上下键在三个模式之间移动焦点。 */
  function onDocumentKeyDown(event) {
    if (modeMenu === null) return
    var key = event.key
    if (key === 'Escape' || key === 'Esc') {
      event.preventDefault()
      closeModeMenu()
      if (headerButton !== null && typeof headerButton.focus === 'function') headerButton.focus()
      return
    }
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return
    var items = modeMenu.querySelectorAll('.dsgb-mode-item input')
    if (items.length === 0) return
    event.preventDefault()
    var active = document.activeElement
    var index = -1
    for (var i = 0; i < items.length; i += 1) {
      if (items[i] === active) {
        index = i
        break
      }
    }
    var next = key === 'ArrowDown' ? index + 1 : index - 1
    if (next < 0) next = items.length - 1
    if (next >= items.length) next = 0
    if (typeof items[next].focus === 'function') items[next].focus()
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
    document.removeEventListener('click', onDocumentClickCapture, true)
    document.removeEventListener('contextmenu', onDocumentContextMenu, true)
    document.removeEventListener('keydown', onDocumentKeyDown, true)
    closeModeMenu()
    document.documentElement.removeAttribute('data-dsgb-mode')
    if (headerButton !== null && headerButton.parentNode !== null) headerButton.parentNode.removeChild(headerButton)
    headerButton = null
    if (headerEl !== null && headerEl.hasAttribute('data-dsgb-chrome-header')) headerEl.removeAttribute('data-dsgb-chrome-header')
    headerEl = null
    clearFilterAttributes()
    var toggles = document.querySelectorAll('.dsgb-auto-color, .dsgb-promote')
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
    // 真实宿主由 waitForApi 先拿到 api；测试桩直接 start 时这里补一次，
    // 否则「会话归属」永远读不到，recent 模式会退化成全局集合语义。
    if (api === null && window.__dshGrokBuddy !== null && typeof window.__dshGrokBuddy === 'object') {
      api = window.__dshGrokBuddy
    }
    injectStyle()
    loadSettings()
    loadWorkspaces()
    ensureHeaderButton()
    ensurePaletteToggle()
    ensurePromoteToggle()
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
    // 菜单的关闭与键盘操作：点外面关、Esc 关、方向键在选项间移动。
    document.addEventListener('click', onDocumentClickCapture, true)
    document.addEventListener('contextmenu', onDocumentContextMenu, true)
    document.addEventListener('keydown', onDocumentKeyDown, true)
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

  // 单元测试桩没有侧栏结构，默认不启动；显式打开 __DSH_CHROME_TEST__ 时
  // 只暴露 start/stop，由测试自己决定何时启动（真实宿主永远走 waitForApi）。
  if (window.__DSH_TEST__ === true && window.__DSH_CHROME_TEST__ === true) {
    window.__dsgbChromeTest = {
      start: start,
      stop: cleanup,
      tick: tick,
      openMenu: openModeMenu,
      closeMenu: closeModeMenu,
      setMode: setDisplayMode,
      setLimit: setRecentLimit,
      mode: modeOf,
      effectiveMode: effectiveMode,
      limit: recentLimit,
      loadRecent: loadRecent,
      recentView: recentView,
      owner: function (sessionId) {
        return sessionOwner.get(sessionId)
      },
    }
    return
  }

  waitForApi()
})();
