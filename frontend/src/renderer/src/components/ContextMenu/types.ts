/** ContextMenu 组件的对外类型定义 */

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

export interface ContextMenuProps {
  /** 期望的显示坐标（视口坐标系，通常取右键事件位置）；贴边时组件自动修正 */
  x: number
  y: number
  /** 菜单条目 */
  entries: ContextMenuEntry[]
  /** 请求关闭菜单（点击条目、点击外部、按 Esc 或任意容器滚动时触发） */
  onClose: () => void
}
