import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ImageSize, ImageZoomProps } from './types'

/** 缩放上限：800%（相对原图像素） */
const MAX_SCALE = 8
/** 缩放下限：10%；图片大到「适应窗口」更小时以适应窗口为准 */
const MIN_SCALE = 0.1
/** 适应窗口时四周留白（px），避免图片贴边 */
const FIT_PADDING = 16
/** 滚轮缩放灵敏度：按指数变化，连续滚动的手感才一致 */
const WHEEL_SENSITIVITY = 0.0015
/** 工具栏按钮与键盘单次缩放的倍率 */
const ZOOM_STEP = 1.25
/** 键盘平移步长（px），按住 Shift 时加速 */
const PAN_STEP = 48

/** 缩放视图：fit 为 true 时比例由容器实时算出，scale/x/y 只在自由缩放时有效 */
interface ZoomView {
  fit: boolean
  /** 自由缩放比例（相对原图，1 表示 100%） */
  scale: number
  /** 图片中心相对视口中心的偏移（px） */
  x: number
  y: number
}

/** 初始状态：适应窗口 */
const FIT_VIEW: ZoomView = { fit: true, scale: 1, x: 0, y: 0 }

/** 二维偏移量：既表示图片位置，也表示缩放锚点 */
interface Offset {
  x: number
  y: number
}

/**
 * 限制图片不被拖出视口：
 * 图片比视口小时强制居中（偏移归零），比视口大时最多拖到图片边缘与视口边缘对齐。
 * 这样无论怎么缩放/拖拽，画面里始终留有图片，不会「拖丢」。
 */
function clampOffset(
  offset: Offset,
  scale: number,
  natural: ImageSize | null,
  viewport: ImageSize
): Offset {
  if (!natural) {
    return { x: 0, y: 0 }
  }
  const maxX = Math.max(0, (natural.width * scale - viewport.width) / 2)
  const maxY = Math.max(0, (natural.height * scale - viewport.height) / 2)
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y))
  }
}

/** 工具栏图标按钮：统一交互尺寸与悬停配色 */
function ToolButton({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-dim transition-colors hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-dim"
    >
      {children}
    </button>
  )
}

/**
 * 图片查看器：默认「适应窗口」，支持滚轮缩放（以指针为锚点）、拖动平移、
 * 双击在适应窗口与 1:1 之间切换，以及工具栏与键盘快捷键。
 *
 * 图片用绝对定位 + transform 缩放：偏移只改 transform 不触发布局，
 * 拖动与连续滚轮缩放都能保持流畅。
 */
