import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { isAtOrUnder, relativePathNative } from '../../lib/filePath'
import ContextMenu from '../ContextMenu'
import type { ContextMenuEntry } from '../ContextMenu/types'
import FileRow from '../FileRow'
import type { EditorTabsProps, TabMenuState, TabOverflowMenuState } from './types'

/**
 * 收集被横向滚动挤出可视区的标签路径（按打开顺序）。
 * 用视口坐标比较而不是 offsetLeft：标签与滚动容器的 offsetParent 可能不同层级。
 */
function collectHiddenPaths(strip: HTMLDivElement): string[] {
  const viewport = strip.getBoundingClientRect()
  const hidden: string[] = []
  for (const element of strip.querySelectorAll<HTMLElement>('[data-tab-path]')) {
    const rect = element.getBoundingClientRect()
    // 允许 1px 误差：子像素布局下边界值会有小数抖动
    if (rect.left < viewport.left - 1 || rect.right > viewport.right + 1) {
      hidden.push(element.dataset.tabPath ?? '')
    }
  }
  return hidden.filter((path) => path !== '')
}

/** 把指定标签滚动到可视区内（已完整可见时不动） */
function scrollTabIntoView(strip: HTMLDivElement, path: string): void {
  const element = strip.querySelector<HTMLElement>(`[data-tab-path="${CSS.escape(path)}"]`)
  if (!element) {
    return
  }
  const viewport = strip.getBoundingClientRect()
  const rect = element.getBoundingClientRect()
  if (rect.left < viewport.left) {
    strip.scrollLeft -= viewport.left - rect.left
  } else if (rect.right > viewport.right) {
    strip.scrollLeft += rect.right - viewport.right
  }
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
  onCloseAll,
  projectPath,
  onReveal,
  onSendToAi
}: EditorTabsProps): React.JSX.Element {
  const [menu, setMenu] = useState<TabMenuState | null>(null)
  // 「更多」下拉的锚点坐标；null 表示未展开，列表内容取当前被挤出的标签
  const [overflowMenu, setOverflowMenu] = useState<TabOverflowMenuState | null>(null)
  // 被横向滚动挤出可视区的标签（只在这里露出入口，避免标签栏把布局撑宽）
  const [hiddenPaths, setHiddenPaths] = useState<string[]>([])
  const stripRef = useRef<HTMLDivElement | null>(null)

  // 右键后目标标签可能已被其它操作关闭：失效时不再展示菜单
  const menuIndex = menu ? files.findIndex((file) => file.path === menu.path) : -1

  /** 重算被挤出的标签：容器尺寸、滚动位置或标签集合变化后调用（内容不变时不触发重渲染） */
  const refreshHidden = useCallback((): void => {
    const strip = stripRef.current
    if (!strip) {
      return
    }
    const next = collectHiddenPaths(strip)
    setHiddenPaths((prev) =>
      prev.length === next.length && prev.every((path, index) => path === next[index]) ? prev : next
    )
  }, [])

  // 标签增删、脏点或文件名变化都会改变宽度：提交后立即重算
  useLayoutEffect(() => {
    refreshHidden()
  }, [refreshHidden, files, dirtyPaths])

  // 容器尺寸变化（窗口/面板拖拽、下拉按钮出现后标签区变窄）时重算
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) {
      return
    }
    const observer = new ResizeObserver(refreshHidden)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [refreshHidden])

  // 切换激活项后把它滚进可视区：从「更多」下拉、文件树或 AI 附件打开时都能看到对应标签
  useEffect(() => {
    const strip = stripRef.current
    if (strip && activePath !== null) {
      scrollTabIntoView(strip, activePath)
    }
  }, [activePath, files])

  // 标签栏隐藏了横向滚动条，这里把滚轮的纵向增量转成横向滚动（与 IDEA 一致）
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) {
      return
    }
    const handleWheel = (event: WheelEvent): void => {
      if (strip.scrollWidth <= strip.clientWidth) {
        return
      }
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (delta === 0) {
        return
      }
      event.preventDefault()
      strip.scrollLeft += delta
    }
    // 必须显式 passive:false，React 的合成 onWheel 监听是 passive 的，无法阻止默认滚动
    strip.addEventListener('wheel', handleWheel, { passive: false })
    return () => strip.removeEventListener('wheel', handleWheel)
  }, [])

  /**
   * 构建标签右键菜单条目（数据驱动）。
   * 定位/发送给 AI、复制路径与关闭系列操作各成一组，以 null 作为分隔线。
   */
  const buildMenuEntries = (index: number, path: string): ContextMenuEntry[] => {
    // 相对路径需归属于当前项目才能计算
    const canCopyRelative = projectPath !== null && isAtOrUnder(path, projectPath)
    return [
      { id: 'reveal', label: '在资源管理器视图中显示', onSelect: () => onReveal(path) },
      { id: 'send-to-ai', label: '发送给 AI', onSelect: () => onSendToAi(path) },
      null,
      {
        id: 'copy-path',
        label: '复制路径',
        onSelect: () => void navigator.clipboard.writeText(path)
      },
      {
        id: 'copy-relative-path',
        label: '复制相对路径',
        disabled: !canCopyRelative,
        disabledReason: projectPath === null ? '未打开文件夹' : '文件不在当前项目内',
        onSelect: () =>
          void navigator.clipboard.writeText(relativePathNative(path, projectPath ?? path))
      },
      null,
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
  }

  /** 「更多」下拉条目：列出被挤出的标签，点击即切换（激活后会自动滚进可视区） */
  const buildOverflowEntries = (): ContextMenuEntry[] =>
    hiddenPaths.map((path) => {
      const name = files.find((file) => file.path === path)?.name ?? path
      return {
        id: `overflow:${path}`,
        label: dirtyPaths.has(path) ? `${name} ·` : name,
        onSelect: () => onActivate(path)
      }
    })

  return (
    // 外层不参与横向滚动：标签区自己滚动，被挤出的标签收进右侧「更多」下拉，
    // 这样标签再多也不会把编辑器区撑宽（进而挤掉右侧面板）
    <div className="flex min-h-8 min-w-0 shrink-0 items-stretch border-b border-line bg-elevated">
      <div
        ref={stripRef}
        className="scrollbar-none flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
        role="tablist"
        aria-label="已打开的文件"
        onScroll={refreshHidden}
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
              data-tab-path={file.path}
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
      </div>
      {hiddenPaths.length > 0 ? (
        <button
          type="button"
          className="flex w-7 shrink-0 cursor-pointer items-center justify-center border-l border-line text-dim hover:bg-hover hover:text-fg"
          aria-label={`还有 ${hiddenPaths.length} 个已打开的文件`}
          aria-haspopup="menu"
          aria-expanded={overflowMenu !== null}
          title={`还有 ${hiddenPaths.length} 个已打开的文件`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setOverflowMenu({ x: rect.left, y: rect.bottom })
          }}
        >
          <ChevronDown className="size-3.5" />
        </button>
      ) : null}
      {menu && menuIndex !== -1 ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={buildMenuEntries(menuIndex, menu.path)}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {overflowMenu ? (
        <ContextMenu
          x={overflowMenu.x}
          y={overflowMenu.y}
          entries={buildOverflowEntries()}
          onClose={() => setOverflowMenu(null)}
        />
      ) : null}
    </div>
  )
}
