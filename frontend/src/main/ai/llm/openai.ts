import type { JsonSchemaObject } from '../../../shared/ai/types'
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

/** 流式增量：文本片段或工具调用的参数片段（工具调用按 index 合并） */
export interface StreamDelta {
  text?: string
  toolCalls?: {
    index: number
    id?: string
    name?: string
    argumentsDelta?: string
  }[]
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

/**
 * 调用 OpenAI 兼容的 chat/completions 流式接口。
 * 只做两件事：把 SSE 帧解析成增量、把取消信号透传给 fetch。
 * 不负责重试、计费、reasoning 字段（P2 再补）。
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
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey.length > 0 ? { Authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: config.modelName,
      messages,
      stream: true,
      ...(tools.length > 0 ? { tools } : {})
    }),
    signal
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`模型请求失败（HTTP ${response.status}）：${detail.slice(0, 500)}`)
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

/** 解析一帧 SSE 数据；个别厂商会发送心跳等非 JSON 内容，直接忽略 */
function parseDelta(data: string): StreamDelta | undefined {
  let chunk: StreamChunk
  try {
    chunk = JSON.parse(data) as StreamChunk
  } catch {
    return undefined
  }
  const choice = chunk.choices?.[0]
  const delta = choice?.delta
  if (!delta) return undefined
  const result: StreamDelta = {}
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
  return Object.keys(result).length > 0 ? result : undefined
}
