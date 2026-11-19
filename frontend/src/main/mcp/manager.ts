/**
 * MCP 服务端管理器：把数据库里的每条启用配置变成一条连接，并串行地对齐两侧。
 *
 * 对应 deepseek-harness 的 mcp-manager：配置是唯一事实来源，
 * 增删改之后调用 refresh()，管理器负责挂载新连接、卸载已删除/停用/变更的连接。
 * 所有生命周期操作串行执行：同一时刻只有一次换表，避免两代工具互相覆盖。
 */

import type {
  McpPromptServer,
  McpProbeResult,
  McpServerConfig,
  McpServerStatus,
  McpServerView
} from '../../shared/mcp/types'
import { toolRegistry } from '../ai/registry'
import { findMcpServer, listMcpServers } from '../db'
import { McpConnection } from './connection'
import { probeMcpServer } from './probe'

/** 一条配置的运行时记录：配置、连接与最近一次状态 */
interface ServerRecord {
  server: McpServerConfig
  /** 已挂载的连接；停用或连接尚未建立时为 null */
  connection: McpConnection | null
  status: McpServerStatus
  /** 服务端自述的使用说明，进入系统提示 */
  instructions: string
}

/** 状态变化订阅者：IPC 层据此推送到所有窗口 */
export type McpStatusListener = (view: McpServerView) => void

/** MCP 服务端管理器 */
export class McpManager {
  private readonly records = new Map<number, ServerRecord>()
  private readonly listeners = new Set<McpStatusListener>()
  /** 生命周期操作的串行尾：每个操作接在它后面执行 */
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false

  /** 启动时按库里的配置挂载全部启用的服务端；失败只记日志，不阻塞应用启动 */
  start(): void {
    void this.refresh().catch((error: unknown) => {
      console.warn('MCP 服务端初始化失败', error)
    })
  }

  /**
   * 读取全部配置及其当前状态。
   * @returns 按创建顺序排列的配置与状态
   */
  list(): McpServerView[] {
    return listMcpServers().map((server) => ({
      server,
      status: this.statusOf(server)
    }))
  }

