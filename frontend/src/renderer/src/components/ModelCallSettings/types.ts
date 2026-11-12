/** 调用设置（上下文窗口与思考深度）的对外类型定义 */
import type {
  ModelConfig,
  ModelContextWindow,
  ModelReasoningEffort
} from '@shared/model-config/types'

/** 一次保存提交的调用参数 */
export interface ModelCallSettingsValue {
  contextWindow: ModelContextWindow
  reasoningEffort: ModelReasoningEffort
}

/** 两组单选项的表单：作用于单个模型 */
export interface CallSettingsFieldsProps {
  model: ModelConfig
  onSave: (id: number, settings: ModelCallSettingsValue) => Promise<void>
}
