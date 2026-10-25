import { promises as fs } from 'fs'
import { join, relative, sep } from 'path'
import { IGNORED_DIRECTORY_NAMES } from '../fs/service'
import type { ToolDefinition } from './registry'
import { optionalString, requireString } from './registry'

/** 单次 glob 返回的路径上限 */
const GLOB_MAX_RESULTS = 200
/** 单次 grep 返回的匹配行上限 */
const GREP_MAX_MATCHES = 100
/** 遍历的文件总数上限：仓库异常庞大时兜底 */
const WALK_MAX_FILES = 20000
/** 遍历深度上限 */
const WALK_MAX_DEPTH = 16
/** grep 只读取不超过该大小的文件 */
const GREP_MAX_FILE_BYTES = 1024 * 1024
/** grep 单行预览长度 */
const GREP_MAX_LINE_LENGTH = 300

/** 遍历结果：相对工作区根、使用 / 分隔的路径 */
interface WalkedFile {
  absolute: string
  relative: string
}

/**
 * 递归收集文件路径，跳过噪音目录与符号链接。
 * P0 用同步式递归；P2 仓库变大后应换成 ripgrep 子进程（参考 tool-fs-search）。
 */
async function collectFiles(
  directory: string,
  base: string,
  budget: { files: number },
  depth = 0
): Promise<WalkedFile[]> {
  if (depth > WALK_MAX_DEPTH || budget.files <= 0) return []
  const dirents = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const files: WalkedFile[] = []
  for (const dirent of dirents) {
    if (budget.files <= 0) break
    const absolute = join(directory, dirent.name)
    if (dirent.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(dirent.name)) continue
      files.push(...(await collectFiles(absolute, base, budget, depth + 1)))
      continue
    }
    // 符号链接一律跳过：避免目录环与越界读取
    if (!dirent.isFile()) continue
    budget.files -= 1
    files.push({ absolute, relative: toPosix(relative(base, absolute)) })
  }
  return files
}

/** Windows 分隔符统一成 /，让模型看到的路径与 glob 模式一致 */
function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** 正则元字符转义（glob 中的字面量部分） */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把 glob 模式转成正则：支持 `*`、`**`、`?`、`{a,b}`。
 * 双星号后紧跟斜杠时表示“零或多层目录”，因此 `src` 下的任意深度都能命中。
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '{') {
      const end = pattern.indexOf('}', index)
      if (end > index) {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(',')
          .map(escapeRegExp)
          .join('|')
        source += `(?:${alternatives})`
        index = end
        continue
      }
    }
    source += escapeRegExp(char)
  }
  return new RegExp(`${source}$`)
}

/**
 * glob 工具：按路径模式查找文件。
 * 与 grep 的分工：glob 找“哪些文件”，grep 找“哪一行”。
 */
