import type { AiEvent, AiSendRequest, AiTurnEndReason } from '../../../shared/ai/types'
import type { FileSystemService } from '../fs/service'
import type { ChatMessage, ChatToolCall, OpenAiConfig, StreamDelta } from '../llm/openai'
import { streamChat, toOpenAiTools } from '../llm/openai'
import { buildSystemPrompt } from '../prompt'
import type { SessionStore } from '../session/store'
import { errorMessage, type ToolRegistry } from '../tools/registry'

/** 一轮对话允许的最大模型步数：防止模型在工具循环里空转 */
const MAX_STEPS = 24

/** 流式累积中的工具调用（同一 index 的片段合并成一次调用） */
interface PendingCall {
  id: string
  name: string
  arguments: string
}

/** 一轮对话的依赖：全部由调用方注入，循环自身不创建服务、不碰 IPC */
export interface RunTurnOptions {
  request: AiSendRequest
  model: OpenAiConfig
  fs: FileSystemService
  registry: ToolRegistry
  sessions: SessionStore
  /** 事件出口：主进程里是 webContents.send，测试里可以直接收集 */
  emit: (event: AiEvent) => void
  /** 用户中止信号 */
  signal: AbortSignal
}

/**
 * 执行一轮对话：模型流 → 文本增量 → 工具调用 → 结果回灌 → 下一步。
 * 停止条件：模型不再请求工具、用户中止、达到步数上限或发生错误。
 * @param options 注入的依赖与本轮请求
 */
export async function runTurn(options: RunTurnOptions): Promise<void> {
  const { request, model, fs, registry, sessions, emit, signal } = options
  const messages = initialMessages(sessions, request)
  const tools = toOpenAiTools(registry.list())
  let reason: AiTurnEndReason = 'done'

  emit({ type: 'turn-start', sessionId: request.sessionId })
  try {
    for (let step = 1; step <= MAX_STEPS; step += 1) {
      signal.throwIfAborted()
      emit({ type: 'step-start', step })

      const pending = new Map<number, PendingCall>()
      let text = ''
      for await (const delta of streamChat(model, messages, tools, signal)) {
        text += appendDelta(delta, pending, emit)
      }
      const toolCalls = finishCalls(pending)

      // 有文本或工具调用才写 assistant 消息；空响应直接结束本轮
      if (text.length > 0 || toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        })
        sessions.replace(request.sessionId, messages)
      }
      if (toolCalls.length === 0) {
        break
      }

      for (const call of toolCalls) {
        signal.throwIfAborted()
        await executeCall(call, messages, { fs, registry, request, emit, signal })
        sessions.replace(request.sessionId, messages)
      }

      if (step === MAX_STEPS) {
        reason = 'error'
        emit({ type: 'error', message: `达到单轮最大步数 ${MAX_STEPS}，已停止` })
      }
    }
  } catch (error) {
    if (signal.aborted) {
      reason = 'aborted'
    } else {
      reason = 'error'
      emit({ type: 'error', message: errorMessage(error) })
    }
  } finally {
    // 无论正常结束还是中断，都把已发生的消息留在会话里
    sessions.replace(request.sessionId, messages)
    emit({ type: 'turn-end', reason })
  }
}

/** 首轮插入系统提示；之后复用历史，只追加用户消息 */
function initialMessages(sessions: SessionStore, request: AiSendRequest): ChatMessage[] {
  const history = sessions.history(request.sessionId)
  const userMessage: ChatMessage = { role: 'user', content: request.prompt }
  if (history.length === 0) {
    return [{ role: 'system', content: buildSystemPrompt(request.cwd) }, userMessage]
  }
  return [...history, userMessage]
}

/**
 * 处理一帧流式增量：文本转成事件，工具调用片段按 index 累积。
 * @returns 本帧新增的文本（无文本时为空串）
 */
function appendDelta(
  delta: StreamDelta,
  pending: Map<number, PendingCall>,
  emit: (event: AiEvent) => void
): string {
  if (delta.text) {
    emit({ type: 'text-delta', text: delta.text })
  }
  for (const part of delta.toolCalls ?? []) {
    const current = pending.get(part.index) ?? { id: '', name: '', arguments: '' }
    if (part.id) current.id = part.id
    if (part.name) current.name = part.name
    if (part.argumentsDelta) current.arguments += part.argumentsDelta
    pending.set(part.index, current)
  }
  return delta.text ?? ''
}

/** 把累积片段整理成可执行的调用：按 index 排序，缺失 id 时补一个稳定值 */
function finishCalls(pending: Map<number, PendingCall>): ChatToolCall[] {
  return [...pending.entries()]
    .sort(([left], [right]) => left - right)
    .filter(([, call]) => call.name.length > 0)
    .map(([index, call]) => ({
      id: call.id.length > 0 ? call.id : `call_${index}`,
      type: 'function' as const,
      function: { name: call.name, arguments: call.arguments }
    }))
}

/** 执行一次工具调用，并把结果作为 tool 消息回灌给模型 */
async function executeCall(
  call: ChatToolCall,
  messages: ChatMessage[],
  context: {
    fs: FileSystemService
    registry: ToolRegistry
    request: AiSendRequest
    emit: (event: AiEvent) => void
    signal: AbortSignal
  }
): Promise<void> {
  const { fs, registry, request, emit, signal } = context
  const args = safeParseArguments(call.function.arguments)
  const card = registry.get(call.function.name)?.presentCall?.(args)
  emit({
    type: 'tool-call',
    callId: call.id,
    name: call.function.name,
    args,
    ...(card ? { card } : {})
  })
  const result = await registry.execute(call.function.name, call.function.arguments, {
    fs,
    cwd: request.cwd,
    sessionId: request.sessionId,
    signal
  })
  emit({
    type: 'tool-result',
    callId: call.id,
    ok: result.ok,
    text: result.text,
    ...(result.card ? { card } : {})
  })
  messages.push({ role: 'tool', tool_call_id: call.id, content: result.text })
}

/** 展示用：参数解析失败时给空对象，真正的错误交给注册表回报 */
function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = raw.trim().length === 0 ? {} : JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
