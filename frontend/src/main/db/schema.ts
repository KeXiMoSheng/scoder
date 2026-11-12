import type Database from 'better-sqlite3'
import { DbError } from './errors'

/**
 * 本应用的数据库标识（ASCII "SCOD"）。
 * 打开文件时校验：避免用户把别的 SQLite 文件放到该路径后被我们建表写坏。
 * 参考 deepseek-harness 的 session-query-sqlite：先验 application_id，再动结构。
 */
export const APPLICATION_ID = 0x53434f44

/**
 * 当前库结构版本。
 * 加表/加字段时：递增此常量，并在 MIGRATIONS 末尾追加一步；不要修改已发布的历史步骤。
 */
export const SCHEMA_VERSION = 5

/** 一次结构升级：只在库的 user_version 小于该步版本时执行一次 */
interface Migration {
  version: number
  /** 仅用于日志与排错 */
  description: string
  /** 在事务内执行；可以是多条 DDL */
  up: (db: Database.Database) => void
}

/** 模型配置表：列与 ModelConfig 一一对应，时间列由数据库生成 */
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

/**
 * 应用设置表：key-value，value 存 JSON 文本。
 * 目前只放 AI 运行参数；后续需要新的全局配置时直接加 key，不用再加表。
 */
const CREATE_APP_SETTINGS_SQL = `
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`

/**
 * 有序迁移列表，版本必须从 1 开始连续递增。
 * 旧库启动时会按版本号自动补齐缺的结构。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: '模型配置表',
    up: (db) => db.exec(CREATE_MODEL_CONFIGS_SQL)
  },
  {
    version: 2,
    description: '应用设置表',
    up: (db) => db.exec(CREATE_APP_SETTINGS_SQL)
  },
  {
    version: 3,
    description: '模型上下文窗口与思考深度',
    // 旧库里的已有行直接拿到默认值：窗口 1M（与原用量口径一致）、思考深度 high
    up: (db) =>
      db.exec(`
        ALTER TABLE model_configs ADD COLUMN context_window INTEGER NOT NULL DEFAULT 1000000;
        ALTER TABLE model_configs ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'high';
      `)
  },
  {
    version: 4,
    description: '模型思考模式开关',
    // 该开关的界面已移除；列保留不删，避免已升级的库把 user_version 降回去
    up: (db) =>
      db.exec('ALTER TABLE model_configs ADD COLUMN reasoning_enabled INTEGER NOT NULL DEFAULT 1;')
  },
  {
    version: 5,
    description: '上下文窗口缺省值改为 200k',
    // 早期迁移把未设置的存量行统一补成了 1M；按新的缺省口径归位，避免界面全部显示 1M
    up: (db) =>
      db.exec('UPDATE model_configs SET context_window = 200000 WHERE context_window = 1000000;')
  }
]

/**
 * 把数据库升级到 {@link SCHEMA_VERSION}。
 * 每个版本的 DDL 与版本号写入在同一个事务里：失败时一起回滚，
 * 库不会停在“表建好了但版本没写”的中间态（这是原实现缺的一步）。
 * @param db 已打开的连接
 * @throws DbError 库版本高于程序版本，或迁移列表不连续
 */
export function migrate(db: Database.Database): void {
  const current = readVersion(db)
  if (current > SCHEMA_VERSION) {
    throw new DbError(
      `数据库结构版本 ${current} 高于当前程序支持的 ${SCHEMA_VERSION}，请升级应用后再打开`,
      'DB_VERSION_TOO_NEW'
    )
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    applyMigration(db, migration)
  }
}

/** 读取 user_version（0 表示全新库或旧版库） */
function readVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number
}

/** 应用一步迁移：先检查版本连续性，再事务内执行 DDL 与版本写入 */
function applyMigration(db: Database.Database, migration: Migration): void {
  const applied = readVersion(db)
  if (migration.version !== applied + 1) {
    throw new DbError(
      `迁移版本不连续：期望 ${applied + 1}，实际 ${migration.version}（${migration.description}）`,
      'DB_MIGRATION_INVALID'
    )
  }
  // better-sqlite3 的 transaction 是同步的，DDL 与 pragma 都会在提交前一起回滚
  db.transaction(() => {
    migration.up(db)
    db.pragma(`user_version = ${migration.version}`)
  })()
}
