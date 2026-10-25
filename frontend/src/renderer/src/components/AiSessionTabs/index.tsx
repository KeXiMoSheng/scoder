import { useState } from 'react'
import ContextMenu from '../ContextMenu'
import type { ContextMenuEntry } from '../ContextMenu/types'
import type { AiSessionTabsProps, SessionTabMenuState } from './types'

/** 标签关闭按钮图标（与编辑器标签一致的小叉） */
function CloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * AI 会话标签栏：与编辑器标签栏同款视觉。
 * 支持切换、悬停关闭与右键菜单（重命名 / 关闭 / 关闭其它）。
 */
export default function AiSessionTabs({
  sessions,
  activeId,
  onActivate,
  onClose,
  onCloseOthers,
  onRename
}: AiSessionTabsProps): React.JSX.Element {
  const [menu, setMenu] = useState<SessionTabMenuState | null>(null)

  // 右键后目标标签可能已被其它操作关闭：失效时不再展示菜单
  const menuIndex = menu ? sessions.findIndex((session) => session.id === menu.id) : -1

  /** 构建标签右键菜单条目（数据驱动，后续可在此追加新操作） */
  const buildMenuEntries = (id: string): ContextMenuEntry[] => [
    { id: 'rename', label: '重命名会话', onSelect: () => onRename(id) },
    null,
    { id: 'close', label: '关闭会话', onSelect: () => onClose(id) },
    {
      id: 'close-others',
      label: '关闭其它会话',
      disabled: sessions.length <= 1,
      disabledReason: '没有其它会话',
      onSelect: () => onCloseOthers(id)
    }
  ]

  return (
    // 不画边框与高度：由 AiSidebar 的工具栏行提供，页签随行高纵向拉伸
    <div
      className="scrollbar-none flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
      role="tablist"
      aria-label="AI 会话"
    >
      {sessions.map((session) => {
        const active = session.id === activeId
        return (
          <div
            key={session.id}
            role="tab"
            aria-selected={active}
            className={
              active
                ? 'group flex max-w-[160px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-t border-r-line border-t-accent-hover bg-base pl-3 pr-1.5 text-fg select-none'
                : 'group flex max-w-[160px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-t border-r-line border-t-transparent text-dim select-none hover:bg-hover'
            }
            title={session.title}
            onClick={() => onActivate(session.id)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ x: event.clientX, y: event.clientY, id: session.id })
            }}
          >
            <span className="min-w-0 truncate">{session.title}</span>
            <span className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center">
              <button
                type="button"
                className="absolute inset-0 inline-flex cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent p-0 text-inherit opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[color-mix(in_srgb,var(--text)_14%,transparent)]"
                aria-label={`关闭 ${session.title}`}
                title="关闭会话"
                onClick={(event) => {
                  // 阻止冒泡，避免同时触发标签激活
                  event.stopPropagation()
                  onClose(session.id)
                }}
              >
                <CloseIcon />
              </button>
            </span>
          </div>
        )
      })}
      {menu && menuIndex !== -1 ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={buildMenuEntries(menu.id)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}
