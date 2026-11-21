/**
 * 读取 .vsix 主题扩展包。
 *
 * .vsix 就是一个 ZIP：扩展清单在 extension/package.json 的 contributes.themes 里，
 * 主题文件则由 path 指向扩展目录内的 JSON/JSONC。
 * 这里只用 Node 自带的 zlib 解析 ZIP 中央目录，不引入额外依赖；
 * 仅支持 store / deflate 两种压缩方式（VSIX 实际只会出现这两种），不支持加密。
 */
import { inflateRawSync } from 'zlib'
import { posix } from 'path'
import { THEME_IMPORT_LIMITS } from '../../shared/theme/types'
import { parseThemeJsonc, type ThemeSource } from '../../shared/theme/convert'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_HEADER_SIGNATURE = 0x04034b50
const ZIP64_SENTINEL = 0xffffffff
const MANIFEST_MAX_BYTES = 5 * 1024 * 1024

interface ZipEntry {
  name: string
  flags: number
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

interface ZipArchive {
  buffer: Buffer
  entries: Map<string, ZipEntry>
}

/** 扩展清单里声明的一套主题 */
export interface VsixThemeRef {
  label: string
  /** 扩展包内的规范化路径（ZIP 条目名） */
  key: string
  uiTheme?: string
}

/** 打开后的扩展包：主题清单 + 供 include 链读取包内文件的来源 */
export interface VsixThemePackage {
  refs: VsixThemeRef[]
  source: ThemeSource
}

/** ZIP 文件头（PK\x03\x04）：扩展名不靠谱时也能识别 */
export function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_HEADER_SIGNATURE
}

/**
 * 解析 .vsix：读出扩展清单，返回其中声明的全部主题。
 * @throws 包结构损坏、没有清单、或清单未声明主题
 */
export function openVsixThemePackage(buffer: Buffer): VsixThemePackage {
  const archive = readZipArchive(buffer)
  const manifestKey = findManifestKey(archive)
  if (!manifestKey) {
    throw new Error('扩展包内找不到 package.json，无法识别主题')
  }
  const manifestEntry = archive.entries.get(manifestKey)
  if (!manifestEntry) {
    throw new Error('扩展包内找不到 package.json，无法识别主题')
  }
  const manifestText = readZipEntryText(archive, manifestEntry, MANIFEST_MAX_BYTES)
  const manifest = parseThemeJsonc(manifestText)
  const refs = readThemeRefs(manifest, manifestKey)
  if (refs.length === 0) {
    throw new Error('扩展包未声明任何 VS Code 主题（contributes.themes）')
  }
  if (refs.length > THEME_IMPORT_LIMITS.maxThemesPerPackage) {
    throw new Error(
      `扩展包声明了 ${refs.length} 套主题，超过单次导入上限 ${THEME_IMPORT_LIMITS.maxThemesPerPackage}`
    )
  }
  return { refs, source: createZipThemeSource(archive) }
}

