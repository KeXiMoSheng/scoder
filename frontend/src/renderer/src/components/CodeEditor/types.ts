/** CodeEditor 组件的对外类型定义 */

import type { Ref } from 'react'
import type { AiAttachment } from '@shared/ai/types'
import type { OpenedFile } from '../../hooks/useOpenedFiles'

/** 暴露给 App 的命令式接口（通过 ref 调用） */
export interface CodeEditorHandle {
  /** 保存指定路径及其子路径下所有有未保存修改的文件；任一保存失败时抛错（用于移动/重命名前落盘） */
  saveDirtyUnder: (path: string) => Promise<void>
  /** 丢弃指定路径及其子路径的模型缓存（条目被重命名/移动后调用，避免旧路径残留） */
  dropCachedUnder: (path: string) => void
  /**
   * 磁盘上的文件被外部（AI 写工具）改后，重新载入编辑器缓存。
   * 文件未打开、或缓冲区有未保存修改时保持现状，不覆盖用户输入。
   */
  reloadFromDisk: (path: string) => void
}

export interface CodeEditorProps {
  /** 当前激活的标签文件（由标签栏切换）；null 表示没有打开任何文件 */
  file: OpenedFile | null
  /** 未保存状态变化通知（按文件绝对路径归属） */
  onDirtyChange: (path: string, dirty: boolean) => void
  /** 把编辑器中选中的整行发送给 AI（附当前文件路径、行号与选中文本） */
  onSendSelectionToAi: (attachment: AiAttachment) => void
  ref?: Ref<CodeEditorHandle>
}

/** 读取或保存失败的文件及原因（按路径归属，切换文件后旧错误不再展示） */
export interface LoadFailure {
  path: string
  message: string
}

/** 带预览能力的文档（Markdown / SVG）的三档视图：仅编辑 / 编辑与预览分栏 / 仅预览 */
export type PreviewViewMode = 'edit' | 'split' | 'preview'
