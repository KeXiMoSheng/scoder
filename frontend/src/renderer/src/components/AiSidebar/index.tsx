import { useCallback, useState } from 'react'
import { History, Plus } from 'lucide-react'
import AiChatPanel from '../AiChatPanel'
import AiSessionHistory from '../AiSessionHistory'
import AiSessionTabs from '../AiSessionTabs'
import PromptDialog from '../PromptDialog'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import type { AiSidebarProps } from './types'

/**
 * 右侧 AI 边栏：
 * 顶部工具栏（新建会话 / 对话历史）+ 会话标签栏 + 对话区 + 底部输入区。
 * 会话列表由 App 持有，面板隐藏再打开时标签与历史记录保持不丢；
 * 对话区按会话 id 重建，切换标签即重新载入对应会话的磁盘历史。
 */
export default function AiSidebar({ width, sessions, cwd }: AiSidebarProps): React.JSX.Element {
  const {
    sessions: list,
    history,
    activeId,
    activeSession,
    create,
    activate,
    open,
    refreshHistory,
    rename,
    remove,
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

  /** 发出消息后更新会话活动时间；自动标题的会话用首条消息替换标题 */
  const handleUserSend = useCallback(
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

  /** 打开历史弹层：每次展开都重新读盘，保证标题与时间是新的 */
  const toggleHistory = useCallback((): void => {
    const next = !historyOpen
    setHistoryOpen(next)
    if (next) {
      refreshHistory()
    }
  }, [historyOpen, refreshHistory])

  /** 点击历史会话：关闭过的标签也能重新打开（open 负责把它加回标签栏） */
  const handleSelectHistory = useCallback(
    (id: string): void => {
      open(id)
      setHistoryOpen(false)
    },
    [open]
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
              title={cwd === null ? '先打开一个项目' : '新建会话'}
              aria-label="新建会话"
              disabled={cwd === null}
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
              onClick={toggleHistory}
            >
              <History className="size-3.5" />
            </Button>
          </div>
        </header>
        {historyOpen ? (
          <AiSessionHistory
            sessions={history}
            activeId={activeId}
            onSelect={handleSelectHistory}
            onDelete={remove}
            onClose={() => setHistoryOpen(false)}
          />
        ) : null}
      </div>
      <AiChatPanel
        key={activeSession?.id ?? 'no-session'}
        sessionId={activeSession?.id ?? null}
        cwd={cwd}
        disabled={activeSession === null}
        emptyHint={
          cwd === null
            ? '请先打开一个项目；AI 会话与项目绑定'
            : activeSession
              ? '输入消息开始对话；回复与代码块会按当前主题渲染'
              : '点击顶部「+」新建会话开始对话'
        }
        onUserSend={handleUserSend}
      />
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
