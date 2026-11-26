/**
 * 浏览器页签的展示辅助：页签键、标题与主机名。
 * 浏览器页签与文件页签共用标签栏，但浏览器页签没有磁盘路径，
 * 这里用 `browser:<sessionId>` 作为它在标签栏里的稳定 key。
 */
import type { BrowserTabState } from '@shared/browser/types'

/** 浏览器页签 key 前缀：与常见绝对路径不会冲突 */
const BROWSER_TAB_PREFIX = 'browser:'

/** 会话 id → 标签栏里的页签 key */
export function browserTabKey(sessionId: string): string {
  return `${BROWSER_TAB_PREFIX}${sessionId}`
}

/** 标签栏 key → 会话 id；不是浏览器页签时返回 null */
export function parseBrowserTabKey(key: string): string | null {
  return key.startsWith(BROWSER_TAB_PREFIX) ? key.slice(BROWSER_TAB_PREFIX.length) : null
}

/** 从地址里取主机名（含端口）；地址还没准备好时返回空串 */
export function browserHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** 页签标题：优先页面标题，其次主机名，最后退回地址或「浏览器」 */
export function browserTabTitle(tab: Pick<BrowserTabState, 'title' | 'url'>): string {
  const title = tab.title.trim()
  if (title.length > 0) {
    return title
  }
  return browserHost(tab.url) || tab.url.trim() || '浏览器'
}
