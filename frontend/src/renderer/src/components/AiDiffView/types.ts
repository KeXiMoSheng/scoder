/** AiDiffView 组件的对外类型定义 */

export interface AiDiffViewProps {
  /** 会话 id：diff 基线与具体会话绑定 */
  sessionId: string
  /** 改动所属轮次 */
  turn: number
  /** 相对工作区根的文件路径（展示与基线查询用） */
  path: string
  /** 文件绝对路径（读取当前内容用） */
  absolutePath: string
  /** 当前工作区根；null 时无法读取基线 */
  cwd: string | null
  /** 文件是否有未保存修改：有修改时拒绝操作会覆盖用户输入，需要禁用 */
  dirty: boolean
  /** 关闭 diff 视图，回到普通编辑器 */
  onClose: () => void
  /** 基线不可用或文件无法读取时，退回普通编辑器打开该文件 */
  onOpenFile: (path: string) => void
}
