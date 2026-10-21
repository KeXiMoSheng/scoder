/** PromptDialog 组件的对外类型定义 */

export interface PromptDialogProps {
  /** 对话框标题 */
  title: string
  /** 输入框占位提示 */
  placeholder?: string
  /** 确认按钮文案，默认「创建」 */
  confirmLabel?: string
  /** 输入框初始值 */
  defaultValue?: string
  /** 点击确认或回车时回调（值已去首尾空白；为空时不触发） */
  onConfirm: (value: string) => void
  /** 取消回调：Esc、点击遮罩或取消按钮触发 */
  onCancel: () => void
}