export function createGlobTool(): ToolDefinition {
  return {
    name: 'glob',
    description:
      '按 glob 模式查找工作区内的文件路径。支持 *、**、?、{a,b}；结果相对工作区根，最多返回 200 条。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'glob 模式，例如 src/**/*.ts 或 **/*.test.ts。'
        },
        path: { type: 'string', description: '搜索起点，相对于工作区根；省略时为工作区根。' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    async execute(args, ctx) {
      const pattern = requireString(args, 'pattern')
      const start = optionalString(args, 'path') ?? '.'
      const target = await ctx.fs.resolve(start, ctx.cwd)
      const info = await ctx.fs.stat(target)
      if (!info || info.type !== 'directory') {
        throw new Error(`搜索起点不是目录：${target.displayPath}`)
      }
      const matcher = globToRegExp(pattern)
      const walked = await collectFiles(target.key, target.key, { files: WALK_MAX_FILES })
      const matched = walked
        .map((file) => file.relative)
        .filter((path) => matcher.test(path))
        .slice(0, GLOB_MAX_RESULTS)
      const lines =
        matched.length > 0
          ? matched.join('\n')
          : `没有匹配 ${pattern} 的文件。检查模式，或先用 list 看一下目录结构。`
      const truncated = walked.filter((file) => matcher.test(file.relative)).length > matched.length
      return {
        text: `<pattern>${pattern}</pattern>\n<matches>\n${lines}\n</matches>${
          truncated ? `\n(Results capped at ${GLOB_MAX_RESULTS}.)` : ''
        }`,
        meta: { pattern, count: matched.length }
      }
    },
    presentCall(args) {
      const pattern = optionalString(args, 'pattern') ?? '*'
      return { kind: 'generic', title: `查找 ${pattern}` }
    }
  }
}

/**
 * grep 工具：按正则查找匹配行。
 * P0 逐文件读取并逐行匹配；只返回路径:行号:内容，不带上下文行。
 */
export function createGrepTool(): ToolDefinition {
  return {
    name: 'grep',
    description:
      '在工作区文本文件里按正则查找匹配行，返回 路径:行号:内容。可配合 glob 参数缩小范围。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript 正则表达式，例如 createReadTool\\(' },
        path: { type: 'string', description: '搜索起点，相对于工作区根；省略时为工作区根。' },
        glob: { type: 'string', description: '只搜索匹配该 glob 的文件，例如 **/*.ts。' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    async execute(args, ctx) {
      const pattern = requireString(args, 'pattern')
      const start = optionalString(args, 'path') ?? '.'
      const globFilter = optionalString(args, 'glob')
      const target = await ctx.fs.resolve(start, ctx.cwd)
      const info = await ctx.fs.stat(target)
      if (!info || info.type !== 'directory') {
        throw new Error(`搜索起点不是目录：${target.displayPath}`)
      }
      let matcher: RegExp
      try {
        matcher = new RegExp(pattern)
      } catch (error) {
        throw new Error(
          `正则表达式无效：${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
      }
      const fileFilter = globFilter ? globToRegExp(globFilter) : undefined
      const walked = await collectFiles(target.key, target.key, { files: WALK_MAX_FILES })
      const lines: string[] = []
      for (const file of walked) {
        if (fileFilter && !fileFilter.test(file.relative)) continue
        const stat = await fs.stat(file.absolute).catch(() => undefined)
        if (!stat || stat.size > GREP_MAX_FILE_BYTES) continue
        const buffer = await fs.readFile(file.absolute).catch(() => undefined)
        // 读取失败或二进制文件直接跳过：grep 不为个别文件中断整次搜索
        if (!buffer || buffer.includes(0)) continue
        const text = buffer.toString('utf8')
        const rows = text.split(/\r?\n/)
        for (let index = 0; index < rows.length; index += 1) {
          if (!matcher.test(rows[index])) continue
          lines.push(`${file.relative}:${index + 1}: ${clip(rows[index])}`)
          if (lines.length >= GREP_MAX_MATCHES) break
        }
        if (lines.length >= GREP_MAX_MATCHES) break
      }
      const body =
        lines.length > 0
          ? lines.join('\n')
          : `没有匹配 /${pattern}/ 的行。换一个更短的正则，或先用 glob 确认文件范围。`
      return {
        text: `<pattern>${pattern}</pattern>\n<matches>\n${body}\n</matches>${
          lines.length >= GREP_MAX_MATCHES ? `\n(Results capped at ${GREP_MAX_MATCHES}.)` : ''
        }`,
        meta: { pattern, count: lines.length }
      }
    },
    presentCall(args) {
      const pattern = optionalString(args, 'pattern') ?? ''
      return { kind: 'generic', title: `搜索 /${pattern}/` }
    }
  }
}

/** 截断超长匹配行，保留开头 */
function clip(line: string): string {
  return line.length <= GREP_MAX_LINE_LENGTH ? line : `${line.slice(0, GREP_MAX_LINE_LENGTH)}…`
}
