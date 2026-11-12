import { DEFAULT_CONTEXT_WINDOW } from '../../shared/ai/context'
import type { AiContextUsage, AiTokenUsage } from '../../shared/ai/types'
import type { SessionEvent } from './session/types'

/**
 * 把服务商返回的一次调用用量换算成面板展示的上下文用量。
 * 直接使用 total_tokens（输入 + 输出）：输出会进入下一次请求，同样占用上下文窗口。
 * @param usage 服务商返回的原始 token 计数
 * @param limitTokens 当前模型配置的上下文窗口上限
 */
export function toContextUsage(
  usage: AiTokenUsage,
  limitTokens: number = DEFAULT_CONTEXT_WINDOW
): AiContextUsage {
  return { usedTokens: usage.totalTokens, limitTokens }
}

/**
 * 从会话日志里取最后一次模型调用返回的真实用量。
 * 只认服务商写入的 step/end.usage：旧日志或供应商没返回 usage 时保持 0，不做任何估算。
 * @param events 按 seq 排好的事件
 * @param limitTokens 展示用的窗口上限；由调用方按会话使用的模型配置决定
 */
export function lastContextUsage(
  events: readonly SessionEvent[],
  limitTokens: number = DEFAULT_CONTEXT_WINDOW
): AiContextUsage {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'step/end' && event.data.usage) {
      return toContextUsage(event.data.usage, limitTokens)
    }
  }
  return { usedTokens: 0, limitTokens }
}
