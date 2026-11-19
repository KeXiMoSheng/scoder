import { GIT_STATUS_META } from '../../lib/gitStatus'
import { cn } from '../../lib/utils'
import type { GitStatusBadgeProps } from './types'

/**
 * Git 状态标记：文件行、编辑器页签与 AI 变更清单共用的行尾字母。
 * 颜色来自主题的 editorGutter.*Background（见 lib/theme.ts）。
 */
export default function GitStatusBadge({
  status,
  className
}: GitStatusBadgeProps): React.JSX.Element {
  const mark = GIT_STATUS_META[status]
  return (
    <span
      className={cn(
        'ml-1 w-3 shrink-0 text-center font-mono text-[10px] font-medium',
        mark.className,
        className
      )}
      title={mark.label}
    >
      {mark.letter}
    </span>
  )
}
