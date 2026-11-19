/**
 * Git 设置：可执行文件路径由用户显式指定。
 *
 * 与 PowerShell 7 不同，git 通常已经在 PATH 上，所以默认自动探测；
 * 只有用户显式指定了路径（例如 Windows 上没加进 PATH 的 Git for Windows），
 * 才使用该路径。
 */

/** 设置页可调的 Git 参数 */
export interface GitSettings {
  /** git 可执行文件的绝对路径；空字符串表示自动使用 PATH 上的 git */
  gitPath: string
}

/** 默认自动探测 PATH 上的 git */
export const DEFAULT_GIT_SETTINGS: GitSettings = {
  gitPath: ''
}

/** 设置读写与测试通道：数据落在主进程 SQLite 的 app_settings 表 */
export const GIT_SETTINGS_CHANNELS = {
  get: 'gitSettings:get',
  save: 'gitSettings:save',
  /** 弹出系统文件选择框，返回选中的可执行文件路径（不落库） */
  browse: 'gitSettings:browse',
  /** 实际运行一次 `git --version`，返回版本号 */
  test: 'gitSettings:test'
} as const
