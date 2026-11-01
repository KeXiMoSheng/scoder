/**
 * 会话仓库：把一条条事件追加到 JSONL 日志，再从日志重放出对话历史。
 *
 * 设计要点（与 deepseek-harness 一致的部分）：
 * - 日志是唯一真相，发给模型的 ChatMessage 是派生结果，换 provider 不用改存储；
 * - 只追加不覆盖，工具执行到一半崩溃也不会丢掉已经发生的内容；
 * - seq 由仓库分配并严格连续，读取时校验。
 *
 * 与 harness 刻意不同的部分：没有格式代际迁移、没有跨进程写锁、
 * 没有流式 chunk 时间线——本项目单进程、单写者，这些留到需要时再加。
 */
import { readdir } from 'fs/promises'
import { join } from 'path'
import type { AiSessionSummary } from '../../../shared/ai/types'
import type { ChatMessage, ChatToolCall } from '../llm/openai'
import {
  appendSessionLog,
  createSessionLog,
  readSessionLog,
  sessionLogPath,
  truncateTornTail
} from './jsonl'
import {
  SESSION_LOG_VERSION,
  type SessionBlock,
  type SessionEvent,
  type SessionEventInput,
  type SessionLogContent
} from './types'

/** 新建会话的默认标题（渲染进程会再用首条消息覆盖） */
export const DEFAULT_TITLE = '新会话'

/** 会话的进程内状态：只存写路径需要的计数，事件本身不常驻内存 */
export interface SessionState {
  readonly createdAt: number
  /** 已写入的最后一条事件的 seq（-1 表示只有会话头） */
  lastSeq: number
  /** 已开始的轮次数量，下一轮编号 = turnCount + 1 */
  turnCount: number
  title: string
  autoTitle: boolean
}

/**
 * JSONL 会话仓库。
 * 所有写操作按会话串行（见 enqueue），保证同一文件里的行不会交错；
 * 读操作直接读盘，因此另一个进程追加的内容也能被看到。
 */
export class SessionStore {
  /** 会话 id → 写入链；前一个任务失败也继续执行后一个 */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** 会话 id → 写路径需要的轻量状态 */
  private readonly states = new Map<string, SessionState>()

  /**
   * @param resolveRoot 会话目录解析器；延迟到首次使用才求值，
   *   避免模块加载期就依赖 Electron 的 app 是否可用
   */
  constructor(private readonly resolveRoot: () => string) {}

  /**
   * 确保会话日志存在并返回其状态。
   * 文件不存在时新建并写入会话头与初始标题；已存在时按磁盘内容恢复状态。
   * @param id 会话 id
   * @param title 新建时使用的初始标题
   * @param autoTitle 初始标题是否仍为自动生成的摘要
   */
  async ensure(id: string, title: string = DEFAULT_TITLE, autoTitle = true): Promise<SessionState> {
    const cached = this.states.get(id)
    if (cached) {
      return cached
    }
    return this.enqueue(id, async () => {
      // 队列内再查一次：并发 ensure 只有第一个真正读盘
      const raced = this.states.get(id)
      if (raced) {
        return raced
      }
      const path = sessionLogPath(this.resolveRoot(), id)
      const existing = await readSessionLog(path)
      if (existing) {
        // 上次崩溃留下的半行必须先截掉，否则下一次追写会把它夹成“中间行损坏”
        if (existing.discarded > 0) {
          await truncateTornTail(path)
        }
        const state = toState(existing, title, autoTitle)
        this.states.set(id, state)
        return state
      }
      const createdAt = Date.now()
      await createSessionLog(path, { type: 'session', version: SESSION_LOG_VERSION, id, createdAt })
      const titleEvent = toEvent(
        { type: 'session/title', data: { title, auto: autoTitle } },
        0,
        createdAt
      )
      await appendSessionLog(path, [titleEvent])
      const state: SessionState = {
        createdAt,
        lastSeq: 0,
        turnCount: 0,
        title,
        autoTitle
      }
      this.states.set(id, state)
      return state
    })
  }

  /**
   * 追加一批事件（seq 与时间戳由仓库分配）。
   * 调用方按对话顺序传入，整批一次落盘。
   * @param id 会话 id
   * @param inputs 待写入的事件
   */
  async record(id: string, inputs: readonly SessionEventInput[]): Promise<void> {
    if (inputs.length === 0) {
      return
    }
    await this.ensure(id)
    await this.enqueue(id, async () => {
      const state = this.states.get(id)
      if (!state) {
        throw new Error(`会话 ${id} 尚未初始化`)
      }
      const now = Date.now()
      const events = inputs.map((input, offset) => toEvent(input, state.lastSeq + offset + 1, now))
      await appendSessionLog(sessionLogPath(this.resolveRoot(), id), events)
      state.lastSeq = events[events.length - 1].seq
      for (const event of events) {
        if (event.type === 'turn/start') {
          state.turnCount += 1
        }
      }
    })
  }

  /**
   * 重放会话历史，得到可直接发给模型的 ChatMessage 数组。
   * 不含系统提示：它每轮由 buildSystemPrompt 现算，避免改了提示词却读回旧文案。
   * @param id 会话 id
   */
  async history(id: string): Promise<ChatMessage[]> {
    const content = await readSessionLog(sessionLogPath(this.resolveRoot(), id))
    return content ? replay(content.events) : []
  }

  /**
   * 列出全部会话摘要（按最后活动时间倒序）。
   * 逐个文件读取：会话数量是几十级，目录扫描的整体耗时远小于一次模型调用。
   * 损坏的单个文件跳过而不是让整个列表失败。
   * @returns 会话摘要列表
   */
  async list(): Promise<AiSessionSummary[]> {
    const root = this.resolveRoot()
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }

