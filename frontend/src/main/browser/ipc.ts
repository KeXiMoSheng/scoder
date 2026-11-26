/**
 * 浏览器页签 IPC：渲染进程上报原生页面的位置/可见性，并转发少量页签控制操作。
 *
 * 校验原则与其它通道一致：渲染进程输入按不可信处理，形状不对直接拒绝；
 * 会话不存在时不做任何事（页签关闭与布局上报天然存在竞态，不应抛错打断界面）。
 */
import { ipcMain } from 'electron'
import { BROWSER_CHANNELS } from '../../shared/browser/events'
import type { BrowserBounds } from '../../shared/browser/types'
import { browserManager } from './manager'

/** 会话 id 只做形状与长度校验：真正的会话归属由浏览器管理器按 id 隔离 */
function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new Error('sessionId 无效')
  }
  return value
}

/** 页签内容区：必须四个字段都是有限数字 */
function isBrowserBounds(value: unknown): value is BrowserBounds {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => typeof record[key] === 'number' && Number.isFinite(record[key])
  )
}

/** 注册浏览器页签通道：需要在 app ready 之后、窗口创建之前调用 */
export function registerBrowserHandlers(): void {
  ipcMain.handle(BROWSER_CHANNELS.list, () => browserManager.list())

  // 标题栏「打开浏览器」：打开或切回手动浏览页签（不预载地址，由用户输入）
  ipcMain.handle(BROWSER_CHANNELS.openTab, () => browserManager.openManual())

  ipcMain.handle(
    BROWSER_CHANNELS.setBounds,
    (_event, sessionId: unknown, bounds: unknown, visible: unknown): void => {
      if (!isBrowserBounds(bounds) || typeof visible !== 'boolean') {
        return
      }
      browserManager.setBounds(requireSessionId(sessionId), bounds, visible)
    }
  )

  ipcMain.handle(BROWSER_CHANNELS.close, (_event, sessionId: unknown): boolean => {
    return browserManager.close(requireSessionId(sessionId))
  })

  ipcMain.handle(
    BROWSER_CHANNELS.navigate,
    async (_event, sessionId: unknown, url: unknown): Promise<void> => {
      if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
        throw new Error('地址无效')
      }
      await browserManager.navigate(requireSessionId(sessionId), url)
    }
  )

  ipcMain.handle(BROWSER_CHANNELS.reload, (_event, sessionId: unknown): void => {
    browserManager.reload(requireSessionId(sessionId))
  })

  ipcMain.handle(BROWSER_CHANNELS.goBack, (_event, sessionId: unknown): void => {
    browserManager.goBack(requireSessionId(sessionId))
  })

  ipcMain.handle(BROWSER_CHANNELS.goForward, (_event, sessionId: unknown): void => {
    browserManager.goForward(requireSessionId(sessionId))
  })

  ipcMain.handle(BROWSER_CHANNELS.openExternal, (_event, sessionId: unknown): Promise<void> => {
    return browserManager.openExternal(requireSessionId(sessionId))
  })
}
