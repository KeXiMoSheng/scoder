/**
 * 传输工厂：按配置创建 stdio（本地子进程）或 Streamable HTTP（远程端点）传输。
 * spawn 与环境清洗交给 MCP 官方 SDK 与 env.ts，这里只做选择。
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig } from '../../shared/mcp/types'
import { childEnvironment } from './env'

/**
 * 按配置建立一条尚未启动的传输。
 * @param server 已校验的服务端配置
 * @returns stdio 或 Streamable HTTP 传输；调用方负责 connect/close
 */
export function createMcpTransport(server: McpServerConfig): Transport {
  if (server.transport === 'stdio') {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: childEnvironment(server.env),
      // 空串交给 SDK 的默认值（继承主进程 cwd），不要传一个不存在的目录
      ...(server.cwd.length > 0 ? { cwd: server.cwd } : {})
    })
  }
  return new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers }
  })
}
