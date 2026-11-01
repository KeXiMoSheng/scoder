import { useCallback } from 'react'
import AiComposer from '../AiComposer'
import AiMessageList from '../AiMessageList'
import { useAiChat } from '../../hooks/useAiChat'
import type { AiChatPanelProps } from './types'

/**
 * 一个会话的对话区：消息列表 + 输入区。
 *
 * 由父级用 `key={sessionId}` 挂载：切换会话时整体重建，
 * 历史载入与实时事件都天然只作用于当前会话，无需在组件内重置状态。
 */
export default function AiChatPanel({
  sessionId,
  cwd,
  disabled,
  emptyHint,
  onUserSend
}: AiChatPanelProps): React.JSX.Element {
  const { messages, running, error, send } = useAiChat(sessionId, cwd)

  const handleSend = useCallback(
    (text: string, modelConfigId: number): void => {
      onUserSend(text)
      send(text, modelConfigId)
    },
    [onUserSend, send]
  )

  return (
    <>
      <AiMessageList messages={messages} running={running} error={error} emptyHint={emptyHint} />
      <AiComposer disabled={disabled} running={running} onSend={handleSend} />
    </>
  )
}
