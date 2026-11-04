import type {
  EditorTabsSnapshot,
  RecentProject,
  RestoredEditorFile
} from '../../shared/workspace/types'
import { requireDatabase } from './connection'

/** 最近项目与启动恢复状态的整体存储键：一份 JSON 存全部，加字段靠默认值合并 */
const WORKSPACE_PROJECTS_KEY = 'workspace.projects'

/** MRU 历史上限：菜单只展示最近 5 个项目，超出的旧记录自动丢弃 */
const MAX_RECENT_PROJECTS = 5

/** 落库结构：recent 为 MRU 路径列表（首位最新），restorePath 为上次未手动关闭的项目，
 * openTabs 按项目路径存各自未关闭的编辑器页签快照（重启时恢复） */
interface WorkspaceProjects {
  recent: string[]
  restorePath: string | null
  openTabs: Record<string, EditorTabsSnapshot>
}

/** 读整份状态；缺行或内容损坏时回退空态，不让菜单/启动恢复功能因此报错 */
function readState(): WorkspaceProjects {
  const row = requireDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(WORKSPACE_PROJECTS_KEY) as { value: string } | undefined
  if (!row) {
    return { recent: [], restorePath: null, openTabs: {} }
  }
  try {
    return coerce(JSON.parse(row.value))
  } catch (error) {
    console.warn('工作区项目状态无法解析，已使用空态', error)
    return { recent: [], restorePath: null, openTabs: {} }
  }
}

/** 校验单个页签条目：仅保留带非空字符串 path/name 的对象 */
function coerceFile(input: unknown): RestoredEditorFile | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (typeof record.path !== 'string' || record.path === '') {
    return null
  }
  const name = typeof record.name === 'string' && record.name !== '' ? record.name : record.path
  return { path: record.path, name }
}

/** 校验单个项目的页签快照：逐条过滤非法文件，activePath 必须是列表中的一项否则置 null */
function coerceSnapshot(input: unknown): EditorTabsSnapshot | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (!Array.isArray(record.files)) {
    return null
  }
  const files = record.files
    .map(coerceFile)
    .filter((file): file is RestoredEditorFile => file !== null)
  const activePath =
    typeof record.activePath === 'string' && files.some((file) => file.path === record.activePath)
      ? record.activePath
      : (files[0]?.path ?? null)
  return { files, activePath }
}

/** 校验 openTabs 映射：仅保留路径为键、快照合法的条目 */
function coerceOpenTabs(input: unknown): Record<string, EditorTabsSnapshot> {
  if (!input || typeof input !== 'object') {
    return {}
  }
  const result: Record<string, EditorTabsSnapshot> = {}
  for (const [path, raw] of Object.entries(input as Record<string, unknown>)) {
    if (path === '') {
      continue
    }
    const snapshot = coerceSnapshot(raw)
    if (snapshot && snapshot.files.length > 0) {
      result[path] = snapshot
    }
  }
  return result
}

/** 逐字段过滤：只保留非空字符串路径，去重保序并裁剪到上限 */
function coerce(input: unknown): WorkspaceProjects {
  if (!input || typeof input !== 'object') {
    return { recent: [], restorePath: null, openTabs: {} }
  }
  const record = input as Record<string, unknown>
  const recent = Array.isArray(record.recent)
    ? [
        ...new Set(
          record.recent.filter((item): item is string => typeof item === 'string' && item !== '')
        )
      ].slice(0, MAX_RECENT_PROJECTS)
    : []
  const restorePath =
    typeof record.restorePath === 'string' && record.restorePath !== '' ? record.restorePath : null
  const openTabs = coerceOpenTabs(record.openTabs)
  return { recent, restorePath, openTabs }
}

/** 写整份状态：upsert，时间戳由数据库生成 */
function writeState(state: WorkspaceProjects): void {
  requireDatabase()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .run(WORKSPACE_PROJECTS_KEY, JSON.stringify(state))
}

/** 最近项目列表（MRU 顺序，原样返回绝对路径），供「文件」菜单渲染 */
export function listRecentProjects(): RecentProject[] {
  return readState().recent.map((path) => ({ path }))
}

/**
 * 记录一个刚打开的项目：置于 MRU 首位、去重、裁剪到 5 个，
 * 同时把它设为待恢复路径（下次启动默认打开它）。
 */
export function recordProjectOpened(path: string): void {
  if (typeof path !== 'string' || path === '') {
    return
  }
  const state = readState()
  const recent = [path, ...state.recent.filter((item) => item !== path)].slice(
    0,
    MAX_RECENT_PROJECTS
  )
  // 保留其他项目的页签快照；当前项目的旧快照会被渲染进程随后的保存覆盖
  writeState({ recent, restorePath: path, openTabs: state.openTabs })
}

/**
 * 手动关闭文件夹：清除待恢复路径与该项目页签快照（下次启动不再自动打开/恢复），MRU 历史保留。
 */
export function clearRestoreProject(path: string): void {
  const state = readState()
  const openTabs = { ...state.openTabs }
  if (typeof path === 'string' && path !== '') {
    delete openTabs[path]
  }
  writeState({ ...state, restorePath: null, openTabs })
}

/** 上次未手动关闭的项目路径；无记录时返回 null，供启动时自动打开 */
export function getLastProjectPath(): string | null {
  return readState().restorePath
}

/**
 * 保存某项目当前未关闭的编辑器页签快照：空列表时删除条目，避免下次启动拿到空页签。
 */
export function saveOpenTabs(path: string, snapshot: EditorTabsSnapshot): void {
  if (typeof path !== 'string' || path === '') {
    return
  }
  const state = readState()
  const openTabs = { ...state.openTabs }
  const files = Array.isArray(snapshot?.files) ? snapshot.files : []
  if (files.length === 0) {
    delete openTabs[path]
  } else {
    const valid = coerceSnapshot(snapshot)
    if (valid && valid.files.length > 0) {
      openTabs[path] = valid
    }
  }
  writeState({ ...state, openTabs })
}

/** 某项目上次未手动关闭的编辑器页签快照；无记录时返回 null，供启动时恢复页签 */
export function getOpenTabs(path: string): EditorTabsSnapshot | null {
  if (typeof path !== 'string' || path === '') {
    return null
  }
  return readState().openTabs[path] ?? null
}
