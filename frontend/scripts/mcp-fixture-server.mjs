#!/usr/bin/env node
/**
 * 冒烟测试用的最小 MCP 服务端（stdio）。
 *
 * 只提供两个工具与一段服务端说明，覆盖冒烟脚本需要断言的三件事：
 * 工具发现、工具调用、服务端 instructions 进入系统提示。
 * 环境变量 FIXTURE_EXIT_ON_TOOL=1 让服务端在第一次工具调用后自行退出，
 * 用来验证“连接稳定过之后掉线 → 自动重连 → 工具重新同步”这条路径。
 * 父进程提前关闭管道时会触发 EPIPE，这里吞掉它：那是测试收尾的正常现象。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'scoder-mcp-fixture', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: '演示用 MCP 服务端：echo 回显文本，add 求和两个整数。'
  }
)

const tools = [
  {
    name: 'echo',
    description: '回显输入文本',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text']
    }
  },
  {
    name: 'add',
    description: '两个整数相加',
    inputSchema: {
      type: 'object',
      properties: {
        left: { type: 'integer' },
        right: { type: 'integer' }
      },
      required: ['left', 'right']
    }
  }
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {}
  const response =
    request.params.name === 'echo'
      ? { content: [{ type: 'text', text: `echo:${String(args.text)}` }] }
      : request.params.name === 'add'
        ? { content: [{ type: 'text', text: `sum:${Number(args.left) + Number(args.right)}` }] }
        : {
            isError: true,
            content: [{ type: 'text', text: `unknown tool ${request.params.name}` }]
          }
  if (process.env.FIXTURE_EXIT_ON_TOOL === '1') {
    // 先让响应写回管道，再退出：客户端应看到一次成功调用之后连接断开
    setTimeout(() => process.exit(0), 50)
  }
  return response
})

// 父进程先关闭管道时写入会抛 EPIPE；测试收尾阶段这是预期现象，不应污染输出
process.on('uncaughtException', (error) => {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EPIPE') {
    process.exit(0)
  }
  throw error
})

await server.connect(new StdioServerTransport())
