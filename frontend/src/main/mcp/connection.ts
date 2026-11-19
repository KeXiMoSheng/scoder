/**
 * 单条 MCP 服务端的连接监督者。
 *
 * 职责与 deepseek-harness 的 mcp-client connection.ts 对齐：
 * - 持有当前“连接代”：一个 Client 加一条 Transport，工具注册属于这一代；
 * - 连接成功后把工具列表同步进工具注册表，断线时按配置的退避策略重连；
 * - 重试预算按“一次断线”计：连续失败达到上限后放弃并注销本服务端的工具；
 * - 连接稳定超过 maxDelayMs 后预算清零，下次断线重新计数。
 *
 * 与 harness 的差异：scoder 没有 credential 模板与多模态附件通道，
 * 因此去掉了模板展开、图片入库与资源（resources/*）操作，只保留工具桥。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig, McpServerStatus, McpToolInfo } from '../../shared/mcp/types'
import type { ToolDefinition } from '../ai/tools/registry'
import { describeError, withDeadline } from './deadline'
import { publicToolName } from './naming'
import { createMcpToolDefinition } from './tool-bridge'
import { createMcpTransport } from './transport'

/** 关闭连接与本地清理的预算（毫秒）：不随配置变化，属于安全收尾常量的范畴 */
const CLOSE_TIMEOUT_MS = 5_000

/** 工具列表最多翻多少页：游标实现有 bug 的服务端不应让同步陷入死循环 */
const MAX_LIST_PAGES = 64

/** 工具注册的出口：主进程里是进程内共享的工具注册表 */
export interface McpToolSink {
  /**
   * 注册一个工具。
   * @param definition 工具定义
   * @returns 注销函数
   */
  register(definition: ToolDefinition): () => void
}

/** 连接监督者的依赖 */
export interface McpConnectionOptions {
  server: McpServerConfig
  sink: McpToolSink
  /** 状态变化出口：设置面板据此显示连接中/已连接/重试中/失败 */
  onStatus: (status: McpServerStatus) => void
  /** 服务端自述的使用说明；断开或停用时推送空串 */
  onInstructions: (instructions: string) => void
  /** 诊断出口：连接失败、工具同步失败等 */
  log: (message: string, error?: unknown) => void
}

/** 当前连接代 */
interface Generation {
  client: Client
  lifetime: AbortController
}

/** 一条 MCP 服务端的连接监督者 */
export class McpConnection {
  private readonly server: McpServerConfig
  private readonly sink: McpToolSink
  private readonly onStatus: (status: McpServerStatus) => void
  private readonly onInstructions: (instructions: string) => void
  private readonly log: (message: string, error?: unknown) => void

  /** 当前连接代；未连接时为 undefined */
  private generation: Generation | undefined
  /** 本服务端当前注册的工具：公开名 → 注销函数 */
  private disposers = new Map<string, () => void>()
  /** 当前注册工具的展示信息（顺序与注册一致） */
  private tools: McpToolInfo[] = []
  /** 重连计时器 */
  private reconnectTimer: NodeJS.Timeout | undefined
  /** 本次断线已失败的次数 */
  private failedAttempts = 0
  /** 当前连接代的建立时间（用于判断稳定性并重置预算） */
  private connectedAt: number | undefined
  /** 工具同步的串行链：listChanged 通知与重连不能并发换表 */
  private syncing: Promise<void> = Promise.resolve()
  /** 已开始收尾：此后不再发起连接，也不再推送状态 */
  private disposed = false

  constructor(options: McpConnectionOptions) {
    this.server = options.server
    this.sink = options.sink
    this.onStatus = options.onStatus
    this.onInstructions = options.onInstructions
    this.log = options.log
  }

  /** 发起首次连接；结果通过状态回调与工具注册表体现，不返回 Promise */
  start(): void {
    if (this.disposed) return
    this.publish({ state: 'connecting', attempt: this.failedAttempts })
    void this.connect()
  }

