/** McpServerForm 组件的对外类型定义 */

import type { McpServerConfig, McpServerInput } from '@shared/mcp/types'

export interface McpServerFormProps {
  /** 编辑已有配置时传入；新建时为 null */
  initial: McpServerConfig | null
  /** 提交表单：校验与落库由调用方完成，抛错时表单展示原因 */
  onSubmit: (input: McpServerInput) => Promise<void>
  /** 返回列表 */
  onCancel: () => void
}
