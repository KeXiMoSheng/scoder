import { GIT_DIRECTORY_STATUS_LABEL, GIT_STATUS_META } from '../../lib/gitStatus'
import { cn } from '../../lib/utils'
import type { GitStatusBadgeProps } from './types'

/**
 * Git 状态标记：文件行、编辑器页签与 AI 变更清单共用的行尾字母。
 * 目录传 variant="dot"，改用同色圆点表示「目录内存在变化」。
 * 颜色来自主题的 editorGutter.*Background（见 lib/theme.ts）。
 *
 * 字母与文件名同字号、同字体（字号和字体族都继承所在行），只加粗笔画；
 * 固定 16px 高的 flex 盒子保证字母在文件树 24px 行里垂直居中。
 */
export default function GitStatusBadge({
  status,
  variant = 'letter',
  className
}: GitStatusBadgeProps): React.JSX.Element {
  const mark = GIT_STATUS_META[status]
  const isDot = variant === 'dot'
  return (
    <span
      className={cn(
        'ml-1 inline-flex h-4 w-3.5 shrink-0 items-center justify-center',
        isDot ? undefined : 'leading-none font-bold',
        mark.className,
        className
      )}
      title={isDot ? GIT_DIRECTORY_STATUS_LABEL[status] : mark.label}
    >
      {isDot ? (
        <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      ) : (
        mark.letter
      )}
    </span>
  )
}
