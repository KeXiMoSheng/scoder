/** McpServerCard 组件的对外类型定义 */

import type { McpProbeResult, McpServerConfig, McpServerView } from '@shared/mcp/types'

/** 卡片上正在进行中的操作，用于禁用对应按钮 */
export interface McpServerCardBusy {
  probing: boolean
  restarting: boolean
  /** 启用/停用或保存后等待状态回推 */
  toggling: boolean
  deleting: boolean
}

export interface McpServerCardProps {
  view: McpServerView
  /** 最近一次「测试连接」的结果，未测过时为 null */
  probe: McpProbeResult | null
  busy: McpServerCardBusy
  onEdit: (server: McpServerConfig) => void
  onDelete: (server: McpServerConfig) => void
  onProbe: (server: McpServerConfig) => void
  onRestart: (server: McpServerConfig) => void
  onToggle: (server: McpServerConfig, enabled: boolean) => void
}
