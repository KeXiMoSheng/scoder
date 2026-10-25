/** 终端通道：create/write/resize/dispose 由渲染进程发起，data/exit 由主进程推送 */
export const TERMINAL_CHANNELS = {
  create: 'terminal:create',
  write: 'terminal:write',
  resize: 'terminal:resize',
  dispose: 'terminal:dispose',
  /** 主进程 → 渲染进程：PTY 增量输出 */
  data: 'terminal:data',
  /** 主进程 → 渲染进程：PTY 进程退出 */
  exit: 'terminal:exit'
} as const
