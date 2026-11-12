import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_REASONING_EFFORT,
  MODEL_CONTEXT_WINDOW_OPTIONS,
  MODEL_REASONING_EFFORT_OPTIONS,
  type ModelConfig,
  type ModelConfigInput,
  type ModelContextWindow,
  type ModelImportResult,
  type ModelReasoningEffort
} from '../../shared/model-config/types'
import { requireDatabase } from './connection'
import { DbError } from './errors'

/** 查询列固定列出，避免 SELECT * 在加字段后把多余列带进映射 */
const MODEL_CONFIG_COLUMNS =
  'id, provider_name, base_url, display_name, model_name, api_key, context_window, reasoning_effort, created_at, updated_at'

/** 新增行的语句：单条新建与批量导入共用同一份列顺序 */
const INSERT_MODEL_CONFIG_SQL = `
  INSERT INTO model_configs (provider_name, base_url, display_name, model_name, api_key, context_window, reasoning_effort)
  VALUES (@providerName, @baseUrl, @displayName, @modelName, @apiKey, @contextWindow, @reasoningEffort)
`

/**
 * 覆盖已有行的语句：单条更新与批量导入共用同一份列顺序。
 * 窗口与思考深度用 COALESCE：调用方没传（如一键导入）时保留用户已经调过的值。
 */
const UPDATE_MODEL_CONFIG_SQL = `
  UPDATE model_configs
  SET provider_name = @providerName,
      base_url = @baseUrl,
      display_name = @displayName,
      model_name = @modelName,
      api_key = @apiKey,
      context_window = COALESCE(@contextWindow, context_window),
      reasoning_effort = COALESCE(@reasoningEffort, reasoning_effort),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = @id
`

/** 单次一键导入允许的最大条数：防止一次塞入过多记录 */
const MAX_IMPORT_BATCH = 500

/** model_configs 表的原始行（snake_case，仅在本文件出现） */
interface ModelConfigRow {
  id: number
  provider_name: string
  base_url: string
  display_name: string
  model_name: string
  api_key: string
  context_window: number
  reasoning_effort: string
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
    contextWindow: readContextWindow(row.context_window),
    reasoningEffort: readReasoningEffort(row.reasoning_effort),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** 读库时的兜底：手工改库出现未知值时不让整张列表失败 */
function readContextWindow(value: number): ModelContextWindow {
  return (MODEL_CONTEXT_WINDOW_OPTIONS as readonly number[]).includes(value)
    ? (value as ModelContextWindow)
    : DEFAULT_MODEL_CONTEXT_WINDOW
}

/** 读库时的兜底：未知思考深度退回默认值 */
function readReasoningEffort(value: string): ModelReasoningEffort {
  return (MODEL_REASONING_EFFORT_OPTIONS as readonly string[]).includes(value)
    ? (value as ModelReasoningEffort)
    : DEFAULT_MODEL_REASONING_EFFORT
}

/** 写入时的校验：只接受固定档位，缺省（undefined/null）表示沿用原值 */
function normalizeContextWindow(value: unknown): ModelContextWindow | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (
    typeof value !== 'number' ||
    !(MODEL_CONTEXT_WINDOW_OPTIONS as readonly number[]).includes(value)
  ) {
    throw new DbError('上下文窗口大小无效', 'INVALID_ARGUMENT')
  }
  return value as ModelContextWindow
}

