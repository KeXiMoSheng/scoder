import type { ModelConfig, ModelConfigInput } from '../../shared/model-config/types'
import { requireDatabase } from './connection'
import { DbError } from './errors'

/** 查询列固定列出，避免 SELECT * 在加字段后把多余列带进映射 */
const MODEL_CONFIG_COLUMNS =
  'id, provider_name, base_url, display_name, model_name, api_key, created_at, updated_at'

/** model_configs 表的原始行（snake_case，仅在本文件出现） */
interface ModelConfigRow {
  id: number
  provider_name: string
  base_url: string
  display_name: string
  model_name: string
  api_key: string
  created_at: string
  updated_at: string
}

/** 行记录 → 渲染进程共享类型（snake_case → camelCase） */
function toModelConfig(row: ModelConfigRow): ModelConfig {
  return {
    id: row.id,
    providerName: row.provider_name,
    baseUrl: row.base_url,
    displayName: row.display_name,
    modelName: row.model_name,
    apiKey: row.api_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * 校验并清洗表单输入：除 API Key 外均不允许为空。
 * 清洗放在仓储入口，IPC、命令行或测试等任何调用方都得到同一套规则。
 */
function normalizeInput(input: ModelConfigInput): ModelConfigInput {
  if (!input || typeof input !== 'object') {
    throw new DbError('参数无效', 'INVALID_ARGUMENT')
  }
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  const normalized: ModelConfigInput = {
    providerName: text(input.providerName),
    baseUrl: text(input.baseUrl),
    displayName: text(input.displayName),
    modelName: text(input.modelName),
    apiKey: text(input.apiKey)
  }
  if (!normalized.providerName) {
    throw new DbError('供应商名不能为空', 'INVALID_ARGUMENT')
  }
  if (!normalized.baseUrl) {
    throw new DbError('模型地址不能为空', 'INVALID_ARGUMENT')
  }
  if (!normalized.displayName) {
    throw new DbError('模型显示名称不能为空', 'INVALID_ARGUMENT')
  }
  if (!normalized.modelName) {
    throw new DbError('模型名称不能为空', 'INVALID_ARGUMENT')
  }
  return normalized
}

/** 主键必须是正整数 */
function assertId(id: number): void {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new DbError('参数无效', 'INVALID_ARGUMENT')
  }
}

/** 读取全部模型配置（按创建时间倒序，即 id 倒序） */
export function listModelConfigs(): ModelConfig[] {
  const rows = requireDatabase()
    .prepare(`SELECT ${MODEL_CONFIG_COLUMNS} FROM model_configs ORDER BY id DESC`)
    .all() as ModelConfigRow[]
  return rows.map(toModelConfig)
}

/**
 * 按主键读取模型配置。
 * AI 主进程直接调用它取连接信息，API Key 因此不经过渲染进程。
 * @throws DbError 记录不存在
 */
export function findModelConfigById(id: number): ModelConfig {
  assertId(id)
  const row = requireDatabase()
    .prepare(`SELECT ${MODEL_CONFIG_COLUMNS} FROM model_configs WHERE id = ?`)
    .get(id) as ModelConfigRow | undefined
  if (!row) {
    throw new DbError('模型配置不存在', 'MODEL_CONFIG_NOT_FOUND')
  }
  return toModelConfig(row)
}

/** 新建模型配置，返回落库后的完整记录 */
export function createModelConfig(input: ModelConfigInput): ModelConfig {
  const data = normalizeInput(input)
  const result = requireDatabase()
    .prepare(
      `INSERT INTO model_configs (provider_name, base_url, display_name, model_name, api_key)
       VALUES (@providerName, @baseUrl, @displayName, @modelName, @apiKey)`
    )
    .run(data)
  return findModelConfigById(Number(result.lastInsertRowid))
}

/** 更新模型配置，返回更新后的完整记录 */
export function updateModelConfig(id: number, input: ModelConfigInput): ModelConfig {
  assertId(id)
  const data = normalizeInput(input)
  const result = requireDatabase()
    .prepare(
      `UPDATE model_configs
       SET provider_name = @providerName,
           base_url = @baseUrl,
           display_name = @displayName,
           model_name = @modelName,
           api_key = @apiKey,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = @id`
    )
    .run({ ...data, id })
  if (result.changes === 0) {
    throw new DbError('模型配置不存在', 'MODEL_CONFIG_NOT_FOUND')
  }
  return findModelConfigById(id)
}

/** 删除模型配置；确认交互属于 IPC 层，这里只做数据操作 */
export function deleteModelConfig(id: number): void {
  assertId(id)
  const result = requireDatabase().prepare('DELETE FROM model_configs WHERE id = ?').run(id)
  if (result.changes === 0) {
    throw new DbError('模型配置不存在', 'MODEL_CONFIG_NOT_FOUND')
  }
}