export default function ImageZoom({
  src,
  alt,
  onLoad,
  onError,
  className
}: ImageZoomProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // 原图尺寸：解码成功后才有值，也是计算「适应窗口」比例的依据
  const [natural, setNatural] = useState<ImageSize | null>(null)
  // 容器可视尺寸：由 ResizeObserver 维护，窗口缩放与分栏拖动后自动重算适应比例
  const [viewport, setViewport] = useState<ImageSize>({ width: 0, height: 0 })
  const [view, setView] = useState<ZoomView>(FIT_VIEW)
  const [dragging, setDragging] = useState(false)
  // 拖拽会话：起点与起始偏移放 ref，pointermove 不必依赖每次渲染的闭包
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origin: Offset
  } | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const measure = (): void => {
      setViewport({ width: container.clientWidth, height: container.clientHeight })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // 适应窗口比例：只缩小不放大（小图保持原始尺寸），四周留出固定留白
  const fitScale = ((): number => {
    if (!natural || viewport.width === 0 || viewport.height === 0) {
      return 1
    }
    const availableWidth = Math.max(1, viewport.width - FIT_PADDING * 2)
    const availableHeight = Math.max(1, viewport.height - FIT_PADDING * 2)
    return Math.min(1, availableWidth / natural.width, availableHeight / natural.height)
  })()
  // 缩放下限不高于适应比例：超大图也能缩回「适应窗口」
  const minScale = Math.min(MIN_SCALE, fitScale)
  // 当前生效比例：适应窗口时随容器变化，自由缩放时用用户设定的比例
  const scale = view.fit ? fitScale : view.scale
  // 渲染用偏移：容器或图片尺寸变化后即使状态里还留着旧值，也在渲染时夹紧。
  // 不用 effect 回写状态——同步 setState 会触发级联渲染，这里派生出来即可。
  const offset = view.fit ? { x: 0, y: 0 } : clampOffset(view, scale, natural, viewport)

  /**
   * 缩放入口：按当前比例算出目标比例后，围绕锚点调整偏移。
   * 锚点为空时以视口中心为基准（工具栏/键盘），传指针位置则可保证指针下的像素不动（滚轮）。
   * 用函数式更新读取最新状态，滚轮监听因此不必随每次缩放重新注册。
   */
  const updateZoom = useCallback(
    (nextScale: (current: number) => number, anchor: Offset | null): void => {
      setView((prev) => {
        const current = prev.fit ? fitScale : prev.scale
        const target = Math.min(MAX_SCALE, Math.max(minScale, nextScale(current)))
        // 已到缩放边界：保持原状态，避免无意义的重渲染
        if (Math.abs(target - current) < 0.0001) {
          return prev
        }
        const ratio = target / current
        // 以当前「可见」偏移为基准，容器刚改变尺寸时也不会从旧位置跳一下
        const base = prev.fit ? { x: 0, y: 0 } : clampOffset(prev, current, natural, viewport)
        const moved = anchor
          ? {
              x: anchor.x - (anchor.x - base.x) * ratio,
              y: anchor.y - (anchor.y - base.y) * ratio
            }
          : { x: base.x * ratio, y: base.y * ratio }
        return { fit: false, scale: target, ...clampOffset(moved, target, natural, viewport) }
      })
    },
    [fitScale, minScale, natural, viewport]
  )

  const resetToFit = useCallback((): void => setView(FIT_VIEW), [])

  /** 键盘/按钮平移 */
  const panBy = useCallback(
    (dx: number, dy: number): void => {
      setView((prev) => {
        if (prev.fit) {
          return prev
        }
        const base = clampOffset(prev, prev.scale, natural, viewport)
        const moved = clampOffset({ x: base.x + dx, y: base.y + dy }, prev.scale, natural, viewport)
        return moved.x === prev.x && moved.y === prev.y ? prev : { ...prev, ...moved }
      })
    },
    [natural, viewport]
  )

  // 滚轮缩放：React 的合成 onWheel 是 passive 的，必须用原生监听才能 preventDefault
  useEffect(() => {
    const container = containerRef.current
    if (!container || !natural) {
      return
    }
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault()
      // 行模式（部分鼠标/旧浏览器）换算成像素，避免一格滚轮跳动过大
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1)
      const rect = container.getBoundingClientRect()
      const anchor = {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2
      }
      // 向上滚（delta < 0）放大，向下滚缩小；触控板捏合在 Chromium 中同样是带 ctrlKey 的 wheel
      updateZoom((current) => current * Math.exp(-delta * WHEEL_SENSITIVITY), anchor)
    }
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [natural, updateZoom])

  const handleLoad = (event: React.SyntheticEvent<HTMLImageElement>): void => {
    const image = event.currentTarget
    const size: ImageSize = { width: image.naturalWidth, height: image.naturalHeight }
    setNatural((prev) =>
      prev && prev.width === size.width && prev.height === size.height ? prev : size
    )
    onLoad?.(size)
  }

  // 图片超出视口才允许拖动；适应窗口时整张图完整可见，不需要平移
  const canPan =
    natural !== null &&
    (natural.width * scale > viewport.width + 0.5 || natural.height * scale > viewport.height + 0.5)
  const canZoomIn = scale < MAX_SCALE - 0.0001
  const canZoomOut = scale > minScale + 0.0001

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !canPan) {
      return
    }
    // 捕获指针：拖出预览区后仍能继续接收 move/up，拖动不会中断
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: offset.x, y: offset.y }
    }
    setDragging(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    const moved = clampOffset(
      {
        x: drag.origin.x + event.clientX - drag.startX,
        y: drag.origin.y + event.clientY - drag.startY
      },
      scale,
      natural,
      viewport
    )
    setView((prev) => (prev.fit ? prev : { ...prev, ...moved }))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return
    }
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  // 双击：适应窗口 ↔ 1:1；其它比例一律回到适应窗口
  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!natural) {
      return
    }
    if (view.fit) {
      const rect = event.currentTarget.getBoundingClientRect()
      updateZoom(() => 1, {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2
      })
      return
    }
    resetToFit()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!natural) {
      return
    }
    switch (event.key) {
      case '+':
      case '=':
        event.preventDefault()
        updateZoom((current) => current * ZOOM_STEP, null)
        break
      case '-':
      case '_':
        event.preventDefault()
        updateZoom((current) => current / ZOOM_STEP, null)
        break
      case '0':
        event.preventDefault()
        resetToFit()
        break
      case '1':
        event.preventDefault()
        updateZoom(() => 1, null)
        break
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!canPan) {
          return
        }
        event.preventDefault()
        const step = event.shiftKey ? PAN_STEP * 4 : PAN_STEP
        const dx = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0
        const dy = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0
        panBy(dx, dy)
        break
      }
      default:
        break
    }
  }

  const percent = Math.max(1, Math.round(scale * 100))

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 touch-none select-none items-center justify-center overflow-hidden bg-base outline-none',
        'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-link/50',
        canPan && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
        className
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={handleLoad}
        onError={onError}
        // 固定为原图尺寸再整体缩放，缩放比例与状态栏里的像素尺寸才能对应
        className="pointer-events-none absolute top-1/2 left-1/2 max-w-none origin-center"
        style={{
          width: natural?.width,
          height: natural?.height,
          transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          // 解码完成前先隐藏，避免原图尺寸一闪而过
          visibility: natural ? 'visible' : 'hidden'
        }}
      />

      {canPan ? (
        <span className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-sm bg-elevated/85 px-1.5 py-0.5 text-[11px] leading-4 text-dim shadow-sm">
          拖动平移 · 双击复位
        </span>
      ) : null}

      {/* 工具栏是缩放与复位的兜底入口：不依赖用户发现滚轮或双击 */}
      <div
        className="absolute right-3 bottom-3 z-10 flex items-center gap-0.5 rounded-md border border-line bg-elevated/95 p-0.5 shadow-sm backdrop-blur"
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <ToolButton
          label="缩小"
          disabled={!canZoomOut}
          onClick={() => updateZoom((current) => current / ZOOM_STEP, null)}
        >
          <ZoomOut className="size-3.5" />
        </ToolButton>
        <span
          className="w-12 text-center text-[11px] tabular-nums text-dim"
          title={`当前缩放比例（适应窗口为 ${Math.round(fitScale * 100)}%）`}
        >
          {percent}%
        </span>
        <ToolButton
          label="放大"
          disabled={!canZoomIn}
          onClick={() => updateZoom((current) => current * ZOOM_STEP, null)}
        >
          <ZoomIn className="size-3.5" />
        </ToolButton>
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
        <ToolButton label="适应窗口（双击图片）" disabled={view.fit} onClick={resetToFit}>
          <Maximize className="size-3.5" />
        </ToolButton>
        <ToolButton label="原始尺寸 1:1" onClick={() => updateZoom(() => 1, null)}>
          <span className="text-[10px] font-semibold">1:1</span>
        </ToolButton>
      </div>
    </div>
  )
}
