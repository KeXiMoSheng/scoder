/** ModelSelector 组件的对外类型定义 */
import type { ModelConfig } from '@shared/model-config/types'
import type { ModelCallSettingsValue } from '../ModelCallSettings/types'

export interface ModelSelectorProps {
  /** 全部可用模型配置 */
  models: ModelConfig[]
  /** 当前选中的模型主键；null 表示尚无选中项 */
  selectedModelId: number | null
  /** 用户点选某一行模型时触发（单选） */
  onSelect: (id: number) => void
  /** 保存某个模型的调用设置；抛错时面板内展示错误信息 */
  onUpdateModel: (id: number, settings: ModelCallSettingsValue) => Promise<void>
}
