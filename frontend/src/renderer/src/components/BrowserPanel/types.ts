/** BrowserPanel 的对外类型定义 */

import type { BrowserTabState } from '@shared/browser/types'

export interface BrowserPanelProps {
  /** 当前激活的浏览器页签（由主进程推送的状态） */
  tab: BrowserTabState
  /**
   * 是否允许原生页面显示。
   * 编辑器被设置页/搜索/改动审查/菜单/对话框盖住时传 false：只隐藏原生视图，
   * 页面本身保持加载，关掉覆盖层后会重新回到原位置。
   */
  visible: boolean
}
