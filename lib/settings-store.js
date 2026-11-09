/**
 * 工作区外观设置（宿主半侧）。
 *
 * 目前服务于「新建文件夹自动配色」：
 *   · autoColorNewFolders —— 开关本身；
 *   · baselineComplete    —— 是否已经在宿主全量 Workspace 列表上建过基线；
 *   · knownWorkspaces     —— 已知（基线 + 自动分配）的 Workspace；
 *   · autoAssignedWorkspaces —— 插件自动分配过的 Workspace（重置默认色后仍受保护）。
 *
 * 单独一份文件：colors.json 的 schema 只表达「项目 → 颜色」；设置同样落在
 * 插件家目录，同样原子写。文件损坏或字段非法时退回默认值（关闭/未建立基线），
 * 不阻塞页面。
 *
 * @module dsh-grok-buddy/settings-store
 */

import fs from 'node:fs'
import path from 'node:path'
import { pluginHome } from './colors-store.js'

/** 当前 schema 版本。 */
export const SETTINGS_VERSION = 1

/** known / assigned 的防御上限：Workspace 数量远小于这个值。 */
const MAX_IDS = 5000

/** 单个 workspaceId 的防御上限。 */
const MAX_ID_LENGTH = 512

/**
 * 设置文件路径。
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {string} 绝对路径。
 */
export function settingsFile(env) {
  return path.join(pluginHome(env), 'settings.json')
}

/**
 * 只保留非空、长度合理的字符串 id，并去重。
 * @param {unknown} raw 候选数组。
 * @returns {string[]} 清洗后的 id。
 */
export function sanitizeKnownWorkspaces(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    if (item === '' || item.length > MAX_ID_LENGTH) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (out.length >= MAX_IDS) break
  }
  return out
}

/** 只保留前 MAX_IDS 个，避免文件无限增长。 */
function capSet(set) {
  while (set.size > MAX_IDS) {
    const first = set.values().next().value
    if (typeof first !== 'string') break
    set.delete(first)
  }
}

/**
 * 建一个设置表。读写同一实例，内存里留一份。
 *
 * @param {object} [options] 选项。
 * @param {string} [options.file] 文件路径；默认按 DSH_HOME 推。
 * @param {(message: string) => void} [options.warn] 告警出口。
 * @returns {object} 设置表。
 */
