/** SettingsSidebar 组件的对外类型定义 */

import type { LucideIcon } from 'lucide-react'

/** 设置页左侧导航的分区 id：新增设置分区时在此追加 */
export type SettingsSectionId = 'models'

/** 单个设置分区（侧栏菜单项） */
export interface SettingsSection {
  id: SettingsSectionId
  /** 菜单与面包屑共用的显示名 */
  label: string
  icon: LucideIcon
}

export interface SettingsSidebarProps {
  /** 当前选中的分区 */
  activeSection: SettingsSectionId
  /** 切换设置分区 */
  onSelectSection: (section: SettingsSectionId) => void
}
