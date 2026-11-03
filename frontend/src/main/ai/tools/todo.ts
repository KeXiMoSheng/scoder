import type { TodoItem, TodoStatus, ToolCardView } from '../../../shared/ai/types'
import type { ToolDefinition } from './registry'

/** 合法的任务状态：与参数 schema 的 enum 同源 */
const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed']

/**
 * todo_write 工具：把多步工作拆成任务清单，每次提交完整列表。
 *
 * 与 deepseek-harness 的 todo_write 同构：没有逐项编辑，只有整表替换；
 * 清单不单独存储，随 tool/result 的卡片进入会话日志，历史重放即可复原。
 * 状态纪律保持单活跃项：本项目的工具串行执行，同一时刻只该有一条进行中。
 */
export function createTodoTool(): ToolDefinition {
  return {
    name: 'todo_write',
    description:
      '记录并更新任务清单，用来规划多步工作并展示进度；一两步就能完成的简单任务不要用。' +
      '开工前按具体步骤逐条列出，一步一条；工作期间始终让正在做的那一条保持 in_progress，' +
      '同一时刻只允许一条；每完成一条立即标记 completed。' +
      '每次调用都要提交完整清单，它会整体替换上一版。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整任务清单，整体替换上一版。',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: '任务内容，一句简短的祈使句。'
              },
              status: {
                type: 'string',
                description: 'pending（未开始）| in_progress（正在做）| completed（已完成）。',
                enum: [...STATUSES]
              }
            },
            required: ['content', 'status'],
            additionalProperties: false
          }
        }
      },
      required: ['todos'],
      additionalProperties: false
    },
    execute(args) {
      const todos = toTodoList(args.todos)
      const counts = countOf(todos)
      return Promise.resolve({
        text: `已更新任务清单：${counts.pending} 待办，${counts.inProgress} 进行中，${counts.completed} 已完成。`
      })
    },
    presentCall(args) {
      return cardOf(todosOf(args.todos), '更新任务清单')
    },
    presentResult(args) {
      const todos = todosOf(args.todos)
      if (!todos) {
        return { kind: 'todo', title: '更新任务清单' }
      }
      return cardOf(todos, todoTitle(todos))
    }
  }
}

/**
 * 校验并规范化模型提交的清单。
 * 与 deepseek-harness 一致：内容非空且不重复、状态合法、最多一条进行中；
 * 不一致时明确失败，让日志里的快照如实反映模型真正写入的内容。
 * @param raw 模型给出的 todos 参数
 * @returns 去掉首尾空白的规范清单
 */
function toTodoList(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) {
    throw new Error('参数 todos 必须是数组')
  }
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('todos 的每一项必须是 { content, status } 对象')
    }
    const record = item as Record<string, unknown>
    const content = typeof record.content === 'string' ? record.content.trim() : ''
    if (content.length === 0) {
      throw new Error('任务内容 content 必须是非空字符串')
    }
    if (seen.has(content)) {
      throw new Error(`任务内容重复：${content}`)
    }
    seen.add(content)
    const status = record.status
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      throw new Error('任务状态必须是 pending、in_progress 或 completed')
    }
    if (status === 'in_progress') {
      active += 1
    }
    todos.push({ content, status })
  }
  if (active > 1) {
    throw new Error(`同一时刻只能有一条任务处于 in_progress（收到 ${active} 条）`)
  }
  return todos
}

/**
 * 展示用的宽松解析：参数不合法时返回 null，让卡片退回结果文本。
 * @param raw 模型给出的 todos 参数
 */
function todosOf(raw: unknown): TodoItem[] | null {
  try {
    return toTodoList(raw)
  } catch {
    return null
  }
}

/** 各状态的条目数，供结果文本与卡片标题使用 */
function countOf(todos: readonly TodoItem[]): {
  pending: number
  inProgress: number
  completed: number
} {
  return {
    pending: todos.filter((todo) => todo.status === 'pending').length,
    inProgress: todos.filter((todo) => todo.status === 'in_progress').length,
    completed: todos.filter((todo) => todo.status === 'completed').length
  }
}

/** 卡片标题：完成计数打头，有进行中的条目时顺带显示它，收起状态也能看到进度 */
function todoTitle(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return '任务清单为空'
  }
  const counts = countOf(todos)
  const active = todos.find((todo) => todo.status === 'in_progress')
  const progress = `任务清单 ${counts.completed}/${todos.length} 完成`
  return active ? `${progress} · ${active.content}` : progress
}

/** 组装 todo 卡片；没有合法清单时只留标题，正文由结果文本兜底 */
function cardOf(todos: TodoItem[] | null, title: string): ToolCardView {
  return {
    kind: 'todo',
    title,
    ...(todos ? { todos } : {})
  }
}
