/**
 * 工具调用行的纯展示模型。
 *
 * 对齐 deepseek-harness 的 toolRowModel：由「工具名 + 参数 JSON + 结果卡片」
 * 推导出一行的工具族、标题、单行摘要、可打开路径、diff 统计与展开体类型。
 * 组件只按模型渲染，不自己解释参数；工具特有的展示差异集中在定义表里。
 */
import type { AiMessageView, TodoItem, ToolFileChange, ToolRowState } from '@shared/ai/types'
import { isAbsolutePath, isAtOrUnder, relativePath } from './filePath'

/** 一次工具调用消息（行组件的唯一输入） */
export type ToolMessage = Extract<AiMessageView, { kind: 'tool' }>

/** 工具族：决定行首图标与摘要来源 */
export type ToolRowVariant = 'read' | 'search' | 'bash' | 'write' | 'edit' | 'todo' | 'others'

/** 展开体类型：结构化卡片优先，其次通用的输入/输出卡 */
export type ToolRowBodyKind = 'diff' | 'todo' | 'text' | 'io' | 'none'

/**
 * 一个工具在行上的展示定义。
 * 扩展点：新增工具只要在 {@link TOOL_ROW_DEFINITIONS} 里加一条，
 * 标题与单行摘要即刻可用；需要专属展开体时再扩展 ToolRowBodyKind。
 */
export interface ToolRowDefinition {
  variant: ToolRowVariant
  /** 行首标题：中文动词短语，对齐 deepseek-harness 的 tool.title.* */
  title: string
  /** 摘要参数键：按顺序取第一个非空字符串 */
  summaryKeys?: readonly string[]
  /** 摘要就是可打开的工作区文件路径（点击打开，而不是展开整行） */
  filePathSummary?: boolean
}

/**
 * 工具名 → 行定义。
 * 未登记的工具回退为「工具名 + 参数里第一个短字符串」的通用行，
 * 因此新增工具不登记也能正常展示，只是摘要质量差一些。
 */
export const TOOL_ROW_DEFINITIONS: Record<string, ToolRowDefinition> = {
  read: {
    variant: 'read',
    title: '读取',
    summaryKeys: ['file_path'],
    filePathSummary: true
  },
  list: {
    variant: 'read',
    title: '列出目录',
    summaryKeys: ['path']
  },
  glob: {
    variant: 'search',
    title: '查找文件',
    summaryKeys: ['pattern']
  },
  grep: {
    variant: 'search',
    title: '搜索文件内容',
    summaryKeys: ['pattern']
  },
  bash: {
    variant: 'bash',
    title: '执行命令',
    summaryKeys: ['command']
  },
  write: {
    variant: 'write',
    title: '写入',
    summaryKeys: ['file_path'],
    filePathSummary: true
  },
  edit: {
    variant: 'edit',
    title: '编辑',
    summaryKeys: ['file_path'],
    filePathSummary: true
  },
  todo_write: {
    variant: 'todo',
    title: '更新任务清单'
  }
}

/** 参数里永远不进摘要的键：可能是整份文件内容，摘要只放得下一行 */
const NOISY_ARGUMENT_KEYS = new Set(['content', 'old_string', 'new_string', 'text', 'code'])

/** 行组件需要的全部展示数据 */
export interface ToolRowModel {
  variant: ToolRowVariant
  title: string
  /** 单行摘要：参数派生；失败行换成结果首行，让错误直接可见 */
  summary: string
  state: ToolRowState
  /** 摘要里可点击打开的工作区文件路径（相对工作区根） */
  filePath?: string
  /** 文件改动的 +/- 统计（write/edit 的结果卡片会带 change） */
  diffStat?: ToolFileChange
  /** 展开体类型；`none` 表示这一行没有可展开内容 */
  bodyKind: ToolRowBodyKind
  /** 结构化正文：read 的行号窗口、list 的条目、glob/grep 的匹配 */
  textBody?: string
  /** 通用行的输入：参数 JSON 原文 */
  input?: string
  /** 通用行的输出：结果文本；结构化行只在失败时展示 */
  output?: string
}

/**
 * 由一条工具消息推导行模型。
 * @param message 工具调用消息（实时事件或日志重放）
 * @param cwd 当前工作区根；摘要里的绝对路径转成相对路径展示
 */
