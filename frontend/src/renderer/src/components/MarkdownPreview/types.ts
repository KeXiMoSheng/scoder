/** MarkdownPreview 组件的对外类型定义 */

export interface MarkdownPreviewProps {
  /** Markdown 源文本：文件内容或 AI 助手输出 */
  content: string
  /** 相对图片路径的基准目录（通常是 Markdown 文件所在目录） */
  basePath?: string
  /** 工作区根目录：AI 输出与文档行内代码里的相对路径优先按它解析 */
  workspaceRoot?: string | null
  /**
   * 点击正文中的文件路径时触发（如 `frontend/src/main/powershell.ts`）。
   * line 为路径后缀解析出的目标行号；endLine 存在时表示需要选中 line-endLine 的行范围。
   * 未提供时不把路径标记为可点击。
   */
  onOpenFile?: (path: string, line?: number, endLine?: number) => void
  /**
   * 排版变体：
   * - document：文件预览，正文限宽居中、留白充足
   * - message：AI 消息等窄容器，全宽、紧凑留白
   */
  variant?: 'document' | 'message'
  /** 追加到滚动容器上的类名（尺寸、边框由调用方控制） */
  className?: string
}
