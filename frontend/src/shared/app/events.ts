/** 应用信息通道：版本号由主进程读取，仓库跳转统一交给系统浏览器 */
export const APP_CHANNELS = {
  getInfo: 'app:getInfo',
  openRepository: 'app:openRepository'
} as const
