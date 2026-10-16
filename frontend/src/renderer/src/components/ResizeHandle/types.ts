/** ResizeHandle 组件的对外类型定义 */

export interface ResizeHandleProps {
  /** 无障碍标签，说明该分隔条调整的对象 */
  label: string
  /** 拖拽轴向：vertical 调整宽度（默认），horizontal 调整高度 */
  orientation?: 'vertical' | 'horizontal'
  /** 折叠态样式：面板收起后以高亮拖拽条提示可拖出（底部命令行面板使用） */
  collapsed?: boolean
  /** 拖拽开始（父级此刻记录面板初始尺寸） */
  onResizeStart: () => void
  /** 拖拽中回调；offset 为相对按下位置的偏移（px）：竖向拖拽为横向偏移（向右为正），横向拖拽为纵向偏移（向下为正） */
  onResize: (offset: number) => void
}
