/** 无边框窗口控制通道：动作类走单向 send，最大化状态支持回查与订阅 */
export const WINDOW_CHANNELS = {
  minimize: 'window:minimize',
  toggleMaximize: 'window:toggleMaximize',
  close: 'window:close',
  isMaximized: 'window:isMaximized',
  /** 主进程 → 渲染进程：最大化/还原状态变化 */
  maximizeChange: 'window:maximizeChange'
} as const