/** 写入时的思考深度校验，规则与上下文窗口一致 */
function normalizeReasoningEffort(value: unknown): ModelReasoningEffort | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (
    typeof value !== 'string' ||
    !(MODEL_REASONING_EFFORT_OPTIONS as readonly string[]).includes(value)
  ) {
    throw new DbError('思考深度无效', 'INVALID_ARGUMENT')
  }
  return value as ModelReasoningEffort
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
  const contextWindow = normalizeContextWindow(input.contextWindow)
  const reasoningEffort = normalizeReasoningEffort(input.reasoningEffort)
  const normalized: ModelConfigInput = {
    providerName: text(input.providerName),
    baseUrl: text(input.baseUrl),
    displayName: text(input.displayName),
    modelName: text(input.modelName),
    apiKey: text(input.apiKey),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
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

/** 新建/导入插入时的参数：未指定窗口与思考深度时落默认档位 */
function insertValues(input: ModelConfigInput): Record<string, unknown> {
  return {
    ...input,
    contextWindow: input.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    reasoningEffort: input.reasoningEffort ?? DEFAULT_MODEL_REASONING_EFFORT
  }
}

/** 更新参数：未指定的字段显式传 null，SQL 里的 COALESCE 会保留原值 */
function updateValues(input: ModelConfigInput, id: number): Record<string, unknown> {
  return {
    ...input,
    id,
    contextWindow: input.contextWindow ?? null,
    reasoningEffort: input.reasoningEffort ?? null
  }
}

/** 新建模型配置，返回落库后的完整记录 */
export function createModelConfig(input: ModelConfigInput): ModelConfig {
  const data = normalizeInput(input)
  const result = requireDatabase().prepare(INSERT_MODEL_CONFIG_SQL).run(insertValues(data))
  return findModelConfigById(Number(result.lastInsertRowid))
}

/**
 * 批量写入一键导入的模型配置：同一事务内完成。
 * 按「供应商名 + 模型地址 + 模型名称」判断：已存在则覆盖该条配置，否则新增。
 * 重复导入同一批模型不会堆出一模一样的卡片。
 * @param inputs 待导入的配置（已由远程模型列表归一化）
 * @returns 本次新建与覆盖的记录
 * @throws DbError 参数非法或条数超出上限
 */
export function createModelConfigs(inputs: ModelConfigInput[]): ModelImportResult {
  if (!Array.isArray(inputs)) {
    throw new DbError('参数无效', 'INVALID_ARGUMENT')
  }
  if (inputs.length === 0) {
    return { created: [], updated: [] }
  }
  if (inputs.length > MAX_IMPORT_BATCH) {
    throw new DbError(`一次最多导入 ${MAX_IMPORT_BATCH} 个模型`, 'INVALID_ARGUMENT')
  }
  const db = requireDatabase()
  // 手工填写过的地址可能带末尾斜杠，比较时一并去掉
  const findByKey = db.prepare(
    "SELECT id FROM model_configs WHERE provider_name = ? AND RTRIM(base_url, '/') = ? AND model_name = ? LIMIT 1"
  )
  const insert = db.prepare(INSERT_MODEL_CONFIG_SQL)
  const update = db.prepare(UPDATE_MODEL_CONFIG_SQL)
  // 事务内逐条校验：任一条非法就整体回滚，不会留下半批记录
  return db.transaction((items: ModelConfigInput[]): ModelImportResult => {
    const created: ModelConfig[] = []
    const updated: ModelConfig[] = []
    for (const item of items) {
      const data = normalizeInput(item)
      const existing = findByKey.get(
        data.providerName,
        data.baseUrl.replace(/\/+$/, ''),
        data.modelName
      ) as { id: number } | undefined
      if (existing) {
        update.run(updateValues(data, existing.id))
        updated.push(findModelConfigById(existing.id))
        continue
      }
      const result = insert.run(insertValues(data))
      created.push(findModelConfigById(Number(result.lastInsertRowid)))
    }
    return { created, updated }
  })(inputs)
}

/** 更新模型配置，返回更新后的完整记录 */
export function updateModelConfig(id: number, input: ModelConfigInput): ModelConfig {
  assertId(id)
  const data = normalizeInput(input)
  const result = requireDatabase().prepare(UPDATE_MODEL_CONFIG_SQL).run(updateValues(data, id))
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

/** 删除全部模型配置；确认交互同样属于 IPC 层，返回实际删除的条数 */
export function deleteAllModelConfigs(): number {
  return requireDatabase().prepare('DELETE FROM model_configs').run().changes
}
