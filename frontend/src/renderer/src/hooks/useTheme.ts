import { useCallback, useState } from 'react'
import { applyTheme, getActiveThemeId } from '../lib/theme'
import type { ThemeId } from '../lib/theme'

/** 主题切换：初始值为已应用的主题，切换立即生效并持久化（见 lib/theme.ts） */
export function useTheme(): { themeId: ThemeId; setThemeId: (id: ThemeId) => void } {
  const [themeId, setThemeIdState] = useState<ThemeId>(getActiveThemeId)

  const setThemeId = useCallback((id: ThemeId): void => {
    applyTheme(id)
    setThemeIdState(id)
  }, [])

  return { themeId, setThemeId }
}
