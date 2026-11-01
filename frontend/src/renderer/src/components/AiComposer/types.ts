/** AiComposer 组件的对外类型定义 */

export interface AiComposerProps {
  /** 没有可用会话时禁用输入与发送 */
  disabled?: boolean
  /** 当前会话正在执行：允许继续输入，但禁止并发发送 */
  running?: boolean
  /** 发送一条消息（已去除首尾空白且非空）与选中的模型主键 */
  onSend: (text: string, modelConfigId: number) => void
}
