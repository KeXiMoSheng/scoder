import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ContextMenuProps } from './types'

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
      className="fixed z-[100] min-w-[128px] rounded-md border border-line bg-elevated p-1 shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
      style={{ left: position.x, top: position.y }}
      role="menu"
    >
      {entries.map((entry, index) =>
        entry ? (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className="block w-full cursor-pointer whitespace-nowrap rounded-[3px] border-none bg-transparent px-2.5 py-1 text-left font-[inherit] text-[13px] text-fg transition-colors enabled:hover:bg-selection disabled:cursor-default disabled:text-dim"
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
          <div key={`separator-${index}`} className="mx-1.5 my-1 h-px bg-line" role="separator" />
        )
      )}
    </div>
  )
}
