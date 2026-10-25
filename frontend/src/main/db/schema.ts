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
export const SCHEMA_VERSION = 1

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
 * 有序迁移列表，版本必须从 1 开始连续递增。
 * 以后加 AI 会话表（ai_sessions / ai_messages）时，在这里追加 version: 2，
 * 并把 SCHEMA_VERSION 改成 2，旧库启动时就会自动补表。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: '模型配置表',
    up: (db) => db.exec(CREATE_MODEL_CONFIGS_SQL)
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
