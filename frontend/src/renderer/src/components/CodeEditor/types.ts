/** CodeEditor 组件的对外类型定义 */

import type { Ref } from 'react'
import type { AiAttachment } from '@shared/ai/types'
import type { EncodingCandidate, TextEncodingId } from '@shared/files/encoding'
import type { OpenedFile } from '../../hooks/useOpenedFiles'

/** 当前激活文件的编码（上报给 App 的底部状态栏） */
export interface EditorEncodingState {
  /** 文件绝对路径：切换标签后旧文件的编码不再展示 */
  path: string
  encoding: TextEncodingId
  /** 自动识别的候选编码（按可能性降序）：状态栏菜单据此标注最可能的编码 */
  candidates: readonly EncodingCandidate[]
}

/** 暴露给 App 的命令式接口（通过 ref 调用） */
export interface CodeEditorHandle {
  /** 保存指定路径及其子路径下所有有未保存修改的文件；任一保存失败时抛错（用于移动/重命名前落盘） */
  saveDirtyUnder: (path: string) => Promise<void>
  /** 丢弃指定路径及其子路径的模型缓存（条目被重命名/移动后调用，避免旧路径残留） */
  dropCachedUnder: (path: string) => void
  /** 以指定编码重新读取当前文件（手动切换编码）；有未保存修改时先弹确认框 */
  reopenWithEncoding: (encoding: TextEncodingId) => void
}

/** 打开文件后定位到指定行（Markdown 正文里的路径跳转） */
export interface EditorRevealRequest {
  /** 目标文件绝对路径 */
  path: string
  /** 目标行号（1 起；越界时收敛到首/末行） */
  line: number
  /** 行号范围的结束行（包含）：存在时选中 line-endLine，缺省时只定位单行 */
  endLine?: number
  /** 递增信号：同一文件同一行重复请求也能再次定位 */
  nonce: number
}

export interface CodeEditorProps {
  /** 当前激活的标签文件（由标签栏切换）；null 表示没有打开任何文件 */
  file: OpenedFile | null
  /** 未保存状态变化通知（按文件绝对路径归属） */
  onDirtyChange: (path: string, dirty: boolean) => void
  /** 把编辑器中选中的整行发送给 AI（附当前文件路径、行号与选中文本） */
  onSendSelectionToAi: (attachment: AiAttachment) => void
  /** 磁盘上的文件被删除/重命名后，用户确认关闭标签：外层负责关闭标签并清理缓存 */
  onDeletedFromDisk?: (path: string) => void
  /** 打开系统配置的「编辑器」分区（超限提示里的「调整大小上限」） */
  onOpenEditorSettings?: () => void
  /** 重新检查令牌：从设置页返回后递增，用于重新判定当前文件是否超限 */
  recheckToken?: number
  /** 当前激活文件的编码变化（自动识别或手动切换）；没有文本文件时回传 null */
  onEncodingChange?: (state: EditorEncodingState | null) => void
  /** 工作区根目录：Markdown 预览里相对路径的解析基准 */
  workspaceRoot?: string | null
  /** Markdown 预览里点击文件路径：打开对应文件并定位到目标行（endLine 存在时选中行范围） */
  onOpenFile?: (path: string, line?: number, endLine?: number) => void
  /** 打开文件后定位到指定行（App 在点击 Markdown 路径后设置） */
  revealRequest?: EditorRevealRequest | null
  ref?: Ref<CodeEditorHandle>
}

/** 读取或保存失败的文件及原因（按路径归属，切换文件后旧错误不再展示） */
export interface LoadFailure {
  path: string
  message: string
}

/** 流式加载进度（按路径归属，切换文件后旧进度不再展示） */
export interface FileLoadProgress {
  /** 正在加载的文件绝对路径 */
  path: string
  /** 已读取字节数 */
  loaded: number
  /** 文件总字节数；0 表示空文件或尚未拿到大小 */
  total: number
}

/** 流式保存进度（按路径归属，切换文件后旧进度不再展示） */
export interface FileSaveProgress {
  /** 正在保存的文件绝对路径 */
  path: string
  /** 已写入的字符数 */
  written: number
  /** 文件总字符数 */
  total: number
}

/** 体积超过编辑器上限的文件：只提示不读取，用户可选择临时继续打开或调整配置 */
export interface OversizeFile {
  /** 文件绝对路径 */
  path: string
  /** 文件字节数 */
  size: number
  /** 当前配置的上限（MB） */
  limit: number
}

/** 带预览能力的文档（Markdown / SVG）的三档视图：仅编辑 / 编辑与预览分栏 / 仅预览 */
export type PreviewViewMode = 'edit' | 'split' | 'preview'
