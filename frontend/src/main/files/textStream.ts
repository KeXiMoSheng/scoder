import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import type { EncodingCandidate, TextEncodingId } from '../../shared/files/encoding'
import type { TextStreamChunk } from '../../shared/files/types'
import {
  BINARY_SAMPLE_BYTES,
  createTextDecoder,
  decodeText,
  detectEncodingCandidates,
  detectTextEncoding,
  isBinarySample,
  readHeadSample,
  type TextDecoderStream
} from './encoding'

/**
 * 主进程内的文本读取流：句柄与增量解码器留在主进程，按块拉取。
 * 编辑器 IPC 与 AI read 工具共用这一实现；本模块不依赖 ipcMain，
 * 因此可以在主进程内部直接使用，不经过渲染进程往返。
 *
 * 编码语义由 encoding.ts 统一提供：打开时按 BOM / jschardet 自动识别，
 * 也可由调用方指定（编辑器手动切换编码）；BOM 作为编码标记剥离，不进入文本。
 */

/** 单块读取字节数：16 MB 一次，1 GB 文件约 64 块，减少 IPC 与行扫描次数 */
export const TEXT_CHUNK_BYTES = 16 * 1024 * 1024

/** 文本流失败原因：调用方负责把原因转成自己的提示文案 */
export class TextStreamError extends Error {
  readonly reason: 'binary' | 'not-file'
  readonly path: string

  constructor(reason: 'binary' | 'not-file', path: string) {
    super(`${reason}: ${path}`)
    this.name = 'TextStreamError'
    this.reason = reason
    this.path = path
  }
}

/** 打开流时的编码选项 */
export interface TextStreamOptions {
  /** 调用方指定的编码（手动切换编码时使用）；缺省时按文件头自动识别 */
  encoding?: TextEncodingId
}

/**
 * 打开一个文本读取流：只取句柄与大小，内容按块拉取。
 * 二进制与非普通文件在读块 / 打开时抛 {@link TextStreamError}。
 */
export class TextFileStream {
  readonly path: string
  readonly size: number
  /** 本次读取使用的编码：自动识别或调用方指定 */
  readonly encoding: TextEncodingId
  /** 自动识别的候选编码（第一条为实际采用）：状态栏菜单据此标注最可能的编码 */
  readonly candidates: EncodingCandidate[]
  /**
   * 是否为调用方手动指定的编码。
   * 手动指定时不再用 NUL 采样判二进制：用户明确要求按该编码解释，
   * 即使解出乱码也由用户自己切换回来（与 VS Code 的 Reopen with Encoding 一致）。
   */
  private readonly manualEncoding: boolean
  private readonly handle: FileHandle
  private readonly decoder: TextDecoderStream
  private position = 0
  private sampledBytes = 0
  private closed = false

  private constructor(
    handle: FileHandle,
    decoder: TextDecoderStream,
    path: string,
    size: number,
    encoding: TextEncodingId,
    candidates: EncodingCandidate[],
    manualEncoding: boolean
  ) {
    this.handle = handle
    this.decoder = decoder
    this.path = path
    this.size = size
    this.encoding = encoding
    this.candidates = candidates
    this.manualEncoding = manualEncoding
  }

  /**
   * 打开流；目录、设备文件等非普通文件在这里拒绝。
   * @param path 绝对路径
   * @param options 编码选项
   */
  static async open(path: string, options: TextStreamOptions = {}): Promise<TextFileStream> {
    const handle = await fs.open(path, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile()) {
        throw new TextStreamError('not-file', path)
      }
      // 采样只读一次：编码识别与候选标注共用同一段文件头字节
      const sample = await readHeadSample(handle, info.size)
      const encoding = options.encoding ?? detectTextEncoding(sample)
      return new TextFileStream(
        handle,
        createTextDecoder(encoding),
        path,
        info.size,
        encoding,
        detectEncodingCandidates(sample),
        options.encoding !== undefined
      )
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  /** 拉取下一块解码文本；读到末尾（或读失败）时自行释放句柄 */
  async readChunk(): Promise<TextStreamChunk> {
    if (this.position >= this.size) {
      // 空文件或已到末尾：刷出解码器残余后自动释放
      const text = this.flush()
      await this.close()
      return { text, done: true, bytesRead: 0 }
    }
    try {
      const length = Math.min(TEXT_CHUNK_BYTES, this.size - this.position)
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await this.handle.read(buffer, 0, length, this.position)
      if (bytesRead === 0) {
        // 文件在读取期间被截断：按读完处理
        const text = this.flush()
        await this.close()
        return { text, done: true, bytesRead: 0 }
      }
      const chunk = buffer.subarray(0, bytesRead)
      this.assertTextSample(chunk)
      const text = this.decode(chunk)
      this.position += bytesRead
      if (this.position >= this.size) {
        const tail = this.flush()
        await this.close()
        return { text: text + tail, done: true, bytesRead }
      }
      return { text, done: false, bytesRead }
    } catch (error) {
      // 任何中途失败都先释放句柄，再把原因交给调用方
      await this.close()
      throw error
    }
  }

  /** 按块遍历整份文本；正常结束与异常都会释放句柄 */
  async *chunks(): AsyncGenerator<string> {
    try {
      for (;;) {
        const chunk = await this.readChunk()
        if (chunk.text.length > 0) {
          yield chunk.text
        }
        if (chunk.done) {
          return
        }
      }
    } finally {
      await this.close()
    }
  }

  /** 释放句柄；重复调用无副作用 */
  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    await this.handle.close().catch(() => undefined)
  }

  /**
   * 二进制采样：只看文件头 8 KB 内的 NUL，命中即拒绝。
   * 手动指定编码时不参与判定；自动识别时 UTF-16 的 NUL 是内容字节，同样跳过。
   */
  private assertTextSample(chunk: Buffer): void {
    if (this.manualEncoding || this.sampledBytes >= BINARY_SAMPLE_BYTES) {
      return
    }
    const sample = chunk.subarray(
      0,
      Math.min(chunk.length, BINARY_SAMPLE_BYTES - this.sampledBytes)
    )
    if (isBinarySample(sample, this.encoding)) {
      throw new TextStreamError('binary', this.path)
    }
    this.sampledBytes += sample.length
  }

  /** 增量解码一块字节；跨块不完整的序列由解码器缓存 */
  private decode(chunk: Buffer): string {
    return this.decoder.write(chunk)
  }

  /** 收尾时把解码器里残留的不完整序列刷出来 */
  private flush(): string {
    if (this.closed) {
      return ''
    }
    return this.decoder.end()
  }
}

/**
 * 整文件读取的解码基准：与流式路径共用同一套二进制与编码语义，
 * 保证小文件整读和大文件流式读对同一份内容给出一样的结果。
 * @param buffer 文件原始字节
 * @param path 仅用于错误信息的展示路径
 * @param encoding 调用方指定的编码；缺省时自动识别
 */
export function decodeWholeText(
  buffer: Uint8Array,
  path: string,
  encoding?: TextEncodingId
): string {
  const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SAMPLE_BYTES))
  const effective = encoding ?? detectTextEncoding(sample)
  // 手动指定编码时尊重用户选择，不再用 NUL 采样拒绝
  if (encoding === undefined && isBinarySample(sample, effective)) {
    throw new TextStreamError('binary', path)
  }
  return decodeText(buffer, effective)
}
