/**
 * 本地数据库入口。
 * 外部（main/index.ts、AI 运行时）只从这里导入，不直接接触连接与 SQL：
 * - connection：打开、关闭、取连接
 * - schema：版本与迁移
 * - model-configs：模型配置仓储
 * - ipc：渲染进程通道
 */
export { closeDatabase, initDatabase } from './connection'
export { DbError } from './errors'
export type { DbErrorCode } from './errors'
export { registerDatabaseHandlers } from './ipc'
export { findModelConfigById } from './model-configs'
