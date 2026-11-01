/** AiChatPanel 组件的对外类型定义 */

export interface AiChatPanelProps {
  /** 当前会话 id；null 表示没有可用会话 */
  sessionId: string | null
  /** 当前项目根目录（AI 工具的工作区边界） */
  cwd: string | null
  /** 没有可用会话时禁用输入 */
  disabled: boolean
  /** 消息列表为空时的提示文案 */
  emptyHint: string
  /** 用户发出消息后的回调：用于更新会话标题与活动时间 */
  onUserSend: (text: string) => void
}
