import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '../../lib/markdown'
import { monaco } from '../../lib/monaco'
import { getActiveThemeId } from '../../lib/theme'
import { cn } from '../../lib/utils'
import type { MarkdownPreviewProps } from './types'

/** 已注册的语言 id：未注册的代码块保持纯文本，避免着色器产出空内容 */
const REGISTERED_LANGUAGE_IDS = new Set(monaco.languages.getLanguages().map((item) => item.id))

const COPY_IDLE_TEXT = '复制'
/** 复制结果只在按钮上停留一小段时间，避免遮挡代码正文 */
const COPY_FEEDBACK_DELAY = 1600

/** 按钮由 markdown-it 生成的 HTML 创建、不在 React 树内，只能命令式更新文案 */
const copyTimers = new WeakMap<HTMLElement, number>()

function showCopyFeedback(button: HTMLElement, failed: boolean): void {
  const timer = copyTimers.get(button)
  if (timer !== undefined) {
    window.clearTimeout(timer)
  }
  button.textContent = failed ? '复制失败' : '已复制'
  button.dataset.copied = failed ? 'error' : 'true'
  copyTimers.set(
    button,
    window.setTimeout(() => {
      copyTimers.delete(button)
      button.textContent = COPY_IDLE_TEXT
      delete button.dataset.copied
    }, COPY_FEEDBACK_DELAY)
  )
}

/** 取代码块原文：着色后 pre 的 textContent 被逐行 <br/> 打断，优先读着色前缓存的 source */
function readCodeBlockSource(button: HTMLElement): string {
  const pre = button.parentElement?.querySelector('pre.md-code')
  if (!(pre instanceof HTMLElement)) {
    return ''
  }
  return pre.dataset.source ?? pre.textContent ?? ''
}

function copyCodeBlock(button: HTMLElement): void {
  const source = readCodeBlockSource(button)
  if (source === '') {
    return
  }
  void navigator.clipboard.writeText(source).then(
    () => showCopyFeedback(button, false),
    () => showCopyFeedback(button, true)
  )
}

/** 订阅应用主题 id：主题切换后需要重建预览 DOM 并按新主题重新着色 */
function useActiveThemeId(): string {
  const [themeId, setThemeId] = useState(getActiveThemeId)
  useEffect(() => {
    // lib/theme.ts 切换主题时写入 <html data-theme>，作为唯一的主题变更信号
    const observer = new MutationObserver(() => setThemeId(getActiveThemeId()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    return () => observer.disconnect()
  }, [])
  return themeId
}

/**
 * Markdown 预览：markdown-it 负责把源文本渲染为 HTML，
 * 代码块再交给 Monaco 着色（复用编辑器已注册的 tokenizer，配色与编辑器一致）。
 * 渲染结果不可点击导航：外部链接交给系统浏览器，其余链接阻止默认跳转。
 */
export default function MarkdownPreview({
  content,
  basePath,
  variant = 'document',
  className
}: MarkdownPreviewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const themeId = useActiveThemeId()
  const html = useMemo(() => renderMarkdown(content, basePath), [content, basePath])

  // 代码块着色：colorizeElement 会就地改写 pre 的 innerHTML，
  // 因此每次都先把原文还原（StrictMode 下 effect 会重跑），并清掉上一次追加的主题类名
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    for (const block of container.querySelectorAll<HTMLElement>('pre[data-lang]')) {
      const language = block.dataset.lang ?? ''
      if (!language || language === 'plaintext' || !REGISTERED_LANGUAGE_IDS.has(language)) {
        continue
      }
      const source = block.dataset.source ?? block.textContent ?? ''
      block.dataset.source = source
      block.className = 'md-code'
      block.textContent = source
      // theme 必须显式传入：colorizeElement 默认用 vs（浅色），并会把全局编辑器主题改成它
      void monaco.editor
        .colorizeElement(block, { theme: themeId, tabSize: 2 })
        .catch(() => undefined)
    }
  }, [html, themeId])

  /** 点击：复制按钮优先；锚点阻止渲染进程内跳转，外部链接交给系统浏览器 */
  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const copyButton = target.closest('[data-md-code-copy]')
    if (copyButton instanceof HTMLElement) {
      event.preventDefault()
      copyCodeBlock(copyButton)
      return
    }
    const anchor = target.closest('a')
    if (!anchor) {
      return
    }
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) {
      // 主进程的 setWindowOpenHandler 会把新窗口请求转成 shell.openExternal
      window.open(href)
    }
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'markdown-body overflow-auto bg-base',
        variant === 'message' ? 'px-3 py-2' : 'px-8 py-6',
        className
      )}
      onClick={handleClick}
    >
      {/* key 随主题变化重建 DOM：着色结果依赖当前主题的 token 配色 */}
      <div
        key={themeId}
        className={cn(
          'markdown-content',
          variant === 'message' ? 'text-[13px]' : 'mx-auto max-w-[880px]'
        )}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
// AI 输出接入方式：<MarkdownPreview content={assistantText} variant="message" />