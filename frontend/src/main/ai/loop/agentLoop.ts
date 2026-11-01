import type { AiEvent, AiSendRequest, AiTurnEndReason } from '../../../shared/ai/types'
import type { FileSystemService } from '../fs/service'
import type { ChatMessage, ChatToolCall, OpenAiConfig, StreamDelta } from '../llm/openai'
import { streamChat, toOpenAiTools } from '../llm/openai'
import { buildSystemPrompt } from '../prompt'
import type { SessionStore } from '../session/store'
import type { SessionBlock } from '../session/types'
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
  // 先落盘上一轮遗留的未闭合标记，再据此算出本轮编号
  const state = await sessions.ensure(request.sessionId)
  await sessions.settle(request.sessionId)

  const turn = state.turnCount + 1
  const messages = await initialMessages(sessions, request)
  const tools = toOpenAiTools(registry.list())
  let reason: AiTurnEndReason = 'done'

  emit({ type: 'turn-start', sessionId: request.sessionId })
  await sessions.record(request.sessionId, [
    { type: 'turn/start', data: { turn, cwd: request.cwd, modelConfigId: request.modelConfigId } },
    { type: 'user/message', data: { content: [{ type: 'text', text: request.prompt }] } }
  ])
  try {
    for (let step = 1; step <= MAX_STEPS; step += 1) {
      signal.throwIfAborted()
      emit({ type: 'step-start', step })
      await sessions.record(request.sessionId, [{ type: 'step/start', data: { turn, step } }])

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
        await sessions.record(request.sessionId, [
          { type: 'assistant/message', data: { turn, step, content: toBlocks(text, toolCalls) } }
        ])
      }

      // 工具执行属于本步，step/end 要等它们全部回报之后再写
      for (const call of toolCalls) {
        signal.throwIfAborted()
        await executeCall(call, messages, {
          fs,
          registry,
          request,
          sessions,
          turn,
          step,
          emit,
          signal
        })
      }
      await sessions.record(request.sessionId, [{ type: 'step/end', data: { turn, step } }])

      if (toolCalls.length === 0) {
        break
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
    // 无论正常结束还是中断，都闭合这一轮：留下的历史就是用户下次能看到的全部内容
    try {
      await sessions.record(request.sessionId, [{ type: 'turn/end', data: { turn, reason } }])
    } catch (error) {
      // 日志写失败不能吞掉本轮结论，先让界面看到错误再照常通知结束
      emit({ type: 'error', message: errorMessage(error) })
    }
    emit({ type: 'turn-end', reason })
  }
}

/**
 * 组装本次请求的消息序列：系统提示每轮现算，历史从日志重放得到。
 * 系统提示不入库，改 prompt.ts 后对所有历史会话立即生效。
 */
async function initialMessages(
  sessions: SessionStore,
  request: AiSendRequest
): Promise<ChatMessage[]> {
  const history = await sessions.history(request.sessionId)
  const systemMessage: ChatMessage = { role: 'system', content: buildSystemPrompt(request.cwd) }
  const userMessage: ChatMessage = { role: 'user', content: request.prompt }
  return [systemMessage, ...history, userMessage]
}

/** 把一步的输出转成落盘内容块：文本在前，工具调用按模型给出的顺序在后 */
function toBlocks(text: string, toolCalls: readonly ChatToolCall[]): SessionBlock[] {
  const blocks: SessionBlock[] = []
  if (text.length > 0) {
    blocks.push({ type: 'text', text })
  }
  for (const call of toolCalls) {
    blocks.push({
      type: 'tool-call',
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments
    })
  }
  return blocks
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

/** 执行一次工具调用，把结果落盘后作为 tool 消息回灌给模型 */
async function executeCall(
  call: ChatToolCall,
  messages: ChatMessage[],
  context: {
    fs: FileSystemService
    registry: ToolRegistry
    request: AiSendRequest
    sessions: SessionStore
    turn: number
    step: number
    emit: (event: AiEvent) => void
    signal: AbortSignal
  }
): Promise<void> {
  const { fs, registry, request, sessions, turn, step, emit, signal } = context
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
  await sessions.record(request.sessionId, [
    {
      type: 'tool/result',
      data: {
        turn,
        step,
        callId: call.id,
        name: call.function.name,
        ok: result.ok,
        text: result.text
      }
    }
  ])
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
