/** EditorTabs 组件的对外类型定义 */

import type { OpenedFile } from '../../hooks/useOpenedFiles'

export interface EditorTabsProps {
  /** 已打开的文件（按打开顺序） */
  files: OpenedFile[]
  /** 当前激活文件路径 */
  activePath: string | null
  /** 有未保存修改的文件路径集合（显示脏标记） */
  dirtyPaths: ReadonlySet<string>
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onCloseOthers: (path: string) => void
  onCloseToRight: (path: string) => void
  onCloseAll: () => void
  /** 当前项目根目录绝对路径（计算相对路径用）；未打开项目时为 null */
  projectPath: string | null
  /** 在文件树（资源管理器视图）中定位并高亮该文件 */
  onReveal: (path: string) => void
  /** 把标签对应的文件作为附件发送给 AI（添加到右侧输入区） */
  onSendToAi: (path: string) => void
}

/** 标签右键菜单状态：显示坐标（视口坐标系）与目标文件路径 */
export interface TabMenuState {
  x: number
  y: number
  path: string
}
