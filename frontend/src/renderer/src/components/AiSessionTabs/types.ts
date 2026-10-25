/** AiSessionTabs 组件的对外类型定义 */

import type { AiSession } from '../../hooks/useAiSessions'

export interface AiSessionTabsProps {
  /** 全部会话（按创建顺序） */
  sessions: AiSession[]
  /** 当前激活会话 id */
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  /** 请求重命名（由父级弹出输入框） */
  onRename: (id: string) => void
}

/** 标签右键菜单状态：显示坐标（视口坐标系）与目标会话 id */
export interface SessionTabMenuState {
  x: number
  y: number
  id: string
}
