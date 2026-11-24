import type { AiQuestion, AiQuestionAnswer } from '../../../shared/ai/types'

/** 挂起等待回答的请求：一次工具调用对应一条 */
interface PendingQuestion {
  readonly questions: readonly AiQuestion[]
  readonly resolve: (answers: AiQuestionAnswer[]) => void
  readonly reject: (error: Error) => void
  /** 摘掉中止监听：问题已经结算，信号不该再改变它的结果 */
  readonly cleanup: () => void
}

/** 一次作答里每个问题允许的最大字符数：自由输入可能很长，这里只做异常保护 */
const MAX_CUSTOM_CHARS = 8_000

/**
 * 待回答问题的协调器：模型侧的 ask_user_question 在这里挂起，
 * 渲染进程通过 IPC 提交答案后继续，工具结果再照常回灌给模型。
 *
 * 与 deepseek-harness 的 ctx.userQuestions 同构：工具只声明问题与校验参数，
 * 等待、作答与中止统一由主进程服务管理。因为工具串行执行，同一会话同一时刻
 * 只会有一条挂起的询问；键里仍然带 callId，重放与并发会话都不会串。
 */
export class QuestionBroker {
  private readonly pending = new Map<string, PendingQuestion>()

  /**
   * 挂起一次询问，直到用户作答、本轮被中止或会话结束。
   * @param input 会话、工具调用、问题列表与中止信号
   * @returns 用户提交的答案，顺序与问题一致
   * @throws Error 同一调用已经挂起，或调用时本轮已中止
   */
  ask(input: {
    sessionId: string
    callId: string
    questions: readonly AiQuestion[]
    signal: AbortSignal
  }): Promise<AiQuestionAnswer[]> {
    const key = questionKey(input.sessionId, input.callId)
    if (this.pending.has(key)) {
      return Promise.reject(new Error('这次询问已经在等待回答，不能重复挂起'))
    }
    if (input.signal.aborted) {
      return Promise.reject(abortedError())
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.settle(key, abortedError())
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(key, {
        questions: input.questions,
        resolve,
        reject,
        cleanup: () => input.signal.removeEventListener('abort', onAbort)
      })
    })
  }

  /**
   * 提交一次询问的答案。渲染进程传来的内容按不可信处理：问题必须逐个回答，
   * 选项标签必须来自模型给出的选项，自由输入不能为空答案。
   * @param sessionId 会话 id
   * @param callId 工具调用 id
   * @param raw 渲染进程传来的答案数组
   * @throws Error 没有挂起的询问，或答案不合法；抛错时询问继续等待
   */
  answer(sessionId: string, callId: string, raw: unknown): void {
    const key = questionKey(sessionId, callId)
    const entry = this.pending.get(key)
    if (entry === undefined) {
      throw new Error('这个问题已经结束，无法再回答')
    }
    const answers = normalizeAnswers(entry.questions, raw)
    this.pending.delete(key)
    entry.cleanup()
    entry.resolve(answers)
  }

  /**
   * 本轮结束时兜底：仍未回答的问题按中止收尾，
   * 避免工具 Promise 永远悬着（正常流程里工具结算后这里已经没有条目）。
   * @param sessionId 会话 id
   */
  closeSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith(prefix)) {
        this.settle(key, new Error('本轮对话已结束，问题未得到回答'))
      }
    }
  }

  /** 当前挂起的问题数（测试与诊断用） */
  get size(): number {
    return this.pending.size
  }

  /**
   * 某个会话当前正在等待回答的工具调用 id。
   * 打开历史会话时用它区分“真的还在等”与本进程已经不在等待的悬空询问：
   * 后者（例如进程崩溃留下的调用）只展示为未回答，不能再接受作答。
   * @param sessionId 会话 id
   */
  pendingCallIds(sessionId: string): string[] {
    const prefix = `${sessionId}\u0000`
    return [...this.pending.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
  }

  /** 以错误结算并清理一条挂起的询问 */
  private settle(key: string, error: Error): void {
    const entry = this.pending.get(key)
    if (entry === undefined) {
      return
    }
    this.pending.delete(key)
    entry.cleanup()
    entry.reject(error)
  }
}

/** 会话 + 调用 id 组成进程内唯一键；空字符不会出现在 id 里 */
function questionKey(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`
}

/** 用户中止本轮对话：工具调用会随本轮一起结算成「已停止」 */
function abortedError(): Error {
  return new Error('用户中止了这一轮对话，问题未得到回答')
}

/**
 * 校验并规范化答案。
 * 规则与工具 schema 一致：每个问题恰好一条答案、id 不重复、
 * 选项标签必须来自该问题的 options；选不到选项时必须有自由输入。
 * @param questions 模型提出的问题（已校验）
 * @param raw 渲染进程传来的答案
 * @returns 按问题顺序排好的答案
 */
export function normalizeAnswers(
  questions: readonly AiQuestion[],
  raw: unknown
): AiQuestionAnswer[] {
  if (!Array.isArray(raw)) {
    throw new Error('答案必须是数组')
  }
  if (raw.length !== questions.length) {
    throw new Error(`答案数量不对：需要 ${questions.length} 条，收到 ${raw.length} 条`)
  }
  const byId = new Map<string, Record<string, unknown>>()
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error('每条答案必须是对象')
    }
    const record = candidate as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) {
      throw new Error('答案缺少问题 id')
    }
    if (byId.has(record.id)) {
      throw new Error(`问题 ${record.id} 有重复答案`)
    }
    byId.set(record.id, record)
  }
  return questions.map((question) => {
    const record = byId.get(question.id)
    if (record === undefined) {
      throw new Error(`问题「${question.question}」还没有回答`)
    }
    if (!Array.isArray(record.selected)) {
      throw new Error(`问题 ${question.id} 的 selected 必须是数组`)
    }
    const offered = new Set((question.options ?? []).map((option) => option.label))
    const selected: string[] = []
    for (const label of record.selected) {
      if (typeof label !== 'string' || !offered.has(label)) {
        throw new Error(`问题 ${question.id} 的选项不在模型给出的范围里`)
      }
      if (!selected.includes(label)) {
        selected.push(label)
      }
    }
    if (question.multiSelect !== true && selected.length > 1) {
      throw new Error(`问题 ${question.id} 是单选，不能同时选多个选项`)
    }
    const customRaw = record.custom
    if (customRaw !== undefined && typeof customRaw !== 'string') {
      throw new Error(`问题 ${question.id} 的自由回答必须是字符串`)
    }
    const custom = typeof customRaw === 'string' ? customRaw.trim() : ''
    if (custom.length > MAX_CUSTOM_CHARS) {
      throw new Error(`问题 ${question.id} 的自由回答过长`)
    }
    if (selected.length === 0 && custom.length === 0) {
      throw new Error(`问题「${question.question}」还没有回答`)
    }
    return {
      id: question.id,
      selected,
      ...(custom.length > 0 ? { custom } : {})
    }
  })
}
