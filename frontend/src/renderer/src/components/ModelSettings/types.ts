/** ModelSettings 组件的对外类型定义 */

import type { ModelConfig } from '@shared/model-config/types'

/** 模型设置的编辑状态：null 表示列表视图，create 表示新建，edit 携带原记录 */
export type ModelEditorState = { mode: 'create' } | { mode: 'edit'; config: ModelConfig } | null
