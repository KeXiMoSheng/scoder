import { changeFromMeta, diffStat, hunksFromMeta } from './diff'
import type { ToolDefinition } from './registry'
import { optionalString, requireString } from './registry'

/** 调用阶段预览的最大行数：重放历史时每条旧调用都会重算一次，不能拿全文跑 diff */
const PREVIEW_LINES = 60

/** 取文本前 limit 行（不 split 全文，超大文件也只扫到第 limit 个换行） */
function headLines(text: string, limit: number): string {
  let index = -1
  for (let count = 0; count < limit; count += 1) {
    index = text.indexOf('\n', index + 1)
    if (index === -1) return text
  }
  return text.slice(0, index)
}

/**
 * 把写入结果渲染成模型可读的确认文本。
 * 格式与 deepseek-harness 的 write 一致：模型只需知道"哪个文件、新建还是更新"，
 * 不需要把刚写的内容再回显一遍。
 */
function formatWriteOutput(displayPath: string, operation: 'create' | 'update'): string {
  const verb = operation === 'create' ? 'Created' : 'Updated'
  return `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${verb} file\n</content>`
}

/**
 * write 工具：创建或整体覆盖一个文件。
 * 能不能写由 ctx.observation 给出的意图决定：没读过的已有文件只允许新建，
 * 读过则按读到的版本做 CAS，挡住读出之后的并发改动。
 */
export function createWriteTool(): ToolDefinition {
  return {
    name: 'write',
    description:
      '创建或整体覆盖工作区内的 UTF-8 文本文件。覆盖已有文件前必须先 read；只改局部内容请用 edit。',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            '文件路径，相对于工作区根；也可以给工作区内的绝对路径。先给出 file_path 再给出 content。'
        },
        content: {
          type: 'string',
          description: '写入的完整 UTF-8 文本；空串表示写一个空文件。'
        }
      },
      required: ['file_path', 'content'],
      additionalProperties: false
    },
    async execute(args, ctx) {
      const filePath = requireString(args, 'file_path')
      // content 允许空串（写空文件），不能走 requireString
      const content = args.content
      if (typeof content !== 'string') {
        throw new Error('参数 content 必须是字符串（允许空串）')
      }
      const target = await ctx.fs.resolve(filePath, ctx.cwd)
      const intent = ctx.observation.writeIntent(ctx.sessionId, target)
      const outcome = await ctx.fs.writeText(target, content, intent)
      // 成功即刷新观测：同一会话里连续改写不必重新 read
      ctx.observation.record(ctx.sessionId, target, { kind: 'present', version: outcome.version })
      // 新建没有旧内容可比，整段算新增；更新走真正的行级 diff
      const stat = diffStat(outcome.before ?? '', outcome.after)
      return {
        text: formatWriteOutput(target.displayPath, outcome.operation),
        meta: {
          path: target.displayPath,
          operation: outcome.operation,
          hunks: stat.hunks,
          added: stat.added,
          removed: stat.removed
        },
        changedPaths: [target.displayPath]
      }
    },
    presentCall(args) {
      const filePath = optionalString(args, 'file_path') ?? '文件'
      const content = typeof args.content === 'string' ? args.content : ''
      return {
        kind: 'diff',
        title: `写入 ${filePath}`,
        path: filePath,
        // 调用阶段拿不到旧内容：整体按新增预览。
        // 历史重放会对每条旧调用重算一次，所以只取前几行，不拿全文跑 diff。
        hunks: diffStat('', headLines(content, PREVIEW_LINES)).hunks
      }
    },
    presentResult(args, outcome) {
      const filePath = optionalString(args, 'file_path') ?? '文件'
      const hunks = hunksFromMeta(outcome.meta)
      const change = changeFromMeta(outcome.meta)
      return {
        kind: 'diff',
        title: `写入 ${filePath}`,
        path: filePath,
        ...(hunks.length > 0 ? { hunks } : {}),
        ...(change ? { change } : {})
      }
    }
  }
}
