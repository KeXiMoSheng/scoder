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

/** 一次文件观测：version 用于 P1 的写入并发校验（createIfAbsent / replaceIfVersion） */
export interface FsStat {
  version: string
  type: 'file' | 'directory' | 'other'
  size: number
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
  /** 读取有界行窗口 */
  readWindow(target: FsTarget, offset: number, limit: number): Promise<ReadWindow>
  /** 列出目录直接子项 */
  list(target: FsTarget): Promise<FsDirEntry[]>
  /** 判断 child 是否等于 parent 或位于其下 */
  contains(parent: FsTarget, child: FsTarget): boolean
}

/** P0 的整文件读取上限：超过即拒绝，避免把超大文件读进主进程内存 */
const MAX_READ_BYTES = 2 * 1024 * 1024

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

/**
 * 本地文件系统实现：以工作区根为边界，所有目标先 realpath 再使用。
 * 这样 `..` 与符号链接都无法绕过边界判断。
 */
export class LocalFileSystem implements FileSystemService {
  readonly root: FsTarget

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
    try {
      const info = await fs.stat(target.key, { bigint: true })
      return {
        version: versionOf(info),
        type: typeOf(info),
        size: Number(info.size)
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

  /** 绝对路径 → 展示路径：工作区内用相对路径，根本身显示为 `.` */
  private toDisplay(key: string): string {
    const rel = relative(this.root.key, key)
    if (rel.length === 0) return '.'
    if (rel.startsWith('..') || isAbsolute(rel)) return key
    return rel.split(sep).join('/')
  }
}

/** 目录在前、同类按名称不区分大小写升序 */
function compareEntries(a: FsDirEntry, b: FsDirEntry): number {
  const rank = (entry: FsDirEntry): number => (entry.type === 'directory' ? 0 : 1)
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/**
 * 取路径的规范形式；目标不存在时对最近的已存在祖先做 realpath，再拼回缺失后缀。
 * P1 创建新文件依赖这一点：新建路径也必须落在工作区内。
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
