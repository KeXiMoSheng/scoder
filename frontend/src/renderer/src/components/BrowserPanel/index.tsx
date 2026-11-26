import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from 'lucide-react'
import type { BrowserBounds } from '@shared/browser/types'
import { extractErrorMessage } from '../../lib/errorMessage'
import { cn } from '../../lib/utils'
import type { BrowserPanelProps } from './types'

/** 隐藏原生页面时上报的空区域：主进程据此 setVisible(false) */
const HIDDEN_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }

/** 两个矩形是否相交：只有盖住页面区域的浮层才需要让原生页面暂时让位 */
function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** 工具栏按钮：与 IDE 的紧凑图标按钮保持一致 */
const TOOL_BUTTON_CLASS =
  'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent text-dim hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent'

/**
 * 浏览器页签：上面是工具栏，下面把内容区的位置上报给主进程。
 *
 * AI 浏览器是主进程里的 WebContentsView，不是 DOM 里的 iframe：它叠在渲染进程
 * 之上，因此这里必须让内容区成为原生页面的“占位框”。原生页面显示时无法被 React
 * 遮挡，所以菜单、对话框、设置页等覆盖层出现时要把 visible 置为 false。
 */
export default function BrowserPanel({ tab, visible }: BrowserPanelProps): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const addressRef = useRef<HTMLInputElement | null>(null)
  const sessionId = tab.sessionId
  // 地址栏编辑态：未编辑时直接显示主进程推送的当前地址，编辑时保留用户输入，
  // 这样 AI 点击/页面跳转更新地址时不会把正在输入的 URL 冲掉。
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [addressError, setAddressError] = useState<string | null>(null)
  // 渲染进程里的浮层（Radix 菜单、MessageDialog/PromptDialog）会盖住整个窗口；
  // 原生视图永远在最上层，必须感知这些浮层并暂时隐藏，否则菜单/对话框会被页面盖住。
  const [overlayOpen, setOverlayOpen] = useState(false)

  useEffect(() => {
    let frame = 0
    const sync = (): void => {
      if (frame !== 0) {
        return
      }
      frame = requestAnimationFrame(() => {
        frame = 0
        const area = contentRef.current?.getBoundingClientRect()
        const overlays = document.querySelectorAll<HTMLElement>(
          '[role="menu"], [role="dialog"], [role="alertdialog"]'
        )
        let covered = false
        for (const overlay of overlays) {
          // 只看真正压在页面区域上的浮层：文件树/侧边栏里的菜单不必让页面整块消失
          if (area === undefined || intersects(area, overlay.getBoundingClientRect())) {
            covered = true
            break
          }
        }
        setOverlayOpen(covered)
      })
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    sync()
    return () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame)
      }
      observer.disconnect()
    }
  }, [])

  // 地址栏只做导航：回车后交给主进程归一化并加载，完整地址过长时由 CSS 截断
  const address = tab.url.trim()
  const displayAddress = editing ? draft : address
  // 手动浏览页签（标题栏「打开浏览器」）刚建出来时还没有地址：此时不显示原生页面，
  // 让占位提示与地址栏露出来，用户输入地址后再由 navigate 加载页面。
  const hasUrl = address.length > 0
  const nativeVisible = visible && !overlayOpen && hasUrl

  useEffect(() => {
    const element = contentRef.current
    if (!element) {
      return
    }
    let frame = 0
    const report = (): void => {
      frame = 0
      const rect = element.getBoundingClientRect()
      void window.api.browser
        .setBounds(
          sessionId,
          {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          nativeVisible
        )
        .catch(() => undefined)
    }
    // 布局提交后再测量：ResizeObserver 首次回调时尺寸已经是最终值
    const schedule = (): void => {
      if (frame !== 0) {
        cancelAnimationFrame(frame)
      }
      frame = requestAnimationFrame(report)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame)
      }
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      // 页签切换/关闭时立即收回原生页面，避免它继续盖住刚激活的文件
      void window.api.browser.setBounds(sessionId, HIDDEN_BOUNDS, false).catch(() => undefined)
    }
  }, [nativeVisible, sessionId])

  // 新建的手动浏览页签还没有地址：挂载后直接聚焦地址栏，输入即可导航
  useEffect(() => {
    const element = addressRef.current
    if (element !== null && element.value.length === 0) {
      element.focus()
    }
  }, [])

  /** 提交地址栏：空输入不导航；失败时保留编辑态并标红，便于修正 */
  const submitAddress = async (): Promise<void> => {
    // 直接读 DOM 当前值：避免连续输入后立刻回车时拿到上一次渲染的 state
    const next = (addressRef.current?.value ?? displayAddress).trim()
    if (next.length === 0) {
      addressRef.current?.focus()
      return
    }
    if (submitting) {
      return
    }
    setSubmitting(true)
    setAddressError(null)
    try {
      await window.api.browser.navigate(sessionId, next)
      setEditing(false)
      addressRef.current?.blur()
    } catch (reason) {
      setAddressError(extractErrorMessage(reason))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <div className="flex h-8 min-w-0 shrink-0 items-center gap-1 border-b border-line bg-elevated px-2">
        <button
          type="button"
          className={TOOL_BUTTON_CLASS}
          onClick={() => void window.api.browser.goBack(sessionId).catch(() => undefined)}
          disabled={!tab.canGoBack}
          title="后退"
          aria-label="后退"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <button
          type="button"
          className={TOOL_BUTTON_CLASS}
          onClick={() => void window.api.browser.goForward(sessionId).catch(() => undefined)}
          disabled={!tab.canGoForward}
          title="前进"
          aria-label="前进"
        >
          <ArrowRight className="size-3.5" />
        </button>
        <button
          type="button"
          className={TOOL_BUTTON_CLASS}
          onClick={() => void window.api.browser.reload(sessionId).catch(() => undefined)}
          title="刷新"
          aria-label="刷新"
        >
          <RotateCw className={tab.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </button>
        <form
          className={cn(
            'mx-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-sm border bg-base px-2 py-0.5 text-[11px] text-dim',
            addressError !== null ? 'border-danger' : 'border-line focus-within:border-accent-hover'
          )}
          onSubmit={(event) => {
            event.preventDefault()
            void submitAddress()
          }}
        >
          <Globe className="size-3 shrink-0" />
          <input
            ref={addressRef}
            type="text"
            value={displayAddress}
            placeholder="输入页面地址"
            spellCheck={false}
            autoComplete="off"
            aria-label="页面地址"
            aria-invalid={addressError !== null}
            title={addressError ?? displayAddress}
            onChange={(event) => {
              setDraft(event.currentTarget.value)
              if (addressError !== null) {
                setAddressError(null)
              }
            }}
            onFocus={(event) => {
              setEditing(true)
              setDraft(tab.url)
              // 与浏览器地址栏一致：聚焦时全选，直接输入即可替换
              event.currentTarget.select()
            }}
            onBlur={() => {
              setEditing(false)
              setAddressError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submitAddress()
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setDraft(tab.url)
                setEditing(false)
                setAddressError(null)
                event.currentTarget.blur()
              }
            }}
            className="min-w-0 flex-1 border-none bg-transparent p-0 text-[11px] text-fg outline-none placeholder:text-dim"
          />
        </form>
        <button
          type="button"
          className={TOOL_BUTTON_CLASS}
          onClick={() => void window.api.browser.openExternal(sessionId).catch(() => undefined)}
          disabled={!hasUrl}
          title="在系统浏览器中打开"
          aria-label="在系统浏览器中打开"
        >
          <ExternalLink className="size-3.5" />
        </button>
      </div>
      <div
        ref={contentRef}
        className={cn(
          'relative min-h-0 min-w-0 flex-1 overflow-hidden',
          // 有页面时保留白底（页面加载/隐藏时不出暗色闪屏）；空页签直接用主题底色
          hasUrl ? 'bg-white' : 'bg-base'
        )}
      >
        {/* 原生页面显示时会盖住这块占位；隐藏期间（加载中/菜单打开）用户看到的就是它 */}
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-[12px] text-dim">
          <Globe className="size-4" />
          <span>
            {tab.loading ? '正在加载页面…' : hasUrl ? '浏览器页面已隐藏' : '输入地址开始浏览'}
          </span>
        </div>
      </div>
    </div>
  )
}