export function toolRowModel(message: ToolMessage, cwd?: string | null): ToolRowModel {
  const definition = TOOL_ROW_DEFINITIONS[message.name] ?? {
    variant: 'others' as const,
    title: message.name
  }
  const args = parseArguments(message.arguments)
  const card = message.card
  const todos = card?.kind === 'todo' ? (card.todos ?? []) : []
  const hunks = card?.kind === 'diff' ? (card.hunks ?? []) : []
  const textBody = card?.body !== undefined && card.body.length > 0 ? card.body : undefined
  const output =
    message.resultText !== undefined && message.resultText.length > 0
      ? message.resultText
      : undefined

  const baseSummary =
    definition.variant === 'todo' ? todoSummary(todos) : argumentSummary(args, definition, cwd)
  // 失败行用结果首行替换摘要：错误信息比参数更值得占据这一行
  const summary =
    message.status === 'error' && output !== undefined ? firstLine(output) : baseSummary

  const structured = hunks.length > 0 || todos.length > 0 || textBody !== undefined
  // 结构化行的参数对读者没有信息量（尤其是 write 的整份内容），只保留结果
  const input = structured ? undefined : formatArguments(message.arguments, args)
  const bodyKind = pickBodyKind(hunks.length > 0, todos.length > 0, textBody, input, output)

  const filePath = definition.filePathSummary
    ? pickFilePath(card?.path, args, definition, cwd)
    : undefined

  return {
    variant: definition.variant,
    title: definition.title,
    summary,
    state: message.status,
    ...(filePath !== undefined ? { filePath } : {}),
    ...(card?.change !== undefined ? { diffStat: card.change } : {}),
    bodyKind,
    ...(textBody !== undefined ? { textBody } : {}),
    ...(input !== undefined ? { input } : {}),
    // 结构化正文已经承载结果；失败时再把错误文本附在展开体下方
    ...(structured
      ? message.status === 'error' && output !== undefined
        ? { output }
        : {}
      : output !== undefined
        ? { output }
        : {})
  }
}

/** 决定展开体形态：结构化卡片 > 通用输入/输出 > 不可展开 */
function pickBodyKind(
  hasDiff: boolean,
  hasTodos: boolean,
  textBody: string | undefined,
  input: string | undefined,
  output: string | undefined
): ToolRowBodyKind {
  if (hasDiff) return 'diff'
  if (hasTodos) return 'todo'
  if (textBody !== undefined) return 'text'
  if (input !== undefined || output !== undefined) return 'io'
  return 'none'
}

/** 从参数表按定义取摘要；取不到时退到卡片路径或第一个短字符串 */
function argumentSummary(
  args: Record<string, unknown> | undefined,
  definition: ToolRowDefinition,
  cwd?: string | null
): string {
  if (args === undefined) {
    return ''
  }
  const picked = pickString(args, definition.summaryKeys ?? []) ?? firstShortString(args)
  if (picked === undefined) {
    return ''
  }
  const line = firstLine(picked)
  return definition.filePathSummary ? displayPath(line, cwd) : line
}

/** 任务清单摘要：完成进度 + 正在做的那一条（与本项目的单活跃项纪律一致） */
function todoSummary(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return ''
  }
  const done = todos.filter((todo) => todo.status === 'completed').length
  const active = todos.find((todo) => todo.status === 'in_progress')?.content
  const head = `${done}/${todos.length} 已完成`
  return active === undefined ? head : `${head} · ${active}`
}

/** 摘要路径：优先结果卡片记录的相对路径，退到参数里的路径 */
function pickFilePath(
  cardPath: string | undefined,
  args: Record<string, unknown> | undefined,
  definition: ToolRowDefinition,
  cwd?: string | null
): string | undefined {
  const picked =
    cardPath ??
    (args === undefined
      ? undefined
      : pickString(args, definition.summaryKeys ?? ['file_path', 'path']))
  return picked === undefined ? undefined : displayPath(firstLine(picked), cwd)
}

/** 把工作区内的绝对路径转成相对路径；相对路径保持原样 */
function displayPath(path: string, cwd?: string | null): string {
  if (cwd === null || cwd === undefined || !isAbsolutePath(path) || !isAtOrUnder(path, cwd)) {
    return path
  }
  return relativePath(path, cwd)
}

/** 通用行的输入区：优先重新序列化（排版稳定），解析失败时保留原文 */
function formatArguments(
  raw: string,
  args: Record<string, unknown> | undefined
): string | undefined {
  if (raw.trim().length === 0) {
    return undefined
  }
  if (args === undefined) {
    return raw
  }
  return Object.keys(args).length === 0 ? undefined : JSON.stringify(args, null, 2)
}

/** 参数 JSON 解析：流式未完成或非法时返回 undefined，由调用方兜底 */
function parseArguments(raw: string): Record<string, unknown> | undefined {
  if (raw.trim().length === 0) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** 按优先级取第一个非空字符串参数 */
function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

/** 未登记工具的兜底摘要：第一个像样的字符串参数，跳过整份文件内容这类字段 */
function firstShortString(args: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(args)) {
    if (NOISY_ARGUMENT_KEYS.has(key)) {
      continue
    }
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= 200) {
      return value
    }
  }
  return undefined
}

/** 取首行：行式摘要只展示一行 */
function firstLine(text: string): string {
  const index = text.indexOf('\n')
  return index === -1 ? text : text.slice(0, index)
}
