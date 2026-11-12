import type { RemoteModelListRequest } from '../../shared/model-config/types'
import { requireDatabase } from './connection'
import { DbError } from './errors'

/** 设置表里的键：记住上次成功导入时填写的连接信息 */
const MODEL_IMPORT_FORM_KEY = 'modelConfig.importForm'

/** 任意值 → 去空白的字符串 */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 读取上次成功导入时填写的连接信息。
 * 没存过、内容损坏或字段缺失时返回 null：回填只是便利功能，不该拦住导入页。
 */
export function getModelImportForm(): RemoteModelListRequest | null {
  const row = requireDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(MODEL_IMPORT_FORM_KEY) as { value: string } | undefined
  if (!row) {
    return null
  }
  try {
    return coerceForm(JSON.parse(row.value))
  } catch (error) {
    console.warn('一键导入的连接信息无法解析，已忽略回填', error)
    return null
  }
}

/**
 * 保存本次成功导入时填写的连接信息，供下次打开导入页时回填。
 * 与请求参数使用同一套字段，三项都必须非空。
 * @throws DbError 参数非法或字段为空
 */
export function saveModelImportForm(input: RemoteModelListRequest): RemoteModelListRequest {
  if (!input || typeof input !== 'object') {
    throw new DbError('参数无效', 'INVALID_ARGUMENT')
  }
  const form: RemoteModelListRequest = {
    baseUrl: text(input.baseUrl),
    modelsUrl: text(input.modelsUrl),
    authorization: text(input.authorization)
  }
  if (!form.baseUrl || !form.modelsUrl || !form.authorization) {
    throw new DbError('连接信息不完整，无法保存', 'INVALID_ARGUMENT')
  }
  requireDatabase()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .run(MODEL_IMPORT_FORM_KEY, JSON.stringify(form))
  return form
}

/** 读盘用的宽松解析：三项都按字符串清洗，全为空时视为没有保存过 */
function coerceForm(input: unknown): RemoteModelListRequest | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  const form: RemoteModelListRequest = {
    baseUrl: text(record.baseUrl),
    modelsUrl: text(record.modelsUrl),
    authorization: text(record.authorization)
  }
  return form.baseUrl || form.modelsUrl || form.authorization ? form : null
}
