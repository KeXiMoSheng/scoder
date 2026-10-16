import { useCallback, useRef, useState } from 'react'
import type { ResizeHandleProps } from './types'

/** 面板之间的拖拽分隔条：按住后用 pointer capture 持续跟踪移动，松开结束 */
export default function ResizeHandle({
  label,
  orientation = 'vertical',
  collapsed = false,
  onResizeStart,
  onResize
}: ResizeHandleProps): React.JSX.Element {
  const isHorizontal = orientation === 'horizontal'
  const [active, setActive] = useState(false)
  const startPosRef = useRef(0)
  const draggingRef = useRef(false)

  /** 结束拖拽：移除激活标记、还原全局拖拽样式并释放指针捕获 */
  const stopDragging = useCallback(
    (element: HTMLDivElement, pointerId: number): void => {
      draggingRef.current = false
      setActive(false)
      document.body.classList.remove(isHorizontal ? 'is-resizing-row' : 'is-resizing')
      if (element.hasPointerCapture(pointerId)) {
        element.releasePointerCapture(pointerId)
      }
    },
    [isHorizontal]
  )

  // 分隔条尺寸与光标：横向条调高度（折叠时略高并带顶边），纵向条调宽度
  const classNames = [
    'shrink-0 transition-colors',
    isHorizontal ? 'w-auto cursor-row-resize' : 'w-1 cursor-col-resize',
    isHorizontal ? (collapsed ? 'h-1.5' : 'h-1') : '',
    collapsed ? 'border-t border-line' : '',
    // 激活态用强调色覆盖折叠底色，其余情况透明/elevated + 悬停高亮
    active
      ? 'bg-accent-hover'
      : collapsed
        ? 'bg-elevated hover:bg-accent-hover'
        : 'bg-transparent hover:bg-accent-hover'
  ]

  return (
    <div
      className={classNames.join(' ')}
      role="separator"
      aria-orientation={isHorizontal ? 'horizontal' : 'vertical'}
      aria-label={label}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return
        }
        event.preventDefault()
        startPosRef.current = isHorizontal ? event.clientY : event.clientX
        draggingRef.current = true
        setActive(true)
        event.currentTarget.setPointerCapture(event.pointerId)
        // 拖拽期间全局保持对应方向光标并禁止选中文本（覆盖 Monaco 等内部元素）
        document.body.classList.add(isHorizontal ? 'is-resizing-row' : 'is-resizing')
        onResizeStart()
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) {
          return
        }
        const position = isHorizontal ? event.clientY : event.clientX
        onResize(position - startPosRef.current)
      }}
      onPointerUp={(event) => {
        if (draggingRef.current) {
          stopDragging(event.currentTarget, event.pointerId)
        }
      }}
      onPointerCancel={(event) => {
        if (draggingRef.current) {
          stopDragging(event.currentTarget, event.pointerId)
        }
      }}
    />
  )
}
