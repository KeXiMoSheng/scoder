/** SvgPreview 组件的对外类型定义 */

export interface SvgPreviewProps {
  /** SVG 源码（随编辑器内容实时更新） */
  content: string
  /** 追加到滚动容器上的类名（尺寸、边框由调用方控制） */
  className?: string
}
