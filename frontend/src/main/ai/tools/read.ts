import type { ReadWindow } from '../fs/service'
import type { ToolDefinition } from './registry'
import { optionalInteger, requireString } from './registry'

/** 一次读取的默认行数与上限（与 deepseek-harness 的 readLimit 默认值对齐） */
const DEFAULT_LIMIT = 800
const MAX_LIMIT = 2000
/** 单行长度上限：超长行（压缩产物、base64）会挤占整个上下文 */
const MAX_LINE_LENGTH = 2000

/** 把读取窗口渲染成带续读指令的模型文本 */
export function formatReadOutput(window: ReadWindow): string {
  const endLine = window.lines.at(-1)?.number ?? Math.max(0, window.offset - 1)
  const footer =
    endLine < window.totalLines
      ? `(Showing lines ${window.offset}-${endLine} of ${window.totalLines}. Use offset=${endLine + 1} to continue.)`
      : `(End of file - total ${window.totalLines} lines)`
  const body =
    window.lines.length > 0
      ? `${window.lines.map((line) => `${line.number}: ${clipLine(line.text)}`).join('\n')}\n\n${footer}`
      : footer
  return `<path>${window.target.displayPath}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
}

/** 截断超长单行，保留开头便于模型判断内容类型 */
function clipLine(text: string): string {
  return text.length <= MAX_LINE_LENGTH ? text : `${text.slice(0, MAX_LINE_LENGTH)}…`
}

/**
 * read 工具：读取工作区内的文本文件。
 * 流程：解析路径 → 观测类型 → 读有界窗口 → 渲染行号文本。
 * P1 会在这里补一条“已读版本”记录，供 write/edit 做并发校验。
 */
export function createReadTool(): ToolDefinition {
  return {
    name: 'read',
    description:
      '读取工作区内的 UTF-8 文本文件，返回带行号的内容。大文件用 offset 与 limit 分页续读。',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '文件路径，相对于工作区根；也可以给工作区内的绝对路径。'
        },
        offset: { type: 'number', description: '起始行号（1 起），默认 1。' },
        limit: { type: 'number', description: `本次最多返回的行数，默认 ${DEFAULT_LIMIT}。` }
      },
      required: ['file_path'],
      additionalProperties: false
    },
    async execute(args, ctx) {
      const filePath = requireString(args, 'file_path')
      const offset = optionalInteger(args, 'offset', 1, Number.MAX_SAFE_INTEGER)
      const limit = optionalInteger(args, 'limit', DEFAULT_LIMIT, MAX_LIMIT)
      const target = await ctx.fs.resolve(filePath, ctx.cwd)
      const info = await ctx.fs.stat(target)
      if (!info) {
        throw new Error(`文件不存在：${target.displayPath}`)
      }
      if (info.type === 'directory') {
        throw new Error(`这是一个目录，请改用 list：${target.displayPath}`)
      }
      if (info.type !== 'file') {
        throw new Error(`不是普通文件：${target.displayPath}`)
      }
      const window = await ctx.fs.readWindow(target, offset, limit)
      return {
        text: formatReadOutput(window),
        meta: { path: target.displayPath, offset, totalLines: window.totalLines }
      }
    },
    presentCall(args) {
      const filePath = optionalStringValue(args, 'file_path') ?? '文件'
      return { kind: 'read', title: `读取 ${filePath}`, path: filePath }
    },
    presentResult(args, outcome) {
      const filePath = optionalStringValue(args, 'file_path')
      return {
        kind: 'read',
        title: `读取 ${filePath ?? '文件'}`,
        ...(filePath ? { path: filePath } : {}),
        body: outcome.text
      }
    }
  }
}

/** 卡片只需要展示用的字符串，读不到就算了，不让展示逻辑抛错 */
function optionalStringValue(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
