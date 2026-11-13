/** MessageDialog 组件的对外类型定义 */

/** 对话框底部的按钮：primary 使用强调色，其余为次按钮 */
export interface MessageDialogAction {
  /** 按钮文案 */
  label: string
  /** 是否为主按钮 */
  primary?: boolean
  /** 点击动作；通常由调用方同时关闭对话框 */
  onClick: () => void
}

export interface MessageDialogProps {
  /** 标题栏文案 */
  title: string
  /** 正文：一句话说明结果 */
  message: string
  /** 补充信息（如导出路径、错误原因）；缺省时不占位 */
  detail?: string
  /** 语气：error 时正文使用危险色 */
  tone?: 'info' | 'error'
  /** 右下角按钮，按数组顺序从左到右排列 */
  actions: MessageDialogAction[]
  /** 请求关闭对话框（Esc、点击遮罩或按钮自行调用） */
  onClose: () => void
}
