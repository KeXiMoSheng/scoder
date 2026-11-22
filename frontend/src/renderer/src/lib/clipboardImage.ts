/**
 * 剪切板图片：把一次 Ctrl+V 变成可以随消息发送的附件。
 *
 * 只处理「剪贴板里有图片」的情况：纯文本、富文本原样交给输入框的默认粘贴，
 * 因此复制一段代码再粘贴不会被吞掉。图片格式与体积在这里先挡一道，
 * 主进程仍会按字节重新识别（浏览器给的 MIME 只用于初筛）。
 *
 * 每张图读完就交给主进程入库：图片存储返回可打开的预览路径，
 * 于是草稿里的图片标签和文件标签一样能点开编辑器预览。
 */
import {
  MAX_PASTED_IMAGE_BYTES,
  MAX_PASTED_IMAGES,
  PASTED_IMAGE_MEDIA_TYPES
} from '@shared/ai/attachments'
import type { AiAttachment } from '@shared/ai/types'
import { formatBytes } from './bytes'

/** 一次粘贴的结果：成功附加的图片或一句可展示的拒绝原因 */
export interface PasteResult {
  attachments: AiAttachment[]
  /** 没能附加时的提示；成功时缺省 */
  error?: string
}

/** 读取文件的 data URL 前缀 → 去掉前缀的 base64 字节 */
function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? '' : dataUrl.slice(comma + 1)
}

/** 粘贴序号：跨多次粘贴递增，保证展示名（也就是去重键）唯一 */
let pasteSequence = 0

/** 格式对应的扩展名：展示名要能看出是什么图片 */
function extensionOf(mediaType: string): string {
  switch (mediaType) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    default:
      return 'img'
  }
}

/** 从一个文件读出 base64 字节；读取失败时抛出可读错误 */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`读取剪贴板图片失败：${file.name || '未命名'}`))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('读取剪贴板图片失败'))
        return
      }
      resolve(base64Of(result))
    }
    reader.readAsDataURL(file)
  })
}

/**
 * 从粘贴事件里同步取出图片文件。
 * 同步是必须的：输入框要在事件回调里立刻决定是否 preventDefault，
 * 否则浏览器会先把图片当成默认内容粘进输入框。
 * @param event 输入框的粘贴事件
 * @returns 剪贴板里的受支持图片文件；没有图片时为空数组
 */
export function clipboardImageFiles(event: ClipboardEvent): File[] {
  const files: File[] = []
  for (const item of event.clipboardData?.items ?? []) {
    if (item.kind !== 'file') {
      continue
    }
    if (!(PASTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(item.type)) {
      continue
    }
    const file = item.getAsFile()
    if (file !== null) {
      files.push(file)
    }
  }
  return files
}

/**
 * 把剪贴板图片读成待发送附件。
 *
 * 规则：
 * - 超出数量或体积上限 → 不附加任何图片，只返回一条提示；
 * - 同一张图重复粘贴不会去重：它们会作为两张独立的图片进入同一次请求，
 *   由用户在发送前自己决定删哪张。
 * @param files 由 {@link clipboardImageFiles} 取出的图片文件
 * @param currentCount 当前已经附加的图片张数
 */
export async function attachmentsFromImages(
  files: readonly File[],
  currentCount: number
): Promise<PasteResult> {
  if (files.length === 0) {
    return { attachments: [] }
  }
  const room = MAX_PASTED_IMAGES - currentCount
  if (room <= 0) {
    return { attachments: [], error: `一条消息最多粘贴 ${MAX_PASTED_IMAGES} 张图片` }
  }
  if (files.length > room) {
    return {
      attachments: [],
      error: `一次最多再粘贴 ${room} 张图片（单条消息上限 ${MAX_PASTED_IMAGES} 张）`
    }
  }
  const attachments: AiAttachment[] = []
  pasteSequence += 1
  const suffix = pasteSequence
  for (const [index, file] of files.entries()) {
    if (file.size > MAX_PASTED_IMAGE_BYTES) {
      return {
        attachments: [],
        error: `图片 ${formatBytes(file.size)} 超过单张 ${formatBytes(MAX_PASTED_IMAGE_BYTES)} 的上限`
      }
    }
    const name = `粘贴的图片-${suffix}-${index + 1}.${extensionOf(file.type)}`
    const data = await readFileAsBase64(file)
    // 先入库再上屏：主进程返回可打开的预览路径，草稿里的标签已经能点开编辑器预览
    const staged = await window.api.ai.stageImage({ name, mediaType: file.type, data })
    attachments.push({
      kind: 'image',
      path: name,
      mediaType: staged.mediaType,
      data,
      image: {
        mediaType: staged.mediaType,
        width: staged.width,
        height: staged.height,
        bytes: staged.bytes,
        previewPath: staged.previewPath
      }
    })
  }
  return { attachments }
}
