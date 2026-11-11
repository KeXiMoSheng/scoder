/** ToolCallRow 组件的对外类型定义 */

import type { AiMessageView } from '@shared/ai/types'

export interface ToolCallRowProps {
  /** 一条工具调用消息（实时事件或日志重放） */
  message: Extract<AiMessageView, { kind: 'tool' }>
  /** 当前工作区根：摘要里的绝对路径转成相对路径展示 */
  cwd?: string | null
  /** 点击摘要里的文件路径：打开该文件 */
  onOpenFile: (path: string) => void
}
