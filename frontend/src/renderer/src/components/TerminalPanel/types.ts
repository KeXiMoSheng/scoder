import type { ThemeId } from '../../lib/theme'

/** TerminalPanel 组件的对外类型定义 */
export interface TerminalPanelProps {
  /** 是否展开显示；收起时仅隐藏外观（display:none），终端会话保持存活 */
  visible: boolean
  /** 展开时的面板高度（px，由父级按编辑器区高度比例计算） */
  height: number
  /** 会话首次创建时的启动目录（打开的项目路径；null 时落在用户主目录） */
  cwd: string | null
  /** 当前应用主题 id：变化时同步终端配色 */
  themeId: ThemeId
  /** 请求收起面板（点击标题栏关闭按钮） */
  onRequestHide: () => void
}
