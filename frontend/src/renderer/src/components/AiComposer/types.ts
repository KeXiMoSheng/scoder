/** AiComposer 组件的对外类型定义 */

export interface AiComposerProps {
  /** 没有可用会话时禁用输入与发送 */
  disabled?: boolean
  /** 发送一条消息（已去除首尾空白且非空） */
  onSend: (text: string) => void
}
