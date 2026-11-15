import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { FILES_CHANNELS } from '../../shared/files/events'
import type { TextStreamChunk, TextStreamOpenResult } from '../../shared/files/types'

/**
 * 文本文件的流式读取：编辑器按块拉取并增量灌入 Monaco model，
 * 全程不生成整份大字符串，因此不受 V8 单字符串长度上限（0x1fffffe8）约束。
 * 句柄与增量解码器都留在主进程，跨块的多字节 UTF-8 字符不会被切断。
 */

/** 单块读取字节数：16 MB 一次，1 GB 文件约 64 块，减少 IPC 与 model 插入次数 */
const CHUNK_BYTES = 16 * 1024 * 1024

/** 二进制判定只采样文件头 8 KB 中的 NUL */
const BINARY_SAMPLE_BYTES = 8192

/** 一次尚未读完的文本流；生命周期由打开它的窗口持有 */
interface TextStreamSession {
  handle: FileHandle
  /** 增量解码器：分块喂入时保留不完整的 UTF-8 序列 */
  decoder: TextDecoder
  /** 打开会话的 webContents.id，窗口销毁时据此回收 */
  ownerId: number
  /** 下一个待读的文件偏移（字节） */
  position: number
  /** 打开时观测到的文件大小（快照；读完后不追读新增内容） */
  size: number
  /** 已完成 NUL 采样的字节数 */
  sampled: number
  /** 打开时的路径，仅用于错误信息 */
  path: string
}

const sessions = new Map<string, TextStreamSession>()
/** 已挂过 destroyed 监听的窗口，避免重复注册 */
const watchedSenderIds = new Set<number>()

/** 关闭并丢弃一个会话；句柄关闭失败不向调用方扩散 */
async function closeSession(streamId: string): Promise<void> {
  const session = sessions.get(streamId)
  if (!session) {
    return
  }
  sessions.delete(streamId)
  await session.handle.close().catch(() => undefined)
}

/** 窗口销毁时回收其名下全部会话，未读完的流不能留下悬挂句柄 */
function closeOwnerSessions(ownerId: number): void {
  for (const [streamId, session] of sessions) {
    if (session.ownerId === ownerId) {
      void closeSession(streamId)
    }
  }
}

/** 应用退出前释放全部会话（窗口销毁事件未必先到） */
export function disposeAllFileStreams(): void {
  for (const session of sessions.values()) {
    void session.handle.close().catch(() => undefined)
  }
  sessions.clear()
}

/** 首次打开会话时挂上窗口销毁监听 */
function watchSender(sender: WebContents): void {
  const id = sender.id
  if (watchedSenderIds.has(id)) {
    return
  }
  watchedSenderIds.add(id)
  sender.once('destroyed', () => {
    watchedSenderIds.delete(id)
    closeOwnerSessions(id)
  })
}

/** 把打开失败转成可读原因 */
function openError(filePath: string, error: unknown): Error {
  switch ((error as NodeJS.ErrnoException).code) {
    case 'ENOENT':
      return new Error(`文件不存在：${filePath}`)
    case 'EACCES':
    case 'EPERM':
      return new Error(`没有读取权限：${filePath}`)
    case 'EISDIR':
      return new Error(`这是一个目录，无法打开：${filePath}`)
    default:
      return error instanceof Error ? error : new Error(`打开文件失败：${filePath}`)
  }
}

/** 二进制采样：只看文件头 8 KB 内的 NUL，命中即拒绝在编辑器中打开 */
function assertTextSample(session: TextStreamSession, chunk: Buffer): void {
  if (session.sampled >= BINARY_SAMPLE_BYTES) {
    return
  }
  const sample = chunk.subarray(0, Math.min(chunk.length, BINARY_SAMPLE_BYTES - session.sampled))
  if (sample.includes(0)) {
    throw new Error(`二进制文件不支持在编辑器中打开：${session.path}`)
  }
  session.sampled += sample.length
}

/** 增量解码一块字节；非法 UTF-8 由 fatal 解码器直接抛出 */
function decodeChunk(session: TextStreamSession, chunk: Buffer): string {
  try {
    return session.decoder.decode(chunk, { stream: true })
  } catch {
    throw new Error(`文件不是 UTF-8 文本，无法在编辑器中打开：${session.path}`)
  }
}

/** 收尾时把解码器里残留的不完整序列刷出来 */
function flushDecoder(session: TextStreamSession): string {
  try {
    return session.decoder.decode()
  } catch {
    throw new Error(`文件不是 UTF-8 文本，无法在编辑器中打开：${session.path}`)
  }
}

/** 向渲染进程提供文本流式读取：打开会话、逐块拉取、提前释放 */
export function registerFileStreamHandlers(): void {
  ipcMain.handle(
    FILES_CHANNELS.openTextStream,
    async (event, filePath: string): Promise<TextStreamOpenResult> => {
      if (typeof filePath !== 'string') {
        throw new Error('文件路径无效')
      }
      let handle: FileHandle
      try {
        handle = await fs.open(filePath, 'r')
      } catch (error) {
        throw openError(filePath, error)
      }
      try {
        const info = await handle.stat()
        if (!info.isFile()) {
          throw new Error(`不是普通文件，无法打开：${filePath}`)
        }
        const streamId = randomUUID()
        sessions.set(streamId, {
          handle,
          // 与一次性读取保持一致：BOM 作为文本内容保留，不在解码阶段剥离
          decoder: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
          ownerId: event.sender.id,
          position: 0,
          size: info.size,
          sampled: 0,
          path: filePath
        })
        watchSender(event.sender)
        return { streamId, size: info.size }
      } catch (error) {
        await handle.close().catch(() => undefined)
        throw error
      }
    }
  )

  ipcMain.handle(
    FILES_CHANNELS.readTextStreamChunk,
    async (_event, streamId: string): Promise<TextStreamChunk> => {
      const session = typeof streamId === 'string' ? sessions.get(streamId) : undefined
      if (!session) {
        throw new Error('读取会话不存在或已结束，请重新打开文件')
      }
      try {
        if (session.position >= session.size) {
          // 空文件或已到末尾：刷出解码器残余后自动释放
          const text = flushDecoder(session)
          await closeSession(streamId)
          return { text, done: true, bytesRead: 0 }
        }
        const length = Math.min(CHUNK_BYTES, session.size - session.position)
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await session.handle.read(buffer, 0, length, session.position)
        if (bytesRead === 0) {
          // 文件在读取期间被截断：按读完处理
          const text = flushDecoder(session)
          await closeSession(streamId)
          return { text, done: true, bytesRead: 0 }
        }
        const chunk = buffer.subarray(0, bytesRead)
        assertTextSample(session, chunk)
        const text = decodeChunk(session, chunk)
        session.position += bytesRead
        if (session.position >= session.size) {
          const tail = flushDecoder(session)
          await closeSession(streamId)
          return { text: text + tail, done: true, bytesRead }
        }
        return { text, done: false, bytesRead }
      } catch (error) {
        // 任何中途失败都先释放句柄，再把原因交给渲染进程
        await closeSession(streamId)
        throw error instanceof Error ? error : new Error(`读取文件失败：${session.path}`)
      }
    }
  )

  ipcMain.handle(
    FILES_CHANNELS.closeTextStream,
    async (_event, streamId: string): Promise<void> => {
      if (typeof streamId !== 'string') {
        return
      }
      await closeSession(streamId)
    }
  )
}
