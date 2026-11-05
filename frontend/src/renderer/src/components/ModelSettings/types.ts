/** ModelSettings 组件的对外类型定义 */

import type { ModelConfig } from '@shared/model-config/types'

/** 模型设置的编辑状态：null 表示列表视图，create 表示新建，edit 携带原记录 */
export type ModelEditorState = { mode: 'create' } | { mode: 'edit'; config: ModelConfig } | null

/** 模型列表区的对外 props */
export interface ModelSettingsProps {
  /** 打开「一键导入模型」分区 */
  onOpenImport: () => void
}
