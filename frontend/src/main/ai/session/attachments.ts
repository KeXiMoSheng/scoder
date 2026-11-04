/**
 * 用户附加的上下文：把渲染进程传来的附件整理成可入库的内容块。
 *
 * 约定：file/directory 只保留路径与类型，不读取文件内容；
 * 只有 kind 为 selection 的附件携带用户在编辑器中选中的行文本。
 * 路径仍走工作区文件系统解析，保证展示路径与工具看到的一致，并挡住越界路径。
 */
import { attachmentKey } from '../../../shared/ai/attachments'
import type { AiAttachment } from '../../../shared/ai/types'
import type { FileSystemService } from '../fs/service'
import type { SessionBlock } from './types'

/** 单条选中行附件允许携带的最大字符数：超出部分截断，剩余内容交给模型用 read 续读 */
const MAX_SELECTION_CHARS = 20_000

/**
 * 把附件转成会话日志里的内容块。
 * @param fs 本轮工作区文件系统（负责边界校验与展示路径生成）
 * @param attachments 渲染进程传来的附件；重复附件自动忽略
 */
export async function toAttachmentBlocks(
  fs: FileSystemService,
  attachments: readonly AiAttachment[] | undefined
): Promise<SessionBlock[]> {
  const blocks: SessionBlock[] = []
  const seen = new Set<string>()
  for (const attachment of attachments ?? []) {
    const key = attachmentKey(attachment)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)

    // 越界或已不存在的路径仍保留用户给的绝对路径：不读取内容，只作为上下文提示
    let path = attachment.path
    try {
      path = (await fs.resolve(attachment.path)).displayPath
    } catch {
      // 解析失败时沿用原始路径
    }

    if (attachment.kind === 'selection') {
      const text = attachment.text ?? ''
      if (text.length === 0) {
        continue
      }
      const startLine = attachment.startLine ?? 1
      blocks.push({
        type: 'attachment',
        path,
        kind: 'selection',
        startLine,
        endLine: attachment.endLine ?? startLine,
        text: clipSelection(text)
      })
    } else {
      blocks.push({ type: 'attachment', path, kind: attachment.kind })
    }
  }
  return blocks
}

/** 限制选中文本长度：截断时保留一句提示，模型可以继续用 read 读取完整文件 */
function clipSelection(text: string): string {
  if (text.length <= MAX_SELECTION_CHARS) {
    return text
  }
  return `${text.slice(0, MAX_SELECTION_CHARS)}\n…（选中内容过长，已截断，可继续用 read 读取其余部分）`
}
