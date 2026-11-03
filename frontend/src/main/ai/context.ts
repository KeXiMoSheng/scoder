import { DEFAULT_CONTEXT_WINDOW } from '../../shared/ai/context'
import type { AiContextUsage, AiTokenUsage } from '../../shared/ai/types'
import type { SessionEvent } from './session/types'

/**
 * 把服务商返回的一次调用用量换算成面板展示的上下文用量。
 * 直接使用 total_tokens（输入 + 输出）：输出会进入下一次请求，同样占用上下文窗口。
 * @param usage 服务商返回的原始 token 计数
 */
export function toContextUsage(usage: AiTokenUsage): AiContextUsage {
  return { usedTokens: usage.totalTokens, limitTokens: DEFAULT_CONTEXT_WINDOW }
}

/**
 * 从会话日志里取最后一次模型调用返回的真实用量。
 * 只认服务商写入的 step/end.usage：旧日志或供应商没返回 usage 时保持 0，不做任何估算。
 * @param events 按 seq 排好的事件
 */
export function lastContextUsage(events: readonly SessionEvent[]): AiContextUsage {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'step/end' && event.data.usage) {
      return toContextUsage(event.data.usage)
    }
  }
  return { usedTokens: 0, limitTokens: DEFAULT_CONTEXT_WINDOW }
}
