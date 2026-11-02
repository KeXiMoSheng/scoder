import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import type { BigIntStats } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'path'

/**
 * 解析后的文件身份。
 * key 是后端私有的稳定标识（本地实现为 realpath），调用方不得解析它；
 * displayPath 是相对工作区根的展示路径，返回给模型与 UI。
 */
export interface FsTarget {
  key: string
  displayPath: string
}

/** 一次文件观测：version 用于写入并发校验（createIfAbsent / replaceIfVersion） */
export interface FsStat {
  version: string
  type: 'file' | 'directory' | 'other'
  size: number
}

/**
 * 写入意图：把"能不能改"的策略从工具里拿到服务层。
 * createIfAbsent 只允许新建（目标已存在即拒绝）；
 * replaceIfVersion 要求文件仍是读到的那个版本（CAS）。
 * 不传意图表示无条件原子写，只留给内部调用。
 */
export type FsWriteIntent =
  { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string }

/** 整文件写入的结果 */
export interface FsWriteOutcome {
  operation: 'create' | 'update'
  /** 写后版本令牌 */
  version: string
  /** 写前内容（LF 归一化）；新建、二进制或超限时为 null */
  before: string | null
  /** 写后内容（LF 归一化，与 before 同一 diff 基准） */
  after: string
}

/** 一次字面替换请求 */
export interface FsEditRequest {
  /** 待替换的原文，必须非空 */
  oldString: string
  /** 替换文本；空串表示删除匹配到的内容 */
  newString: string
  /** 是否替换全部匹配；false 时要求唯一匹配 */
  replaceAll: boolean
}

/** 字面编辑的结果 */
export interface FsEditOutcome {
  version: string
  /** 编辑前内容（LF 归一化） */
  before: string
  /** 编辑后内容（LF 归一化） */
  after: string
}

/** 目录直接子项（不含内容） */
export interface FsDirEntry {
  name: string
  type: 'file' | 'directory' | 'other'
}

/** 读取窗口中的一行 */
export interface FsLine {
  number: number
  text: string
}

/** 一次有界的读取结果 */
export interface ReadWindow {
  target: FsTarget
  /** 实际起始行（1 起） */
  offset: number
  lines: FsLine[]
  totalLines: number
  /** 是否还有后续行未返回 */
  truncated: boolean
}

/**
 * 执行世界里的文件系统能力。
 * 工具只依赖这个接口：路径解析、边界判断、编码与二进制拒绝都由实现负责，
 * 因此 P1 接入沙箱或远程后端时不需要改工具。
 */
export interface FileSystemService {
  readonly root: FsTarget
  /** 将模型给的字符串路径解析为稳定身份；越出工作区时抛错 */
  resolve(input: string, cwd?: string): Promise<FsTarget>
  /** 观测目标；不存在返回 undefined */
  stat(target: FsTarget): Promise<FsStat | undefined>
  /** 获取有界行窗口 */
  readWindow(target: FsTarget, offset: number, limit: number): Promise<ReadWindow>
  /** 列出目录直接子项 */
  list(target: FsTarget): Promise<FsDirEntry[]>
  /** 按意图整文件写入；缺省意图为无条件原子写 */
  writeText(target: FsTarget, content: string, intent?: FsWriteIntent): Promise<FsWriteOutcome>
  /** 按字面替换编辑；expected 为读到的版本，用于挡住读到之后的外部改动 */
  editText(
    target: FsTarget,
    request: FsEditRequest,
    expected?: { version: string }
  ): Promise<FsEditOutcome>
  /** 判断 child 是否等于 parent 或位于其下 */
  contains(parent: FsTarget, child: FsTarget): boolean
}

/** P0 的整文件读取上限：超过即拒绝，避免把超大文件读进主进程内存 */
const MAX_READ_BYTES = 2 * 1024 * 1024

/** 写入上限：与读取上限对齐，避免模型一次把超大内容灌进磁盘 */
const MAX_WRITE_BYTES = 2 * 1024 * 1024

/** 目录列举与搜索共同忽略的噪音目录（版本库元数据与依赖缓存） */
export const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'dist',
  'out',
  'build'
])

