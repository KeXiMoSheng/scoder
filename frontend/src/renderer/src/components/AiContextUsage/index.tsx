import { useCallback, useEffect, useRef, useState } from 'react'
import { FilePlusCorner, Gauge, Package } from 'lucide-react'
import { contextUsagePercent, DEFAULT_CONTEXT_WINDOW } from '@shared/ai/context'
import { cn } from '../../lib/utils'
import type { AiContextUsageProps } from './types'

/** 压缩尚未接入真实执行，点击后只在面板内给出提示 */
const COMPACT_NOTICE = '压缩功能尚未开放，当前仅统计用量'
const NOTICE_DURATION = 2400

/** 两个快捷按钮共用同一套低对比样式，与面板背景保持一致 */
const PANEL_BUTTON_CLASS =
  'inline-flex h-7 cursor-pointer items-center justify-center gap-1 rounded-md border-none bg-hover px-2 text-[11px] font-medium text-fg transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-40'

/** 去掉小数末尾的 .0：1.0M → 1M */
function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

/** 上下文的紧凑计量：1153 → 1.2k、1_200_000 → 1.2M */
function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${trimZero(value / 1_000_000)}M`
  }
  if (value >= 1000) {
    return `${trimZero(value / 1000)}k`
  }
  return String(value)
}

/**
 * 输入区里的上下文用量入口：
 * 默认缩成一个环形进度图标，悬停或点击展开用量与快捷操作面板。
 * 面板放在触发按钮上方，因为输入区本身贴着窗口底部。
 */
export default function AiContextUsage({
  usage,
  canCreate,
  onCreateSession
}: AiContextUsageProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const noticeTimer = useRef<number | null>(null)

  const usedTokens = usage?.usedTokens ?? 0
  const limitTokens = usage?.limitTokens ?? DEFAULT_CONTEXT_WINDOW
  const percent = contextUsagePercent(usedTokens, limitTokens)
  const open = hovered || pinned

  // 点击展开后：点面板外或按 Esc 收起；纯悬停展开由鼠标进出管理
  useEffect(() => {
    if (!pinned) {
      return
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setPinned(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPinned(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [pinned])

  // 卸载时清掉提示计时器，避免回调落在已卸载的组件上
  useEffect(() => {
    return () => {
      if (noticeTimer.current !== null) {
        window.clearTimeout(noticeTimer.current)
      }
    }
  }, [])

  const handleCompact = useCallback((): void => {
    setNotice(COMPACT_NOTICE)
    if (noticeTimer.current !== null) {
      window.clearTimeout(noticeTimer.current)
    }
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null
      setNotice(null)
    }, NOTICE_DURATION)
  }, [])

  const handleCreate = useCallback((): void => {
    setPinned(false)
    setHovered(false)
    onCreateSession()
  }, [onCreateSession])

  return (
    <div
      ref={rootRef}
      className="relative flex items-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={cn(
          'group relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent p-0 transition-colors hover:bg-hover',
          open && 'bg-hover'
        )}
        aria-label="上下文用量"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setPinned((previous) => !previous)}
      >
        {/* 环形进度：填充与剩余轨道都取主题变量，切换主题即时生效 */}
        <span
          aria-hidden
          className="absolute inset-[5px] rounded-full"
          style={{
            background: `conic-gradient(var(--link) ${percent * 3.6}deg, color-mix(in srgb, var(--text) 16%, transparent) 0deg)`
          }}
        />
        <span aria-hidden className="absolute inset-[7px] rounded-full bg-base" />
        <Gauge className="relative size-3.5 text-dim transition-colors group-hover:text-fg" />
      </button>
      {open ? (
        // 外层用 pb-2 留出与触发按钮的间距：这段留白也属于悬停区域，鼠标移入面板时不会闪退
        <div className="absolute right-0 bottom-full z-20 w-60 pb-2">
          <div
            className="rounded-lg border border-line bg-elevated p-2 shadow-xl"
            role="dialog"
            aria-label="上下文用量"
          >
            {/* 进度条是文字底色：填充宽度就是占用比例，而不是额外的独立长条 */}
            <div
              className="relative overflow-hidden rounded-md"
              style={{ background: 'color-mix(in srgb, var(--text) 8%, transparent)' }}
            >
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 transition-[width] duration-300"
                style={{
                  width: `${percent}%`,
                  background: 'color-mix(in srgb, var(--link) 24%, transparent)'
                }}
              />
              <p className="relative flex items-baseline gap-1 whitespace-nowrap px-2.5 py-1.5 text-[11px] tabular-nums">
                <span className="font-semibold text-fg">{percent}%</span>
                <span className="text-dim">
                  {formatTokens(usedTokens)} / {formatTokens(limitTokens)}
                </span>
                <span className="text-dim">已用上下文</span>
              </p>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <button
                type="button"
                className={PANEL_BUTTON_CLASS}
                title="压缩当前会话（暂未开放真实压缩）"
                onClick={handleCompact}
              >
                <Package className="size-3.5" />
                压缩当前会话
              </button>
              <button
                type="button"
                className={PANEL_BUTTON_CLASS}
                title={canCreate ? '新建会话' : '先打开一个项目'}
                disabled={!canCreate}
                onClick={handleCreate}
              >
                <FilePlusCorner className="size-3.5" />
                新建会话
              </button>
            </div>
            {notice ? (
              <p className="mt-1.5 rounded bg-hover px-2 py-1 text-[10px] leading-4 text-dim">
                {notice}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
