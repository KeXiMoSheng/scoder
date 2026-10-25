import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { DbError } from './errors'
import { APPLICATION_ID, migrate } from './schema'

/** 本地数据库文件名：设置与后续 AI 会话记录共用同一个库 */
const DATABASE_FILE_NAME = 'scoder.db'

/** 进程内唯一连接；better-sqlite3 是同步驱动，单连接即可串行化所有写入 */
let database: Database.Database | null = null

/**
 * 在应用 userData 目录打开本地库（应用启动时调用一次）。
 * 打开顺序：设连接级 pragma → 校验文件归属 → 迁移 → 最后打上 application_id。
 * 迁移成功后才标记归属，失败时磁盘仍是“未认领”状态，下次启动可以重试。
 */
export function initDatabase(): void {
  if (database) {
    return
  }
  const path = join(app.getPath('userData'), DATABASE_FILE_NAME)
  const db = new Database(path)
  try {
    // WAL 提升读写并发；后续聊天记录会持续写入，避免与设置读取相互阻塞
    db.pragma('journal_mode = WAL')
    // 为将来的会话/消息外键约束提前打开；当前表没有外键，行为不变
    db.pragma('foreign_keys = ON')
    assertOwnership(db, path)
    migrate(db)
    db.pragma(`application_id = ${APPLICATION_ID}`)
  } catch (error) {
    // 半初始化的连接必须关掉，否则 database 变量会指向一个不可用实例
    db.close()
    throw error
  }
  database = db
}

/** 应用退出前关闭数据库，确保 WAL 落盘 */
export function closeDatabase(): void {
  database?.close()
  database = null
}

/**
 * 取当前连接；仓储层在每次操作前调用。
 * @throws DbError 初始化失败或尚未调用 initDatabase
 */
export function requireDatabase(): Database.Database {
  if (!database) {
    throw new DbError('本地数据库尚未就绪', 'DB_NOT_READY')
  }
  return database
}

/**
 * 校验文件归属：0 表示全新库或旧版（旧版没有 application_id），
 * 其他值必须等于本应用标识，避免把别人的 SQLite 文件当成自己的库来建表。
 */
function assertOwnership(db: Database.Database, path: string): void {
  const applicationId = db.pragma('application_id', { simple: true }) as number
  if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
    throw new DbError(`文件不是 scoder 的数据库：${path}`, 'DB_FOREIGN_FILE')
  }
}
