/**
 * 粘贴图片入库：把渲染进程读到的 base64 变成图片存储里的对象。
 *
 * 两处调用共用它：粘贴时先入库（这样草稿里的标签已经能点开预览），
 * 以及发送时把附件正式写进会话日志 —— 内容寻址让第二次写入直接命中同一个对象。
 */
import { MAX_PASTED_IMAGE_BYTES } from '../../../shared/ai/attachments'
import { MAX_SOURCE_BYTES, formatBytes, prepareImageForModel } from './prepare'
import { readImageFacts } from './probe'
import { saveToolImage, toolImagePreviewPath } from './store'
import type { ToolImageRef } from './types'

/** 粘贴图片的字节上限：两个上限取小，避免两处口径走偏 */
const MAX_PASTE_BYTES = Math.min(MAX_PASTED_IMAGE_BYTES, MAX_SOURCE_BYTES)

/** 一次粘贴入库的结果：会话日志用的引用 + 预览时打开的文件路径 */
export interface StagedPastedImage {
  ref: ToolImageRef
  /** 编辑器预览用的绝对路径；正常情况下是带原文件名的别名 */
  previewPath?: string
}

/**
 * 校验并保存一张粘贴的图片。
 * 格式与尺寸以字节为准（浏览器给的 MIME 只做初步过滤）。
 * @param name 展示名，同时决定预览页签的名字
 * @param data base64 字节（不含 data: 前缀）
 * @returns 图片引用与预览路径
 * @throws Error 内容为空、不是合法 base64、格式不支持或超出限额
 */
export async function stagePastedImage(name: string, data: string): Promise<StagedPastedImage> {
  if (data.length === 0) {
    throw new Error(`粘贴的图片「${name}」内容为空`)
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.byteLength === 0) {
    throw new Error(`粘贴的图片「${name}」不是合法的 base64 数据`)
  }
  if (bytes.byteLength > MAX_PASTE_BYTES) {
    throw new Error(
      `粘贴的图片「${name}」有 ${formatBytes(bytes.byteLength)}，超过单张 ${formatBytes(MAX_PASTE_BYTES)} 的上限`
    )
  }
  const facts = readImageFacts(bytes)
  if (!facts) {
    throw new Error(`粘贴的图片「${name}」不是受支持的格式（PNG/JPEG/WebP/GIF）`)
  }
  const prepared = prepareImageForModel(bytes, facts)
  const ref = await saveToolImage(prepared, name)
  return { ref, previewPath: toolImagePreviewPath(ref) }
}
