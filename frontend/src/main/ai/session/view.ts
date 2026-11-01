/**
 * 展示层转换：把磁盘上的事件序列整理成渲染进程直接可用的消息条目。
 *
 * 与 store.ts 的重放（生成给模型的 ChatMessage）刻意分开：
 * - store 关心“模型看到什么”，不包含展示卡片；
 * - 这里关心“用户看到什么”，文本与工具卡片分段，结果回填到对应调用上。
 */
import type { AiMessageView, ToolCardView } from '../../../shared/ai/types'
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

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const text = textOf(event.data.content)
        if (text.length > 0) {
          views.push({ kind: 'user', id: `user-${event.seq}`, time: event.time, text })
        }
        break
      }
      case 'assistant/message': {
        const text = textOf(event.data.content)
        if (text.length > 0) {
          views.push({ kind: 'assistant', id: `assistant-${event.seq}`, time: event.time, text })
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
 * @param blocks 内容块数组
 */
export function textOf(blocks: readonly SessionBlock[]): string {
  return blocks
    .filter((block): block is Extract<SessionBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
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
