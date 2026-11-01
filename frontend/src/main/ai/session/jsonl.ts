/**
 * 会话日志的物理层：路径推导、容错读取、追加写入。
 *
 * 只做“文件里有什么、怎么安全写进去”，不关心对话语义；
 * 事件的含义与重放都在 store.ts。
 */
import { appendFile, mkdir, readFile, readdir, truncate, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { SessionLogError } from './errors'
import {
  SESSION_LOG_VERSION,
  type SessionEvent,
  type SessionLogContent,
  type SessionLogHeader
} from './types'

/**
 * 会话 id 白名单：只允许字母数字开头，后续为字母数字、下划线、连字符。
 * 渲染进程传来的值一律按不可信处理，直接当文件名会留下路径穿越口子，
 * 所以用白名单拒绝而不是转义（转义后文件名与 id 对不上，排错更困难）。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** 会话日志目录名，位于 Electron userData 之下 */
export const SESSIONS_DIR_NAME = 'sessions'

/** 可读目录名的最大长度：留出前缀与后缀，避开 Windows 路径长度限制 */
const PROJECT_KEY_MAX = 120

/**
 * 校验会话 id 可直接作为文件名。
 * @param id 待校验的会话 id
 * @throws SessionLogError id 含非法字符或超长
 */
export function assertSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new SessionLogError(
      `会话 id 不合法：${id}（只允许字母数字、下划线、连字符，最长 64）`,
      'SESSION_ID_INVALID'
    )
  }
}

/**
 * 把一个项目路径转成可读的目录名。
 * 分隔符与盘符压成 `-`，其余不安全字符用 `~XXXX` 转义；
 * 过长时截断并追加短哈希，避免两个深层路径落到同一目录（参考 deepseek-harness 的 projectKey）。
 * @param cwd 项目根目录绝对路径
 * @returns 形如 `--home-me-project--` 的单段目录名
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) {
    throw new SessionLogError('项目路径不能为空', 'SESSION_ID_INVALID')
  }
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const char = cwd[index]
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) {
        readable += '-'
      }
      separatorRun = true
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  if (slug.length <= PROJECT_KEY_MAX) {
    return `--${slug}--`
  }
  const digest = createHash('sha256').update(cwd).digest('hex').slice(0, 8)
  return `--${slug.slice(0, PROJECT_KEY_MAX)}-${digest}--`
}

/**
 * 计算某个项目的会话目录。
 * 会话按项目隔离：关闭项目后再次打开，只能看到这个项目自己的会话。
 * @param root 会话根目录（userData/sessions）
 * @param cwd 项目根目录绝对路径
 */
export function projectDir(root: string, cwd: string): string {
  return join(root, projectKey(cwd))
}

/**
 * 推导一个会话的日志文件路径。
 * @param root 会话根目录
 * @param cwd 会话所属项目根目录
 * @param id 会话 id
 * @returns 该会话的 .jsonl 绝对路径
 */
export function sessionLogPath(root: string, cwd: string, id: string): string {
  assertSessionId(id)
  return join(projectDir(root, cwd), `${id}.jsonl`)
}

/**
 * 列出一个项目下的全部会话日志。
 * @param root 会话根目录
 * @param cwd 项目根目录
 * @returns 日志文件名与绝对路径；项目目录不存在时返回空数组
 */
export async function listProjectLogs(
  root: string,
  cwd: string
): Promise<{ name: string; path: string }[]> {
  const dir = projectDir(root, cwd)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (isMissingFile(error)) {
      return []
    }
    throw error
  }
  return entries
    .filter((entry) => entry.endsWith('.jsonl'))
    .map((entry) => ({ name: entry, path: join(dir, entry) }))
}

/**
 * 读取一个会话日志。
 * 尾部半行（崩溃时只写了一半）会被丢弃并计数；中间行损坏视为文件损坏。
 * @param path 日志文件绝对路径
 * @returns 解析结果；文件不存在时返回 null
 * @throws SessionLogError 首行不是会话头、版本过高、中间行损坏、seq 断号
 */
