/** MarkdownPreview 组件的对外类型定义 */

export interface MarkdownPreviewProps {
  /** Markdown 源文本：文件内容或 AI 助手输出 */
  content: string
  /** 相对图片路径的基准目录（通常是 Markdown 文件所在目录） */
  basePath?: string
  /**
   * 排版变体：
   * - document：文件预览，正文限宽居中、留白充足
   * - message：AI 消息等窄容器，全宽、紧凑留白
   */
  variant?: 'document' | 'message'
  /** 追加到滚动容器上的类名（尺寸、边框由调用方控制） */
  className?: string
}
