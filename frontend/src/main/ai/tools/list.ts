import type { ToolDefinition } from './registry'
import { optionalString } from './registry'

/** 单次列举返回的条目上限 */
const MAX_ENTRIES = 500

/**
 * list 工具：列出一个目录的直接子项。
 * P0 只做单层，递归遍历交给 glob（避免模型用 list 逐层爬树浪费轮次）。
 */
export function createListTool(): ToolDefinition {
  return {
    name: 'list',
    description:
      '列出工作区内某个目录的直接子项（目录在前，名称升序）。只看一层，递归查找请用 glob。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录路径，相对于工作区根；省略时为工作区根目录。'
        }
      },
      additionalProperties: false
    },
    async execute(args, ctx) {
      const path = optionalString(args, 'path') ?? '.'
      const target = await ctx.fs.resolve(path, ctx.cwd)
      const info = await ctx.fs.stat(target)
      if (!info) {
        throw new Error(`目录不存在：${target.displayPath}`)
      }
      if (info.type !== 'directory') {
        throw new Error(`不是目录：${target.displayPath}`)
      }
      const entries = await ctx.fs.list(target)
      const visible = entries.slice(0, MAX_ENTRIES)
      const lines = visible.map(
        (entry) => `${entry.type === 'directory' ? 'd' : 'f'} ${entry.name}`
      )
      if (entries.length > visible.length) {
        lines.push(`... 还有 ${entries.length - visible.length} 项未显示`)
      }
      return {
        text: `<path>${target.displayPath}</path>\n<entries>\n${lines.join('\n')}\n</entries>`,
        meta: { path: target.displayPath, count: entries.length }
      }
    },
    presentCall(args) {
      const path = optionalString(args, 'path') ?? '.'
      return { kind: 'generic', title: `列出 ${path}`, path }
    }
  }
}
