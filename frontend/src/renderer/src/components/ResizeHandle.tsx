import { useCallback, useRef } from 'react'

interface ResizeHandleProps {
  /** 无障碍标签，说明该分隔条调整的对象 */
  label: string
  /** 拖拽开始（父级此刻记录面板初始宽度） */
  onResizeStart: () => void
  /** 拖拽中回调，offsetX 为相对按下位置的横向偏移（px，向右为正） */
  onResize: (offsetX: number) => void
}

/** 面板之间的拖拽分隔条：按住后用 pointer capture 持续跟踪移动，松开结束 */
export default function ResizeHandle({
  label,
  onResizeStart,
  onResize
}: ResizeHandleProps): React.JSX.Element {
  const startXRef = useRef(0)
  const draggingRef = useRef(false)

  /** 结束拖拽：移除激活标记、还原全局拖拽样式并释放指针捕获 */
  const stopDragging = useCallback((element: HTMLDivElement, pointerId: number): void => {
    draggingRef.current = false
    element.classList.remove('resize-handle--active')
    document.body.classList.remove('is-resizing')
    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId)
    }
  }, [])

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return
        }
        event.preventDefault()
        startXRef.current = event.clientX
        draggingRef.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        event.currentTarget.classList.add('resize-handle--active')
        // 拖拽期间全局保持列宽光标并禁止选中文本（覆盖 Monaco 等内部元素）
        document.body.classList.add('is-resizing')
        onResizeStart()
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) {
          return
        }
        onResize(event.clientX - startXRef.current)
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
