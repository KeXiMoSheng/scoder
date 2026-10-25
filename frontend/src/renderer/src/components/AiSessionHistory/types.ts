/** AiSessionHistory 组件的对外类型定义 */

import type { AiSession } from '../../hooks/useAiSessions'

export interface AiSessionHistoryProps {
  /** 全部会话（组件内部按最后活动时间倒序展示） */
  sessions: AiSession[]
  /** 当前激活会话 id（选中行高亮） */
  activeId: string | null
  /** 点击某行：切换到该会话 */
  onSelect: (id: string) => void
  /** 请求关闭弹层（点击外部或按 Esc） */
  onClose: () => void
}
