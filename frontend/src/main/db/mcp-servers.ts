import {
  DEFAULT_MCP_RECONNECT,
  MCP_RECONNECT_LIMITS,
  MCP_SERVER_NAME_PATTERN,
  MCP_TIMEOUT_LIMITS,
  type McpReconnectSettings,
  type McpServerConfig,
  type McpServerInput,
  type McpTransport
} from '../../shared/mcp/types'
import { requireDatabase } from './connection'
import { DbError } from './errors'

/** mcp_servers 表的一行（数组与对象列是 JSON 文本） */
interface McpServerRow {
  id: number
  name: string
  enabled: number
  transport: string
  command: string
  args: string
  env: string
  cwd: string
  url: string
  headers: string
  tool_call_timeout_ms: number
  startup_timeout_ms: number
  reconnect: string
  created_at: string
  updated_at: string
}

/** 合法的传输方式（数据库里出现其他值时按 stdio 兜底并列日志） */
const TRANSPORTS: readonly McpTransport[] = ['stdio', 'streamable-http']

/**
 * 读取全部 MCP 服务端配置，按主键升序（即创建顺序）。
 * @returns 配置列表；已损坏的 JSON 列回退为空集合，不让整张列表失败
 */
export function listMcpServers(): McpServerConfig[] {
  const rows = requireDatabase()
    .prepare('SELECT * FROM mcp_servers ORDER BY id ASC')
    .all() as McpServerRow[]
  return rows.map(toConfig)
}

/**
 * 按主键读取一条配置。
 * @param id 主键
 * @returns 配置；不存在时返回 null
 */
export function findMcpServer(id: number): McpServerConfig | null {
  const row = requireDatabase().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as
    McpServerRow | undefined
  return row ? toConfig(row) : null
}

/**
 * 新建服务端配置。
 * @param input 渲染进程提交的字段，逐项校验后才落库
 * @returns 落库后的完整记录
 * @throws DbError 字段非法或服务名重复
 */
