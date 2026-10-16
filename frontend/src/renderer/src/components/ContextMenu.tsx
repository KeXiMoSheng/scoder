import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** 右键菜单中的可点击项 */
export interface ContextMenuItem {
  /** 唯一标识（作为 React key 使用） */
  id: string
  label: string
  /** 点击后的回调（菜单随后自动关闭） */
  onSelect: () => void
  /** 是否禁用 */
  disabled?: boolean
  /** 禁用时的悬浮提示 */
  disabledReason?: string
}

/**
 * 菜单条目：ContextMenuItem 为可点击项，null 为一条分隔线。
 * 调用方按需拼装条目数组即可扩展新菜单项（如「发送给 AI」等）。
 */
export type ContextMenuEntry = ContextMenuItem | null

interface ContextMenuProps {
  /** 期望的显示坐标（视口坐标系，通常取右键事件位置）；贴边时组件自动修正 */
  x: number
  y: number
  /** 菜单条目 */
  entries: ContextMenuEntry[]
  /** 请求关闭菜单（点击条目、点击外部、按 Esc 或任意容器滚动时触发） */
  onClose: () => void
}

/** 菜单与窗口边缘保留的最小间距（px） */
const EDGE_MARGIN = 8

/** 通用右键菜单：按实际尺寸贴边修正位置；点击菜单项后自动关闭 */
export default function ContextMenu({
  x,
  y,
  entries,
  onClose
}: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null)
  // 记录上一次的锚点：组件实例被复用于新位置（如右键了另一个标签）时重置显示位置
  const [anchor, setAnchor] = useState({ x, y })
  const [position, setPosition] = useState({ x, y })
  if (anchor.x !== x || anchor.y !== y) {
    setAnchor({ x, y })
    setPosition({ x, y })
  }

  // 测量实际尺寸后把菜单收进窗口内（布局阶段完成，不会闪烁）
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) {
      return
    }
    const rect = menu.getBoundingClientRect()
    const nextX = Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - rect.width - EDGE_MARGIN))
    const nextY = Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - rect.height - EDGE_MARGIN))
    setPosition((prev) => (prev.x === nextX && prev.y === nextY ? prev : { x: nextX, y: nextY }))
  }, [x, y])

  // 关闭交互：点击菜单外部、按 Esc、任意容器滚动（捕获阶段覆盖文件树等内部滚动容器）
  useEffect(() => {
    const handleMouseDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose()
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: position.x, top: position.y }}
      role="menu"
    >
      {entries.map((entry, index) =>
        entry ? (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className="context-menu__item"
            disabled={entry.disabled}
            title={entry.disabled ? entry.disabledReason : undefined}
            onClick={() => {
              entry.onSelect()
              onClose()
            }}
          >
            {entry.label}
          </button>
        ) : (
          <div key={`separator-${index}`} className="context-menu__separator" role="separator" />
        )
      )}
    </div>
  )
}
