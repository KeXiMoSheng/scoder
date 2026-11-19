/**
 * MCP 运行时的装配入口。
 * 主进程启动时在数据库初始化之后调用 initMcp()：
 * 注册设置面板使用的通道，并按已保存的配置挂载连接。
 */

import { registerMcpHandlers } from './ipc'
import { mcpManager } from './manager'

/**
 * 初始化 MCP：注册 IPC 通道并启动管理器。
 * 管理器内部会吞掉初始化失败（记日志），不让一条坏配置挡住应用启动。
 */
export function initMcp(): void {
  registerMcpHandlers()
  mcpManager.start()
}

/**
 * 关闭全部 MCP 连接并注销工具。
 * 应用退出前等待它完成：stdio 服务端是子进程，提前退出会留下孤儿进程。
 */
export async function disposeMcp(): Promise<void> {
  await mcpManager.dispose()
}
