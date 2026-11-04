/** AiComposer 组件的对外类型定义 */
import type { AiAttachment, AiContextUsage } from '@shared/ai/types'

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
  /** 已附加、等待随下一条消息发送的上下文（路径 + 类型，选中行含内容） */
  attachments: readonly AiAttachment[]
  /** 移除一个已附加的上下文 */
  onRemoveAttachment: (attachment: AiAttachment) => void
  /** 点击附件图标/名称在编辑器中打开对应文件（目录不跳转） */
  onOpenFile: (path: string) => void
  /** 发送一条消息（已去除首尾空白且非空）、选中的模型主键与随行附件 */
  onSend: (text: string, modelConfigId: number, attachments: readonly AiAttachment[]) => void
}
