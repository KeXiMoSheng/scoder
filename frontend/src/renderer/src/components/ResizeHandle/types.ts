/** ResizeHandle 组件的对外类型定义 */

export interface ResizeHandleProps {
  /** 无障碍标签，说明该分隔条调整的对象 */
  label: string
  /** 拖拽开始（父级此刻记录面板初始宽度） */
  onResizeStart: () => void
  /** 拖拽中回调，offsetX 为相对按下位置的横向偏移（px，向右为正） */
  onResize: (offsetX: number) => void
}
