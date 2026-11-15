import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { isTextEncodingId, type TextEncodingId } from '../../shared/files/encoding'
import { FILES_CHANNELS } from '../../shared/files/events'
import type { TextWriteOpenResult } from '../../shared/files/types'
import { bomBytesFor, detectFileEncoding, encodeText } from './encoding'

/**
 * 文本文件的流式写入：大文件按块写入同目录临时文件，
 * 完成后 fsync + rename 原子替换目标，避免整串字符串与半截落盘。
 * 与项目内 writeTextAtomic 的约定一致：同目录临时文件、发布前落盘、失败清理。
 */

/** 一次尚未写完的写入会话；生命周期由发起保存的窗口持有 */
interface TextWriteSession {
  handle: FileHandle
  targetPath: string
  tempPath: string
  ownerId: number
  /** 原文件权限（存在时用它在发布前恢复） */
  mode: number | undefined
  /** 原文件编码：保存时按同一编码写回，不把 UTF-16 静默改成 UTF-8 */
  encoding: TextEncodingId
  /** 已写入的字节数 */
  position: number
}

const sessions = new Map<string, TextWriteSession>()
/** 已挂过 destroyed 监听的窗口，避免重复注册 */
const watchedSenderIds = new Set<number>()

/** 放弃并清理一个写入会话：关闭句柄并删除临时文件，目标文件不受影响 */
async function abortSession(writeId: string): Promise<void> {
  const session = sessions.get(writeId)
  if (!session) {
    return
  }
  sessions.delete(writeId)
  await session.handle.close().catch(() => undefined)
  await fs.rm(session.tempPath, { force: true }).catch(() => undefined)
}

/** 窗口销毁时清理其名下全部写入会话，避免残留临时文件 */
function abortOwnerSessions(ownerId: number): void {
  for (const [writeId, session] of sessions) {
    if (session.ownerId === ownerId) {
      void abortSession(writeId)
    }
  }
}

/** 应用退出前清理全部写入会话（窗口销毁事件未必先到） */
export function disposeAllFileWrites(): void {
  for (const writeId of [...sessions.keys()]) {
    void abortSession(writeId)
  }
}

/** 首次打开写入会话时挂上窗口销毁监听 */
function watchSender(sender: WebContents): void {
  const id = sender.id
  if (watchedSenderIds.has(id)) {
    return
  }
  watchedSenderIds.add(id)
  sender.once('destroyed', () => {
    watchedSenderIds.delete(id)
    abortOwnerSessions(id)
  })
}

/** 校验渲染进程传来的编码；非法值直接拒绝，未传时返回 undefined */
function parseEncoding(encoding: unknown): TextEncodingId | undefined {
  if (encoding === undefined) {
    return undefined
  }
  if (!isTextEncodingId(encoding)) {
    throw new Error('文件编码无效')
  }
  return encoding
}

/** 向渲染进程提供大文件分块保存：打开写流、追加块、完成或放弃 */
export function registerFileWriteHandlers(): void {
  ipcMain.handle(
    FILES_CHANNELS.openWriteStream,
    async (event, filePath: string, encoding?: unknown): Promise<TextWriteOpenResult> => {
      if (typeof filePath !== 'string') {
        throw new Error('文件路径无效')
      }
      // 编辑器会传入当前记录的编码；未传时（如旧调用方）按目标文件自动识别
      const requested = parseEncoding(encoding) ?? (await detectFileEncoding(filePath))
      const directory = dirname(filePath)
      await fs.mkdir(directory, { recursive: true })
      // 目标已存在时保留原权限；不存在则沿用临时文件的 0600
      let mode: number | undefined
      try {
        const info = await fs.stat(filePath)
        if (!info.isFile()) {
          throw new Error(`不是普通文件，无法保存：${filePath}`)
        }
        mode = info.mode & 0o777
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
      const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
      const handle = await fs.open(tempPath, 'wx', 0o600)
      // BOM 是文件头的一部分，先写它再追加正文；UTF-16 没有 BOM 就无法与二进制区分
      const bom = bomBytesFor(requested)
      let position = 0
      if (bom !== null) {
        const { bytesWritten } = await handle.write(bom, 0, bom.length, 0)
        position = bytesWritten
      }
      const writeId = randomUUID()
      sessions.set(writeId, {
        handle,
        targetPath: filePath,
        tempPath,
        ownerId: event.sender.id,
        mode,
        encoding: requested,
        position
      })
      watchSender(event.sender)
      return { writeId }
    }
  )

  ipcMain.handle(
    FILES_CHANNELS.appendWriteChunk,
    async (_event, writeId: string, text: string): Promise<void> => {
      const session = typeof writeId === 'string' ? sessions.get(writeId) : undefined
      if (!session) {
        throw new Error('写入会话不存在或已结束，请重新保存')
      }
      if (typeof text !== 'string') {
        throw new Error('写入内容无效')
      }
      try {
        const buffer = encodeText(text, session.encoding)
        const { bytesWritten } = await session.handle.write(
          buffer,
          0,
          buffer.length,
          session.position
        )
        session.position += bytesWritten
      } catch (error) {
        await abortSession(writeId)
        throw error
      }
    }
  )

  ipcMain.handle(
    FILES_CHANNELS.finishWriteStream,
    async (_event, writeId: string): Promise<void> => {
      const session = typeof writeId === 'string' ? sessions.get(writeId) : undefined
      if (!session) {
        throw new Error('写入会话不存在或已结束，请重新保存')
      }
      try {
        // 先落盘再发布：否则断电后 rename 成功但内容还在页缓存里
        await session.handle.sync()
        await session.handle.close()
        if (session.mode !== undefined) {
          await fs.chmod(session.tempPath, session.mode)
        }
        await fs.rename(session.tempPath, session.targetPath)
        sessions.delete(writeId)
      } catch (error) {
        await abortSession(writeId)
        throw error
      }
    }
  )

  ipcMain.handle(
    FILES_CHANNELS.abortWriteStream,
    async (_event, writeId: string): Promise<void> => {
      if (typeof writeId !== 'string') {
        return
      }
      await abortSession(writeId)
    }
  )
}
