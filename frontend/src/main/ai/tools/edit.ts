import { changeFromMeta, diffStat, hunksFromMeta } from './diff'
import type { ToolDefinition } from './registry'
import { optionalString, requireString } from './registry'

/**
 * 编辑成功的确认文本。
 * 采用与 deepseek-harness 一致的句式：模型下一步只关心"改成了没有"。
 */
function formatEditOutput(displayPath: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`
}

/**
 * edit 工具：对文件做字面替换，默认要求唯一匹配。
 * 编辑必须先 read：意图由 ctx.observation 给出，未读过直接拒绝，
 * 读过则附带版本做 CAS，避免基于旧内容改动。
 */
export function createEditTool(): ToolDefinition {
  return {
    name: 'edit',
    description:
      '对工作区内的 UTF-8 文本文件做字面替换。old_string 必须在文件中唯一出现，否则请给更精确的片段或设置 replace_all。',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            '文件路径，相对于工作区根；也可以给工作区内的绝对路径。先给出 file_path 再给出替换文本。'
        },
        old_string: {
          type: 'string',
          description: '要被替换的原文，必须非空且与文件内容逐字符一致（含缩进与换行）。'
        },
        new_string: {
          type: 'string',
          description: '替换后的文本；空串表示删除匹配到的内容。'
        },
        replace_all: {
          type: 'boolean',
          description: '替换全部匹配。默认 false，此时 old_string 必须唯一出现。'
        }
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false
    },
    async execute(args, ctx) {
      const filePath = requireString(args, 'file_path')
      const oldString = requireString(args, 'old_string')
      // new_string 允许空串（删除匹配内容），不能走 requireString
      const newString = args.new_string
      if (typeof newString !== 'string') {
        throw new Error('参数 new_string 必须是字符串（允许空串表示删除）')
      }
      if (oldString === newString) {
        throw new Error('old_string 与 new_string 相同，这次编辑不会改变任何内容')
      }
      const replaceAll = args.replace_all === true
      const target = await ctx.fs.resolve(filePath, ctx.cwd)
      const expected = ctx.observation.editIntent(ctx.sessionId, target)
      const outcome = await ctx.fs.editText(target, { oldString, newString, replaceAll }, expected)
      // 成功即刷新观测：同一会话里连续编辑不必重新 read
      ctx.observation.record(ctx.sessionId, target, { kind: 'present', version: outcome.version })
      const stat = diffStat(outcome.before, outcome.after)
      return {
        text: formatEditOutput(target.displayPath, replaceAll),
        meta: {
          path: target.displayPath,
          hunks: stat.hunks,
          added: stat.added,
          removed: stat.removed
        },
        changedPaths: [target.displayPath]
      }
    },
    presentCall(args) {
      const filePath = optionalString(args, 'file_path') ?? '文件'
      const oldString = typeof args.old_string === 'string' ? args.old_string : ''
      const newString = typeof args.new_string === 'string' ? args.new_string : ''
      return {
        kind: 'diff',
        title: `编辑 ${filePath}`,
        path: filePath,
        // 调用阶段拿不到文件内容：用模型给出的替换片段预览
        hunks: diffStat(oldString, newString).hunks
      }
    },
    presentResult(args, outcome) {
      const filePath = optionalString(args, 'file_path') ?? '文件'
      const hunks = hunksFromMeta(outcome.meta)
      const change = changeFromMeta(outcome.meta)
      return {
        kind: 'diff',
        title: `编辑 ${filePath}`,
        path: filePath,
        ...(hunks.length > 0 ? { hunks } : {}),
        ...(change ? { change } : {})
      }
    }
  }
}
