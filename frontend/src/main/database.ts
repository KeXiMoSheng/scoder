import { app, BrowserWindow, dialog, ipcMain, type MessageBoxOptions } from 'electron'
import Database from 'better-sqlite3'
import { join } from 'path'
import type { ModelConfig, ModelConfigInput } from '../shared/types'

/** 本地数据库文件名：设置与后续聊天记录共用同一个库 */
const DATABASE_FILE_NAME = 'scoder.db'

/** 当前库结构版本：新增表/字段时递增，并在 migrate 中追加对应的升级步骤 */
const SCHEMA_VERSION = 1

/** 建表 SQL：模型配置 */
const CREATE_MODEL_CONFIGS_SQL = `
  CREATE TABLE IF NOT EXISTS model_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    display_name TEXT NOT NULL,
    model_name TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`

const MODEL_CONFIG_COLUMNS =
  'id, provider_name, base_url, display_name, model_name, api_key, created_at, updated_at'

/** model_configs 表的原始行（snake_case） */
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

let database: Database.Database | null = null

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

function requireDatabase(): Database.Database {
  if (!database) {
    throw new Error('本地数据库尚未就绪')
  }
  return database
}

/** 按 user_version 逐步升级库结构，便于后续追加聊天记录等表 */
function migrate(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version < 1) {
    db.exec(CREATE_MODEL_CONFIGS_SQL)
  }
  if (version < SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }
}

/** 在应用 userData 目录打开本地库（应用启动时调用一次） */
export function initDatabase(): void {
  if (database) {
    return
  }
  database = new Database(join(app.getPath('userData'), DATABASE_FILE_NAME))
  // WAL 提升读写并发；后续聊天记录会持续写入，避免与设置读取相互阻塞
  database.pragma('journal_mode = WAL')
  migrate(database)
}

/** 应用退出前关闭数据库，确保 WAL 落盘 */
export function closeDatabase(): void {
  database?.close()
  database = null
}

/** 校验并清洗表单输入：除 API Key 外均不允许为空 */
function normalizeModelConfigInput(input: ModelConfigInput): ModelConfigInput {
  if (!input || typeof input !== 'object') {
    throw new Error('参数无效')
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
    throw new Error('供应商名不能为空')
  }
  if (!normalized.baseUrl) {
    throw new Error('模型地址不能为空')
  }
  if (!normalized.displayName) {
    throw new Error('模型显示名称不能为空')
  }
  if (!normalized.modelName) {
    throw new Error('模型名称不能为空')
  }
  return normalized
}

function queryModelConfigById(id: number): ModelConfig {
  const row = requireDatabase()
    .prepare(`SELECT ${MODEL_CONFIG_COLUMNS} FROM model_configs WHERE id = ?`)
    .get(id) as ModelConfigRow | undefined
  if (!row) {
    throw new Error('模型配置不存在')
  }
  return toModelConfig(row)
}

export function listModelConfigs(): ModelConfig[] {
  const rows = requireDatabase()
    .prepare(`SELECT ${MODEL_CONFIG_COLUMNS} FROM model_configs ORDER BY id DESC`)
    .all() as ModelConfigRow[]
  return rows.map(toModelConfig)
}

export function createModelConfig(input: ModelConfigInput): ModelConfig {
  const data = normalizeModelConfigInput(input)
  const result = requireDatabase()
    .prepare(
      `INSERT INTO model_configs (provider_name, base_url, display_name, model_name, api_key)
       VALUES (@providerName, @baseUrl, @displayName, @modelName, @apiKey)`
    )
    .run(data)
  return queryModelConfigById(Number(result.lastInsertRowid))
}

export function updateModelConfig(id: number, input: ModelConfigInput): ModelConfig {
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error('参数无效')
  }
  const data = normalizeModelConfigInput(input)
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
    throw new Error('模型配置不存在')
  }
  return queryModelConfigById(id)
}

/** 删除模型配置：先经系统对话框确认，用户取消时返回 false */
export async function deleteModelConfig(
  window: BrowserWindow | null,
  id: number
): Promise<boolean> {
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new Error('参数无效')
  }
  const config = queryModelConfigById(id)
  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: ['取消', '删除'],
    defaultId: 0,
    cancelId: 0,
    title: '删除确认',
    message: `确定要删除模型「${config.displayName}」吗？`,
    detail: '删除后无法恢复，与之相关的本地数据不会一并删除。'
  }
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  if (result.response !== 1) {
    return false
  }
  requireDatabase().prepare('DELETE FROM model_configs WHERE id = ?').run(id)
  return true
}

/** 向渲染进程提供模型配置的读取与增删改（白名单 IPC） */
export function registerDatabaseHandlers(): void {
  ipcMain.handle('modelConfig:list', (): ModelConfig[] => listModelConfigs())

  ipcMain.handle('modelConfig:create', (_event, input: ModelConfigInput): ModelConfig =>
    createModelConfig(input)
  )

  ipcMain.handle('modelConfig:update', (_event, id: number, input: ModelConfigInput): ModelConfig =>
    updateModelConfig(id, input)
  )

  ipcMain.handle('modelConfig:delete', async (event, id: number): Promise<boolean> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return deleteModelConfig(window, id)
  })
}
