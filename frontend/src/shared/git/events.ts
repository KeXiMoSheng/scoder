/** Git 通道：主进程 handler、preload 转发与渲染进程订阅共用，避免字符串漂移 */
export const GIT_CHANNELS = {
  /** 开始按固定间隔自动检测某个工作区的 Git 状态（重复调用即切换目标） */
  watchStatus: 'git:watchStatus',
  /** 立即重新检测一次（手动刷新文件树、收到磁盘变更时使用） */
  refreshStatus: 'git:refreshStatus',
  /** 停止自动检测（关闭或切换项目时调用） */
  unwatchStatus: 'git:unwatchStatus',
  /** 主进程 → 渲染进程：状态发生变化（含首次读取结果） */
  statusChanged: 'git:statusChanged'
} as const
