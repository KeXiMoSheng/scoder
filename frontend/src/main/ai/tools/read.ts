import { READ_LIMIT, formatReadOutput } from '../fs/readRender'
import type { ToolDefinition } from './registry'
import { optionalInteger, requireString, sectionText } from './registry'

/** 一次读取的默认行数（与上限相同，对齐 deepseek-harness 的 readLimit） */
const DEFAULT_LIMIT = READ_LIMIT

/**
 * read 工具：读取工作区内的文本文件。
 * 流程：解析路径 → 观测类型 → 读有界窗口 → 渲染行号文本。
 * 大文件由文件系统层流式扫描，窗口内存只与行数/字节上限相关；
 * 顺带把读到的版本记进会话观测，供 write/edit 做“先读后改”与并发校验。
 */
export function createReadTool(): ToolDefinition {
  return {
    name: 'read',
    description:
      '读取工作区内的文本文件（自动识别 UTF-8 / UTF-16 / GBK 等编码），返回带行号的内容。大文件用 offset 与 limit 分页续读；单次输出受字节上限约束，命中上限时按 footer 继续读。',
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
      const limit = optionalInteger(args, 'limit', DEFAULT_LIMIT, READ_LIMIT)
      const target = await ctx.fs.resolve(filePath, ctx.cwd)
      const info = await ctx.fs.stat(target)
      if (!info) {
        // 记下“确认不存在”：随后 write 可以据此合法新建同名文件
        ctx.observation.record(ctx.sessionId, target, { kind: 'absent' })
        throw new Error(`文件不存在：${target.displayPath}`)
      }
      if (info.type === 'directory') {
        throw new Error(`这是一个目录，请改用 list：${target.displayPath}`)
      }
      if (info.type !== 'file') {
        throw new Error(`不是普通文件：${target.displayPath}`)
      }
      // 已知大小的文件按阈值选择整读或流式；大小未知时一律流式，避免整份缓冲
      const window = await ctx.fs.readWindow(target, offset, limit, info.size)
      // 读到即观测：写工具据此拿到可以安全覆盖的版本基准
      ctx.observation.record(ctx.sessionId, target, { kind: 'present', version: info.version })
      return {
        text: formatReadOutput(target.displayPath, window),
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
        // 行卡片只展示带行号的内容窗口；`<path>`/`<type>` 包裹是给模型定位用的
        body: sectionText(outcome.text, 'content')
      }
    }
  }
}

/** 卡片只需要展示用的字符串，读不到就算了，不让展示逻辑抛错 */
function optionalStringValue(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
