import { useCallback } from 'react'
import type { AiAttachment } from '@shared/ai/types'
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
  onUserSend,
  onCreateSession,
  attachments,
  onRemoveAttachment,
  onAttachmentsSent,
  onOpenFile
}: AiChatPanelProps): React.JSX.Element {
  const { messages, running, error, usage, send } = useAiChat(sessionId, cwd)

  const handleSend = useCallback(
    (text: string, modelConfigId: number, attachments: readonly AiAttachment[]): void => {
      onUserSend(text)
      send(text, modelConfigId, attachments)
      onAttachmentsSent()
    },
    [onAttachmentsSent, onUserSend, send]
  )

  return (
    <>
      <AiMessageList
        messages={messages}
        running={running}
        error={error}
        emptyHint={emptyHint}
        onOpenFile={onOpenFile}
      />
      <AiComposer
        disabled={disabled}
        running={running}
        usage={usage}
        canCreateSession={cwd !== null}
        onCreateSession={onCreateSession}
        attachments={attachments}
        onRemoveAttachment={onRemoveAttachment}
        onOpenFile={onOpenFile}
        onSend={handleSend}
      />
    </>
  )
}