  /**
   * 订阅状态变化。
   * @param listener 收到单个服务端的最新视图
   * @returns 取消订阅函数
   */
  onChange(listener: McpStatusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 与配置对齐：卸载已删除/停用/变更的连接，挂载新增或重新启用的连接。
   * 增删改配置的 IPC 处理器在落库后调用它。
   */
  async refresh(): Promise<void> {
    await this.enqueue(async () => {
      const servers = listMcpServers()
      const byId = new Map(servers.map((server) => [server.id, server]))
      for (const [id, record] of [...this.records]) {
        const next = byId.get(id)
        const changed = next !== undefined && fingerprint(record.server) !== fingerprint(next)
        if (next === undefined || !next.enabled || changed) {
          await this.unmount(id)
        }
        if (next === undefined) {
          this.records.delete(id)
        }
      }
      for (const server of servers) {
        if (!server.enabled) {
          this.setStatus(server, { state: 'disabled' })
          continue
        }
        const record = this.records.get(server.id)
        if (record === undefined || record.connection === null) {
          this.mount(server)
        }
      }
    })
  }

  /**
   * 重建一条连接：先断开（含工具注销），再按当前配置重新挂载。
   * 重试预算随新连接一起重置。
   * @param id 配置主键
   * @throws 配置不存在时抛错
   */
  async restart(id: number): Promise<void> {
    await this.enqueue(async () => {
      const server = findMcpServer(id)
      if (server === null) {
        throw new Error(`MCP 服务端 ${id} 不存在`)
      }
      await this.unmount(id)
      if (!server.enabled) {
        this.setStatus(server, { state: 'disabled' })
        return
      }
      this.mount(server)
    })
  }

  /**
   * 探测一条配置：临时连接、列工具、断开，不影响已挂载的连接。
   * @param id 配置主键
   * @returns 探测结果
   * @throws 配置不存在时抛错
   */
  async probe(id: number): Promise<McpProbeResult> {
    const server = findMcpServer(id)
    if (server === null) {
      throw new Error(`MCP 服务端 ${id} 不存在`)
    }
    return probeMcpServer(server)
  }

  /**
   * 供给系统提示的 MCP 段落：只包含当前已连接的服务端。
   * @returns 服务名、工具数量与服务端说明
   */
  promptServers(): McpPromptServer[] {
    const servers: McpPromptServer[] = []
    for (const record of this.records.values()) {
      if (record.status.state !== 'connected') continue
      servers.push({
        name: record.server.name,
        toolCount: record.status.toolCount,
        instructions: record.instructions
      })
    }
    return servers.sort((left, right) => left.name.localeCompare(right.name))
  }

  /** 关闭全部连接并注销工具；应用退出前调用 */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const id of [...this.records.keys()]) {
      await this.unmount(id)
    }
    this.records.clear()
    this.listeners.clear()
  }

  /** 挂载一条连接；record 先落位，状态回调才有地方更新 */
  private mount(server: McpServerConfig): void {
    const existing = this.records.get(server.id)
    const record: ServerRecord = existing ?? {
      server,
      connection: null,
      status: { state: 'connecting', attempt: 0 },
      instructions: ''
    }
    record.server = server
    this.records.set(server.id, record)
    const connection = new McpConnection({
      server,
      sink: { register: (definition) => toolRegistry.register(definition) },
      onStatus: (status) => this.setStatus(server, status),
      onInstructions: (instructions) => {
        record.instructions = instructions
      },
      log: (message, error) => {
        if (error === undefined) {
          console.warn(message)
          return
        }
        console.warn(message, error)
      }
    })
    record.connection = connection
    this.setStatus(server, { state: 'connecting', attempt: 0 })
    connection.start()
  }

  /** 卸载一条连接：停掉重连、关闭传输、注销工具 */
  private async unmount(id: number): Promise<void> {
    const record = this.records.get(id)
    if (record === undefined) return
    const connection = record.connection
    record.connection = null
    record.instructions = ''
    if (connection !== null) {
      await connection.dispose()
    }
  }

  /** 记录并广播一条状态 */
  private setStatus(server: McpServerConfig, status: McpServerStatus): void {
    if (this.disposed) return
    const record = this.records.get(server.id) ?? {
      server,
      connection: null,
      status,
      instructions: ''
    }
    record.server = server
    record.status = status
    this.records.set(server.id, record)
    const view: McpServerView = { server, status }
    for (const listener of this.listeners) {
      try {
        listener(view)
      } catch (error) {
        console.warn('MCP 状态订阅者执行失败', error)
      }
    }
  }

  /** 取一条配置的当前状态；没有运行时记录时按启用状态给出初始值 */
  private statusOf(server: McpServerConfig): McpServerStatus {
    const record = this.records.get(server.id)
    if (record !== undefined) return record.status
    return server.enabled ? { state: 'connecting', attempt: 0 } : { state: 'disabled' }
  }

  /**
   * 把一个操作排到串行尾执行。
   * @param operation 生命周期操作
   * @returns 操作的返回值；管理器已销毁时抛错
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.disposed) {
        throw new Error('MCP 管理器已关闭')
      }
      return operation()
    })
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

/**
 * 配置指纹：用于判断一条配置是否需要重建连接。
 * 键值集合按固定顺序展开，避免同样的内容因为 JSON 键序不同被误判为变更。
 * @param server 服务端配置
 * @returns 可比较的字符串
 */
function fingerprint(server: McpServerConfig): string {
  return JSON.stringify([
    server.name,
    server.enabled,
    server.transport,
    server.command,
    server.args,
    sortedEntries(server.env),
    server.cwd,
    server.url,
    sortedEntries(server.headers),
    server.toolCallTimeoutMs,
    server.startupTimeoutMs,
    server.reconnect
  ])
}

/** 键值对象展开成按 key 排序的二维数组 */
function sortedEntries(values: Record<string, string>): Array<[string, string]> {
  return Object.keys(values)
    .sort((left, right) => left.localeCompare(right))
    .map((key): [string, string] => [key, values[key]])
}

/** 进程内唯一的 MCP 管理器 */
export const mcpManager = new McpManager()
