/** SessionChangesPanel 组件的对外类型定义 */
import type { AiMessageView } from '@shared/ai/types'

export interface SessionChangesPanelProps {
  /** 当前会话的全部消息：从中聚合整场会话改动过的文件 */
  messages: readonly AiMessageView[]
  /** 当前工作区根：读取审查进度用 */
  cwd: string | null
  /** 当前会话 id：读取审查进度用 */
  sessionId: string | null
  /** 审查进度变更信号：变化时重新拉取 reviews.json */
  reviewsVersion: number
  /** 点击文件行：打开该文件在本会话最早一轮的 diff 审查 */
  onOpenChange: (path: string, turn: number) => void
}
