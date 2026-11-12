import { app, ipcMain, shell } from 'electron'
import { APP_CHANNELS } from '../../shared/app/events'
import type { AppInfo } from '../../shared/app/types'

/** 官方源码仓库：设置页「关于」展示，点击后由系统浏览器打开 */
const REPOSITORY_URL = 'https://github.com/KeXiMoSheng/scoder'

/**
 * 注册应用信息通道。
 * 版本号只能由主进程读取（app.getVersion），渲染进程通过 getInfo 获取；
 * 跳转固定为目标仓库地址，不接受渲染进程传入 URL，避免被利用打开任意外链。
 */
export function registerAppHandlers(): void {
  ipcMain.handle(APP_CHANNELS.getInfo, (): AppInfo => ({
    version: app.getVersion(),
    repositoryUrl: REPOSITORY_URL
  }))

  ipcMain.handle(APP_CHANNELS.openRepository, async (): Promise<void> => {
    await shell.openExternal(REPOSITORY_URL)
  })
}
