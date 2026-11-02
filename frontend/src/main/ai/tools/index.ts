import { createEditTool } from './edit'
import { createListTool } from './list'
import { createReadTool } from './read'
import { ToolRegistry } from './registry'
import { createGlobTool, createGrepTool } from './search'
import { createWriteTool } from './write'

/**
 * 装配工具集：只读的 read / list / glob / grep，加上写入的 write / edit。
 * 写工具的安全性来自"先读后改"（ctx.observation），而不是审批弹窗；
 * 工作区边界由 fs.resolve 统一保证。
 * @returns 已注册全部工具的注册表
 */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(createReadTool())
  registry.register(createListTool())
  registry.register(createGlobTool())
  registry.register(createGrepTool())
  registry.register(createWriteTool())
  registry.register(createEditTool())
  return registry
}
