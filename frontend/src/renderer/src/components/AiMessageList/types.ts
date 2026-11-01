/** AiMessageList 组件的对外类型定义 */

import type { AiMessageView } from '@shared/ai/types'

export interface AiMessageListProps {
  /** 按发生顺序排列的消息条目（历史 + 本轮实时） */
  messages: AiMessageView[]
  /** 正在执行一轮对话：列表底部显示生成中提示 */
  running: boolean
  /** 最近一次错误；null 表示无错误 */
  error: string | null
  /** 没有任何消息时显示的提示文案 */
  emptyHint: string
}
