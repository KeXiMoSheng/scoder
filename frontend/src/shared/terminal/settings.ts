/**
 * 终端设置：PowerShell 7 的路径由用户显式指定。
 *
 * PS7 的安装位置五花八门（MSI、Store、zip 解压、自定义目录），自动探测不可靠，
 * 所以不做猜测：没配置就一律使用 Windows 自带的 5.1。
 */

/** 设置页可调的终端参数 */
export interface TerminalSettings {
  /** pwsh.exe 的绝对路径；空字符串表示不使用 PowerShell 7，回退系统自带 5.1 */
  powershellPath: string
}

/** 默认不使用 PowerShell 7 */
export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  powershellPath: ''
}

/** 设置读写与测试通道：数据落在主进程 SQLite 的 app_settings 表 */
export const TERMINAL_SETTINGS_CHANNELS = {
  get: 'terminalSettings:get',
  save: 'terminalSettings:save',
  /** 弹出系统文件选择框，返回选中的 exe 路径（不落库） */
  browse: 'terminalSettings:browse',
  /** 实际启动一次选中的 PowerShell，返回版本号 */
  test: 'terminalSettings:test',
  /** 用系统浏览器打开 PowerShell 官方下载页 */
  openDownload: 'terminalSettings:openDownload'
} as const

/** PowerShell 官方下载页：设置页展示，点击后由系统浏览器打开 */
export const POWERSHELL_DOWNLOAD_URL = 'https://github.com/PowerShell/PowerShell/releases/'
