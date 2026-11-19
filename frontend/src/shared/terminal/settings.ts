/**
 * 终端设置：PowerShell 7 的路径由用户显式指定。
 *
 * 设置页会从 PATH 与常见安装目录自动探测 pwsh.exe 并预先填入；
 * 是否使用仍以保存的路径为准：留空时运行时一律回退 Windows 自带的 5.1。
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
  /** 自动探测 PATH / 常见安装目录中的 pwsh.exe，返回绝对路径（不落库） */
  detect: 'terminalSettings:detect',
  /** 实际启动一次选中的 PowerShell，返回版本号 */
  test: 'terminalSettings:test',
  /** 用系统浏览器打开 PowerShell 官方下载页 */
  openDownload: 'terminalSettings:openDownload'
} as const

/** PowerShell 官方下载页：设置页展示，点击后由系统浏览器打开 */
export const POWERSHELL_DOWNLOAD_URL = 'https://github.com/PowerShell/PowerShell/releases/'
