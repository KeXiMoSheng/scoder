import type { AiTokenUsage, JsonSchemaObject } from '../../../shared/ai/types'
import type { ToolDefinition } from '../tools/registry'

/** 一次模型调用的连接配置（来自本地 SQLite 的 model_configs 行） */
export interface OpenAiConfig {
  baseUrl: string
  apiKey: string
  modelName: string
}

/** 发回模型的工具调用（assistant 消息里的 tool_calls 项） */
export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** 会话历史中的一条消息，形状与 OpenAI chat/completions 对齐 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
}

/** 提供给模型的工具声明 */
export interface OpenAiToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: JsonSchemaObject }
}

/** 流式增量：文本片段、工具调用参数片段或最终 usage（工具调用按 index 合并） */
export interface StreamDelta {
  text?: string
  toolCalls?: {
    index: number
    id?: string
    name?: string
    argumentsDelta?: string
  }[]
  /** 服务商在流的末尾返回的本次调用用量 */
  usage?: AiTokenUsage
}

/** 模型流里一帧的最小结构（只声明用到的字段） */
interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  /** stream_options.include_usage 打开的供应商会在最后追加一帧 usage */
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  } | null
}

/** 工具定义 → 模型可读的 function 列表（P0 不带任何执行期元数据） */
export function toOpenAiTools(tools: ToolDefinition[]): OpenAiToolSpec[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))
}

/** 首次请求之外最多重试几次；重试只覆盖建立连接阶段 */
const MAX_RETRIES = 5

/** 这些状态码属于临时故障，值得重试；鉴权、参数错误等重试也没用 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

/** 指数退避：500ms 起步，最长 10s，叠加 ±10% 抖动避免同时重试 */
function retryDelay(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 10_000)
  const jitter = base * 0.1 * (Math.random() * 2 - 1)
  return Math.round(base + jitter)
}

/** 可被用户中止打断的等待 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 建立连接并拿到响应头；只有这一阶段能重试。
 * 流一旦开始产出就不再重试，否则会把已经显示给用户的文本重复一遍。
 * @param config 连接配置
 * @param body 已经序列化好的请求体，重试时原样复用
 * @param signal 用户中止信号
 */
async function openStream(
  config: OpenAiConfig,
  body: string,
  signal: AbortSignal
): Promise<Response> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const headers = {
    'Content-Type': 'application/json',
    ...(config.apiKey.length > 0 ? { Authorization: `Bearer ${config.apiKey}` } : {})
  }
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      const delay = retryDelay(attempt - 1)
      console.warn(`模型请求失败，${delay}ms 后进行第 ${attempt} 次重试`)
      await sleep(delay, signal)
    }
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal
      })
    } catch (error) {
      // 用户中止不是失败，直接向上传播
      if (signal.aborted) throw error
      lastError = error
      continue
    }
    if (response.ok) {
      return response
    }
    const detail = await response.text().catch(() => '')
    const error = new Error(`模型请求失败（HTTP ${response.status}）：${detail.slice(0, 500)}`)
    if (!RETRYABLE_STATUS.has(response.status)) {
      throw error
    }
    lastError = error
  }
  throw lastError
}

/**
 * 调用 OpenAI 兼容的 chat/completions 流式接口。
 * 负责 SSE → 增量、透传取消信号、建立连接失败时重试，
 * 并通过 stream_options.include_usage 请求服务商的真实 token 用量。
 * @param config 连接配置
 * @param messages 完整会话历史
 * @param tools 工具声明，空数组表示不带工具
 * @param signal 用户中止信号
 */
export async function* streamChat(
  config: OpenAiConfig,
  messages: ChatMessage[],
  tools: OpenAiToolSpec[],
  signal: AbortSignal
): AsyncGenerator<StreamDelta> {
  let response: Response
  try {
    response = await openStream(config, requestBody(config, messages, tools, true), signal)
  } catch (error) {
    // 个别兼容实现会拒绝 stream_options；退回普通流式请求，聊天不中断，只是拿不到 usage
    if (!rejectsStreamOptions(error)) {
      throw error
    }
    console.warn('供应商不支持 stream_options.include_usage，本次不返回真实用量')
    response = await openStream(config, requestBody(config, messages, tools, false), signal)
  }
  if (!response.body) {
    throw new Error('模型响应没有可读流')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // 最后一行可能被网络切断，留到下一块再拼
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        const delta = parseDelta(data)
        if (delta) yield delta
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** 构造流式请求体；includeUsage 为 false 时用于不支持 stream_options 的供应商 */
function requestBody(
  config: OpenAiConfig,
  messages: ChatMessage[],
  tools: OpenAiToolSpec[],
  includeUsage: boolean
): string {
  return JSON.stringify({
    model: config.modelName,
    messages,
    stream: true,
    ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...(tools.length > 0 ? { tools } : {})
  })
}

/**
 * 判断失败是否因为供应商不认识 stream_options/include_usage。
 * 只在 400/422 且错误详情提到该字段时退回，避免吞掉其它参数错误。
 */
function rejectsStreamOptions(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /HTTP (400|422)/.test(error.message) && /stream_options|include_usage/i.test(error.message)
}

/**
 * 不带工具跑一次对话，把流式文本收集成完整字符串。
 * 会话标题这类辅助请求复用它，不再写一份 HTTP/SSE 解析。
 * @param config 连接配置
 * @param messages 请求消息
 * @param signal 取消信号
 * @returns 模型输出的全文
 */
export async function completeChat(
  config: OpenAiConfig,
  messages: ChatMessage[],
  signal: AbortSignal
): Promise<string> {
  let text = ''
  for await (const delta of streamChat(config, messages, [], signal)) {
    if (delta.text) {
      text += delta.text
    }
  }
  return text
}

/** 解析一帧 SSE 数据；个别厂商会发送心跳等非 JSON 内容，直接忽略 */
function parseDelta(data: string): StreamDelta | undefined {
  let chunk: StreamChunk
  try {
    chunk = JSON.parse(data) as StreamChunk
  } catch {
    return undefined
  }
  const result: StreamDelta = {}
  const delta = chunk.choices?.[0]?.delta
  if (delta) {
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      result.text = delta.content
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      result.toolCalls = delta.tool_calls.map((call) => ({
        index: call.index ?? 0,
        ...(call.id ? { id: call.id } : {}),
        ...(call.function?.name ? { name: call.function.name } : {}),
        ...(call.function?.arguments ? { argumentsDelta: call.function.arguments } : {})
      }))
    }
  }
  // usage 帧通常没有 choices（或 delta 为空），不能因为没文本就丢掉
  const usage = toTokenUsage(chunk.usage)
  if (usage) {
    result.usage = usage
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/** 把服务商的 snake_case usage 归一化为驼峰结构；全零或缺失时返回 undefined */
function toTokenUsage(raw: StreamChunk['usage']): AiTokenUsage | undefined {
  if (!raw) {
    return undefined
  }
  const promptTokens = tokenCount(raw.prompt_tokens)
  const completionTokens = tokenCount(raw.completion_tokens)
  const totalTokens = tokenCount(raw.total_tokens) || promptTokens + completionTokens
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return undefined
  }
  return { promptTokens, completionTokens, totalTokens }
}

/** usage 字段可能缺失或为小数；只接受非负有限数，其余按 0 处理 */
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0
}
