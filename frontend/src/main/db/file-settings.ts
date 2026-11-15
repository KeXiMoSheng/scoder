import {
  DEFAULT_FILE_SETTINGS,
  FILE_SETTINGS_LIMITS,
  type FileSettings
} from '../../shared/files/settings'
import { requireDatabase } from './connection'
import { DbError } from './errors'

/** 设置表里的键：一个键存一份完整 JSON，新增字段时靠默认值合并 */
const FILE_SETTINGS_KEY = 'files.limits'

/**
 * 读取文件限制。
 * 没存过、内容损坏或字段越界时一律回退默认值：
 * 设置存储坏了不该让编辑器打不开文件。
 */
export function getFileSettings(): FileSettings {
  const row = requireDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(FILE_SETTINGS_KEY) as { value: string } | undefined
  if (!row) {
    return { ...DEFAULT_FILE_SETTINGS }
  }
  try {
    return coerceSettings(JSON.parse(row.value))
  } catch (error) {
    console.warn('文件设置无法解析，已使用默认值', error)
    return { ...DEFAULT_FILE_SETTINGS }
  }
}

/**
 * 保存文件限制。
 * 校验不通过时整份拒绝，不做部分写入，避免出现“改了一半”的配置。
 * @throws DbError 任一字段非法
 */
export function saveFileSettings(input: FileSettings): FileSettings {
  const settings = requireSettings(input)
  requireDatabase()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .run(FILE_SETTINGS_KEY, JSON.stringify(settings))
  return settings
}

/** 读盘用的宽松解析：当前值合法就保留，否则用默认值 */
function coerceSettings(input: unknown): FileSettings {
  if (!input || typeof input !== 'object') {
    return { ...DEFAULT_FILE_SETTINGS }
  }
  const record = input as Record<string, unknown>
  return {
    maxEditorFileMegabytes: clampPositiveInteger(
      record.maxEditorFileMegabytes,
      FILE_SETTINGS_LIMITS.maxEditorFileMegabytes.min,
      DEFAULT_FILE_SETTINGS.maxEditorFileMegabytes
    )
  }
}

/** 当前值合法（不小于下限的整数）就保留，否则用默认值 */
function clampPositiveInteger(value: unknown, min: number, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : fallback
}

/** 保存用的严格校验：全部字段必须合法，否则整份拒绝 */
function requireSettings(input: unknown): FileSettings {
  if (!input || typeof input !== 'object') {
    throw new DbError('文件设置无效', 'INVALID_ARGUMENT')
  }
  const record = input as Record<string, unknown>
  const megabytes = record.maxEditorFileMegabytes
  const min = FILE_SETTINGS_LIMITS.maxEditorFileMegabytes.min
  if (typeof megabytes !== 'number' || !Number.isSafeInteger(megabytes) || megabytes < min) {
    throw new DbError(`文件大小上限必须是不小于 ${min} 的整数`, 'INVALID_ARGUMENT')
  }
  return { maxEditorFileMegabytes: megabytes }
}
