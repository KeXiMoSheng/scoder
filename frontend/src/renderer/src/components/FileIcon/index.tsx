import { useEffect, useState } from 'react'
import { resolveFileIcon, type ThemeKind } from '../../lib/fileIcon'
import { cn } from '../../lib/utils'
import type { FileIconProps } from './types'
import '../../assets/file-icons/fileIcons.css'

/** 读取应用当前主题明暗；lib/theme.ts 在切换时更新 <html data-theme-kind> */
function readThemeKind(): ThemeKind {
  return document.documentElement.dataset.themeKind === 'light' ? 'light' : 'dark'
}

/** 订阅主题切换，保证文件图标颜色随应用主题即时更新 */
function useThemeKind(): ThemeKind {
  const [kind, setKind] = useState<ThemeKind>(readThemeKind)

  useEffect(() => {
    const update = (): void => setKind(readThemeKind())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme-kind']
    })
    return () => observer.disconnect()
  }, [])

  return kind
}

/**
 * 按 VS Code Seti 主题渲染字体文件图标；未匹配到类型时回退到默认 file 字形。
 * 主题中 `_todo` 未声明 fontColor，此时沿用当前文字色。
 */
export default function FileIcon({ name, size = 14, className }: FileIconProps): React.JSX.Element {
  const kind = useThemeKind()
  const icon = resolveFileIcon(name, kind)

  return (
    <span
      className={cn('file-icon-glyph shrink-0', className)}
      data-file-icon={icon.definition}
      style={{ color: icon.color, fontSize: size * 1.5, width: size + 6 }}
      aria-hidden="true"
      draggable={false}
    >
      {icon.character}
    </span>
  )
}
