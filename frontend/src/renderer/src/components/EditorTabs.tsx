import { useState } from 'react'
import ContextMenu, { type ContextMenuEntry } from './ContextMenu'
import type { OpenedFile } from '../hooks/useOpenedFiles'

interface EditorTabsProps {
  /** 已打开的文件（按打开顺序） */
  files: OpenedFile[]
  /** 当前激活文件路径 */
  activePath: string | null
  /** 有未保存修改的文件路径集合（显示脏标记） */
  dirtyPaths: ReadonlySet<string>
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onCloseOthers: (path: string) => void
  onCloseToRight: (path: string) => void
  onCloseAll: () => void
}

/** 标签右键菜单状态：显示坐标（视口坐标系）与目标文件路径 */
interface TabMenuState {
  x: number
  y: number
  path: string
}

/** 标签关闭按钮图标（悬停时替代脏标记显示） */
function CloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

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
    <div className="editor-tabs" role="tablist" aria-label="已打开的文件">
      {files.map((file) => {
        const active = file.path === activePath
        return (
          <div
            key={file.path}
            role="tab"
            aria-selected={active}
            className={active ? 'editor-tab editor-tab--active' : 'editor-tab'}
            title={file.path}
            onClick={() => onActivate(file.path)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ x: event.clientX, y: event.clientY, path: file.path })
            }}
          >
            <span className="editor-tab__name">{file.name}</span>
            <span className="editor-tab__status">
              {dirtyPaths.has(file.path) ? (
                <span className="editor-tab__dirty" title="有未保存的更改" />
              ) : null}
              <button
                type="button"
                className="editor-tab__close"
                aria-label={`关闭 ${file.name}`}
                title="关闭"
                onClick={(event) => {
                  // 阻止冒泡，避免同时触发标签激活
                  event.stopPropagation()
                  onClose(file.path)
                }}
              >
                <CloseIcon />
              </button>
            </span>
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