export function createMcpServer(input: unknown): McpServerConfig {
  const server = requireInput(input)
  const statement = requireDatabase().prepare(
    `INSERT INTO mcp_servers (
       name, enabled, transport, command, args, env, cwd, url, headers,
       tool_call_timeout_ms, startup_timeout_ms, reconnect
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  let id = 0
  guardNameConflict(() => {
    const result = statement.run(
      server.name,
      server.enabled ? 1 : 0,
      server.transport,
      server.command,
      JSON.stringify(server.args),
      JSON.stringify(server.env),
      server.cwd,
      server.url,
      JSON.stringify(server.headers),
      server.toolCallTimeoutMs,
      server.startupTimeoutMs,
      JSON.stringify(server.reconnect)
    )
    id = Number(result.lastInsertRowid)
  }, server.name)
  return requireServer(id)
}

/**
 * 覆盖更新一条配置。
 * @param id 主键
 * @param input 渲染进程提交的字段
 * @returns 更新后的完整记录
 * @throws DbError 记录不存在、字段非法或服务名与别人重复
 */
export function updateMcpServer(id: number, input: unknown): McpServerConfig {
  requireServer(id)
  const server = requireInput(input)
  const statement = requireDatabase().prepare(
    `UPDATE mcp_servers SET
       name = ?, enabled = ?, transport = ?, command = ?, args = ?, env = ?, cwd = ?,
       url = ?, headers = ?, tool_call_timeout_ms = ?, startup_timeout_ms = ?, reconnect = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`
  )
  guardNameConflict(() => {
    statement.run(
      server.name,
      server.enabled ? 1 : 0,
      server.transport,
      server.command,
      JSON.stringify(server.args),
      JSON.stringify(server.env),
      server.cwd,
      server.url,
      JSON.stringify(server.headers),
      server.toolCallTimeoutMs,
      server.startupTimeoutMs,
      JSON.stringify(server.reconnect),
      id
    )
  }, server.name)
  return requireServer(id)
}

/**
 * 删除一条配置。
 * @param id 主键
 * @returns 是否确实删除了一行
 */
export function deleteMcpServer(id: number): boolean {
  const result = requireDatabase().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
  return result.changes > 0
}

/**
 * 只改启用开关：停用即断开并注销工具，启用即重新挂载。
 * @param id 主键
 * @param enabled 目标状态
 * @returns 更新后的完整记录
 * @throws DbError 记录不存在
 */
export function setMcpServerEnabled(id: number, enabled: boolean): McpServerConfig {
  requireServer(id)
  requireDatabase()
    .prepare(
      `UPDATE mcp_servers SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`
    )
    .run(enabled ? 1 : 0, id)
  return requireServer(id)
}

/** 按主键取记录，不存在时抛错 */
function requireServer(id: number): McpServerConfig {
  if (!Number.isInteger(id) || id <= 0) {
    throw new DbError('MCP 服务端 id 无效', 'INVALID_ARGUMENT')
  }
  const server = findMcpServer(id)
  if (!server) {
    throw new DbError(`MCP 服务端 ${id} 不存在`, 'MCP_SERVER_NOT_FOUND')
  }
  return server
}

/** 行 → 投影 */
function toConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    transport: TRANSPORTS.includes(row.transport as McpTransport)
      ? (row.transport as McpTransport)
      : 'stdio',
    command: row.command,
    args: parseJson(row.args, [], isStringArray),
    env: parseJson(row.env, {}, isStringRecord),
    cwd: row.cwd,
    url: row.url,
    headers: parseJson(row.headers, {}, isStringRecord),
    toolCallTimeoutMs: row.tool_call_timeout_ms,
    startupTimeoutMs: row.startup_timeout_ms,
    reconnect: parseReconnect(row.reconnect),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** JSON 列解析：内容不可用时回退默认值，并留下一条诊断（不阻断整张列表） */
function parseJson<T>(text: string, fallback: T, accept: (value: unknown) => value is T): T {
  try {
    const parsed: unknown = JSON.parse(text)
    if (accept(parsed)) {
      return parsed
    }
  } catch (error) {
    console.warn('MCP 配置列不是合法 JSON，已回退默认值', error)
    return fallback
  }
  console.warn('MCP 配置列内容不符合预期，已回退默认值')
  return fallback
}

/** 重连策略列解析：逐字段校验，越界或缺失时回退默认值 */
function parseReconnect(text: string): McpReconnectSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    console.warn('MCP 重连配置不是合法 JSON，已回退默认值', error)
    return { ...DEFAULT_MCP_RECONNECT }
  }
  if (!isRecord(parsed)) {
    return { ...DEFAULT_MCP_RECONNECT }
  }
  return {
    enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_MCP_RECONNECT.enabled,
    initialDelayMs: clampInteger(
      parsed.initialDelayMs,
      MCP_RECONNECT_LIMITS.initialDelayMs,
      DEFAULT_MCP_RECONNECT.initialDelayMs
    ),
    maxDelayMs: clampInteger(
      parsed.maxDelayMs,
      MCP_RECONNECT_LIMITS.maxDelayMs,
      DEFAULT_MCP_RECONNECT.maxDelayMs
    ),
    maxAttempts: clampInteger(
      parsed.maxAttempts,
      MCP_RECONNECT_LIMITS.maxAttempts,
      DEFAULT_MCP_RECONNECT.maxAttempts
    )
  }
}

/**
 * 校验渲染进程提交的配置。
 * 一次只报第一个问题：设置面板的保存按钮会把它原样展示，堆一屏错误反而无从下手。
 * @param input IPC 传入的未知值
 * @returns 清洗后的字段
 * @throws DbError 任一字段非法
 */
function requireInput(input: unknown): McpServerInput {
  if (!isRecord(input)) {
    throw new DbError('MCP 服务端配置无效', 'INVALID_ARGUMENT')
  }
  const name = requireText(input.name, '服务名').trim()
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    throw new DbError(
      '服务名只能包含字母、数字、下划线和短横线，长度 1-32，例如 filesystem',
      'INVALID_ARGUMENT'
    )
  }
  const transport = input.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    throw new DbError('传输方式必须是 stdio 或 streamable-http', 'INVALID_ARGUMENT')
  }
  if (typeof input.enabled !== 'boolean') {
    throw new DbError('启用状态必须是布尔值', 'INVALID_ARGUMENT')
  }
  const command = requireText(input.command, '命令').trim()
  const args = requireStringArray(input.args, '参数')
  const env = requireStringRecord(input.env, '环境变量')
  const cwd = requireText(input.cwd, '工作目录').trim()
  const url = requireText(input.url, '地址').trim()
  const headers = requireStringRecord(input.headers, '请求头')

  if (transport === 'stdio') {
    if (command.length === 0) {
      throw new DbError('stdio 传输必须填写启动命令', 'INVALID_ARGUMENT')
    }
    if (url.length > 0) {
      throw new DbError(
        'stdio 传输不填写地址；需要远程服务请改选 streamable-http',
        'INVALID_ARGUMENT'
      )
    }
    if (Object.keys(headers).length > 0) {
      throw new DbError(
        'stdio 传输不填写请求头；需要远程服务请改选 streamable-http',
        'INVALID_ARGUMENT'
      )
    }
  } else {
    if (url.length === 0) {
      throw new DbError('streamable-http 传输必须填写服务地址', 'INVALID_ARGUMENT')
    }
    requireHttpUrl(url)
    if (command.length > 0 || args.length > 0 || Object.keys(env).length > 0 || cwd.length > 0) {
      throw new DbError(
        'streamable-http 传输不使用命令、参数、环境变量与工作目录；需要本地进程请改选 stdio',
        'INVALID_ARGUMENT'
      )
    }
  }

  const toolCallTimeoutMs = requireInteger(
    input.toolCallTimeoutMs,
    '工具调用超时',
    MCP_TIMEOUT_LIMITS.toolCallTimeoutMs
  )
  const startupTimeoutMs = requireInteger(
    input.startupTimeoutMs,
    '启动超时',
    MCP_TIMEOUT_LIMITS.startupTimeoutMs
  )
  const reconnect = requireReconnect(input.reconnect)
  return {
    name,
    enabled: input.enabled,
    transport,
    command,
    args,
    env,
    cwd,
    url,
    headers,
    toolCallTimeoutMs,
    startupTimeoutMs,
    reconnect
  }
}

/** 重连策略校验：上下界之外还要求首次延迟不超过退避上限 */
function requireReconnect(value: unknown): McpReconnectSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_MCP_RECONNECT }
  }
  if (typeof value.enabled !== 'boolean') {
    throw new DbError('重连开关必须是布尔值', 'INVALID_ARGUMENT')
  }
  const initialDelayMs = requireInteger(
    value.initialDelayMs,
    '首次重试延迟',
    MCP_RECONNECT_LIMITS.initialDelayMs
  )
  const maxDelayMs = requireInteger(
    value.maxDelayMs,
    '最大重试延迟',
    MCP_RECONNECT_LIMITS.maxDelayMs
  )
  const maxAttempts = requireInteger(
    value.maxAttempts,
    '最大重试次数',
    MCP_RECONNECT_LIMITS.maxAttempts
  )
  if (initialDelayMs > maxDelayMs) {
    throw new DbError('首次重试延迟不能大于最大重试延迟', 'INVALID_ARGUMENT')
  }
  return { enabled: value.enabled, initialDelayMs, maxDelayMs, maxAttempts }
}

/** 只接受 http/https 的地址：stdio 之外的传输方式都要真正可连 */
function requireHttpUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // 服务端地址解析失败只可能是格式问题，统一给出可读提示
    throw new DbError('服务地址不是合法的 URL', 'INVALID_ARGUMENT')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DbError('服务地址必须使用 http 或 https', 'INVALID_ARGUMENT')
  }
}

/** 读必填字符串 */
function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new DbError(`${label}必须是字符串`, 'INVALID_ARGUMENT')
  }
  return value
}

/** 读字符串数组 */
function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new DbError(`${label}必须是字符串数组`, 'INVALID_ARGUMENT')
  }
  return [...value]
}

/** 读字符串到字符串的对象 */
function requireStringRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new DbError(`${label}必须是键值对象`, 'INVALID_ARGUMENT')
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new DbError(`${label}「${key}」的值必须是字符串`, 'INVALID_ARGUMENT')
    }
    out[key] = entry
  }
  return out
}

/** 读范围内的整数 */
function requireInteger(
  value: unknown,
  label: string,
  range: { readonly min: number; readonly max: number }
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < range.min ||
    value > range.max
  ) {
    throw new DbError(`${label}必须是 ${range.min} 到 ${range.max} 之间的整数`, 'INVALID_ARGUMENT')
  }
  return value
}

/** 当前值合法就保留，否则用默认值 */
function clampInteger(
  value: unknown,
  range: { readonly min: number; readonly max: number },
  fallback: number
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= range.min &&
    value <= range.max
    ? value
    : fallback
}

/** 窄化为字符串键对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON 列断言：字符串数组 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** JSON 列断言：字符串到字符串的对象 */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

/**
 * 把唯一约束冲突翻译成用户能看懂的提示。
 * 服务名是数据库唯一键：INSERT/UPDATE 撞键时 better-sqlite3 抛的是英文 SQL 错误。
 * @param action 写入动作
 * @param name 冲突的服务名
 */
function guardNameConflict(action: () => void, name: string): void {
  try {
    action()
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      String(error.code).includes('SQLITE_CONSTRAINT')
    ) {
      throw new DbError(`服务名「${name}」已被占用，请换一个名字`, 'INVALID_ARGUMENT', {
        cause: error
      })
    }
    throw error
  }
}
