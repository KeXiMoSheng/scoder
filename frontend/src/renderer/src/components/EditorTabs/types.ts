/** EditorTabs 组件的对外类型定义 */

import type { BrowserTabState } from '@shared/browser/types'
import type { OpenedFile } from '../../hooks/useOpenedFiles'
import type { GitFileStatus } from '@shared/git/types'

export interface EditorTabsProps {
  /** 已打开的文件（按打开顺序） */
  files: OpenedFile[]
  /** 当前激活文件路径；浏览器页签激活时传 null */
  activePath: string | null
  /** AI 浏览器页签（按打开顺序，排在文件页签之后） */
  browserTabs: BrowserTabState[]
  /** 当前激活的浏览器页签所属会话；文件页签激活时为 null */
  activeBrowserSession: string | null
  /** 有未保存修改的文件路径集合（显示脏标记） */
  dirtyPaths: ReadonlySet<string>
  /** 工作区 Git 状态（绝对路径 → 状态），与文件树共用 App 的同一份快照 */
  gitStatuses: ReadonlyMap<string, GitFileStatus>
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onCloseOthers: (path: string) => void
  onCloseToRight: (path: string) => void
  onCloseAll: () => void
  /** 激活一个 AI 浏览器页签 */
  onActivateBrowser: (sessionId: string) => void
  /** 关闭一个 AI 浏览器页签（同时销毁页面） */
  onCloseBrowser: (sessionId: string) => void
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

/** 浏览器页签右键菜单状态：显示坐标与目标会话 */
export interface BrowserTabMenuState {
  x: number
  y: number
  sessionId: string
}

/** 「更多」下拉状态：显示坐标（视口坐标系），列表内容取当前被挤出的标签 */
export interface TabOverflowMenuState {
  x: number
  y: number
}
