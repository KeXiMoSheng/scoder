/** FileRow 组件的对外类型定义 */

import type { ReactNode } from 'react'

export interface FileRowProps {
  /** 文件名：用于默认图标解析与文本展示 */
  name: string
  /**
   * 图标节点：缺省时按文件名解析文件图标；
   * 传 null 表示不显示图标（文件夹等自定义图标直接传节点）
   */
  icon?: ReactNode
  /** 行尾附加内容（脏点、关闭按钮、变更状态等） */
  trailing?: ReactNode
  /** 自定义主内容（如重命名输入框）；提供时替代文件名与行尾内容 */
  children?: ReactNode
  /** 附加到内容容器的样式（例如覆盖行内间距） */
  className?: string
}
