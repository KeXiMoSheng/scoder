/** AiSessionHistory 组件的对外类型定义 */

import type { AiSession } from '../../hooks/useAiSessions'

export interface AiSessionHistoryProps {
  /** 全部会话（组件内部按最后活动时间倒序展示） */
  sessions: AiSession[]
  /** 当前激活会话 id（选中行高亮） */
  activeId: string | null
  /** 点击某行：切换到该会话 */
  onSelect: (id: string) => void
  /** 删除某个会话（磁盘日志一并删除，主进程会先弹确认框） */
  onDelete: (id: string) => void
  /** 导出某个会话的 jsonl 日志（主进程弹出目录选择框并复制文件） */
  onExport: (id: string) => void
  /** 批量导出选中的会话（目录选择框只弹一次，与单条导出同一套参数） */
  onExportMany: (ids: string[]) => void
  /** 请求关闭弹层（点击外部或按 Esc） */
  onClose: () => void
}
