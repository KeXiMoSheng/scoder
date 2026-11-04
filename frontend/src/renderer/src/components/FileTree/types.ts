/** FileTree 组件的对外类型定义 */

import type { MoveHandler, RenameHandler } from 'react-arborist'
import type { FileEntry } from '@shared/files/types'

/** 文件树节点：以绝对路径为唯一标识；目录的 children 初始为空数组表示尚未加载 */
export interface FileNode extends FileEntry {
  children?: FileNode[]
}

export interface FileTreeProps {
  /** 项目根目录绝对路径（变化时组件以 key 重挂载，全部状态自然重置） */
  rootPath: string
  /** 当前在编辑器中打开的文件路径 */
  selectedPath: string | null
  /** 有未保存修改的文件路径集合（显示脏标记圆点） */
  dirtyPaths: ReadonlySet<string>
  /** 单击文件：把绝对路径交给外部在编辑器中打开 */
  onSelectFile: (path: string) => void
  /** 外部（AI 写工具）改动磁盘后的刷新信号：值变化即重读已加载目录，不重挂载 */
  refreshToken?: number
  /** 条目被重命名/移动前调用（例如先把脏缓冲区落盘）；抛错则中止本次操作 */
  onBeforeEntryMove: (path: string) => Promise<void>
  /** 条目重命名/移动完成后调用（oldPath → newPath） */
  onEntryMoved: (oldPath: string, newPath: string) => void
  /** 条目删除完成后调用（path 为被删除的条目路径） */
  onEntryDeleted: (path: string) => void
  /** 把文件或目录作为上下文发送给 AI（添加到右侧输入区）；目录只提供路径与类型 */
  onSendToAi: (path: string, isDirectory: boolean) => void
  /**
   * 外部（编辑器标签）请求在文件树中定位某文件：路径 + 递增信号。
   * 每次 nonce 变化触发一次定位，同一路径重复请求也能生效。
   */
  revealRequest?: { path: string; nonce: number } | null
}

/** react-arborist 处理器为函数类型，取参数对象类型便于解构 */
export type MoveArgs<T> = Parameters<MoveHandler<T>>[0]
export type RenameArgs<T> = Parameters<RenameHandler<T>>[0]

/** 名称搜索的结果状态（term 记录对应的查询词，与当前输入不一致时视为尚未产出结果） */
export interface SearchState {
  term: string
  entries: FileNode[]
  truncated: boolean
  /** 失败原因；null 表示搜索成功 */
  error: string | null
}

/** 右键菜单状态：显示坐标（视口坐标系）、目标节点路径与是否为目录 */
export interface ContextMenuState {
  x: number
  y: number
  path: string
  isDirectory: boolean
}