/** 由高精度 stat 身份与新鲜度拼出的版本令牌，实现细节对调用方不透明 */
function versionOf(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

/** 判断路径条目类型（只区分文件、目录与其他） */
function typeOf(info: BigIntStats): 'file' | 'directory' | 'other' {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  return 'other'
}

/** 内部观测：比公开的 FsStat 多带 mode，写入时用来保留原权限 */
interface ProbedStat extends FsStat {
  mode: number
}

/**
 * 本地文件系统实现：以工作区根为边界，所有目标先 realpath 再使用。
 * 这样 `..` 与符号链接都无法绕过边界判断。
 */
export class LocalFileSystem implements FileSystemService {
  readonly root: FsTarget

  /** 同一目标的读写队列：读→校验→写必须是一个不可交错的窗口 */
  private readonly locks = new Map<string, Promise<unknown>>()

  private constructor(root: FsTarget) {
    this.root = root
  }

  /**
   * 以绝对路径创建工作区文件系统。
   * @param rootPath 工作区根目录（用户当前打开的项目）
   * @returns 已完成 realpath 的实例
   */
  static async create(rootPath: string): Promise<LocalFileSystem> {
    if (!isAbsolute(rootPath)) {
      throw new Error('工作区根目录必须是绝对路径')
    }
    const key = await fs.realpath(rootPath)
    const info = await fs.stat(key)
    if (!info.isDirectory()) {
      throw new Error('工作区根目录不是一个目录')
    }
    return new LocalFileSystem({ key, displayPath: '.' })
  }

  async resolve(input: string, cwd?: string): Promise<FsTarget> {
    if (input.trim().length === 0) {
      throw new Error('路径不能为空')
    }
    // P0 的 cwd 固定为工作区根；P1 支持会话 cwd 后从入参读取
    const base = cwd ?? this.root.key
    const absolute = isAbsolute(input) ? input : resolvePath(base, input)
    const key = await canonicalPath(absolute)
    const target: FsTarget = { key, displayPath: this.toDisplay(key) }
    if (!this.contains(this.root, target)) {
      throw new Error(`路径超出工作区：${input}`)
    }
    return target
  }

  async stat(target: FsTarget): Promise<FsStat | undefined> {
    return this.probe(target.key)
  }

  /** 观测单个路径（含写入必需的 mode）；不存在返回 undefined */
  private async probe(key: string): Promise<ProbedStat | undefined> {
    try {
      const info = await fs.stat(key, { bigint: true })
      return {
        version: versionOf(info),
        type: typeOf(info),
        size: Number(info.size),
        mode: Number(info.mode)
      }
    } catch (error) {
      // 目标不存在不是异常：调用方据此决定“创建”还是“读取”
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async readWindow(target: FsTarget, offset: number, limit: number): Promise<ReadWindow> {
    const buffer = await fs.readFile(target.key)
    if (buffer.byteLength > MAX_READ_BYTES) {
      throw new Error(`文件超过 ${MAX_READ_BYTES / 1024 / 1024} MB，P0 暂不支持读取`)
    }
    // 含 NUL 字节按二进制处理：交给模型只会得到乱码
    if (buffer.includes(0)) {
      throw new Error('二进制文件不支持读取')
    }
    const text = buffer.toString('utf8')
    // 末尾换行不作为额外一行，避免行号比编辑器多 1
    const body = text.endsWith('\n') ? text.slice(0, -1) : text
    const all = body.length === 0 ? [] : body.split(/\r?\n/)
    const start = Math.min(Math.max(0, offset - 1), all.length)
    const selected = all
      .slice(start, start + limit)
      .map((line, index) => ({ number: start + index + 1, text: line }))
    return {
      target,
      offset,
      lines: selected,
      totalLines: all.length,
      truncated: start + selected.length < all.length
    }
  }

  async list(target: FsTarget): Promise<FsDirEntry[]> {
    const dirents = await fs.readdir(target.key, { withFileTypes: true })
    return dirents
      .filter((dirent) => !(dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)))
      .map((dirent): FsDirEntry => ({
        name: dirent.name,
        type: dirent.isFile() ? 'file' : dirent.isDirectory() ? 'directory' : 'other'
      }))
      .sort(compareEntries)
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    // P0 用词法边界判断；P1 需补 inode 兜底，覆盖大小写别名与 8.3 短名（见 fs-sandbox/containment）
    const normalize = (value: string): string =>
      process.platform === 'win32' ? value.toLowerCase() : value
    const parentKey = normalize(parent.key)
    const childKey = normalize(child.key)
    if (childKey === parentKey) return true
    const prefix = parentKey.endsWith(sep) ? parentKey : parentKey + sep
    return childKey.startsWith(prefix)
  }

  /**
   * 按意图写入整文件。
   * 流程：加锁 → 意图校验 → 抓写前内容 → 原子写 → 重新观测版本。
   * 加锁保证同一文件的读→校验→写是一个不可交错的窗口。
   */
  async writeText(
    target: FsTarget,
    content: string,
    intent?: FsWriteIntent
  ): Promise<FsWriteOutcome> {
    assertWriteSize(target, content)
    return this.withLock(target.key, async () => {
      const existing = await this.requireWritable(target, intent)
      // 写前内容只用于 diff 展示：读不到（二进制/超限/权限）就退化为整段替换
      const before = existing ? await readTextWithin(target, MAX_READ_BYTES) : null
      await writeTextAtomic(target, content, existing?.mode, intent?.kind === 'createIfAbsent')
      const after = await this.probe(target.key)
      return {
        operation: existing ? 'update' : 'create',
        version: after?.version ?? `missing:${target.key}`,
        before,
        // 与 before 同一 diff 基准：CRLF 写入不应被当成整文件改动
        after: normalizeLineEndings(content)
      }
    })
  }

  /**
   * 按字面替换编辑。
   * 版本校验放在文本匹配之前：读到旧内容时应当报“文件已变动”，
   * 而不是用“找不到 old_string”掩盖真正原因。
   */
  async editText(
    target: FsTarget,
    request: FsEditRequest,
    expected?: { version: string }
  ): Promise<FsEditOutcome> {
    return this.withLock(target.key, async () => {
      const existing = await this.probe(target.key)
      if (!existing) {
        throw new Error(`文件已不存在，请重新确认后再改：${target.displayPath}`)
      }
      if (existing.type !== 'file') {
        throw new Error(`不是普通文件，无法编辑：${target.displayPath}`)
      }
      if (expected && existing.version !== expected.version) {
        throw new Error(`文件在读取后被修改过，请重新 read 后再改：${target.displayPath}`)
      }
      const original = await readTextWithin(target, MAX_READ_BYTES)
      if (original === null) {
        throw new Error(`内容不是 UTF-8 文本或超过 2 MB，无法编辑：${target.displayPath}`)
      }
      // 匹配与 diff 统一在 LF 基准上做，写回时再还原原文的行尾风格
      const lineEnding = original.includes('\r\n') ? '\r\n' : '\n'
      const normalized = normalizeLineEndings(original)
      const edited = applyLiteralEdit(normalized, request, target.displayPath)
      await writeTextAtomic(target, restoreLineEndings(edited, lineEnding), existing.mode, false)
      const after = await this.probe(target.key)
      return {
        version: after?.version ?? `missing:${target.key}`,
        before: normalized,
        after: edited
      }
    })
  }

  /** 意图校验：把“该不该写”的判断集中在服务层，工具只负责拿到意图 */
  private async requireWritable(
    target: FsTarget,
    intent: FsWriteIntent | undefined
  ): Promise<ProbedStat | undefined> {
    const existing = await this.probe(target.key)
    if (existing && existing.type !== 'file') {
      throw new Error(`不是普通文件，无法写入：${target.displayPath}`)
    }
    if (intent?.kind === 'replaceIfVersion') {
      if (!existing) {
        throw new Error(`文件已不存在，请重新 read 后再写：${target.displayPath}`)
      }
      if (existing.version !== intent.version) {
        throw new Error(`文件在读取后被修改过，请重新 read 后再写：${target.displayPath}`)
      }
    } else if (intent?.kind === 'createIfAbsent' && existing) {
      throw new Error(`目标文件已存在且尚未读取，请先 read 再覆盖：${target.displayPath}`)
    }
    return existing
  }

  /**
   * 同一文件的变更操作串行执行。
   * 队列尾部吞掉异常：前一个操作失败不能阻断后面排队的人。
   */
  private withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve()
    const run = prior.then(operation)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.locks.set(key, tail)
    return run.finally(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    })
  }

  /** 绝对路径 → 展示路径：工作区内用相对路径，根本身显示为 `.` */
  private toDisplay(key: string): string {
    const rel = relative(this.root.key, key)
    if (rel.length === 0) return '.'
    if (rel.startsWith('..') || isAbsolute(rel)) return key
    return rel.split(sep).join('/')
  }
}

