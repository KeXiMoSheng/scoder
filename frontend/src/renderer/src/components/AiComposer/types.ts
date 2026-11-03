/** AiComposer 组件的对外类型定义 */
import type { AiContextUsage } from '@shared/ai/types'

export interface AiComposerProps {
  /** 没有可用会话时禁用输入与发送 */
  disabled?: boolean
  /** 当前会话正在执行：允许继续输入，但禁止并发发送 */
  running?: boolean
  /** 当前会话上下文用量；null 表示尚未载入 */
  usage: AiContextUsage | null
  /** 有打开的项目时才能新建会话 */
  canCreateSession: boolean
  /** 新建一个会话（上下文用量面板里的快捷入口） */
  onCreateSession: () => void
  /** 发送一条消息（已去除首尾空白且非空）与选中的模型主键 */
  onSend: (text: string, modelConfigId: number) => void
}
