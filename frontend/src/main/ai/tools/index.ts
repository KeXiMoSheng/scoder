import { createListTool } from './list'
import { createReadTool } from './read'
import { ToolRegistry } from './registry'
import { createGlobTool, createGrepTool } from './search'

/**
 * 装配 P0 的只读工具集。
 * P1 在此追加 write / edit，并把“审批 + 观测 + 沙箱”插进 Registry.execute。
 * @returns 已注册 read / list / glob / grep 的注册表
 */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(createReadTool())
  registry.register(createListTool())
  registry.register(createGlobTool())
  registry.register(createGrepTool())
  return registry
}
