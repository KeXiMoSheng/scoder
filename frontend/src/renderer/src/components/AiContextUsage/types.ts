/** AiContextUsage 组件的对外类型定义 */
import type { AiContextUsage } from '@shared/ai/types'

export interface AiContextUsageProps {
  /** 当前上下文用量；null 表示尚未载入 */
  usage: AiContextUsage | null
  /** 是否有可用的项目：没有项目时无法新建会话 */
  canCreate: boolean
  /** 点击面板里的「新建会话」 */
  onCreateSession: () => void
}
