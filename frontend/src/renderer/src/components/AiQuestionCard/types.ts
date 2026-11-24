/** AiQuestionCard 组件的对外类型定义 */
import type { AiMessageView, AiQuestionAnswer } from '@shared/ai/types'

export interface AiQuestionCardProps {
  /** 一次 ask_user_question 的工具消息（实时事件或日志重放） */
  message: Extract<AiMessageView, { kind: 'tool' }>
  /** 本轮是否仍在执行：只有执行中且还没收到结果的询问才接受作答 */
  active: boolean
  /**
   * 提交回答。主进程校验失败或询问已经结束时抛错，
   * 卡片就地展示错误并保持等待状态。
   */
  onAnswer: (answers: AiQuestionAnswer[]) => Promise<void>
}
