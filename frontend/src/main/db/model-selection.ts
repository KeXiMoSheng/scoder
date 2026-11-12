import { requireDatabase } from './connection'
import { DbError } from './errors'

/** 设置表里的键：对话框上次选中的模型（对应 model_configs.id） */
const SELECTED_MODEL_KEY = 'modelConfig.selectedId'

/**
 * 读取对话框上次选中的模型主键。
 * 没存过或内容损坏时返回 null，由调用方回落到当前模型列表的第一个。
 * 这里不查 model_configs：模型是否仍存在由持有完整列表的渲染进程判断。
 */
export function getSelectedModelConfigId(): number | null {
  const row = requireDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(SELECTED_MODEL_KEY) as { value: string } | undefined
  if (!row) {
    return null
  }
  try {
    return coerceSelectedId(JSON.parse(row.value))
  } catch (error) {
    console.warn('上次选中的模型记录无法解析，已忽略', error)
    return null
  }
}

/**
 * 记录对话框当前选中的模型，供下次打开时恢复。
 * 每次切换都覆盖同一行，不累积历史。
 * @throws DbError 主键非法
 */
export function saveSelectedModelConfigId(id: number): number {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new DbError('模型主键无效', 'INVALID_ARGUMENT')
  }
  requireDatabase()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .run(SELECTED_MODEL_KEY, JSON.stringify(id))
  return id
}

/** 读盘用的宽松解析：只接受正整数主键 */
function coerceSelectedId(input: unknown): number | null {
  return typeof input === 'number' && Number.isInteger(input) && input > 0 ? input : null
}
