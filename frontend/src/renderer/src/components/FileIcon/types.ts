/** FileIcon 组件的对外类型定义 */

export interface FileIconProps {
  /** 文件名（含扩展名），用于解析语言图标 */
  name: string
  /** 图标槽边长（px）；字体字号按 VS Code 主题的 150% 放大以完整显示 */
  size?: number
  /** 附加样式类 */
  className?: string
}
