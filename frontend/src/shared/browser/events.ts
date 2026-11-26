/**
 * 浏览器页签通道名：主进程、preload 与渲染进程共用，避免字符串漂移。
 * 页签状态统一走 event 推送；渲染进程只通过 invoke 上报布局与少量控制操作。
 */
export const BROWSER_CHANNELS = {
  /** 主进程 → 渲染进程：页签打开/状态变化/关闭 */
  event: 'browser:event',
  /** 渲染进程 → 主进程：列出当前打开的页签（渲染进程重载后恢复） */
  list: 'browser:list',
  /** 渲染进程 → 主进程：打开（或切回）手动浏览页签，不预载地址 */
  openTab: 'browser:openTab',
  /** 渲染进程 → 主进程：设置原生页面位置与可见性 */
  setBounds: 'browser:setBounds',
  /** 渲染进程 → 主进程：关闭页签 */
  close: 'browser:close',
  /** 渲染进程 → 主进程：地址栏回车，导航到新地址 */
  navigate: 'browser:navigate',
  reload: 'browser:reload',
  goBack: 'browser:goBack',
  goForward: 'browser:goForward',
  /** 用系统浏览器打开当前页面 */
  openExternal: 'browser:openExternal'
} as const
