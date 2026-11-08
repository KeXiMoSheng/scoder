/**
 * 展示层转换：把磁盘上的事件序列整理成渲染进程直接可用的消息条目。
 *
 * 与 store.ts 的重放（生成给模型的 ChatMessage）刻意分开：
 * - store 关心“模型看到什么”，不包含展示卡片；
 * - 这里关心“用户看到什么”，文本与工具卡片分段，结果回填到对应调用上。
 */
import { mergeFileChange } from '../../../shared/ai/changes'
import { attachmentKey } from '../../../shared/ai/attachments'
import type {
  AiAttachmentView,
  AiMessageView,
  ToolCardView,
  ToolFileChange
} from '../../../shared/ai/types'
import type { SessionBlock, SessionEvent } from './types'

/** 由工具名与原始参数推导挂起卡片；历史日志里没有结果卡片时用它兜底 */
export type ToolCallDescriber = (name: string, rawArguments: string) => ToolCardView | undefined

/**
 * 把事件序列整理成展示条目。
 * 规则：
 * - 用户消息、助手文本段、工具卡片按发生顺序排列；
 * - 工具结果按 callId 回填到对应卡片，不单独成条；
 * - 空文本的助手消息（只调了工具）不产生文本条目。
 * @param events 按 seq 排好的事件
 * @param describe 生成挂起卡片的兜底函数（工具定义不在时可以为空）
 */
export function toMessageViews(
  events: readonly SessionEvent[],
  describe?: ToolCallDescriber
): AiMessageView[] {
  const views: AiMessageView[] = []
  /** callId → 卡片在 views 里的下标，用于结果回填 */
  const toolIndex = new Map<string, number>()
  /** 本轮改动清单：turn → 路径 → 统计 */
  const turnChanges = new Map<number, Map<string, ToolFileChange>>()

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const text = textOf(event.data.content)
        const attachments = attachmentsOf(event.data.content)
        if (text.length > 0 || attachments.length > 0) {
          views.push({
            kind: 'user',
            id: `user-${event.seq}`,
            time: event.time,
            text,
            ...(attachments.length > 0 ? { attachments } : {})
          })
        }
        break
      }
      case 'assistant/message': {
        const text = textOf(event.data.content)
        if (text.length > 0) {
          views.push({
            kind: 'assistant',
            id: `assistant-${event.seq}`,
            time: event.time,
            text,
            // 被用户中止打断的消息：内容只是中断前已流出的前缀
            ...(event.data.interrupted ? { interrupted: true } : {})
          })
        }
        for (const block of event.data.content) {
          if (block.type !== 'tool-call') {
            continue
          }
          const card = describe?.(block.name, block.arguments)
          toolIndex.set(block.id, views.length)
          views.push({
            kind: 'tool',
            id: `tool-${event.seq}-${block.id}`,
            time: event.time,
            callId: block.id,
            name: block.name,
            arguments: block.arguments,
            status: 'pending',
            ...(card ? { card } : {})
          })
        }
        break
      }
      case 'tool/result': {
        const index = toolIndex.get(event.data.callId)
        if (index === undefined) {
          break
        }
        const current = views[index]
        if (current.kind !== 'tool') {
          break
        }
        // 优先用执行后推导的卡片；旧日志没有它时再用调用阶段的卡片 + 结果文本兜底
        const card = resultCard(event.data.card ?? current.card, event.data.name, event.data.text)
        views[index] = {
          ...current,
          status: 'done',
          ok: event.data.ok,
          resultText: event.data.text,
          ...(card ? { card } : {})
        }
        // 累积本轮改动，turn/end 时整理成清单
        const change = event.data.card?.change
        if (change) {
          let files = turnChanges.get(event.data.turn)
          if (!files) {
            files = new Map()
            turnChanges.set(event.data.turn, files)
          }
          files.set(change.path, mergeFileChange(files.get(change.path), change))
        }
        break
      }
      case 'turn/end': {
        const files = turnChanges.get(event.data.turn)
        turnChanges.delete(event.data.turn)
        if (files && files.size > 0) {
          views.push({
            kind: 'changes',
            id: `changes-${event.seq}`,
            time: event.time,
            files: [...files.values()]
          })
        }
        break
      }
      default:
        break
    }
  }
  return views
}

