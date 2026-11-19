/**
 * MCP（Model Context Protocol）域：服务端配置、运行状态与探测结果。
 *
 * 这些类型同时被主进程（连接管理）、preload 与渲染进程（设置面板）使用，
 * 因此不允许依赖 Node/Electron：需要哈希、子进程的能力都留在主进程。
 * 设计对应 deepseek-harness 的 mcp-client + mcp-manager：
 * 一条配置对应一个连接实例，工具以 mcp__<服务名>__<原始工具名> 的名字注册。
 */

/** 连接方式：本地子进程（stdio）或远程 Streamable HTTP */
export type McpTransport = 'stdio' | 'streamable-http'

/**
 * 自动重连策略。
 * 一次断线共用一份重试预算：连续失败达到 maxAttempts 后放弃并注销工具；
 * 连接稳定超过 maxDelayMs 后预算清零，下次断线重新计数。
 */
export interface McpReconnectSettings {
  /** 断线后是否自动重连 */
  enabled: boolean
  /** 首次重试延迟（毫秒），之后逐次翻倍 */
  initialDelayMs: number
  /** 退避上限（毫秒），同时是重置重试预算的稳定时长 */
  maxDelayMs: number
  /** 单次断线允许的连续失败次数上限 */
  maxAttempts: number
}

/** 一条 MCP 服务端配置（数据库 mcp_servers 表在进程边界上的投影） */
export interface McpServerConfig {
  /** 自增主键 */
  id: number
  /** 命名空间：工具名拼接为 mcp__<name>__<原始工具名>，库内唯一 */
  name: string
  /** 是否在应用启动后保持连接 */
  enabled: boolean
  transport: McpTransport
  /** stdio：可执行文件 */
  command: string
  /** stdio：参数，按数组原样传递，不经 shell 解释 */
  args: string[]
  /** stdio：附加给子进程的环境变量（覆盖同名系统变量） */
  env: Record<string, string>
  /** stdio：子进程工作目录；空串表示继承主进程 */
  cwd: string
  /** streamable-http：MCP 端点地址 */
  url: string
  /** streamable-http：附加请求头 */
  headers: Record<string, string>
  /** 单次工具调用/资源请求超时（毫秒） */
  toolCallTimeoutMs: number
  /** 单次启动（连接 + 首次工具同步）预算（毫秒） */
  startupTimeoutMs: number
  reconnect: McpReconnectSettings
  /** 创建时间（UTC，ISO 字符串） */
  createdAt: string
  /** 最后更新时间（UTC，ISO 字符串） */
  updatedAt: string
}

/** 新建/更新服务端配置时提交的字段 */
export type McpServerInput = Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>

/** 服务名合法字符：与 deepseek-harness 的 mcp-client 一致，给工具名留出长度预算 */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 工具名长度上限：DeepSeek 函数名契约，属协议常量不作为配置项 */
export const MCP_MAX_TOOL_NAME_LENGTH = 64

/** 超时取值范围：主进程按此校验，设置面板据此提示 */
export const MCP_TIMEOUT_LIMITS = {
  toolCallTimeoutMs: { min: 1_000, max: 600_000 },
  startupTimeoutMs: { min: 1_000, max: 300_000 }
} as const

/** 重连参数的取值范围 */
export const MCP_RECONNECT_LIMITS = {
  initialDelayMs: { min: 100, max: 60_000 },
  maxDelayMs: { min: 100, max: 300_000 },
  maxAttempts: { min: 1, max: 50 }
} as const

/** 默认重连策略：与 deepseek-harness 的 RECONNECT_DEFAULTS 保持一致 */
export const DEFAULT_MCP_RECONNECT: McpReconnectSettings = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10
}

/** 新建服务端表单的初值 */
export const DEFAULT_MCP_SERVER_INPUT: McpServerInput = {
  name: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: '',
  headers: {},
  toolCallTimeoutMs: 60_000,
  startupTimeoutMs: 30_000,
  reconnect: { ...DEFAULT_MCP_RECONNECT }
}

/** 一个已注册的 MCP 工具：公开名已带 mcp__ 命名空间 */
export interface McpToolInfo {
  /** 注册到工具表的公开名 */
  name: string
  /** 服务端给出的说明（空串表示没有说明） */
  description: string
}

/** 放弃重连的原因 */
export type McpFailureReason =
  /** 单次断线的重试预算用尽 */
  | 'gave-up'
  /** 断线时重连开关是关闭的 */
  | 'reconnect-disabled'
  /** 插件级启动失败（配置无法解析等） */
  | 'load'
  /** 上次连接的清理未完成，无法安全替换 */
  | 'cleanup'

/** 单个服务端的运行状态 */
export type McpServerStatus =
  /** 配置为停用，不建立连接 */
  | { state: 'disabled' }
  /** 正在建立连接；attempt 为本次断线已失败的次数（首次为 0） */
  | { state: 'connecting'; attempt: number }
  | {
      state: 'connected'
      /** 当前已注册的工具数量 */
      toolCount: number
      /** 连接与首次工具同步完成的时间（epoch 毫秒） */
      connectedAt: number
      /** 当前已注册的工具（公开名 + 说明） */
      tools: McpToolInfo[]
    }
  | {
      state: 'reconnecting'
      /** 本次断线已失败的次数 */
      attempt: number
      /** 单次断线的重试预算 */
      maxAttempts: number
      /** 下一次重试的时间（epoch 毫秒） */
      nextRetryAtMs: number
      lastError: string
    }
  | { state: 'failed'; reason: McpFailureReason; lastError: string }

/** 设置面板列表项：配置 + 当前状态 */
export interface McpServerView {
  server: McpServerConfig
  status: McpServerStatus
}

/** 探测失败的阶段：建立连接，或列工具 */
export type McpProbeStage = 'connect' | 'list'

/** 探测成功：完成握手与工具枚举 */
export interface McpProbeSuccess {
  ok: true
  /** 服务端在 initialize 里报告的身份（缺失时省略） */
  serverInfo?: { name: string; version: string }
  /** 服务端公布的原始工具名（未加命名空间） */
  toolNames: string[]
  /** 工具名是否被上限截断 */
  truncated: boolean
  /** 握手 + 枚举耗时（毫秒，不含清理） */
  durationMs: number
}

/** 探测失败：给出失败阶段与可读原因 */
export interface McpProbeFailure {
  ok: false
  stage: McpProbeStage
  message: string
  durationMs: number
}

/** 一次探测的结果 */
export type McpProbeResult = McpProbeSuccess | McpProbeFailure

/** 系统提示里的 MCP 段落输入：已连接服务端及其指令 */
export interface McpPromptServer {
  /** 服务名（工具命名空间） */
  name: string
  /** 当前注册的工具数量 */
  toolCount: number
  /** 服务端自述的使用说明（空串表示没有） */
  instructions: string
}
