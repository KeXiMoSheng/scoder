/**
 * 工具桥：把一个 MCP 工具适配成 scoder 的工具定义。
 *
 * 与 deepseek-harness 的 mcp-client 的 tools.ts 对齐：公开名带命名空间、
 * 参数 schema 原样透传、结果把 MCP 内容块投影成模型可读文本。
 * 与 harness 的差异只在投影目标：scoder 的工具结果是纯文本（ToolOutcome.text），
 * 没有附件与多模态内容通道，所以图片/音频/内嵌资源都降级为一句可读说明。
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import type { JsonSchemaLoose } from '../../shared/ai/types'
import type { ToolDefinition } from '../ai/tools/registry'
import { publicToolName } from './naming'

/** 结构化结果单独回灌给模型时的文本上限（字符）：避免一个 JSON 占满上下文 */
const MAX_STRUCTURED_CHARS = 8_000

/** MCP 内容块里可能出现的字段（外部数据，读取前都要判型） */
interface McpContentBlock {
  type?: unknown
  text?: unknown
  mimeType?: unknown
  name?: unknown
  uri?: unknown
}

/**
 * 把 MCP 工具落成 scoder 的工具定义。
 * @param serverName 配置里的服务名（命名空间）
 * @param tool 服务端公布的工具描述
 * @param invoke 实际发起 tools/call 的回调；由连接层提供，携带当前连接与中止信号
 * @param timeoutMs 单次调用预算（毫秒），由工具注册表据此打断
 * @returns 可注册的 ToolDefinition
 */
export function createMcpToolDefinition(
  serverName: string,
  tool: McpTool,
  invoke: (args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>,
  timeoutMs: number
): ToolDefinition {
  const name = publicToolName(serverName, tool.name)
  const description =
    tool.description !== undefined && tool.description.trim().length > 0
      ? tool.description
      : `来自 MCP 服务端「${serverName}」的工具 ${tool.name}。`
  return {
    name,
    description,
    parameters: tool.inputSchema as JsonSchemaLoose,
    timeoutMs,
    async execute(args, ctx) {
      const result = await invoke(args, ctx.signal)
      const text = projectResult(result, tool.name)
      // isError 的调用按失败回灌：模型据此改参数，界面也标红
      if (result.isError === true) {
        throw new Error(text)
      }
      return { text }
    },
    presentCall() {
      return { kind: 'generic', title: `${serverName} · ${tool.name}` }
    }
  }
}

/**
 * 把一次 tools/call 的结果投影成模型可读文本。
 * 文本块按出现顺序以换行拼接；图片、音频、内嵌资源降级为说明；
 * 只有结构化结果、没有文本块时，附上截断后的 JSON。
 * @param result 服务端返回的调用结果
 * @param rawName 服务端工具名，用于空结果的提示文案
 * @returns 单段文本
 */
export function projectResult(result: CallToolResult, rawName: string): string {
  const parts: string[] = []
  for (const value of result.content) {
    if (typeof value !== 'object' || value === null) {
      parts.push('[无法识别的内容块]')
      continue
    }
    const block = value as McpContentBlock
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image':
        parts.push(`[图片结果：${mediaTypeOf(block)}，未直接展示]`)
        break
      case 'audio':
        parts.push(`[音频结果：${mediaTypeOf(block)}，未直接展示]`)
        break
      case 'resource_link':
        parts.push(`资源链接：${nameOf(block)}（${uriOf(block)}）`)
        break
      case 'resource':
        parts.push(`[内嵌资源：${uriOf(block)}，未直接展示]`)
        break
      default:
        parts.push(`[不支持的内容类型：${String(block.type)}]`)
    }
  }
  const text = parts.join('\n')
  if (text.length > 0) {
    return text
  }
  const structured = result.structuredContent
  if (structured !== undefined) {
    const json = JSON.stringify(structured, null, 2)
    const body =
      json.length > MAX_STRUCTURED_CHARS
        ? `${json.slice(0, MAX_STRUCTURED_CHARS)}\n…（已截断）`
        : json
    return `结构化结果：\n${body}`
  }
  return `（${rawName} 没有返回可展示内容）`
}

/** 内容块的 MIME 类型，缺失时给出占位 */
function mediaTypeOf(block: McpContentBlock): string {
  return typeof block.mimeType === 'string' && block.mimeType.length > 0
    ? block.mimeType
    : '未知类型'
}

/** 资源链接的名称，缺失时回退到 URI */
function nameOf(block: McpContentBlock): string {
  return typeof block.name === 'string' && block.name.length > 0 ? block.name : uriOf(block)
}

/** 资源 URI，缺失时给出占位 */
function uriOf(block: McpContentBlock): string {
  return typeof block.uri === 'string' && block.uri.length > 0 ? block.uri : '未提供地址'
}
