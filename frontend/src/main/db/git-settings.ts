import { isAbsolute } from 'path'
import { DEFAULT_GIT_SETTINGS, type GitSettings } from '../../shared/git/settings'
import { requireDatabase } from './connection'
import { DbError } from './errors'

/** 设置表里的键：一个键存一份完整 JSON，新增字段时靠默认值合并 */
const GIT_SETTINGS_KEY = 'git.settings'

/**
 * 读取 Git 设置。
 * 没存过或内容损坏时回退默认值（自动探测 PATH 上的 git）：
 * 设置存储坏了不该让文件树的 Git 标记整个失效。
 */
export function getGitSettings(): GitSettings {
  const row = requireDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(GIT_SETTINGS_KEY) as { value: string } | undefined
  if (!row) {
    return { ...DEFAULT_GIT_SETTINGS }
  }
  try {
    return coerceSettings(JSON.parse(row.value))
  } catch (error) {
    console.warn('Git 设置无法解析，已使用默认值', error)
    return { ...DEFAULT_GIT_SETTINGS }
  }
}

/**
 * 保存 Git 设置。
 * 空路径表示自动探测；非空必须是绝对路径。文件是否真的存在由「测试」按钮与
 * 实际执行时的回退校验，这里只拦明显写错的字符串。
 * @throws DbError 路径非法
 */
export function saveGitSettings(input: GitSettings): GitSettings {
  const settings = requireSettings(input)
  requireDatabase()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .run(GIT_SETTINGS_KEY, JSON.stringify(settings))
  return settings
}

/** 读盘用的宽松解析：当前值合法就保留，否则视为自动探测 */
function coerceSettings(input: unknown): GitSettings {
  if (!input || typeof input !== 'object') {
    return { ...DEFAULT_GIT_SETTINGS }
  }
  const record = input as Record<string, unknown>
  const path = record.gitPath
  return { gitPath: isGitPath(path) ? path.trim() : '' }
}

/** 保存用的严格校验：路径必须是字符串；非空时必须是绝对路径 */
function requireSettings(input: unknown): GitSettings {
  if (!input || typeof input !== 'object') {
    throw new DbError('Git 设置无效', 'INVALID_ARGUMENT')
  }
  const record = input as Record<string, unknown>
  const path = record.gitPath
  if (typeof path !== 'string') {
    throw new DbError('Git 路径无效', 'INVALID_ARGUMENT')
  }
  const trimmed = path.trim()
  if (trimmed.length === 0) {
    return { gitPath: '' }
  }
  // 相对路径会随主进程的工作目录漂移，必须拒绝
  if (!isAbsolute(trimmed)) {
    throw new DbError('Git 路径必须是可执行文件的绝对路径', 'INVALID_ARGUMENT')
  }
  return { gitPath: trimmed }
}

/** 绝对路径：本机平台上可直接执行的文件路径 */
function isGitPath(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const trimmed = value.trim()
  return trimmed.length === 0 || isAbsolute(trimmed)
}
