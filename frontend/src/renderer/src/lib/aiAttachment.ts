/** 附件的展示辅助：输入区 chips 与会话气泡共用同一套命名规则 */
import type { AiAttachment, AiAttachmentView } from '@shared/ai/types'
import { basename, relativePath } from './filePath'

/**
 * 附件短名称：文件/目录取名称，选中行追加行号范围（如 foo.ts:10-20）。
 * 完整路径放在 title 中，避免 chip 过长。
 */
export function attachmentLabel(attachment: AiAttachmentView): string {
  const name = basename(attachment.path)
  if (attachment.kind !== 'selection') {
    return name
  }
  const startLine = attachment.startLine ?? 1
  return `${name}:${startLine}-${attachment.endLine ?? startLine}`
}

/** 选中行的行号标签（如 L10-20）；其他类型返回 null，供 chip 尾部展示 */
export function attachmentLineLabel(attachment: AiAttachmentView): string | null {
  if (attachment.kind !== 'selection') {
    return null
  }
  const startLine = attachment.startLine ?? 1
  return `L${startLine}-${attachment.endLine ?? startLine}`
}

/**
 * 把待发送附件转成展示对象，用于本地消息回显。
 * 文件/目录/选中行把绝对路径转成相对工作区根；粘贴的图片本来就没有工作区路径，
 * 原样保留展示名与预览信息（预览用内联 data URL，不必等主进程回包）。
 */
export function toAttachmentView(attachment: AiAttachment, cwd: string): AiAttachmentView {
  if (attachment.kind === 'image') {
    return {
      path: attachment.path,
      kind: 'image',
      ...(attachment.image === undefined ? {} : { image: attachment.image })
    }
  }
  const startLine = attachment.startLine ?? 1
  return {
    path: relativePath(attachment.path, cwd),
    kind: attachment.kind,
    ...(attachment.kind === 'selection'
      ? { startLine, endLine: attachment.endLine ?? startLine }
      : {})
  }
}