/** 让 include 能读取包内相对路径：只允许引用已存在的 ZIP 条目 */
function createZipThemeSource(archive: ZipArchive): ThemeSource {
  return {
    resolve: (reference: string, fromKey: string): string => {
      const clean = reference.replace(/\\/g, '/').replace(/^\.\//, '')
      return posix.normalize(posix.join(posix.dirname(fromKey), clean))
    },
    read: (key: string): unknown => {
      const entry = archive.entries.get(key)
      if (!entry) {
        throw new Error(`扩展包内缺少主题文件：${key}`)
      }
      const text = readZipEntryText(archive, entry, THEME_IMPORT_LIMITS.maxThemeFileBytes)
      return parseThemeJsonc(text)
    }
  }
}

/** 清单 contributes.themes 的宽松读取：缺 label 时用文件名兜底 */
function readThemeRefs(manifest: unknown, manifestKey: string): VsixThemeRef[] {
  const record = asRecord(manifest)
  const contributes = asRecord(record?.contributes)
  const themes = Array.isArray(contributes?.themes) ? contributes.themes : []
  const baseDir = posix.dirname(manifestKey)
  const refs: VsixThemeRef[] = []
  for (const item of themes) {
    const definition = asRecord(item)
    const rawPath = typeof definition?.path === 'string' ? definition.path.trim() : ''
    if (rawPath === '') {
      continue
    }
    const key = posix.normalize(posix.join(baseDir, rawPath.replace(/\\/g, '/')))
    if (key.startsWith('../')) {
      throw new Error(`扩展清单中的主题路径越界：${rawPath}`)
    }
    const declaredLabel = typeof definition?.label === 'string' ? definition.label.trim() : ''
    const uiTheme = typeof definition?.uiTheme === 'string' ? definition.uiTheme : undefined
    refs.push({
      label: declaredLabel || basenameWithoutExtension(key),
      key,
      uiTheme
    })
  }
  return refs
}

/** 优先 extension/package.json；找不到时退回任意浅层 package.json */
function findManifestKey(archive: ZipArchive): string | null {
  if (archive.entries.has('extension/package.json')) {
    return 'extension/package.json'
  }
  const candidates = [...archive.entries.keys()]
    .filter((name) => name.endsWith('/package.json'))
    .sort((left, right) => left.split('/').length - right.split('/').length)
  return candidates[0] ?? null
}

/** 从文件末尾扫描 EOCD 并建立条目索引 */
function readZipArchive(buffer: Buffer): ZipArchive {
  if (buffer.length < 22) {
    throw new Error('压缩包内容不完整')
  }
  const eocd = findEndOfCentralDirectory(buffer)
  const totalEntries = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset === ZIP64_SENTINEL || centralSize === ZIP64_SENTINEL) {
    throw new Error('暂不支持 ZIP64 格式的扩展包')
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('压缩包中央目录损坏')
  }

  const entries = new Map<string, ZipEntry>()
  let offset = centralOffset
  let totalUncompressed = 0
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new Error('压缩包中央目录损坏')
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buffer.length) {
      throw new Error('压缩包中央目录损坏')
    }
    const name = buffer.toString('utf8', nameStart, nameEnd)
    entries.set(name, { name, flags, method, compressedSize, uncompressedSize, localHeaderOffset })
    totalUncompressed += uncompressedSize
    offset = nameEnd + extraLength + commentLength
  }
  if (totalUncompressed > THEME_IMPORT_LIMITS.maxUncompressedBytes) {
    throw new Error('扩展包解压后体积超过上限，已停止读取')
  }
  return { buffer, entries }
}

/** 倒序查找 EOCD（ZIP 注释最长 65535 字节） */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset
    }
  }
  throw new Error('不是有效的 ZIP/VSIX 文件（未找到中央目录）')
}

/** 读取单个条目并按需解压；maxOutputLength 防止压缩炸弹 */
function readZipEntry(archive: ZipArchive, entry: ZipEntry, maxOutputLength: number): Buffer {
  if ((entry.flags & 0x1) !== 0) {
    throw new Error('不支持加密的压缩包条目')
  }
  const local = entry.localHeaderOffset
  if (
    local + 30 > archive.buffer.length ||
    archive.buffer.readUInt32LE(local) !== LOCAL_HEADER_SIGNATURE
  ) {
    throw new Error(`压缩包条目损坏：${entry.name}`)
  }
  const nameLength = archive.buffer.readUInt16LE(local + 26)
  const extraLength = archive.buffer.readUInt16LE(local + 28)
  const dataStart = local + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > archive.buffer.length) {
    throw new Error(`压缩包条目损坏：${entry.name}`)
  }
  if (entry.uncompressedSize > maxOutputLength) {
    throw new Error(`压缩包条目体积超过上限：${entry.name}`)
  }
  const data = archive.buffer.subarray(dataStart, dataEnd)
  if (entry.method === 0) {
    if (data.length > maxOutputLength) {
      throw new Error(`压缩包条目体积超过上限：${entry.name}`)
    }
    return data
  }
  if (entry.method === 8) {
    return inflateRawSync(data, { maxOutputLength })
  }
  throw new Error(`不支持的压缩方式（${entry.method}）：${entry.name}`)
}

/** 读取条目文本（按 UTF-8 解码，主题文件均为 UTF-8） */
function readZipEntryText(archive: ZipArchive, entry: ZipEntry, maxOutputLength: number): string {
  return readZipEntry(archive, entry, maxOutputLength).toString('utf8')
}

function basenameWithoutExtension(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}
