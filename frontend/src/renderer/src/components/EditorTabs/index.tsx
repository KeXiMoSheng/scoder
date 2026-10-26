import { useState } from 'react'
import { X } from 'lucide-react'
import ContextMenu from '../ContextMenu'
import type { ContextMenuEntry } from '../ContextMenu/types'
import FileRow from '../FileRow'
import type { EditorTabsProps, TabMenuState } from './types'

/** 编辑器标签栏：切换/关闭打开的文件，右键标签弹出操作菜单 */
export default function EditorTabs({
  files,
  activePath,
  dirtyPaths,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll
}: EditorTabsProps): React.JSX.Element {
  const [menu, setMenu] = useState<TabMenuState | null>(null)

  // 右键后目标标签可能已被其它操作关闭：失效时不再展示菜单
  const menuIndex = menu ? files.findIndex((file) => file.path === menu.path) : -1

  /**
   * 构建标签右键菜单条目（数据驱动）。
   * 扩展点：后续「发送给 AI」等操作在此数组追加条目即可；
   * 以 null 作为分隔线，可与关闭系列操作视觉分组。
   */
  const buildMenuEntries = (index: number, path: string): ContextMenuEntry[] => [
    { id: 'close', label: '关闭', onSelect: () => onClose(path) },
    {
      id: 'close-others',
      label: '关闭其它',
      disabled: files.length <= 1,
      disabledReason: '没有其它已打开的文件',
      onSelect: () => onCloseOthers(path)
    },
    {
      id: 'close-right',
      label: '关闭右侧',
      disabled: index === files.length - 1,
      disabledReason: '右侧没有已打开的文件',
      onSelect: () => onCloseToRight(path)
    },
    { id: 'close-all', label: '关闭全部', onSelect: onCloseAll }
  ]

  return (
    <div
      className="flex min-h-8 shrink-0 overflow-x-auto overflow-y-hidden border-b border-line bg-elevated"
      role="tablist"
      aria-label="已打开的文件"
    >
      {files.map((file) => {
        const active = file.path === activePath
        return (
          <div
            key={file.path}
            role="tab"
            aria-selected={active}
            className={
              active
                ? 'group flex max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-t border-r-line border-t-accent-hover bg-base pl-3 pr-1.5 text-fg select-none'
                : 'group flex max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-t border-r-line border-t-transparent text-dim select-none hover:bg-hover'
            }
            title={file.path}
            onClick={() => onActivate(file.path)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ x: event.clientX, y: event.clientY, path: file.path })
            }}
          >
            <FileRow
              name={file.name}
              trailing={
                <span className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center">
                  {dirtyPaths.has(file.path) ? (
                    <span
                      className="absolute h-[7px] w-[7px] rounded-full bg-fg opacity-85 transition-opacity group-hover:opacity-0"
                      title="有未保存的更改"
                    />
                  ) : null}
                  <button
                    type="button"
                    className="absolute inset-0 inline-flex cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent p-0 text-inherit opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[color-mix(in_srgb,var(--text)_14%,transparent)]"
                    aria-label={`关闭 ${file.name}`}
                    title="关闭"
                    onClick={(event) => {
                      // 阻止冒泡，避免同时触发标签激活
                      event.stopPropagation()
                      onClose(file.path)
                    }}
                  >
                    <X className="size-2.5" />
                  </button>
                </span>
              }
            />
          </div>
        )
      })}
      {menu && menuIndex !== -1 ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={buildMenuEntries(menuIndex, menu.path)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}
