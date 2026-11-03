import type { AiRuntimeSettings } from '../../../shared/ai/settings'
import type { AiEvent, AiSendRequest, AiTurnEndReason } from '../../../shared/ai/types'
import type { ObservationStore } from '../fs/observation'
import type { FileSystemService } from '../fs/service'
import { toContextUsage } from '../context'
import type { ChatMessage, ChatToolCall, OpenAiConfig, StreamDelta } from '../llm/openai'
import { streamChat, toOpenAiTools } from '../llm/openai'
import { buildSystemPrompt } from '../prompt'
import type { SessionStore } from '../session/store'
import { generateTitle } from '../session/title'
import type { SessionBlock } from '../session/types'
import { errorMessage, type ToolExecutionResult, type ToolRegistry } from '../tools/registry'
import { RepeatCallGuard } from './repeatGuard'

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
  /** 会话级“已读”观测：写工具的“先读后改”就靠它 */
  observation: ObservationStore
  registry: ToolRegistry
  sessions: SessionStore
  /** 本轮使用的运行参数：由调用方从设置读取，循环本身不碰数据库 */
  settings: AiRuntimeSettings
  /** 事件出口：主进程里是 webContents.send，测试里可以直接收集 */
  emit: (event: AiEvent) => void
  /** 用户中止信号 */
  signal: AbortSignal
}

/**
 * 执行一轮对话：模型流 → 文本增量 → 工具调用 → 结果回灌 → 下一步。
 * 停止条件：模型不再请求工具、用户中止、重复调用守卫叫停、续接段数到顶或发生错误。
 * @param options 注入的依赖与本轮请求
 */