export async function readSessionLog(path: string): Promise<SessionLogContent | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) {
      return null
    }
    throw error
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) {
    throw new SessionLogError(`会话日志为空：${path}`, 'SESSION_LOG_CORRUPT')
  }

  const header = parseLine(lines[0], path)
  if (!isSessionHeader(header)) {
    throw new SessionLogError(`首行不是会话头：${path}`, 'SESSION_LOG_CORRUPT')
  }
  if (header.version > SESSION_LOG_VERSION) {
    throw new SessionLogError(
      `会话日志版本 ${header.version} 高于当前程序支持的 ${SESSION_LOG_VERSION}`,
      'SESSION_LOG_VERSION_UNSUPPORTED'
    )
  }

  const events: SessionEvent[] = []
  let discarded = 0
  for (let index = 1; index < lines.length; index += 1) {
    let event: SessionEvent
    try {
      event = parseLine(lines[index], path) as SessionEvent
    } catch (error) {
      // 只有最后一行允许损坏：进程在写入中途被杀会留下半行
      if (index === lines.length - 1) {
        discarded = 1
        break
      }
      throw error
    }
    if (event.seq !== events.length) {
      throw new SessionLogError(
        `会话日志 seq 不连续（${path}）：期望 ${events.length}，实际 ${event.seq}`,
        'SESSION_LOG_CORRUPT'
      )
    }
    events.push(event)
  }
  return { header, events, discarded }
}

/**
 * 创建会话日志并写入首行。
 * @param path 日志文件绝对路径
 * @param header 会话头
 * @returns true 表示本次新建；false 表示文件已存在（未改动磁盘内容）
 */
export async function createSessionLog(path: string, header: SessionLogHeader): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  try {
    // wx 保证并发创建只有一个成功，已有文件永远不会被覆盖
    await writeFile(path, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if (isExistingFile(error)) {
      return false
    }
    throw new SessionLogError(`创建会话日志失败：${path}`, 'SESSION_LOG_WRITE_FAILED', {
      cause: error
    })
  }
}

/**
 * 追加一批记录到会话日志。
 * 整批拼成一次 appendFile：要么整批写进去，要么在尾部留下可被丢弃的半行，
 * 不会出现“一半记录在前、一半在后”的交错。
 * @param path 日志文件绝对路径
 * @param records 已分配好 seq 的事件（顺序即写入顺序）
 */
export async function appendSessionLog(
  path: string,
  records: readonly SessionEvent[]
): Promise<void> {
  if (records.length === 0) {
    return
  }
  const chunk = records.map((record) => `${JSON.stringify(record)}\n`).join('')
  try {
    await appendFile(path, chunk, 'utf8')
  } catch (error) {
    throw new SessionLogError(`写入会话日志失败：${path}`, 'SESSION_LOG_WRITE_FAILED', {
      cause: error
    })
  }
}

/**
 * 截掉文件尾部的半行。
 * 崩溃时最后一条记录可能只写了一半；若不先截掉就继续追加，
 * 那半行会变成“中间行损坏”，之后整份日志都读不出来。
 * @param path 日志文件绝对路径
 */
export async function truncateTornTail(path: string): Promise<void> {
  const text = await readFile(path, 'utf8')
  const cut = text.lastIndexOf('\n')
  // 已经以换行结尾（无残行）或空文件：无需处理
  if (cut === -1 || cut === text.length - 1) {
    return
  }
  // 按字节截断：中文是多字节字符，不能用字符下标
  await truncate(path, Buffer.byteLength(text.slice(0, cut + 1), 'utf8'))
}

/** 解析一行 JSON，失败时统一抛文件损坏 */
function parseLine(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new SessionLogError(`无法解析会话日志行：${path}`, 'SESSION_LOG_CORRUPT', {
      cause: error
    })
  }
}

/** 类型守卫：首行必须是带 id 的会话头 */
function isSessionHeader(value: unknown): value is SessionLogHeader {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<SessionLogHeader>
  return candidate.type === 'session' && typeof candidate.id === 'string'
}

/** 文件不存在（首次读取未创建的会话） */
function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** 目标文件已存在（并发创建或重启后重复创建） */
function isExistingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST'
}
