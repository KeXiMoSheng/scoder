import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { createRequire } from 'module'
import { relative, resolve, sep } from 'path'
import {
  createSearchMatcher,
  type ContentSearchMatch,
  type ContentSearchResult,
  type ReplaceResult,
  type SearchOptions
} from '../../shared/files/types'
import { bomBytesFor, decodeText, detectFileEncoding, encodeText } from './encoding'

const MAX_MATCHES = 200
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const SEARCH_TIMEOUT_MS = 30_000
const requireFromHere = createRequire(__filename)

/** 定位随应用分发的 ripgrep；打包后二进制位于 asar 的解包目录。 */
function ripgrepPath(): string {
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const platformPackage = `@vscode/ripgrep-${process.platform}-${process.arch}`
  return requireFromHere
    .resolve(`${platformPackage}/bin/${binary}`)
    .replace(/app\.asar(?=[\\/])/u, 'app.asar.unpacked')
}

/** 只替换用户当前搜索结果中的行，未加载或截断掉的匹配不会隐式改动。 */
export async function replaceFileContents(
  rootPath: string,
  query: string,
  replacement: string,
  options: SearchOptions,
  matches: ContentSearchMatch[]
): Promise<ReplaceResult> {
  const root = resolve(rootPath)
  const matcher = createSearchMatcher(query, options)
  const byPath = new Map<string, Set<number>>()
  for (const match of matches) {
    const path = resolve(match.path)
    const rel = relative(root, path)
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(path) === root) {
      throw new Error('只能替换当前项目内的文件')
    }
    const lines = byPath.get(path) ?? new Set<number>()
    lines.add(match.line)
    byPath.set(path, lines)
  }
  let replacements = 0
  for (const [path, targetLines] of byPath) {
    const fileMatches = matches.filter((match) => resolve(match.path) === path)
    const buffer = await fs.readFile(path)
    const encoding = await detectFileEncoding(path)
    const text = decodeText(buffer, encoding)
    const sourceLines = text.split(/(?<=\n)/u)
    for (const match of fileMatches) {
      if (sourceLines[match.line - 1]?.replace(/\r?\n$/u, '') !== match.text) {
        throw new Error(`文件已发生变化，请重新搜索：${path}`)
      }
    }
    let count = 0
    const replaced = text.replace(/^.*(?:\n|$)/gmu, (line, offset: number, source: string) => {
      if (!line) return line
      const lineNumber = source.slice(0, offset).split('\n').length
      if (!targetLines.has(lineNumber)) return line
      matcher.lastIndex = 0
      return line.replace(matcher, (...args: unknown[]) => {
        if (!options.regex) {
          count += 1
          return replacement
        }
        const captures = args.slice(1, -2) as Array<string | undefined>
        const substituted = replacement.replace(/\$([$&`']|\d{1,2})/gu, (token, key: string) => {
          if (key === '$') return '$'
          if (key === '&') return args[0] as string
          if (key === '`') return line.slice(0, args.at(-2) as number)
          if (key === "'") return line.slice((args.at(-2) as number) + (args[0] as string).length)
          const value = captures[Number(key) - 1]
          return value ?? (options.regex ? token : '')
        })
        count += 1
        return substituted
      })
    })
    if (count === 0) throw new Error(`文件已发生变化，请重新搜索：${path}`)
    const stat = await fs.stat(path)
    const temporary = `${path}.scoder-replace-${process.pid}-${Date.now()}.tmp`
    try {
      await fs.writeFile(
        temporary,
        Buffer.concat([bomBytesFor(encoding) ?? Buffer.alloc(0), encodeText(replaced, encoding)]),
        { mode: stat.mode }
      )
      await fs.rename(temporary, path)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    replacements += count
  }
  return { filesChanged: byPath.size, replacements }
}

/** 在当前项目中搜索文本或正则，返回可直接跳转的绝对路径与行号。 */
export function searchFileContents(
  rootPath: string,
  query: string,
  options: SearchOptions
): Promise<ContentSearchResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      ripgrepPath(),
      [
        '--no-config',
        '--json',
        ...(options.regex ? [] : ['--fixed-strings']),
        ...(options.caseSensitive ? ['--case-sensitive'] : ['--ignore-case']),
        ...(options.wholeWord ? ['--word-regexp'] : []),
        '--max-count',
        String(MAX_MATCHES),
        '--max-columns',
        '500',
        '--regexp',
        query,
        '--',
        '.'
      ],
      { cwd: rootPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const output: Buffer[] = []
    let outputBytes = 0
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => child.kill(), SEARCH_TIMEOUT_MS)
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill()
        settle(() => reject(new Error('匹配内容过多，请输入更精确的关键词')))
        return
      }
      output.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      settle(() => reject(new Error(`无法启动内容搜索：${error.message}`, { cause: error })))
    })
    child.on('close', (code, signal) => {
      settle(() => {
        if (signal !== null) {
          reject(new Error('内容搜索超时，请输入更精确的关键词'))
          return
        }
        if (code !== 0 && code !== 1) {
          reject(new Error(`内容搜索失败：${stderr.trim() || `退出码 ${String(code)}`}`))
          return
        }
        const matches: ContentSearchMatch[] = []
        let truncated = false
        for (const raw of Buffer.concat(output).toString('utf8').split('\n')) {
          if (!raw) continue
          const record = JSON.parse(raw) as {
            type?: string
            data?: {
              path?: { text?: string }
              line_number?: number
              lines?: { text?: string }
            }
          }
          if (record.type !== 'match') continue
          const path = record.data?.path?.text
          const line = record.data?.line_number
          if (typeof path !== 'string' || typeof line !== 'number') continue
          if (matches.length >= MAX_MATCHES) {
            truncated = true
            break
          }
          matches.push({
            path: resolve(rootPath, path),
            line,
            text: record.data?.lines?.text?.replace(/\r?\n$/u, '') ?? ''
          })
        }
        resolveResult({ matches, truncated })
      })
    })
  })
}