  /**
   * 停止重连、关闭传输并注销本服务端的全部工具。
   * 清理有固定预算：超出后只记录诊断，不阻塞设置页的操作。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const generation = this.generation
    this.generation = undefined
    this.connectedAt = undefined
    if (generation !== undefined) {
      await this.closeGeneration(generation)
    }
    // 已经开始的同步可能仍在注册工具：等它收尾再统一注销
    await this.syncing.catch(() => undefined)
    this.clearTools()
    this.onInstructions('')
  }

  /** 建立一代连接：连接 → 同步工具 → 进入已连接；失败进入重连或放弃 */
  private async connect(): Promise<void> {
    if (this.disposed || this.reconnectTimer !== undefined) return
    const client = new Client(
      { name: 'scoder-mcp-client', version: '1.0.0' },
      {
        capabilities: {},
        // 工具列表变化时重新同步；autoRefresh 关掉，由我们自己按公开名换表
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 300,
            onChanged: (error) => {
              if (error) {
                this.log(`MCP 服务端「${this.server.name}」工具列表刷新失败`, error)
                return
              }
              this.requestSync()
            }
          }
        }
      }
    )
    const generation: Generation = { client, lifetime: new AbortController() }
    this.generation = generation
    // 断线只处理当前这一代：换表期间旧代的关闭通知必须被忽略
    client.onclose = () => {
      if (this.generation !== generation) return
      this.handleLost('连接已断开')
    }
    const startedAt = Date.now()
    const remaining = (): number =>
      Math.max(1, this.server.startupTimeoutMs - (Date.now() - startedAt))

    try {
      const transport = createMcpTransport(this.server)
      await withDeadline(
        client.connect(transport, { signal: generation.lifetime.signal }),
        remaining(),
        '启动超时'
      )
      this.requireCurrent(generation)
      await withDeadline(this.syncTools(generation), remaining(), '启动时同步工具超时')
      this.requireCurrent(generation)
      const instructions = client.getInstructions()?.trim() ?? ''
      this.connectedAt = Date.now()
      this.onInstructions(instructions)
      this.publishConnected()
      if (this.failedAttempts > 0) {
        this.log(
          `MCP 服务端「${this.server.name}」已重连（第 ${this.failedAttempts}/${this.server.reconnect.maxAttempts} 次尝试后）`
        )
      }
      this.failedAttempts = 0
    } catch (error) {
      if (this.generation !== generation) return
      this.generation = undefined
      await this.closeGeneration(generation)
      if (this.disposed) return
      const reason = `${this.server.name}：${describeError(error)}`
      this.log(`MCP 服务端「${this.server.name}」连接失败`, error)
      this.scheduleReconnect(reason, undefined)
    }
  }

  /** 当前代已经失效（被替换或已中止）时短路后续步骤 */
  private requireCurrent(generation: Generation): void {
    if (this.generation !== generation || generation.lifetime.signal.aborted) {
      throw new Error('连接已被替换')
    }
  }

  /** 断线：清理当前代并安排重试 */
  private handleLost(reason: string): void {
    if (this.disposed) return
    const generation = this.generation
    if (generation === undefined) return
    this.generation = undefined
    const connectedAt = this.connectedAt
    this.connectedAt = undefined
    void (async () => {
      await this.closeGeneration(generation)
      this.onInstructions('')
      if (this.disposed) return
      this.scheduleReconnect(reason, connectedAt)
    })()
  }

  /**
   * 安排一次重连；连接稳定过（存活超过 maxDelayMs）时先清空预算。
   * @param error 触发重连的可读原因
   * @param connectedAt 上一代的建立时间；首次连接失败时为 undefined
   */
  private scheduleReconnect(error: string, connectedAt: number | undefined): void {
    if (this.disposed) return
    const policy = this.server.reconnect
    if (!policy.enabled) {
      this.clearTools()
      this.publish({ state: 'failed', reason: 'reconnect-disabled', lastError: error })
      this.log(`MCP 服务端「${this.server.name}」连接失败，且自动重连已关闭`)
      return
    }
    // 稳定运行超过退避上限：上一次断线算彻底恢复，预算重新计数
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) {
      this.failedAttempts = 0
    }
    this.failedAttempts += 1
    if (this.failedAttempts > policy.maxAttempts) {
      this.clearTools()
      this.publish({ state: 'failed', reason: 'gave-up', lastError: error })
      this.log(
        `MCP 服务端「${this.server.name}」连续 ${policy.maxAttempts} 次重连失败，已放弃并注销其工具`
      )
      return
    }
    const delayMs = Math.min(
      policy.maxDelayMs,
      policy.initialDelayMs * 2 ** (this.failedAttempts - 1)
    )
    this.publish({
      state: 'reconnecting',
      attempt: this.failedAttempts,
      maxAttempts: policy.maxAttempts,
      nextRetryAtMs: Date.now() + delayMs,
      lastError: error
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.disposed) return
      this.publish({ state: 'connecting', attempt: this.failedAttempts })
      void this.connect()
    }, delayMs)
    this.reconnectTimer.unref()
  }

  /** 工具列表变化后重新同步（串行链，避免与重连并发换表） */
  private requestSync(): void {
    const generation = this.generation
    if (generation === undefined || this.connectedAt === undefined) return
    this.syncing = this.syncing
      .then(async () => {
        if (this.generation !== generation) return
        await this.syncTools(generation)
        if (this.generation !== generation) return
        this.publishConnected()
      })
      .catch((error: unknown) => {
        this.log(`MCP 服务端「${this.server.name}」重新同步工具失败`, error)
      })
  }

  /** 拉取工具列表并换表；换表只在拉取全部成功后才动手 */
  private async syncTools(generation: Generation): Promise<void> {
    const { client, lifetime } = generation
    const capabilities = client.getServerCapabilities()
    const tools =
      capabilities?.tools === undefined ? [] : await this.listAllTools(client, lifetime.signal)
    const definitions = new Map<string, ToolDefinition>()
    for (const tool of tools) {
      const name = publicToolName(this.server.name, tool.name)
      if (definitions.has(name)) {
        throw new Error(`服务端重复列出工具「${tool.name}」，无法建立稳定命名`)
      }
      definitions.set(
        name,
        createMcpToolDefinition(
          this.server.name,
          tool,
          (args, signal) => this.invoke(generation, tool, args, signal),
          this.server.toolCallTimeoutMs
        )
      )
    }
    // 先注销旧代再注册新代：同名工具不会被自己挡住
    const previous = this.disposers
    this.disposers = new Map()
    for (const dispose of previous.values()) dispose()
    const registered = new Map<string, () => void>()
    try {
      for (const [name, definition] of definitions) {
        registered.set(name, this.sink.register(definition))
      }
    } catch (error) {
      // 注册冲突时回滚成零工具：模型要么看到完整一代，要么一个都看不到
      for (const dispose of registered.values()) dispose()
      throw new Error(`工具注册失败：${describeError(error)}`, { cause: error })
    }
    this.disposers = registered
    this.tools = [...definitions.values()].map((definition) => ({
      name: definition.name,
      description: definition.description
    }))
  }

  /**
   * 翻页读取服务端公布的全部工具。
   * @param client 当前连接代的客户端
   * @param signal 连接代的中止信号
   * @returns 全部工具；页数超过上限时抛错（游标实现有问题应显式暴露）
   */
  private async listAllTools(client: Client, signal: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        signal
      })
      tools.push(...response.tools)
      if (response.nextCursor === undefined || response.nextCursor === '') return tools
      cursor = response.nextCursor
    }
    throw new Error(`工具列表超过 ${MAX_LIST_PAGES} 页，已停止读取`)
  }

  /** 调用当前代的工具；连接已断开时不发请求，直接给出可读失败 */
  private async invoke(
    generation: Generation,
    tool: McpTool,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<CallToolResult> {
    if (this.generation !== generation) {
      throw new Error(`MCP 服务端「${this.server.name}」已断开，未发送请求`)
    }
    // 显式传入结果 schema：让 SDK 按标准调用结果校验；
    // 兼容形态（toolResult）没有 content 数组，属于本桥不支持的旧协议返回，直接判错
    const result = await generation.client.callTool(
      { name: tool.name, arguments: args },
      CallToolResultSchema,
      { signal }
    )
    if (!hasContentBlocks(result)) {
      throw new Error(`MCP 服务端「${this.server.name}」返回了不兼容的调用结果（缺少 content）`)
    }
    return result
  }

  /** 关闭一代连接：先中止代内所有请求，再关闭传输，整体有预算 */
  private async closeGeneration(generation: Generation): Promise<void> {
    generation.lifetime.abort(new Error('MCP 连接已关闭'))
    try {
      await withDeadline(generation.client.close(), CLOSE_TIMEOUT_MS, '关闭连接超时')
    } catch (error) {
      this.log(`MCP 服务端「${this.server.name}」关闭连接失败`, error)
    }
  }

  /** 注销本服务端的全部工具并清空展示信息 */
  private clearTools(): void {
    for (const dispose of this.disposers.values()) dispose()
    this.disposers = new Map()
    this.tools = []
  }

  /** 推送“已连接”状态 */
  private publishConnected(): void {
    this.publish({
      state: 'connected',
      toolCount: this.disposers.size,
      connectedAt: this.connectedAt ?? Date.now(),
      tools: this.tools
    })
  }

  /** 推送状态；收尾开始后不再推送，避免把已删除的配置又画回列表 */
  private publish(status: McpServerStatus): void {
    if (this.disposed) return
    this.onStatus(status)
  }
}

/**
 * 判定一次调用结果是否带标准的内容数组。
 * 旧协议的兼容返回只有一个 toolResult 字段；这种结果无法投影成模型可读文本。
 * @param value 服务端返回的调用结果
 * @returns 是否是可投影的标准结果
 */
function hasContentBlocks(value: unknown): value is CallToolResult {
  if (typeof value !== 'object' || value === null) return false
  return Array.isArray((value as { content?: unknown }).content)
}
