/** McpSettings 组件的对外类型定义 */

import type { McpServerConfig } from '@shared/mcp/types'

/**
 * 列表页与表单页之间的编辑态。
 * create 是新建，edit 带上被编辑的配置，null 表示停留在列表页。
 */
export type McpEditorState = { mode: 'create' } | { mode: 'edit'; server: McpServerConfig } | null
