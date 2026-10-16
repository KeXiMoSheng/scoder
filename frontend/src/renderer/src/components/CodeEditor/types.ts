/** CodeEditor 组件的对外类型定义 */

import type { Ref } from 'react'
import type { OpenedFile } from '../../hooks/useOpenedFiles'

/** 暴露给 App 的命令式接口（通过 ref 调用） */
export interface CodeEditorHandle {
  /** 保存指定路径及其子路径下所有有未保存修改的文件；任一保存失败时抛错（用于移动/重命名前落盘） */
  saveDirtyUnder: (path: string) => Promise<void>
  /** 丢弃指定路径及其子路径的模型缓存（条目被重命名/移动后调用，避免旧路径残留） */
  dropCachedUnder: (path: string) => void
}

export interface CodeEditorProps {
  /** 当前激活的标签文件（由标签栏切换）；null 表示没有打开任何文件 */
  file: OpenedFile | null
  /** 未保存状态变化通知（按文件绝对路径归属） */
  onDirtyChange: (path: string, dirty: boolean) => void
  ref?: Ref<CodeEditorHandle>
}

/** 读取或保存失败的文件及原因（按路径归属，切换文件后旧错误不再展示） */
export interface LoadFailure {
  path: string
  message: string
}
