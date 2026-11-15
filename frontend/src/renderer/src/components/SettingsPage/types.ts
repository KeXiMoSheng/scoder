/** SettingsPage 组件的对外类型定义 */

import type { SettingsSectionId } from '../SettingsSidebar/types'

export interface SettingsPageProps {
  /** 关闭设置页，返回工作区 */
  onClose: () => void
  /** 首次打开时定位的分区；缺省为「模型」 */
  initialSection?: SettingsSectionId
}
