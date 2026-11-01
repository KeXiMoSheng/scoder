/**
 * 会话日志错误。
 * 与 db/errors.ts 同样的思路：用稳定错误码区分“id 不合法”“文件损坏”
 * “文件版本高于当前程序”“写入失败”，让调用方分支处理而不是匹配文案。
 */
export type SessionLogErrorCode =
  /** 会话 id 不能直接作为文件名（路径穿越、超长、非法字符） */
  | 'SESSION_ID_INVALID'
  /** 文件存在但内容不是本格式：首行不是会话头、seq 不连续、中间行无法解析 */
  | 'SESSION_LOG_CORRUPT'
  /** 磁盘上的日志版本高于当前程序，继续读取可能丢掉新字段 */
  | 'SESSION_LOG_VERSION_UNSUPPORTED'
  /** 追加写入磁盘失败 */
  | 'SESSION_LOG_WRITE_FAILED'

/** 带稳定错误码的会话日志异常 */
export class SessionLogError extends Error {
  readonly code: SessionLogErrorCode

  /**
   * @param message 面向用户的说明
   * @param code 稳定错误码
   * @param options 原始异常链
   */
  constructor(message: string, code: SessionLogErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SessionLogError'
    this.code = code
  }
}
