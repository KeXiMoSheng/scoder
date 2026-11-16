import { win32 } from 'path'
import { DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from '../../shared/terminal/settings'
import { requireDatabase } from './connection'
import { DbError } from './errors'

/** 设置表里的键：一个键存一份完整 JSON，新增字段时靠默认值合并 */
const TERMINAL_SETTINGS_KEY = 'terminal.settings'

/**
 * 读取终端设置。
 * 没存过或内容损坏时回退默认值（不使用 PowerShell 7）：
 * 设置存储坏了不该让终端起不来。
 */
export function getTerminalSettings(): TerminalSettings {
  const row = requireDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(TERMINAL_SETTINGS_KEY) as { value: string } | undefined
  if (!row) {
    return { ...DEFAULT_TERMINAL_SETTINGS }
  }
  try {
    return coerceSettings(JSON.parse(row.value))
  } catch (error) {
    console.warn('终端设置无法解析，已使用默认值', error)
    return { ...DEFAULT_TERMINAL_SETTINGS }
  }
}

/**
 * 保存终端设置。
 * 空路径表示不使用 PowerShell 7；非空必须是 .exe 的绝对路径。
 * 启动时由探测侧再校验文件是否存在，这里只拦明显写错的字符串。
 * @throws DbError 路径非法
 */
export function saveTerminalSettings(input: TerminalSettings): TerminalSettings {
  const settings = requireSettings(input)
  requireDatabase()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .run(TERMINAL_SETTINGS_KEY, JSON.stringify(settings))
  return settings
}

/** 读盘用的宽松解析：当前值合法就保留，否则视为不使用 PowerShell 7 */
function coerceSettings(input: unknown): TerminalSettings {
  if (!input || typeof input !== 'object') {
    return { ...DEFAULT_TERMINAL_SETTINGS }
  }
  const record = input as Record<string, unknown>
  const path = record.powershellPath
  return { powershellPath: isPowerShellPath(path) ? path.trim() : '' }
}

/** 保存用的严格校验：路径必须是字符串；非空时必须是 .exe 的绝对路径 */
function requireSettings(input: unknown): TerminalSettings {
  if (!input || typeof input !== 'object') {
    throw new DbError('终端设置无效', 'INVALID_ARGUMENT')
  }
  const record = input as Record<string, unknown>
  const path = record.powershellPath
  if (typeof path !== 'string') {
    throw new DbError('PowerShell 路径无效', 'INVALID_ARGUMENT')
  }
  const trimmed = path.trim()
  if (trimmed.length === 0) {
    return { powershellPath: '' }
  }
  if (!isPowerShellPath(trimmed)) {
    throw new DbError('PowerShell 路径必须是 .exe 文件的绝对路径', 'INVALID_ARGUMENT')
  }
  return { powershellPath: trimmed }
}

/** 绝对路径且以 .exe 结尾：Windows 路径按 win32 规则判断，不受宿主平台影响 */
function isPowerShellPath(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const trimmed = value.trim()
  return win32.isAbsolute(trimmed) && /\.exe$/i.test(trimmed)
}