export function createSettingsStore(options) {
  const opts = options !== undefined && options !== null ? options : {}
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {}
  const file = typeof opts.file === 'string' && opts.file !== '' ? opts.file : settingsFile()
  let autoColorNewFolders = false
  let baselineComplete = false
  const known = new Set()
  const autoAssigned = new Set()
  let loaded = false

  function load() {
    if (loaded) return
    loaded = true
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (err !== null && err !== undefined && err.code !== 'ENOENT') {
        warn('读不出设置文件，先按默认值走: ' + file + ' (' + String(err.message || err) + ')')
      }
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      warn('设置文件不是合法 JSON，先按默认值走: ' + file)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn('设置文件结构不对（不是对象），先按默认值走: ' + file)
      return
    }
    autoColorNewFolders = parsed.autoColorNewFolders === true
    baselineComplete = parsed.baselineComplete === true
    for (const id of sanitizeKnownWorkspaces(parsed.knownWorkspaces)) known.add(id)
    for (const id of sanitizeKnownWorkspaces(parsed.autoAssignedWorkspaces)) autoAssigned.add(id)
  }

  /** 当前设置快照。 */
  function snapshot() {
    load()
    return {
      version: SETTINGS_VERSION,
      autoColorNewFolders,
      baselineComplete,
      knownWorkspaces: [...known],
      autoAssignedWorkspaces: [...autoAssigned],
    }
  }

  /** 原子写；失败时由调用方回滚内存。 */
  function flush() {
    const body = JSON.stringify(
      {
        version: SETTINGS_VERSION,
        autoColorNewFolders,
        baselineComplete,
        knownWorkspaces: [...known],
        autoAssignedWorkspaces: [...autoAssigned],
      },
      null,
      2,
    ) + '\n'
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, file)
      return true
    } catch (err) {
      try {
        fs.unlinkSync(tmp)
      } catch (ignored) {}
      warn('写不进设置文件: ' + file + ' (' + String((err && err.message) || err) + ')')
      return false
    }
  }

  /**
   * 改设置。knownWorkspaces 是**追加**语义：多个窗口各自看到新 Workspace 时
   * 不会用后到的数组覆盖先到的记录。
   *
   * @param {object} patch { autoColorNewFolders?: boolean, baselineComplete?: boolean, knownWorkspaces?: string[] }
   * @returns {{ok: boolean, status?: number, error?: string}} 结果；成功时附带快照。
   */
  function update(patch) {
    load()
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: '设置必须是对象' }
    }
    const hasToggle = Object.prototype.hasOwnProperty.call(patch, 'autoColorNewFolders')
    if (hasToggle && typeof patch.autoColorNewFolders !== 'boolean') {
      return { ok: false, error: 'autoColorNewFolders 必须是布尔值' }
    }
    const hasBaseline = Object.prototype.hasOwnProperty.call(patch, 'baselineComplete')
    if (hasBaseline && typeof patch.baselineComplete !== 'boolean') {
      return { ok: false, error: 'baselineComplete 必须是布尔值' }
    }
    const hasKnown = Object.prototype.hasOwnProperty.call(patch, 'knownWorkspaces')
    if (hasKnown && !Array.isArray(patch.knownWorkspaces)) {
      return { ok: false, error: 'knownWorkspaces 必须是数组' }
    }
    const prevToggle = autoColorNewFolders
    const prevBaseline = baselineComplete
    const prevKnown = new Set(known)
    if (hasToggle) autoColorNewFolders = patch.autoColorNewFolders
    if (hasBaseline) baselineComplete = patch.baselineComplete
    if (hasKnown) {
      for (const id of sanitizeKnownWorkspaces(patch.knownWorkspaces)) known.add(id)
      capSet(known)
    }
    if (flush() !== true) {
      autoColorNewFolders = prevToggle
      baselineComplete = prevBaseline
      known.clear()
      for (const id of prevKnown) known.add(id)
      return { ok: false, status: 500, error: '设置文件写不进去，设置没有保存' }
    }
    return { ok: true, ...snapshot() }
  }

  return {
    get file() {
      return file
    },
    snapshot,
    update,
    /** 追加一批已见过的 Workspace。 */
    remember(workspaceIds) {
      return update({ knownWorkspaces: Array.isArray(workspaceIds) ? workspaceIds : [] })
    },
    /**
     * 记一条「由插件自动分配」的 Workspace：同时进 known 与 autoAssigned。
     * 用户之后把它重置成默认色时，两个集合仍然在，旧请求不能再把它重新自动染色。
     */
    rememberAutoAssigned(workspaceIds) {
      load()
      const ids = sanitizeKnownWorkspaces(Array.isArray(workspaceIds) ? workspaceIds : [])
      if (ids.length === 0) return { ok: true, ...snapshot() }
      const prevKnown = new Set(known)
      const prevAssigned = new Set(autoAssigned)
      for (const id of ids) {
        known.add(id)
        autoAssigned.add(id)
      }
      capSet(known)
      capSet(autoAssigned)
      if (flush() !== true) {
        known.clear()
        for (const id of prevKnown) known.add(id)
        autoAssigned.clear()
        for (const id of prevAssigned) autoAssigned.add(id)
        return { ok: false, status: 500, error: '设置文件写不进去，自动分配记录没有保存' }
      }
      return { ok: true, ...snapshot() }
    },
    /** 丢掉内存表，下次访问重新读盘。 */
    reload() {
      loaded = false
      autoColorNewFolders = false
      baselineComplete = false
      known.clear()
      autoAssigned.clear()
    },
  }
}
