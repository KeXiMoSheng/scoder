import { useCallback, useSyncExternalStore } from 'react'
import { applyTheme, getThemeSnapshot, subscribeThemes } from '../lib/theme'
import type { AppTheme, ThemeId } from '../lib/theme'

export interface ThemeController {
  /** 当前应用主题 id */
  themeId: ThemeId
  /** 切换主题：立即生效并持久化（见 lib/theme.ts） */
  setThemeId: (id: ThemeId) => void
  /** 全部可用主题：内置在前、导入在后；导入/删除后自动更新 */
  themes: readonly AppTheme[]
}

/**
 * 主题状态：订阅 lib/theme.ts 的全局主题目录。
 * 目录可能在运行时变化（设置页导入/删除主题），因此不用组件内 state 缓存，
 * 而是走 useSyncExternalStore，标题栏菜单与设置页共享同一份快照。
 */
export function useTheme(): ThemeController {
  const snapshot = useSyncExternalStore(subscribeThemes, getThemeSnapshot, getThemeSnapshot)
  const setThemeId = useCallback((id: ThemeId): void => applyTheme(id), [])
  return { themeId: snapshot.activeId, setThemeId, themes: snapshot.themes }
}
