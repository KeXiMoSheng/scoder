/** AiSidebar 组件的对外类型定义 */

import type { AiAttachment } from '@shared/ai/types'
import type { AiSessionsApi } from '../../hooks/useAiSessions'

export interface AiSidebarProps {
  /** 面板宽度（px），由父级的拖拽分隔条控制 */
  width: number
  /** 会话状态（由 App 持有，侧边栏收起再展开时不丢标签与历史记录） */
  sessions: AiSessionsApi
  /** 当前打开的项目根目录：作为 AI 工具的工作区边界，未打开项目时为 null */
  cwd: string | null
  /** 已附加、等待随下一条消息发送的上下文（路径 + 类型，选中行含内容） */
  attachments: readonly AiAttachment[]
  /** 移除一个已附加的上下文 */
  onRemoveAttachment: (attachment: AiAttachment) => void
  /** 消息发出后清空已附加内容 */
  onAttachmentsSent: () => void
  /** 点击附件打开对应文件；path 可能是绝对路径（待发送）或相对工作区根（历史消息） */
  onOpenFile: (path: string) => void
}
