import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import iconv from 'iconv-lite'
import jschardet from 'jschardet'
import {
  encodingSpec,
  isUtf16Encoding,
  type EncodingCandidate,
  type TextBomKind,
  type TextEncodingId
} from '../../shared/files/encoding'

/**
 * 文本编码的主进程实现：BOM / jschardet 探测，iconv-lite 编解码。
 * 编辑器、AI read 与写工具共用这一份语义，避免同一份字节在不同入口得到不同文本。
 */

/** 编码探测与二进制判定共用的采样窗口：文件头 8 KB */
export const BINARY_SAMPLE_BYTES = 8192

/** BOM 字节：保存时按编码 id 写出 */
const BOM_BYTES: Record<TextBomKind, Buffer> = {
  'utf-8': Buffer.from([0xef, 0xbb, 0xbf]),
  'utf-16le': Buffer.from([0xff, 0xfe]),
  'utf-16be': Buffer.from([0xfe, 0xff])
}

/** 文件头 BOM → 带 BOM 的编码 id；没有 BOM 时返回 null */
export function sniffBomEncoding(sample: Uint8Array): TextEncodingId | null {
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return 'utf-8-bom'
  }
  if (sample.length >= 2) {
    if (sample[0] === 0xff && sample[1] === 0xfe) return 'utf-16le-bom'
    if (sample[0] === 0xfe && sample[1] === 0xff) return 'utf-16be-bom'
  }
  return null
}

/**
 * jschardet 的编码名 → 本应用支持的编码。
 * jschardet 会优先给出兼容超集（GB18030 / CP932 / CP949），正好可以原样写回；
 * 无 BOM 的 UTF-16 不参与映射（与二进制无法可靠区分），仍按二进制处理。
 */
function mapDetectedEncoding(name: string | null): TextEncodingId | null {
  if (name === null) {
    return null
  }
  switch (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
  ) {
    case 'utf8':
      return 'utf-8'
    case 'gb2312':
    case 'gbk':
    case 'gb18030':
      return 'gb18030'
    case 'big5':
      return 'big5'
    case 'cp932':
    case 'shiftjis':
    case 'sjis':
      return 'shift-jis'
    case 'cp949':
    case 'euckr':
      return 'euc-kr'
    case 'windows1252':
      return 'windows-1252'
    case 'iso88591':
      return 'iso-8859-1'
    default:
      return null
  }
}

/** 采样是否为合法 UTF-8：样本可能被截断，最多退掉 3 个尾字节再判定 */
function isValidUtf8Sample(sample: Uint8Array): boolean {
  for (let trim = 0; trim <= 3 && trim < sample.length; trim += 1) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - trim))
      return true
    } catch {
      // 尾部可能是不完整的多字节序列：缩短一个字节再试
    }
  }
  return false
}

/**
 * 自动识别编码：BOM → 合法 UTF-8 → jschardet → UTF-8 兜底。
 * 先判 UTF-8 是因为合法 UTF-8 的字节序列几乎不可能是遗留编码，
 * 而 jschardet 对短样本容易给出低置信度的遗留编码。
 */
export function detectTextEncoding(sample: Uint8Array): TextEncodingId {
  const bom = sniffBomEncoding(sample)
  if (bom !== null) {
    return bom
  }
  if (sample.length === 0 || isValidUtf8Sample(sample)) {
    return 'utf-8'
  }
  const result = jschardet.detect(Buffer.from(sample)) as {
    encoding: string | null
    confidence: number
  }
  return mapDetectedEncoding(result.encoding) ?? 'utf-8'
}

/**
 * 候选编码（按可能性降序）：状态栏菜单据此把最可能的编码标注出来。
 * 实际采用的编码一定包含在内（即使 jschardet 没有给出它），保证标注与编辑器行为一致。
 * @param sample 文件头采样（与二进制判定共用同一段字节）
 * @param limit 最多返回的候选数量
 */
