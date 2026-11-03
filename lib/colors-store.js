/**
 * 项目配色表的持久化（宿主半侧）。
 *
 * 为什么不放 localStorage：桌面端和 dsh web 的来源（origin）不一样，端口每次启动
 * 还可能变，localStorage 等于一次重启就清空。所以落成插件家目录下的一个 JSON 文件。
 *
 * 以 **workspaceId** 为键：标题会改、会话会新建，只有 Workspace 的 key 是稳的。
 * 顺带记一份 path 作为人肉可读的备份，但读的时候只认 workspaceId。
 *
 * 文件损坏、字段缺失、权限不足 —— 一律不崩：退回空表（也就是各项目的哈希默认色），
 * 打一条 warn 就完事。
 *
 * @module dsh-grok-buddy/colors-store
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 当前 schema 版本。升级时按版本号迁移。 */
export const COLORS_VERSION = 1

/**
 * 插件家目录：`$DSH_HOME/dsh-grok-buddy`，没设 DSH_HOME 就退回 `~/.dsh/dsh-grok-buddy`。
 * @param {NodeJS.ProcessEnv} [env] 环境变量（测试时可注入）。
 * @returns {string} 绝对路径。
 */
export function pluginHome(env) {
  const source = env !== undefined && env !== null ? env : process.env
  const root =
    typeof source.DSH_HOME === 'string' && source.DSH_HOME !== ''
      ? source.DSH_HOME
      : path.join(os.homedir(), '.dsh')
  return path.join(root, 'dsh-grok-buddy')
}

/**
 * 配色文件路径。
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {string} 绝对路径。
 */
export function colorsFile(env) {
  return path.join(pluginHome(env), 'colors.json')
}

/** 规范化一份「项目 → 颜色」。非对象、非字符串键值、非法颜色全部丢掉。 */
export function sanitizeProjects(raw, normalize) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key === '') continue
    const color = normalize(value)
    if (color !== null) out[key] = color
  }
  return out
}

/**
 * 建一个配色表。读写都走同一个实例，内存里留一份，避免每次取色都读盘。
 *
 * @param {object} options 选项。
 * @param {(value: unknown) => (string|null)} options.normalize 颜色校验/规范化（宿主侧用纯 hex 版）。
 * @param {(hex: string) => string} [options.defaultFor] 默认色推导（用于「恢复默认」）。
 * @param {string} [options.file] 文件路径；默认按 DSH_HOME 推。
 * @param {(message: string) => void} [options.warn] 告警出口。
 * @returns {object} 配色表。
 */
export function createColorStore(options) {
  const normalize = options.normalize
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  const file = typeof options.file === 'string' && options.file !== '' ? options.file : colorsFile()
  /** @type {Record<string, string>} */
  let projects = {}
  /** 可读备份：workspaceId → 目录路径。只写不读。 */
  let paths = {}
  let loaded = false

  /**
   * 从磁盘读。失败就当空表，但只在第一次真正读盘时报一次 warn。
   * @returns {Record<string, string>} 当前表。
   */
  function load() {
    if (loaded) return projects
    loaded = true
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      // 文件不存在是正常情况（还没人改过颜色），不算错误
      if (err !== null && err !== undefined && err.code !== 'ENOENT') {
        warn('读不出配色文件，先按默认色走: ' + file + ' (' + String(err.message || err) + ')')
      }
      return projects
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      warn('配色文件不是合法 JSON，先按默认色走: ' + file)
      return projects
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn('配色文件结构不对（不是对象），先按默认色走: ' + file)
      return projects
    }
    projects = sanitizeProjects(parsed.projects, normalize)
    if (parsed.paths !== null && typeof parsed.paths === 'object' && !Array.isArray(parsed.paths)) {
      for (const [key, value] of Object.entries(parsed.paths)) {
        if (typeof value === 'string') paths[key] = value
      }
    }
    return projects
  }

  /** 原子写：先写 tmp 再 rename，避免读到半截文件。 */
  function flush() {
    const body = JSON.stringify({ version: COLORS_VERSION, projects, paths }, null, 2) + '\n'
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
      warn('写不进配色文件: ' + file + ' (' + String((err && err.message) || err) + ')')
      return false
    }
  }

  return {
    /** 文件路径（调试/测试用）。 */
    get file() {
      return file
    },
    /** 当前整表（只读快照）。 */
    snapshot() {
      load()
      return { version: COLORS_VERSION, projects: { ...projects }, paths: { ...paths } }
    },
    /** 某一项目的自定义色；没设过返回 undefined。 */
    get(workspaceId) {
      load()
      return typeof workspaceId === 'string' ? projects[workspaceId] : undefined
    },
    /**
     * 设/清一个项目的颜色。
     * @param {string} workspaceId Workspace key。
     * @param {unknown} value 颜色；null / '' / 'default' 表示恢复默认。
     * @param {string} [cwd] 可选的目录备份（只写不读）。
     * @returns {{ok: boolean, color?: string, error?: string}} 结果。
     */
    set(workspaceId, value, cwd) {
      load()
      if (typeof workspaceId !== 'string' || workspaceId === '') {
        return { ok: false, error: 'workspaceId 必须是非空字符串' }
      }
      const clear = value === null || value === undefined || value === '' || value === 'default'
      if (clear) {
        delete projects[workspaceId]
        if (typeof cwd === 'string' && cwd !== '') paths[workspaceId] = cwd
        flush()
        return { ok: true }
      }
      const color = normalize(value)
      if (color === null) return { ok: false, error: '颜色必须是 #rrggbb 或预设色名' }
      projects[workspaceId] = color
      if (typeof cwd === 'string' && cwd !== '') paths[workspaceId] = cwd
      flush()
      return { ok: true, color }
    },
    /** 丢掉内存表，下次访问重新读盘（测试用）。 */
    reload() {
      loaded = false
      projects = {}
      paths = {}
    },
  }
}