export async function runTurn(options: RunTurnOptions): Promise<void> {
  const { request, model, fs, observation, registry, sessions, emit, signal, settings } = options
  // 先落盘上一轮遗留的未闭合标记，再据此算出本轮编号
  const state = await sessions.ensure(request.cwd, request.sessionId)
  await sessions.settle(request.cwd, request.sessionId)

  const turn = state.turnCount + 1
  const messages = await initialMessages(sessions, request)
  const tools = toOpenAiTools(registry.list())
  let reason: AiTurnEndReason = 'done'

  // 首轮异步润色标题：与主回复并行，不阻塞也不影响结果；失败保留默认标题
  if (turn === 1) {
    void refineTitle(request, model, sessions, emit, signal)
  }

  emit({ type: 'turn-start', sessionId: request.sessionId })
  await sessions.record(request.cwd, request.sessionId, [
    { type: 'turn/start', data: { turn, cwd: request.cwd, modelConfigId: request.modelConfigId } },
    { type: 'user/message', data: { content: [{ type: 'text', text: request.prompt }] } }
  ])
  // 重复调用守卫：整轮对话共用一个实例，只有用户发新消息才会重置
  const guard = new RepeatCallGuard({
    thresholds: settings.repeatRemindThresholds,
    stopThreshold: settings.repeatStopThreshold
  })
  /** 当前是第几段（一段 = settings.maxSteps 步预算） */
  let round = 1
  /** 当前段剩余步数 */
  let budget = settings.maxSteps
  /** 已发出的模型调用步数：跨段连续编号，日志里能看出真实的执行顺序 */
  let step = 0

  try {
    while (true) {
      signal.throwIfAborted()

      // 一段预算用尽：不判失败，注入续接指令接着干；到总段数上限才真正停止
      if (budget === 0) {
        if (round >= settings.maxRounds) {
          reason = 'error'
          emit({ type: 'error', message: `达到最大自动续接段数 ${settings.maxRounds}，已停止` })
          break
        }
        round += 1
        budget = settings.maxSteps
        messages.push({ role: 'user', content: continuePrompt(round, settings) })
      }

      step += 1
      budget -= 1
      emit({ type: 'step-start', step })
      await sessions.record(request.cwd, request.sessionId, [
        { type: 'step/start', data: { turn, step } }
      ])

      const pending = new Map<number, PendingCall>()
      let text = ''
      /** 本步模型调用返回的真实用量；供应商未返回时保持 undefined */
      let stepUsage: StreamDelta['usage']
      for await (const delta of streamChat(model, messages, tools, signal)) {
        text += appendDelta(delta, pending, emit)
        if (delta.usage) {
          stepUsage = delta.usage
        }
      }
      const toolCalls = finishCalls(pending)

      // 只推真实用量：拿到 usage 后立刻更新面板，没拿到就保持上一次的值
      if (stepUsage) {
        emit({ type: 'context-usage', usage: toContextUsage(stepUsage) })
      }

      // 有文本或工具调用才写 assistant 消息；空响应直接结束本轮
      if (text.length > 0 || toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        })
        await sessions.record(request.cwd, request.sessionId, [
          { type: 'assistant/message', data: { turn, step, content: toBlocks(text, toolCalls) } }
        ])
      }

      const callContext: CallContext = {
        fs,
        observation,
        registry,
        request,
        sessions,
        turn,
        step,
        emit,
        signal,
        guard
      }

      // 工具执行属于本步，step/end 要等它们全部回报之后再写
      let stoppedByGuard = false
      for (const [index, call] of toolCalls.entries()) {
        signal.throwIfAborted()
        const stop = await executeCall(call, messages, callContext)
        if (!stop) {
          continue
        }
        // 判定原地打转：本步剩下的调用不再执行，但必须补结果，
        // 否则历史里这条 assistant 消息的 tool_calls 会有去无回
        for (const rest of toolCalls.slice(index + 1)) {
          await recordSkippedCall(rest, messages, callContext)
        }
        stoppedByGuard = true
        break
      }
      await sessions.record(request.cwd, request.sessionId, [
        {
          type: 'step/end',
          // usage 随日志保存：重开会话时直接展示最后一次真实计数
          data: { turn, step, ...(stepUsage ? { usage: stepUsage } : {}) }
        }
      ])

      if (stoppedByGuard) {
        reason = 'error'
        break
      }
      if (toolCalls.length === 0) {
        break
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
      await sessions.record(request.cwd, request.sessionId, [
        { type: 'turn/end', data: { turn, reason } }
      ])
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
  const history = await sessions.history(request.cwd, request.sessionId)
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

/** 工具执行与结果回灌共用的上下文 */
interface CallContext {
  fs: FileSystemService
  observation: ObservationStore
  registry: ToolRegistry
  request: AiSendRequest
  sessions: SessionStore
  turn: number
  step: number
  emit: (event: AiEvent) => void
  signal: AbortSignal
  /** 跨步骤累计的重复调用守卫 */
  guard: RepeatCallGuard
}

/**
 * 执行一次工具调用，把结果落盘后作为 tool 消息回灌给模型。
 * @returns 是否因重复调用守卫叫停而中止本轮
 */
async function executeCall(
  call: ChatToolCall,
  messages: ChatMessage[],
  context: CallContext
): Promise<boolean> {
  const { fs, observation, registry, request, signal, guard } = context
  emitToolCall(call, context)

  const action = guard.observe(call.function.name, call.function.arguments)
  if (action.kind === 'stop') {
    // 不再执行这次调用：用失败结果收尾，日志与消息序列才能保持自洽
    context.emit({ type: 'error', message: action.text })
    await writeToolResult(call, { ok: false, text: action.text }, messages, context)
    return true
  }

  const result = await registry.execute(call.function.name, call.function.arguments, {
    fs,
    cwd: request.cwd,
    sessionId: request.sessionId,
    observation,
    signal
  })
  await writeToolResult(call, result, messages, context)

  // 提醒紧跟在工具结果之后：模型下一步就能看到；不进日志，历史重放时自然消失
  if (action.kind === 'remind') {
    messages.push({ role: 'user', content: action.text })
  }
  return false
}

/** 通知界面出现一张挂起卡片；参数解析失败时给空对象，真正的错误交给注册表回报 */
function emitToolCall(call: ChatToolCall, context: CallContext): void {
  const args = safeParseArguments(call.function.arguments)
  const card = context.registry.get(call.function.name)?.presentCall?.(args)
  context.emit({
    type: 'tool-call',
    callId: call.id,
    name: call.function.name,
    args,
    ...(card ? { card } : {})
  })
}

/**
 * 因守卫叫停而不再执行的调用也要走一遍结果回灌：
 * 界面上的挂起卡片要收尾，日志里每个 tool_call 也必须有对应的 tool/result。
 */
async function recordSkippedCall(
  call: ChatToolCall,
  messages: ChatMessage[],
  context: CallContext
): Promise<void> {
  emitToolCall(call, context)
  await writeToolResult(
    call,
    { ok: false, text: '因检测到重复调用，本次调用未执行' },
    messages,
    context
  )
}

/** 把一次调用的结果推给界面、写入日志并回灌模型 */
async function writeToolResult(
  call: ChatToolCall,
  result: ToolExecutionResult,
  messages: ChatMessage[],
  context: CallContext
): Promise<void> {
  const { request, sessions, turn, step, emit } = context
  emit({
    type: 'tool-result',
    callId: call.id,
    ok: result.ok,
    text: result.text,
    ...(result.card ? { card: result.card } : {})
  })
  // 写工具落盘后通知界面：文件树与已打开的编辑器需要跟着变
  if (result.changedPaths && result.changedPaths.length > 0) {
    emit({ type: 'file-changed', paths: result.changedPaths })
  }
  await sessions.record(request.cwd, request.sessionId, [
    {
      type: 'tool/result',
      data: {
        turn,
        step,
        callId: call.id,
        name: call.function.name,
        ok: result.ok,
        text: result.text,
        // 卡片随日志保存，历史重放才能与实时看到的一致
        ...(result.card ? { card: result.card } : {})
      }
    }
  ])
  messages.push({ role: 'tool', tool_call_id: call.id, content: result.text })
}

/**
 * 用模型润色会话标题。
 * 与 deepseek-harness 的 first-prompt provider 一致：只在首轮跑一次，
 * 用户已手工改名（autoTitle=false）时不覆盖，失败保留默认标题。
 */
async function refineTitle(
  request: AiSendRequest,
  model: OpenAiConfig,
  sessions: SessionStore,
  emit: (event: AiEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const title = await generateTitle(model, request.prompt, signal)
  if (title === null) {
    return
  }
  try {
    const applied = await sessions.updateAutoTitle(request.cwd, request.sessionId, title)
    if (applied) {
      emit({ type: 'session-title', title })
    }
  } catch (error) {
    console.warn('保存会话标题失败', error)
  }
}

/**
 * 步数预算用尽时注入的续接指令。
 * 只进内存消息序列、不落盘：它描述的是“同一轮对话继续干”，不是用户新说的话。
 */
function continuePrompt(round: number, settings: AiRuntimeSettings): string {
  return (
    '<auto_continue>\n' +
    `上一段工作已用满 ${settings.maxSteps} 步预算。继续推进同一个任务（第 ${round}/${settings.maxRounds} 段）：\n` +
    '1. 先核对工作区当前状态，不要假设之前的改动已经生效；\n' +
    '2. 从上次中断的地方接着做，不要重复已经完成的工作；\n' +
    '3. 任务全部完成时直接给出最终结论。\n' +
    '</auto_continue>'
  )
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
