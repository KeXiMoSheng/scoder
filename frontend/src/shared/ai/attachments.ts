/** 用户附加上下文的去重规则：主进程入库与渲染进程待发送列表共用同一份实现 */
import type { AiAttachmentView } from './types'

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