    const summaries: AiSessionSummary[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) {
        continue
      }
      const content = await this.readQuietly(join(root, entry))
      if (!content) {
        continue
      }
      summaries.push(toSummary(content))
    }
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * 在驱动新一轮之前闭合上次遗留的未结束轮次。
   * 进程被强杀时最后一条 turn/end 没有写进去，补一条 interrupted 让日志自洽。
   * @param id 会话 id
   */
  async settle(id: string): Promise<void> {
    // 先 ensure：它会在首次加载时截掉崩溃留下的半行，后续追加才不会夹在中间
    await this.ensure(id)
    const content = await readSessionLog(sessionLogPath(this.resolveRoot(), id))
    if (!content) {
      return
    }
    const open = findOpenTurn(content.events)
    if (open === null) {
      return
    }
    await this.record(id, [{ type: 'turn/end', data: { turn: open, reason: 'interrupted' } }])
  }

  /**
   * 更新会话标题（追加一条 session/title 事件，而不是改写文件开头）。
   * @param id 会话 id
   * @param title 新标题
   * @param autoTitle 是否仍为自动生成的摘要标题
   */
  async updateTitle(id: string, title: string, autoTitle: boolean): Promise<void> {
    await this.ensure(id, title, autoTitle)
    await this.record(id, [{ type: 'session/title', data: { title, auto: autoTitle } }])
    const state = this.states.get(id)
    if (state) {
      state.title = title
      state.autoTitle = autoTitle
    }
  }

  /** 读取日志；损坏或缺失时返回 null（列表场景下不因单个文件失败） */
  private async readQuietly(path: string): Promise<SessionLogContent | null> {
    try {
      return await readSessionLog(path)
    } catch (error) {
      console.warn(`跳过无法读取的会话日志：${path}`, error)
      return null
    }
  }

  /** 把任务排到该会话写入链的末尾，等待前一个任务结束（无论成败） */
  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve()
    const next = previous.then(task, task)
    // 链上只保留“是否已完成”，避免把业务异常传播给下一个任务
    this.chains.set(
      id,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }
}

/** 由磁盘内容恢复写路径状态 */
function toState(
  content: SessionLogContent,
  fallbackTitle: string,
  fallbackAutoTitle: boolean
): SessionState {
  const title = lastTitle(content.events)
  return {
    createdAt: content.header.createdAt,
    lastSeq: content.events.length - 1,
    turnCount: content.events.filter((event) => event.type === 'turn/start').length,
    title: title?.title ?? fallbackTitle,
    autoTitle: title?.auto ?? fallbackAutoTitle
  }
}

/** 由磁盘内容生成列表项；updatedAt 取最后一条事件的时间 */
function toSummary(content: SessionLogContent): AiSessionSummary {
  const title = lastTitle(content.events)
  const lastEvent = content.events[content.events.length - 1]
  return {
    id: content.header.id,
    title: title?.title ?? DEFAULT_TITLE,
    autoTitle: title?.auto ?? true,
    createdAt: content.header.createdAt,
    updatedAt: lastEvent?.time ?? content.header.createdAt
  }
}

/** 取最后一条标题事件：标题可变，但始终以追加方式表达 */
function lastTitle(events: readonly SessionEvent[]): { title: string; auto: boolean } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'session/title') {
      return event.data
    }
  }
  return null
}

/** 找出已开始但未结束的轮次编号（取最大的一个） */
function findOpenTurn(events: readonly SessionEvent[]): number | null {
  const open = new Set<number>()
  for (const event of events) {
    if (event.type === 'turn/start') {
      open.add(event.data.turn)
    } else if (event.type === 'turn/end') {
      open.delete(event.data.turn)
    }
  }
  if (open.size === 0) {
    return null
  }
  return Math.max(...open)
}

/**
 * 把事件序列重放成 ChatMessage 数组。
 * 只认消息类事件，边界事件（turn/step）与标题事件不进入上下文。
 * @param events 按 seq 排好的事件
 */
function replay(events: readonly SessionEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        messages.push({ role: 'user', content: textOf(event.data.content) })
        break
      }
      case 'assistant/message': {
        const text = textOf(event.data.content)
        const toolCalls = toolCallsOf(event.data.content)
        if (text.length === 0 && toolCalls.length === 0) {
          // 空响应（模型这一轮什么也没说）不进上下文
          break
        }
        messages.push({
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        })
        break
      }
      case 'tool/result': {
        messages.push({
          role: 'tool',
          tool_call_id: event.data.callId,
          content: event.data.text
        })
        break
      }
      default:
        break
    }
  }
  return messages
}

/** 拼接内容块里的全部文本 */
function textOf(blocks: readonly SessionBlock[]): string {
  return blocks
    .filter((block): block is Extract<SessionBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** 取出内容块里的工具调用，展开成 OpenAI 的 tool_calls 形状 */
function toolCallsOf(blocks: readonly SessionBlock[]): ChatToolCall[] {
  return blocks
    .filter(
      (block): block is Extract<SessionBlock, { type: 'tool-call' }> => block.type === 'tool-call'
    )
    .map((block) => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments }
    }))
}

/**
 * 把待写事件补上 seq 与时间。
 * inputs 本身已经是按 type 判别的合法联合，这里只是把外层信封补齐；
 * 映射后 TS 无法自行收敛，故断言为 SessionEvent（数据未做任何改写）。
 */
function toEvent(input: SessionEventInput, seq: number, time: number): SessionEvent {
  return { type: input.type, seq, time, data: input.data } as SessionEvent
}
