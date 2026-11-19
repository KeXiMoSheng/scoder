import { createToolRegistry } from './tools'

/**
 * 进程内唯一的工具注册表。
 * 内置工具在装配阶段注册一次；MCP 工具随连接增删（见 main/mcp/connection.ts）。
 * 单独成模块是为了让 MCP 运行时和 AI 循环共用同一份实例，又不互相引入启动逻辑。
 */
export const toolRegistry = createToolRegistry()
