import type { ThemeId } from '../../lib/theme'

/** TitleBar 组件的对外类型定义 */
export interface TitleBarProps {
  /** 当前打开的项目目录；null 表示未打开（此时「关闭文件夹」禁用） */
  projectPath: string | null
  /** 当前应用主题 id */
  themeId: ThemeId
  /** 命令行面板是否展开（用于终端按钮的高亮状态） */
  terminalVisible: boolean
  /** AI 助手侧边栏是否展开 */
  aiPanelVisible: boolean
  /** 系统配置页是否打开（设置按钮高亮） */
  settingsOpen: boolean
  /** 打开文件夹（弹出目录选择框） */
  onOpenFolder: () => void
  /** 关闭当前文件夹 */
  onCloseFolder: () => void
  /** 切换应用主题 */
  onThemeChange: (id: ThemeId) => void
  /** 展开命令行面板并新建一个终端会话 */
  onNewTerminal: () => void
  /** 展开/收起 AI 助手 */
  onToggleAiPanel: () => void
  /** 打开/关闭系统配置页 */
  onToggleSettings: () => void
}
