/** ModelConfigForm 组件的对外类型定义 */

import type { ModelConfig, ModelConfigInput } from '@shared/model-config/types'

export interface ModelConfigFormProps {
  /** 编辑时传入原记录；null 表示新建 */
  initial: ModelConfig | null
  /** 提交表单：由调用方负责落库，抛错时表单展示错误信息 */
  onSubmit: (input: ModelConfigInput) => Promise<void>
  /** 取消编辑，回到模型列表 */
  onCancel: () => void
}