/** 写入内容的大小保护（按 UTF-8 字节数） */
function assertWriteSize(target: FsTarget, content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    throw new Error(
      `写入内容超过 ${MAX_WRITE_BYTES / 1024 / 1024} MB，请拆分成多次修改：${target.displayPath}`
    )
  }
}

/**
 * 读整文件文本，用作匹配与 diff 基准。
 * 不可用（二进制、超限、读失败）时返回 null：这是展示/匹配的辅助读取，
 * 不能因为拿不到基准就把已经成功的写入报成失败。
 */
async function readTextWithin(target: FsTarget, maxBytes: number): Promise<string | null> {
  try {
    const buffer = await fs.readFile(target.key)
    if (buffer.byteLength > maxBytes || buffer.includes(0)) return null
    return buffer.toString('utf8')
  } catch {
    return null
  }
}

/**
 * 原子写：同目录临时文件 → fsync → rename 覆盖。
 * 同目录很关键：跟目标不在同一文件系统的 rename 会退化成拷贝，不再原子。
 * createIfAbsent 改用 link 发布，保证并发创建只有一个赢家。
 */
async function writeTextAtomic(
  target: FsTarget,
  content: string,
  mode: number | undefined,
  createIfAbsent: boolean
): Promise<void> {
  const directory = dirname(target.key)
  try {
    await fs.mkdir(directory, { recursive: true })
  } catch (error) {
    throw writeIoError(target, error)
  }
  const tempPath = join(directory, `.${basename(target.key)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const handle = await fs.open(tempPath, 'wx', 0o600)
    try {
      await handle.writeFile(content, 'utf8')
      // 先落盘再发布：否则断电后 rename 成功但内容还在页缓存里
      await handle.sync()
      // 新建文件继承临时文件的 0600，需要还给目标原本的权限
      if (mode !== undefined) await handle.chmod(mode)
    } finally {
      await handle.close()
    }
    if (createIfAbsent) {
      await publishIfAbsent(tempPath, target)
    } else {
      await fs.rename(tempPath, target.key)
    }
  } catch (error) {
    throw writeIoError(target, error)
  } finally {
    // 成功发布后临时文件已不存在；失败路径下的残留也要清掉
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
  }
}

/** link 发布：目标已存在时拿 EEXIST，不会静默覆盖别人的文件 */
async function publishIfAbsent(tempPath: string, target: FsTarget): Promise<void> {
  try {
    await fs.link(tempPath, target.key)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`目标文件已存在且尚未读取，请先 read 再覆盖：${target.displayPath}`, {
        cause: error
      })
    }
    throw error
  }
}

/** 把 Node 的写入失败转成模型能据此调整的可读原因 */
function writeIoError(target: FsTarget, error: unknown): Error {
  switch ((error as NodeJS.ErrnoException).code) {
    case 'EACCES':
      return new Error(`没有写入权限：${target.displayPath}`)
    case 'EPERM':
      // Windows 上目标被其他进程占用也报 EPERM，一并提示避免误判
      return new Error(`没有写入权限，或文件正被其他程序占用：${target.displayPath}`)
    case 'EISDIR':
      return new Error(`这是一个目录，无法写入：${target.displayPath}`)
    case 'ENOSPC':
      return new Error(`磁盘空间不足，写入失败：${target.displayPath}`)
    default:
      return error instanceof Error
        ? new Error(`写入失败：${target.displayPath}（${error.message}）`, { cause: error })
        : new Error(`写入失败：${target.displayPath}`)
  }
}

/** 统一换行符为 LF：diff 与文本匹配都以它为准，避免 CRLF 文件每行都显示成改动 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** 写回时还原原文的行尾风格 */
function restoreLineEndings(text: string, lineEnding: string): string {
  return lineEnding === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

/**
 * 字面替换：默认要求唯一匹配，避免一次改动落到多处。
 * @returns 替换后的 LF 文本
 */
function applyLiteralEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldText = normalizeLineEndings(request.oldString)
  if (oldText.length === 0) {
    throw new Error(`old_string 不能为空字符串：${displayPath}`)
  }
  const newText = normalizeLineEndings(request.newString)
  const matches = countOccurrences(content, oldText)
  if (matches === 0) {
    throw new Error(`文件里找不到 old_string，请先 read 确认当前内容：${displayPath}`)
  }
  if (!request.replaceAll && matches > 1) {
    throw new Error(
      `old_string 匹配到 ${matches} 处，请提供更精确的片段或设置 replace_all：${displayPath}`
    )
  }
  return content.split(oldText).join(newText)
}

/** 统计不重叠出现次数 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** 目录在前、同类按名称不区分大小写升序 */
function compareEntries(a: FsDirEntry, b: FsDirEntry): number {
  const rank = (entry: FsDirEntry): number => (entry.type === 'directory' ? 0 : 1)
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/**
 * 取路径的规范形式；目标不存在时对最近的已存在祖先做 realpath，再拼回缺失后缀。
 * 新建文件依赖这一点：目标尚不存在时也要落到工作区内的真实路径上。
 */
async function canonicalPath(absolute: string): Promise<string> {
  try {
    return await fs.realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    if (parent === absolute) return absolute
    return join(await canonicalPath(parent), basename(absolute))
  }
}
