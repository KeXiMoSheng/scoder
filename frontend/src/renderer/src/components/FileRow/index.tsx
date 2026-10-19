import { cn } from '../../lib/utils'
import FileIcon from '../FileIcon'
import type { FileRowProps } from './types'

/**
 * 文件行内容层：图标 + 文件名 + 行尾插槽。
 * 只负责内容排布；行高、选中/hover、拖拽等容器行为由调用方决定，
 * 以便文件树、编辑器页签等不同容器复用同一套视觉。
 */
export default function FileRow({
  name,
  icon,
  trailing,
  children,
  className
}: FileRowProps): React.JSX.Element {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {icon === null ? null : (
        <span className="inline-flex w-4 shrink-0 items-center justify-center">
          {icon ?? <FileIcon name={name} />}
        </span>
      )}
      {children ?? (
        <>
          <span className="min-w-0 truncate">{name}</span>
          {trailing ? <span className="inline-flex shrink-0 items-center">{trailing}</span> : null}
        </>
      )}
    </span>
  )
}
