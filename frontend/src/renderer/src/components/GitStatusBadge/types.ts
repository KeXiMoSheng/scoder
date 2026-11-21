/** GitStatusBadge 组件的对外类型定义 */
import type { GitFileStatus } from '@shared/git/types'

/** 标记形态：文件用字母，目录用圆点（目录是子孙状态的聚合，没有单一字母含义） */
export type GitStatusBadgeVariant = 'letter' | 'dot'

export interface GitStatusBadgeProps {
  /** 要展示的 Git 状态 */
  status: GitFileStatus
  /** 展示形态，默认字母；目录传 dot */
  variant?: GitStatusBadgeVariant
  /** 覆盖默认的外边距等样式（例如放在已有 gap 的行尾容器里） */
  className?: string
}
