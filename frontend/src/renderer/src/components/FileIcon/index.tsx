import { getFileIconUrl } from '../../lib/fileIcon'
import { cn } from '../../lib/utils'
import type { FileIconProps } from './types'

/** 按文件名解析并渲染文件图标；未匹配到的类型回退到通用文件图标 */
export default function FileIcon({ name, size = 14, className }: FileIconProps): React.JSX.Element {
  return (
    <img
      src={getFileIconUrl(name)}
      width={size}
      height={size}
      className={cn('shrink-0 select-none', className)}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
