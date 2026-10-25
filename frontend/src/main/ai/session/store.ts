import type { ChatMessage } from '../llm/openai'

/**
 * 会话历史存储（P0 仅内存）。
 * 保存完整消息序列（含 system 与工具结果），下一轮直接复用，避免模型丢失上下文。
 * P1 改为追加式事件日志并落 SQLite（scoder.db 的 user_version 递增），
 * 这样进程重启后仍能恢复对话与工具卡片。
 */
export class SessionStore {
  private readonly sessions = new Map<string, ChatMessage[]>()

  /** 读取会话历史；未知会话返回空数组（调用方不得原地修改返回值） */
  history(sessionId: string): ChatMessage[] {
    return [...(this.sessions.get(sessionId) ?? [])]
  }

  /** 用最新完整序列覆盖会话历史：每步结束调用，异常中断也能保留已发生的工具结果 */
  replace(sessionId: string, messages: ChatMessage[]): void {
    this.sessions.set(sessionId, [...messages])
  }

  /** 清空某个会话（UI 上的“新对话”） */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
