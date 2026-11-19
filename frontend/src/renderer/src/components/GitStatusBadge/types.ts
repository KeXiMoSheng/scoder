/** GitStatusBadge 组件的对外类型定义 */
import type { GitFileStatus } from '@shared/git/types'

export interface GitStatusBadgeProps {
  /** 要展示的 Git 状态 */
  status: GitFileStatus
  /** 覆盖默认的外边距等样式（例如放在已有 gap 的行尾容器里） */
  className?: string
}
