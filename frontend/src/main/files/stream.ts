import { randomUUID } from 'crypto'
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { FILES_CHANNELS } from '../../shared/files/events'
import type { TextStreamChunk, TextStreamOpenResult } from '../../shared/files/types'
import { TextFileStream, TextStreamError } from './textStream'

/**
 * 文本文件的流式读取（编辑器 IPC 侧）：渲染进程按块拉取并增量灌入 Monaco model，
 * 全程不生成整份大字符串，因此不受 V8 单字符串长度上限（0x1fffffe8）约束。
 * 会话与编解码实现在 textStream.ts，与 AI read 工具共用同一份实现。
 */

/** 一次尚未读完的文本流；生命周期由打开它的窗口持有 */
interface TextStreamSession {
  stream: TextFileStream
  /** 打开会话的 webContents.id，窗口销毁时据此回收 */
  ownerId: number
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
  await session.stream.close()
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
    void session.stream.close()
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
  if (error instanceof TextStreamError) {
    return new Error(`不是普通文件，无法打开：${filePath}`)
  }
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

/** 把读块失败转成可读原因 */
function chunkError(error: unknown, filePath: string): Error {
  if (error instanceof TextStreamError) {
    return error.reason === 'binary'
      ? new Error(`二进制文件不支持在编辑器中打开：${filePath}`)
      : new Error(`文件不是 UTF-8 文本，无法在编辑器中打开：${filePath}`)
  }
  return error instanceof Error ? error : new Error(`读取文件失败：${filePath}`)
}

/** 向渲染进程提供文本流式读取：打开会话、逐块拉取、提前释放 */
export function registerFileStreamHandlers(): void {
  ipcMain.handle(
    FILES_CHANNELS.openTextStream,
    async (event, filePath: string): Promise<TextStreamOpenResult> => {
      if (typeof filePath !== 'string') {
        throw new Error('文件路径无效')
      }
      let stream: TextFileStream
      try {
        // 编辑器要原样保存，BOM 作为内容保留，不在解码阶段剥离
        stream = await TextFileStream.open(filePath, { preserveBom: true })
      } catch (error) {
        throw openError(filePath, error)
      }
      const streamId = randomUUID()
      sessions.set(streamId, { stream, ownerId: event.sender.id })
      watchSender(event.sender)
      return { streamId, size: stream.size }
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
        const chunk = await session.stream.readChunk()
        // 读完的流已自行释放句柄，会话表同步移除
        if (chunk.done) {
          sessions.delete(streamId)
        }
        return chunk
      } catch (error) {
        // 任何中途失败都先释放句柄，再把原因交给渲染进程
        sessions.delete(streamId)
        throw chunkError(error, session.stream.path)
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
