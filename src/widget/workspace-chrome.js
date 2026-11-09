/**
 * 工作区标题栏增强（独立模块，构建时拼进 widget.js）。
 *
 * 两个功能：
 *   1. 标题栏「只显示活跃会话」开关：复用 avatar 已经算好的 data-dsgb-tone
 *      （active / dormant），只加一层显示过滤，不重新实现六态判定；
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
  var workspaces = { loaded: false, available: false, ids: [], error: '' }
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
      if (document.documentElement.getAttribute('data-dsgb-active-only') !== '1') {
        document.documentElement.setAttribute('data-dsgb-active-only', '1')
      }
    } else if (document.documentElement.hasAttribute('data-dsgb-active-only')) {
      document.documentElement.removeAttribute('data-dsgb-active-only')
    }
    updateHeaderButton()
    applyFilter()
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
   * 活跃语义唯一来源：widget 已经按 isActive() 把结果写在 avatar 的
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
      if (!sections.has(group)) {
        // 没有会话行的叶分组（空 Workspace）也属于「没有活跃会话」；
        // 但带嵌套 groupSection 的容器不能一起隐藏，否则会连带隐藏里面的活跃分组。
        if (group.querySelector('[class*="groupSection"]') !== null) {
          if (group.hasAttribute('data-dsgb-active-empty')) group.removeAttribute('data-dsgb-active-empty')
        } else if (group.getAttribute('data-dsgb-active-empty') !== '1') {
          group.setAttribute('data-dsgb-active-empty', '1')
        }
        continue
      }
      if (sections.get(group) === true) {
        if (group.hasAttribute('data-dsgb-active-empty')) group.removeAttribute('data-dsgb-active-empty')
      } else if (group.getAttribute('data-dsgb-active-empty') !== '1') {
        group.setAttribute('data-dsgb-active-empty', '1')
      }
    }
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
            return ids
          })
      })
  }

  function loadWorkspaces() {
    if (stopped || workspacesLoading) return
    workspacesLoading = true
    fetchWorkspaceIds()
      .then(function (ids) {
        workspacesLoading = false
        if (stopped) return
        workspaces.loaded = true
        workspaces.available = true
        workspaces.ids = ids
        workspaces.error = ''
        updatePaletteToggle()
        maybeBaseline()
        reconcileFolders()
      })
      .catch(function (error) {
        workspacesLoading = false
        if (stopped) return
        workspaces.loaded = true
        workspaces.available = false
        workspaces.ids = []
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
