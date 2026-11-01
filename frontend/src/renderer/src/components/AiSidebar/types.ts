/** AiSidebar 组件的对外类型定义 */

import type { AiSessionsApi } from '../../hooks/useAiSessions'

export interface AiSidebarProps {
  /** 面板宽度（px），由父级的拖拽分隔条控制 */
  width: number
  /** 会话状态（由 App 持有，侧边栏收起再展开时不丢标签与历史记录） */
  sessions: AiSessionsApi
  /** 当前打开的项目根目录：作为 AI 工具的工作区边界，未打开项目时为 null */
  cwd: string | null
}