/**
 * 拼接内容块里的全部文本。
 * 与 store.ts 的重放共用：两处的“文本”定义必须一致。
 * 只取 text 块，用户附加的上下文不进入展示文本。
 * @param blocks 内容块数组
 */
export function textOf(blocks: readonly SessionBlock[]): string {
  return blocks
    .filter((block): block is Extract<SessionBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * 拼接发给模型的内容：文本块原样保留，附加的上下文展开成带类型的引用；
 * 只有 selection 会携带选中文本，file/directory 仅给出路径与类型。
 * 与 textOf 刻意分开：附件信息只进入上下文，不进入用户气泡正文。
 * @param blocks 内容块数组
 */
export function modelTextOf(blocks: readonly SessionBlock[]): string {
  const parts: string[] = []
  const attachments: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) {
        parts.push(block.text)
      }
    } else if (block.type === 'attachment') {
      attachments.push(attachmentOf(block))
    }
  }
  if (attachments.length > 0) {
    parts.push(
      `用户附加的上下文（file/directory 只给出路径与类型，需要内容时请用工具读取）：\n${attachments.join('\n')}`
    )
  }
  return parts.join('\n\n')
}

/** 把一条附件块渲染成模型可读的 XML 片段 */
function attachmentOf(block: Extract<SessionBlock, { type: 'attachment' }>): string {
  if (block.kind === 'selection') {
    const startLine = block.startLine ?? 1
    const endLine = block.endLine ?? startLine
    return `<attachment path="${block.path}" type="selection" lines="${startLine}-${endLine}">\n${block.text ?? ''}\n</attachment>`
  }
  return `<attachment path="${block.path}" type="${block.kind}" />`
}

/** 取出用户附加的上下文（供气泡展示）；同一附件只保留一份 */
export function attachmentsOf(blocks: readonly SessionBlock[]): AiAttachmentView[] {
  const attachments: AiAttachmentView[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    if (block.type !== 'attachment') {
      continue
    }
    const view: AiAttachmentView = {
      path: block.path,
      kind: block.kind,
      ...(block.kind === 'selection'
        ? { startLine: block.startLine ?? 1, endLine: block.endLine ?? block.startLine ?? 1 }
        : {})
    }
    const key = attachmentKey(view)
    if (!seen.has(key)) {
      seen.add(key)
      attachments.push(view)
    }
  }
  return attachments
}

/**
 * 结果卡片兜底。
 * 旧日志（或没有定义 presentResult 的工具）只存了结果文本，卡片没有正文；
 * 这种情况下用挂起卡片的标题加结果文本补一个，保证每个工具卡片都能展开。
 * @param base 调用阶段推导的卡片（可能只有标题）
 * @param name 工具名
 * @param text 结果文本
 */
function resultCard(
  base: ToolCardView | undefined,
  name: string,
  text: string
): ToolCardView | undefined {
  // 工具已经给出了带正文的卡片（如 read 的带行号窗口）：保持原样
  if (base?.body !== undefined && base.body.length > 0) {
    return base
  }
  // diff 卡片的信息在 hunks 里，不能被结果文本顶掉
  if (base?.hunks !== undefined && base.hunks.length > 0) {
    return base
  }
  // todo 卡片的信息在 todos 里，同样不能用结果文本顶掉
  if (base?.todos !== undefined) {
    return base
  }
  if (text.length === 0) {
    return base
  }
  return {
    kind: base?.kind ?? 'generic',
    title: base?.title ?? name,
    body: text,
    ...(base?.path ? { path: base.path } : {})
  }
}