export function detectEncodingCandidates(sample: Uint8Array, limit = 3): EncodingCandidate[] {
  const bom = sniffBomEncoding(sample)
  if (bom !== null) {
    return [{ encoding: bom, confidence: 1 }]
  }
  if (sample.length === 0 || isValidUtf8Sample(sample)) {
    return [{ encoding: 'utf-8', confidence: 1 }]
  }
  const results = jschardet.detectAll(Buffer.from(sample)) as Array<{
    encoding: string | null
    confidence: number
  }>
  // 同一字符集的多个名字（如 CP932 / SHIFT_JIS）合并成一条，取最高置信度
  const merged = new Map<TextEncodingId, number>()
  for (const result of results) {
    const id = mapDetectedEncoding(result.encoding)
    if (id === null || result.confidence <= 0) {
      continue
    }
    merged.set(id, Math.max(merged.get(id) ?? 0, result.confidence))
  }
  // 兜底 UTF-8 也放进来：菜单里当前编码仍有对勾，候选标注只描述字节特征
  const effective = detectTextEncoding(sample)
  merged.set(effective, merged.get(effective) ?? 0)
  return [...merged.entries()]
    .map(([encoding, confidence]) => ({ encoding, confidence }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit)
}

/**
 * 二进制采样：当前编码是 UTF-16 时 NUL 是内容字节，不参与判定；
 * 未指定编码时按 BOM 判断（statFile 场景），其余沿用「8 KB 内含 NUL 即二进制」。
 */
export function isBinarySample(sample: Uint8Array, encoding?: TextEncodingId): boolean {
  // 未指定编码时（statFile 场景）按文件头 BOM 判断，二者都委托给同一套 UTF-16 判定
  const effective = encoding ?? sniffBomEncoding(sample) ?? undefined
  if (isUtf16Encoding(effective)) {
    return false
  }
  return sample.includes(0)
}

/** 增量解码器：跨块不完整的多字节序列由 iconv-lite 内部缓存 */
export interface TextDecoderStream {
  write: (chunk: Uint8Array) => string
  end: () => string
}

/** 创建指定编码的增量解码器 */
export function createTextDecoder(encoding: TextEncodingId): TextDecoderStream {
  const decoder = iconv.getDecoder(encodingSpec(encoding).charset)
  return {
    write: (chunk) => decoder.write(Buffer.from(chunk)),
    end: () => decoder.end() ?? ''
  }
}

/** 整段解码：BOM 由 iconv 自动剥离，不进入文本内容 */
export function decodeText(buffer: Uint8Array, encoding: TextEncodingId): string {
  return iconv.decode(Buffer.from(buffer), encodingSpec(encoding).charset)
}

/** 编码一段文本（不含 BOM）；不可表示的字符由 iconv 替换 */
export function encodeText(text: string, encoding: TextEncodingId): Buffer {
  return iconv.encode(text, encodingSpec(encoding).charset)
}

/** 保存时应写出的 BOM 字节；null 表示不写 */
export function bomBytesFor(encoding: TextEncodingId): Buffer | null {
  const kind = encodingSpec(encoding).bom
  return kind === null ? null : BOM_BYTES[kind]
}

/** 读取文件头采样（最多 8 KB）；空文件返回空数组 */
export async function readHeadSample(handle: FileHandle, size: number): Promise<Uint8Array> {
  if (size === 0) {
    return new Uint8Array(0)
  }
  const sample = Buffer.allocUnsafe(Math.min(BINARY_SAMPLE_BYTES, size))
  const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
  return sample.subarray(0, bytesRead)
}

/** 从已打开的句柄探测编码；空文件按 UTF-8 */
export async function detectHandleEncoding(
  handle: FileHandle,
  size: number
): Promise<TextEncodingId> {
  return detectTextEncoding(await readHeadSample(handle, size))
}

/** 从磁盘探测文件编码；不存在或读取失败时按 UTF-8（新建文件场景） */
export async function detectFileEncoding(filePath: string): Promise<TextEncodingId> {
  let handle: FileHandle | undefined
  try {
    handle = await fs.open(filePath, 'r')
    const info = await handle.stat()
    return info.isFile() ? await detectHandleEncoding(handle, Number(info.size)) : 'utf-8'
  } catch {
    return 'utf-8'
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
