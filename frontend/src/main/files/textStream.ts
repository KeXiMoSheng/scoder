import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import type { TextStreamChunk } from '../../shared/files/types'

/**
 * 主进程内的文本读取流：句柄与增量解码器留在主进程，按块拉取。
 * 编辑器 IPC 与 AI read 工具共用这一实现；本模块不依赖 ipcMain，
 * 因此可以在主进程内部直接使用，不经过渲染进程往返。
 */

/** 单块读取字节数：16 MB 一次，1 GB 文件约 64 块，减少 IPC 与行扫描次数 */
export const TEXT_CHUNK_BYTES = 16 * 1024 * 1024

/** 二进制判定只采样文件头 8 KB 中的 NUL（与上游 harness 一致） */
export const BINARY_SAMPLE_BYTES = 8192

/** 文本流失败原因：调用方负责把原因转成自己的提示文案 */
export class TextStreamError extends Error {
  readonly reason: 'binary' | 'not-utf8' | 'not-file'
  readonly path: string

  constructor(reason: 'binary' | 'not-utf8' | 'not-file', path: string) {
    super(`${reason}: ${path}`)
    this.name = 'TextStreamError'
    this.reason = reason
    this.path = path
  }
}

/** 打开流时的编码选项 */
export interface TextStreamOptions {
  /**
   * 是否保留 BOM 字符。
   * 编辑器需要原样保留（保存时不能丢 BOM）；AI 读取按上游 harness 语义剥离。
   */
  preserveBom?: boolean
}

/**
 * 打开一个文本读取流：只取句柄与大小，内容按块拉取。
 * 编码失败（非法 UTF-8）与二进制判定都在读块时抛 {@link TextStreamError}。
 */
export class TextFileStream {
  readonly path: string
  readonly size: number
  private readonly handle: FileHandle
  private readonly decoder: TextDecoder
  private position = 0
  private sampledBytes = 0
  private closed = false

  private constructor(handle: FileHandle, decoder: TextDecoder, path: string, size: number) {
    this.handle = handle
    this.decoder = decoder
    this.path = path
    this.size = size
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
      const decoder = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: options.preserveBom === true
      })
      return new TextFileStream(handle, decoder, path, info.size)
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

  /** 二进制采样：只看文件头 8 KB 内的 NUL，命中即拒绝 */
  private assertTextSample(chunk: Buffer): void {
    if (this.sampledBytes >= BINARY_SAMPLE_BYTES) {
      return
    }
    const sample = chunk.subarray(
      0,
      Math.min(chunk.length, BINARY_SAMPLE_BYTES - this.sampledBytes)
    )
    if (sample.includes(0)) {
      throw new TextStreamError('binary', this.path)
    }
    this.sampledBytes += sample.length
  }

  /** 增量解码一块字节；非法 UTF-8 由 fatal 解码器直接抛出 */
  private decode(chunk: Buffer): string {
    try {
      return this.decoder.decode(chunk, { stream: true })
    } catch {
      throw new TextStreamError('not-utf8', this.path)
    }
  }

  /** 收尾时把解码器里残留的不完整序列刷出来 */
  private flush(): string {
    if (this.closed) {
      return ''
    }
    try {
      return this.decoder.decode()
    } catch {
      throw new TextStreamError('not-utf8', this.path)
    }
  }
}

/**
 * 整文件读取的解码基准：与流式路径共用同一套二进制与编码语义，
 * 保证小文件整读和大文件流式读对同一份内容给出一样的结果。
 * @param buffer 文件原始字节
 * @param path 仅用于错误信息的展示路径
 */
export function decodeWholeText(buffer: Uint8Array, path: string): string {
  const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SAMPLE_BYTES))
  if (sample.includes(0)) {
    throw new TextStreamError('binary', path)
  }
  try {
    // 默认不 ignoreBOM：BOM 作为编码标记剥离，不进入文本
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new TextStreamError('not-utf8', path)
  }
}
