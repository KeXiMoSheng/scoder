/**
 * MCP 客户端冒烟测试：拉起 scripts/mcp-fixture-server.mjs，验证连接、工具桥、
 * 服务端说明、断线重连与放弃注销。
 *
 * 为什么是脚本而不是单元测试：scoder 目前没有前端测试运行器，这里用最小的
 * rolldown + node 组合把主进程的 MCP 模块打成一个 CJS 文件后直接跑（见 package.json 的 test:mcp）。
 * 没有 Electron 依赖：connection.ts / probe.ts 只用到 Node 与 MCP SDK。
 */

import { join } from 'path'
import type { McpServerConfig, McpServerStatus } from '../src/shared/mcp/types'
import type { ToolContext, ToolDefinition } from '../src/main/ai/tools/registry'
import { McpConnection } from '../src/main/mcp/connection'
import { probeMcpServer } from '../src/main/mcp/probe'
import { publicToolName } from '../src/main/mcp/naming'

/** 断言失败即退出，避免后续断言给出误导性的连锁错误 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exit(1)
  }
  console.log(`✓ ${message}`)
}

/** 等待某个状态出现 */
function waitForStatus(
  statuses: McpServerStatus[],
  predicate: (status: McpServerStatus) => boolean,
  label: string,
  timeoutMs = 10_000
): Promise<McpServerStatus> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const found = statuses.find(predicate)
      if (found !== undefined) {
        clearInterval(timer)
        resolve(found)
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`等待状态超时：${label}`))
      }
    }, 20)
  })
}

/** 已连接过的次数：用来判断重连之后确实建立过新一代连接 */
function statusesAfter(statuses: readonly McpServerStatus[]): McpServerStatus[] {
  const firstDisconnect = statuses.findIndex((status) => status.state === 'reconnecting')
  if (firstDisconnect < 0) return []
  return statuses.slice(firstDisconnect).filter((status) => status.state === 'connected')
}

/**
 * fixture 服务端路径：npm 脚本从 frontend 目录运行，因此以 cwd 为基准；
 * 需要时可用 MCP_FIXTURE 覆盖（例如从仓库根运行）。
 */
function fixturePath(): string {
  return process.env.MCP_FIXTURE ?? join(process.cwd(), 'scripts', 'mcp-fixture-server.mjs')
}

/** 构造一条指向 fixture 服务端的 stdio 配置 */
function fixtureConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  const fixture = fixturePath()
  const now = new Date().toISOString()
  return {
    id: 1,
    name: 'demo',
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    env: {},
    cwd: '',
    url: '',
    headers: {},
    toolCallTimeoutMs: 5_000,
    startupTimeoutMs: 10_000,
    reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 200, maxAttempts: 2 },
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

/** 简易工具出口：记录注册，注销时移除 */
function createSink(): {
  tools: Map<string, ToolDefinition>
  register: (definition: ToolDefinition) => () => void
} {
  const tools = new Map<string, ToolDefinition>()
  return {
    tools,
    register(definition) {
      tools.set(definition.name, definition)
      return () => {
        tools.delete(definition.name)
      }
    }
  }
}

/**
 * 一个够用的工具执行上下文：MCP 工具只读取 signal，不需要文件系统与观测存储。
 * 这里刻意只提供被用到的字段，避免为了跑测试去搭建整套文件服务。
 */
function toolContext(): ToolContext {
  return {
    sessionId: 'smoke',
    cwd: process.cwd(),
    signal: new AbortController().signal
  } as unknown as ToolContext
}

