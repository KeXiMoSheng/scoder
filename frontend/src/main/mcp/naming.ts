/**
 * MCP 工具的公开命名。
 *
 * 命名契约与 deepseek-harness 的 mcp-client 一致：每个 MCP 工具的身份是
 * (serverName, rawName)，模型看到的公开名是 mcp__<serverName>__<rawName>，
 * 并按 DeepSeek 的函数名约束（最多 64 字符、只允许 [A-Za-z0-9_-]）归一化。
 * 归一化确实改动过名字时追加身份哈希，保证不同工具不会塌缩成同一个公开名；
 * 原始名只在 tools/call 时回传给服务端，绝不从公开名反解。
 */

import { createHash } from 'crypto'
import { MCP_MAX_TOOL_NAME_LENGTH } from '../../shared/mcp/types'

/** 非法字符：DeepSeek 函数名只允许字母、数字、下划线与短横线 */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** 被截断或替换时追加的身份哈希长度（十六进制字符数） */
const HASH_LENGTH = 12

/**
 * 推导一个 MCP 工具对模型公开的名字。
 * 纯函数：同样的 (serverName, rawName) 永远得到同样的名字，重启后历史会话仍能对上。
 * @param serverName 配置里的服务名（命名空间）
 * @param rawName 服务端自己的工具名
 * @returns 符合函数名约束且全局唯一的公开名
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MCP_MAX_TOOL_NAME_LENGTH) {
    return normalized
  }
  const hash = createHash('sha256')
    .update(`${serverName}\0${rawName}`)
    .digest('hex')
    .slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MCP_MAX_TOOL_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}
