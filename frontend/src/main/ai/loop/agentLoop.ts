import type { AiRuntimeSettings } from '../../../shared/ai/settings'
import type { AiEvent, AiSendRequest, AiTurnEndReason } from '../../../shared/ai/types'
import type { ObservationStore } from '../fs/observation'
import type { FileSystemService } from '../fs/service'
import { toContextUsage } from '../context'
import type { ChatMessage, ChatToolCall, OpenAiConfig, StreamDelta } from '../llm/openai'
import { streamChat, toOpenAiTools } from '../llm/openai'
import { buildSystemPrompt } from '../prompt'
import { toAttachmentBlocks } from '../session/attachments'
import type { SessionStore } from '../session/store'
import { generateTitle } from '../session/title'
import type { SessionBlock } from '../session/types'
import { modelTextOf } from '../session/view'
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
  // 附件在落盘前整理成内容块：只有选中行带文本，文件/目录只记录路径与类型
  const attachments = await toAttachmentBlocks(fs, request.attachments)
  const messages = await initialMessages(sessions, request, attachments)
  const tools = toOpenAiTools(registry.list())
  let reason: AiTurnEndReason = 'done'

  // 首轮异步润色标题：与主回复并行，不阻塞也不影响结果；失败保留默认标题
  if (turn === 1) {
    void refineTitle(request, model, sessions, emit, signal)
  }

  emit({ type: 'turn-start', sessionId: request.sessionId })
  await sessions.record(request.cwd, request.sessionId, [
    { type: 'turn/start', data: { turn, cwd: request.cwd, modelConfigId: request.modelConfigId } },
    {
      type: 'user/message',
      data: { content: [{ type: 'text', text: request.prompt }, ...attachments] }
    }
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

      const pending = new Map<number, PendingCall>()
      /** 已经发过「准备中」行的调用（按流式 index）：只发一次，不随参数分片重复 */
      const prepared = new Set<number>()
      /** 本步已经流出的文本：中止时要作为「中断前缀」落盘 */
      let text = ''
      /** assistant 消息是否已经落盘（中止结算据此决定要不要补记前缀） */
      let messageRecorded = false
      /** 本步模型请求的工具调用；只有流正常读完后才有值 */
      let toolCalls: ChatToolCall[] = []
      /** 已经写好结果的 callId：中止时用来补齐剩下的调用 */
      const answered = new Set<string>()
      /** 已经发过挂起卡片的 callId：中止时补结果才不会重复建卡片 */
      const cardShown = new Set<string>()
      /** 本步模型调用返回的真实用量；供应商未返回时保持 undefined */
      let stepUsage: StreamDelta['usage']

      try {
        for await (const delta of streamChat(model, messages, tools, signal)) {
          // 每个 chunk 都自己判一次中止：不依赖适配器有没有把 signal 真正传到连接上，
          // 用户点停止后最多再丢这一帧，不会继续把内容推到界面上
          signal.throwIfAborted()
          text += appendDelta(delta, pending, prepared, emit)
          if (delta.usage) {
            stepUsage = delta.usage
          }
        }
        signal.throwIfAborted()
        toolCalls = finishCalls(pending)

        // 只推真实用量：拿到 usage 后立刻更新面板，没拿到就保持上一次的值
        if (stepUsage) {
          emit({ type: 'context-usage', usage: toContextUsage(stepUsage, model.contextWindow) })
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
          messageRecorded = true
        }

        // 工具执行属于本步，step/end 要等它们全部回报之后再写
        let stoppedByGuard = false
        for (const [index, call] of toolCalls.entries()) {
          signal.throwIfAborted()
          cardShown.add(call.id)
          const stop = await executeCall(call, messages, callContext)
          answered.add(call.id)
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
      } catch (error) {
        if (!signal.aborted) {
          throw error
        }
        // 用户中止：先把这一步结算成日志自洽的状态，再把中止继续向外传播
        await settleAbortedStep({
          text,
          messageRecorded,
          stepUsage,
          toolCalls,
          answered,
          cardShown,
          messages,
          context: callContext
        })
        throw error
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
 * @param attachments 本轮新附加文件的内容块（历史里的附件已由重放展开）
 */
async function initialMessages(
  sessions: SessionStore,
  request: AiSendRequest,
  attachments: readonly SessionBlock[]
): Promise<ChatMessage[]> {
  const history = await sessions.history(request.cwd, request.sessionId)
  const systemMessage: ChatMessage = { role: 'system', content: buildSystemPrompt(request.cwd) }
  const userMessage: ChatMessage = {
    role: 'user',
    content: modelTextOf([{ type: 'text', text: request.prompt }, ...attachments])
  }
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
 * 一旦某个调用已经知道 id 与名字，就先推一条「准备中」事件：
 * 参数往往要流好一会儿（write 的整份文件内容），界面能提前看到即将执行哪个工具。
 * 真正的 tool-call 事件在流读完后发出，按同一 callId 把这个行升级为执行中。
 * @returns 本帧新增的文本（无文本时为空串）
 */
function appendDelta(
  delta: StreamDelta,
  pending: Map<number, PendingCall>,
  prepared: Set<number>,
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
    // id 与名字可能不同帧到达：两条都齐了再发，且每个 index 只发一次
    if (!prepared.has(part.index) && current.id.length > 0 && current.name.length > 0) {
      prepared.add(part.index)
      emit({ type: 'tool-preparing', callId: current.id, name: current.name })
    }
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

/** 被用户中止打断的调用，用这条结果收尾（工具本身没有跑完，不能报成功） */
const CANCELED_CALL_TEXT = '用户中止了这一轮对话，本次调用未完成'

/**
 * 中止结算：把被中止打断的那一步补成日志自洽、界面也解释得通的状态。
 *
 * 规则与 deepseek-harness 保持一致：
 * - 已经流出的文本保留，记成一条 interrupted 的助手消息——用户屏幕上看到的就是它；
 * - 流没读完就中断时，这一帧里还没发出去的工具调用一律丢弃：
 *   中断发生在派发之前，保留一个 tool_call 就必须附带一条伪造的结果；
 * - 已经落盘的调用用「已取消」收尾，否则历史里会留下有去无回的 tool_calls，
 *   下一次请求会因为工具结果缺失而直接失败；
 * - step/end 一定要写，不能留下只有 step/start 的悬空步骤。
 * @param options 中止那一刻这一步的全部状态
 */
async function settleAbortedStep(options: {
  text: string
  messageRecorded: boolean
  stepUsage: StreamDelta['usage']
  toolCalls: readonly ChatToolCall[]
  answered: ReadonlySet<string>
  cardShown: ReadonlySet<string>
  messages: ChatMessage[]
  context: CallContext
}): Promise<void> {
  const { text, messageRecorded, stepUsage, toolCalls, answered, cardShown, messages, context } =
    options
  const { request, sessions, turn, step, emit } = context
  try {
    if (text.length > 0 && !messageRecorded) {
      await sessions.record(request.cwd, request.sessionId, [
        {
          type: 'assistant/message',
          data: { turn, step, content: [{ type: 'text', text }], interrupted: true }
        }
      ])
    }
    for (const call of messageRecorded ? toolCalls : []) {
      if (answered.has(call.id)) {
        continue
      }
      // 还没轮到执行的调用在界面上没有卡片，先补一张再收尾
      if (!cardShown.has(call.id)) {
        emitToolCall(call, context)
      }
      await writeToolResult(call, { ok: false, text: CANCELED_CALL_TEXT }, messages, context, true)
    }
    await sessions.record(request.cwd, request.sessionId, [
      {
        type: 'step/end',
        data: { turn, step, ...(stepUsage ? { usage: stepUsage } : {}) }
      }
    ])
  } catch (error) {
    // 结算失败不能吞掉中止本身：先让界面看到错误，再继续向外传播
    emit({ type: 'error', message: errorMessage(error) })
  }
}

/**
 * 把一次调用的结果推给界面、写入日志并回灌模型。
 * @param stopped 用户中止导致的收尾结果：界面展示为「已停止」而不是失败
 */
async function writeToolResult(
  call: ChatToolCall,
  result: ToolExecutionResult,
  messages: ChatMessage[],
  context: CallContext,
  stopped = false
): Promise<void> {
  const { request, sessions, turn, step, emit } = context
  emit({
    type: 'tool-result',
    callId: call.id,
    ok: result.ok,
    text: result.text,
    ...(stopped ? { stopped: true as const } : {}),
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
        ...(stopped ? { stopped: true as const } : {}),
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