async function main(): Promise<void> {
  // 1) 连接 + 工具同步 + 服务端说明
  const sink = createSink()
  const statuses: McpServerStatus[] = []
  let instructions = ''
  const connection = new McpConnection({
    server: fixtureConfig(),
    sink,
    onStatus: (status) => statuses.push(status),
    onInstructions: (text) => {
      instructions = text
    },
    log: (message, error) => {
      if (error !== undefined) console.error(message, error)
    }
  })
  connection.start()
  const connected = await waitForStatus(
    statuses,
    (status) => status.state === 'connected',
    '已连接'
  )
  assert(connected.state === 'connected' && connected.toolCount === 2, '连接成功并同步到 2 个工具')
  assert(sink.tools.has(publicToolName('demo', 'echo')), '工具按 mcp__demo__<工具名> 注册')
  assert(instructions.includes('演示用 MCP 服务端'), '服务端 instructions 被捕获')

  // 2) 工具调用投影
  const echo = sink.tools.get(publicToolName('demo', 'echo'))
  assert(echo !== undefined, 'echo 工具可取到')
  const echoOutcome = await echo?.execute({ text: 'hello' }, toolContext())
  assert(echoOutcome?.text === 'echo:hello', '工具结果按文本投影回灌')
  const add = sink.tools.get(publicToolName('demo', 'add'))
  const addOutcome = await add?.execute({ left: 2, right: 40 }, toolContext())
  assert(addOutcome?.text === 'sum:42', '第二个工具同样可用')

  // 3) 探测：临时连接不影响已挂载实例
  const probe = await probeMcpServer(fixtureConfig(), { timeoutMs: 10_000 })
  assert(probe.ok && probe.toolNames.length === 2, '探测返回 2 个原始工具名')
  assert(probe.ok && probe.serverInfo?.name === 'scoder-mcp-fixture', '探测拿到服务端身份')

  await connection.dispose()
  assert(sink.tools.size === 0, '关闭连接后工具全部注销')

  // 4) 掉线重连：第一次工具调用后服务端退出，重连应重新同步工具
  const flakySink = createSink()
  const flakyStatuses: McpServerStatus[] = []
  const flaky = new McpConnection({
    server: fixtureConfig({
      id: 2,
      name: 'flaky',
      env: { FIXTURE_EXIT_ON_TOOL: '1' },
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 60_000, maxAttempts: 3 }
    }),
    sink: flakySink,
    onStatus: (status) => flakyStatuses.push(status),
    onInstructions: () => undefined,
    log: () => undefined
  })
  flaky.start()
  await waitForStatus(flakyStatuses, (status) => status.state === 'connected', '掉线用例已连接')
  const flakyEcho = flakySink.tools.get(publicToolName('flaky', 'echo'))
  assert(flakyEcho !== undefined, '掉线用例注册了 echo')
  await flakyEcho?.execute({ text: 'bye' }, toolContext())
  await waitForStatus(flakyStatuses, (status) => status.state === 'reconnecting', '进入重连')
  await waitForStatus(
    flakyStatuses,
    (status) => status.state === 'connected' && statusesAfter(flakyStatuses).length > 0,
    '重连后重新同步'
  )
  assert(flakySink.tools.has(publicToolName('flaky', 'echo')), '重连后工具重新注册')
  await flaky.dispose()
  assert(flakySink.tools.size === 0, '掉线用例收尾后工具注销')

  // 5) 放弃重连：命令必然失败，重试预算耗尽后进入 failed(gave-up)
  const brokenSink = createSink()
  const brokenStatuses: McpServerStatus[] = []
  const broken = new McpConnection({
    server: fixtureConfig({
      id: 3,
      name: 'broken',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 100, maxAttempts: 2 }
    }),
    sink: brokenSink,
    onStatus: (status) => brokenStatuses.push(status),
    onInstructions: () => undefined,
    log: () => undefined
  })
  broken.start()
  const gaveUp = await waitForStatus(
    brokenStatuses,
    (status) => status.state === 'failed',
    '放弃重连'
  )
  assert(
    gaveUp.state === 'failed' && gaveUp.reason === 'gave-up',
    '重试预算耗尽后进入 failed(gave-up)'
  )
  assert(brokenSink.tools.size === 0, '从未连接成功的服务端不留下工具')
  await broken.dispose()

  console.log('\nMCP 冒烟测试通过')
}

/** 未捕获的异常直接失败，避免 CI 里静默通过 */
main().catch((error: unknown) => {
  console.error('✗ 冒烟测试失败')
  console.error(error)
  process.exit(1)
})
