import type {
  AiQuestion,
  AiQuestionAnswer,
  AiQuestionOption,
  ToolCardView
} from '../../../shared/ai/types'
import type { ToolDefinition } from './registry'

/** 一次询问最多包含的问题数：问题太多会让等待与作答都变成负担 */
const MAX_QUESTIONS = 4
/** 每个问题最多给出的选项数：再多就不是选择题，而是一份菜单 */
const MAX_OPTIONS = 6
/** 各字段的长度上限：模型偶发超长文本时给出可执行的修正提示 */
const MAX_ID_CHARS = 64
const MAX_QUESTION_CHARS = 1_000
const MAX_HEADER_CHARS = 100
const MAX_LABEL_CHARS = 120
const MAX_OPTION_DESCRIPTION_CHARS = 300

/**
 * ask_user_question 工具：模型用它在关键信息缺失时提问，本轮暂停等待用户回答。
 *
 * 与 deepseek-harness 的 ask-user 工具同构：模型只声明问题（id、正文、可选标题、
 * 选项与是否多选），挂起与作答交给 Questions 协调器；答案按问题 id 回填成
 * JSON 工具结果，模型据此继续。问题与答案都随工具卡片进入会话日志，
 * 历史重放时无需重新询问。
 */
export function createAskUserTool(): ToolDefinition {
  return {
    name: 'ask_user_question',
    description:
      '当你不确定下一步怎么做时，向用户提问并等待回答：缺少无法从工作区确认的关键信息、' +
      '需要在几个可行方案之间取舍、或即将执行不可逆/影响范围大的操作时使用。' +
      '一次最多问 4 个问题，相关问题放在同一次调用里；每个问题给出 2-4 个具体选项，' +
      '推荐项放第一位并在标签末尾加「（推荐）」；没有选项时用户只能自由输入。' +
      '调用后本轮会暂停，直到用户回答才继续——不要在等待期间假装已经得到答复。' +
      '用户回答后直接按答案执行，不要重复确认已经回答过的问题。' +
      '返回 JSON：answers 按问题顺序给出 id、selected（选中的选项标签）与 custom（用户自己输入的回答）。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: `要在继续之前问用户的问题，最多 ${MAX_QUESTIONS} 个。`,
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: '这个问题在本调用内的稳定 id，回答会原样带回；同一次调用内不能重复。'
              },
              question: {
                type: 'string',
                description: '要问用户的具体问题，用用户能看懂的话写清楚，不要用内部代号。'
              },
              header: {
                type: 'string',
                description: '可选的短标题，如「确认」「选择方案」。'
              },
              options: {
                type: 'array',
                description: '可选的选择项。推荐项放第一位，并在标签末尾加「（推荐）」。',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '选项标签，会原样作为回答返回。' },
                    description: { type: 'string', description: '一句话说明这个选项的取舍或影响。' }
                  },
                  required: ['label'],
                  additionalProperties: false
                }
              },
              multi_select: {
                type: 'boolean',
                description: '是否允许选多个选项，默认只能选一个。'
              }
            },
            required: ['id', 'question'],
            additionalProperties: false
          }
        }
      },
      required: ['questions'],
      additionalProperties: false
    },
    async execute(args, ctx) {
      const questions = toQuestions(args.questions)
      const answers = await ctx.questions.ask({
        sessionId: ctx.sessionId,
        callId: ctx.callId,
        questions,
        signal: ctx.signal
      })
      return { text: JSON.stringify({ answers }) }
    },
    presentCall(args) {
      const questions = questionsOrNull(args.questions)
      if (questions === null) {
        return undefined
      }
      return questionCard(questions)
    },
    presentResult(args, outcome) {
      const questions = questionsOrNull(args.questions)
      if (questions === null) {
        return undefined
      }
      const answers = answersOf(outcome.text)
      return questionCard(questions, answers ?? undefined)
    }
  }
}

/**
 * 校验模型的询问参数。
 * 这里抛出的错误会作为工具结果回灌，模型可以据此改参数重试；
 * 因此每条提示都指出具体是哪个问题、哪一项不对。
 * @param raw 模型给出的 questions 参数
 * @returns 去掉首尾空白的规范问题列表
 */
