import type { RecentProject } from '../../shared/workspace/types'
import { requireDatabase } from './connection'

/** 最近项目与启动恢复状态的整体存储键：一份 JSON 存全部，加字段靠默认值合并 */
const WORKSPACE_PROJECTS_KEY = 'workspace.projects'

/** MRU 历史上限：菜单只展示最近 5 个项目，超出的旧记录自动丢弃 */
const MAX_RECENT_PROJECTS = 5

/** 落库结构：recent 为 MRU 路径列表（首位最新），restorePath 为上次未手动关闭的项目 */
interface WorkspaceProjects {
  recent: string[]
  restorePath: string | null
}

/** 读整份状态；缺行或内容损坏时回退空态，不让菜单/启动恢复功能因此报错 */
function readState(): WorkspaceProjects {
  const row = requireDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(WORKSPACE_PROJECTS_KEY) as { value: string } | undefined
  if (!row) {
    return { recent: [], restorePath: null }
  }
  try {
    return coerce(JSON.parse(row.value))
  } catch (error) {
    console.warn('工作区项目状态无法解析，已使用空态', error)
    return { recent: [], restorePath: null }
  }
}

/** 逐字段过滤：只保留非空字符串路径，去重保序并裁剪到上限 */
function coerce(input: unknown): WorkspaceProjects {
  if (!input || typeof input !== 'object') {
    return { recent: [], restorePath: null }
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
  return { recent, restorePath }
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
  const recent = [path, ...readState().recent.filter((item) => item !== path)].slice(
    0,
    MAX_RECENT_PROJECTS
  )
  writeState({ recent, restorePath: path })
}

/** 手动关闭文件夹：仅清除待恢复路径，MRU 历史保留（下次启动不再自动打开） */
export function clearRestoreProject(): void {
  writeState({ ...readState(), restorePath: null })
}

/** 上次未手动关闭的项目路径；无记录时返回 null，供启动时自动打开 */
export function getLastProjectPath(): string | null {
  return readState().restorePath
}
