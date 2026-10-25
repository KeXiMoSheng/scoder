/**
 * 数据库错误。
 * 与 deepseek-harness 的 StorageError 一样，用稳定错误码区分“库没打开”“库版本太新”
 * “不是本应用的库”“记录不存在”，让调用方能分支处理而不是匹配文案。
 */
export type DbErrorCode =
  /** 连接尚未初始化（initDatabase 之前被调用） */
  | 'DB_NOT_READY'
  /** 磁盘上的库结构版本高于当前程序，继续读写可能损坏数据 */
  | 'DB_VERSION_TOO_NEW'
  /** 迁移列表本身不连续（开发期错误） */
  | 'DB_MIGRATION_INVALID'
  /** 目标文件属于其他应用，拒绝打开 */
  | 'DB_FOREIGN_FILE'
  /** 参数不合法（类型、范围） */
  | 'INVALID_ARGUMENT'
  /** 按主键查不到记录 */
  | 'MODEL_CONFIG_NOT_FOUND'

/** 带稳定错误码的数据库异常 */
export class DbError extends Error {
  readonly code: DbErrorCode

  /**
   * @param message 面向用户的说明
   * @param code 稳定错误码
   * @param options 原始异常链
   */
  constructor(message: string, code: DbErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DbError'
    this.code = code
  }
}