export function toQuestions(raw: unknown): AiQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('参数 questions 必须是非空数组')
  }
  if (raw.length > MAX_QUESTIONS) {
    throw new Error(`一次最多问 ${MAX_QUESTIONS} 个问题（收到 ${raw.length} 个）`)
  }
  const ids = new Set<string>()
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`第 ${index + 1} 个问题必须是对象`)
    }
    const record = item as Record<string, unknown>
    const id = textOf(record.id)
    if (id.length === 0) {
      throw new Error(`第 ${index + 1} 个问题缺少 id`)
    }
    if (id.length > MAX_ID_CHARS) {
      throw new Error(`第 ${index + 1} 个问题的 id 过长（上限 ${MAX_ID_CHARS} 字符）`)
    }
    if (ids.has(id)) {
      throw new Error(`问题 id 重复：${id}`)
    }
    ids.add(id)
    const question = textOf(record.question)
    if (question.length === 0) {
      throw new Error(`第 ${index + 1} 个问题缺少正文 question`)
    }
    if (question.length > MAX_QUESTION_CHARS) {
      throw new Error(`问题 ${id} 的正文过长（上限 ${MAX_QUESTION_CHARS} 字符）`)
    }
    const header = optionalText(record.header)
    if (header !== undefined && header.length > MAX_HEADER_CHARS) {
      throw new Error(`问题 ${id} 的标题过长（上限 ${MAX_HEADER_CHARS} 字符）`)
    }
    const options = toOptions(record.options, id)
    const multiSelect = record.multi_select
    if (multiSelect !== undefined && typeof multiSelect !== 'boolean') {
      throw new Error(`问题 ${id} 的 multi_select 必须是布尔值`)
    }
    return {
      id,
      question,
      ...(header !== undefined ? { header } : {}),
      ...(options !== undefined ? { options } : {}),
      ...(typeof multiSelect === 'boolean' ? { multiSelect } : {})
    }
  })
}

/** 校验选项列表；没有给出选项时返回 undefined */
function toOptions(raw: unknown, questionId: string): AiQuestionOption[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!Array.isArray(raw)) {
    throw new Error(`问题 ${questionId} 的 options 必须是数组`)
  }
  if (raw.length === 0) {
    return undefined
  }
  if (raw.length > MAX_OPTIONS) {
    throw new Error(`问题 ${questionId} 最多给 ${MAX_OPTIONS} 个选项（收到 ${raw.length} 个）`)
  }
  const labels = new Set<string>()
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`问题 ${questionId} 的第 ${index + 1} 个选项必须是对象`)
    }
    const record = item as Record<string, unknown>
    const label = textOf(record.label)
    if (label.length === 0) {
      throw new Error(`问题 ${questionId} 的第 ${index + 1} 个选项缺少 label`)
    }
    if (label.length > MAX_LABEL_CHARS) {
      throw new Error(`问题 ${questionId} 的选项标签过长（上限 ${MAX_LABEL_CHARS} 字符）`)
    }
    if (labels.has(label)) {
      throw new Error(`问题 ${questionId} 的选项标签重复：${label}`)
    }
    labels.add(label)
    const description = optionalText(record.description)
    if (description !== undefined && description.length > MAX_OPTION_DESCRIPTION_CHARS) {
      throw new Error(
        `问题 ${questionId} 的选项说明过长（上限 ${MAX_OPTION_DESCRIPTION_CHARS} 字符）`
      )
    }
    return { label, ...(description !== undefined ? { description } : {}) }
  })
}

/** 展示用宽松解析：参数不合法时返回 null，卡片退回通用工具行 */
function questionsOrNull(raw: unknown): AiQuestion[] | null {
  try {
    return toQuestions(raw)
  } catch {
    return null
  }
}

/** 卡片标题：单个问题直接展示正文，多个问题只报数量 */
function questionCard(
  questions: readonly AiQuestion[],
  answers?: AiQuestionAnswer[]
): ToolCardView {
  const title =
    questions.length === 1 ? questions[0].question : `${questions.length} 个问题等待你的回答`
  return {
    kind: 'question',
    title,
    questions: [...questions],
    ...(answers !== undefined ? { answers } : {})
  }
}

/**
 * 从工具结果文本里取回答。
 * 文本由本工具自己生成，格式固定；旧日志或异常内容解析不出来时不给回答，
 * 卡片仍然展示问题与结果文本。
 * @param text 工具结果文本（JSON）
 */
function answersOf(text: string): AiQuestionAnswer[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const raw = (parsed as Record<string, unknown>).answers
  if (!Array.isArray(raw)) {
    return null
  }
  const answers: AiQuestionAnswer[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return null
    }
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || !Array.isArray(record.selected)) {
      return null
    }
    if (!record.selected.every((label): label is string => typeof label === 'string')) {
      return null
    }
    if (record.custom !== undefined && typeof record.custom !== 'string') {
      return null
    }
    answers.push({
      id: record.id,
      selected: [...record.selected],
      ...(typeof record.custom === 'string' && record.custom.length > 0
        ? { custom: record.custom }
        : {})
    })
  }
  return answers
}

/** 读取必填文本并去掉首尾空白；非字符串一律按空串处理 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 读取可选文本：空串与缺省都返回 undefined */
function optionalText(value: unknown): string | undefined {
  const text = textOf(value)
  return text.length > 0 ? text : undefined
}
