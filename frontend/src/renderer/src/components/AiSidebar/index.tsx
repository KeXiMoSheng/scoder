import { useCallback, useState } from 'react'
import { History, Plus } from 'lucide-react'
import AiComposer from '../AiComposer'
import AiSessionHistory from '../AiSessionHistory'
import AiSessionTabs from '../AiSessionTabs'
import PromptDialog from '../PromptDialog'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import type { AiSidebarProps } from './types'

/**
 * 右侧 AI 边栏：
 * 顶部工具栏（新建会话 / 对话历史）+ 会话标签栏 + 对话区占位 + 底部输入区。
 * 会话状态由 App 持有，面板隐藏再打开时标签与历史记录保持不丢。
 */
export default function AiSidebar({ width, sessions }: AiSidebarProps): React.JSX.Element {
  const {
    sessions: list,
    activeId,
    activeSession,
    create,
    activate,
    rename,
    close,
    closeOthers,
    touch
  } = sessions
  const [historyOpen, setHistoryOpen] = useState(false)
  // 正在重命名的会话 id；null 表示未打开重命名对话框
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const renamingSession = renamingId
    ? (list.find((session) => session.id === renamingId) ?? null)
    : null

  /** 发送消息（当前仅更新会话活动时间与自动标题，模型调用后续接入） */
  const handleSend = useCallback(
    (text: string): void => {
      if (activeId) {
        touch(activeId, text)
      }
    },
    [activeId, touch]
  )

  const handleCreate = useCallback((): void => {
    create()
    setHistoryOpen(false)
  }, [create])

  const handleSelectHistory = useCallback(
    (id: string): void => {
      activate(id)
      setHistoryOpen(false)
    },
    [activate]
  )

  return (
    <aside className="flex shrink-0 flex-col border-l border-line bg-elevated" style={{ width }}>
      {/* 工具栏行：会话页签占满左侧，新建/历史按钮固定在右侧；历史弹层从该行下方展开 */}
      <div className="relative shrink-0 border-b border-line">
        <header className="flex h-9 items-stretch">
          {list.length === 0 ? (
            // 没有会话时页签区让位给面板标题，新建后由页签接管
            <span className="flex min-w-0 flex-1 items-center truncate pl-3 text-[12px] font-medium text-dim">
              AI 助手
            </span>
          ) : (
            <AiSessionTabs
              sessions={list}
              activeId={activeId}
              onActivate={activate}
              onClose={close}
              onCloseOthers={closeOthers}
              onRename={setRenamingId}
            />
          )}
          <div className="flex shrink-0 items-center gap-0.5 px-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-dim hover:text-fg"
              title="新建会话"
              aria-label="新建会话"
              onClick={handleCreate}
            >
              <Plus className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={cn('text-dim hover:text-fg', historyOpen && 'bg-hover text-fg')}
              title="对话历史"
              aria-label="对话历史"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((prev) => !prev)}
            >
              <History className="size-3.5" />
            </Button>
          </div>
        </header>
        {historyOpen ? (
          <AiSessionHistory
            sessions={list}
            activeId={activeId}
            onSelect={handleSelectHistory}
            onClose={() => setHistoryOpen(false)}
          />
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <p className="m-0 max-w-[220px] text-center leading-[1.6] text-dim">
          {activeSession ? '对话内容将在此显示' : '点击顶部「+」新建会话开始对话'}
        </p>
      </div>
      <AiComposer disabled={activeSession === null} onSend={handleSend} />
      {renamingSession ? (
        <PromptDialog
          title="重命名会话"
          placeholder="会话名称"
          confirmLabel="保存"
          defaultValue={renamingSession.title}
          onConfirm={(title) => {
            rename(renamingSession.id, title)
            setRenamingId(null)
          }}
          onCancel={() => setRenamingId(null)}
        />
      ) : null}
    </aside>
  )
}
