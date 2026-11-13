/**
 * 会话仓库：把一条条事件追加到 JSONL 日志，再从日志重放出对话历史。
 *
 * 设计要点（与 deepseek-harness 一致的部分）：
 * - 会话按项目隔离：userData/sessions/--<项目路径>--/<会话id>.jsonl；
 * - 日志是唯一真相，发给模型的 ChatMessage 是派生结果，换 provider 不用改存储；
 * - 只追加不覆盖，工具执行到一半崩溃也不会丢掉已经发生的内容；
 * - seq 由仓库分配并严格连续，读取时校验。
 *
 * 与 harness 刻意不同的部分：没有格式代际迁移、没有跨进程写锁、
 * 没有流式 chunk 时间线——本项目单进程、单写者，这些留到需要时再加。
 */
import { join } from 'path'
import type { AiSessionSummary } from '../../../shared/ai/types'
import type { ChatMessage, ChatToolCall } from '../llm/openai'
import {
  appendSessionLog,
  createSessionLog,
  exportSessionLog,
  listProjectLogs,
  readSessionLog,
  removeSessionLog,
  sessionLogExists,
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
import { modelTextOf, textOf } from './view'

/** 新建会话的默认标题（首轮由模型润色，用户也可手动改名） */
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
 *
 * 每个方法都要求显式传入 cwd：会话属于具体项目，
 * 关闭项目后列表里就查不到它的会话，重新打开同一项目才会再次出现。
 */
export class SessionStore {
  /** 会话键（cwd + id）→ 写入链；前一个任务失败也继续执行后一个 */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** 会话键 → 写路径需要的轻量状态 */
  private readonly states = new Map<string, SessionState>()

  /**
   * @param resolveRoot 会话根目录解析器；延迟到首次使用才求值，
   *   避免模块加载期就依赖 Electron 的 app 是否可用
   */
  constructor(private readonly resolveRoot: () => string) {}

  /**
   * 确保会话日志存在并返回其状态。
   * 文件不存在时新建并写入会话头与初始标题；已存在时按磁盘内容恢复状态。
   * @param cwd 会话所属项目根目录
   * @param id 会话 id
   * @param title 新建时使用的初始标题
   * @param autoTitle 初始标题是否仍由自动流程管理（默认名）
   */
  async ensure(
    cwd: string,
    id: string,
    title: string = DEFAULT_TITLE,
    autoTitle = true
  ): Promise<SessionState> {
    const key = refKey(cwd, id)
    const cached = this.states.get(key)
    if (cached) {
      return cached
    }
    return this.enqueue(key, async () => {
      // 队列内再查一次：并发 ensure 只有第一个真正读盘
      const raced = this.states.get(key)
      if (raced) {
        return raced
      }
      const path = sessionLogPath(this.resolveRoot(), cwd, id)
      const existing = await readSessionLog(path)
      if (existing) {
        // 上次崩溃留下的半行必须先截掉，否则下一次追写会把它夹成“中间行损坏”
        if (existing.discarded > 0) {
          await truncateTornTail(path)
        }
        const state = toState(existing, title, autoTitle)
        this.states.set(key, state)
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
      this.states.set(key, state)
      return state
    })
  }

  /**
   * 追加一批事件（seq 与时间戳由仓库分配）。
   * 调用方按对话顺序传入，整批一次落盘。
   * @param cwd 会话所属项目根目录
   * @param id 会话 id
   * @param inputs 待写入的事件
   */
  async record(cwd: string, id: string, inputs: readonly SessionEventInput[]): Promise<void> {
    if (inputs.length === 0) {
      return
    }
    await this.ensure(cwd, id)
    const key = refKey(cwd, id)
    await this.enqueue(key, async () => {
      const state = this.states.get(key)
      if (!state) {
        throw new Error(`会话 ${id} 尚未初始化`)
      }
      const now = Date.now()
      const events = inputs.map((input, offset) => toEvent(input, state.lastSeq + offset + 1, now))
      await appendSessionLog(sessionLogPath(this.resolveRoot(), cwd, id), events)
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
   * @param cwd 会话所属项目根目录
   * @param id 会话 id
   */
  async history(cwd: string, id: string): Promise<ChatMessage[]> {
    const content = await readSessionLog(sessionLogPath(this.resolveRoot(), cwd, id))
    return content ? replay(content.events) : []
  }

  /**
   * 读取会话的全部事件（展示层整理用）。
   * 文件不存在时返回空数组，供“新建后尚未落盘”的会话直接展示空列表。
   * @param cwd 会话所属项目根目录
   * @param id 会话 id
   */
  async events(cwd: string, id: string): Promise<SessionEvent[]> {
    const content = await readSessionLog(sessionLogPath(this.resolveRoot(), cwd, id))
    return content ? content.events : []
  }

  /**
   * 列出某个项目下的会话摘要（按最后活动时间倒序）。
   * 目录不存在（该项目还没有会话）时返回空数组；
   * 损坏的单个文件跳过而不是让整个列表失败。
   * @param cwd 项目根目录
   */
  async list(cwd: string): Promise<AiSessionSummary[]> {
    const logs = await listProjectLogs(this.resolveRoot(), cwd)
    const summaries: AiSessionSummary[] = []
    for (const log of logs) {
      const content = await this.readQuietly(log.path)
      if (content) {
        summaries.push(toSummary(content))
      }
    }
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * 在驱动新一轮之前闭合上次遗留的未结束轮次。
   * 进程被强杀时最后一条 turn/end 没有写进去，补一条 interrupted 让日志自洽。
   * @param cwd 会话所属项目根目录
   * @param id 会话 id
   */
  async settle(cwd: string, id: string): Promise<void> {
    // 先 ensure：它会在首次加载时截掉崩溃留下的半行，后续追加才不会夹在中间
    await this.ensure(cwd, id)
    const content = await readSessionLog(sessionLogPath(this.resolveRoot(), cwd, id))
    if (!content) {
      return
    }
    const open = findOpenTurn(content.events)
    if (open === null) {
      return
    }
    await this.record(cwd, id, [{ type: 'turn/end', data: { turn: open, reason: 'interrupted' } }])
  }

  /**
   * 更新会话标题（追加一条 session/title 事件，而不是改写文件开头）。
   * @param cwd 会话所属项目根目录
   * @param id 会话 id
   * @param title 新标题
   * @param autoTitle 是否仍为自动生成的标题（模型润色）
   */
  async updateTitle(cwd: string, id: string, title: string, autoTitle: boolean): Promise<void> {
    await this.ensure(cwd, id, title, autoTitle)
    await this.record(cwd, id, [{ type: 'session/title', data: { title, auto: autoTitle } }])
    const state = this.states.get(refKey(cwd, id))
    if (state) {
      state.title = title
      state.autoTitle = autoTitle
    }
  }

  /**
   * 用自动生成的标题覆盖当前标题。
   * 用户已经手工重命名（autoTitle 为 false）时不再覆盖——重命名即“钉住”，
   * 之后只有用户自己改才能变。
   * @returns 是否真的写入
   */
  async updateAutoTitle(cwd: string, id: string, title: string): Promise<boolean> {
    const state = await this.ensure(cwd, id)
    if (!state.autoTitle) {
      return false
    }
    await this.updateTitle(cwd, id, title, true)
    return true
  }

  /**
   * 删除一个会话的全部日志，并清掉进程内状态。
   * 排到该会话写入链末尾：先让进行中的写完成再删，
   * 避免删到一半又被追加、或删完立刻被重建。
   * @param cwd 会话所属项目根目录
   * @param id 会话 id
   */
  async remove(cwd: string, id: string): Promise<void> {
    const key = refKey(cwd, id)
    try {
      await this.enqueue(key, async () => {
        await removeSessionLog(sessionLogPath(this.resolveRoot(), cwd, id))
        this.states.delete(key)
      })
    } finally {
      // 会话已经不存在，写入链也一并清掉
      this.chains.delete(key)
    }
  }

  /**
   * 会话日志是否已落盘。
   * 新建后还没发过消息的会话只存在于内存，没有可导出的文件。
   * @param cwd 会话所属项目根目录
   * @param id 会话 id
   */
  async exists(cwd: string, id: string): Promise<boolean> {
    const key = refKey(cwd, id)
    return this.enqueue(key, () => sessionLogExists(sessionLogPath(this.resolveRoot(), cwd, id)))
  }

  /**
   * 导出会话日志到指定目录。
   * 排到该会话写入链末尾：先让进行中的追加落盘，复制到的一定是完整文件。
   * @param cwd 会话所属项目根目录
   * @param id 会话 id
   * @param targetDir 导出目录（由系统目录选择框返回的绝对路径）
   * @returns 导出后的文件绝对路径
   */
  async exportTo(cwd: string, id: string, targetDir: string): Promise<string> {
    const key = refKey(cwd, id)
    return this.enqueue(key, async () => {
      const target = join(targetDir, `${id}.jsonl`)
      await exportSessionLog(sessionLogPath(this.resolveRoot(), cwd, id), target)
      return target
    })
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
  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    // 链上只保留“是否已完成”，避免把业务异常传播给下一个任务
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }
}

/** 同一 id 在不同项目下是两个会话，缓存与写入链都要按 (cwd, id) 区分 */
function refKey(cwd: string, id: string): string {
  return `${cwd}\u0000${id}`
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
 *
 * 工具调用与结果必须成对出现在历史里：用户中止或被强杀可能在两者之间留下缺口，
 * 把缺口原样喂给模型会得到 “tool_calls must be followed by tool messages” 的 400，
 * 整个会话从此发不出消息。因此这里以 assistant 消息为组，消费它后面的工具结果，
 * 没有结果的调用、没有调用的结果都丢弃——历史因此永远是可发送的形状。
 * @param events 按 seq 排好的事件
 */
function replay(events: readonly SessionEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    switch (event.type) {
      case 'user/message': {
        messages.push({ role: 'user', content: modelTextOf(event.data.content) })
        break
      }
      case 'assistant/message': {
        const text = textOf(event.data.content)
        const calls = toolCallsOf(event.data.content)
        // 这条消息之后、下一条消息之前的工具结果；中间允许夹着 step/turn 与标题事件
        const results = new Map<string, string>()
        let next = index + 1
        while (
          next < events.length &&
          events[next].type !== 'user/message' &&
          events[next].type !== 'assistant/message'
        ) {
          const candidate = events[next]
          if (candidate.type === 'tool/result') {
            results.set(candidate.data.callId, candidate.data.text)
          }
          next += 1
        }
        index = next - 1
        const answered = calls.filter((call) => results.has(call.id))
        if (text.length === 0 && answered.length === 0) {
          // 空响应（模型这一轮什么也没说）不进上下文
          break
        }
        messages.push({
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(answered.length > 0 ? { tool_calls: answered } : {})
        })
        for (const call of answered) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: results.get(call.id) ?? ''
          })
        }
        break
      }
      default:
        // 工具结果已在上面随其 assistant 消息成组消费；没有前导调用的孤立结果直接丢弃
        break
    }
  }
  return messages
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
