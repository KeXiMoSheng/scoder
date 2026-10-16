import { useEffect, useState } from 'react'
import type { TitleBarProps } from './types'

/** 最小化图标：底部一条横线 */
function MinimizeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

/** 最大化图标：单个方框 */
function MaximizeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <rect
        x="2.5"
        y="2.5"
        width="7"
        height="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  )
}

/** 还原图标：两个叠放的方框，表示当前处于最大化状态 */
function RestoreIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <rect x="2" y="4" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M4 4 V2 H10 V8 H8" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

/** 关闭图标：叉 */
function CloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

/** 标题栏窗口控制按钮：关闭键悬停用危险色，其余用普通悬停高亮 */
function titleBarButton(close: boolean): string {
  const base =
    'inline-flex w-11 shrink-0 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-fg transition-colors'
  return close ? `${base} hover:bg-danger hover:text-accent-fg` : `${base} hover:bg-hover`
}

/**
 * 无边框窗口（frame: false）的自绘标题栏：
 * 整条栏通过 CSS `-webkit-app-region: drag` 可拖动窗口，右侧按钮设为 no-drag 以保持可点击。
 * 最大化/还原图标跟随主进程推送的窗口状态切换。
 */
export default function TitleBar({ title = 'Scoder' }: TitleBarProps): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    // 标题栏挂载时先回查当前状态（应用启动即最大化），再订阅后续变化
    let mounted = true
    void window.api.isWindowMaximized().then((value) => {
      if (mounted) {
        setMaximized(value)
      }
    })
    const unsubscribe = window.api.onWindowMaximizeChange((value) => {
      if (mounted) {
        setMaximized(value)
      }
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  return (
    <div className="flex h-8 shrink-0 items-stretch border-b border-line bg-elevated [-webkit-app-region:drag] select-none">
      <span className="flex min-w-0 flex-1 items-center overflow-hidden pl-3 truncate text-[12px] font-semibold text-dim">
        {title}
      </span>
      <div className="flex shrink-0 items-stretch [-webkit-app-region:no-drag]">
        <button
          type="button"
          className={titleBarButton(false)}
          onClick={() => window.api.windowMinimize()}
          title="最小化"
          aria-label="最小化"
        >
          <MinimizeIcon />
        </button>
        <button
          type="button"
          className={titleBarButton(false)}
          onClick={() => window.api.windowToggleMaximize()}
          title={maximized ? '向下还原' : '最大化'}
          aria-label={maximized ? '向下还原' : '最大化'}
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button
          type="button"
          className={titleBarButton(true)}
          onClick={() => window.api.windowClose()}
          title="关闭"
          aria-label="关闭"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}
