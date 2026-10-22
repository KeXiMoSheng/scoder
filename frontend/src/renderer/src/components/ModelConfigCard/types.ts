/** ModelConfigCard 组件的对外类型定义 */

import type { ModelConfig } from '@shared/types'

export interface ModelConfigCardProps {
  /** 卡片展示的模型配置 */
  config: ModelConfig
  /** 进入编辑表单 */
  onEdit: (config: ModelConfig) => void
  /** 删除该配置（主进程会弹出确认框） */
  onDelete: (config: ModelConfig) => void
}
