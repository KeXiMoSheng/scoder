/** 用户附加上下文的去重规则：主进程入库与渲染进程待发送列表共用同一份实现 */
import type { AiAttachmentView } from './types'

/** 一条消息最多能粘贴的图片数：多张图会一起进入同一次请求，上限同时也是费用保护 */
export const MAX_PASTED_IMAGES = 6

/** 单张粘贴图片的字节上限：与 read_image 的源文件上限保持一致 */
export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024

/** 允许粘贴的图片格式：与 read_image / 模型端支持的格式一致 */
export const PASTED_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
] as const

/**
 * 附件的去重键：同类型、同路径、同选区范围视为同一个附件。
 * 同一文件的完整文件附件与选中行附件是两条不同上下文，键里必须带 kind。
 * @param attachment 附件（或展示用附件）
 */
export function attachmentKey(attachment: AiAttachmentView): string {
  return [
    attachment.kind,
    attachment.path,
    attachment.startLine ?? 0,
    attachment.endLine ?? 0
  ].join('\u0000')
}
